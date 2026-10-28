"""CLI: image(s) → result JSON, consumer view JSON and annotated PNGs.

Frontal (default): one image is analyzed as a still photo (test-time augmentation);
several images are analyzed as a burst (3–15 frames of identical size, in capture order).
Profile (``--view profile``): one side photo; ``--facing`` is the direction the nose
points in the image; ``--frontal-result`` (a result.json from a frontal run of the same
session) enables mm values by scale transfer.

Examples::

    python -m facescan.apps.analyze_image photo.jpg --sex female --age 28 --out-dir out/
    python -m facescan.apps.analyze_image f1.png f2.png f3.png --sex male --age 35 \\
        --focal-px 2890 --override trichion=1012.5,388 --out-dir out/ --styles user clinical
    python -m facescan.apps.analyze_image side.jpg --view profile --facing right --sex female --age 28 \\
        --frontal-result out/result.json --override alar_crease=1510,980 --out-dir out_profile/

Only this app (and the other reference apps) write files, and only into the
directory given with ``--out-dir``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from facescan import CameraInfo, EngineConfig, FaceScanEngine, FrontalResult, Override, SubjectInfo, load_image
from facescan.core.errors import FaceScanError
from facescan.render.overlay import LAYERS


def _parse_override(text: str) -> tuple[str, Override]:
    """``name=x,y`` or ``name=x,y:clinician``."""
    try:
        name, rest = text.split("=", 1)
        coords, _, source = rest.partition(":")
        x, y = (float(v) for v in coords.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"bad override {text!r}; expected name=x,y[:source]") from exc
    return name.strip(), Override(x=x, y=y, source=source or "user_adjusted")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="facescan-analyze", description=__doc__.split("\n\n")[0])
    p.add_argument("images", nargs="+", type=Path, help="one photo, or 3–15 burst frames (frontal)")
    p.add_argument("--view", choices=["frontal", "profile"], default="frontal")
    p.add_argument("--facing", choices=["left", "right"], help="profile: direction the nose points in the image")
    p.add_argument("--frontal-result", type=Path, help="profile: frontal result.json of the same session")
    p.add_argument("--out-dir", type=Path, required=True, help="directory for the outputs (created if missing)")
    p.add_argument("--sex", choices=["female", "male", "unspecified"], required=True)
    p.add_argument("--age", type=int, required=True)
    p.add_argument("--norms-profile", default="canon")
    p.add_argument("--models-dir", type=Path, default=Path("models"))
    p.add_argument("--config", type=Path, help="EngineConfig YAML (overrides --models-dir)")
    p.add_argument("--focal-px", type=float, help="focal length in pixels (device intrinsics); default: EXIF")
    p.add_argument("--locale", choices=["th", "en"], default="th")
    p.add_argument("--styles", nargs="*", choices=["user", "clinical"], default=["user"])
    p.add_argument("--layers", nargs="*", choices=list(LAYERS),
                   help="default: every layer of the view (golden ratio only in the clinical style)")
    p.add_argument("--override", action="append", type=_parse_override, default=[],
                   help="point override name=x,y[:user_adjusted|clinician] (repeatable)")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.view == "profile" and (len(args.images) != 1 or args.facing is None):
        parser.error("--view profile needs exactly one image and --facing")
    layers = set(args.layers) if args.layers else (
        {"landmarks", "profile_lines", "labels"} if args.view == "profile"
        else {"landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"})
    config = EngineConfig.from_yaml(args.config) if args.config else EngineConfig.from_models_dir(args.models_dir)
    camera = CameraInfo(focal_px=args.focal_px, source="device") if args.focal_px else None
    subject = SubjectInfo(sex=args.sex, age=args.age, norms_profile=args.norms_profile)
    overrides = dict(args.override)
    try:
        images = [load_image(p.read_bytes(), camera=camera) for p in args.images]
        with FaceScanEngine(config) as engine:
            if args.view == "profile":
                frontal = None
                if args.frontal_result:
                    frontal = FrontalResult.model_validate_json(args.frontal_result.read_text(encoding="utf-8"))
                result = engine.analyze_profile(images[0], subject=subject, facing=args.facing, frontal=frontal,
                                                overrides=overrides or None)
            else:
                result = engine.analyze_frontal(images if len(images) > 1 else images[0], subject=subject,
                                                overrides=overrides or None)
            args.out_dir.mkdir(parents=True, exist_ok=True)
            (args.out_dir / "result.json").write_text(result.model_dump_json(indent=2), encoding="utf-8")
            view = engine.user_view(result, locale=args.locale)
            (args.out_dir / f"user_view_{args.locale}.json").write_text(
                json.dumps(view, ensure_ascii=False, indent=2), encoding="utf-8")
            written = ["result.json", f"user_view_{args.locale}.json"]
            if result.landmarks and result.frames is not None:
                ref = images[result.frames.reference_frame]
                for style in args.styles:
                    extra = {"golden_ratio"} if style == "clinical" and args.view == "frontal" else set()
                    out = engine.render_overlay(ref, result, layers=layers | extra, style=style, locale=args.locale)
                    name = f"overlay_{style}.png"
                    Image.fromarray(out).save(args.out_dir / name)
                    written.append(name)
    except (FaceScanError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"status: {result.status}")
    if result.quality is not None:
        for c in result.quality.checks:
            if c.status != "pass":
                print(f"  {c.id}: {c.status} (value={c.value}, limit={c.limit})")
        for hint in view.get("hints", []):
            print(f"  hint: {hint}")
    print(f"wrote {', '.join(written)} to {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
