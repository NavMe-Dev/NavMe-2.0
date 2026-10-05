# NavMe Dashboard — branches

**Default branch = `feat/project-admin-rbac`.**  
GitHub **Code → Download ZIP** (and the green Code button ZIP) downloads this branch only — not `main` or `admin-rbac`.

| Branch | ZIP download | What it includes |
|--------|----------------|------------------|
| **feat/project-admin-rbac** (default) | https://github.com/NERDS-GEEKS/Navme_Dashboard/archive/refs/heads/feat/project-admin-rbac.zip | Editor + project admin / sub-admin RBAC + translation-on-save + mesh heat Y-offset + media PNG download |
| `admin-rbac` | (not default — avoid for new setups) | Older RBAC snapshot |
| `main` | (not default — avoid for new setups) | Stable editor without full RBAC UI |

## Run on localhost (feat/project-admin-rbac)

```bash
# From ZIP: unzip, then cd into the folder
# Or clone this branch only:
git clone -b feat/project-admin-rbac --single-branch https://github.com/NERDS-GEEKS/Navme_Dashboard.git
cd Navme_Dashboard

cp .env.production .env   # uses existing Supabase project keys
npm ci
npm run dev:dashboard     # http://localhost:3001
# or: npm run dev         # dashboard + 2D + 3D sub-apps (needs subfolder deps)
```

Open **http://localhost:3001** (editor) and **http://localhost:3001/access** (superadmin).

Node **20+** required. Port **3001** is fixed (`strictPort`).

## Build & publish

```bash
npm ci
npm run build
```

Deploy the `dist/` folder to your static host (Render, Vercel, etc.).

## Routes

| URL | Purpose |
|-----|---------|
| `/` | 3D editor — POIs, categories, media (Save details translates to all languages) |
| `/access` | Superadmin — projects, features, languages, **assign project admin** |

## Project admin RBAC setup

1. Apply Supabase migrations in `supabase/migrations/20260812160000_*` through `20260812162000_*`.
2. Superadmin assigns a **project admin** per `poi_type` on `/access`.
3. Project admin signs in → 3D editor + **Team** panel to create sub-admins.
4. Sub-admins see only POIs/media they created or were assigned.

## Translation on save

When you click **Save details** on a POI (or save a category), the dashboard translates into all language columns before writing to Supabase. Use the **globe** button on the POI list to fill names that are still missing translations. Add POI is never blocked by rate-limits (translations continue in the background).

## Matterport pending POIs (super admin)

On Matterport projects only:

1. Set server env `MATTERPORT_TOKEN_ID` + `MATTERPORT_TOKEN_SECRET` (Model API). Local: `.env`. Production Edge Function secrets for `matterport-tags`.
2. Super admin → POI panel → **Pending POIs** lists Matterport tags not yet accepted.
3. **Accept** creates a live NavMe POI at the tag XYZ (visible in VITM AR via `is_active`).
4. Project/sub-admins: **Add POI** opens Matterport Cloud Edit for that model.

Geometric mesh projects are unchanged.


```bash
git checkout feat/project-admin-rbac
git add -A && git commit -m "your message"
git push origin feat/project-admin-rbac
```
