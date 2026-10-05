# Guided Tours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any editor curate Guided Tours from existing POIs (SpaceCheck-style roadmap), and let visitors pick a tour in AR (destination-search UI), follow curated or Shortest order stop-by-stop with Previous/Continue/End, without hurting WebXR FPS/SLAM.

**Architecture:** `navme_guided_tours` + `navme_guided_tour_stops` + `navme_project_features.guided_tours`. Dashboard panel CRUD with auto stats from stop XYZ + pace. Experience is **one new file** `guidedTour.ts` that loads tours when the flag is on, drives legs via existing `NAVME_ACTIVATE_EVENT`, and listens for `NAVME_CLEAR_NAVIGATION_EVENT` with `reason: "arrived"`.

**Tech Stack:** Vite vanilla JS dashboard, Supabase PostgREST, GCU Mattercraft TypeScript (`guidedTour.ts`, thin hooks in `navmeI18n.ts` + `Scene.zcomp`).

**Spec:** `docs/superpowers/specs/2026-09-09-guided-tours-design.md`

## Global Constraints

- Experience: **at most one new file** (`guidedTour.ts`). Other experience changes only in existing files (`navmeI18n.ts`, `Scene.zcomp`, optional tiny style hook in `navmeStyles.ts` if class reuse needs a shared rule — prefer reusing `gcu-dest-search-*` classes with no new stylesheet file).
- **No `package.json` / dependency changes.**
- Experience UI must match **destination search** (fonts, icons, overlay/sheet/list chrome).
- Feature flag: **`guided_tours`** on `navme_project_features` (default `false`).
- Editors: **any** of super / project / sub-admin.
- Stops: **existing POIs only**.
- Order: curator order default; user **Shortest** = nearest-neighbor from one-shot camera XYZ (idle/click only).
- Stats: auto distance/time/battery; curator sets **pace** only.
- Perf: no `useOnBeforeRender` / rAF for tour logic; no per-frame camera; hide during scanning / confidence-failed; Android WebXR safe.
- Battery % is a **heuristic**, not device Battery Status API.
- Build **dashboard + migration first**, then experience.

---

## File map

| File | Responsibility |
|------|----------------|
| `supabase/migrations/20260909140000_navme_guided_tours.sql` | Schema + `guided_tours` column |
| `src/ar/guided-tours.js` | In-memory tours + stops + stats helpers |
| `src/services/supabase.js` | Tour/stop CRUD REST |
| `src/ui/guided-tour-panel.js` | Dashboard list + roadmap editor |
| `src/ui/dashboard.js` | Sidebar slot `guided-tours` |
| `src/ui/access-control-page.js` | Feature toggle UI + defaults |
| `src/main.js` | Hydrate, gate panel, wire panel |
| GCU `navmeI18n.ts` | Load flag + `isNavmeGuidedToursEnabled()` |
| GCU `guidedTour.ts` | **Only new experience file** — UI + session flow |
| GCU `Scene.zcomp` | Register component node |

---

### Task 1: Migration + feature column

**Files:**
- Create: `Navme_Dashboard-feat-project-admin-rbac/supabase/migrations/20260909140000_navme_guided_tours.sql`

**Interfaces:**
- Produces: tables `navme_guided_tours`, `navme_guided_tour_stops`; column `navme_project_features.guided_tours`

- [ ] **Step 1: Write migration**

```sql
ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS guided_tours boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.navme_guided_tours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  poi_type text NOT NULL,
  name text NOT NULL,
  pace text NOT NULL DEFAULT 'standard'
    CHECK (pace IN ('relaxed', 'standard', 'express')),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  approx_distance_m double precision,
  expected_duration_min integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_guided_tours_poi_type_name_key UNIQUE (poi_type, name)
);

CREATE INDEX IF NOT EXISTS navme_guided_tours_poi_type_idx
  ON public.navme_guided_tours (poi_type);

CREATE TABLE IF NOT EXISTS public.navme_guided_tour_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id uuid NOT NULL REFERENCES public.navme_guided_tours(id) ON DELETE CASCADE,
  poi_id uuid NOT NULL REFERENCES public.navme_pois(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_guided_tour_stops_tour_poi_key UNIQUE (tour_id, poi_id)
);

CREATE INDEX IF NOT EXISTS navme_guided_tour_stops_tour_order_idx
  ON public.navme_guided_tour_stops (tour_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_guided_tours TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_guided_tour_stops TO anon, authenticated;
```

