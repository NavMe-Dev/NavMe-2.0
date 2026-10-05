# Matterport Pending POI Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Matterport projects only, super admins review Pending Matterport tags and Accept them into live NavMe POIs; other admins’ Add POI opens Matterport Cloud Edit.

**Architecture:** Server-side Model API proxy (Vite middleware + env secrets) lists tags and accepts them into `navme_pois` with `matterport_tag_id`. Pending = API tags minus accepted ids. UI gates are Matterport-active + superadmin vs project/sub-admin.

**Tech Stack:** Vite 6, Supabase REST, Matterport Model API GraphQL, existing `poi-panel.js` / `matterport-map.js`.

## Global Constraints

- Matterport projects only (`isMatterportMapActive()` / active matterport media). Mesh projects unchanged.
- Secrets: `MATTERPORT_TOKEN_ID`, `MATTERPORT_TOKEN_SECRET` server-only (never `VITE_*`).
- Accept sets `is_active=true` so VITM AR (`is_active=eq.true`) shows the POI.
- Do not embed Matterport Edit in the iframe; open `https://my.matterport.com/models/{modelId}`.

---

### Task 1: Migration + env docs

**Files:**
- Create: `supabase/migrations/20260907180000_navme_pois_matterport_tag_approval.sql`
- Modify: `.env.example` (document server env vars only)
- Apply via Supabase MCP `apply_migration`

**Steps:**

- [ ] **Step 1: Write migration SQL**

```sql
ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS matterport_tag_id text,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'accepted';

COMMENT ON COLUMN public.navme_pois.matterport_tag_id IS
  'Matterport Mattertag id when POI was accepted from a space tag';
COMMENT ON COLUMN public.navme_pois.approval_status IS
  'accepted | rejected. Pending tags are not rows until accept.';

CREATE UNIQUE INDEX IF NOT EXISTS navme_pois_matterport_tag_id_uidx
  ON public.navme_pois (matterport_tag_id)
  WHERE matterport_tag_id IS NOT NULL;
```

- [ ] **Step 2: Apply migration** via `apply_migration` name `navme_pois_matterport_tag_approval`

- [ ] **Step 3: Document env in `.env.example`**

```
# Server-only Matterport Model API (Vite middleware / Render). Never prefix with VITE_.
# MATTERPORT_TOKEN_ID=
# MATTERPORT_TOKEN_SECRET=
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260907180000_navme_pois_matterport_tag_approval.sql .env.example docs/superpowers/specs/2026-09-07-matterport-pending-poi-approval-design.md
git commit -m "Add matterport_tag_id approval columns for pending Matterport tags."
```

---

### Task 2: Matterport Model API server helpers + Vite routes

**Files:**
- Create: `server/matterport-model-api.js` (Node ESM helpers used by Vite plugin)
- Modify: `vite.config.js` — add plugin registering:
  - `GET /api/matterport/tags?modelId=&poiType=`
  - `POST /api/matterport/accept-tag`

**Interfaces:**
- Produces: `listModelMattertags(modelId)`, `getAcceptedMatterportTagIds(poiType)`, `acceptMatterportTag({ modelId, poiType, tagId, label, description, categoryIds })`
- Consumes: env `MATTERPORT_TOKEN_ID`, `MATTERPORT_TOKEN_SECRET`; Supabase service or anon+RLS via existing URL/key from `.env` (`VITE_SUPABASE_URL`, prefer `SUPABASE_SERVICE_ROLE_KEY` if set else anon for local)

**Steps:**

- [ ] **Step 1: Implement `server/matterport-model-api.js`**

```js
export function matterportAuthHeader() {
  const id = process.env.MATTERPORT_TOKEN_ID || '';
  const secret = process.env.MATTERPORT_TOKEN_SECRET || '';
  if (!id || !secret) throw new Error('MATTERPORT_TOKEN_ID / MATTERPORT_TOKEN_SECRET not configured');
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

export async function fetchModelMattertags(modelId) {
  const res = await fetch('https://api.matterport.com/api/models/graph', {
    method: 'POST',
    headers: {
      Authorization: matterportAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `query($id: ID!) { model(id: $id) { id name mattertags { id label description enabled anchorPosition { x y z } } } }`,
      variables: { id: modelId },
    }),
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message || 'Matterport API error');
  return data.data?.model?.mattertags || [];
}
```

Plus helpers to query Supabase REST for accepted tag ids and insert POI on accept (use service role if available).

