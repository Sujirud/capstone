"""User / clinician point overrides and the user-adjustment rules.

Rules (every view):

* Users may move only the points in ``user_adjustable_points``; clinicians may
  move any point. ``source`` comes from the caller and is never inferred.
* Both the automatic and the adjusted position of every adjusted point are kept
  (``Landmark.auto``).
* A user adjustment farther than ``large_adjustment_frac`` × nasion→menton from
  the automatic position adds the flag ``large_user_adjustment``: dependent
  metrics are still shown but can never trigger considerations.
* A point the user places where no automatic position exists has low confidence.
* Clinician placements have high confidence (this is how brow points become
  "confirmed").
* Phase 2: silhouette points are always re-snapped to the stored contour,
  whatever coordinates the client sent (``snap``).
"""

from __future__ import annotations

from typing import Callable, Iterable, Mapping

import numpy as np

from facescan.core.errors import OverrideError, OverrideOutOfBoundsError, PointNotAdjustableError, UnknownPointError
from facescan.core.geometry import dist
from facescan.core.schema import AutoPosition, ImageSize, Landmark, Override

LARGE_USER_ADJUSTMENT = "large_user_adjustment"
NO_AUTOMATIC_POSITION = "no_automatic_position"


def coerce_overrides(overrides: Mapping[str, Override | dict] | None) -> dict[str, Override]:
    return {name: o if isinstance(o, Override) else Override.model_validate(o) for name, o in (overrides or {}).items()}


def validate_overrides(overrides: Mapping[str, Override], *, point_names: Iterable[str],
                       user_adjustable: Iterable[str], image: ImageSize | None) -> None:
    names, allowed = set(point_names), set(user_adjustable)
    for name, ov in overrides.items():
        if name not in names:
            raise UnknownPointError(f"unknown point {name!r}")
        if ov.source == "user_adjusted" and name not in allowed:
            raise PointNotAdjustableError(f"users may not adjust {name!r}")
        if image is not None and not (0 <= ov.x < image.width and 0 <= ov.y < image.height):
            raise OverrideOutOfBoundsError(f"{name!r} ({ov.x}, {ov.y}) is outside the image")


def automatic_position(lm: Landmark) -> AutoPosition:
    """The detector's position for a landmark, whether or not it has been adjusted."""
    if lm.adjusted and lm.auto is not None:
        return lm.auto
    return AutoPosition(x=lm.x, y=lm.y, source=lm.source, confidence=lm.confidence, sd_px=lm.sd_px, reason=lm.reason)


def reference_length_px(landmarks: Mapping[str, Landmark], a: str = "nasion", b: str = "menton") -> float | None:
    """Distance a→b from the *automatic* positions (stable under adjustments)."""
    pa, pb = landmarks.get(a), landmarks.get(b)
    if pa is None or pb is None:
        return None
    aa, ab = automatic_position(pa), automatic_position(pb)
    if None in (aa.x, aa.y, ab.x, ab.y):
        return None
    return dist(np.array([aa.x, aa.y]), np.array([ab.x, ab.y]))


def apply_point_overrides(landmarks: Mapping[str, Landmark], overrides: Mapping[str, Override], *,
                          large_adjustment_frac: float, manual_sd_frac: float,
                          snap: Callable[[str, np.ndarray], np.ndarray] | None = None,
                          reference_pairs: tuple[tuple[str, str], ...] = (("nasion", "menton"),)
                          ) -> dict[str, Landmark]:
    """New landmark dict with overrides applied (inputs are not modified).

    The tolerance and manual SD are fractions of the first available *automatic* distance
    in ``reference_pairs`` (nasion→menton; the profile falls back to nasion→pogonion when
    the chin underside is not visible, which gives a slightly stricter tolerance).
    """
    ref = next((r for r in (reference_length_px(landmarks, a, b) for a, b in reference_pairs) if r), None)
    if ref is None:
        pairs = ", ".join(f"{a}→{b}" for a, b in reference_pairs)
        raise OverrideError(f"cannot apply overrides: no automatic reference distance ({pairs}) is available")
    tolerance = large_adjustment_frac * ref
    manual_sd = manual_sd_frac * ref
    out = dict(landmarks)
    for name in sorted(overrides):
        ov = overrides[name]
        current = landmarks.get(name)
        if current is None:
            raise UnknownPointError(f"result has no point {name!r}")
        xy = np.array([ov.x, ov.y], dtype=float)
        if snap is not None:
            xy = snap(name, xy)
        auto = automatic_position(current)
        has_auto = auto.x is not None and auto.y is not None
        flags: list[str] = []
        if ov.source == "clinician":
            confidence = "high"
        elif has_auto:
            confidence = auto.confidence
            if dist(xy, np.array([auto.x, auto.y])) > tolerance:
                flags.append(LARGE_USER_ADJUSTMENT)
        else:
            confidence = "low"
            flags.append(NO_AUTOMATIC_POSITION)
        out[name] = Landmark(x=float(xy[0]), y=float(xy[1]), source=ov.source, confidence=confidence,
                             sd_px=manual_sd, auto=auto, flags=flags)
    return out
