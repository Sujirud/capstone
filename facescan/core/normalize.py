"""Image loading, camera intrinsics, face axes and pixel → mm scale.

``load_image`` decodes in memory and never touches the disk. ``LoadedImage``
carries the RGB pixels exactly as analyzed (after EXIF orientation), the camera
focal length for that image, and a SHA-256 of the decoded pixels.
"""

from __future__ import annotations

import hashlib
import io
import math
from dataclasses import dataclass
from typing import Literal, Mapping

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from facescan.core.errors import ImageDecodeError
from facescan.core.geometry import FaceAxes, dist
from facescan.core.landmark_map import AXIS_POINTS, IRIS_POINTS, SCALE_POINTS
from facescan.core.schema import CameraInfo

ACCEPTED_FORMATS = {"JPEG", "MPO", "PNG", "WEBP"}

# 35 mm film frame diagonal (36 × 24 mm); CIPA DC-008 defines the 35 mm-equivalent
# focal length through the diagonal.
FULL_FRAME_DIAGONAL_MM = math.hypot(36.0, 24.0)

_EXIF_IFD = 0x8769
_FOCAL_LENGTH = 0x920A
_FOCAL_LENGTH_35MM = 0xA405
_FOCAL_PLANE_X_RES = 0xA20E
_FOCAL_PLANE_RES_UNIT = 0xA210
_PIXEL_X_DIMENSION = 0xA002
_MM_PER_UNIT = {2: 25.4, 3: 10.0, 4: 1.0, 5: 0.001}  # inch, cm, mm, µm


def pixel_sha256(rgb: np.ndarray) -> str:
    """SHA-256 of decoded RGB pixels (shape included, so reshapes cannot collide)."""
    arr = np.ascontiguousarray(rgb, dtype=np.uint8)
    h = hashlib.sha256()
    h.update(("x".join(str(s) for s in arr.shape) + ":").encode())
    h.update(arr.tobytes())
    return h.hexdigest()


@dataclass(frozen=True, eq=False)
class LoadedImage:
    """An image ready for analysis: H×W×3 uint8 RGB (read-only), camera, pixel hash.

    ``camera.focal_px`` refers to these exact pixels, so callers must not resize
    or crop a LoadedImage's pixels before analysis.
    """

    pixels: np.ndarray
    sha256: str
    camera: CameraInfo | None = None

    @property
    def width(self) -> int:
        return int(self.pixels.shape[1])

    @property
    def height(self) -> int:
        return int(self.pixels.shape[0])

    @classmethod
    def from_array(cls, array: np.ndarray, *, camera: CameraInfo | None = None,
                   channel_order: Literal["rgb", "bgr"] = "rgb") -> "LoadedImage":
        """Wrap an already-decoded frame (e.g. an OpenCV webcam frame with ``channel_order="bgr"``)."""
        arr = np.asarray(array)
        if arr.dtype != np.uint8 or arr.ndim != 3 or arr.shape[2] not in (3, 4):
            raise ValueError("expected an H×W×3 (or ×4) uint8 array")
        arr = arr[:, :, :3]
        if channel_order == "bgr":
            arr = arr[:, :, ::-1]
        arr = np.ascontiguousarray(arr).copy()
        arr.setflags(write=False)
        return cls(pixels=arr, sha256=pixel_sha256(arr), camera=camera)


def camera_from_exif(exif: Image.Exif, raw_width: int, raw_height: int) -> CameraInfo | None:
    """Focal length in pixels from EXIF, or None.

    Uses the 35 mm-equivalent focal length (through the image diagonal), else the
    focal length plus the focal-plane resolution (sensor pixel density), scaled if
    the stored image is smaller than the sensor image. ``raw_*`` are the stored
    (pre-orientation) dimensions; the focal length in pixels does not change
    with rotation.
    """
    try:
        ifd = exif.get_ifd(_EXIF_IFD)
    except Exception:  # malformed EXIF must never break decoding
        return None
    diag_px = math.hypot(raw_width, raw_height)
    focal_px: float | None = None
    try:
        f35 = ifd.get(_FOCAL_LENGTH_35MM)
        if f35 and float(f35) > 0:
            focal_px = float(f35) * diag_px / FULL_FRAME_DIAGONAL_MM
        else:
            f_mm = ifd.get(_FOCAL_LENGTH)
            res = ifd.get(_FOCAL_PLANE_X_RES)
            unit = int(ifd.get(_FOCAL_PLANE_RES_UNIT, 2))
            if f_mm and res and float(f_mm) > 0 and float(res) > 0 and unit in _MM_PER_UNIT:
                px_per_mm = float(res) / _MM_PER_UNIT[unit]
                sensor_w = ifd.get(_PIXEL_X_DIMENSION)
                shrink = raw_width / float(sensor_w) if sensor_w and float(sensor_w) > 0 else 1.0
                focal_px = float(f_mm) * px_per_mm * shrink
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if focal_px is None or not (0.2 * diag_px < focal_px < 20.0 * diag_px):
        return None
    return CameraInfo(focal_px=focal_px, source="exif")


