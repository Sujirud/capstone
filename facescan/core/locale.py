"""Locale strings and the consumer-app JSON view (``user_view``).

All user-facing text comes from ``config/locale_<code>.yaml`` so the clinical
team can review the wording. ``user_view`` drops ``display: clinic_only``
metrics and resolves every text key (hints, statuses, findings,
considerations, disclaimers) into the locale's strings.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from facescan.core.config import DEFAULT_CONFIG_DIR, LOCALES, load_locales, read_yaml
from facescan.core.schema import FrontalResult, Metric, ProfileResult, Report

_MISSING = object()


class Strings:
    """Dotted-key lookup (``"hint.move_back"``) with English fallback."""

    def __init__(self, locales: Mapping[str, Mapping[str, Any]], locale: str) -> None:
        if locale not in locales:
            raise ValueError(f"unsupported locale {locale!r}; available: {sorted(locales)}")
        self.locale = locale
        self._data = locales[locale]
        self._fallback = locales.get("en") if locale != "en" else None

    @staticmethod
    def _walk(data: Mapping[str, Any] | None, key: str) -> Any:
        node: Any = data
        for part in key.split("."):
            if not isinstance(node, Mapping) or part not in node:
                return _MISSING
            node = node[part]
        return node

    def lookup(self, key: str) -> Any:
        v = self._walk(self._data, key)
        if v is _MISSING and self._fallback is not None:
            v = self._walk(self._fallback, key)
        return v

    def has(self, key: str) -> bool:
        return self._walk(self._data, key) is not _MISSING

    def get(self, key: str | None, default: str | None = None) -> str | None:
        if key is None:
            return default
        v = self.lookup(key)
        if v is _MISSING or not isinstance(v, str):
            return default if default is not None else key
        return v

    def section(self, key: str) -> Any:
        v = self.lookup(key)
        return {} if v is _MISSING else v


def load_strings(locale: str, config_dir: str | Path | None = None) -> Strings:
    return Strings(load_locales(Path(config_dir or DEFAULT_CONFIG_DIR)), locale)


_DECIMALS = {"fraction": 3, "ratio": 2, "deg": 1, "mm": 1, "%ICD": 1, "%E-line": 1}


def format_value(value: float | None, unit: str, S: Strings) -> str | None:
    if value is None:
        return None
    return f"{value:.{_DECIMALS.get(unit, 2)}f}{S.get('units.' + unit, '')}"


# --------------------------------------------------------------------------- views


def _metric_text_key(metric_id: str) -> str:
    return f"metric.{metric_id}"


def _metric_view(metric_id: str, m: Metric, S: Strings, area: str | None) -> dict[str, Any]:
    ref = None
    if m.status_basis == "population" and m.population.typical_min is not None:
        lo, hi, basis = m.population.typical_min, m.population.typical_max, "population"
    elif m.canon is not None and m.canon.min is not None and m.canon.max is not None:
        lo, hi, basis = m.canon.min, m.canon.max, "canon"
    else:
        lo = hi = basis = None
    if basis is not None:
        ref = {
            "basis": basis,
            "label": S.get(f"reference.{basis}"),
            "min": lo,
            "max": hi,
            "text": f"{format_value(lo, m.unit, S)} – {format_value(hi, m.unit, S)}",
        }
    key = _metric_text_key(metric_id)
    return {
        "name": S.get(f"{key}.name"),
        "short": S.get(f"{key}.short"),
        "description": S.get(f"{key}.description"),
        "area": area,
        "role": m.role,
        "value": m.value,
        "unit": m.unit,
        "value_text": format_value(m.value, m.unit, S),
        "uncertainty": m.uncertainty,
        "status": m.status,
        "status_text": S.get(f"status.{m.status}"),
        "reference": ref,
        "confidence": m.confidence,
        "confidence_text": S.get(f"confidence.{m.confidence}"),
        "flags": [{"key": f, "text": S.get(f"flags.{f}")} for f in m.flags],
    }


def _result_view(r: FrontalResult | ProfileResult, S: Strings, adjustable: list[str]) -> dict[str, Any]:
    from facescan.core.metrics_frontal import FRONTAL_METRICS
    from facescan.core.metrics_profile import PROFILE_METRICS

    defs = {**FRONTAL_METRICS, **PROFILE_METRICS}
    q = r.quality
    out: dict[str, Any] = {
        "schema_version": r.schema_version,
        "core_version": r.core_version,
        "config_hash": r.config_hash,
        "view": r.view,
        "status": r.status,
        "locale": S.locale,
        "norms_profile": r.subject.norms_profile,
        "quality": None if q is None else {
            "passed": q.passed,
            "considerations_eligible": q.considerations_eligible,
            "checks": [{"id": c.id, "name": S.get(f"check.{c.id}"), "status": c.status, "value": c.value,
                        "limit": c.limit, "hint": S.get(c.hint_key) if c.hint_key else None} for c in q.checks],
        },
        "hints": [S.get(k) for k in (q.hint_keys if q else [])],
        "warnings": [{"key": w, "text": S.get(f"warning.{w}")} for w in (q.warnings if q else [])],
        "disclaimer": S.get("disclaimer.general"),
    }
    if r.status != "ok":
        return out  # least disclosure: no measurements from failed captures in the consumer view
    out.update({
        "side_note": S.get("side_note"),
        "reference_note": S.get("reference.note"),
        "image": r.image.model_dump() if r.image else None,
        "frames": r.frames.model_dump() if r.frames else None,
        "calibration": None if r.calibration is None else {
            "method": r.calibration.method, "available": r.calibration.mm_per_px is not None},
        "adjustable_points": [
            {"id": p, "name": S.get(f"point.{p}.name"), "instruction": S.get(f"point.{p}.instruction")}
            for p in adjustable],
        "landmarks": {
            name: {
                "x": lm.x, "y": lm.y, "available": lm.available, "source": lm.source,
                "confidence": lm.confidence, "adjusted": lm.adjusted,
                "auto": None if lm.auto is None else {"x": lm.auto.x, "y": lm.auto.y},
                "flags": list(lm.flags), "adjustable": name in adjustable,
            } for name, lm in r.landmarks.items()},
        "metrics": {
            mid: _metric_view(mid, m, S, defs[mid].area if mid in defs else None)
            for mid, m in r.metrics.items() if m.display == "user"},
    })
    if isinstance(r, ProfileResult):
        out["facing"] = r.facing
        out["contour"] = [[p.x, p.y] for p in r.contour] if r.contour else None
    return out


def _report_view(rep: Report, S: Strings, adjustable: Mapping[str, list[str]]) -> dict[str, Any]:
    from facescan.core.metrics_frontal import FRONTAL_METRICS
    from facescan.core.metrics_profile import PROFILE_METRICS

    defs = {**FRONTAL_METRICS, **PROFILE_METRICS}
    metrics: dict[str, Any] = {}
    for res in (rep.frontal, rep.profile):
        if res is not None and res.status == "ok":
            metrics.update({mid: m for mid, m in res.metrics.items() if m.display == "user"})

    def measured(mid: str) -> dict[str, Any] | None:
        m = metrics.get(mid)
        if m is None:
            return None
        v = _metric_view(mid, m, S, defs[mid].area if mid in defs else None)
        return {"id": mid, "name": v["name"], "description": v["description"], "value_text": v["value_text"],
                "status": v["status"], "status_text": v["status_text"], "reference": v["reference"]}

    considerations = [
        {
            "rule_id": c.rule_id,
            "area": c.area,
            "area_text": S.get(f"area.{c.area}"),
            "severity": c.severity,
            "severity_text": S.get(f"severity.{c.severity}"),
            "finding": S.get(c.finding_key),
            "considerations": [S.get(k) for k in c.consideration_keys],
            # The triggering measurements in plain language with their reference range.
            "measurements": [x for x in (measured(mid) for mid in c.triggering_metrics) if x is not None],
            "consult": S.get("disclaimer.consult"),
        } for c in rep.considerations]
    return {
        "schema_version": rep.schema_version,
        "core_version": rep.core_version,
        "config_hash": rep.config_hash,
        "status": rep.status,
        "locale": S.locale,
        "frontal": None if rep.frontal is None else _result_view(rep.frontal, S, adjustable.get("frontal", [])),
        "profile": None if rep.profile is None else _result_view(rep.profile, S, adjustable.get("profile", [])),
        "consideration_intro": S.get("consideration_intro"),
        "considerations": considerations,
        "no_considerations_note": None if considerations else S.get("consideration_none"),
        "rules_version": rep.rules_version,
        "disclaimer": S.get(rep.disclaimer_key),
    }


def user_view(obj: FrontalResult | ProfileResult | Report, *, locale: str = "th",
              config_dir: str | Path | None = None,
              locales: Mapping[str, Mapping[str, Any]] | None = None,
              user_adjustable_points: Mapping[str, list[str]] | None = None) -> dict[str, Any]:
    """JSON view for the consumer app (clinic-only metrics removed, text resolved).

    ``config_dir`` selects the config files (default: the package's); the engine
    passes its already-loaded ``locales`` and ``user_adjustable_points`` instead.
    """
    config_dir = Path(config_dir or DEFAULT_CONFIG_DIR)
    if locales is None:
        locales = load_locales(config_dir)
    if user_adjustable_points is None:
        user_adjustable_points = read_yaml(config_dir / "capture.yaml")["overrides"]["user_adjustable_points"]
    S = Strings(locales, locale)
    if isinstance(obj, Report):
        return _report_view(obj, S, user_adjustable_points)
    if isinstance(obj, (FrontalResult, ProfileResult)):
        return _result_view(obj, S, list(user_adjustable_points.get(obj.view, [])))
    raise TypeError(f"user_view expects a FrontalResult, ProfileResult or Report, got {type(obj).__name__}")


def all_user_strings(locale_data: Mapping[str, Any], *, skip: tuple[str, ...] = ("locale", "language_name")) -> list[tuple[str, str]]:
    """Every (key, string) in a locale file, for wording review and tests."""
    out: list[tuple[str, str]] = []

    def walk(node: Any, prefix: str) -> None:
        if isinstance(node, Mapping):
            for k, v in node.items():
                if prefix == "" and k in skip:
                    continue
                walk(v, f"{prefix}.{k}" if prefix else str(k))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{prefix}[{i}]")
        elif isinstance(node, str):
            out.append((prefix, node))

    walk(locale_data, "")
    return out


__all__ = ["Strings", "load_strings", "format_value", "user_view", "all_user_strings", "LOCALES"]
