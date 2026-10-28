"""Phase 3: recommendation engine, consumer safety and reports."""

from __future__ import annotations

import json
import math

import pytest
from pydantic import ValidationError

from facescan import FrontalResult, InvalidInputError, ProfileResult, Report, SubjectInfo, user_view
from facescan._version import __version__
from facescan.core.config import DEFAULT_CONFIG_DIR, load_locales
from facescan.core.recommend import ReportBuilder, RulesFile, RulesValidationError, load_rules, validate_rules
from facescan.core.schema import Metric, Quality
from helpers import MODELS, models_available, synthetic_result, synthetic_settings

EXAMPLE = DEFAULT_CONFIG_DIR / "rules.example.yaml"
LOCALES = load_locales(DEFAULT_CONFIG_DIR)


def rule(id="R1", conditions=None, exclusions=(), keys=("consideration.example_alar_base",), area="nose",
         severity="info", finding="finding.example_alar_width_above"):
    return {"id": id, "version": 1, "approved_by": "Dr Test", "severity": severity, "area": area,
            "conditions": conditions or {"all": [{"metric": "F6_alar_icd_ratio", "op": "status_is", "value": "above"}]},
            "exclusions": list(exclusions), "finding_key": finding, "consideration_keys": list(keys)}


def rules(*items) -> RulesFile:
    rf = RulesFile.model_validate({"rules_version": "T1", "rules": list(items)})
    validate_rules(rf, LOCALES)
    return rf


def builder(rf: RulesFile | None) -> ReportBuilder:
    return ReportBuilder(synthetic_settings(), rf)


def with_metric(result, mid, **changes):
    m = result.metrics[mid]
    metrics = dict(result.metrics)
    metrics[mid] = Metric(**{**dict(m), **changes})
    return type(result)(**{**dict(result), "metrics": metrics})


def frontal(age=28, **f6):
    fr, _ = synthetic_result()
    fr = FrontalResult(**{**dict(fr), "subject": SubjectInfo(sex="female", age=age)})
    changes = {"status": "above", "value": 1.2, "uncertainty": 0.01, "deviation_abs": 0.15}
    changes.update(f6)
    return with_metric(fr, "F6_alar_icd_ratio", **changes)


def profile(fr: FrontalResult, metrics: dict[str, dict], eligible=True, status="ok") -> ProfileResult:
    ms = {mid: Metric(**{"value": 1.0, "unit": "mm", "uncertainty": 0.1, "status": "within", "confidence": "high",
                         **kw}) for mid, kw in metrics.items()}
    q = Quality(passed=status == "ok", considerations_eligible=eligible)
    return ProfileResult(core_version=__version__, config_hash="sha256:test", status=status, subject=fr.subject,
                         facing="right", quality=q, metrics=ms)


# ------------------------------------------------------------------- loading


def test_example_rules_load_and_validate():
    rf = load_rules(EXAMPLE)
    validate_rules(rf, LOCALES)
    assert rf.example_not_clinically_validated
    assert rf.rules_version == "EXAMPLE" and len(rf.rules) == 3
    assert len(rf.rules[1].consideration_keys) > 1  # one finding, several possible causes


def test_real_rules_need_approval(tmp_path):
    p = tmp_path / "rules.yaml"
    p.write_text(EXAMPLE.read_text(encoding="utf-8").replace(
        "example_not_clinically_validated: true", "example_not_clinically_validated: false"), encoding="utf-8")
    with pytest.raises(ValueError, match="approved_by"):
        load_rules(p)


@pytest.mark.parametrize("bad, match", [
    (rule(conditions={"all": [{"metric": "F99_nope", "op": "status_is", "value": "above"}]}), "unknown metric"),
    (rule(conditions={"all": [{"metric": "F10_golden_ratio", "op": "status_is", "value": "above"}]}), "clinic-only"),
    (rule(conditions={"all": [{"metric": "F7_mouth_alar_ratio", "op": "gt", "value": 1.6}]}), "secondary"),
    (rule(keys=("consideration.not_written",)), "missing in locale"),
    (rule(area="elbow"), "area.elbow"),
])
def test_rules_referencing_unknown_or_forbidden_things_fail_to_load(bad, match):
    with pytest.raises(RulesValidationError, match=match):
        rules(bad)


