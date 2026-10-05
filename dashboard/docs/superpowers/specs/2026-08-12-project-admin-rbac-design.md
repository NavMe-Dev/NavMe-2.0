# NavMe project admin / sub-admin RBAC design

**Date:** 2026-08-12  
**Status:** Approved for planning (Approach 1)  
**Scope:** Dashboard multi-tenant roles on top of existing `poi_type` tenancy

---

## 1. Goal

Give every `poi_type` (project/tenant) a **project admin** who can create **sub-admins**. Sub-admins edit content inside that project but only see their own work. Superadmin sees everything and assigns existing `poi_type`s to project admins.

### Non-goals (this phase)

- Multiple project admins per `poi_type`
- One account belonging to multiple `poi_type`s
- End-user / AR app roles (`navme_users`)
- Full Postgres RLS rollout on every `navme_*` table (noted as follow-up; anon key currently has broad access)

---

## 2. Role hierarchy

```text
Superadmin
  └── Project admin  (exactly one per poi_type)
        └── Sub-admin × N  (all share that same poi_type)
```

| Role | Project scope | Content visibility | Capabilities |
|------|---------------|--------------------|--------------|
| **Superadmin** | All `poi_type`s | All rows | Manage projects on `/access`; assign/replace project admin; open any project; feature/language/map controls |
| **Project admin** | Exactly one `poi_type` | All content in that `poi_type` | Create/manage sub-admins; create/edit all editor content; cannot access other projects |
| **Sub-admin** | Same `poi_type` as their project admin | Only rows they **created** or were **assigned** | Full editor tools (POIs, media, facilities, categories, blocks, stairs, etc.) on their rows only |

### Visibility rules

1. Sub-admin A never sees Sub-admin B’s rows (unless assigned).
2. Project admin sees every row for their `poi_type` (including all sub-admins’ work).
3. Superadmin sees every `poi_type`.
4. Legacy rows with `created_by IS NULL` are **project-owned**: visible to project admin + superadmin; hidden from sub-admins until assigned.

---

## 3. Data model

### 3.1 `navme_accounts`

Identity for dashboard logins (replaces “one email = one login row” as the source of truth).

| Column | Type | Notes |
|--------|------|--------|
| `id` | uuid PK | |
| `email` | text unique | ci-normalized |
| `password` | text | Phase 1: match existing plain-text style used by `navme_logins` / RPCs; hash migration later |
| `display_name` | text nullable | |
| `is_superadmin` | boolean default false | Prefer DB flag over hardcoded JS password long-term |
| `is_active` | boolean default true | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### 3.2 `navme_project_members`

| Column | Type | Notes |
|--------|------|--------|
| `id` | uuid PK | |
| `account_id` | uuid → `navme_accounts` | |
| `poi_type` | text | Tenant key (same string as today) |
| `role` | text check (`project_admin` \| `sub_admin`) | |
| `created_by` | uuid nullable → `navme_accounts` | Who assigned them |
| `is_active` | boolean default true | |
| `created_at` | timestamptz | |

**Constraints**

- `UNIQUE (account_id)` where `is_active` — one person → one project membership (this phase).
- `UNIQUE (poi_type)` where `role = 'project_admin' AND is_active` — **one project admin per `poi_type`**.
- Sub-admins: many rows with same `poi_type`, role `sub_admin`.

### 3.3 Content ownership columns

Add to editor content tables (minimum set for phase 1):

- `navme_pois`
- `navme_media`
- `navme_facilities`
- `navme_categories`
- `navme_blocks`
- (treasure / floor edits: same pattern in a follow-up if needed)

| Column | Type | Notes |
|--------|------|--------|
| `created_by` | uuid nullable → `navme_accounts.id` | Set on insert from session |
| `assigned_to` | uuid nullable → `navme_accounts.id` | Optional handoff to a sub-admin |

**Visibility predicate (sub-admin):**

```sql
poi_type = session_poi_type
AND (
  created_by = session_account_id
  OR assigned_to = session_account_id
)
```

**Visibility predicate (project admin / superadmin in project):**

```sql
poi_type = session_poi_type
```

### 3.4 Relationship to `navme_logins`

Keep `navme_logins` for **project map credentials** (`map_code`, `client_id`, `client_secret`) and backward compatibility during migration.

