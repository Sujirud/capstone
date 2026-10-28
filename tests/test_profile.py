"""Phase 2: profile analysis."""

from __future__ import annotations

import json
import math

import numpy as np
import pytest
from scipy.interpolate import splev, splprep

from facescan import (CameraInfo, EngineConfig, FaceScanEngine, FrontalResult, InvalidInputError, LoadedImage,
                      Override, ProfileResult, SubjectInfo, UnknownPointError, load_image, user_view)
from facescan.core.geometry import project_onto_polyline
from facescan.core.metrics_profile import PROFILE_METRIC_IDS, compute_profile
from facescan.core.normalize import ScaleEstimate, frontal_transfer_inputs, transfer_scale
from facescan.core.profile_contour import CONTOUR_CHECKS, simplify_contour, snap_to_contour
from facescan.core.schema import Landmark
from helpers import DATA, MODELS, capture_settings, models_available, synthetic_result
from profile_synth import BACK, FRONT, SIZE, FakeSegmenter, make_profile

CFG = capture_settings().profile
needs_models = pytest.mark.skipif(not models_available(), reason="models missing")


# ----------------------------------------------------------------- metrics (pure)


def _profile_pts():
    return {"glabella": np.array([100.0, 100.0]), "nasion": np.array([90.0, 150.0]),
            "pronasale": np.array([140.0, 220.0]), "subnasale": np.array([60.0, 240.0]),
            "labrale_superius": np.array([65.0, 280.0]), "labrale_inferius": np.array([70.0, 320.0]),
            "soft_tissue_pogonion": np.array([100.0, 420.0]), "menton": np.array([80.0, 450.0]),
            "trichion": np.array([85.0, 20.0]), "alar_crease": np.array([90.0, 230.0])}


def _contour():
    # forehead → nasion → tip → straight columella → subnasale → lip → chin
    return np.array([[85, 20], [100, 100], [90, 150], [140, 200], [140, 220], [100, 230], [60, 240],
                     [65, 280], [70, 320], [100, 420], [80, 450]], dtype=float)


def _angle(u, v):
    return math.degrees(math.acos(np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v))))


def test_profile_metrics_known_answers():
    P = _profile_pts()
    scale = ScaleEstimate(0.2, 0.04, None, landmarks_used=("subnasale", "menton", "nasion"))
    v = {k: m.value for k, m in compute_profile(P, _contour(), "right", scale, CFG.contour).items()}
    assert set(v) == set(PROFILE_METRIC_IDS)
    assert v["P1_nasofrontal_angle"] == pytest.approx(_angle(P["glabella"] - P["nasion"], P["pronasale"] - P["nasion"]))
    # columella: straight segment tip → subnasale on the contour, direction toward the tip = (80, −20)
    assert v["P2_nasolabial_angle"] == pytest.approx(_angle(np.array([80.0, -20.0]), P["labrale_superius"] - P["subnasale"]))
    n, ac, prn = P["nasion"], P["alar_crease"], P["pronasale"]
    d = (ac - n) / np.linalg.norm(ac - n)
    perp = abs((prn - n)[0] * d[1] - (prn - n)[1] * d[0])
    assert v["P3a_tip_projection_goode"] == pytest.approx(perp / np.linalg.norm(prn - n))
    assert v["P3b_tip_projection_simons"] == pytest.approx(
        np.linalg.norm(P["subnasale"] - P["pronasale"]) / np.linalg.norm(P["subnasale"] - P["labrale_superius"]))
    e = P["soft_tissue_pogonion"] - P["pronasale"]
    nrm = np.array([e[1], -e[0]]) / np.linalg.norm(e)
    off = float(np.dot(P["labrale_superius"] - P["pronasale"], nrm))
    assert off < 0  # the lip is behind the E-line
    assert v["P4_eline_upper_lip_mm"] == pytest.approx(off * 0.2)
    assert v["P4_eline_upper_lip_pct"] == pytest.approx(off / np.linalg.norm(e) * 100)
    assert v["P5_forehead_inclination"] == pytest.approx(math.degrees(math.atan2(15, 80)))  # slopes back → +


