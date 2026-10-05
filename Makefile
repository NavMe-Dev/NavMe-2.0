SHELL := /bin/bash
PY    := platform/.venv/bin/python

.PHONY: setup setup-platform setup-dashboard dev dev-platform dev-dashboard migrate

## Install all dependencies (platform Python venv + dashboard npm)
setup: setup-platform setup-dashboard

setup-platform:
	cd platform && python3 -m venv .venv && \
	  .venv/bin/pip install -e pipeline -e api pytest

setup-dashboard:
	cd dashboard && npm install

## Run platform API on :8780 (viewer + admin + inline worker)
dev-platform:
	cd platform && \
	  VIEWER_DIR=viewer ADMIN_DIR=admin WORKER_INLINE=true \
	  $(abspath platform)/.venv/bin/python \
	  -m uvicorn wayfinding_api.main:app --app-dir api --host 127.0.0.1 --port 8780 --reload

## Run dashboard dev server (Vite on :5173)
dev-dashboard:
	cd dashboard && npm run dev

## Run both simultaneously (requires tmux or two terminals — use make dev-platform and make dev-dashboard in separate tabs)
dev:
	@echo "Starting platform on :8780 and dashboard on :5173"
	@trap 'kill %1 %2 2>/dev/null' INT; \
	  $(MAKE) dev-platform & \
	  sleep 3 && $(MAKE) dev-dashboard & \
	  wait

## Database migrations
migrate:
	cd platform && $(abspath platform)/.venv/bin/wayfinding migrate
