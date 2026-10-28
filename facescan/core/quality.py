"""Capture quality gates.

Every check returns an id, the measured value, its limit, a status
(pass / fail / unverified) and a locale hint key. A failed capture has
``quality.passed = false``; a capture with an unverified check (unknown focal
length) passes but can never trigger considerations.
"""

from __future__ import annotations

from typing import Sequence

import cv2
import numpy as np

from facescan.core.config import CaptureSettings
from facescan.core.detector import FaceDetection
from facescan.core.landmark_map import FACE_OVAL_RING, MESH_LANDMARKS
from facescan.core.normalize import camera_distance_m
from facescan.core.schema import CameraInfo, Quality, QualityCheck

_EXPRESSION_HINTS = {
    "jawOpen": "hint.close_mouth",
    "mouthSmileLeft": "hint.relax_smile",
    "mouthSmileRight": "hint.relax_smile",
    "eyeBlinkLeft": "hint.open_eyes",
    "eyeBlinkRight": "hint.open_eyes",
    "browInnerUp": "hint.relax_brows",
}

CHECK_ORDER = (
    "face_count", "face_in_frame", "camera_distance_m", "yaw_deg", "pitch_deg", "roll_deg",
    "expression_jawOpen", "expression_mouthSmileLeft", "expression_mouthSmileRight",
    "expression_eyeBlinkLeft", "expression_eyeBlinkRight", "expression_browInnerUp",
    "ipd_px", "sharpness", "exposure_mean", "exposure_clipped_frac", "burst_good_frames",
)


def _check(id_: str, value: float | None, limit, ok: bool | None, hint: str | None) -> QualityCheck:
    if ok is None:
        return QualityCheck(id=id_, value=value, limit=limit, passed=True, status="unverified", hint_key=hint)
    return QualityCheck(id=id_, value=value, limit=limit, passed=ok, status="pass" if ok else "fail",
                        hint_key=None if ok else hint)


def face_count_check(n_faces: int) -> QualityCheck:
    hint = "hint.no_face" if n_faces == 0 else "hint.multiple_faces"
    return _check("face_count", float(n_faces), 1.0, n_faces == 1, hint)


def face_in_frame_check(det: FaceDetection, width: int, height: int) -> QualityCheck:
    """Whole face inside the photo: fraction of face-oval mesh points inside the image must be 1.

    MediaPipe extrapolates points that fall outside the frame, and the core never measures
    from an extrapolated landmark.
    """
    oval = det.xy[list(FACE_OVAL_RING)]
    inside = (oval[:, 0] >= 0) & (oval[:, 0] < width) & (oval[:, 1] >= 0) & (oval[:, 1] < height)
    frac = float(inside.mean())
    return _check("face_in_frame", frac, 1.0, frac >= 1.0, "hint.face_in_frame")


def most_common(items: Sequence[str]) -> str:
    """Most frequent item; ties broken alphabetically (never by set order, which varies per process)."""
    return min(set(items), key=lambda k: (-items.count(k), k))


def mesh_iris_px(det: FaceDetection) -> float:
    """Mean horizontal iris diameter in pixels, straight from the mesh."""
    xy = det.xy
    r = np.hypot(*(xy[MESH_LANDMARKS["iris_right_lateral"].indices[0]] - xy[MESH_LANDMARKS["iris_right_medial"].indices[0]]))
    l = np.hypot(*(xy[MESH_LANDMARKS["iris_left_lateral"].indices[0]] - xy[MESH_LANDMARKS["iris_left_medial"].indices[0]]))
    return float((r + l) / 2.0)


def distance_check(det: FaceDetection, camera: CameraInfo | None, settings: CaptureSettings) -> QualityCheck:
    g = settings.frontal.gates
    if camera is None:
        return _check("camera_distance_m", None, g.camera_distance_min_m, None, "hint.distance_unverified")
    iris_px = mesh_iris_px(det)
    if iris_px <= 0:
        return _check("camera_distance_m", None, g.camera_distance_min_m, False, "hint.move_back")
    d = camera_distance_m(camera.focal_px, iris_px, settings.scale.iris_diameter_mm)
    return _check("camera_distance_m", d, g.camera_distance_min_m, d >= g.camera_distance_min_m, "hint.move_back")


