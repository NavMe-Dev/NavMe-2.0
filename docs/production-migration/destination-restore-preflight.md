# Complete destination recovery rehearsal — VERIFIED

Status: **PASS for isolated destination recovery**. The actual full backup was
restored and verified in a separate PostgreSQL 17.11 environment. This report
supplements destination report 03; it does not declare all production release
gates passed. This restoration work made no production changes and left the
existing local PostgreSQL 18 source cluster intact.

## Executed recovery results

The official Supabase PostgreSQL image supplies exact PostgreSQL 17.11,
PostGIS 3.3.7 and Vault 0.3.1. It runs inside a new native Apple Virtualization
Framework Linux VM using a checksum-verified portable Lima 2.3.0 binary. No paid
service, replacement production database, or source upgrade was created.

| Verification | Actual result |
|---|---|
| Full archive | 6,995,284 bytes; SHA-256 `4f1781bb50419e25cafb8938a6cf7c3ef5e3bc7851613f2769b6c97c6ccb08bf` |
| Isolated target | `navme_destination_restore_test`, PostgreSQL 17.11 |
| Frozen exported-snapshot tables | **130/130 counts and complete row digests match** |
| Alembic and Supabase migration records | Exact match |
| Installed extensions | All seven names/versions match |
| Global roles / memberships | 30 / 24 match |
| Schemas / policies / event triggers | 10 / 80 / 7 match |
| Relation ACL/owner/RLS records | 415 match |
| Function ACL/owner/security/config records | 1,098 match |
| Database properties | Owner, ICU en-US locale, encoding, ACL and configuration match; staging name and cluster OIDs normalized |
| Sequence states | All 15 `last_value` and `is_called` states exactly match the original archive |
| Full-precision coordinate verification | Four sensitive tables match a fresh read-only source comparison with `extra_float_digits=3` |
| After reader-role/auth/denied-write tests | All 130 frozen table digests/counts and all 15 sequences remain unchanged |
| Original capture checksums | Unchanged |

A separate allocation-health audit found one existing source counter behind
its table's allocated range: `public.navme_ar_events_id_seq` is `1, false`
while the table's maximum ID is 15,208. ID 1 is not currently occupied, so an
immediate next-ID collision was **not** demonstrated; it can collide later as
the counter advances. The other 14 owned sequences align beyond their existing
ID ranges. This state was faithfully preserved, not caused by restoration or
reader-role tests. No sequence was changed. Any forward-only correction is a
separate reviewed release action; faithful recovery is not a claim that the
source already had perfect sequence health.

The immutable table-data anchor is the original exported read-only snapshot.
Security/database metadata was additionally captured in a separate current
read-only sidecar and compared explicitly; it is not mislabeled as part of the
original snapshot. The extra full-precision comparison also uses a separately
identified current source snapshot.

Source pooler JSON serialization uses `extra_float_digits=0`; the native dump
uses full precision. Matching that confirmed source serialization made all 130
original digest anchors equal. An independent `extra_float_digits=3` comparison
then proved the four coordinate-heavy tables retained full precision. No
rounding, approximate equality, or data updates were used to force agreement.

Secret-free evidence: [`evidence/destination-restore-verification.json`](evidence/destination-restore-verification.json).
Detailed private evidence under the captured backup directory includes
`restore-verification-pg17-complete/verification-report.json`,
`restore-post-reader-verification/additional-verification-report.json`,
`recovery-execution-manifest.json`, and `restore-execution-logs/`.

Runtime identifiers: Lima home `/private/tmp/navme-recovery-lima`, instance
`navme-recovery`, container `navme-recovery-db-v4`. The container has **no
network**, PostgreSQL accepts only local socket connections, and the original
backup directory is mounted **read-only**. The official image tag is
`supabase/postgres:17.11.0.018`; its OCI index is
`sha256:7c31363a3f7434ff14945f1b8a4880e6eca8b362e197e88b87c476c77aa3cf8c`.

## Initial native PostgreSQL 18 preflight — historical

At the initial audit, only PostgreSQL **18.6** server/client binaries were installed, in the existing
`navme-wf` environment and its identical cached package. No installed PostgreSQL
17 server, Docker runtime, or Postgres.app was found. The production destination
is PostgreSQL **17.11**.

| Required destination extension | Locally available default | Exact local rehearsal |
|---|---|---|
| plpgsql 1.0 | 1.0 | Available |
| uuid-ossp 1.1 | 1.1 | Available |
| postgis 3.3.7 | 3.6.4 | Exact version unavailable |
| pgcrypto 1.3 | 1.4 | Older SQL version listed as available |
| pg_stat_statements 1.11 | 1.12 | Older SQL version listed as available; not preloaded |
| btree_gist 1.7 | 1.8 | Older SQL version listed as available |
| supabase_vault 0.3.1 | Not available | Blocked |

