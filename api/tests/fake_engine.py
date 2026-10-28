"""A deterministic stand-in for ``FaceScanEngine`` (same signatures, real result models).

Behaviour is chosen by the colour of the first frame's top-left pixel:

* black → ``no_face`` (this is also the workers' warm-up image)
* blue → ``quality_failed`` (frontal: pitch check fails) / ``contour_failed`` (profile)
* red → the worker process dies (crash recovery)
* green → sleeps for a minute (hard timeouts)
* magenta → raises an unexpected exception (500)
* anything else → ``ok``

Results carry a user metric (F1_upper_third) and a clinic-only metric (F10_golden_ratio) whose value is a
sentinel, so tests can prove responses carry only the user view. Profile results have a contour, the ten profile points and a scale transferred from
the frontal result when one is given; profile adjustments snap silhouette points to
the stored contour, as the core does. ``user_view`` is the core's real implementation.
"""

from __future__ import annotations

import math
import os
import time
from typing import Any, Mapping, Sequence

import numpy as np

from facescan import (
    SCHEMA_VERSION, FrontalResult, ImageMismatchError, InvalidInputError, LoadedImage, Override,
    PointNotAdjustableError, ProfileResult, SubjectInfo, UnknownPointError,
)
from facescan.core.errors import OverrideOutOfBoundsError
from facescan.core.landmark_map import PROFILE_POINT_NAMES, PROFILE_SILHOUETTE_POINTS
from facescan.core.locale import user_view as core_user_view
from facescan.core.schema import (
    AutoPosition, CanonRef, Calibration, Consideration, Frames, ImageSize, Landmark, Metric, Point2D, Quality, QualityCheck,
    Report, RuleOutcome,
)

BLACK, BLUE, RED, GREEN, MAGENTA = (0, 0, 0), (0, 0, 255), (255, 0, 0), (0, 255, 0), (255, 0, 255)
ADJUSTABLE = {"frontal": ["trichion"], "profile": list(PROFILE_POINT_NAMES)}   # as in the core's capture.yaml
# Contour index of each silhouette point (60-point contour, top to bottom).
PROFILE_INDEX = {"trichion": 2, "glabella": 12, "nasion": 18, "pronasale": 27, "subnasale": 31,
                 "labrale_superius": 35, "labrale_inferius": 40, "soft_tissue_pogonion": 48, "menton": 55}
FAKE_MM_PER_PX = 0.2
CLINIC_ONLY_SENTINEL = 1.6180339887
CONFIG_HASH = "sha256:fake-config"


FAKE_RULES = {"rules_version": "FAKE-1", "rules_hash": "sha256:fake-rules", "example": True}


