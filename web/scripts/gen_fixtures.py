"""Fixtures for the web app, generated from the real core and API.

Run from the repository root with the environment that runs the core and API tests
(the model files must be in ``models/``):

    .venv/bin/python web/scripts/gen_fixtures.py

Writes ``web/fixtures/``:

- ``error_codes.json``: every problem code and its HTTP status (``CODES`` in
  ``api/facescan_api/errors.py``); a web test fails if one has no mapping.
- ``client_config.{th,en}.json``: ``GET /v1/client-config`` from the real API app
  (real engine, the core's example rules, the API's default limits).
- ``frontal_ok.{th,en}.json``: an ``ok`` analyze response around the real core's
  ``user_view`` of the synthetic result in ``tests/helpers.py``. The envelope mirrors
  ``api/facescan_api/routes/common.py:analysis_response`` and is validated with the
  API's ``AnalyzeResponse`` model; the token is a placeholder.
- ``frontal_quality_failed.{th,en}.json``: the real API's response for
  ``tests/data/astronaut.png`` (a real ``quality_failed``); ``frontal_no_face.{th,en}.json``
  for a blank image.
- ``photo.jpg``: a line drawing of the synthetic face (not a person) at the synthetic
  result's size, 1600 × 1800, with EXIF (35 mm-equivalent focal length, rear lens). The
  synthetic result's ``reference_sha256`` is set to its pixels, so it is that result's
  reference image. ``photo_front.jpg`` is the same with a front-camera lens model, and
  ``photo.heic`` a HEIC copy made with macOS ``sips`` (skipped elsewhere).
- ``overlay_ok.{th,en}.jpg`` and ``overlay_adjusted.{th,en}.jpg``: the core's ``user``
  overlays of that photo (the web app's frontal layers), encoded as the API does.
- ``frontal_adjusted.{th,en}.json``: ``/v1/adjust`` for the trichion moved 60 px up (the
  core's ``apply_overrides``: ``large_user_adjustment``); ``frontal_ok_no_hairline.{th,en}.json``:
  a result whose hairline was not found.
- ``formats/``: small PNG, JPEG (baseline and progressive) and WebP (lossy, lossless,
  extended) files of known sizes, for the header parser.
- ``exif_focal.json``: EXIF tag sets and the focal length the core computes from them
  (``camera_from_exif``), plus the photos' values, for the web app's port.

The side view (milestone 3):

- ``profile.jpg``: the synthetic side profile of the core's tests (``tests/profile_synth.py``,
  flat colours, not a person, nose pointing right), with EXIF whose 35 mm-equivalent focal
  length puts the camera at the recommended 1.5 m.
- ``profile_ok.{th,en}.json``: the real engine's analysis of that photo, in the API's
  envelope. As in the core's tests, the engine uses the colour-based ``FakeSegmenter``
  (the real segmenter finds no face in a flat drawing), and the frontal result is the
  synthetic one with its nasion moved to match the drawing's proportions, so the scale
  transfer succeeds.
- ``profile_no_scale.{th,en}.json``: the same photo with the unchanged synthetic frontal
  result: the scale transfer's cross-check fails, so ``calibration.available`` is false
  and there is no warning key for it (request 3 in ASSUMPTIONS.md).
- ``profile_adjusted.{th,en}.json``: ``apply_overrides`` with the alar crease placed and the
  nose tip moved (re-snapped by the core); ``overlay_profile_{ok,adjusted}.{th,en}.jpg``
  are the core's overlays of both with the web app's profile layers.
- ``profile_contour_failed.{th,en}.json``: the real API's answer for
  ``tests/data/profile_lathe_operator_1942.jpg`` (collar touching the chin), sent with a
  frontal token that the API's own ``seal`` issued for the synthetic frontal result.
- ``contour_snap.json``: points and where the core's ``project_onto_polyline`` and
  ``point_at_arclength`` put them on the stored contour, for the web app's port.

The report (milestone 4):

- ``report_ok.{th,en}.json``: the real API's ``/v1/report`` for the frontal and side results
  above (``frontal_ok`` and ``profile_ok``), sent as tokens of one session that the API's own
  ``seal`` issued. The example rules find the side view's nasolabial angle below its range, so
  the report has a consideration.
- ``report_frontal_only.{th,en}.json``: the same without the side photo: no considerations,
  so the report carries ``no_considerations_note``.

Live mode (milestone 5):

- ``live_gates.json``: detector outputs (MediaPipe in image mode: landmarks, blendshapes,
  transformation matrix) for ``tests/data/astronaut.png`` and variants of it (enlarged,
  darkened, brightened, blurred, cut), and cases that change one input of the enlarged one
  (pose, expression, iris points, a calibrated camera) to reach every hint, one of them passing
  every gate; for each, the core's ``frontal_checks`` and ``summarize``. Also the core's check
  order, expression hints and mesh indices, and samples of ``webcam_capture.OneEuroFilter``.
- ``live/<image>.png``: the face region of each image (the oval's box), losslessly, for the
  pixel checks.
- ``live/camera_astronaut.mjpeg`` and ``live/camera_drawing.mjpeg``: still frames for
  Chromium's fake camera in the end-to-end tests and the screenshots.

Thai overlay labels need Pillow's RAQM layout: on macOS run with
``DYLD_LIBRARY_PATH=/opt/homebrew/lib`` (``brew install fribidi``).

Values that change on every run (request ids) are replaced, so the output is stable
and a diff shows only real changes in the core or the API.

``--check`` compares instead of writing (CI): it fails when a committed JSON fixture
differs from what the current core and API produce. Floats are compared with a relative
tolerance of 1e-9, since the last bits of a computed value may differ between platforms.
The profile fixtures come from image analysis (decoding, warps, smoothing), where such
differences can grow, so their floats use 1e-6. The live-mode gates are computed from the
committed detector outputs and face regions, but their sharpness and exposure go through
OpenCV's resize, whose vector code rounds differently on x86 and ARM; they use 1e-3, which
still catches any change to the gates. Images and pixel hashes are not compared: fonts and
JPEG codecs differ between platforms.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "fixtures"
MODELS = ROOT / "models"
ASTRONAUT = ROOT / "tests" / "data" / "astronaut.png"
LATHE = ROOT / "tests" / "data" / "profile_lathe_operator_1942.jpg"
LOCALES = ("th", "en")

REQUEST_ID = "req_fixture"

sys.path.insert(0, str(ROOT / "tests"))   # the core's synthetic results (tests/helpers.py, profile_synth.py)

# The web app's overlay layers per view: never golden_ratio.
FRONTAL_LAYERS = ["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"]
PROFILE_LAYERS = ["landmarks", "profile_lines", "labels"]
RECOMMENDED_DISTANCE_MM = 1500.0   # capture.yaml: camera_distance_recommended_m
FOCAL_35MM = 52          # a 2× lens on a phone; any plausible value works
REAR_LENS = "back camera 6.86mm f/1.78"
FRONT_LENS = "front camera 2.69mm f/1.9"
OVERLAY_MAX_SIDE, OVERLAY_QUALITY = 1600, 85   # the API's defaults (api/facescan_api/settings.py)


CHECK = False
MISMATCHES: list[str] = []


def same(a: Any, b: Any, rel: float = 1e-9) -> bool:
    if isinstance(a, float) or isinstance(b, float):
        return (isinstance(a, (int, float)) and isinstance(b, (int, float))
                and math.isclose(a, b, rel_tol=rel, abs_tol=rel * 1e-3))
    if isinstance(a, dict) and isinstance(b, dict):
        return list(a) == list(b) and all(k == "reference_sha256" or same(a[k], b[k], rel) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y, rel) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def write(name: str, data: Any) -> None:
    path = OUT / name
    if CHECK:
        committed = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
        # Image analysis (the side view) is compared more loosely: see the module docstring.
        rel = 1e-6 if name.startswith(("profile_", "contour_")) else 1e-3 if name.startswith("live_") else 1e-9
        ok = committed is not None and same(json.loads(json.dumps(data)), committed, rel)
        print(f"{'same' if ok else 'DIFFERS'} {path.relative_to(ROOT)}")
        if not ok:
            MISMATCHES.append(name)
        return
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}")


def write_bytes(name: str, data: bytes) -> None:
    """Images: written, never compared (fonts and codecs differ between platforms)."""
    path = OUT / name
    if CHECK:
        print(f"{'exists' if path.is_file() else 'MISSING'} {path.relative_to(ROOT)}")
        if not path.is_file():
            MISMATCHES.append(name)
        return
    path.write_bytes(data)
    print(f"wrote {path.relative_to(ROOT)}")


def draw_face(pts: dict[str, Any], size: tuple[int, int]):
    """A plain line drawing of the synthetic face: a stand-in photo, clearly not a person."""
    from PIL import Image, ImageDraw

    im = Image.new("RGB", size, (210, 215, 220))          # plain, light background
    d = ImageDraw.Draw(im)
    P = {k: (float(v[0]), float(v[1])) for k, v in pts.items()}
    cx = P["nasion"][0]
    top, chin = P["trichion"][1], P["menton"][1]
    half_w = (P["bizygomatic_left"][0] - P["bizygomatic_right"][0]) / 2
    ink, skin, hair = (60, 64, 70), (226, 196, 172), (88, 76, 68)
    d.rectangle([cx - 150, chin - 60, cx + 150, size[1]], fill=skin)                              # neck
    d.polygon([(cx - 560, size[1]), (cx - 230, chin + 170), (cx + 230, chin + 170), (cx + 560, size[1])],
              fill=(150, 160, 175))                                                                  # shoulders
    d.ellipse([cx - half_w - 30, top - 170, cx + half_w + 30, top + 330], fill=hair)             # hair
    d.ellipse([cx - half_w, top, cx + half_w, chin], fill=skin, outline=ink, width=3)           # face
    for side in ("right", "left"):
        m, l = P[f"medial_canthus_{side}"], P[f"lateral_canthus_{side}"]
        c = P[f"iris_center_{side}"]
        r = abs(P[f"iris_{side}_lateral"][0] - P[f"iris_{side}_medial"][0]) / 2
        mid = ((m[0] + l[0]) / 2, (m[1] + l[1]) / 2)
        d.polygon([m, (mid[0], mid[1] - r * 1.1), l, (mid[0], mid[1] + r * 0.9)], fill=(246, 244, 240), outline=ink)
        d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=(110, 96, 84), outline=ink, width=2)
        d.ellipse([c[0] - r / 2.6, c[1] - r / 2.6, c[0] + r / 2.6, c[1] + r / 2.6], fill=(30, 30, 30))
        brow = [P[f"brow_head_{side}"]] + [P[f"brow_upper_{side}_{i}"] for i in (5, 4, 3, 2, 1)] + [P[f"brow_tail_{side}"]]
        d.line(brow, fill=(70, 60, 54), width=12, joint="curve")
    d.line([P["nasion"], P["pronasale"]], fill=ink, width=3)
    d.line([P["alare_right"], P["subnasale"], P["alare_left"]], fill=ink, width=3, joint="curve")
    lips = (184, 110, 104)
    d.polygon([P["commissure_right"], P["labrale_superius"], P["commissure_left"], P["upper_lip_inner"]], fill=lips)
    d.polygon([P["commissure_right"], P["lower_lip_inner"], P["commissure_left"], P["labrale_inferius"]], fill=lips)
    d.line([P["commissure_right"], P["upper_lip_inner"], P["commissure_left"]], fill=ink, width=2)
    return im


def photo_jpeg(im, lens: str, focal_35mm: int = FOCAL_35MM) -> bytes:
    from PIL import Image

    exif = Image.Exif()
    exif[0x010F] = "facescan"                 # Make
    exif[0x0110] = "synthetic fixture"        # Model
    exif[0x8769] = {0xA405: focal_35mm, 0x920A: 6.86, 0xA434: lens}   # 35 mm focal, focal, lens model
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=92, exif=exif)
    return buf.getvalue()


def overlay_jpeg(rgb) -> bytes:
    """As the API encodes overlays (api/facescan_api/workers.py ``_jpeg``)."""
    from PIL import Image

    im = Image.fromarray(rgb)
    w, h = im.size
    if max(w, h) > OVERLAY_MAX_SIDE:
        f = OVERLAY_MAX_SIDE / max(w, h)
        im = im.resize((max(1, round(w * f)), max(1, round(h * f))), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=OVERLAY_QUALITY, optimize=True)
    return buf.getvalue()


def heic_copy(jpeg: bytes) -> bytes | None:
    """A HEIC copy made with macOS sips (keeps the 35 mm focal length and lens model)."""
    if not shutil.which("sips"):
        return None
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "photo.jpg", Path(tmp) / "photo.heic"
        src.write_bytes(jpeg)
        subprocess.run(["sips", "-s", "format", "heic", str(src), "--out", str(dst)], check=True, capture_output=True)
        return dst.read_bytes()


def exif_cases() -> list[dict[str, Any]]:
    """EXIF tag sets (exifr's names) and the focal length the core computes from them.

    Each tag set is written into a tiny JPEG and read back, as the core reads a camera file
    (Pillow cannot read the IFDs of an EXIF block that was only built in memory). The sensor
    values are a phone's: a 4.2 mm lens over 1.4 µm pixels, about 714 pixels per mm.
    """
    from PIL import Image

    from facescan.core.normalize import camera_from_exif

    px_per_mm = 1000 / 1.4
    cases = [
        {"name": "35 mm-equivalent", "raw": [4032, 3024], "tags": {"FocalLengthIn35mmFormat": 26}},
        {"name": "35 mm-equivalent, 2x lens", "raw": [4032, 3024], "tags": {"FocalLengthIn35mmFormat": 52, "FocalLength": 6.86}},
        {"name": "35 mm-equivalent wins over the focal plane", "raw": [3000, 4000],
         "tags": {"FocalLengthIn35mmFormat": 28, "FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm * 10,
                  "FocalPlaneResolutionUnit": 3}},
        {"name": "focal plane in inches (default unit)", "raw": [4000, 3000],
         "tags": {"FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm * 25.4}},
        {"name": "focal plane in cm", "raw": [4000, 3000],
         "tags": {"FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm * 10, "FocalPlaneResolutionUnit": 3}},
        {"name": "focal plane in mm", "raw": [4000, 3000],
         "tags": {"FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm, "FocalPlaneResolutionUnit": 4}},
        {"name": "focal plane in µm", "raw": [4000, 3000],
         "tags": {"FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm / 1000, "FocalPlaneResolutionUnit": 5}},
        {"name": "stored image smaller than the sensor image", "raw": [2000, 1500],
         "tags": {"FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm, "FocalPlaneResolutionUnit": 4,
                  "ExifImageWidth": 4000}},
        {"name": "35 mm value 0 falls back to the focal plane", "raw": [4000, 3000],
         "tags": {"FocalLengthIn35mmFormat": 0, "FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm,
                  "FocalPlaneResolutionUnit": 4}},
        {"name": "unknown resolution unit", "raw": [4000, 3000],
         "tags": {"FocalLength": 4.2, "FocalPlaneXResolution": px_per_mm, "FocalPlaneResolutionUnit": 7}},
        {"name": "focal length without resolution", "raw": [4000, 3000], "tags": {"FocalLength": 4.2}},
        {"name": "implausibly long", "raw": [4032, 3024], "tags": {"FocalLengthIn35mmFormat": 2000}},
        {"name": "implausibly short", "raw": [4032, 3024], "tags": {"FocalLengthIn35mmFormat": 1}},
        {"name": "no EXIF", "raw": [4032, 3024], "tags": {}},
    ]
    ids = {"FocalLengthIn35mmFormat": 0xA405, "FocalLength": 0x920A, "FocalPlaneXResolution": 0xA20E,
           "FocalPlaneResolutionUnit": 0xA210, "ExifImageWidth": 0xA002}
    for case in cases:
        exif = Image.Exif()
        if case["tags"]:
            exif[0x8769] = {ids[k]: v for k, v in case["tags"].items()}
        buf = io.BytesIO()
        Image.new("RGB", (4, 4)).save(buf, format="JPEG", exif=exif)
        stored = Image.open(io.BytesIO(buf.getvalue())).getexif()
        # What was stored (rationals round to their fraction), so the port reads the same values.
        ifd = stored.get_ifd(0x8769)
        case["tags"] = {k: float(ifd[ids[k]]) if isinstance(v, float) else int(ifd[ids[k]])
                        for k, v in case["tags"].items()}
        cam = camera_from_exif(stored, *case["raw"])
        case["focal_px"] = None if cam is None else cam.focal_px
    assert sum(c["focal_px"] is not None for c in cases) >= 8, "most cases must give a focal length"
    return cases


def format_samples() -> dict[str, bytes]:
    """Real encoder output at odd sizes (width × height in the name), for the header parser."""
    from PIL import Image

    def enc(size: tuple[int, int], fmt: str, mode: str = "RGB", **kw: Any) -> bytes:
        buf = io.BytesIO()
        Image.new(mode, size, (120, 130, 140) if mode == "RGB" else (120, 130, 140, 200)).save(buf, format=fmt, **kw)
        return buf.getvalue()

    return {
        "sample_301x199.png": enc((301, 199), "PNG"),
        "sample_302x198.jpg": enc((302, 198), "JPEG", quality=90),
        "sample_303x197_progressive.jpg": enc((303, 197), "JPEG", quality=90, progressive=True),
        "sample_304x196_lossy.webp": enc((304, 196), "WEBP", quality=80),
        "sample_305x195_lossless.webp": enc((305, 195), "WEBP", lossless=True),
        "sample_306x194_alpha.webp": enc((306, 194), "WEBP", mode="RGBA", quality=80, exact=True),
    }


def stable(body: dict[str, Any]) -> dict[str, Any]:
    return {**body, "request_id": REQUEST_ID}


def real_api() -> TestClient:
    from facescan_api.app import create_app
    from facescan_api.settings import Settings
    from facescan_api.workers import default_engine_factory

    settings = Settings(workers=1, require_raqm=False, models_dir=str(MODELS))
    return TestClient(create_app(settings, engine_factory=default_engine_factory), raise_server_exceptions=True)


def wait_ready(client: TestClient) -> None:
    import time

    t0 = time.time()
    while client.get("/readyz").status_code != 200:
        if time.time() - t0 > 120:
            raise SystemExit("the API workers did not become ready")
        time.sleep(0.2)


def blank_png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (200, 205, 210)).save(buf, format="PNG")
    return buf.getvalue()


def no_hairline_result(frontal, asm):
    """The synthetic result as if hair segmentation found no hairline (trichion unavailable)."""
    from facescan.core.schema import FrontalResult
    from helpers import face_mm, to_image

    pts = to_image(face_mm())
    pts.pop("trichion")
    landmarks = asm.landmarks(pts, {"trichion": "hairline_not_found"}, {n: 0.5 for n in pts}, {})
    metrics, calibration = asm.metrics(landmarks, frontal.subject, run_u=None, previous=None)
    return FrontalResult(**{**dict(frontal), "landmarks": landmarks, "metrics": metrics, "calibration": calibration})


def matching_frontal(frontal, profile):
    """The synthetic frontal result with its nasion moved so that nasion→menton : subnasale→menton
    matches the profile drawing (as ``tests/test_profile.py`` does), so the scale transfer's
    cross-check passes. Only the landmarks change; the transfer reads nothing else."""
    from facescan.core.schema import FrontalResult, Landmark

    L = profile.landmarks
    ratio = (L["menton"].y - L["nasion"].y) / (L["menton"].y - L["subnasale"].y)
    lms = dict(frontal.landmarks)
    me, sn = lms["menton"], lms["subnasale"]
    lms["nasion"] = Landmark(**{**dict(lms["nasion"]), "y": me.y - ratio * (me.y - sn.y)})
    return FrontalResult(**{**dict(frontal), "landmarks": lms})


def profile_results(engine, frontal) -> dict[str, Any]:
    """The side view from the real engine, with the core tests' colour-based segmenter.

    Returns the photo (JPEG bytes with EXIF), its LoadedImage, and the ok, no-scale and
    adjusted results.
    """
    from PIL import Image

    from facescan.core.normalize import FULL_FRAME_DIAGONAL_MM, LoadedImage, frontal_transfer_inputs, load_image
    from facescan.core.schema import Override
    from profile_synth import make_profile

    rgb, _, fake = make_profile("right")
    real = engine._segmenter          # the core's tests swap it the same way
    engine._segmenter = fake
    try:
        probe = engine.analyze_profile(LoadedImage.from_array(rgb), subject=frontal.subject, facing="right")
        matched = matching_frontal(frontal, probe)
        inputs, _ = frontal_transfer_inputs(matched)
        L = probe.landmarks
        mm_per_px = inputs["frontal_sn_me_mm"] / (L["menton"].y - L["subnasale"].y)
        h, w = rgb.shape[:2]
        # The 35 mm-equivalent focal length that puts the camera at the recommended distance.
        f35 = round(RECOMMENDED_DISTANCE_MM / mm_per_px * FULL_FRAME_DIAGONAL_MM / math.hypot(w, h))
        photo = photo_jpeg(Image.fromarray(rgb), REAR_LENS, focal_35mm=f35)
        side = load_image(photo)
        ok = engine.analyze_profile(side, subject=frontal.subject, facing="right", frontal=matched)
        no_scale = engine.analyze_profile(side, subject=frontal.subject, facing="right", frontal=frontal)
    finally:
        engine._segmenter = real
    assert ok.status == "ok" and ok.calibration.mm_per_px is not None, (ok.status, ok.calibration)
    assert not ok.quality.warnings, ok.quality.warnings
    assert no_scale.status == "ok" and no_scale.calibration.mm_per_px is None, no_scale.calibration
    assert not {"no_frontal_scale"} & set(no_scale.quality.warnings)
    P = ok.landmarks
    adjusted = engine.apply_overrides(ok, {
        # Off the outline on purpose: the core re-snaps silhouette points to the contour.
        "pronasale": Override(x=P["pronasale"].x + 4, y=P["pronasale"].y + 8, source="user_adjusted"),
        # Not on the silhouette: behind the nose, where the side of the nose meets the cheek.
        "alar_crease": Override(x=P["subnasale"].x - 20, y=P["subnasale"].y - 19, source="user_adjusted"),
    })
    assert adjusted.metrics["P3a_tip_projection_goode"].value is not None
    return {"photo": photo, "side": side, "ok": ok, "no_scale": no_scale, "adjusted": adjusted}


def contour_snap_cases(profile) -> dict[str, Any]:
    """Points and the core's nearest point on the stored contour (with its arc length), and
    points at given arc lengths, for the web app's port of the snapping."""
    import numpy as np

    from facescan.core.geometry import point_at_arclength, polyline_lengths, project_onto_polyline

    contour = np.array([[p.x, p.y] for p in profile.contour])
    total = float(polyline_lengths(contour)[-1])
    points = [[profile.landmarks[n].x + dx, profile.landmarks[n].y + dy]
              for n, (dx, dy) in {"glabella": (12, -5), "nasion": (-30, 4), "pronasale": (25, 30),
                                  "subnasale": (-40, -3), "menton": (-6, 18), "trichion": (3, -2)}.items()]
    points += [[float(contour[0, 0]), float(contour[0, 1]) - 80], [float(contour[-1, 0]) - 50, float(contour[-1, 1]) + 90],
               [5.0, 5.0], [990.0, 700.0]]
    cases = []
    for p in points:
        on, s = project_onto_polyline(np.array(p, dtype=float), contour)
        cases.append({"point": p, "snapped": [float(on[0]), float(on[1])], "s": s})
    arc = [{"s": s, "point": [float(v) for v in point_at_arclength(contour, s)]}
           for s in (-5.0, 0.0, 1.0, 10.0, total / 3, total / 2 + 0.5, total - 1.0, total, total + 5.0)]
    return {"contour": contour.tolist(), "length": total, "cases": cases, "arc": arc}


def live_images() -> dict[str, Any]:
    """The astronaut photo and variants of it, together covering every path of the gates."""
    import cv2
    import numpy as np

    rgb = cv2.cvtColor(cv2.imread(str(ASTRONAUT)), cv2.COLOR_BGR2RGB)

    def up(k: int):
        return cv2.resize(rgb, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)

    return {
        "small": rgb,                                            # face narrower than the ROI: enlarged
        "x3": up(3),                                             # a little wider: reduced
        "x4": up(4),
        "dark": (rgb * 0.2).astype(np.uint8),                    # too dark, and too little detail
        "bright": np.clip(rgb * 1.8, 0, 255).astype(np.uint8),   # too bright, clipped
        "blur": cv2.GaussianBlur(up(2), (0, 0), 6),              # not sharp
        "cut": np.ascontiguousarray(rgb[100:]),                  # the top of the face outside the photo
    }


def face_box(oval, width: int, height: int) -> list[int]:
    """The face-oval bounding box as ``face_roi`` crops it (quality.py), clipped to the photo."""
    import numpy as np

    x0, y0 = np.floor(oval.min(axis=0)).astype(int)
    x1, y1 = np.ceil(oval.max(axis=0)).astype(int)
    return [int(max(x0, 0)), int(max(y0, 0)), int(min(x1, width)), int(min(y1, height))]


def camera_feeds() -> dict[str, bytes]:
    """Still frames for Chromium's fake camera (``--use-file-for-fake-video-capture``, MJPEG):
    the astronaut photo enlarged 2× for the end-to-end test with the real model, and the
    synthetic face drawing for the screenshots."""
    import cv2
    import numpy as np

    rgb = live_images()["small"]
    ok, astronaut = cv2.imencode(".jpg", cv2.cvtColor(cv2.resize(rgb, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC),
                                                      cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
    assert ok
    drawing = cv2.imdecode(np.frombuffer((OUT / "photo.jpg").read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    ok, plain = cv2.imencode(".jpg", drawing, [cv2.IMWRITE_JPEG_QUALITY, 90])   # without EXIF
    assert ok
    return {"camera_astronaut.mjpeg": astronaut.tobytes(), "camera_drawing.mjpeg": plain.tobytes()}


def live_detections() -> dict[str, Any]:
    """Detector outputs for each image (MediaPipe in image mode), with the face region of the
    image written losslessly to ``live/<name>.png``: what the pixel checks read."""
    import cv2

    from facescan.core.detector import FaceDetector
    from facescan.core.landmark_map import FACE_OVAL_RING

    out: dict[str, Any] = {}
    with FaceDetector(MODELS / "face_landmarker.task") as detector:
        for name, rgb in live_images().items():
            faces = detector.detect(rgb)
            assert len(faces) == 1, (name, len(faces))
            face = faces[0]
            h, w = rgb.shape[:2]
            x0, y0, x1, y1 = box = face_box(face.xy[list(FACE_OVAL_RING)], w, h)
            ok, png = cv2.imencode(".png", cv2.cvtColor(rgb[y0:y1, x0:x1], cv2.COLOR_RGB2BGR))
            assert ok
            write_bytes(f"live/{name}.png", png.tobytes())
            out[name] = {"width": w, "height": h, "region": box, "xy": face.xy.tolist(),
                         "blendshapes": dict(sorted(face.blendshapes.items())), "matrix": face.transform.tolist()}
    return out


def live_gates() -> dict[str, Any]:
    """The core's frontal checks for detector outputs, for the web app's port.

    Written: fresh detections of ``live_images()``. Checked (``--check``): the committed
    detections and regions, since the Python and web runtimes of MediaPipe, and platforms,
    can detect slightly different landmarks; what must not change is what the core computes
    from them. Besides the images as detected, cases change one input (pose, expression,
    iris points, camera) to reach every hint.
    """
    import cv2
    import numpy as np

    from facescan import EngineConfig
    from facescan.apps.webcam_capture import TYPICAL_IPD_MM, OneEuroFilter
    from facescan.core.config import load_settings
    from facescan.core.detector import FaceDetection, pose_from_matrix
    from facescan.core.landmark_map import FACE_OVAL_RING, MESH_LANDMARKS
    from facescan.core.quality import _EXPRESSION_HINTS, CHECK_ORDER, frontal_checks, mesh_iris_px, summarize
    from facescan.core.schema import CameraInfo

    settings = load_settings(EngineConfig.from_models_dir(MODELS)).capture
    for name, data in camera_feeds().items():
        write_bytes(f"live/{name}", data)
    if CHECK:
        images = json.loads((OUT / "live_gates.json").read_text(encoding="utf-8"))["images"]
        for name in images:
            write_bytes(f"live/{name}.png", b"")   # only checks that the file exists
    else:
        images = live_detections()

    def rot(axis: str, deg: float):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        return {"x": np.array([[1, 0, 0], [0, c, -s], [0, s, c]]),
                "y": np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
                "z": np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]

    def rotated(image: str, *turns: tuple[str, float]) -> list[list[float]]:
        m = np.array(images[image]["matrix"], dtype=float)
        for axis, deg in turns:
            m[:3, :3] = rot(axis, deg) @ m[:3, :3]
        return m.tolist()

    def pitch_of(matrix) -> float:
        return pose_from_matrix(np.array(matrix)).pitch_deg

    # x4: the face is large enough (IPD ≥ 150 px). Level it and relax the smile, and every gate passes.
    x4 = images["x4"]
    level = rotated("x4", ("x", pitch_of(x4["matrix"])))
    neutral = {**x4["blendshapes"], "mouthSmileLeft": 0.05, "mouthSmileRight": 0.05}
    iris_x4 = mesh_iris_px(FaceDetection(np.column_stack([np.array(x4["xy"]), np.zeros(len(x4["xy"]))]),
                                         {}, np.eye(4), pose_from_matrix(np.eye(4))))

    def at(distance_m: float) -> dict[str, Any]:
        """A camera whose focal length puts the x4 face at this distance."""
        return {"focal_px": distance_m * 1000 * iris_x4 / settings.scale.iris_diameter_mm, "source": "calibration"}

    iris = {n: MESH_LANDMARKS[n].indices[0] for n in ("iris_center_right", "iris_right_medial", "iris_right_lateral",
                                                     "iris_center_left", "iris_left_lateral", "iris_left_medial")}
    base = {"matrix": level, "blendshapes": neutral, "camera": at(1.5)}
    cases: list[dict[str, Any]] = [
        {"name": name, "image": name, "matrix": img["matrix"], "blendshapes": img["blendshapes"], "camera": None}
        for name, img in images.items()
    ] + [{"name": name, "image": "x4", **base, **change} for name, change in (
        ("passes", {}),
        ("passes_distance_unverified", {"camera": None}),
        ("too_close", {"camera": at(0.8)}),
        ("turned_left", {"matrix": rotated("x4", ("x", pitch_of(x4["matrix"])), ("y", -12))}),
        ("turned_right", {"matrix": rotated("x4", ("x", pitch_of(x4["matrix"])), ("y", 12))}),
        ("chin_raised", {"matrix": rotated("x4", ("x", pitch_of(x4["matrix"]) - 12))}),
        ("tilted", {"matrix": rotated("x4", ("x", pitch_of(x4["matrix"])), ("z", 15))}),
        ("mouth_open", {"blendshapes": {**neutral, "jawOpen": 0.5}}),
        ("eyes_closed", {"blendshapes": {**neutral, "eyeBlinkLeft": 0.8}}),
        ("brows_raised", {"blendshapes": {**neutral, "browInnerUp": 0.6}}),
        ("no_blendshapes", {"blendshapes": {}}),
        # The iris ring collapsed to one point: the distance cannot be measured.
        ("no_iris", {"xy_patch": {str(iris[a]): x4["xy"][iris[b]] for a, b in (
            ("iris_right_lateral", "iris_right_medial"), ("iris_left_lateral", "iris_left_medial"))}}),
    )]

    regions: dict[str, Any] = {}
    for name, img in images.items():
        bgr = cv2.imread(str(OUT / "live" / f"{name}.png"))
        assert bgr is not None, name
        x0, y0, x1, y1 = img["region"]
        full = np.zeros((img["height"], img["width"], 3), np.uint8)   # only the region is ever read
        full[y0:y1, x0:x1] = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        regions[name] = full

    for case in cases:
        img = images[case["image"]]
        xy = np.array(img["xy"], dtype=float)
        for index, point in case.get("xy_patch", {}).items():
            xy[int(index)] = point
        matrix = np.array(case["matrix"], dtype=float)
        det = FaceDetection(landmarks=np.column_stack([xy, np.zeros(len(xy))]), blendshapes=case["blendshapes"],
                            transform=matrix, pose=pose_from_matrix(matrix))
        assert face_box(xy[list(FACE_OVAL_RING)], img["width"], img["height"]) == img["region"]
        camera = CameraInfo(**case["camera"]) if case["camera"] else None
        quality = summarize(frontal_checks(regions[case["image"]], det, camera, settings))
        case["expected"] = {
            "checks": [{"id": c.id, "value": c.value, "limit": c.limit, "status": c.status, "hint_key": c.hint_key}
                       for c in quality.checks],
            "passed": quality.passed,
            "hint_keys": quality.hint_keys,
            "warnings": quality.warnings,
            "iris_px": mesh_iris_px(det),
        }
    assert cases[len(images)]["expected"]["passed"] and not cases[len(images)]["expected"]["hint_keys"]

    # The display smoothing (webcam_capture.OneEuroFilter): noise, a jump, a timestamp going back.
    oe = settings.frontal.guided_capture.one_euro
    smooth = OneEuroFilter(oe.min_cutoff, oe.beta, oe.d_cutoff)
    rng = np.random.default_rng(314)
    t, samples = 0.0, []
    for i in range(90):
        t += 1 / 30 + float(rng.uniform(-0.004, 0.004))
        if i == 60:
            t -= 0.1
        x = 10 * math.sin(2 * t) + float(rng.normal(0, 0.5)) + (15.0 if i >= 45 else 0.0)
        samples.append({"t": t, "x": x, "y": smooth(x, t)})

    return {
        "constants": {"check_order": list(CHECK_ORDER), "expression_hints": _EXPRESSION_HINTS,
                      "face_oval_ring": list(FACE_OVAL_RING), "iris": iris, "typical_ipd_mm": TYPICAL_IPD_MM},
        "images": images,
        "cases": cases,
        "one_euro": {"params": {"min_cutoff": oe.min_cutoff, "beta": oe.beta, "d_cutoff": oe.d_cutoff},
                     "samples": samples},
    }


def ok_envelope(view: dict[str, Any], result: dict[str, Any], versions: dict[str, str],
                token: str | None = None) -> dict[str, Any]:
    """The API's ``ok`` response (see ``analysis_response``)."""
    from facescan_api.schemas import AnalyzeResponse

    quality = result.get("quality") or {}
    body = {
        "request_id": REQUEST_ID,
        "status": result["status"],
        "failed_checks": [c["id"] for c in quality.get("checks", []) if c.get("status") == "fail"],
        "hints": list(view.get("hints", [])),
        "warnings": list(quality.get("warnings", [])),
        "result": view,
        "result_token": token or f"fixture-token-{result['view']}",
        "versions": versions,
    }
    AnalyzeResponse.model_validate(body)
    return body


def main() -> None:
    from facescan.core.locale import user_view
    from facescan_api.errors import CODES
    from facescan_api.tokens import seal
    from helpers import synthetic_result

    if not (MODELS / "face_landmarker.task").is_file():
        raise SystemExit("model files missing: python -m facescan.tools.download_models")
    OUT.mkdir(parents=True, exist_ok=True)
    write("error_codes.json", dict(sorted(CODES.items())))

    from PIL import features

    from facescan import EngineConfig, FaceScanEngine
    from facescan.core.normalize import load_image
    from helpers import face_mm, to_image

    if not features.check("raqm") and not CHECK:
        print("warning: RAQM unavailable, so Thai overlay labels are shaped incorrectly "
              "(macOS: brew install fribidi; DYLD_LIBRARY_PATH=/opt/homebrew/lib)", file=sys.stderr)

    frontal, asm = synthetic_result()
    assert frontal.image is not None and frontal.frames is not None
    size = (frontal.image.width, frontal.image.height)
    face = draw_face(to_image(face_mm()), size)
    photo = photo_jpeg(face, REAR_LENS)
    loaded = load_image(photo)
    # The synthetic result's reference image is the photo (overlays and /v1/overlay need it).
    frontal = frontal.model_copy(update={"frames": frontal.frames.model_copy(update={"reference_sha256": loaded.sha256})})
    adjusted = asm.apply_overrides(frontal, {"trichion": {"x": 800.0, "y": 490.0, "source": "user_adjusted"}})
    assert "large_user_adjustment" in adjusted.landmarks["trichion"].flags
    no_hairline = no_hairline_result(frontal, asm)
    (OUT / "formats").mkdir(exist_ok=True)
    for name, data in format_samples().items():
        write_bytes(f"formats/{name}", data)
    write_bytes("photo.jpg", photo)
    write_bytes("photo_front.jpg", photo_jpeg(face, FRONT_LENS))
    heic = heic_copy(photo)
    if heic is not None:
        write_bytes("photo.heic", heic)
    elif not (OUT / "photo.heic").is_file():
        print("warning: photo.heic needs macOS sips", file=sys.stderr)
    write("exif_focal.json", {
        "cases": exif_cases(),
        # Every photo's EXIF gives this focal length in the core (load_image), HEIC included.
        "photos": {"photo.jpg": loaded.camera.focal_px if loaded.camera else None},
    })

    with FaceScanEngine(EngineConfig.from_models_dir(MODELS)) as engine:
        for locale in LOCALES:
            for name, result in (("overlay_ok", frontal), ("overlay_adjusted", adjusted)):
                rgb = engine.render_overlay(loaded, result, layers=set(FRONTAL_LAYERS), locale=locale)
                write_bytes(f"{name}.{locale}.jpg", overlay_jpeg(rgb))
        side = profile_results(engine, frontal)
        write_bytes("profile.jpg", side["photo"])
        for locale in LOCALES:
            for name in ("ok", "adjusted"):
                rgb = engine.render_overlay(side["side"], side[name], layers=set(PROFILE_LAYERS), locale=locale)
                write_bytes(f"overlay_profile_{name}.{locale}.jpg", overlay_jpeg(rgb))
    write("contour_snap.json", contour_snap_cases(side["ok"]))
    (OUT / "live").mkdir(exist_ok=True)
    write("live_gates.json", live_gates())

    full = json.loads(frontal.model_dump_json())
    with real_api() as client:
        wait_ready(client)
        for locale in LOCALES:
            r = client.get("/v1/client-config", params={"locale": locale})
            r.raise_for_status()
            config = r.json()
            write(f"client_config.{locale}.json", config)

            write(f"frontal_ok.{locale}.json",
                  ok_envelope(user_view(frontal, locale=locale), full, config["versions"]))
            write(f"frontal_adjusted.{locale}.json",
                  ok_envelope(user_view(adjusted, locale=locale), json.loads(adjusted.model_dump_json()),
                              config["versions"], token="fixture-token-frontal-adjusted"))
            write(f"frontal_ok_no_hairline.{locale}.json",
                  ok_envelope(user_view(no_hairline, locale=locale), json.loads(no_hairline.model_dump_json()),
                              config["versions"], token="fixture-token-frontal-no-hairline"))

            meta = {"subject": {"sex": "female", "age": 28}, "locale": locale}
            r = client.post("/v1/frontal/analyze", files=[
                ("frames", ("astronaut.png", ASTRONAUT.read_bytes(), "image/png")),
                ("meta", (None, json.dumps(meta), "application/json"))])
            r.raise_for_status()
            failed = r.json()
            assert failed["status"] == "quality_failed", failed["status"]
            write(f"frontal_quality_failed.{locale}.json", stable(failed))

            r = client.post("/v1/frontal/analyze", files=[
                ("frames", ("blank.png", blank_png(), "image/png")),
                ("meta", (None, json.dumps(meta), "application/json"))])
            r.raise_for_status()
            assert r.json()["status"] == "no_face", r.json()["status"]
            write(f"frontal_no_face.{locale}.json", stable(r.json()))

            # The side view. Tokens are placeholders, as for the frontal results.
            for name, token in (("ok", None), ("no_scale", "fixture-token-profile-no-scale"),
                                ("adjusted", "fixture-token-profile-adjusted")):
                result = side[name]
                write(f"profile_{name}.{locale}.json",
                      ok_envelope(user_view(result, locale=locale), json.loads(result.model_dump_json()),
                                  config["versions"], token=token))

            # A real contour_failed from the API, sent as the web app sends it: with a frontal
            # token. The API's own seal issues it for the synthetic frontal result, stamped with
            # the running configuration's hash (the synthetic result uses the same config files
            # under a stand-in hash).
            stamped = frontal.model_copy(update={"config_hash": config["config_hash"]})
            token = seal(kind="frontal", session_id=str(uuid.uuid4()), result=json.loads(stamped.model_dump_json()))
            meta = {"facing": "right", "locale": locale, "frontal_token": token,
                    "overlay": {"layers": PROFILE_LAYERS}}
            r = client.post("/v1/profile/analyze", files=[
                ("image", (LATHE.name, LATHE.read_bytes(), "image/jpeg")),
                ("meta", (None, json.dumps(meta), "application/json"))])
            r.raise_for_status()
            assert r.json()["status"] == "contour_failed", r.json()["status"]
            write(f"profile_contour_failed.{locale}.json", stable(r.json()))

            # The report, from tokens of one session, as the web app sends them.
            assert side["ok"].config_hash == config["config_hash"], "the engine and the API use different configurations"
            session = str(uuid.uuid4())
            frontal_token = seal(kind="frontal", session_id=session, result=json.loads(stamped.model_dump_json()))
            profile_token = seal(kind="profile", session_id=session, result=json.loads(side["ok"].model_dump_json()))
            for name, body in (("report_ok", {"frontal_token": frontal_token, "profile_token": profile_token}),
                               ("report_frontal_only", {"frontal_token": frontal_token})):
                r = client.post("/v1/report", json={**body, "locale": locale})
                r.raise_for_status()
                report = r.json()
                assert report["report"]["rules_version"] == "EXAMPLE"
                assert bool(report["report"]["considerations"]) == (name == "report_ok"), report["report"]["considerations"]
                write(f"{name}.{locale}.json", stable(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate (or --check) the web fixtures.")
    parser.add_argument("--check", action="store_true", help="compare with the committed fixtures; write nothing")
    CHECK = parser.parse_args().check
    main()
    if MISMATCHES:
        raise SystemExit(f"fixtures differ from the core and API: {', '.join(MISMATCHES)}; "
                         "run web/scripts/gen_fixtures.py and commit the result")
