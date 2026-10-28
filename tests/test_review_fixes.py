"""Regression tests for issues found in the Phase 1 review."""

import os
import subprocess
import sys
import textwrap

import numpy as np
import pytest

from facescan.core.hairline import segment_head
from facescan.core.metrics_frontal import FRONTAL_METRIC_IDS
from facescan.core.quality import aggregate_burst, most_common
from facescan.core.schema import QualityCheck
from helpers import ROOT, capture_settings, face_mm, models_available, synthetic_settings, to_image


def test_most_common_breaks_ties_alphabetically():
    assert most_common(["b", "a", "b", "a"]) == "a"
    assert most_common(["z", "y", "z"]) == "z"


def test_burst_hint_tie_is_deterministic():
    def chk(hint):
        return QualityCheck(id="yaw_deg", value=9.0, limit=5.0, passed=False, status="fail", hint_key=hint)
    a = aggregate_burst([[chk("hint.turn_right")], [chk("hint.turn_left")]], n_good=0, min_frames=3)
    b = aggregate_burst([[chk("hint.turn_left")], [chk("hint.turn_right")]], n_good=0, min_frames=3)
    assert a == b and a[0].hint_key == "hint.turn_left"


class _FakeSegmenter:
    """Category 1 (hair) wherever the red channel is bright, else 3 (face skin)."""
    model_resolution = 256

    def segment(self, rgb):
        return np.where(rgb[:, :, 0] > 127, 1, 3).astype(np.uint8)


@pytest.mark.parametrize("scale", [1.0, 6.0])  # 6× → block-averaged path (f > 1)
def test_head_crop_mask_maps_exactly_back_to_the_image(scale):
    h, w = int(700 * scale), int(900 * scale)
    img = np.zeros((h, w, 3), np.uint8)
    img[: int(300 * scale), :, 0] = 255                   # "hair" above y = 300·scale
    top, chin = np.array([450.0, 320.0]) * scale, np.array([450.0, 600.0]) * scale
    seg = segment_head(_FakeSegmenter(), img, top, chin, capture_settings().hairline)
    assert seg is not None and seg.side_px < 2 * 2048 * max(1.0, scale)
    ys = np.array([150, 280, 320, 450]) * scale
    cats = seg.category_at(np.column_stack([np.full(len(ys), 450 * scale), ys]))
    assert list(cats) == [1, 1, 3, 3]
    assert seg.category_at(np.array([[-5.0, 10.0]]))[0] == -1  # outside the image is never trusted


def test_unavailable_metric_has_no_uncertainty_and_quantization_is_propagated():
    from facescan.core.assemble import FrontalAssembler
    from facescan.core.schema import SubjectInfo

    asm = FrontalAssembler(synthetic_settings())
    pts = to_image(face_mm())
    subject = SubjectInfo(sex="female", age=28)
    run = {m: (0.001, "tta") for m in FRONTAL_METRIC_IDS}
    lms = asm.landmarks(pts, {}, {n: 0.5 for n in pts}, {"trichion": 3.0})
    plain, _ = asm.metrics(lms, subject, run_u=run, previous=None)
    quant, _ = asm.metrics(lms, subject, run_u=run, previous=None, quant_sd={"trichion": 3.0})
    # d(upper/total)/d(trichion_y) = (middle + lower) / total² = 600 / 900² per px (synthetic face, 5 px/mm)
    import math
    expected = math.hypot(0.001, 3.0 * 600 / 900 ** 2)
    assert plain["F1_upper_third"].uncertainty == pytest.approx(0.001)
    assert quant["F1_upper_third"].uncertainty == pytest.approx(expected, rel=0.1)
    assert quant["F5_canthal_tilt_right"] == plain["F5_canthal_tilt_right"]
    del pts["trichion"]
    lms = asm.landmarks(pts, {"trichion": "hair_covers_forehead"}, {n: 0.5 for n in pts}, {})
    m, _ = asm.metrics(lms, subject, run_u=run, previous=None)
    assert m["F1_upper_third"].value is None and m["F1_upper_third"].uncertainty is None
    assert m["F1_upper_third"].uncertainty_method is None


@pytest.mark.skipif(not models_available(), reason="models missing")
def test_face_cut_by_the_frame_fails_quality_and_drops_extrapolated_points(engine, subject, astronaut,
                                                                           astronaut_result):
    from facescan import LoadedImage

    menton_y = int(astronaut_result.landmarks["menton"].y)
    cut = LoadedImage.from_array(np.ascontiguousarray(astronaut.pixels[: menton_y - 15]))
    r = engine.analyze_frontal(cut, subject=subject)
    by = {c.id: c for c in r.quality.checks}
    assert by["face_in_frame"].status == "fail" and "hint.face_in_frame" in r.quality.hint_keys
    assert not r.landmarks["menton"].available and r.landmarks["menton"].reason == "out_of_frame"
    for mid in ("F1_middle_lower_ratio", "F2_lower_face_ratio"):
        assert r.metrics[mid].status == "unavailable", mid
    for lm in r.landmarks.values():
        if lm.available:
            assert 0 <= lm.x < cut.width and 0 <= lm.y < cut.height


@pytest.mark.skipif(not models_available(), reason="models missing")
def test_results_are_identical_across_processes():
    """Determinism must not depend on per-process string hashing (PYTHONHASHSEED)."""
    code = textwrap.dedent(f"""
        import hashlib, sys
        from facescan import EngineConfig, FaceScanEngine, LoadedImage, SubjectInfo, load_image
        img = load_image(open(r"{ROOT / 'tests/data/astronaut.png'}", "rb").read())
        with FaceScanEngine(EngineConfig.from_models_dir(r"{ROOT / 'models'}")) as e:
            s = SubjectInfo(sex="female", age=30)
            out = e.analyze_frontal(img, subject=s).model_dump_json() + e.analyze_frontal([img] * 3, subject=s).model_dump_json()
            prof = load_image(open(r"{ROOT / 'tests/data/profile_lathe_operator_1942.jpg'}", "rb").read())
            pr = e.analyze_profile(prof, subject=s, facing="right")
            out += pr.model_dump_json()
            out += e.build_report(e.analyze_frontal(img, subject=s), pr).model_dump_json()
        print(hashlib.sha256(out.encode()).hexdigest())
    """)
    digests = []
    for seed in ("1", "2"):
        env = dict(os.environ, PYTHONHASHSEED=seed, GLOG_minloglevel="2")
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=300)
        assert out.returncode == 0, out.stderr[-2000:]
        digests.append(out.stdout.strip().splitlines()[-1])
    assert digests[0] == digests[1]
