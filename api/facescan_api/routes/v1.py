"""Version 1 endpoints: client config, frontal and profile analysis,
adjustments and overlays for both views, and reports.

Order of checks for every analysis call: rate limit → worker slot (503 before the
upload is read) → body parsing and validation → result token → worker task.
"""

from __future__ import annotations

import hashlib
import json
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response

from facescan_api.errors import ApiError
from facescan_api.openapi import json_body, multipart_body, problems
from facescan_api.routes.common import (
    analysis_response, api_state, check_layers, rate_limit, read_token, report_response, versions,
)
from facescan_api.schemas import (
    AdjustRequest, AnalyzeResponse, ClientConfigResponse, FrontalAnalyzeMeta, OverlayMeta, ProfileAnalyzeMeta,
    ReportRequest, ReportResponse,
)
from facescan_api.uploads import parse_meta, read_json, read_multipart, require_image
from facescan_api.workers import (
    task_adjust, task_analyze_frontal, task_analyze_profile, task_build_report, task_overlay,
)

router = APIRouter(prefix="/v1", dependencies=[Depends(rate_limit)])

ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"]
CLIENT_CONFIG_CACHE = "public, max-age=3600"

_BUSY = ("rate_limited", "not_ready", "overloaded")
_BINARY = {"type": "string", "format": "binary"}


# =========================================================================== client config


@router.get(
    "/client-config", response_model=ClientConfigResponse, summary="Capture thresholds, limits and strings",
    description="`engine.client_config(locale)` plus upload limits, overlay layers, the rules version and "
                "versions. Cacheable (`ETag`, 1 h).",
    responses={304: {"description": "Not Modified (If-None-Match matched the ETag)"},
               **problems("invalid_request", "rate_limited", "not_ready")},
    openapi_extra={"parameters": [{"name": "locale", "in": "query", "required": False,
                                   "schema": {"type": "string", "enum": ["th", "en"], "default": "th"}}]},
)
async def client_config(request: Request) -> Response:
    api = api_state(request)
    if set(request.query_params) - {"locale"}:
        raise ApiError("invalid_request", "unknown query parameter")
    locale = request.query_params.get("locale", "th")
    if locale not in ("th", "en"):
        raise ApiError("invalid_request", "locale must be 'th' or 'en'")
    info = api.pool.info()
    s = api.settings
    body = {
        **info.client_config[locale],
        "upload_limits": {"max_image_bytes": s.max_image_bytes, "max_request_bytes": s.max_request_bytes,
                          "max_frames": min(s.max_frames, info.burst["max_frames"]), "max_pixels": s.max_pixels,
                          "max_burst_pixels": s.max_burst_pixels, "accepted_types": ACCEPTED_TYPES},
        "overlay": {"layers": list(info.layers), "max_side_px": s.overlay_max_side},
        "rules_version": info.rules["rules_version"],
        "versions": versions(info),
    }
    raw = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    etag = '"' + hashlib.sha256(raw).hexdigest()[:32] + '"'
    headers = {"ETag": etag, "Cache-Control": CLIENT_CONFIG_CACHE}
    inm = request.headers.get("if-none-match")
    if inm and (inm.strip() == "*" or etag in [t.strip().removeprefix("W/") for t in inm.split(",")]):
        return Response(status_code=304, headers=headers)
    return Response(raw, media_type="application/json", headers=headers)


# ========================================================================= frontal analyze


@router.post(
    "/frontal/analyze", response_model=AnalyzeResponse, summary="Analyze a frontal photo or burst",
    description="One photo, or a burst of 3–15 frames of identical size in capture order. Capture outcomes "
                "(`no_face`, `multiple_faces`, `quality_failed`) are 200 responses with hints and no token.",
    responses=problems("invalid_request", *_BUSY, "payload_too_large", "unsupported_media_type", "invalid_meta",
                       "too_many_pixels", "frame_size_mismatch", "analysis_timeout", "internal_error"),
    openapi_extra=multipart_body(
        FrontalAnalyzeMeta,
        {"frames": {"type": "array", "items": _BINARY, "minItems": 1, "maxItems": 15,
                    "description": "JPEG, PNG or WebP as captured: no resizing, cropping or re-encoding."}},
        {"frames": ["<frame-1.jpg>", "<frame-2.jpg>", "<frame-3.jpg>"]}),
)
async def frontal_analyze(request: Request) -> JSONResponse:
    api = api_state(request)
    s = api.settings
    async with api.pool.slot():
        info = api.pool.info()
        form = await read_multipart(request, files={"frames": s.max_frames}, fields={"meta"},
                                    max_request_bytes=s.max_request_bytes, max_file_bytes=s.max_image_bytes,
                                    max_field_bytes=s.max_meta_bytes)
        meta = parse_meta(FrontalAnalyzeMeta, form.fields.get("meta"))
        frames = form.files.get("frames", [])
        lo, hi = info.burst["min_frames"], min(info.burst["max_frames"], s.max_frames)
        if not (len(frames) == 1 or lo <= len(frames) <= hi):
            raise ApiError("invalid_request", f"send one photo or a burst of {lo}–{hi} frames")
        layers = check_layers(meta.overlay.layers, info) if meta.overlay else None
        for i, frame in enumerate(frames):
            require_image(frame, f"frame {i}")
        out = await api.pool.run("frontal", task_analyze_frontal, frames, meta.model_dump(mode="json"), layers,
                                 timeout=s.timeout_frontal_s)
    return analysis_response(request, out, kind="frontal", session_id=str(uuid.uuid4()), info=info)


