# Data conflict review

Status: **HOLD**. No conflicts are silently discarded. No destination record is
approved for overwrite. A business-identity comparison of hashed records is
prepared in `scripts/production_migration/reconcile.py`.

Known conflict classes from inspected metadata:

- Local `gcu` and destination `gcu` share Matterport model `jdjvM17BPEh`, but
  their names, status, timestamps, editable counts, and publication histories
  differ. Preserve the existing destination building and report field changes.
- Local current `gcu` v1 conflicts with destination current `gcu` v5. Preserve
  destination v5; do not republish local v1 or overwrite shared bundle paths.
- Local `uncc-main-campus` is absent from the inspected destination building
  inventory. It remains a recovery candidate pending provenance, asset,
  identity, FK, and permission review.
- Local map-version IDs 2 and 3 represent UNCC v1 and v2, while destination IDs
  2 and 3 represent GCU v2 and v3. Integer-key equality would corrupt identity;
  stage a reviewed ID remapping before any insertion.
- Local and destination user IDs/counts do not establish the same people.
  Authentication records stay outside automatic merge scope.
- Graphs lack an enforced stable unique business-version identity; jobs may
  replay work. Both require separate manual decisions.

The machine-readable reconciliation output contains source-record and identity
digests with explicit outcomes. It deliberately has `executable: false`,
`production_approved: false`, `proposed_updates: 0`, and
`proposed_deletions: 0`. An insertion candidate is not an approved insert.

## Actual offline comparison

Read-only snapshots of the local source and exact destination were compared
using UTC PostgreSQL JSONB content digests. Each digest covers every non-PK
column. For child tables, the parent integer ID is excluded and replaced with
the parent building slug for business identity; all remaining fields are hashed.
There is no ignore-timestamps or prefer-newest rule. Different hashes are
conflicts even when the difference might later prove to be metadata alone.

| Table | Source / destination | Exact matches | Content conflicts | New candidates | PK collisions | Destination-only |
|---|---|---:|---:|---:|---:|---:|
| buildings | 2 / 1 | 0 | 1 | 1 | 0 | 0 |
| floors | 12 / 5 | 5 | 0 | 7 | 0 | 0 |
| pois | 536 / 230 | 0 | 230 | 207 | 99 | 0 |
| map_versions | 3 / 5 | 0 | 1 | 0 | 2 | 4 |
| **Total** | **553 / 241** | **5** | **232** | **215** | **101** | **4** |

Every destination record is preserved, including the four destination-only GCU
publication versions. The 101 collisions are different business identities
sharing a PK; they require reviewed allocation and dependent-reference remapping,
not overwrite or silent discard. The 215 candidates also remain blocked pending
provenance and relationship review. Users, jobs, graphs, and shared datasets are
outside this four-table identity comparison and remain protected.

Machine-readable per-record digest report:
[`evidence/identity-conflicts.json`](evidence/identity-conflicts.json). Private
input snapshots remain in the ignored local recovery directory. The actual
occupied-destination database restore and transactional merge rehearsal remain
**NOT RUN** pending the required backup and approval gates.
