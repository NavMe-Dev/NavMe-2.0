# Final release report — PRODUCTION RELEASE — HOLD

Recorded 2026-11-13, Asia/Kolkata; updated after destination capture at **18:21 IST**. The audit, recoverable local backup, complete destination logical capture, comparison, local fixes, staging security candidate, tests and evidence have been executed. **The requested live recovery has not been achieved.** No production data, security policy, environment configuration, deployment or DNS setting was changed.

Latest live check at **17:36:42 IST**: website HTML **200**, database health **500**, venue manifest **500**. Latest existing Render deployment remains `dep-dbgre2h42hec73drki50`, commit `78e309de5938b46d50f9fd38763d9ea70a209405`. A Render deployment marked live does not establish a healthy application. Evidence: [`final-live-status.json`](evidence/final-live-status.json) and [`render-baseline.json`](evidence/render-baseline.json).

## Architect report

The intended architecture preserves the existing Render service/domain and uses only the occupied Supabase project **`kzpvhzyefdtrtidrbuxb`** for the backend database and existing durable assets. The separate legacy dashboard and ConnectLabs datasets remain in that project. No replacement production project or service was created.

The immediate outage is the backend's continued connection to the expired Render hostname, which fails DNS resolution. The exact service was identified independently from the database: web service `srv-db32v3bncjis73e9l2cg`; expired database `dpg-db32uq3ncjis73e9k3q0-a`. Effective Render environment access remains unavailable. The user-supplied destination credential now works: exact-project session pooler on 5432, client TLS, read-only mode, PostgreSQL 17.11 and Alembic `0001` were verified. The ignored local migration URI was corrected for password escaping and saved with 0600 permissions; no secret was copied into these reports.

Preservation results:

- All 82 existing public tables were counted exactly, totaling 20,121 rows; catalog metadata, grants/policies/functions/triggers, migrations and Storage were inventoried. No destination records were changed by this session. Post-merge preservation has not been demonstrated because no merge occurred.
- The local development database was dumped and restored into a new isolated database. All 11 table count/content fingerprints and sequence states match. Archive SHA-256: `13f3998a7de60096a2e17cc05d7dca5fa8b20137136d14c59d286f5766d9ae24`.
- The user confirmed local production provenance is **unknown**. This copy is a recovery candidate, not an approved replacement for Render data. The suspended source itself was not recovered or exported.
- Exact shared-table comparison found 11 structurally compatible tables and 71 destination-only tables to preserve. RLS/extension/version differences are separately recorded.
- Actual four-table identity comparison found **5 matches, 232 content conflicts, 215 insertion candidates and 101 primary-key collisions**. Existing destination GCU v5 is preserved. Approved/executed production inserts, updates and deletes are all **zero**.
- Supabase has seven completed provider physical backups. A full **130-table**, **6,995,284-byte** logical archive has now been captured using a read-only exported snapshot, retaining owners/ACLs and with password-free global roles captured separately. The archive fully decoded and its SHA-256 is `4f1781bb50419e25cafb8938a6cf7c3ef5e3bc7851613f2769b6c97c6ccb08bf`. Snapshot digests cover all 130 tables; public counts remain 82 tables/20,121 rows. No destination backup has been fully restored in isolation. Actual local preflight identifies PG18 versus PG17, unavailable exact Vault/PostGIS versions, missing roles, preload and publication settings. The verified zero-row Vault table does not create a hypothetical ciphertext-key blocker. This mandatory restore gate remains blocked. See [destination backup](03-supabase-inventory.md) and [restore prerequisites](destination-restore-preflight.md).

