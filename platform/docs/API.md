# API

Base path `/api`. Live, always-current reference: **`/api/docs`** (Swagger UI), `/api/redoc`, `/api/openapi.json`.
Auth: `POST /api/v1/auth/login` (form fields `username`, `password`) → `{"access_token": "…"}`; send `Authorization: Bearer <token>` to `/api/v1/admin/*`.

## Examples
```bash
B=http://127.0.0.1:8780/api
TOKEN=$(curl -s -d "username=admin@local&password=$PW" $B/v1/auth/login | jq -r .access_token)
curl -s $B/v1/public/venues/all/manifest.json | jq '.buildings[].slug'
curl -s $B/v1/public/buildings/greenland/data/config.json | jq .floors
curl -s -X POST $B/v1/public/buildings/greenland/route -H 'content-type: application/json' \
     -d '{"from_key":"poi_parking","to_key":"poi_b4qtykzcaz","step_free":false}' | jq '.length_m, .eta_s'
curl -s -H "Authorization: Bearer $TOKEN" $B/v1/admin/buildings/greenland/pois | jq length
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"name":"Pastor'"'"'s Office","hours":"Mon–Fri 9–15"}' $B/v1/admin/buildings/greenland/pois/1
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"notes":"names"}' \
     $B/v1/admin/buildings/greenland/publish
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"from_step":"graph"}' \
     $B/v1/admin/buildings/greenland/jobs            # queue a partial rebuild
```

## Public data files (`/api/v1/public/buildings/{slug}/data/{file}`)
`config.json, pois.json, nav_graph.json, walkgrid.json, georef.json, floors.json, indoor_F1.geojson …, site_shell.geojson,
buildings_osm.geojson, floor_F1.webp …, model_full.glb, model_F1.glb, model_glb.json, mp_graph_raw.json, thumbs/index.json, thumbs/<sweep>.jpg`.
Served from the current published version with `Cache-Control: public, max-age=60`. Formats: DATA_FORMATS.md.

## VPS slot
`POST /api/v1/public/vps/localize` forwards the raw body (multipart image or JSON) and query string to `{VPS_URL}/localize`
and returns its JSON; 501 if `VPS_URL` is unset, 502 if unreachable. `GET /api/v1/public/config` tells viewers whether VPS / SDK are available.

