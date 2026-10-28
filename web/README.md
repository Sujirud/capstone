# Facial analysis web app

The web client for the facial analysis service. It is a single-page app in Thai and
English. It guides the capture, sends photos to the API in [`api/`](../api/README.md), and
shows the results, overlays and report. Measurements, statuses and their wording come only
from the API: the app renders them and never reinterprets them.

| Milestone | Scope | State |
|---|---|---|
| 1 | Project, CI and i18n; design tokens, type and core components on a review page; `client-config`, subject form; the demo setup | **done** |
| 2 | Frontal photo mode: guide with illustrations, capture, pre-flight, upload, hints, results, hairline adjustment, overlay redraw | **done** |
| 3 | Profile: guide, facing, upload with the frontal token, contour adjustment, alar crease | **done** |
| 4 | Report, print, landing and "How it's measured", design review, phone checklist | **done** (the manual phone and screen-reader checks still need devices) |
| 5 | Live mode (optional): the camera on the page, real-time hints, auto-capture, calibration | **done** (the checks on real phones still need devices) |

The app opens on a landing page: what it does, the core's disclaimer, who made it, "Start",
and a link to "How it's measured". Then the frontal flow:

1. the subject form;
2. the capture guide, with drawings;
3. "Take a photo" or "Choose a photo": "Take a photo" opens live mode (below) where the
   browser can show a camera on a page, and the phone's rear camera elsewhere;
4. the pre-flight checks and the preview;
5. the upload and analysis;
6. either retake guidance, or the results with the core's overlay and measurement sheet;
7. hairline adjustment, with the overlay redrawn, and "Reset to automatic".

"Take a photo" on the front photo's guide opens **live mode** (milestone 5) where the
browser can show a camera on a page (HTTPS or localhost):

1. an introduction that states its limits first (below);
2. the camera on the page: the rear camera at the highest resolution it gives, 2× zoom where
   the camera allows it, the front camera mirrored on screen only;
3. one hint at a time from the core's gates, ported to the browser, in large type, optionally
   read aloud;
4. once every gate has passed for 20 frames in a row, the 7 sharpest frames are taken by
   themselves, encoded as JPEG and analyzed as one burst; from there the flow is photo mode's;
5. an optional calibration at a tape-measured 1.5 m, which gives the focal length the
   browser does not, so the distance is checked.

**Live mode's limits** (stated on its screen too):

- **Face size.** The face-size gate (150 px between the pupils) at 1 m or more needs about a
  4K stream or optical zoom. Most laptop webcams cannot reach it; many phones can, with zoom.
  The screen warns when the stream cannot, and suggests photo mode.
- **Distance.** The browser gives no focal length, so without a calibration the distance
  check is `unverified`, the results carry `distance_unverified`, and the report has no topics.
- **Calibration** is kept on the device per camera, resolution and zoom; a new resolution or
  zoom needs a new one.
- **The side photo** is taken in photo mode.
- The server runs every gate again: the hints on the page are guidance.

The side photo follows from the frontal results (optional):

1. the side-photo guide, with drawings, and which way the nose will point (right by default);
2. the photo, the pre-flight checks and the preview, with the facing choice again;
3. the upload with the latest frontal token, whose scale gives millimetre values;
4. either retake guidance (`contour_failed` like `quality_failed`), or the results;
5. a request to place the side of the nose (the alar crease), which one nose measurement needs;
6. adjustment of the ten side points: nine slide along the face's outline, and the alar
   crease is placed by a tap; the overlay is redrawn, and "Reset to automatic" works as for
   the front photo.

The report follows, from either results screen:

1. the core's report for the latest tokens, verbatim and in its order: a note when the rules
   are the illustrative examples, the discussion topics with their measurements, or the
   core's note when there are none;
2. every measurement of each photo, as tables beside the photos;
3. the disclaimer, last;
4. "Save as PDF or print", which prints an A4 document without navigation or buttons.

