"""Model-free result assembly: named points → landmarks → metrics.

Everything after detection lives here, so ``apply_overrides`` needs no models and uses
exactly the code path of a full analysis:

* ``landmarks``: named points + per-point SD → ``Landmark`` records;
* ``apply_overrides``: user / clinician adjustments (rules in ``overrides.py``; profile
  silhouette points are re-snapped to the stored contour);
* ``metrics``: values, uncertainty, reference assessment, confidence and flags. Metrics
  that depend on an adjusted point get ``landmark_sampling`` uncertainty; with
  ``previous`` given, every other metric is kept unchanged.
"""

from __future__ import annotations

import math
from typing import Any, Mapping

import numpy as np

from facescan.core.config import Settings
from facescan.core.landmark_map import (FRONTAL_POINT_NAMES, PROFILE_POINT_NAMES, PROFILE_SILHOUETTE_POINTS,
                                        default_confidence)
from facescan.core.metrics_frontal import FRONTAL_METRICS, FrontalParams, MetricDef, MetricValue, compute_frontal
from facescan.core.metrics_profile import PROFILE_METRICS, compute_profile
from facescan.core.normalize import ScaleEstimate, transfer_scale
from facescan.core.overrides import apply_point_overrides, coerce_overrides, validate_overrides
from facescan.core.profile_contour import snap_to_contour
from facescan.core.reference import NormsBook, assess, resolve_canon
from facescan.core.schema import (Calibration, FrontalResult, ImageSize, Landmark, Metric, Override, ProfileResult,
                                  SubjectInfo)
from facescan.core.uncertainty import landmark_sampling, with_scale

UNCERTAINTY_UNAVAILABLE = "uncertainty_unavailable"


def metric_values(metrics: Mapping[str, MetricValue]) -> dict[str, float | None]:
    return {k: v.value for k, v in metrics.items()}


