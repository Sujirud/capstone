"""Exceptions raised by the core.

Expected analysis outcomes (no face, failed quality gate…) are result statuses,
not exceptions. These errors signal invalid input or misuse.
"""

from __future__ import annotations


class FaceScanError(Exception):
    """Base class for core errors."""


class ImageDecodeError(FaceScanError, ValueError):
    """The bytes are not a decodable JPEG, PNG or WebP image."""


class InvalidInputError(FaceScanError, ValueError):
    """Malformed request, e.g. a burst of the wrong length or with mixed frame sizes."""


class ImageMismatchError(FaceScanError, ValueError):
    """The image passed to ``render_overlay`` is not the result's reference image."""


class OverrideError(FaceScanError, ValueError):
    """Base class for rejected point overrides."""


class UnknownPointError(OverrideError):
    """The override names a point that does not exist in this view."""


class PointNotAdjustableError(OverrideError):
    """A user-sourced override targets a point outside ``user_adjustable_points``."""


class OverrideOutOfBoundsError(OverrideError):
    """The override coordinates fall outside the analyzed image."""
