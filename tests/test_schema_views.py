import math

import numpy as np
import pytest
from pydantic import ValidationError

from facescan import user_view
from facescan.core.config import DEFAULT_CONFIG_DIR, load_locales
from facescan.core.locale import all_user_strings
from facescan.core.metrics_frontal import FRONTAL_METRICS
from facescan.core.schema import (Consideration, Metric, Point2D, ProfileResult, Report, SubjectInfo)
from helpers import synthetic_result

BANNED = {
    "en": ["defect", "flaw", "abnormal", "ugly", "deformity", "deformed", "unattractive", "attractiveness",
           "you need", "you must", "fix your", "beauty score"],
    "th": ["ผิดปกติ", "ข้อบกพร่อง", "บกพร่อง", "น่าเกลียด", "ไม่สวย", "ผิดรูป", "พิการ", "คุณต้อง"],
}


def test_frontal_result_json_round_trip():
    r, _ = synthetic_result()
    assert type(r).model_validate_json(r.model_dump_json()) == r


def test_profile_and_report_round_trip_and_vector():
    r, _ = synthetic_result()
    prof = ProfileResult(core_version="0.1.0", config_hash="sha256:test", status="contour_failed",
                         subject=r.subject, facing="left", contour=[Point2D(x=1.5, y=2.25)])
    assert ProfileResult.model_validate_json(prof.model_dump_json()) == prof
    rep = Report(core_version="0.1.0", config_hash="sha256:test", status="ok", frontal=r, profile=prof,
                 considerations=[Consideration(rule_id="EXAMPLE-01", area="nose", finding_key="finding.x",
                                               consideration_keys=["consideration.y"],
                                               triggering_metrics=["F6_alar_icd_ratio"], severity="info")],
                 rules_version="EXAMPLE")
    assert Report.model_validate_json(rep.model_dump_json()) == rep
    vec, ids = rep.to_vector()
    assert len(vec) == len(ids) and ids[0] == "F1_upper_third"
    assert vec[ids.index("F10_golden_ratio")] == pytest.approx(r.metrics["F10_golden_ratio"].value)
    assert math.isnan(vec[ids.index("P2_nasolabial_angle")])
    assert vec.dtype == np.float64


def test_nan_is_rejected():
    with pytest.raises(ValidationError):
        Metric(value=float("nan"), unit="ratio", status="within", confidence="high")
    with pytest.raises(ValidationError):
        SubjectInfo(sex="female", age=0)
    with pytest.raises(ValidationError):
        SubjectInfo(sex="other", age=30)


@pytest.mark.parametrize("locale", ["th", "en"])
def test_user_view_drops_clinic_only_and_resolves_text(locale):
    r, _ = synthetic_result()
    v = user_view(r, locale=locale)
    assert "F10_golden_ratio" not in v["metrics"]
    assert set(v["metrics"]) == {m for m, d in FRONTAL_METRICS.items() if d.display == "user"}
    for mid, m in v["metrics"].items():
        assert m["name"] and not m["name"].startswith("metric."), mid
        assert m["status_text"] and not m["status_text"].startswith("status."), mid
    assert v["disclaimer"] and not v["disclaimer"].startswith("disclaimer.")
    assert v["adjustable_points"][0]["id"] == "trichion" and v["landmarks"]["trichion"]["adjustable"]
    ref = v["metrics"]["F5_canthal_tilt_right"]["reference"]
    assert ref["basis"] == "canon" and (ref["min"], ref["max"]) == (2.0, 8.0)
    assert "golden" not in str(v).lower() and "ทองคำ" not in str(v)


def test_user_view_of_failed_capture_has_hints_but_no_measurements():
    r, _ = synthetic_result(status="quality_failed")
    v = user_view(r, locale="en")
    assert v["status"] == "quality_failed" and "metrics" not in v and "landmarks" not in v
    assert v["hints"] and not v["hints"][0].startswith("hint.")


def test_locales_have_the_same_keys_and_cover_user_metrics():
    loc = load_locales(DEFAULT_CONFIG_DIR)
    keys = {c: {k for k, _ in all_user_strings(d)} for c, d in loc.items()}
    assert keys["th"] == keys["en"]
    from facescan.core.metrics_profile import PROFILE_METRICS

    for code, data in loc.items():
        for mid, d in {**FRONTAL_METRICS, **PROFILE_METRICS}.items():
            if d.display == "user":
                assert data["metric"][mid]["name"], (code, mid)
            else:
                assert mid not in data["metric"], (code, mid)


def test_user_facing_text_has_no_banned_terms():
    """Wording rules: fails if any locale string contains a banned term."""
    loc = load_locales(DEFAULT_CONFIG_DIR)
    for code, data in loc.items():
        for key, text in all_user_strings(data):
            low = text.lower()
            for term in BANNED["en"] + BANNED["th"]:
                assert term not in low, f"{code}:{key} contains banned term {term!r}: {text!r}"


PROMOTIONAL = {
    "en": ["price", "discount", "promotion", "promo", "offer", "sale", "limited time", "hurry", "urgent", "act now",
           "book now", "free consultation", "before and after", "before/after", "guarantee", "baht", "฿",
           "perfect", "ideal face", "score", "rank", "celebrity"],
    "th": ["ราคา", "ส่วนลด", "โปรโมชั่น", "โปรฯ", "ด่วน", "จำนวนจำกัด", "รับประกัน", "ก่อนและหลัง", "บาท", "ดารา",
           "คะแนน", "อันดับ", "สมบูรณ์แบบ"],
}


def test_no_prices_promotions_urgency_scores_or_promises():
    """No prices, promotions, urgency, before / after promises, scores or rankings in any text."""
    import re

    loc = load_locales(DEFAULT_CONFIG_DIR)
    for code, data in loc.items():
        for key, text in all_user_strings(data):
            low = text.lower()
            for term in PROMOTIONAL["en"] + PROMOTIONAL["th"]:
                hit = re.search(rf"\b{re.escape(term)}\b", low) if term.isascii() and term[0].isalpha() else term in low
                assert not hit, f"{code}:{key} contains {term!r}: {text!r}"
