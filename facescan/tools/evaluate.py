"""Validation against clinician-placed landmarks.

    python -m facescan.tools.evaluate --images-dir data/ --landmarks clinician.csv --out report.json

CSV columns (one row per image and point)::

    image,subject_id,session,condition,sex,age,point,x,y[,view,facing]

``image`` is relative to ``--images-dir``; ``condition`` labels the capture
setting (e.g. ``consumer_phone``, ``controlled``); ``point`` is a point name of the
image's view (``landmark_map``) in pixel coordinates of the image after EXIF
orientation. ``sex`` / ``age`` may be empty (defaults: unspecified / 30). ``view`` is
``frontal`` (default) or ``profile``; profile rows need ``facing`` (left / right) and
use the frontal image of the same subject and session, when there is one, for the
mm scale transfer. Clinician silhouette points are snapped to the contour before the
metric comparison (as in the app); landmark errors use the raw clinician positions.

The report contains, overall and per condition:

* per-landmark error (px, and mm when the iris scale is available);
* per-metric agreement between automatic metrics and metrics recomputed with the
  clinician's points (clinician overrides): mean difference, SD and
  Bland–Altman 95 % limits of agreement;
* test–retest repeatability of automatic metrics across repeated captures of the
  same person: ICC(1,1) (one-way random effects, unbalanced groups);
* gate rejection rates and failure counts per check;
* comparison with the acceptance targets in ``config/evaluation.yaml``
  (placeholders; null means "no target").

Evaluation images and landmark files are never committed.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from facescan import EngineConfig, FaceScanEngine, FaceScanError, Override, SubjectInfo, load_image
from facescan.core.config import DEFAULT_CONFIG_DIR, read_yaml
from facescan.core.landmark_map import FRONTAL_POINT_NAMES, PROFILE_POINT_NAMES


def icc_1_1(groups: list[list[float]]) -> float | None:
    """One-way random-effects ICC(1,1) for unbalanced groups (≥ 2 groups with ≥ 2 values)."""
    groups = [g for g in groups if len(g) >= 2]
    if len(groups) < 2:
        return None
    n_i = np.array([len(g) for g in groups], dtype=float)
    N, k = n_i.sum(), len(groups)
    means = np.array([np.mean(g) for g in groups])
    grand = np.concatenate([np.asarray(g, float) for g in groups]).mean()
    msb = float((n_i * (means - grand) ** 2).sum() / (k - 1))
    msw = float(sum(((np.asarray(g) - m) ** 2).sum() for g, m in zip(groups, means)) / (N - k))
    k0 = (N - (n_i ** 2).sum() / N) / (k - 1)
    denom = msb + (k0 - 1) * msw
    return None if denom <= 0 else (msb - msw) / denom


def bland_altman(diffs: list[float]) -> dict[str, float | int | None]:
    d = np.asarray(diffs, dtype=float)
    if len(d) == 0:
        return {"n": 0, "mean_diff": None, "sd_diff": None, "loa_low": None, "loa_high": None}
    mean = float(d.mean())
    sd = float(d.std(ddof=1)) if len(d) > 1 else None
    return {"n": int(len(d)), "mean_diff": mean, "sd_diff": sd,
            "loa_low": None if sd is None else mean - 1.96 * sd,
            "loa_high": None if sd is None else mean + 1.96 * sd}


def _summary(values: list[float]) -> dict[str, float | int | None]:
    v = np.asarray(values, dtype=float)
    if len(v) == 0:
        return {"n": 0, "mean": None, "median": None, "p95": None}
    return {"n": int(len(v)), "mean": float(v.mean()), "median": float(np.median(v)),
            "p95": float(np.percentile(v, 95))}


def _target(targets: dict[str, Any], section: str, key: str, name: str) -> Any:
    sec = targets.get(section) or {}
    return (sec.get(name) or {}).get(key, (sec.get("default") or {}).get(key))


def read_csv(path: Path) -> dict[str, dict[str, Any]]:
    images: dict[str, dict[str, Any]] = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            img = images.setdefault(row["image"], {
                "subject_id": row.get("subject_id") or row["image"], "session": row.get("session") or "",
                "condition": row.get("condition") or "unspecified", "sex": row.get("sex") or "unspecified",
                "age": int(row["age"]) if row.get("age") else 30, "points": {},
                "view": (row.get("view") or "frontal").strip(), "facing": (row.get("facing") or "").strip() or None})
            img["points"][row["point"]] = (float(row["x"]), float(row["y"]))
    return images


def evaluate(engine: FaceScanEngine, images_dir: Path, rows: dict[str, dict[str, Any]],
             targets: dict[str, Any]) -> dict[str, Any]:
    lm_err: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))   # condition → point → px
    lm_err_mm: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    diffs: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))    # condition → metric
    auto_values: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))  # metric → subject
    gates: dict[str, dict[str, Any]] = defaultdict(lambda: {"n": 0, "rejected": 0, "failed_checks": defaultdict(int)})
    skipped: list[str] = []

    frontal_by_session: dict[tuple[str, str], Any] = {}
    # Frontal images first, so profile images of the same session can use their scale.
    order = sorted(rows, key=lambda n: rows[n]["view"] != "frontal")
    for name in order:
        info = rows[name]
        cond = info["condition"]
        g = gates[cond]
        g["n"] += 1
        try:
            img = load_image((images_dir / name).read_bytes())
        except (OSError, ValueError) as exc:
            skipped.append(f"{name}: {exc}")
            g["n"] -= 1
            continue
        subject = SubjectInfo(sex=info["sex"], age=info["age"])
        key = (info["subject_id"], info["session"])
        if info["view"] == "profile":
            if info["facing"] not in ("left", "right"):
                skipped.append(f"{name}: profile rows need facing=left|right")
                g["n"] -= 1
                continue
            frontal = frontal_by_session.get(key)
            if frontal is not None and frontal.subject != subject:
                frontal = None
            result = engine.analyze_profile(img, subject=subject, facing=info["facing"], frontal=frontal)
            point_names = PROFILE_POINT_NAMES
        else:
            result = engine.analyze_frontal(img, subject=subject)
            frontal_by_session[key] = result
            point_names = FRONTAL_POINT_NAMES
        if result.status != "ok":
            g["rejected"] += 1
            for c in (result.quality.checks if result.quality else []):
                if c.status == "fail":
                    g["failed_checks"][c.id] += 1
        if not result.landmarks:
            continue
        mm = result.calibration.mm_per_px if result.calibration else None
        clin = {p: xy for p, xy in info["points"].items() if p in point_names}
        W, H = img.width, img.height
        clin = {p: xy for p, xy in clin.items() if 0 <= xy[0] < W and 0 <= xy[1] < H}
        for p, (x, y) in clin.items():
            lm = result.landmarks[p]
            if lm.available:
                e = math.hypot(lm.x - x, lm.y - y)
                for c in (cond, "_all"):
                    lm_err[c][p].append(e)
                    if mm:
                        lm_err_mm[c][p].append(e * mm)
        try:
            clinician = engine.apply_overrides(
                result, {p: Override(x=x, y=y, source="clinician") for p, (x, y) in clin.items()})
        except FaceScanError as exc:
            skipped.append(f"{name}: clinician points not applicable ({exc})")
            continue
        for mid, m in result.metrics.items():
            mc = clinician.metrics[mid]
            if m.value is not None and mc.value is not None:
                for c in (cond, "_all"):
                    diffs[c][mid].append(m.value - mc.value)
            if m.value is not None:
                auto_values[mid][info["subject_id"]].append(m.value)

    report: dict[str, Any] = {"core_version": engine.core_version, "config_hash": engine.config_hash,
                              "n_images": len(rows), "skipped": skipped, "conditions": {}}
    for cond in sorted(set(lm_err) | set(diffs) | set(gates) | {"_all"}):
        lms = {}
        for p, errs in lm_err[cond].items():
            s = _summary(errs)
            s_mm = _summary(lm_err_mm[cond][p])
            t = _target(targets, "landmarks", "max_mean_error_mm", p)
            lms[p] = {"px": s, "mm": s_mm, "target_max_mean_error_mm": t,
                      "meets_target": None if t is None or s_mm["mean"] is None else s_mm["mean"] <= t}
        mets = {}
        for mid, d in diffs[cond].items():
            ba = bland_altman(d)
            t_mean = _target(targets, "metrics", "max_abs_mean_diff", mid)
            t_loa = _target(targets, "metrics", "max_loa_half_width", mid)
            ba["target_max_abs_mean_diff"] = t_mean
            ba["target_max_loa_half_width"] = t_loa
            mets[mid] = ba
        entry: dict[str, Any] = {"landmark_error": lms, "metric_agreement": mets}
        if cond != "_all":
            g = gates[cond]
            rate = g["rejected"] / g["n"] if g["n"] else None
            t = (targets.get("gates") or {}).get("max_rejection_rate")
            entry["gates"] = {"n": g["n"], "rejected": g["rejected"], "rejection_rate": rate,
                              "failed_checks": dict(g["failed_checks"]), "target_max_rejection_rate": t}
        report["conditions"][cond] = entry
    report["test_retest_icc"] = {}
    for mid, by_subject in auto_values.items():
        icc = icc_1_1(list(by_subject.values()))
        t = _target(targets, "metrics", "min_icc", mid)
        report["test_retest_icc"][mid] = {"icc_1_1": icc, "target_min_icc": t,
                                          "meets_target": None if t is None or icc is None else icc >= t}
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="facescan-evaluate", description=__doc__.split("\n\n")[0])
    p.add_argument("--images-dir", type=Path, required=True)
    p.add_argument("--landmarks", type=Path, required=True, help="CSV of clinician-placed landmarks")
    p.add_argument("--out", type=Path, required=True, help="output JSON report")
    p.add_argument("--models-dir", type=Path, default=Path("models"))
    p.add_argument("--targets", type=Path, default=DEFAULT_CONFIG_DIR / "evaluation.yaml")
    args = p.parse_args(argv)
    rows = read_csv(args.landmarks)
    targets = read_yaml(args.targets)
    with FaceScanEngine(EngineConfig.from_models_dir(args.models_dir)) as engine:
        report = evaluate(engine, args.images_dir, rows, targets)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    for cond, entry in report["conditions"].items():
        g = entry.get("gates")
        if g:
            print(f"[{cond}] images={g['n']} rejected={g['rejected']} rate={g['rejection_rate']}")
    print(f"wrote {args.out}")
    if report["skipped"]:
        print(f"skipped {len(report['skipped'])} images", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
