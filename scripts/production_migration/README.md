# Production recovery helpers

The audit, reconciliation and recovery helpers below make no production changes.
The separately reviewed reader-role release tools have their own exact-project
guards and are documented in reports 07/08/13. `audit.py inventory` runs catalog
and count queries in a read-only repeatable-read transaction. `audit.py backup`
uses `pg_dump` custom format with no owner/ACL restoration and checks the archive
directory using `pg_restore --list`. Connect-panel `postgresql://` URLs and the
legacy `postgres://` alias use the installed psycopg3 driver. Remote connections
default to required TLS; stronger supplied verification settings are retained,
and downgrade modes are rejected. An archive listing alone does **not** prove
restorability. A complete restore and integrity comparison in a new isolated
database remains mandatory.

For the complete occupied-destination package, use `capture_destination.py`
with the exact project's ignored `--secret-file`, a **new private** `--output`
directory and installed `--pg-bin`. It captures all schemas while retaining
owners/ACLs, exports password-free role definitions separately, and uses one
read-only exported snapshot for the archive and table digests. Its target guard
permits only the reviewed project's direct/session endpoints, clears inherited
libpq routing, requires TLS, and never restores or changes production. Native
`pg_restore` runs offline only, to list/decode the archive and export schema SQL.
Preserve private failure logs and never overwrite earlier review evidence.

Archive readability is not restoration. `restore_preflight.py` checks an
explicit loopback server read-only and records exact version/extension/role
requirements before any full isolated rehearsal. The current local PostgreSQL
18 environment does not satisfy the occupied PG17 destination's requirements.
See `docs/production-migration/03-supabase-inventory.md` and the supplemental
restore-prerequisite report for actual capture and HOLD evidence.

Use the platform Python environment. Supply the connection using an existing
server-side environment variable; do not paste it in shell history or command
arguments. `--url-env` selects its name. Never commit snapshots or dumps. Write
them to the ignored `platform/var/data/production_migration/` directory with
restricted local access, and copy approved backups to encrypted durable storage.

```sh
platform/.venv/bin/python scripts/production_migration/audit.py inventory \
  --url-env DATABASE_URL --schemas public --output /private/path/inventory.json
platform/.venv/bin/python scripts/production_migration/audit.py backup \
  --url-env DATABASE_URL --expected-host 127.0.0.1 \
  --pg-bin /path/to/matching/postgresql/bin --output /private/path/source.dump
```

`reconcile.py` compares offline JSON row snapshots using a separately reviewed
business-identity policy. Unknown tables remain blocked. Matching integer IDs are
never business identity. Existing records are preserved; differing content and
key collisions are explicitly reported by digest. New rows are only candidates,
pending parent identity remapping, foreign keys, sequence allocation, provenance,
permissions, and backup/restore verification. The tool emits no SQL and never
approves a production merge.

Input format: `{"tables":{"public.buildings":{"rows":[...]}}}`. Policy format:
`{"public.buildings":{"identity":["slug"],"primary_key":["id"]}}`. Composite
foreign keys must first be resolved to proven business identities in staging;
raw `building_id` values from separate databases cannot be compared as identity.

```sh
platform/.venv/bin/python scripts/production_migration/reconcile.py \
  --source /private/path/source.json --destination /private/path/destination.json \
  --policy /private/path/reviewed-policy.json --output /private/path/conflicts.json
platform/.venv/bin/python -m pytest -q scripts/production_migration/test_reconcile.py
```

`schema_diff.py` compares the private catalog exports with exact formatted
column types, nullability, defaults, constraint definitions, indexes, and RLS
state. It normalizes PostgreSQL 18 NOT NULL catalog entries through column
`attnotnull`, so the PostgreSQL 17 representation is compared correctly. Exact
destination row counts can be included using `--destination-counts`. Run
`platform/.venv/bin/python scripts/production_migration/schema_diff.py --help`
for required export paths. The checked-in `evidence/schema-differences.json`
contains the actual comparison, with no row data or connection credentials.

Do not use the older `platform/scripts/restore.sh` against Supabase. It performs
a destructive clean restore and is incompatible with this preserve-and-merge task.

`restore_preflight.py` inspects only an explicit loopback PostgreSQL endpoint,
read-only. It checks the source manifest's exact server/extension requirements,
global roles and relevant settings. It never restores a database, changes roles,
or converts successful prerequisites into a verified backup. See
`docs/production-migration/destination-restore-preflight.md` for the full managed
Supabase recovery requirements. The inspected local PostgreSQL 18 server lacks
the production PostgreSQL 17/exact extension/Vault prerequisites; a separate
matching PostgreSQL 17.11 VM was subsequently created and the complete archive
was actually restored and verified there.

`capture_destination.py` is the full occupied-destination capture tool. It
preserves ownership/ACL information and records all 130 table digests from the
same exported read-only snapshot. Use it for the full destination package rather
than the simplified `audit.py backup` source-copy helper, which omits owner/ACL
restoration records.

`prepare_restore_companions.py` regenerates restricted staging-only bootstrap,
managed owner/settings and ACL companion scripts from the captured current
metadata sidecar and the previous clone checkpoint. Original capture files are
checksum-verified and never modified. The actual restoration used the native
Supabase bootstrap role, source ICU locale and native Supabase privilege hooks;
event triggers were replayed under their original owners in a separate
transactional checkpoint.

`verify_vm_restore.py` verifies frozen data/migrations/extensions and canonical
security/database metadata in the named network-disabled local container.
`verify_vm_additional.py` verifies post-reader data preservation, full-precision
coordinate hashes and exact archived sequence states without consuming sequence
values. The completed rehearsal matched all 130 tables, 15 sequences and every
captured metadata category. See the recovery report for actual runtime identifiers
and private evidence locations.
