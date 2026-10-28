# Assumptions and decisions (web app)

Where a choice was open, the simplest option that keeps results correct was taken and
recorded here. What the code or [`DESIGN.md`](DESIGN.md) already shows is left out. The
requests to the API and core are at the end.

## Stack and routing

1. **TypeScript 5.9.3, not 7.** `openapi-typescript` needs `^5.x` and `typescript-eslint`
   needs `< 6.1`. Move up when they do.
2. **msw's install script is denied** in `pnpm-workspace.yaml` (pnpm 12 blocks install
   scripts unless approved). The end-to-end tests use `@msw/playwright` instead, so no
   service worker ships with the site.
3. **Tailwind 4 without its default theme.** `tokens.css` defines the whole theme, and a
   utility that needs a missing theme value produces no CSS, silently (`bottom-0` once left
   the action bar without its sticky offset). `tests/tailwind.test.ts` fails on any such
   class.
4. **Hash routing** (`#/subject`) needs no rewrite rules on the server. The skip link moves
   focus itself, since `href="#main"` would be read as a route.

## client-config and errors

5. **client-config** is fetched per language with `cache: "no-cache"` (a 304 when nothing
   changed) and kept in memory. A config whose `locale` differs from the request, or that
   lacks a field the UI reads, is an error, never a guess. Every screen needs it, the
   landing page included (it shows the core's disclaimer); without it they show "the
   service is not reachable" with a retry. Only the component page works without it.
6. **Busy retry.** `overloaded` and `not_ready` are retried once, automatically, when
   `Retry-After` is at most 10 s (this API sends 2–5 s). A second failure, or a longer or
   missing `Retry-After`, goes to the screen.
7. **Answers without a problem document**, from the proxy or the tunnel, are classified by
   status: 413 → `payload_too_large`, 429 → `rate_limited`, 503 → `overloaded`, 504 →
   `analysis_timeout`, anything else unexpected. Network failures get the client code
   `network`.
8. **Unknown codes** get the generic message and a retry. A coverage test fails when the
   API defines a code the app does not map, or the app maps one the API no longer defines.
9. **Logging** sends only the code, HTTP status and request id to the console, never a
   body, so no image or result data can reach it.

## Subject form and presentation

10. **The subject form** is saved on the device when the age is confirmed: that is the
    "last scan" that prefills the next one. A stored form that fails validation is ignored.
    Thai numerals (๒๑) are read as digits.
11. **Steps.** The indicator counts four: about you, front photo, side photo, report. Each
    photo's screens, from its guide to its adjustment and live mode included, are its step.
    The landing and method pages have none.
12. **Metric caveats are always visible**: a caveat on a value (`confidence_text` and the
    flag texts, such as "approximate" or "shown for information only") is never hidden
    behind a tap. Only `description` expands.
13. **Focus.** A step change moves focus to the new screen's heading, but the first screen
    after a page load does not, so the skip link is the first Tab stop.
14. **The component review page** ships in the build at `#/components`, lazily loaded,
    unlinked and in English only, so the advisor can review it on the demo.

## Front photo

15. **Drawings** are inline SVG components rather than files in `public/illustrations/`,
    since an `<img>` could not take the tokens' colours or `client-config`'s numbers. They
    pair with the core's steps by position, since the steps are plain strings (request 7),
    and the zoom drawing's "2×" is fixed (request 6).
16. **Photo sources.** Two hidden file inputs with `accept="image/jpeg,image/png,image/webp"`,
    one with `capture="environment"`, behind "Take a photo" and "Choose a photo". "Retake"
    on the preview opens the same source again. For the front photo, "Take a photo" opens
    live mode instead where the browser can show a camera (item 43).
17. **Pre-flight** reads the magic bytes and the header; nothing is decoded before the
    pixel cap is checked. For HEIF it takes the largest `ispe`, which is the primary image.
18. **The front camera** is recognised by EXIF `LensModel` containing "front" (iPhone: "…
    front TrueDepth camera …"; Android phones name it too). Without a lens model there is no
    warning.
19. **HEIC** is converted by libheif's WebAssembly build, loaded only when a HEIC file
    arrives (2 MB), to a JPEG at quality 0.95 with rotation applied. `camera: {focal_px,
    source: "exif"}` comes from the HEIC's EXIF and the stored (`ispe`) size, as the core
    reads a stored JPEG.
20. **The analyzing screen owns the request**, started one tick after it mounts so that
    StrictMode's double mount sends one upload. Leaving the screen cancels the request, but
    an upload the service already received is still analyzed.
21. **Retake** shows the hints verbatim, in the analysis's language, which can
    differ from the interface's (item 24); each failed check's name once, since left and
    right can share one; and the warnings. The primary action takes a photo again, and the
    guide is one link away rather than a forced step back ("then go back to the guide").
    After three failures in a row the full protocol appears here. A side photo's
    `contour_failed` is handled the same way, and failures are counted per view.
22. **"Adjust points"**, not "Adjust the hairline": the label would have to lower-case the
    core's point name, which would then not be verbatim.
23. **The arrow buttons** act on `click`, which every input sends, including the screen
    readers and voice control that press a button without pointer events (TalkBack, Voice
    Access, NVDA). `pointerdown` is not default-prevented, because WebKit then drops the
    tap's click; CSS prevents selection and the long-press callout instead.
24. **Language during a scan.** With results, a switch is confirmed and the photo in memory
    is analyzed again in the new language; the interface changes language when that
    analysis answers. If it fails, the old results and the old language stay together, and
    "Try again" still asks for the new one. Without results, the switch is immediate.
25. **An overlay that cannot be redrawn** after an adjustment is replaced by the app's own
    points: silently for `image_mismatch`, with a one-line note for any other failure.

## Side photo

26. **Every side screen needs frontal results**, whose token gives the scale, and otherwise
    goes back to them.
27. **Facing** is chosen first on the side guide (right by default), since the core's
    `profile_facing` hint refers to "the side shown in the app". It is shown again on the
    preview, to check against the photo, and on the retake screen. It is kept in memory
    only.
28. **The profile request** sends the latest frontal token (adjusted or not), never
    `subject`, and `camera` only for a HEIC photo, whose converted JPEG has no EXIF.
29. **A profile belongs to one frontal analysis**, whose token carries the session and the
    scale:
    - a new or failed frontal analysis drops the side results but keeps the side photo, to
      analyze it again with the new token;
    - a new frontal photo, which may show someone else, drops the side photo too;
    - a frontal adjustment keeps the side results: the session stays, and the scale transfer
      reads frontal points a user cannot move (subnasale, menton, nasion). If those ever
      become adjustable, a frontal adjustment must send the side photo again.
30. **Analyzing both photos again.** A language switch with side results, and an ended scan
    (`token_stale`, `token_invalid`) during the side photo's analysis or adjustment, analyze
    the frontal photo, then the side photo with the new token, and end on the side results.
    The interface switches language when the frontal analysis answers (item 24).
31. **Routes are keyed by their path.** The frontal and side screens are the same
    components at the same place, so without a key, going from the frontal analyzing
    screen to the side one would keep the first one's state and request.
32. **Side-photo drawings** use the frontal `camera_distance_recommended_m`: the core's step
    says "taken the same way as the front photo", and `client-config.profile` gives only the
    minimum.
33. **An unusable frontal scale** (`calibration.available: false` without a
    `no_frontal_scale` warning) gets a web note that millimetre values are not shown
    (request 3).
34. **The alar crease** is asked for on the side results while it has no position, naming
    the metric that needs it: `P3a_tip_projection_goode` (request 9), or "a measurement of
    the nose" when that metric is missing.
35. **Points on the outline.** Every adjustable profile point except `alar_crease` slides
    along the outline (request 8): a drag or a tap lands on the nearest point of
    `result.contour`, by a port of the core's `project_onto_polyline` tested against its
    values. Moves are kept while switching points, and every changed point goes in one
    `/v1/adjust` call.

## Report, landing and method

36. **The landing page** (`#/`) is the start, and back from the subject form returns to it.
    Who made it comes from `src/app/about.ts`: the course defaults to "DSI314", from the
    project's folder name, and the team's line is left out until someone fills it in.
37. **"How it's measured"** (`#/method`) quotes the core where it can: the iris diameter
    from `client-config`, the `inconclusive` text and the classical reference's name. The
    iris diameter's ±4 % is a web string (request 10).
38. **Where the report is reached.** Without side results, the frontal results offer "Add a
    side photo" (primary) and "See the report"; with them, "See the report" is primary.
    "Start a new scan" is a tertiary button in the footer that asks first: it is not the
    next step, and nothing is stored.
39. **The report request** sends the latest tokens (the side one only with side results)
    and the scan's locale. The report is kept in memory and asked for again only when a
    token or the language changes.
40. **All measurements.** The printed report needs the overlay and the measurement table,
    so the report shows every measurement of each photo as a table, from the report's own
    views, beside that photo, with the caveats as on the sheet (item 12).
41. **Report errors**: an ended scan analyzes both photos again and returns to the
    report, and `session_mismatch` offers to start over. A language switch on the report
    returns to it too.
42. **A language switch waits for that language's `client-config`** (a bug fix). Switching
    while it loaded replaced the screen with "loading", and when it arrived while a
    navigation was still in a transition, the analyzing screen being left came back and
    sent its photo a second time. Every switch now loads the target config first
    (`src/app/useSwitchLanguage.ts`); a test fails without the fix.

## Live mode

43. **Where it is offered.** "Take a photo" on the frontal guide and retake screens opens
    it where the browser can show a camera on a page: a secure context with `getUserMedia`
    (HTTPS, as through the demo's tunnel, or localhost). Elsewhere the button opens the
    phone's camera app (item 16). Live mode is thus the default for the front photo; the
    camera app, whose photos carry the EXIF focal length that live mode lacks without a
    calibration, is still reached through "Choose a photo" (iOS offers "Take Photo" there;
    the phone checklist checks both phones). Front photo only. Its names are "Live
    camera" / "กล้องในหน้าเว็บ", and the way back reads "Choose a photo instead".
44. **Limits stated first.** Before the camera starts, an introduction lists them, each
    problem before its reason: where to put the camera; the face size, which cameras
    usually reach it, and why moving closer is no fix; the report's discussion topics,
    which need a calibration, and what calibrating involves; and the side photo. What the
    tab keeps is left to the method page, as on the other guides. While the camera runs,
    notices show when the face cannot reach the face-size gate (item 53) and while there is
    no calibration.
45. **The camera**: the rear one at an ideal 3840 × 2160, without audio, at 2× zoom where
    the camera allows it (the low end of the protocol's 2–3×), with 1×, 2× and 3× offered
    within its range. "Switch camera" takes the next camera by id, since a laptop's webcams
    have no facing. The front camera's preview is mirrored with CSS; the frames never are.
    A change of zoom or frame size starts the run over and looks up that setup's
    calibration.
46. **Detection**: MediaPipe's FaceLandmarker in video mode with the server's
    `face_landmarker.task`, served by the site and checked against the SHA-256 the core
    pins (`pnpm build` fails without it). Two faces at most, so "exactly one face" can be
    checked. The GPU delegate comes first, since it takes frames as textures at 4K, then the
    CPU one if it fails. After 30 failed frames in a row the loop stops and the screen says
    so.
47. **MediaPipe's matrix is column-major in the browser**: the web runtime returns the
    proto's packed data as it is, while the Python API transposes it for the core. An
    end-to-end test checks it: the browser's head pose for the astronaut photo is within 2°
    of the core's.
48. **The gate port** (`gates.ts`, `pixels.ts`) runs the core's `frontal_checks` with
    client-config's thresholds, in the core's order (request 12). Its pixel checks port the
    OpenCV calls the core makes, on the face region read at full resolution and reduced in
    JavaScript as the core does, since the canvas resamples differently. On the core's
    detector outputs for the astronaut photo, six variants and 12 one-input cases
    (`gen_fixtures.py`), it gives every status, hint and limit exactly, and every value to
    1e-9 except sharpness (0.5 %), brightness (0.1 %) and the glare fraction (0.001).
49. **Smoothing is for the display only.** Distance, pose and face size are smoothed with
    the One-Euro filter to choose the hint shown; auto-capture uses each frame's raw checks,
    as the server does. No values are shown, unlike the desktop app.
50. **Screen readers and speech.** The visible hint is not a live region, since it can
    change every frame: a polite region gets a hint once it has held for 1.5 s, and the same
    one again after 10 s. "Read the hints aloud" (off by default) speaks a hint once it has
    held for 1.2 s (again after 6 s), only with a voice for the interface's language.
    Turning it on speaks the current hint at once: iOS Safari speaks only after a first
    utterance from a user's action.
51. **Auto-capture.** When every gate passes for `consecutive_pass_frames` (20) frames in a
    row, the sharpest `burst.recommended_frames` (7, not `keep_best_frames`)
    are kept, within the upload limits. The camera then stops and the frames are encoded as
    JPEG at quality 0.95, dropping the least sharp while the request would be too large. The
    burst is analyzed at once, without a preview, as in the desktop reference; the photo
    shown with its results is the frame the result names (`frames.reference_frame`).
52. **Calibration** counts frames that pass every gate, with the distance check unverified
    meanwhile. After 30 such frames, focal_px = the mean iris diameter in pixels (the core's
    `mesh_iris_px`) × `camera_distance_recommended_m` × 1000 ÷ `iris_diameter_mm`. It is
    sent as `camera: {focal_px, source: "calibration"}` and kept on the device per camera,
    resolution (either way round) and zoom: a focal length, nothing about a face.
53. **The face-size warning** uses the calibrated focal length, or else one estimated from a
    70° horizontal field of view (a phone's main camera has 69°, webcams 65–78°) times the
    zoom, and warns when a typical 63 mm IPD at the recommended distance falls below
    `ipd_min_px`.
54. **What the tests cannot cover.** The component tests run the real gate port,
    auto-capture and burst code with a fake camera and detector. Chromium's fake camera
    plays the astronaut photo, which fails the gates, so hints show but nothing is captured.
    No committed image passes every gate, so auto-capture with the real model, WebKit's
    camera, spoken Thai and the phones' memory are left to the phone checklist.

## Fixtures, tests and the demo

55. **Fixtures** come from `scripts/gen_fixtures.py`, which runs the real API app in process
    with the example rules. `client_config`, the failed and no-face frontal answers, the
    side photo's `contour_failed` and the reports are the API's real answers; where they
    need tokens, the API's own `seal` issued them. `frontal_ok` is the core's `user_view` of
    the core tests' synthetic result, whose "photo" is a line drawing of that face, not a
    person. The side results come from the real engine on the core tests' synthetic profile
    with their colour-based segmenter, since the real one finds no face in a flat drawing.
56. **`gen_fixtures.py --check`** runs in CI. Floats are compared with a relative tolerance
    of 1e-9, or 1e-6 for the side photo's fixtures and 1e-3 for the live gate values
    (OpenCV's resize rounds differently on x86 and ARM); images are only checked to exist.
    The image-analysis fixtures have not yet been checked on Linux.
57. **Test harness limits**, worked around in the tests, not in the app:
    - jsdom's XMLHttpRequest with MSW fails on FormData holding a File, so the jsdom tests
      give the app an XHR stand-in that sends the same body with Node's fetch;
    - Playwright's interception hides upload bytes (Chromium's for files on disk, WebKit's
      for every Blob), so bytes are checked in Chromium only; the real-stack run confirms
      that both engines send the whole photo;
    - Playwright's WebKit hangs on `page.close({ runBeforeUnload: true })`, and WebKit skips
      links on Tab, so the leave-page warning and the keyboard pass run in Chromium only;
    - the real-stack tests run with one worker, so uploads do not queue behind the few
      analysis workers a laptop runs.
58. **One origin.** The dev and preview servers forward `/v1` to the API (`API_URL`), so the
    API needs no CORS and one tunnel brings both to phones; Vite allows the quick tunnel's
    `.trycloudflare.com` hostnames. `VITE_API_BASE_URL` points the app at another origin,
    for the mocked end-to-end tests only. Through the tunnel, a frontal analysis, an
    adjustment and a report were verified on an Apple Silicon Mac in WebKit and Chromium
    phone emulation.

## Requests to the API / core

Recorded here and handled in the web app as described; neither project was changed.

1. **Area names.** Metrics carry `area` as a key, and `client-config` has no area strings.
   Request: `area_text` on metrics, or `strings.area` in `client-config`. Until then,
   `src/i18n/areas.ts` copies the core's strings, and `tests/areas.test.ts` compares them
   with the locale files.
2. **24 MP photos.** `MAX_PIXELS` is 24,000,000, and recent iPhones save about 24.5 MP at
   1×. Request: raise the single-photo cap after measuring memory and time. Until then,
   the pre-flight refuses such a photo before any upload and suggests 2× zoom or the 12 MP
   mode.
3. **Unusable frontal scale.** A profile with `calibration.available: false` has no
   warning key. Request: one with the core's wording, or `calibration.reason` in
   `user_view`. Until then, a web note (item 33).
4. **Per-view overlay layers.** `client-config.overlay.layers` is one list, and it includes
   `golden_ratio`. Request: a list per view, without it. Until then, fixed lists per view,
   intersected with the API's (`src/api/layers.ts`, tested).
5. **Negative zero in value texts.** The core's `format_value` prints small negative values
   as `-0.0` (for example "-0.0 mm"), and the app shows `value_text` verbatim. Request:
   normalize negative zero after rounding in `facescan/core/locale.py:format_value`.
6. **A recommended zoom in `client-config`.** The protocol says "2–3× zoom", but
   `client-config` gives only the distance, so the zoom drawing and the pre-flight message
   say a fixed "2×". Request: add it (e.g. `frontal.capture.zoom: [2, 3]`), so they follow
   the core.
7. **Step ids for the capture protocols.** The steps are lists of strings, so the drawings
   pair with them by position, and a reordered or added step would put a drawing next to
   the wrong text. Request: ids, e.g. `[{id: "distance", text}]`. Until then, a test fails
   unless the core has the six frontal and five profile steps the drawings expect.
8. **Which profile points slide along the silhouette.** `user_view` does not say which
   adjustable points the core re-snaps to the contour. Request: mark them, e.g.
   `adjustable_points[].on_contour: true`. Until then, every adjustable profile point except
   `alar_crease`, which is not on the silhouette (`src/scan/points.ts`); the server re-snaps anyway, so a
   wrong guess would only show a point off the outline until it is saved.
9. **Which metrics use a point.** `landmarks_used` is not in `user_view`, so a result does
   not say which metric needs the alar crease. Request: the points each metric uses, or the
   metrics each adjustable point feeds. Until then, the prompt names
   `P3a_tip_projection_goode`, with a generic sentence when that metric is
   missing.
10. **The iris diameter's uncertainty.** `client-config.frontal` has `iris_diameter_mm` but
    not `iris_rel_uncertainty` (0.04 in `capture.yaml`). Request: add it, so "How it's
    measured" follows the core. Until then, the web string says "about ±4 %".
11. **A no-break space before ๆ in the core's Thai strings.** Eleven strings in
    `locale_th.yaml` have "word ๆ" with a plain space (e.g. `hint.close_mouth`), so ๆ can
    start a line on its own (capture step 6 at 360 px). Request: U+00A0 before ๆ. Until
    then, they are rendered verbatim; the web app does not rewrite the core's text.
12. **The gates' order and hints in `client-config`.** Live mode ports the frontal gates.
    `client-config` gives their thresholds, but not the check order, each check's hints
    (the expression hints, the yaw and pitch signs) or the mesh points they read, so the
    app copies `quality.CHECK_ORDER`, `_EXPRESSION_HINTS` and the `landmark_map` indices.
    Request: publish the order and the hint keys. Until then, `tests/live.test.ts` compares
    the copies with the core's (`fixtures/live_gates.json`) and fails when they differ.