@pytest.mark.parametrize("bad", [
    rule(conditions={"all": [{"metric": "F6_alar_icd_ratio", "op": "status_is", "value": "inconclusive"}]}),
    rule(conditions={"all": [{"metric": "F6_alar_icd_ratio", "op": "gt", "value": "high"}]}),
    rule(conditions={"all": [{"metric": "F6_alar_icd_ratio", "op": "gt", "value": 1}],
                     "any": [{"metric": "F6_alar_icd_ratio", "op": "gt", "value": 1}]}),
    {**rule(), "min_confidence": "low"},
    {**rule(), "min_quality": "any"},
    rule(keys=()),
])
def test_malformed_rules_fail_validation(bad):
    with pytest.raises(ValidationError):
        RulesFile.model_validate({"rules_version": "T", "rules": [bad]})
    with pytest.raises(ValidationError):
        RulesFile.model_validate({"rules_version": "T", "rules": [rule(), rule()]})  # duplicate ids


# ------------------------------------------------------------------- evaluation


def test_rule_fires_on_an_eligible_metric():
    rep = builder(rules(rule())).build(frontal(), None, core_version=__version__)
    assert [c.rule_id for c in rep.considerations] == ["R1"]
    c = rep.considerations[0]
    assert c.triggering_metrics == ["F6_alar_icd_ratio"] and c.rule_version == 1 and c.severity == "info"
    assert rep.rule_audit[0].outcome == "fired" and rep.rules_version == "T1"


@pytest.mark.parametrize("changes, reason", [
    ({"status": "inconclusive"}, "inconclusive"),
    ({"status": "unavailable", "value": None}, "unavailable"),
    ({"confidence": "low"}, "low_confidence"),
    ({"flags": ["large_user_adjustment"]}, "large_user_adjustment"),
    ({"uncertainty": None}, "uncertainty_unavailable"),
])
def test_ineligible_metrics_never_trigger(changes, reason):
    rep = builder(rules(rule())).build(frontal(**changes), None, core_version=__version__)
    assert rep.considerations == []
    assert rep.rule_audit[0].outcome == "not_met" and rep.rule_audit[0].ineligible == {"F6_alar_icd_ratio": reason}


def test_ineligible_captures_never_trigger():
    fr = frontal()
    failed = FrontalResult(**{**dict(fr), "status": "quality_failed",
                              "quality": Quality(passed=False, considerations_eligible=False)})
    unverified = FrontalResult(**{**dict(fr), "quality": Quality(passed=True, considerations_eligible=False)})
    for res in (failed, unverified):
        rep = builder(rules(rule())).build(res, None, core_version=__version__)
        assert rep.considerations == [] and rep.rule_audit[0].ineligible == {"F6_alar_icd_ratio": "capture_not_eligible"}


def test_example_rules_any_semantics_and_several_causes():
    rf = load_rules(EXAMPLE)
    fr = frontal(status="within", value=1.0, deviation_abs=0.0)
    pr = profile(fr, {"P4_eline_lower_lip_mm": {"value": 1.5, "status": "above"},
                      "P4_eline_upper_lip_mm": {"value": -3.0, "status": "within"},
                      "P2_nasolabial_angle": {"value": 100.0, "unit": "deg", "status": "within"}})
    rep = builder(rf).build(fr, pr, core_version=__version__)
    assert [c.rule_id for c in rep.considerations] == ["EXAMPLE-02"]
    c = rep.considerations[0]
    assert c.triggering_metrics == ["P4_eline_lower_lip_mm"] and len(c.consideration_keys) == 3
    # The profile capture is not eligible (e.g. no verified distance) → nothing from the profile.
    rep = builder(rf).build(fr, profile(fr, {"P4_eline_lower_lip_mm": {"value": 1.5, "status": "above"}},
                                        eligible=False), core_version=__version__)
    assert rep.considerations == []


def test_all_needs_every_condition():
    two = rule(conditions={"all": [{"metric": "F6_alar_icd_ratio", "op": "status_is", "value": "above"},
                                   {"metric": "F4_eye_icd_ratio_right", "op": "status_is", "value": "below"}]})
    fr = frontal()                                  # F4 right is within on the synthetic face
    assert builder(rules(two)).build(fr, None, core_version=__version__).considerations == []
    fr = with_metric(fr, "F4_eye_icd_ratio_right", status="below", value=0.8)
    rep = builder(rules(two)).build(fr, None, core_version=__version__)
    assert rep.considerations[0].triggering_metrics == ["F6_alar_icd_ratio", "F4_eye_icd_ratio_right"]


