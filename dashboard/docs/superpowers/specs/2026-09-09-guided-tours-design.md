# Guided Tours — Design Spec

**Date:** 2026-09-09  
**Status:** Draft for review  
**Scope:** Dashboard (NavMe_Dashboard) + AR experience (GCU / NavMe XR)  
**Repos:** Approach A — Tour catalog + leg navigation via existing activate event  
**Repos UI reference (dashboard sequence only):** [NavMe_SpaceCheck](https://github.com/NERDS-GEEKS/NavMe_SpaceCheck.git) `poi-roadmap.js` (START → drag-reorder stops)

---

## Problem

Curators need named Guided Tours made from **existing POIs** (e.g. Science Journey → 5 stops). Visitors (Ananya) pick a tour, see duration / stops / distance / pace / battery before start, then follow stop-by-stop with Previous / Continue / End. Optional **Shortest** reorders from live XYZ. Must not hurt WebXR FPS, SLAM, or Android stability, and experience UI must match **destination search** (fonts, icons, sheet chrome).

---

## Goals

1. Any editor (super / project / sub-admin) can create/edit guided tours for their project from **existing POIs only**.
2. Dashboard stop UI mirrors SpaceCheck journey roadmap: START → ordered stops, drag-reorder, add from POI picker.
3. Curator sets **pace** only (Relaxed / Standard / Express). Distance, walking time, expected duration, and battery estimate are **auto** from stop XYZ + pace.
4. Feature flag **`guided_tours`** on `navme_project_features` (Access Control). Off → no dashboard tour tools (or locked) and no experience UI/fetch.
5. Experience: **one new file only** (`guidedTour.ts`), scene component like robot — **outside** `destinationSearch.ts`.
6. Experience UI reuses destination-search visual language (`gcu-dest-search-*` / shared navme chrome styles — same fonts, icons, sheets).
7. Start: **Follow curated** or **Shortest** (nearest-neighbor from current camera XYZ on idle — no navmesh TSP).
8. Each stop navigates via existing `NAVME_ACTIVATE_EVENT` / clear events (reuse pathfinding, breadcrumbs, arrival).
9. Arrive sheet: Previous / Continue to next / End tour. Completion: time taken vs expected; optional next-tour suggestions.
10. Zero per-frame tour work; no package.json / dependency changes; Android WebXR stable.

## Non-goals (v1)

- Creating new POIs from the tour panel (select existing only).
- Full TSP or navmesh-length matrix for “shortest” (too heavy for WebXR).
- Auto-advance between stops.
- Folding tours into destination search.
- Multi-language tour **titles** in v1 (POI names already i18n via existing POI columns).
- Changing `package.json` or adding npm deps.
- iOS-only APIs / native battery APIs (battery % is a **heuristic estimate**, not device Battery Status).

---

## Decisions (locked)

| Topic | Choice |
|--------|--------|
| Approach | A — catalog + leg navigation |
| Order | Hybrid: curated default + user **Shortest** |
| Who edits | Any editor role |
| Stops | Existing POIs only |
| Stats | Auto; curator pace only |
| Entry | Outside search; feature-gated |
| Arrive | Sheet: Previous / Continue / End |
| Experience files | **One new file:** `guidedTour.ts` |
| Experience UI | Match destination search |
| Perf | No rAF; idle/event only; no package changes |

---

## Data model

### `navme_project_features`

| Column | Type | Notes |
|--------|------|--------|
| `guided_tours` | boolean NOT NULL DEFAULT false | Access Control toggle |

Migration: `ADD COLUMN IF NOT EXISTS guided_tours boolean NOT NULL DEFAULT false`.

### `navme_guided_tours` (new)

| Column | Type | Notes |
|--------|------|--------|
| `id` | uuid PK | `gen_random_uuid()` |
| `organization_id` | uuid nullable | match other navme tables |
| `poi_type` | text NOT NULL | tenant |
| `name` | text NOT NULL | e.g. “Museum Highlights” |
| `pace` | text NOT NULL | `relaxed` \| `standard` \| `express` |
| `is_active` | boolean NOT NULL DEFAULT true | hide from experience when false |
| `sort_order` | int NOT NULL DEFAULT 0 | list order in picker |
| `approx_distance_m` | double precision nullable | cached on save (sum of straight segments in curator order) |
| `expected_duration_min` | int nullable | cached on save (dwell + walk from pace) |
| `created_by` / `assigned_to` | as RBAC pattern | if project uses ownership columns |
| `created_at` / `updated_at` | timestamptz | |

Unique UX: name unique per `poi_type` (UI enforce; optional DB unique `(poi_type, name)`).

### `navme_guided_tour_stops` (new)

| Column | Type | Notes |
|--------|------|--------|
| `id` | uuid PK | |
| `tour_id` | uuid NOT NULL FK → `navme_guided_tours(id)` ON DELETE CASCADE | |
| `poi_id` | uuid NOT NULL FK → `navme_pois(id)` ON DELETE CASCADE | |
| `sort_order` | int NOT NULL | curator order (1…N) |
| `created_at` | timestamptz | |

Unique `(tour_id, poi_id)`. Index `(tour_id, sort_order)`.

### Stats formulas (dashboard save + experience preview)

Constants (tunable, documented in code):

- Walk speeds (m/min): Relaxed `40`, Standard `55`, Express `70`.
- Dwell per stop (min): Relaxed `4`, Standard `3`, Express `2`.
- Battery heuristic: `~1%` per `3` minutes expected duration (display only; not device API). Cap display `1–100%`.

On save (curator order):

1. `approx_distance_m` = sum of Euclidean 3D distance between consecutive stop `pos_*` (navigation XYZ).
2. `walk_min` = `approx_distance_m / speed_m_per_min`.
3. `expected_duration_min` = round(`walk_min + dwell_min * stop_count`).
4. Battery estimate for UI = from `expected_duration_min` (not stored required; can compute client-side).

**Shortest mode (experience only):** reorder stops with nearest-neighbor from a **one-shot** camera XYZ snapshot at Start (or when tapping Shortest). Recompute preview distance/time for that order. Never on rAF / SLAM loop.

---

## Dashboard

### Access Control

- Add **Guided Tours** to `ACCESS_UI_FEATURES` / `DEFAULT_FEATURES` (`guided_tours: false`).
- Saving features persists column like other flags.

### Sidebar

- Panel **Guided Tours** available to **any editor**.
- If `guided_tours` feature off for project: panel locked/hidden (same pattern as Facilities).

### Tour list + editor

1. List active/inactive tours (name, stop count, pace, expected mins).
2. Create / Edit:
   - Name (required)
   - Pace select
   - Active toggle
   - **Roadmap** (SpaceCheck-style): START → drag-reorder stop cards → connectors
   - **Add stop**: picker of project POIs (search + category filter OK); exclude already-added
   - Remove stop from chain
3. Save → write tour + replace stops + refresh cached distance/duration.
4. Delete tour → cascade stops.

No new npm packages. Reuse existing toast / confirm / glass drawer patterns.

---

## Experience (`guidedTour.ts` only)

### Registration

- Mattercraft/`Scene.zcomp` component (same pattern as `robotanimation` / `customMedia`).
- **Do not** grow `destinationSearch.ts` beyond a tiny optional feature-flag helper if already centralized in `navmeI18n` (prefer adding `isNavmeGuidedToursEnabled()` next to other feature helpers — that is an **existing file edit**, not a second new file).

### Feature gate

- After `ensureNavmeFeaturesReady`: if `guided_tours !== true` → no button, no fetch, no timers, no listeners beyond no-op.

### UI (match destination search)

- Overlay / sheet / list / buttons use the same classes and visual language as destination search (`gcu-dest-search-overlay`, sheet, list rows, bottom chrome patterns, lucide-style stroke icons, SF / system fonts already used there).
- Entry control: fixed chrome button **outside** search (position analogous to robot companion affordance — not inside search FAB). Hidden when feature off or during surface-scanning / confidence-failed (same body-class gates as other chrome).

### Screens

1. **Tour list** — active tours for tenant; show name · expected mins · stop count.
2. **Tour detail / pre-start** — name; hours/mins expected; N stops; ~distance m; expected walking band; pace; battery estimate; buttons **Follow curated** and **Shortest**; Cancel.
3. **Active tour HUD** — Stop i of N; current stop name; End.
4. **Arrive sheet** — You’re at Stop i of N; Previous (disabled on first); Continue to next; End tour.
5. **Complete** — elapsed vs expected; optional list of other tours; Done.

### Navigation integration

- Start / Continue / Previous → `window.dispatchEvent(NAVME_ACTIVATE_EVENT)` with target POI id + XYZ from existing POI cache (`fetchNavmePois` / `findNavmePoiById`).
- Listen for existing arrival / clear events already used by distance calculator / navigation (do not invent a second pathfinder).
- Ending tour → clear navigation event (same as cancel route).

### Performance / WebXR contract (must not break)

| Rule | Detail |
|------|--------|
| No per-frame | No `useOnBeforeRender` / rAF loops for tour logic |
| Timers | Only while a tour sheet/HUD is visible; tear down on close |
| Fetch | One session load of tours+stops when feature on (after localize); cache in memory |
| Shortest | Idle / click-time nearest-neighbor on ≤ ~30 stops; straight-line XYZ only |
| Camera | One snapshot for start/shortest — never live tracking for tour math |
| Packages | Zero new deps |
| Scanning | Hide tour UI while `navme-surface-scanning` / `navme-confidence-failed` |
| Search open | Do not run tour layout work while `gcu-dest-search-open` if overlapping |
| Android | Avoid large DOM rebuilds; update text nodes; reuse sheet DOM |

---

## i18n (v1)

- Tour chrome strings: add keys to existing `navmeI18n` where practical (existing file).
- Tour **names** from dashboard stored as plain text (v1).
- Stop labels: `getPoiDisplayName` from existing POI cache.

---

## Testing (manual)

1. Feature off → no experience button; dashboard locked.
2. Feature on → create “Science Journey” with 5 POIs; drag reorder; save; cached stats sensible.
3. Experience list → detail stats → Follow curated → arrive → Continue → Previous → End.
4. Shortest from far from Stop 1 → different first stop; complete summary shows.
5. Android Chrome WebXR: no FPS cliff when opening list / starting tour; no hang on Shortest.
6. Simultaneous destination search still works; tour chrome matches search look.

---

## Out of scope follow-ups

- Multilingual tour titles  
- Navmesh-accurate tour distance  
- Auto-advance / audio guide per stop  
- Analytics of tour completions  

---

## Spec self-review

- [x] No unresolved placeholders  
- [x] Approach A consistent throughout  
- [x] One new experience file constraint explicit  
- [x] Feature flag named `guided_tours`  
- [x] SpaceCheck referenced for dashboard roadmap only  
- [x] Destination-search UI parity + WebXR/FPS rules explicit  
- [x] Battery is heuristic (not device API)  
- [x] Existing `NAVME_ACTIVATE_EVENT` reuse (no second router)  
