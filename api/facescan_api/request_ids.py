"""Request ids and the last-resort error answer.

Every response carries ``X-Request-ID``, and problem details repeat it as ``request_id``;
the web app shows it in small type. Unexpected errors are logged with their traceback.
"""

from __future__ import annotations

import json
import logging
import secrets
import time

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from facescan_api.errors import PROBLEM_MEDIA_TYPE, ApiError

log = logging.getLogger("facescan_api")


def new_request_id() -> str:
    """Time-ordered: ``req_`` + ms timestamp (hex) + 64 random bits."""
    return f"req_{int(time.time() * 1000):011x}{secrets.token_hex(8)}"


class RequestIdMiddleware:
    """Outermost middleware: the request id, and a problem answer for anything unhandled."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        rid = new_request_id()
        scope.setdefault("state", {})["request_id"] = rid
        response_started = False

        async def send_wrapper(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                MutableHeaders(scope=message)["X-Request-ID"] = rid
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("unhandled error in request %s", rid)
            if not response_started:
                err = ApiError("internal_error", "unexpected error; see the logs for this request id")
                await send_wrapper({"type": "http.response.start", "status": err.status,
                                    "headers": [(b"content-type", PROBLEM_MEDIA_TYPE.encode())]})
                await send_wrapper({"type": "http.response.body",
                                    "body": json.dumps(err.problem(rid), ensure_ascii=False).encode("utf-8")})
