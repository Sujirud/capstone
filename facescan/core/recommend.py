"""Phase 3: rules engine for user-facing considerations.

Rules come only from a YAML file authored and signed off by the clinical team; the core
never hard-codes a metric → procedure mapping. One finding may list several possible
causes, so a rule emits one ``Consideration`` with all of its ``consideration_keys``.

Consumer safety, enforced here whatever a rules file says:

* **Eligible captures only** — a metric can satisfy a condition only if its result has
  status ``ok`` and ``quality.considerations_eligible`` (every gate passed, distance
  verified).
* **Eligible metrics only** — status within / above / below (a reference range exists,
  which every consideration must show), confidence ``high``, a known uncertainty, no
  ``large_user_adjustment`` flag, ``display: user`` and ``role: primary``. Inconclusive,
  unavailable and ``no_reference`` metrics never trigger.
* **Numeric thresholds keep the ``inconclusive`` margin** — ``lt`` / ``gt`` hold only when the value is
  beyond the threshold by more than ``inconclusive_k`` × uncertainty.
* **Exclusions fail closed** — an exclusion that cannot be evaluated (its metric is not
  eligible) suppresses the rule.

Rule files are validated when loaded: metric ids exist, conditions do not use
clinic-only or secondary metrics, every text key exists in every locale, and every rule of
a file that is not marked ``example_not_clinically_validated`` names ``approved_by``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, Mapping

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

from facescan.core.config import Settings
from facescan.core.errors import InvalidInputError
from facescan.core.metrics_frontal import FRONTAL_METRICS, MetricDef
from facescan.core.metrics_profile import PROFILE_METRICS
from facescan.core.schema import (SCHEMA_VERSION, Consideration, FrontalResult, Metric, ProfileResult, Report,
                                  RuleOutcome)

CONCLUSIVE = ("within", "above", "below")
LARGE_USER_ADJUSTMENT = "large_user_adjustment"
ALL_METRICS: dict[str, MetricDef] = {**FRONTAL_METRICS, **PROFILE_METRICS}


class RulesValidationError(ValueError):
    """A rules file is malformed or refers to unknown metrics / text keys."""


class _Rule(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Condition(_Rule):
    metric: str
    op: Literal["status_is", "lt", "le", "gt", "ge"]
    value: float | str

    @model_validator(mode="after")
    def _check(self) -> "Condition":
        if self.op == "status_is":
            if self.value not in CONCLUSIVE:
                raise ValueError(f"status_is needs one of {CONCLUSIVE}, got {self.value!r}")
        elif isinstance(self.value, str):
            raise ValueError(f"{self.op} needs a numeric value, got {self.value!r}")
        return self


class ConditionGroup(_Rule):
    all: list[Condition] | None = None
    any: list[Condition] | None = None

    @model_validator(mode="after")
    def _one(self) -> "ConditionGroup":
        if bool(self.all) == bool(self.any):
            raise ValueError("conditions need exactly one non-empty 'all' or 'any' list")
        return self

    @property
    def mode(self) -> str:
        return "all" if self.all else "any"

    @property
    def items(self) -> list[Condition]:
        return list(self.all or self.any or [])


class Rule(_Rule):
    id: str
    version: int
    approved_by: str | None
    conditions: ConditionGroup
    exclusions: list[Condition] = Field(default_factory=list)
    min_quality: Literal["passed"] = "passed"          # nothing weaker is allowed
    min_confidence: Literal["high"] = "high"           # low confidence never triggers
    severity: Literal["info", "discuss"]
    area: str
    finding_key: str
    consideration_keys: list[str] = Field(min_length=1)
    references: list[str] = Field(default_factory=list)


class RulesFile(_Rule):
    example_not_clinically_validated: bool = False
    rules_version: str
    rules: list[Rule]

    @model_validator(mode="after")
    def _unique(self) -> "RulesFile":
        ids = [r.id for r in self.rules]
        if len(ids) != len(set(ids)):
            raise ValueError("rule ids must be unique")
        return self


def load_rules(path: str | Path) -> RulesFile:
    """Parse and validate a rules file's structure (see ``validate_rules`` for references).

    Refuses rules without ``approved_by`` in files that are not marked
    ``example_not_clinically_validated: true``.
    """
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    rules = RulesFile.model_validate(data)
    if not rules.example_not_clinically_validated:
        unapproved = [r.id for r in rules.rules if not r.approved_by]
        if unapproved:
            raise ValueError(f"rules without approved_by: {unapproved}")
    return rules


def _has_key(locale: Mapping[str, Any], key: str) -> bool:
    node: Any = locale
    for part in key.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return False
        node = node[part]
    return isinstance(node, str) and bool(node.strip())


def validate_rules(rules: RulesFile, locales: Mapping[str, Mapping[str, Any]]) -> None:
    """Every metric exists and may be used; every text key exists in every locale (fail closed)."""
    problems: list[str] = []
    for r in rules.rules:
        for c in r.conditions.items:
            d = ALL_METRICS.get(c.metric)
            if d is None:
                problems.append(f"{r.id}: unknown metric {c.metric!r}")
            elif d.display != "user":
                problems.append(f"{r.id}: {c.metric} is clinic-only and can never trigger considerations")
            elif d.role != "primary":
                problems.append(f"{r.id}: {c.metric} is secondary (information only) and cannot trigger")
        for c in r.exclusions:
            if c.metric not in ALL_METRICS:
                problems.append(f"{r.id}: unknown exclusion metric {c.metric!r}")
        keys = [r.finding_key, *r.consideration_keys, f"area.{r.area}", f"severity.{r.severity}"]
        for code, data in locales.items():
            problems += [f"{r.id}: text key {k!r} missing in locale {code!r}" for k in keys if not _has_key(data, k)]
    if problems:
        raise RulesValidationError("invalid rules file:\n  " + "\n  ".join(problems))


class Recommender:
    """Evaluates a validated rules file against a frontal and / or profile result."""

    def __init__(self, rules: RulesFile | None, *, inconclusive_k: float) -> None:
        self.rules = rules
        self.k = inconclusive_k

    @property
    def rules_version(self) -> str | None:
        return self.rules.rules_version if self.rules is not None else None

    # -- eligibility
    @staticmethod
    def _result_for(metric_id: str, frontal: FrontalResult | None,
                    profile: ProfileResult | None) -> FrontalResult | ProfileResult | None:
        return frontal if metric_id in FRONTAL_METRICS else profile if metric_id in PROFILE_METRICS else None

    def _eligible(self, metric_id: str, frontal, profile, *, for_exclusion: bool) -> tuple[Metric | None, str | None]:
        res = self._result_for(metric_id, frontal, profile)
        if res is None:
            return None, "view_missing"
        if res.status != "ok" or res.quality is None or not res.quality.considerations_eligible:
            return None, "capture_not_eligible"
        m = res.metrics.get(metric_id)
        if m is None:
            return None, "metric_missing"
        if not for_exclusion and (m.display != "user" or m.role != "primary"):
            return None, "not_user_primary"
        if m.status not in CONCLUSIVE:
            return None, m.status   # inconclusive / unavailable / no_reference (no range to show)
        if m.confidence != "high":
            return None, "low_confidence"
        if LARGE_USER_ADJUSTMENT in m.flags:
            return None, LARGE_USER_ADJUSTMENT
        if m.value is None or m.uncertainty is None:
            return None, "uncertainty_unavailable"
        return m, None

    def _holds(self, c: Condition, m: Metric) -> bool:
        if c.op == "status_is":
            return m.status == c.value                   # above / below already include the inconclusive margin
        v, margin, t = m.value, self.k * m.uncertainty, float(c.value)
        return {"lt": v + margin < t, "le": v + margin <= t, "gt": v - margin > t, "ge": v - margin >= t}[c.op]

    # -- evaluation
    def evaluate(self, frontal: FrontalResult | None,
                 profile: ProfileResult | None) -> tuple[list[Consideration], list[RuleOutcome]]:
        """(considerations, audit trail)."""
        if self.rules is None:
            return [], []
        considerations: list[Consideration] = []
        audit: list[RuleOutcome] = []
        for r in self.rules.rules:
            results, ineligible = [], {}
            for c in r.conditions.items:
                m, why = self._eligible(c.metric, frontal, profile, for_exclusion=False)
                if m is None:
                    ineligible[c.metric] = why
                    results.append(False)
                else:
                    results.append(self._holds(c, m))
            met = all(results) if r.conditions.mode == "all" else any(results)
            if not met:
                audit.append(RuleOutcome(rule_id=r.id, rule_version=r.version, outcome="not_met", ineligible=ineligible))
                continue
            excluded = {}
            for e in r.exclusions:
                m, why = self._eligible(e.metric, frontal, profile, for_exclusion=True)
                if m is None or self._holds(e, m):       # cannot rule it out → suppress (fail closed)
                    excluded[e.metric] = why or "matched"
            if excluded:
                audit.append(RuleOutcome(rule_id=r.id, rule_version=r.version, outcome="excluded", ineligible=excluded))
                continue
            triggering = list(dict.fromkeys(c.metric for c, ok in zip(r.conditions.items, results) if ok))
            considerations.append(Consideration(
                rule_id=r.id, rule_version=r.version, area=r.area, finding_key=r.finding_key,
                consideration_keys=list(r.consideration_keys), triggering_metrics=triggering, severity=r.severity))
            audit.append(RuleOutcome(rule_id=r.id, rule_version=r.version, outcome="fired"))
        return considerations, audit


class ReportBuilder:
    """Model-free report assembly (used by ``FaceScanEngine.build_report`` and the API)."""

    def __init__(self, settings: Settings, rules: RulesFile | None) -> None:
        self.settings = settings
        self.recommender = Recommender(rules, inconclusive_k=settings.capture.reference.inconclusive_k)

    def build(self, frontal: FrontalResult | None, profile: ProfileResult | None, *, core_version: str) -> Report:
        if frontal is None and profile is None:
            raise InvalidInputError("a report needs a frontal and / or a profile result")
        if frontal is not None and not isinstance(frontal, FrontalResult):
            raise InvalidInputError("frontal must be a FrontalResult")
        if profile is not None and not isinstance(profile, ProfileResult):
            raise InvalidInputError("profile must be a ProfileResult")
        results = [r for r in (frontal, profile) if r is not None]
        for r in results:
            if (r.schema_version, r.core_version, r.config_hash) != \
                    (SCHEMA_VERSION, core_version, self.settings.config_hash):
                raise InvalidInputError(
                    f"stale_result: the {r.view} result was produced by schema {r.schema_version}, core "
                    f"{r.core_version}, config {r.config_hash}; analyze again with this engine")
        if frontal is not None and profile is not None and frontal.subject != profile.subject:
            raise InvalidInputError("subject_mismatch: frontal and profile results belong to different subjects")
        considerations, audit = self.recommender.evaluate(frontal, profile)
        status = next((r.status for r in results if r.status != "ok"), "ok")
        return Report(core_version=core_version, config_hash=self.settings.config_hash, status=status,
                      frontal=frontal, profile=profile, considerations=considerations,
                      rules_version=self.recommender.rules_version, rules_hash=self.settings.rules_hash,
                      rule_audit=audit, disclaimer_key="disclaimer.general")
