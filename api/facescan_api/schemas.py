"""Request and response models: the source of the OpenAPI schema.

Requests are strict (``extra="forbid"``, no type coercion for numbers, finite
floats only). ``result`` and ``report`` in responses are the core's ``user_view``,
passed through unchanged; their schema belongs to the core (``facescan.core.schema``).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

Locale = Literal["th", "en"]
FiniteFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]
TokenStr = Annotated[str, Field(min_length=1, max_length=512 * 1024)]
LayerName = Annotated[str, Field(min_length=1, max_length=32)]
PointName = Annotated[str, Field(min_length=1, max_length=64)]
Layers = Annotated[list[LayerName], Field(min_length=1, max_length=16)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


def _unique(v: list[Any]) -> list[Any]:
    if len(set(v)) != len(v):
        raise ValueError("items must be unique")
    return v


# ============================================================================ requests


class SubjectIn(_Strict):
    """Self-reported; ``norms_profile`` is set by server config, never by the client."""

    sex: Literal["female", "male", "unspecified"]
    age: Annotated[StrictInt, Field(ge=1, le=120)]


class CameraIn(_Strict):
    """Intrinsics of the image exactly as uploaded (after EXIF orientation). Wins over EXIF."""

    focal_px: Annotated[FiniteFloat, Field(gt=0)]
    source: Literal["device", "exif", "configured_fov", "calibration"]


class OverlayRequest(_Strict):
    """The overlay to render with the result, with these layers."""

    layers: Layers

    _u = field_validator("layers")(_unique)


class FrontalAnalyzeMeta(_Strict):
    model_config = ConfigDict(json_schema_extra={"examples": [{
        "subject": {"sex": "female", "age": 28},
        "camera": {"focal_px": 2890.0, "source": "device"},
        "locale": "th",
        "overlay": {"layers": ["landmarks", "thirds", "fifths"]},
    }]})

    subject: SubjectIn
    camera: CameraIn | None = None
    locale: Locale = "th"
    overlay: OverlayRequest | None = None


class ProfileAnalyzeMeta(_Strict):
    """With ``frontal_token`` the subject and session come from it (a different ``subject`` → 400
    ``subject_mismatch``); without one ``subject`` is required and mm values are unavailable."""

    model_config = ConfigDict(json_schema_extra={"examples": [{
        "facing": "left",
        "camera": {"focal_px": 2890.0, "source": "device"},
        "locale": "th",
        "overlay": {"layers": ["landmarks", "profile_lines"]},
        "frontal_token": "eJy…",
    }]})

    facing: Literal["left", "right"]
    camera: CameraIn | None = None
    locale: Locale = "th"
    overlay: OverlayRequest | None = None
    frontal_token: TokenStr | None = None
    subject: SubjectIn | None = None


class PointIn(_Strict):
    x: FiniteFloat
    y: FiniteFloat


class AdjustRequest(_Strict):
    """Point overrides in pixels of the analyzed image; the API records each as a user adjustment."""

    model_config = ConfigDict(json_schema_extra={"examples": [{
        "result_token": "eJy…",
        "overrides": {"trichion": {"x": 1012.5, "y": 388.0}},
        "locale": "th",
    }]})

    result_token: TokenStr
    overrides: Annotated[dict[PointName, PointIn], Field(min_length=1, max_length=32)]
    locale: Locale = "th"


class OverlayMeta(_Strict):
    model_config = ConfigDict(json_schema_extra={"examples": [{
        "result_token": "eJy…",
        "layers": ["landmarks", "thirds", "fifths"],
        "locale": "th",
    }]})

    result_token: TokenStr
    layers: Layers
    locale: Locale = "th"

    _u = field_validator("layers")(_unique)


class ReportRequest(_Strict):
    """Both tokens must share a ``session_id``; the profile is optional."""

    model_config = ConfigDict(json_schema_extra={"examples": [{
        "frontal_token": "eJy…", "profile_token": "eJy…", "locale": "th"}]})

    frontal_token: TokenStr
    profile_token: TokenStr | None = None
    locale: Locale = "th"


# =========================================================================== responses


class Versions(BaseModel):
    api: str
    core: str
    schema_: str = Field(alias="schema", serialization_alias="schema")

    model_config = ConfigDict(populate_by_name=True)


class AnalyzeResponse(BaseModel):
    """Analyze and adjust responses. ``status`` passes through from the core."""

    model_config = ConfigDict(json_schema_extra={"examples": [{
        "request_id": "req_0192f3a4b5c6d7e8f9a0b1c2d3",
        "status": "ok",
        "failed_checks": [],
        "hints": [],
        "warnings": ["distance_unverified"],
        "result": {"view": "frontal", "status": "ok", "metrics": {"…": "…"}},
        "result_token": "eJy…",
        "overlay": "data:image/jpeg;base64,/9j/…",
        "versions": {"api": "0.1.0", "core": "0.1.0", "schema": "2.0"},
    }]})

    request_id: str
    status: Literal["ok", "no_face", "multiple_faces", "quality_failed", "contour_failed"]
    failed_checks: list[str] = Field(description="Ids of the quality checks that failed (empty when ok).")
    hints: list[str] = Field(description="The core's localized capture hints.")
    warnings: list[str] = Field(description="Non-blocking notes, e.g. distance_unverified, no_frontal_scale.")
    result: dict[str, Any] | None = Field(default=None, description="The core's user_view; present only when "
                                                                    "status is ok.")
    result_token: str | None = Field(default=None, description="Present only when status is ok. Opaque.")
    overlay: str | None = Field(
        default=None, description="The requested overlay as a data:image/jpeg;base64 URI (status ok only).")
    versions: Versions


class ReportResponse(BaseModel):
    """The report's user view. No token is returned."""

    model_config = ConfigDict(json_schema_extra={"examples": [{
        "request_id": "req_0192f3a4b5c6d7e8f9a0b1c2d3",
        "status": "ok",
        "report": {
            "status": "ok", "locale": "en", "rules_version": "EXAMPLE",
            "frontal": {"view": "frontal", "…": "…"}, "profile": {"view": "profile", "…": "…"},
            "consideration_intro": "Features you may want to discuss with a licensed plastic surgeon",
            "considerations": [{
                "rule_id": "EXAMPLE-01", "area": "nose", "area_text": "Nose", "severity": "info",
                "severity_text": "…", "finding": "…", "considerations": ["…"],
                "measurements": [{"id": "P2_nasolabial_angle", "name": "…", "value_text": "84.2°",
                                  "status": "below", "status_text": "…",
                                  "reference": {"basis": "canon", "min": 95.0, "max": 105.0,
                                                "text": "95.0° – 105.0°"}}],
                "consult": "Please consult a licensed plastic surgeon in person before making any decision."}],
            "no_considerations_note": None, "disclaimer": "…"},
        "versions": {"api": "0.1.0", "core": "0.1.0", "schema": "2.0"},
    }]})

    request_id: str
    status: Literal["ok", "no_face", "multiple_faces", "quality_failed", "contour_failed"]
    report: dict[str, Any] = Field(description="The core's user_view(report).")
    versions: Versions


