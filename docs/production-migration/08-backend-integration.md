# Backend integration — prepared, production cutover blocked

Audit date: 2026-11-13 (Asia/Kolkata). Destination: **NavMe-2.0 / `kzpvhzyefdtrtidrbuxb` only**.

## Existing integration

The Render application is a Python FastAPI API with a static Vue administration UI and an ArcGIS public viewer. SQLAlchemy and GeoAlchemy2 use psycopg 3 against PostgreSQL/PostGIS. The server reads `DATABASE_URL`; `SUPABASE_URL` is an HTTP API/Storage URL and cannot replace it. Backend models use `users`, `venues`, `buildings`, `floors`, `pois`, `control_points`, `nav_graphs`, `map_versions`, and `jobs`. These tables are distinct from the occupied `navme_*` and `spatial_*` datasets.

Administration uses bcrypt password hashes and HS256 JWT bearer tokens; the API verifies `users.is_admin`. Supabase Auth identities and policies are a separate access model. Do not substitute Supabase JWTs or rewrite user records during a database cutover.

One repository Alembic revision exists: `0001`. The destination reports that revision and already has backend application data. Table existence alone does not establish that local/source and destination records represent the same business entities.

Local installed versions observed: FastAPI 0.142.2, Uvicorn 0.54.0, SQLAlchemy 2.1.3, GeoAlchemy2 0.20.0, Alembic 1.20.0, psycopg 3.3.6, pydantic-settings 2.15.0. The pyproject specifies broad dependency ranges; **production installed versions were not confirmed**.

## Prepared code changes

| File | Behavior |
|---|---|
| `platform/api/wayfinding_api/config.py` | Validated pool, connection, statement, lock, and TLS settings |
| `platform/api/wayfinding_api/db.py` | Normalizes plain Render/PostgreSQL URLs to installed psycopg 3; bounded pooling; pre-ping; hidden SQL parameters; explicit disposal |
| `platform/api/alembic/env.py` | Reuses normalized URL/TLS without ConfigParser interpolation of percent-encoded credentials |
| `platform/api/wayfinding_api/main.py` | Database/PostGIS/application-table readiness; independent `/api/live`; generic database 503 without private SQL/connection text; shutdown handling |
| `platform/api/wayfinding_api/services/jobs.py` | Bounded retry of queue polling after transient connection failures; no automatic replay of job writes; stop event prevents new claims during shutdown |
| `platform/deploy/start-api.sh` | Supports `RUN_MIGRATIONS=false` to suppress automatic startup DDL for an audited occupied database; default remains `true` for existing deployments |
| `platform/api/wayfinding_api/readiness.py` | Bounded database/PostGIS/schema/revision/read-only startup check before the TCP listener opens in recovery mode |

The API health endpoint now checks connectivity, PostGIS, and required application relations. It does not prove row completeness, RLS role usability, publication assets, or full schema compatibility; those remain separate release gates. `/api/live` reports process liveness and must not replace database readiness in the release gate.

## Recovery environment change set — execution gates remain

A user-supplied database credential was verified for the exact project's
session pooler on port 5432, with client TLS, a read-only transaction,
PostgreSQL 17.11, and Alembic revision `0001`. Direct-host DNS was unavailable
from this environment. Credentials remain in restricted local files and are
never copied into these reports. The non-secret recovery flags were later
merged into the existing Render configuration, but **the running service has
not been switched to the reader database URL or the new application code**.

After matching-clone recovery and role verification, an independent production
reader login was provisioned and verified. The final local shadow uses that
reader rather than the owner credential; its actual TLS, session identity,
membership, timeout, and effective privilege checks passed. Activation of that
credential on Render is a separate reviewed deployment step. No owner
credential should be used for the recovered public service.

Use the verified **session pooler on port 5432**. The actual independent reader
has passed native and local-shadow tests through this endpoint. Validation
from the deployed Render process remains necessary after activation. The
transaction pooler on port 6543 is outside the reviewed configuration.