def pose_checks(det: FaceDetection, settings: CaptureSettings) -> list[QualityCheck]:
    g = settings.frontal.gates
    p = det.pose
    # yaw > 0: face turned toward the subject's left → ask them to turn back to their right.
    yaw_hint = "hint.turn_right" if p.yaw_deg > 0 else "hint.turn_left"
    pitch_hint = "hint.chin_down" if p.pitch_deg > 0 else "hint.chin_up"
    return [
        _check("yaw_deg", p.yaw_deg, g.yaw_max_deg, abs(p.yaw_deg) <= g.yaw_max_deg, yaw_hint),
        _check("pitch_deg", p.pitch_deg, g.pitch_max_deg, abs(p.pitch_deg) <= g.pitch_max_deg, pitch_hint),
        _check("roll_deg", p.roll_deg, g.roll_max_deg, abs(p.roll_deg) <= g.roll_max_deg, "hint.head_level"),
    ]


def expression_checks(det: FaceDetection, settings: CaptureSettings) -> list[QualityCheck]:
    out = []
    for name, limit in settings.frontal.gates.expression.items():
        score = det.blendshapes.get(name)
        hint = _EXPRESSION_HINTS.get(name, "hint.neutral_expression")
        # A missing blendshape cannot be verified as neutral → fail (conservative).
        ok = score is not None and score < limit
        out.append(_check(f"expression_{name}", score, limit, ok, hint))
    return out


def ipd_check(det: FaceDetection, settings: CaptureSettings) -> QualityCheck:
    xy = det.xy
    ipd = float(np.hypot(*(xy[MESH_LANDMARKS["iris_center_right"].indices[0]] - xy[MESH_LANDMARKS["iris_center_left"].indices[0]])))
    g = settings.frontal.gates
    return _check("ipd_px", ipd, g.ipd_min_px, ipd >= g.ipd_min_px, "hint.face_too_small")


def face_roi(rgb: np.ndarray, det: FaceDetection, roi_width: int) -> tuple[np.ndarray, np.ndarray] | None:
    """Face-oval crop resized to ``roi_width`` px wide, and its face mask (uint8)."""
    h, w = rgb.shape[:2]
    oval = det.xy[list(FACE_OVAL_RING)]
    x0, y0 = np.floor(oval.min(axis=0)).astype(int)
    x1, y1 = np.ceil(oval.max(axis=0)).astype(int)
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    crop = rgb[y0:y1, x0:x1]
    s = roi_width / crop.shape[1]
    interp = cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR
    crop = cv2.resize(crop, (roi_width, max(8, int(round(crop.shape[0] * s)))), interpolation=interp)
    poly = np.round((oval - [x0, y0]) * s).astype(np.int32)
    mask = np.zeros(crop.shape[:2], np.uint8)
    cv2.fillPoly(mask, [cv2.convexHull(poly)], 255)
    return crop, mask


