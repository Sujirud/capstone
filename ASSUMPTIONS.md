# Assumptions and open decisions

Where a choice was open, the most conservative option was taken and recorded here. Items
marked **[clinical]** need the clinical team; **[tune]** are software defaults to tune on
real captures, whose values are in `facescan/config/`. What the [README](README.md), the
config or the code already says is left out.

## Needs clinical input (summary)

| # | Item | Where | Current value |
|---|---|---|---|
| C1 | Thai / East Asian population norms: mean and SD per sex for every metric, with sources and sign-off | `config/norms.yaml → th_east_asian` | all `null`, `source: TODO` |
| C2 | Width of the "typical range" shown to users (mean ± k·SD) | `norms.yaml → th_east_asian.typical_range_sd` | `null` (so status uses the canon) |
| C3 | Tolerance band for single-value canon targets | `norms.yaml → canon.tolerance_frac` | ±5 % (placeholder) |
| C4 | Band for zero-target alignment offsets (F7, F9) | `norms.yaml → canon.zero_band_frac_icd` | ±5 % of ICD (placeholder) |
| C5 | Landmark definitions (debug sheet sign-off): alare 129/358, alar base 64/294, medial canthi 133/362, glabella 9, brow head/tail/apex from mesh brow points, temporal boundary = mesh face contour at canthal level, bizygomatic 234/454 | `core/landmark_map.py`, `tools/debug_landmarks.py` | verified on the canonical model and two portraits only |
| C6 | Definition choices in metrics (items 13 and 16): F2 as 1 : 2 ratio of subnasale→stomion to stomion→menton; F8 as lower ÷ upper vermilion = 1.618; F9 apex both criteria reported; F9 tail sign (+ = lateral of the line); F11 for signed metrics as absolute L–R difference | `core/metrics_frontal.py` | as described |
| C7 | Which metrics consumers see (currently every metric except F10) and which are "secondary" | `FRONTAL_METRICS[...].display/role` | F7 mouth ratios secondary |
| C8 | User-adjustment tolerance ("large" adjustment) and manual-placement SD | `capture.yaml → overrides` | 3 % and 1 % of nasion→menton |
| C9 | Wording of every user-facing string (Thai and English), including hints, disclaimers, metric names and the example findings | `config/locale_*.yaml` | drafted by engineering |
| C10 | Evaluation acceptance targets per landmark / metric / gate | `config/evaluation.yaml` | all `null` |
| C11 | The real rules file: conditions, exclusions, approvals, consideration wording | new file, `EngineConfig.rules_path` | only `rules.example.yaml` (illustrative); the engine is implemented |
| C12 | Profile landmark definitions as operationalized here (items 34–42), especially menton ("lowest point of the chin" → farthest from the pogonion–cervical chord), nasion depth ≥ 1 mm, and the columella-tangent fit range | `core/profile_contour.py`, `metrics_profile.py` | engineering proposal |
| C13 | Profile capture requirements added for measurability: chin underside and neck visible, nothing in front of the outline, head pitch within ±20° | locale `capture.profile`, `capture.yaml → profile` | proposal |
| C14 | Sign and reference conventions: E-line negative = behind (Ricketts), forehead inclination + = sloping back against the image vertical | `metrics_profile.py` | as stated |
| C15 | How to handle head pitch in the profile scale transfer (item 44): accept and document, add a pose term to the uncertainty, or tighten the pitch gate | `normalize.transfer_scale`, `capture.yaml → profile.gates` | not handled; the image vertical is used |
| C16 | Rule semantics chosen here (item 51 and the README's "Considerations and consumer safety"): numeric thresholds need the 2 × uncertainty margin, exclusions fail closed, metrics without a reference range (asymmetry, E-line %) and secondary metrics cannot trigger | `core/recommend.py` | as described |
| C17 | Consumer text for reports: area and severity labels, the "no topics" note, and the real finding / consideration strings for the clinical rules | `config/locale_*.yaml` | drafted by engineering; examples only |

## Detection and landmarks

1. **`num_faces=2`**. With 1, a second face would never be reported, so the
   "exactly one face" gate could not be evaluated; the single face's landmarks are the same
   either way. Any frame with more than one face, a burst's included, gives
   `multiple_faces`. Faces too small for MediaPipe's detector (it downsizes the whole
   image) count as no face.
2. **Index verification** (`landmark_map.py` docstring), against the canonical face model's
   OBJ and UV map and on two public-domain portraits: pronasale = **4** (the most anterior
   canonical vertex; the often-quoted 1 sits on the lower tip lobule, and no frontal metric
   uses it), glabella 9, nasion 168, subnasale 2, iris horizontal ring points 469/471
   (right) and 474/476 (left), alare 129/358 (on the visible alar edge), alar base 64/294,
   commissures 61/291, bizygomatic 234/454, upper brow contour 70-63-105-66-107 /
   300-293-334-296-336. **[clinical, C5]**
