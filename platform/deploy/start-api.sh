#!/bin/sh
# Single-container entrypoint: run pending Alembic migrations, then serve.
# PORT is injected by the host (Render sets it; default 8000 for local docker run).
set -e
wayfinding migrate
exec uvicorn wayfinding_api.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers
