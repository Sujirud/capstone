"""Readiness (not rate-limited)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from facescan_api.errors import retry_after
from facescan_api.openapi import problems
from facescan_api.routes.common import api_state
from facescan_api.schemas import ReadyResponse

router = APIRouter()


@router.get("/readyz", response_model=ReadyResponse, summary="Readiness",
            description="Ready once every worker has created its engine and run the warm-up analysis, and RAQM "
                        "(Thai text in overlays) is available.",
            responses=problems("not_ready"))
async def readyz(request: Request) -> dict[str, object]:
    pool = api_state(request).pool
    if not pool.ready:
        raise retry_after("not_ready", 5, "the analysis workers are not ready")
    return {"status": "ready", "workers": pool.workers}