@pytest.mark.parametrize("value, unc, fires", [(1.20, 0.01, True), (1.11, 0.01, False), (1.20, 0.06, False)])
def test_numeric_thresholds_keep_the_uncertainty_margin(value, unc, fires):
    r = rule(conditions={"all": [{"metric": "F6_alar_icd_ratio", "op": "gt", "value": 1.1}]})
    rep = builder(rules(r)).build(frontal(value=value, uncertainty=unc), None, core_version=__version__)
    assert bool(rep.considerations) is fires       # needs value − 2·u > 1.1


def test_exclusions_suppress_and_fail_closed():
    ex = [{"metric": "F4_eye_icd_ratio_right", "op": "status_is", "value": "below"}]
    r = rules(rule(exclusions=ex))
    fr = with_metric(frontal(), "F4_eye_icd_ratio_right", status="within", value=1.0, deviation_abs=0.0)
    assert builder(r).build(fr, None, core_version=__version__).considerations   # exclusion clearly not met
    matched = with_metric(fr, "F4_eye_icd_ratio_right", status="below", value=0.8)
    rep = builder(r).build(matched, None, core_version=__version__)
    assert rep.considerations == [] and rep.rule_audit[0].outcome == "excluded"
    unknown = with_metric(fr, "F4_eye_icd_ratio_right", status="inconclusive")
    rep = builder(r).build(unknown, None, core_version=__version__)  # cannot be ruled out → suppressed
    assert rep.considerations == [] and rep.rule_audit[0].ineligible == {"F4_eye_icd_ratio_right": "inconclusive"}


def test_no_rules_configured_gives_no_considerations():
    rep = builder(None).build(frontal(), None, core_version=__version__)
    assert rep.considerations == [] and rep.rules_version is None and rep.rule_audit == []


# ------------------------------------------------------------------- building


def test_build_report_input_validation():
    b = builder(rules(rule()))
    fr = frontal()
    with pytest.raises(InvalidInputError):
        b.build(None, None, core_version=__version__)
    with pytest.raises(InvalidInputError, match="subject_mismatch"):
        b.build(fr, profile(frontal(age=40), {}), core_version=__version__)
    with pytest.raises(InvalidInputError, match="stale_result"):
        b.build(FrontalResult(**{**dict(fr), "config_hash": "sha256:other"}), None, core_version=__version__)
    with pytest.raises(InvalidInputError, match="stale_result"):
        b.build(fr, None, core_version="9.9.9")
    with pytest.raises(InvalidInputError):
        b.build(profile(fr, {}), None, core_version=__version__)


def test_report_status_traceability_and_round_trip():
    fr = frontal()
    pr = profile(fr, {}, status="contour_failed", eligible=False)
    rep = builder(rules(rule())).build(fr, pr, core_version=__version__)
    assert rep.status == "contour_failed" and [c.rule_id for c in rep.considerations] == ["R1"]
    assert rep.config_hash == "sha256:test" and rep.disclaimer_key == "disclaimer.general"
    assert Report.model_validate_json(rep.model_dump_json()) == rep
    vec, ids = rep.to_vector()
    assert vec[ids.index("F6_alar_icd_ratio")] == pytest.approx(1.2) and math.isnan(vec[ids.index("P1_nasofrontal_angle")])


@pytest.mark.parametrize("locale", ["th", "en"])
def test_report_user_view(locale):
    rep = builder(rules(rule(severity="discuss"))).build(frontal(), None, core_version=__version__)
    v = user_view(rep, locale=locale)
    assert "rule_audit" not in v and "F10_golden_ratio" not in json.dumps(v)
    c = v["considerations"][0]
    assert c["finding"] == LOCALES[locale]["finding"]["example_alar_width_above"]
    assert c["area_text"] == LOCALES[locale]["area"]["nose"] and c["severity_text"] == LOCALES[locale]["severity"]["discuss"]
    m = c["measurements"][0]                        # triggering measurement, plain language + reference range
    assert m["id"] == "F6_alar_icd_ratio" and m["value_text"] and m["status_text"] == LOCALES[locale]["status"]["above"]
    assert m["reference"]["label"] == LOCALES[locale]["reference"]["canon"] and "–" in m["reference"]["text"]
    assert c["consult"] == LOCALES[locale]["disclaimer"]["consult"]
    assert v["disclaimer"] == LOCALES[locale]["disclaimer"]["general"] and v["no_considerations_note"] is None
    none = user_view(builder(rules(rule())).build(frontal(status="within", value=1.0), None,
                                                  core_version=__version__), locale=locale)
    assert none["considerations"] == [] and none["no_considerations_note"] == LOCALES[locale]["consideration_none"]


