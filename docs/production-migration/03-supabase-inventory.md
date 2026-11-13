# Occupied Supabase destination inventory

Audit date: 2026-11-13. Exact project **NavMe-2.0 / `kzpvhzyefdtrtidrbuxb`**. Status ACTIVE_HEALTHY, Singapore, PostgreSQL 17.11, PostGIS 3.3.7 in `public`. Baseline inspection and backup were read-only. The subsequently authorized scoped reader migration added two roles, ten reader SELECT policies and one expected migration-history record; **no application-data DML was performed and every original record was preserved**.

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

All ten backend tables including `alembic_version` are owned by `postgres` with RLS enabled and no browser policies. The scoped backend reader now has SELECT-only policies and has passed actual PostgreSQL 17, SCRAM authentication, privilege-denial and shadow-API checks. These are backend-principal policies, not browser access. A successful administrator MCP query alone was not counted as restricted-reader verification.

Installed extensions: plpgsql 1.0, pg_stat_statements 1.11, uuid-ossp 1.1, pgcrypto 1.3, supabase_vault 0.3.1, postgis 3.3.7, btree_gist 1.7. The backend Alembic version is `0001`. The captured Supabase migration history had 21 entries, beginning `20261021155131` and ending `20261111091258`; most recent entries belonged to Spatial Studio/ConnectLabs. All 21 original entries were preserved, with exactly one new authorized reader migration added afterward. All `spatial_*` / `spatial_private` data and dependencies remain unchanged by the scoped reader work.

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

## Captured destination backup — isolated recovery verification PASS

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
| Isolated complete restore | **PASS**, actual matching Supabase PostgreSQL 17.11 VM |
| Frozen table records | **130/130 complete row digests and counts match** |
| Original archive sequence states | **15/15 exact**, without consuming values |
| Security/database metadata baseline | **All nine captured categories match** |
| After reader-role staging tests | All 130 frozen table records and 15 sequence states unchanged |

Private package files include `destination.dump`, `schema.sql`,
`roles-without-passwords.sql`, `snapshot-inventory.json`,
`source-requirements.json`, and `capture-manifest.json`. Public proof without
record contents: [`evidence/destination-backup-summary.json`](evidence/destination-backup-summary.json).
An initial schema-only decoding command required an explicit output flag; it
was corrected and finalized entirely offline without repeating the production
dump. The diagnostic is preserved privately.

The initial native PostgreSQL 18 preflight could not pass, so an actual separate
Linux VM was created using portable Lima/native macOS virtualization and the
official Supabase PostgreSQL 17.11 image. Exact PostGIS 3.3.7 and Vault 0.3.1,
source ICU locale, original bootstrap grantors, native Supabase privilege hooks,
all captured data and managed security metadata were restored there. This was
an executed restoration, not an inference from archive readability or the
independent local-source restore in report 02.

All 130 frozen table digests/counts, migrations and seven extension versions
match. The separate current read-only metadata sidecar also matches: 30 roles,
24 memberships, ten schemas, 80 original policies, seven event triggers,
415 relation ACL/owner/RLS records, 1,098 function ACL/security/config records,
and database owner/ICU/ACL/settings. Original source role OIDs and the deliberately
different staging database name are normalized by identity. Source serialization
settings were matched explicitly; four precision-sensitive coordinate tables
additionally match a fresh full-precision source comparison. All original backup
checksums remain unchanged. See the [executed recovery report](destination-restore-preflight.md)
and [`evidence/destination-restore-verification.json`](evidence/destination-restore-verification.json).

The captured Vault table has zero records; encryption-key recovery is not a
separate blocker for this verified empty snapshot. Its extension/schema was
still restored completely. A separate allocation audit found one pre-existing
counter behind its table's key range (`navme_ar_events_id_seq`: value 1, not yet
called, versus maximum ID 15,208). ID 1 is currently unused, so no immediate
next-ID collision was demonstrated. The other 14 owned sequences align beyond
existing IDs. Restoration faithfully preserved the original states; it did not
change this unrelated counter or silently claim perfect source sequence health.

`scripts/production_migration/capture_destination.py` implements the full
same-snapshot capture and offline verification. The older `audit.py` helper is
still available for generic read-only inventory/ownerless exports but is not
the complete destination recovery package. Storage object bytes and external
configuration are separate recovery inputs. Recovery verification passed before
the scoped production reader migration; that does not establish that the Render
code deployment, public viewer or broader release gates have passed.

## Production preservation after scoped reader migration

The authorized production reader work added **two scoped principals**, **ten
SELECT-only backend policies** and **exactly one expected migration-history
record**. It performed no application-data DML and imported no uncertain local
records. A subsequent read-only preservation comparison verified every original
record across **all 130 captured tables**, including all **21 original migration
history records**. The single added history row is explicitly identified rather
than hidden behind a changed table hash.

Public proof contains only counts, booleans and the expected migration identity:
[`evidence/production-reader-preservation-summary.json`](evidence/production-reader-preservation-summary.json).
The private per-table comparison stays in the ignored recovery directory.
Neither this preservation check nor successful shadow-API testing is evidence
that the Render reader URL was activated or the production viewer deployed.

References: [Supabase backup behavior and Storage exclusion](https://supabase.com/docs/guides/platform/backups), [backup inventory API](https://supabase.com/docs/reference/api/v1-list-all-backups), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
