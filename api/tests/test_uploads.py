"""Upload validation and limits: 413, 415, 422, magic bytes, pixel caps, bursts."""

from __future__ import annotations

import io
import json
import os
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.conftest import META, analyze, image_bytes, make_settings, running_app

BOUNDARY = "testboundary7MA4YWxkTrZu0gW"


@pytest.fixture(scope="module")
def small() -> Iterator[TestClient]:
    """Tiny limits so the limit paths are cheap to reach."""
    s = make_settings(max_image_bytes=4096, max_request_bytes=20_000, max_meta_bytes=256, max_frames=4,
                      max_pixels=10_000, max_burst_pixels=25_000, max_json_bytes=4096)
    with running_app(s) as c:
        yield c


def code(r: Any) -> tuple[int, str]:
    assert r.headers["content-type"] == "application/problem+json", r.text
    return r.status_code, r.json()["code"]


def multipart(parts: list[tuple[str, bytes, str | None]], *, close: bool = True) -> bytes:
    out = b""
    for name, data, filename in parts:
        disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        out += f"--{BOUNDARY}\r\nContent-Disposition: {disp}\r\n\r\n".encode() + data + b"\r\n"
    return out + (f"--{BOUNDARY}--\r\n".encode() if close else b"")


def post_raw(client: TestClient, body: Any, *, ctype: str | None = None, headers: dict[str, str] | None = None) -> Any:
    h = {"content-type": ctype or f"multipart/form-data; boundary={BOUNDARY}", **(headers or {})}
    return client.post("/v1/frontal/analyze", content=body, headers=h)


def noise_png(size: tuple[int, int]) -> bytes:
    buf = io.BytesIO()
    Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3)).save(buf, format="PNG")
    return buf.getvalue()


# ------------------------------------------------------------------------------ body shape


def test_body_must_be_multipart(client: TestClient):
    assert code(client.post("/v1/frontal/analyze", json=META)) == (415, "unsupported_media_type")
    assert code(post_raw(client, b"x", ctype="multipart/form-data")) == (400, "invalid_request")   # no boundary


def test_unknown_duplicate_and_truncated_parts(client: TestClient):
    meta = json.dumps(META).encode()
    img = image_bytes()
    assert code(post_raw(client, multipart([("frames", img, "a.png"), ("meta", meta, None), ("extra", b"1", None)]))) \
        == (400, "invalid_request")
    assert code(post_raw(client, multipart([("frames", img, "a.png"), ("meta", meta, None), ("meta", meta, None)]))) \
        == (400, "invalid_request")
    assert code(post_raw(client, multipart([("frames", img, "a.png"), ("meta", meta, None)], close=False))) \
        == (400, "invalid_request")
    assert code(post_raw(client, b"garbage without boundaries")) == (400, "invalid_request")


def test_frame_counts(client: TestClient):
    img = image_bytes()
    assert code(analyze(client, frames=[])) == (400, "invalid_request")
    assert code(analyze(client, frames=[img, img])) == (400, "invalid_request")          # 2 is neither photo nor burst
    assert analyze(client, frames=[img, img, img]).json()["status"] == "ok"              # 3-frame burst


def test_magic_bytes_decide_the_type(client: TestClient):
    gif = b"GIF89a" + b"\x00" * 64
    r = client.post("/v1/frontal/analyze",
                    files=[("frames", ("f.png", gif, "image/png")), ("meta", (None, json.dumps(META), "application/json"))])
    assert code(r) == (415, "unsupported_media_type")
    # A declared type that disagrees with the bytes does not matter: JPEG bytes sent as "text/plain" are fine.
    r = client.post("/v1/frontal/analyze",
                    files=[("frames", ("f.txt", image_bytes(fmt="JPEG"), "text/plain")),
                           ("meta", (None, json.dumps(META), "application/json"))])
    assert r.status_code == 200
    for fmt in ("PNG", "JPEG", "WEBP"):
        assert analyze(client, frames=[image_bytes(fmt=fmt)]).status_code == 200


def test_valid_magic_but_corrupt_image(client: TestClient):
    corrupt = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
    assert code(analyze(client, frames=[corrupt])) == (400, "invalid_request")


# ------------------------------------------------------------------------------------ meta


@pytest.mark.parametrize("meta", [
    {"subject": {"sex": "female", "age": 28}, "locale": "en", "extra": 1},
    {"subject": {"sex": "female", "age": "28"}},
    {"subject": {"sex": "female", "age": 28.5}},
    {"subject": {"sex": "female", "age": 0}},
    {"subject": {"sex": "female", "age": 121}},
    {"subject": {"sex": "other", "age": 28}},
    {"subject": {"sex": "female", "age": 28, "norms_profile": "th_east_asian"}},
    {"subject": {"sex": "female", "age": 28}, "locale": "fr"},
    {"subject": {"sex": "female", "age": 28}, "camera": {"focal_px": 0, "source": "device"}},
    {"subject": {"sex": "female", "age": 28}, "camera": {"focal_px": "2890", "source": "device"}},
    {"subject": {"sex": "female", "age": 28}, "camera": {"focal_px": 2890.0, "source": "guess"}},
    {"subject": {"sex": "female", "age": 28}, "overlay": {"layers": ["landmarks", "landmarks"]}},
    {"subject": {"sex": "female", "age": 28}, "overlay": {"layers": []}},
    {"subject": {"sex": "female", "age": 28}, "overlay": {"layers": ["no_such_layer"]}},
    {"subject": {"sex": "female", "age": 28}, "overlay": {"layers": ["landmarks"], "extra": 1}},
    {"locale": "en"},
])
def test_invalid_meta(client: TestClient, meta: dict[str, Any]):
    assert code(analyze(client, meta=meta)) == (422, "invalid_meta")


