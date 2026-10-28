"""OpenAPI document: generated from the routes and ``schemas.py``.

Bodies that the service parses itself (streamed multipart, size-limited JSON) are
described here, along with problem responses. The committed ``openapi.json`` must
equal ``python -m facescan_api.openapi`` (snapshot test).
"""

from __future__ import annotations

import json
import sys
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel

from facescan_api._version import __version__
from facescan_api.errors import CODES, PROBLEM_MEDIA_TYPE
from facescan_api.schemas import (
    AdjustRequest, FrontalAnalyzeMeta, OverlayMeta, Problem, ProfileAnalyzeMeta, ReportRequest,
)

TITLE = "Facial Analysis API"
DESCRIPTION = (
    "HTTP service around the `facescan` core. Stateless: results travel back to the client in result tokens "
    "(compressed JSON) that later calls send back. Frontal and profile analysis, adjustments, overlays, and "
    "reports with considerations from the rules file. Errors are RFC 9457 problem details with a stable `code`."
)
_PROBLEM_REF = {"$ref": "#/components/schemas/Problem"}
_EXTRA_MODELS: tuple[type[BaseModel], ...] = (
    FrontalAnalyzeMeta, ProfileAnalyzeMeta, OverlayMeta, AdjustRequest, ReportRequest, Problem)


def problems(*codes: str) -> dict[int | str, dict[str, Any]]:
    """Problem responses grouped by HTTP status, with the codes each status can carry."""
    by_status: dict[int, list[str]] = {}
    for c in codes:
        by_status.setdefault(CODES[c], []).append(c)
    out: dict[int | str, dict[str, Any]] = {}
    for status, cs in sorted(by_status.items()):
        out[status] = {
            "description": f"{HTTPStatus(status).phrase}: " + ", ".join(f"`{c}`" for c in cs),
            "content": {PROBLEM_MEDIA_TYPE: {"schema": _PROBLEM_REF, "example": {
                "type": "about:blank", "title": HTTPStatus(status).phrase, "status": status,
                "detail": "…", "code": cs[0], "request_id": "req_0192f3a4b5c6d7e8f9a0b1c2d3"}}},
        }
    return out


def multipart_body(meta: type[BaseModel], files: dict[str, dict[str, Any]], example_files: dict[str, Any]
                   ) -> dict[str, Any]:
    props: dict[str, Any] = dict(files)
    props["meta"] = {"$ref": f"#/components/schemas/{meta.__name__}"}
    return {"requestBody": {"required": True, "content": {"multipart/form-data": {
        "schema": {"type": "object", "required": [*files, "meta"], "properties": props},
        "encoding": {"meta": {"contentType": "application/json"},
                     **{name: {"contentType": "image/jpeg, image/png, image/webp"} for name in files}},
        "example": {**example_files, "meta": meta.model_json_schema()["examples"][0]},
    }}}}


def json_body(model: type[BaseModel]) -> dict[str, Any]:
    return {"requestBody": {"required": True, "content": {"application/json": {
        "schema": {"$ref": f"#/components/schemas/{model.__name__}"},
        "example": model.model_json_schema()["examples"][0],
    }}}}


def build_openapi(app: FastAPI) -> dict[str, Any]:
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=TITLE, version=__version__, description=DESCRIPTION, routes=app.routes)
    components = schema.setdefault("components", {})
    schemas = components.setdefault("schemas", {})
    for model in _EXTRA_MODELS:
        js = model.model_json_schema(ref_template="#/components/schemas/{model}")
        for name, sub in js.pop("$defs", {}).items():
            schemas.setdefault(name, sub)
        schemas[model.__name__] = js
    # Inline each JSON response's example (from its model) so every endpoint shows one.
    for ops in schema["paths"].values():
        for op in ops.values():
            for resp in op.get("responses", {}).values():
                media = resp.get("content", {}).get("application/json")
                ref = (media or {}).get("schema", {}).get("$ref", "")
                examples = schemas.get(ref.rsplit("/", 1)[-1], {}).get("examples")
                if media is not None and examples and "example" not in media:
                    media["example"] = examples[0]
    schema["components"] = {k: components[k] for k in sorted(components)}
    schema["components"]["schemas"] = {k: schemas[k] for k in sorted(schemas)}
    app.openapi_schema = schema
    return schema


def render(app: FastAPI) -> str:
    return json.dumps(build_openapi(app), indent=2, ensure_ascii=False) + "\n"


def export_app() -> FastAPI:
    """An app built only to render the document: routes do not depend on settings."""
    from facescan_api.app import create_app

    return create_app()


def main() -> int:
    sys.stdout.write(render(export_app()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
