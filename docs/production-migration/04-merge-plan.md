# Preserve-and-merge plan

Status: **HOLD — comparison and approval preparation only.** Approved production
inserts: **0**. Approved updates: **0**. Approved deletions: **0**. No apply SQL is
generated until provenance, destination restore verification, identities,
relationships, and production approval are complete.

The existing project is exactly `kzpvhzyefdtrtidrbuxb`; it is occupied. It already
contains both the backend tables below and unrelated NavMe/ConnectLabs datasets.
A full restore into `public` is prohibited. The independent local source is
**ineligible for production transfer** until provenance is established or the
user approves a specific reconciliation. The user confirmed its production
provenance is unknown.

| Table | Local rows | Destination rows | Initial classification / identity |
|---|---:|---:|---|
| buildings | 2 | 1 | Existing; compare slug plus Matterport identity; preserve destination GCU |
| floors | 12 | 5 | Existing; parent building business identity + `fid` |
| pois | 536 | 230 | Existing; parent building business identity + `key` |
| map_versions | 3 | 5 | Existing with publication conflicts; building identity + version |
| nav_graphs | 5 | 1 | Manual; no unique stable version identity is enforced |
| jobs | 11 | 1 | Unsafe to replay historical queued/running operations; preserve destination |
| users | 2 | 2 | Protected; no automatic auth/account merge |
| venues | 0 | 0 | No recoverable rows in the inspected copies |
| control_points | 0 | 0 | No recoverable rows in the inspected copies |
| alembic_version | 1 | 1 | Both `0001`; preserve destination migration history |
| spatial_ref_sys | 8,500 | extension-owned | Extension-managed; never merge as application records |
| `navme_*`, `spatial_*`, other existing tables | absent | occupied | Destination-only/shared; preserve unchanged |

The completed structured catalog comparison found **11 shared tables with exact
column types/modifiers, nullability/defaults, primary/foreign/unique/check
constraint definitions, and index definitions matching**. No missing backend
table or column was found. The 71 destination-only tables remain unchanged.
See [`evidence/schema-differences.json`](evidence/schema-differences.json).
PostgreSQL 18 NOT NULL catalog entries were normalized through column
`attnotnull` so PostgreSQL 17 is compared semantically. This version difference
is documented in the official [PostgreSQL 18](https://www.postgresql.org/docs/18/catalog-pg-constraint.html)
and [PostgreSQL 17](https://www.postgresql.org/docs/17/catalog-pg-constraint.html)
catalog references.

Local backend RLS is disabled; destination backend RLS is enabled. Preserve
destination RLS. Extension-owned PostGIS objects differ by installed version;
do not copy extension metadata or functions from local 3.6.4 over destination
3.3.7. Application function, trigger, role, policy, and sequence audits require
the separate security/integrity review; table structural parity is not a
substitute for those checks.

The completed four-table offline identity comparison found 5 exact matches,
232 content conflicts, 215 insertion candidates, and 101 integer-key collisions.
No candidate has become an approved insertion. See `06-conflict-report.md` for
the table breakdown and per-record digest artifact.

## Conflict policy

Existing destination records remain unchanged, including destination GCU v5
publication metadata. Local GCU v1 being current cannot demote destination v5.
Timestamp recency does not confer authority. Differing content for the same
business identity becomes a review conflict. Equal integer IDs do not identify
the same business record. Missing business identity, duplicates, and protected
tables block automatic handling.

New source records remain insertion candidates. Allocate new destination integer
IDs only in staging, then remap every dependent FK through proven parent business
identities. Check every floor/POI reference and sequence value after allocation.
Do not transfer local filesystem paths as working production asset paths without
verifying durable storage objects. Missing parents defer children; no silent
discard or `ON CONFLICT` shortcut is permitted.

## Execution prerequisites

1. Verify an authoritative source or obtain approved local-record reconciliation.
2. Obtain a complete destination logical backup or approved equivalent, restore
   it into a separate environment, and compare schemas, counts, and full records.
   **Completed:** matching PostgreSQL 17.11 restore, all 130 frozen table digests,
   metadata baseline and 15 original sequence states verified; see
   `destination-restore-preflight.md`. This does not approve local-source transfer.
3. Restore source separately; the local source restore has already passed, but a
   PostgreSQL 17 rehearsal and complete asset audit remain outstanding.
4. Compare all schemas, classify every table, and resolve identity conflicts.
5. Rehearse exact insert-only DML, FK remapping, sequence allocation, permission
   changes, and recovery checkpoints against the occupied destination clone.
6. Prove all pre-existing destination row digests unchanged, no deletions, no
   duplicate identities, no FK orphans, and no shared-table changes.
7. Present the exact final row/field/schema changes and conflicts for explicit
   approval before any production write.

Prepared helpers are in `scripts/production_migration/`. They inventory and
back up through private connection environment variables and compare offline
business identities. They have no production apply operation.