# ================================================================================= adjust


@router.post(
    "/adjust", response_model=AnalyzeResponse, summary="Apply point adjustments to a result",
    description="Recomputes a token's result with moved points, without the image. Every override is recorded as "
                "a user adjustment; only `user_adjustable_points` of the token's view may move. Profile "
                "silhouette points are re-snapped to the stored contour by the core, whatever coordinates were "
                "sent. Returns a new token (same session) and no overlay.",
    responses=problems("invalid_request", "token_invalid", "token_stale", *_BUSY, "payload_too_large",
                       "unsupported_media_type", "point_not_adjustable", "analysis_timeout", "internal_error"),
    openapi_extra=json_body(AdjustRequest),
)
async def adjust(request: Request) -> JSONResponse:
    api = api_state(request)
    s = api.settings
    async with api.pool.slot():
        info = api.pool.info()
        body = await read_json(request, AdjustRequest, max_bytes=s.max_json_bytes)
        payload = read_token(api, body.result_token, info)
        allowed = info.user_adjustable_points.get(payload.kind, [])
        if set(body.overrides) - set(allowed):
            raise ApiError("point_not_adjustable", f"only these points can be adjusted: {', '.join(allowed) or 'none'}")
        overrides = {name: {"x": p.x, "y": p.y} for name, p in body.overrides.items()}
        out = await api.pool.run("adjust", task_adjust, payload.kind, payload.result, overrides, body.locale,
                                 timeout=s.timeout_adjust_s)
    return analysis_response(request, out, kind=payload.kind, session_id=payload.session_id, info=info)


# ================================================================================ overlay


@router.post(
    "/overlay", response_class=Response, summary="Draw an overlay for a result",
    description="Redraws a token's result on its reference image (the reference frame or photo exactly as "
                "uploaded, or the profile photo) after adjustments. JPEG, long side ≤ OVERLAY_MAX_SIDE, no EXIF.",
    responses={200: {"description": "The overlay", "content": {"image/jpeg": {"schema": _BINARY}}},
               **problems("invalid_request", "token_invalid", "token_stale", *_BUSY, "payload_too_large",
                          "unsupported_media_type", "invalid_meta", "too_many_pixels", "image_mismatch",
                          "analysis_timeout", "internal_error")},
    openapi_extra=multipart_body(
        OverlayMeta, {"image": {**_BINARY, "description": "The result's reference image as originally uploaded."}},
        {"image": "<frame-2.jpg>"}),
)
async def overlay(request: Request) -> Response:
    api = api_state(request)
    s = api.settings
    async with api.pool.slot():
        info = api.pool.info()
        # This meta carries a result token: its limit is the usual one plus one token.
        form = await read_multipart(request, files={"image": 1}, fields={"meta"},
                                    max_request_bytes=s.max_request_bytes, max_file_bytes=s.max_image_bytes,
                                    max_field_bytes=s.max_meta_bytes + s.max_token_chars)
        meta = parse_meta(OverlayMeta, form.fields.get("meta"))
        images = form.files.get("image", [])
        if len(images) != 1:
            raise ApiError("invalid_request", "send exactly one 'image' part")
        payload = read_token(api, meta.result_token, info)
        layers = check_layers(meta.layers, info)
        require_image(images[0], "image")
        jpeg = await api.pool.run("overlay", task_overlay, payload.kind, payload.result, images[0], layers,
                                  meta.locale, timeout=s.timeout_overlay_s)
    return Response(jpeg, media_type="image/jpeg")