class FakeEngine:
    core_version = "0.1.0"
    config_hash = CONFIG_HASH

    rules_info = FAKE_RULES

    def close(self) -> None:
        pass

    def build_report(self, frontal: FrontalResult | None, profile: ProfileResult | None) -> Report:
        """One fake rule that fires for every session. Like the core, it is triggered only by a metric with
        a reference range, and uses the core's example rules' text keys."""
        results = [r for r in (frontal, profile) if r is not None]
        if not results:
            raise InvalidInputError("a report needs a frontal and / or a profile result")
        for r in results:
            if (r.core_version, r.config_hash) != (self.core_version, self.config_hash):
                raise InvalidInputError("stale_result: analyze again with this engine")
        if frontal is not None and profile is not None and frontal.subject != profile.subject:
            raise InvalidInputError("subject_mismatch: frontal and profile results belong to different subjects")
        if profile is not None:      # nasolabial angle below its range
            trigger, finding, cause = ("P2_nasolabial_angle", "finding.example_nasolabial_below",
                                       "consideration.example_nasal_tip")
        else:                        # alar width above its range
            trigger, finding, cause = ("F6_alar_icd_ratio", "finding.example_alar_width_above",
                                       "consideration.example_alar_base")
        considerations = [Consideration(
            rule_id="FAKE-01", rule_version=1, area="nose", finding_key=finding, consideration_keys=[cause],
            triggering_metrics=[trigger], severity="info")]
        status = next((r.status for r in results if r.status != "ok"), "ok")
        return Report(core_version=self.core_version, config_hash=self.config_hash, status=status, frontal=frontal,
                      profile=profile, considerations=considerations, rules_version=FAKE_RULES["rules_version"],
                      rules_hash=FAKE_RULES["rules_hash"],
                      rule_audit=[RuleOutcome(rule_id="FAKE-01", rule_version=1, outcome="fired")])

    # ----------------------------------------------------------------- analysis

    def analyze_frontal(self, images: LoadedImage | Sequence[LoadedImage], *, subject: SubjectInfo | Mapping,
                        overrides: Mapping[str, Override] | None = None) -> FrontalResult:
        frames = [images] if isinstance(images, LoadedImage) else list(images)
        if not frames or len({(f.width, f.height) for f in frames}) != 1:
            raise InvalidInputError("frame_size_mismatch: burst frames must have identical dimensions")
        subject = subject if isinstance(subject, SubjectInfo) else SubjectInfo.model_validate(subject)
        first = frames[0]
        px = tuple(int(v) for v in first.pixels[0, 0])
        if px == RED:
            os._exit(3)
        if px == GREEN:
            time.sleep(60)
        if px == MAGENTA:
            raise ValueError("an unexpected failure of the fake engine")
        ref = len(frames) // 2
        base: dict[str, Any] = dict(core_version=self.core_version, config_hash=self.config_hash, subject=subject,
                                    image=ImageSize(width=first.width, height=first.height), camera=first.camera)
        if px == BLACK:
            check = QualityCheck(id="face_count", value=0.0, limit=1.0, passed=False, status="fail",
                                 hint_key="hint.no_face")
            return FrontalResult(
                status="no_face",
                frames=Frames(count=len(frames), used=[], reference_frame=0, reference_sha256=first.sha256),
                quality=Quality(passed=False, considerations_eligible=False, checks=[check],
                                hint_keys=["hint.no_face"]), **base)
        failed = px == BLUE
        checks = [QualityCheck(id="pitch_deg", value=14.0 if failed else 2.0, limit=10.0, passed=not failed,
                               status="fail" if failed else "pass", hint_key="hint.chin_down" if failed else None)]
        if first.camera is None:
            checks.append(QualityCheck(id="camera_distance_m", value=None, limit=1.0, passed=True,
                                       status="unverified", hint_key="hint.distance_unverified"))
        quality = Quality(passed=not failed, considerations_eligible=not failed and first.camera is not None,
                          checks=checks, warnings=["distance_unverified"] if first.camera is None else [],
                          hint_keys=["hint.chin_down"] if failed else [])
        w, h = first.width, first.height
        landmarks = {
            "trichion": Landmark(x=w / 2, y=0.10 * h, source="segmentation", confidence="high", sd_px=2.0),
            "nasion": Landmark(x=w / 2, y=0.40 * h, source="auto", confidence="high", sd_px=1.0),
            "subnasale": Landmark(x=w / 2, y=0.62 * h, source="auto", confidence="high", sd_px=1.0),
            "menton": Landmark(x=w / 2, y=0.90 * h, source="auto", confidence="high", sd_px=1.0),
        }
        return FrontalResult(
            status="quality_failed" if failed else "ok",
            frames=Frames(count=len(frames), used=list(range(len(frames))), reference_frame=ref,
                          reference_sha256=frames[ref].sha256),
            quality=quality, landmarks=landmarks, metrics=self._metrics(landmarks), **base)

    @staticmethod
    def _metrics(lm: Mapping[str, Landmark]) -> dict[str, Metric]:
        t, n, m = lm["trichion"], lm["nasion"], lm["menton"]
        upper = (n.y - t.y) / (m.y - t.y)
        return {
            "F1_upper_third": Metric(value=upper, unit="fraction", status="within", confidence="high", uncertainty=0.01,
                         uncertainty_method="tta", landmarks_used=["trichion", "nasion", "menton"]),
            "F6_alar_icd_ratio": Metric(value=1.12, unit="ratio", status="above", status_basis="canon",
                                        canon=CanonRef(type="range", min=0.95, max=1.05), confidence="high",
                                        uncertainty=0.02, uncertainty_method="tta", landmarks_used=["nasion"]),
            "F10_golden_ratio": Metric(value=CLINIC_ONLY_SENTINEL, unit="ratio", status="no_reference", confidence="high",
                          display="clinic_only", landmarks_used=["trichion", "menton"]),
        }

    def analyze_profile(self, image: LoadedImage, *, subject: SubjectInfo | Mapping, facing: str,
                        frontal: FrontalResult | None = None,
                        overrides: Mapping[str, Override] | None = None) -> ProfileResult:
        if facing not in ("left", "right"):
            raise InvalidInputError(f"facing must be 'left' or 'right', got {facing!r}")
        subject = subject if isinstance(subject, SubjectInfo) else SubjectInfo.model_validate(subject)
        if frontal is not None and frontal.subject != subject:
            raise InvalidInputError("subject_mismatch: the frontal result belongs to a different subject")
        px = tuple(int(v) for v in image.pixels[0, 0])
        if px == RED:
            os._exit(3)
        if px == GREEN:
            time.sleep(60)
        if px == MAGENTA:
            raise ValueError("an unexpected failure of the fake engine")
        w, h = image.width, image.height
        base: dict[str, Any] = dict(core_version=self.core_version, config_hash=self.config_hash, subject=subject,
                                    image=ImageSize(width=w, height=h), camera=image.camera, facing=facing)
        if px == BLACK:
            check = QualityCheck(id="face_count", value=0.0, limit=1.0, passed=False, status="fail",
                                 hint_key="hint.no_face")
            return ProfileResult(
                status="no_face", frames=Frames(count=1, used=[], reference_frame=0, reference_sha256=image.sha256),
                quality=Quality(passed=False, considerations_eligible=False, checks=[check], hint_keys=["hint.no_face"]),
                **base)
        ok = px != BLUE
        sgn = -1.0 if facing == "left" else 1.0     # the nose points toward the image side named by facing
        contour = [(w / 2 + sgn * 0.15 * w * math.sin(math.pi * t), h * (0.1 + 0.8 * t))
                   for t in (i / 59 for i in range(60))]
        landmarks = {name: Landmark(x=contour[i][0], y=contour[i][1],
                                    source="segmentation" if name == "trichion" else "contour",
                                    confidence="high", sd_px=1.5) for name, i in PROFILE_INDEX.items()}
        sn = landmarks["subnasale"]
        landmarks["alar_crease"] = Landmark(x=sn.x - sgn * 0.05 * w, y=sn.y - 0.01 * h, source="auto",
                                            confidence="high", sd_px=2.0)
        checks = [QualityCheck(id="contour_continuous", value=1.0 if ok else 0.0, limit=1.0, passed=ok,
                               status="pass" if ok else "fail", hint_key=None if ok else "hint.profile_in_frame")]
        quality = Quality(passed=ok, considerations_eligible=ok and frontal is not None and image.camera is not None,
                          checks=checks, warnings=[] if frontal is not None else ["no_frontal_scale"],
                          hint_keys=[] if ok else ["hint.profile_in_frame"])
        calibration = (Calibration(method="transferred_from_frontal", mm_per_px=FAKE_MM_PER_PX,
                                   inputs={"subnasale_menton_mm": 62.0}) if frontal is not None
                       else Calibration(method="none", reason="no_frontal_scale"))
        return ProfileResult(
            status="ok" if ok else "contour_failed",
            frames=Frames(count=1, used=[0], reference_frame=0, reference_sha256=image.sha256),
            quality=quality, calibration=calibration, landmarks=landmarks,
            metrics=self._profile_metrics(landmarks, calibration),
            contour=[Point2D(x=x, y=y) for x, y in contour], **base)

    @staticmethod
    def _profile_metrics(lm: Mapping[str, Landmark], cal: Calibration) -> dict[str, Metric]:
        g, n, p = (np.array([lm[k].x, lm[k].y]) for k in ("glabella", "nasion", "pronasale"))
        a, b = g - n, p - n
        angle = math.degrees(math.acos(float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))))
        sn, ls = np.array([lm["subnasale"].x, lm["subnasale"].y]), np.array([lm["labrale_superius"].x,
                                                                             lm["labrale_superius"].y])
        mm = None if cal.mm_per_px is None else float(np.linalg.norm(sn - ls)) * cal.mm_per_px
        return {
            "P2_nasolabial_angle": Metric(value=84.0, unit="deg", status="below", status_basis="canon",
                                          canon=CanonRef(type="range", min=90.0, max=105.0), confidence="high",
                                          uncertainty=1.5, uncertainty_method="tta",
                                          landmarks_used=["subnasale", "labrale_superius"]),
            "P1_nasofrontal_angle": Metric(value=angle, unit="deg", status="within", confidence="high",
                                           uncertainty=1.0, uncertainty_method="tta",
                                           landmarks_used=["glabella", "nasion", "pronasale"]),
            "P3b_tip_projection_simons": Metric(value=float(np.linalg.norm(sn - p) / np.linalg.norm(sn - ls)),
                                                unit="ratio", status="no_reference", confidence="high",
                                                role="secondary",
                                                landmarks_used=["subnasale", "pronasale", "labrale_superius"]),
            "P4_eline_upper_lip_mm": Metric(value=mm, unit="mm", status="unavailable" if mm is None else "no_reference",
                                            confidence="high", reason=None if mm is not None else "no_frontal_scale",
                                            landmarks_used=["subnasale", "labrale_superius"]),
        }

    def apply_overrides(self, result: FrontalResult | ProfileResult,
                        overrides: Mapping[str, Override]) -> FrontalResult | ProfileResult:
        if not result.landmarks:
            raise InvalidInputError("no landmarks to adjust")
        assert result.image is not None
        landmarks = dict(result.landmarks)
        contour = np.array([[q.x, q.y] for q in result.contour]) if isinstance(result, ProfileResult) and result.contour else None
        for name, ov in overrides.items():
            if name not in landmarks:
                raise UnknownPointError(f"unknown point {name!r}")
            if ov.source == "user_adjusted" and name not in ADJUSTABLE[result.view]:
                raise PointNotAdjustableError(f"users may not adjust {name!r}")
            if not (0 <= ov.x < result.image.width and 0 <= ov.y < result.image.height):
                raise OverrideOutOfBoundsError(f"{name!r} is outside the image")
            cur = landmarks[name]
            auto = cur.auto or AutoPosition(x=cur.x, y=cur.y, source=cur.source, confidence=cur.confidence,
                                            sd_px=cur.sd_px)
            x, y = ov.x, ov.y
            if contour is not None and name in PROFILE_SILHOUETTE_POINTS:   # re-snap, whatever was sent
                x, y = (float(v) for v in contour[int(np.argmin(((contour - [x, y]) ** 2).sum(axis=1)))])
            landmarks[name] = Landmark(x=x, y=y, source=ov.source, confidence="high", sd_px=3.0, auto=auto)
        if isinstance(result, ProfileResult):
            assert result.calibration is not None
            return ProfileResult(**{**dict(result), "landmarks": landmarks,
                                    "metrics": self._profile_metrics(landmarks, result.calibration)})
        return FrontalResult(**{**dict(result), "landmarks": landmarks, "metrics": self._metrics(landmarks)})

    # ----------------------------------------------------------------- outputs

    def render_overlay(self, image: LoadedImage, result: FrontalResult | ProfileResult, *, layers: set[str],
                       locale: str = "th") -> np.ndarray:
        if result.frames is None or image.sha256 != result.frames.reference_sha256:
            raise ImageMismatchError("image does not match the result's reference_sha256")
        out = image.pixels.copy()
        out[: max(1, out.shape[0] // 10), : max(1, out.shape[1] // 10)] = (255, 255, 255)
        return out

    def user_view(self, obj: Any, *, locale: str = "th") -> dict[str, Any]:
        return core_user_view(obj, locale=locale, user_adjustable_points=ADJUSTABLE)

    def client_config(self, locale: str = "th") -> dict[str, Any]:
        return {
            "core_version": self.core_version, "schema_version": SCHEMA_VERSION, "config_hash": self.config_hash,
            "locale": locale,
            "frontal": {"gates": {"yaw_max_deg": 8.0}, "burst": {"min_frames": 3, "max_frames": 15,
                                                                  "recommended_frames": 7}},
            "profile": {"gates": {"max_head_tilt_deg": 20.0, "contrast_min": 6.0}},
            "user_adjustable_points": ADJUSTABLE,
            "strings": {"hint": {"chin_down": "Lower your chin slightly." if locale == "en" else "ก้มคางลงเล็กน้อย"}},
        }


# Factories are module-level so the spawn start method can pickle them.

def fake_factory(cfg: Any) -> FakeEngine:
    return FakeEngine()


def failing_factory(cfg: Any) -> FakeEngine:
    raise RuntimeError("model files are missing")


def slow_start_factory(cfg: Any) -> FakeEngine:
    time.sleep(4)
    return FakeEngine()
