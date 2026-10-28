# TODO

Phases 1–3 are implemented. What remains needs clinical input, real data or hardware.

## Clinical content

- [ ] Author and sign off the real rules file (`approved_by` on every rule); the engine
      validates it at start-up (ASSUMPTIONS C11, C16).
- [ ] Write and review the real finding / consideration strings, area and severity labels
      and the "no topics" note in Thai and English (C17, C9).
- [ ] Fill `th_east_asian` norms and `typical_range_sd`, with sources (C1, C2).
- [ ] Sign off landmark definitions (frontal debug sheet; operational profile
      definitions, C5, C12) and the added capture requirements (C13).
- [ ] Decide how to handle head pitch in the profile scale transfer (C15).

## Validation and tuning

- [ ] Run `tools/evaluate.py` on phone and controlled captures (frontal and
      profile rows); tune gate thresholds, hairline / temporal-boundary and profile
      parameters (`capture.yaml`); set acceptance targets (`evaluation.yaml`).
- [ ] Collect protocol-compliant real profile photos and confirm the profile `ok` path and
      landmark accuracy on them (the committed real images test the failure paths only).
- [ ] Review rule behaviour on real sessions (the report's `rule_audit` shows why each rule
      fired or not).

## Web API (`api/`)

- [x] API Phase 2: `POST /v1/profile/analyze`, profile adjust and overlay.
- [ ] Measure a successful profile analysis with real protocol-compliant profile photos
      (estimated ≈ 3.4 s at 4K on an M2).
- [x] API Phase 3: `POST /v1/report`, with the rules file at `RULES_PATH` (the example rules
      by default).
- [ ] Revisit the size limits, rate limit and timeouts (`api/ASSUMPTIONS.md`, open
      decisions).

## Web app (`web/`)

- [x] Milestone 1: foundation (tokens, components, `client-config`, subject form, the demo
      setup).
- [x] Milestone 2: frontal photo mode, results, hairline adjustment, overlay redraw.
- [x] Milestone 3: profile, contour adjustment, alar crease.
- [x] Milestone 4: report, print, landing, "How it's measured", design review, phone
      checklist.
- [x] Milestone 5 (optional): live mode (the camera on the page, real-time hints,
      auto-capture, calibration).
- [ ] Run the phone checklist in `web/README.md` on one iPhone and one Android phone, with
      the manual accessibility checks (VoiceOver, TalkBack, Thai rendering, a saved PDF) and
      live mode (hints, auto-capture with a real face, calibration at 1.5 m, spoken Thai).
- [ ] Fill in the team's names (and the course's full name, if wanted) in
      `web/src/app/about.ts` for the landing page.
- [ ] Run the side-photo `ok` path against the real API with protocol-compliant frontal and
      side photos of one person (`E2E_OK_PHOTO`, `E2E_OK_PROFILE`); none are committed.
- [ ] Confirm the side-photo and live-gate fixtures pass `gen_fixtures.py --check` on Linux
      (CI): they come from image analysis and have not yet been compared across platforms.

## Hardware

- [ ] Try the reference capture app with a physical 4K webcam.
