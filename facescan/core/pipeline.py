"""Public API: ``FaceScanEngine`` plus ``load_image`` and ``user_view``.

Flow of ``analyze_frontal``:

1. Detect each frame (IMAGE mode; frames are measured independently) and run the
   quality gates. More than one face in any frame → ``multiple_faces``; no face in
   any frame → ``no_face``.
2. Named points per frame (mesh, hair-segmentation trichion, temporal boundaries).
3. One photo: landmark and metric uncertainty from seeded test-time augmentation.
   Burst: frames aligned to the reference frame (similarity transform), per-point
   median, across-frame SD; below ``tta_below_frames`` frames the larger of the
   burst SD and a TTA estimate on the reference frame.
4. Overrides replace named points (auto positions kept), then metrics are
   computed from the named points only. Metrics that depend on an adjusted point
   get ``landmark_sampling`` uncertainty. ``apply_overrides`` runs this same step
   on a stored result, so its values equal a full re-analysis.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

import numpy as np

from facescan._version import __version__
from facescan.core.assemble import FrontalAssembler, ProfileAssembler, ProfileContext, metric_values
from facescan.core.config import EngineConfig, Settings, load_settings
from facescan.core.detector import FaceDetection, FaceDetector, HairSegmenter
from facescan.core.errors import ImageMismatchError, InvalidInputError
from facescan.core.frontal_points import ExtractedPoints, extract_frontal_points
from facescan.core.geometry import apply_affine, invert_affine, similarity_transform
from facescan.core.landmark_map import FRONTAL_POINT_NAMES
from facescan.core.locale import Strings
from facescan.core.locale import user_view as _user_view
from facescan.core.metrics_frontal import FRONTAL_METRIC_IDS, compute_frontal
from facescan.core.metrics_profile import PROFILE_METRIC_IDS
from facescan.core.normalize import LoadedImage, ScaleEstimate, frontal_transfer_inputs, load_image
from facescan.core.overrides import coerce_overrides
from facescan.core.profile_contour import ProfileExtraction, extract_profile
from facescan.core.quality import (aggregate_burst, face_count_check, frame_passed, frontal_checks, most_common,
                                   summarize)
from facescan.core.recommend import ReportBuilder, load_rules, validate_rules
from facescan.core.schema import (
    SCHEMA_VERSION, CameraInfo, Frames, FrontalResult, HeadPose, ImageSize, Override, Point2D, ProfileResult, Quality,
    QualityCheck, Report, SubjectInfo,
)
from facescan.core.uncertainty import landmark_sd, metric_sd, tta_transforms, warp

__all__ = ["FaceScanEngine", "load_image", "user_view", "LoadedImage"]


@dataclass
class _ProfileRun:
    points: dict[str, np.ndarray]
    contour: np.ndarray


@dataclass
class _FrameObs:
    n_faces: int
    det: FaceDetection | None = None
    checks: list | None = None
    ext: ExtractedPoints | None = None


def resolve_font(explicit: Path | None, candidates: Sequence[str]) -> Path | None:
    if explicit is not None:
        return Path(explicit)
    for c in candidates:
        if Path(c).is_file():
            return Path(c)
    return None


class FaceScanEngine:
    """Loads models, config files and rules once; keeps no per-request state.

    Not thread-safe (MediaPipe task objects are not): servers create one engine
    per worker process. Supports ``with`` for cleanup.
    """

    def __init__(self, config: EngineConfig | None = None) -> None:
        self.config = config if config is not None else EngineConfig.from_models_dir()
        self._rules = None
        rules_raw = None
        if self.config.rules_path is not None:
            self._rules = load_rules(self.config.rules_path)
            rules_raw = self._rules.model_dump(mode="json")
        self.settings: Settings = load_settings(self.config, rules=rules_raw)
        if self._rules is not None:
            validate_rules(self._rules, self.settings.locales)   # fail closed at start-up
        self._reports = ReportBuilder(self.settings, self._rules)
        self._assembler = FrontalAssembler(self.settings)
        self._profile_assembler = ProfileAssembler(self.settings)
        self.norms = self._assembler.norms
        self._params = self._assembler.params
        c = self.settings.capture
        self._font_path = resolve_font(self.config.font_path, c.render.font_candidates)
        self._detector = FaceDetector(self.config.face_landmarker_model, mode="image")
        try:
            self._segmenter = HairSegmenter(self.config.segmenter_model)
        except Exception:
            self._detector.close()
            raise

    # ------------------------------------------------------------------ lifecycle

    @property
    def config_hash(self) -> str:
        return self.settings.config_hash

    @property
    def core_version(self) -> str:
        return __version__

    @property
    def rules_info(self) -> dict[str, Any] | None:
        """The loaded rules file (``rules_version``, ``rules_hash``, ``example``), or None without rules.

        ``example`` is true for files marked ``example_not_clinically_validated``, which
        clients label as illustrative.
        """
        if self._rules is None:
            return None
        return {"rules_version": self._rules.rules_version, "rules_hash": self.settings.rules_hash,
                "example": bool(self._rules.example_not_clinically_validated)}

    def close(self) -> None:
        self._detector.close()
        self._segmenter.close()

    def __enter__(self) -> "FaceScanEngine":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ frontal

    def analyze_frontal(self, images: LoadedImage | Sequence[LoadedImage], *, subject: SubjectInfo | Mapping,
                        overrides: Mapping[str, Override] | None = None) -> FrontalResult:
        """Analyze one frontal photo (TTA uncertainty) or a burst of 3–15 frames of identical size."""
        frames = self._check_frames(images)
        subject = subject if isinstance(subject, SubjectInfo) else SubjectInfo.model_validate(subject)
        if subject.norms_profile not in self.norms.profile_names:
            raise InvalidInputError(f"unknown norms profile {subject.norms_profile!r}")
        c = self.settings.capture
        image = ImageSize(width=frames[0].width, height=frames[0].height)
        ovs = coerce_overrides(overrides)
        self._assembler.validate(ovs, image)

        obs = [self._observe(f) for f in frames]
        base = dict(core_version=__version__, config_hash=self.config_hash, subject=subject, image=image)

        max_faces = max(o.n_faces for o in obs)
        face_obs = [(i, o) for i, o in enumerate(obs) if o.n_faces == 1]
        if max_faces > 1 or not face_obs:
            status = "multiple_faces" if max_faces > 1 else "no_face"
            return FrontalResult(
                status=status, camera=frames[0].camera,
                frames=Frames(count=len(frames), used=[], reference_frame=0, reference_sha256=frames[0].sha256),
                quality=summarize([face_count_check(max_faces)]), **base)

        min_n = c.reference.min_uncertainty_samples
        if len(frames) == 1:
            ref_i, o = face_obs[0]
            quality = summarize(o.checks)
            used = [ref_i]
            points, reasons, extra_sd = dict(o.ext.points), dict(o.ext.reasons), dict(o.ext.extra_sd)
            tta = self._tta(frames[ref_i], o.det)
            lm_sd = landmark_sd([t.points for t in tta], min_n)
            run_u = {k: (u, "tta") for k, u in metric_sd(
                [metric_values(compute_frontal(t.points, self._params)[0]) for t in tta], FRONTAL_METRIC_IDS, min_n).items()}
            pose = o.det.pose
        else:
            good = [(i, o) for i, o in face_obs if frame_passed(o.checks)]
            quality = summarize(aggregate_burst([o.checks for _, o in face_obs], len(good), c.frontal.burst.min_frames))
            use = good if len(good) >= c.frontal.burst.min_frames else face_obs
            used = [i for i, _ in use]
            ref_i, points, reasons, extra_sd, lm_sd, run_u, pose = self._aggregate_burst(frames, use)

        landmarks = self._assembler.landmarks(points, reasons, lm_sd, extra_sd)
        if ovs:
            landmarks = self._assembler.with_overrides(landmarks, ovs)
        metrics, calibration = self._assembler.metrics(landmarks, subject, run_u=run_u, previous=None,
                                                       quant_sd=extra_sd)
        return FrontalResult(
            status="ok" if quality.passed else "quality_failed",
            camera=frames[ref_i].camera,
            frames=Frames(count=len(frames), used=used, reference_frame=ref_i, reference_sha256=frames[ref_i].sha256),
            quality=quality, pose=pose, calibration=calibration, landmarks=landmarks, metrics=metrics, **base)

    def apply_overrides(self, result: FrontalResult | ProfileResult,
                        overrides: Mapping[str, Override]) -> FrontalResult | ProfileResult:
        """Recompute a result after point adjustments, without the image.

        Only metrics that use an adjusted point are recomputed (landmark-sampling
        uncertainty); if an adjusted point feeds the calibration, the calibration
        and every mm metric are recomputed too (they list the iris points).
        """
        if not result.landmarks:
            raise InvalidInputError(f"result with status {result.status!r} has no landmarks to adjust")
        if isinstance(result, ProfileResult):
            return self._profile_assembler.apply_overrides(result, overrides)
        return self._assembler.apply_overrides(result, overrides)

    # ------------------------------------------------------------------ profile and report

    def analyze_profile(self, image: LoadedImage, *, subject: SubjectInfo | Mapping, facing: Literal["left", "right"],
                        frontal: FrontalResult | None = None,
                        overrides: Mapping[str, Override] | None = None) -> ProfileResult:
        """Analyze a true 90° profile photo.

        Landmarks come from the silhouette. ``facing`` is the direction the nose points in
        the image. ``frontal`` (the same session's frontal result, status ``ok``) calibrates
        mm via subnasale→menton; without it mm metrics are unavailable and the warning
        ``no_frontal_scale`` is set.
        """
        if not isinstance(image, LoadedImage):
            raise InvalidInputError("image must be a LoadedImage (use load_image / LoadedImage.from_array)")
        if facing not in ("left", "right"):
            raise InvalidInputError(f"facing must be 'left' or 'right', got {facing!r}")
        subject = subject if isinstance(subject, SubjectInfo) else SubjectInfo.model_validate(subject)
        if subject.norms_profile not in self.norms.profile_names:
            raise InvalidInputError(f"unknown norms profile {subject.norms_profile!r}")
        if frontal is not None:
            if not isinstance(frontal, FrontalResult):
                raise InvalidInputError("frontal must be a FrontalResult")
            if frontal.subject != subject:
                raise InvalidInputError("subject_mismatch: the frontal result belongs to a different subject")
        asm = self._profile_assembler
        c = self.settings.capture
        size = ImageSize(width=image.width, height=image.height)
        ovs = coerce_overrides(overrides)
        asm.validate(ovs, size)

        ext = extract_profile(image.pixels, facing, self._segmenter, c)
        inputs, in_reason = frontal_transfer_inputs(frontal)
        base = dict(core_version=__version__, config_hash=self.config_hash, subject=subject, image=size,
                    camera=image.camera, facing=facing)
        frames = Frames(count=1, used=[0], reference_frame=0, reference_sha256=image.sha256)
        if ext.n_faces != 1:
            return ProfileResult(status="multiple_faces" if ext.n_faces > 1 else "no_face",
                                 frames=Frames(count=1, used=[], reference_frame=0, reference_sha256=image.sha256),
                                 quality=summarize(ext.checks), **base)
        ctx = ProfileContext(ext.contour, facing, inputs, in_reason)
        if ext.contour is None:
            return ProfileResult(status="contour_failed", frames=frames,
                                 quality=self._profile_quality(ext.checks, None, image.camera, frontal is None),
                                 **base)

        min_n = c.reference.min_uncertainty_samples
        run_u: dict[str, tuple[float | None, str]] = {}
        lm_sd: dict[str, float] = {}
        if ext.contour_ok:  # uncertainty only for usable contours
            runs = self._profile_tta(image, facing, ext)
            lm_sd = landmark_sd([r.points for r in runs], min_n)
            vals = [metric_values(asm.compute(r.points, ProfileContext(r.contour, facing, inputs, in_reason), {})[0])
                    for r in runs]
            run_u = {k: (u, "tta") for k, u in metric_sd(vals, PROFILE_METRIC_IDS, min_n).items()}
        landmarks = asm.landmarks(ext.points, ext.reasons, lm_sd, ext.extra_sd)
        # Gates describe the capture: the distance check uses the automatic points only.
        auto_scale = asm.scale({n: lm.xy() for n, lm in landmarks.items() if lm.available}, ctx,
                               {n: lm.sd_px for n, lm in landmarks.items() if lm.available})
        quality = self._profile_quality(ext.checks, auto_scale, image.camera, frontal is None)
        if ovs:
            landmarks = asm.with_overrides(landmarks, ovs, ctx)
        metrics, calibration = asm.metrics(landmarks, subject, ctx=ctx, run_u=run_u, previous=None,
                                           quant_sd=ext.extra_sd)
        status = "contour_failed" if not ext.contour_ok else ("ok" if quality.passed else "quality_failed")
        return ProfileResult(status=status, frames=frames, quality=quality, calibration=calibration,
                             landmarks=landmarks, metrics=metrics,
                             contour=[Point2D(x=float(x), y=float(y)) for x, y in ext.contour], **base)

    def _profile_quality(self, checks: list[QualityCheck], scale: ScaleEstimate | None, camera: CameraInfo | None,
                         no_frontal: bool) -> Quality:
        """Profile gates plus the camera distance (profile mm/px × focal length, else unverified)."""
        g = self.settings.capture.frontal.gates
        if camera is None or scale is None or not scale.available:
            dist = QualityCheck(id="camera_distance_m", value=None, limit=g.camera_distance_min_m, passed=True,
                                status="unverified", hint_key="hint.distance_unverified")
        else:
            d = scale.mm_per_px * camera.focal_px / 1000.0
            ok = d >= g.camera_distance_min_m
            dist = QualityCheck(id="camera_distance_m", value=d, limit=g.camera_distance_min_m, passed=ok,
                                status="pass" if ok else "fail", hint_key=None if ok else "hint.move_back")
        q = summarize(list(checks) + [dist])
        if no_frontal:
            q = Quality(**{**dict(q), "warnings": q.warnings + ["no_frontal_scale"]})
        return q

    def _profile_tta(self, image: LoadedImage, facing: str, ext: ProfileExtraction) -> list[_ProfileRun]:
        """Profile landmarks and contour from augmented copies, mapped back to the original image."""
        c = self.settings.capture
        x0, y0, x1, y1 = ext.head_box
        corners = np.array([[x0, y0], [x1, y0], [x0, y1], [x1, y1]], dtype=float)
        runs: list[_ProfileRun] = []
        for A in tta_transforms(image.sha256, ext.head_box, c.frontal.tta):
            q = apply_affine(A, corners)
            box = (float(q[:, 0].min()), float(q[:, 1].min()), float(q[:, 0].max()), float(q[:, 1].max()))
            e = extract_profile(warp(image.pixels, A), facing, self._segmenter, c, head_box=box)
            if e.contour is None or not e.contour_ok:
                continue
            Ai = invert_affine(A)
            runs.append(_ProfileRun({k: apply_affine(Ai, v) for k, v in e.points.items()}, apply_affine(Ai, e.contour)))
        return runs if len(runs) >= c.frontal.tta.min_successful_runs else []

    def build_report(self, frontal: FrontalResult | None, profile: ProfileResult | None) -> Report:
        """Combine the session's results and evaluate the clinical rules into considerations.

        Only conclusive, high-confidence metrics from captures that passed every gate can
        trigger a rule. Results must come from this engine's code and measurement
        configuration (``stale_result`` otherwise).
        """
        return self._reports.build(frontal, profile, core_version=__version__)

    # ------------------------------------------------------------------ outputs

    def render_overlay(self, image: LoadedImage, result: FrontalResult | ProfileResult, *, layers: set[str],
                       style: Literal["user", "clinical"] = "user", locale: str = "th") -> np.ndarray:
        """Annotated RGB image. Raises ``ImageMismatchError`` if ``image`` is not the result's reference frame."""
        from facescan.render.overlay import render_overlay

        if result.frames is None or image.sha256 != result.frames.reference_sha256:
            raise ImageMismatchError("image does not match the result's reference_sha256")
        return render_overlay(image.pixels, result, layers=set(layers), style=style,
                              strings=Strings(self.settings.locales, locale), font_path=self._font_path,
                              columella_fit=self.settings.capture.profile.contour.columella_fit)

    def user_view(self, obj: FrontalResult | ProfileResult | Report, *, locale: str = "th") -> dict[str, Any]:
        return _user_view(obj, locale=locale, locales=self.settings.locales,
                          user_adjustable_points=self.settings.capture.overrides.user_adjustable_points)

    def client_config(self, locale: str = "th") -> dict[str, Any]:
        """Gate thresholds, burst limits, adjustable points and localized strings for on-device guidance."""
        c = self.settings.capture
        S = Strings(self.settings.locales, locale)
        return {
            "core_version": __version__,
            "schema_version": SCHEMA_VERSION,
            "config_hash": self.config_hash,
            "locale": locale,
            "profile": {"gates": {**c.profile.gates.model_dump(),
                                  "camera_distance_min_m": c.frontal.gates.camera_distance_min_m}},
            "frontal": {
                "gates": c.frontal.gates.model_dump(),
                "burst": c.frontal.burst.model_dump(),
                "guided_capture": c.frontal.guided_capture.model_dump(),
                "iris_diameter_mm": c.scale.iris_diameter_mm,
            },
            "user_adjustable_points": c.overrides.user_adjustable_points,
            "strings": {key: S.section(key) for key in (
                "hint", "check", "warning", "disclaimer", "capture", "point", "status", "reference", "side_note")},
        }

    # ------------------------------------------------------------------ internals

    def _check_frames(self, images: LoadedImage | Sequence[LoadedImage]) -> list[LoadedImage]:
        frames = [images] if isinstance(images, LoadedImage) else list(images)
        b = self.settings.capture.frontal.burst
        if not frames:
            raise InvalidInputError("no images")
        if len(frames) != 1 and not (b.min_frames <= len(frames) <= b.max_frames):
            raise InvalidInputError(f"a burst needs {b.min_frames}–{b.max_frames} frames, got {len(frames)}")
        if not all(isinstance(f, LoadedImage) for f in frames):
            raise InvalidInputError("images must be LoadedImage instances (use load_image / LoadedImage.from_array)")
        if len({(f.width, f.height) for f in frames}) != 1:
            raise InvalidInputError("frame_size_mismatch: burst frames must have identical dimensions")
        return frames

    def _observe(self, frame: LoadedImage) -> _FrameObs:
        faces = self._detector.detect(frame.pixels)
        if len(faces) != 1:
            return _FrameObs(n_faces=len(faces))
        det = faces[0]
        checks = frontal_checks(frame.pixels, det, frame.camera, self.settings.capture)
        ext = extract_frontal_points(det, frame.pixels, self._segmenter, self.settings.capture)
        return _FrameObs(n_faces=1, det=det, checks=checks, ext=ext)

    def _tta(self, frame: LoadedImage, det: FaceDetection) -> list[ExtractedPoints]:
        """Named points from each augmented copy, mapped back to the original frame."""
        xy = det.xy
        box = (*xy.min(axis=0), *xy.max(axis=0))
        out = []
        for A in tta_transforms(frame.sha256, box, self.settings.capture.frontal.tta):
            warped = warp(frame.pixels, A)
            faces = self._detector.detect(warped)
            if len(faces) != 1:
                continue
            ext = extract_frontal_points(faces[0], warped, self._segmenter, self.settings.capture)
            out.append(ext.mapped(invert_affine(A)))
        if len(out) < self.settings.capture.frontal.tta.min_successful_runs:
            return []
        return out

    def _aggregate_burst(self, frames: list[LoadedImage], use: list[tuple[int, _FrameObs]]):
        c = self.settings.capture
        min_n = c.reference.min_uncertainty_samples
        stack = np.array([o.det.xy for _, o in use])  # full mesh: always present, unlike named points
        med = np.median(stack, axis=0)
        k = int(np.argmin(((stack - med) ** 2).sum(axis=(1, 2))))
        ref_i, ref_o = use[k]
        aligned = [o.ext.mapped(similarity_transform(o.det.xy, ref_o.det.xy)) for _, o in use]

        need = max(1, math.ceil(c.frontal.burst.min_point_frame_frac * len(use)))
        points: dict[str, np.ndarray] = {}
        reasons: dict[str, str] = {}
        for name in FRONTAL_POINT_NAMES:
            vals = [a.points[name] for a in aligned if name in a.points]
            if len(vals) >= need:
                points[name] = np.median(np.array(vals), axis=0)
            else:
                why = [a.reasons[name] for a in aligned if name in a.reasons]
                reasons[name] = most_common(why) if why else "unavailable_in_most_frames"
        extra_sd = {n: max(a.extra_sd[n] for a in aligned if n in a.extra_sd)
                    for n in sorted({n for a in aligned for n in a.extra_sd}) if n in points}
        lm_sd = landmark_sd([a.points for a in aligned], min_n)
        run_u = {k2: (u, "burst_sd") for k2, u in metric_sd(
            [metric_values(compute_frontal(o.ext.points, self._params)[0]) for _, o in use], FRONTAL_METRIC_IDS, min_n).items()}

        if len(use) < c.frontal.burst.tta_below_frames:
            tta = self._tta(frames[ref_i], ref_o.det)
            tta_u = metric_sd([metric_values(compute_frontal(t.points, self._params)[0]) for t in tta], FRONTAL_METRIC_IDS, min_n)
            for mid, u_t in tta_u.items():
                u_b = run_u[mid][0]
                if u_t is not None and (u_b is None or u_t > u_b):
                    run_u[mid] = (u_t, "tta")
            for name, s in landmark_sd([t.points for t in tta], min_n).items():
                lm_sd[name] = max(s, lm_sd.get(name, 0.0))

        poses = np.array([[o.det.pose.yaw_deg, o.det.pose.pitch_deg, o.det.pose.roll_deg] for _, o in use])
        yaw, pitch, roll = np.median(poses, axis=0)
        pose = HeadPose(yaw_deg=float(yaw), pitch_deg=float(pitch), roll_deg=float(roll))
        return ref_i, points, reasons, extra_sd, lm_sd, run_u, pose


def user_view(obj: FrontalResult | ProfileResult | Report, *, locale: str = "th",
              config_dir: str | Path | None = None) -> dict[str, Any]:
    """JSON view for the consumer app: clinic-only metrics removed, text keys resolved."""
    return _user_view(obj, locale=locale, config_dir=config_dir)