A language switch or an ended scan analyzes both photos in memory again, and comes back to
the report when it started there. The component review page is at `#/components`. [`DESIGN.md`](DESIGN.md) holds the design system and the screenshots,
and [`ASSUMPTIONS.md`](ASSUMPTIONS.md) every decision and the requests to the API and
core.

## Requirements

Node.js 24 (LTS, `.nvmrc`) and pnpm 12.6.0 through corepack. Pinned versions (exact, in
`package.json` and `pnpm-lock.yaml`):

| Area | Packages |
|---|---|
| App | Vite 8.3.1, React 19.3.0, React Router 8.4.0 (hash routing), TypeScript 5.9.3 (`strict`; see ASSUMPTIONS 1) |
| Styling | Tailwind CSS 4.3.3 (tokens only, no default theme), Radix UI primitives (radio group 1.4.7, toggle group 1.1.19, collapsible 1.1.20, dialog 1.1.23), Lucide icons 1.48.0, IBM Plex Sans Thai (self-hosted, from `@fontsource` 5.3.0) |
| Data | zod 4.6.5, `openapi-typescript` 7.13.0 (types from `api/openapi.json`), i18next 26.4.2 with react-i18next 17.0.15 |
| Photos | exifr 7.1.3 (EXIF), libheif-js 1.23.2 (the libheif WebAssembly build, loaded only for a HEIC photo) |
| Tests | Vitest 5.0.2, Testing Library (React 16.3.3), MSW 2.15.0 with `@msw/playwright` 0.6.7, Playwright 1.63.0, `@axe-core/playwright` 4.13.0 |
| Live mode | `@mediapipe/tasks-vision` 1.0.1 (FaceLandmarker; loaded only when live mode opens), with the server's `face_landmarker.task` |

Live mode's model and MediaPipe's WebAssembly are served by the site itself. They are copied
into `public/models/` and `public/mediapipe/` (not committed) by
`scripts/copy_live_assets.mjs`, which `pnpm dev` and `pnpm build` run. The model comes from
the repository's `models/` and must match the SHA-256 pinned in
`facescan/tools/download_models.py`; `pnpm build` fails without it:

```bash
python3 facescan/tools/download_models.py --dest models   # from the repository root, once
```

## Setup

```bash
cd web
corepack enable                 # once; provides pnpm 12.6.0 from package.json
pnpm install
pnpm exec playwright install chromium webkit   # for the end-to-end tests
```

Start the API (`python -m facescan_api` from the repository root, see
[`api/README.md`](../api/README.md)), then the dev server:

```bash
pnpm dev      # http://localhost:5173; /v1 is forwarded to the API
```

