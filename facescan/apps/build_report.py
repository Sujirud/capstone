"""CLI: frontal / profile result JSON files → report JSON and consumer report view (Phase 3).

    python -m facescan.apps.build_report --frontal-result out/result.json \\
        --profile-result out_profile/result.json --rules clinic_rules.yaml --out-dir report/

The results must come from the same code and measurement configuration as this run
(same models and config files); rules may differ, they are recorded separately in the
report (``rules_version``, ``rules_hash``). Only ``--out-dir`` is written to.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from facescan import EngineConfig, FaceScanEngine, FrontalResult, ProfileResult
from facescan.core.errors import FaceScanError


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="facescan-report", description=__doc__.split("\n\n")[0])
    p.add_argument("--frontal-result", type=Path)
    p.add_argument("--profile-result", type=Path)
    p.add_argument("--rules", type=Path, help="clinical rules file (none → measurements only)")
    p.add_argument("--models-dir", type=Path, default=Path("models"))
    p.add_argument("--locale", choices=["th", "en"], default="th")
    p.add_argument("--out-dir", type=Path, required=True)
    args = p.parse_args(argv)
    if not args.frontal_result and not args.profile_result:
        p.error("give --frontal-result and / or --profile-result")
    try:
        frontal = FrontalResult.model_validate_json(args.frontal_result.read_text(encoding="utf-8")) \
            if args.frontal_result else None
        profile = ProfileResult.model_validate_json(args.profile_result.read_text(encoding="utf-8")) \
            if args.profile_result else None
        config = EngineConfig.from_models_dir(args.models_dir, rules_path=args.rules)
        with FaceScanEngine(config) as engine:
            report = engine.build_report(frontal, profile)
            view = engine.user_view(report, locale=args.locale)
    except (FaceScanError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "report.json").write_text(report.model_dump_json(indent=2), encoding="utf-8")
    (args.out_dir / f"report_view_{args.locale}.json").write_text(json.dumps(view, ensure_ascii=False, indent=2),
                                                                  encoding="utf-8")
    print(f"status: {report.status}; considerations: {len(report.considerations)}; rules: {report.rules_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