3. **Brows.** Head / tail = the mean of the medial (107+55) / lateral (70+46) ends of the
   upper and lower mesh brow contours; apex = the highest upper-contour point in face axes,
   refined with a parabola through its neighbours. All brow points are low confidence until
   a clinician adjusts or confirms them.
4. **Temporal boundary** = where the mesh face oval crosses the face-horizontal line through
   the automatic lateral canthus; `unavailable` when hair covers too much of a window around
   it, or it is out of frame. **[tune]**
5. **Head-pose signs** (verified on real images and in tests): yaw > 0 = face turned toward
   the subject's left, pitch > 0 = chin up, roll > 0 = clockwise on screen. Hints ask the
   user to turn back ("turn slightly to your right" when yaw > 0).
6. **Added gate `face_in_frame`**: every face-oval mesh point must be
   inside the photo. MediaPipe extrapolates the points of a face cut off by the frame, so a
   named point with a source vertex outside the image is `unavailable` (`out_of_frame`):
   the core never extrapolates a landmark. `apply_overrides` then raises `OverrideError` when the automatic nasion
   or menton is missing, since the adjustment tolerance and the manual SD are defined from
   them.

## Hairline, scale and distance

7. **The hair mask's coarseness enters the uncertainty**: the mask cell's quantization
   SD (cell ÷ √12) is added in quadrature to the trichion's SD and propagated to every
   metric that uses the automatic trichion.
8. **The trichion is `unavailable`** unless the glabella is on face skin, the first non-skin
   class above it is hair followed by enough hair (else `ambiguous_transition`,
   `no_hair_transition` or `out_of_frame`), the transition is far enough above the glabella
   (`hair_covers_forehead`), and two scans to either side agree with the midline one
   (`ambiguous_hairline`). **[tune]**
