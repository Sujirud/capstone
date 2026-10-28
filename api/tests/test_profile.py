"""Profile analysis, profile adjustments and overlays, with the fake engine."""

from __future__ import annotations

import io
import json
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from facescan_api.tokens import Versions, open_token, seal
from tests.conftest import analyze, image_bytes, overlay_files
from tests.fake_engine import BLACK, BLUE, CONFIG_HASH, FAKE_MM_PER_PX, PROFILE_INDEX

V = Versions(core="0.1.0", schema="2.0", config_hash=CONFIG_HASH)
PROFILE_IMG = image_bytes((180, 140, 110), size=(80, 100))


def problem(r: Any) -> tuple[int, str]:
    assert r.headers["content-type"] == "application/problem+json", r.text
    return r.status_code, r.json()["code"]


def profile(client: TestClient, meta: dict[str, Any], image: bytes = PROFILE_IMG) -> Any:
    return client.post("/v1/profile/analyze", files=[("image", ("profile.png", image, "image/png")),
                                                     ("meta", (None, json.dumps(meta), "application/json"))])


def frontal_token(client: TestClient, meta: dict[str, Any] | None = None) -> str:
    b = analyze(client, meta=meta).json()
    assert b["status"] == "ok", b
    return b["result_token"]


def opened(token: str) -> Any:
    return open_token(token, versions=V, max_chars=512 * 1024)


def adjust(client: TestClient, token: str, overrides: dict[str, Any]) -> Any:
    return client.post("/v1/adjust", json={"result_token": token, "overrides": overrides})


# ----------------------------------------------------------------------------- analysis


def test_profile_with_a_frontal_token_joins_its_session(client: TestClient):
    ftok = frontal_token(client)
    r = profile(client, {"facing": "left", "locale": "en", "frontal_token": ftok})
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["status"], b["failed_checks"], b["warnings"]) == ("ok", [], [])
    res = b["result"]
    assert res["view"] == "profile" and res["facing"] == "left" and len(res["contour"]) == 60
    assert [p["id"] for p in res["adjustable_points"]] == [
        "trichion", "glabella", "nasion", "pronasale", "subnasale", "labrale_superius", "labrale_inferius",
        "soft_tissue_pogonion", "menton", "alar_crease"]
    assert res["calibration"] == {"method": "transferred_from_frontal", "available": True}
    assert res["metrics"]["P4_eline_upper_lip_mm"]["value"] is not None       # mm from the frontal scale
    front, prof = opened(ftok), opened(b["result_token"])
    assert prof.kind == "profile" and prof.session_id == front.session_id
    assert prof.result["subject"] == front.result["subject"]                  # the token's subject wins
    assert prof.result["calibration"]["mm_per_px"] == FAKE_MM_PER_PX


def test_profile_without_a_frontal_token_starts_a_session_without_mm(client: TestClient):
    assert problem(profile(client, {"facing": "right"})) == (422, "invalid_meta")     # subject required
    b = profile(client, {"facing": "right", "subject": {"sex": "male", "age": 35}, "locale": "th"}).json()
    assert b["status"] == "ok" and b["warnings"] == ["no_frontal_scale"]
    assert b["result"]["calibration"] == {"method": "none", "available": False}
    assert b["result"]["metrics"]["P4_eline_upper_lip_mm"]["value"] is None
    p1 = opened(b["result_token"])
    p2 = opened(profile(client, {"facing": "right", "subject": {"sex": "male", "age": 35}}).json()["result_token"])
    assert p1.session_id != p2.session_id
    assert p1.result["subject"] == {"sex": "male", "age": 35, "norms_profile": "canon"}


def test_subject_must_match_the_frontal_token(client: TestClient):
    ftok = frontal_token(client)                                   # META subject: female, 28
    same = profile(client, {"facing": "left", "frontal_token": ftok, "subject": {"sex": "female", "age": 28}})
    assert same.status_code == 200 and same.json()["status"] == "ok"
    for other in ({"sex": "male", "age": 28}, {"sex": "female", "age": 29}):
        r = profile(client, {"facing": "left", "frontal_token": ftok, "subject": other})
        assert problem(r) == (400, "subject_mismatch")


def test_frontal_token_checks(client: TestClient):
    ftok = frontal_token(client)
    ptok = profile(client, {"facing": "left", "frontal_token": ftok}).json()["result_token"]
    assert problem(profile(client, {"facing": "left", "frontal_token": ptok})) == (400, "token_invalid")   # wrong kind
    result = opened(ftok).result
    stale = seal(kind="frontal", session_id="s", result={**result, "config_hash": "sha256:old"})
    assert problem(profile(client, {"facing": "left", "frontal_token": stale})) == (400, "token_stale")
    assert problem(profile(client, {"facing": "left", "frontal_token": "garbage"})) == (400, "token_invalid")
    edited = seal(kind="frontal", session_id="s", result={**result, "subject": {"sex": "female", "age": "x"}})
    assert problem(profile(client, {"facing": "left", "frontal_token": edited})) == (400, "token_invalid")


