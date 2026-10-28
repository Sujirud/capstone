"""Worker-process pool for CPU-bound analysis.

Web process: ``WorkerPool`` schedules tasks on a pebble ``ProcessPool`` (spawn
context) and maps hard timeouts and crashed workers to 504 / 500. Requests hold a
*slot* from before their body is read until their task is done, so the bounded
queue (503 ``overloaded``) also bounds the upload bytes held in memory
(``capacity × MAX_REQUEST_BYTES``), and an overloaded service refuses a request
before receiving its upload. It never imports ``facescan`` (MediaPipe stays
out of the web process) and never decodes image bytes.

Worker processes: ``_init_worker`` creates one ``FaceScanEngine``, runs a warm-up
analysis on a blank image (expected status ``no_face``), checks RAQM (Thai text in
overlays) and reports to the web process through a queue; ``/readyz`` turns ready
once every initial worker has reported. Workers are recycled after
``WORKER_MAX_TASKS`` tasks. The ``task_*`` functions run inside workers: they
decode the uploads with the core's ``load_image`` (with Pillow's pixel cap) and
return plain JSON-ready data. Errors that are the caller's fault come back as
``ApiError``; anything else is an internal error.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import multiprocessing
import os
import queue
import threading
import warnings
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import pebble

from facescan_api.errors import ApiError, retry_after

LOCALES = ("th", "en")
log = logging.getLogger("facescan_api")


@dataclass(frozen=True)
class WorkerConfig:
    """What each worker needs (picklable)."""

    models_dir: str
    norms_profile: str
    max_pixels: int
    max_burst_pixels: int
    overlay_max_side: int
    overlay_jpeg_quality: int
    rules_path: str


@dataclass(frozen=True)
class WorkerInfo:
    """Reported by each worker after its warm-up."""

    pid: int
    core_version: str
    schema_version: str
    config_hash: str
    raqm: bool
    layers: tuple[str, ...]
    client_config: dict[str, dict[str, Any]]
    rules: dict[str, Any]                  # engine.rules_info: rules_version, rules_hash, example

    @property
    def user_adjustable_points(self) -> dict[str, list[str]]:
        return self.client_config["en"]["user_adjustable_points"]

    @property
    def burst(self) -> dict[str, int]:
        return self.client_config["en"]["frontal"]["burst"]


# =============================================================================== worker side

_ENGINE: Any = None
_CFG: WorkerConfig | None = None


def default_engine_factory(cfg: WorkerConfig) -> Any:
    from facescan import EngineConfig, FaceScanEngine

    return FaceScanEngine(EngineConfig.from_models_dir(cfg.models_dir, rules_path=cfg.rules_path))


def _init_worker(factory: Callable[[WorkerConfig], Any], cfg: WorkerConfig, ready_queue: Any) -> None:
    global _ENGINE, _CFG
    try:
        import numpy as np
        from PIL import Image, features

        from facescan import LoadedImage, SubjectInfo
        from facescan.render.overlay import LAYERS

        # Pillow's decompression-bomb limit is the pixel cap, and its warning is an error.
        Image.MAX_IMAGE_PIXELS = cfg.max_pixels
        warnings.simplefilter("error", Image.DecompressionBombWarning)

        engine = factory(cfg)
        blank = LoadedImage.from_array(np.zeros((480, 640, 3), dtype=np.uint8))
        warm = engine.analyze_frontal(blank, subject=SubjectInfo(sex="unspecified", age=30,
                                                                   norms_profile=cfg.norms_profile))
        if warm.status != "no_face":
            raise RuntimeError(f"warm-up analysis returned {warm.status!r}, expected 'no_face'")
        client_config = {loc: engine.client_config(loc) for loc in LOCALES}
        info = WorkerInfo(pid=os.getpid(), core_version=engine.core_version,
                          schema_version=client_config["en"]["schema_version"], config_hash=engine.config_hash,
                          raqm=bool(features.check("raqm")), layers=tuple(LAYERS), client_config=client_config,
                          rules=engine.rules_info)
    except BaseException as exc:
        ready_queue.put({"pid": os.getpid(), "error": f"{type(exc).__name__}: {exc}"})
        raise
    _ENGINE, _CFG = engine, cfg
    ready_queue.put({"pid": info.pid, "info": info})


def _decode(blobs: list[bytes], camera: dict | None) -> list[Any]:
    """Decode uploads in this worker: pixel caps first (headers only), then the core's ``load_image``."""
    from PIL import Image, UnidentifiedImageError

    from facescan import CameraInfo, ImageDecodeError, load_image

    assert _CFG is not None
    total = 0
    for i, data in enumerate(blobs):
        try:
            with Image.open(io.BytesIO(data)) as im:
                w, h = im.size
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise ApiError("too_many_pixels", f"image {i} exceeds {_CFG.max_pixels} pixels") from None
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
            raise ApiError("invalid_request", f"image {i} cannot be decoded") from None
        total += w * h
    if len(blobs) > 1 and total > _CFG.max_burst_pixels:
        raise ApiError("too_many_pixels", f"the burst exceeds {_CFG.max_burst_pixels} pixels in total")
    cam = CameraInfo.model_validate(camera) if camera else None
    images = []
    for i, data in enumerate(blobs):
        try:
            images.append(load_image(data, camera=cam))
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise ApiError("too_many_pixels", f"image {i} exceeds {_CFG.max_pixels} pixels") from None
        except ImageDecodeError:
            raise ApiError("invalid_request", f"image {i} cannot be decoded") from None
    if len({(im.width, im.height) for im in images}) > 1:
        raise ApiError("frame_size_mismatch", "burst frames must have identical dimensions")
    return images