- [ ] **Step 2: Apply** via Supabase MCP `apply_migration` (or SQL editor) before UI testing.

- [ ] **Step 3: Commit** migration file only.

```bash
git add supabase/migrations/20260909140000_navme_guided_tours.sql
git commit -m "Add navme_guided_tours schema and guided_tours feature flag."
```

---

### Task 2: Stats helpers + domain module

**Files:**
- Create: `src/ar/guided-tours.js`

**Interfaces:**
- Produces:
  - `export const guidedToursData = []`
  - `export function normalizeTourRow(row, stops=[])`
  - `export function computeTourStats(stopsWithPos, pace)` → `{ approx_distance_m, expected_duration_min, walk_min, battery_pct }`
  - `export async function hydrateGuidedToursFromSupabase()`
  - Pace speeds: relaxed `40`, standard `55`, express `70` (m/min); dwell 4 / 3 / 2 min; battery `clamp(round(expected_duration_min / 3), 1, 100)`

- [ ] **Step 1: Implement `computeTourStats`**

```js
const PACE = {
  relaxed: { speed: 40, dwell: 4 },
  standard: { speed: 55, dwell: 3 },
  express: { speed: 70, dwell: 2 },
};

export function computeTourStats(stops, pace = 'standard') {
  const cfg = PACE[pace] || PACE.standard;
  let dist = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const dx = Number(b.pos_x) - Number(a.pos_x);
    const dy = Number(b.pos_y) - Number(a.pos_y);
    const dz = Number(b.pos_z) - Number(a.pos_z);
    dist += Math.hypot(dx, dy, dz);
  }
  const walk_min = dist / cfg.speed;
  const expected_duration_min = Math.max(1, Math.round(walk_min + cfg.dwell * stops.length));
  const battery_pct = Math.min(100, Math.max(1, Math.round(expected_duration_min / 3)));
  return { approx_distance_m: dist, expected_duration_min, walk_min, battery_pct };
}
```

- [ ] **Step 2: Hydrate** tours for active `poi_type`, then fetch stops for those tour ids (two REST calls), attach `stops: [{ poi_id, sort_order, poi_name, pos_x, pos_y, pos_z }]` by joining in-memory `poisData`.

- [ ] **Step 3: Commit**

```bash
git add src/ar/guided-tours.js
git commit -m "Add guided tours domain helpers and stats."
```

---

### Task 3: Supabase REST for tours

**Files:**
- Modify: `src/services/supabase.js`

**Interfaces:**
- Produces: `fetchAllGuidedTours`, `fetchGuidedTourStops(tourIds)`, `insertGuidedTourRow`, `updateGuidedTourRow`, `deleteGuidedTourRow`, `replaceGuidedTourStops(tourId, stops)` (delete+insert or upsert pattern already used elsewhere)

- [ ] **Step 1: Mirror categories/floors mutate helpers** with `poi_type` from session on insert.

- [ ] **Step 2: `replaceGuidedTourStops`** — `DELETE` where `tour_id=eq.`, then `POST` rows `{ tour_id, poi_id, sort_order }`.

- [ ] **Step 3: Commit**

```bash
git add src/services/supabase.js
git commit -m "Add Supabase CRUD for guided tours and stops."
```

---

### Task 4: Access Control feature flag

**Files:**
- Modify: `src/ui/access-control-page.js`

- [ ] **Step 1: Add to `DEFAULT_FEATURES`:** `guided_tours: false`.

- [ ] **Step 2: Add to `ACCESS_UI_FEATURES`:**