| Variable | Proposed value / requirement |
|---|---|
| `DATABASE_URL` | Exact project Connect-panel PostgreSQL secret; existing server-side variable name retained |
| `DB_SSLMODE` | `require` minimum; prefer `verify-full` with the project's verified trust configuration |
| `DB_POOL_SIZE` | `3` per process |
| `DB_MAX_OVERFLOW` | `2` per process |
| `DB_POOL_TIMEOUT_SECONDS` | `5` |
| `DB_POOL_RECYCLE_SECONDS` | `300` |
| `DB_CONNECT_TIMEOUT_SECONDS` | `10` |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` (validate publishing/import duration before approval) |
| `DB_LOCK_TIMEOUT_MS` | `5000` |
| `RUN_MIGRATIONS` | `false` for reviewed occupied-database cutover after schema and revision verification |
| `DB_READ_ONLY` | `true` for the initial unchanged-publication recovery scope |
| `WF_READ_ONLY` | `true`; block application mutations including REST-backed feedback; retain query POST routes |
| `WORKER_INLINE` | `false`; read-only mode also prevents worker startup if misconfigured |
| `DB_STARTUP_CHECK` | `true`; verify readiness before binding because the current Render service uses TCP health checks |
| `DB_STARTUP_TIMEOUT_SECONDS` | `60` retry window, with bounded individual connection/query attempts |

The default TLS override is empty, preserving existing URL configuration until an approved hosted configuration is supplied. Existing JWT secrets, domain, storage configuration, and Render service identity must be preserved. Never send PostgreSQL credentials or service-role credentials to the frontend.

Maximum configured application connections are `process_count × (3 + 2)` plus any independent worker, migrations, monitoring, and administrative connections. Confirm actual Render process count and Supabase database/pooler limits before approval. A successful local test does not establish a usable Supabase role: existing RLS-enabled backend tables require the reviewed backend role and grants.

The actual session pooler ignored libpq startup timeout/read-only options.
`db.py` now applies explicit session settings in autocommit before application
transactions and verifies read-only mode. An actual destination probe confirmed
transaction/default read-only `on`, statement timeout `30s`, and lock timeout
`5s`. Aggregate job inspection found one succeeded onboarding job and no queued
or running jobs; no job logs or user records were exported by that probe. See
`evidence/read-only-destination-db-probe.json`.

In read-only recovery, the explicitly provided process `DATABASE_URL` remains
authoritative over stale runtime secret overlays; other established overlays
such as JWT configuration remain honored. Recovery requires that explicit
process connection value. Published file paths are mapped to a private local
cache in this mode without rewriting database records. Startup also refuses
automatic migrations in read-only mode and exits before listening if the
database, PostGIS, required tables, revision `0001`, or read-only state fails
the gate. The actual read-only startup probe passed; see
`evidence/read-only-startup-readiness.json`.

## Validation evidence and remaining gates

`platform/.venv/bin/pytest -q platform/tests` completed with **182 passed, 2 skipped** on the isolated, local `wayfinding_test` database. The integration test harness now refuses nonlocal targets and database names without `_test`, before the existing table-rebuild fixture runs. The dedicated recovery/resilience suite contributes 41 passing tests plus 10 startup readiness tests. See `evidence/platform-pytest.txt`.

The complete destination restoration and matching PG17 role tests passed.
Production reader provisioning and native verification also passed; the
actual-reader shadow passed 22 API checks and 24 privacy/authorization checks.
These are not Render deployment results.

The reviewed runtime commit is
`616b4a960216cd0e500c5dd113480d1f3059eec9`, still local. GitHub rejected the
push to `NavMe-Dev/NavMe-2.0` with HTTP 403 for the current `AdhamNG` account.
The new code is therefore unavailable to Render, and the reader URL remains
unactivated there. This access failure is the current cutover blocker, not a
failed database connection or missing implementation. An authorized repository
write connection is required to publish the reviewed commit. The safe order
remains new code first, then reader-URL activation and deployment of that exact
commit; old code must not receive the working reader URL because it lacks the
application mutation gate.

The GO-LIVE authorization and chosen scope are recorded in
`16-read-only-recovery-decision.md`. Unknown source records remain quarantined,
with zero source-data DML for initial recovery. Live domain/API/browser
verification remains pending cutover. See `03-supabase-inventory.md` and
`evidence/final-runtime-review.json` for the recovery and runtime evidence.

## References

- [SQLAlchemy connection pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html)
- [SQLAlchemy PostgreSQL/psycopg dialect](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html#module-sqlalchemy.dialects.postgresql.psycopg)
- [PostgreSQL libpq connection parameters](https://www.postgresql.org/docs/current/libpq-connect.html)