def test_failed_profile_captures(client: TestClient):
    meta = {"facing": "left", "subject": {"sex": "female", "age": 30}, "locale": "en"}
    b = profile(client, meta, image=image_bytes(BLUE, size=(80, 100))).json()
    assert (b["status"], b["failed_checks"]) == ("contour_failed", ["contour_continuous"])
    assert b["hints"] and not b["hints"][0].startswith("hint.")
    assert "result" not in b and "result_token" not in b
    b = profile(client, meta, image=image_bytes(BLACK, size=(80, 100))).json()
    assert (b["status"], b["failed_checks"]) == ("no_face", ["face_count"]) and "result_token" not in b


def test_profile_meta_validation(client: TestClient):
    subj = {"sex": "female", "age": 30}
    for meta in ({"subject": subj}, {"facing": "up", "subject": subj}, {"facing": "left", "subject": subj, "x": 1},
                 {"facing": "left", "subject": {"sex": "female", "age": "30"}},
                 {"facing": "left", "subject": subj, "frontal_token": ""}):
        assert problem(profile(client, meta)) == (422, "invalid_meta"), meta
    r = client.post("/v1/profile/analyze", files=[("frames", ("p.png", PROFILE_IMG, "image/png")),
                                                  ("meta", (None, json.dumps({"facing": "left", "subject": subj}),
                                                            None))])
    assert problem(r) == (400, "invalid_request")                  # 'frames' is not a profile part
    r = client.post("/v1/profile/analyze",
                    files=[("image", ("p.png", PROFILE_IMG, "image/png")), ("image", ("q.png", PROFILE_IMG, "image/png")),
                           ("meta", (None, json.dumps({"facing": "left", "subject": subj}), None))])
    assert problem(r) == (413, "payload_too_large")
    r = profile(client, {"facing": "left", "subject": subj}, image=b"GIF89a" + b"\0" * 50)
    assert problem(r) == (415, "unsupported_media_type")


def test_profile_overlays_in_the_analysis(client: TestClient):
    meta = {"facing": "left", "subject": {"sex": "female", "age": 30},
            "overlay": {"layers": ["landmarks", "profile_lines"]}}
    b = profile(client, meta).json()
    assert b["overlay"].startswith("data:image/jpeg;base64,")
    r = profile(client, {**meta, "overlay": {"layers": ["no_such_layer"]}})
    assert problem(r) == (422, "invalid_meta")


# ------------------------------------------------------------------ adjust and overlay


def test_profile_adjustments_are_resnapped(client: TestClient):
    ftok = frontal_token(client)
    b = profile(client, {"facing": "left", "frontal_token": ftok}).json()
    ptok, res = b["result_token"], b["result"]
    contour = np.array(res["contour"])
    target = contour[PROFILE_INDEX["pronasale"] + 3] + [25.0, 0.0]      # off the silhouette
    r = adjust(client, ptok, {"pronasale": {"x": float(target[0]), "y": float(target[1])}})
    assert r.status_code == 200, r.text
    b2 = r.json()
    lm = b2["result"]["landmarks"]["pronasale"]
    assert lm["source"] == "user_adjusted" and lm["adjusted"]
    assert min(np.hypot(*(contour - [lm["x"], lm["y"]]).T)) < 1e-6          # back on the contour
    assert (lm["x"], lm["y"]) != (float(target[0]), float(target[1]))
    assert b2["result"]["view"] == "profile" and b2["result"]["metrics"]["P1_nasofrontal_angle"]["value"] != \
        res["metrics"]["P1_nasofrontal_angle"]["value"]
    new = opened(b2["result_token"])
    assert new.kind == "profile" and new.session_id == opened(ftok).session_id
    # alar_crease is not a silhouette point: kept where it was placed.
    ac = res["landmarks"]["alar_crease"]
    b3 = adjust(client, b2["result_token"], {"alar_crease": {"x": ac["x"] + 2.0, "y": ac["y"] + 1.0}}).json()
    assert (b3["result"]["landmarks"]["alar_crease"]["x"], b3["result"]["landmarks"]["alar_crease"]["y"]) == \
        (ac["x"] + 2.0, ac["y"] + 1.0)
    assert problem(adjust(client, ptok, {"trichion_x": {"x": 1.0, "y": 1.0}})) == (422, "point_not_adjustable")
    # The frontal allowlist does not apply to profile tokens, and vice versa.
    assert problem(adjust(client, ftok, {"nasion": {"x": 30.0, "y": 20.0}})) == (422, "point_not_adjustable")


def test_profile_overlay_endpoint(client: TestClient):
    ftok = frontal_token(client)
    ptok = profile(client, {"facing": "left", "frontal_token": ftok}).json()["result_token"]
    meta = {"result_token": ptok, "layers": ["landmarks", "profile_lines"], "locale": "th"}
    r = client.post("/v1/overlay", files=overlay_files(PROFILE_IMG, meta))
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(r.content)).size == (80, 100)
    r = client.post("/v1/overlay", files=overlay_files(image_bytes(), meta))
    assert problem(r) == (422, "image_mismatch")                      # the frontal photo is not the reference
