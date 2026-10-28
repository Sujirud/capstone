"""Render every named point with its label on a sample image for human sign-off.

    python -m facescan.tools.debug_landmarks photo.jpg --out sheet.png [--all-indices]

The sheet shows the whole face plus enlarged crops of the brows, eyes, nose and
mouth. ``--all-indices`` also prints every MediaPipe mesh index in the crops,
which is how indices are checked against the canonical face model UV map.
The table printed to stdout lists name, indices, side, pixel position, source
and the reason for every unavailable point.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from facescan import EngineConfig, load_image
from facescan.core.config import load_settings
from facescan.core.detector import FaceDetector, HairSegmenter
from facescan.core.frontal_points import extract_frontal_points
from facescan.core.landmark_map import DERIVED_FRONTAL_POINTS, FRONTAL_POINT_NAMES, MESH_LANDMARKS

REGIONS = {
    "brows": ["brow_tail_right", "brow_tail_left", "brow_upper_right_3", "brow_upper_left_3", "glabella"],
    "eyes": ["lateral_canthus_right", "lateral_canthus_left", "iris_center_right", "iris_center_left"],
    "nose": ["alare_right", "alare_left", "pronasale", "subnasale"],
    "mouth": ["commissure_right", "commissure_left", "labrale_superius", "labrale_inferius"],
}
COLORS = {"midline": (255, 230, 0), "right": (0, 200, 255), "left": (255, 90, 200), "derived": (120, 255, 120)}


def _crop_box(points: list[np.ndarray], pad_frac: float, w: int, h: int) -> tuple[int, int, int, int]:
    p = np.array(points)
    x0, y0 = p.min(axis=0)
    x1, y1 = p.max(axis=0)
    pad = pad_frac * max(x1 - x0, y1 - y0, 20)
    return (int(max(0, x0 - pad)), int(max(0, y0 - pad)), int(min(w, x1 + pad)), int(min(h, y1 + pad)))


def _panel(rgb: np.ndarray, box, pts: dict[str, np.ndarray], mesh: np.ndarray | None, width: int) -> Image.Image:
    x0, y0, x1, y1 = box
    crop = Image.fromarray(rgb[y0:y1, x0:x1])
    s = width / crop.width
    crop = crop.resize((width, max(1, int(crop.height * s))), Image.LANCZOS)
    d = ImageDraw.Draw(crop)
    small = ImageFont.load_default(10)
    font = ImageFont.load_default(13)
    if mesh is not None:
        for i, (x, y) in enumerate(mesh):
            if x0 <= x < x1 and y0 <= y < y1:
                u, v = (x - x0) * s, (y - y0) * s
                d.point((u, v), fill=(200, 200, 200))
                d.text((u + 2, v - 5), str(i), font=small, fill=(200, 200, 200))
    for name, p in pts.items():
        if not (x0 <= p[0] < x1 and y0 <= p[1] < y1):
            continue
        u, v = (p[0] - x0) * s, (p[1] - y0) * s
        side = "derived" if name in DERIVED_FRONTAL_POINTS else MESH_LANDMARKS[name].side
        c = COLORS[side]
        d.ellipse((u - 4, v - 4, u + 4, v + 4), fill=c, outline=(0, 0, 0))
        d.text((u + 6, v - 7), name, font=font, fill=c, stroke_width=2, stroke_fill=(0, 0, 0))
    return crop


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="facescan-debug-landmarks", description=__doc__.split("\n\n")[0])
    p.add_argument("image", type=Path)
    p.add_argument("--out", type=Path, required=True, help="output PNG path")
    p.add_argument("--models-dir", type=Path, default=Path("models"))
    p.add_argument("--all-indices", action="store_true", help="also print every mesh index in the crops")
    args = p.parse_args(argv)

    config = EngineConfig.from_models_dir(args.models_dir)
    settings = load_settings(config)
    img = load_image(args.image.read_bytes())
    with FaceDetector(config.face_landmarker_model) as det, HairSegmenter(config.segmenter_model) as seg:
        faces = det.detect(img.pixels)
        if len(faces) != 1:
            print(f"error: expected one face, found {len(faces)}", file=sys.stderr)
            return 2
        ext = extract_frontal_points(faces[0], img.pixels, seg, settings.capture)
    pts, mesh = ext.points, faces[0].xy
    h, w = img.height, img.width

    print(f"{'name':28s} {'indices':12s} {'side':8s} {'x':>9s} {'y':>9s}  note")
    for name in FRONTAL_POINT_NAMES:
        spec = MESH_LANDMARKS.get(name)
        idx = ",".join(map(str, spec.indices)) if spec else "derived"
        side = spec.side if spec else "-"
        if name in pts:
            print(f"{name:28s} {idx:12s} {side:8s} {pts[name][0]:9.1f} {pts[name][1]:9.1f}")
        else:
            print(f"{name:28s} {idx:12s} {side:8s} {'—':>9s} {'—':>9s}  unavailable: {ext.reasons.get(name)}")

    face_box = _crop_box(list(pts.values()), 0.15, w, h)
    panels = [_panel(img.pixels, face_box, pts, None, 900)]
    for names in REGIONS.values():
        box = _crop_box([pts[n] for n in names if n in pts], 0.35, w, h)
        panels.append(_panel(img.pixels, box, pts, mesh if args.all_indices else None, 900))
    rows_h = sum(max(pp.height for pp in panels[1:][i:i + 2]) + 10 for i in range(0, len(panels) - 1, 2))
    sheet = Image.new("RGB", (1800, panels[0].height + 20 + rows_h), (20, 20, 20))
    sheet.paste(panels[0], (0, 0))
    y = panels[0].height + 20
    crops = panels[1:]
    for i in range(0, len(crops), 2):
        row = crops[i:i + 2]
        for col, pp in enumerate(row):
            sheet.paste(pp, (col * 900, y))
        y += max(pp.height for pp in row) + 10
    legend = ImageDraw.Draw(sheet)
    lx = 920
    for i, (k, c) in enumerate(COLORS.items()):
        y0 = 20 + 22 * i
        legend.ellipse((lx, y0 + 3, lx + 12, y0 + 15), fill=c)
        legend.text((lx + 20, y0), k, font=ImageFont.load_default(16), fill=c)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
