# POI Floors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Super-admin Floors panel (Y-slice + name + manual POI/category assign), floor dropdown on POI edit for all admins, then AR destination-search floor labels with zero FPS/SLAM impact.

**Architecture:** New `navme_floors` table + `navme_pois.floor_id`. Dashboard CRUD via existing Supabase REST helpers. Experience loads floors once with POIs and stamps `floorName` on cached rows (no per-frame work).

**Tech Stack:** Vite vanilla JS dashboard, Supabase PostgREST, GCU `destinationSearch.ts` / `navmePois.ts`.

## Global Constraints

- Floors panel + Y-slicing: **super admin only** (`isSuperAdminMapRole()`).
- Other admins: **existing-floor dropdown only** on POI dialog.
- Assign on create: **manual** category select-all + POI checks (no Y auto-select).
- Experience: show floor name **like distance**; **no** current-floor UI.
- Experience perf: session-load only; no rAF/polling/SLAM/camera hooks for floors.
- Build **dashboard first**, run localhost, then experience.

---

## File map

| File | Responsibility |
|------|----------------|
| `supabase/migrations/20260908190000_create_navme_floors.sql` | Schema |
| `src/ar/floors.js` | In-memory floor list + normalize |
| `src/services/supabase.js` | Floor CRUD + POI `floor_id` patches |
| `src/ui/floor-panel.js` | Super-admin Floors UI + assign dialog |
| `src/ui/dashboard.js` | Sidebar slot `floors` (super-admin gated in main) |
| `src/main.js` | Wire panel, hydrate floors, visibility |
| `src/ui/poi-panel.js` | Floor `<select>` on add/edit |
| `src/ar/pois.js` | Carry `floor_id` / `floorName` on normalize |
| GCU `navmePois.ts` | Map floor onto `NavmePoi` |
| GCU `destinationSearch.ts` | Floor label on row (with distance) |

---

### Task 1: Migration + Supabase floor APIs

**Files:**
- Create: `supabase/migrations/20260908190000_create_navme_floors.sql`
- Modify: `src/services/supabase.js`

- [ ] **Step 1: Add migration**

```sql
CREATE TABLE IF NOT EXISTS public.navme_floors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  poi_type text NOT NULL,
  name text NOT NULL,
  slice_y double precision NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_floors_poi_type_name_key UNIQUE (poi_type, name)
);

CREATE INDEX IF NOT EXISTS navme_floors_poi_type_idx ON public.navme_floors (poi_type);

ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS floor_id uuid REFERENCES public.navme_floors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS navme_pois_floor_id_idx ON public.navme_pois (floor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_floors TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_floors TO authenticated;
```

- [ ] **Step 2: Add REST helpers** (mirror categories): `fetchAllFloors`, `insertFloorRow`, `updateFloorRow`, `deleteFloorRow`, and ensure `insertPoiRow` / `updatePoiRow` accept `floor_id`.

- [ ] **Step 3: Apply migration** to the linked Supabase project (CLI or SQL editor) before UI testing.

---

### Task 2: `src/ar/floors.js` domain module

**Files:**
- Create: `src/ar/floors.js`

- [ ] **Step 1: Export** `floorsData` array, `normalizeFloorRow(row)`, `hydrateFloorsFromSupabase()`, `getFloorById(id)`, `getFloorNameById(id)`.

- [ ] **Step 2: Wire hydrate** from `main.js` after auth / project load (same place categories/POIs hydrate).

---

### Task 3: Floors sidebar panel (super admin)

**Files:**
- Create: `src/ui/floor-panel.js`
- Modify: `src/ui/dashboard.js` (nav item + `#slot-floors`)
- Modify: `src/main.js` (create panel; `setPanelVisible('floors', isSuperAdminMapRole())`)

- [ ] **Step 1: UI** — list floors; Add / Edit / Delete.
- [ ] **Step 2: Add flow** — capture `slice_y` (gizmo Y or numeric input seeded from camera/scene Y) → name prompt → `insertFloorRow` → open assign dialog.
- [ ] **Step 3: Assign dialog** — categories with select-all + POI checkboxes; on save, `updatePoiRow(id, { floor_id })` for selected; clear `floor_id` for POIs that had this floor but were unchecked.
- [ ] **Step 4: Gate** — hide Floors nav for non–super admin.

---

### Task 4: POI panel floor dropdown

**Files:**
- Modify: `src/ui/poi-panel.js`
- Modify: `src/ar/pois.js` (`normalizePoiRow` include `floor_id`)

- [ ] **Step 1:** Add Floor `<select>` to add + edit dialogs; options from `floorsData`.
- [ ] **Step 2:** Persist `floor_id` on create/update.
- [ ] **Step 3:** Refresh select when floors change.

---

### Task 5: Run dashboard on localhost

- [ ] **Step 1:** Ensure `.env` from `.env.example` with valid `VITE_SUPABASE_*`.
- [ ] **Step 2:** `npm run dev:dashboard` (or `npm run dev`) and verify Floors + POI dropdown.

---

### Task 6: Experience floor labels (perf-safe)

**Files:**
- Modify: `GCU Production/navmePois.ts`
- Modify: `GCU Production/destinationSearch.ts` (row UI only)

- [ ] **Step 1:** Fetch `navme_floors` once with POIs (or join); set `NavmePoi.floorId` / `floorName`.
- [ ] **Step 2:** In `_createPoiRow`, add floor element next to distance; update in distance sync path only when label text changes.
- [ ] **Step 3:** Confirm no new rAF / camera / per-frame work.

---

## Execution

After plan save: prefer **inline execution** in this session (dashboard → localhost → experience) unless the user picks subagent-driven.
