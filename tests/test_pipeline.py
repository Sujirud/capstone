"""Smoke and integration tests with the real models on tests/data (skipped without models)."""

import cv2
import numpy as np
import pytest

from facescan import (FrontalResult, ImageMismatchError, InvalidInputError, LoadedImage, Override,
                      PointNotAdjustableError, SubjectInfo)
from facescan.core.geometry import FaceAxes
from facescan.core.metrics_frontal import FRONTAL_METRIC_IDS

LAYERS = {"landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels", "golden_ratio"}


def test_blank_image_is_no_face(engine, subject):
    r = engine.analyze_frontal(LoadedImage.from_array(np.full((480, 640, 3), 128, np.uint8)), subject=subject)
    assert r.status == "no_face" and not r.quality.passed and r.quality.hint_keys == ["hint.no_face"]
    assert r.metrics == {} and FrontalResult.model_validate_json(r.model_dump_json()) == r


def test_two_faces_is_multiple_faces(engine, astronaut, subject, astronaut_result):
    # Tight crops, so each face stays large enough for the detector after its internal downscale.
    L = astronaut_result.landmarks
    cx, cy = int(L["pronasale"].x), int(L["pronasale"].y)
    half = int(1.3 * (L["menton"].y - L["mesh_top"].y) / 2 + 20)
    crop = astronaut.pixels[max(0, cy - half):cy + half, max(0, cx - half):cx + half]
    two = LoadedImage.from_array(np.ascontiguousarray(np.hstack([crop, crop])))
    r = engine.analyze_frontal(two, subject=subject)
    assert r.status == "multiple_faces" and r.quality.hint_keys == ["hint.multiple_faces"]


def test_small_face_fails_quality_but_is_measured(astronaut_result):
    r = astronaut_result
    assert r.status == "quality_failed"
    by = {c.id: c for c in r.quality.checks}
    assert by["ipd_px"].status == "fail" and by["camera_distance_m"].status == "unverified"
    assert not r.quality.considerations_eligible
    assert r.landmarks["trichion"].reason == "hair_covers_forehead"  # bangs cover the forehead
    assert r.metrics["F1_upper_third"].status == "unavailable"
    assert r.metrics["F1_middle_lower_ratio"].value is not None
    assert r.metrics["F5_canthal_tilt_right"].uncertainty_method == "tta"
    assert r.calibration.method == "iris" and r.frames.reference_sha256 is not None
    assert set(r.metrics) == set(FRONTAL_METRIC_IDS)


def test_determinism_and_json_round_trip(engine, astronaut, subject, astronaut_result):
    again = engine.analyze_frontal(astronaut, subject=subject)
    assert again.model_dump_json() == astronaut_result.model_dump_json()
    assert FrontalResult.model_validate_json(astronaut_result.model_dump_json()) == astronaut_result


def test_apply_overrides_equals_full_reanalysis(engine, astronaut, subject, astronaut_result):
    sn, gl = astronaut_result.landmarks["subnasale"], astronaut_result.landmarks["glabella"]
    ovs = {"trichion": Override(x=gl.x, y=gl.y - 0.9 * (sn.y - gl.y), source="user_adjusted"),
           "subnasale": Override(x=sn.x + 1.5, y=sn.y + 2.0, source="clinician")}
    adjusted = engine.apply_overrides(astronaut_result, ovs)
    full = engine.analyze_frontal(astronaut, subject=subject, overrides=ovs)
    assert adjusted == full
    for mid, m in adjusted.metrics.items():
        uses = {"trichion", "subnasale"} & set(m.landmarks_used)
        if uses:
            assert m.uncertainty_method in ("landmark_sampling", None), mid
        else:
            assert m == astronaut_result.metrics[mid], mid
    assert adjusted.landmarks["trichion"].confidence == "low"  # no automatic hairline existed


def test_user_override_outside_allowlist_is_rejected(engine, astronaut, subject):
    with pytest.raises(PointNotAdjustableError):
        engine.analyze_frontal(astronaut, subject=subject,
                               overrides={"menton": Override(x=10, y=10, source="user_adjusted")})


def test_invalid_bursts(engine, astronaut, subject):
    with pytest.raises(InvalidInputError):
        engine.analyze_frontal([astronaut, astronaut], subject=subject)
    small = LoadedImage.from_array(np.ascontiguousarray(astronaut.pixels[:500, :500]))
    with pytest.raises(InvalidInputError, match="frame_size_mismatch"):
        engine.analyze_frontal([astronaut, astronaut, small], subject=subject)
    with pytest.raises(InvalidInputError):
        engine.analyze_frontal(astronaut, subject=SubjectInfo(sex="female", age=30, norms_profile="nope"))


