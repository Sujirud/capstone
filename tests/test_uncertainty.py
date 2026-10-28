import numpy as np
import pytest

from facescan.core.uncertainty import (landmark_sampling, landmark_sd, metric_sd, rng_from_sha256, tta_transforms,
                                       with_scale)
from helpers import capture_settings, face_mm, params, to_image
from facescan.core.assemble import metric_values
from facescan.core.metrics_frontal import compute_frontal

TTA = capture_settings().frontal.tta


def test_tta_is_seeded_from_the_image_hash_and_bounded():
    box = (100.0, 100.0, 300.0, 400.0)
    a = tta_transforms("ab" * 32, box, TTA)
    b = tta_transforms("ab" * 32, box, TTA)
    c = tta_transforms("cd" * 32, box, TTA)
    assert len(a) == TTA.runs
    assert all(np.array_equal(x, y) for x, y in zip(a, b))
    assert not all(np.array_equal(x, y) for x, y in zip(a, c))
    for A in a:
        scale = np.sqrt(abs(np.linalg.det(A[:, :2])))
        angle = np.degrees(np.arctan2(A[1, 0], A[0, 0]))
        assert 1 - TTA.scale_frac - 1e-9 <= scale <= 1 + TTA.scale_frac + 1e-9
        assert abs(angle) <= TTA.rotation_deg + 1e-9


def test_rng_from_sha256_is_stable():
    assert rng_from_sha256("0f" * 32).integers(1 << 30) == rng_from_sha256("0f" * 32).integers(1 << 30)


def test_landmark_and_metric_sd():
    sets = [{"a": np.array([0.0, 0.0])}, {"a": np.array([2.0, 0.0])}, {"a": np.array([4.0, 0.0])}]
    assert landmark_sd(sets, 3)["a"] == pytest.approx(np.sqrt(4.0 / 2))
    assert landmark_sd(sets[:2], 3) == {}
    assert metric_sd([{"m": 1.0}, {"m": 3.0}, {"m": None}, {"m": 2.0}], ["m"], 3)["m"] == pytest.approx(1.0)
    assert metric_sd([{"m": 1.0}, {"m": None}], ["m"], 3)["m"] is None


def test_with_scale_adds_relative_uncertainty_in_quadrature():
    assert with_scale(0.3, 10.0, 0.04) == pytest.approx(0.5)
    assert with_scale(None, 10.0, 0.04) is None
    assert with_scale(0.3, 10.0, None) == 0.3


def test_landmark_sampling_fixed_seed_and_zero_sd():
    pts = to_image(face_mm())
    fn = lambda p: metric_values(compute_frontal(p, params())[0])  # noqa: E731
    ids = ["F5_canthal_tilt_right", "F4_eye_icd_ratio_right"]
    sd = {n: 1.0 for n in pts}
    a = landmark_sampling(pts, sd, fn, ids, runs=50, seed=7, min_n=3)
    b = landmark_sampling(pts, sd, fn, ids, runs=50, seed=7, min_n=3)
    assert a == b and all(v > 0 for v in a.values())
    z = landmark_sampling(pts, {n: 0.0 for n in pts}, fn, ids, runs=10, seed=7, min_n=3)
    assert all(v == pytest.approx(0.0, abs=1e-12) for v in z.values())
