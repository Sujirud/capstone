"""Named anatomical points → MediaPipe Face Landmarker indices (single source of truth).

Sides are from the **subject's** perspective. In an unmirrored photo the subject's
right side appears on the image's left. Images must not be mirrored (front-camera
previews often are): MediaPipe labels sides from facial appearance, so a mirrored
image swaps every left/right label.

Verification (2026-09-27, recorded in ASSUMPTIONS.md; re-run
``python -m facescan.tools.debug_landmarks`` for human sign-off on new models):

* Each index was checked against the canonical face model
  (``mediapipe/modules/face_geometry/data/canonical_face_model.obj`` and
  ``canonical_face_model_uv_visualization.png``): midline points have x = 0 and
  the expected vertical order (10 top > 151 > 9 > 168 > 6 > 4 > 1 > 2 > 0 > 13 >
  14 > 17 > 152 bottom); "right" points have negative canonical x (image left).
* pronasale = 4, not the often-quoted 1: vertex 4 is the most anterior point of the
  canonical mesh (z = 7.59 vs 7.48 for vertex 1); vertex 1 sits on the lower tip
  lobule. No frontal metric uses pronasale.
* glabella = 9: the most anterior midline vertex between nasion and the forehead.
  nasion = 168: the deepest midline vertex between glabella and the nasal dorsum.
* Iris rings (checked on a real frontal portrait): 469 / 474 are the image-right
  extremes, 471 / 476 the image-left extremes, 470 / 475 top, 472 / 477 bottom.
  So the horizontal diameters are 469–471 (right eye) and 474–476 (left eye); for
  the subject's right eye the medial (nasal) side is 469, for the left eye 476.
* Alare (alar width) = 129 / 358: on a real portrait these lie on the visible
  lateral alar edge (alar-facial groove); 48 / 278 and 64 / 294 lie inside it.
  Alar base = 64 / 294: lateral point where the alar base meets the face.
* Brows: upper contour 70-63-105-66-107 (right, lateral→medial) and
  300-293-334-296-336 (left); lower contour 46-53-52-65-55 / 276-283-282-295-285.
  Head = mean(medial upper, medial lower), tail = mean(lateral upper, lateral lower).
* Face oval ring order is taken from ``FaceLandmarksConnections.FACE_LANDMARKS_FACE_OVAL``.

Never extrapolate points the mesh does not provide: trichion comes from hair
segmentation (``hairline.py``), temporal boundaries from the face-oval contour at
canthal level, and every profile point from the silhouette (Phase 2).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Side = Literal["midline", "right", "left"]

NUM_MESH_POINTS = 478  # 468 face mesh + 10 iris points


@dataclass(frozen=True)
class LandmarkSpec:
    name: str
    indices: tuple[int, ...]  # averaged when more than one
    side: Side
    confidence: Literal["high", "low"]
    comment: str


def _spec(name: str, indices: tuple[int, ...] | int, side: Side, comment: str,
          confidence: Literal["high", "low"] = "high") -> LandmarkSpec:
    if isinstance(indices, int):
        indices = (indices,)
    return LandmarkSpec(name, indices, side, confidence, comment)


_BROW_NOTE = "mesh brow points may not follow the brow hairs → low confidence unless a clinician confirms"

MESH_LANDMARKS: dict[str, LandmarkSpec] = {s.name: s for s in [
    # Midline
    _spec("mesh_top", 10, "midline", "top of the mesh; NOT the hairline"),
    _spec("glabella", 9, "midline", "most anterior midline point between the brows"),
    _spec("nasion", 168, "midline", "deepest point of the frontonasal junction"),
    _spec("pronasale", 4, "midline", "nasal tip, most anterior mesh vertex (see module docstring)"),
    _spec("subnasale", 2, "midline", "junction of columella and upper lip"),
    _spec("labrale_superius", 0, "midline", "upper vermilion border, midline"),
    _spec("upper_lip_inner", 13, "midline", "upper lip, inner (stomion superius)"),
    _spec("lower_lip_inner", 14, "midline", "lower lip, inner (stomion inferius)"),
    _spec("labrale_inferius", 17, "midline", "lower vermilion border, midline"),
    _spec("menton", 152, "midline", "lowest point of the chin"),
    # Eyes
    _spec("lateral_canthus_right", 33, "right", "exocanthion"),
    _spec("medial_canthus_right", 133, "right", "endocanthion"),
    _spec("medial_canthus_left", 362, "left", "endocanthion"),
    _spec("lateral_canthus_left", 263, "left", "exocanthion"),
    # Irises (horizontal ring points verified on a real portrait)
    _spec("iris_center_right", 468, "right", "iris centre"),
    _spec("iris_right_medial", 469, "right", "iris ring, nasal horizontal extreme"),
    _spec("iris_right_lateral", 471, "right", "iris ring, temporal horizontal extreme"),
    _spec("iris_center_left", 473, "left", "iris centre"),
    _spec("iris_left_lateral", 474, "left", "iris ring, temporal horizontal extreme"),
    _spec("iris_left_medial", 476, "left", "iris ring, nasal horizontal extreme"),
    # Nose
    _spec("alare_right", 129, "right", "most lateral point of the ala (alar width)"),
    _spec("alare_left", 358, "left", "most lateral point of the ala (alar width)"),
    _spec("alar_base_right", 64, "right", "lateral alar base (alar-facial junction)"),
    _spec("alar_base_left", 294, "left", "lateral alar base (alar-facial junction)"),
    # Mouth
    _spec("commissure_right", 61, "right", "oral commissure (cheilion)"),
    _spec("commissure_left", 291, "left", "oral commissure (cheilion)"),
    # Face width
    _spec("bizygomatic_right", 234, "right", "widest face-oval point at cheekbone level"),
    _spec("bizygomatic_left", 454, "left", "widest face-oval point at cheekbone level"),
    # Brows (upper contour 1 = lateral … 5 = medial)
    _spec("brow_head_right", (107, 55), "right", "medial end of the brow; " + _BROW_NOTE, "low"),
    _spec("brow_tail_right", (70, 46), "right", "lateral end of the brow; " + _BROW_NOTE, "low"),
    _spec("brow_upper_right_1", 70, "right", "upper brow contour, lateral; " + _BROW_NOTE, "low"),
    _spec("brow_upper_right_2", 63, "right", "upper brow contour; " + _BROW_NOTE, "low"),
    _spec("brow_upper_right_3", 105, "right", "upper brow contour; " + _BROW_NOTE, "low"),
    _spec("brow_upper_right_4", 66, "right", "upper brow contour; " + _BROW_NOTE, "low"),
    _spec("brow_upper_right_5", 107, "right", "upper brow contour, medial; " + _BROW_NOTE, "low"),
    _spec("brow_head_left", (336, 285), "left", "medial end of the brow; " + _BROW_NOTE, "low"),
    _spec("brow_tail_left", (300, 276), "left", "lateral end of the brow; " + _BROW_NOTE, "low"),
    _spec("brow_upper_left_1", 300, "left", "upper brow contour, lateral; " + _BROW_NOTE, "low"),
    _spec("brow_upper_left_2", 293, "left", "upper brow contour; " + _BROW_NOTE, "low"),
    _spec("brow_upper_left_3", 334, "left", "upper brow contour; " + _BROW_NOTE, "low"),
    _spec("brow_upper_left_4", 296, "left", "upper brow contour; " + _BROW_NOTE, "low"),
    _spec("brow_upper_left_5", 336, "left", "upper brow contour, medial; " + _BROW_NOTE, "low"),
]}

# Points not provided by the mesh index table.
DERIVED_FRONTAL_POINTS: dict[str, str] = {
    "trichion": "hair segmentation: first face-skin → hair transition above the glabella",
    "temporal_boundary_right": "face-oval contour crossed by the face-horizontal line through the lateral canthus",
    "temporal_boundary_left": "face-oval contour crossed by the face-horizontal line through the lateral canthus",
}

FRONTAL_POINT_NAMES: tuple[str, ...] = tuple(MESH_LANDMARKS) + tuple(DERIVED_FRONTAL_POINTS)

# Face oval split into the two sides, each ordered top (10) → bottom (152).
FACE_OVAL_RING: tuple[int, ...] = (
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400,
    377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
)
FACE_OVAL_LEFT: tuple[int, ...] = FACE_OVAL_RING[: FACE_OVAL_RING.index(152) + 1]
FACE_OVAL_RIGHT: tuple[int, ...] = (10,) + tuple(reversed(FACE_OVAL_RING[FACE_OVAL_RING.index(152):]))

# Points used by the iris scale.
IRIS_POINTS: dict[str, tuple[str, str]] = {
    "right": ("iris_right_lateral", "iris_right_medial"),
    "left": ("iris_left_lateral", "iris_left_medial"),
}
SCALE_POINTS: tuple[str, ...] = ("iris_right_lateral", "iris_right_medial", "iris_left_lateral", "iris_left_medial")
# Points defining the face axes.
AXIS_POINTS: tuple[str, ...] = ("medial_canthus_right", "medial_canthus_left")

# Phase 2: profile points come from the silhouette, never from MediaPipe.
PROFILE_POINT_NAMES: tuple[str, ...] = (
    "trichion", "glabella", "nasion", "pronasale", "subnasale", "labrale_superius",
    "labrale_inferius", "soft_tissue_pogonion", "menton", "alar_crease",
)
PROFILE_SILHOUETTE_POINTS: tuple[str, ...] = tuple(p for p in PROFILE_POINT_NAMES if p != "alar_crease")


def default_confidence(name: str) -> Literal["high", "low"]:
    spec = MESH_LANDMARKS.get(name)
    return spec.confidence if spec is not None else "high"
