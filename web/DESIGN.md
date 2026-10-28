# Design

How the web app looks and reads, and why. The goal is a careful
measurement tool, closer to a lab report than a beauty app. The photo and the
measurements carry every screen; the interface stays quiet.

This file covers milestones 1–5:

- tokens, type and the core components;
- the landing page and "How it's measured";
- the subject screens;
- the frontal photo flow: guide with drawings, preview, analyzing, retake, results and
  point adjustment;
- the side photo: guide with drawings and the facing choice, preview, retake, results with
  the request to place the side of the nose, and adjustment along the face's outline;
- the report, on screen and printed;
- live mode: its introduction, the camera with one hint at a time, calibration, and its
  problems.

The component review page shows every component in both languages: open `#/components` in
the running app (for example `http://localhost:5173/#/components`).

## Tokens

All colours, type sizes, spacing and radii live in
[`src/styles/tokens.css`](src/styles/tokens.css). Tailwind reads them from there through
an `@theme inline` block. Tailwind's default theme is never loaded: its palette, fonts,
shadows and scales do not exist in this app. Two tests keep it that way:

- [`tests/tokens.test.ts`](tests/tokens.test.ts) parses the file and checks the contrast
  of every pair the components use.
- [`tests/tailwind.test.ts`](tests/tailwind.test.ts) compiles every class in `src/` with
  this theme and with Tailwind's default one. A class that only works with the default
  one fails the test: either a token is missing, or the default palette has leaked in.

| Token | Value | Use | Tested pairs (contrast) |
|---|---|---|---|
| `--paper` | `#F6F4EF` | page background | |
| `--surface` | `#FFFFFF` | measurement sheet, inputs, text on the primary button | on `--ink` 16.7, `--ink-2` 7.8, `--viewer` 13.8 |
| `--ink` | `#1B1E22` | primary text, primary button | on paper 15.2, surface 16.7, notice 13.7, accent-band 13.4 |
| `--ink-2` | `#4D535B` | secondary text, in-range marker, notice rule | on paper 7.1, surface 7.8, notice 6.4 |
| `--ink-3` | `#656A72` | metadata (dates, versions) | on paper 5.0, surface 5.4 only; on notice it is 4.45, so metadata inside notices uses `--ink-2` |
| `--line` | `#DDD9D0` | hairlines (decorative) | not tested (decorative) |
| `--line-strong` | `#7D8289` | input borders, range-bar ticks | graphic: paper 3.5, surface 3.9, accent-band 3.1 |
| `--accent` | `#1C64C4` | links, focus ring, selected state, out-of-range | text on paper 5.2, surface 5.7, notice 4.7, accent-band 4.6 |
| `--accent-band` | `#DCE7F7` | reference band on the range bar | |
| `--notice` | `#ECE8DF` | notice background | |
| `--viewer` | `#2A2D31` | surround for photos | |
| `--error` | `#A33A2B` | form validation on the subject screens only | on paper 6.0, surface 6.6 |
| `--point`, `--point-low`, `--point-shadow` | `#F5F5F5`, `#C8C8C8`, `#282828` | points the app draws on photos (the adjustment view, the fallback points) | the core's `user` overlay palette (`point`, `point_low`, `shadow` in `overlay.py`); a test compares them |

- **Accent.** `--accent` has the hue of the overlay's `USER_ACCENT` (`#409CFF` in
  `facescan/render/overlay.py`), one step darker for contrast. A test reads the overlay
  file and fails if the hues drift apart by more than 6°.
- **Spacing.** A 4 px scale: `1 2 3 4 6 8 12` in Tailwind names (4 … 48 px), plus `0`.
  Other steps, such as `p-5`, produce no CSS; the Tailwind test catches them.
- **Radius.** 4 px for controls (`rounded-control`) and 8 px for the photo viewer
  (`rounded-viewer`). Nothing else is rounded, and nothing has a shadow: hairlines only.
- **Motion.** 180 ms ease-out. The only looping animation is the indeterminate
  progress line. With reduced motion, every animation and transition stops, and the
  progress lines are hidden: the status text remains.

## Type

- **Family.** IBM Plex Sans Thai only, weights 400, 500 and 600. It is self-hosted in
  `public/fonts/`: the Thai and Latin subsets, 104 kB in all. `pnpm fonts` copies them
  from the pinned `@fontsource` package, with the OFL licence.
- **Scale.** 14, 16, 18, 22 and 28 px, written in rem so text follows the reader's own
  text-size setting. Body text is 16 px and nothing is smaller than 14 px. h1 is 28 px.
  h2 is 18 px in the sheet and 22 px on the component page.
- **Line height.** 1.7 for body text (14–16 px) and 1.35 for headings (18–28 px). Nothing
  combines a tight line height with `overflow: hidden`.
