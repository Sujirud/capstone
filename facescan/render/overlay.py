"""Measurement overlays: a pure function of image + result → annotated image.

Styles
------
* ``user`` (shown in the app): neutral palette; metrics outside the reference
  range get one neutral accent colour (never red); no golden-ratio layer.
* ``clinical`` (clinic export and QA): within = green, above / below = red,
  inconclusive = amber, unavailable = grey.

Automatic points are filled dots; adjusted points (user or clinician) are hollow
rings. Lines are drawn with OpenCV; text with Pillow and a Thai-capable font
(RAQM layout when available, so Thai vowel and tone marks are placed correctly).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, features

from facescan.core.geometry import FaceAxes, dist
from facescan.core.locale import Strings, format_value
from facescan.core.metrics_frontal import brow_apex
from facescan.core.metrics_profile import columella_tangent
from facescan.core.normalize import face_axes
from facescan.core.schema import FrontalResult, ProfileResult

LAYERS = ("landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "profile_lines", "golden_ratio", "labels")

RGB = tuple[int, int, int]


@dataclass(frozen=True)
class Palette:
    base: RGB
    shadow: RGB
    point: RGB
    point_low: RGB
    status: dict[str, RGB]


USER_ACCENT: RGB = (64, 156, 255)  # neutral blue accent, never red
PALETTES = {
    "user": Palette(base=(245, 245, 245), shadow=(40, 40, 40), point=(245, 245, 245), point_low=(200, 200, 200),
                    status={"within": (245, 245, 245), "no_reference": (245, 245, 245), "inconclusive": (245, 245, 245),
                            "unavailable": (170, 170, 170), "above": USER_ACCENT, "below": USER_ACCENT}),
    "clinical": Palette(base=(230, 230, 230), shadow=(30, 30, 30), point=(0, 220, 255), point_low=(200, 120, 255),
                        status={"within": (46, 204, 64), "above": (230, 40, 40), "below": (230, 40, 40),
                                "inconclusive": (255, 176, 0), "unavailable": (150, 150, 150),
                                "no_reference": (200, 200, 255)}),
}
_SEVERITY = {"above": 4, "below": 4, "inconclusive": 3, "within": 1, "no_reference": 0, "unavailable": 2}


def _load_font(font_path: Path | None, size: int) -> ImageFont.ImageFont:
    if font_path is not None:
        layout = ImageFont.Layout.RAQM if features.check("raqm") else ImageFont.Layout.BASIC
        return ImageFont.truetype(str(font_path), size, layout_engine=layout)
    return ImageFont.load_default(size)


class _Canvas:
    def __init__(self, rgb: np.ndarray, style: str, strings: Strings, font_path: Path | None,
                 ref_px: float | None) -> None:
        self.img = np.ascontiguousarray(rgb.copy())
        h, w = self.img.shape[:2]
        s = min(h, w)
        # Sizes follow the face (intercanthal distance), capped by the image size.
        ref = ref_px if ref_px and ref_px > 0 else s / 10
        self.lw = max(1, round(ref / 70))
        self.r = max(2, round(ref / 35))
        self.font = _load_font(font_path, int(min(max(12, round(ref * 0.16)), max(12, s // 30))))
        self.pal = PALETTES[style]
        self.style = style
        self.S = strings
        self.labels: list[tuple[np.ndarray, str, RGB, str]] = []

    def color(self, *statuses: str | None) -> RGB:
        valid = [s for s in statuses if s]
        if not valid:
            return self.pal.base
        worst = max(valid, key=lambda s: _SEVERITY.get(s, 0))
        return self.pal.status.get(worst, self.pal.base)

    def line(self, a, b, color: RGB, width: int | None = None) -> None:
        w = width or self.lw
        p, q = tuple(int(round(v)) for v in a[:2]), tuple(int(round(v)) for v in b[:2])
        cv2.line(self.img, p, q, self.pal.shadow, w + 2, cv2.LINE_AA)
        cv2.line(self.img, p, q, color, w, cv2.LINE_AA)

    def polyline(self, pts: np.ndarray, color: RGB, width: int | None = None) -> None:
        w = width or max(1, self.lw // 2)
        q = np.round(np.asarray(pts, dtype=float)).astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(self.img, [q], False, self.pal.shadow, w + 2, cv2.LINE_AA)
        cv2.polylines(self.img, [q], False, color, w, cv2.LINE_AA)

    def dot(self, p, color: RGB, hollow: bool) -> None:
        c = tuple(int(round(v)) for v in p[:2])
        if hollow:
            cv2.circle(self.img, c, self.r + 1, self.pal.shadow, self.lw + 2, cv2.LINE_AA)
            cv2.circle(self.img, c, self.r + 1, color, self.lw, cv2.LINE_AA)
        else:
            cv2.circle(self.img, c, self.r + 1, self.pal.shadow, -1, cv2.LINE_AA)
            cv2.circle(self.img, c, self.r, color, -1, cv2.LINE_AA)

    def label(self, anchor, text: str | None, color: RGB, align: str = "right") -> None:
        """Queue a text label; ``align`` = side of the anchor the text goes (right / left / center)."""
        if text:
            self.labels.append((np.asarray(anchor, dtype=float), text, color, align))

    def finish(self, legend: list[tuple[str, RGB, str]]) -> np.ndarray:
        pil = Image.fromarray(self.img).convert("RGBA")
        overlay = Image.new("RGBA", pil.size, (0, 0, 0, 0))
        draw_bg = ImageDraw.Draw(overlay)
        texts: list[tuple[tuple[int, int], str, RGB]] = []
        placed: list[tuple[int, int, int, int]] = []
        pad = max(2, self.lw * 2)
        W, H = pil.size
        for anchor, text, color, align in self.labels:
            l, t, r, b = draw_bg.textbbox((0, 0), text, font=self.font)
            tw, th = r - l + 2 * pad, b - t + 2 * pad
            if align == "left":
                x = int(anchor[0]) - pad - tw
            elif align == "center":
                x = int(anchor[0]) - tw // 2
            else:
                x = int(anchor[0]) + pad
            y = int(anchor[1]) - th // 2
            for _ in range(30):  # simple collision offsets
                box = (x, y, x + tw, y + th)
                if not any(box[0] < q[2] and q[0] < box[2] and box[1] < q[3] and q[1] < box[3] for q in placed):
                    break
                y += th + 2
            x = min(max(0, x), max(0, W - tw))
            y = min(max(0, y), max(0, H - th))
            placed.append((x, y, x + tw, y + th))
            draw_bg.rectangle((x, y, x + tw, y + th), fill=(0, 0, 0, 150))
            texts.append(((x + pad - l, y + pad - t), text, color))
        # Legend (bottom-left).
        if legend:
            sw = max(10, self.r * 3)
            rows = []
            for kind, color, text in legend:
                l, t, r, b = draw_bg.textbbox((0, 0), text, font=self.font)
                rows.append((kind, color, text, r - l, b - t, l, t))
            row_h = max(h for *_, h, _, _ in rows) + pad
            box_w = sw + 3 * pad + max(w for _, _, _, w, *_ in rows)
            box_h = row_h * len(rows) + 2 * pad
            x0, y0 = pad, H - box_h - pad
            draw_bg.rectangle((x0, y0, x0 + box_w, y0 + box_h), fill=(0, 0, 0, 170))
        pil = Image.alpha_composite(pil, overlay)
        draw = ImageDraw.Draw(pil)
        for (x, y), text, color in texts:
            draw.text((x, y), text, font=self.font, fill=color + (255,))
        if legend:
            for i, (kind, color, text, w, h, l, t) in enumerate(rows):
                cy = y0 + pad + i * row_h + row_h // 2
                cx = x0 + pad + sw // 2
                if kind == "dot":
                    draw.ellipse((cx - self.r, cy - self.r, cx + self.r, cy + self.r), fill=color + (255,))
                elif kind == "ring":
                    draw.ellipse((cx - self.r, cy - self.r, cx + self.r, cy + self.r), outline=color + (255,),
                                 width=max(1, self.lw))
                else:
                    draw.line((x0 + pad, cy, x0 + pad + sw, cy), fill=color + (255,), width=max(2, self.lw))
                draw.text((x0 + 2 * pad + sw - l, cy - h // 2 - t), text, font=self.font, fill=(240, 240, 240, 255))
        return np.asarray(pil.convert("RGB"))


def render_overlay(rgb: np.ndarray, result: FrontalResult | ProfileResult, *, layers: Iterable[str],
                   style: Literal["user", "clinical"] = "user", strings: Strings,
                   font_path: Path | None = None, columella_fit: tuple[float, float] = (0.4, 0.9)) -> np.ndarray:
    """Annotated copy of ``rgb`` (H×W×3 RGB) for the given result, layers and style."""
    if style not in PALETTES:
        raise ValueError(f"unknown style {style!r}")
    layers = set(layers)
    unknown = layers - set(LAYERS)
    if unknown:
        raise ValueError(f"unknown layers: {sorted(unknown)}")
    if style == "user":
        layers.discard("golden_ratio")  # clinic export only, never shown in the app
    pts = {n: lm.xy() for n, lm in result.landmarks.items() if lm.available}
    if "medial_canthus_right" in pts and "medial_canthus_left" in pts:
        ref_px = dist(pts["medial_canthus_right"], pts["medial_canthus_left"])
    elif "nasion" in pts and ("menton" in pts or "soft_tissue_pogonion" in pts):
        ref_px = dist(pts["nasion"], pts.get("menton", pts.get("soft_tissue_pogonion"))) / 3.5  # ≈ ICD
    else:
        ref_px = None
    cv = _Canvas(rgb, style, strings, font_path, ref_px)
    show_labels = "labels" in layers

    if isinstance(result, FrontalResult) and result.metrics:
        axes = face_axes(pts)
        if axes is not None:
            _frontal_layers(cv, result, pts, axes, layers, show_labels)

    if isinstance(result, ProfileResult) and "profile_lines" in layers:
        _profile_layers(cv, result, pts, show_labels, columella_fit)

    if "landmarks" in layers:
        for name, lm in result.landmarks.items():
            if lm.available and name != "mesh_top":
                color = cv.pal.point if lm.confidence == "high" else cv.pal.point_low
                cv.dot(lm.xy(), color, hollow=lm.adjusted)

    S = strings
    legend: list[tuple[str, RGB, str]] = [("dot", cv.pal.point, S.get("overlay.auto_point")),
                                          ("dot", cv.pal.point_low, S.get("overlay.low_confidence_point")),
                                          ("ring", cv.pal.point, S.get("overlay.adjusted_point"))]
    if style == "user":
        legend += [("line", cv.pal.base, S.get("overlay.measured")),
                   ("line", USER_ACCENT, S.get("overlay.outside_reference"))]
    else:
        st = cv.pal.status
        legend += [("line", st["within"], S.get("overlay.within")), ("line", st["above"], S.get("overlay.above_below")),
                   ("line", st["inconclusive"], S.get("overlay.inconclusive")),
                   ("line", st["unavailable"], S.get("overlay.unavailable"))]
    return cv.finish(legend)


def _status(result: FrontalResult, *ids: str) -> list[str | None]:
    return [result.metrics[i].status if i in result.metrics else None for i in ids]


def _text(cv: _Canvas, result: FrontalResult, mid: str) -> str | None:
    m = result.metrics.get(mid)
    if m is None or m.value is None:
        return None
    key = f"metric.{mid}.short" if m.display == "user" else f"clinical.metric.{mid}.short"
    return f"{cv.S.get(key, mid)} {format_value(m.value, m.unit, cv.S)}"


def _frontal_layers(cv: _Canvas, r: FrontalResult, P: dict[str, np.ndarray], axes: FaceAxes,
                    layers: set[str], show_labels: bool) -> None:
    icd = dist(P["medial_canthus_right"], P["medial_canthus_left"])
    have = lambda *names: all(n in P for n in names)  # noqa: E731
    h_left_edge = axes.h(P["bizygomatic_right"]) - 0.25 * icd if have("bizygomatic_right") else -2.5 * icd
    h_right_edge = axes.h(P["bizygomatic_left"]) + 0.25 * icd if have("bizygomatic_left") else 2.5 * icd

    def hline(p, color, h0=h_left_edge, h1=h_right_edge, width=None):
        v = axes.v(p)
        cv.line(axes.to_image(h0, v), axes.to_image(h1, v), color, width)

    def vline(h, v0, v1, color):
        cv.line(axes.to_image(h, v0), axes.to_image(h, v1), color)

    # ---- thirds
    if "thirds" in layers and have("glabella", "subnasale", "menton"):
        guide = cv.pal.base
        levels = ["glabella", "subnasale", "menton"] + (["trichion"] if "trichion" in P else [])
        for n in levels:
            hline(P[n], guide, width=max(1, cv.lw // 2))
        hb = h_left_edge
        segs = [("glabella", "subnasale", "F1_middle_third"), ("subnasale", "menton", "F1_lower_third")]
        if "trichion" in P:
            segs.insert(0, ("trichion", "glabella", "F1_upper_third"))
        for a, b, mid in segs:
            status = _status(r, mid) if "trichion" in P else _status(r, "F1_middle_lower_ratio")
            color = cv.color(*status)
            vline(hb, axes.v(P[a]), axes.v(P[b]), color)
            if show_labels:
                label = _text(cv, r, mid) if "trichion" in P else None
                cv.label(axes.to_image(hb, (axes.v(P[a]) + axes.v(P[b])) / 2), label, color, "left")
        if show_labels and "trichion" not in P:
            cv.label(axes.to_image(hb, axes.v(P["subnasale"])), _text(cv, r, "F1_middle_lower_ratio"),
                     cv.color(*_status(r, "F1_middle_lower_ratio")), "left")

    # ---- fifths
    order = ["temporal_boundary_right", "lateral_canthus_right", "medial_canthus_right",
             "medial_canthus_left", "lateral_canthus_left", "temporal_boundary_left"]
    f3 = ["F3_fifth_outer_right", "F3_fifth_eye_right", "F3_fifth_intercanthal", "F3_fifth_eye_left", "F3_fifth_outer_left"]
    if "fifths" in layers and have(*order[1:5]):
        v_c = axes.v(P["lateral_canthus_right"])
        span = 0.6 * icd
        avail = [n for n in order if n in P]
        for n in avail:
            vline(axes.h(P[n]), v_c - span, v_c + span, cv.pal.base)
        for i, mid in enumerate(f3):
            a, b = order[i], order[i + 1]
            if a in P and b in P:
                color = cv.color(*_status(r, mid))
                y = v_c - 0.45 * icd
                cv.line(axes.to_image(axes.h(P[a]), y), axes.to_image(axes.h(P[b]), y), color)
                if show_labels:
                    cv.label(axes.to_image((axes.h(P[a]) + axes.h(P[b])) / 2, y - 0.25 * icd - 0.3 * icd * (i % 2)),
                             _text(cv, r, mid), color, "center")

    # ---- eyes and brows
    if "eyes_brows" in layers:
        for s in ("right", "left"):
            sgn = axes.lateral_sign(s)
            m, l = f"medial_canthus_{s}", f"lateral_canthus_{s}"
            if have(m, l):
                color = cv.color(*_status(r, f"F5_canthal_tilt_{s}"))
                cv.line(P[m], P[l], color)
                if show_labels:
                    cv.label(P[l] + 0.2 * icd * axes.ey, _text(cv, r, f"F5_canthal_tilt_{s}"), color,
                             "left" if s == "right" else "right")
            ab, head, tail = f"alar_base_{s}", f"brow_head_{s}", f"brow_tail_{s}"
            uppers = [f"brow_upper_{s}_{i}" for i in range(1, 6)]
            if have(ab, head):
                color = cv.color(*_status(r, f"F9_brow_head_offset_{s}_pct_icd"))
                vline(axes.h(P[ab]), axes.v(P[ab]), axes.v(P[head]) - 0.1 * icd, color)
            if have(*uppers, f"iris_center_{s}", f"iris_{s}_lateral", f"iris_{s}_medial"):
                apex = brow_apex(P, axes, s)
                radius = dist(P[f"iris_{s}_lateral"], P[f"iris_{s}_medial"]) / 2
                h_ll = axes.h(P[f"iris_center_{s}"]) + sgn * radius
                color = cv.color(*_status(r, f"F9_brow_apex_offset_{s}_pct_icd", f"F9_brow_apex_ratio_{s}"))
                vline(h_ll, axes.v(P[f"iris_center_{s}"]), axes.v(apex) - 0.1 * icd, color)
                cv.dot(apex, color, hollow=False)
                if show_labels:
                    cv.label(apex - 0.35 * icd * axes.ey, _text(cv, r, f"F9_brow_apex_ratio_{s}"), color, "center")
            if have(ab, l, tail):
                color = cv.color(*_status(r, f"F9_brow_tail_offset_{s}_pct_icd"))
                d = P[l] - P[ab]
                t = max(1.0, float(np.dot(P[tail] - P[ab], d) / max(np.dot(d, d), 1e-9)) + 0.05)
                cv.line(P[ab], P[ab] + t * d, color)

    # ---- nose and lips
    if "nose_lips" in layers:
        if have("alare_right", "alare_left"):
            color = cv.color(*_status(r, "F6_alar_icd_ratio"))
            cv.line(P["alare_right"], P["alare_left"], color)
            if show_labels:
                cv.label(P["alare_left"] + 0.15 * icd * axes.ex, _text(cv, r, "F6_alar_icd_ratio"), color)
        if have("medial_canthus_right", "medial_canthus_left"):
            color = cv.color(*_status(r, "F4_icd_mm"))
            cv.line(P["medial_canthus_right"], P["medial_canthus_left"], color, width=max(1, cv.lw // 2))
        for s in ("right", "left"):
            sgn = axes.lateral_sign(s)
            if have(f"iris_center_{s}", f"iris_{s}_lateral", f"iris_{s}_medial", f"commissure_{s}"):
                radius = dist(P[f"iris_{s}_lateral"], P[f"iris_{s}_medial"]) / 2
                h_ml = axes.h(P[f"iris_center_{s}"]) - sgn * radius
                color = cv.color(*_status(r, f"F7_commissure_offset_{s}_pct_icd"))
                vline(h_ml, axes.v(P[f"iris_center_{s}"]), axes.v(P[f"commissure_{s}"]) + 0.15 * icd, color)
                if show_labels:
                    cv.label(P[f"commissure_{s}"] + 0.35 * icd * axes.ey,
                             _text(cv, r, f"F7_commissure_offset_{s}_pct_icd"), color,
                             "left" if s == "right" else "right")
        if have("labrale_superius", "upper_lip_inner", "lower_lip_inner", "labrale_inferius"):
            color = cv.color(*_status(r, "F8_lip_ratio"))
            off = 0.05 * icd * axes.ex
            cv.line(P["labrale_superius"] + off, P["upper_lip_inner"] + off, color)
            cv.line(P["lower_lip_inner"] + off, P["labrale_inferius"] + off, color)
            if show_labels:
                cv.label(P["labrale_inferius"] + 0.8 * icd * axes.ex, _text(cv, r, "F8_lip_ratio"), color)

    # ---- golden ratio (clinical style only; removed earlier for the user style)
    if "golden_ratio" in layers and have("trichion", "menton", "bizygomatic_right", "bizygomatic_left"):
        color = cv.color(*_status(r, "F10_golden_ratio"))
        h_mid = (axes.h(P["bizygomatic_right"]) + axes.h(P["bizygomatic_left"])) / 2
        vline(h_mid, axes.v(P["trichion"]), axes.v(P["menton"]), color)
        cv.line(P["bizygomatic_right"], P["bizygomatic_left"], color)
        if show_labels:
            cv.label(P["bizygomatic_left"] + 0.1 * icd * axes.ex, _text(cv, r, "F10_golden_ratio"), color)


def _profile_layers(cv: _Canvas, r: ProfileResult, P: dict[str, np.ndarray], show_labels: bool,
                    columella_fit: tuple[float, float]) -> None:
    contour = np.array([[p.x, p.y] for p in r.contour], dtype=float) if r.contour else None
    if contour is not None:
        cv.polyline(contour, cv.pal.base)
    have = lambda *names: all(n in P for n in names)  # noqa: E731
    fwd = np.array([-1.0, 0.0]) if r.facing == "left" else np.array([1.0, 0.0])   # anterior direction
    unit_px = 3.5 * cv.r * 3                                                         # label offset scale
    side = "left" if r.facing == "left" else "right"

    def st(*ids: str):
        return cv.color(*[r.metrics[i].status if i in r.metrics else None for i in ids])

    if have("glabella", "nasion", "pronasale"):
        c = st("P1_nasofrontal_angle")
        cv.line(P["nasion"], P["glabella"], c)
        cv.line(P["nasion"], P["pronasale"], c)
        if show_labels:
            cv.label(P["nasion"] + fwd * unit_px, _text(cv, r, "P1_nasofrontal_angle"), c, side)
    tan = columella_tangent(P, contour, columella_fit) if contour is not None else None
    if tan is not None and have("subnasale", "labrale_superius", "pronasale"):
        c = st("P2_nasolabial_angle")
        L = dist(P["subnasale"], P["pronasale"])
        cv.line(P["subnasale"], P["subnasale"] + tan[1] * L, c)
        cv.line(P["subnasale"], P["labrale_superius"], c)
        if show_labels:
            cv.label(P["subnasale"] + fwd * unit_px * 1.5, _text(cv, r, "P2_nasolabial_angle"), c, side)
    if have("nasion", "alar_crease", "pronasale"):
        c = st("P3a_tip_projection_goode")
        n, ac = P["nasion"], P["alar_crease"]
        cv.line(n, ac + 0.15 * (ac - n), c)
        d = (ac - n) / max(float(np.hypot(*(ac - n))), 1e-9)
        foot = n + d * float(np.dot(P["pronasale"] - n, d))
        cv.line(P["pronasale"], foot, c)
        if show_labels:
            cv.label(foot - fwd * unit_px * 0.5, _text(cv, r, "P3a_tip_projection_goode"), c,
                     "right" if side == "left" else "left")
    if have("pronasale", "soft_tissue_pogonion"):
        ids = ("P4_eline_upper_lip_mm", "P4_eline_lower_lip_mm", "P4_eline_upper_lip_pct", "P4_eline_lower_lip_pct")
        c = st(*ids)
        a, b = P["pronasale"], P["soft_tissue_pogonion"]
        cv.line(a - 0.1 * (b - a), b + 0.15 * (b - a), c)
        d = (b - a) / max(float(np.hypot(*(b - a))), 1e-9)
        for lip, mid_mm, mid_pct in (("labrale_superius", ids[0], ids[2]), ("labrale_inferius", ids[1], ids[3])):
            if lip in P:
                foot = a + d * float(np.dot(P[lip] - a, d))
                cv.line(P[lip], foot, c, width=max(1, cv.lw // 2))
                if show_labels:
                    m = r.metrics.get(mid_mm)
                    cv.label(foot + fwd * unit_px,
                             _text(cv, r, mid_mm if m is not None and m.value is not None else mid_pct), c, side)
    if have("glabella", "trichion"):
        c = st("P5_forehead_inclination")
        g, t = P["glabella"], P["trichion"]
        cv.line(g, t, c)
        cv.line(g, g - np.array([0.0, float(np.hypot(*(g - t)))]), cv.pal.base, width=max(1, cv.lw // 2))
        if show_labels:
            cv.label((g + t) / 2 + fwd * unit_px, _text(cv, r, "P5_forehead_inclination"), c, side)