- One `navme_logins` row per `poi_type` remains the “project record” used by `/access` for MultiSet/Matterport keys + features.
- Dashboard people authenticate via `navme_accounts` + `navme_project_members`.
- Migration: for each existing `navme_logins` (except superadmin email), create `navme_accounts` + `project_admin` membership for that `poi_type`.

---

## 4. Auth & session

### Session shape (client)

```ts
{
  accountId: string
  email: string
  role: 'superadmin' | 'project_admin' | 'sub_admin'
  poiType: string | null      // null only for superadmin on /access
  mapCode: string | null
  organizationId: string
}
```

### Login flow

1. User submits email/password.
2. If `is_superadmin` → set superadmin session → `/access` (unchanged UX).
3. Else load active `navme_project_members` row → require exactly one → set editor session for that `poi_type` → load map credentials from `navme_logins` for that `poi_type` → open `/`.
4. All fetches stamp/filter with session `poiType` + ownership for `sub_admin`.

### RPC surface (SECURITY DEFINER)

Prefer RPCs so anon key cannot freely rewrite memberships:

| RPC | Caller | Purpose |
|-----|--------|---------|
| `authenticate_navme_account` | public | Login → account + membership + map fields |
| `admin_assign_project_admin` | superadmin | Bind/replace project admin for a `poi_type` |
| `admin_list_project_members` | superadmin / project admin | List team for a `poi_type` |
| `project_admin_upsert_sub_admin` | project admin | Create/update/disable sub-admin in own `poi_type` |
| `project_admin_assign_entity` | project admin | Set `assigned_to` on a row in own `poi_type` |

Verify actor via password/session token pattern already used (`verify_navme_superadmin` style), then evolve to safer auth later.

---

## 5. UI

### Superadmin `/access`

- Existing project grid unchanged (features, languages, splat/Matterport, Login to project).
- Per project card:
  - **Project admin** seat: assign / replace (email + password create-or-link).
  - Read-only (or removable) **sub-admin list**.

### Project admin (editor)

- New **Team** panel:
  - Create sub-admin (email, password, display name).
  - Disable / remove sub-admin.
  - Assign selected content to a sub-admin (`assigned_to`).
- Full content lists for the `poi_type`.

### Sub-admin (editor)

- Same chrome/tools gated by `navme_project_features`.
- Lists filtered to owned/assigned rows only.
- Inserts set `created_by = session.accountId`.

---

## 6. Enforcement layers

| Layer | Phase 1 | Follow-up |
|-------|---------|-----------|
| Client filters | Required | Keep as UX |
| SECURITY DEFINER RPCs for memberships | Required | Keep |
| Content CRUD via scoped queries (`poi_type` + ownership) | Required | Keep |
| Postgres RLS on `navme_*` | Deferred | Enable carefully with policies matching this model |

**Security note:** Many `navme_*` tables currently have RLS disabled. Phase 1 must not pretend DB is locked; ship RPC + server-side filters first, then RLS.

---

## 7. Migration plan

1. Create `navme_accounts` + `navme_project_members`.
2. Seed superadmin account (`is_superadmin = true`) from existing superadmin login.
3. For each `navme_logins` tenant row → account + `project_admin` membership.
4. Add `created_by` / `assigned_to` nullable columns to content tables (no backfill required).
5. Ship new auth RPC; dual-read old `authenticate_login_navme` during rollout if needed.
6. Update `/access` + editor Team panel + fetch filters.
7. Remove hardcoded superadmin password from client once DB flag + RPC are trusted.

---

## 8. Acceptance criteria

- [ ] Superadmin can assign exactly one project admin to an existing `poi_type`.
- [ ] Assigning a second project admin to the same `poi_type` replaces or is rejected (no two active).
- [ ] Project admin can create multiple sub-admins for their `poi_type` only.
- [ ] Sub-admin can create POIs, media, facilities, and other editor entities.
- [ ] Sub-admin lists only their created/assigned rows.
- [ ] Project admin sees all rows for that `poi_type`.
- [ ] Superadmin sees all projects and all rows.
- [ ] Project admin of A cannot see project B’s data.
- [ ] Legacy null-`created_by` rows visible to project admin/superadmin, not to sub-admins until assigned.

---

## 9. Open follow-ups (out of phase 1)

- Password hashing + session tokens instead of storing password in `sessionStorage`.
- RLS policies for all `navme_*` tables.
- Optional: assign subsets of feature flags per sub-admin.
- Treasure / floor-editor ownership columns.
- Multiple projects per account (explicitly rejected for phase 1).
