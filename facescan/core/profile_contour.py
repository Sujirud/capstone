"""Phase 2: profile silhouette, contour landmarks and snap-to-contour.

MediaPipe's face mesh is not used on profile images. The pipeline:

1. **Head location** — the selfie segmenter on the whole (downscaled) photo finds the
   face-skin region; it also counts faces.
2. **Silhouette** — on a crop around the head (mirrored so the face points toward +x),
   a colour model of the plain background (Lab mean and covariance of pixels far from
   the segmenter's person mask) gives a per-pixel Mahalanobis distance. Pixels deep
   inside the person mask are foreground; within a band around its boundary a pixel is
   foreground when its distance exceeds max(threshold_min, Otsu). The component that
   holds the face skin gives the closed outer contour.
3. **Profile segment** — from the most anterior point in the nose rows, the contour is
   walked up to above the forehead and down to below the chin, then smoothed
   (Savitzky–Golay) and resampled at 1 px spacing.
4. **Landmarks** (top to bottom): trichion (skin → hair transition of the classes
   sampled just inside the silhouette), glabella (most anterior forehead point above the
   nasion, on face skin), nasion (deepest point between glabella and pronasale),
   pronasale (most anterior point), subnasale (maximum concave turning between
   pronasale and labrale superius), labrale superius / inferius and soft-tissue
   pogonion (anterior maxima below the nose), menton (point of the chin curve farthest
   from the chord pogonion → cervical point). The alar crease is not on the silhouette
   and is placed by the user.

All geometry in this module is in the *oriented work frame* (crop pixels, face toward
+x, y down) until ``CropFrame.to_image`` maps it back to image pixels.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import cv2
import numpy as np
from scipy.signal import find_peaks, savgol_filter

from facescan.core.config import CaptureSettings, ProfileContourSettings, ProfileSegmentationSettings
from facescan.core.detector import SEG_BACKGROUND, SEG_BODY_SKIN, SEG_FACE_SKIN, SEG_HAIR, HairSegmenter
from facescan.core.geometry import project_onto_polyline, resample_polyline, signed_point_line_distance
from facescan.core.quality import face_count_check
from facescan.core.schema import QualityCheck

MAX_STORED_CONTOUR_POINTS = 400
REQUIRED_POINTS = ("glabella", "nasion", "pronasale", "subnasale", "labrale_superius", "soft_tissue_pogonion")
CONTOUR_CHECKS = ("background_contrast", "facing", "contour_continuous", "profile_points",
                  "pronasale_most_anterior", "landmark_order")
_SEG_INPUT_PX = 512


# ------------------------------------------------------------------ frames and masks


@dataclass(frozen=True)
class CropFrame:
    """Oriented work-crop pixel ↔ image pixel mapping (pixel-centre convention)."""

    x0: int
    y0: int
    kx: float           # work px per image px
    ky: float
    work_w: int
    work_h: int
    mirror: bool        # True when facing="left" (crop flipped so the face points to +x)

    def to_image(self, pts: np.ndarray) -> np.ndarray:
        p = np.atleast_2d(np.asarray(pts, dtype=float))
        u = (self.work_w - 1) - p[:, 0] if self.mirror else p[:, 0]
        out = np.column_stack([self.x0 + (u + 0.5) / self.kx - 0.5, self.y0 + (p[:, 1] + 0.5) / self.ky - 0.5])
        return out[0] if np.ndim(pts) == 1 else out

    def to_work(self, pts: np.ndarray) -> np.ndarray:
        p = np.atleast_2d(np.asarray(pts, dtype=float))
        u = (p[:, 0] - self.x0 + 0.5) * self.kx - 0.5
        if self.mirror:
            u = (self.work_w - 1) - u
        out = np.column_stack([u, (p[:, 1] - self.y0 + 0.5) * self.ky - 0.5])
        return out[0] if np.ndim(pts) == 1 else out

    @property
    def scale(self) -> float:
        """Work px per image px (mean of both axes)."""
        return (self.kx + self.ky) / 2.0


def _segment_padded(segmenter: HairSegmenter, img: np.ndarray) -> tuple[np.ndarray, float]:
    """Category mask for ``img`` (padded to a square for the model) and the mask cell size in img px."""
    h, w = img.shape[:2]
    side = max(h, w)
    pad = cv2.copyMakeBorder(img, 0, side - h, 0, side - w, cv2.BORDER_REPLICATE)
    interp = cv2.INTER_AREA if side > _SEG_INPUT_PX else cv2.INTER_LINEAR
    small = cv2.resize(pad, (_SEG_INPUT_PX, _SEG_INPUT_PX), interpolation=interp)
    mask = segmenter.segment(np.ascontiguousarray(small))
    big = cv2.resize(mask, (side, side), interpolation=cv2.INTER_NEAREST)
    return big[:h, :w], side / segmenter.model_resolution


# ------------------------------------------------------------------ 1. head location


@dataclass(frozen=True)
class HeadLocation:
    n_faces: int
    box: tuple[float, float, float, float] | None  # face-skin box in image px (x0, y0, x1, y1)


def locate_head(rgb: np.ndarray, segmenter: HairSegmenter, cfg: ProfileSegmentationSettings) -> HeadLocation:
    """Face-skin components on a coarse pass; more than one large component → several faces."""
    h, w = rgb.shape[:2]
    s = min(1.0, cfg.coarse_input_px / max(h, w))
    small = rgb if s >= 1.0 else cv2.resize(rgb, (max(1, round(w * s)), max(1, round(h * s))),
                                            interpolation=cv2.INTER_AREA)
    sx, sy = small.shape[1] / w, small.shape[0] / h
    mask, _ = _segment_padded(segmenter, small)
    face = (mask == SEG_FACE_SKIN).astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(face, connectivity=8)
    areas = stats[1:, cv2.CC_STAT_AREA] if n > 1 else np.array([], dtype=int)
    if len(areas) == 0 or areas.max() < cfg.min_face_px:
        return HeadLocation(0, None)
    count = int((areas >= cfg.second_face_frac * areas.max()).sum())
    x, y, bw, bh = stats[1 + int(np.argmax(areas)), :4]
    return HeadLocation(count, (x / sx, y / sy, (x + bw) / sx, (y + bh) / sy))


# ------------------------------------------------------------------ 2. silhouette


@dataclass
class Silhouette:
    frame: CropFrame
    mask: np.ndarray                 # class mask, oriented work frame
    cell: float                      # mask cell size in work px
    contour: np.ndarray | None       # closed outer contour (K, 2), work px
    contrast: float | None
    face_rows: tuple[float, float] | None
    facing_ok: bool = True
    reason: str | None = None


def _otsu(values: np.ndarray) -> float:
    hi = float(np.percentile(values, 99.5)) if len(values) else 0.0
    if hi <= 0:
        return 0.0
    hist, edges = np.histogram(np.clip(values, 0, hi), bins=256, range=(0.0, hi))
    p = hist / max(hist.sum(), 1)
    centers = (edges[:-1] + edges[1:]) / 2
    omega = np.cumsum(p)
    mu = np.cumsum(p * centers)
    sigma_b = (mu[-1] * omega - mu) ** 2 / np.maximum(omega * (1 - omega), 1e-12)
    return float(centers[int(np.argmax(sigma_b))])


def _work_crop(rgb: np.ndarray, box: tuple[float, float, float, float], facing: str,
               cfg: ProfileSegmentationSettings) -> tuple[np.ndarray, CropFrame]:
    h, w = rgb.shape[:2]
    bx0, by0, bx1, by1 = box
    side = cfg.head_crop_scale * max(bx1 - bx0, by1 - by0)
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    x0, y0 = int(max(0, math.floor(cx - side / 2))), int(max(0, math.floor(cy - side / 2)))
    x1, y1 = int(min(w, math.ceil(cx + side / 2))), int(min(h, math.ceil(cy + side / 2)))
    crop = rgb[y0:y1, x0:x1]
    ch, cw = crop.shape[:2]
    k = min(1.0, cfg.work_max_px / max(ch, cw))
    if k < 1.0:
        crop = cv2.resize(crop, (max(1, round(cw * k)), max(1, round(ch * k))), interpolation=cv2.INTER_AREA)
    wh, ww = crop.shape[:2]
    mirror = facing == "left"
    if mirror:
        crop = crop[:, ::-1]
    return np.ascontiguousarray(crop), CropFrame(x0, y0, ww / cw, wh / ch, ww, wh, mirror)


def extract_silhouette(rgb: np.ndarray, box: tuple[float, float, float, float], facing: Literal["left", "right"],
                       segmenter: HairSegmenter, cfg: ProfileSegmentationSettings) -> Silhouette:
    """Subject / plain-background separation around the head → closed outer contour."""
    work, frame = _work_crop(rgb, box, facing, cfg)
    mask, cell = _segment_padded(segmenter, work)
    person = (mask != SEG_BACKGROUND).astype(np.uint8)
    face = mask == SEG_FACE_SKIN
    sil = Silhouette(frame=frame, mask=mask, cell=cell, contour=None, contrast=None, face_rows=None)
    if face.sum() < 16:
        sil.reason = "no_face_skin"
        return sil
    rows = np.nonzero(face.any(axis=1))[0]
    sil.face_rows = (float(rows.min()), float(rows.max()))

    # Facing: in the oriented frame the face skin lies in front of the hair.
    hair = mask == SEG_HAIR
    if hair.sum() > 16:
        sil.facing_ok = float(np.nonzero(face)[1].mean()) > float(np.nonzero(hair)[1].mean())

    # Background colour model from pixels well away from the person.
    d_bg = cv2.distanceTransform((1 - person).astype(np.uint8), cv2.DIST_L2, 5)
    bg = d_bg >= cfg.bg_margin_cells * cell
    lab = cv2.cvtColor(work, cv2.COLOR_RGB2Lab).astype(np.float32)
    samples = lab[bg]
    if len(samples) < cfg.min_bg_pixels:
        sil.reason = "no_background"
        return sil
    samples = samples[:: max(1, len(samples) // 20000)].astype(np.float64)
    mu = samples.mean(axis=0)
    cov = np.cov(samples.T) + cfg.cov_reg * np.eye(3)
    inv = np.linalg.inv(cov)
    diff = lab.astype(np.float64) - mu
    dist = np.sqrt(np.maximum(np.einsum("...i,ij,...j->...", diff, inv, diff), 0.0))
    k = max(1, int(round(cfg.band_cells * cell)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))
    inner = cv2.erode(person, kernel) > 0
    outer = cv2.dilate(person, kernel) > 0
    band = outer & ~inner
    ke = max(1, int(round(cell)))
    face_inner = cv2.erode(face.astype(np.uint8), np.ones((2 * ke + 1, 2 * ke + 1), np.uint8)) > 0
    sil.contrast = float(np.median(dist[face_inner if face_inner.any() else face]))
    thr = max(cfg.threshold_min, _otsu(dist[band]))
    fg = (inner | (band & (dist > thr))).astype(np.uint8)
    small = np.ones((3, 3), np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, small)
    # Close narrow notches (e.g. a dark nostril opening next to a dark background).
    rc = max(1, int(round(cfg.close_radius_frac * (sil.face_rows[1] - sil.face_rows[0]))))
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rc + 1, 2 * rc + 1)))
    n, labels = cv2.connectedComponents(fg, connectivity=8)
    counts = np.bincount(labels[face], minlength=n)
    counts[0] = 0
    if counts.max() == 0:
        sil.reason = "no_silhouette"
        return sil
    comp = (labels == int(np.argmax(counts))).astype(np.uint8)
    contours, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    sil.contour = max(contours, key=len).reshape(-1, 2).astype(float)
    return sil


# ------------------------------------------------------------------ 3. profile segment


def profile_segment(contour: np.ndarray, face_rows: tuple[float, float], work_shape: tuple[int, int],
                    cfg: ProfileContourSettings, mask: np.ndarray | None = None,
                    offset: float = 0.0) -> tuple[np.ndarray | None, bool]:
    """Front part of the closed contour, top → bottom, and whether it is complete.

    The walk starts at the most anterior contour point in the nose rows that lies on face
    skin (so an arm or object in front of the face is not taken for the nose). Complete =
    the segment reaches the face-skin top and extends below the chin without running into
    the crop / image border.
    """
    v_top, v_bot = face_rows
    fh = v_bot - v_top
    u, v = contour[:, 0], contour[:, 1]
    n = len(contour)
    lo, hi = v_top + cfg.pronasale_window[0] * fh, v_top + cfg.pronasale_window[1] * fh
    in_rows = (v >= lo) & (v <= hi)
    if mask is not None:
        iu = np.clip(np.round(u - offset).astype(int), 0, mask.shape[1] - 1)
        iv = np.clip(np.round(v).astype(int), 0, mask.shape[0] - 1)
        in_rows &= mask[iv, iu] == SEG_FACE_SKIN
    cand = np.nonzero(in_rows)[0]
    if len(cand) == 0 or fh <= 0:
        return None, False
    i0 = int(cand[np.argmax(u[cand])])
    k = max(3, int(0.02 * fh))
    up = 1 if v[(i0 + k) % n] < v[(i0 - k) % n] else -1
    H, W = work_shape
    tol = 0.05 * fh

    def border(i: int) -> bool:
        return u[i] <= 0 or u[i] >= W - 1 or v[i] <= 0 or v[i] >= H - 1

    def walk(step: int, going_up: bool) -> list[int]:
        out: list[int] = []
        i, extreme = i0, v[i0]
        limit = v_top - cfg.top_margin_frac * fh if going_up else v_bot + cfg.bottom_margin_frac * fh
        for _ in range(n // 2):
            i = (i + step) % n
            if border(i):
                break
            out.append(i)
            if going_up:
                extreme = min(extreme, v[i])
                if v[i] <= limit or v[i] > extreme + tol:   # reached the limit, or went over the head
                    break
            else:
                extreme = max(extreme, v[i])
                if v[i] >= limit or v[i] < extreme - tol:   # reached the limit, or turned back up
                    break
        return out

    up_idx, dn_idx = walk(up, True), walk(-up, False)
    seg = contour[up_idx[::-1] + [i0] + dn_idx]
    complete = bool(up_idx) and bool(dn_idx) and v[up_idx].min() <= v_top and v[dn_idx].max() >= v_bot + 0.1 * fh
    return seg, complete


def smooth_resample(seg: np.ndarray, window: int, polyorder: int, step: float = 1.0) -> np.ndarray:
    """Savitzky–Golay smoothing along the contour, then uniform arc-length resampling."""
    keep = np.concatenate([[True], np.hypot(*np.diff(seg, axis=0).T) > 0])
    seg = seg[keep]
    n = len(seg)
    window = min(window | 1, n if n % 2 else n - 1)
    if window > polyorder + 1:
        seg = np.column_stack([savgol_filter(seg[:, 0], window, polyorder, mode="interp"),
                               savgol_filter(seg[:, 1], window, polyorder, mode="interp")])
    L = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(seg, axis=0).T))])
    m = max(2, int(L[-1] / step) + 1)
    return resample_polyline(seg, m)


def turning(curve: np.ndarray, span: int) -> np.ndarray:
    """Signed turning angle (rad) over ± span samples; > 0 convex, < 0 concave (top → bottom, face to −x)."""
    n = len(curve)
    i = np.arange(n)
    a, b, c = curve[np.clip(i - span, 0, n - 1)], curve, curve[np.clip(i + span, 0, n - 1)]
    d1, d2 = b - a, c - b
    ang = np.arctan2(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0], (d1 * d2).sum(axis=1))
    ang[:span] = 0.0
    ang[-span:] = 0.0
    return ang


def inward_classes(curve: np.ndarray, mask: np.ndarray, offset: float) -> np.ndarray:
    """Segmentation class just inside the silhouette at each curve point (−1 outside the mask)."""
    t = np.gradient(curve, axis=0)
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    p = curve + offset * np.column_stack([-t[:, 1], t[:, 0]])  # face side for a top → bottom front profile
    ix, iy = np.round(p[:, 0]).astype(int), np.round(p[:, 1]).astype(int)
    h, w = mask.shape
    ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    out = np.full(len(curve), -1, dtype=int)
    out[ok] = mask[iy[ok], ix[ok]]
    return out


# ------------------------------------------------------------------ 4. landmarks


@dataclass
class ProfilePoints:
    """Landmarks found on the dense curve (oriented work frame)."""

    index: dict[str, int] = field(default_factory=dict)
    points: dict[str, np.ndarray] = field(default_factory=dict)
    reasons: dict[str, str] = field(default_factory=dict)
    anterior_margin: float | None = None      # (x_prn − max x of the face rows) / face height
    order_ok: bool = False
    tilt_deg: float | None = None             # forehead-to-chin line vs image vertical (+ = top leans back)
    trichion_fringe: float = 0.0              # length of the skin → hair fringe (samples ≈ work px)


def locate_profile_points(curve: np.ndarray, classes: np.ndarray, face_rows: tuple[float, float],
                          cell: float, cfg: ProfileContourSettings) -> ProfilePoints:
    N = len(curve)
    v_top, v_bot = face_rows
    fh = v_bot - v_top
    out = ProfilePoints()
    # Face-aligned frame: rotate so the forehead-to-chin line is vertical (bounded), then
    # "anterior" = +X. Only the choice of extrema uses this frame; points stay on the curve.
    rows = (curve[:, 1] >= v_top) & (curve[:, 1] <= v_bot)
    slope = np.polyfit(curve[rows, 1], curve[rows, 0], 1)[0] if rows.sum() > 10 else 0.0
    out.tilt_deg = math.degrees(math.atan(slope))
    th = math.radians(float(np.clip(out.tilt_deg, -cfg.max_rotation_deg, cfg.max_rotation_deg)))
    X = curve[:, 0] * math.cos(th) - curve[:, 1] * math.sin(th)
    Y = curve[:, 0] * math.sin(th) + curve[:, 1] * math.cos(th)
    v_top, v_bot = float(Y[rows].min()), float(Y[rows].max())
    fh = v_bot - v_top
    face = classes == SEG_FACE_SKIN
    turn = turning(curve, max(2, int(round(cfg.curvature_span_frac * fh))))

    def put(name: str, i: int | None, reason: str) -> int | None:
        if i is None:
            out.reasons[name] = reason
            return None
        out.index[name] = int(i)
        out.points[name] = curve[int(i)].copy()
        return int(i)

    # Pronasale: most anterior point in the nose rows.
    w0, w1 = cfg.pronasale_window
    cand = np.nonzero((Y >= v_top + w0 * fh) & (Y <= v_top + w1 * fh) & face)[0]
    if len(cand) == 0:
        for name in REQUIRED_POINTS:
            out.reasons[name] = "pronasale_not_found"
        return out
    i_prn = put("pronasale", int(cand[np.argmax(X[cand])]), "")
    rows_i = np.nonzero((Y >= v_top) & (Y <= v_bot) & face)[0]   # the face region = face-skin points
    out.anterior_margin = float((X[i_prn] - X[rows_i].max()) / fh)

    # The concavity between forehead and nose is located as the point farthest behind the
    # line from the forehead top to the tip; glabella = most anterior point of the face-skin
    # run above it; nasion = deepest (most posterior) point between glabella and pronasale,
    # which must lie ≥ nasion_min_depth behind both (a real concavity).
    def depth(idx: np.ndarray, a: int, b: int) -> np.ndarray:
        d = np.array([X[b] - X[a], Y[b] - Y[a]])
        n = np.array([d[1], -d[0]]) / max(float(np.hypot(*d)), 1e-9)
        if n[0] < 0:
            n = -n                                           # n points anterior (+X)
        return -((X[idx] - X[a]) * n[0] + (Y[idx] - Y[a]) * n[1])  # > 0 behind the line

    run, gap, j = [], 0, i_prn
    while j > 0 and Y[j - 1] >= Y[i_prn] - 0.8 * fh:
        j -= 1
        if face[j]:
            gap = 0
            run.append(j)
        else:
            gap += 1
            if gap > max(1, int(cell)):
                break
    i_n = i_g = None
    if len(run) > 3:
        run = np.array(run[::-1])                            # top → bottom
        above = run[run < i_prn]
        i_n0 = int(above[np.argmax(depth(above, int(run[0]), i_prn))])
        cands = run[(run < i_n0) & (Y[run] >= Y[i_n0] - cfg.glabella_window_frac * fh)]
        if len(cands):
            i_g = int(cands[np.argmax(X[cands])])
            mid = np.arange(i_g + 1, i_prn)
            if len(mid):
                k = int(mid[np.argmin(X[mid])])              # deepest = most posterior
                if min(X[i_g], X[i_prn]) - X[k] >= cfg.nasion_min_depth_frac * fh:
                    i_n = k
    put("glabella", i_g, "glabella_not_found")
    put("nasion", i_n, "nasion_not_found")

    # Lips and chin. The chin underside and neck must be visible: a cervical point is a
    # concave turn after which the contour stays on skin and does not come forward again.
    skin = np.isin(classes, (SEG_FACE_SKIN, SEG_BODY_SKIN))
    gap_max, i_end, gap, j = max(1, int(cell)), i_prn, 0, i_prn
    while j < N - 1:
        j += 1
        if skin[j]:
            gap, i_end = 0, j
        else:
            gap += 1
            if gap > gap_max:
                break
    i_ls = i_li = i_pog = i_sn = i_c = None
    why_pog = "chin_not_found"
    if i_end > i_prn + 2:
        maxs, _ = find_peaks(X[i_prn + 1:i_end + 1], prominence=cfg.lip_prominence_frac * fh)
        maxs = [int(m) + i_prn + 1 for m in maxs if Y[int(m) + i_prn + 1] <= v_bot + 0.05 * fh]
        neck_n = max(3, int(cfg.neck_len_frac * fh))
        if maxs:
            conc, _ = find_peaks(-turn[maxs[0]:i_end + 1], height=math.radians(cfg.cervical_min_turn_deg))
            for c in (int(k) + maxs[0] for k in conc):
                before = [m for m in maxs if m < c]
                if len(before) >= 2 and c + neck_n <= i_end and \
                        X[c + 1:c + neck_n + 1].max() <= X[c] + cfg.neck_rise_frac * fh:
                    i_c = c
                    break
            if i_c is None:
                why_pog = "chin_underside_not_visible"
            else:
                before = [m for m in maxs if m < i_c]
                i_ls, i_pog = before[0], before[-1]
                between = [m for m in before if i_ls < m < i_pog]
                if between:
                    i_li = between[int(np.argmax(X[between]))]
        if maxs:
            i_ls = maxs[0] if i_ls is None else i_ls
        if i_ls is not None and i_ls > i_prn + 2:
            seg = np.arange(i_prn + 1, i_ls)
            i_sn = int(seg[np.argmax(-turn[seg])])
    put("subnasale", i_sn, "subnasale_not_found")
    put("labrale_superius", i_ls, "lips_not_found")
    put("labrale_inferius", i_li, "lower_lip_not_separable" if i_pog is not None else why_pog)
    put("soft_tissue_pogonion", i_pog, why_pog)

    # Menton: chin curve between pogonion and the cervical point, farthest from their chord.
    i_me, why_me = None, why_pog
    if i_pog is not None and i_c is not None and i_c > i_pog + 2:
        chin = np.arange(i_pog + 1, i_c)
        d = np.abs([signed_point_line_distance(curve[i], curve[i_pog], curve[i_c]) for i in chin])
        i_me = int(chin[int(np.argmax(d))])
        if Y[i_me] - Y[i_pog] < cfg.min_chin_drop_frac * fh:
            i_me, why_me = None, "chin_underside_not_visible"
    put("menton", i_me, why_me)

    # Trichion: first face-skin → hair transition above the glabella.
    i_tri, why = None, "glabella_not_found"
    if i_g is not None:
        j = i_g
        while j > 0 and classes[j] == SEG_FACE_SKIN:
            j -= 1
        top_skin = j + 1
        # Allow a fringe of other classes between skin and hair: at the outline hair, skin and
        # background meet, and a 256-px mask blurs that junction over a few cells.
        k = j
        while k > 0 and top_skin - k <= max(1, int(cfg.trichion_fringe_cells * cell)) and \
                classes[k] not in (SEG_HAIR, -1):
            k -= 1
        if classes[k] == SEG_HAIR:
            j = k
        run_n = max(1, int(cfg.hair_run_cells * cell))
        if j == 0 or classes[j] == -1:
            why = "out_of_frame"
        elif classes[j] != SEG_HAIR:
            why = "no_hair_transition"
        elif j - run_n < 0 or not np.all(classes[j - run_n:j + 1] == SEG_HAIR):
            why = "ambiguous_transition"
        elif i_n is not None and i_sn is not None and \
                Y[i_g] - Y[j] < cfg.min_forehead_frac * (Y[i_sn] - Y[i_n]):
            why = "hair_covers_forehead"
        else:
            i_tri = (j + top_skin) // 2
            out.trichion_fringe = float(top_skin - j)
    put("trichion", i_tri, why)

    # Order: along the contour top → bottom, with the basic anterior relations.
    seq = [out.index.get(n) for n in ("trichion", "glabella", "nasion", "pronasale", "subnasale",
                                      "labrale_superius", "labrale_inferius", "soft_tissue_pogonion", "menton")]
    seq = [i for i in seq if i is not None]
    # (nasion lies behind the glabella–pronasale line by construction; min depth enforced above)
    rel = all(n in out.index for n in REQUIRED_POINTS) and (
        X[out.index["nasion"]] < X[i_prn] and X[out.index["subnasale"]] < X[i_prn]
        and X[out.index["subnasale"]] < X[out.index["labrale_superius"]])
    out.order_ok = bool(rel and all(a < b for a, b in zip(seq, seq[1:])))
    return out


# ------------------------------------------------------------------ public API


def simplify_contour(contour: np.ndarray, max_points: int = MAX_STORED_CONTOUR_POINTS) -> np.ndarray:
    """Contour resampled to at most ``max_points`` points, uniformly by arc length."""
    contour = np.asarray(contour, dtype=float)
    return contour.copy() if len(contour) <= max_points else resample_polyline(contour, max_points)


def snap_to_contour(point: np.ndarray, contour: np.ndarray) -> np.ndarray:
    """Nearest point on the stored contour polyline (silhouette points can only slide along it)."""
    return project_onto_polyline(point, contour)[0]


@dataclass
class ProfileExtraction:
    n_faces: int
    head_box: tuple[float, float, float, float] | None
    checks: list[QualityCheck]
    contour: np.ndarray | None = None               # stored contour, image px, top → bottom
    points: dict[str, np.ndarray] = field(default_factory=dict)   # image px, snapped to the contour
    reasons: dict[str, str] = field(default_factory=dict)
    extra_sd: dict[str, float] = field(default_factory=dict)
    face_height_px: float | None = None

    @property
    def contour_ok(self) -> bool:
        return all(c.passed for c in self.checks if c.id in CONTOUR_CHECKS)


def _check(id_: str, value: float | None, limit: float, ok: bool, hint: str) -> QualityCheck:
    return QualityCheck(id=id_, value=value, limit=limit, passed=ok, status="pass" if ok else "fail",
                        hint_key=None if ok else hint)


def extract_profile(rgb: np.ndarray, facing: Literal["left", "right"], segmenter: HairSegmenter,
                    settings: CaptureSettings, head_box: tuple[float, float, float, float] | None = None
                    ) -> ProfileExtraction:
    """Silhouette → stored contour and named profile points, with the profile quality checks.

    ``head_box`` skips the coarse head search (used for test-time augmentation runs).
    """
    p = settings.profile
    if head_box is None:
        loc = locate_head(rgb, segmenter, p.segmentation)
        n_faces, head_box = loc.n_faces, loc.box
    else:
        n_faces = 1
    ext = ProfileExtraction(n_faces=n_faces, head_box=head_box, checks=[face_count_check(n_faces)])
    if n_faces != 1:
        return ext

    sil = extract_silhouette(rgb, head_box, facing, segmenter, p.segmentation)
    contrast = sil.contrast
    ext.checks.append(_check("background_contrast", contrast, p.gates.contrast_min,
                             contrast is not None and contrast >= p.gates.contrast_min, "hint.profile_background"))
    ext.checks.append(_check("facing", 1.0 if sil.facing_ok else 0.0, 1.0, sil.facing_ok, "hint.profile_facing"))
    seg, complete = (None, False)
    if sil.contour is not None and sil.face_rows is not None:
        seg, complete = profile_segment(sil.contour, sil.face_rows, sil.mask.shape, p.contour,
                                        mask=sil.mask, offset=p.contour.inward_offset_cells * sil.cell)
    ext.checks.append(_check("contour_continuous", 1.0 if complete else 0.0, 1.0, complete, "hint.profile_in_frame"))
    if seg is None or len(seg) < 20:
        ext.checks += [_check("profile_points", 0.0, 1.0, False, "hint.profile_pose"),
                       _check("pronasale_most_anterior", None, -p.gates.anterior_tolerance_frac, False,
                              "hint.profile_pose"),
                       _check("landmark_order", 0.0, 1.0, False, "hint.profile_pose")]
        for name in REQUIRED_POINTS:
            ext.reasons[name] = sil.reason or "contour_not_found"
        return ext

    fh = sil.face_rows[1] - sil.face_rows[0]
    window = max(5, int(round(p.contour.smooth_window_frac * fh)))
    curve = smooth_resample(seg, window, p.contour.smooth_polyorder)
    classes = inward_classes(curve, sil.mask, p.contour.inward_offset_cells * sil.cell)
    found = locate_profile_points(curve, classes, sil.face_rows, sil.cell, p.contour)

    n_req = sum(n in found.points for n in REQUIRED_POINTS)
    ext.checks.append(_check("profile_points", n_req / len(REQUIRED_POINTS), 1.0, n_req == len(REQUIRED_POINTS),
                             "hint.profile_pose"))
    margin = found.anterior_margin
    ext.checks.append(_check("pronasale_most_anterior", margin, -p.gates.anterior_tolerance_frac,
                             margin is not None and margin >= -p.gates.anterior_tolerance_frac, "hint.profile_pose"))
    ext.checks.append(_check("landmark_order", 1.0 if found.order_ok else 0.0, 1.0, found.order_ok,
                             "hint.profile_pose"))
    tilt = found.tilt_deg
    ext.checks.append(_check("head_tilt_deg", tilt, p.gates.max_head_tilt_deg,
                             tilt is not None and abs(tilt) <= p.gates.max_head_tilt_deg, "hint.profile_level"))

    frame = sil.frame
    dense = frame.to_image(curve)
    ext.contour = simplify_contour(dense, p.contour.stored_points)
    for name, pt in found.points.items():
        ext.points[name] = snap_to_contour(frame.to_image(pt), ext.contour)
    ext.reasons = dict(found.reasons)
    ext.reasons.setdefault("alar_crease", "user_placed_point")
    if "trichion" in ext.points:
        # Mask-cell quantization and the fringe width, each as a uniform position error.
        ext.extra_sd["trichion"] = math.hypot(sil.cell, found.trichion_fringe) / frame.scale / math.sqrt(12.0)
    ext.face_height_px = fh / frame.scale
    return ext
