# NavMe Profile section design

**Date:** 2026-08-14  
**Status:** Approved for planning  
**Scope:** Replace sidebar **User logs** with **Profile**; self-service account editing; Activity (logs) scoped by role. Partner Key/Secret is **deferred**.

---

## 1. Goal

Give every logged-in dashboard account a **Profile** home where they can:

1. Update **their own** account (display name, email, password).
2. View **activity** that belongs to them or their project, depending on role.

### Navigation rule (explicit)

- Sidebar shows **Profile** only — **no** separate **User logs** item.
- **User logs** exists **only inside Profile** (as the Activity / User logs section), never as its own sidebar destination on the main dashboard.

### Non-goals (this phase)

- Partner / NavMe Key + Secret generation and shareable scoped links (follow-up under Profile → Partner access).
- Changing existing table column types, rename, or drop on `navme_accounts`, `navme_project_members`, `navme_user_logs`, or `navme_logins`.
- Password hashing migration (keep current plaintext storage style used by existing RPCs).
- Superadmin `/access` global/project log feeds (unchanged — those are not the dashboard sidebar User logs).
- Letting sub-admins see the project owner’s account fields or other users’ activity.
- Putting User logs back in the sidebar as a sibling of Profile.

---

## 2. Role matrix

| Role | Sidebar | Inside Profile → Account | Inside Profile → User logs |
|------|---------|--------------------------|----------------------------|
| **Project admin** | **Profile** only | Own account only | All logs for their `poi_type` (same as today’s User logs) |
| **Sub-admin** | **Profile** only | Own account only — never owner fields | **Only** their own actor rows |
| **Superadmin** (project browse on `/`) | **Profile** only | Own account only | Project-scoped report; global feed stays on `/access` |

Sub-admins today cannot open User logs. That changes: they open **Profile → User logs** and see **only** their own rows — never the owner’s account or other users’ activity.

---

## 3. UI / navigation

### 3.1 Sidebar

```text
Sidebar
  └── Profile     ← only this entry (User logs removed from sidebar)
        ├── Account      (edit own name / email / password)
        └── User logs    (same report as today; nested only here)
```

- Replace nav item `{ id: 'logs', label: 'User logs' }` with `{ id: 'profile', label: 'Profile' }`.
- Do **not** keep both Profile and User logs in the sidebar.
- Visibility:
  - **Project admin** and **sub-admin**: Profile visible.
  - **Sub-admin**: Admins (`team`) stays hidden; Profile is their entry for account + own logs.
  - Legacy `logs` panel id may alias to `profile` briefly for deep-links, then remove.
- Full-page layout: keep current `logs-focus` / `navme-logs-report-open` behavior, renamed conceptually to profile focus (map/tools hidden while Profile is open).

### 3.2 Profile page layout

Single full-page panel opened from sidebar **Profile**, with two sections/tabs **inside** Profile only:

1. **Account** — form for the signed-in user (name, email, password).
2. **User logs** (label may say “User logs” or “Activity”) — embed the existing user-logs report UI (`user-logs-panel.js`), with role-aware fetch. This is the **only** place the dashboard User logs report appears.

Optional third section **Partner access** is follow-up only; do not build in this phase.

### 3.3 Account form fields

| Field | Behavior |
|-------|----------|
| Display name | Editable |
| Email | Editable; unique across `navme_accounts` (ci); on success update client session email |
| Current password | Required for any save that changes email or password |
| New password | Optional; if set, confirm field required and must match |
| Confirm new password | Required when new password is non-empty |

Show role and `poi_type` as **read-only** context (not editable). Do not show other members’ credentials.

On success: toast + refresh session (`setAuthSession` with updated email/password/display if stored client-side). On failure: inline error from RPC message.

---

## 4. Data model (add-only)

### 4.1 Existing tables — do not reshape

Keep as-is:

- `navme_accounts` (`email`, `password`, `display_name`, …)
- `navme_user_logs` (already has `actor_account_id`, `actor_email`, `actor_role`, `poi_type`)
- `navme_project_members`, `navme_logins`

No column renames, type changes, or drops.

### 4.2 New RPC: `account_update_own_profile`

Security-definer RPC (same style as existing auth RPCs). Caller proves identity with current credentials.

**Inputs**