def load_image(data: bytes, *, camera: CameraInfo | None = None) -> LoadedImage:
    """Decode JPEG, PNG or WebP bytes in memory and apply EXIF orientation.

    ``camera`` (device intrinsics from the app) wins over EXIF. Raises
    ``ImageDecodeError`` for undecodable or unsupported data.
    """
    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format
        if fmt not in ACCEPTED_FORMATS:
            raise ImageDecodeError(f"unsupported image format: {fmt}")
        img.load()
        raw_w, raw_h = img.size
        exif = img.getexif()
        img = ImageOps.exif_transpose(img)
        rgb = np.asarray(img.convert("RGB"))
    except ImageDecodeError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise ImageDecodeError(f"cannot decode image: {exc}") from exc
    cam = camera if camera is not None else camera_from_exif(exif, raw_w, raw_h)
    return LoadedImage.from_array(rgb, camera=cam)


# ---------------------------------------------------------------- axes and scale


def face_axes(pts: Mapping[str, np.ndarray]) -> FaceAxes | None:
    """Face axes from the medial canthi, or None if either is missing."""
    if not all(name in pts for name in AXIS_POINTS):
        return None
    right, left = (pts[n] for n in AXIS_POINTS)
    if dist(right, left) < 1e-6:
        return None
    return FaceAxes.from_medial_canthi(right, left)


@dataclass(frozen=True)
class ScaleEstimate:
    mm_per_px: float | None
    rel_uncertainty: float | None
    diameters_px: dict[str, float] | None
    reason: str | None = None
    landmarks_used: tuple[str, ...] = SCALE_POINTS

    @property
    def available(self) -> bool:
        return self.mm_per_px is not None


def iris_diameters(pts: Mapping[str, np.ndarray]) -> dict[str, float] | None:
    """Horizontal iris diameter of each eye in pixels, or None if a ring point is missing."""
    out: dict[str, float] = {}
    for side, (a, b) in IRIS_POINTS.items():
        if a not in pts or b not in pts:
            return None
        out[side] = dist(pts[a], pts[b])
    return out


def iris_scale(pts: Mapping[str, np.ndarray], *, iris_diameter_mm: float, rel_uncertainty: float,
               max_diff_frac: float) -> ScaleEstimate:
    """mm/px = iris diameter (mm) ÷ mean horizontal iris diameter (px) of both eyes.

    Rejected (``mm_per_px`` None) when the two eyes differ by more than
    ``max_diff_frac`` of their mean.
    """
    d = iris_diameters(pts)
    if d is None:
        return ScaleEstimate(None, None, None, "iris_points_unavailable")
    mean_d = (d["right"] + d["left"]) / 2.0
    if min(d.values()) <= 1e-6:
        return ScaleEstimate(None, None, d, "iris_degenerate")
    if abs(d["right"] - d["left"]) / mean_d > max_diff_frac:
        return ScaleEstimate(None, None, d, "iris_size_mismatch")
    return ScaleEstimate(iris_diameter_mm / mean_d, rel_uncertainty, d)


def camera_distance_m(focal_px: float, iris_px: float, iris_diameter_mm: float) -> float:
    """Pinhole distance estimate: focal_px × iris_mm ÷ iris_px, in metres."""
    return focal_px * iris_diameter_mm / iris_px / 1000.0


PROFILE_SCALE_POINTS: tuple[str, ...] = ("subnasale", "menton", "nasion")


