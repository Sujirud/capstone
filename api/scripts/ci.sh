#!/usr/bin/env bash
# CI for the API: locked install with hash checks, model download, tests and the
# OpenAPI contract check. Run from anywhere, in a fresh virtualenv:
#   python3.11 -m venv .venv-ci && . .venv-ci/bin/activate && api/scripts/ci.sh
set -euo pipefail
api="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$api/.." && pwd)"

python -m pip install --quiet --require-hashes --only-binary=:all: \
    -r "$api/requirements.lock" -r "$api/requirements-dev.lock"
python -m pip install --quiet --no-deps -e "$root" -e "$api"
python -m pip check

# Model files for the real-core integration tests (checked against the core's pinned SHA-256).
python "$root/facescan/tools/download_models.py" --dest "$root/models"

cd "$api"
python -m pytest -q
# The committed contract must equal the generated one (changes are deliberate).
python -m facescan_api.openapi | diff -u openapi.json -
echo "CI passed"
