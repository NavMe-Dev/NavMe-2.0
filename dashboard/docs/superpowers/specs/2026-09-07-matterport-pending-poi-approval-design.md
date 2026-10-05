# Matterport pending tags → NavMe POI approval

**Date:** 2026-09-07  
**Status:** Approved for implementation (pending final spec review)  
**Branch:** `feat/project-admin-rbac`  
**Related:** VITM Matterport model `fXEtkfPQDR7`, VITM Production AR (`is_active=eq.true`)

## Problem

Project / sub-admins currently place NavMe POIs directly in the dashboard. Super admins need a review gate. Matterport’s native **Add Tag / Add Media Element** editor cannot be embedded in our Showcase iframe; it lives on Matterport Cloud Edit.

**Scope: Matterport projects only.** Geometric / MultiSet mesh projects keep today’s Add POI / media / facility tools unchanged. Pending tags, Accept, and “Add POI → Matterport Edit” apply only when the active project map is a Matterport space.

## Goals

1. **Super admin** sees **All POIs** and **Pending POIs** in the POI list panel.
2. **Pending** lists Matterport space tags that are not yet accepted as NavMe POIs.
3. **Accept** creates a NavMe POI at the tag’s exact XYZ, shows it under All POIs, removes it from Pending, and makes it visible in VITM AR.
4. **Non–super-admins:** **Add POI** opens Matterport Cloud **Edit** for that project’s model (new tab) instead of our place-POI flow.
5. Tags they create there appear under Pending for super admin (via Model API).

## Non-goals (v1)

- Embedding Matterport Edit inside the NavMe iframe (not supported).
- Full “adjust XYZ then accept” UI beyond editing the new POI after accept (v1: accept at tag XYZ; super admin can then move the POI with existing tools).
- Syncing NavMe POI edits back into Matterport tags.
- Deleting Matterport tags on accept (tag stays in Matterport; only hidden from Pending).

## Roles

| Role | Add POI behavior | Sees Pending | Can Accept |
|------|------------------|--------------|------------|
| Super admin (`/access` session or designated superadmin) | Existing tools OK; also uses Pending / Accept | Yes | Yes |
| Project admin / sub-admin | **Add POI** → open Matterport Edit URL | No (or read-only later; v1: no) | No |

Detection: reuse existing `hasSuperadminSession` / access-control patterns; Matterport pending UI is for super admin only.

## Data model

### Migration on `navme_pois`

```sql
ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS matterport_tag_id text,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'accepted';

-- accepted | rejected (pending is “Matterport tag with no accepted row”)
CREATE UNIQUE INDEX IF NOT EXISTS navme_pois_matterport_tag_id_uidx
  ON public.navme_pois (matterport_tag_id)
  WHERE matterport_tag_id IS NOT NULL;
```

- Existing POIs: `approval_status = 'accepted'`, `matterport_tag_id` null.
- Accept: insert POI with `matterport_tag_id`, `approval_status = 'accepted'`, `is_active = true`, `show_in_ar = true`, `pos_*` / `expected_pos_*` from tag anchor.
- VITM AR: keep `is_active=eq.true` (no VITM code change required if Accept sets `is_active`).

### Optional mapping note

Pending items are **not** stored as POI rows until Accept. Pending = Matterport Model API tags − tags whose `id` appears on an accepted `navme_pois.matterport_tag_id` for that `poi_type`.

## Matterport credentials

| Key | Use | Storage |
|-----|-----|---------|
| SDK key (`VITE_MATTERPORT_SDK_KEY`) | Showcase iframe (existing) | Vite env (public) |
| Model API Token ID + Secret | List tags, (future mutations) | **Server only** — `MATTERPORT_TOKEN_ID`, `MATTERPORT_TOKEN_SECRET` on Render / Vite server middleware. Never `VITE_*`, never git. |

Auth to Model API: HTTP Basic `base64(tokenId:tokenSecret)` → `POST https://api.matterport.com/api/models/graph`.

## Server API (dashboard)

Add Vite (and production-equivalent) endpoints:

1. `GET /api/matterport/tags?modelId=…&poiType=…`  
   - Proxies Model API `model { mattertags { id label description enabled anchorPosition { x y z } } }`  
   - Loads accepted `matterport_tag_id`s for that `poi_type`  
   - Returns `{ pending: [...], acceptedTagIds: [...] }` where `pending` excludes accepted ids.

2. `POST /api/matterport/accept-tag`  
   Body: `{ modelId, poiType, tagId, label?, categoryIds?, description? }`  
   - Re-fetches tag XYZ from Model API (trust server, not client)  
   - Inserts `navme_pois` with ownership/org fields as today  
   - Returns created POI row  

Production: same routes via Vite SSR plugin if hosted on Node, or a thin Supabase Edge Function with secrets. Prefer one implementation shared with local Vite plugin for parity.

## UI

### Super admin — `#poi-list-panel`

- Segmented control: **All POIs** | **Pending POIs**.
- **All POIs:** current list (`poisData`), optionally badge if linked to a Matterport tag.
- **Pending POIs:** fetch `/api/matterport/tags`; rows show label, short XYZ, **Accept**.
- Accept → optional quick dialog (name override, category/icon) → POST accept → refresh lists → toast.
- Refresh Pending when opening the tab / after returning from Matterport.

### Non–super-admin — Add POI

- **Only when Matterport map is active** for the project:
  - Toolbar / panel **Add POI** redirects to Matterport Cloud Edit:
    - Resolve project Matterport model id from current matterport media / project setting.
    - `window.open(`https://my.matterport.com/models/${modelId}`, '_blank')`.
  - Do **not** open our add-POI dialog for these roles on Matterport projects.
- **Geometric mesh / non-Matterport projects:** unchanged — existing place-POI flow for all roles.

### Matterport map iframe

- Continue hiding space-authored tags in Showcase for normal view (existing session `Tag.remove`).
- Pending list is **API-driven**, not Showcase-driven, so super admin still sees Pending even if pins are hidden in the iframe.

## VITM Production

- No change if Accept sets `is_active=true`.
- Verify `fetchNavmePois` still uses `is_active=eq.true`.
- Do not insert pending rows into `navme_pois` before Accept.

## Acceptance criteria

- [ ] Super admin can switch All / Pending in POI panel.
- [ ] Pending shows current Matterport tags for VITM model minus accepted ones (e.g. Engine Hall, Science on a Sphere, …).
- [ ] Accept creates POI at tag XYZ; POI appears in All; tag disappears from Pending; AR shows it after refresh.
- [ ] Project/sub-admin Add POI opens Matterport Edit in a new tab on Matterport projects.
- [ ] API secrets never shipped to the browser or committed.
- [ ] Duplicate Accept of same `matterport_tag_id` is rejected (unique index).

## Risks / mitigations

| Risk | Mitigation |
|------|------------|
| Model API rate limits / auth failure | Clear toast; cache last pending list briefly |
| Admin not logged into Matterport in new tab | Document that Matterport login is required |
| Tag XYZ vs NavMe mesh coordinates | Use Matterport tag XYZ as source of truth for Matterport projects (same as today’s Showcase tags) |
| Secrets pasted in chat | Rotate tokens; store only in host env |

## Implementation order

1. Migration + env docs  
2. Server proxy: list tags + accept  
3. Super admin Pending / All UI + Accept  
4. Gate non–super-admin Add POI → Matterport Edit  
5. Smoke-test VITM AR visibility after Accept  
