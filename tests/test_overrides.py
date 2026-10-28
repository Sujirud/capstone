import pytest

from facescan import Override, PointNotAdjustableError, UnknownPointError
from facescan.core.errors import OverrideOutOfBoundsError
from facescan.core.schema import FrontalResult, Landmark
from helpers import synthetic_result


@pytest.fixture()
def base():
    return synthetic_result()


def test_users_may_adjust_only_allowlisted_points(base):
    result, asm = base
    with pytest.raises(PointNotAdjustableError):
        asm.apply_overrides(result, {"subnasale": Override(x=800, y=1150, source="user_adjusted")})
    out = asm.apply_overrides(result, {"subnasale": Override(x=800, y=1150, source="clinician")})
    assert out.landmarks["subnasale"].source == "clinician"
    with pytest.raises(UnknownPointError):
        asm.apply_overrides(result, {"not_a_point": Override(x=1, y=1, source="clinician")})
    with pytest.raises(OverrideOutOfBoundsError):
        asm.apply_overrides(result, {"trichion": Override(x=-5, y=10, source="user_adjusted")})


def test_source_is_recorded_and_auto_position_kept(base):
    result, asm = base
    tri = result.landmarks["trichion"]
    out = asm.apply_overrides(result, {"trichion": Override(x=tri.x, y=tri.y - 10, source="user_adjusted")})
    lm = out.landmarks["trichion"]
    assert lm.source == "user_adjusted" and lm.adjusted
    assert (lm.auto.x, lm.auto.y, lm.auto.source) == (tri.x, tri.y, "segmentation")
    assert lm.confidence == "high" and "large_user_adjustment" not in lm.flags
    # A second adjustment keeps the original automatic position, not the first adjustment.
    out2 = asm.apply_overrides(out, {"trichion": Override(x=tri.x, y=tri.y - 20, source="user_adjusted")})
    assert (out2.landmarks["trichion"].auto.x, out2.landmarks["trichion"].auto.y) == (tri.x, tri.y)


def test_large_user_adjustment_flag_propagates_to_metrics(base):
    result, asm = base
    tri = result.landmarks["trichion"]
    # nasion→menton = 108 mm × 5 px/mm = 540 px; tolerance 3 % = 16.2 px
    out = asm.apply_overrides(result, {"trichion": Override(x=tri.x, y=tri.y - 40, source="user_adjusted")})
    assert "large_user_adjustment" in out.landmarks["trichion"].flags
    for mid in ("F1_upper_third", "F1_lower_third", "F10_golden_ratio"):
        assert "large_user_adjustment" in out.metrics[mid].flags
    assert "large_user_adjustment" not in out.metrics["F5_canthal_tilt_right"].flags
    # Clinician adjustments are never "large user adjustments".
    out = asm.apply_overrides(result, {"trichion": Override(x=tri.x, y=tri.y - 40, source="clinician")})
    assert out.landmarks["trichion"].flags == [] and out.landmarks["trichion"].confidence == "high"


def test_point_placed_without_automatic_position_has_low_confidence(base):
    result, asm = base
    lms = dict(result.landmarks)
    lms["trichion"] = Landmark(source="segmentation", confidence="low", reason="hair_covers_forehead")
    no_tri = FrontalResult(**{**dict(result), "landmarks": lms})
    out = asm.apply_overrides(no_tri, {"trichion": Override(x=800, y=560, source="user_adjusted")})
    lm = out.landmarks["trichion"]
    assert lm.confidence == "low" and lm.auto.x is None and lm.auto.reason == "hair_covers_forehead"
    assert out.metrics["F1_upper_third"].confidence == "low"
    assert out.metrics["F1_upper_third"].value is not None


def test_clinician_confirms_brow_points(base):
    result, asm = base
    assert result.metrics["F9_brow_apex_ratio_right"].confidence == "low"
    ovs = {n: Override(x=result.landmarks[n].x, y=result.landmarks[n].y, source="clinician")
           for n in result.landmarks if n.startswith(("brow_", )) and n.endswith(("_right", "_1", "_2", "_3", "_4", "_5"))
           and "right" in n}
    out = asm.apply_overrides(result, ovs)
    assert out.metrics["F9_brow_apex_ratio_right"].confidence == "high"
    assert out.metrics["F9_brow_apex_ratio_right"].value == pytest.approx(result.metrics["F9_brow_apex_ratio_right"].value)


def test_only_affected_metrics_are_recomputed(base):
    result, asm = base
    tri = result.landmarks["trichion"]
    out = asm.apply_overrides(result, {"trichion": Override(x=tri.x + 3, y=tri.y - 8, source="user_adjusted")})
    for mid, m in out.metrics.items():
        if "trichion" in m.landmarks_used:
            assert m.uncertainty_method == "landmark_sampling", mid
        else:
            assert m == result.metrics[mid], mid
    assert out.metrics["F1_upper_third"].value != result.metrics["F1_upper_third"].value


def test_calibration_point_override_recomputes_mm_metrics(base):
    result, asm = base
    p = result.landmarks["iris_left_lateral"]
    out = asm.apply_overrides(result, {"iris_left_lateral": Override(x=p.x + 2, y=p.y, source="clinician")})
    assert out.calibration.mm_per_px != result.calibration.mm_per_px
    for mid, m in out.metrics.items():
        if mid.endswith("_mm"):
            assert m.uncertainty_method == "landmark_sampling", mid
            if abs(result.metrics[mid].value) > 1e-9:  # a value of exactly 0 mm stays 0 under any scale
                assert m.value != result.metrics[mid].value, mid
    assert out.metrics["F5_canthal_tilt_right"] == result.metrics["F5_canthal_tilt_right"]


def test_apply_overrides_is_deterministic_and_round_trips(base):
    result, asm = base
    ovs = {"trichion": Override(x=801, y=548, source="user_adjusted")}
    a, b = asm.apply_overrides(result, ovs), asm.apply_overrides(result, ovs)
    assert a == b
    assert FrontalResult.model_validate_json(a.model_dump_json()) == a