The site and the API share one origin: the dev and preview servers forward `/v1` to the
API. The root [`README.md`](../README.md) shows how to run the demo for phones.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server on port 5173 (copies live mode's model and WebAssembly first, if the model is there) |
| `pnpm build` | Copy live mode's model and WebAssembly, type check the app, then build into `dist/` |
| `pnpm preview` | Serve `dist/` on port 4173 (the demo), with `/v1` forwarded to the API |
| `pnpm typecheck` | The app, the tests, and the Node configs and end-to-end specs |
| `pnpm lint` | ESLint (TypeScript, React hooks) |
| `pnpm test` | Unit and component tests (Vitest, jsdom, MSW) |
| `pnpm e2e` | End-to-end tests against the mocked API: WebKit (iPhone 15) and Chromium (Pixel 7) emulation, with axe; live mode's camera with Chromium's fake camera |
| `pnpm e2e:real` | End-to-end tests against a running API (below) |
| `pnpm screenshots` | The `DESIGN.md` screenshots, into `docs/screenshots/` |
| `pnpm gen:types` | Regenerate `src/api/openapi.d.ts` from `api/openapi.json` |
| `pnpm check:types` | Fail if the committed types differ from the regenerated ones (CI) |
| `pnpm fonts` | Copy the IBM Plex Sans Thai subsets into `public/fonts/` (after a font upgrade) |
| `pnpm live-assets` | Copy live mode's model (SHA-256 checked) and MediaPipe's WebAssembly into `public/` |

Fixtures are generated from the real core and API with the repository's Python
environment. The models must be in `models/`:

```bash
.venv/bin/python web/scripts/gen_fixtures.py            # write web/fixtures/
.venv/bin/python web/scripts/gen_fixtures.py --check    # compare only (CI)
```

## Configuration

| Variable | When | Default | Meaning |
|---|---|---|---|
| `API_URL` | `pnpm dev` / `pnpm preview` | `http://127.0.0.1:8000` | The API that `/v1` is forwarded to. |
| `VITE_API_BASE_URL` | build time | the site's own origin | An API on another origin; only the mocked end-to-end tests set it. |

The site makes no other requests: the fonts, live mode's model and MediaPipe's WebAssembly
come from the site itself.

**Who made it.** The landing page names the course and the team from
[`src/app/about.ts`](src/app/about.ts): `course`, `institution` (optional) and `team`, in
Thai and English. Fill in the team's names there before a demo; while the list is empty, the
team line is left out.

## Layout

```
web/
  src/
    api/          client (problems, Retry-After, one busy retry), problem mapping,
                  client-config loader, zod schemas, types generated from api/openapi.json
    app/          device storage (language, last subject form, live camera calibrations), services, client-config state,
                  the language switch (loads the config first), who made it (about.ts)
    capture/      CaptureSource.ts (shared by photo and live mode); photo/: file inputs, magic bytes,
                  header dimensions, EXIF, the focal-length port, HEIC conversion, pre-flight;
                  live/: the gate port (gates.ts, pixels.ts), camera, frames, MediaPipe
                  (detector.ts), the frame loop, auto-capture and burst limits, calibration,
                  display smoothing (One-Euro), spoken hints
    scan/         the scan session (in memory, per view: photo, original and latest results,
                  tokens; the facing), the language switch, the subject form, the points the
                  API does not describe (points.ts)
    screens/      landing, "How it's measured", subject (sex, age), report, component review
                  page, routes (paths.ts); scan/: guide, live mode, preview, analyzing, retake,
                  results and adjust for both views, the facing choice, the alar-crease request
    components/   layout/ (screen, top bar, action bar), ui/ (buttons, fields, notices, dialog, …),
                  results/ (metric row, range bar, measurement sheet and table, scan footer),
                  report/ (a discussion topic, a photo in the report),
                  viewer/ (photo viewer, zoom and pan, client-drawn points), adjust/ (point
                  adjustment with the loupe; sliding along the outline, contour.ts),
                  illustrations/ (capture-guide drawings, frontal and side)
    styles/       tokens.css (the only place colours, type and spacing are defined, screen and
                  print), fonts, base and the print stylesheet
    i18n/         th.json, en.json, area names copied from the core (tested)
  public/fonts/   IBM Plex Sans Thai, Thai + Latin subsets, weights 400/500/600, OFL licence
  public/models/, public/mediapipe/   live mode's model and WebAssembly (generated, not committed)
  fixtures/       from the real core and API (scripts/gen_fixtures.py): client-config, analysis
                  and adjustment responses (frontal and side), error codes, EXIF focal cases,
                  contour-snap cases, a line drawing of the synthetic face as the "photo" (JPEG,
                  front-camera JPEG, HEIC), the core tests' synthetic side profile (profile.jpg),
                  the core's overlays of both, the real API's reports (with and without topics),
                  header samples (formats/); live mode: detector outputs and the core's gate
                  values (live_gates.json), face regions and fake-camera stills (live/)
  tests/          unit and component tests; mocks/ (MSW handlers shared with Playwright)
  e2e/            Playwright: mocked flows, real stack, screenshots
  docs/screenshots/
```

## Tests

**Unit and component** (`pnpm test`, 326 tests):

- every problem code in `api/facescan_api/errors.py` is mapped, and nothing else;
- the API client: problem parsing (`detail` is dropped), one busy retry, gateway answers,
  network errors, validation;
- the subject form (validation, prefill, saving, the start of the app) and the
  `client-config` failure paths;
- the measurement sheet from the fixtures, in Thai and English: every text verbatim,
  grouping, "More details", range bars only where they belong;
- the fixtures pass the zod schemas and contain no clinic-only metric;
- web strings: the same keys in both languages, no hype or banned terms, no gendered
  particles;
- token contrast, the Tailwind class guard, the area-name copy, and the glossary;
- photo mode: magic bytes, header dimensions from real encoder output (PNG, JPEG, the three
  WebP forms, HEIC), every pre-flight outcome, and the EXIF focal port against the core's
  values (14 tag sets and the fixture photos, HEIC included);
- uploads through XMLHttpRequest: progress, problems, one busy retry, cancellation;
- the scan session: the original result kept for "Reset to automatic" (no request), failures
  in a row, object URLs; overlay layers per view, never `golden_ratio`; `camera` only for
  HEIC;
- the frontal flow through the app. What was sent is checked at each step, and the flow
  runs failed capture → retake → results → a keyboard adjustment → save (one override, no
  `source`) → overlay redraw → reset. Also: three failures and the full protocol,
  pre-flight refusals, the front-camera warning, a point to place, an image-size mismatch,
  the arrow buttons from a pointer, a click alone (as screen readers send it) and Enter,
  the hints' `lang` after a language switch, and errors (429, 422, 504 twice);
- the capture drawings: text at 14 px or more.
- the side photo: the profile request (facing, the latest frontal token, the profile layers,
  no subject, `camera` only for HEIC); the session (a new frontal analysis drops the side
  results and keeps the side photo, a new frontal photo drops both); the snap-to-contour port
  against the core's own values; the fixtures (a profile without its contour is refused);
  the facing choice and the side drawings;
- the report: the latest tokens sent (no side token without a side photo); every text verbatim
  and in the API's order, the disclaimer last; the example-rules note only for the example
  rules; the core's note without topics; every measurement of both photos in the tables,
  a shared reference label heading its column once; the report kept until an adjustment
  changes a token; an ended scan (both photos analyzed again, back to the report); a session
  mismatch; printing; a language switch on the report;
- the landing and method pages in both languages: the core's disclaimer, iris diameter,
  `inconclusive` text and reference name verbatim; who made it; the links;
- the print palette (black on white) in the token test;
- a language switch loads the new language's `client-config` before switching (ASSUMPTIONS 42);
- the side-photo flow through the app: facing chosen → `contour_failed` → retake → results →
  the alar crease placed by a tap → the nose tip moved along the outline with the keyboard
  (sideways keys do nothing) → save (both points in one call, the nose tip on the contour)
  → overlay redrawn on the side photo → reset. Also: the unusable-scale note, three
  failures and the side protocol, a language switch and an ended scan that analyze both
  photos again, and the side screens needing frontal results;
- live mode: the gate port against the core's `frontal_checks` for the same detector outputs
  (19 cases from the astronaut photo and variants: every hint, one case passing every gate):
  every check's id, status, hint and limit, values to 1e-9, and sharpness and exposure within
  the stated tolerance; the core's check order, expression hints and mesh indices; the
  One-Euro filter against the core's; auto-capture (the run, the sharpest frames kept, frames
  freed); the burst limits; calibration (the inverse of the core's distance, 30 frames, kept
  per camera, resolution and zoom); the face-size warning; the steady hint; MediaPipe's matrix
  layout and landmark conversion;
