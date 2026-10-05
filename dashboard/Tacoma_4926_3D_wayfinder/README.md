# NavMe Mini3dGta Standalone

View-only 2D/3D floor map from saved `navme_floor_edits` (no GLB).

## Setup

```bash
npm install
cp .env.example .env   # add Supabase URL, anon key, poi type
npm run dev
```

Open http://localhost:5174 — use the **Map** button (bottom) to open the fullscreen floor map.

## Env

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_NAVME_POI_TYPE` | `navme_logins.poi_type` / tenant |
| `VITE_DEFAULT_MAP_CODE` | Fallback map code if login row has none |

## Deploy on Render (Static Site)

1. New → **Static Site** (or Blueprint via `render.yaml`)
2. Connect `NERDS-GEEKS/unisys_wayfinder_fp`, branch `main`
3. **Build:** `npm ci && npm run build`
4. **Publish directory:** `dist`
5. Add rewrite: `/*` → `/index.html` (included in `render.yaml`)
6. Set **build-time** env vars (Vite inlines `VITE_*` at build):

| Variable | Example |
|----------|---------|
| `VITE_SUPABASE_URL` | your Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | anon key |
| `VITE_NAVME_POI_TYPE` | `room` |
| `VITE_DEFAULT_MAP_CODE` | your map code |
| `VITE_NAVME_STANDALONE` | `true` |

After changing env vars, **clear build cache / redeploy** so Vite picks them up.

## Structure

- `src/Mini3dGtaEmbed.ts` — full embed (map, routing, 3D walls, UI)
- `src/floorWallExtract.ts` / `src/floorWallWorker.ts` — off-main-thread wall extraction
- `src/behaviors.ts` — Supabase config from env
- `src/navmeI18n.ts` / `src/navmePois.ts` — i18n + POI helpers
- `src/mocks/` — `@zcomponent/*` stubs for standalone Vite (no Mattercraft)
- `render.yaml` — Render Static Site blueprint