| Param | Required | Notes |
|-------|----------|--------|
| `p_email` | yes | Current session email |
| `p_password` | yes | Current password (must match) |
| `p_display_name` | no | If null, leave unchanged; empty string may clear or keep — prefer leave unchanged when null |
| `p_new_email` | no | If provided and different, update email (ci-unique) |
| `p_new_password` | no | If provided and non-empty, replace password |

**Rules**

1. Resolve account by `lower(trim(p_email))` + password match + `is_active`.
2. Update only that row in `navme_accounts`.
3. Never accept another `account_id` as a target — no “edit owner” path.
4. If `p_new_email` conflicts with another account → error.
5. Return the updated account row (id, email, display_name, role context not required from this RPC).

**Out of scope for this RPC:** changing `is_superadmin`, membership role, or `poi_type`.

Optional: write a `navme_user_logs` row (`entity_type: 'editor'`, action `updated`) after successful profile change — nice-to-have, not required for MVP.

---

## 5. Activity / logs behavior

### 5.1 Fetch API

Extend `fetchVisibleUserLogs` (or sibling) so:

| Caller | Result |
|--------|--------|
| Project admin | `poi_type` scope; existing filter that hides superadmin account-entity noise |
| Sub-admin | `poi_type` scope **and** `actor_account_id = session.accountId` (or email fallback) |
| Superadmin on `/` | Unchanged project-scoped fetch when a project is selected |

Update `canViewUserLogs()` → split or extend:

- `canViewProfileActivity()` — true for project_admin, sub_admin, and superadmin sessions that may open Profile.
- Sub-admin path must **not** use the old “return false” gate.

Prefer server-side filter via PostgREST (`actor_account_id=eq.…`) so large projects do not download other actors’ rows to the client. Client-side filter alone is insufficient as a security boundary given anon key access today; still apply client filter as defense-in-depth.

### 5.2 UI reuse

- Keep `user-logs-panel.js` report builder; mount inside Profile Activity tab.
- For sub-admin: hide actor column or keep it (always self); hide project column; subtitle e.g. “Your activity”.
- Export CSV respects the same filtered set.

### 5.3 `/access` logs

Superadmin Access Control page keeps its own log feeds. No move into Profile.

---

## 6. Wiring (frontend)

| Area | Change |
|------|--------|
| `dashboard.js` | Nav item `profile`; show for project_admin **and** sub_admin; remove exclusive “logs for admins only” hide for Profile |
| `main.js` | Panel open handlers: `profile` instead of / in addition to `logs`; sub-admin allowed; focus class rename or dual-support |
| New `profile-panel.js` | Tabs + Account form + host for Activity report |
| `supabase.js` | `accountUpdateOwnProfile(...)` → RPC |
| `user-logs.js` | Sub-admin own-activity fetch; permission helpers |
| Icons | Profile icon in sidebar |

---

## 7. Security notes

- Profile updates always require **current password**.
- Sub-admin cannot load another account’s profile via UI or by passing foreign ids to the RPC.
- Activity for sub-admin is actor-scoped; project admin sees full project activity (including sub-admins), which is intentional and separate from Account privacy.
- Do not surface project-admin email/password on sub-admin Profile.
- Map provider credentials (`navme_logins.client_id` / `client_secret`) stay out of Profile Account (those remain Admins / Access Control concerns).

---

## 8. Testing checklist

- [ ] Project admin: open Profile → edit display name; save with current password.
- [ ] Project admin: change password; re-login with new password.
- [ ] Project admin: change email; session + re-login work; unique conflict shows error.
- [ ] Project admin: Activity shows project-wide logs (same as old User logs).
- [ ] Sub-admin: Profile visible; Admins still hidden.
- [ ] Sub-admin: Account shows only their email/name; no owner fields.
- [ ] Sub-admin: Activity shows only their actions; creating a POI appears; admin actions do not.
- [ ] Sub-admin: cannot open old `logs` panel if deep-linked without permission alias.
- [ ] Superadmin `/access` logs still work.
- [ ] Sidebar no longer shows “User logs”.

---

## 9. Follow-up (explicitly out of this phase)

**Partner access** tab on Profile:

- New `navme_partner_keys` table (add-only).
- Project admin generates/rotates Key + Secret (hashed secret).
- Scoped dashboard + experience links limited to that `poi_type`.
- Spec separately when ready.

---

## 10. Implementation approach

Recommended: **UI shell first** (Profile replaces User logs, tabs, Activity reuse), then **RPC + Account form**, then **sub-admin activity filter**. Keeps add-only DB changes minimal and avoids reshaping existing structures.
