# Merge dry-run evidence

**Source-data merge rehearsal: NOT RUN / HOLD. Destination recovery and scoped
reader-role rehearsal: PASS.** The occupied destination's complete backup was
actually restored and verified on matching PostgreSQL 17.11. Local-source
provenance remains unknown, so its 232 content conflicts and 101 key collisions
have not become an approved data-transfer plan. A verified destination restore
is not a claim that an unapproved local-source merge occurred.

Completed checks:

- Complete occupied-destination logical archive captured from a read-only
  exported snapshot (130 tables), preserving owner/ACL records and separate
  password-free roles; archive fully decoded and checksummed.
- Full occupied destination restored in a network-isolated matching Supabase
  PostgreSQL 17.11 image, with exact PostGIS/Vault versions and source ICU locale.
- All **130** frozen table counts and complete row digests match. Migration
  histories, seven installed extension versions and all captured source
  role/membership/schema/policy/event-trigger/ACL/configuration categories match
  the separate current metadata sidecar.
- All **15** sequence states match the original archive. Four sensitive
  coordinate tables additionally match a full-precision current source check.
- After actual reader-role, SCRAM authentication and denied-write staging tests,
  all 130 table digests/counts and all 15 sequences remain unchanged.
- Consistent custom-format local development dump created and archive read.
- Dump restored into a new isolated local database with exit 0.
- All 11 source table aggregate record digests/counts and sequence states match
  the restored local copy.
- Offline reconciliation/backup/schema comparison safety tests: **21 passed**.
- Real read-only source/destination snapshots compared for buildings, floors,
  POIs, and publication versions (553 local rows versus 241 destination rows).
- This source-recovery work performed no production data transfer or restore.
  Production role/configuration changes, when authorized, are separate release
  operations recorded in report 13.

The offline comparison found **5** exact content matches, **232** differing
records with matching business identity, **215** new-record candidates requiring
relationship review, and **101** different-business-record primary-key
collisions. All 241 destination rows are preserved by the proposal. These
outcomes are comparisons, not inserts or accepted conflict resolutions. Details
are in `06-conflict-report.md` and `evidence/identity-conflicts.json`.

The safety tests cover primary-key collisions between different business
records, differing fields on the same business identity, exact identity matches
despite remapped integer IDs, duplicate/missing identity, protected tables,
relationship-review requirements, private report output, host validation,
credential handling, unreadable backup rejection, and PostgreSQL 17/18 NOT NULL
catalog representation, complete-catalog requirements, Connect-panel URL driver
selection, and remote TLS downgrade rejection. These are tooling tests,
not production feature or data-integrity tests.

Command:

```sh
platform/.venv/bin/python -m pytest -q \
  scripts/production_migration/test_reconcile.py \
  scripts/production_migration/test_audit.py \
  scripts/production_migration/test_schema_diff.py
```

Restore evidence and the exact local dump checksum are in
`02-render-recovery.md`; raw private evidence remains in the ignored local
production-migration directory.

Complete destination restore evidence:
[`destination-restore-preflight.md`](destination-restore-preflight.md) and
[`evidence/destination-restore-verification.json`](evidence/destination-restore-verification.json).

Remaining **local-source merge** assertions: approved provenance/identity policy,
exact insertions and FK remapping, absence of duplicate business entities,
sequence allocation for proposed inserts, and unchanged occupied/shared records
after that reviewed merge. No local candidate is imported merely because the
destination recovery rehearsal passed.