class _Assembler:
    """Shared metric assembly. Subclasses provide the view's points, metric registry and compute."""

    view: str
    point_names: tuple[str, ...]
    defs: dict[str, MetricDef]
    reference_pairs: tuple[tuple[str, str], ...] = (("nasion", "menton"),)

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.norms = NormsBook(settings.norms)

    @property
    def user_adjustable(self) -> list[str]:
        return list(self.settings.capture.overrides.user_adjustable_points.get(self.view, []))

    # -- hooks
    def compute(self, pts: Mapping[str, np.ndarray], ctx: Any,
                sd_px: Mapping[str, float | None]) -> tuple[dict[str, MetricValue], ScaleEstimate]:
        raise NotImplementedError

    def calibration(self, scale: ScaleEstimate, ctx: Any) -> Calibration:
        raise NotImplementedError

    def snap(self, ctx: Any):
        return None

    def source(self, name: str) -> str:
        return "auto"

    # -- landmarks and overrides
    def landmarks(self, points: Mapping[str, np.ndarray], reasons: Mapping[str, str],
                  sd: Mapping[str, float], extra_sd: Mapping[str, float]) -> dict[str, Landmark]:
        out: dict[str, Landmark] = {}
        for name in self.point_names:
            source = self.source(name)
            if name in points:
                s = sd.get(name)
                if name in extra_sd:
                    s = math.hypot(s or 0.0, extra_sd[name])
                p = points[name]
                out[name] = Landmark(x=float(p[0]), y=float(p[1]), source=source,
                                     confidence=default_confidence(name), sd_px=s)
            else:
                out[name] = Landmark(source=source, confidence="low", reason=reasons.get(name, "unavailable"))
        return out

    def validate(self, overrides: Mapping[str, Override], image: ImageSize | None) -> None:
        validate_overrides(overrides, point_names=self.point_names, user_adjustable=self.user_adjustable,
                           image=image)

    def with_overrides(self, landmarks: Mapping[str, Landmark], overrides: Mapping[str, Override],
                       ctx: Any = None) -> dict[str, Landmark]:
        o = self.settings.capture.overrides
        return apply_point_overrides(landmarks, overrides, large_adjustment_frac=o.large_adjustment_frac,
                                     manual_sd_frac=o.manual_placement_sd_frac, snap=self.snap(ctx),
                                     reference_pairs=self.reference_pairs)

    # -- metrics
    def metrics(self, landmarks: Mapping[str, Landmark], subject: SubjectInfo, *, ctx: Any = None,
                run_u: Mapping[str, tuple[float | None, str]] | None,
                previous: Mapping[str, Metric] | None,
                quant_sd: Mapping[str, float] | None = None) -> tuple[dict[str, Metric], Calibration]:
        """``quant_sd``: per-point quantization SD (the hair-mask cell for the trichion). Its effect
        on each metric that uses the (automatic) point is added in quadrature to the run-based SD."""
        c = self.settings.capture
        pts = {n: lm.xy() for n, lm in landmarks.items() if lm.available}
        sd_px = {n: lm.sd_px for n, lm in landmarks.items() if lm.available}
        values, scale = self.compute(pts, ctx, sd_px)

        def fn(p: dict[str, np.ndarray]) -> dict[str, float | None]:
            return metric_values(self.compute(p, ctx, sd_px)[0])

        adjusted = {n for n, lm in landmarks.items() if lm.adjusted}
        affected = [mid for mid, mv in values.items() if adjusted.intersection(mv.landmarks)]
        sampling = dict(runs=c.overrides.landmark_sampling_runs, seed=c.overrides.landmark_sampling_seed,
                        min_n=c.reference.min_uncertainty_samples)
        sampled = landmark_sampling(pts, sd_px, fn, affected, **sampling) if affected else {}
        quant = {n: q for n, q in (quant_sd or {}).items() if n in pts and n not in adjusted and q > 0}
        quant_ids = [mid for mid, mv in values.items() if mid not in affected and quant.keys() & set(mv.landmarks)]
        quant_u = landmark_sampling(pts, quant, fn, quant_ids, **sampling) if quant_ids else {}
        icd_mm = values["F4_icd_mm"].value if "F4_icd_mm" in values else None
        out: dict[str, Metric] = {}
        for mid, mv in values.items():
            if previous is not None and mid not in affected and mid in previous:
                out[mid] = previous[mid]
                continue
            if mid in affected:
                u, method = sampled.get(mid), "landmark_sampling"
                # An automatic point without an SD (augmentation failed) would be treated as exact;
                # without a complete error model the uncertainty is unknown (conservative).
                if any(landmarks[n].available and not landmarks[n].adjusted and landmarks[n].sd_px is None
                       for n in mv.landmarks if n in landmarks):
                    u = None
            else:
                u, method = (run_u or {}).get(mid, (None, None))
                if u is not None and quant_u.get(mid) is not None:
                    u = math.hypot(u, quant_u[mid])
            if mv.value is None:
                u = None  # no value → no uncertainty (augmented runs may still have found the point)
            elif self.defs[mid].uses_scale:
                u = with_scale(u, mv.value, scale.rel_uncertainty)
            out[mid] = self.metric(mid, mv, u, method, landmarks, subject, icd_mm)
        return out, self.calibration(scale, ctx)

    def metric(self, mid: str, mv: MetricValue, u: float | None, method: str | None,
               landmarks: Mapping[str, Landmark], subject: SubjectInfo, icd_mm: float | None) -> Metric:
        d = self.defs[mid]
        c = self.settings.capture
        canon = resolve_canon(self.norms.canon(mid), d.unit, tolerance_frac=self.norms.tolerance_frac,
                              zero_band_frac_icd=self.norms.zero_band_frac_icd, icd_mm=icd_mm)
        pop, k_sd = self.norms.population(subject.norms_profile, subject.sex, mid)
        a = assess(mv.value, u, canon=canon, population=pop, typical_range_sd=k_sd, signed=d.signed,
                   inconclusive_k=c.reference.inconclusive_k)
        used = [landmarks[n] for n in mv.landmarks if n in landmarks]
        # A metric takes the lowest confidence among its landmarks and inherits their flags.
        confidence = "low" if any(lm.confidence == "low" or not lm.available for lm in used) else "high"
        flags = sorted({f for lm in used for f in lm.flags})
        if mv.value is not None and u is None:
            flags.append(UNCERTAINTY_UNAVAILABLE)
        return Metric(
            value=mv.value, unit=d.unit, uncertainty=u, uncertainty_method=method if u is not None else None,
            canon=a.canon, deviation_abs=a.deviation_abs, deviation_pct=a.deviation_pct, population=a.population,
            status=a.status, status_basis=a.status_basis, display=d.display, role=d.role, confidence=confidence,
            flags=flags, landmarks_used=list(mv.landmarks), reason=mv.reason)


