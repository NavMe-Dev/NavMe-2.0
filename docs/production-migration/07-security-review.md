# Security review — critical findings remain; narrow candidate tested locally

Audit date: 2026-11-13 (Asia/Kolkata). Project: `kzpvhzyefdtrtidrbuxb`.

**Full writable project security gate: HOLD.** After the complete PostgreSQL 17
restore and role tests passed, the reviewed initial recovery added an
independent SELECT-only reader group, its ten SELECT policies, and a separately
credentialed login. Existing application records, legacy grants/policies,
functions, and RLS-disabled tables were preserved. The shared legacy risks
below remain open; this scoped server role does not claim to fix them.

## Confirmed exposure and access models

The destination exposes `public` and `graphql_public`. The live catalog contains **30 public tables with RLS disabled**, including 29 legacy `navme_*` application tables and the PostGIS `spatial_ref_sys` reference table. Do not treat extension-owned reference data as an application ownership table or modify it blindly.

`navme_accounts`, `navme_users`, and `navme_logins` grant both `anon` and `authenticated` SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, and TRUNCATE. Combined with RLS disabled and the exposed schema, these privileges are a critical access-control defect. This conclusion comes from metadata and configuration; no destructive live access test or private-record retrieval through anonymous endpoints was performed.

Existing policies on `navme_pois`, `navme_media`, and `navme_categories` do not protect those tables because their RLS is disabled. The live privilege audit also identified **39 SECURITY DEFINER signatures callable by anonymous and authenticated roles**. Each signature's owner, body, input validation, search path, return fields, and callers require review; a function running with privileged ownership can undermine otherwise correct table RLS. No blanket function revoke or ownership change was applied to the shared project.

The unprefixed wayfinding backend tables, including `alembic_version`, already have RLS enabled and no policies in the captured catalog. They nevertheless have 140 combined `anon`/`authenticated` table-privilege entries across ten tables. Direct row access is currently restricted by RLS, but these grants are unnecessary for a backend-only architecture; RLS does not cover every table privilege such as TRUNCATE.

| Principal / surface | Required access | Current limitation |
|---|---|---|
| Public wayfinding viewer | Published manifest, public assets, published routes through FastAPI | Must not gain database access to drafts, users, job logs, or secrets |
| Wayfinding administrator | Authenticated FastAPI administration using existing bcrypt/JWT and `users.is_admin` checks | Distinct identity system from Supabase Auth |
| Wayfinding backend service | Reviewed CRUD on nine application tables; read migration revision | Dedicated server database login/membership not provisioned or validated |
| Legacy NavMe dashboard | Tenant/account-scoped application operations | Requests currently use the anonymous key as their authorization token |
| ConnectLabs/spatial/Matterport consumers | Existing application-specific authorization | Shared tables, functions, and views require owner/caller review before changes |

## Legacy compatibility blocker

`dashboard/src/services/supabase.js` sets `Authorization: Bearer <anon key>` in its shared headers. Its custom `authenticate_login_navme` RPC resolves dashboard identity/scope, but subsequent requests do not carry a Supabase user JWT. Client-side ownership filters and stored identity are not enforceable database authorization.

Adding generic `auth.uid() = user_id` policies would therefore fail to establish the intended legacy identity and can break the existing dashboard. Allowing anonymous CRUD to preserve that flow would retain the critical defect. No such insecure compatibility policy was proposed.

Remediation requires a reviewed identity transition: either verified Supabase Auth sessions with an explicit existing-account/tenant mapping, or a server-mediated session architecture that validates the current login and enforces tenant/account authorization on every request. Existing `navme_*` account/user identifiers must be mapped without replacing records. SECURITY DEFINER RPCs must be reviewed alongside that transition, including any sensitive credential fields returned to clients. Security-critical authorization must use server-controlled identity/claims, not editable user metadata or frontend filters.

## Prepared review-only SQL

`scripts/production_migration/security_candidate.sql` is a **staging candidate**, not an approved production migration. It deliberately requires database name `navme_security_test` and an explicit staging setting; it refuses existing policies or a pre-existing candidate backend role for manual reconciliation.

The narrow scope is the existing backend's nine tables (`users`, `venues`, `buildings`, `floors`, `pois`, `control_points`, `nav_graphs`, `map_versions`, `jobs`) plus read-only `alembic_version`:

