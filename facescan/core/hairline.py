"""Frontal trichion from hair segmentation, plus hair checks around points.

The mesh does not provide the hairline (landmark 10 is only the top of the mesh),
so it is found from the selfie multiclass segmenter: scan upward from the
glabella along the face midline; trichion = the first face-skin → hair
transition. Anything ambiguous returns ``unavailable`` with a reason, and a
point supplied from outside (user / clinician override) can replace it.

The segmenter runs on a square head crop rather than the full frame, so a mask
cell covers fewer image pixels; the cell size still enters the uncertainty.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping

import cv2
import numpy as np

from facescan.core.config import HairlineSettings
from facescan.core.detector import SEG_FACE_SKIN, SEG_HAIR, HairSegmenter
from facescan.core.geometry import FaceAxes, dist

_SEG_INPUT_PX = 512  # crop is resized to this before segmentation (the model works at 256)


@dataclass(frozen=True)
class HeadSegmentation:
    """Category mask of a square head crop, addressable in image coordinates."""

    mask: np.ndarray        # (M, M) uint8 categories
    origin: np.ndarray      # image coordinates of the crop's top-left corner
    side_px: float          # crop side in image pixels
    image_size: tuple[int, int]  # (width, height) of the trusted image area
    model_resolution: int

    @property
    def cell_px(self) -> float:
        """Size of one model output cell in image pixels."""
        return self.side_px / self.model_resolution

    def category_at(self, pts: np.ndarray) -> np.ndarray:
        """Category at each image point; −1 outside the image (padding is never trusted)."""
        pts = np.atleast_2d(np.asarray(pts, dtype=float))
        w, h = self.image_size
        m = self.mask.shape[0]
        uv = np.floor((pts - self.origin) * (m / self.side_px)).astype(int)
        inside = ((pts[:, 0] >= 0) & (pts[:, 0] < w) & (pts[:, 1] >= 0) & (pts[:, 1] < h)
                  & (uv[:, 0] >= 0) & (uv[:, 0] < m) & (uv[:, 1] >= 0) & (uv[:, 1] < m))
        out = np.full(len(pts), -1, dtype=int)
        out[inside] = self.mask[uv[inside, 1], uv[inside, 0]]
        return out


def segment_head(segmenter: HairSegmenter, rgb: np.ndarray, mesh_top: np.ndarray, menton: np.ndarray,
                 cfg: HairlineSettings) -> HeadSegmentation | None:
    """Segment a square crop around the head (edge-padded where it leaves the image).

    Large crops are first block-averaged by an integer factor ``f`` (exact INTER_AREA), with
    the crop aligned to multiples of ``f``, so memory stays bounded (< 2048² px) and the
    mask → image mapping stays exact.
    """
    h, w = rgb.shape[:2]
    face_h = dist(mesh_top, menton)
    if face_h < 4:
        return None
    side = cfg.crop_scale * face_h
    f = max(1, int(side // (2 * _SEG_INPUT_PX)))
    c = mesh_top + cfg.crop_center_frac * (menton - mesh_top)
    x0, y0 = math.floor((c[0] - side / 2) / f), math.floor((c[1] - side / 2) / f)  # in the f-grid
    S = int(math.ceil(side / f))
    ws, hs = w // f, h // f  # whole blocks only
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x0 + S, ws), min(y0 + S, hs)
    if sx1 - sx0 < 4 or sy1 - sy0 < 4:
        return None
    sub = rgb[sy0 * f:sy1 * f, sx0 * f:sx1 * f]
    if f > 1:
        sub = cv2.resize(sub, (sx1 - sx0, sy1 - sy0), interpolation=cv2.INTER_AREA)
    crop = cv2.copyMakeBorder(sub, sy0 - y0, (y0 + S) - sy1, sx0 - x0, (x0 + S) - sx1, cv2.BORDER_REPLICATE)
    interp = cv2.INTER_AREA if S > _SEG_INPUT_PX else cv2.INTER_LINEAR
    small = cv2.resize(crop, (_SEG_INPUT_PX, _SEG_INPUT_PX), interpolation=interp)
    mask = segmenter.segment(np.ascontiguousarray(small))
    return HeadSegmentation(mask=mask, origin=np.array([x0 * f, y0 * f], dtype=float), side_px=float(S * f),
                            image_size=(ws * f, hs * f), model_resolution=segmenter.model_resolution)


@dataclass(frozen=True)
class HairlineResult:
    point: np.ndarray | None
    sd_px: float | None     # quantization SD from the mask cell size
    reason: str | None


def _scan_up(seg: HeadSegmentation, start: np.ndarray, up: np.ndarray, t_max: float,
             step: float, hair_run: float) -> tuple[float | None, str | None]:
    """Distance from ``start`` to the first face-skin → hair transition, or (None, reason)."""
    ts = np.arange(0.0, t_max, step)
    cats = seg.category_at(start + ts[:, None] * up)
    if cats[0] != SEG_FACE_SKIN:
        return None, "no_face_skin_at_start"
    non_skin = np.nonzero(cats != SEG_FACE_SKIN)[0]
    if len(non_skin) == 0:
        return None, "no_transition_found"
    i = int(non_skin[0])
    if cats[i] == -1:
        return None, "out_of_frame"
    if cats[i] != SEG_HAIR:
        return None, "no_hair_transition"
    n = int(math.ceil(hair_run / step))
    run = cats[i:i + n]
    if len(run) < n or np.any(run == -1):
        return None, "out_of_frame"
    if not np.all(run == SEG_HAIR):
        return None, "ambiguous_transition"
    return float((ts[i - 1] + ts[i]) / 2.0), None


def find_trichion(seg: HeadSegmentation | None, pts: Mapping[str, np.ndarray], axes: FaceAxes,
                  cfg: HairlineSettings) -> HairlineResult:
    """Trichion on the face midline above the glabella, or unavailable with a reason.

    Three scans (midline and ±``lateral_offset_frac_icd`` × ICD) must all find a
    clean skin → hair transition and agree within ``max_lateral_spread_frac`` of
    the glabella→subnasale distance; the transition must lie at least
    ``min_forehead_frac`` of that distance above the glabella (otherwise hair
    likely covers the forehead).
    """
    if seg is None:
        return HairlineResult(None, None, "segmentation_unavailable")
    gla, sn = pts["glabella"], pts["subnasale"]
    middle = axes.v(sn) - axes.v(gla)
    icd = dist(pts["medial_canthus_right"], pts["medial_canthus_left"])
    if middle <= 1 or icd <= 1:
        return HairlineResult(None, None, "degenerate_geometry")
    up = -axes.ey
    cell = seg.cell_px
    step = max(0.25, min(1.0, cell / 4.0))
    hair_run = cfg.hair_run_min_cells * cell
    t_max = cfg.max_scan_frac * middle

    t_mid, reason = _scan_up(seg, gla, up, t_max, step, hair_run)
    if t_mid is None:
        return HairlineResult(None, None, "no_face_skin_at_glabella" if reason == "no_face_skin_at_start" else reason)
    if t_mid < cfg.min_forehead_frac * middle:
        return HairlineResult(None, None, "hair_covers_forehead")
    # Lateral scans start halfway up the forehead so they begin on skin, not on the brows.
    t0 = t_mid / 2.0
    for sign in (-1.0, 1.0):
        start = gla + t0 * up + sign * cfg.lateral_offset_frac_icd * icd * axes.ex
        t_lat, _ = _scan_up(seg, start, up, t_max - t0, step, hair_run)
        if t_lat is None or abs(t0 + t_lat - t_mid) > cfg.max_lateral_spread_frac * middle:
            return HairlineResult(None, None, "ambiguous_hairline")
    return HairlineResult(gla + t_mid * up, cell / math.sqrt(12.0), None)


def hair_fraction(seg: HeadSegmentation | None, center: np.ndarray, half_size: float, n: int = 9) -> float | None:
    """Fraction of hair among in-image samples of a square window, or None."""
    if seg is None:
        return None
    g = np.linspace(-half_size, half_size, n)
    gx, gy = np.meshgrid(g, g)
    cats = seg.category_at(np.column_stack([gx.ravel(), gy.ravel()]) + center)
    valid = cats >= 0
    if not valid.any():
        return None
    return float((cats[valid] == SEG_HAIR).mean())
