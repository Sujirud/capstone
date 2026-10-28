"""Frontal metrics F1–F11 as a pure function of named points.

Conventions
-----------
* ``h(p)`` / ``v(p)``: projections onto the face axes; ``h`` grows toward the
  subject's left, ``v`` toward the chin. "Vertical" and "horizontal" distances are
  differences of these projections, which removes head roll.
* Widths of bilateral structures (eye fissure, ICD, alar width, mouth width,
  bizygomatic width) are Euclidean distances between the two points.
* Signed offsets are positive **lateral** (away from the midline) unless stated.
* ``_pct_icd`` metrics are percent of the intercanthal distance; ``_mm`` metrics
  need the iris scale and are ``unavailable`` without it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping

import numpy as np

from facescan.core.geometry import FaceAxes, dist, midpoint, refine_peak, unit
from facescan.core.landmark_map import AXIS_POINTS, SCALE_POINTS
from facescan.core.normalize import ScaleEstimate, face_axes, iris_scale
from facescan.core.schema import Display, MetricRole

AX = AXIS_POINTS
SC = SCALE_POINTS
SIDES = ("right", "left")


@dataclass(frozen=True)
class MetricDef:
    id: str
    unit: str
    area: str
    formula: str
    display: Display = "user"
    role: MetricRole = "primary"
    signed: bool = False      # signed-distance metric → deviation_pct is null
    uses_scale: bool = False


@dataclass(frozen=True)
class MetricValue:
    value: float | None
    landmarks: tuple[str, ...]
    reason: str | None = None


@dataclass(frozen=True)
class FrontalParams:
    iris_diameter_mm: float
    iris_rel_uncertainty: float
    max_iris_diff_frac: float


def _defs() -> list[MetricDef]:
    d: list[MetricDef] = []
    A = d.append
    third = "fraction of v(menton) − v(trichion)"
    A(MetricDef("F1_upper_third", "fraction", "thirds", f"(v(glabella) − v(trichion)) ÷ {third}"))
    A(MetricDef("F1_middle_third", "fraction", "thirds", f"(v(subnasale) − v(glabella)) ÷ {third}"))
    A(MetricDef("F1_lower_third", "fraction", "thirds", f"(v(menton) − v(subnasale)) ÷ {third}"))
    A(MetricDef("F1_middle_lower_ratio", "ratio", "thirds",
                "(v(subnasale) − v(glabella)) ÷ (v(menton) − v(subnasale))"))
    A(MetricDef("F2_lower_face_ratio", "ratio", "lower_face",
                "(v(stomion) − v(subnasale)) ÷ (v(menton) − v(stomion)); stomion = midpoint(13, 14)"))
    fifth = "÷ (h(temporal_boundary_left) − h(temporal_boundary_right))"
    A(MetricDef("F3_fifth_outer_right", "fraction", "fifths", f"(h(lateral_canthus_right) − h(temporal_boundary_right)) {fifth}"))
    A(MetricDef("F3_fifth_eye_right", "fraction", "fifths", f"(h(medial_canthus_right) − h(lateral_canthus_right)) {fifth}"))
    A(MetricDef("F3_fifth_intercanthal", "fraction", "fifths", f"(h(medial_canthus_left) − h(medial_canthus_right)) {fifth}"))
    A(MetricDef("F3_fifth_eye_left", "fraction", "fifths", f"(h(lateral_canthus_left) − h(medial_canthus_left)) {fifth}"))
    A(MetricDef("F3_fifth_outer_left", "fraction", "fifths", f"(h(temporal_boundary_left) − h(lateral_canthus_left)) {fifth}"))
    for s in SIDES:
        A(MetricDef(f"F4_eye_icd_ratio_{s}", "ratio", "eyes",
                    f"|lateral_canthus_{s} − medial_canthus_{s}| ÷ ICD"))
    A(MetricDef("F4_icd_mm", "mm", "eyes", "|medial_canthus_left − medial_canthus_right| × mm/px", uses_scale=True))
    for s in SIDES:
        A(MetricDef(f"F5_canthal_tilt_{s}", "deg", "eyes",
                    f"atan2(v(medial_canthus_{s}) − v(lateral_canthus_{s}), |h(lateral) − h(medial)|); + = lateral higher"))
    A(MetricDef("F6_alar_icd_ratio", "ratio", "nose", "|alare_left − alare_right| ÷ ICD"))
    for s in SIDES:
        f = (f"lateral-positive h-offset of commissure_{s} from the vertical through the medial limbus "
             f"(h(iris_center_{s}) ∓ iris radius toward the midline)")
        A(MetricDef(f"F7_commissure_offset_{s}_pct_icd", "%ICD", "mouth", f + " ÷ ICD × 100", signed=True))
        A(MetricDef(f"F7_commissure_offset_{s}_mm", "mm", "mouth", f + " × mm/px", signed=True, uses_scale=True))
    A(MetricDef("F7_mouth_alar_ratio", "ratio", "mouth", "|commissure_left − commissure_right| ÷ alar width",
                role="secondary"))
    A(MetricDef("F7_mouth_ipd_ratio", "ratio", "mouth",
                "|commissure_left − commissure_right| ÷ |iris_center_left − iris_center_right|", role="secondary"))
    A(MetricDef("F8_lip_ratio", "ratio", "lips",
                "(v(labrale_inferius) − v(lower_lip_inner)) ÷ (v(upper_lip_inner) − v(labrale_superius))"))
    for s in SIDES:
        A(MetricDef(f"F9_brow_head_offset_{s}_pct_icd", "%ICD", "brows",
                    f"lateral h-offset of brow_head_{s} from the vertical through alar_base_{s} ÷ ICD × 100", signed=True))
        A(MetricDef(f"F9_brow_head_offset_{s}_mm", "mm", "brows",
                    f"lateral h-offset of brow_head_{s} from the vertical through alar_base_{s} × mm/px",
                    signed=True, uses_scale=True))
        A(MetricDef(f"F9_brow_apex_offset_{s}_pct_icd", "%ICD", "brows",
                    "lateral h-offset of the brow apex (highest point of the upper brow contour, parabolic "
                    "refinement) from the vertical through the lateral limbus ÷ ICD × 100", signed=True))
        A(MetricDef(f"F9_brow_apex_offset_{s}_mm", "mm", "brows",
                    "lateral h-offset of the brow apex from the vertical through the lateral limbus × mm/px",
                    signed=True, uses_scale=True))
        A(MetricDef(f"F9_brow_apex_ratio_{s}", "ratio", "brows",
                    "|h(apex) − h(brow_head)| ÷ |h(brow_tail) − h(apex)|"))
        A(MetricDef(f"F9_brow_tail_offset_{s}_pct_icd", "%ICD", "brows",
                    f"signed distance of brow_tail_{s} from the line alar_base_{s} → lateral_canthus_{s} "
                    "(+ = lateral side) ÷ ICD × 100", signed=True))
        A(MetricDef(f"F9_brow_tail_offset_{s}_mm", "mm", "brows",
                    f"signed distance of brow_tail_{s} from the line alar_base_{s} → lateral_canthus_{s} × mm/px",
                    signed=True, uses_scale=True))
    A(MetricDef("F10_golden_ratio", "ratio", "proportions",
                "(v(menton) − v(trichion)) ÷ |bizygomatic_left − bizygomatic_right|", display="clinic_only"))
    A(MetricDef("F11_asym_eye_width", "ratio", "symmetry", "|R − L| ÷ mean(R, L) of palpebral fissure widths"))
    A(MetricDef("F11_asym_outer_fifth", "ratio", "symmetry", "|R − L| ÷ mean(R, L) of the outer fifths"))
    A(MetricDef("F11_asym_brow_apex_ratio", "ratio", "symmetry", "|R − L| ÷ mean(R, L) of F9 apex ratios"))
    A(MetricDef("F11_asym_canthal_tilt", "deg", "symmetry", "|R − L| of F5 canthal tilts (signed metric)"))
    A(MetricDef("F11_asym_commissure_offset", "%ICD", "symmetry", "|R − L| of F7 commissure offsets (signed metric)"))
    A(MetricDef("F11_asym_brow_head_offset", "%ICD", "symmetry", "|R − L| of F9 brow-head offsets (signed metric)"))
    A(MetricDef("F11_asym_brow_apex_offset", "%ICD", "symmetry", "|R − L| of F9 brow-apex offsets (signed metric)"))
    A(MetricDef("F11_asym_brow_tail_offset", "%ICD", "symmetry", "|R − L| of F9 brow-tail offsets (signed metric)"))
    return d


FRONTAL_METRICS: dict[str, MetricDef] = {m.id: m for m in _defs()}
FRONTAL_METRIC_IDS: tuple[str, ...] = tuple(FRONTAL_METRICS)


def brow_apex(pts: Mapping[str, np.ndarray], axes: FaceAxes, side: str) -> np.ndarray:
    """Highest point of the upper brow contour, refined by a parabola through its neighbours."""
    upper = [pts[f"brow_upper_{side}_{i}"] for i in range(1, 6)]
    hs = [axes.h(p) for p in upper]
    heights = [-axes.v(p) for p in upper]
    h_a, height_a, _ = refine_peak(hs, heights)
    return axes.to_image(h_a, -height_a)


def compute_frontal(pts: Mapping[str, np.ndarray], params: FrontalParams) -> tuple[dict[str, MetricValue], ScaleEstimate]:
    """All frontal metric values from named points (image pixel coordinates).

    Pure and deterministic: the same points always give the same values.
    """
    P = pts
    out: dict[str, MetricValue] = {}
    scale = iris_scale(P, iris_diameter_mm=params.iris_diameter_mm, rel_uncertainty=params.iris_rel_uncertainty,
                       max_diff_frac=params.max_iris_diff_frac)
    axes = face_axes(P)
    icd = dist(P[AX[0]], P[AX[1]]) if axes is not None else None

    def put(mid: str, value: float | None, used, reason: str | None = None) -> None:
        used = tuple(dict.fromkeys(used))
        if value is not None and not math.isfinite(value):
            value, reason = None, "degenerate_geometry"
        if value is None and reason is None:
            reason = "degenerate_geometry"
        out[mid] = MetricValue(None if value is None else float(value), used, None if value is not None else reason)

    def req(*names: str) -> str | None:
        if axes is None:
            return "axes_unavailable"
        for n in names:
            if n not in P:
                return f"{n}_unavailable"
        return None

    def put_offset(base_id: str, off_px: float | None, used, reason: str | None) -> None:
        """Write the ``_pct_icd`` and ``_mm`` forms of a signed offset."""
        put(f"{base_id}_pct_icd", None if off_px is None else off_px / icd * 100.0, used, reason)
        if off_px is None:
            put(f"{base_id}_mm", None, tuple(used) + SC, reason)
        elif not scale.available:
            put(f"{base_id}_mm", None, tuple(used) + SC, scale.reason or "no_scale")
        else:
            put(f"{base_id}_mm", off_px * scale.mm_per_px, tuple(used) + SC)

    # ---- F1 facial thirds ------------------------------------------------------
    base = AX + ("glabella", "subnasale", "menton")
    thirds_used = base + ("trichion",)
    r = req(*base)
    if r:
        for mid in ("F1_upper_third", "F1_middle_third", "F1_lower_third"):
            put(mid, None, thirds_used, r)
        put("F1_middle_lower_ratio", None, base, r)
    else:
        vg, vs, vm = axes.v(P["glabella"]), axes.v(P["subnasale"]), axes.v(P["menton"])
        middle, lower = vs - vg, vm - vs
        ok = middle > 0 and lower > 0
        put("F1_middle_lower_ratio", middle / lower if ok else None, base)
        r = req("trichion")
        upper = vg - axes.v(P["trichion"]) if not r else None
        if r or not ok or upper <= 0:
            for mid in ("F1_upper_third", "F1_middle_third", "F1_lower_third"):
                put(mid, None, thirds_used, r)
        else:
            total = upper + middle + lower
            put("F1_upper_third", upper / total, thirds_used)
            put("F1_middle_third", middle / total, thirds_used)
            put("F1_lower_third", lower / total, thirds_used)

    # ---- F2 lower-face split ---------------------------------------------------
    used = AX + ("subnasale", "upper_lip_inner", "lower_lip_inner", "menton")
    r = req(*used)
    if r:
        put("F2_lower_face_ratio", None, used, r)
    else:
        sto = midpoint(P["upper_lip_inner"], P["lower_lip_inner"])
        up, lo = axes.v(sto) - axes.v(P["subnasale"]), axes.v(P["menton"]) - axes.v(sto)
        put("F2_lower_face_ratio", up / lo if up > 0 and lo > 0 else None, used)

    # ---- F3 horizontal fifths --------------------------------------------------
    order = ("temporal_boundary_right", "lateral_canthus_right", "medial_canthus_right",
             "medial_canthus_left", "lateral_canthus_left", "temporal_boundary_left")
    f3_ids = ("F3_fifth_outer_right", "F3_fifth_eye_right", "F3_fifth_intercanthal",
              "F3_fifth_eye_left", "F3_fifth_outer_left")
    r = req(*order)
    if r:
        # Without both temporal boundaries the total width is undefined, so no fifth can be a fraction of it.
        for mid in f3_ids:
            put(mid, None, order, r)
    else:
        hs = np.array([axes.h(P[n]) for n in order])
        segs = np.diff(hs)
        total = hs[-1] - hs[0]
        ok = bool(np.all(segs > 0))
        for mid, seg in zip(f3_ids, segs):
            put(mid, seg / total if ok else None, order)

    # ---- F4 eye width vs intercanthal -----------------------------------------
    for s in SIDES:
        used = AX + (f"lateral_canthus_{s}",)
        r = req(*used)
        put(f"F4_eye_icd_ratio_{s}",
            None if r else dist(P[f"medial_canthus_{s}"], P[f"lateral_canthus_{s}"]) / icd, used, r)
    r = req(*AX)
    if r:
        put("F4_icd_mm", None, AX + SC, r)
    elif not scale.available:
        put("F4_icd_mm", None, AX + SC, scale.reason or "no_scale")
    else:
        put("F4_icd_mm", icd * scale.mm_per_px, AX + SC)

    # ---- F5 canthal tilt -------------------------------------------------------
    for s in SIDES:
        used = AX + (f"lateral_canthus_{s}",)
        r = req(*used)
        if r:
            put(f"F5_canthal_tilt_{s}", None, used, r)
        else:
            m, l = P[f"medial_canthus_{s}"], P[f"lateral_canthus_{s}"]
            dv_up = axes.v(m) - axes.v(l)
            dh = abs(axes.h(l) - axes.h(m))
            put(f"F5_canthal_tilt_{s}", math.degrees(math.atan2(dv_up, dh)) if dh > 0 else None, used)

    # ---- F6 nasal base vs intercanthal ----------------------------------------
    used = AX + ("alare_right", "alare_left")
    r = req(*used)
    put("F6_alar_icd_ratio", None if r else dist(P["alare_right"], P["alare_left"]) / icd, used, r)

    # ---- F7 mouth width --------------------------------------------------------
    for s in SIDES:
        sgn = FaceAxes.lateral_sign(s)
        ring = (f"iris_{s}_lateral", f"iris_{s}_medial")
        used = AX + (f"commissure_{s}", f"iris_center_{s}") + ring
        r = req(*used)
        off = None
        if not r:
            radius = dist(P[ring[0]], P[ring[1]]) / 2.0
            h_medial_limbus = axes.h(P[f"iris_center_{s}"]) - sgn * radius
            off = sgn * (axes.h(P[f"commissure_{s}"]) - h_medial_limbus)
        put_offset(f"F7_commissure_offset_{s}", off, used, r)
    have_mouth = all(n in P for n in ("commissure_right", "commissure_left"))
    mouth = dist(P["commissure_right"], P["commissure_left"]) if have_mouth else None
    used = ("commissure_right", "commissure_left", "alare_right", "alare_left")
    r = None if all(n in P for n in used) else "points_unavailable"
    put("F7_mouth_alar_ratio", None if r else mouth / dist(P["alare_right"], P["alare_left"]), used, r)
    used = ("commissure_right", "commissure_left", "iris_center_right", "iris_center_left")
    r = None if all(n in P for n in used) else "points_unavailable"
    put("F7_mouth_ipd_ratio", None if r else mouth / dist(P["iris_center_right"], P["iris_center_left"]), used, r)

    # ---- F8 lip ratio -----------------------------------------------------------
    used = AX + ("labrale_superius", "upper_lip_inner", "lower_lip_inner", "labrale_inferius")
    r = req(*used)
    if r:
        put("F8_lip_ratio", None, used, r)
    else:
        upper = axes.v(P["upper_lip_inner"]) - axes.v(P["labrale_superius"])
        lower = axes.v(P["labrale_inferius"]) - axes.v(P["lower_lip_inner"])
        put("F8_lip_ratio", lower / upper if upper > 0 and lower > 0 else None, used)

    # ---- F9 eyebrows ------------------------------------------------------------
    for s in SIDES:
        sgn = FaceAxes.lateral_sign(s)
        upper_names = tuple(f"brow_upper_{s}_{i}" for i in range(1, 6))
        ring = (f"iris_{s}_lateral", f"iris_{s}_medial")
        head, tail, ab, lc = f"brow_head_{s}", f"brow_tail_{s}", f"alar_base_{s}", f"lateral_canthus_{s}"

        used = AX + (head, ab)
        r = req(*used)
        put_offset(f"F9_brow_head_offset_{s}", None if r else sgn * (axes.h(P[head]) - axes.h(P[ab])), used, r)

        apex = None if req(*upper_names) else brow_apex(P, axes, s)
        used = AX + upper_names + (f"iris_center_{s}",) + ring
        r = req(*used)
        off = None
        if not r:
            h_lateral_limbus = axes.h(P[f"iris_center_{s}"]) + sgn * dist(P[ring[0]], P[ring[1]]) / 2.0
            off = sgn * (axes.h(apex) - h_lateral_limbus)
        put_offset(f"F9_brow_apex_offset_{s}", off, used, r)

        used = AX + upper_names + (head, tail)
        r = req(*used)
        ratio = None
        if not r:
            a, b = abs(axes.h(apex) - axes.h(P[head])), abs(axes.h(P[tail]) - axes.h(apex))
            ratio = a / b if b > 1e-6 * icd else None
        put(f"F9_brow_apex_ratio_{s}", ratio, used, r)

        used = AX + (tail, ab, lc)
        r = req(*used)
        off = None
        if not r:
            d = unit(P[lc] - P[ab])
            n = np.array([-d[1], d[0]])
            if float(np.dot(n, sgn * axes.ex)) < 0:
                n = -n
            off = float(np.dot(P[tail] - P[ab], n))
        put_offset(f"F9_brow_tail_offset_{s}", off, used, r)

    # ---- F10 golden ratio (clinic export only) ---------------------------------
    used = AX + ("trichion", "menton", "bizygomatic_right", "bizygomatic_left")
    r = req(*used)
    if r:
        put("F10_golden_ratio", None, used, r)
    else:
        height = axes.v(P["menton"]) - axes.v(P["trichion"])
        width = dist(P["bizygomatic_right"], P["bizygomatic_left"])
        put("F10_golden_ratio", height / width if height > 0 and width > 0 else None, used)

    # ---- F11 asymmetry ----------------------------------------------------------
    def pair(mid: str, right_id: str, left_id: str, relative: bool) -> None:
        a, b = out[right_id], out[left_id]
        used = a.landmarks + b.landmarks
        if a.value is None or b.value is None:
            put(mid, None, used, "pair_unavailable")
        elif relative:
            mean = (a.value + b.value) / 2.0
            put(mid, abs(a.value - b.value) / mean if mean > 0 else None, used)
        else:
            put(mid, abs(a.value - b.value), used)

    pair("F11_asym_eye_width", "F4_eye_icd_ratio_right", "F4_eye_icd_ratio_left", True)
    pair("F11_asym_outer_fifth", "F3_fifth_outer_right", "F3_fifth_outer_left", True)
    pair("F11_asym_brow_apex_ratio", "F9_brow_apex_ratio_right", "F9_brow_apex_ratio_left", True)
    pair("F11_asym_canthal_tilt", "F5_canthal_tilt_right", "F5_canthal_tilt_left", False)
    pair("F11_asym_commissure_offset", "F7_commissure_offset_right_pct_icd", "F7_commissure_offset_left_pct_icd", False)
    pair("F11_asym_brow_head_offset", "F9_brow_head_offset_right_pct_icd", "F9_brow_head_offset_left_pct_icd", False)
    pair("F11_asym_brow_apex_offset", "F9_brow_apex_offset_right_pct_icd", "F9_brow_apex_offset_left_pct_icd", False)
    pair("F11_asym_brow_tail_offset", "F9_brow_tail_offset_right_pct_icd", "F9_brow_tail_offset_left_pct_icd", False)

    return {mid: out[mid] for mid in FRONTAL_METRIC_IDS}, scale