Security remains critical: **30 public tables have RLS disabled**, including sensitive account/login/user tables with anonymous read/write grants; advisors also flag 39 privileged function signatures for each browser role. The legacy dashboard uses an anonymous authorization token after custom login. Generic ownership policies cannot safely repair that architecture. A narrow backend-only role/RLS candidate passed real isolated tests, but does not fix those shared legacy findings. See [security review](07-security-review.md) and [Supabase RLS remediation guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Scalability/operations: prepared connection limits bound each process to five pooled connections, with timeouts and graceful disposal. Actual Supabase backend/pooler limits, selected session/direct endpoint, TLS trust and concurrent process budget still require verification. Oregon-to-Singapore database latency has not been measured. The repository's broad dependency ranges and Docker rebuild must be reviewed against deployed runtime compatibility.

## Developer report

Implemented locally:

- Normalized PostgreSQL Connect URLs to the installed psycopg 3 driver; configured bounded pools, connection/query/lock timeouts and TLS overrides without logging secrets.
- Added database/PostGIS/schema readiness, independent liveness, redacted database 503 responses, transient polling recovery and graceful worker/pool shutdown.
- Added occupied-database startup migration opt-out. No automatic production migration was executed.
- Made missing/corrupt published bundles fail explicitly instead of silently producing incomplete successful manifests.
- Fixed the startup translation-key leak, alert semantics and mobile Retry target. A real manifest failure remains visible.
- Fixed the existing E57 NumPy fallback guard and exercised its authentic fixture without optional Open3D. Optional pye57 was installed only in the local development environment.
- Added guarded backup/inventory, full same-snapshot capture with password-free roles, read-only restore prerequisites, exact schema comparison and digest-based reconciliation tools; staging-only security SQL; read-only browser smoke/failure tests and bounded published-asset/route probes. Native archive/schema decoding ran offline without a restore connection. No production apply operation was generated for unresolved data.

Database integration is prepared, **not cut over**. All three frontend builds pass. Patched API read-only checks against the actual local development database return health/manifest 200, but local GCU v1 differs from destination GCU v5. Local success cannot prove production compatibility.

Published GCU v5 is recoverable at the inspected reference level: config, 131 pipeline POIs, 1,073 graph nodes, 3,842 edges and 27 referenced assets were validated. It is distinct from the 230 curated destination POIs. UNCC v2 has one missing walkgrid and 20 POIs without a nearest node. Both bundles have unresolved floor-height/elevation defects. Four ordinary offline routes succeed; four corresponding step-free requests return no route. These data findings were recorded without altering authentic records. See [published asset report](published-asset-integrity.md).

No production build/deploy was triggered. Actual new deployment ID: **none**. The proposed environment changes and previous-release/rollback limitations are in reports [13](13-production-deployment.md) and [14](14-rollback-plan.md).

## QA tester report

Latest result per defined suite, counted once; targeted subsets and repeated verification are not added again:

| Suite | Total | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Platform pytest | 155 | 153 | 0 | 2 |
| Backup/schema/reconciliation/capture/preflight tooling | 74 | 74 | 0 | 0 |
| Isolated PostgreSQL authorization | 7 | 7 | 0 | 0 |
| Browser/API assessment: 33 live checks, 8 isolated regressions, 2 local API checks | 43 | 28 | 15 | 0 |
| **Defined-suite total** | **279** | **262** | **15** | **2** |

The tooling row comprises 21 original backup/schema/reconciliation tests, 27 capture safety tests, and 26 latest restore-preflight tests, each suite counted once. The 15 failures reproduce the current production outage and startup defects. They were not reclassified as passes after a local fix. The two platform skips are an absent Greenland workspace and an absent E57 ZIP fixture. Three frontend build successes, local source restore fingerprints, actual destination archive decoding/connection probes, 60 public asset HEAD probes (59 available/1 missing), and eight offline route/no-route diagnostics are supplementary evidence, outside the table's assertion count. No complete occupied-destination transactional merge rehearsal or full production feature regression passed.

Desktop/tablet/mobile/small-mobile screenshots capture actual failure state at 1440×900, 768×1024, 390×844 and 360×800. All failed-page layouts fit horizontally; real map/search/floor/popups/navigation remain untested. The local error regression passes eight cases. Anonymous production admin read correctly returns 401; real login/logout/session/publishing acceptance is outstanding. The available headless Chrome lacks WebGL2, preventing independent ArcGIS rendering acceptance.

Actual measurements include the failing live manifest at 261 ms in the browser baseline and 307.5 ms in the final API probe; failed-page load events were approximately 2.7–4.9 seconds across devices. These are individual observations of failed startup. They are not usable-map timings. POI rendering/search and live route timings remain unavailable. Local offline route timings are separately labeled in the asset report.

Evidence: [platform tests](evidence/platform-pytest.txt), [security tests](evidence/security-staging-tests.txt), [capture safety tests](evidence/capture-safety-tests.txt), [destination backup summary](evidence/destination-backup-summary.json), [functional results](11-functional-test-report.md), [mobile results](12-mobile-test-report.md), [desktop production screenshot](evidence/browser/desktop-before.png), [mobile production screenshot](evidence/browser/mobile-before.png), [local error-only fixture screenshot](evidence/browser/mobile-isolated-error-after.png). Private raw logs, database archives, schemas and password-free role exports stay under ignored `platform/var/` paths; no credentials or database dumps were added to Git.

## Mandatory release gates

| Gate | Status / exact reason |
|---|---|
| Source recovery/reconciliation | BLOCKED: expired source unavailable; local provenance unknown |
| Destination backup | Capture/checksums/decoding PASS; complete isolated restore BLOCKED by confirmed environment prerequisites |
| Merge integrity | NOT RUN: no approved executable merge or occupied-destination rehearsal |
| Existing Supabase records preserved | No session mutations; post-merge integrity gate NOT RUN |
| Database connectivity | Exact-project native session/TLS/read-only probe PASS; intended restricted-role Render backend cutover BLOCKED |
| Critical security | FAIL: legacy RLS/grant/privileged-RPC defects remain |
| Backend health | FAIL live, 500 |
| Venue manifest | FAIL live, 500 |
| ArcGIS map rendering | BLOCKED by manifest and test-browser WebGL2 limitation |
| Building/floor/POI navigation | BLOCKED; independent published data defects recorded |
| Search and routing | BLOCKED live; ordinary offline probes are partial evidence only |
| Admin authentication | Anonymous denial PASS; full authenticated flows NOT VERIFIED |
| Mobile regression | Error-state regressions PASS locally; functional map acceptance BLOCKED |
| Production build | Three frontend builds PASS; deployed container/release NOT VERIFIED |
| Live smoke tests | FAIL: 15 baseline failures; no replacement release |

## Required continuation and ETA

Preparation is complete to the current access/safety boundary. A reliable **go-live ETA remains unavailable** while the critical gates above fail. The earlier 20–30 minute estimate concerned preparation, not a guaranteed production restoration.

The database credential is now available and verified in ignored `dashboard/.env.production-migration`; no further database-password input is needed for the current workflow. The next recovery prerequisite is a fresh isolated PG17 environment with the exact required extensions and reviewed role/server settings so the captured archive can be completely restored and compared. Render environment read access still needs a working authenticated service/API path. Existing access does not itself approve unreviewed database changes.

Then complete the destination restore rehearsal, obtain an authoritative source or approve exact record reconciliation, resolve key remapping/publication/security defects, validate the scoped backend connection and browser feature flows, and present the concrete reviewed production changes for approval. The user's request explicitly prohibits proceeding through critical recovery/preservation failures. No production-write or deployment approval is requested prematurely while the candidate remains unsafe.