def test_profile_metrics_are_mirror_invariant():
    P, C = _profile_pts(), _contour()
    right = compute_profile(P, C, "right", None, CFG.contour)
    mir = {k: np.array([1000.0 - p[0], p[1]]) for k, p in P.items()}
    left = compute_profile(mir, np.column_stack([1000.0 - C[:, 0], C[:, 1]]), "left", None, CFG.contour)
    for mid in PROFILE_METRIC_IDS:
        a, b = right[mid].value, left[mid].value
        assert (a is None and b is None) or a == pytest.approx(b), mid


def test_mm_metrics_need_a_scale_and_pct_forms_remain():
    v = compute_profile(_profile_pts(), _contour(), "right", None, CFG.contour)
    assert v["P4_eline_upper_lip_mm"].value is None and v["P4_eline_upper_lip_mm"].reason == "no_frontal_scale"
    assert v["P4_eline_upper_lip_pct"].value is not None
    P = _profile_pts()
    del P["alar_crease"]
    assert compute_profile(P, _contour(), "right", None, CFG.contour)["P3a_tip_projection_goode"].reason == \
        "alar_crease_unavailable"


# ------------------------------------------------------------ snap and scale transfer


def test_snap_to_contour_and_simplify():
    poly = np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]])
    assert snap_to_contour(np.array([4.0, 3.0]), poly) == pytest.approx([4.0, 0.0])
    assert snap_to_contour(np.array([14.0, 6.0]), poly) == pytest.approx([10.0, 6.0])
    dense = np.column_stack([np.linspace(0, 1000, 5000), np.zeros(5000)])
    s = simplify_contour(dense, 400)
    assert len(s) == 400 and s[0] == pytest.approx(dense[0]) and s[-1] == pytest.approx(dense[-1])


def test_scale_transfer_cross_check_and_uncertainty():
    inputs = {"frontal_sn_me_mm": 60.0, "frontal_sn_me_sd_mm": 2.4, "frontal_n_me_mm": 108.0, "frontal_n_me_sd_mm": 4.3}
    pts = {"subnasale": np.array([0.0, 200.0]), "menton": np.array([0.0, 500.0]), "nasion": np.array([0.0, -40.0])}
    s = transfer_scale(inputs, pts, {"subnasale": 3.0, "menton": 4.0}, max_disagreement_frac=0.05)
    assert s.mm_per_px == pytest.approx(60.0 / 300.0)
    assert s.rel_uncertainty == pytest.approx(math.hypot(2.4 / 60.0, 5.0 / 300.0))
    pts["nasion"] = np.array([0.0, 0.0])      # n→me 500 px → 0.216 vs 0.200 mm/px (8 % apart)
    bad = transfer_scale(inputs, pts, {}, max_disagreement_frac=0.05)
    assert bad.mm_per_px is None and bad.reason == "transfer_inconsistent"
    assert transfer_scale(None, pts, {}, max_disagreement_frac=0.05).reason == "no_frontal_scale"


def test_frontal_transfer_inputs():
    fr, _ = synthetic_result()
    inputs, reason = frontal_transfer_inputs(fr)
    assert reason is None
    assert inputs["frontal_sn_me_mm"] == pytest.approx(60.0) and inputs["frontal_n_me_mm"] == pytest.approx(108.0)
    assert inputs["frontal_sn_me_sd_mm"] >= 60.0 * 0.04  # includes the iris-scale uncertainty
    failed, _ = synthetic_result(status="quality_failed")
    assert frontal_transfer_inputs(failed) == (None, "frontal_not_usable")
    assert frontal_transfer_inputs(None) == (None, "no_frontal_scale")


# --------------------------------------------------------------- synthetic end to end