```js
{
  key: 'guided_tours',
  label: 'Guided Tours',
  desc: 'Curated multi-stop tours in the AR experience. Turns on the Guided Tours panel in the editor.',
  icon: iconNavigate, // or existing map/route icon already imported
},
```

- [ ] **Step 3: Ensure feature PATCH includes `guided_tours`** (uses `FEATURE_FLAG_KEYS` from `DEFAULT_FEATURES` — verify no hard-coded omit list).

- [ ] **Step 4: Commit**

```bash
git add src/ui/access-control-page.js
git commit -m "Add guided_tours project feature toggle."
```

---

### Task 5: Dashboard Guided Tours panel

**Files:**
- Create: `src/ui/guided-tour-panel.js`
- Modify: `src/ui/dashboard.js` (SIDEBAR_ITEMS + `#slot-guided-tours`)
- Modify: `src/main.js` (create panel, hydrate, lock when `!featureGates.guided_tours`)

**Interfaces:**
- Consumes: `guidedToursData`, `computeTourStats`, `poisData`, supabase tour CRUD
- UI reference: `/tmp/NavMe_SpaceCheck_ref/src/ui/poi-roadmap.js` drag pattern (adapt; do not import that repo)

- [ ] **Step 1: Sidebar** — `{ id: 'guided-tours', label: 'Guided Tours' }` (not superAdminOnly). Slot `slot-guided-tours`.

- [ ] **Step 2: Panel list** — tours with name, stop count, pace, expected mins; Add / Edit / Delete.

- [ ] **Step 3: Editor** — name input; pace select (`relaxed|standard|express`); active checkbox; roadmap chain START → drag-reorder POI cards; Add stop opens searchable checklist of `poisData` excluding already selected; Remove on card.

- [ ] **Step 4: Save** — `computeTourStats` from selected POI positions + pace → insert/update tour → `replaceGuidedTourStops` → hydrate → toast.

- [ ] **Step 5: Gate in `main.js`** — `dashboard.setSidebarPanelLocked?.('guided-tours', !featureGates.guided_tours)` after feature load (mirror facilities).

- [ ] **Step 6: Manual test** — enable flag in Access; create “Science Journey” with 5 POIs; reorder; save; reload; order persists.

- [ ] **Step 7: Commit**

```bash
git add src/ui/guided-tour-panel.js src/ui/dashboard.js src/main.js src/ar/guided-tours.js
git commit -m "Add Guided Tours editor panel with roadmap stop order."
```

---

### Task 6: Experience feature flag helper

**Files:**
- Modify: `GCU Production/navmeI18n.ts`

**Interfaces:**
- Produces: `isNavmeGuidedToursEnabled(): boolean` (strict `=== true` like facilities/robo)

- [ ] **Step 1: Extend features `select=`** to include `guided_tours` (primary + fallback select paths).

- [ ] **Step 2: Parse** `guidedToursFeatureEnabled = row.guided_tours === true`.

- [ ] **Step 3: Export**

```ts
export function isNavmeGuidedToursEnabled(): boolean {
  return guidedToursFeatureEnabled;
}
```

- [ ] **Step 4: Commit** (experience repo / copy as project uses).

---

### Task 7: `guidedTour.ts` — load + picker UI

**Files:**
- Create: `GCU Production/guidedTour.ts`
- Modify: `GCU Production/Scene.zcomp` (register script + node like `customMedia`)

**Interfaces:**
- Consumes: `NAVME_CONFIG`, `isNavmeGuidedToursEnabled`, `ensureNavmeFeaturesReady`, `fetchNavmePois` / `findNavmePoiById`, `getPoiDisplayName`, `NAVME_ACTIVATE_EVENT`, `NAVME_CLEAR_NAVIGATION_EVENT`
- Produces: Mattercraft `@zcomponent` class `GuidedTour`

- [ ] **Step 1: Scaffold component** with performance header comment (copy contract from spec). No `useOnBeforeRender`.

- [ ] **Step 2: After started + features ready:** if `!isNavmeGuidedToursEnabled()` return. Else one REST fetch:

```
navme_guided_tours?poi_type=eq.{tenant}&is_active=eq.true&order=sort_order.asc
navme_guided_tour_stops?tour_id=in.(...)&order=sort_order.asc
```

Join POI XYZ from session POI cache (await `fetchNavmePois()` if needed). Cache in `_tours`.

- [ ] **Step 3: Entry button** — fixed chrome using same visual language as destination-search nav items (`gcu-nav-item` or sibling class already in `navmeStyles`). Hidden when feature off, `_tours.length===0`, or body has `navme-surface-scanning` / `navme-confidence-failed`.

- [ ] **Step 4: Overlay** — reuse `gcu-dest-search-overlay` + sheet structure/classes for list and detail. List rows show name · duration · stop count.

- [ ] **Step 5: Detail** — stats from cached columns or `computeTourStats` client-side; buttons **Follow curated** / **Shortest** / Cancel.

- [ ] **Step 6: Commit**

---

### Task 8: `guidedTour.ts` — session navigation + arrive/complete

**Files:**
- Modify: `GCU Production/guidedTour.ts` only

**Interfaces:**
- Shortest: `orderNearestNeighbor(start:{x,y,z}, stops[])` — greedy, O(n²), run on button click only
- Camera snapshot: read camera `matrixWorld` translation once (same pattern as `customMedia` / search snapshot) — never per frame

- [ ] **Step 1: Start session** — set `_order` (curated or shortest); `_index=0`; `_startedAt=Date.now()`; activate stop 0 via:

```ts
window.dispatchEvent(new CustomEvent(NAVME_ACTIVATE_EVENT, {
  detail: { id, name, x, y, z, markerX, markerY, markerZ },
}));
```

- [ ] **Step 2: Listen** `NAVME_CLEAR_NAVIGATION_EVENT` — if `detail?.reason === "arrived"` and session active and arrived id matches current stop → show **arrive sheet** (Previous / Continue / End). Do not auto-advance.

- [ ] **Step 3: Continue** → `_index++` → activate next; if past end → completion sheet (elapsed vs `expected_duration_min`).

- [ ] **Step 4: Previous** → if `_index>0` then `_index--` → activate previous.

- [ ] **Step 5: End / Done** → clear session; dispatch clear navigation without retain; hide sheets.

- [ ] **Step 6: Manual Android/WebXR check** — open list during idle (no FPS cliff); start tour; arrive sheet; Shortest with 5+ stops; confirm no rAF/tour timers while overlay closed.

- [ ] **Step 7: Commit**

```bash
git add guidedTour.ts Scene.zcomp navmeI18n.ts
git commit -m "Add guidedTour experience: picker, curated/shortest, stop sheets."
```

---

### Task 9: Smoke verification checklist

- [ ] Feature off → no experience button; dashboard panel locked.
- [ ] Feature on → create tour with 5 existing POIs; drag reorder; stats update on save.
- [ ] Experience list → detail → Follow curated → arrive → Continue → Previous → End.
- [ ] Shortest changes first stop when starting far from curated Stop 1.
- [ ] Completion shows time vs expected.
- [ ] Destination search UI still works; tour sheets look like search sheets.
- [ ] No new packages; only one new experience source file (`guidedTour.ts`).

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| `guided_tours` flag | 1, 4, 6 |
| Tables tours/stops | 1–3 |
| Any editor + existing POIs | 5 |
| SpaceCheck-like roadmap | 5 |
| Auto stats + pace | 2, 5 |
| One experience file | 7–8 |
| Outside destinationSearch | 7 |
| Destination-search UI | 7–8 |
| Curated + Shortest | 8 |
| Arrive Previous/Continue/End | 8 |
| Completion time vs expected | 8 |
| WebXR/FPS/no package | Global + 7–8 |
| Battery heuristic | 2, 7 |

**Placeholder scan:** none intentional.  
**Type consistency:** pace union `relaxed|standard|express`; activate event detail matches destinationSearch.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-09-guided-tours.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — run tasks in this session with checkpoints  

Which approach?
