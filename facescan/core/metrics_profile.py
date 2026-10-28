"""Phase 2: profile metrics P1–P5 as a pure function of named points and the stored contour.

Coordinates are image pixels. ``facing`` only mirrors the x axis so that "anterior"
(toward the face) is +x; angles and ratios do not depend on it. The columella tangent
is fitted on the *stored* contour between pronasale and subnasale, so a full analysis
and ``apply_overrides`` give the same values.

Signs: E-line distances are negative behind the line (toward the face), per Ricketts;
forehead inclination is positive when the forehead slopes back from the glabella.
"""

from __future__ import annotations

import math
from typing import Mapping

import numpy as np

from facescan.core.config import ProfileContourSettings
from facescan.core.geometry import (angle_between_lines, cross2, dist, fit_line, point_at_arclength,
                                    project_onto_polyline)
from facescan.core.metrics_frontal import MetricDef, MetricValue
from facescan.core.normalize import ScaleEstimate

PROFILE_METRICS: dict[str, MetricDef] = {m.id: m for m in [
    MetricDef("P1_nasofrontal_angle", "deg", "nose", "angle glabella–nasion–pronasale"),
    MetricDef("P2_nasolabial_angle", "deg", "nose",
              "angle at subnasale between the columella tangent (line fitted to the stored contour on the "
              "pronasale→subnasale arc) and subnasale→labrale superius"),
    MetricDef("P3a_tip_projection_goode", "ratio", "nose",
              "distance pronasale → line nasion–alar_crease ÷ |nasion − pronasale|"),
    MetricDef("P3b_tip_projection_simons", "ratio", "nose",
              "|subnasale − pronasale| ÷ |subnasale − labrale superius|", role="secondary"),
    MetricDef("P4_eline_upper_lip_mm", "mm", "lips",
              "signed distance labrale superius → line pronasale–soft-tissue pogonion (− = behind) × mm/px",
              signed=True, uses_scale=True),
    MetricDef("P4_eline_lower_lip_mm", "mm", "lips",
              "signed distance labrale inferius → line pronasale–soft-tissue pogonion (− = behind) × mm/px",
              signed=True, uses_scale=True),
    MetricDef("P4_eline_upper_lip_pct", "%E-line", "lips",
              "signed distance labrale superius → E-line ÷ E-line length × 100", signed=True),
    MetricDef("P4_eline_lower_lip_pct", "%E-line", "lips",
              "signed distance labrale inferius → E-line ÷ E-line length × 100", signed=True),
    MetricDef("P5_forehead_inclination", "deg", "forehead",
              "angle of glabella→trichion vs the image vertical (true vertical with a level camera); "
              "+ = forehead slopes back"),
]}
PROFILE_METRIC_IDS: tuple[str, ...] = tuple(PROFILE_METRICS)


def _oriented(p: np.ndarray, facing: str) -> np.ndarray:
    p = np.asarray(p, dtype=float)
    return np.array([-p[0], p[1]]) if facing == "left" else p


def columella_tangent(pts: Mapping[str, np.ndarray], contour: np.ndarray | None,
                      fit: tuple[float, float]) -> tuple[np.ndarray, np.ndarray] | None:
    """(point, unit direction toward the tip) of the line fitted to the columella, image px."""
    if contour is None or len(contour) < 2 or "pronasale" not in pts or "subnasale" not in pts:
        return None
    _, s_prn = project_onto_polyline(pts["pronasale"], contour)
    _, s_sn = project_onto_polyline(pts["subnasale"], contour)
    if s_sn - s_prn <= 1e-6:
        return None
    s = np.linspace(s_prn + fit[0] * (s_sn - s_prn), s_prn + fit[1] * (s_sn - s_prn), 24)
    c, d = fit_line(point_at_arclength(contour, s))
    if float(np.dot(d, np.asarray(pts["pronasale"]) - np.asarray(pts["subnasale"]))) < 0:
        d = -d
    return c, d


