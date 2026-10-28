import math

import numpy as np
import pytest

from facescan.core.detector import FaceDetection, pose_from_matrix
from facescan.core.quality import (aggregate_burst, distance_check, expression_checks, face_count_check,
                                   pose_checks, summarize)
from facescan.core.schema import CameraInfo, HeadPose
from helpers import capture_settings

S = capture_settings()


def _det(iris_px=40.0, pose=(0.0, 0.0, 0.0), blend=None):
    lm = np.zeros((478, 3))
    for c, med, lat, x in ((468, 469, 471, 400.0), (473, 476, 474, 800.0)):
        lm[c, :2] = (x, 500)
        lm[med, :2] = (x + (iris_px / 2 if c == 468 else -iris_px / 2), 500)
        lm[lat, :2] = (x - (iris_px / 2 if c == 468 else -iris_px / 2), 500)
    return FaceDetection(landmarks=lm, blendshapes=blend or {}, transform=np.eye(4),
                         pose=HeadPose(yaw_deg=pose[0], pitch_deg=pose[1], roll_deg=pose[2]))


def test_distance_gate_from_iris_and_focal():
    # distance = focal × 11.7 mm ÷ iris px → 2890 × 11.7 / 23.4 = 1445 mm
    c = distance_check(_det(iris_px=23.4), CameraInfo(focal_px=2890, source="device"), S)
    assert c.value == pytest.approx(1.445) and c.status == "pass"
    c = distance_check(_det(iris_px=60.0), CameraInfo(focal_px=2890, source="device"), S)
    assert c.value == pytest.approx(2890 * 11.7 / 60 / 1000) and c.status == "fail" and c.hint_key == "hint.move_back"


def test_unknown_focal_length_is_unverified_and_blocks_considerations():
    c = distance_check(_det(), None, S)
    assert c.status == "unverified" and c.passed and c.value is None
    q = summarize([face_count_check(1), c])
    assert q.passed and not q.considerations_eligible and q.warnings == ["distance_unverified"]


def test_pose_hints_follow_sign_conventions():
    by = {c.id: c for c in pose_checks(_det(pose=(7.0, 8.0, 12.0)), S)}
    assert by["yaw_deg"].hint_key == "hint.turn_right"   # turned toward the subject's left
    assert by["pitch_deg"].hint_key == "hint.chin_down"  # chin up
    assert by["roll_deg"].hint_key == "hint.head_level"
    by = {c.id: c for c in pose_checks(_det(pose=(-7.0, -8.0, 2.0)), S)}
    assert by["yaw_deg"].hint_key == "hint.turn_left" and by["pitch_deg"].hint_key == "hint.chin_up"
    assert by["roll_deg"].passed


def test_expression_gate_and_missing_blendshape_fails():
    checks = {c.id: c for c in expression_checks(_det(blend={"jawOpen": 0.05, "mouthSmileLeft": 0.5}), S)}
    assert checks["expression_jawOpen"].passed
    assert checks["expression_mouthSmileLeft"].hint_key == "hint.relax_smile" and not checks["expression_mouthSmileLeft"].passed
    assert not checks["expression_browInnerUp"].passed  # missing → fail (conservative)


def test_pose_from_matrix_conventions():
    th = math.radians(10)
    # forward vector (third column) turned toward camera +x (image right) → yaw > 0
    Ry = np.array([[math.cos(th), 0, math.sin(th)], [0, 1, 0], [-math.sin(th), 0, math.cos(th)]])
    M = np.eye(4); M[:3, :3] = 2.0 * Ry  # scale must not matter
    p = pose_from_matrix(M)
    assert p.yaw_deg == pytest.approx(10) and p.pitch_deg == pytest.approx(0, abs=1e-9)
    Rx = np.array([[1, 0, 0], [0, math.cos(th), math.sin(th)], [0, -math.sin(th), math.cos(th)]])
    M[:3, :3] = Rx  # forward tilted toward camera +y (up) → chin up
    assert pose_from_matrix(M).pitch_deg == pytest.approx(10)
    Rz = np.array([[math.cos(th), -math.sin(th), 0], [math.sin(th), math.cos(th), 0], [0, 0, 1]])
    M[:3, :3] = Rz  # counter-clockwise on screen → negative roll (roll > 0 is clockwise)
    assert pose_from_matrix(M).roll_deg == pytest.approx(-10)


def test_burst_aggregation():
    good = [face_count_check(1), distance_check(_det(iris_px=23.4), CameraInfo(focal_px=2890, source="device"), S)]
    bad = [face_count_check(1), distance_check(_det(iris_px=60.0), CameraInfo(focal_px=2890, source="device"), S)]
    checks = aggregate_burst([good, good, bad], n_good=2, min_frames=3)
    by = {c.id: c for c in checks}
    assert by["burst_good_frames"].status == "fail" and by["burst_good_frames"].hint_key == "hint.hold_still"
    assert by["camera_distance_m"].frames_passed == 2 and by["camera_distance_m"].status == "fail"
    assert not summarize(checks).passed
    checks = aggregate_burst([good, good, good, bad], n_good=3, min_frames=3)
    assert summarize(checks).passed
