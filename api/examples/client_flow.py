"""Walk through the web app's flow against a running service.

    python examples/client_flow.py --base-url http://127.0.0.1:8000 \\
        --image frontal.jpg [--image frame2.jpg --image frame3.jpg ...] [--focal-px 2890] \\
        [--profile profile.jpg --facing left] [--out out/]

Steps: client config → frontal analysis (one photo or a burst) → hairline
adjustment → overlay redrawn after the adjustment → profile analysis with the
frontal token (same session, mm scale) → nose-tip adjustment, which the service
re-snaps to the silhouette → profile overlay → report with considerations.
Uses ``httpx2``.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Any

import httpx2 as httpx


def show_problem(r: httpx.Response) -> None:
    p = r.json()
    print(f"  → {r.status_code} {p['code']}: {p['detail']} (request {p.get('request_id')})")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--image", action="append", type=Path, required=True,
                    help="frontal photo; repeat 3–15 times for a burst (capture order)")
    ap.add_argument("--sex", default="unspecified", choices=["female", "male", "unspecified"])
    ap.add_argument("--age", type=int, default=30)
    ap.add_argument("--locale", default="th", choices=["th", "en"])
    ap.add_argument("--focal-px", type=float, help="camera focal length in pixels, if the device knows it")
    ap.add_argument("--profile", type=Path, help="profile photo (true 90° side view)")
    ap.add_argument("--facing", default="left", choices=["left", "right"],
                    help="the direction the nose points in the profile photo")
    ap.add_argument("--out", type=Path, default=Path("out"))
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    frames = [p.read_bytes() for p in args.image]

    with httpx.Client(base_url=args.base_url, timeout=60) as c:
        # 1. Client config: thresholds and strings for on-device guidance.
        r = c.get("/v1/client-config", params={"locale": args.locale})
        if r.status_code != 200:
            show_problem(r)
            return 1
        cfg = r.json()
        burst = cfg["frontal"]["burst"]
        print(f"1. client config: core {cfg['core_version']}, burst {burst['min_frames']}–{burst['max_frames']} frames, "
              f"adjustable {cfg['user_adjustable_points']['frontal']}, rules {cfg['rules_version']}")

        # 2. Frontal analysis.
        meta: dict[str, Any] = {"subject": {"sex": args.sex, "age": args.age}, "locale": args.locale,
                                "overlay": {"layers": ["landmarks", "thirds", "fifths"]}}
        if args.focal_px:
            meta["camera"] = {"focal_px": args.focal_px, "source": "device"}
        files = [("frames", (p.name, data, "application/octet-stream")) for p, data in zip(args.image, frames, strict=True)]
        files.append(("meta", (None, json.dumps(meta), "application/json")))
        r = c.post("/v1/frontal/analyze", files=files)
        if r.status_code != 200:
            show_problem(r)
            return 1
        b = r.json()
        print(f"2. frontal analysis: {b['status']}, warnings {b['warnings']}")
        if b["status"] != "ok":
            print("   retake the photo:", *[f"\n   - {h}" for h in b["hints"]])
            return 0
        if "overlay" in b:
            (args.out / "overlay.jpg").write_bytes(base64.b64decode(b["overlay"].split(",", 1)[1]))
        result, token = b["result"], b["result_token"]
        for m in result["metrics"].values():
            print(f"   {m['name']}: {m['value_text']} ({m['status_text']})")

        # 3. The user moves the hairline point (here: 1 % of the image height upwards).
        t = result["landmarks"].get("trichion", {})
        if t.get("x") is not None:
            new = {"x": t["x"], "y": max(0.0, t["y"] - 0.01 * result["image"]["height"])}
            r = c.post("/v1/adjust", json={"result_token": token, "overrides": {"trichion": new}, "locale": args.locale})
            if r.status_code != 200:
                show_problem(r)
                return 1
            token = r.json()["result_token"]
            print("3. adjusted trichion → new token in the same session")
        else:
            print("3. no automatic hairline point to adjust; skipped")

        # 4. Overlay redrawn after the adjustment, on the reference frame as uploaded.
        ref = frames[result["frames"]["reference_frame"]]
        ov_meta = {"result_token": token, "layers": ["landmarks", "thirds"], "locale": args.locale}
        r = c.post("/v1/overlay", files=[("image", ("reference", ref, "application/octet-stream")),
                                         ("meta", (None, json.dumps(ov_meta), "application/json"))])
        if r.status_code == 200:
            (args.out / "overlay_adjusted.jpg").write_bytes(r.content)
            print(f"4. overlay saved to {args.out / 'overlay_adjusted.jpg'}")
        else:
            show_problem(r)

        # 5. Profile photo with the frontal token: same session and subject, mm scale from the frontal result.
        profile_token = None
        if args.profile:
            prof = args.profile.read_bytes()
            pmeta = {"facing": args.facing, "locale": args.locale, "frontal_token": token,
                     "overlay": {"layers": ["landmarks", "profile_lines"]}}
            r = c.post("/v1/profile/analyze", files=[("image", (args.profile.name, prof, "application/octet-stream")),
                                                     ("meta", (None, json.dumps(pmeta), "application/json"))])
            if r.status_code != 200:
                show_problem(r)
                return 1
            pb = r.json()
            print(f"5. profile analysis: {pb['status']}, warnings {pb['warnings']}")
            if pb["status"] != "ok":
                print("   retake the profile photo:", *[f"\n   - {h}" for h in pb["hints"]])
            else:
                profile_token = pb["result_token"]
                if "overlay" in pb:
                    (args.out / "profile_overlay.jpg").write_bytes(base64.b64decode(pb["overlay"].split(",", 1)[1]))
                for m in pb["result"]["metrics"].values():
                    print(f"   {m['name']}: {m['value_text']} ({m['status_text']})")
                ptoken = pb["result_token"]
                # 6. The user drags the nose tip 5 px forward; the service puts it back on the silhouette.
                pn = pb["result"]["landmarks"].get("pronasale", {})
                if pn.get("x") is not None:
                    dx = -5.0 if args.facing == "left" else 5.0
                    r = c.post("/v1/adjust", json={
                        "result_token": ptoken, "overrides": {"pronasale": {"x": pn["x"] + dx, "y": pn["y"]}},
                        "locale": args.locale})
                    if r.status_code != 200:
                        show_problem(r)
                        return 1
                    moved = r.json()["result"]["landmarks"]["pronasale"]
                    ptoken = profile_token = r.json()["result_token"]
                    print(f"6. pronasale sent at ({pn['x'] + dx:.1f}, {pn['y']:.1f}), "
                          f"snapped to ({moved['x']:.1f}, {moved['y']:.1f})")
                ov_meta = {"result_token": ptoken, "layers": ["landmarks", "profile_lines"], "locale": args.locale}
                r = c.post("/v1/overlay", files=[("image", ("profile", prof, "application/octet-stream")),
                                                 ("meta", (None, json.dumps(ov_meta), "application/json"))])
                if r.status_code == 200:
                    (args.out / "profile_overlay_adjusted.jpg").write_bytes(r.content)
                    print(f"7. profile overlay saved to {args.out / 'profile_overlay_adjusted.jpg'}")
                else:
                    show_problem(r)

        # 8. Report with considerations: the session's (latest) frontal and profile tokens.
        body = {"frontal_token": token, "locale": args.locale}
        if profile_token:
            body["profile_token"] = profile_token
        r = c.post("/v1/report", json=body)
        if r.status_code != 200:
            show_problem(r)
            return 1
        rep = r.json()["report"]
        print(f"8. report (rules {rep['rules_version']}):")
        if not rep["considerations"]:
            print(f"   {rep['no_considerations_note']}")
        else:
            print(f"   {rep['consideration_intro']}")
            for item in rep["considerations"]:
                print(f"   - [{item['area_text']}] {item['finding']}")
                for m in item["measurements"]:
                    ref = m["reference"]["text"] if m["reference"] else "—"
                    print(f"       {m['name']}: {m['value_text']} (reference {ref})")
                for text in item["considerations"]:
                    print(f"       · {text}")
                print(f"     {item['consult']}")
        print(f"   {rep['disclaimer']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