- the live screen through the app, with a fake camera and detector (the fixture's detections
  and face region): the limits stated first, the core's hints, auto-capture of a 7-frame burst
  and its upload, a saved calibration sent as `camera`, calibrating and saving, the face-size
  warning, a refused camera, retaking a failed burst with the live camera, spoken hints with and
  without a voice (said at once when turned on), the photos being prepared and dropped when the
  screen is left meanwhile, switching to the next camera by id, a detector that keeps failing,
  the side photo's "Take a photo" opening the camera app, and the camera app instead of live
  mode where the browser cannot show a camera; the frame loop keeps one chain of callbacks
  across a stop and start.

**End to end** (`pnpm e2e`, mocked with MSW, WebKit and Chromium mobile, 75 tests, 3 of
them skipped in WebKit):

- milestone 1: the subject flow, service not reachable → retry, the language switch, the
  component page, reflow at 320 px with 200 % text, and a keyboard-only pass;
- milestone 2: the frontal flow in real browsers (real image loading, dragging with the
  loupe from off-centre, keyboard nudging, the arrow buttons by tap and click, the overlay
  redraw, reset); a HEIC photo converted in the browser with its focal length; switching
  language with results (re-analysis), keeping it, or a re-analysis that fails (the
  interface stays in its language); a scan that ended on save (a new service version);
  429, 503 (retried once) and 504 (one retry, then another photo); reflow at 320 px and
  200 % text on the frontal screens; the leave-page warning; a new scan;
- milestone 3: the side-photo flow in real browsers (the facing choice, `contour_failed`,
  the alar crease placed by a tap where it was tapped, the nose tip dragged off the face with
  the loupe and kept on the outline, overlay redraw, reset); moving along the outline with
  the keyboard and with the buttons by tap and click; a HEIC side photo with its focal length;
  a language switch and an ended scan that analyze both photos again; reflow at 320 px and
  200 % text on the side screens;
- milestone 4: the whole scan from the landing page (failed frontal → retake → adjust →
  reset → side photo → adjust → report, with the latest tokens); the printed report (A4 from
  the stylesheet, checked in a PDF Chromium prints; black on white; no navigation or
  buttons; the disclaimer last); the method page from the report and back; a keyboard-only
  pass from the landing page (Chromium); reflow at 320 px and 200 % text on the landing,
  method and report pages;
- milestone 5: MediaPipe's web runtime, with the site's own model and WebAssembly, finds
  the landmarks, head pose and expression the core finds in the same photo (both engines;
  this also checks how its matrix is read); the live introduction, opened by the guide's
  "Take a photo", with axe and reflow; with Chromium's fake camera playing the astronaut photo, the core's hint from
  the real model, the face-size and distance notices, the screen-reader announcement, axe,
  reflow, calibration counting only passing frames, and the camera stopped on leaving;
- axe on every screen, dialogs included (the preview and analyzing screens with reflow at
  320 px too).

**Real stack** (`pnpm e2e:real`): a running API, reached through the test server's `/v1`
proxy, as a phone reaches it in the demo.

```bash
E2E_API_URL=http://127.0.0.1:8000 pnpm e2e:real
```

It runs in Chromium and WebKit, with one worker. It checks:

- `client-config` through the site's origin (`ETag`, request id), through the subject form
  to the API's guide text;
- `tests/data/astronaut.png` → `quality_failed` with Thai hints, both posted from the page
  and through the capture flow (file input, preview, upload, retake screen);
- `tests/data/profile_lathe_operator_1942.jpg` posted to `/v1/profile/analyze` →
  `contour_failed` with Thai hints;
- live mode's burst as the app encodes and sends it (three JPEG frames from bitmaps, a
  calibrated focal length): the API takes it as one burst and verifies the distance with it;
- with `E2E_OK_PHOTO=<a protocol-compliant frontal photo, never committed>`, the `ok`
  path: results, a hairline adjustment, and the overlay redraw, which the API accepts only
  if the uploaded bytes are exactly the analyzed ones, and the report from the adjusted
  token; then the side photo with that real
  frontal token: the lathe-operator photo → `contour_failed` and retake;
