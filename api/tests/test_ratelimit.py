"""The rate limit: requests per client address per minute, in memory."""

from __future__ import annotations

import pytest

from facescan_api.errors import ApiError
from facescan_api.ratelimit import RateLimiter
from tests.conftest import analyze, make_settings, running_app


class Clock:
    def __init__(self, t: float = 1_800_000_000.0) -> None:   # a multiple of 60: the start of a minute window
        self.t = t

    def __call__(self) -> float:
        return self.t


def test_the_limit_covers_every_v1_request_but_not_readiness():
    with running_app(make_settings(rate_limit_ip_per_minute=3)) as client:
        assert analyze(client).status_code == 200
        assert client.post("/v1/adjust", json={}).status_code == 400
        assert client.get("/v1/client-config").status_code == 200
        r = client.get("/v1/client-config")                           # 4th request from this address this minute
        assert r.status_code == 429 and r.json()["code"] == "rate_limited"
        assert 1 <= int(r.headers["retry-after"]) <= 60
        assert client.get("/readyz").status_code == 200


def test_windows_and_addresses():
    clock = Clock()
    limiter = RateLimiter(3, clock=clock)
    for _ in range(3):
        limiter.hit("203.0.113.7")
    limiter.hit("203.0.113.8")                                         # another address has its own count
    clock.t += 45
    with pytest.raises(ApiError) as e:
        limiter.hit("203.0.113.7")
    assert e.value.code == "rate_limited" and e.value.headers["Retry-After"] == "15"
    clock.t += 15                                                      # next window
    limiter.hit("203.0.113.7")


def test_old_windows_are_pruned():
    clock = Clock()
    limiter = RateLimiter(5, clock=clock, max_keys=10)
    for i in range(10):
        limiter.hit(f"10.0.0.{i}")
    clock.t += 61
    limiter.hit("10.0.1.1")
    assert set(limiter._counts) == {"10.0.1.1"}
