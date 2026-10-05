# Wayfinding Platform

Open-source, low-cost **indoor + outdoor wayfinding** for buildings scanned with Matterport.
Turn a MatterPak (OBJ + colour plans) and a Matterport model ID into a Google-Maps-style web map with
search, turn-by-turn multi-floor directions, step-free routing, 3D preview, and an admin dashboard to
curate places and publish versioned maps. Multi-building (campus) aware.

```
MatterPak + model id + address ─► onboarding pipeline (wfpipe) ─► building workspace (out/*.json, webp, glb)
                                                                     │ import
admin dashboard (Vue) ──JWT──► FastAPI + PostGIS ◄───────────────────┘
                                  │ publish (immutable, versioned bundle)
viewer (ArcGIS JS, static) ◄──── public read API  /  or static export (Cloudflare/GitHub Pages)
```

| Folder | What |
|---|---|
| `pipeline/` | `wfpipe` – MatterPak → wayfinding data CLI (16 idempotent steps) |
| `api/` | `wayfinding_api` – FastAPI, SQLAlchemy/GeoAlchemy2, Alembic, JWT admin auth, job worker, `wayfinding` management CLI |
| `admin/` | Admin dashboard (Vue 3 + MapLibre, no build step) |
| `viewer/` | Public viewer (refactored prototype; loads data by venue/building slug; works static) |
| `deploy/`, `docker-compose.yml` | Dockerfile, Caddy (automatic HTTPS) |
| `scripts/` | dev server, Ubuntu setup, backup/restore |
| `tests/` | pytest (pipeline + API) |
| `tools/e2e_screens.py` | Playwright end-to-end UI check + doc screenshots |
| `docs/` | All documentation |

## Quickstart (native, what was tested)

Requirements: Python 3.11+, PostgreSQL 14+ with PostGIS 3, ~2 GB RAM for onboarding.

```bash
cd platform
make setup                              # .venv + pip install -e pipeline -e api pytest
cp .env.example .env                    # set DATABASE_URL, JWT_SECRET (openssl rand -hex 32)
sudo -u postgres createuser -P wayfinding && sudo -u postgres createdb -O wayfinding wayfinding
sudo -u postgres psql -d wayfinding -c "CREATE EXTENSION postgis"
set -a; . ./.env; set +a
.venv/bin/wayfinding migrate
.venv/bin/wayfinding create-admin you@example.com          # prompts for a password
make onboard-greenland                                      # example building (needs ../matterpak)
.venv/bin/wayfinding publish greenland
scripts/dev_server.sh start                                  # http://127.0.0.1:8780  (viewer /, admin /admin/, API docs /api/docs)
```

## Quickstart (Docker, single VM)

```bash
scripts/setup_ubuntu.sh           # docker, firewall, .env with random secrets
nano .env                         # DOMAIN=maps.example.org
docker compose up -d --build
docker compose exec api wayfinding create-admin you@example.com
```
Then open `https://DOMAIN/admin/` and use **Add building**. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) – components, coordinate frames, transform chain, data model
- [ONBOARDING_A_MATTERPAK.md](docs/ONBOARDING_A_MATTERPAK.md) – step by step, with screenshots
- [ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) – dashboard pages
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) – VM, DNS, HTTPS, Matterport SDK, backups, static-only option, costs
- [API.md](docs/API.md) – endpoints (live OpenAPI at `/api/docs`)
- [DATA_FORMATS.md](docs/DATA_FORMATS.md) – config, georef, floors, indoor GeoJSON (IMDF-like), nav graph, POIs, CSV
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) – tests, repo conventions, adding a pipeline step
- [ROADMAP.md](docs/ROADMAP.md) – what is next and what was cut
- [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) – licences and data attribution
- Project-level handoff: `../HANDOFF.md`

## Status
Working end-to-end on the test site (Shiloh Institutional Baptist Church, 2400 Greenland Ave, Charlotte NC;
Matterport `Hn36TwktGgz`): onboard → admin edit → publish → viewer search/route, via API and static export.
`pytest`: 16 passed. See `docs/ROADMAP.md` for gaps.

Licence: MIT (see `LICENSE`). Third-party services and data have their own terms (see notices).
