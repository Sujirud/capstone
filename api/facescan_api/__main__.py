"""Server entry point: ``python -m facescan_api`` (configuration from the environment).

One Uvicorn process serves HTTP; analysis runs in the worker-process pool.
"""

from __future__ import annotations

import logging

import uvicorn

from facescan_api.app import create_app
from facescan_api.settings import Settings


def main() -> None:
    settings = Settings()
    logging.basicConfig(level=settings.log_level, format="%(levelname)s:     %(name)s: %(message)s")
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level=settings.log_level.lower())


if __name__ == "__main__":
    main()
