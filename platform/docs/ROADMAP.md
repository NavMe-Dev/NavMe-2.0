# Roadmap

## Cut from v0.1 or left partial (deliberately, to ship a working, tested slice)
| Item | State | Notes / how to do it |
|---|---|---|
| Running the Docker stack | **written, not executed** | the build box has no Docker. Compose/Dockerfile/Caddyfile are syntax-checked; everything was tested natively. First real deploy needs a smoke test |
| Separate `admin` and `viewer` containers | folded into Caddy | both are static files; Caddy serves them. Split out only if you need a CDN / separate scaling |
| Multi-building campus | **implemented, not exercised** | venue manifest, campus search across buildings, "other building" markers and `?b=` switching are coded, but only one building exists (no second scan to test with). Cross-building *routing* (outdoor legs between buildings) is not implemented – selecting a place in another building opens that building's map |
| Nav graph editor in admin | cut | stair zones, extra edges and outdoor tie-in points are set via pipeline options JSON (`stairs`, `graph`) and re-run. UI editor: draw/delete edges on the Route tester map, store overrides in `pipeline_config.graph.overrides`, apply in `steps/graph.py` |
| Per-building SDK keys | partial | `buildings.sdk_key_ref` is stored (env var **name**), but the API currently uses the global `MATTERPORT_SDK_KEY` |
| Matterport Showcase inside the public viewer | cut | admin has the Showcase iframe preview; the viewer uses skybox thumbnails in direction cards. Needs the SDK key + domain whitelisting |
| Photo upload for POIs | cut | POIs take a `photo_url`; add an upload endpoint storing into `DATA_DIR/media/` and copy on publish |
| Job cancel while running | cut | only queued jobs can be cancelled; add a cancel flag checked between steps in `services/jobs.run_job` |
| pgRouting | not used (by design) | graphs are ~200 nodes; networkx server-side and JS A* client-side are enough. Revisit for campus-scale outdoor graphs |
| `cloud.xyz` point cloud | ignored | mesh-based voxels suffice |
| Admin user management UI, roles, password reset, audit log, rate limiting | cut | CLI `create-admin` only; all admins are equal |
| Structured opening hours | free text | could adopt OSM `opening_hours` syntax |
| Automated UI tests in CI | partial | `tools/e2e_screens.py` runs the full UI flow (Playwright) but is manual; pytest covers pipeline + API |
| Esri dependency in the viewer | kept | ArcGIS JS SDK from the prototype. A MapLibre port would remove the Esri account requirement for production basemaps |
| i18n | **first cut** | Shared `locales/{en,es,fr,de,hi,kn,ar}.json` + `locales/i18n.js`; admin enabled-languages checkboxes; viewer/admin switchers; Arabic RTL |

## Next (in order, as agreed with the project owner)
1. **VPS (visual positioning)** – separate service in `/workspace/wayfinding/vps` (FastAPI `POST /localize`, built from Matterport sweep imagery). Platform slot exists: set `VPS_URL` and the API proxies `POST /api/v1/public/vps/localize`; published `config.json` carries `vps_enabled`. Viewer **Locate me** / Use camera can call it (or same-origin `/localize` on the prototype). Remaining: harden confidence/heading UX, FOV from EXIF, multi-frame. Field page: `app/localize.html`. Results: `/workspace/wayfinding/vps/RESULTS.md`.
2. **Field-test kit** – see `/workspace/wayfinding/FIELD_TEST_PLAN.md`: printable test-route sheet, QR codes per start point (`?from=<poi>`), a logging page that records VPS fixes vs. ground truth, timing of routes, and a feedback form; checklist for verifying step-free entrances, stairs, and room names on site.
3. **Native mobile AR** (iOS ARKit / Android ARCore, or Unity/AR Foundation): VIO tracking between VPS fixes, periodic **re-anchoring** with VPS, **route snapping** of the tracked pose to the nav graph, AR arrows/breadcrumbs, floor-change detection (barometer + VPS). Same public data API.
4. Multi-building outdoor routing: merge building graphs through shared OSM footways into a venue graph; route across buildings with entrance hand-offs.
5. Indoor data standards: full IMDF export (venue/building/footprint/level/unit/opening/amenity/anchor) and OSM SIT/Indoor= export.
6. Accessibility: verified step-free entrance data, ramp/elevator modelling, audio turn-by-turn, high-contrast theme polish.
7. Operations: object storage for bundles (S3/R2) + CDN, Prometheus metrics, error tracking.

## Scan planning (admin) — requested 2026-09-29
Upload a CAD / floor-plan drawing of a space and get a **Matterport scan plan** before capture:
recommended scan (tripod) positions, coverage estimate, walking path between setups, and duration timing (setup + capture + travel).
**Status:** first cut shipped (2026-09-29); address→OSM footprint scale hint added (2026-09-29). Admin `#/scan-plan`: PNG/JPG/PDF/DXF upload, optional street-address geocode (Nominatim, Esri fallback) + Overpass building footprint (oriented L×W m) as scale-length hint, scale (line / px-per-m / DXF units), auto or polygon walkable mask, 1.5–3.0 m grid with wall clearance + optional LOS filter, NN+2-opt walk order, Pro3-ish timing defaults, CSV + PDF export. API: `/api/v1/admin/scan-plans` (+ `/address`, `/scale-hint`). Known limits: single-floor drawings, no furniture model, outdoor not handled, DXF uses largest closed loops/hatches only, Overpass mirrors can be slow/flaky, footprint is roof outline (not interior walls), no automatic footprint overlay on the drawing.

## Internationalization (i18n) — requested 2026-09-29
Multi-language **admin dashboard** and **end-user viewer** (directions, search UI chrome, settings). Place/POI names remain as authored unless a translation field is added later.
**Status:** first cut shipped (2026-09-29). Locales: **en, es, fr, de, hi, kn, ar** (Arabic RTL via `dir="rtl"`). Shared JSON dictionaries under `platform/locales/` served at `/locales/`; vanilla `i18n.js` (no bundler). Admin **Building settings → Enabled languages** multi-checkboxes persist `branding.enabled_languages` (English always on); **re-publish** so the public viewer picks them up. Viewer drawer language switcher shows only enabled locales; choice in `localStorage` (`wf_lang`). Admin header switcher offers the full first-cut catalog so operators are not locked to English. POI/room names stay as editors enter them (no per-locale name fields yet). Remaining: per-locale POI names, translate turn-by-turn instruction text from the router, professional translation pass, he/fa RTL if added later.

## E57 point-cloud ingest — requested 2026-09-29
Accept `.e57` (Matterport / LiDAR) alongside MatterPak zip in Add building; ingest converts to `model.obj` + synthetic colour plans via `pye57` + Open3D (2.5D heightfield fallback).
**Status:** first cut shipped (2026-09-29). Upload API + admin accept `.e57`; server path supported; `MAX_UPLOAD_MB` default 8192. Remaining: streaming/chunked read for huge clouds, better multi-floor colourplan quality, optional georef hints from E57 pose metadata, and end-to-end onboard of a real multi-GB Matterport E57 once the user’s download finishes.