def frontal_transfer_inputs(frontal) -> tuple[dict[str, float] | None, str | None]:
    """Distances measured on the frontal scan (mm, with SD) that calibrate a profile.

    subnasale→menton and nasion→menton along the frontal face-vertical axis, converted with
    the iris scale; the SD combines the landmark SDs and the iris-scale uncertainty. The
    frontal capture must have passed its gates and have an iris scale.
    """
    if frontal is None:
        return None, "no_frontal_scale"
    if frontal.status != "ok" or frontal.quality is None or not frontal.quality.passed:
        return None, "frontal_not_usable"
    cal = frontal.calibration
    if cal is None or cal.mm_per_px is None:
        return None, "frontal_scale_unavailable"
    L = frontal.landmarks
    names = ("subnasale", "menton", "nasion", "medial_canthus_right", "medial_canthus_left")
    if not all(n in L and L[n].available for n in names):
        return None, "frontal_points_unavailable"
    axes = FaceAxes.from_medial_canthi(L["medial_canthus_right"].xy(), L["medial_canthus_left"].xy())
    rel = cal.rel_uncertainty or 0.0
    out: dict[str, float] = {}
    for key, top in (("sn_me", "subnasale"), ("n_me", "nasion")):
        px = axes.v(L["menton"].xy()) - axes.v(L[top].xy())
        if px <= 0:
            return None, "frontal_points_unavailable"
        mm = px * cal.mm_per_px
        sd_px = math.hypot(L[top].sd_px or 0.0, L["menton"].sd_px or 0.0)
        out[f"frontal_{key}_mm"] = mm
        out[f"frontal_{key}_sd_mm"] = math.hypot(sd_px * cal.mm_per_px, mm * rel)
    return out, None


def transfer_scale(inputs: Mapping[str, float] | None, pts: Mapping[str, np.ndarray],
                   sd_px: Mapping[str, float | None], *, max_disagreement_frac: float,
                   reason: str | None = None) -> ScaleEstimate:
    """Profile mm/px = frontal subnasale→menton (mm) ÷ profile subnasale→menton (px, image vertical).

    Cross-checked with nasion→menton: estimates differing by more than
    ``max_disagreement_frac`` make the transfer unreliable (mm values unavailable). The
    relative uncertainty combines the frontal distance's SD (incl. the iris scale) and the
    profile landmark SDs.
    """
    if inputs is None:
        return ScaleEstimate(None, None, None, reason or "no_frontal_scale", landmarks_used=())
    if not all(n in pts for n in PROFILE_SCALE_POINTS):
        return ScaleEstimate(None, None, None, "profile_points_unavailable", landmarks_used=PROFILE_SCALE_POINTS)
    px1 = float(pts["menton"][1] - pts["subnasale"][1])
    px2 = float(pts["menton"][1] - pts["nasion"][1])
    if px1 <= 0 or px2 <= 0:
        return ScaleEstimate(None, None, None, "degenerate_geometry", landmarks_used=PROFILE_SCALE_POINTS)
    s1 = inputs["frontal_sn_me_mm"] / px1
    s2 = inputs["frontal_n_me_mm"] / px2
    if abs(s1 - s2) / ((s1 + s2) / 2.0) > max_disagreement_frac:
        return ScaleEstimate(None, None, None, "transfer_inconsistent", landmarks_used=PROFILE_SCALE_POINTS)
    sd_prof = math.hypot(sd_px.get("subnasale") or 0.0, sd_px.get("menton") or 0.0)
    rel = math.hypot(inputs["frontal_sn_me_sd_mm"] / inputs["frontal_sn_me_mm"], sd_prof / px1)
    return ScaleEstimate(s1, rel, None, None, landmarks_used=PROFILE_SCALE_POINTS)


def transfer_scale_from_frontal(frontal, profile_points: Mapping[str, np.ndarray],
                                profile_sd: Mapping[str, float | None] | None = None, *,
                                max_disagreement_frac: float = 0.05) -> ScaleEstimate:
    """Profile scale transferred from the same session's frontal result."""
    inputs, reason = frontal_transfer_inputs(frontal)
    return transfer_scale(inputs, profile_points, profile_sd or {}, max_disagreement_frac=max_disagreement_frac,
                          reason=reason)