def _spline_truth(facing: str) -> dict[str, np.ndarray]:
    """Ground truth on the dense synthetic outline, from the textbook definitions (image frame)."""
    pts = np.array([p for _, p in FRONT] + BACK + [FRONT[0][1]], dtype=float)
    tck, _ = splprep([pts[:, 0], pts[:, 1]], s=0, per=True, k=3)
    x, y = splev(np.linspace(0, 1, 20000), tck)
    c = np.column_stack([x, y])
    front = c[(c[:, 0] > 540) & (c[:, 1] > 250) & (c[:, 1] < 830)]

    def argmax_x(y0, y1):
        seg = front[(front[:, 1] >= y0) & (front[:, 1] <= y1)]
        return seg[np.argmax(seg[:, 0])]

    t = {"pronasale": argmax_x(500, 600), "glabella": argmax_x(340, 440), "labrale_superius": argmax_x(600, 645),
         "labrale_inferius": argmax_x(650, 690), "soft_tissue_pogonion": argmax_x(715, 780),
         "subnasale": np.array(dict(FRONT)["subnasale"], float), "trichion": np.array(dict(FRONT)["trichion"], float)}
    seg = front[(front[:, 1] > t["glabella"][1]) & (front[:, 1] < t["pronasale"][1])]
    t["nasion"] = seg[np.argmin(seg[:, 0])]
    pog, cerv = t["soft_tissue_pogonion"], np.array(dict(FRONT)["cervical"], float)
    chin = front[(front[:, 1] > pog[1]) & (front[:, 1] < cerv[1]) & (front[:, 0] > cerv[0])]
    e = cerv - pog
    d = np.abs(e[0] * (chin - pog)[:, 1] - e[1] * (chin - pog)[:, 0]) / np.linalg.norm(e)
    t["menton"] = chin[np.argmax(d)]
    if facing == "left":
        t = {k: np.array([SIZE[0] - 1 - p[0], p[1]]) for k, p in t.items()}
    return t


@pytest.fixture(scope="module")
def synth_engine():
    if not models_available():
        pytest.skip("models missing")
    eng = FaceScanEngine(EngineConfig.from_models_dir(MODELS))
    real = eng._segmenter
    eng._segmenter = FakeSegmenter()
    yield eng
    real.close()
    eng._detector.close()


SUBJECT = SubjectInfo(sex="female", age=28)


@pytest.fixture(scope="module")
def synth_result(synth_engine):
    rgb, _, _ = make_profile("right")
    img = LoadedImage.from_array(rgb)
    return img, synth_engine.analyze_profile(img, subject=SUBJECT, facing="right")


@pytest.mark.parametrize("facing", ["right", "left"])
def test_synthetic_profile_landmarks_match_ground_truth(synth_engine, facing):
    rgb, _, _ = make_profile(facing)
    r = synth_engine.analyze_profile(LoadedImage.from_array(rgb), subject=SUBJECT, facing=facing)
    assert r.status in ("ok", "quality_failed") and r.facing == facing
    assert all(c.status == "pass" for c in r.quality.checks if c.id in CONTOUR_CHECKS)
    truth = _spline_truth(facing)
    extrema = {"pronasale", "glabella", "labrale_superius", "labrale_inferius", "soft_tissue_pogonion", "nasion"}
    for name, p in truth.items():
        lm = r.landmarks[name]
        assert lm.available, (name, lm.reason)
        if name in extrema:
            assert abs(lm.x - p[0]) < 1.5, (name, lm.x - p[0])   # anteriority itself is precise
        # Along a flat extremum (the forehead at the glabella) the position is poorly conditioned.
        tol = 10.0 if name == "glabella" else 6.0                # ≈ 1–2 % of the face height
        err = math.hypot(lm.x - p[0], lm.y - p[1])
        assert err < tol, (name, err)
    assert r.landmarks["alar_crease"].reason == "user_placed_point" and not r.landmarks["alar_crease"].available


