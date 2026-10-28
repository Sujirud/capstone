"""Pure 2-D geometry on pixel coordinates (x right, y down).

No image processing, no state. Every function takes and returns NumPy arrays
or floats.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

EPS = 1e-9


def as_xy(p: Sequence[float] | np.ndarray) -> np.ndarray:
    return np.asarray(p, dtype=float)[:2]


def dist(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.hypot(*(as_xy(a) - as_xy(b))))


def midpoint(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (as_xy(a) + as_xy(b)) / 2.0


def unit(v: np.ndarray) -> np.ndarray:
    v = as_xy(v)
    n = float(np.hypot(*v))
    if n < EPS:
        raise ValueError("zero-length vector")
    return v / n


def cross2(a: np.ndarray, b: np.ndarray) -> float:
    return float(a[0] * b[1] - a[1] * b[0])


def angle_at(a: np.ndarray, vertex: np.ndarray, b: np.ndarray) -> float:
    """Unsigned angle a–vertex–b in degrees (0–180)."""
    u = as_xy(a) - as_xy(vertex)
    v = as_xy(b) - as_xy(vertex)
    return math.degrees(math.atan2(abs(cross2(u, v)), float(np.dot(u, v))))


def angle_between_lines(d1: np.ndarray, d2: np.ndarray) -> float:
    """Unsigned angle in degrees between two direction vectors (0–180)."""
    return math.degrees(math.atan2(abs(cross2(d1, d2)), float(np.dot(d1, d2))))


def signed_point_line_distance(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    """Signed distance from p to the infinite line a→b.

    Positive when p lies to the right of the direction a→b as seen on screen
    (image coordinates, y down), i.e. ``cross(b − a, p − a) > 0``.
    """
    d = unit(as_xy(b) - as_xy(a))
    return cross2(d, as_xy(p) - as_xy(a))


def project_onto_line(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = as_xy(a)
    d = unit(as_xy(b) - a)
    return a + d * float(np.dot(as_xy(p) - a, d))


def fit_line(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Total-least-squares line through points → (centroid, unit direction).

    Used for tangent fitting (e.g. the columella tangent in Phase 2). The direction
    is oriented from the first point toward the last one.
    """
    pts = np.asarray(points, dtype=float)[:, :2]
    if len(pts) < 2:
        raise ValueError("need at least two points")
    c = pts.mean(axis=0)
    _, _, vt = np.linalg.svd(pts - c)
    d = vt[0]
    if float(np.dot(pts[-1] - pts[0], d)) < 0:
        d = -d
    return c, d / np.linalg.norm(d)


@dataclass(frozen=True)
class FaceAxes:
    """Face-horizontal / face-vertical frame.

    ``ex`` points from the subject's right medial canthus toward the left one
    (image right in an unmirrored photo); ``ey`` is ``ex`` rotated +90° in image
    coordinates, pointing toward the chin. Projections onto these axes remove
    head roll.
    """

    origin: np.ndarray
    ex: np.ndarray
    ey: np.ndarray

    @classmethod
    def from_medial_canthi(cls, right: np.ndarray, left: np.ndarray) -> "FaceAxes":
        ex = unit(as_xy(left) - as_xy(right))
        ey = np.array([-ex[1], ex[0]])
        return cls(origin=midpoint(right, left), ex=ex, ey=ey)

    def h(self, p: np.ndarray) -> float:
        """Face-horizontal coordinate (grows toward the subject's left)."""
        return float(np.dot(as_xy(p) - self.origin, self.ex))

    def v(self, p: np.ndarray) -> float:
        """Face-vertical coordinate (grows toward the chin)."""
        return float(np.dot(as_xy(p) - self.origin, self.ey))

    def to_image(self, h: float, v: float) -> np.ndarray:
        return self.origin + h * self.ex + v * self.ey

    @staticmethod
    def lateral_sign(side: str) -> float:
        """+1 if face-horizontal grows laterally on this side, −1 otherwise."""
        return -1.0 if side == "right" else 1.0

    @property
    def roll_deg(self) -> float:
        """Angle of the face horizontal in the image (positive = clockwise on screen)."""
        return math.degrees(math.atan2(self.ex[1], self.ex[0]))


