"""Reference profiles, deviation, status and z-score.

Two references sit side by side: the classical canon (``canon`` profile) and
population norms (e.g. the ``th_east_asian`` profile, per-sex mean / SD) from
``norms.yaml``. Status is judged against the *active* reference: the typical
range (mean ± k·SD) when population norms exist for the subject, otherwise the
canon. ``status_basis`` records which one was used.

Status logic
------------
* value None → ``unavailable``; no active reference → ``no_reference``.
* inside [min, max] → ``within`` (deviation 0).
* outside: ``above`` / ``below`` only when |deviation| > k × uncertainty;
  otherwise ``inconclusive`` (cannot be separated from measurement noise). A
  missing uncertainty is treated as unresolvable → ``inconclusive``.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from facescan.core.schema import CanonRef, MetricStatus, Population


@dataclass(frozen=True)
class CanonSpec:
    type: str                 # range | target | zero_band
    min: float | None = None
    max: float | None = None
    target: float | None = None


@dataclass(frozen=True)
class PopulationSpec:
    mean: float | None
    sd: float | None
    source: str | None


def _num(x: Any) -> float | None:
    if x is None:
        return None
    if isinstance(x, str):
        return float(Fraction(x.strip()))
    return float(x)


class NormsBook:
    """Parsed ``norms.yaml``."""

    def __init__(self, data: dict[str, Any]) -> None:
        profiles = data.get("profiles") or {}
        if "canon" not in profiles:
            raise ValueError("norms.yaml must define a 'canon' profile")
        canon = profiles["canon"]
        self.tolerance_frac = float(canon["tolerance_frac"])
        self.zero_band_frac_icd = float(canon["zero_band_frac_icd"])
        self._canon: dict[str, CanonSpec | None] = {}
        for mid, spec in (canon.get("metrics") or {}).items():
            if spec is None:
                self._canon[mid] = None
            else:
                self._canon[mid] = CanonSpec(type=spec["type"], min=_num(spec.get("min")),
                                             max=_num(spec.get("max")), target=_num(spec.get("target")))
        self._profiles = profiles

    @property
    def profile_names(self) -> list[str]:
        return list(self._profiles)

    def canon(self, metric_id: str) -> CanonSpec | None:
        return self._canon.get(metric_id)

    def population(self, profile: str, sex: str, metric_id: str) -> tuple[PopulationSpec | None, float | None]:
        """(population spec, typical-range width in SD units) for a subject, or (None, None).

        ``canon`` profiles and ``sex="unspecified"`` have no population norms
        (norms are per sex and sex is never inferred).
        """
        prof = self._profiles.get(profile)
        if prof is None:
            raise ValueError(f"unknown norms profile: {profile!r}")
        if prof.get("kind") != "population" or sex not in ("female", "male"):
            return None, None
        entry = ((prof.get("sexes") or {}).get(sex) or {}).get(metric_id)
        if not entry:
            return None, _num(prof.get("typical_range_sd"))
        return (PopulationSpec(_num(entry.get("mean")), _num(entry.get("sd")), entry.get("source")),
                _num(prof.get("typical_range_sd")))


@dataclass(frozen=True)
class Assessment:
    canon: CanonRef | None
    deviation_abs: float | None
    deviation_pct: float | None
    population: Population
    status: MetricStatus
    status_basis: str | None


def resolve_canon(spec: CanonSpec | None, unit: str, *, tolerance_frac: float, zero_band_frac_icd: float,
                  icd_mm: float | None) -> CanonRef | None:
    """Turn a canon spec into a concrete [min, max] band for this metric and subject."""
    if spec is None:
        return None
    if spec.type == "range":
        return CanonRef(type="range", min=spec.min, max=spec.max)
    if spec.type == "target":
        t = spec.target
        band = abs(t) * tolerance_frac
        return CanonRef(type="target", target=t, min=t - band, max=t + band, tolerance_frac=tolerance_frac)
    if spec.type == "zero_band":
        if unit == "%ICD":
            half = zero_band_frac_icd * 100.0
        elif unit == "mm":
            if icd_mm is None:
                return CanonRef(type="zero_band", target=0.0, band_frac_icd=zero_band_frac_icd)
            half = zero_band_frac_icd * icd_mm
        else:
            raise ValueError(f"zero_band canon needs a %ICD or mm metric, got {unit!r}")
        return CanonRef(type="zero_band", target=0.0, min=-half, max=half, band_frac_icd=zero_band_frac_icd)
    raise ValueError(f"unknown canon type {spec.type!r}")


def assess(value: float | None, uncertainty: float | None, *, canon: CanonRef | None,
           population: PopulationSpec | None, typical_range_sd: float | None, signed: bool,
           inconclusive_k: float) -> Assessment:
    pop = Population()
    pop_range: tuple[float, float] | None = None
    if population is not None:
        z = None
        if value is not None and population.mean is not None and population.sd:
            z = (value - population.mean) / population.sd
        tmin = tmax = None
        if population.mean is not None and population.sd is not None and typical_range_sd is not None:
            tmin = population.mean - typical_range_sd * population.sd
            tmax = population.mean + typical_range_sd * population.sd
            pop_range = (tmin, tmax)
        pop = Population(mean=population.mean, sd=population.sd, z=z, typical_min=tmin, typical_max=tmax,
                         source=population.source)

    if value is None:
        return Assessment(canon, None, None, pop, "unavailable", None)

    if pop_range is not None:
        lo, hi, basis, ref_target = pop_range[0], pop_range[1], "population", None
    elif canon is not None and canon.min is not None and canon.max is not None:
        lo, hi, basis = canon.min, canon.max, "canon"
        ref_target = canon.target if canon.type == "target" else None
    else:
        return Assessment(canon, None, None, pop, "no_reference", None)

    if lo <= value <= hi:
        return Assessment(canon, 0.0, None if signed else 0.0, pop, "within", basis)

    bound = hi if value > hi else lo
    dev = value - bound
    if signed:
        pct = None
    else:
        ref = ref_target if ref_target is not None else bound
        pct = dev / abs(ref) * 100.0 if ref else None
    if uncertainty is None or abs(dev) <= inconclusive_k * uncertainty:
        status: MetricStatus = "inconclusive"
    else:
        status = "above" if dev > 0 else "below"
    return Assessment(canon, dev, pct, pop, status, basis)
