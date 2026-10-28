"""Pydantic result models.

Every model is JSON-serializable and survives a JSON round trip without loss
(``Model.model_validate_json(r.model_dump_json()) == r``): floats are finite
(``allow_inf_nan=False``; "unavailable" is ``None``, never NaN), containers are
lists and dicts, and enumerations are string literals.
"""

from __future__ import annotations

import math
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "2.0"

ResultStatus = Literal["ok", "no_face", "multiple_faces", "quality_failed", "contour_failed"]
PointSource = Literal["auto", "segmentation", "contour", "user_adjusted", "clinician"]
OverrideSource = Literal["user_adjusted", "clinician"]
Confidence = Literal["high", "low"]
MetricStatus = Literal["within", "below", "above", "inconclusive", "unavailable", "no_reference"]
Display = Literal["user", "clinic_only"]
MetricRole = Literal["primary", "secondary"]
UncertaintyMethod = Literal["burst_sd", "tta", "landmark_sampling"]
CameraSource = Literal["device", "exif", "configured_fov", "calibration"]
Sex = Literal["female", "male", "unspecified"]
CheckStatus = Literal["pass", "fail", "unverified"]

ADJUSTED_SOURCES: frozenset[str] = frozenset({"user_adjusted", "clinician"})


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


# --------------------------------------------------------------------------- inputs


class CameraInfo(_Model):
    """Camera intrinsics for the image exactly as analyzed (after EXIF orientation)."""

    focal_px: float = Field(gt=0)
    source: CameraSource


class SubjectInfo(_Model):
    """Who is being analyzed.

    ``sex`` is entered by the user and never inferred from the face. ``age`` is the
    self-reported age in whole years, an input of the analysis carried in the result.
    ``norms_profile`` is set by deployment config (e.g. "canon", "th_east_asian"),
    never by the user.
    """

    sex: Sex
    age: int = Field(ge=1, le=120)
    norms_profile: str = "canon"


class Override(_Model):
    """A point adjustment in pixel coordinates of the analyzed image.

    For a burst, coordinates refer to the reference frame. The caller sets
    ``source`` from who made the change; the core never infers it.
    """

    x: float
    y: float
    source: OverrideSource


# ------------------------------------------------------------------------ landmarks


class Point2D(_Model):
    x: float
    y: float


class AutoPosition(_Model):
    """The automatic position kept for an adjusted point (``x``/``y`` None if none existed)."""

    x: float | None = None
    y: float | None = None
    source: PointSource
    confidence: Confidence
    sd_px: float | None = None
    reason: str | None = None


class Landmark(_Model):
    """A named anatomical point. ``x``/``y`` are None when the point is unavailable."""

    x: float | None = None
    y: float | None = None
    source: PointSource
    confidence: Confidence
    sd_px: float | None = None
    auto: AutoPosition | None = None
    flags: list[str] = Field(default_factory=list)
    reason: str | None = None

    @property
    def available(self) -> bool:
        return self.x is not None and self.y is not None

    @property
    def adjusted(self) -> bool:
        return self.source in ADJUSTED_SOURCES

    def xy(self) -> np.ndarray | None:
        return None if not self.available else np.array([self.x, self.y], dtype=float)


# ---------------------------------------------------------------------- capture info


class HeadPose(_Model):
    """Head pose in degrees (subject's perspective, unmirrored image).

    yaw > 0: face turned toward the subject's left; pitch > 0: chin up;
    roll > 0: head tilted toward the subject's left shoulder.
    """

    yaw_deg: float
    pitch_deg: float
    roll_deg: float


class QualityCheck(_Model):
    id: str
    value: float | None = None
    limit: float | list[float] | None = None
    passed: bool
    status: CheckStatus
    hint_key: str | None = None
    frames_passed: int | None = None


class Quality(_Model):
    """Capture quality. A failed or unverified capture can never trigger considerations."""

    passed: bool
    considerations_eligible: bool
    checks: list[QualityCheck] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    hint_keys: list[str] = Field(default_factory=list)


class Calibration(_Model):
    method: Literal["iris", "transferred_from_frontal", "none"]
    mm_per_px: float | None = None
    rel_uncertainty: float | None = None
    iris_diameter_px: dict[str, float] | None = None
    # Stored calibration inputs (profile: the frontal scan's distances in mm), so that
    # apply_overrides can recompute the calibration without the frontal result.
    inputs: dict[str, float] | None = None
    landmarks_used: list[str] = Field(default_factory=list)
    reason: str | None = None