- [ ] **Step 2: Wire Vite middleware** in `vite.config.js` that loads dotenv from `__dirname` for `MATTERPORT_*` and handles the two routes; JSON responses; CORS `*`.

- [ ] **Step 3: Manual smoke**

```bash
# With tokens in env:
curl -s "http://localhost:3001/api/matterport/tags?modelId=fXEtkfPQDR7&poiType=VITM" | head
```

Expected: JSON with `pending` array length ≥ 0.

- [ ] **Step 4: Commit**

```bash
git add server/matterport-model-api.js vite.config.js
git commit -m "Add Matterport Model API proxy for pending tags and accept."
```

---

### Task 3: Client service + normalize POI fields

**Files:**
- Create: `src/services/matterport-pending-api.js`
- Modify: `src/ar/pois.js` — `normalizePoiRow` include `matterport_tag_id`, `approval_status`
- Modify: `src/ar/media.js` or export helper `getActiveMatterportModelId()` using `getActiveMatterportUrl` + `parseMatterportModelId`

**Interfaces:**
- Produces:
  - `fetchPendingMatterportTags({ modelId, poiType }) → { pending, acceptedTagIds }`
  - `acceptMatterportTag(body) → poi row`
  - `openMatterportEditForModel(modelId)`
  - `getActiveMatterportModelId()`

- [ ] **Step 1: Implement client wrappers** calling `/api/matterport/*`

- [ ] **Step 2: Extend normalizePoiRow**

```js
matterport_tag_id: row.matterport_tag_id != null ? String(row.matterport_tag_id) : null,
approval_status: String(row.approval_status || 'accepted'),
```

- [ ] **Step 3: Commit**

---

### Task 4: Super admin Pending / All UI + Accept

**Files:**
- Modify: `src/ui/poi-panel.js`
- Modify: `src/styles/` (minimal tabs + pending row styles in existing POI CSS file)

**Behavior:**
- If `isMatterportMapActive()` && (`hasSuperadminSession()` || `getAuthSession()?.role === 'superadmin'`):
  - Show tabs All | Pending
  - Pending: load tags for `getActiveMatterportModelId()` + `getPoiType()`
  - Accept button → POST accept → `poisData` push / reload → rebuildList; switch to All
- If not Matterport: no tabs (unchanged list)

- [ ] **Step 1: Add tab UI + pending list renderer**

- [ ] **Step 2: Wire Accept** with toast success/error

- [ ] **Step 3: Manual test on localhost with VITM Matterport project as superadmin

- [ ] **Step 4: Commit**

---

### Task 5: Non–super-admin Add POI → Matterport Edit (Matterport only)

**Files:**
- Modify: `src/ui/poi-panel.js` — header Add POI / `onStartAddPoi` path
- Modify: `src/main.js` and/or `src/ui/scene-toolbar.js` — `add-poi` tool when Matterport active and not superadmin

**Behavior:**
```js
function shouldRedirectAddPoiToMatterportEdit() {
  return isMatterportMapActive() && !isSuperAdminEditor();
}
function redirectToMatterportEdit() {
  const modelId = getActiveMatterportModelId();
  if (!modelId) { showToast('No Matterport model for this project', 'error'); return; }
  window.open(`https://my.matterport.com/models/${modelId}`, '_blank', 'noopener,noreferrer');
  showToast('Add tags in Matterport Edit — super admin will see them under Pending', 'info');
}
```

- [ ] **Step 1: Gate toolbar + panel add buttons**

- [ ] **Step 2: Verify mesh projects still use normal Add POI**

- [ ] **Step 3: Commit**

---

### Task 6: Local env + Render notes + smoke

**Files:**
- Modify: `docs/BRANCHES.md` short note on Matterport pending + env vars
- Local: set `MATTERPORT_TOKEN_ID` / `MATTERPORT_TOKEN_SECRET` in shell or `.env` (gitignored) for Vite `loadEnv`

- [ ] **Step 1: Restart Vite with tokens; accept one pending tag; confirm POI in list and `is_active`**

- [ ] **Step 2: Push branch when user provides token / asks**

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Matterport-only | 4, 5 |
| All / Pending UI | 4 |
| Pending = API − accepted | 2, 3 |
| Accept → POI + hide pending | 2, 4 |
| Add POI → Matterport Edit | 5 |
| Secrets server-only | 2, 6 |
| VITM is_active | 2 accept insert |
| Unique matterport_tag_id | 1 |
