"""All configuration comes from environment variables, each with a default (``README.md`` lists them)."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MB = 1_000_000   # decimal megabytes (the stricter reading of "12 MB")


def core_rules_path() -> Path:
    """The core's shipped rules file (package data), found without importing the core into the web process."""
    spec = importlib.util.find_spec("facescan")
    if spec is None or spec.origin is None:
        raise RuntimeError("the facescan core is not installed")
    return Path(spec.origin).parent / "config" / "rules.example.yaml"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False, extra="ignore", frozen=True)

    host: str = "127.0.0.1"
    port: int = 8000
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # --- result tokens
    max_token_chars: int = Field(default=256 * 1024, ge=1024)   # real tokens are ~8–20 kB

    # --- core engine (per worker)
    models_dir: Path = Path("models")
    norms_profile: str = "canon"
    rules_path: Path = Field(default_factory=core_rules_path)

    # --- workers
    workers: int = Field(default_factory=lambda: len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity")
                         else (os.cpu_count() or 1), ge=1)
    worker_max_tasks: int = Field(default=200, ge=1)
    queue_size: int | None = Field(default=None, ge=0)
    timeout_frontal_s: float = Field(default=20.0, gt=0)
    timeout_profile_s: float = Field(default=30.0, gt=0)
    timeout_adjust_s: float = Field(default=5.0, gt=0)
    timeout_overlay_s: float = Field(default=10.0, gt=0)
    timeout_report_s: float = Field(default=5.0, gt=0)
    require_raqm: bool = True

    # --- uploads
    max_image_bytes: int = Field(default=12 * MB, ge=1024)
    max_request_bytes: int = Field(default=60 * MB, ge=1024)
    max_json_bytes: int = Field(default=1 * MB, ge=1024)
    max_meta_bytes: int = Field(default=16 * 1024, ge=256)
    max_frames: int = Field(default=15, ge=1)
    max_pixels: int = Field(default=24_000_000, ge=10_000)
    # Decoded frames of one burst together (15 × 3840×2160 ≈ 124 MP ≈ 375 MB of RGB).
    max_burst_pixels: int = Field(default=125_000_000, ge=10_000)
    overlay_max_side: int = Field(default=1600, ge=64)
    overlay_jpeg_quality: int = Field(default=85, ge=1, le=100)

    # --- rate limit: a whole class may share one Wi-Fi address
    rate_limit_ip_per_minute: int = Field(default=600, ge=1)

    @property
    def queue_capacity(self) -> int:
        """Tasks that may wait for a worker (default 2 × workers)."""
        return self.queue_size if self.queue_size is not None else 2 * self.workers

    @model_validator(mode="after")
    def _check(self) -> "Settings":
        if not self.rules_path.is_file():
            raise ValueError(f"RULES_PATH {self.rules_path} is not a file")
        if self.max_image_bytes > self.max_request_bytes:
            raise ValueError("MAX_IMAGE_BYTES must not exceed MAX_REQUEST_BYTES")
        return self