# ------------------------------------------------------------------- engine level


@pytest.mark.skipif(not models_available(), reason="models missing")
def test_engine_reports_with_example_rules(engine, astronaut, subject):
    from facescan import EngineConfig, FaceScanEngine

    with FaceScanEngine(EngineConfig.from_models_dir(MODELS, rules_path=EXAMPLE)) as eng:
        assert eng.config_hash == engine.config_hash       # rules do not change results → portable results
        result = engine.analyze_frontal(astronaut, subject=subject)   # analyzed without rules
        rep = eng.build_report(result, None)
        assert rep.status == "quality_failed" and rep.considerations == []   # capture not eligible
        assert rep.rules_version == "EXAMPLE" and rep.rules_hash.startswith("sha256:")
        assert {a.outcome for a in rep.rule_audit} == {"not_met"}
        assert engine.rules_info is None
        assert eng.rules_info == {"rules_version": "EXAMPLE", "rules_hash": rep.rules_hash, "example": True}
        assert json.dumps(eng.user_view(rep, locale="th"), ensure_ascii=False)


@pytest.mark.skipif(not models_available(), reason="models missing")
def test_consideration_fires_end_to_end_with_real_models(tmp_path, astronaut):
    """Real engine, test-only relaxed gates (so the photo is eligible) and an approved custom rule."""
    import shutil

    import yaml

    from facescan import CameraInfo, EngineConfig, FaceScanEngine, LoadedImage

    cfg = tmp_path / "config"
    shutil.copytree(DEFAULT_CONFIG_DIR, cfg)
    cap = yaml.safe_load((cfg / "capture.yaml").read_text(encoding="utf-8"))
    g = cap["frontal"]["gates"]
    g.update(ipd_min_px=20.0, pitch_max_deg=30.0, yaw_max_deg=30.0, camera_distance_min_m=0.1)
    g["expression"] = {k: 1.01 for k in g["expression"]}
    (cfg / "capture.yaml").write_text(yaml.safe_dump(cap, allow_unicode=True), encoding="utf-8")
    rules_path = tmp_path / "rules.yaml"
    rules_path.write_text(yaml.safe_dump({"rules_version": "TEST-1", "rules": [
        rule(id="T-01", conditions={"all": [{"metric": "F1_middle_lower_ratio", "op": "gt", "value": 0.1}]})]}),
        encoding="utf-8")
    with FaceScanEngine(EngineConfig.from_models_dir(MODELS, config_dir=cfg, rules_path=rules_path)) as eng:
        img = LoadedImage.from_array(astronaut.pixels, camera=CameraInfo(focal_px=600.0, source="configured_fov"))
        result = eng.analyze_frontal(img, subject=SubjectInfo(sex="female", age=30))
        assert result.status == "ok"
        rep = eng.build_report(result, None)
        assert [c.rule_id for c in rep.considerations] == ["T-01"] and rep.rules_version == "TEST-1"
        v = eng.user_view(rep, locale="th")
        assert v["considerations"][0]["measurements"][0]["id"] == "F1_middle_lower_ratio"


@pytest.mark.skipif(not models_available(), reason="models missing")
def test_report_cli(tmp_path, engine, astronaut, subject):
    from facescan.apps.build_report import main

    res = tmp_path / "result.json"
    res.write_text(engine.analyze_frontal(astronaut, subject=subject).model_dump_json(), encoding="utf-8")
    out = tmp_path / "rep"
    assert main(["--frontal-result", str(res), "--rules", str(EXAMPLE),
                 "--models-dir", str(MODELS), "--locale", "en", "--out-dir", str(out)]) == 0
    assert json.loads((out / "report.json").read_text())["rules_version"] == "EXAMPLE"
    assert (out / "report_view_en.json").exists()


def _spec_eligible(res, m) -> bool:
    """The eligibility rules, restated independently of the implementation."""
    return (res.status == "ok" and res.quality.considerations_eligible and m.display == "user" and m.role == "primary"
            and m.status in ("within", "above", "below") and m.confidence == "high"
            and "large_user_adjustment" not in m.flags and m.value is not None and m.uncertainty is not None)


def _spec_holds(c, m, k=2.0) -> bool:
    if c["op"] == "status_is":
        return m.status == c["value"]
    v, u, t = m.value, k * m.uncertainty, c["value"]
    return {"lt": v + u < t, "le": v + u <= t, "gt": v - u > t, "ge": v - u >= t}[c["op"]]


