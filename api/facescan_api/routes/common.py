"""Shared route steps: the rate limit, tokens, overlay layers and responses."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from facescan_api._version import __version__
from facescan_api.errors import ApiError
from facescan_api.ratelimit import RateLimiter
from facescan_api.settings import Settings
from facescan_api.tokens import TokenPayload, Versions, open_token, seal
from facescan_api.workers import WorkerInfo, WorkerPool


@dataclass
class ApiState:
    settings: Settings
    pool: WorkerPool
    limiter: RateLimiter


def api_state(request: Request) -> ApiState:
    return request.app.state.api


async def rate_limit(request: Request) -> None:
    """Router dependency: requests per client address per minute."""
    api_state(request).limiter.hit(request.client.host if request.client else "unknown")


def versions(info: WorkerInfo) -> dict[str, str]:
    return {"api": __version__, "core": info.core_version, "schema": info.schema_version}


def read_token(api: ApiState, token: str, info: WorkerInfo, kind: str | None = None) -> TokenPayload:
    """Open a result token issued by the running core and configuration; ``kind`` must match when given."""
    payload = open_token(token, versions=Versions(core=info.core_version, schema=info.schema_version,
                                                  config_hash=info.config_hash),
                         max_chars=api.settings.max_token_chars)
    if kind is not None and payload.kind != kind:
        raise ApiError("token_invalid", f"expected a {kind} result token")
    return payload


def check_layers(layers: list[str], info: WorkerInfo) -> list[str]:
    unknown = [layer for layer in layers if layer not in info.layers]
    if unknown:
        raise ApiError("invalid_meta", f"unknown overlay layer; available: {', '.join(info.layers)}")
    return list(layers)


def report_response(request: Request, view: dict[str, Any], *, info: WorkerInfo) -> JSONResponse:
    return JSONResponse({"request_id": request.scope["state"]["request_id"], "status": view["status"],
                         "report": view, "versions": versions(info)})


def analysis_response(request: Request, out: dict[str, Any], *, kind: str, session_id: str,
                      info: WorkerInfo) -> JSONResponse:
    """Analyze / adjust response: status and hints always; the user view and a token only for ``ok``."""
    result, view = out["result"], out["view"]
    status = result["status"]
    quality = result.get("quality") or {}
    body: dict[str, Any] = {
        "request_id": request.scope["state"]["request_id"],
        "status": status,
        "failed_checks": [c["id"] for c in quality.get("checks", []) if c.get("status") == "fail"],
        "hints": list(view.get("hints", [])),
        "warnings": list(quality.get("warnings", [])),
    }
    if status == "ok":
        body["result"] = view
        body["result_token"] = seal(kind=kind, session_id=session_id, result=result)
    if out["overlay"] is not None:
        body["overlay"] = "data:image/jpeg;base64," + base64.b64encode(out["overlay"]).decode("ascii")
    body["versions"] = versions(info)
    return JSONResponse(body)