def _jpeg(rgb: Any) -> bytes:
    """Overlay as JPEG: long side ≤ OVERLAY_MAX_SIDE, fixed quality, no EXIF or other metadata."""
    from PIL import Image

    assert _CFG is not None
    im = Image.fromarray(rgb)
    w, h = im.size
    if max(w, h) > _CFG.overlay_max_side:
        s = _CFG.overlay_max_side / max(w, h)
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=_CFG.overlay_jpeg_quality, optimize=True)
    return buf.getvalue()


def _result_model(kind: str, result: dict[str, Any]) -> Any:
    """A token's result as the core's model. Tokens are plain JSON, so a result the core
    does not accept makes the token invalid."""
    from pydantic import ValidationError

    from facescan import FrontalResult, ProfileResult

    try:
        return (FrontalResult if kind == "frontal" else ProfileResult).model_validate(result)
    except ValidationError:
        raise ApiError("token_invalid", f"the {kind} token does not hold a valid result") from None


def _overlay(image: Any, result: Any, layers: list[str] | None, locale: str) -> bytes | None:
    if layers is None or result.status != "ok":
        return None
    return _jpeg(_ENGINE.render_overlay(image, result, layers=set(layers), locale=locale))


def task_analyze_frontal(frames: list[bytes], meta: dict[str, Any], layers: list[str] | None) -> dict[str, Any]:
    from facescan import InvalidInputError, SubjectInfo

    assert _CFG is not None
    images = _decode(frames, meta.get("camera"))
    subject = SubjectInfo(sex=meta["subject"]["sex"], age=meta["subject"]["age"], norms_profile=_CFG.norms_profile)
    try:
        result = _ENGINE.analyze_frontal(images if len(images) > 1 else images[0], subject=subject)
    except InvalidInputError as exc:
        code = "frame_size_mismatch" if "frame_size_mismatch" in str(exc) else "invalid_request"
        raise ApiError(code, "the frames cannot be analyzed together") from None
    ref = images[result.frames.reference_frame] if result.frames is not None else images[0]
    return {"result": result.model_dump(mode="json"), "view": _ENGINE.user_view(result, locale=meta["locale"]),
            "overlay": _overlay(ref, result, layers, meta["locale"])}


def task_analyze_profile(image: bytes, meta: dict[str, Any], subject: dict[str, Any], frontal: dict[str, Any] | None,
                         layers: list[str] | None) -> dict[str, Any]:
    """Profile analysis. ``subject`` is the frontal token's (norms profile included) or the request's;
    ``frontal`` is the frontal token's result, for the mm scale transfer."""
    from pydantic import ValidationError

    from facescan import InvalidInputError, SubjectInfo

    assert _CFG is not None
    img = _decode([image], meta.get("camera"))[0]
    front = _result_model("frontal", frontal) if frontal is not None else None
    try:
        subj = SubjectInfo.model_validate({"norms_profile": _CFG.norms_profile, **subject})
    except ValidationError:
        raise ApiError("token_invalid", "the frontal token does not hold a valid subject") from None
    try:
        result = _ENGINE.analyze_profile(img, subject=subj, facing=meta["facing"], frontal=front)
    except InvalidInputError as exc:
        if "subject_mismatch" in str(exc):
            raise ApiError("subject_mismatch", "the frontal result belongs to a different subject") from None
        raise ApiError("invalid_request", "the profile photo cannot be analyzed with this request") from None
    return {"result": result.model_dump(mode="json"), "view": _ENGINE.user_view(result, locale=meta["locale"]),
            "overlay": _overlay(img, result, layers, meta["locale"])}