def test_safety_invariants_hold_for_random_sessions_and_rules():
    import random

    rnd = random.Random(20260927)
    ids = ["F6_alar_icd_ratio", "F4_eye_icd_ratio_right", "F5_canthal_tilt_right", "F11_asym_eye_width"]
    base, _ = synthetic_result()
    for _ in range(400):
        fr = FrontalResult(**{**dict(base), "status": rnd.choice(["ok", "ok", "ok", "quality_failed"]),
                              "quality": Quality(passed=True, considerations_eligible=rnd.random() < 0.85)})
        for mid in ids:
            st = rnd.choice(["within", "above", "below", "inconclusive", "unavailable"]) \
                if mid != "F11_asym_eye_width" else rnd.choice(["no_reference", "unavailable"])
            fr = with_metric(fr, mid, status=st, value=None if st == "unavailable" else rnd.uniform(-2, 12),
                             uncertainty=rnd.choice([None, 0.05, 0.5, 2.0]),
                             confidence=rnd.choice(["high", "high", "low"]),
                             flags=rnd.choice([[], [], ["large_user_adjustment"]]))
        rule_specs = []
        for i in range(rnd.randint(1, 3)):
            conds = []
            for _ in range(rnd.randint(1, 3)):
                mid = rnd.choice(ids)
                if mid != "F11_asym_eye_width" and rnd.random() < 0.5:
                    conds.append({"metric": mid, "op": "status_is", "value": rnd.choice(["within", "above", "below"])})
                else:
                    conds.append({"metric": mid, "op": rnd.choice(["lt", "le", "gt", "ge"]), "value": rnd.uniform(-2, 12)})
            mode = rnd.choice(["all", "any"])
            ex = [{"metric": rnd.choice(ids), "op": "gt", "value": rnd.uniform(-2, 12)}] if rnd.random() < 0.3 else []
            rule_specs.append(rule(id=f"R{i}", conditions={mode: conds}, exclusions=ex))
        rep = builder(rules(*rule_specs)).build(fr, None, core_version=__version__)

        fired = {c.rule_id for c in rep.considerations}
        assert fired == {a.rule_id for a in rep.rule_audit if a.outcome == "fired"}
        for spec in rule_specs:
            mode, conds = next(iter(spec["conditions"].items()))
            ok = [(_spec_eligible(fr, fr.metrics[c["metric"]]) and _spec_holds(c, fr.metrics[c["metric"]]))
                  for c in conds]
            met = all(ok) if mode == "all" else any(ok)
            blocked = any(not _spec_eligible_excl(fr, fr.metrics[e["metric"]]) or _spec_holds(e, fr.metrics[e["metric"]])
                          for e in spec["exclusions"])
            assert (spec["id"] in fired) == (met and not blocked), spec
        for c in rep.considerations:
            for mid in c.triggering_metrics:
                assert _spec_eligible(fr, fr.metrics[mid]), (c.rule_id, mid)


def _spec_eligible_excl(res, m) -> bool:
    return (res.status == "ok" and res.quality.considerations_eligible
            and m.status in ("within", "above", "below") and m.confidence == "high"
            and "large_user_adjustment" not in m.flags and m.value is not None and m.uncertainty is not None)


def test_metrics_without_a_reference_range_cannot_trigger():
    """A consideration must show the reference range; no_reference metrics have none."""
    r = rule(conditions={"all": [{"metric": "F11_asym_eye_width", "op": "gt", "value": 0.01}]})
    fr = with_metric(frontal(), "F11_asym_eye_width", status="no_reference", value=0.2, uncertainty=0.01)
    rep = builder(rules(r)).build(fr, None, core_version=__version__)
    assert rep.considerations == [] and rep.rule_audit[0].ineligible == {"F11_asym_eye_width": "no_reference"}


def test_profile_only_report():
    fr = frontal()
    pr = profile(fr, {"P2_nasolabial_angle": {"value": 88.0, "unit": "deg", "uncertainty": 1.0, "status": "below"}})
    rep = builder(load_rules(EXAMPLE)).build(None, pr, core_version=__version__)
    assert rep.frontal is None and [c.rule_id for c in rep.considerations] == ["EXAMPLE-01"]
    v = user_view(rep, locale="th")
    assert v["frontal"] is None and v["considerations"][0]["measurements"][0]["id"] == "P2_nasolabial_angle"