- Remove PUBLIC, anonymous, and authenticated table grants, independent column grants, and privileges on the nine owned ID sequences.
- Create a `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, non-administrative backend group role.
- Permit that service principal to read/write only the nine backend application tables, with explicit `USING` and `WITH CHECK` policies; permit migration-version SELECT only.
- Grant schema USAGE and required sequence USAGE/SELECT; grant no TRUNCATE, schema CREATE, migration mutation, or role-management privilege.
- Leave legacy `navme_*`, spatial, ConnectLabs, auth, storage, views, RPCs, default privileges, and all records unchanged.
- Create no login credential or browser JWT and grant no membership to existing production principals.

The backend policy intentionally permits all rows **only to the restricted server service role**, because existing FastAPI routes enforce end-user publication and administrator authorization. It does not grant blanket access to public/authenticated browser roles. A future dedicated login must inherit only the reviewed group privileges, must not own application tables or bypass RLS, and must be tested through the selected Supabase connection endpoint. Supabase service-role credentials remain server-only.

This candidate cannot resolve the legacy dashboard or privileged-RPC defects. It does not pass the project-wide security gate and must not be applied to production as a substitute for that work.

## Actual isolated authorization tests

`run_security_staging.py` initializes a separate local PostgreSQL cluster in a private `/tmp/navme-security-*` directory, accepts only a Unix socket, rejects TCP hosts, creates an empty `navme_security_test` database, and shuts down the cluster after testing. It does not connect to the existing local recovered database or hosted Supabase. Test records are explicitly synthetic fixtures using the actual backend ORM schema, with legacy/ConnectLabs sentinel tables solely to verify narrow scope.

Command used:

```sh
platform/.venv/bin/python scripts/production_migration/run_security_staging.py \
  --pg-bin /Users/mediauser/miniforge3/envs/navme-wf/bin
