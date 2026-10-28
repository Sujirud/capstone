# Assumptions and decisions (Facial Analysis API)

Where a choice was open, the most conservative option was taken and recorded here. What the
[README](README.md) or `openapi.json` already says is left out. The **open decisions** at
the end are still open.

## Scope and structure

1. **The web process never imports `facescan`**, so MediaPipe, OpenCV and image decoding
   stay in the workers. It gets the versions, `config_hash`, `client_config`, overlay
   layers and adjustable points from the workers' start-up reports and checks token
   staleness against those; the default `RULES_PATH` is found in the installed core
   package without importing it.
2. **Rules information** comes from the core engine's read-only `rules_info`
   (`rules_version`, `rules_hash`, `example`), so the API reads no private attributes and
   never parses the rules file itself. `client-config` also carries `rules_version`.

## Workers

3. **Spawn, never fork**: the web process has threads.
4. **Readiness.** Each worker's warm-up analyzes a blank 640×480 image, which must return
   `no_face`, and reports whether RAQM is available. `/readyz` is ready once all initial
   workers have reported and agree on versions, configuration and rules (`rules_hash`
   included), and RAQM is available (unless `REQUIRE_RAQM=false`). Replacements for
   recycled, crashed or timed-out workers do not flip readiness; tasks wait for them.
5. **A worker that cannot start** (missing models, bad config, a failed warm-up) stops the
   pool instead of respawning workers in a loop, and the error is logged. Requests already
   waiting get 503 `not_ready`, since a stopped pebble pool would leave them pending
   forever, and the service stays not ready until it is restarted.
6. **Queue and timeouts.** A request takes its queue place before its body is read and
   keeps it while uploading, so an overloaded service refuses it before receiving 60 MB.
   Queue wait is bounded only by the queue length. Hard timeouts count from when a worker
   starts the task, which is then killed with its worker (504). A worker that dies
   mid-task gives 500 `internal_error`, and a client that disconnects mid-upload 400
   `invalid_request`.
7. **`MAX_BURST_PIXELS`** (125 MP) exists because 15 frames × 24 MP would be about 1 GB of
   RGB in one worker; 15 4K frames (124 MP) still fit. Image headers are read before
   anything is decoded.

## Uploads and validation

8. **Frame counts**: 0 or 2 frames → 400 `invalid_request`; more than `MAX_FRAMES` → 413
   `payload_too_large`, since the frame count is one of the size limits.
9. **Malformed requests.** A body that is not `multipart/form-data`, or JSON without
   `application/json`, → 415 `unsupported_media_type`. An image with valid magic bytes that
   cannot be decoded, unknown parts, a repeated `meta`, a truncated body and unknown query
   parameters → 400 `invalid_request`. `meta` may be a text or a file part.
10. **Validation codes.** Multipart `meta` fails with 422 `invalid_meta`, JSON bodies
    (adjust, report) with 400 `invalid_request`. Error details name the field and the error
    type, never the input value.
11. **Numbers are strict**: `age` must be a JSON integer and coordinates JSON numbers, not
    coerced from strings, and floats must be finite.
12. **Override errors**: a point that is not adjustable or not known, or a result without an
    automatic reference distance → 422 `point_not_adjustable`; a point outside the image →
    400 `invalid_request`.

## Tokens

13. **Tokens carry no secret**, so a client could edit one: a token that does not decode to
    the expected shape, or whose result the core does not accept, is 400 `token_invalid`,
    and an edited result changes only that client's own scan. Checks run in order:
    readable → current versions (`token_stale`) → the expected kind (`token_invalid`).
    `session_id` is a random UUID per frontal analysis, kept by adjustments.

## Profiles

14. **Subject.** With a `frontal_token`, the profile uses the token's subject exactly, its
    norms profile included; a `subject` in `meta` is then optional and compared on sex and
    age only, since the norms profile is server configuration. Without a token, a missing
    `subject` is 422 `invalid_meta`.
15. **The worker gets only `facing`, `camera` and `locale`** from `meta`, plus the subject and
    the frontal result, not the token. The profile's `camera` serves the profile photo's
    distance check; mm values come from the frontal scale.
16. **Same person.** The service does not check that the profile shows the person of the
    frontal token (there is no face matching); the core's 5 % cross-check of the
    transferred scale is the only guard.
17. **An unusable frontal scale** (no iris scale, missing frontal points) leaves the profile
    without mm values: the core records `calibration.reason` but sets no warning key, as
    `no_frontal_scale` means "no frontal token". The API passes the core's warnings through
    unchanged, so a warning for this case is for the core and the wording
    review.

## Reports

18. **The rules file** is validated by the core in every worker at start (structure,
    `approved_by` unless the file is marked `example_not_clinically_validated`, text keys in
    both locales); a file that fails keeps the service not ready. The start-up log names the
    rules version and says when they are the illustrative examples.
19. **Tokens and status.** The core re-checks versions and subjects (`stale_result` →
    `token_stale`, `subject_mismatch` → 400). A report's `status` is always `ok`, since
    tokens exist only for `ok` results.

## Responses

20. **Unverified checks are not failures**: `failed_checks` lists only the checks whose
    status is `fail`, and the camera distance without a focal length comes through the
    core's `distance_unverified` warning.
21. **Problem details**: `type` is `about:blank` and `title` the HTTP reason phrase;
    `not_found` and `method_not_allowed` cover unknown routes and methods.

## Rate limit and logs

22. **One fixed one-minute window** per client address over every `/v1` request (readiness
    is not limited), so up to twice the limit can pass across a window boundary; the worker
    queue (503 `overloaded`) is what protects the CPU.
23. **The client address** comes from `X-Forwarded-For` only when the connection is from
    127.0.0.1, where the web app's proxy and the tunnel run; otherwise it is the
    connection's own.
24. **Request ids** are server-generated and time-ordered: a millisecond timestamp plus 64
    random bits.

## Build and tooling

25. **`httpx2`** is the test dependency, since Starlette 1.x deprecates `httpx` for its test
    client; the example client uses it too.
26. **Lock files** are compiled with `uv pip compile --universal --python-version 3.11
    --generate-hashes`, and every pinned wheel exists for CPython 3.11 on linux/x86_64,
    which CI (`api/scripts/ci.sh`) runs.

## Open decisions

- **Limits:** the size and pixel caps, `MAX_BURST_PIXELS`, the rate limit (600 requests per
  minute per address) and the timeouts (frontal 20 s) are software defaults, not measured
  requirements.
- **Profile time:** a successful 4K profile is estimated at ≈ 3.4 s on an M2 (10
  test-time-augmentation runs: 0.4 s extraction plus 3.0 s), inside the 30 s timeout but
  not yet measured with real protocol-compliant profile photos. `capture.yaml`'s
  `tta.runs` is the lever.
