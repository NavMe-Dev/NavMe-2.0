# Project Admin / Sub-admin RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Superadmin → one project admin per `poi_type` → many sub-admins, with sub-admins able to create all editor content but only see their own/assigned rows.

**Architecture:** New `navme_accounts` + `navme_project_members` tables; keep `navme_logins` as the project/map credential record. Auth via SECURITY DEFINER RPCs. Content tables gain `created_by` / `assigned_to`. Client session carries `accountId`, `role`, `poiType` and filters all fetches/inserts.

**Tech Stack:** Vite SPA, Supabase REST + Postgres RPCs (existing `verify_navme_superadmin` pattern), sessionStorage/localStorage sessions.

**Spec:** `docs/superpowers/specs/2026-08-12-project-admin-rbac-design.md`

## Global Constraints

- Exactly **one** active `project_admin` per `poi_type`.
- Each account has **at most one** active project membership (phase 1).
- Sub-admins use full editor tools; visibility = `created_by = me OR assigned_to = me`.
- Legacy rows with `created_by IS NULL` are project-owned (visible to project admin + superadmin only).
- Do **not** enable RLS on all `navme_*` tables in this plan (deferred).
- Password storage stays plain-text compatible with existing `navme_logins` / RPC style for phase 1.
- Prefer SECURITY DEFINER RPCs for membership mutations; do not expose raw INSERT on `navme_project_members` to anon beyond grants already used elsewhere.

---

## File map

| File | Responsibility |
|------|----------------|
| `supabase/migrations/20260812160000_navme_rbac_accounts.sql` | Tables, constraints, seed from `navme_logins` |
| `supabase/migrations/20260812161000_navme_rbac_ownership_columns.sql` | `created_by` / `assigned_to` on content tables |
| `supabase/migrations/20260812162000_navme_rbac_auth_rpcs.sql` | Auth + membership RPCs |
| `src/config/auth-session.js` | Unified dashboard session (account/role/poiType) |
| `src/services/supabase.js` | Client wrappers for new RPCs + ownership query helpers |
| `src/ui/form.js` | Login against new auth RPC |
| `src/ui/access-control-page.js` | Assign/replace project admin seat |
| `src/ui/team-panel.js` | Project-admin Team UI (sub-admins + assign) |
| `src/main.js` | Wire Team panel; pass account session into fetches |
| `src/ar/pois.js`, `media.js`, `facilities.js`, `categories.js`, `blocks` paths via `supabase.js` | Stamp + filter ownership |
| `src/config/superadmin.js` | Prefer DB `is_superadmin` after migration; keep fallback |

---

### Task 1: Schema — accounts + memberships + seed

**Files:**
- Create: `supabase/migrations/20260812160000_navme_rbac_accounts.sql`

**Interfaces:**
- Produces: tables `public.navme_accounts`, `public.navme_project_members` with constraints below

- [ ] **Step 1: Write migration SQL**

Create file `supabase/migrations/20260812160000_navme_rbac_accounts.sql` with:

```sql
-- NavMe RBAC: accounts + project memberships (one project_admin per poi_type)

CREATE TABLE IF NOT EXISTS public.navme_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password text NOT NULL,
  display_name text,
  is_superadmin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_accounts_email_unique UNIQUE (email)
);

CREATE UNIQUE INDEX IF NOT EXISTS navme_accounts_email_ci_idx
  ON public.navme_accounts (lower(trim(email)));

CREATE TABLE IF NOT EXISTS public.navme_project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.navme_accounts(id) ON DELETE CASCADE,
  poi_type text NOT NULL,
  role text NOT NULL CHECK (role IN ('project_admin', 'sub_admin')),
  created_by uuid REFERENCES public.navme_accounts(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One active membership per account
CREATE UNIQUE INDEX IF NOT EXISTS navme_project_members_one_active_account
  ON public.navme_project_members (account_id)
  WHERE is_active;

-- One active project_admin per poi_type
CREATE UNIQUE INDEX IF NOT EXISTS navme_project_members_one_project_admin
  ON public.navme_project_members (lower(trim(poi_type)))
  WHERE is_active AND role = 'project_admin';

CREATE INDEX IF NOT EXISTS navme_project_members_poi_type_idx
  ON public.navme_project_members (poi_type);

-- Seed superadmin account from existing login email if present
INSERT INTO public.navme_accounts (email, password, display_name, is_superadmin)
SELECT lower(trim(l.email)), l.password, 'Superadmin', true
FROM public.navme_logins l
WHERE lower(trim(l.email)) = 'superadmin@navme.space'
ON CONFLICT (email) DO UPDATE
SET is_superadmin = true,
    password = EXCLUDED.password,
    updated_at = now();

-- Seed each tenant login as project_admin for its poi_type
INSERT INTO public.navme_accounts (email, password, display_name, is_superadmin)
SELECT lower(trim(l.email)), l.password, split_part(l.email, '@', 1), false
FROM public.navme_logins l
WHERE lower(trim(l.email)) <> 'superadmin@navme.space'
  AND nullif(trim(l.poi_type), '') IS NOT NULL
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.navme_project_members (account_id, poi_type, role, is_active)
SELECT a.id, trim(l.poi_type), 'project_admin', true
FROM public.navme_logins l
JOIN public.navme_accounts a ON lower(trim(a.email)) = lower(trim(l.email))
WHERE lower(trim(l.email)) <> 'superadmin@navme.space'
  AND nullif(trim(l.poi_type), '') IS NOT NULL
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.navme_accounts TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.navme_project_members TO anon, authenticated;
```