A forward-version local clone may support limited application experiments, but
does not establish a PostgreSQL 17 full-database recovery procedure. Do not omit
the unavailable Vault schema/extension and call the result a complete restore.
Do not silently substitute extension versions without a separately reviewed
compatibility rehearsal.

The final native-18 read-only preflight used an enriched
`source-requirements-vault-count.json`: PostgreSQL 17.11, all seven installed
extensions, 30 source roles, two publications, and **zero `vault.secrets` rows**
verified against the same exported snapshot as the full archive. Original
`source-requirements.json` and `snapshot-inventory.json` hashes were checked
against the completed capture manifest and remain unchanged. The inventory
SHA-256 is `004edc3b3b8fa156410cc9f72e37f263fca2bbd9259ea4397c9d5ed9218b72f1`.

It returned **HOLD**, with six actual blockers:
different PostgreSQL major, unavailable Vault 0.3.1 and PostGIS 3.3.7, 15 required
global roles absent from this local server, missing `pg_stat_statements` preload,
and logical-WAL settings unsuitable for the source publications. Encryption-key
recovery is **not a separate blocker for this snapshot** because its Vault table
is verified empty. The exact Vault extension is still required to restore the
schema completely.

Private historical report:
`platform/var/data/production_migration/2026-11-13-supabase-1247/restore-preflight-local-18-vault-count.json`.
The earlier `destination-restore-preflight.json` used an abbreviated source
inventory while role/publication capture was pending; it is retained as
historical evidence. `restore-preflight-local-18.json` used the full source
requirements before the Vault count was enriched; it is also historical.
No preflight
executed a restore. Historical SQL extension versions offered by the local
package do not establish cross-major binary or managed-service compatibility.

## Recovery package

The completed root workflow captured the live destination through its verified
session pooler, with required TLS and a read-only exported transaction snapshot.
The recovery package comprises:

1. A full custom-format dump with **all schemas and original owner/ACL records**,
   plus a schema-only export from the same snapshot. No application-only `-n`
   filter and no clean restore option.
2. Exact counts and canonical record digests taken from that exported snapshot,
   required extensions, migration histories, constraints/validation flags,
   functions, triggers, policies, grants, and publication metadata.
3. Global roles and memberships captured separately using
   `pg_dumpall --roles-only --no-role-passwords`. A database dump alone omits
   cluster-global roles. Role password hashes are deliberately not exported;
   dedicated test login credentials must be provisioned separately.
4. Restricted local files (0600, directory 0700), timestamps, byte sizes, SHA-256
   checksums, successful archive-directory reading, and a private command log
   that does not disclose connection credentials.
5. Provider-specific configuration needed by managed extensions, authentication,
   Storage, and Realtime. For any populated or unverified Vault snapshot,
   encryption/configuration recoverability must be verified using the
   provider-supported method; SQL object creation alone does not prove encrypted
   contents can be used. The actual snapshot here has zero Vault records, so
   recovery of encrypted Vault contents is not required for this capture.
6. Database metadata for Storage, plus separately handled external-secret and
   object-byte recovery. A logical database dump does **not** contain Storage
   object bytes. The public bundle's asset verification is separate; this
   database restore does not claim an off-host backup of every object.

Global-role state and sequence values are not made into one atomic global
snapshot by a table-data export. Record their capture times and compare restored
sequence values with the dump's values, then check that future allocations exceed
all restored IDs. Do not compare an actively changing production sequence to an
earlier snapshot and misreport normal concurrent changes as corruption.

## Executed isolated restoration procedure

Prepare a **fresh isolated PostgreSQL 17 cluster**, with no production network
role or endpoint. A newly named database inside the local development cluster is
insufficient to safely replay arbitrary global roles: roles are cluster-wide.
The fresh cluster uses the source's bootstrap role **`supabase_admin`**, required
to preserve original membership grantors. A derived staging-only role script
skips only that already-existing `CREATE ROLE`; the original export remains
unchanged. A differently named bootstrap failed PostgreSQL's grantor checks and
was retained as a diagnostic attempt, not counted as a successful restore.

Install the exact required managed extensions and reviewed server settings in
that isolated environment. Account for `pg_stat_statements` preloading and
logical-WAL settings where publication recovery requires them. These prerequisites
were supplied by the official matching image. Native `supautils` session hooks
and the image's own privilege configuration were enabled, preserving nonsuperuser
object ownership rules without elevating the source `postgres` role.

