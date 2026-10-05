#!/usr/bin/env bash
# Restore a backup made by backup.sh:  scripts/restore.sh backups/<ts>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
F=${1:?usage: restore.sh backups/<ts>.tar.gz}; TMP=$(mktemp -d); tar xzf "$F" -C "$TMP"; D=$(ls "$TMP")
if [ -n "$(docker compose ps -q db 2>/dev/null)" ]; then
  docker compose exec -T db pg_restore -U "${POSTGRES_USER:-wayfinding}" -d "${POSTGRES_DB:-wayfinding}" --clean --if-exists < "$TMP/$D/db.dump"
  docker compose run --rm -v "$TMP/$D:/in" --entrypoint sh api -c "tar xzf /in/data.tar.gz -C /data"
else
  set -a; . ./.env; set +a
  pg_restore -d "${DATABASE_URL/+psycopg/}" --clean --if-exists "$TMP/$D/db.dump"
  mkdir -p "${DATA_DIR:-var/data}"; tar xzf "$TMP/$D/data.tar.gz" -C "${DATA_DIR:-var/data}"
fi
rm -rf "$TMP"; echo restored