# ======================================================================== profile analyze


@router.post(
    "/profile/analyze", response_model=AnalyzeResponse, summary="Analyze a profile photo",
    description="A true 90° profile photo; `facing` is the direction the nose points in the image. With a "
                "`frontal_token` (from `/v1/frontal/analyze` or `/v1/adjust` of the same session) the subject and "
                "`session_id` come from it (a different `subject` in `meta` → 400 `subject_mismatch`) and mm values "
                "use its scale. Without one, `subject` is required, a new session starts and mm values are "
                "unavailable (warning `no_frontal_scale`). The result includes the silhouette `contour` and the "
                "points the user may adjust. Capture outcomes (`no_face`, `multiple_faces`, `contour_failed`, "
                "`quality_failed`) are 200 responses with hints and no token.",
    responses=problems("invalid_request", "subject_mismatch", "token_invalid", "token_stale", *_BUSY,
                       "payload_too_large", "unsupported_media_type", "invalid_meta", "too_many_pixels",
                       "analysis_timeout", "internal_error"),
    openapi_extra=multipart_body(
        ProfileAnalyzeMeta, {"image": {**_BINARY, "description": "JPEG, PNG or WebP as captured."}},
        {"image": "<profile.jpg>"}),
)
async def profile_analyze(request: Request) -> JSONResponse:
    api = api_state(request)
    s = api.settings
    async with api.pool.slot():
        info = api.pool.info()
        # This meta may carry a frontal token: its limit is the usual one plus one token.
        form = await read_multipart(request, files={"image": 1}, fields={"meta"},
                                    max_request_bytes=s.max_request_bytes, max_file_bytes=s.max_image_bytes,
                                    max_field_bytes=s.max_meta_bytes + s.max_token_chars)
        meta = parse_meta(ProfileAnalyzeMeta, form.fields.get("meta"))
        images = form.files.get("image", [])
        if len(images) != 1:
            raise ApiError("invalid_request", "send exactly one 'image' part")
        frontal: dict | None = None
        if meta.frontal_token is not None:
            front = read_token(api, meta.frontal_token, info, kind="frontal")
            frontal = front.result
            subject = dict(frontal["subject"])            # the token's subject wins
            session_id = front.session_id
            if meta.subject is not None and (meta.subject.sex, meta.subject.age) != (subject.get("sex"),
                                                                                       subject.get("age")):
                raise ApiError("subject_mismatch", "meta.subject differs from the frontal result's subject")
        elif meta.subject is None:
            raise ApiError("invalid_meta", "subject is required without a frontal_token")
        else:
            subject = meta.subject.model_dump()
            session_id = str(uuid.uuid4())
        layers = check_layers(meta.overlay.layers, info) if meta.overlay else None
        require_image(images[0], "image")
        worker_meta = meta.model_dump(mode="json", include={"facing", "camera", "locale"})
        out = await api.pool.run("profile", task_analyze_profile, images[0], worker_meta, subject, frontal, layers,
                                 timeout=s.timeout_profile_s)
    return analysis_response(request, out, kind="profile", session_id=session_id, info=info)


# ================================================================================= report


@router.post(
    "/report", response_model=ReportResponse, summary="Build the report with considerations",
    description="Combines the session's frontal result and, optionally, its profile result into the report with "
                "considerations from the rules file. Both tokens must share a `session_id` (otherwise 400 "
                "`session_mismatch`). The response is `user_view(report)`: each consideration with its "
                "triggering measurements and reference range, the advice to consult a licensed surgeon, and the "
                "disclaimer. No token is returned.",
    responses=problems("invalid_request", "subject_mismatch", "session_mismatch", "token_invalid", "token_stale",
                       *_BUSY, "payload_too_large", "unsupported_media_type", "analysis_timeout", "internal_error"),
    openapi_extra=json_body(ReportRequest),
)
async def report(request: Request) -> JSONResponse:
    api = api_state(request)
    s = api.settings
    async with api.pool.slot():
        info = api.pool.info()
        body = await read_json(request, ReportRequest, max_bytes=s.max_json_bytes)
        front = read_token(api, body.frontal_token, info, kind="frontal")
        prof = None
        if body.profile_token is not None:
            prof = read_token(api, body.profile_token, info, kind="profile")
            if prof.session_id != front.session_id:
                raise ApiError("session_mismatch", "the frontal and profile results come from different sessions")
        view = await api.pool.run("report", task_build_report, front.result, prof.result if prof else None,
                                  body.locale, timeout=s.timeout_report_s)
    return report_response(request, view, info=info)
