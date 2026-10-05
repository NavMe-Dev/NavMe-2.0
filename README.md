# NavMe 2.0

Monorepo containing the NavMe wayfinding platform and dashboard.

```
NavMe-2.0/
├── platform/   FastAPI API + viewer + admin + pipeline (port 8780)
└── dashboard/  Vue 3 + Vite dashboard frontend (port 5173)
```

## Quick start

```bash
cp .env.example .env   # fill in your secrets once
make setup             # Python venv + npm install
```

Then in two terminals:

```bash
make dev-platform      # API on http://127.0.0.1:8780
make dev-dashboard     # Vite on http://localhost:5173
```

Or `make dev` to start both (background processes, Ctrl-C stops both).

## Shared config

All secrets live in the root `.env`. Both subdirectories symlink to it:

- `platform/.env → ../.env` — read by the FastAPI settings loader
- `dashboard/.env → ../.env` — read by Vite (uses `VITE_`-prefixed vars)

## Platform

See `platform/README.md` for pipeline, Docker, and deployment docs.

## Dashboard

See `dashboard/docs/` for dashboard-specific documentation.
