"""Worker pool: readiness, hard timeouts, crash recovery, backpressure, recycling."""

from __future__ import annotations

import threading
import time
from typing import Any

from facescan_api.workers import WorkerConfig, WorkerInfo, WorkerPool
from tests.conftest import analyze, image_bytes, make_settings, running_app
from tests.fake_engine import FAKE_RULES, GREEN, RED, failing_factory, slow_start_factory


def problem_code(r: Any) -> tuple[int, str]:
    assert r.headers["content-type"] == "application/problem+json", r.text
    return r.status_code, r.json()["code"]


def test_timeout_gives_504_and_the_pool_recovers():
    with running_app(make_settings(timeout_frontal_s=1.5)) as client:
        t0 = time.time()
        r = analyze(client, frames=[image_bytes(GREEN)])
        assert problem_code(r) == (504, "analysis_timeout")
        assert time.time() - t0 < 10                                 # killed at the hard limit, not after 60 s
        assert analyze(client).json()["status"] == "ok"              # a fresh worker took over


def test_crashed_worker_gives_500_and_the_pool_recovers():
    with running_app() as client:
        r = analyze(client, frames=[image_bytes(RED)])
        assert problem_code(r) == (500, "internal_error")
        assert analyze(client).json()["status"] == "ok"
        assert client.get("/readyz").status_code == 200


def test_full_queue_gives_503_with_retry_after():
    with running_app(make_settings(workers=1, queue_size=0, timeout_frontal_s=3)) as client:
        slow: dict[str, Any] = {}
        t = threading.Thread(target=lambda: slow.update(r=analyze(client, frames=[image_bytes(GREEN)])))
        t.start()
        deadline = time.time() + 5
        while client.api.pool.pending == 0 and time.time() < deadline:
            time.sleep(0.02)
        r = analyze(client)
        assert problem_code(r) == (503, "overloaded") and int(r.headers["retry-after"]) >= 1
        t.join()
        assert problem_code(slow["r"]) == (504, "analysis_timeout")
        assert analyze(client).json()["status"] == "ok"
        assert client.api.pool.pending == 0


def test_overload_is_refused_before_the_upload_is_read():
    with running_app(make_settings(workers=1, queue_size=0, timeout_frontal_s=3)) as client:
        slow: dict[str, Any] = {}
        t = threading.Thread(target=lambda: slow.update(r=analyze(client, frames=[image_bytes(GREEN)])))
        t.start()
        deadline = time.time() + 5
        while client.api.pool.pending == 0 and time.time() < deadline:
            time.sleep(0.02)
        # A malformed body would be a 400 if it were parsed: the 503 shows it was not read.
        r = client.post("/v1/frontal/analyze", headers={"content-type": "multipart/form-data; boundary=x"},
                        content=b"not multipart at all" * 1000)
        assert problem_code(r) == (503, "overloaded")
        r = client.post("/v1/adjust", json={"result_token": "x", "overrides": {}})
        assert problem_code(r) == (503, "overloaded")
        t.join()
        assert client.api.pool.pending == 0


def test_workers_that_cannot_start_keep_the_service_not_ready():
    with running_app(factory=failing_factory, wait_ready=False) as client:
        deadline = time.time() + 30
        while not client.api.pool.failed and time.time() < deadline:
            time.sleep(0.1)
        assert client.api.pool.failed
        r = client.get("/readyz")
        assert problem_code(r) == (503, "not_ready") and r.headers["retry-after"]
        assert problem_code(analyze(client)) == (503, "not_ready")
        assert problem_code(client.get("/v1/client-config")) == (503, "not_ready")


def test_readiness_waits_for_the_warm_up():
    with running_app(factory=slow_start_factory, wait_ready=False) as client:
        assert problem_code(client.get("/readyz")) == (503, "not_ready")
        deadline = time.time() + 60
        while client.get("/readyz").status_code != 200:
            assert time.time() < deadline
            time.sleep(0.2)
        assert analyze(client).json()["status"] == "ok"


def test_workers_are_recycled_after_max_tasks():
    with running_app(make_settings(workers=1, worker_max_tasks=2)) as client:
        for _ in range(5):
            assert analyze(client).json()["status"] == "ok"
        assert client.api.pool._state.reports >= 3                   # the initial worker plus replacements


def _info(**kw: Any) -> WorkerInfo:
    base = dict(pid=1, core_version="0.1.0", schema_version="2.0", config_hash="sha256:a", raqm=True,
                layers=("landmarks",), client_config={"en": {}}, rules=FAKE_RULES)
    base.update(kw)
    return WorkerInfo(**base)


def _pool(workers: int = 2, require_raqm: bool = True) -> WorkerPool:
    cfg = WorkerConfig(models_dir="x", norms_profile="canon", max_pixels=1, max_burst_pixels=1, overlay_max_side=1,
                       overlay_jpeg_quality=1, rules_path="rules.yaml")
    return WorkerPool(cfg, workers=workers, max_tasks=1, queue_capacity=1, require_raqm=require_raqm)


def test_readiness_rules():
    pool = _pool()
    pool._on_report({"pid": 1, "info": _info(pid=1)})
    assert not pool.ready                                     # 1 of 2 workers
    pool._on_report({"pid": 2, "info": _info(pid=2)})
    assert pool.ready
    pool._on_report({"pid": 3, "info": _info(pid=3, config_hash="sha256:b")})
    assert not pool.ready                                     # workers disagree on the configuration
    pool = _pool(workers=1)
    pool._on_report({"pid": 1, "info": _info(raqm=False)})
    assert not pool.ready                                     # Thai text in overlays needs RAQM
    pool = _pool(workers=1, require_raqm=False)
    pool._on_report({"pid": 1, "info": _info(raqm=False)})
    assert pool.ready


def test_requests_get_an_answer_when_the_pool_stops_under_them():
    with running_app(make_settings(workers=1, queue_size=2, timeout_frontal_s=20)) as client:
        results: list[Any] = []
        threads = [threading.Thread(target=lambda: results.append(analyze(client, frames=[image_bytes(GREEN)])))
                   for _ in range(2)]
        for t in threads:
            t.start()
        deadline = time.time() + 5
        while client.api.pool.pending < 2 and time.time() < deadline:
            time.sleep(0.02)
        time.sleep(0.5)
        client.api.pool._on_report({"pid": 0, "error": "RuntimeError: replacement worker failed"})
        for t in threads:
            t.join(timeout=30)
        assert len(results) == 2
        codes = sorted(problem_code(r) for r in results)
        assert all(status >= 500 for status, _ in codes), codes      # answered, not dropped
        assert problem_code(client.get("/readyz")) == (503, "not_ready")