def task_adjust(kind: str, result: dict[str, Any], overrides: dict[str, dict[str, float]],
                locale: str) -> dict[str, Any]:
    from facescan import InvalidInputError, OverrideError, Override, PointNotAdjustableError, UnknownPointError
    from facescan.core.errors import OverrideOutOfBoundsError

    res = _result_model(kind, result)
    ovs = {name: Override(x=p["x"], y=p["y"], source="user_adjusted") for name, p in overrides.items()}
    try:
        new = _ENGINE.apply_overrides(res, ovs)
    except (PointNotAdjustableError, UnknownPointError):
        raise ApiError("point_not_adjustable", "a requested point cannot be adjusted") from None
    except OverrideOutOfBoundsError:
        raise ApiError("invalid_request", "an adjusted point lies outside the analyzed image") from None
    except OverrideError:
        raise ApiError("point_not_adjustable", "this result cannot be adjusted (no reference distance)") from None
    except InvalidInputError:
        raise ApiError("invalid_request", "this result cannot be adjusted") from None
    return {"result": new.model_dump(mode="json"), "view": _ENGINE.user_view(new, locale=locale), "overlay": None}


def task_overlay(kind: str, result: dict[str, Any], image: bytes, layers: list[str], locale: str) -> bytes:
    from facescan import ImageMismatchError

    img = _decode([image], None)[0]
    res = _result_model(kind, result)
    try:
        rgb = _ENGINE.render_overlay(img, res, layers=set(layers), locale=locale)
    except ImageMismatchError:
        raise ApiError("image_mismatch", "the image is not the result's reference image") from None
    return _jpeg(rgb)


def task_build_report(frontal: dict[str, Any], profile: dict[str, Any] | None, locale: str) -> dict[str, Any]:
    """The report's user view, with considerations from the rules this worker's engine loaded."""
    from facescan import InvalidInputError

    front = _result_model("frontal", frontal)
    prof = _result_model("profile", profile) if profile is not None else None
    try:
        report = _ENGINE.build_report(front, prof)
    except InvalidInputError as exc:
        msg = str(exc)
        if "subject_mismatch" in msg:
            raise ApiError("subject_mismatch", "the frontal and profile results belong to different subjects") from None
        if "stale_result" in msg:
            raise ApiError("token_stale", "a result was produced by a different core or configuration") from None
        raise ApiError("invalid_request", "a report cannot be built from these results") from None
    return _ENGINE.user_view(report, locale=locale)


def _noop() -> None:
    return None


# ================================================================================= web side


@dataclass
class _PoolState:
    reports: int = 0
    info: WorkerInfo | None = None
    error: str | None = None
    inconsistent: bool = False