The Ubuntu guest's default AppArmor container profile blocked signals between
Nix-wrapped PostgreSQL processes. The recovery container uses a compatible
unconfined AppArmor setting **inside the dedicated VM**, while VM isolation,
disabled networking and the read-only backup mount remain in place. No host or
production security policy was changed.

The role/membership export was replayed only in the fresh cluster. A
new target database was created with source owner `postgres`, UTF-8 encoding,
ICU provider and `en-US` locale. The full archive was restored preserving owners,
grants and policies with `pg_restore --exit-on-error --single-transaction`.
Managed event triggers require original-owner creation, so seven entries were
deferred into a second transactional checkpoint using
`--use-set-session-authorization`. This preserved native superuser/function-owner
checks; no trigger or role permission was weakened.

The captured current metadata sidecar supplied properties a plain logical
archive does not reproduce completely in a seed-free managed platform: five
database ACL entries, one database setting, 49 extension-function owners, two
view owners and six managed schema/relation ACLs. Staging-only companion scripts
replayed those exact fields, then every metadata category matched the source
sidecar. The complete package therefore includes these metadata companions,
not just the archive alone.
Do not use clean, replace, reset, or database-create options against the occupied
project. Any first restore failure means the full restore is unverified; preserve
the private diagnostics and correct the isolated environment.

Compare every restored schema/table and exact snapshot count/digest, migration
version, FK/constraint validation state, owner/grant/policy/function/trigger,
publication and sequence. Check protected NavMe/ConnectLabs records, managed
auth/storage metadata, and Vault extension restoration. Verify decrypted source
Vault contents only when the snapshot actually contains encrypted records.
Application and reader-role recovery tests used that clone. Only the completed full comparison is counted as
recovery verification; table-only experiments and archive readability were not.

## Reproducible companion and verification tools

`prepare_restore_companions.py` generates new private staging scripts in three
phases: `bootstrap`, `owners-settings`, and `acls`. It verifies original capture
checksums, never modifies source artifacts and makes no database connection.
Owner/ACL phases take metadata from the preceding clone checkpoint; generated
SQL refuses a database other than `navme_destination_restore_test`.

`verify_vm_restore.py` checks the original frozen rows, migrations, exact
extensions and security/database metadata through the named network-disabled
container. `verify_vm_additional.py` verifies rows after reader-role tests,
compares full-precision coordinates, and reads exact sequence states without
calling `nextval` or `setval`. Output is restricted and never overwrites an
earlier verification. The committed tools contain no source credentials.

## Prepared preflight tool

`scripts/production_migration/restore_preflight.py` performs **read-only** local
server inspection. It rejects non-loopback or implicit-host URLs, requires exact
extension-version and PostgreSQL-major compatibility, checks role/configuration
requirements, and records separate external Vault recovery requirements. It has
no restore operation and never marks an unexecuted restore verified.

The local-host guard also rejects URL query routing overrides (`host`,
`hostaddr`, service, database and identity/port overrides), rejects nested
connection URLs as database names, and removes all inherited libpq `PG*`
environment settings during connection setup. The environment is restored on
failure. Twenty-six focused preflight tests pass, including route overrides,
inherited environment, verified empty Vault versus positive/unknown counts,
and continued extension requirements for empty Vault. A loopback URL alone is insufficient
when libpq routing overrides are allowed.

Source manifest format:

```json
{
  "server_version": "17.11",
  "extensions": [{"name": "plpgsql", "version": "1.0"}],
  "roles": ["postgres"],
  "publications": []
}
```

The example is a format illustration; use the actual complete captured source
manifest, not this abbreviated extension/role list. Supply the explicit local
inspection connection through `LOCAL_RESTORE_DATABASE_URL` without putting its
credential in command arguments or reports.

```sh
platform/.venv/bin/python scripts/production_migration/restore_preflight.py \
  --source-manifest /private/path/destination-recovery-manifest.json \
  --output /private/path/restore-preflight.json
```

A successful prerequisite check remains separate from a successful restore.
The original native PostgreSQL 18 preflight failed; the subsequently created
matching PostgreSQL 17 VM completed the actual restoration and verification.

References: [PostgreSQL pg_dump scope and snapshots](https://www.postgresql.org/docs/17/app-pgdump.html),
[global roles and pg_dumpall](https://www.postgresql.org/docs/17/app-pg-dumpall.html),
[Supabase backups and Storage scope](https://supabase.com/docs/guides/platform/backups),
[portable Lima installation](https://lima-vm.io/docs/installation/),
[native VZ support](https://lima-vm.io/docs/config/vmtype/vz/),
[official Supabase PostgreSQL image](https://hub.docker.com/r/supabase/postgres/tags?name=17.11.0.018).
