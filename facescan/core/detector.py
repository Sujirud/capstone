"""MediaPipe Tasks wrappers: FaceLandmarker → pixel landmarks, blendshapes, head pose;
ImageSegmenter → hair / face-skin category mask.

Only the Tasks API is used (the legacy ``mp.solutions`` API no longer exists).
Both tasks run on the CPU delegate. Models load from local paths; nothing is
downloaded at runtime.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from facescan.core.landmark_map import NUM_MESH_POINTS
from facescan.core.schema import HeadPose

# Selfie multiclass segmenter categories.
SEG_BACKGROUND, SEG_HAIR, SEG_BODY_SKIN, SEG_FACE_SKIN, SEG_CLOTHES, SEG_OTHERS = range(6)

# FaceLandmarker must report a second face for the "exactly one face" gate to be
# checkable, so it runs with num_faces=2 (ASSUMPTIONS.md item 1).
MAX_FACES = 2


def pose_from_matrix(matrix: np.ndarray) -> HeadPose:
    """Head pose from the facial transformation matrix (canonical face → camera).

    MediaPipe's metric space is right-handed with y up and the camera looking
    down −z. The canonical face looks toward +z, so its forward vector in camera
    space is the third column of the rotation. Verified on real images: a face
    turned toward the image left has forward.x < 0 and its image-right cheek
    closer to the camera.
    """
    R = np.asarray(matrix, dtype=float)[:3, :3]
    R = R / np.linalg.norm(R, axis=0, keepdims=True)  # drop scale
    fwd = R[:, 2]
    xaxis = R[:, 0]
    yaw = math.degrees(math.atan2(fwd[0], fwd[2]))  # >0: toward image right = subject's left
    pitch = math.degrees(math.atan2(fwd[1], math.hypot(fwd[0], fwd[2])))  # >0: chin up
    roll = math.degrees(math.atan2(-xaxis[1], xaxis[0]))  # face x-axis in image coords (y down)
    return HeadPose(yaw_deg=yaw, pitch_deg=pitch, roll_deg=roll)


@dataclass(frozen=True)
class FaceDetection:
    """One detected face in pixel coordinates of the input image.

    ``landmarks`` is (478, 3): x and y in pixels (normalized x × width, y × height),
    and MediaPipe's relative z scaled like x. z is weak-perspective depth and must
    never be used as a metric distance.
    """

    landmarks: np.ndarray
    blendshapes: dict[str, float]
    transform: np.ndarray
    pose: HeadPose

    @property
    def xy(self) -> np.ndarray:
        return self.landmarks[:, :2]


class FaceDetector:
    """FaceLandmarker wrapper. ``mode="image"`` for stills and burst frames (each
    frame measured independently), ``mode="video"`` only for the live preview."""

    def __init__(self, model_path: str | Path, *, mode: Literal["image", "video"] = "image",
                 max_faces: int = MAX_FACES) -> None:
        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(
                f"face landmarker model not found: {model_path} "
                "(run `python -m facescan.tools.download_models`)")
        self.mode = mode
        running_mode = vision.RunningMode.IMAGE if mode == "image" else vision.RunningMode.VIDEO
        options = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(model_path), delegate=BaseOptions.Delegate.CPU),
            running_mode=running_mode,
            num_faces=max_faces,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        self._landmarker = vision.FaceLandmarker.create_from_options(options)
        self._last_ts = -1

    def detect(self, rgb: np.ndarray) -> list[FaceDetection]:
        if self.mode != "image":
            raise RuntimeError("detect() needs mode='image'; use detect_for_video()")
        result = self._landmarker.detect(_mp_image(rgb))
        return _convert(result, rgb.shape[1], rgb.shape[0])

    def detect_for_video(self, rgb: np.ndarray, timestamp_ms: int) -> list[FaceDetection]:
        """Live preview only. Timestamps must increase monotonically."""
        if self.mode != "video":
            raise RuntimeError("detect_for_video() needs mode='video'")
        timestamp_ms = max(int(timestamp_ms), self._last_ts + 1)
        self._last_ts = timestamp_ms
        result = self._landmarker.detect_for_video(_mp_image(rgb), timestamp_ms)
        return _convert(result, rgb.shape[1], rgb.shape[0])

    def close(self) -> None:
        if self._landmarker is not None:
            self._landmarker.close()
            self._landmarker = None

    def __enter__(self) -> "FaceDetector":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class HairSegmenter:
    """Selfie multiclass segmenter (0 background, 1 hair, 2 body skin, 3 face skin,
    4 clothes, 5 others). The model works at 256 × 256; the returned category
    mask is resized by MediaPipe to the input size."""

    def __init__(self, model_path: str | Path) -> None:
        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(
                f"segmentation model not found: {model_path} "
                "(run `python -m facescan.tools.download_models`)")
        options = vision.ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_path=str(model_path), delegate=BaseOptions.Delegate.CPU),
            running_mode=vision.RunningMode.IMAGE,
            output_category_mask=True,
            output_confidence_masks=False,
        )
        self._segmenter = vision.ImageSegmenter.create_from_options(options)
        self.model_resolution = 256

    def segment(self, rgb: np.ndarray) -> np.ndarray:
        """Category mask (H×W uint8) for an RGB image."""
        result = self._segmenter.segment(_mp_image(rgb))
        mask = np.array(result.category_mask.numpy_view(), dtype=np.uint8, copy=True)
        return mask.reshape(mask.shape[0], mask.shape[1])

    def close(self) -> None:
        if self._segmenter is not None:
            self._segmenter.close()
            self._segmenter = None

    def __enter__(self) -> "HairSegmenter":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _mp_image(rgb: np.ndarray) -> mp.Image:
    arr = np.ascontiguousarray(rgb, dtype=np.uint8)
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError("expected an H×W×3 RGB array")
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=arr)


def _convert(result, width: int, height: int) -> list[FaceDetection]:
    faces: list[FaceDetection] = []
    for i, lms in enumerate(result.face_landmarks):
        pts = np.array([[p.x * width, p.y * height, p.z * width] for p in lms], dtype=float)
        if len(pts) != NUM_MESH_POINTS:
            raise RuntimeError(f"expected {NUM_MESH_POINTS} landmarks (model with iris), got {len(pts)}")
        blend = {c.category_name: float(c.score) for c in result.face_blendshapes[i]} if result.face_blendshapes else {}
        mat = np.array(result.facial_transformation_matrixes[i], dtype=float) if result.facial_transformation_matrixes else np.eye(4)
        faces.append(FaceDetection(landmarks=pts, blendshapes=blend, transform=mat, pose=pose_from_matrix(mat)))
    return faces