Note: If `ON CONFLICT DO NOTHING` on members fails because there is no matching unique constraint covering the insert, use a `WHERE NOT EXISTS` insert instead:

```sql
INSERT INTO public.navme_project_members (account_id, poi_type, role, is_active)
SELECT a.id, trim(l.poi_type), 'project_admin', true
FROM public.navme_logins l
JOIN public.navme_accounts a ON lower(trim(a.email)) = lower(trim(l.email))
WHERE lower(trim(l.email)) <> 'superadmin@navme.space'
  AND nullif(trim(l.poi_type), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.navme_project_members m
    WHERE m.account_id = a.id AND m.is_active
  );
```

- [ ] **Step 2: Apply migration** to the metadigilabs Supabase project (CLI `supabase db push` or MCP `apply_migration` with the SQL body).

- [ ] **Step 3: Verify seed**

Run SQL:

```sql
SELECT role, count(*) FROM navme_project_members WHERE is_active GROUP BY role;
SELECT count(*) FROM navme_accounts WHERE is_superadmin;
SELECT poi_type, count(*) FILTER (WHERE role='project_admin' AND is_active)
FROM navme_project_members GROUP BY poi_type HAVING count(*) FILTER (WHERE role='project_admin' AND is_active) > 1;
```

Expected: `project_admin` count ≈ tenant logins; exactly 1 superadmin account; third query returns **0 rows**.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260812160000_navme_rbac_accounts.sql
git commit -m "Add navme_accounts and project memberships with one admin per poi_type."
```

---

### Task 2: Ownership columns on content tables

**Files:**
- Create: `supabase/migrations/20260812161000_navme_rbac_ownership_columns.sql`

**Interfaces:**
- Produces: nullable `created_by`, `assigned_to` on listed tables

- [ ] **Step 1: Write migration**

```sql
-- Ownership for RBAC visibility (nullable = legacy project-owned)

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'navme_pois',
    'navme_media',
    'navme_facilities',
    'navme_categories',
    'navme_blocks'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.navme_accounts(id) ON DELETE SET NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.navme_accounts(id) ON DELETE SET NULL',
      t
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (created_by)',
      t || '_created_by_idx', t
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (assigned_to)',
      t || '_assigned_to_idx', t
    );
  END LOOP;
END $$;
```

- [ ] **Step 2: Apply + verify**

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='navme_pois' AND column_name IN ('created_by','assigned_to');
```

Expected: both rows present.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260812161000_navme_rbac_ownership_columns.sql
git commit -m "Add created_by and assigned_to ownership columns for RBAC content."
```

---

### Task 3: Auth + membership RPCs

**Files:**
- Create: `supabase/migrations/20260812162000_navme_rbac_auth_rpcs.sql`
- Modify: `src/services/supabase.js` (add client wrappers after RPC exists)

**Interfaces:**
- Produces RPC return shapes used by client:

```ts
// authenticate_navme_account → one row:
{
  account_id: string
  email: string
  is_superadmin: boolean
  role: 'superadmin' | 'project_admin' | 'sub_admin' | null
  poi_type: string | null
  map_code: string | null
  client_id: string | null
  client_secret: string | null
  member_id: string | null
}

