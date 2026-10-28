"""Engine configuration and typed settings loaded from ``config/*.yaml``.

Loading happens once, in ``FaceScanEngine.__init__``. Nothing here downloads,
writes, or keeps module-level state.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

DEFAULT_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
LOCALES = ("th", "en")

FACE_LANDMARKER_FILE = "face_landmarker.task"
SEGMENTER_FILE = "selfie_multiclass_256x256.tflite"


class _Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FrontalGates(_Settings):
    camera_distance_min_m: float
    camera_distance_recommended_m: float
    yaw_max_deg: float
    pitch_max_deg: float
    roll_max_deg: float
    expression: dict[str, float]
    ipd_min_px: float
    sharpness_min: float
    roi_width_px: int
    exposure_mean_min: float
    exposure_mean_max: float
    exposure_clip_low: int
    exposure_clip_high: int
    exposure_clipped_max_frac: float


class BurstSettings(_Settings):
    min_frames: int
    max_frames: int
    recommended_frames: int
    tta_below_frames: int
    min_point_frame_frac: float


class OneEuroSettings(_Settings):
    min_cutoff: float
    beta: float
    d_cutoff: float


class GuidedCaptureSettings(_Settings):
    consecutive_pass_frames: int
    keep_best_frames: int
    one_euro: OneEuroSettings


class TTASettings(_Settings):
    runs: int
    scale_frac: float
    shift_frac: float
    rotation_deg: float
    min_successful_runs: int


class FrontalSettings(_Settings):
    gates: FrontalGates
    burst: BurstSettings
    guided_capture: GuidedCaptureSettings
    tta: TTASettings


class ProfileGates(_Settings):
    contrast_min: float
    anterior_tolerance_frac: float
    max_head_tilt_deg: float


class ProfileSegmentationSettings(_Settings):
    coarse_input_px: int
    min_face_px: int
    second_face_frac: float
    head_crop_scale: float
    work_max_px: int
    bg_margin_cells: float
    band_cells: float
    min_bg_pixels: int
    cov_reg: float
    threshold_min: float
    close_radius_frac: float


class ProfileContourSettings(_Settings):
    smooth_window_frac: float
    smooth_polyorder: int
    curvature_span_frac: float
    stored_points: int
    top_margin_frac: float
    bottom_margin_frac: float
    pronasale_window: tuple[float, float]
    nasion_min_depth_frac: float
    lip_prominence_frac: float
    max_rotation_deg: float
    min_chin_drop_frac: float
    neck_len_frac: float
    neck_rise_frac: float
    glabella_window_frac: float
    columella_fit: tuple[float, float]
    cervical_window_frac: float
    cervical_min_turn_deg: float
    inward_offset_cells: float
    hair_run_cells: float
    trichion_fringe_cells: float
    min_forehead_frac: float


class ProfileTransferSettings(_Settings):
    max_disagreement_frac: float


class ProfileSettings(_Settings):
    gates: ProfileGates
    segmentation: ProfileSegmentationSettings
    contour: ProfileContourSettings
    transfer: ProfileTransferSettings


class ScaleSettings(_Settings):
    iris_diameter_mm: float
    iris_rel_uncertainty: float
    max_iris_diff_frac: float


class HairlineSettings(_Settings):
    crop_scale: float
    crop_center_frac: float
    hair_run_min_cells: float
    min_forehead_frac: float
    max_scan_frac: float
    lateral_offset_frac_icd: float
    max_lateral_spread_frac: float


class TemporalBoundarySettings(_Settings):
    window_frac_icd: float
    max_hair_frac: float


class OverrideSettings(_Settings):
    user_adjustable_points: dict[str, list[str]]
    large_adjustment_frac: float
    manual_placement_sd_frac: float
    landmark_sampling_runs: int
    landmark_sampling_seed: int


class ReferenceSettings(_Settings):
    inconclusive_k: float
    min_uncertainty_samples: int


class RenderSettings(_Settings):
    font_candidates: list[str] = Field(default_factory=list)


class CaptureSettings(_Settings):
    version: str
    frontal: FrontalSettings
    profile: ProfileSettings
    scale: ScaleSettings
    hairline: HairlineSettings
    temporal_boundary: TemporalBoundarySettings
    overrides: OverrideSettings
    reference: ReferenceSettings
    render: RenderSettings


class EngineConfig(BaseModel):
    """Where the engine finds its models and configuration files.

    Model files are fetched once with ``python -m facescan.tools.download_models``;
    the engine never downloads anything.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    face_landmarker_model: Path
    segmenter_model: Path
    config_dir: Path = DEFAULT_CONFIG_DIR
    font_path: Path | None = None
    rules_path: Path | None = None  # Phase 3

    @classmethod
    def from_models_dir(cls, models_dir: str | Path = "models", **kwargs: Any) -> "EngineConfig":
        models_dir = Path(models_dir)
        return cls(
            face_landmarker_model=models_dir / FACE_LANDMARKER_FILE,
            segmenter_model=models_dir / SEGMENTER_FILE,
            **kwargs,
        )

    @classmethod
    def from_yaml(cls, path: str | Path) -> "EngineConfig":
        """Load from a YAML file; relative paths resolve against the file's directory."""
        path = Path(path)
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for key in ("face_landmarker_model", "segmenter_model", "config_dir", "font_path", "rules_path"):
            if data.get(key) is not None and not Path(data[key]).is_absolute():
                data[key] = str((path.parent / data[key]).resolve())
        return cls(**data)


@dataclass(frozen=True)
class Settings:
    capture: CaptureSettings
    norms: dict[str, Any]
    locales: dict[str, dict[str, Any]]
    rules: dict[str, Any] | None
    config_hash: str
    rules_hash: str | None = None


def read_yaml(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping at the top level")
    return data


def load_locales(config_dir: Path) -> dict[str, dict[str, Any]]:
    return {code: read_yaml(Path(config_dir) / f"locale_{code}.yaml") for code in LOCALES}


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _hash(obj: Any) -> str:
    payload = json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_settings(config: EngineConfig, *, rules: dict[str, Any] | None = None) -> Settings:
    """Read every config file and compute ``config_hash`` (and ``rules_hash``).

    ``config_hash`` covers everything that determines a result: capture settings, norms,
    locale strings and the SHA-256 of both model files. Rules do not change results,
    so they are hashed separately (``rules_hash``, recorded in reports next to
    ``rules_version``); updating rules therefore does not invalidate stored results.
    """
    config_dir = Path(config.config_dir)
    capture_raw = read_yaml(config_dir / "capture.yaml")
    norms = read_yaml(config_dir / "norms.yaml")
    locales = load_locales(config_dir)
    models = {
        "face_landmarker": file_sha256(Path(config.face_landmarker_model)),
        "segmenter": file_sha256(Path(config.segmenter_model)),
    }
    return Settings(
        capture=CaptureSettings.model_validate(capture_raw),
        norms=norms,
        locales=locales,
        rules=rules,
        config_hash=_hash({"capture": capture_raw, "norms": norms, "locales": locales, "models": models}),
        rules_hash=_hash(rules) if rules is not None else None,
    )