def test_synthetic_profile_result_shape(synth_result):
    img, r = synth_result
    assert r.status == "ok"
    assert r.quality.warnings == ["distance_unverified", "no_frontal_scale"]
    assert not r.quality.considerations_eligible
    assert r.calibration.method == "none" and r.calibration.reason == "no_frontal_scale"
    assert 2 <= len(r.contour) <= 400
    contour = np.array([[p.x, p.y] for p in r.contour])
    for name in ("glabella", "nasion", "pronasale", "subnasale", "labrale_superius", "soft_tissue_pogonion"):
        on = project_onto_polyline(r.landmarks[name].xy(), contour)[0]
        assert np.hypot(*(on - r.landmarks[name].xy())) < 1e-6, name   # silhouette points lie on the contour
    assert r.landmarks["pronasale"].source == "contour" and r.landmarks["trichion"].source == "segmentation"
    assert r.metrics["P1_nasofrontal_angle"].uncertainty_method == "tta"
    assert r.metrics["P3a_tip_projection_goode"].status == "unavailable"
    assert ProfileResult.model_validate_json(r.model_dump_json()) == r


def test_profile_is_deterministic(synth_engine, synth_result):
    img, r = synth_result
    assert synth_engine.analyze_profile(img, subject=SUBJECT, facing="right").model_dump_json() == r.model_dump_json()


def test_user_adjustment_rules_on_profile(synth_engine, synth_result):
    img, r = synth_result
    prn = r.landmarks["pronasale"]
    out = synth_engine.apply_overrides(r, {
        "pronasale": Override(x=prn.x + 30, y=prn.y + 25, source="user_adjusted"),   # off the silhouette
        "alar_crease": Override(x=prn.x - 60, y=prn.y - 5, source="user_adjusted")})
    contour = np.array([[p.x, p.y] for p in r.contour])
    moved = out.landmarks["pronasale"]
    assert np.hypot(*(project_onto_polyline(moved.xy(), contour)[0] - moved.xy())) < 1e-6  # re-snapped
    assert (moved.auto.x, moved.auto.y) == (prn.x, prn.y)
    ac = out.landmarks["alar_crease"]
    assert (ac.x, ac.y) == (prn.x - 60, prn.y - 5)                      # placed freely, not snapped
    assert ac.confidence == "low" and "no_automatic_position" in ac.flags
    m = out.metrics["P3a_tip_projection_goode"]
    assert m.value is not None and m.confidence == "low" and m.uncertainty_method == "landmark_sampling"
    clin = synth_engine.apply_overrides(r, {"alar_crease": Override(x=prn.x - 60, y=prn.y - 5, source="clinician")})
    assert clin.metrics["P3a_tip_projection_goode"].confidence == "high"
    with pytest.raises(UnknownPointError):
        synth_engine.apply_overrides(r, {"medial_canthus_left": Override(x=1, y=1, source="clinician")})


def test_profile_allowlist_covers_silhouette_and_alar_crease(synth_engine):
    allowed = synth_engine.client_config()["user_adjustable_points"]["profile"]
    assert set(allowed) == {"trichion", "glabella", "nasion", "pronasale", "subnasale", "labrale_superius",
                            "labrale_inferius", "soft_tissue_pogonion", "menton", "alar_crease"}


@pytest.mark.parametrize("ovs", [
    {"alar_crease": Override(x=620, y=540, source="user_adjusted"), "pronasale": Override(x=700, y=600, source="user_adjusted")},
    {"subnasale": Override(x=630, y=590, source="clinician")},
    {"trichion": Override(x=580, y=250, source="user_adjusted")},
])
def test_profile_apply_overrides_equals_full_reanalysis(synth_engine, synth_result, ovs):
    img, r = synth_result
    assert synth_engine.apply_overrides(r, ovs) == \
        synth_engine.analyze_profile(img, subject=SUBJECT, facing="right", overrides=ovs)