// admin_assign_project_admin(p_email, p_password, p_poi_type, p_admin_email, p_admin_password, p_display_name)
// → { account_id, member_id, poi_type, role }

// project_admin_upsert_sub_admin(p_email, p_password, p_sub_email, p_sub_password, p_display_name, p_active)
// → { account_id, member_id, poi_type, role }

// admin_list_project_members(p_email, p_password, p_poi_type)
// → rows { member_id, account_id, email, display_name, role, is_active }

// project_admin_assign_entity(p_email, p_password, p_table, p_row_id, p_assignee_account_id)
// p_table in ('navme_pois','navme_media','navme_facilities','navme_categories','navme_blocks')
```

- [ ] **Step 1: Implement RPCs in migration**

Include helper:

```sql
CREATE OR REPLACE FUNCTION public.verify_navme_account(p_email text, p_password text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  aid uuid;
BEGIN
  SELECT id INTO aid FROM public.navme_accounts
  WHERE lower(trim(email)) = lower(trim(p_email))
    AND password = p_password
    AND is_active
  LIMIT 1;
  RETURN aid;
END;
$$;
```

`authenticate_navme_account`:
- Verify account password.
- If `is_superadmin` → return role `superadmin`, null poi_type/map.
- Else load active membership; join `navme_logins` on `poi_type` for map credentials.
- Raise if no membership.

`admin_assign_project_admin`:
- `verify_navme_superadmin`.
- Upsert account for admin email/password.
- Deactivate any existing active `project_admin` for that `poi_type`.
- Deactivate any other active membership for that account.
- Insert active `project_admin` membership.

`project_admin_upsert_sub_admin`:
- Verify caller is active `project_admin` for some `poi_type` (via `verify_navme_account` + members lookup).
- Create/update sub account; membership role `sub_admin` on **caller’s** `poi_type` only.
- Reject if target email is already project_admin elsewhere.

`admin_list_project_members`:
- Superadmin: any `poi_type`.
- Project admin: only their own `poi_type`.

`project_admin_assign_entity`:
- Caller must be project_admin for row’s `poi_type`.
- Assignee must be active `sub_admin` on same `poi_type`.
- `UPDATE` set `assigned_to`.

Grant `EXECUTE` to `anon`, `authenticated`, `PUBLIC` (match existing admin RPCs).

- [ ] **Step 2: Apply migration**

- [ ] **Step 3: Smoke-test RPCs via SQL**

```sql
SELECT * FROM authenticate_navme_account('superadmin@navme.space', 'Superadmin');
-- expect is_superadmin true

-- pick a known tenant email from navme_accounts / members and test login
```

- [ ] **Step 4: Add JS wrappers in `src/services/supabase.js`**

```js
export async function authenticateNavmeAccount({ email, password }) { /* rpc POST */ }
export async function adminAssignProjectAdmin({ email, password, poiType, adminEmail, adminPassword, displayName }) {}
export async function projectAdminUpsertSubAdmin({ email, password, subEmail, subPassword, displayName, active = true }) {}
export async function adminListProjectMembers({ email, password, poiType }) {}
export async function projectAdminAssignEntity({ email, password, table, rowId, assigneeAccountId }) {}
```

Use the same `fetch(.../rpc/...)` pattern as `authenticateLoginNavme`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260812162000_navme_rbac_auth_rpcs.sql src/services/supabase.js
git commit -m "Add RBAC auth and membership SECURITY DEFINER RPCs."
```

---

### Task 4: Client auth session module

**Files:**
- Create: `src/config/auth-session.js`
- Modify: `src/config/poi-session.js` (keep setters; call from auth-session)
- Modify: `src/config/superadmin.js` (optional bridge)

**Interfaces:**
- Produces:

```js
/** @typedef {{ accountId: string, email: string, password: string, role: 'superadmin'|'project_admin'|'sub_admin', poiType: string|null, mapCode: string|null, memberId: string|null }} AuthSession */

export function setAuthSession(session) {}
export function getAuthSession() {} // null if missing
export function clearAuthSession() {}
export function getAuthAccountId() {}
export function getAuthRole() {}
export function isProjectAdminSession() {}
export function isSubAdminSession() {}
export function ownershipFilterParams() {}
// returns '' for project_admin/superadmin-in-project;
// for sub_admin: `&or=(created_by.eq.${id},assigned_to.eq.${id})`
```

- [ ] **Step 1: Implement `auth-session.js`** storing JSON in `localStorage` key `navme_auth_session` (and keep writing `poi-session` + project session fields needed by MultiSet).

When setting a project session, also call existing `setPoiSession({ poiType, mapCode, organizationId })`.

- [ ] **Step 2: Implement `ownershipFilterParams()`** exactly as interface above. For legacy-safe sub-admin lists, do **not** include null `created_by` rows.

- [ ] **Step 3: Syntax check**

```bash
node --check src/config/auth-session.js
```

Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add src/config/auth-session.js src/config/poi-session.js
git commit -m "Add unified auth session with ownership filter helpers."
```

---

### Task 5: Wire login to new auth RPC

**Files:**
- Modify: `src/ui/form.js`
- Modify: `src/main.js` (session restore path)

**Interfaces:**
- Consumes: `authenticateNavmeAccount`, `setAuthSession`, `setSuperadminSession`

- [ ] **Step 1: Update login handler**

Flow:
1. Call `authenticateNavmeAccount`.
2. If `is_superadmin` / role `superadmin` → `setSuperadminSession` + `setAuthSession` → redirect `/access`.
3. Else require `poi_type` + map credentials → `setAuthSession` + existing MultiSet token fetch → `/`.
4. Keep temporary fallback: if new RPC missing, fall back to `authenticateLoginNavme` (log warning) so deploys without migration don’t hard-brick — remove fallback in a later cleanup commit once RPC is live everywhere.

- [ ] **Step 2: Update `main.js` restore** to prefer `getAuthSession()` then re-auth with stored email/password via `authenticateNavmeAccount`.

- [ ] **Step 3: Manual test**

- Login as seeded project admin → editor opens for their `poi_type`.
- Login as superadmin → `/access`.

- [ ] **Step 4: Commit**

```bash
git add src/ui/form.js src/main.js
git commit -m "Route dashboard login through navme account RBAC auth."
```

---

### Task 6: Superadmin UI — assign project admin

**Files:**
- Modify: `src/ui/access-control-page.js`
- Modify: `src/styles/access-control.css` (minimal styles for new controls)

**Interfaces:**
- Consumes: `adminAssignProjectAdmin`, `adminListProjectMembers`, `getSuperadminSession`

- [ ] **Step 1: Per project card, add “Project admin” block**

UI elements:
- Current admin email (from `adminListProjectMembers` filtered `role=project_admin`)
- Inputs: admin email, password, display name
- Button: **Assign / replace project admin**
- List sub-admins (email + active flag)

- [ ] **Step 2: Wire assign button** to `adminAssignProjectAdmin` with superadmin session credentials + card `poi_type`. On success refresh members list; toast success/error.

- [ ] **Step 3: Manual test on `/access`**

- Assign admin to a test `poi_type`.
- Attempt second different admin → previous deactivated, new one active (only one).
- Login as that admin works.

- [ ] **Step 4: Commit**

```bash
git add src/ui/access-control-page.js src/styles/access-control.css
git commit -m "Allow superadmin to assign one project admin per poi_type."
```

---

### Task 7: Project admin Team panel (sub-admins)

**Files:**
- Create: `src/ui/team-panel.js`
- Modify: `src/ui/dashboard.js` (nav item when `project_admin`)
- Modify: `src/main.js` (mount panel)

**Interfaces:**
- Consumes: `projectAdminUpsertSubAdmin`, `adminListProjectMembers`, `getAuthSession`
- Produces: `createTeamPanel(container, { onChange })`

- [ ] **Step 1: Build Team panel UI**

- List sub-admins for session `poiType`
- Form: email, password, display name → create
- Toggle active / disable

Only render nav entry when `getAuthRole() === 'project_admin'` (superadmin uses `/access`; sub-admin does not see Team).

- [ ] **Step 2: Wire into dashboard + main**

- [ ] **Step 3: Manual test**

- As project admin, create 2 sub-admins.
- Each can log in to same `poi_type`.

- [ ] **Step 4: Commit**

```bash
git add src/ui/team-panel.js src/ui/dashboard.js src/main.js
git commit -m "Add project-admin Team panel for sub-admin management."
```

---

### Task 8: Ownership on POI / media / facility CRUD

**Files:**
- Modify: `src/services/supabase.js` (`fetchAllPois`, insert/update helpers, media, facilities)
- Modify: `src/ar/pois.js`, `src/ar/media.js`, `src/ar/facilities.js` if inserts bypass supabase helpers

**Interfaces:**
- Consumes: `getAuthAccountId()`, `getAuthRole()`, `ownershipFilterParams()`
- On insert body: always set `created_by: getAuthAccountId()` when account id present
- On fetch: append `ownershipFilterParams()` for `sub_admin`

- [ ] **Step 1: Add helper**

```js
function withOwnershipInsert(body) {
  const id = getAuthAccountId();
  if (!id) return body;
  return { ...body, created_by: id };
}

function withOwnershipQuery(path) {
  const extra = ownershipFilterParams();
  return extra ? `${path}${extra}` : path;
}
```

- [ ] **Step 2: Apply to pois/media/facilities fetch + insert**

- [ ] **Step 3: Manual test**

- Sub-admin A creates POI + facility + media → visible to A.
- Sub-admin B does not see A’s rows.
- Project admin sees both.
- Legacy null `created_by` rows visible to project admin, not to sub-admins.

- [ ] **Step 4: Commit**

```bash
git add src/services/supabase.js src/ar/pois.js src/ar/media.js src/ar/facilities.js
git commit -m "Enforce sub-admin ownership filters on POIs, media, and facilities."
```

---

### Task 9: Ownership on categories + blocks (+ assign action)

**Files:**
- Modify: `src/services/supabase.js` (categories/blocks)
- Modify: `src/ui/team-panel.js` or entity panels — **Assign to sub-admin** action for project admin

**Interfaces:**
- Consumes: `projectAdminAssignEntity`

- [ ] **Step 1: Same ownership filter/stamp for categories and blocks**

- [ ] **Step 2: Project admin “Assign” control**

From POI (and optionally media/facility) selection when role is project_admin:
- Dropdown of active sub-admins
- Call `projectAdminAssignEntity({ table: 'navme_pois', rowId, assigneeAccountId })`
- After assign, sub-admin should see the row

- [ ] **Step 3: Manual test assign handoff**

- [ ] **Step 4: Commit**

```bash
git add src/services/supabase.js src/ui/team-panel.js src/ui/poi-panel.js
git commit -m "Extend ownership to categories/blocks and allow assign-to-sub-admin."
```

---

### Task 10: Acceptance pass + spec checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-project-admin-rbac-design.md` (check acceptance boxes when verified)

- [ ] **Step 1: Run acceptance criteria from the spec** (section 8) end-to-end on a staging project.

Checklist (must all pass):

1. Superadmin assigns exactly one project admin to an existing `poi_type`.
2. Second assign replaces/deactivates previous (never two active).
3. Project admin creates multiple sub-admins for their `poi_type` only.
4. Sub-admin creates POI, media, facility (and category/block if gated on).
5. Sub-admin lists only own/assigned rows.
6. Project admin sees all rows for that `poi_type`.
7. Superadmin sees all projects.
8. Project admin A cannot open/see project B.
9. Legacy null-`created_by` hidden from sub-admins until assigned.

- [ ] **Step 2: Mark criteria checked in the spec file**

- [ ] **Step 3: Final commit + push**

```bash
git add docs/superpowers/specs/2026-08-12-project-admin-rbac-design.md
git commit -m "Record RBAC acceptance verification against the design spec."
git push
```

---

## Spec coverage self-review

| Spec requirement | Task |
|------------------|------|
| One project admin per poi_type | Task 1 unique index + Task 3/6 assign RPC |
| Many sub-admins same poi_type | Task 3/7 |
| Sub-admin creates all editor content | Task 8–9 (tools unchanged; ownership stamped) |
| Sub-admin sees only own/assigned | Task 4 filter + Task 8–9 |
| Project admin sees all in poi_type | Task 4 (no ownership filter) |
| Superadmin assigns existing poi_type | Task 6 |
| Legacy null created_by behavior | Task 2 + Task 8 tests |
| Keep navme_logins for map creds | Task 3 auth join |
| RLS deferred | Explicit non-goal; no RLS task |

## Placeholder scan

No TBD/TODO steps; RPC shapes and file paths specified.

## Type consistency

- Roles: `'superadmin' | 'project_admin' | 'sub_admin'` everywhere.
- Session field: `accountId` (client) ↔ `account_id` (RPC).
- Membership roles in DB: only `project_admin` | `sub_admin` (superadmin is account flag, not a member row).
