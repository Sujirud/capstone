# Facial Analysis API (`facescan_api`)

HTTP service that exposes the `facescan` core (in the parent directory) to the web app in
[`../web/`](../web/README.md). The core owns measurements, statuses and user-facing text;
this service owns transport, validation and the worker processes.

**Endpoint**

- `GET /v1/client-config`
- `POST /v1/frontal/analyze`
- `POST /v1/profile/analyze`
- `POST /v1/adjust` and `POST /v1/overlay` (frontal and profile)
- `POST /v1/report`
- `GET /readyz`

Reports use the rules file at `RULES_PATH`, by default the core's illustrative example
rules (`facescan/config/rules.example.yaml`, `rules_version: "EXAMPLE"`); the web app
labels their topics as illustrative.

- **Stateless:** no images, results or tokens are stored anywhere. Each `ok` result goes
  back to the client inside a **result token** (compressed JSON) that later calls send
  back.
- **Worker processes:** analysis runs in a pool of worker processes (one
  `FaceScanEngine` each) with hard timeouts. The web process never decodes images and
  never loads MediaPipe.

```
api/
  facescan_api/
    app.py            app factory: middleware, error handlers, routers, lifespan (worker pool)
    settings.py       configuration from environment variables, with defaults
    tokens.py         result tokens: encode / open, kind and staleness checks
    uploads.py        streaming multipart parsing and limits, magic bytes, strict JSON
    workers.py        pebble pool, worker warm-up, task functions, timeouts, backpressure
    routes/           v1 endpoints and readiness
    schemas.py        request / response models (source of the OpenAPI document)
    errors.py         problem+json errors and codes
    request_ids.py    request ids and the last-resort 500
    ratelimit.py      requests per client address per minute
    openapi.py        OpenAPI document; `python -m facescan_api.openapi > openapi.json`
  tests/              pytest (fake engine + real-core integration)
  examples/client_flow.py
  openapi.json        committed contract (snapshot-tested)
  requirements.in / requirements.lock (runtime, hashed), requirements-dev.in / .lock
  ASSUMPTIONS.md      decisions made where the choice was open
```

## Setup

Python 3.11+. From the repository root:

```bash
python -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r api/requirements.lock -r api/requirements-dev.lock
pip install --no-deps -e . -e api                   # the core and the service
python -m facescan.tools.download_models --dest models
```

On macOS, overlays with Thai text need FriBiDi for Pillow's RAQM:
`brew install fribidi` and `export DYLD_LIBRARY_PATH=/opt/homebrew/lib`. Otherwise
set `REQUIRE_RAQM=false`, and the Thai labels in overlays will be shaped incorrectly.

Run it from the repository root (the models are in `./models`):

```bash
python -m facescan_api            # http://127.0.0.1:8000, interactive docs at /docs
python api/examples/client_flow.py --image photo.jpg --locale en
```

The service is ready once every worker has run its warm-up analysis (`/readyz`); until
then, calls get 503 `not_ready`. The root [`README.md`](../README.md) shows how to run it
together with the web app for a demo.

## Configuration

Everything comes from environment variables, and every variable has a default. Invalid
combinations stop the service at start-up.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8000` | listener |
| `LOG_LEVEL` | `INFO` | |
| `MODELS_DIR` | `models` | MediaPipe model files |
| `NORMS_PROFILE` | `canon` | norms profile for every subject (never set by clients) |
| `RULES_PATH` | the core's `rules.example.yaml` | the rules file for reports |
| `WORKERS` | CPUs available | analysis processes |
| `WORKER_MAX_TASKS` | `200` | tasks before a worker is recycled |
| `QUEUE_SIZE` | `2 × WORKERS` | requests that may wait for a worker; beyond `WORKERS + QUEUE_SIZE` requests in flight (uploading, waiting or running) → 503 `overloaded`, before the upload is read |
| `TIMEOUT_FRONTAL_S` / `_PROFILE_S` / `_ADJUST_S` / `_OVERLAY_S` / `_REPORT_S` | `20` / `30` / `5` / `10` / `5` | hard per-task limits (the worker is killed) |
| `REQUIRE_RAQM` | `true` | readiness requires RAQM (Thai text shaping) |
| `MAX_IMAGE_BYTES` / `MAX_REQUEST_BYTES` | 12 MB / 60 MB | decimal MB |
| `MAX_JSON_BYTES` / `MAX_META_BYTES` | 1 MB / 16 kB | JSON bodies; the multipart `meta` part (plus `MAX_TOKEN_CHARS` when it carries a token) |
| `MAX_TOKEN_CHARS` | `262144` | longest accepted result token (real ones are ~8–20 kB) |
| `MAX_FRAMES` | `15` | frames per burst |
| `MAX_PIXELS` / `MAX_BURST_PIXELS` | 24 MP / 125 MP | per image (Pillow's bomb limit) / all frames of a burst |
| `OVERLAY_MAX_SIDE` / `OVERLAY_JPEG_QUALITY` | `1600` / `85` | overlay JPEGs |
| `RATE_LIMIT_IP_PER_MINUTE` | `600` | `/v1` requests per client address per minute; a class that shares one Wi-Fi address stays under it |

## Endpoints

JSON uses snake_case. Coordinates are pixels of the analyzed image after EXIF
orientation (for a burst: the reference frame named in the result). The full contract,
with examples, is [`openapi.json`](openapi.json).

```bash
API=http://127.0.0.1:8000