def test_single_image_vs_burst_uncertainty(engine, astronaut, subject, astronaut_result):
    # Identical frames: across-frame SD is 0. With fewer than 5 frames the larger TTA estimate wins.
    r3 = engine.analyze_frontal([astronaut] * 3, subject=subject)
    assert r3.frames.count == 3 and r3.frames.used == [0, 1, 2]
    m3 = r3.metrics["F5_canthal_tilt_right"]
    assert m3.uncertainty_method == "tta"
    assert m3.uncertainty == pytest.approx(astronaut_result.metrics["F5_canthal_tilt_right"].uncertainty)
    assert m3.value == pytest.approx(astronaut_result.metrics["F5_canthal_tilt_right"].value)
    assert any(c.id == "burst_good_frames" for c in r3.quality.checks)
    # With 5 frames only the burst SD is used.
    r5 = engine.analyze_frontal([astronaut] * 5, subject=subject)
    m5 = r5.metrics["F5_canthal_tilt_right"]
    assert m5.uncertainty_method == "burst_sd" and m5.uncertainty == pytest.approx(0.0)


def test_roll_is_measured_and_removed(engine, astronaut, subject, astronaut_result):
    h, w = astronaut.pixels.shape[:2]
    A = cv2.getRotationMatrix2D((w / 2, h / 2), 10.0, 1.0)  # +10° = counter-clockwise on screen
    rot = LoadedImage.from_array(cv2.warpAffine(astronaut.pixels, A, (w, h), borderMode=cv2.BORDER_REPLICATE))
    r = engine.analyze_frontal(rot, subject=subject)
    d_roll = r.pose.roll_deg - astronaut_result.pose.roll_deg
    assert d_roll == pytest.approx(-10.0, abs=2.0)  # roll > 0 is clockwise on screen
    L = {n: lm.xy() for n, lm in r.landmarks.items() if lm.available}
    ax = FaceAxes.from_medial_canthi(L["medial_canthus_right"], L["medial_canthus_left"])
    assert ax.roll_deg == pytest.approx(r.pose.roll_deg, abs=4.0)
    for mid in ("F1_middle_lower_ratio", "F4_eye_icd_ratio_right", "F6_alar_icd_ratio"):
        assert r.metrics[mid].value == pytest.approx(astronaut_result.metrics[mid].value, rel=0.05), mid


def test_overlay_requires_the_reference_image(engine, astronaut, astronaut_result):
    for style in ("user", "clinical"):
        out = engine.render_overlay(astronaut, astronaut_result, layers=LAYERS, style=style, locale="th")
        assert out.shape == astronaut.pixels.shape and out.dtype == np.uint8
        assert not np.array_equal(out, astronaut.pixels)
    other = LoadedImage.from_array(np.ascontiguousarray(astronaut.pixels[::-1]))
    with pytest.raises(ImageMismatchError):
        engine.render_overlay(other, astronaut_result, layers={"landmarks"})


def test_user_style_never_draws_the_golden_ratio(engine, astronaut, astronaut_result):
    a = engine.render_overlay(astronaut, astronaut_result, layers={"golden_ratio"}, style="user")
    b = engine.render_overlay(astronaut, astronaut_result, layers=set(), style="user")
    assert np.array_equal(a, b)


def test_client_config_matches_server_settings(engine):
    cc = engine.client_config("th")
    g = engine.settings.capture.frontal.gates
    assert cc["frontal"]["gates"]["ipd_min_px"] == g.ipd_min_px
    assert cc["frontal"]["gates"]["expression"] == g.expression
    assert cc["frontal"]["burst"]["min_frames"] == 3 and cc["frontal"]["burst"]["max_frames"] == 15
    assert cc["user_adjustable_points"]["frontal"] == ["trichion"]
    assert cc["strings"]["hint"]["move_back"].startswith("เลื่อน")
    assert cc["config_hash"].startswith("sha256:") and cc["core_version"] == engine.core_version


def test_ok_path_with_relaxed_gates(tmp_path, astronaut, subject):
    """The astronaut photo fails the real gates; with test-only relaxed gates the full `ok` path runs."""
    import shutil

    import yaml

    from facescan import CameraInfo, EngineConfig, FaceScanEngine, user_view
    from facescan.core.config import DEFAULT_CONFIG_DIR
    from helpers import MODELS

    cfg_dir = tmp_path / "config"
    shutil.copytree(DEFAULT_CONFIG_DIR, cfg_dir)
    cap = yaml.safe_load((cfg_dir / "capture.yaml").read_text(encoding="utf-8"))
    g = cap["frontal"]["gates"]
    g.update(ipd_min_px=20.0, pitch_max_deg=30.0, yaw_max_deg=30.0, camera_distance_min_m=0.1)
    g["expression"] = {k: 1.01 for k in g["expression"]}
    (cfg_dir / "capture.yaml").write_text(yaml.safe_dump(cap, allow_unicode=True), encoding="utf-8")

    with FaceScanEngine(EngineConfig.from_models_dir(MODELS, config_dir=cfg_dir)) as eng:
        img = LoadedImage.from_array(astronaut.pixels, camera=CameraInfo(focal_px=600.0, source="configured_fov"))
        r = eng.analyze_frontal(img, subject=subject)
        assert r.status == "ok" and r.quality.passed and r.quality.considerations_eligible
        assert r.config_hash != "" and r.camera.source == "configured_fov"
        v = eng.user_view(r, locale="th")
        assert v["status"] == "ok" and "F10_golden_ratio" not in v["metrics"] and v["metrics"]
        assert user_view(r, locale="en", config_dir=cfg_dir)["metrics"].keys() == v["metrics"].keys()
