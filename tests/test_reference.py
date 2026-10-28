import pytest

from facescan.core.config import DEFAULT_CONFIG_DIR, read_yaml
from facescan.core.metrics_frontal import FRONTAL_METRICS
from facescan.core.metrics_profile import PROFILE_METRICS
from facescan.core.reference import CanonSpec, NormsBook, PopulationSpec, assess, resolve_canon

K = 2.0


def _canon(spec, unit="ratio", icd_mm=None):
    return resolve_canon(spec, unit, tolerance_frac=0.05, zero_band_frac_icd=0.05, icd_mm=icd_mm)


def test_range_within_and_outside():
    c = _canon(CanonSpec("range", 2.0, 8.0))
    a = assess(5.8, 0.9, canon=c, population=None, typical_range_sd=None, signed=False, inconclusive_k=K)
    assert (a.status, a.deviation_abs, a.deviation_pct, a.status_basis) == ("within", 0.0, 0.0, "canon")
    a = assess(10.0, 0.5, canon=c, population=None, typical_range_sd=None, signed=False, inconclusive_k=K)
    assert a.status == "above" and a.deviation_abs == pytest.approx(2.0) and a.deviation_pct == pytest.approx(25.0)
    a = assess(1.0, 0.1, canon=c, population=None, typical_range_sd=None, signed=False, inconclusive_k=K)
    assert a.status == "below" and a.deviation_abs == pytest.approx(-1.0) and a.deviation_pct == pytest.approx(-50.0)


def test_inconclusive_when_deviation_within_two_uncertainties():
    c = _canon(CanonSpec("range", 2.0, 8.0))
    a = assess(9.0, 0.6, canon=c, population=None, typical_range_sd=None, signed=False, inconclusive_k=K)
    assert a.status == "inconclusive"  # |1.0| ≤ 2 × 0.6
    a = assess(9.0, None, canon=c, population=None, typical_range_sd=None, signed=False, inconclusive_k=K)
    assert a.status == "inconclusive"  # unknown uncertainty is never conclusive


def test_target_band_and_pct_relative_to_target():
    c = _canon(CanonSpec("target", target=1.0))
    assert (c.min, c.max) == pytest.approx((0.95, 1.05))
    a = assess(1.2, 0.01, canon=c, population=None, typical_range_sd=None, signed=False, inconclusive_k=K)
    assert a.status == "above"
    assert a.deviation_abs == pytest.approx(0.15)
    assert a.deviation_pct == pytest.approx(15.0)  # relative to the target


def test_zero_target_band_uses_icd_and_has_no_pct():
    pct = _canon(CanonSpec("zero_band"), unit="%ICD")
    assert (pct.min, pct.max) == pytest.approx((-5.0, 5.0))
    mm = _canon(CanonSpec("zero_band"), unit="mm", icd_mm=32.0)
    assert (mm.min, mm.max) == pytest.approx((-1.6, 1.6))
    a = assess(0.0, 0.2, canon=mm, population=None, typical_range_sd=None, signed=True, inconclusive_k=K)
    assert a.status == "within" and a.deviation_pct is None
    a = assess(3.0, 0.2, canon=mm, population=None, typical_range_sd=None, signed=True, inconclusive_k=K)
    assert a.status == "above" and a.deviation_abs == pytest.approx(1.4) and a.deviation_pct is None
    a = assess(-3.0, 0.2, canon=mm, population=None, typical_range_sd=None, signed=True, inconclusive_k=K)
    assert a.status == "below"


def test_unavailable_and_no_reference():
    c = _canon(CanonSpec("range", 1.0, 2.0))
    assert assess(None, 0.1, canon=c, population=None, typical_range_sd=None, signed=False,
                  inconclusive_k=K).status == "unavailable"
    assert assess(0.3, 0.1, canon=None, population=None, typical_range_sd=None, signed=False,
                  inconclusive_k=K).status == "no_reference"


def test_population_typical_range_takes_precedence_and_z():
    c = _canon(CanonSpec("range", 2.0, 8.0))
    pop = PopulationSpec(mean=10.0, sd=2.0, source="test")
    a = assess(13.0, 0.1, canon=c, population=pop, typical_range_sd=1.0, signed=False, inconclusive_k=K)
    assert a.status_basis == "population"
    assert a.population.z == pytest.approx(1.5)
    assert (a.population.typical_min, a.population.typical_max) == (8.0, 12.0)
    assert a.status == "above"
    # Without the clinically decided width, the typical range does not exist → canon.
    a = assess(13.0, 0.1, canon=c, population=pop, typical_range_sd=None, signed=False, inconclusive_k=K)
    assert a.status_basis == "canon" and a.population.z == pytest.approx(1.5)


def test_norms_file_matches_metric_registries():
    book = NormsBook(read_yaml(DEFAULT_CONFIG_DIR / "norms.yaml"))
    canon = read_yaml(DEFAULT_CONFIG_DIR / "norms.yaml")["profiles"]["canon"]["metrics"]
    ids = set(FRONTAL_METRICS) | set(PROFILE_METRICS)
    assert set(canon) == ids
    assert book.canon("F1_upper_third").target == pytest.approx(1 / 3)
    assert book.canon("F11_asym_eye_width") is None


def test_population_norms_are_all_null_until_clinical_signoff():
    data = read_yaml(DEFAULT_CONFIG_DIR / "norms.yaml")["profiles"]["th_east_asian"]
    assert data["typical_range_sd"] is None
    for sex in ("female", "male"):
        for mid, entry in data["sexes"][sex].items():
            assert entry["mean"] is None and entry["sd"] is None and entry["source"] == "TODO", mid


def test_population_lookup_rules():
    book = NormsBook(read_yaml(DEFAULT_CONFIG_DIR / "norms.yaml"))
    assert book.population("canon", "female", "F1_upper_third") == (None, None)
    assert book.population("th_east_asian", "unspecified", "F1_upper_third") == (None, None)
    spec, k = book.population("th_east_asian", "female", "F1_upper_third")
    assert spec.mean is None and k is None
    with pytest.raises(ValueError):
        book.population("nope", "female", "F1_upper_third")
