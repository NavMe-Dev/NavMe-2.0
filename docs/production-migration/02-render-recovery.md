# Source recovery evidence — 2026-11-13

Release gate: **HOLD**. An independent local development copy is recoverable;
the user confirmed its production provenance is unknown, so it is ineligible
for transfer without an approved reconciliation. It is not established as a
complete or authoritative copy of the expired
Render database `dpg-db32uq3ncjis73e9k3q0-a`. No Render upgrade, allowlist change,
authentication bypass, or production database write was performed.

The live source is suspended with billing as its suspender, and its external
allowlist is empty. The read-only Render query was rejected at that network
boundary; no source connection or source dump succeeded. The connector has no
Recovery-page/export inspection capability, and authenticated Dashboard/SSH
access was unavailable. Account-specific export availability is therefore
unverified. [Render's recovery documentation](https://render.com/docs/postgresql-backups)
says managed recovery/backups are not provided for Free databases. Its
[Free database policy](https://render.com/docs/free#30-day-limit) says expired
databases are inaccessible and have a 14-day grace period before deletion.
Applied to the observed November 6 expiry, the nominal policy window ends
**November 20, 2026, 17:09 IST**; this is a policy-based inference, not a verified
account-specific recovery guarantee. No upgrade was attempted, as instructed.

The infrastructure audit records the live Render suspension/network evidence.
The repository contains no pre-existing custom PostgreSQL dump, `.backup`,
compressed SQL export, or documented backup archive available in this checkout.
`platform/scripts/backup.sh` describes the historical backup convention
(`platform/backups/<timestamp>.tar.gz`, database plus assets); that directory is
absent here. Deployment documentation recommends an off-host copy, but a
recommendation is not evidence that such a copy exists.

## Independent local source

The root environment points the platform to local `127.0.0.1:5432/wayfinding`.
Credentials were consumed privately and never printed. Read-only inspection
found PostgreSQL **18.6**, PostGIS **3.6.4**, and Alembic revision **0001**. This
differs from the stated Render PostgreSQL 16 source. Neither matching migration
revision nor matching building slug proves a production snapshot.

| Table | Exact local rows |
|---|---:|
| buildings | 2 |
| floors | 12 |
| pois | 536 |
| nav_graphs | 5 |
| map_versions | 3 |
| jobs | 11 |
| users | 2 |
| venues | 0 |
| control_points | 0 |
| alembic_version | 1 |
| spatial_ref_sys | 8,500 |

Building `gcu` uses Matterport model `jdjvM17BPEh` and has 366 editable POIs.
Building `uncc-main-campus` uses `kQBN52JqFE9` and has 170 editable POIs. The
database marks both buildings `ready`. Current local publication rows are `gcu`
v1 and `uncc-main-campus` v2; the latter also has an older v1. Destination GCU
publication v5 must remain untouched.

The disk contains **27** published bundle directories totaling **11,568,966,021
bytes**. Some versions have no corresponding local publication row. These
artifacts need their own provenance and asset-integrity audit; folder presence
does not establish a production publication. The 11.57 GB assets have not been
copied to durable off-host storage as part of this run.

## Verified local logical backup

The new restricted directory is
`platform/var/data/production_migration/2026-11-13-local/` (ignored by Git).
Directory permission: 0700. Dump permission: 0600.

| Evidence | Result |
|---|---|
| Archive | `source.dump` (custom format, no owner/ACL) |
| Captured | 2026-11-13 11:51:27 UTC / 17:21:27 IST |
| Bytes | 2,311,581 |
| SHA-256 | `13f3998a7de60096a2e17cc05d7dca5fa8b20137136d14c59d286f5766d9ae24` |
| `pg_restore --list` | PASS |
| Isolated local target | `navme_recovery_verify_20261113` (new database) |
| Restore | PASS, exit 0, without clean/owner/ACL |
| Full row aggregate digests / counts | PASS for all 11 source tables |
| Sequence states | PASS, identical to source |

Private evidence files: `inventory-postgis.json`, `source.dump.json`,
`restore-verification.json`, `restored-inventory.json`,
`published-artifacts.json`, and `source-identities.json`. The initial dump
metadata correctly says restoration had not yet been verified; the subsequent
`restore-verification.json` records the completed restore. No backup contains
an assertion that local records are approved production data.

The restored local database was retained for review. This verifies the local
backup only; it does **not** verify the existing Supabase destination backup.
PostgreSQL 18 tooling cannot establish PostgreSQL 17 restore compatibility merely
by restoring back into PostgreSQL 18. A target-version rehearsal remains required.

## Remaining recovery gate

Obtain an authorized Render backup/recovery export or independently establish
which local records and assets are legitimate production recovery candidates.
Reconcile them with existing destination identities. Preserve destination
records and publication state throughout. If no authoritative source or approved
reconciliation exists, data transfer and production cutover stay blocked.

**Do not run `platform/scripts/restore.sh` against Supabase:** it uses a clean
restore that is incompatible with the occupied-destination requirements.
