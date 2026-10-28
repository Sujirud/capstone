"""OpenAPI contract: the generated document equals the committed ``openapi.json``."""

from __future__ import annotations

import json
import re
from pathlib import Path

from facescan_api.errors import CODES
from facescan_api.openapi import export_app, render

COMMITTED = Path(__file__).resolve().parent.parent / "openapi.json"


def test_generated_schema_matches_the_committed_file():
    generated = render(export_app())
    assert generated == COMMITTED.read_text(encoding="utf-8"), (
        "The API contract changed. If that is deliberate, regenerate it:\n"
        "    python -m facescan_api.openapi > openapi.json")


def test_every_endpoint_is_documented_with_examples_and_problems():
    doc = json.loads(COMMITTED.read_text(encoding="utf-8"))
    refs = set(re.findall(r'"#/components/schemas/([^"]+)"', COMMITTED.read_text(encoding="utf-8")))
    assert refs <= set(doc["components"]["schemas"])
    assert set(doc["paths"]) == {"/readyz", "/v1/client-config", "/v1/frontal/analyze", "/v1/adjust",
                                 "/v1/overlay", "/v1/profile/analyze", "/v1/report"}
    for path, ops in doc["paths"].items():
        for method, op in ops.items():
            ok = op["responses"]["200"]["content"]
            if path != "/v1/overlay":
                assert "example" in ok["application/json"], (method, path)
            for media in op.get("requestBody", {}).get("content", {}).values():
                assert "example" in media, (method, path)
            for status, resp in op["responses"].items():
                if status.startswith(("4", "5")):
                    problem = resp["content"]["application/problem+json"]
                    assert problem["schema"] == {"$ref": "#/components/schemas/Problem"}
                    assert CODES[problem["example"]["code"]] == int(status)
    # Requests reject unknown fields, so a client-supplied override source cannot slip through.
    for name in ("FrontalAnalyzeMeta", "AdjustRequest", "OverlayMeta", "PointIn", "ReportRequest", "ProfileAnalyzeMeta"):
        assert doc["components"]["schemas"][name]["additionalProperties"] is False
    assert "subject_mismatch" in doc["paths"]["/v1/profile/analyze"]["post"]["responses"]["400"]["description"]
