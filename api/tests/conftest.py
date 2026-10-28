"""Shared fixtures: apps with the fake engine, test images, request helpers."""

from __future__ import annotations

import contextlib
import io
import json
import time
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from facescan_api.app import create_app
from facescan_api.settings import Settings
from tests.fake_engine import fake_factory

META: dict[str, Any] = {"subject": {"sex": "female", "age": 28}, "locale": "en"}
SKIN = (200, 150, 120)


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = dict(workers=1, require_raqm=False, rate_limit_ip_per_minute=10_000, models_dir="unused")
    base.update(overrides)
    return Settings(**base)


def wait_until_ready(client: TestClient, timeout: float = 90.0) -> None:
    t0 = time.time()
    while client.get("/readyz").status_code != 200:
        if time.time() - t0 > timeout:
            raise AssertionError("workers did not become ready")
        time.sleep(0.1)


@contextlib.contextmanager
def running_app(settings: Settings | None = None, factory: Any = fake_factory, *, wait_ready: bool = True,
                **create_kw: Any) -> Iterator[TestClient]:
    app = create_app(settings or make_settings(), engine_factory=factory, **create_kw)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.api = app.state.api  # type: ignore[attr-defined]
        if wait_ready:
            wait_until_ready(client)
        yield client


def image_bytes(color: tuple[int, int, int] = SKIN, size: tuple[int, int] = (64, 48), fmt: str = "PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


def analyze_files(frames: list[bytes], meta: dict[str, Any] | None = None) -> list[tuple[str, Any]]:
    parts: list[tuple[str, Any]] = [("frames", (f"f{i}.png", f, "image/png")) for i, f in enumerate(frames)]
    parts.append(("meta", (None, json.dumps(META if meta is None else meta), "application/json")))
    return parts


def overlay_files(image: bytes, meta: dict[str, Any]) -> list[tuple[str, Any]]:
    return [("image", ("ref.png", image, "image/png")), ("meta", (None, json.dumps(meta), "application/json"))]


def analyze(client: TestClient, frames: list[bytes] | None = None, meta: dict[str, Any] | None = None) -> Any:
    frames = frames if frames is not None else [image_bytes()]
    return client.post("/v1/frontal/analyze", files=analyze_files(frames, meta))


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    with running_app(make_settings(workers=2)) as c:
        yield c
