import pytest

from facescan.core.metrics_frontal import FRONTAL_METRIC_IDS, FRONTAL_METRICS, compute_frontal
from helpers import expected, face_mm, params, to_image


def _values(pts):
    vals, scale = compute_frontal(pts, params())
    return {k: v.value for k, v in vals.items()}, vals, scale


def test_known_answers_on_synthetic_face():
    vals, full, scale = _values(to_image(face_mm()))
    assert scale.mm_per_px == pytest.approx(0.2)
    for mid, exp in expected().items():
        assert vals[mid] == pytest.approx(exp, abs=1e-9), mid
    assert set(vals) == set(FRONTAL_METRIC_IDS)


@pytest.mark.parametrize("roll", [10.0, -10.0, 3.0])
def test_roll_invariance(roll):
    base, _, _ = _values(to_image(face_mm()))
    rolled, _, _ = _values(to_image(face_mm(), roll_deg=roll, origin=(1234.5, 876.0)))
    for mid in FRONTAL_METRIC_IDS:
        if base[mid] is None:
            assert rolled[mid] is None
        else:
            assert rolled[mid] == pytest.approx(base[mid], abs=1e-9), mid


def test_scale_invariance_of_ratios_and_mm():
    a, _, _ = _values(to_image(face_mm()))
    b, _, _ = _values(to_image(face_mm(), mm_per_px=0.07))
    for mid in FRONTAL_METRIC_IDS:
        assert b[mid] == pytest.approx(a[mid], abs=1e-9), mid


def test_without_trichion_only_middle_lower_ratio_remains():
    pts = to_image(face_mm())
    del pts["trichion"]
    vals, full, _ = _values(pts)
    for mid in ("F1_upper_third", "F1_middle_third", "F1_lower_third", "F10_golden_ratio"):
        assert vals[mid] is None and full[mid].reason == "trichion_unavailable"
    assert vals["F1_middle_lower_ratio"] == pytest.approx(1.0)


def test_hidden_temporal_boundary_makes_fifths_unavailable():
    pts = to_image(face_mm())
    del pts["temporal_boundary_left"]
    vals, full, _ = _values(pts)
    for mid in FRONTAL_METRIC_IDS:
        if mid.startswith("F3_"):
            assert vals[mid] is None and full[mid].reason == "temporal_boundary_left_unavailable"
    assert vals["F11_asym_outer_fifth"] is None
    assert vals["F4_eye_icd_ratio_right"] is not None


def test_iris_mismatch_rejects_scale_but_keeps_ratio_forms():
    mm = face_mm()
    h, v = mm["iris_left_lateral"]
    mm["iris_left_lateral"] = (h + 2.0, v)  # left iris 17 % larger
    vals, full, scale = _values(to_image(mm))
    assert scale.mm_per_px is None and scale.reason == "iris_size_mismatch"
    assert vals["F4_icd_mm"] is None and full["F4_icd_mm"].reason == "iris_size_mismatch"
    assert vals["F7_commissure_offset_right_mm"] is None
    assert vals["F7_commissure_offset_right_pct_icd"] == pytest.approx(6.25)


def test_landmarks_used_are_traceable():
    _, full, _ = _values(to_image(face_mm()))
    assert "trichion" in full["F1_upper_third"].landmarks
    assert {"iris_right_lateral", "iris_right_medial"} <= set(full["F4_icd_mm"].landmarks)
    assert "medial_canthus_right" in full["F5_canthal_tilt_right"].landmarks
    for mid, d in FRONTAL_METRICS.items():
        if d.uses_scale:
            assert {"iris_left_lateral", "iris_left_medial"} <= set(full[mid].landmarks), mid


def test_golden_ratio_is_clinic_only_and_registry_is_consistent():
    assert FRONTAL_METRICS["F10_golden_ratio"].display == "clinic_only"
    assert all(d.display == "user" for mid, d in FRONTAL_METRICS.items() if mid != "F10_golden_ratio")
    assert FRONTAL_METRICS["F7_mouth_alar_ratio"].role == "secondary"
    for mid, d in FRONTAL_METRICS.items():
        assert d.uses_scale == mid.endswith("_mm"), mid
