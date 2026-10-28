"""Stateless result tokens.

A token is base64url-encoded, zlib-compressed JSON::

    {kind, session_id, result}

``result`` is the full core result, subject and versions included; responses show only
its ``user_view``. Opening a token checks that it decodes to a payload of this shape,
then that its result comes from the running core, schema and configuration version
(``token_stale`` otherwise: the app analyzes the photo again).
"""

from __future__ import annotations

import base64
import binascii
import json
import zlib
from dataclasses import dataclass
from typing import Any

from facescan_api.errors import ApiError

KINDS = ("frontal", "profile")
MAX_PAYLOAD_BYTES = 16 * 1024 * 1024   # decompressed; payloads are ~50 kB in practice
_VERSION_FIELDS = ("core_version", "schema_version", "config_hash")


@dataclass(frozen=True)
class Versions:
    """What a token's result must match to be current: the running core, schema and configuration."""

    core: str
    schema: str
    config_hash: str


@dataclass(frozen=True)
class TokenPayload:
    kind: str
    session_id: str
    result: dict[str, Any]


def seal(*, kind: str, session_id: str, result: dict[str, Any]) -> str:
    if kind not in KINDS:
        raise ValueError(f"unknown token kind {kind!r}")
    payload = {"kind": kind, "session_id": session_id, "result": result}
    data = zlib.compress(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), 6)
    return base64.urlsafe_b64encode(data).decode("ascii")


def open_token(token: Any, *, versions: Versions, max_chars: int) -> TokenPayload:
    if not isinstance(token, str) or not token or len(token) > max_chars:
        raise ApiError("token_invalid", "result token is malformed")
    try:
        d = zlib.decompressobj()
        raw = d.decompress(base64.b64decode(token.encode("ascii"), altchars=b"-_", validate=True), MAX_PAYLOAD_BYTES)
        if d.unconsumed_tail or d.unused_data or not d.eof:
            raise ValueError("payload too large, truncated or followed by other data")
        p = json.loads(raw.decode("utf-8"))
        payload = TokenPayload(kind=p["kind"], session_id=p["session_id"], result=p["result"])
    except (binascii.Error, zlib.error, ValueError, KeyError, TypeError, UnicodeError):
        raise ApiError("token_invalid", "result token cannot be read") from None
    result = payload.result
    if (payload.kind not in KINDS or not isinstance(payload.session_id, str) or not isinstance(result, dict)
            or not isinstance(result.get("subject"), dict)
            or not all(isinstance(result.get(f), str) for f in _VERSION_FIELDS)):
        raise ApiError("token_invalid", "result token cannot be read")
    if tuple(result[f] for f in _VERSION_FIELDS) != (versions.core, versions.schema, versions.config_hash):
        raise ApiError("token_stale", "result token was issued by a different core or configuration version; "
                                      "analyze again")
    return payload
