#!/usr/bin/env bash
# Native dev server: API + viewer (/) + admin (/admin/) + inline job worker on 127.0.0.1:${PORT:-8780}.
# scripts/dev_server.sh start|stop|restart   (pid in var/dev_server.pid, log in var/api.log)
set -euo pipefail
cd "$(dirname "$0")/.."; PORT=${PORT:-8780}; PIDF=var/dev_server.pid; mkdir -p var
stop() { [ -f $PIDF ] && kill "$(cat $PIDF)" 2>/dev/null || true; rm -f $PIDF; }
start() {
  set -a; . ./.env; set +a
  VIEWER_DIR=$PWD/viewer ADMIN_DIR=$PWD/admin WORKER_INLINE=true nohup .venv/bin/python -m uvicorn wayfinding_api.main:app \
    --app-dir api --host 127.0.0.1 --port "$PORT" > var/api.log 2>&1 &
  echo $! > $PIDF; echo "dev server pid $(cat $PIDF) on http://127.0.0.1:$PORT (viewer /, admin /admin/, docs /api/docs)"
}
case "${1:-start}" in start) start;; stop) stop;; restart) stop; sleep 1; start;; esac
