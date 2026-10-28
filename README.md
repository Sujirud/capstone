# facescan — facial aesthetic analysis core

`facescan` is the analysis engine of a facial analysis tool: it measures a face from photos
and gives recommendations, the report's considerations. It is a student capstone project,
used by classmates and the project advisor and run on a laptop for demos. It finds facial
landmarks in frontal and profile photos, computes aesthetic proportions and angles with
explicit uncertainty, compares them with reference standards, draws measurement overlays,
and produces a localized (Thai / English) view for the app. The web API that wraps it is a
separate project in [`api/`](api/README.md) (API Phases 1–3 are implemented). The web
client is in [`web/`](web/README.md) (milestones 1–5 are built, live mode included). The
[demo](#demo) runs all of it on one laptop.

| Phase | Scope | State |
|---|---|---|
| 1 | Frontal analysis: gates, landmarks, hairline, iris scale, F1–F11, uncertainty, overrides, overlays, `user_view`, `client_config` | **implemented** |
| 2 | Profile analysis: silhouette landmarks, in-app point adjustment with snap-to-contour, scale transfer, P1–P5 | **implemented** |
| 3 | Recommendation engine (rules file, consumer safety), `build_report` | **implemented** (ships illustrative example rules) |

See [`ASSUMPTIONS.md`](ASSUMPTIONS.md) for the decisions taken where the choice was open,
and [`TODO.md`](TODO.md) for the remaining work (clinical rules, validation).

> The core is not a clinical authority. Clinical values (norms, tolerance bands, rules)
> come only from the classical canon or from config files maintained by the clinical
> team. Every placeholder is marked `null` / `TODO` / "placeholder" in `facescan/config/`.

---

## Setup

Requirements: Python 3.10+ (tested on CPython 3.13, macOS arm64; the pins also resolve for
CPython 3.11 on linux/amd64, which the API's CI runs).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install -e .                                   # installs the `facescan` package
python -m facescan.tools.download_models           # once; files go to ./models
pytest                                             # 147 passed
```

Notes

* **MediaPipe is pinned to 1.0.0.** 1.0.1 aborts on macOS arm64 inside a Metal helper
  (`TensorsToDetectionsCalculator`) even with the CPU delegate.
* MediaPipe depends on `opencv-contrib-python`. Do not also install `opencv-python`
  (both provide `cv2`; uninstalling one breaks the other).
* **Model files** are downloaded once by `tools/download_models.py` and checked against
  pinned SHA-256 hashes; the engine never downloads at runtime. The URLs are Google's
  "latest" paths: if a hash no longer matches, validate the new model (debug sheet +
  tests) before pinning it.
* **Thai text in overlays** needs a Thai-capable font (candidates in
  `config/capture.yaml → render.font_candidates`, or `EngineConfig(font_path=…)`) and
  Pillow's RAQM layout for correct vowel and tone-mark placement. RAQM needs FriBiDi at
  runtime: Debian/Ubuntu `apt install libfribidi0 fonts-noto-core`; macOS
  `brew install fribidi` and `export DYLD_LIBRARY_PATH=/opt/homebrew/lib`. Without RAQM,
  overlays fall back to basic layout.

## Demo

The demo runs on one laptop: the API, the web app, and a tunnel that gives phones one HTTPS
address for both. A tunnel needs only internet access, so it works on campus Wi-Fi that keeps
devices from reaching each other.

Once: the Python environment with the core and the API (`api/README.md`, "Setup"), the
model files in `models/` (`python -m facescan.tools.download_models`; the web build copies
the face model from there for live mode), the web app's packages (`cd web && pnpm
install`), and `brew install fribidi cloudflared` (FriBiDi shapes the Thai overlay labels).

Then, from the repository root, in three terminals:

```bash
DYLD_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/python -m facescan_api   # the API: http://127.0.0.1:8000
cd web && pnpm preview                                                 # the web app: http://localhost:4173
cloudflared tunnel --url http://localhost:4173                         # prints https://<name>.trycloudflare.com
```

Open the printed address on the phones, and `http://localhost:4173` on the laptop. The web
app forwards `/v1` to the API, so the one address serves both. The address changes on every
run of the tunnel. No keys, secrets or settings files are needed. Reports use the core's
illustrative example rules (`rules_version: "EXAMPLE"`). The web app's live camera needs
HTTPS, which the tunnel's address gives (and `localhost` on the laptop); a plain
`http://<laptop address>` would offer photo mode only.

## Usage

### Python API

```python
from facescan import CameraInfo, EngineConfig, FaceScanEngine, Override, SubjectInfo, load_image, user_view

with FaceScanEngine(EngineConfig.from_models_dir("models")) as engine:       # one engine per worker process
    img = load_image(open("photo.jpg", "rb").read(),                        # decode + EXIF orientation
                     camera=CameraInfo(focal_px=2890.0, source="device"))    # optional; else EXIF
    subject = SubjectInfo(sex="female", age=28, norms_profile="canon")       # norms_profile: deployment config

    result = engine.analyze_frontal(img, subject=subject)                    # or a burst: [img1, …, img7]
    result.status                     # ok | no_face | multiple_faces | quality_failed
    result.quality.hint_keys          # e.g. ["hint.move_back"]

    # The user drags the hairline (the only user-adjustable frontal point by default):
    adjusted = engine.apply_overrides(result, {"trichion": Override(x=1012.5, y=388.0, source="user_adjusted")})

    overlay = engine.render_overlay(img, adjusted, layers={"landmarks", "thirds", "fifths", "labels"},
                                    style="user", locale="th")               # RGB numpy array
    app_json = user_view(adjusted, locale="th")                              # clinic-only data removed
    guidance = engine.client_config("th")                                    # thresholds + strings for the app

    result.model_dump_json()                                                 # lossless JSON round trip

    # Profile (Phase 2): the nose points to the image's right; the same session's frontal
    # result (status ok) calibrates mm by subnasale→menton.
    side = load_image(open("side.jpg", "rb").read())
    profile = engine.analyze_profile(side, subject=subject, facing="right", frontal=result)
    profile.status                    # ok | no_face | multiple_faces | quality_failed | contour_failed
    profile.contour                   # ≤ 400 silhouette points, for on-device snapping
    # The user drags points on the silhouette (re-snapped to the contour) and places the alar crease:
    profile = engine.apply_overrides(profile, {"subnasale": Override(x=1480.0, y=1102.0, source="user_adjusted"),
                                               "alar_crease": Override(x=1410.0, y=1060.0, source="user_adjusted")})
```

* `analyze_frontal` accepts one photo (uncertainty from 10 seeded test-time augmentations)
  or a burst of 3–15 identically sized frames (per-point median after aligning frames to
  the reference frame; across-frame SD, and below 5 frames the larger of that SD and a
  TTA estimate).
* Expected failures are statuses, not exceptions. Invalid input raises
  `InvalidInputError` / `ImageDecodeError`; bad overrides raise `UnknownPointError`,
  `PointNotAdjustableError` or `OverrideOutOfBoundsError`; `render_overlay` raises
  `ImageMismatchError` if the image is not the result's reference frame.
* `apply_overrides` needs no image and no models: metrics that use an adjusted point are
  recomputed with `landmark_sampling` uncertainty; everything else is copied. The result
  equals a full re-analysis with the same overrides (tested for exact equality).
* `analyze_profile` takes one photo; its uncertainty comes from the same seeded test-time
  augmentation (silhouette re-extracted on each augmented copy). Silhouette points are
  always re-snapped to the stored contour; the alar crease (needed for P3a) is placed by
  the user, so P3a has low confidence until a clinician places or confirms it.
* `build_report(frontal, profile)` combines the session's results into a `Report` with
  considerations from the clinical rules file (`EngineConfig(rules_path=…)`; without one
  the report has measurements only). `user_view(report)` shows each consideration with the
  triggering measurements, their reference range and the fixed advice to consult a
  licensed surgeon in person, plus the disclaimer. `engine.rules_info` names the loaded
  rules file (`rules_version`, `rules_hash`, `example`), or is None without one; `example`
  marks illustrative rules.

### Command line

```bash
# One photo → result.json, user_view_th.json, overlay_user.png, overlay_clinical.png
python -m facescan.apps.analyze_image photo.jpg --sex female --age 28 --out-dir out/ --styles user clinical

# A burst, with a known focal length and a hairline override
python -m facescan.apps.analyze_image f1.png f2.png f3.png f4.png f5.png --sex male --age 35 \
    --focal-px 2890 --override trichion=1012.5,388 --out-dir out/

# A profile photo; --frontal-result enables mm values by scale transfer
python -m facescan.apps.analyze_image side.jpg --view profile --facing right --sex female --age 28 \
    --frontal-result out/result.json --override alar_crease=1410,1060 --out-dir out_profile/

# Report with considerations from a rules file (results must come from the same models and config)
python -m facescan.apps.build_report --frontal-result out/result.json --profile-result out_profile/result.json \
    --rules clinic_rules.yaml --out-dir report/

# Reference guided-capture window (desktop webcam / kiosk; needs a 4K camera or a phone-as-webcam)
python -m facescan.apps.webcam_capture --out-dir out/ --sex female --age 28 --hfov-deg 68

# Landmark sign-off sheet for a sample image (add --all-indices to print every mesh index)
python -m facescan.tools.debug_landmarks photo.jpg --out sheet.png

# Validation against clinician-placed landmarks (CSV format in the module docstring)
python -m facescan.tools.evaluate --images-dir data/ --landmarks clinician.csv --out report.json
```

The same entry points are installed as `facescan-analyze`, `facescan-report`, `facescan-capture`,
`facescan-debug-landmarks`, `facescan-evaluate` and `facescan-download-models`. Only
these apps and tools write files, and only to paths given on the command line.

## Capture protocol

Frontal photo (text and illustrations for the app are in the locale files,
`capture.frontal`):

1. A helper takes the photo with the **rear camera from about 1.5 m using 2–3× zoom**, or
   the phone stands at eye level with a timer / voice trigger.
2. **No arm's-length selfies**: short distances enlarge the nose and mid-face.
3. Plain light background, even frontal lighting.
4. Hair pulled back to expose the hairline and temples; no glasses.
5. Natural head position, eyes on the lens; neutral expression, lips closed.

Server-side quality gates (all re-run on the server; defaults in `config/capture.yaml`,
software defaults to tune on real data):

| Check id | Rule (default) | Hint key on failure |
|---|---|---|
| `face_count` | exactly one face | `hint.no_face` / `hint.multiple_faces` |
| `face_in_frame` | every face-oval mesh point inside the photo (added: MediaPipe extrapolates cut-off points) | `hint.face_in_frame` |
| `camera_distance_m` | focal_px × 11.7 mm ÷ iris px ≥ 1.0 m; unknown focal → `unverified` | `hint.move_back` |
| `yaw_deg`, `pitch_deg` | within ±5° (facial transformation matrix) | `hint.turn_left/right`, `hint.chin_up/down` |
| `roll_deg` | within ±10° (then corrected in software) | `hint.head_level` |
| `expression_*` | jawOpen < 0.10, mouthSmile* < 0.20, eyeBlink* < 0.40, browInnerUp < 0.30 | `hint.close_mouth`, … |
| `ipd_px` | inter-pupillary distance ≥ 150 px | `hint.face_too_small` |
| `sharpness` | var(Laplacian) on the face ROI (256 px wide) ≥ 25 | `hint.hold_still` |
| `exposure_mean`, `exposure_clipped_frac` | face luma 60–205; < 2 % clipped | `hint.more_light/less_light`, `hint.avoid_glare` |
| `burst_good_frames` | ≥ 3 frames passing every gate together (bursts only) | `hint.hold_still` |

A capture with a failed gate has `status: quality_failed`; one with an unverified distance
passes but has `quality.considerations_eligible = false` and the warning
`distance_unverified`. Neither can ever trigger considerations.

Profile photo (`capture.profile` in the locale files): a true 90° profile taken the same
way, on a plain background that contrasts with skin and hair, hair behind the ear, camera
level, natural head position. The whole outline from forehead to neck must be visible
with nothing in front of it — in particular the **chin underside and some neck**.

| Check id (profile) | Rule (default) | Failure → status | Hint key |
|---|---|---|---|
| `face_count` | exactly one face-skin region | `no_face` / `multiple_faces` | `hint.no_face` / `hint.multiple_faces` |
| `background_contrast` | median Mahalanobis distance of face skin from the background colour model ≥ 6 | `contour_failed` | `hint.profile_background` |
| `facing` | face skin in front of the hair for the given `facing` (added) | `contour_failed` | `hint.profile_facing` |
| `contour_continuous` | one outline from above the face to below the chin, not cut by the frame | `contour_failed` | `hint.profile_in_frame` |
| `profile_points` | glabella, nasion, pronasale, subnasale, labrale superius, pogonion found (added) | `contour_failed` | `hint.profile_pose` |
| `pronasale_most_anterior` | no face-skin point in front of the nose tip (tolerance 0.5 % of face height) | `contour_failed` | `hint.profile_pose` |
| `landmark_order` | points in order along the outline; nasion, subnasale behind the tip | `contour_failed` | `hint.profile_pose` |
| `head_tilt_deg` | forehead-to-chin line within ±20° of vertical (added; P5 uses the true vertical) | `quality_failed` | `hint.profile_level` |
| `camera_distance_m` | profile mm/px × focal_px ≥ 1.0 m; without a frontal scale or focal length → `unverified` | `quality_failed` | `hint.move_back` |

Without a frontal result the profile has the warning `no_frontal_scale`: mm metrics are
`unavailable`, their ratio forms remain, and the distance is unverified.

**Resolution.** IPD in px ≈ focal_px × 63 mm ÷ distance. A 1080p webcam at 1 m gives about
85 px, so the reference capture app needs a 4K webcam with a moderate field of view (or a
phone used as a webcam); it warns at start-up when the camera cannot reach 150 px.

## What is measured

Frontal distances are projections onto face axes defined by the medial canthi, which removes
head roll. `_mm` metrics need the iris scale (11.7 mm ÷ mean horizontal iris diameter,
±4 %); without it they are `unavailable` and their `_pct_icd` / ratio forms remain.

| ID | Metrics | Canon (from `config/norms.yaml`) |
|---|---|---|
| F1 | `F1_upper_third`, `F1_middle_third`, `F1_lower_third`, `F1_middle_lower_ratio` | 1/3 each; 1 : 1 |
| F2 | `F2_lower_face_ratio` (subnasale→stomion ÷ stomion→menton) | 0.5 |
| F3 | `F3_fifth_outer_right` … `F3_fifth_outer_left` | 0.2 each |
| F4 | `F4_eye_icd_ratio_{right,left}`, `F4_icd_mm` | 1.0; 30–34 mm |
| F5 | `F5_canthal_tilt_{right,left}` | +2° to +8° |
| F6 | `F6_alar_icd_ratio` | 1.0 |
| F7 | `F7_commissure_offset_{side}_{pct_icd,mm}`; secondary `F7_mouth_alar_ratio`, `F7_mouth_ipd_ratio` | 0 (±5 % ICD); 1.5; 1.0 |
| F8 | `F8_lip_ratio` (lower ÷ upper vermilion) | 1.618 |
| F9 | `F9_brow_{head,apex,tail}_offset_{side}_{pct_icd,mm}`, `F9_brow_apex_ratio_{side}` | 0 (±5 % ICD); 2 : 1 |
| F10 | `F10_golden_ratio` — `display: clinic_only`, never in the app | 1.618 |
| F11 | `F11_asym_*` (left–right differences) | reported only (`no_reference`) |

Each metric records `value`, `unit`, `uncertainty` (+ method `tta` / `burst_sd` /
`landmark_sampling`), the resolved `canon` band, `deviation_abs`, `deviation_pct`,
`population` (mean / SD / z, when norms exist), `status`
(`within / above / below / inconclusive / unavailable / no_reference`), `status_basis`,
`display`, `role`, `confidence`, `flags` and `landmarks_used`. Out-of-range values within
2 × uncertainty are `inconclusive`. Formulas are listed in
`facescan/core/metrics_frontal.py` (`FRONTAL_METRICS[...].formula`) and
`facescan/core/metrics_profile.py` (`PROFILE_METRICS`).

Profile metrics (landmarks from the silhouette, not from MediaPipe):

| ID | Metrics | Canon |
|---|---|---|
| P1 | `P1_nasofrontal_angle` (glabella–nasion–pronasale) | 115°–130° |
| P2 | `P2_nasolabial_angle` (columella tangent vs subnasale→labrale superius) | 95°–105° |
| P3a | `P3a_tip_projection_goode` (needs the user-placed alar crease → low confidence) | 0.55–0.60 |
| P3b | `P3b_tip_projection_simons` (secondary) | 1.0 |
| P4 | `P4_eline_{upper,lower}_lip_mm` (needs the frontal scale); `P4_eline_*_pct` (% of E-line, always) | −4 to −2 mm; −2 to −1 mm; % forms reported only |
| P5 | `P5_forehead_inclination` (glabella→trichion vs image vertical; + = slopes back) | 12°–15° |

## Considerations and consumer safety

Considerations come only from a YAML rules file authored and signed off by the clinical
team (format and fields: `config/rules.example.yaml`). A rule has `all` / `any`
conditions on metric ids (`status_is` within / above / below, or `lt` / `le` / `gt` / `ge`
thresholds), optional `exclusions`, a `finding_key` and one or more `consideration_keys`
(one finding can have several possible causes — there is no one-to-one metric →
procedure mapping). The engine enforces, whatever a rules file says:

* **Eligible captures only** — the result's status is `ok` and every gate passed with a
  verified camera distance (`quality.considerations_eligible`).
* **Eligible metrics only** — status within / above / below (a reference range exists to
  show), high confidence, known uncertainty, no `large_user_adjustment` flag,
  `display: user`, `role: primary`; numeric thresholds must be passed by more than
  2 × the uncertainty (the margin of the `inconclusive` status).
* **Exclusions fail closed** — an exclusion that cannot be evaluated suppresses the rule.
* **Fail at start-up** — unknown metrics, clinic-only or secondary metrics in conditions,
  missing text keys in any locale, and rules without `approved_by` (in files not marked
  `example_not_clinically_validated`) stop the engine from starting.

All text is in the locale files (neutral wording, checked by a test); there are no scores,
rankings, prices or promises. Reports record `rules_version` and `rules_hash`, and keep a
per-rule audit trail (`rule_audit`: fired / not met / excluded, with the metrics that could
not count) for clinic QA; the consumer view leaves it out.

## Package layout

```
facescan/
  core/
    detector.py        MediaPipe Tasks wrappers (FaceLandmarker, ImageSegmenter), head pose
    landmark_map.py    named points → mesh indices (verified; see module docstring)
    geometry.py        distances, angles, face axes, point–line distance, tangent fitting, similarity
    normalize.py       load_image, EXIF focal length, face axes, iris scale
    quality.py         capture gates and burst aggregation
    hairline.py        head-crop hair segmentation, trichion scan
    frontal_points.py  detection → named points (mesh, trichion, temporal boundaries)
    metrics_frontal.py F1–F11 as a pure function of named points
    assemble.py        model-free landmarks → metrics assembly (used by apply_overrides)
    overrides.py       user / clinician overrides and adjustment rules
    reference.py       norms, canon bands, deviation, status, z-score
    uncertainty.py     TTA, burst SD, landmark sampling
    locale.py          locale strings, user_view
    schema.py          pydantic result models
    pipeline.py        FaceScanEngine, load_image, user_view
    config.py          EngineConfig, typed settings, config_hash
    profile_contour.py silhouette (background colour model + segmenter), contour landmarks, snap-to-contour
    metrics_profile.py P1–P5 from named points and the stored contour
    recommend.py       rules loading and validation, safety eligibility, rule evaluation, ReportBuilder
  render/overlay.py    overlays (user / clinical styles)
  apps/                analyze_image.py, build_report.py, webcam_capture.py
  tools/               download_models.py, debug_landmarks.py, evaluate.py
  config/              capture.yaml, norms.yaml, rules.example.yaml, locale_th.yaml, locale_en.yaml, evaluation.yaml
tests/                 unit tests (synthetic faces / profiles with known answers) + real-model smoke tests
```

## Performance (development Mac, Apple Silicon, 12.8 MP photos, warm engine)

| Operation | Time |
|---|---|
| `analyze_frontal`, one photo (1 + 10 TTA detections and segmentations) | ≈ 1.6 s |
| `analyze_frontal`, burst of 3 / 7 / 15 frames | ≈ 1.9 / 1.0 / 2.1 s |
| `analyze_profile`, one 12.4 MP photo (1 + 10 TTA silhouette passes, ≈ 0.36 s each) | ≈ 4 s (estimated from the pass time) |
| `apply_overrides` | ≈ 45 ms |
| `render_overlay` | ≈ 0.05 s |

The hair segmenter (≈ 120 ms per call, independent of input size) dominates. The first
analysis after start-up is slower (graph initialisation): warm up each worker once.

## Known limitations

* **Mesh points are approximations of anatomical landmarks.** MediaPipe's canonical mesh
  was not designed for anthropometry; medial canthi, alar points and especially brows
  can be offset from the clinical definitions. Brow points are low confidence unless a
  clinician confirms them. Validate with `tools/evaluate.py` on clinician-placed points.
* **Hairline** comes from a 256 × 256 segmentation model; bangs, receding or very light
  hair, and hats make it `unavailable` (the user can then place it, at low confidence).
* **Temporal boundaries** use the mesh face contour, which sits slightly inside the real
  face outline, and are rejected when temple hair reaches canthal level (common in short
  hair styles) — then F3 is unavailable.
* **Iris scale** assumes an adult iris of 11.7 mm (±4 %); children, some ocular
  conditions and strong eyelid coverage bias it. Glasses are not allowed.
* **Mirrored images** swap left and right labels; only unmirrored images are supported.
* **Faces cut by the frame**: points MediaPipe places outside the image are extrapolated, so
  they are reported `unavailable` and the `face_in_frame` gate fails the capture.
* **Camera distance** needs the focal length (device intrinsics or EXIF). Without it the
  capture is `unverified` and can never trigger considerations.
* **Thresholds are placeholders**: quality gates, tolerance bands and adjustment
  tolerances need tuning on real consumer captures; population norms are all `null`.
* **Profile silhouettes need the protocol.** Anything in front of the outline (hands,
  arms, a collar touching the chin, hair across the forehead or nose) or a background
  similar to skin or hair gives `contour_failed`. A dark nostril next to a dark
  background is closed by a ≈ 1 mm morphological closing, which also rounds concave
  corners by up to that much.
* **Profile landmarks are defined as extrema of the outline** (most anterior / deepest
  points in a face-aligned frame). Along flat parts of the outline — the forehead at the
  glabella — the position is poorly conditioned (≈ 1–2 % of the face height), although the
  anterior coordinate itself is precise. An idealized straight forehead–nose line (as in
  the test painting) has no nasion and fails.
* **Head pitch biases the profile mm scale**: the transfer uses vertical distances;
  on the synthetic profile a pitched photo shifts the transferred scale by ≤ 1.5 % at 10°
  and 2.6 % at 15° — within the reported ≈ 4 % scale uncertainty but systematic
  (ASSUMPTIONS 44).
* **Only illustrative rules ship.** `rules.example.yaml` is not clinically validated; the
  considerations it produces are examples of the format, not clinical advice. Clinically
  meaningful considerations need a rules file and finding / consideration wording signed off
  by the clinical team.
* **Profile validation is limited**: the `ok` path is tested on synthetic profiles with
  known answers; the two real test images (public domain) both break the protocol and
  are used for the failure paths. Accuracy on real consumer profile photos is unknown
  until `tools/evaluate.py` is run on clinician-marked captures.
* The reference capture app's loop has been exercised headlessly with a video file (live
  gates, streak, frame selection, burst analysis, outputs) but not with a physical 4K webcam.

## Stateless core and versioned results

The core is pure and stateless: images are processed in memory, nothing is written to disk,
no network calls are made (models load from local paths), and there is no global state.
Results keep only the named anatomical points, not the full mesh. Every result carries
`schema_version`, `core_version`, `config_hash` (hash of the capture settings, norms, locale
strings and model files) and `norms_profile`; reports add `rules_version` and `rules_hash`.
Rules are hashed separately because they do not change results, so a rules update does not
invalidate saved results.