def compute_profile(pts: Mapping[str, np.ndarray], contour: np.ndarray | None, facing: str,
                    scale: ScaleEstimate | None, cfg: ProfileContourSettings) -> dict[str, MetricValue]:
    """All profile metric values from named points (image px), the stored contour and the scale."""
    P = pts
    out: dict[str, MetricValue] = {}

    def put(mid: str, value: float | None, used, reason: str | None = None) -> None:
        used = tuple(dict.fromkeys(used))
        if value is not None and not math.isfinite(value):
            value, reason = None, "degenerate_geometry"
        if value is None and reason is None:
            reason = "degenerate_geometry"
        out[mid] = MetricValue(None if value is None else float(value), used, None if value is not None else reason)

    def req(*names: str) -> str | None:
        for n in names:
            if n not in P:
                return f"{n}_unavailable"
        return None

    # P1 nasofrontal angle
    used = ("glabella", "nasion", "pronasale")
    r = req(*used)
    if r:
        put("P1_nasofrontal_angle", None, used, r)
    else:
        a, n, b = P["glabella"], P["nasion"], P["pronasale"]
        ok = dist(a, n) > 0 and dist(b, n) > 0
        put("P1_nasofrontal_angle", angle_between_lines(a - n, b - n) if ok else None, used)

    # P2 nasolabial angle (columella tangent from the stored contour)
    used = ("pronasale", "subnasale", "labrale_superius")
    r = req(*used)
    tan = None if r else columella_tangent(P, contour, cfg.columella_fit)
    if r:
        put("P2_nasolabial_angle", None, used, r)
    elif tan is None:
        put("P2_nasolabial_angle", None, used, "columella_unavailable")
    else:
        lip = P["labrale_superius"] - P["subnasale"]
        put("P2_nasolabial_angle", angle_between_lines(tan[1], lip) if np.hypot(*lip) > 0 else None, used)

    # P3a Goode (needs the user-placed alar crease)
    used = ("nasion", "alar_crease", "pronasale")
    r = req(*used)
    if r:
        put("P3a_tip_projection_goode", None, used, r)
    else:
        n, ac, prn = P["nasion"], P["alar_crease"], P["pronasale"]
        d_line = np.hypot(*(ac - n))
        length = dist(n, prn)
        if d_line <= 0 or length <= 0:
            put("P3a_tip_projection_goode", None, used)
        else:
            perp = abs(cross2(ac - n, prn - n)) / d_line
            put("P3a_tip_projection_goode", perp / length, used)

    # P3b Simons
    used = ("subnasale", "pronasale", "labrale_superius")
    r = req(*used)
    den = None if r else dist(P["subnasale"], P["labrale_superius"])
    put("P3b_tip_projection_simons", None if r or not den else dist(P["subnasale"], P["pronasale"]) / den, used, r)

    # P4 Ricketts' E-line
    for lip, key in (("labrale_superius", "upper"), ("labrale_inferius", "lower")):
        used = ("pronasale", "soft_tissue_pogonion", lip)
        r = req(*used)
        off = length = None
        if not r:
            a, b, p = (_oriented(P[k], facing) for k in ("pronasale", "soft_tissue_pogonion", lip))
            d = b - a
            length = float(np.hypot(*d))
            if length > 0:
                nrm = np.array([d[1], -d[0]]) / length
                if nrm[0] < 0:
                    nrm = -nrm                               # anterior (+x) side is positive
                off = float(np.dot(p - a, nrm))
        put(f"P4_eline_{key}_lip_pct", None if off is None else off / length * 100.0, used, r)
        mm_used = used + (tuple(scale.landmarks_used) if scale is not None else ())
        if off is None:
            put(f"P4_eline_{key}_lip_mm", None, mm_used, r)
        elif scale is None or not scale.available:
            put(f"P4_eline_{key}_lip_mm", None, mm_used, (scale.reason if scale else None) or "no_frontal_scale")
        else:
            put(f"P4_eline_{key}_lip_mm", off * scale.mm_per_px, mm_used)

    # P5 forehead inclination vs image vertical
    used = ("glabella", "trichion")
    r = req(*used)
    if r:
        put("P5_forehead_inclination", None, used, r)
    else:
        g, t = _oriented(P["glabella"], facing), _oriented(P["trichion"], facing)
        dy = g[1] - t[1]
        put("P5_forehead_inclination", math.degrees(math.atan2(g[0] - t[0], dy)) if dy > 0 else None, used)

    return {mid: out[mid] for mid in PROFILE_METRIC_IDS}
