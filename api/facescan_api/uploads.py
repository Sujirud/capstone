"""Streaming request parsing with limits.

Multipart bodies are parsed incrementally (``python-multipart``) into memory. The
``Content-Length`` is checked before reading, and bytes are counted while streaming,
so an oversized body is refused without being read in full. Unknown parts, duplicate
fields and truncated bodies are rejected. Image types are checked by magic bytes; the
images themselves are decoded only in worker processes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Mapping, TypeVar

from pydantic import BaseModel, ValidationError
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.requests import ClientDisconnect, Request

from facescan_api.errors import ApiError

M = TypeVar("M", bound=BaseModel)


@dataclass
class MultipartForm:
    files: dict[str, list[bytearray]] = field(default_factory=dict)   # the parse buffers themselves (no copies)
    fields: dict[str, bytearray] = field(default_factory=dict)


def image_type(data: bytes | bytearray) -> str | None:
    """``jpeg`` / ``png`` / ``webp`` from the magic bytes, else None."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def require_image(data: bytes | bytearray, what: str) -> None:
    if image_type(data) is None:
        raise ApiError("unsupported_media_type", f"{what} is not a JPEG, PNG or WebP image")


def _check_length(request: Request, limit: int) -> None:
    value = request.headers.get("content-length")
    if value is None:
        return
    if not value.isdigit():
        raise ApiError("invalid_request", "invalid Content-Length")
    if int(value) > limit:
        raise ApiError("payload_too_large", f"request body exceeds {limit} bytes")


async def _chunks(request: Request) -> AsyncIterator[bytes]:
    try:
        async for chunk in request.stream():
            yield chunk
    except ClientDisconnect:   # common on mobile networks; not a server error
        raise ApiError("invalid_request", "the client disconnected during the upload") from None


async def read_multipart(request: Request, *, files: Mapping[str, int], fields: set[str], max_request_bytes: int,
                         max_file_bytes: int, max_field_bytes: int) -> MultipartForm:
    """Parse ``multipart/form-data``. ``files`` maps part name → maximum count; ``fields`` are single text parts."""
    ctype, params = parse_options_header(request.headers.get("content-type", ""))
    if ctype != b"multipart/form-data":
        raise ApiError("unsupported_media_type", "expected multipart/form-data")
    boundary = params.get(b"boundary")
    if not boundary or len(boundary) > 200:
        raise ApiError("invalid_request", "multipart boundary missing or too long")
    _check_length(request, max_request_bytes)

    form = MultipartForm()
    st: dict[str, object] = {"headers": {}, "hname": b"", "hvalue": b"", "name": None, "buf": None, "limit": 0,
                             "ended": False}

    def on_part_begin() -> None:
        st.update(headers={}, hname=b"", hvalue=b"", name=None, buf=None)

    def on_header_field(data: bytes, start: int, end: int) -> None:
        st["hname"] = st["hname"] + data[start:end]  # type: ignore[operator]

    def on_header_value(data: bytes, start: int, end: int) -> None:
        st["hvalue"] = st["hvalue"] + data[start:end]  # type: ignore[operator]

    def on_header_end() -> None:
        st["headers"][st["hname"].lower()] = st["hvalue"]  # type: ignore[index, union-attr]
        st.update(hname=b"", hvalue=b"")

    def on_headers_finished() -> None:
        disp, opts = parse_options_header(st["headers"].get(b"content-disposition", b""))  # type: ignore[union-attr]
        name = opts.get(b"name", b"").decode("utf-8", "replace")
        if disp != b"form-data" or not name:
            raise ApiError("invalid_request", "each part needs Content-Disposition: form-data with a name")
        if name in files:
            if len(form.files.get(name, [])) >= files[name]:
                raise ApiError("payload_too_large", f"at most {files[name]} '{name}' part(s) are accepted")
            st["limit"] = max_file_bytes
        elif name in fields:
            if name in form.fields:
                raise ApiError("invalid_request", f"'{name}' was sent more than once")
            st["limit"] = max_field_bytes
        else:
            raise ApiError("invalid_request", "unknown multipart part")
        st.update(name=name, buf=bytearray())

    def on_part_data(data: bytes, start: int, end: int) -> None:
        buf: bytearray = st["buf"]  # type: ignore[assignment]
        if len(buf) + (end - start) > st["limit"]:  # type: ignore[operator]
            raise ApiError("payload_too_large", f"a '{st['name']}' part exceeds {st['limit']} bytes")
        buf += data[start:end]

    def on_part_end() -> None:
        name: str = st["name"]  # type: ignore[assignment]
        data: bytearray = st["buf"]  # type: ignore[assignment]
        if name in files:
            form.files.setdefault(name, []).append(data)
        else:
            form.fields[name] = data
        st.update(name=None, buf=None)

    def on_end() -> None:
        st["ended"] = True

    parser = MultipartParser(boundary, {
        "on_part_begin": on_part_begin, "on_header_field": on_header_field, "on_header_value": on_header_value,
        "on_header_end": on_header_end, "on_headers_finished": on_headers_finished, "on_part_data": on_part_data,
        "on_part_end": on_part_end, "on_end": on_end,
    }, max_header_count=8, max_header_size=4096)
    total = 0
    try:
        async for chunk in _chunks(request):
            total += len(chunk)
            if total > max_request_bytes:
                raise ApiError("payload_too_large", f"request body exceeds {max_request_bytes} bytes")
            if chunk:
                parser.write(chunk)
        parser.finalize()
    except MultipartParseError:
        raise ApiError("invalid_request", "malformed multipart body") from None
    if not st["ended"]:
        raise ApiError("invalid_request", "incomplete multipart body")
    return form


async def read_json(request: Request, model: type[M], *, max_bytes: int) -> M:
    """A JSON body validated strictly by ``model`` (400 ``invalid_request`` on any problem)."""
    ctype, _ = parse_options_header(request.headers.get("content-type", ""))
    if ctype != b"application/json":
        raise ApiError("unsupported_media_type", "expected application/json")
    _check_length(request, max_bytes)
    body = bytearray()
    async for chunk in _chunks(request):
        body += chunk
        if len(body) > max_bytes:
            raise ApiError("payload_too_large", f"request body exceeds {max_bytes} bytes")
    try:
        return model.model_validate_json(bytes(body))
    except ValidationError as exc:
        raise ApiError("invalid_request", validation_summary(exc)) from None


def parse_meta(model: type[M], raw: bytes | bytearray | None) -> M:
    """The multipart ``meta`` part (422 ``invalid_meta`` on any problem)."""
    if raw is None:
        raise ApiError("invalid_meta", "the 'meta' part is required")
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        raise ApiError("invalid_meta", validation_summary(exc)) from None


def validation_summary(exc: ValidationError) -> str:
    """Field locations and error types only, never the input values (the detail goes back to the client)."""
    parts = []
    for e in exc.errors(include_url=False, include_input=False)[:10]:
        loc = ".".join(str(p) for p in e.get("loc", ())) or "body"
        parts.append(f"{loc}: {e.get('type')}")
    return "invalid fields: " + "; ".join(parts)
