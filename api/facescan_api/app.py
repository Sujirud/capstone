"""App factory: middleware, error handlers, routers, and the worker pool's lifespan."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from facescan_api._version import __version__
from facescan_api.errors import PROBLEM_MEDIA_TYPE, ApiError
from facescan_api.openapi import DESCRIPTION, TITLE, build_openapi
from facescan_api.ratelimit import RateLimiter
from facescan_api.request_ids import RequestIdMiddleware
from facescan_api.routes import health, v1
from facescan_api.routes.common import ApiState
from facescan_api.settings import Settings
from facescan_api.workers import WorkerConfig, WorkerPool, default_engine_factory


def _problem(request: Request, err: ApiError) -> JSONResponse:
    request_id = request.scope.get("state", {}).get("request_id")
    return JSONResponse(err.problem(request_id), status_code=err.status, headers=err.headers,
                        media_type=PROBLEM_MEDIA_TYPE)


def create_app(settings: Settings | None = None, *, engine_factory: Callable[[WorkerConfig], Any] | None = None,
               clock: Callable[[], float] = time.time) -> FastAPI:
    """Build the app. Tests pass a fake ``engine_factory`` and a ``clock`` for the rate limit."""
    settings = settings if settings is not None else Settings()
    pool = WorkerPool(
        WorkerConfig(models_dir=str(settings.models_dir), norms_profile=settings.norms_profile,
                     max_pixels=settings.max_pixels, max_burst_pixels=settings.max_burst_pixels,
                     overlay_max_side=settings.overlay_max_side, overlay_jpeg_quality=settings.overlay_jpeg_quality,
                     rules_path=str(settings.rules_path)),
        workers=settings.workers, max_tasks=settings.worker_max_tasks, queue_capacity=settings.queue_capacity,
        require_raqm=settings.require_raqm, engine_factory=engine_factory or default_engine_factory)
    api = ApiState(settings=settings, pool=pool, limiter=RateLimiter(settings.rate_limit_ip_per_minute, clock=clock))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        logging.getLogger("facescan_api").info("API %s starting %d analysis workers", __version__, settings.workers)
        pool.start()
        try:
            yield
        finally:
            await run_in_threadpool(pool.stop)

    app = FastAPI(title=TITLE, version=__version__, description=DESCRIPTION, lifespan=lifespan)
    app.state.api = api

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _problem(request, exc)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return _problem(request, ApiError("invalid_request", "invalid request parameters"))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(
            exc.status_code, "invalid_request" if exc.status_code < 500 else "internal_error")
        headers = {k: v for k, v in (exc.headers or {}).items() if k.lower() == "allow"}
        return _problem(request, ApiError(code, None, headers=headers))

    app.include_router(health.router)
    app.include_router(v1.router)
    app.add_middleware(RequestIdMiddleware)   # outermost: sees every response
    app.openapi = lambda: build_openapi(app)  # type: ignore[method-assign]
    return app
