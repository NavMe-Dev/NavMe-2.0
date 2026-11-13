# Occupied Supabase destination inventory

Audit date: 2026-11-13. Exact project **NavMe-2.0 / `kzpvhzyefdtrtidrbuxb`**. Status ACTIVE_HEALTHY, Singapore, PostgreSQL 17.11, PostGIS 3.3.7 in `public`. No production writes were executed.

## Catalog and count baseline

All non-system schemas were enumerated. The catalog captured 329 constraints, 260 indexes, 15 sequences, 5 views, 34 non-internal triggers, 80 RLS policies, 2,600 table-grant records and 1,099 function signatures/security attributes across those schemas. Extension-owned functions are included in that total. This is structural inventory, not a restorable backup. Exact formatted public column metadata covers 1,128 columns; source/destination comparison is in `evidence/schema-differences.json`.

| Schema | Tables (including partitioned parents) | Views | Sequences |
|---|---:|---:|---:|
| public | 82 | 2 | 13 |
| auth | 27 | 0 | 1 |
| storage | 10 | 0 | 0 |
| realtime | 9 | 0 | 1 |
| supabase_migrations | 1 | 0 | 0 |
| vault | 1 | 1 | 0 |
| extensions | 0 | 2 | 0 |
| graphql / graphql_public / spatial_private | 0 | 0 | 0 |

The fresh exact count of all 82 public tables totals **20,121 rows**, including 8,500 extension-owned `spatial_ref_sys` rows. Full per-table exact counts: `evidence/destination-row-counts.json`. Metadata queries and counts were read-only. Counts and separate catalog reads are not a single frozen database backup, and other applications may continue to write.

| Selected public table | Exact rows |
|---|---:|
| navme_navnode | 7,102 |
| navme_gmap_pois | 1,542 |
| navme_pois | 566 |
| navme_media | 194 |
| navme_users | 173 |
| navme_categories | 74 |
| navme_floors | 16 |
| navme_accounts / navme_logins | 41 / 43 |
| spatial_spaces / spatial_markers | 52 / 52 |
| spatial_equipment | 21 |
| buildings / floors / pois | 1 / 5 / 230 |
| map_versions / nav_graphs / jobs | 5 / 1 / 1 |
| users / venues / control_points | 2 / 0 / 0 |

Backend GCU identity: slug `gcu`, Matterport `jdjvM17BPEh`, current publication **v5**, destination publication rows v1–v5. Destination values are preserved. Local GCU v1 and editable POIs differ; UNCC exists locally and in Storage but has no destination backend building row. Folder presence is not authorization to insert or republish it.

All ten backend tables including `alembic_version` are owned by `postgres` with RLS enabled and no browser policies. The application needs a verified role/grant design; a successful administrator MCP query is not evidence that a restricted backend role can query them.

Installed extensions: plpgsql 1.0, pg_stat_statements 1.11, uuid-ossp 1.1, pgcrypto 1.3, supabase_vault 0.3.1, postgis 3.3.7, btree_gist 1.7. The backend Alembic version is `0001`. Supabase migration history has 21 entries, beginning `20261021155131` and ending `20261111091258`; most recent entries belong to Spatial Studio/ConnectLabs. Preserve that history and all `spatial_*` / `spatial_private` dependencies.

## Data API, grants and dependencies

Actual exposed schemas: **public, graphql_public**. Public tables with RLS disabled: **30**, including `navme_accounts`, `navme_users`, `navme_logins`. Catalog grants independently confirm both `anon` and `authenticated` have table-level read/write access to those sensitive tables; no private record contents were retrieved to demonstrate the issue. Three existing read policies have no effect while their tables' RLS is disabled. See security report 07 for architecture and staging limits.

Legacy NavMe dashboard code accesses `navme_*` tables and RPCs directly with an anonymous bearer key. ConnectLabs uses separate `spatial_*` tables, private helper functions, Storage policies, publications and migration versions. Those records, triggers, policies and objects must remain unchanged by this migration. No broad schema-level revoke or drop is proposed.

## Object storage