# Thresholds, limits and localized strings for on-device guidance (ETag, 1 h cache)
curl -s "$API/v1/client-config?locale=th"

# Frontal analysis: one photo, or 3–15 frames of identical size in capture order
curl -s "$API/v1/frontal/analyze" \
  -F frames=@frame1.jpg -F frames=@frame2.jpg -F frames=@frame3.jpg \
  -F 'meta={"subject":{"sex":"female","age":28},"camera":{"focal_px":2890.0,"source":"device"},
           "locale":"th","overlay":{"layers":["landmarks","thirds","fifths"]}};type=application/json'

# Move the hairline point (no image upload); returns a new token in the same session
curl -s -H 'Content-Type: application/json' "$API/v1/adjust" \
  -d '{"result_token":"eJy…","overrides":{"trichion":{"x":1012.5,"y":388.0}},"locale":"th"}'

# Overlay redrawn on the reference image as originally uploaded → image/jpeg
curl -s "$API/v1/overlay" -o overlay.jpg -F image=@frame2.jpg \
  -F 'meta={"result_token":"eJy…","layers":["landmarks","thirds"],"locale":"th"};type=application/json'

# Profile photo with the (latest) frontal token: same session and subject, mm scale from the frontal result
curl -s "$API/v1/profile/analyze" -F image=@profile.jpg \
  -F 'meta={"facing":"left","frontal_token":"eJy…","locale":"th",
           "overlay":{"layers":["landmarks","profile_lines"]}};type=application/json'

# Without a frontal token: subject required, new session, no mm values (warning no_frontal_scale)
curl -s "$API/v1/profile/analyze" -F image=@profile.jpg \
  -F 'meta={"facing":"left","subject":{"sex":"female","age":28}};type=application/json'

# Move a profile point with the profile token; silhouette points are re-snapped to the contour
curl -s -H 'Content-Type: application/json' "$API/v1/adjust" \
  -d '{"result_token":"eJy…(profile)","overrides":{"pronasale":{"x":702.0,"y":811.5}}}'

# Report with considerations from the session's latest frontal (and profile) tokens; no token returned
curl -s -H 'Content-Type: application/json' "$API/v1/report" \
  -d '{"frontal_token":"eJy…","profile_token":"eJy…(profile)","locale":"th"}'