- **Thai.** There is no letter-spacing and no justified text. `word-break: normal`
  leaves line breaking to the browser's Thai dictionary. `overflow-wrap: anywhere`
  (`.break-token`) is used for request ids only. Headings use `overflow-wrap:
  break-word`, which breaks a word only when it is longer than a whole line; this is
  needed for reflow at 320 px and 200 % text.
- **Numbers.** Values and references use `tabular-nums`.
- **Language.** `lang` on the document follows the chosen language. Embedded text in
  the other language carries its own `lang`: the language control, version strings and
  request ids.

## Layout and components

| Component | Where | Notes |
|---|---|---|
| Page frame | [`Screen`](src/components/layout/Screen.tsx) | Skip link, top bar, one h1, a 640 px column (1200 px for wide pages) and the optional action bar. On every step change, focus moves to the new heading. The first screen after a page load leaves focus at the start, so the skip link is the first Tab stop. |
| Top bar and step | [`TopBar`](src/components/layout/TopBar.tsx) | Back (icon with `aria-label`), the step text ("ขั้นที่ 2 จาก 4 · ภาพหน้าตรง") and the language control. The step progress is a 2 px `--ink-2` line along the bar's lower edge, within the column. There are no numbered circles. |
| Action bar | [`ActionBar`](src/components/layout/ActionBar.tsx) | Sticky at the bottom, with a top hairline, above the safe-area inset. It holds one primary button. Its height feeds `scroll-padding-bottom`, so a focused control is never hidden behind it. |
| Buttons | [`Button`](src/components/ui/Button.tsx) | Primary: solid ink. Secondary: outlined. Tertiary: an underlined accent link. Labels are verbs, and buttons are at least 44 × 44 px. |
| Text field | [`TextField`](src/components/ui/TextField.tsx) | Visible label and help. The error is in `--error`, is linked with `aria-describedby` and receives focus on submit. |
| Single choice | [`RadioCards`](src/components/ui/RadioCards.tsx) | A Radix radio group: one Tab stop, arrow keys choose. Rows are 48 px, and the selected row has an accent border and dot plus weight 500. |
| Segmented control | [`SegmentedControl`](src/components/ui/SegmentedControl.tsx) | A Radix toggle group. The selected option is marked by accent text on the band colour, weight 600 and a border, not by colour alone. |
| Notice | [`Notice`](src/components/ui/Notice.tsx) | A 3 px `--ink-2` rule on `--notice`, with an optional info glyph. Used for the core's warnings and notes. |
| Error message | [`ErrorMessage`](src/components/ui/ErrorMessage.tsx) | The localized message for the problem `code` and the request id in small type, with `role="alert"`. The API's `detail` is never shown. |
| Progress | [`ProgressLine`](src/components/ui/ProgressLine.tsx) | A 3 px determinate line for uploads and an indeterminate one while analyzing, with text next to it ("กำลังอัปโหลด 45 %"). It is hidden with reduced motion. |
| Range bar | [`RangeBar`](src/components/results/RangeBar.tsx) | The band in `--accent-band` has `--line-strong` ticks at min and max. The scale is the band plus half its width on each side, so the band is the middle half. The marker is `--ink-2` within the range and `--accent` above or below it. A value beyond the scale becomes an arrow at the edge. The bar is hidden from assistive technology (the status is text) and is drawn only for within, above and below. |
| Metric row | [`MetricRow`](src/components/results/MetricRow.tsx) | Line 1: `name` and `value_text`, then a chevron in a fixed column at the end. Line 2: `reference.label reference.text · status_text`, with out-of-range status text in accent at weight 600. Then the range bar, then `confidence_text` (when low) and flag texts, always visible. A tap expands `description`. No status icons. |
| Measurement sheet | [`MeasurementSheet`](src/components/results/MeasurementSheet.tsx) | One white sheet with hairline rows, grouped by `area` in the API's order under the core's area names. `role: secondary` metrics sit in a collapsed "More details" section. |
| Scan footer | [`ScanMeta`](src/components/results/ScanMeta.tsx) | The date (`th-TH` in the Buddhist era, or `en-GB`) and the API, core and schema versions, in `--ink-3`. |
| Photo viewer | [`PhotoViewer`](src/components/viewer/PhotoViewer.tsx), [`useZoomPan`](src/components/viewer/useZoomPan.ts) | The `user` overlay on a `--viewer` surround with 8 px corners, at the photo's aspect ratio and no taller than 70 % of the screen. Pinch, double-tap and Ctrl/⌘ + wheel zoom inside it, with zoom buttons as the alternative. At 1× a vertical swipe scrolls the page. A two-option switch shows "with measurement lines" or "original". |
| Fallback points | [`PointsLayer`](src/components/viewer/PointsLayer.tsx) | Without an overlay, the app draws the points in image pixels: filled dots for automatic points, hollow rings for adjusted ones, and the lighter shade for low confidence. |
| Adjustment view | [`AdjustView`](src/components/adjust/AdjustView.tsx) | The photo framed on the face, and the point as a filled dot, or a hollow ring once moved, drawn in an SVG layer in image pixels. The view's other adjustable points are smaller dots (rings once moved). A 44 px handle takes drag, focus and arrow keys; a drag keeps the offset from where the handle was taken, so the point never jumps under the finger. While dragging, a round loupe at 2.5× with an accent crosshair shows above the finger, or beside it near the top edge. Arrow buttons (with text) and zoom buttons sit below the photo; a press is the button's click, so they work with touch, keyboard and screen readers, and holding repeats. Tapping places the point. A side point on the outline slides along it: the outline is drawn as a thin `--point` line with a dark edge, every drag and tap lands on it, and two buttons move it "toward the forehead" and "toward the chin" (↑ ↓ keys, 1 px of outline, 10 with Shift). |
| Adjustment screen | [`AdjustScreen`](src/screens/scan/AdjustScreen.tsx) | On a phone: the point picker, the point's name and instruction (the core's, verbatim), then the photo, so choosing a point never scrolls the photo away. From 1024 px they sit to the right of the photo. For the side of the nose, the drawing sits beside the instruction. |
| Point picker | [`Select`](src/components/ui/Select.tsx) | The platform's own select, with a visible label: a 48 px row with a `--line-strong` border, 4 px corners and a chevron. On a phone it opens the phone's own list. Used when a view has more than one adjustable point (ten on the side photo); a list of radio rows below the photo pushed the photo off screen on every choice. |
| Facing choice | [`FacingChoice`](src/screens/scan/FacingChoice.tsx) | Two cards in one radio group: a head in profile with an accent arrow for the way the nose points, and the words "Left" / "Right". The selected card has an accent border and dot and weight 500. The whole card is the label. |
| Side-of-the-nose request | [`AlarCreasePrompt`](src/screens/scan/AlarCreasePrompt.tsx) | Under the photo on the side results while the point has no position: the core's point name as an h2, the close-up drawing, one sentence naming the measurement that needs it, and "Place the point". A hairline above, no box. |
| Capture drawings | [`Guide`](src/components/illustrations/Guide.tsx), [`Profile`](src/components/illustrations/Profile.tsx) | Line drawings with a 1.75 px `--ink` stroke and round caps, with `--accent` on the one detail to notice. The pairs are helper at a distance (like this) and arm's-length selfie (not like this, with a cross). The distance label comes from `client-config`. Text in a drawing is at least 14 px as shown (the "2×" zoom button included; tested). Each drawing is named by its instruction. The side photo's five use one plain head in profile (mirrored for the left-facing card): the 90° turn seen from above (a camera icon, the line of sight, an accent arc), the plain background, the hair behind the ear, the line of sight to a point at eye level, and the chin and neck in view. The side of the nose is a close-up of the nose with the point ringed in accent, cropped so it reads at 8–10 rem. |
| Upload and analysis | [`AnalyzingScreen`](src/screens/scan/AnalyzingScreen.tsx) | The photo dimmed to 40 % and not interactive. A determinate line shows the real upload percent, then an indeterminate line with "analyzing · usually 2–5 seconds" and the elapsed seconds. There is no beam or animation over the photo. With reduced motion, text only. |
| Confirmation | [`ConfirmDialog`](src/components/ui/ConfirmDialog.tsx) | A Radix dialog: a white panel with a hairline border, no shadow, over an ink scrim at 40 %. It is used before results would be lost (new scan, language switch). |
| Scan errors | [`ScanErrorPanel`](src/screens/scan/ScanErrorPanel.tsx) | The error notice plus the actions its code allows: retake, analyze again, start over, or try again (disabled until the rate limit's time, which is shown). After a second timeout, another photo is offered instead of a retry. |
| Landing drawing | [`ResultSheetDrawing`](src/components/illustrations/Landing.tsx) | A result sheet, drawn: a plain head on the viewer's surround with three dashed measurement lines, rows of text as plain lines, and three range bars, one with its marker outside the band in the accent. No real face, no words to read. |
| Discussion topic | [`ConsiderationItem`](src/components/report/ConsiderationItem.tsx) | An article under a hairline: the area as an h3, the severity as a line of small text (not a badge), the finding, "Possible topics" as a list, "Measurements" as rows in a white sheet (name, value, reference and status, out-of-range status in accent at weight 600), and the consult sentence. |
| Measurement table | [`MeasurementTable`](src/components/results/MeasurementTable.tsx) | The report's table: a semantic `<table>` with column headers and area row-group headers, every metric of a photo, caveats under the name. A reference label shared by every row heads its column; the cells hold the ranges. On a narrow screen, two columns (measurement, value) with the reference and status under the name. |
| Checkbox | [`Checkbox`](src/components/ui/Checkbox.tsx) | The platform's own checkbox in the accent, with its visible label; the row is at least 44 px tall, and a note under it (why it is off) is linked to it. Used for "Read the hints aloud". |
| Live camera | [`LiveScreen`](src/screens/scan/LiveScreen.tsx) | The camera view in the photo viewer's `--viewer` surround, at most 60 % of the screen's height, mirrored only for the front camera. Nothing is drawn over it: no landmarks, mesh, frame or beam. Under it, the core's hint in the largest size (28 px, weight 600), one at a time, with room for two lines so the page does not jump; when every check passes, "Hold still" and a line for the real run of passing frames. Then zoom (a segmented control), "Switch camera", "Read the hints aloud", and notices for the face size and the unchecked distance, the latter with "Calibrate the distance". Calibration is a section under a hairline: an h2 (focused), two numbered steps, "n of 30 frames" and its line. |
| Report photo | [`ReportFigure`](src/components/report/ReportFigure.tsx) | The latest overlay, small (16 rem, 60 mm in print), beside its table from 1024 px; the app's points on the photo when the overlay could not be redrawn. |

### Print

The report prints as an A4 document ([`index.css`](src/styles/index.css), print tokens in
[`tokens.css`](src/styles/tokens.css)):

- **Page.** A4 from `@page`, 14 mm margins (16 mm at the foot). The type sizes are the
  screen's: 16 px (12 pt) body text and nothing below 14 px (10.5 pt).
- **Colour.** Black on white: paper, surfaces and notices are white, text black, secondary
  text #333 for hierarchy, the accent black. Accent text becomes weight 600, so an
  out-of-range status still stands out. Photos keep their colours.
- **Content.** A header with the scan's date and the versions; the example-rules note; the
  topics; each photo with its measurement table; the disclaimer last.
- **Removed.** The top bar, the action bar, buttons, dialogs and the page footer.
- **Breaks.** Table rows, topics and photos are not split across pages.
- **Checked** in an end-to-end test: Chromium prints a PDF whose page is A4 (595 × 842 pt),
  and in print media the page is black on white with no buttons and the disclaimer last.

## Glossary

The web app reuses the core's terms exactly and never invents synonyms for them.
[`tests/glossary.test.ts`](tests/glossary.test.ts) checks that every term below appears
verbatim in `facescan/config/locale_th.yaml` and `locale_en.yaml`.

<!-- glossary:start -->
| Concept | ไทย | English | Core key |
|---|---|---|---|
| reference range | ช่วงอ้างอิง | reference range | `status.*` |
| classical proportion reference | สัดส่วนอ้างอิงแบบคลาสสิก | Classical proportion reference | `reference.canon` |
| typical range | ช่วงที่พบได้ทั่วไป | Typical range | `reference.population` |
| hairline | แนวไรผม | Hairline | `point.trichion.name` |
| side of the nose | ข้างปีกจมูก | Side of the nose | `point.alar_crease.name` |
| nose tip | ปลายจมูก | Nose tip | `point.pronasale.name` |
| outline (of the face) | เส้นขอบ | outline | `point.glabella.instruction`, `check.contour_continuous` |
| millimetre values | ค่าเป็นมิลลิเมตร | Millimetre values | `warning.no_frontal_scale` |
| measurement line | เส้นการวัด | Measurement line | `overlay.measured` |
| detected point | จุดที่ระบบตรวจพบ | Detected point | `overlay.auto_point` |
| adjusted point | จุดที่ปรับเอง | Adjusted point | `overlay.adjusted_point` |
| approximate point | จุดโดยประมาณ | Approximate point | `overlay.low_confidence_point` |
| front photo | ภาพหน้าตรง | front photo | `capture.frontal.title` |
| side photo | ภาพด้านข้าง | side photo | `capture.profile.title` |
| eye spacing | ระยะหัวตา | eye spacing | `units.%ICD` |
| camera distance | ระยะห่างจากกล้อง | camera distance | `check.camera_distance_m`, `warning.distance_unverified` |
| shown for information | แสดงเพื่อเป็นข้อมูล | Shown for information | `status.no_reference` |
| licensed plastic surgeon | ศัลยแพทย์ตกแต่งที่มีใบอนุญาต | licensed plastic surgeon | `disclaimer.consult` |
<!-- glossary:end -->

The web strings use these terms: the step labels "ภาพหน้าตรง" and "ภาพด้านข้าง",
"มีเส้นการวัด" for the viewer toggle, "แนวไรผม" in milestone 2, and "เส้นขอบ" ("the
outline"), "ปลายจมูก" and "มิลลิเมตร" on the side-photo screens. The side of the nose is
always called by the core's point name.

## Copy

- **Thai.** Polite and neutral, with no ครับ / ค่ะ. Requests use the core's "กรุณา…"
  form, and sentences are short. "คุณ" appears only where the core uses it
  ("ข้อมูลของคุณ", "เพศของคุณ", "อายุของคุณ").
- **English.** Plain, in sentence case, with no Title Case headings. A test checks the
  heading keys.
- **Errors** say what happened and what to do next, without blame, for example "The
  service could not be reached. Please check the internet connection and try again."
- **Tests.** [`tests/i18n.test.ts`](tests/i18n.test.ts) checks that Thai and English have
  the same keys and placeholders, and that no string has an exclamation mark, a gendered
  particle, a hype word or one of the core's banned or promotional terms.

## Screenshots

Screenshots are made with `pnpm screenshots`, against the mocked API, at 360 px and
1280 px, in Thai and English. The files are in [`docs/screenshots/`](docs/screenshots/),
named `<screen>.<language>.<width>.png`.

- The "photo" is a line drawing of the core's synthetic test face, and the overlays are
  the core's own rendering of it. Live mode's camera is Chromium's fake camera playing the
  same drawing; the hint is what MediaPipe and the gate port make of it.
- In full-page pictures the sticky action bar appears where the viewport ended, part-way
  down the page. On a phone it stays at the bottom of the screen.
- States that differ only at the top are viewport pictures: results after an adjustment,
  an open dialog, and a drag in progress.

| Screen | th 360 | en 360 | 1280 |
|---|---|---|---|
| Subject: sex | <img src="docs/screenshots/subject-sex.th.360.png" width="160" alt="Sex question, Thai"> | <img src="docs/screenshots/subject-sex.en.360.png" width="160" alt="Sex question, English"> | [th](docs/screenshots/subject-sex.th.1280.png) · [en](docs/screenshots/subject-sex.en.1280.png) |
| Subject: age, invalid | <img src="docs/screenshots/subject-age-error.th.360.png" width="160" alt="Age question with an inline error, Thai"> | <img src="docs/screenshots/subject-age-error.en.360.png" width="160" alt="Age question with an inline error, English"> | [th](docs/screenshots/subject-age-error.th.1280.png) · [en](docs/screenshots/subject-age-error.en.1280.png) |
| Frontal guide, with drawings | <img src="docs/screenshots/frontal-guide.th.360.png" width="160" alt="Frontal capture guide with drawings, Thai"> | <img src="docs/screenshots/frontal-guide.en.360.png" width="160" alt="Frontal capture guide with drawings, English"> | [th](docs/screenshots/frontal-guide.th.1280.png) · [en](docs/screenshots/frontal-guide.en.1280.png) |
| Live camera: introduction and limits | <img src="docs/screenshots/live-intro.th.360.png" width="160" alt="Live camera introduction with its limits, Thai"> | <img src="docs/screenshots/live-intro.en.360.png" width="160" alt="Live camera introduction with its limits, English"> | [th](docs/screenshots/live-intro.th.1280.png) · [en](docs/screenshots/live-intro.en.1280.png) |
| Live camera: a hint | <img src="docs/screenshots/live-camera.th.360.png" width="160" alt="Live camera with the core's hint and the notices, Thai"> | <img src="docs/screenshots/live-camera.en.360.png" width="160" alt="Live camera with the core's hint and the notices, English"> | [th](docs/screenshots/live-camera.th.1280.png) · [en](docs/screenshots/live-camera.en.1280.png) |
| Live camera: calibration | <img src="docs/screenshots/live-calibration.th.360.png" width="160" alt="Calibrating the distance, Thai"> | | [en](docs/screenshots/live-calibration.en.1280.png) |
| Live camera: camera refused | <img src="docs/screenshots/live-denied.th.360.png" width="160" alt="The camera was not allowed, Thai"> | | [en](docs/screenshots/live-denied.en.1280.png) |
| Preview | <img src="docs/screenshots/preview.th.360.png" width="160" alt="Photo preview before sending, Thai"> | <img src="docs/screenshots/preview.en.360.png" width="160" alt="Photo preview before sending, English"> | [th](docs/screenshots/preview.th.1280.png) · [en](docs/screenshots/preview.en.1280.png) |
| Uploading and analyzing | <img src="docs/screenshots/analyzing.th.360.png" width="160" alt="The dimmed photo with the upload progress, Thai"> | <img src="docs/screenshots/analyzing.en.360.png" width="160" alt="The dimmed photo with the upload progress, English"> | [th](docs/screenshots/analyzing.th.1280.png) · [en](docs/screenshots/analyzing.en.1280.png) |
| Retake | <img src="docs/screenshots/retake.th.360.png" width="160" alt="Retake guidance with the core's hints, Thai"> | <img src="docs/screenshots/retake.en.360.png" width="160" alt="Retake guidance with the core's hints, English"> | [th](docs/screenshots/retake.th.1280.png) · [en](docs/screenshots/retake.en.1280.png) |
| Retake, third failure: full protocol | <img src="docs/screenshots/retake-protocol.th.360.png" width="160" alt="Retake guidance with the full protocol, Thai"> | <img src="docs/screenshots/retake-protocol.en.360.png" width="160" alt="Retake guidance with the full protocol, English"> | [th](docs/screenshots/retake-protocol.th.1280.png) · [en](docs/screenshots/retake-protocol.en.1280.png) |
| Results | <img src="docs/screenshots/results.th.360.png" width="160" alt="Frontal results: overlay and measurement sheet, Thai"> | <img src="docs/screenshots/results.en.360.png" width="160" alt="Frontal results: overlay and measurement sheet, English"> | [th](docs/screenshots/results.th.1280.png) · [en](docs/screenshots/results.en.1280.png) |
| Results after an adjustment | <img src="docs/screenshots/results-adjusted.th.360.png" width="160" alt="Results after moving the hairline, Thai"> | <img src="docs/screenshots/results-adjusted.en.360.png" width="160" alt="Results after moving the hairline, English"> | [th](docs/screenshots/results-adjusted.th.1280.png) · [en](docs/screenshots/results-adjusted.en.1280.png) |
| Adjust points | <img src="docs/screenshots/adjust.th.360.png" width="160" alt="The hairline adjustment view, Thai"> | <img src="docs/screenshots/adjust.en.360.png" width="160" alt="The hairline adjustment view, English"> | [th](docs/screenshots/adjust.th.1280.png) · [en](docs/screenshots/adjust.en.1280.png) |
| Adjust, dragging (loupe) | <img src="docs/screenshots/adjust-dragging.th.360.png" width="160" alt="Dragging the hairline with the loupe, Thai"> | <img src="docs/screenshots/adjust-dragging.en.360.png" width="160" alt="Dragging the hairline with the loupe, English"> | [th](docs/screenshots/adjust-dragging.th.1280.png) · [en](docs/screenshots/adjust-dragging.en.1280.png) |
| Language switch with results | <img src="docs/screenshots/language-dialog.th.360.png" width="160" alt="Confirmation before re-analysis in the other language, Thai"> | <img src="docs/screenshots/language-dialog.en.360.png" width="160" alt="Confirmation before re-analysis in the other language, English"> | [th](docs/screenshots/language-dialog.th.1280.png) · [en](docs/screenshots/language-dialog.en.1280.png) |
| Error: rate limited | <img src="docs/screenshots/error-rate-limited.th.360.png" width="160" alt="A rate-limit error with the time to try again, Thai"> | <img src="docs/screenshots/error-rate-limited.en.360.png" width="160" alt="A rate-limit error with the time to try again, English"> | [th](docs/screenshots/error-rate-limited.th.1280.png) · [en](docs/screenshots/error-rate-limited.en.1280.png) |
| Side guide: facing choice and drawings | <img src="docs/screenshots/profile-guide.th.360.png" width="160" alt="Side-photo guide with the facing choice and drawings, Thai"> | <img src="docs/screenshots/profile-guide.en.360.png" width="160" alt="Side-photo guide with the facing choice and drawings, English"> | [th](docs/screenshots/profile-guide.th.1280.png) · [en](docs/screenshots/profile-guide.en.1280.png) |
| Side preview, facing to check | <img src="docs/screenshots/profile-preview.th.360.png" width="160" alt="Side photo before sending, with the facing choice, Thai"> | <img src="docs/screenshots/profile-preview.en.360.png" width="160" alt="Side photo before sending, with the facing choice, English"> | [th](docs/screenshots/profile-preview.th.1280.png) · [en](docs/screenshots/profile-preview.en.1280.png) |
| Side retake (`contour_failed`) | <img src="docs/screenshots/profile-retake.th.360.png" width="160" alt="Side-photo retake guidance with the core's hints, Thai"> | <img src="docs/screenshots/profile-retake.en.360.png" width="160" alt="Side-photo retake guidance with the core's hints, English"> | [th](docs/screenshots/profile-retake.th.1280.png) · [en](docs/screenshots/profile-retake.en.1280.png) |
| Side results, side of the nose requested | <img src="docs/screenshots/profile-results.th.360.png" width="160" alt="Side results with the request to place the side of the nose, Thai"> | <img src="docs/screenshots/profile-results.en.360.png" width="160" alt="Side results with the request to place the side of the nose, English"> | [th](docs/screenshots/profile-results.th.1280.png) · [en](docs/screenshots/profile-results.en.1280.png) |
| Side adjust: the side of the nose | <img src="docs/screenshots/profile-adjust-alar.th.360.png" width="160" alt="Placing the side of the nose, with its drawing, Thai"> | <img src="docs/screenshots/profile-adjust-alar.en.360.png" width="160" alt="Placing the side of the nose, with its drawing, English"> | [th](docs/screenshots/profile-adjust-alar.th.1280.png) · [en](docs/screenshots/profile-adjust-alar.en.1280.png) |
| Side adjust: a point on the outline | <img src="docs/screenshots/profile-adjust-outline.th.360.png" width="160" alt="The nose tip on the drawn outline, Thai"> | | [en](docs/screenshots/profile-adjust-outline.en.1280.png) |
| Side results after placing the point | <img src="docs/screenshots/profile-results-adjusted.th.360.png" width="160" alt="Side results with the redrawn overlay, Thai"> | | [en](docs/screenshots/profile-results-adjusted.en.1280.png) |
| Side results, frontal scale unusable | <img src="docs/screenshots/profile-results-no-scale.th.360.png" width="160" alt="The note that millimetre values are not shown, Thai"> | | [en](docs/screenshots/profile-results-no-scale.en.1280.png) |
| Landing | <img src="docs/screenshots/landing.th.360.png" width="160" alt="Landing page, Thai"> | <img src="docs/screenshots/landing.en.360.png" width="160" alt="Landing page, English"> | [th](docs/screenshots/landing.th.1280.png) · [en](docs/screenshots/landing.en.1280.png) |
| How it's measured | <img src="docs/screenshots/method.th.360.png" width="160" alt="How it's measured, Thai"> | <img src="docs/screenshots/method.en.360.png" width="160" alt="How it's measured, English"> | [th](docs/screenshots/method.th.1280.png) · [en](docs/screenshots/method.en.1280.png) |
| Report | <img src="docs/screenshots/report.th.360.png" width="160" alt="Report with a discussion topic and the measurement tables, Thai"> | <img src="docs/screenshots/report.en.360.png" width="160" alt="Report with a discussion topic and the measurement tables, English"> | [th](docs/screenshots/report.th.1280.png) · [en](docs/screenshots/report.en.1280.png) |
| Report without topics (front photo only) | <img src="docs/screenshots/report-no-topics.th.360.png" width="160" alt="Report with the core's note that there are no topics, Thai"> | | [en](docs/screenshots/report-no-topics.en.1280.png) |
| Report, print view (A4) | <img src="docs/screenshots/report-print.th.a4.png" width="160" alt="The printed report, Thai"> | <img src="docs/screenshots/report-print.en.a4.png" width="160" alt="The printed report, English"> | PDF: [th](docs/screenshots/report-print.th.pdf) · [en](docs/screenshots/report-print.en.pdf) |
| Service not reachable | <img src="docs/screenshots/service-unreachable.th.360.png" width="160" alt="Service not reachable, Thai"> | <img src="docs/screenshots/service-unreachable.en.360.png" width="160" alt="Service not reachable, English"> | [th](docs/screenshots/service-unreachable.th.1280.png) · [en](docs/screenshots/service-unreachable.en.1280.png) |
| Component page (full length) | [th](docs/screenshots/components.th.360.png) | | [en](docs/screenshots/components.en.1280.png) |

The side photo's variant states (the last three side rows), live mode's calibration and
refused camera, and the report without topics are captured in one language per width, like
the component page. The print view is captured at
A4 width (794 px) in print media, and the PDFs are what Chromium prints from it.

## Design review, milestones 1–5

**The generic "AI-generated" look is absent from every screenshot.**

- No gradients, glass or blur, glows or a dark theme. The theme is light only, and
  `color-scheme: light` is set.
- No face meshes, scanning beams, stock photos, mascots or 3D shapes.
  - While the photo is analyzed it is only dimmed, with no line or animation over it.
  - Live mode draws nothing over the camera view: the detected points stay in the code, and
    the only feedback is the hint text and a line for the real run of passing frames.
  - The overlay is the core's own measurement drawing.
  - The guide's figures are neutral line drawings.
- No hero section, fake statistics, testimonials or feature-card grid. The landing page is
  one sentence, a drawing of a result sheet, the disclaimer, who made it, and one action.
- No large rounded cards, shadows or pill badges. The report's severity is a line of text.
  The default Tailwind palette and Inter are not loaded, and a test enforces that.
- No sparkle, wand, brain or robot icons, and no emoji. Lucide outline icons at a
  1.5 px stroke appear only next to text (the chevron, the notice glyph), plus back with
  an `aria-label`.
- No bouncing, springs, shimmer skeletons or confetti. Loading is a line of text.
- No hype words or exclamation marks. A test enforces that.

**Copy:** it has been reviewed against the rules above.

- The guide's steps, the hints, the check and warning names, point names and
  instructions, and every measurement text are the core's own, rendered verbatim.
- Messages about the photo say what happened without blame, for example "This photo
  cannot be measured yet".
- The report's topics, measurements, notes and disclaimer are the core's, verbatim and in its
  order; the web adds only its labels ("Possible topics", "Measurements", the column
  headings) and the example-rules note. Nothing counts or ranks the topics.
- "How it's measured" quotes the core's words where they exist (the `inconclusive` status,
  the classical reference's name) and promises nothing about accuracy.

**Automated checks, all passing:**

- axe (WCAG 2.2 AA tags) on every screen in WebKit and Chromium mobile emulation, with
  no serious or critical violations;
- the token contrast test;
- the Tailwind class test;
- reflow at 320 px with 200 % text, with no horizontal scroll, on the landing, method,
  subject, component, guide, preview, analyzing, retake, results, adjust and report screens;
- a keyboard-only pass in Chromium (`e2e/foundation.spec.ts`, `e2e/report.spec.ts`): the
  landing page's skip link, method link and Start (in view, in the action bar); the subject
  form's radio group with arrow keys, the sticky primary button in view, and Enter to
  submit. WebKit, like Safari, skips links on Tab unless full keyboard access is on, so the
  pass runs in Chromium only.

The automated checks now also include:

- milestone-2 screens under axe: guide, preview and analyzing (the preview and analyzing
  screens since the review of milestones 1–4), retake, results, adjust, the dialogs and the
  error panels;
- milestone-3 screens under axe: the side guide, preview, retake, results and adjustment
  (placing the side of the nose), and the ended-scan panel; reflow at 320 px with 200 %
  text on the same screens;
- the adjustment's alternatives in end-to-end tests: a drag taken off-centre, the arrow
  keys, and the arrow buttons by touch tap and mouse click; in component tests also a click
  alone, as TalkBack and Voice Access send it, and Enter. On the side photo: a tap places the
  side of the nose, a drag off the face keeps the nose tip on the outline, and the ↑ ↓ keys
  and the along-the-outline buttons move a point along it.

- milestone-4 screens under axe: the landing page, the method page and the report (with a
  topic, and its tables); the print view checked in print media and as a PDF.
- milestone-5 screens under axe: the live introduction (both engines), and the running
  camera and calibration (Chromium's fake camera, with the real model); reflow at 320 px
  with 200 % text on the introduction and the running camera; focus moving to the
  calibration heading.

**Changes made in this review (milestone 5):**

- The hint first kept room for three lines, which left a gap under the usual one-line hint;
  it keeps two.
- The face-size notice repeated "Take or choose a photo instead", which the action bar
  already holds; the notice now only explains.

**Changes made in the review of milestones 1–4:**

- The guides say how to move a photo from the phone to a desktop without losing its camera
  details; the note was missing.
- Print uses the screen's type sizes, so nothing is below 14 px.
- ๆ no longer starts a line in the web's own Thai strings (a no-break space before it); the
  core's strings still can (request 11 in `ASSUMPTIONS.md`), as in capture step 6 at 360 px.

**Changes made in this review (milestone 4):**

- The report's tables first sat in the 640 px text column, and every row wrapped (8,274 px of
  page at desktop width). They now use the wide page beside their photos, and a reference
  label shared by every row heads its column instead of repeating in each row (5,814 px).
- "Start a new scan" left the action bar for the page footer: the bar holds the next step.

**Changes made in this review (milestone 3):**

- The point picker moved from a list of ten radio rows under the photo to a select above
  it: on a phone, each choice scrolled the photo off screen.
- The side-of-the-nose drawing was redrawn larger and cropped to the nose; the first version
  was too small to show where the point goes.
- The 90° drawing was redrawn as a camera icon, the line of sight and an arc; the first
  version, with a helper seen from above, did not read.
- The left-facing card's head moved so its arrow no longer runs through the nose.

**Screens reviewed.** Every screen was looked at in at least one language and width after it
changed, the milestone-4 screens in both languages at 360 px and 1280 px and in print, and
the live screens in both languages at both widths, against the list above and the copy
rules. Nothing on the list is present.

**Manual checks, still to do:** these need real phones (the full phone checklist is in the
[README](README.md#on-real-phones)).

- [ ] VoiceOver (iOS Safari) through the frontal flow, including the hairline handle
      (named, arrow keys) and the arrow buttons
- [ ] VoiceOver and TalkBack through the side photo: the facing cards, the point picker,
      the handle on the outline (↑ ↓) and placing the side of the nose
- [ ] TalkBack (Android Chrome) through the frontal flow, including a double-tap on each
      arrow button (it sends a click alone)
- [ ] Thai rendering with the longest strings on both phones (the status text for
      `inconclusive`, the capture steps, the method page, the report's tables) and in a
      PDF saved on each phone
- [ ] VoiceOver and TalkBack through the report: the topics as articles, the tables' row
      and column headers, "Save as PDF or print"
- [ ] A keyboard-only pass on a desktop browser through the whole scan (the automated pass
      covers the landing page and the subject form)
- [ ] Live mode with VoiceOver and TalkBack: the hint announced once it holds, the
      calibration heading and count, "Read the hints aloud" in Thai
