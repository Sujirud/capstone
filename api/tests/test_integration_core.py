"""Integration with the real ``facescan`` core on its committed sample images.

Skipped when the model files are missing (``python -m facescan.tools.download_models``).
The sample images (public domain) fail the capture gates, so the ``ok`` paths use
their real results, computed by the core in the test process, with only ``status``
changed to ``ok`` and sealed by the test; the adjustment (including the re-snapping of
silhouette points), user view, overlay and report are then computed by the real core
in the API's workers.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from facescan_api.tokens import seal
from facescan_api.workers import default_engine_factory
from tests.conftest import analyze, image_bytes, make_settings, overlay_files, running_app

CORE_ROOT = Path(__file__).resolve().parents[2]
MODELS = CORE_ROOT / "models"
SAMPLE = CORE_ROOT / "tests" / "data" / "astronaut.png"
PROFILE = CORE_ROOT / "tests" / "data" / "profile_pollaiuolo_painting.jpg"   # public domain; see its README
SUBJECT = {"sex": "female", "age": 28}

pytestmark = pytest.mark.skipif(
    not (MODELS / "face_landmarker.task").is_file() or not SAMPLE.is_file() or not PROFILE.is_file(),
    reason="core models or sample image not available")


@pytest.fixture(scope="module")
def real() -> Iterator[TestClient]:
    with running_app(make_settings(models_dir=str(MODELS), workers=1), factory=default_engine_factory) as c:
        yield c


@pytest.fixture(scope="module")
def engine() -> Iterator[Any]:
    """The core in the test process, for full results of the failed sample captures."""
    from facescan import EngineConfig, FaceScanEngine

    with FaceScanEngine(EngineConfig.from_models_dir(MODELS)) as eng:
        yield eng


def frontal_result(engine: Any) -> dict[str, Any]:
    from facescan import SubjectInfo, load_image

    return engine.analyze_frontal(load_image(SAMPLE.read_bytes()), subject=SubjectInfo(**SUBJECT)).model_dump(mode="json")


def profile_result(engine: Any) -> dict[str, Any]:
    from facescan import SubjectInfo, load_image

    return engine.analyze_profile(load_image(PROFILE.read_bytes()), subject=SubjectInfo(**SUBJECT),
                                  facing="left").model_dump(mode="json")


def seal_ok(result: dict[str, Any], kind: str, **quality: Any) -> str:
    """Seal a real result as if its capture had passed (status and quality), the only state tokens carry."""
    ok = {**result, "status": "ok", "quality": {**result["quality"], "passed": True, **quality}}
    return seal(kind=kind, session_id="s-int", result=ok)


def profile(real: TestClient, meta: dict, image: bytes | None = None) -> Any:
    return real.post("/v1/profile/analyze",
                     files=[("image", ("p.jpg", image if image is not None else PROFILE.read_bytes(), "image/jpeg")),
                            ("meta", (None, json.dumps(meta), "application/json"))])


def distance_to_polyline(p: tuple[float, float], line: list) -> float:
    """``line``: [[x, y], …] (user view) or [{"x", "y"}, …] (full result)."""
    import numpy as np

    rows = [[q["x"], q["y"]] if isinstance(q, dict) else q for q in line]
    pts, q = np.asarray(rows, dtype=float), np.asarray(p, dtype=float)
    a, b = pts[:-1], pts[1:]
    ab = b - a
    t = np.clip(((q - a) * ab).sum(1) / np.maximum((ab * ab).sum(1), 1e-12), 0, 1)
    return float(np.min(np.hypot(*(a + t[:, None] * ab - q).T)))


def test_readiness_with_the_real_engine(real: TestClient):
    assert real.get("/readyz").json() == {"status": "ready", "workers": 1}
    cfg = real.get("/v1/client-config?locale=en").json()
    assert cfg["user_adjustable_points"]["frontal"] == ["trichion"]
    assert cfg["frontal"]["burst"]["min_frames"] == 3 and "golden_ratio" in cfg["overlay"]["layers"]
    assert cfg["config_hash"].startswith("sha256:") and cfg["rules_version"] == "EXAMPLE"


def test_real_capture_outcomes(real: TestClient):
    img = SAMPLE.read_bytes()
    meta = {"subject": SUBJECT, "locale": "en"}
    b = analyze(real, frames=[img], meta=meta).json()
    assert b["status"] == "quality_failed" and "pitch_deg" in b["failed_checks"]
    assert b["hints"] and all(isinstance(h, str) and not h.startswith("hint.") for h in b["hints"])
    assert "result" not in b and "result_token" not in b and b["warnings"] == ["distance_unverified"]
    assert analyze(real, frames=[img, img, img], meta=meta).json()["status"] == "quality_failed"   # a burst
    assert analyze(real, frames=[image_bytes()], meta=meta).json()["status"] == "no_face"


def test_adjust_and_overlay_with_the_real_core(real: TestClient, engine: Any):
    img = SAMPLE.read_bytes()
    result = frontal_result(engine)
    token = seal_ok(result, "frontal")
    # The helmet hides the hairline: the user places the trichion where no automatic point exists.
    assert result["landmarks"]["trichion"]["x"] is None
    n = result["landmarks"]["nasion"]
    r = real.post("/v1/adjust", json={
        "result_token": token, "overrides": {"trichion": {"x": n["x"], "y": n["y"] - 90.0}}, "locale": "th"})
    assert r.status_code == 200, r.text
    b = r.json()
    lm = b["result"]["landmarks"]["trichion"]
    assert lm["source"] == "user_adjusted" and lm["adjusted"] and lm["y"] == n["y"] - 90.0
    assert lm["confidence"] == "low" and "no_automatic_position" in lm["flags"] and lm["auto"]["y"] is None
    assert b["result"]["metrics"]["F1_upper_third"]["value"] is not None       # the upper third now has a hairline
    clinic_only = {m for m, v in result["metrics"].items() if v["display"] == "clinic_only"}
    assert clinic_only and not clinic_only & set(b["result"]["metrics"])
    r = real.post("/v1/adjust", json={"result_token": token, "overrides": {"nasion": {"x": 1.0, "y": 1.0}}})
    assert r.status_code == 422 and r.json()["code"] == "point_not_adjustable"

    ov = {"result_token": b["result_token"], "layers": ["landmarks", "thirds", "labels"], "locale": "th"}
    r = real.post("/v1/overlay", files=overlay_files(img, ov))
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(r.content)).size == (512, 512)
    r = real.post("/v1/overlay", files=overlay_files(image_bytes(size=(512, 512)), ov))
    assert r.status_code == 422 and r.json()["code"] == "image_mismatch"


def test_meta_camera_reaches_the_core(real: TestClient):
    meta = {"subject": SUBJECT, "locale": "en", "camera": {"focal_px": 600.0, "source": "device"}}
    b = analyze(real, frames=[SAMPLE.read_bytes()], meta=meta).json()
    assert b["status"] == "quality_failed" and b["warnings"] == []           # the distance could be checked


def test_real_profile_analysis(real: TestClient, engine: Any):
    meta = {"facing": "left", "subject": SUBJECT, "locale": "th"}
    b = profile(real, meta).json()
    assert b["status"] == "contour_failed" and {"profile_points", "landmark_order"} <= set(b["failed_checks"])
    assert b["hints"] and any("฀" <= ch <= "๿" for ch in b["hints"][0])
    assert "no_frontal_scale" in b["warnings"] and "result" not in b and "result_token" not in b
    # With a frontal token (the astronaut's result, same subject) the frontal result reaches the core's
    # scale transfer. It then stops because this painting's profile lacks a nasion.
    front = frontal_result(engine)
    assert front["calibration"]["method"] == "iris" and front["calibration"]["mm_per_px"]
    ftok = seal_ok(front, "frontal")
    b = profile(real, {"facing": "left", "frontal_token": ftok}).json()
    assert b["status"] == "contour_failed" and "no_frontal_scale" not in b["warnings"]
    r = profile(real, {"facing": "left", "frontal_token": ftok, "subject": {"sex": "male", "age": 28}})
    assert r.status_code == 400 and r.json()["code"] == "subject_mismatch"


def test_real_profile_adjust_resnaps_and_overlay(real: TestClient, engine: Any):
    full = profile_result(engine)
    assert len(full["contour"]) > 50 and full["landmarks"]["pronasale"]["source"] == "contour"
    ptok = seal_ok(full, "profile")
    pn = full["landmarks"]["pronasale"]
    sent = {"x": pn["x"] - 30.0, "y": pn["y"] + 4.0}           # facing left: 30 px in front of the nose tip
    assert distance_to_polyline((sent["x"], sent["y"]), full["contour"]) > 20
    r = real.post("/v1/adjust", json={"result_token": ptok, "overrides": {"pronasale": sent}})
    assert r.status_code == 200, r.text
    lm = r.json()["result"]["landmarks"]["pronasale"]
    assert lm["source"] == "user_adjusted" and lm["auto"]["x"] == pn["x"]
    assert distance_to_polyline((lm["x"], lm["y"]), full["contour"]) < 0.5     # re-snapped by the core
    assert math.hypot(lm["x"] - sent["x"], lm["y"] - sent["y"]) > 20
    ov = {"result_token": r.json()["result_token"], "layers": ["landmarks", "profile_lines", "labels"], "locale": "th"}
    r = real.post("/v1/overlay", files=overlay_files(PROFILE.read_bytes(), ov))
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).size == (669, 1000)
    r = real.post("/v1/overlay", files=overlay_files(SAMPLE.read_bytes(), ov))
    assert r.status_code == 422 and r.json()["code"] == "image_mismatch"


def test_real_report_with_the_example_rules(real: TestClient, engine: Any):
    ftok, ptok = seal_ok(frontal_result(engine), "frontal"), seal_ok(profile_result(engine), "profile")   # one session
    r = real.post("/v1/report", json={"frontal_token": ftok, "profile_token": ptok, "locale": "th"})
    assert r.status_code == 200, r.text
    rep = r.json()["report"]
    assert rep["status"] == "ok" and rep["rules_version"] == "EXAMPLE" and rep["locale"] == "th"
    # The distance was never verified (no focal length), so no rule may fire.
    assert rep["considerations"] == [] and rep["no_considerations_note"] and "rule_audit" not in rep
    assert rep["frontal"]["view"] == "frontal" and rep["profile"]["view"] == "profile"


def test_real_consideration_fires_through_the_api(real: TestClient, engine: Any):
    """Real core and example rules. The astronaut's alar width (F6) is 'above' with high confidence; sealed as an
    eligible capture (the gates it misses), EXAMPLE-03 fires and the user view shows it in plain language with its reference range."""
    front = frontal_result(engine)
    assert front["metrics"]["F6_alar_icd_ratio"]["status"] == "above"
    r = real.post("/v1/report", json={"frontal_token": seal_ok(front, "frontal", considerations_eligible=True),
                                      "locale": "th"})
    assert r.status_code == 200, r.text
    rep = r.json()["report"]
    [c] = rep["considerations"]
    assert c["rule_id"] == "EXAMPLE-03" and c["area"] == "nose" and c["area_text"]
    assert c["finding"] and not c["finding"].startswith("finding.") and c["considerations"] and c["consult"]
    [m] = c["measurements"]
    assert m["id"] == "F6_alar_icd_ratio" and m["status"] == "above" and m["reference"]["text"]
    assert rep["no_considerations_note"] is None and rep["consideration_intro"]
    assert "rule_audit" not in rep