def _matching_frontal(profile: ProfileResult) -> FrontalResult:
    """Synthetic frontal (0.2 mm/px) whose nasion→menton : subnasale→menton matches the profile."""
    fr, _ = synthetic_result()
    L = profile.landmarks
    ratio = (L["menton"].y - L["nasion"].y) / (L["menton"].y - L["subnasale"].y)
    lms = dict(fr.landmarks)
    me, sn = lms["menton"], lms["subnasale"]
    lms["nasion"] = Landmark(**{**dict(lms["nasion"]), "y": me.y - ratio * (me.y - sn.y)})
    return FrontalResult(**{**dict(fr), "landmarks": lms})


def test_scale_transfer_end_to_end(synth_engine, synth_result):
    rgb, _, _ = make_profile("right")
    img, r0 = synth_result
    frontal = _matching_frontal(r0)
    L = r0.landmarks
    expected = 60.0 / (L["menton"].y - L["subnasale"].y)
    focal = 1500.0 / expected                       # puts the camera at 1.5 m
    cam = LoadedImage.from_array(rgb, camera=CameraInfo(focal_px=focal, source="device"))
    r = synth_engine.analyze_profile(cam, subject=SUBJECT, facing="right", frontal=frontal)
    assert r.calibration.method == "transferred_from_frontal"
    assert r.calibration.mm_per_px == pytest.approx(expected)
    assert set(r.calibration.inputs) == {"frontal_sn_me_mm", "frontal_sn_me_sd_mm", "frontal_n_me_mm",
                                         "frontal_n_me_sd_mm"}
    assert r.metrics["P4_eline_upper_lip_mm"].value == pytest.approx(
        r.metrics["P4_eline_upper_lip_pct"].value / 100 * math.dist(
            (L["pronasale"].x, L["pronasale"].y), (L["soft_tissue_pogonion"].x, L["soft_tissue_pogonion"].y)) * expected)
    by = {c.id: c for c in r.quality.checks}
    assert by["camera_distance_m"].status == "pass" and by["camera_distance_m"].value == pytest.approx(1.5)
    assert r.status == "ok" and r.quality.considerations_eligible and "no_frontal_scale" not in r.quality.warnings
    # Moving the profile subnasale changes the transfer: calibration and every mm metric are recomputed.
    sn = r.landmarks["subnasale"]
    adj = synth_engine.apply_overrides(r, {"subnasale": Override(x=sn.x, y=sn.y + 6, source="clinician")})
    assert adj.calibration.mm_per_px != r.calibration.mm_per_px
    assert adj.metrics["P4_eline_lower_lip_mm"].uncertainty_method == "landmark_sampling"
    assert adj.metrics["P5_forehead_inclination"] == r.metrics["P5_forehead_inclination"]
    # A camera that is too close fails the gate.
    near = LoadedImage.from_array(rgb, camera=CameraInfo(focal_px=focal / 2, source="device"))
    rn = synth_engine.analyze_profile(near, subject=SUBJECT, facing="right", frontal=frontal)
    assert rn.status == "quality_failed" and "hint.move_back" in rn.quality.hint_keys


def test_profile_input_validation(synth_engine, synth_result):
    img, r = synth_result
    other = SubjectInfo(sex="male", age=40)
    fr, _ = synthetic_result()
    with pytest.raises(InvalidInputError, match="subject_mismatch"):
        synth_engine.analyze_profile(img, subject=other, facing="right", frontal=fr)
    with pytest.raises(InvalidInputError):
        synth_engine.analyze_profile(img, subject=SUBJECT, facing="up")


def test_profile_failure_statuses(synth_engine):
    blank = LoadedImage.from_array(np.full((800, 600, 3), (70, 110, 150), np.uint8))
    assert synth_engine.analyze_profile(blank, subject=SUBJECT, facing="right").status == "no_face"
    rgb, _, _ = make_profile("right")
    two = LoadedImage.from_array(np.ascontiguousarray(np.hstack([rgb, rgb])))
    assert synth_engine.analyze_profile(two, subject=SUBJECT, facing="right").status == "multiple_faces"
    wrong = synth_engine.analyze_profile(LoadedImage.from_array(rgb), subject=SUBJECT, facing="left")
    assert wrong.status == "contour_failed" and "hint.profile_facing" in wrong.quality.hint_keys


