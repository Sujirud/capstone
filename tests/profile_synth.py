"""Synthetic side-profile images with known landmarks, and a colour-based fake segmenter.

The head is a closed interpolating spline through anatomical control points (facing
right, image y down). Regions are painted in flat colours (background, hair, face skin,
neck skin, clothes); ``FakeSegmenter`` maps each pixel to the nearest palette colour, so
it works on every crop / resize the pipeline makes.
"""

from __future__ import annotations

import cv2
import numpy as np
from scipy.interpolate import splev, splprep

PALETTE = {  # class id → RGB (selfie multiclass ids)
    0: (70, 110, 150),    # background (plain, blue-grey)
    1: (60, 40, 30),      # hair
    2: (205, 160, 130),   # body skin (neck)
    3: (228, 184, 152),   # face skin
    4: (170, 40, 40),     # clothes
}

# Front profile, top → bottom, then back of the head / neck (closed). Facing right.
FRONT = [
    ("vertex", (440, 160)), ("hair_front", (560, 215)), ("trichion", (592, 262)),
    ("forehead", (608, 330)), ("glabella", (620, 398)), ("nasion", (604, 446)),
    ("dorsum", (636, 500)), ("pronasale", (676, 552)), ("infratip", (664, 574)),
    ("subnasale", (622, 584)), ("upper_lip", (624, 606)), ("labrale_superius", (642, 628)),
    ("stomion", (628, 646)), ("labrale_inferius", (640, 666)), ("sulcus", (614, 700)),
    ("soft_tissue_pogonion", (634, 746)), ("menton", (606, 792)), ("cervical", (556, 812)),
    ("neck", (552, 900)), ("neck_low", (560, 1010)), ("chest", (640, 1120)), ("chest_low", (700, 1299)),
]
BACK = [(260, 1299), (330, 1120), (372, 960), (330, 760), (292, 560), (300, 380), (345, 240)]
LANDMARKS = ("trichion", "glabella", "nasion", "pronasale", "subnasale", "labrale_superius",
             "labrale_inferius", "soft_tissue_pogonion", "menton")
SIZE = (1000, 1300)  # width, height


class FakeSegmenter:
    model_resolution = 256

    def __init__(self) -> None:
        self._ids = np.array(list(PALETTE), dtype=np.uint8)
        self._cols = np.array(list(PALETTE.values()), dtype=np.float32)

    def segment(self, rgb: np.ndarray) -> np.ndarray:
        d = ((rgb[:, :, None, :].astype(np.float32) - self._cols[None, None]) ** 2).sum(axis=-1)
        return self._ids[np.argmin(d, axis=-1)]

    def close(self) -> None:
        pass


def _outline(n: int = 4000) -> np.ndarray:
    pts = np.array([p for _, p in FRONT] + BACK + [FRONT[0][1]], dtype=float)
    tck, _ = splprep([pts[:, 0], pts[:, 1]], s=0, per=True, k=3)
    x, y = splev(np.linspace(0, 1, n), tck)
    return np.column_stack([x, y])


def make_profile(facing: str = "right") -> tuple[np.ndarray, dict[str, np.ndarray], FakeSegmenter]:
    """(RGB image, ground-truth landmark positions, fake segmenter)."""
    w, h = SIZE
    person = np.zeros((h, w), np.uint8)
    cv2.fillPoly(person, [np.round(_outline()).astype(np.int32)], 1)
    cls = np.zeros((h, w), np.uint8)
    cls[person > 0] = 3
    yy, xx = np.mgrid[0:h, 0:w]
    tri = dict(FRONT)["trichion"]
    # Hair: above a hairline running from the trichion back and down to behind the ear.
    hairline = (yy < tri[1] + (tri[0] - xx) * 0.9) | (xx < 400)
    cls[(person > 0) & hairline & (yy < 820)] = 1
    # Neck: below the jaw line (cervical point → back of the jaw).
    cerv = dict(FRONT)["cervical"]
    cls[(person > 0) & (yy > cerv[1] - (cerv[0] - xx) * 0.35) & (yy > 700)] = 2
    cls[(person > 0) & (yy > 1060)] = 4
    rgb = np.zeros((h, w, 3), np.uint8)
    for c, col in PALETTE.items():
        rgb[cls == c] = col
    gt = {name: np.array(dict(FRONT)[name], dtype=float) for name in LANDMARKS}
    if facing == "left":
        rgb = np.ascontiguousarray(rgb[:, ::-1])
        for k in gt:
            gt[k] = np.array([w - 1 - gt[k][0], gt[k][1]])
    return rgb, gt, FakeSegmenter()
