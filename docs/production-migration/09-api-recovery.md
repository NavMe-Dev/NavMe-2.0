# Venue manifest API recovery — root cause confirmed, production not restored

Audit date: 2026-11-13 (Asia/Kolkata).

## Confirmed production failure

The production request is:

`GET https://wayfinding.navme.space/api/v1/public/venues/all/manifest.json`

Live Render runtime logs on November 13 show psycopg failing to resolve hostname **`dpg-db32uq3ncjis73e9k3q0-a`**, the expired Render source database. The running service still attempts its old source connection. This is direct evidence of a backend database connectivity failure; an initialized ArcGIS SDK does not resolve it.

Production cutover remains on HOLD. Non-secret recovery flags were prepared
on Render, but neither the new application code nor the working reader
database URL has been activated. No missing venue/publication record was
fabricated and no source record was merged into production.

## Request and data dependency chain

1. Viewer startup requests the venue manifest from the Render API.
2. `routers/public.py:manifest` calls `venue_manifest` using a SQLAlchemy session.
3. Virtual venue `all` queries all `buildings`; named venues query `venues` and their relationships.
4. For each building, `services/publish.py:current_version` selects the highest `map_versions.version` with `is_current=true`.
5. `services/bundle_storage.py:read_bundle_file` reads that publication's `config.json` locally, then falls back to the configured public Supabase bundle bucket.
6. The manifest emits the existing `wayfinding.venue/v1` structure, center/bounds, floor references, version, and building data paths.
7. Viewer POIs, indoor layers, navigation graph, and other assets load through the existing building data endpoints. Successful manifest JSON alone does not validate those dependencies.

The root database failure occurs before usable published venue data can be produced. Restoring connectivity must also preserve destination data and resolve publication/version differences; pointing at a dataset with superficially similar table names is insufficient.

## Local implementation fixes

- Database failures now produce HTTP **503** with `detail: database unavailable` and `Retry-After: 5`, rather than leaking raw driver/SQL details. Safe server logs identify the exception class. This accurately reports unavailability and does not claim manifest success.
- The previous manifest behavior silently skipped published buildings whose `config.json` was missing both locally and in Storage. That could return an empty or incomplete HTTP 200. The prepared code instead returns **503** with `detail: published venue data unavailable` and `Retry-After: 30` when a referenced publication is missing or corrupt.
- Existing manifest fields and published building identity are preserved when the data is available. Unknown named venues remain HTTP 404. Unpublished buildings remain excluded by the existing publication rule.
- `/api/health` checks PostGIS and the application tables; `/api/live` independently checks process liveness.

These recovery/error-reporting changes are in local commit
`616b4a960216cd0e500c5dd113480d1f3059eec9`, **not a deployed connectivity fix**.
GitHub rejected the push with HTTP 403 for the current account. The reviewed
code cannot reach the existing Render deployment until repository write
access is restored. The database reader has independently passed all native
and shadow connection checks; its URL intentionally remains unactivated on
Render until the new mutation-gated code is available.

## Actual unchanged-destination shadow verification

An isolated local FastAPI shadow now uses the real destination connection,
existing GCU v5 publication, private temporary cache, verified PostgreSQL
read-only sessions, disabled workers/migrations, and an HTTP mutation gate.
`evidence/read-only-shadow-api.json` records **22 of 22 expected-status checks**:
healthy database, actual GCU v5/five-floor manifest, core published assets,
curated public metadata, ordinary same-floor and multi-floor route responses,
invalid POI/missing venue errors, anonymous administrator denial, and blocked
feedback mutation. This is local shadow evidence, not a deployed-domain claim.

The complete API check and a separate 24-check privacy/authorization preflight
were repeated successfully after replacing the owner-backed shadow with the
actual independently credentialed production reader. That login cannot mutate
application tables, use sequences, create a schema, access unrelated public
columns, or invoke privileged application RPCs. Evidence:
`evidence/actual-reader-shadow-api.json` and
`evidence/actual-reader-shadow-privacy.json`.

The two tested step-free pairs returned HTTP 404 because the existing graph
has no qualifying route; matching that expected failure does not pass an
accessibility-routing acceptance gate. Search/rendering/mobile evidence is
recorded independently by browser QA.

Public curated POI responses now additionally require a current publication
and `published=true`; an isolated API test verifies that unpublished POIs and
entirely unpublished buildings do not leak through that endpoint. All 99
existing GCU curated POIs are already published, so this guard preserves the
observed current public result.

## Independent publication-asset evidence

Read-only public Storage checks recovered existing GCU v5 and UNCC v2 configuration, POIs, and navigation graphs. The separate [published-asset integrity report](published-asset-integrity.md) records identities, reference checks, counts, offline route probes, and actual defects: a missing UNCC walkgrid, 20 UNCC POIs without nearest-node references, and floor metadata requiring review. Published-bundle counts differ from editable draft-table counts and must not be conflated. These findings are not permission to import or rewrite either publication.

Storage availability demonstrates a durable copy of some publication artifacts. It does not establish Render source-database completeness, resolve source/destination identity conflicts, replace a verified destination backup, or pass routing/browser release gates.

## Automated verification

The recovery tests cover installed-driver URL selection, TLS override, pool/timeout bounds, preserved startup options, production-test-target refusal, redacted database outage handling, missing-schema readiness, graceful shutdown, startup migration suppression, valid manifest schema, missing/corrupt bundle failure, unknown venue 404, polling recovery, and stop behavior.

Latest full local platform result: **182 passed, 2 skipped**, including 41 recovery/resilience tests and 10 startup readiness tests; log: `evidence/platform-pytest.txt`. A pre-existing E57 regression initially failed because the documented NumPy fallback was blocked by a mandatory Open3D check. The fallback guard was repaired and the existing real fixture test explicitly exercises it without Open3D. Optional `pye57 0.4.19` was installed in the local venv; no Open3D installation or production dependency change occurred.

## Remaining acceptance and access gates

- Authorized GitHub write access so the reviewed local commit can reach the existing Render service.
- Activate only the independently credentialed reader URL with the reviewed new code, then verify the Render process's startup/read-only state.
- Follow the authorized initial read-only recovery scope in `16-read-only-recovery-decision.md`; unknown source records remain quarantined and writable/shared-application security changes remain separately gated.
- Live HTTP 200 with valid `wayfinding.venue/v1` JSON and the expected published buildings/floors.
- Correct POIs, graph, asset references, and public/private boundaries under the selected publication versions.
- Browser desktop/mobile rendering, search, routes, multi-floor behavior, and administrative authorization.

The complete destination backup/restore rehearsal, record preservation,
matching PG17 reader-role tests, actual native reader connection, local
startup gate, 22 API checks, and 24 privacy checks have passed. They must not
be presented as successful live-domain deployment or browser verification.

An HTTP 503 response is a truthful outage signal. It is not a passing manifest release gate.