def test_meta_must_be_present_and_json(client: TestClient):
    r = client.post("/v1/frontal/analyze", files=[("frames", ("f.png", image_bytes(), "image/png"))])
    assert code(r) == (422, "invalid_meta")
    r = client.post("/v1/frontal/analyze",
                    files=[("frames", ("f.png", image_bytes(), "image/png")), ("meta", (None, "{not json", None))])
    assert code(r) == (422, "invalid_meta")
    inf = '{"subject": {"sex": "female", "age": 28}, "camera": {"focal_px": Infinity, "source": "device"}}'
    r = client.post("/v1/frontal/analyze",
                    files=[("frames", ("f.png", image_bytes(), "image/png")), ("meta", (None, inf, None))])
    assert code(r) == (422, "invalid_meta")


def test_meta_may_be_sent_as_a_file_part(client: TestClient):
    r = client.post("/v1/frontal/analyze",
                    files=[("frames", ("f.png", image_bytes(), "image/png")),
                           ("meta", ("meta.json", json.dumps(META).encode(), "application/json"))])
    assert r.status_code == 200


# ---------------------------------------------------------------------------------- limits


def test_content_length_is_checked_before_reading(small: TestClient):
    body = multipart([("frames", b"\xff\xd8\xff" + b"\x00" * 30_000, "a.jpg")])
    assert code(post_raw(small, body)) == (413, "payload_too_large")


def test_streamed_body_is_counted(small: TestClient):
    def chunks() -> Iterator[bytes]:
        yield f"--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"frames\"; filename=\"a.jpg\"\r\n\r\n".encode()
        for _ in range(40):
            yield b"\x00" * 1000
    r = post_raw(small, chunks())
    assert "content-length" not in {k.lower() for k in r.request.headers}
    assert code(r) == (413, "payload_too_large")


def test_per_image_and_frame_count_limits(small: TestClient):
    assert code(analyze(small, frames=[noise_png((64, 48))])) == (413, "payload_too_large")      # > 4096 bytes
    tiny = image_bytes(size=(8, 8))
    assert code(analyze(small, frames=[tiny] * 5)) == (413, "payload_too_large")                # > 4 frames
    big_meta = {**META, "subject": {"sex": "female", "age": 28}, "pad": "x" * 400}
    assert code(analyze(small, meta=big_meta, frames=[tiny])) == (413, "payload_too_large")    # meta > 256 bytes


def test_pixel_cap(small: TestClient):
    assert code(analyze(small, frames=[image_bytes(size=(150, 100))])) == (422, "too_many_pixels")   # cap < px ≤ 2 cap
    assert code(analyze(small, frames=[image_bytes(size=(300, 300))])) == (422, "too_many_pixels")   # > 2 × cap
    assert analyze(small, frames=[image_bytes(size=(100, 100))]).status_code == 200                 # exactly the cap


def test_burst_pixel_total(small: TestClient):
    f = image_bytes(size=(100, 90))
    assert code(analyze(small, frames=[f, f, f])) == (422, "too_many_pixels")
    g = image_bytes(size=(80, 80))
    assert analyze(small, frames=[g, g, g]).status_code == 200


def test_decompression_bomb(client: TestClient):
    buf = io.BytesIO()
    Image.new("1", (12_000, 12_000)).save(buf, format="PNG")    # 144 MP in a few kB
    assert len(buf.getvalue()) < 100_000
    assert code(analyze(client, frames=[buf.getvalue()])) == (422, "too_many_pixels")
    assert client.get("/readyz").status_code == 200   # the worker survived


def test_burst_frames_must_match(client: TestClient):
    a, b = image_bytes(size=(64, 48)), image_bytes(size=(48, 64))
    assert code(analyze(client, frames=[a, a, b])) == (422, "frame_size_mismatch")


# ----------------------------------------------------------------------------- JSON bodies


def test_json_body_rules(small: TestClient):
    assert code(small.post("/v1/adjust", content=b"{}")) == (415, "unsupported_media_type")
    assert code(small.post("/v1/adjust", headers={"content-type": "application/json"}, content=b"{nope")) \
        == (400, "invalid_request")
    big = {"result_token": "t" * 5000, "overrides": {"trichion": {"x": 1, "y": 2}}}
    assert code(small.post("/v1/adjust", json=big)) == (413, "payload_too_large")
    body = {"result_token": "t", "overrides": {"trichion": {"x": 1, "y": 2, "source": "user_adjusted"}}}
    assert code(small.post("/v1/adjust", json=body)) == (400, "invalid_request")
    for bad in ({"result_token": "t", "overrides": {}}, {"result_token": "t", "overrides": {"trichion": {"x": "1", "y": 2}}},
                {"result_token": "t", "overrides": {"trichion": {"x": 1, "y": 2}}, "locale": "de"},
                {"overrides": {"trichion": {"x": 1, "y": 2}}}):
        assert code(small.post("/v1/adjust", json=bad)) == (400, "invalid_request")
