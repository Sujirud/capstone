"""Measurement uncertainty.

* ``burst_sd``: SD of each metric across burst frames.
* ``tta``: SD across test-time augmentations of a single image (random scale,
  shift and rotation, seeded from the image's SHA-256, landmarks mapped back).
* ``landmark_sampling``: SD across metrics recomputed from landmark positions
  drawn from N(position, sd_px²); used for metrics that depend on an adjusted
  point, whose position no longer comes from the detector. Fixed seed.

For mm metrics the iris-scale uncertainty is added in quadrature.
"""

from __future__ import annotations

import math
from typing import Callable, Iterable, Mapping, Sequence

import cv2
import numpy as np

from facescan.core.config import TTASettings


def rng_from_sha256(sha256: str) -> np.random.Generator:
    return np.random.default_rng(int(sha256[:16], 16))


def tta_transforms(sha256: str, face_box: tuple[float, float, float, float], cfg: TTASettings) -> list[np.ndarray]:
    """``cfg.runs`` random 2×3 affine maps about the face-box centre (deterministic per image)."""
    rng = rng_from_sha256(sha256)
    x0, y0, x1, y1 = face_box
    cx, cy, bw, bh = (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0
    out = []
    for _ in range(cfg.runs):
        s = 1.0 + rng.uniform(-cfg.scale_frac, cfg.scale_frac)
        theta = rng.uniform(-cfg.rotation_deg, cfg.rotation_deg)
        tx = rng.uniform(-cfg.shift_frac, cfg.shift_frac) * bw
        ty = rng.uniform(-cfg.shift_frac, cfg.shift_frac) * bh
        A = cv2.getRotationMatrix2D((float(cx), float(cy)), float(theta), float(s))
        A[:, 2] += (tx, ty)
        out.append(A)
    return out


def warp(rgb: np.ndarray, A: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    return cv2.warpAffine(rgb, A, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def sample_sd(values: Iterable[float | None], min_n: int) -> float | None:
    v = [x for x in values if x is not None and math.isfinite(x)]
    if len(v) < max(2, min_n):
        return None
    return float(np.std(v, ddof=1))


def landmark_sd(point_sets: Sequence[Mapping[str, np.ndarray]], min_n: int) -> dict[str, float]:
    """Isotropic SD per point: sqrt((var_x + var_y) / 2) across sets."""
    names = sorted({n for s in point_sets for n in s})
    out: dict[str, float] = {}
    for n in names:
        pts = np.array([s[n] for s in point_sets if n in s], dtype=float)
        if len(pts) >= max(2, min_n):
            var = pts.var(axis=0, ddof=1)
            out[n] = float(math.sqrt((var[0] + var[1]) / 2.0))
    return out


def metric_sd(value_sets: Sequence[Mapping[str, float | None]], ids: Iterable[str], min_n: int) -> dict[str, float | None]:
    return {mid: sample_sd((vs.get(mid) for vs in value_sets), min_n) for mid in ids}


def with_scale(u: float | None, value: float | None, rel: float | None) -> float | None:
    """Add a relative (scale) uncertainty in quadrature."""
    if u is None or value is None or rel is None:
        return u
    return float(math.hypot(u, abs(value) * rel))


def landmark_sampling(pts: Mapping[str, np.ndarray], sd_px: Mapping[str, float | None],
                      values_fn: Callable[[dict[str, np.ndarray]], Mapping[str, float | None]],
                      ids: Iterable[str], *, runs: int, seed: int, min_n: int) -> dict[str, float | None]:
    """SD of each metric over ``runs`` draws of the landmark positions (fixed seed).

    Random numbers are drawn only for points with a non-zero SD (in name order), so points
    that are not perturbed — e.g. an extra user-placed point — never change the draws.
    """
    ids = list(ids)
    names = sorted(pts)
    fixed = {n: np.asarray(pts[n], dtype=float) for n in names}
    active = [n for n in names if (sd_px.get(n) or 0.0) > 0]
    base = np.array([fixed[n] for n in active], dtype=float).reshape(-1, 2)
    sds = np.array([sd_px[n] for n in active], dtype=float)
    rng = np.random.default_rng(seed)
    draws: list[Mapping[str, float | None]] = []
    for _ in range(runs):
        noisy = base + rng.standard_normal(base.shape) * sds[:, None]
        sample = dict(fixed)
        sample.update({n: noisy[i] for i, n in enumerate(active)})
        draws.append(values_fn(sample))
    return metric_sd(draws, ids, min_n)