class Frames(_Model):
    count: int
    used: list[int]
    reference_frame: int
    reference_sha256: str


class ImageSize(_Model):
    width: int
    height: int


# -------------------------------------------------------------------------- metrics


class CanonRef(_Model):
    """The canon target, resolved to a [min, max] band for this subject."""

    type: Literal["range", "target", "zero_band"]
    min: float | None = None
    max: float | None = None
    target: float | None = None
    tolerance_frac: float | None = None
    band_frac_icd: float | None = None


class Population(_Model):
    mean: float | None = None
    sd: float | None = None
    z: float | None = None
    typical_min: float | None = None
    typical_max: float | None = None
    source: str | None = None


class Metric(_Model):
    value: float | None
    unit: str
    uncertainty: float | None = None
    uncertainty_method: UncertaintyMethod | None = None
    canon: CanonRef | None = None
    deviation_abs: float | None = None
    deviation_pct: float | None = None
    population: Population = Field(default_factory=Population)
    status: MetricStatus
    status_basis: Literal["canon", "population"] | None = None
    display: Display = "user"
    role: MetricRole = "primary"
    confidence: Confidence
    flags: list[str] = Field(default_factory=list)
    landmarks_used: list[str] = Field(default_factory=list)
    reason: str | None = None


# -------------------------------------------------------------------------- results


class _ResultBase(_Model):
    schema_version: str = SCHEMA_VERSION
    core_version: str
    config_hash: str
    status: ResultStatus
    subject: SubjectInfo
    camera: CameraInfo | None = None
    image: ImageSize | None = None
    frames: Frames | None = None
    quality: Quality | None = None
    pose: HeadPose | None = None
    calibration: Calibration | None = None
    landmarks: dict[str, Landmark] = Field(default_factory=dict)
    metrics: dict[str, Metric] = Field(default_factory=dict)

    @property
    def norms_profile(self) -> str:
        return self.subject.norms_profile


class FrontalResult(_ResultBase):
    view: Literal["frontal"] = "frontal"


class ProfileResult(_ResultBase):
    """Phase 2. Same shape as FrontalResult plus ``facing`` and the stored contour."""

    view: Literal["profile"] = "profile"
    facing: Literal["left", "right"]
    # Silhouette simplified to ≤ 400 points (pixel coordinates), so clients can snap
    # dragged points on-device and apply_overrides can re-snap them.
    contour: list[Point2D] | None = None


class Consideration(_Model):
    rule_id: str
    rule_version: int | None = None
    area: str
    finding_key: str
    consideration_keys: list[str]
    triggering_metrics: list[str]
    severity: str


class RuleOutcome(_Model):
    """Audit entry per rule (clinic export / QA; not part of the consumer view)."""

    rule_id: str
    rule_version: int | None = None
    outcome: Literal["fired", "not_met", "excluded"]
    ineligible: dict[str, str] = Field(default_factory=dict)   # metric → why it could not count


class Report(_Model):
    """Phase 3: frontal + profile results with considerations from the rules file.

    ``config_hash`` identifies the measurement configuration (as in the results);
    ``rules_version`` and ``rules_hash`` identify the rules file that produced the
    considerations.
    """

    schema_version: str = SCHEMA_VERSION
    core_version: str
    config_hash: str
    status: ResultStatus
    frontal: FrontalResult | None = None
    profile: ProfileResult | None = None
    considerations: list[Consideration] = Field(default_factory=list)
    rules_version: str | None = None
    rules_hash: str | None = None
    rule_audit: list[RuleOutcome] = Field(default_factory=list)
    disclaimer_key: str = "disclaimer.general"

    def to_vector(self) -> tuple[np.ndarray, list[str]]:
        """Fixed-order float vector of every metric (NaN = unavailable) and its id order."""
        from facescan.core.metrics_frontal import FRONTAL_METRIC_IDS
        from facescan.core.metrics_profile import PROFILE_METRIC_IDS

        ids = list(FRONTAL_METRIC_IDS) + list(PROFILE_METRIC_IDS)
        values = np.full(len(ids), math.nan, dtype=float)
        for i, metric_id in enumerate(ids):
            for res in (self.frontal, self.profile):
                if res is not None and metric_id in res.metrics:
                    v = res.metrics[metric_id].value
                    if v is not None:
                        values[i] = v
        return values, ids
