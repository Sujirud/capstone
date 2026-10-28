from __future__ import annotations

import pytest

from helpers import DATA, MODELS, models_available


@pytest.fixture(scope="session")
def engine():
    """One real engine for the whole session (models load once). Skips without models."""
    if not models_available():
        pytest.skip("models missing: run `python -m facescan.tools.download_models`")
    from facescan import EngineConfig, FaceScanEngine

    eng = FaceScanEngine(EngineConfig.from_models_dir(MODELS))
    yield eng
    eng.close()


@pytest.fixture(scope="session")
def astronaut():
    from facescan import load_image

    return load_image((DATA / "astronaut.png").read_bytes())


@pytest.fixture(scope="session")
def subject():
    from facescan import SubjectInfo

    return SubjectInfo(sex="female", age=30)


@pytest.fixture(scope="session")
def astronaut_result(engine, astronaut, subject):
    return engine.analyze_frontal(astronaut, subject=subject)