## Endpoint list (generated from OpenAPI)
| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/auth/login` | Login |
| GET | `/api/v1/auth/me` | Me |
| GET | `/api/v1/public/venues` | Venues |
| GET | `/api/v1/public/venues/{venue}/manifest.json` | Manifest |
| GET | `/api/v1/public/buildings` | Buildings |
| GET | `/api/v1/public/buildings/{slug}/data/{path}` | Data File |
| POST | `/api/v1/public/buildings/{slug}/route` | Server-side route between two published POIs (the viewer normally routes client-side). |
| GET | `/api/v1/public/config` | Runtime options for viewers (no secrets): VPS, SDK, debug, `chat_enabled` / `chat_configured` / `chat_url`. |
| POST | `/api/v1/public/chat` | Public wayfinding chat (Option 3 phase 1). Body `{messages, building?, locale?}`. Tools: list_buildings, search_pois, get_poi, route, make_deep_link. 404 if `WF_CHAT_ENABLED=false`. Graceful message if LLM unset. |
| GET | `/api/v1/admin/buildings/{slug}/files/{path}` | Draft artefacts from the building workspace (out/…, or work/sat.png, work/georef_preview.jpg). |
| GET | `/api/v1/admin/venues` | List Venues |
| POST | `/api/v1/admin/venues` | Create Venue |
| PATCH | `/api/v1/admin/venues/{slug}` | Patch Venue |
| GET | `/api/v1/admin/buildings` | List Buildings |
| POST | `/api/v1/admin/buildings` | Create Building |
| GET | `/api/v1/admin/buildings/{slug}` | Get Building |
| PATCH | `/api/v1/admin/buildings/{slug}` | Patch Building |
| DELETE | `/api/v1/admin/buildings/{slug}` | Delete Building |
| POST | `/api/v1/admin/buildings/{slug}/matterpak` | Upload MatterPak `.zip`, bare `.e57`, or Matterport E57-export zip (`*.e57` inside, no `.obj`). E57 → `{path,bytes,format:"e57"}`; MatterPak zip → files/colorplans. |
| GET | `/api/v1/admin/geocode` | Geocode |
| GET | `/api/v1/admin/matterport/{model_id}` | Quick model lookup (name, floors, sweeps) for the Add-building wizard. |
| GET | `/api/v1/admin/buildings/{slug}/showcase` | Showcase iframe URL (includes the SDK application key if configured – admin only). |
| POST | `/api/v1/admin/buildings/{slug}/jobs` | Start Job |
| GET | `/api/v1/admin/jobs` | List Jobs |
| GET | `/api/v1/admin/jobs/{jid}` | Get Job |
| POST | `/api/v1/admin/jobs/{jid}/cancel` | Cancel Job |
| PUT | `/api/v1/admin/buildings/{slug}/floors` | Put Floors |
| GET | `/api/v1/admin/buildings/{slug}/pois` | List Pois |
| POST | `/api/v1/admin/buildings/{slug}/pois` | Create Poi |
| GET | `/api/v1/admin/categories` | Categories |
| PATCH | `/api/v1/admin/buildings/{slug}/pois/{pid}` | Patch Poi |
| DELETE | `/api/v1/admin/buildings/{slug}/pois/{pid}` | Delete Poi |
| POST | `/api/v1/admin/buildings/{slug}/pois/{pid}/snap` | Move the POI onto its nearest sweep (exact routing anchor). |
| GET | `/api/v1/admin/buildings/{slug}/pois.csv` | Export Csv |
| POST | `/api/v1/admin/buildings/{slug}/pois/import` | Bulk upsert by `key` (new keys are created). Columns: see GET pois.csv. |
| GET | `/api/v1/admin/buildings/{slug}/georef` | Get Georef |
| POST | `/api/v1/admin/buildings/{slug}/control_points` | Add Cp |
| DELETE | `/api/v1/admin/buildings/{slug}/control_points/{cid}` | Del Cp |
| POST | `/api/v1/admin/buildings/{slug}/georef/fit` | Fit a unit-scale similarity to enabled control points; returns residuals. apply=true stores it (mode=fixed). |
| POST | `/api/v1/admin/buildings/{slug}/georef/finetune` | Nudge the transform (metres / degrees) about the model centre; stored as mode=fixed. Rebuild afterwards. |
| POST | `/api/v1/admin/buildings/{slug}/georef/mode` | Georef Mode |
| POST | `/api/v1/admin/buildings/{slug}/route` | Route |
| GET | `/api/v1/admin/buildings/{slug}/nav` | Nav Geojson |
| POST | `/api/v1/admin/buildings/{slug}/publish` | Do Publish |
| GET | `/api/v1/admin/buildings/{slug}/versions` | Versions |
| POST | `/api/v1/admin/buildings/{slug}/versions/{ver}/activate` | Activate |
| POST | `/api/v1/public/vps/localize` | Localize |
| GET | `/api/health` | Health |


## Debug mode (`/api/v1/public/debug/*`, `/api/v1/admin/debug/*`)

Platform-wide + per-building verbose logging for viewers/mobile → admin Dashboard.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/public/debug/status?b=<slug>` | public | Live effective flag (`enabled`, `global`, `override`) |
| POST | `/api/v1/public/debug/logs` | public | Body `{entries:[{level,source,message,building?}], building?, client?}`. Accepted only when effective debug is on |
| GET | `/api/v1/public/config` | public | Includes `debug_enabled` (global) |
| GET/PATCH | `/api/v1/admin/debug/settings` | admin | Global `{enabled}` and/or `{building, override: true\|false\|null}` |
| GET | `/api/v1/admin/debug/logs` | admin | `after_id`, `limit`, `level`, `building`, `source` |
| DELETE | `/api/v1/admin/debug/logs` | admin | Clear ring + jsonl |
| GET | `/api/v1/admin/debug/logs/export` | admin | Text download |

Persist: `var/data/platform_settings.json` (global); `pipeline_config.debug.enabled` (override). Publish writes `config.debug` hint; live status API is authoritative for global flips.

## Scan planning (`/api/v1/admin/scan-plans`)
Admin-only. Plans stored under `var/data/scan_plans/{id}/meta.json` (not PostGIS).

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/v1/admin/scan-plans` | List / create plan |
| GET/DELETE | `/api/v1/admin/scan-plans/{id}` | Get meta / delete |
| POST | `…/{id}/upload` | Multipart CAD/floor drawing (PNG/JPG/PDF/DXF) |
| POST | `…/{id}/address` | Body `{address, osm_id?, osm_type?, provider?, radius_m?}`. Geocode (Nominatim→Esri), Overpass buildings ~150 m, save `address`/`geocode`/`footprints`/`footprint_hint` on meta. Returns `{meta, candidates}` |
| POST | `…/{id}/scale` | `{mode: line\|px_per_m\|drawing_units, …}` |
| POST | `…/{id}/scale-hint` | `{edge: long\|short\|custom, meters?, x1,y1,x2,y2, confirm?}`. Applies footprint side length to a drawn scale line; refuses to overwrite existing scale unless `confirm=true` |
| POST | `…/{id}/walkable` | Auto or polygon mask |
| POST | `…/{id}/generate` | Grid + path + timing (requires scale) |
| POST | `…/{id}/auto-generate` | Estimate scale (area_m2 / footprint bbox / existing) then generate Pro3 grid. Body `{area_m2?, assume_area_m2?, px_per_m?, spacing_m?, clearance_m?, confirm?}`. If scale+points already exist, require `confirm=true` |
| PATCH | `…/{id}/points` | Edit points / rename |
| GET | `…/{id}/export.csv` / `export.pdf` | Downloads |
| GET | `…/{id}/preview.png` | `?token=` (img-friendly) |

## Public chat (`/api/v1/public/chat`)
Option 3 phase 1 — viewer FAB talks same-origin to this endpoint. LLM keys stay in `.env` (`WF_CHAT_LLM_*`). OpenAI-compatible (`/chat/completions`); Ollama works when `WF_CHAT_LLM_BASE_URL` points at `http://127.0.0.1:11434/v1`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/public/chat` | public | `{messages:[{role,content}], building?, locale?}` → `{message, actions[{type:deep_link,url}], configured, tools_used?}` |
| GET | `/api/v1/public/config` | public | Includes `chat_enabled`, `chat_configured`, `chat_url` |

Rate limit: `WF_CHAT_RATE_LIMIT_PER_MIN` (default 20) per client IP.

## Platform Config (admin JWT)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/admin/platform/config` | Non-secret values + secret configured bools + status. Never returns secret values. |
| PATCH | `/api/v1/admin/platform/config` | Body `{ values, clear_values, secrets, clear_secrets }`. Secrets write-only. |
| POST | `/api/v1/admin/platform/config/probe-llm` | Safe LLM reachability (`GET /models`). |

Overlay files: `var/runtime_settings.json`, `var/runtime_secrets.env` (0600). See [`OWN_CLOUD.md`](OWN_CLOUD.md), Admin **Config** tab.