class UploadLimits(BaseModel):
    max_image_bytes: int
    max_request_bytes: int
    max_frames: int
    max_pixels: int
    max_burst_pixels: int
    accepted_types: list[str]


class ClientConfigResponse(BaseModel):
    """``engine.client_config(locale)`` (gates, burst, adjustable points, strings) plus the API's limits."""

    model_config = ConfigDict(extra="allow", json_schema_extra={"examples": [{
        "core_version": "0.1.0", "schema_version": "2.0", "config_hash": "3f9a…", "locale": "th",
        "frontal": {"gates": {"…": "…"}, "burst": {"min_frames": 3, "max_frames": 15, "recommended_frames": 7}},
        "profile": {"gates": {"…": "…"}},
        "user_adjustable_points": {"frontal": ["trichion"], "profile": ["…"]},
        "strings": {"hint": {"…": "…"}},
        "upload_limits": {"max_image_bytes": 12000000, "max_request_bytes": 60000000, "max_frames": 15,
                          "max_pixels": 24000000, "max_burst_pixels": 125000000,
                          "accepted_types": ["image/jpeg", "image/png", "image/webp"]},
        "overlay": {"layers": ["landmarks", "thirds", "fifths"], "max_side_px": 1600},
        "rules_version": "EXAMPLE",
        "versions": {"api": "0.1.0", "core": "0.1.0", "schema": "2.0"},
    }]})

    core_version: str
    schema_version: str
    config_hash: str
    locale: Locale
    upload_limits: UploadLimits
    overlay: dict[str, Any]
    rules_version: str = Field(description="The loaded rules file's version.")
    versions: Versions


class Problem(BaseModel):
    """RFC 9457 problem details with a stable ``code``."""

    model_config = ConfigDict(json_schema_extra={"examples": [{
        "type": "about:blank", "title": "Unprocessable Content", "status": 422,
        "detail": "invalid fields: subject.age: less_than_equal", "code": "invalid_meta",
        "request_id": "req_0192f3a4b5c6d7e8f9a0b1c2d3"}]})

    type: str = "about:blank"
    title: str
    status: int
    detail: str
    code: str
    request_id: str | None = None


class ReadyResponse(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"status": "ready", "workers": 4}]})

    status: Literal["ready"]
    workers: int