```

**7 authorization tests passed** on local PostgreSQL **18.6**. Evidence: `evidence/security-staging-tests.txt`.

| Check | Actual result |
|---|---|
| Anonymous SELECT/INSERT/UPDATE/DELETE and sequence access to private backend data | Denied |
| Authenticated-role SELECT/INSERT/UPDATE/DELETE and sequence access | Denied |
| Scoped backend principal reads all application tables and performs permitted CRUD | Passed |
| Backend mutation of Alembic history, TRUNCATE, or access to legacy private sentinel table | Denied |
| All baseline fixture row counts and content checksums | Preserved |
| RLS, policy role scope, and nonprivileged backend-role attributes | Passed |
| Legacy broad grants intentionally remain unresolved | Explicitly verified; no claim of remediation |

These are real PostgreSQL role checks, not live Supabase Auth/HTTP or complete destination-copy tests. Local PostgreSQL 18.6 differs from destination PostgreSQL 17.11; repeat the approved migration against a verified PG17 destination copy and the actual API/role configuration before production approval.

## Required next security gates

The later, explicitly chosen initial public recovery scope is documented in
`16-initial-recovery-scope.md`. It uses existing destination GCU v5 unchanged,
with no source-data merge and no editing/publishing. The original writable
project-wide security findings remain open; they are not represented as fixed
by a scoped reader role.

For that initial scope, `reader_role_candidate.sql` prepares an independent
SELECT-only group role and SELECT-only RLS policies on the nine backend tables
plus Alembic revision metadata. It grants no sequence access, data mutation,
schema creation, ownership, browser membership, or login credential. It aborts
if inherited PUBLIC table privileges allow mutations or if an unaudited
SECURITY DEFINER function is reachable. Captured destination ACLs show the 36
non-extension privileged application RPCs grant explicit access to legacy
roles, not PUBLIC; an independent role therefore need not inherit those RPCs.
The three PUBLIC-callable SECURITY DEFINER overloads are extension-owned
`ST_EstimatedExtent` statistics readers, separately reviewed using the
[official PostGIS reference](https://postgis.net/docs/ST_EstimatedExtent.html).

Ten additional real role/authentication tests passed in a fresh isolated PostgreSQL 18.6
cluster: SELECT works under RLS; application writes, sequence allocation,
schema DDL, privileged legacy RPC invocation, and legacy table access are
denied; existing fixture data and legacy grants remain unchanged. An inherited
table write privilege, a PUBLIC privileged-write function, or inherited schema
creation causes the candidate transaction to abort. A synthetic dedicated
LOGIN is genuinely SCRAM-authenticated, rejects the wrong password, inherits
only the reader group, starts read-only, and still cannot UPDATE when its
session read-only flag is explicitly disabled. Only a SCRAM verifier reaches
the fixture provisioning SQL. No production login was created by these tests. Evidence:
`evidence/reader-role-staging-tests.txt`.

The same candidate subsequently passed against the complete, verified
PostgreSQL 17.11 destination clone. A synthetic SCRAM login inherited exactly
one reader group and selected all ten backend/revision tables under RLS. It
had zero application mutation privileges, zero sequence privileges, no public
schema creation, and no reachable non-extension SECURITY DEFINER function.
An actual UPDATE remained denied after the session read-only setting was
disabled; the wrong password was rejected. Evidence:
`evidence/reader-role-pg17.json`. These were isolated clone changes; production
role creation and real credential activation were separate execution steps.

The production provisioning template was also executed completely on that
matching clone with fresh probe names and a synthetic verifier, ending in
ROLLBACK. Its preconditions, SELECT policies, SCRAM login, PostgreSQL 17
membership syntax, CONNECT grant, and role defaults passed; no probe role or
policy remained afterward. See `evidence/reader-production-template-pg17.json`.
The source recovery agent verified all 130 frozen table digests,
all 15 archived sequence states, and the full-precision coordinate checks
unchanged after the reader fixture work.

The reviewed group was then provisioned through credential-free migration
`20261113135823_wayfinding_public_reader_recovery`; the independent production
login was provisioned with only its SCRAM verifier in SQL. Actual native and
shadow verification confirmed TLS, identical current/session user, exactly one
non-administrative reader membership, read-only mode, and zero mutation,
sequence, unrelated column, or custom SECURITY DEFINER privileges. The actual
reader-backed shadow passed 22 API expected-status checks and 24 privacy/auth
and mutation-gate checks. See `evidence/actual-reader-connection.json`,
`evidence/actual-reader-shadow-api.json`, and
`evidence/actual-reader-shadow-privacy.json`. Render activation is recorded
separately in the deployment reports.

Defense in depth is also implemented and verified in the shadow: an explicit
session initializer checks `default_transaction_read_only=on`, an HTTP gate
blocks mutations including REST-backed feedback, automatic migrations and
workers are disabled, and a pre-listener readiness gate checks the actual
database/revision. The session pooler was observed to ignore libpq startup
options; explicit session initialization corrected that. These controls do
not substitute for the independent role's privilege restrictions.

1. Obtain and restore-verify the occupied destination backup; preserve grants, policies, functions, definitions, and row baselines.
2. Complete the dashboard identity/session and tenant mapping design with the application owners; implement and test it in isolation.
3. Review all callable privileged RPCs and shared views individually; define necessary public outputs and deny private/authentication/credential leakage.
4. Test anonymous, authenticated, tenant-crossing, administrator, backend-service, and session-revocation behavior through actual application interfaces.
5. Review default privileges and Data API/GraphQL exposure with all existing application consumers; no blanket shared-schema changes.
6. Generate an approval-ready migration and rollback/compensation plan from the tested destination copy; obtain explicit approval before live security writes.
7. Re-run Supabase advisors and clear or explicitly accept reviewed findings before deployment. The current findings remain open.

The Supabase CLI is not installed in this environment. No numbered Supabase migration or migration-history entry was invented; the SQL remains a clearly labelled candidate, and no `apply_migration` was invoked.

## Documentation checked

The Supabase changelog was checked on the audit date, including the CLI v3 hosted-change behavior; no hosted CLI action was taken. Official reference material used:

- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Anonymous SECURITY DEFINER advisor](https://supabase.com/docs/guides/observability/advisors?queryGroups=lint&lint=0028_anon_security_definer_function_executable)
- [Authenticated SECURITY DEFINER advisor](https://supabase.com/docs/guides/observability/advisors?queryGroups=lint&lint=0029_authenticated_security_definer_function_executable)
- [PostgreSQL table and column privilege revocation](https://www.postgresql.org/docs/current/sql-revoke.html)
