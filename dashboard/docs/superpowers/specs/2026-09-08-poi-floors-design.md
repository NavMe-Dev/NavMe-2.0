# POI Floors — Design Spec

**Date:** 2026-09-08  
**Status:** Draft for review  
**Scope:** Dashboard first, then AR destination-search experience  
**Repos:** Approach 1 — shared `navme_floors` + `navme_pois.floor_id`

---

## Problem

Admins need named building floors with a Y-slice height so POIs can be grouped by floor. In the AR destination search, each POI should show its floor name beside distance. Floor management by Y-slicing is super-admin-only. The AR path must not hurt FPS, SLAM, or introduce lag.

---

## Goals

1. Super admin can create/edit/delete floors via a dedicated **Floors** sidebar panel using Y-slicing, then name the floor.
2. Super admin assigns POIs to a floor **manually** (category select-all + individual POI checks). Y-slice is stored for the floor’s height marker; it does **not** auto-select POIs.
3. Project / sub-admins can only **pick an existing floor** on the POI create/edit dialog (dropdown). They never see the Floors panel or slicing tools.
4. AR destination search shows each POI’s floor name like distance (e.g. name · distance · floor).
5. No “current floor” filter / camera-Y floor detection UI in v1.
6. AR: zero per-frame floor work; no SLAM/camera changes; no layout thrash while searching.

## Non-goals (v1)

- Current-floor detection or floor filter chips in destination search.
- Auto-assigning POIs by Y proximity when slicing.
- Migrating facilities/`floor_name` into `navme_floors` (facilities keep their existing free-text field).
- Changing mini3d-2d `navme_floor_edits` (separate product surface).

---

## Data model

### `navme_floors` (new)

| Column | Type | Notes |
|--------|------|--------|
| `id` | uuid PK | default `gen_random_uuid()` |
| `organization_id` | uuid nullable | match other navme tables if used |
| `poi_type` | text NOT NULL | project tenant key |
| `name` | text NOT NULL | display name (“Ground”, “Floor 1”) |
| `slice_y` | double precision NOT NULL | Y height from super-admin slice |
| `sort_order` | int NOT NULL default 0 | list order |
| `created_by` / `assigned_to` | as RBAC pattern | follow existing ownership columns if required by project |
| `created_at` / `updated_at` | timestamptz | |

Unique-ish UX: names unique per `poi_type` (soft uniqueness in UI; optional DB unique on `(poi_type, name)`).

### `navme_pois`

| Column | Type | Notes |
|--------|------|--------|
| `floor_id` | uuid NULL FK → `navme_floors(id)` ON DELETE SET NULL | |

Indexes: `navme_floors(poi_type)`, `navme_pois(floor_id)`.

RLS / grants: same anon/authenticated patterns as `navme_categories` / `navme_pois` for the tenant.

---

## Dashboard — Super admin (A)

### Visibility

- New sidebar item **Floors**, registered only when `isSuperAdminMapRole()` / superadmin session is true.
- Non–super admins never see the panel, slice gizmo, or floor CRUD APIs in the UI.

### Create floor flow

1. Open Floors → **Add floor**.
2. Interactive Y-slice in the 3D/Matterport scene (horizontal plane or Y handle at current/camera or click height).
3. Confirm slice → modal: **Floor name** (required).
4. Persist `navme_floors` row (`name`, `slice_y`, `poi_type`).
5. **Assign POIs** step (same dialog or follow-on):
   - List categories with **Select all** per category (checking a category selects all POIs that have that category).
   - Individual POI checkboxes (searchable).
   - Save writes `floor_id` on selected POIs; unselected POIs that previously had this floor keep or clear per explicit UX: **only selected set is assigned; POIs removed from the checklist for this floor get `floor_id` cleared if they pointed at this floor**.

### Edit / delete

- Edit name, re-adjust `slice_y`, re-open assign checklist.
- Delete floor → `ON DELETE SET NULL` clears POI links; confirm dialog.

### Y-slice behavior

- Stored only as `slice_y` on the floor row.
- **No** auto-suggestion of POIs by Y distance (Approach C from discovery).

---

## Dashboard — All admins (C)

### POI create / edit dialog

- Field **Floor**: `<select>` of floors for current `poi_type` (`id` / `name`), plus empty “None”.
- Saving POI writes `floor_id`.
- No create-floor or Y-slice controls here.
- Super admin may also set floor here for convenience.

---

## Experience (GCU destination search) — after dashboard

### Display

- Map `floor_id` → floor `name` when loading POIs (prefer one fetch: floors list for `poi_type` + join in client, or embed `floor_name` via select join if PostgREST allows).
- POI row shows floor name next to distance (same visual weight/pattern as distance), omit if no floor.

### Performance contract (hard)

- Floor names resolved **once** when destinations load / language refresh — never per AR frame.
- No extra rAF, no polling, no WebGL/canvas resize, no SLAM/camera hooks for floors.
- Search open: reuse existing one-shot camera snapshot for distances only; floors do not use camera Y in v1.
- Row updates: set text on existing cached row nodes (same pattern as distance labels); no full list rebuild for floor alone.
- Icons/markup stay inline; no image decode per floor.
- Filtering/typing paths unchanged except reading a precomputed `floorName` string on the POI object.

If floors fetch fails, search still works; floor labels simply empty.

---

## Implementation order

1. Migration + Supabase helpers (`fetchFloors`, CRUD, update POI `floor_id`).
2. Dashboard Floors panel (super admin) + Y-slice + assign UI.
3. POI panel floor dropdown (all admins).
4. Run dashboard on localhost and verify.
5. GCU: map floor on `NavmePoi`, show in destination search rows under the performance contract.

---

## Testing

### Dashboard

- Super admin: create floor (slice → name → assign category select-all + POIs) → rows in DB.
- Non–super admin: no Floors nav; POI dialog shows dropdown of floors only.
- Delete floor → POIs `floor_id` null.
- Project switch / `poi_type`: floors scoped correctly.

### Experience

- POI with floor shows name beside distance; without floor shows no floor chip.
- Open search / type filter / category change: no FPS hitch beyond existing behavior; DevTools Performance: no per-frame floor work.

---

## Open points (resolved in discovery)

| Topic | Decision |
|-------|----------|
| Panel vs mini3d vs POI-only | A + C |
| Who slices | Super admin only |
| Other admins | Dropdown of existing floors |
| Assign on create | Manual category select-all + POIs (no Y auto) |
| AR current floor | Not in v1 — show floor name on POI like distance |
| Perf | Session-load only; no SLAM/FPS impact |

---

## Approval

Pending user review of this spec before implementation plan and coding.