class FrontalAssembler(_Assembler):
    view = "frontal"
    point_names = FRONTAL_POINT_NAMES
    defs = FRONTAL_METRICS

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        s = settings.capture.scale
        self.params = FrontalParams(s.iris_diameter_mm, s.iris_rel_uncertainty, s.max_iris_diff_frac)

    def values(self, pts: Mapping[str, np.ndarray]) -> dict[str, float | None]:
        return metric_values(compute_frontal(pts, self.params)[0])

    def source(self, name: str) -> str:
        return "segmentation" if name == "trichion" else "auto"

    def compute(self, pts, ctx, sd_px):
        return compute_frontal(pts, self.params)

    def calibration(self, scale: ScaleEstimate, ctx: Any) -> Calibration:
        return Calibration(method="iris" if scale.available else "none", mm_per_px=scale.mm_per_px,
                           rel_uncertainty=scale.rel_uncertainty, iris_diameter_px=scale.diameters_px,
                           landmarks_used=list(scale.landmarks_used), reason=scale.reason)

    def apply_overrides(self, result: FrontalResult, overrides: Mapping[str, Override | dict]) -> FrontalResult:
        """Recompute a stored result after point adjustments (no image, no models)."""
        if not result.landmarks:
            raise ValueError(f"result with status {result.status!r} has no landmarks to adjust")
        ovs = coerce_overrides(overrides)
        self.validate(ovs, result.image)
        landmarks = self.with_overrides(result.landmarks, ovs)
        metrics, calibration = self.metrics(landmarks, result.subject, run_u=None, previous=result.metrics)
        return FrontalResult(**{**dict(result), "landmarks": landmarks, "metrics": metrics, "calibration": calibration})


class ProfileContext:
    """What profile metrics need besides the points: stored contour, facing, frontal inputs."""

    def __init__(self, contour: np.ndarray | None, facing: str, inputs: dict[str, float] | None,
                 inputs_reason: str | None) -> None:
        self.contour = contour
        self.facing = facing
        self.inputs = inputs
        self.inputs_reason = inputs_reason

    @classmethod
    def from_result(cls, result: ProfileResult) -> "ProfileContext":
        contour = np.array([[p.x, p.y] for p in result.contour], dtype=float) if result.contour else None
        cal = result.calibration
        inputs = dict(cal.inputs) if cal is not None and cal.inputs else None
        reason = None if inputs else (cal.reason if cal is not None else "no_frontal_scale")
        return cls(contour, result.facing, inputs, reason)


class ProfileAssembler(_Assembler):
    view = "profile"
    point_names = PROFILE_POINT_NAMES
    defs = PROFILE_METRICS
    # nasion→menton (spec); when the chin underside or the nasion concavity is not found, fall
    # back to similar vertical spans (none longer than nasion→menton, so the tolerance is not looser).
    reference_pairs = (("nasion", "menton"), ("nasion", "soft_tissue_pogonion"),
                       ("glabella", "menton"), ("glabella", "soft_tissue_pogonion"))

    def source(self, name: str) -> str:
        if name == "trichion":
            return "segmentation"
        return "auto" if name == "alar_crease" else "contour"

    def snap(self, ctx: ProfileContext | None):
        if ctx is None or ctx.contour is None:
            return None
        contour = ctx.contour
        return lambda name, xy: snap_to_contour(xy, contour) if name in PROFILE_SILHOUETTE_POINTS else xy

    def scale(self, pts, ctx: ProfileContext, sd_px) -> ScaleEstimate:
        return transfer_scale(ctx.inputs, pts, sd_px,
                              max_disagreement_frac=self.settings.capture.profile.transfer.max_disagreement_frac,
                              reason=ctx.inputs_reason)

    def compute(self, pts, ctx: ProfileContext, sd_px):
        scale = self.scale(pts, ctx, sd_px)
        return compute_profile(pts, ctx.contour, ctx.facing, scale, self.settings.capture.profile.contour), scale

    def calibration(self, scale: ScaleEstimate, ctx: ProfileContext) -> Calibration:
        return Calibration(method="transferred_from_frontal" if scale.available else "none",
                           mm_per_px=scale.mm_per_px, rel_uncertainty=scale.rel_uncertainty,
                           inputs=ctx.inputs, landmarks_used=list(scale.landmarks_used), reason=scale.reason)

    def apply_overrides(self, result: ProfileResult, overrides: Mapping[str, Override | dict]) -> ProfileResult:
        """Recompute a stored profile result after adjustments; silhouette points are re-snapped."""
        if not result.landmarks:
            raise ValueError(f"result with status {result.status!r} has no landmarks to adjust")
        ovs = coerce_overrides(overrides)
        self.validate(ovs, result.image)
        ctx = ProfileContext.from_result(result)
        landmarks = self.with_overrides(result.landmarks, ovs, ctx)
        metrics, calibration = self.metrics(landmarks, result.subject, ctx=ctx, run_u=None, previous=result.metrics)
        return ProfileResult(**{**dict(result), "landmarks": landmarks, "metrics": metrics, "calibration": calibration})