class WorkerPool:
    """Pebble process pool with readiness tracking, a bounded queue and error mapping."""

    def __init__(self, cfg: WorkerConfig, *, workers: int, max_tasks: int, queue_capacity: int, require_raqm: bool,
                 engine_factory: Callable[[WorkerConfig], Any] = default_engine_factory) -> None:
        self.cfg = cfg
        self.workers = workers
        self.max_tasks = max_tasks
        self.capacity = workers + queue_capacity
        self.require_raqm = require_raqm
        self._factory = engine_factory
        self._state = _PoolState()
        self._lock = threading.Lock()
        self._pending = 0
        self._futures: set[Any] = set()   # scheduled, unfinished pebble futures
        self._terminate_lock = threading.Lock()
        self._terminated = False
        self._pool: pebble.ProcessPool | None = None
        self._ready_q: Any = None
        self._listener: threading.Thread | None = None
        self._stopping = threading.Event()

    # ----------------------------------------------------------------- lifecycle

    def start(self) -> None:
        ctx = multiprocessing.get_context("spawn")   # never fork a process with running threads
        self._ready_q = ctx.Queue()
        self._pool = pebble.ProcessPool(max_workers=self.workers, max_tasks=self.max_tasks,
                                        initializer=_init_worker,
                                        initargs=(self._factory, self.cfg, self._ready_q), context=ctx)
        self._listener = threading.Thread(target=self._listen, name="worker-ready-listener", daemon=True)
        self._listener.start()
        self._pool.schedule(_noop)   # pebble starts its workers on the first task

    def stop(self, grace_s: float = 10.0) -> None:
        self._stopping.set()
        if self._pool is not None:
            if self._state.error is None:
                self._pool.close()   # finish running tasks (uvicorn has already drained requests)
            self._terminate(grace_s)
        if self._listener is not None:
            self._listener.join(timeout=2)
        if self._ready_q is not None:
            self._ready_q.close()
            self._ready_q.join_thread()

    def _terminate(self, grace_s: float = 0.0) -> None:
        """Join the pool exactly once (pebble's worker cleanup is not safe to run concurrently), then
        answer requests whose tasks the stopped pool left pending. Called at shutdown and after a
        start failure, possibly from two threads at once."""
        with self._terminate_lock:
            if not self._terminated:
                assert self._pool is not None
                try:
                    self._pool.join(timeout=grace_s)       # CLOSED: waits for the queue to drain
                except TimeoutError:
                    self._pool.stop()
                    self._pool.join()
                except RuntimeError:                       # still RUNNING: never started any task
                    self._pool.stop()
                    self._pool.join()
                self._terminated = True
        self._fail_outstanding()

    def _fail_outstanding(self) -> None:
        """A stopped pebble pool leaves its futures pending forever: answer their requests with 503."""
        with self._lock:
            futures = list(self._futures)
        for f in futures:
            if not f.done():
                try:
                    f.set_exception(retry_after("not_ready", 5, "the analysis workers stopped"))
                except Exception:   # finished meanwhile
                    pass

    def _listen(self) -> None:
        while not self._stopping.is_set():
            try:
                msg = self._ready_q.get(timeout=0.2)
            except queue.Empty:
                continue
            except (EOFError, OSError, ValueError):
                return
            self._on_report(msg)

    def _on_report(self, msg: dict[str, Any]) -> None:
        with self._lock:
            st = self._state
            if "error" in msg:
                # A worker that cannot start will not start on retry either (models, config):
                # stop instead of letting the pool respawn it forever. /readyz stays 503.
                first = st.error is None
                st.error = msg["error"]
                log.error("an analysis worker failed to start: %s", msg["error"])
                if first and self._pool is not None:
                    self._pool.stop()   # the pool manager stops respawning workers
                    threading.Thread(target=self._terminate, name="worker-pool-stop", daemon=True).start()
                return
            info: WorkerInfo = msg["info"]
            if st.info is not None and (info.core_version, info.schema_version, info.config_hash, info.rules) != (
                    st.info.core_version, st.info.schema_version, st.info.config_hash, st.info.rules):
                st.inconsistent = True
                log.error("the analysis workers disagree on their versions, configuration or rules")
            st.info = st.info or info
            st.reports += 1
            if st.reports == self.workers:
                log.info("%d analysis workers ready: core %s, rules %s%s, RAQM %s", self.workers,
                         info.core_version, info.rules["rules_version"],
                         " (illustrative example rules)" if info.rules["example"] else "", info.raqm)

    # ----------------------------------------------------------------- state

    @property
    def ready(self) -> bool:
        st = self._state
        return (st.error is None and not st.inconsistent and st.info is not None and st.reports >= self.workers
                and (st.info.raqm or not self.require_raqm))

    def info(self) -> WorkerInfo:
        """Versions, client config and layers reported by the workers (503 until ready)."""
        if not self.ready or self._state.info is None:
            raise retry_after("not_ready", 5, "the analysis workers are starting")
        return self._state.info

    @property
    def failed(self) -> bool:
        """A worker could not start: the service cannot recover without a restart."""
        return self._state.error is not None

    @property
    def pending(self) -> int:
        return self._pending

    # ----------------------------------------------------------------- tasks

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        """Reserve a place in the bounded queue (event loop thread only); 503 when not ready or full."""
        if not self.ready or self._pool is None:
            raise retry_after("not_ready", 5, "the analysis workers are not ready")
        if self._pending >= self.capacity:
            raise retry_after("overloaded", 2, "all analysis workers are busy; retry shortly")
        self._pending += 1
        try:
            yield
        finally:
            self._pending -= 1

    async def run(self, task: str, fn: Callable[..., Any], *args: Any, timeout: float) -> Any:
        """Run ``fn(*args)`` in a worker, inside a ``slot()``."""
        if self._pool is None or self.failed:
            raise retry_after("not_ready", 5, "the analysis workers are not ready")
        try:
            try:
                future = self._pool.schedule(fn, args=args, timeout=timeout)
            except RuntimeError:
                raise retry_after("not_ready", 5, "the analysis workers are not available") from None
            with self._lock:
                self._futures.add(future)
            try:
                return await asyncio.wrap_future(future)
            finally:
                with self._lock:
                    self._futures.discard(future)
        except (FutureTimeoutError, TimeoutError):
            raise ApiError("analysis_timeout", f"the {task} task exceeded its {timeout:g} s limit") from None
        except pebble.ProcessExpired:
            raise ApiError("internal_error", "the analysis worker stopped unexpectedly") from None
