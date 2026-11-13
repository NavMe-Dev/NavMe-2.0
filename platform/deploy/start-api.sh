#!/bin/sh
# Single-container entrypoint: run pending Alembic migrations, then serve.
# PORT is injected by the host (Render sets it; default 8000 for local docker run).
set -e
read_only_mode=false
needs_readiness=false
for mode in "${WF_READ_ONLY:-false}" "${DB_READ_ONLY:-false}"; do
  case "$mode" in true|True|TRUE|1|t|T|yes|Yes|YES|y|Y|on|On|ON) read_only_mode=true ;; esac
done
case "${DB_STARTUP_CHECK:-false}" in true|True|TRUE|1|t|T|yes|Yes|YES|y|Y|on|On|ON) needs_readiness=true ;; esac
if [ "$read_only_mode" = true ]; then
  needs_readiness=true
  case "${RUN_MIGRATIONS:-true}" in false|0) ;; *) echo "Read-only recovery requires RUN_MIGRATIONS=false" >&2; exit 1 ;; esac
fi
# An occupied production database must be audited/migrated explicitly before
# cutover. Leave the historical default for existing installations; opt out only
# through a reviewed environment change. Never infer permission to run DDL.
case "${RUN_MIGRATIONS:-true}" in
  true|1) wayfinding migrate ;;
  false|0) echo "Automatic migrations disabled; /api/health verifies required application tables." ;;
  *) echo "RUN_MIGRATIONS must be true or false" >&2; exit 1 ;;
esac
if [ "$needs_readiness" = true ]; then
  python -m wayfinding_api.readiness --timeout "${DB_STARTUP_TIMEOUT_SECONDS:-60}"
fi
exec uvicorn wayfinding_api.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers
