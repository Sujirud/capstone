"""Download the MediaPipe model files once (the engine never downloads at runtime).

    python -m facescan.tools.download_models [--dest models]

Each file is checked against a pinned SHA-256. The URLs point at Google's
"latest" model paths, so a mismatch means Google published a new model: the
download is refused until the new file is validated (re-run
``tools/debug_landmarks.py`` and the tests) and its hash is pinned here, or the
caller passes ``--accept-new-hash`` for local experiments.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

MODELS: dict[str, tuple[str, str]] = {
    "face_landmarker.task": (
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
        "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    ),
    "selfie_multiclass_256x256.tflite": (
        "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
        "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0",
    ),
}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(name: str, dest: Path, *, force: bool, accept_new_hash: bool) -> bool:
    url, pinned = MODELS[name]
    target = dest / name
    if target.exists() and not force:
        actual = sha256_of(target)
        if actual == pinned:
            print(f"ok       {name} (already present)")
            return True
        print(f"mismatch {name}: existing file has sha256 {actual}; re-downloading")
    tmp = target.with_suffix(target.suffix + ".part")
    print(f"download {name} …")
    with urllib.request.urlopen(url, timeout=120) as resp, open(tmp, "wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)
    actual = sha256_of(tmp)
    if actual != pinned and not accept_new_hash:
        tmp.unlink(missing_ok=True)
        print(f"error    {name}: sha256 {actual} does not match the pinned {pinned}", file=sys.stderr)
        return False
    tmp.replace(target)
    note = "" if actual == pinned else f" (NEW HASH {actual}, accepted by --accept-new-hash)"
    print(f"ok       {name}{note}")
    return True


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="facescan-download-models", description=__doc__.split("\n\n")[0])
    p.add_argument("--dest", type=Path, default=Path("models"))
    p.add_argument("--force", action="store_true", help="download even if a valid file exists")
    p.add_argument("--accept-new-hash", action="store_true", help="keep files whose hash differs from the pin")
    args = p.parse_args(argv)
    args.dest.mkdir(parents=True, exist_ok=True)
    ok = all([fetch(n, args.dest, force=args.force, accept_new_hash=args.accept_new_hash) for n in MODELS])
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