curl -s "$API/readyz"
```

**Analyze / adjust response.**

- **`status`:** passes through from the core: `ok`, `no_face`, `multiple_faces`,
  `quality_failed`, or for profiles `contour_failed`.
- **`failed_checks` and `hints`:** the ids of failed gate checks and the core's
  localized hints.
- **`warnings`:** the core's warning keys, for example `distance_unverified` or
  `no_frontal_scale` (a profile without a frontal token).
- **`result`:** the core's `user_view`, only when the status is `ok`. For a profile this
  includes the silhouette `contour` and the adjustable points.
- **`result_token`:** present only when the status is `ok`.
- **`overlay`:** present only when requested and the status is `ok`: a
  `data:image/jpeg;base64` URI of the `user` style, long side ≤ 1600 px, with no EXIF.
- **`versions`:** the API, core and schema versions.

**Rules the service enforces:**

- Adjust records every override as a user adjustment (`source: user_adjusted`). A
  client-sent `source` is an unknown field and is rejected.
- Only the `user_adjustable_points` of the token's view may move: the hairline on a
  frontal result, and the ten profile points on a profile result. The core re-snaps
  profile silhouette points to the stored contour, whatever coordinates were sent.
- **Profile subject and session.**
  - With a `frontal_token`, the subject and `session_id` come from the token. A
    different `subject` in `meta` → 400 `subject_mismatch`.
  - A token of another kind → 400 `token_invalid`.
  - Without a token, `subject` is required and the profile starts a new session.

**Report response.** `{request_id, status, report, versions}`, with no token. `report` is
the core's `user_view(report)`: both views' results; each consideration with its finding,
possible causes, the triggering measurements with their reference range, and the advice
to consult a licensed surgeon; the rules version and the disclaimer.

- The profile token is optional. Both tokens must come from the same session: the
  profile analyzed with this frontal token (or an adjusted version of it). Otherwise 400
  `session_mismatch`.
- A token of the wrong kind → 400 `token_invalid`.

**Errors** are RFC 9457 problem details (`application/problem+json`) with a stable
`code` and the `request_id`; every response also carries `X-Request-ID`. Capture outcomes
are *not* errors: they come back as 200 responses with a `status`.

| HTTP | `code` |
|---|---|
| 400 | `invalid_request`, `subject_mismatch`, `session_mismatch`, `token_invalid`, `token_stale` |
| 404 / 405 | `not_found` / `method_not_allowed` |
| 413 / 415 | `payload_too_large` / `unsupported_media_type` |
| 422 | `invalid_meta`, `too_many_pixels`, `frame_size_mismatch`, `image_mismatch`, `point_not_adjustable` |
| 429 | `rate_limited` (with `Retry-After`) |
| 500 | `internal_error` (the traceback is in the service's log, under the request id) |
| 503 / 504 | `overloaded`, `not_ready` (with `Retry-After`) / `analysis_timeout` |

**Result tokens** are base64url-encoded, zlib-compressed JSON of `kind`, `session_id` and
the full core result. A frontal token is about 7–8 kB, a profile token (with its contour)
about 12–20 kB. Opening one checks that it decodes to a token of that shape, then that
its result came from the running core, schema and configuration version: tokens from
before a change of code or configuration get `token_stale`, and the app analyzes the
photo again. A result the core does not accept makes the token `token_invalid`.

## Tests

```bash
cd api && python -m pytest -q          # macOS: DYLD_LIBRARY_PATH=/opt/homebrew/lib for RAQM
api/scripts/ci.sh                      # CI: hashed install, models, tests, contract
```

Most tests use a deterministic fake engine (`tests/fake_engine.py`) with the core's
signatures and real result models. The top-left pixel colour picks the outcome: ok,
failed gate, no face, crash, hang or exception. The tests cover:

- **Validation and limits:** 413 (declared and streamed length), 415 (magic bytes),
  422 (meta, pixel caps, decompression bomb, burst size mismatch).
- **Responses:** the user view only (clinic-only sentinel), overlays, override source
  and the allowlist per view, unexpected errors as a 500 problem.
- **Tokens:** round trip, unreadable and edited tokens, kinds, stale versions, size.
- **Profiles:** frontal-token session and subject, subject mismatch, token kind and
  staleness; no-token sessions without mm values; failed contours; re-snapped
  adjustments; profile overlays.
- **Reports:** a session's report, frontal-only reports, session mismatch (including an
  adjusted frontal token), token kinds and staleness, a missing rules file.
- **Workers and limits:**
  - 429 per client address;
  - 503 on overload, before the upload is read;
  - 504 with a hanging engine;
  - crash recovery and a pool stopping under queued requests;
  - start failure, which keeps the service not ready;
  - warm-up readiness and worker recycling.
- **OpenAPI snapshot:** `openapi.json` must equal the generated document. Regenerate
  it deliberately with `python -m facescan_api.openapi > openapi.json`.

`tests/test_integration_core.py` runs the real core on its committed sample images:
the frontal photo, and a public-domain profile painting whose contour fails the gates.
It seals the core's own results of those photos as `ok` tokens, then checks that a
frontal token reaches the core's scale transfer, the core's re-snapping of an adjusted
silhouette point through `/v1/adjust`, overlays, and real reports with the example rules,
including one whose consideration fires. It is skipped without `models/`.

Decisions made where the choice was open, and the open questions, are in
[`ASSUMPTIONS.md`](ASSUMPTIONS.md).