def intersect_polyline_with_line(poly: np.ndarray, p0: np.ndarray, direction: np.ndarray) -> list[np.ndarray]:
    """Intersections of a polyline with the infinite line p0 + t·direction."""
    poly = np.asarray(poly, dtype=float)[:, :2]
    p0 = as_xy(p0)
    n = np.array([-direction[1], direction[0]], dtype=float)  # line normal
    s = (poly - p0) @ n
    out: list[np.ndarray] = []
    for i in range(len(poly) - 1):
        s0, s1 = s[i], s[i + 1]
        if s0 == 0.0:
            out.append(poly[i].copy())
        elif s0 * s1 < 0.0:
            t = s0 / (s0 - s1)
            out.append(poly[i] + t * (poly[i + 1] - poly[i]))
    if len(poly) and s[-1] == 0.0:
        out.append(poly[-1].copy())
    return out


def refine_peak(xs: Sequence[float], ys: Sequence[float]) -> tuple[float, float, int]:
    """Peak of a sampled curve, refined by a parabola through its neighbours.

    Returns (x*, y*, index of the sampled maximum). At an end sample, or when
    the three points are not concave, the sample itself is returned.
    """
    xs = np.asarray(xs, dtype=float)
    ys = np.asarray(ys, dtype=float)
    j = int(np.argmax(ys))
    if j == 0 or j == len(ys) - 1:
        return float(xs[j]), float(ys[j]), j
    x3, y3 = xs[j - 1:j + 2], ys[j - 1:j + 2]
    try:
        a, b, c = np.polyfit(x3, y3, 2)
    except (np.linalg.LinAlgError, ValueError):
        return float(xs[j]), float(ys[j]), j
    if a >= -EPS:
        return float(xs[j]), float(ys[j]), j
    xv = float(np.clip(-b / (2 * a), min(x3[0], x3[2]), max(x3[0], x3[2])))
    return xv, float(a * xv * xv + b * xv + c), j


# ------------------------------------------------------------------- 2-D transforms


def apply_affine(A: np.ndarray, pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, dtype=float)
    single = pts.ndim == 1
    p = np.atleast_2d(pts)[:, :2]
    out = p @ A[:, :2].T + A[:, 2]
    return out[0] if single else out


def invert_affine(A: np.ndarray) -> np.ndarray:
    M = np.vstack([A, [0.0, 0.0, 1.0]])
    return np.linalg.inv(M)[:2]


def similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares similarity (rotation, uniform scale, translation) mapping src → dst.

    Umeyama (1991), without reflection. Returns a 2×3 matrix.
    """
    src = np.asarray(src, dtype=float)[:, :2]
    dst = np.asarray(dst, dtype=float)[:, :2]
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, S, Vt = np.linalg.svd(cov)
    D = np.eye(2)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[1, 1] = -1.0
    R = U @ D @ Vt
    var_s = float((xs ** 2).sum() / len(src))
    scale = float(np.trace(np.diag(S) @ D) / var_s) if var_s > EPS else 1.0
    t = mu_d - scale * R @ mu_s
    return np.hstack([scale * R, t[:, None]])


# ------------------------------------------------------------------------ polylines


def polyline_lengths(poly: np.ndarray) -> np.ndarray:
    """Cumulative arc length at each vertex (first = 0)."""
    poly = np.asarray(poly, dtype=float)[:, :2]
    seg = np.hypot(*np.diff(poly, axis=0).T)
    return np.concatenate([[0.0], np.cumsum(seg)])


def project_onto_polyline(p: np.ndarray, poly: np.ndarray) -> tuple[np.ndarray, float]:
    """Nearest point on a polyline and its arc-length parameter."""
    poly = np.asarray(poly, dtype=float)[:, :2]
    p = as_xy(p)
    a, b = poly[:-1], poly[1:]
    ab = b - a
    denom = np.maximum((ab ** 2).sum(axis=1), EPS)
    t = np.clip(((p - a) * ab).sum(axis=1) / denom, 0.0, 1.0)
    proj = a + t[:, None] * ab
    i = int(np.argmin(np.hypot(*(proj - p).T)))
    s = polyline_lengths(poly)
    return proj[i], float(s[i] + t[i] * np.hypot(*ab[i]))


def point_at_arclength(poly: np.ndarray, s: float | np.ndarray) -> np.ndarray:
    poly = np.asarray(poly, dtype=float)[:, :2]
    L = polyline_lengths(poly)
    s = np.clip(s, 0.0, L[-1])
    return np.column_stack([np.interp(s, L, poly[:, 0]), np.interp(s, L, poly[:, 1])]) if np.ndim(s) else \
        np.array([np.interp(s, L, poly[:, 0]), np.interp(s, L, poly[:, 1])])


def resample_polyline(poly: np.ndarray, n: int) -> np.ndarray:
    """``n`` points spaced uniformly by arc length (end points kept)."""
    L = polyline_lengths(poly)
    return point_at_arclength(poly, np.linspace(0.0, L[-1], n))
