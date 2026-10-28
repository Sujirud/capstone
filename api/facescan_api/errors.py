"""Problem-details errors (RFC 9457) with stable codes.

Analysis outcomes (``no_face``, ``quality_failed`` …) are ``200`` responses with a
``status``; everything else is an ``ApiError`` rendered as
``application/problem+json``. ``detail`` is developer-facing English; the app maps
``code`` to its own localized text.

``ApiError`` is also raised inside worker processes and pickled back, so its
constructor arguments are its only state.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Mapping

PROBLEM_MEDIA_TYPE = "application/problem+json"

# code → HTTP status. ``not_found`` / ``method_not_allowed`` cover unknown routes.
CODES: dict[str, int] = {
    "invalid_request": 400,
    "subject_mismatch": 400,
    "session_mismatch": 400,
    "token_invalid": 400,
    "token_stale": 400,
    "not_found": 404,
    "method_not_allowed": 405,
    "payload_too_large": 413,
    "unsupported_media_type": 415,
    "invalid_meta": 422,
    "too_many_pixels": 422,
    "frame_size_mismatch": 422,
    "image_mismatch": 422,
    "point_not_adjustable": 422,
    "rate_limited": 429,
    "internal_error": 500,
    "overloaded": 503,
    "not_ready": 503,
    "analysis_timeout": 504,
}


class ApiError(Exception):
    """An error response with a stable ``code`` and a developer-facing ``detail``."""

    def __init__(self, code: str, detail: str | None = None, headers: Mapping[str, str] | None = None) -> None:
        if code not in CODES:
            raise ValueError(f"unknown error code {code!r}")
        super().__init__(code, detail, dict(headers) if headers else None)
        self.code = code
        self.status = CODES[code]
        self.detail = detail or HTTPStatus(self.status).phrase
        self.headers = dict(headers) if headers else {}

    def problem(self, request_id: str | None) -> dict[str, object]:
        return {
            "type": "about:blank",
            "title": HTTPStatus(self.status).phrase,
            "status": self.status,
            "detail": self.detail,
            "code": self.code,
            "request_id": request_id,
        }


def retry_after(code: str, seconds: int, detail: str | None = None) -> ApiError:
    return ApiError(code, detail, headers={"Retry-After": str(max(1, int(seconds)))})
