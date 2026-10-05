# Development

```bash
cd platform && make setup                 # .venv, editable installs of pipeline + api, pytest
set -a; . ./.env; set +a
make test                                  # pytest -q tests  (needs PostGIS; uses database wayfinding_test)
scripts/dev_server.sh restart              # API + viewer + admin + inline worker on :8780 (log var/api.log)
python3 tools/e2e_screens.py               # Playwright: admin login → edit POI → route → publish → viewer search/route; writes docs/img/
```

Tests (`tests/`):
- `test_geo.py` – Mercator round-trip, affine params/inverse, ground-scale check, similarity fit, control-point fit.
- `test_pipeline.py` – floor resolution + overrides on a synthetic Matterport model, OBJ loader, colour-plan mask, runner idempotency (skip / re-run on config change / force), step registry consistency.
- `test_api.py` – health, login, auth required, venue/building/POI CRUD, CSV export → import upsert, unpublished = 404, and (if the Greenland workspace exists at `var/data/buildings/greenland`) import → edit → publish → public config/pois/manifest → cross-floor route.
The test DB is `TEST_DATABASE_URL` or `DATABASE_URL` with the db name replaced by `wayfinding_test` (create it once: `createdb -O wayfinding wayfinding_test; psql -d wayfinding_test -c 'create extension postgis'`). The schema is dropped and recreated each run.

## Conventions
- Pipeline steps are modules in `pipeline/wfpipe/steps/` with `run(ctx) -> dict` (summary). Register in `runner.STEPS` with deps, config keys that affect the result, and required outputs; the runner fingerprints them.
- Read config from `ctx.cfg` (defaults in `context.DEFAULTS`), write with `ctx.write_json(ctx.o(...))` / `ctx.w(...)`, log with `ctx.log` / `ctx.warn` (streams to the job log).
- Keep the four georef implementations consistent (see ARCHITECTURE.md).
- New DB columns: edit `models.py`, then `cd api && alembic revision --autogenerate -m "…"` and review (GeoAlchemy2 creates spatial indexes itself).
- The viewer must keep working from static files: only use data listed in `config.files`, via `WF.D(file)`.
- Never print or commit secrets. `.env` is git-ignored; the local dev admin password lives in `var/dev_admin_password` (mode 600).

## Layout of a building workspace (`DATA_DIR/buildings/<slug>/`)
`building.json` (effective config), `work/` (intermediates: matterpak copy, mp_model.json, mesh.npz, sat.png, colorplan_map.json, floors_resolved.json, vox.npz, osm_*.json, state.json with per-step fingerprints), `out/` (everything the viewer needs).
