# Wayfinding platform – common tasks. Docker targets need docker compose; native targets use .venv + local PostGIS.
PY=.venv/bin
.PHONY: setup dev migrate admin worker test onboard-greenland publish static up down logs backup restore zip
setup:            ## native: venv + deps
	python3 -m venv .venv && $(PY)/pip install -e pipeline -e api pytest
migrate:
	$(PY)/wayfinding migrate
admin:            ## make admin EMAIL=you@example.com
	$(PY)/wayfinding create-admin $(EMAIL)
dev:              ## API + viewer + admin + inline worker on :8780
	VIEWER_DIR=viewer ADMIN_DIR=admin WORKER_INLINE=true $(PY)/python -m uvicorn wayfinding_api.main:app --app-dir api --port 8780 --reload
worker:
	$(PY)/wayfinding worker
test:
	$(PY)/pytest -q tests
onboard-greenland:
	$(PY)/wayfinding add-building greenland --name "Shiloh Institutional Baptist Church" --model-id Hn36TwktGgz \
	  --matterpak ../matterpak --address "2400 Greenland Ave, Charlotte, NC 28208" --venue greenland-campus --config fixtures/greenland_pipeline.json
	$(PY)/wayfinding onboard greenland --inline
publish:          ## make publish SLUG=greenland
	$(PY)/wayfinding publish $(SLUG)
static:           ## static export for Cloudflare/GitHub Pages -> dist/
	$(PY)/wayfinding export-static dist --viewer viewer
up:
	docker compose up -d --build
down:
	docker compose down
logs:
	docker compose logs -f --tail=100
backup:
	./scripts/backup.sh
restore:          ## make restore FILE=backups/xxx.tar.gz
	./scripts/restore.sh $(FILE)