- with `E2E_OK_PROFILE=<a protocol-compliant side photo of the same person, never
  committed>` as well, the side `ok` path: results, the alar crease placed, and the overlay
  redrawn.

**CI** ([`.github/workflows/web-ci.yml`](../.github/workflows/web-ci.yml)) runs the
contract-type check, type check, lint, unit tests, build and mocked end-to-end tests, with the
model files downloaded (and cached) for live mode. A second job regenerates the fixtures from
the core and API (`--check`).

## On real phones

The phone checklist, for one iPhone (Safari) and one Android phone (Chrome), with the
demo running as the root [`README.md`](../README.md) describes. None of it has been run yet:
it needs the devices.

**Capture and photos**

- [ ] "Take a photo" opens the live camera for the front photo and the rear camera for the side photo; "Choose a photo" opens the library and also offers the camera (iOS: "Take Photo")
- [ ] The photo arrives as JPEG (iOS, with HEIC not in `accept`); if HEIC arrives, it is converted
- [ ] The result has no `distance_unverified`, so the EXIF focal length survived the upload
- [ ] A 2× zoom photo passes the face-size gate; a 24 MP photo at 1× is refused before upload
- [ ] Side photo: the person turns so the nose points the chosen way; a helper at 1.5 m with 2× zoom gives results without `distance_unverified`

**Results and adjustment**

- [ ] Pinch and double-tap zoom in the viewer, while the page still scrolls and zooms
- [ ] Dragging the hairline with the loupe, the arrow buttons (tap and hold) and tap-to-place all work
- [ ] Side adjustment: the point picker opens the phone's own list; dragging a point with the loupe keeps it on the outline; the alar crease is placed by a tap; the "toward the forehead / chin" buttons repeat while held
- [ ] The leave-page warning appears with results

**Report**

- [ ] The report appears in a few seconds, with the example-rules note
- [ ] "Save as PDF or print": iOS shows the share sheet's print preview (and "Save to Files" as PDF); Android offers "Save as PDF"; the saved PDF is A4 with no buttons, and its Thai text is shaped correctly

**Reading and accessibility**

- [ ] Thai renders correctly with the longest strings (capture steps, `inconclusive` status, the method page, the report's tables)
- [ ] VoiceOver (iOS) through the whole flow: the heading on each step, the radio groups, form errors, the point handles (named, adjustable), the arrow buttons, the report's tables (row and column headers read)
- [ ] TalkBack (Android) through the whole flow, including a double-tap on each arrow button (it sends a click alone)
- [ ] Text at 200 % in the phone's settings: nothing is cut off or scrolls sideways

**Live mode** (milestone 5)

- [ ] On the demo's HTTPS address, "Take a photo" on the front photo's guide opens the live camera; the browser asks for the camera once
- [ ] The rear camera starts at its highest resolution (iPhone: 3840 × 2160 or the phone's maximum), with 2× zoom where offered; the front camera's preview is mirrored, the analyzed photo is not
- [ ] Real-time hints change as the person moves, one at a time, readable from 1.5 m; "Read the hints aloud" speaks Thai with a Thai voice (and says when there is none)
- [ ] Auto-capture: after every check passes and the person holds still, the photos are taken and analyzed; a failed burst goes back to the live camera
- [ ] Calibration at a tape-measured 1.5 m: 30 frames, then the distance notice changes; the next capture's result has no `distance_unverified`, and the report can have topics
- [ ] The face-size warning shows on a laptop webcam and not on a phone with 2× zoom
- [ ] VoiceOver and TalkBack hear the hint once it holds, not every change
- [ ] The phone stays responsive and does not run out of memory during a run (7 frames kept at 4K)

## What the device keeps

Three things are kept on the device (`localStorage`): the language, the last subject form
(sex and age), and live mode's calibrations (a focal length per camera, resolution and zoom,
if one was made). Photos, camera frames, results and tokens stay in memory and in
requests to the API.
Object URLs are revoked as soon as nothing shows them, and a reload or "Start a new scan"
ends the scan.