| Bucket | Public | Observed metadata objects |
|---|---|---:|
| wayfinding-bundles | yes | 37,167 |
| wayfinding-sources | no | 1 |
| project-media | yes | 0 |
| spatial-models | no | 1 |
| spatial-images | no | 0 |

Published object groups include GCU v4 (4,542), GCU v5 (836), UNCC v1 (15,894), UNCC v2 (15,893). Additional objects fall outside those prefixes. GCU v5 config, POIs and graph are present; this alone does not verify all assets or align editable records with the bundle. Object-byte backup is separate from logical database backup; no objects were replaced.

## Captured destination backup — restore-verification gate HOLD

The Management API reports seven **completed physical** backups, PITR disabled. Latest observed backup ID **2245883379**, captured **2026-11-12 18:13:02 UTC / 23:43:02 IST**. The inventory is saved in `evidence/supabase-management.json`.

The user supplied a working database credential through the ignored local
`dashboard/.env.production-migration` file (0600). URI password escaping was
corrected locally. The direct database hostname did not resolve from this
machine, so the documented session endpoint was verified instead:
`aws-0-ap-southeast-1.pooler.supabase.com:5432`, scoped to this project. The
connection verified PostgreSQL 17.11, Alembic `0001`, read-only mode, and libpq
client TLS. The server-side proxy hop's `pg_stat_ssl` value is distinct from
client-to-pooler encryption. No password or connection secret is in this report.

**An actual full logical backup was captured**, completed **2026-11-13
12:51:34 UTC / 18:21:34 IST**. A single exported repeatable-read, read-only
snapshot was shared by `pg_dump` and the table count/content-digest inventory.
The archive preserves original owners, ACLs, schema definitions and policies;
global roles/memberships were separately exported without role passwords.

| Evidence | Actual result |
|---|---|
| Private archive | `platform/var/data/production_migration/2026-11-13-supabase-1247/destination.dump` |
| Format / bytes | PostgreSQL custom archive / **6,995,284 bytes** |
| SHA-256 | `4f1781bb50419e25cafb8938a6cf7c3ef5e3bc7851613f2769b6c97c6ccb08bf` |
| Snapshot inventory | **130 tables**, including **82 public tables / 20,121 rows** |
| Migration metadata | Alembic `0001`; 21 Supabase migrations |
| Global recovery metadata | 30 roles, 2 publications; role password hashes excluded |
| Archive directory read | PASS |
| Full archive decoding without SQL execution | PASS |
| Schema export and checksums | PASS, generated offline from the captured archive |
| Directory / files | 0700 / 0600; ignored by Git |
| Isolated complete restore | **NOT RUN / HOLD** |

Private package files include `destination.dump`, `schema.sql`,
`roles-without-passwords.sql`, `snapshot-inventory.json`,
`source-requirements.json`, and `capture-manifest.json`. Public proof without
record contents: [`evidence/destination-backup-summary.json`](evidence/destination-backup-summary.json).
An initial schema-only decoding command required an explicit output flag; it
was corrected and finalized entirely offline without repeating the production
dump. The diagnostic is preserved privately.

The full restoration gate remains unpassed. The available local server is PG18,
not PG17, lacks the exact Vault/PostGIS versions, and needs an isolated cluster
with reviewed roles, preload and publication configuration. Details and actual
read-only inspection: [restore prerequisites](destination-restore-preflight.md).
The captured Vault table has zero records; this fact is evaluated separately
from the requirement to restore its schema/extension. A decoded archive is not
a completed restoration, and the local-source restore in report 02 does not
satisfy the destination gate.

`scripts/production_migration/capture_destination.py` implements the full
same-snapshot capture and offline verification. The older `audit.py` helper is
still available for generic read-only inventory/ownerless exports but is not
the complete destination recovery package. Storage object bytes and external
configuration are separate recovery inputs. No production merge, security
mutation or connection cutover is eligible until complete recovery verification
passes.

References: [Supabase backup behavior and Storage exclusion](https://supabase.com/docs/guides/platform/backups), [backup inventory API](https://supabase.com/docs/reference/api/v1-list-all-backups), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
