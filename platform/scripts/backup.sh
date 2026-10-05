#!/usr/bin/env bash
# Backup DB (pg_dump) + data volume (workspaces, published bundles) into backups/<timestamp>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
TS=$(date +%Y%m%d-%H%M%S); OUT=backups/$TS; mkdir -p "$OUT"
if docker compose ps db >/dev/null 2>&1 && [ -n "$(docker compose ps -q db)" ]; then
  docker compose exec -T db pg_dump -U "${POSTGRES_USER:-wayfinding}" -Fc "${POSTGRES_DB:-wayfinding}" > "$OUT/db.dump"
  docker compose run --rm -v "$PWD/$OUT:/out" --entrypoint sh api -c "tar czf /out/data.tar.gz -C /data published buildings --exclude='*/work/matterpak' --exclude='*/work/vox.npz'"
else
  set -a; . ./.env; set +a
  pg_dump -Fc "${DATABASE_URL/+psycopg/}" > "$OUT/db.dump"
  tar czf "$OUT/data.tar.gz" -C "${DATA_DIR:-var/data}" published buildings --exclude='*/work/matterpak' --exclude='*/work/vox.npz'
fi
tar czf "backups/$TS.tar.gz" -C backups "$TS" && rm -rf "$OUT"
echo "backup: backups/$TS.tar.gz"