def image_checks(rgb: np.ndarray, det: FaceDetection, settings: CaptureSettings) -> list[QualityCheck]:
    g = settings.frontal.gates
    roi = face_roi(rgb, det, g.roi_width_px)
    if roi is None:
        return [
            _check("sharpness", None, g.sharpness_min, False, "hint.hold_still"),
            _check("exposure_mean", None, [g.exposure_mean_min, g.exposure_mean_max], False, "hint.more_light"),
            _check("exposure_clipped_frac", None, g.exposure_clipped_max_frac, False, "hint.avoid_glare"),
        ]
    crop, mask = roi
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    # Sharpness inside the face, away from the face/background edge.
    k = max(3, g.roi_width_px // 20)
    inner = cv2.erode(mask, np.ones((k, k), np.uint8)) > 0
    lap = cv2.Laplacian(gray.astype(np.float64), cv2.CV_64F, ksize=3)
    sharp = float(lap[inner].var()) if inner.any() else 0.0
    face = mask > 0
    luma = gray[face].astype(np.float64)
    mean = float(luma.mean())
    clipped = float(((luma <= g.exposure_clip_low) | (luma >= g.exposure_clip_high)).mean())
    exposure_hint = "hint.more_light" if mean < g.exposure_mean_min else "hint.less_light"
    return [
        _check("sharpness", sharp, g.sharpness_min, sharp >= g.sharpness_min, "hint.hold_still"),
        _check("exposure_mean", mean, [g.exposure_mean_min, g.exposure_mean_max],
               g.exposure_mean_min <= mean <= g.exposure_mean_max, exposure_hint),
        _check("exposure_clipped_frac", clipped, g.exposure_clipped_max_frac,
               clipped < g.exposure_clipped_max_frac, "hint.avoid_glare"),
    ]


def frontal_checks(rgb: np.ndarray, det: FaceDetection, camera: CameraInfo | None,
                   settings: CaptureSettings) -> list[QualityCheck]:
    """Every frontal gate for one frame with exactly one face."""
    h, w = rgb.shape[:2]
    return ([face_count_check(1), face_in_frame_check(det, w, h), distance_check(det, camera, settings)]
            + pose_checks(det, settings) + expression_checks(det, settings)
            + [ipd_check(det, settings)] + image_checks(rgb, det, settings))


def frame_passed(checks: Sequence[QualityCheck]) -> bool:
    return all(c.passed for c in checks)


def aggregate_burst(per_frame: Sequence[Sequence[QualityCheck]], n_good: int, min_frames: int) -> list[QualityCheck]:
    """Combine per-frame checks of a burst.

    Each check reports the median value across frames with one face and passes
    when at least ``min_frames`` frames passed it. ``burst_good_frames`` passes when
    at least ``min_frames`` frames passed every check together.
    """
    by_id: dict[str, list[QualityCheck]] = {}
    for checks in per_frame:
        for c in checks:
            by_id.setdefault(c.id, []).append(c)
    out: list[QualityCheck] = []
    for id_, cs in by_id.items():
        vals = [c.value for c in cs if c.value is not None]
        value = float(np.median(vals)) if vals else None
        n_pass = sum(c.status != "fail" for c in cs)
        if all(c.status == "unverified" for c in cs):
            status = "unverified"
        else:
            status = "pass" if n_pass >= min_frames else "fail"
        hint = None
        if status != "pass":
            hints = [c.hint_key for c in cs if c.hint_key]
            hint = most_common(hints) if hints else None
        out.append(QualityCheck(id=id_, value=value, limit=cs[0].limit, passed=status != "fail",
                                status=status, hint_key=hint, frames_passed=n_pass))
    ok = n_good >= min_frames
    out.append(QualityCheck(id="burst_good_frames", value=float(n_good), limit=float(min_frames), passed=ok,
                            status="pass" if ok else "fail", hint_key=None if ok else "hint.hold_still",
                            frames_passed=n_good))
    return _ordered(out)


def _ordered(checks: list[QualityCheck]) -> list[QualityCheck]:
    rank = {c: i for i, c in enumerate(CHECK_ORDER)}
    return sorted(checks, key=lambda c: rank.get(c.id, len(rank)))


def summarize(checks: Sequence[QualityCheck]) -> Quality:
    checks = _ordered(list(checks))
    passed = all(c.passed for c in checks)
    unverified = [c for c in checks if c.status == "unverified"]
    warnings = ["distance_unverified"] if any(c.id == "camera_distance_m" for c in unverified) else []
    hints: list[str] = []
    for c in checks:
        if c.status == "fail" and c.hint_key and c.hint_key not in hints:
            hints.append(c.hint_key)
    return Quality(passed=passed, considerations_eligible=passed and not unverified, checks=checks,
                   warnings=warnings, hint_keys=hints)
