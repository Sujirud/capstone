"""Reference guided-capture window (OpenCV) for desktop webcams and kiosks.

The live preview shows guidance only (distance, pose, expression, face size,
sharpness); it never shows measurements. When every gate passes for N
consecutive frames (default 20), the app keeps the sharpest K frames of that
streak (default 15) and sends them to ``analyze_frontal`` as a burst, then
writes the result JSON, the consumer view and a user-style overlay into
``--out-dir``. Raw frames are not saved.

Resolution matters: IPD in px ≈ focal_px × 63 mm ÷ distance, so passing the
distance (≥ 1 m) and face-size (IPD ≥ 150 px) gates together needs a 4K webcam
with a moderate field of view, or a phone used as a webcam. The focal length
comes from ``--hfov-deg`` (configured field of view) or ``--focal-px``
(one-time calibration).

Example::

    python -m facescan.apps.webcam_capture --out-dir out/ --sex female --age 28 --hfov-deg 68
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

from facescan import CameraInfo, EngineConfig, FaceScanEngine, LoadedImage, SubjectInfo
from facescan.core.config import CaptureSettings
from facescan.core.detector import FaceDetector
from facescan.core.locale import Strings
from facescan.core.quality import face_count_check, frontal_checks
from facescan.render.overlay import _load_font

TYPICAL_IPD_MM = 63.0


class OneEuroFilter:
    """One-Euro filter (Casiez et al., CHI 2012) for smoothing displayed values only."""

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.05, d_cutoff: float = 1.0) -> None:
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self._x: float | None = None
        self._dx = 0.0
        self._t: float | None = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, x: float, t: float) -> float:
        if self._x is None or self._t is None or t <= self._t:
            self._x, self._t = x, t
            return x
        dt = t - self._t
        dx = (x - self._x) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        self._dx = a_d * dx + (1 - a_d) * self._dx
        cutoff = self.min_cutoff + self.beta * abs(self._dx)
        a = self._alpha(cutoff, dt)
        self._x = a * x + (1 - a) * self._x
        self._t = t
        return self._x


@dataclass
class GuidedCapture:
    """Consecutive-pass counter that keeps the best frames of the current streak."""

    needed: int = 20
    keep: int = 15
    streak: int = 0
    kept: list[tuple[float, int, np.ndarray]] = field(default_factory=list)
    _counter: int = 0

    def update(self, passed: bool, frame: np.ndarray | None, score: float) -> bool:
        """Feed one frame; returns True when the streak is long enough to capture."""
        if not passed:
            self.streak = 0
            self.kept.clear()
            return False
        self.streak += 1
        self._counter += 1
        self.kept.append((score, self._counter, frame))
        self.kept.sort(key=lambda k: (-k[0], k[1]))
        del self.kept[self.keep:]
        return self.streak >= self.needed

    def take(self) -> list[np.ndarray]:
        """Kept frames in capture order; resets the streak."""
        frames = [f for _, _, f in sorted(self.kept, key=lambda k: k[1])]
        self.streak = 0
        self.kept.clear()
        return frames


def focal_from_hfov(width_px: int, hfov_deg: float) -> float:
    return (width_px / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)


def _draw_guidance(preview_rgb: np.ndarray, lines: list[tuple[str, tuple[int, int, int]]], font) -> np.ndarray:
    pil = Image.fromarray(preview_rgb)
    draw = ImageDraw.Draw(pil)
    y = 12
    for text, color in lines:
        l, t, r, b = draw.textbbox((0, 0), text, font=font)
        draw.rectangle((8, y - 2, 8 + (r - l) + 12, y + (b - t) + 6), fill=(0, 0, 0))
        draw.text((14 - l, y + 2 - t), text, font=font, fill=color)
        y += (b - t) + 12
    return np.asarray(pil)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="facescan-capture", description=__doc__.split("\n\n")[0])
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--sex", choices=["female", "male", "unspecified"], required=True)
    p.add_argument("--age", type=int, required=True)
    p.add_argument("--norms-profile", default="canon")
    p.add_argument("--camera", type=int, default=0, help="camera index")
    p.add_argument("--source", help="video file instead of a camera (for testing)")
    p.add_argument("--width", type=int, default=3840)
    p.add_argument("--height", type=int, default=2160)
    focal = p.add_mutually_exclusive_group()
    focal.add_argument("--hfov-deg", type=float, help="horizontal field of view of the camera")
    focal.add_argument("--focal-px", type=float, help="focal length in pixels from a one-time calibration")
    p.add_argument("--models-dir", type=Path, default=Path("models"))
    p.add_argument("--locale", choices=["th", "en"], default="th")
    p.add_argument("--no-mirror", action="store_true", help="do not mirror the preview")
    p.add_argument("--preview-width", type=int, default=1280)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = EngineConfig.from_models_dir(args.models_dir)
    cap = cv2.VideoCapture(args.source if args.source else args.camera)
    if not args.source:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    ok, frame = cap.read()
    if not ok:
        print("error: cannot read from the camera / source", file=sys.stderr)
        return 2
    h, w = frame.shape[:2]
    camera = None
    if args.focal_px:
        camera = CameraInfo(focal_px=args.focal_px, source="calibration")
    elif args.hfov_deg:
        camera = CameraInfo(focal_px=focal_from_hfov(w, args.hfov_deg), source="configured_fov")

    with FaceScanEngine(config) as engine, FaceDetector(config.face_landmarker_model, mode="video") as live:
        settings: CaptureSettings = engine.settings.capture
        g = settings.frontal.gates
        S = Strings(engine.settings.locales, args.locale)
        if camera is None:
            print("warning: no focal length (--hfov-deg / --focal-px); the distance gate will be unverified")
        else:
            ipd_at_recommended = camera.focal_px * TYPICAL_IPD_MM / (g.camera_distance_recommended_m * 1000)
            if ipd_at_recommended < g.ipd_min_px:
                print(f"warning: at {g.camera_distance_recommended_m} m this camera gives about "
                      f"{ipd_at_recommended:.0f} px IPD (< {g.ipd_min_px:.0f}); use a 4K camera or a narrower field of view")
        gc = settings.frontal.guided_capture
        guide = GuidedCapture(needed=gc.consecutive_pass_frames, keep=gc.keep_best_frames)
        oe = gc.one_euro
        filters = {k: OneEuroFilter(oe.min_cutoff, oe.beta, oe.d_cutoff) for k in ("dist", "yaw", "pitch", "ipd")}
        font = _load_font(engine._font_path, 22)
        subject = SubjectInfo(sex=args.sex, age=args.age, norms_profile=args.norms_profile)
        t0 = time.monotonic()
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            rgb = np.ascontiguousarray(frame[:, :, ::-1])
            now = time.monotonic()
            faces = live.detect_for_video(rgb, int((now - t0) * 1000))
            if len(faces) == 1:
                checks = frontal_checks(rgb, faces[0], camera, settings)
            else:
                checks = [face_count_check(len(faces))]
            by_id = {c.id: c for c in checks}
            passed = all(c.passed for c in checks)
            sharp = by_id["sharpness"].value if "sharpness" in by_id and by_id["sharpness"].value else 0.0
            ready = guide.update(passed, frame.copy() if passed else None, sharp)

            lines: list[tuple[str, tuple[int, int, int]]] = []
            ok_col, bad_col = (120, 230, 120), (255, 200, 90)
            if "camera_distance_m" in by_id and by_id["camera_distance_m"].value is not None:
                d = filters["dist"](by_id["camera_distance_m"].value, now)
                lines.append((f"{S.get('check.camera_distance_m')}: {d:.2f} m",
                              ok_col if by_id["camera_distance_m"].passed else bad_col))
            for key, cid in (("yaw", "yaw_deg"), ("pitch", "pitch_deg")):
                if cid in by_id:
                    v = filters[key](by_id[cid].value, now)
                    lines.append((f"{S.get('check.' + cid)}: {v:+.1f}°", ok_col if by_id[cid].passed else bad_col))
            if "ipd_px" in by_id:
                v = filters["ipd"](by_id["ipd_px"].value, now)
                lines.append((f"{S.get('check.ipd_px')}: {v:.0f} px", ok_col if by_id["ipd_px"].passed else bad_col))
            hints = [S.get(c.hint_key) for c in checks if c.status == "fail" and c.hint_key]
            if hints:
                lines.append((hints[0], bad_col))
            else:
                lines.append((f"{guide.streak}/{guide.needed}", ok_col))

            preview = rgb if args.no_mirror else np.ascontiguousarray(rgb[:, ::-1])
            scale = args.preview_width / preview.shape[1]
            preview = cv2.resize(preview, (args.preview_width, int(preview.shape[0] * scale)))
            preview = _draw_guidance(np.ascontiguousarray(preview), lines, font)
            cv2.imshow("facescan guided capture", preview[:, :, ::-1])
            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord("q")):
                break
            if ready:
                frames_bgr = guide.take()
                images = [LoadedImage.from_array(f, camera=camera, channel_order="bgr") for f in frames_bgr]
                if len(images) < settings.frontal.burst.min_frames:
                    continue
                result = engine.analyze_frontal(images, subject=subject)
                args.out_dir.mkdir(parents=True, exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                (args.out_dir / f"result_{stamp}.json").write_text(result.model_dump_json(indent=2), encoding="utf-8")
                (args.out_dir / f"user_view_{stamp}.json").write_text(
                    json.dumps(engine.user_view(result, locale=args.locale), ensure_ascii=False, indent=2),
                    encoding="utf-8")
                if result.landmarks:
                    ref = images[result.frames.reference_frame]
                    out = engine.render_overlay(ref, result, style="user", locale=args.locale,
                                                layers={"landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"})
                    Image.fromarray(out).save(args.out_dir / f"overlay_{stamp}.png")
                print(f"captured {len(images)} frames → status {result.status}; saved to {args.out_dir}")
                break
    cap.release()
    cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