def test_profile_user_view_and_overlay(synth_engine, synth_result):
    img, r = synth_result
    v = user_view(r, locale="th")
    assert v["facing"] == "right" and len(v["contour"]) == len(r.contour)
    assert [p["id"] for p in v["adjustable_points"]][-1] == "alar_crease"
    assert v["metrics"]["P2_nasolabial_angle"]["name"] == "มุมจมูกกับริมฝีปากบน"
    assert {w["key"] for w in v["warnings"]} == {"distance_unverified", "no_frontal_scale"}
    json.dumps(v, ensure_ascii=False)
    for style in ("user", "clinical"):
        out = synth_engine.render_overlay(img, r, layers={"landmarks", "profile_lines", "labels"}, style=style)
        assert out.shape == img.pixels.shape and not np.array_equal(out, img.pixels)
    assert "profile" in synth_engine.client_config("en")


# ------------------------------------------------------------------ real images


@needs_models
def test_real_profile_with_collar_touching_the_chin(engine):
    img = load_image((DATA / "profile_lathe_operator_1942.jpg").read_bytes())
    r = engine.analyze_profile(img, subject=SUBJECT, facing="right")
    assert r.status == "contour_failed" and "hint.profile_pose" in r.quality.hint_keys
    for name in ("glabella", "nasion", "pronasale", "subnasale", "labrale_superius"):
        assert r.landmarks[name].available, name
    assert r.landmarks["soft_tissue_pogonion"].reason == "chin_underside_not_visible"
    assert ProfileResult.model_validate_json(r.model_dump_json()) == r


@needs_models
def test_real_painted_profile_without_a_nasion(engine):
    img = load_image((DATA / "profile_pollaiuolo_painting.jpg").read_bytes())
    r = engine.analyze_profile(img, subject=SUBJECT, facing="left")
    assert r.status == "contour_failed" and r.landmarks["nasion"].reason == "nasion_not_found"
    for name in ("pronasale", "subnasale", "soft_tissue_pogonion", "menton"):
        assert r.landmarks[name].available, name
    out = engine.render_overlay(img, r, layers={"landmarks", "profile_lines", "labels"}, style="clinical")
    assert out.shape == img.pixels.shape


def test_profile_apply_overrides_equals_full_reanalysis_with_scale_transfer(synth_engine, synth_result):
    img, r0 = synth_result
    frontal = _matching_frontal(r0)
    r = synth_engine.analyze_profile(img, subject=SUBJECT, facing="right", frontal=frontal)
    assert r.calibration.method == "transferred_from_frontal"
    sn, me = r.landmarks["subnasale"], r.landmarks["menton"]
    ovs = {"subnasale": Override(x=sn.x, y=sn.y + 4, source="user_adjusted"),
           "menton": Override(x=me.x, y=me.y - 3, source="clinician")}
    adjusted = synth_engine.apply_overrides(r, ovs)
    assert adjusted == synth_engine.analyze_profile(img, subject=SUBJECT, facing="right", frontal=frontal, overrides=ovs)
    assert adjusted.calibration.method == "transferred_from_frontal"
    assert adjusted.calibration.mm_per_px != r.calibration.mm_per_px


def test_affected_metric_without_point_sd_has_no_uncertainty(synth_engine, synth_result):
    """If augmentation gave no SD for an automatic point, sampling cannot bound the error → unknown."""
    img, r = synth_result
    lms = {k: (Landmark(**{**dict(v), "sd_px": None}) if v.available else v) for k, v in r.landmarks.items()}
    bare = ProfileResult(**{**dict(r), "landmarks": lms})
    prn = r.landmarks["pronasale"]
    out = synth_engine.apply_overrides(bare, {"pronasale": Override(x=prn.x, y=prn.y, source="clinician")})
    m = out.metrics["P1_nasofrontal_angle"]
    assert m.value is not None and m.uncertainty is None and "uncertainty_unavailable" in m.flags
