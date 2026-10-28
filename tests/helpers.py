"""Synthetic landmark sets with known answers, and shared test utilities."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from facescan.core.config import CaptureSettings, DEFAULT_CONFIG_DIR, read_yaml
from facescan.core.metrics_frontal import FrontalParams

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(__file__).resolve().parent / "data"
MODELS = ROOT / "models"

MM_PER_PX = 0.2          # synthetic scale: 5 px per mm
IRIS_MM = 11.7
TILT_DEG = 5.0
EYE_W = 30.0
ICD = 32.0


def capture_settings() -> CaptureSettings:
    return CaptureSettings.model_validate(read_yaml(DEFAULT_CONFIG_DIR / "capture.yaml"))


def params() -> FrontalParams:
    c = capture_settings()
    return FrontalParams(c.scale.iris_diameter_mm, c.scale.iris_rel_uncertainty, c.scale.max_iris_diff_frac)


def face_mm() -> dict[str, tuple[float, float]]:
    """Face coordinates in mm: h toward the subject's left, v toward the chin, origin between the medial canthi.

    Built so that the expected metric values are known exactly (see EXPECTED).
    """
    c, s = math.cos(math.radians(TILT_DEG)), math.sin(math.radians(TILT_DEG))
    r_iris = IRIS_MM / 2
    lc_h = ICD / 2 + EYE_W * c
    lc_v = -EYE_W * s
    ab = (15.0, 48.0)
    # Brow apex exactly above the lateral limbus (symmetric neighbours → parabola vertex at the centre).
    h_ll = 31.0 + r_iris
    head_h = 15.0
    tail_h = h_ll + (h_ll - head_h) / 2.0          # head→apex : apex→tail = 2 : 1
    t = (tail_h - ab[0]) / (lc_h - ab[0])           # tail on the line alar base → lateral canthus
    tail_v = ab[1] + t * (lc_v - ab[1])
    pts: dict[str, tuple[float, float]] = {
        "mesh_top": (0, -50), "trichion": (0, -70), "glabella": (0, -10), "nasion": (0, 2),
        "pronasale": (0, 35), "subnasale": (0, 50), "labrale_superius": (0, 64),
        "upper_lip_inner": (0, 70), "lower_lip_inner": (0, 70), "labrale_inferius": (0, 70 + 6 * 1.618),
        "menton": (0, 110),
    }
    for side, sg in (("right", -1.0), ("left", 1.0)):
        pts[f"medial_canthus_{side}"] = (sg * ICD / 2, 0.0)
        pts[f"lateral_canthus_{side}"] = (sg * lc_h, lc_v)
        pts[f"iris_center_{side}"] = (sg * 31.0, 0.0)
        pts[f"iris_{side}_medial"] = (sg * (31.0 - r_iris), 0.0)
        pts[f"iris_{side}_lateral"] = (sg * (31.0 + r_iris), 0.0)
        pts[f"alare_{side}"] = (sg * 16.0, 45.0)
        pts[f"alar_base_{side}"] = (sg * ab[0], ab[1])
        pts[f"bizygomatic_{side}"] = (sg * 70.0, 20.0)
        pts[f"temporal_boundary_{side}"] = (sg * (lc_h + 30.0), lc_v)
        pts[f"brow_head_{side}"] = (sg * head_h, -12.0)
        pts[f"brow_tail_{side}"] = (sg * tail_h, tail_v)
        for i, (h, height) in enumerate([(h_ll + 17.0, 14.0), (h_ll + 6.0, 19.0), (h_ll, 21.0),
                                         (h_ll - 6.0, 19.0), (16.0, 15.0)], start=1):
            pts[f"brow_upper_{side}_{i}"] = (sg * h, -height)
    # Right commissure 2 mm lateral to the medial-limbus vertical; left exactly on it.
    pts["commissure_right"] = (-(31.0 - r_iris) - 2.0, 70.0)
    pts["commissure_left"] = (31.0 - r_iris, 70.0)
    return pts


def to_image(pts_mm: dict[str, tuple[float, float]], *, roll_deg: float = 0.0,
             origin: tuple[float, float] = (800.0, 900.0), mm_per_px: float = MM_PER_PX) -> dict[str, np.ndarray]:
    """Map face coordinates to image pixels with a given head roll (rotation in the image plane)."""
    th = math.radians(roll_deg)
    ex = np.array([math.cos(th), math.sin(th)])
    ey = np.array([-math.sin(th), math.cos(th)])
    o = np.asarray(origin, dtype=float)
    return {n: o + (h * ex + v * ey) / mm_per_px for n, (h, v) in pts_mm.items()}


def expected() -> dict[str, float]:
    c = math.cos(math.radians(TILT_DEG))
    lc_h = ICD / 2 + EYE_W * c
    total_w = 2 * (lc_h + 30.0)
    mouth = 2 * (31.0 - IRIS_MM / 2) + 2.0
    return {
        "F1_upper_third": 1 / 3, "F1_middle_third": 1 / 3, "F1_lower_third": 1 / 3,
        "F1_middle_lower_ratio": 1.0, "F2_lower_face_ratio": 0.5,
        "F3_fifth_outer_right": 30.0 / total_w, "F3_fifth_eye_right": EYE_W * c / total_w,
        "F3_fifth_intercanthal": ICD / total_w,
        "F4_eye_icd_ratio_right": EYE_W / ICD, "F4_eye_icd_ratio_left": EYE_W / ICD, "F4_icd_mm": ICD,
        "F5_canthal_tilt_right": TILT_DEG, "F5_canthal_tilt_left": TILT_DEG,
        "F6_alar_icd_ratio": 1.0,
        "F7_commissure_offset_right_mm": 2.0, "F7_commissure_offset_left_mm": 0.0,
        "F7_commissure_offset_right_pct_icd": 2.0 / ICD * 100, "F7_commissure_offset_left_pct_icd": 0.0,
        "F7_mouth_alar_ratio": mouth / 32.0, "F7_mouth_ipd_ratio": mouth / 62.0,
        "F8_lip_ratio": 1.618,
        "F9_brow_head_offset_right_mm": 0.0, "F9_brow_head_offset_left_pct_icd": 0.0,
        "F9_brow_apex_offset_right_mm": 0.0, "F9_brow_apex_offset_left_mm": 0.0,
        "F9_brow_apex_ratio_right": 2.0, "F9_brow_apex_ratio_left": 2.0,
        "F9_brow_tail_offset_right_mm": 0.0, "F9_brow_tail_offset_left_pct_icd": 0.0,
        "F10_golden_ratio": 180.0 / 140.0,
        "F11_asym_eye_width": 0.0, "F11_asym_canthal_tilt": 0.0,
        "F11_asym_commissure_offset": 2.0 / ICD * 100,
    }


def models_available() -> bool:
    return (MODELS / "face_landmarker.task").is_file() and (MODELS / "selfie_multiclass_256x256.tflite").is_file()


def synthetic_settings():
    from facescan.core.config import Settings, load_locales

    return Settings(capture=capture_settings(), norms=read_yaml(DEFAULT_CONFIG_DIR / "norms.yaml"),
                    locales=load_locales(DEFAULT_CONFIG_DIR), rules=None, config_hash="sha256:test")


def synthetic_result(*, sd_px: float = 0.5, run_sd: float = 0.01, status: str = "ok", camera=True):
    """A complete FrontalResult built from the synthetic face without any model."""
    from facescan import __version__
    from facescan.core.assemble import FrontalAssembler
    from facescan.core.metrics_frontal import FRONTAL_METRIC_IDS
    from facescan.core.quality import summarize
    from facescan.core.schema import (CameraInfo, Frames, FrontalResult, HeadPose, ImageSize, QualityCheck,
                                      SubjectInfo)

    asm = FrontalAssembler(synthetic_settings())
    pts = to_image(face_mm())
    landmarks = asm.landmarks(pts, {}, {n: sd_px for n in pts}, {})
    subject = SubjectInfo(sex="female", age=28)
    metrics, calibration = asm.metrics(landmarks, subject, run_u={m: (run_sd, "tta") for m in FRONTAL_METRIC_IDS},
                                       previous=None)
    ok = status == "ok"
    checks = [QualityCheck(id="ipd_px", value=310.0 if ok else 80.0, limit=150.0, passed=ok,
                           status="pass" if ok else "fail", hint_key=None if ok else "hint.face_too_small")]
    return FrontalResult(
        core_version=__version__, config_hash="sha256:test", status=status, subject=subject,
        camera=CameraInfo(focal_px=2890.0, source="device") if camera else None,
        image=ImageSize(width=1600, height=1800),
        frames=Frames(count=1, used=[0], reference_frame=0, reference_sha256="0" * 64),
        quality=summarize(checks), pose=HeadPose(yaw_deg=0.5, pitch_deg=-1.0, roll_deg=0.2),
        calibration=calibration, landmarks=landmarks, metrics=metrics), asm
