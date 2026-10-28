"""Result tokens: round trip, unreadable tokens, kinds, staleness, size."""

from __future__ import annotations

import base64
import json
import zlib

import pytest

from facescan_api.errors import ApiError
from facescan_api.tokens import Versions, open_token, seal

V = Versions(core="0.1.0", schema="2.0", config_hash="sha256:abc")
RESULT = {"status": "ok", "subject": {"sex": "female", "age": 28}, "metrics": {"F1": {"value": 0.33}}, "text": "ไทย",
          "core_version": "0.1.0", "schema_version": "2.0", "config_hash": "sha256:abc"}


def opened(token: object, versions: Versions = V, max_chars: int = 512 * 1024):
    return open_token(token, versions=versions, max_chars=max_chars)


def code_of(fn) -> str:
    with pytest.raises(ApiError) as e:
        fn()
    return e.value.code


def encode(payload: object) -> str:
    return base64.urlsafe_b64encode(zlib.compress(json.dumps(payload).encode())).decode()


def test_round_trip_keeps_the_full_result():
    token = seal(kind="frontal", session_id="s-1", result=RESULT)
    p = opened(token)
    assert (p.kind, p.session_id, p.result) == ("frontal", "s-1", RESULT)
    assert token.isascii() and "ไทย" not in token                 # compressed, safe in JSON and URLs


def test_unreadable_tokens_are_invalid():
    token = seal(kind="frontal", session_id="s-1", result=RESULT)
    for bad in ("", "x", token[: len(token) // 2], token + "AAAA", "ไทย", 123, None,
                encode([1, 2]), encode({"kind": "frontal", "session_id": "s"}),
                encode({"kind": "report", "session_id": "s", "result": RESULT}),
                encode({"kind": "frontal", "session_id": 5, "result": RESULT}),
                encode({"kind": "frontal", "session_id": "s", "result": {**RESULT, "subject": None}}),
                encode({"kind": "frontal", "session_id": "s", "result": {**RESULT, "config_hash": 1}})):
        assert code_of(lambda bad=bad: opened(bad)) == "token_invalid", bad


@pytest.mark.parametrize("changed", [
    Versions(core="0.2.0", schema="2.0", config_hash="sha256:abc"),
    Versions(core="0.1.0", schema="2.1", config_hash="sha256:abc"),
    Versions(core="0.1.0", schema="2.0", config_hash="sha256:def"),
])
def test_stale_versions_are_rejected(changed):
    token = seal(kind="profile", session_id="s-1", result=RESULT)
    assert code_of(lambda: opened(token, versions=changed)) == "token_stale"


def test_oversized_tokens_are_rejected_before_decoding():
    assert code_of(lambda: opened("A" * 4096, max_chars=2048)) == "token_invalid"


def test_unknown_kinds_are_not_sealed():
    with pytest.raises(ValueError):
        seal(kind="report", session_id="s", result=RESULT)
