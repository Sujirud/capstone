"""Endpoints end to end with the fake engine: status mapping, tokens, adjust, overlay."""

from __future__ import annotations

import base64
import io
import json
import random
from typing import Any

from fastapi.testclient import TestClient
from PIL import Image

from facescan_api import __version__
from facescan_api.tokens import Versions, open_token, seal
from tests.conftest import META, analyze, image_bytes, overlay_files
from tests.fake_engine import BLACK, BLUE, CLINIC_ONLY_SENTINEL, CONFIG_HASH, MAGENTA

CHIN_DOWN_EN = "Lower your chin slightly."
V = Versions(core="0.1.0", schema="2.0", config_hash=CONFIG_HASH)


def ok(client: TestClient, **kw: Any) -> dict[str, Any]:
    r = analyze(client, **kw)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    return body


def problem(r: Any) -> tuple[int, str]:
    assert r.headers["content-type"] == "application/problem+json", r.text
    body = r.json()
    assert set(body) == {"type", "title", "status", "detail", "code", "request_id"}
    assert body["status"] == r.status_code and body["request_id"] == r.headers["x-request-id"]
    return r.status_code, body["code"]


def adjust(client: TestClient, token: str, overrides: dict[str, Any]) -> Any:
    return client.post("/v1/adjust", json={"result_token": token, "overrides": overrides, "locale": "en"})


def result_of(token: str) -> dict[str, Any]:
    return open_token(token, versions=V, max_chars=512 * 1024).result


def decode_data_uri(uri: str) -> Image.Image:
    assert uri.startswith("data:image/jpeg;base64,")
    return Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1])))


# ------------------------------------------------------------------------------ analyze


def test_ok_response(client: TestClient):
    r = analyze(client)
    b = r.json()
    assert set(b) == {"request_id", "status", "failed_checks", "hints", "warnings", "result", "result_token",
                      "versions"}
    assert (b["status"], b["failed_checks"], b["hints"]) == ("ok", [], [])
    assert b["warnings"] == ["distance_unverified"]            # no focal length: passes through from the core
    assert b["versions"] == {"api": __version__, "core": "0.1.0", "schema": "2.0"}
    assert b["result"]["view"] == "frontal" and b["result"]["locale"] == "en"
    assert r.headers["x-request-id"] == b["request_id"] and b["request_id"].startswith("req_")


def test_camera_from_meta(client: TestClient):
    b = ok(client, meta={**META, "camera": {"focal_px": 2890.0, "source": "device"}})
    assert b["warnings"] == []


def test_failed_captures_give_hints_and_no_token(client: TestClient):
    b = analyze(client, frames=[image_bytes(BLUE)]).json()
    assert (b["status"], b["failed_checks"], b["hints"]) == ("quality_failed", ["pitch_deg"], [CHIN_DOWN_EN])
    assert "result" not in b and "result_token" not in b
    b = analyze(client, frames=[image_bytes(BLACK)], meta={**META, "locale": "th"}).json()
    assert (b["status"], b["failed_checks"]) == ("no_face", ["face_count"])
    assert b["hints"] and any("฀" <= ch <= "๿" for ch in b["hints"][0])   # Thai text
    assert "result" not in b and "result_token" not in b


def test_responses_carry_the_user_view_and_tokens_the_full_result(client: TestClient):
    r = analyze(client)
    assert "F10_golden_ratio" not in r.json()["result"]["metrics"] and "F1_upper_third" in r.json()["result"]["metrics"]
    assert str(CLINIC_ONLY_SENTINEL) not in json.dumps(r.json()["result"])
    full = result_of(r.json()["result_token"])     # the token keeps the full result for later calls
    assert full["metrics"]["F10_golden_ratio"]["value"] == CLINIC_ONLY_SENTINEL


def test_overlays_in_analyze(client: TestClient):
    meta = {**META, "overlay": {"layers": ["landmarks", "thirds"]}}
    b = ok(client, meta=meta, frames=[image_bytes(size=(2000, 1000))])
    im = decode_data_uri(b["overlay"])
    assert im.format == "JPEG" and im.size == (1600, 800) and not im.getexif()
    assert im.getpixel((5, 5))[0] > 240                         # the fake engine's overlay mark
    b = analyze(client, frames=[image_bytes(BLUE)], meta=meta).json()
    assert "overlay" not in b                                    # failed captures get none


def test_an_unexpected_error_is_a_500_problem_with_the_request_id(client: TestClient):
    assert problem(analyze(client, frames=[image_bytes(MAGENTA)])) == (500, "internal_error")
    assert analyze(client).json()["status"] == "ok"


# ------------------------------------------------------------------------------ adjust


def test_adjust_returns_a_new_token_in_the_same_session(client: TestClient):
    first = ok(client)
    r = adjust(client, first["result_token"], {"trichion": {"x": 32.0, "y": 2.0}})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["status"] == "ok" and b["result_token"] != first["result_token"] and "overlay" not in b
    lm = b["result"]["landmarks"]["trichion"]
    assert (lm["x"], lm["y"], lm["source"], lm["adjusted"]) == (32.0, 2.0, "user_adjusted", True)
    assert b["result"]["metrics"]["F1_upper_third"]["value"] != first["result"]["metrics"]["F1_upper_third"]["value"]
    old = open_token(first["result_token"], versions=V, max_chars=512 * 1024)
    new = open_token(b["result_token"], versions=V, max_chars=512 * 1024)
    assert new.session_id == old.session_id and new.kind == "frontal"
    again = adjust(client, b["result_token"], {"trichion": {"x": 30.0, "y": 3.0}})   # adjustments chain
    assert again.status_code == 200 and again.json()["result"]["landmarks"]["trichion"]["x"] == 30.0


