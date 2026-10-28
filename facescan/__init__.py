"""facescan: facial aesthetic analysis core (Phase 1: frontal analysis).

Public API::

    from facescan import FaceScanEngine, EngineConfig, load_image, user_view, SubjectInfo

    with FaceScanEngine(EngineConfig.from_models_dir("models")) as engine:
        image = load_image(open("photo.jpg", "rb").read())
        result = engine.analyze_frontal(image, subject=SubjectInfo(sex="female", age=28))
        view = user_view(result, locale="th")
"""

from facescan._version import __version__
from facescan.core.config import EngineConfig
from facescan.core.errors import (
    FaceScanError, ImageDecodeError, ImageMismatchError, InvalidInputError, OverrideError,
    PointNotAdjustableError, UnknownPointError,
)
from facescan.core.normalize import LoadedImage, load_image
from facescan.core.pipeline import FaceScanEngine, user_view
from facescan.core.schema import (
    SCHEMA_VERSION, CameraInfo, FrontalResult, Override, ProfileResult, Report, SubjectInfo,
)

__all__ = [
    "__version__", "SCHEMA_VERSION", "FaceScanEngine", "EngineConfig", "load_image", "user_view", "LoadedImage",
    "CameraInfo", "SubjectInfo", "Override", "FrontalResult", "ProfileResult", "Report",
    "FaceScanError", "ImageDecodeError", "ImageMismatchError", "InvalidInputError", "OverrideError",
    "PointNotAdjustableError", "UnknownPointError",
]
