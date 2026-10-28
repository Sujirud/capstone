"""Reports with considerations, with the fake engine."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from facescan_api.tokens import Versions, open_token, seal
from tests.conftest import analyze, image_bytes, make_settings
from tests.fake_engine import BLUE, CLINIC_ONLY_SENTINEL, CONFIG_HASH

V = Versions(core="0.1.0", schema="2.0", config_hash=CONFIG_HASH)
PROFILE_IMG = image_bytes((180, 140, 110), size=(80, 100))


def problem(r: Any) -> tuple[int, str]:
    assert r.headers["content-type"] == "application/problem+json", r.text
    return r.status_code, r.json()["code"]


def frontal(client: TestClient) -> str:
    b = analyze(client).json()
    assert b["status"] == "ok", b
    return b["result_token"]


def profile(client: TestClient, meta: dict[str, Any]) -> str:
    r = client.post("/v1/profile/analyze", files=[("image", ("p.png", PROFILE_IMG, "image/png")),
                                                  ("meta", (None, json.dumps(meta), "application/json"))])
    assert r.json()["status"] == "ok", r.text
    return r.json()["result_token"]


def report(client: TestClient, body: dict[str, Any]) -> Any:
    return client.post("/v1/report", json=body)


def test_report_for_a_session(client: TestClient):
    ftok = frontal(client)
    ptok = profile(client, {"facing": "left", "frontal_token": ftok})
    r = report(client, {"frontal_token": ftok, "profile_token": ptok, "locale": "en"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert set(b) == {"request_id", "status", "report", "versions"}          # no token
    rep = b["report"]
    assert b["status"] == rep["status"] == "ok" and rep["locale"] == "en"
    assert rep["frontal"]["view"] == "frontal" and rep["profile"]["view"] == "profile"
    assert rep["rules_version"] == "FAKE-1"
    [c] = rep["considerations"]
    assert c["finding"] and not c["finding"].startswith("finding.") and c["consult"]
    [m] = c["measurements"]
    assert m["id"] == "P2_nasolabial_angle" and m["status"] == "below"
    assert m["reference"]["min"] == 90.0 and m["reference"]["max"] == 105.0    # shown with its range
    assert rep["disclaimer"] and rep["no_considerations_note"] is None
    # The user view: no rule audit, no rules hash, no clinic-only metrics.
    assert "rule_audit" not in rep and "rules_hash" not in rep
    assert "F10_golden_ratio" not in rep["frontal"]["metrics"] and str(CLINIC_ONLY_SENTINEL) not in r.text


def test_frontal_only_report(client: TestClient):
    rep = report(client, {"frontal_token": frontal(client)}).json()["report"]
    assert rep["profile"] is None and rep["locale"] == "th"
    [m] = rep["considerations"][0]["measurements"]
    assert m["id"] == "F6_alar_icd_ratio" and m["reference"]["text"]


def test_tokens_must_share_the_session(client: TestClient):
    ftok = frontal(client)
    other_session = profile(client, {"facing": "left", "subject": {"sex": "female", "age": 28}})
    assert problem(report(client, {"frontal_token": ftok, "profile_token": other_session})) \
        == (400, "session_mismatch")
    second_frontal = frontal(client)
    same_session_profile = profile(client, {"facing": "left", "frontal_token": second_frontal})
    assert problem(report(client, {"frontal_token": ftok, "profile_token": same_session_profile})) \
        == (400, "session_mismatch")
    # An adjusted frontal token keeps its session, so it pairs with the profile made from it.
    adj = client.post("/v1/adjust", json={"result_token": second_frontal,
                                          "overrides": {"trichion": {"x": 30.0, "y": 3.0}}}).json()
    assert report(client, {"frontal_token": adj["result_token"], "profile_token": same_session_profile}).status_code == 200


def test_token_kinds_and_staleness(client: TestClient):
    ftok = frontal(client)
    ptok = profile(client, {"facing": "left", "frontal_token": ftok})
    assert problem(report(client, {"frontal_token": ptok})) == (400, "token_invalid")
    assert problem(report(client, {"frontal_token": ftok, "profile_token": ftok})) == (400, "token_invalid")
    result = open_token(ftok, versions=V, max_chars=512 * 1024).result
    stale = seal(kind="frontal", session_id="s", result={**result, "config_hash": "sha256:old"})
    assert problem(report(client, {"frontal_token": stale})) == (400, "token_stale")


def test_request_validation(client: TestClient):
    ftok = frontal(client)
    for body in ({}, {"profile_token": ftok}, {"frontal_token": ftok, "locale": "de"},
                 {"frontal_token": ftok, "extra": 1}, {"frontal_token": 5}):
        assert problem(report(client, body)) == (400, "invalid_request"), body
    r = client.post("/v1/report", content=b"{}")
    assert problem(r) == (415, "unsupported_media_type")


def test_failed_capture_tokens_cannot_exist(client: TestClient):
    """Reports are built only from tokens, and tokens exist only for ok results."""
    b = analyze(client, frames=[image_bytes(BLUE)]).json()
    assert b["status"] == "quality_failed" and "result_token" not in b


def test_a_missing_rules_file_is_refused_in_settings(tmp_path):
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="not a file"):
        make_settings(rules_path=tmp_path / "missing.yaml")