def test_only_user_adjustable_points_move(client: TestClient):
    token = ok(client)["result_token"]
    assert problem(adjust(client, token, {"nasion": {"x": 30.0, "y": 20.0}})) == (422, "point_not_adjustable")
    assert problem(adjust(client, token, {"no_such_point": {"x": 1.0, "y": 1.0}})) == (422, "point_not_adjustable")
    assert problem(adjust(client, token, {"trichion": {"x": 5000.0, "y": 1.0}})) == (400, "invalid_request")


def test_unreadable_and_stale_tokens(client: TestClient):
    token = ok(client)["result_token"]
    i = len(token) // 2
    for bad in (token[:i], token[:i] + "!" + token[i + 1:], "garbage", seal(kind="frontal", session_id="s", result={})):
        assert problem(adjust(client, bad, {"trichion": {"x": 1.0, "y": 1.0}})) == (400, "token_invalid"), bad[:20]
    result = result_of(token)
    stale = seal(kind="frontal", session_id="s", result={**result, "config_hash": "sha256:old"})
    assert problem(adjust(client, stale, {"trichion": {"x": 1.0, "y": 1.0}})) == (400, "token_stale")
    # A token is plain JSON: a result the core does not accept makes it invalid, not a server error.
    edited = seal(kind="frontal", session_id="s", result={**result, "status": "not-a-status"})
    assert problem(adjust(client, edited, {"trichion": {"x": 1.0, "y": 1.0}})) == (400, "token_invalid")


# ------------------------------------------------------------------------------ overlay


def test_overlay_endpoint(client: TestClient):
    frames = [image_bytes((200, 150, 120 + i)) for i in range(3)]     # a burst; reference frame = 1 (fake)
    token = ok(client, frames=frames)["result_token"]
    meta = {"result_token": token, "layers": ["landmarks"], "locale": "th"}
    r = client.post("/v1/overlay", files=overlay_files(frames[1], meta))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/jpeg"
    im = Image.open(io.BytesIO(r.content))
    assert im.format == "JPEG" and im.size == (64, 48) and not im.getexif()
    r = client.post("/v1/overlay", files=overlay_files(frames[0], meta))
    assert problem(r) == (422, "image_mismatch")
    r = client.post("/v1/overlay", files=overlay_files(frames[1], {**meta, "layers": ["x"]}))
    assert problem(r) == (422, "invalid_meta")
    r = client.post("/v1/overlay", files=overlay_files(frames[1], {**meta, "extra": 1}))
    assert problem(r) == (422, "invalid_meta")                        # unknown field
    r = client.post("/v1/overlay", files=[("meta", (None, json.dumps(meta), "application/json"))])
    assert problem(r) == (400, "invalid_request")


def test_overlay_meta_fits_a_large_token(client: TestClient):
    """Overlay meta carries a token; its limit is MAX_META_BYTES plus one token, not 16 kB."""
    img = image_bytes()
    result = result_of(ok(client, frames=[img])["result_token"])
    rnd = random.Random(5)                                  # random values: zlib cannot shrink them
    extra = {f"extra_point_{i:03d}": {"x": rnd.uniform(0, 60), "y": rnd.uniform(0, 40), "source": "auto",
                                      "confidence": "high", "sd_px": rnd.uniform(0, 3)} for i in range(600)}
    big = seal(kind="frontal", session_id="s", result={**result, "landmarks": {**result["landmarks"], **extra}})
    meta = {"result_token": big, "layers": ["landmarks"]}
    assert len(json.dumps(meta)) > 16 * 1024
    r = client.post("/v1/overlay", files=overlay_files(img, meta))
    assert r.status_code == 200, r.text


# ------------------------------------------------------------- client config and health


def test_client_config(client: TestClient):
    r = client.get("/v1/client-config")
    b = r.json()
    assert r.status_code == 200 and b["locale"] == "th"
    assert r.headers["cache-control"] == "public, max-age=3600" and r.headers["etag"].startswith('"')
    assert b["upload_limits"]["max_frames"] == 15 and b["upload_limits"]["max_pixels"] == 24_000_000
    assert b["user_adjustable_points"]["frontal"] == ["trichion"]
    assert b["overlay"]["max_side_px"] == 1600 and "landmarks" in b["overlay"]["layers"]
    assert b["rules_version"] == "FAKE-1" and b["versions"]["api"] == __version__
    assert b["strings"]["hint"]["chin_down"] == "ก้มคางลงเล็กน้อย"
    en = client.get("/v1/client-config?locale=en")
    assert en.json()["strings"]["hint"]["chin_down"] == CHIN_DOWN_EN and en.headers["etag"] != r.headers["etag"]
    cached = client.get("/v1/client-config", headers={"If-None-Match": r.headers["etag"]})
    assert cached.status_code == 304 and cached.content == b"" and cached.headers["etag"] == r.headers["etag"]
    assert problem(client.get("/v1/client-config?locale=fr")) == (400, "invalid_request")
    assert problem(client.get("/v1/client-config?locale=th&debug=1")) == (400, "invalid_request")


def test_readiness_errors_and_docs(client: TestClient):
    assert client.get("/readyz").json() == {"status": "ready", "workers": 2}
    assert problem(client.get("/nope")) == (404, "not_found")
    r = client.get("/v1/frontal/analyze")
    assert problem(r) == (405, "method_not_allowed") and "POST" in r.headers["allow"]
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 200