9. **EXIF focal length**: the 35 mm equivalent converted through the image diagonal
   (CIPA DC-008), else focal length × focal-plane resolution (scaled when the stored image
   is smaller than the sensor's). Values outside 0.2–20 × the diagonal are ignored, and a
   caller-supplied `camera` wins.
10. **The iris scale is rejected** when the two iris diameters differ by more than 10 %: mm
    metrics are then `unavailable` (`iris_size_mismatch`), and the ratio and %ICD forms
    remain. The distance gate uses the mean horizontal iris diameter of both eyes.
11. **mm uncertainty** = measurement SD ⊕ 4 % × |value| (in quadrature), so the biological
    iris variation is always included.

## Metrics and status

12. **Heights** are face-vertical projections; **widths of bilateral structures** (eye
    fissure, ICD, alar width, mouth, bizygomatic) are Euclidean distances.
13. **Metric definitions chosen here.** F2 = subnasale→stomion ÷ stomion→menton,
    target 0.5 (1 : 2). F5 = atan2(the lateral canthus's vertical rise, the horizontal eye
    length) in face axes. F7's medial and F9's lateral limbus = the iris centre ∓ half the
    horizontal iris diameter. F8 = lower ÷ upper vermilion height, target 1.618; "lips
    closed" is enforced by the `jawOpen` gate only. F9's tail = the signed perpendicular
    distance from the line alar base → lateral canthus, positive on the lateral side, and
    both apex criteria are reported. F10 = trichion→menton (face-vertical) against the
    Euclidean bizygomatic width. **[clinical, C6]**
14. **F3**: if either temporal boundary is unavailable, the total width is undefined, so all
    five fifths are unavailable, not only the outer ones: a fraction of an undefined total
    cannot be reported. F4 still covers eye width against ICD.
15. **Signed offsets are positive lateral** (away from the midline). F7 and F9 offsets are
    reported as `_pct_icd` always and as `_mm` with a scale.
16. **F11**: |L − R| ÷ mean(L, R) for positive magnitudes (eye width, outer
    fifth, brow apex ratio). For signed metrics near 0 (canthal tilt, commissure and brow
    offsets) that ratio is undefined, so |L − R| is reported in the metric's own unit.
    **[clinical, C6]**
17. **Schema additions**: the status `no_reference` for metrics without a canon (F11),
    since neither `within` nor `unavailable` would be truthful, and the field `role`
    (`primary` / `secondary`) for the info-only mouth ratios (mouth ÷ alar width, mouth ÷
    IPD) and P3b, which rules should not use.
18. **Single-value targets** become a band t·(1 ± 5 %). `deviation_abs` is the signed
    distance to the nearest bound (0 inside); `deviation_pct` is relative to the target for
    single-value canons and to the violated bound for ranges, and `null` for signed metrics.
19. **`inconclusive` applies to out-of-range values only**; values inside the range stay
    `within`. A missing uncertainty makes an out-of-range value `inconclusive`, with the
    flag `uncertainty_unavailable`.
20. **The active reference** is the population typical range only when mean, SD and
    `typical_range_sd` all exist, otherwise the canon; `status_basis` records which.
    `sex: unspecified` never uses population norms: sex is never inferred.

## Uncertainty and overrides

21. **Single photo**: the value comes from the original image; its uncertainty is the SD
    over test-time augmentations seeded from the pixel SHA-256, each re-running detection
    and segmentation and mapping the points back. Too few successful runs, or an
    `unavailable` value, gives no uncertainty.
22. **Burst**: gates run per frame. Frames that pass every gate are used when there are at
    least 3; otherwise all single-face frames are used and the status is `quality_failed`.
    Frames are aligned to the reference frame with a similarity transform (all 478 points)
    before the per-point median, so overlays and overrides line up even if the head moved.
    Pose and check values are medians; a check passes when ≥ 3 frames pass it, and
    `burst_good_frames` needs ≥ 3 frames passing every check together.
23. **Landmark sampling** for metrics that depend on an adjusted point. A full analysis with
    overrides uses it for those metrics too (TTA cannot move a hand-placed point), so
    `apply_overrides` equals a full re-analysis exactly, uncertainties included.
24. **Determinism across processes**: ties between hints or unavailability reasons across
    burst frames are broken alphabetically, never by set order, which depends on
    per-process string hashing. Tested with two `PYTHONHASHSEED` values.
25. **The "large adjustment" tolerance and the manual SD** use nasion→menton from the
    automatic positions, so they do not move with adjustments. A point adjusted twice keeps
    its original automatic position in `auto`.
26. **Clinician adjustments** are never flagged as large and always have high confidence
    (this is how brow points become "confirmed"). A user placement where no automatic
    position existed gets low confidence and the flag `no_automatic_position`.

## Quality gates and the consumer view

27. **Sharpness threshold 25** (variance of the Laplacian in the eroded face hull, on the ROI
    resized to 256 px wide): studio portraits score ≈ 1000–1400 and fail once Gaussian blur
    reaches σ ≈ 1–2 % of the face width. **[tune]**
28. **A missing blendshape fails** its expression check, since neutrality cannot be
    verified.
29. **`user_view` of a non-`ok` result** has only the status, quality checks, hints,
    warnings and the disclaimer, no landmarks or metrics: a failed capture gets retake
    guidance, not measurements.
30. **User text.** The reference range shown is the typical range when `status_basis` is
    `population`, otherwise the canon band. "Right" and "left" mean the user's own sides
    (stated in `side_note`).

## Phase 2 — profile analysis

31. **`facing`** is the direction the nose points in the image. The work crop is mirrored
    for `facing="left"`, so all detection runs with the face toward +x.
32. **Silhouette.** The selfie segmenter locates the head. Near its person outline, a pixel
    is foreground when its Lab Mahalanobis distance from the background colour model
    exceeds the larger of a floor and Otsu's threshold; deeper pixels follow the mask.
    GrabCut was not used because OpenCV's draws from a global RNG, which is not
    deterministic without global state. **[tune]**
33. **Face-aligned frame for extrema.** "Most anterior" is measured with the outline rotated
    so the forehead-to-chin line is vertical; the points stay on the outline, and metrics
    use the image frame (P5 the image vertical). An added gate, `head_tilt_deg`, fails
    captures whose pitch would bias true-vertical measurements. **[tune]**
34. **Pronasale**: the most anterior face-skin point in the nose rows. The added gate
    `pronasale_most_anterior` fails when another face-skin point is clearly more anterior
    (objects that are not face skin are caught by other gates).
35. **Nasion and glabella.** The concavity is the point farthest behind the line from the
    forehead top to the tip; glabella = the most anterior face-skin point above it; nasion =
    the most posterior point between glabella and pronasale, which must lie ≥ 1 % of the
    face height (≈ 1 mm) behind both, else `nasion_not_found`. A straight forehead–nose
    line fails. **[clinical, C12]**
36. **Subnasale**: the maximum concave turning angle between pronasale and labrale
    superius.
37. **Lips and chin**: anterior maxima between the tip and the cervical point; labrale
    superius = the first, soft-tissue pogonion = the last, labrale inferius = the most
    anterior between them (unavailable when the lips cannot be separated).
38. **Cervical point**: a concave turn after at least two maxima, followed by a stretch of
    skin that barely comes forward (a neck, not the chin). Without it the chin underside
    counts as not visible, and pogonion and menton are unavailable
    (`chin_underside_not_visible`), e.g. with a collar touching the chin. **[tune]**
39. **Menton** ("lowest point of the chin contour"): the point of the chin curve between
    pogonion and the cervical point farthest from their chord, which is robust to head
    tilt. **[clinical, C12]**
40. **Profile trichion**: the first face-skin → hair transition above the glabella, sampled
    just inside the outline. A narrow fringe of other classes is allowed, since hair, skin
    and background meet at the outline, and its width is added to the SD with the mask
    cell's; hats give `no_hair_transition`.
41. **Columella tangent**: a least-squares line through the stored contour between 40 %
    and 90 % of the pronasale→subnasale arc (the rounded tip and the corner excluded),
    oriented toward the tip. **[clinical, C12]**
42. **The stored contour** is the smoothed outline, resampled. Automatic silhouette points
    are snapped onto it, and every contour-dependent computation uses it, so
    `apply_overrides` equals a full re-analysis.
43. **Scale transfer**: frontal subnasale→menton and nasion→menton along the frontal
    face-vertical axis (mm through the iris scale), profile distances along the image
    vertical. mm/px = the subnasale→menton ratio, and the nasion→menton ratio must agree
    within 5 %, else `transfer_inconsistent`. The frontal result must be `ok`
    (`frontal_not_usable`) with the same `SubjectInfo` (`subject_mismatch`). The frontal
    distances are stored in `calibration.inputs`, so profile adjustments recompute the
    scale without the frontal result.
44. **Open issue: head pitch in the profile biases the transfer.** The transfer compares
    vertical distances, and the profile side uses the image vertical. The menton lies behind the
    subnasale, so pitching the head changes their vertical distance: on the synthetic
    profile by ≤ 1.5 % at ±10° and 2.6 % at ±15°, inside the reported ≈ 4 % scale
    uncertainty but systematic, and the 5 % cross-check catches only larger effects.
    Correcting with the profile's own forehead-to-chin tilt would trade pose bias for
    person-dependent bias (profiles are not vertical in natural head position), so it is
    left to the clinical and engineering team (C15).
45. **Profile camera distance** = profile mm/px × focal_px, from the automatic points (gates
    describe the capture and are not re-run after adjustments).
46. **Profile uncertainty**: the same seeded test-time augmentation as frontal, the
    silhouette re-extracted on each copy; only runs whose contour checks pass count, and
    `contour_failed` results carry none.
47. **The adjustment tolerance on profiles** uses nasion→menton, falling back to
    nasion→pogonion, glabella→menton and glabella→pogonion (shorter or similar, so never
    looser).
48. **Landmark sampling draws noise only for perturbed points**, so an extra user-placed
    point (the alar crease) cannot change unrelated metrics' uncertainty. When an automatic
    point of a recomputed metric has no SD, the metric's uncertainty is unavailable rather
    than underestimated.
49. **P4** is reported in mm (needs the scale; compared with the canon) and as % of the E-line
    length (always; no canon, so `no_reference`).

## Phase 3 — considerations and reports

The rules the engine enforces are in the README's "Considerations and consumer safety";
these are the choices beyond them.

50. **Reports.** `build_report` needs results of the right types with the same
    `SubjectInfo` (`subject_mismatch`), produced by this engine's schema version, core
    version and `config_hash` (`stale_result`), so rules never run on metrics computed under
    other settings. The report's status is the first non-`ok` one among the results
    (frontal first), else `ok`: failed captures can be reported (clinic use) but never
    contribute considerations, and the consumer view shows only metrics of `ok` results.
    Without a rules file, reports have measurements only (`rules_version` null).
51. **Rule semantics** (C16). Profile metrics trigger only when the profile was calibrated
    from a frontal scan and the focal length is known, since otherwise its distance is
    unverified. `no_reference` metrics cannot trigger until population norms give them a
    typical range, since every consideration must show one. `status_is`
    accepts only within / above / below, which include the `inconclusive` margin already. In `all` /
    `any`, an ineligible metric makes its condition false, and the triggering metrics are
    the conditions that held, in rule order. Exclusions may use clinic-only or secondary
    metrics, since they can only suppress. `min_quality` can only be `passed` and
    `min_confidence` only `high` (nothing weaker is allowed); `severity` is `info` or
    `discuss`.
52. **Added report fields**: `Consideration.rule_version`, `Report.rules_hash`
    and `Report.rule_audit` (clinic and QA only; not in `user_view`).
