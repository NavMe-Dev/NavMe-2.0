# UNC Charlotte demo stabilization report

Date: 2026-11-16. Candidate branch: `fix/uncc-demo-stabilization`.

**Later update:** the user explicitly authorized production deployment and controlled60-user testing. The historical HOLD below records the earlier preparation checkpoint. Two local60-user repeats now pass with the reviewed15-second wait, and native cold-cache recovery is coalesced/atomic. See [release preflight](UNCC_PROD60_LOCAL_PREFLIGHT.md) and [release checks](evidence/prod60/release-checks.json); live verification follows deployment.

**Production readiness: HOLD.** The reversible candidate is prepared for review, but neither release nor 100-user production capacity is accepted. Production remains unchanged. A real mobile-browser walkthrough could not complete because the external Matterport page presented a Cloudflare challenge. The local API benchmark is useful evidence, but its Apple host does not represent Render's 0.5 CPU / 512 MiB service.

The retained configuration keeps the existing 40 AnyIO worker tokens and five-connection database budget, with admission/backlog bounds of 128. It passed the local 40-user tier, then stopped at 60 after two database wait timeouts. A 16-token experiment improved some timings but failed an independent repeat and was excluded. Production has not been pushed, deployed or restarted.

## A. Baseline

### Repository, deployment and rollback checkpoint

- Original IDE branch and commit: `main`, `33a01cc242d09b10a3abe79cc5a159ca6ab4260b`.
- Frozen successful production commit and stabilization base: `74f37ed55f62d921ced485020389a1150f47facc`.
- The original IDE and deployed `platform/` and `dashboard/` trees were identical; their release histories differ because prior changes were cherry-picked.
- Render service: `srv-db32v3bncjis73e9l2cg`, `navme-wayfinding-platform`; workspace: MetaDigi Labs.
- Last successful live deployment: `dep-dbtel0etlv9c73f542v0`, finished 2026-11-16 17:06:05 Asia/Calcutta.
- Production URL: <https://wayfinding.navme.space/unc-charlotte>.
- Render reports one instance, plan `0.5c-512mb`, Oregon. The entrypoint starts one Uvicorn worker; effective production environment overrides still require verification.
- Checkpoint confirmed before optimization at 17:19:55 Asia/Calcutta. Work was isolated in `/private/tmp/navme-uncc-demo-stabilization`; the original workspace and its unfinished navigation-image changes were preserved.
- No production push, deployment, restart, database migration, RLS change, publication change or asset mutation was performed for this task. See [rollback checkpoint](UNCC_DEMO_ROLLBACK.md).

### Historical PDF findings

The supplied nine-page `UNCC wayfinder results.pdf` was located and its rendered pages inspected. It is the primary historical architectural reference. These figures are **historical report results**, not measurements of the candidate or the currently running production deployment.

| Historical finding | PDF location | Current investigation |
|---|---|---|
| 100 VUs; 1,007 failures / 3,102 requests, 32.46% HTTP failures | Page 1 | A new local comparison was run against the frozen live-base source and the candidate. |
| Saturation around 38–42 users; persistent 502 after worker failure | Page 1 | Local baseline reproduced degradation and two retryable 503s at 40 users; it did not reproduce a worker crash or persistent 502. |
| Route success 56.42%: 189 passes / 146 failures | Page 1 | Route response/geometry equivalence was checked separately; the historical success rate is not a current baseline. |
| `nav_graph.json` 4,766,733 bytes, approximately 4.77 MB | Pages 2–3 | The copied local UNC v2 graph has that exact byte size. Current UNCC Matterport mode already avoids downloading it at boot; the browser attempt also recorded zero graph requests. |
| Approximately 26 SQL queries per session | Page 3 | Query-free sessions were not established; publication checks remain in place. No zero-SQL claim is made. |
| Repeated JSON parsing/NetworkX construction; 4,900 nodes and 15,783 edges | Page 3 | Confirmed in the frozen server-side route implementation and removed from warm route requests. |
| Simultaneous cold Floor 2 downloads; 23.28-second floor-switch median | Page 3 | Duplicate cold downloads were reproduced locally. The original end-to-end floor-switch latency was not reproduced. |
| Route query P95 17,335 ms; floor switch 23,288 ms | Page 9 | Historical figures only. Comparable local request measurements are below. |

The page 9 values of 150+ VUs, route P95 below 25 ms, zero SQL on warm sessions, a roughly 140 MB mobile footprint and reduced battery drain are **projections**, not achieved results. The proposed pool of 20 + 30 connections, global publication TTL bypass, UI changes, GPU throttling and Web Worker changes were not copied blindly.

### New local baseline and test boundaries

The reproducible harness is [benchmark_unc_demo.py](../platform/tools/benchmark_unc_demo.py). It uses real FastAPI handlers, one application worker, an isolated loopback PostgreSQL database ending in `_test`, and copied existing UNC v2 publication files. The copied graph hash is `a966ec368ca92da23134849c709471dfc3732d979ac318d49b9134d0401c5b63`. No live database or publication is used as a write/load target.

Each paced visitor requests the shared cold Floor 2 image, configuration and POIs, then two actual published routes. The storage origin is loopback HTTP with the real 202,510-byte floor image and a controlled 150 ms delay. Four reference route responses warm the graph before the measured tiers. Therefore the main tier run measures **warm graph routing with cold shared floor-file recovery**, not a cold startup for every user.

The local baseline completed 1, 10 and 25 users, then stopped at 40 after two route 503s among 200 requests. It was not pushed to 60 or 100 after the failure gate. Full evidence: [baseline](evidence/unc-demo-baseline.json), [initial stabilized run](evidence/unc-demo-stabilized.json), [comparison](evidence/unc-demo-benchmark-comparison.json).

## B. Fixes implemented

| File / function | Confirmed problem | Exact change | Regression evidence / result |
|---|---|---|---|
| `services/routing_cache.py`: `PublishedRoutingCache.get_for_publication()`, `_load_publication()`; `services/navgraph.py`: `prepare()`, `route()` | Each published route reparsed graph/POI/navmesh JSON and rebuilt the requested graph. Concurrent requests repeated the same allocations and CPU work. | Cache by resolved storage root, building and publication version. Parse once; build both regular and step-free graphs once; freeze shared data. Per-key construction sharing, 15-second waiter timeout, LRU limit of two entries, 96 MiB retained-data budget and at most two distinct pending builds. Failed loads leave a retryable key. New versions cannot reuse old-version state. | `test_routing_cache.py`, `test_public_routing_cache.py`; [graph before](evidence/uncc-demo/graph-cache-before.json) / [after](evidence/uncc-demo/graph-cache-after.json). All 21 sampled real-publication responses, including existing no-route results, match exactly before/after. |
| `routers/public.py`: `public_route()` | Warm routes still performed file reads, JSON parsing and graph preparation after the existing publication lookup. | Keep building/current-publication checks and existing session release, then route through the prepared publication. Preserve successful JSON and legitimate unknown-POI/no-route/missing-publication 404 behavior. No user-specific data enters the graph cache. | Actual HTTP route tests verify exact response equality, regular/step-free policies, invalid POIs, version changes, missing optional navmesh and recovery. Benchmark route hashes match with zero geometry mismatches. |
| `services/bundle_storage.py`: `cache_bundle_file()`, `read_bundle_file()` | Cold asset readers duplicated upstream downloads; byte readers wrote directly to their final cache path. | Per-root/building/version/path request sharing. Stream direct or split objects to a private temporary file and atomically replace the final path. Separate keys stay parallel; failed downloads clean temporary files and permit retry. Validate path containment. Preserve public-read requests without server credentials and byte-read fallback for an unwritable cache disk. | `test_bundle_storage.py`, `test_bundle_storage_concurrency.py`: 18 passed. Same 24-caller, 5 MiB synthetic cold file: downloads 24 → 1, complete results 24/24; [before](evidence/uncc-demo/asset-cache-before.json) / [after](evidence/uncc-demo/asset-cache-after.json). |
| `config.py`: `bundle_cache_wait_timeout_seconds`; `main.py`: `publication_busy()` | A shared preparation waiter needed a bounded wait and an accurate temporary-failure response. | Default waiter limit 15 seconds. A waiter does not cancel or duplicate its leader. Dedicated cache-contention exceptions return sanitized 503 JSON with `Retry-After: 5`; an actually missing file remains 404. | Timeout, failure/retry and sanitized-response tests in storage, routing and `test_database_resilience.py`. Success contracts and public error UI are unchanged. |
| `db.py`: `engine()`, `dispose_engine()` | Concurrent first requests could initialize competing engines/pools before the shared engine was published. | Lock first initialization; publish engine and session factory together; dispose a failed candidate; serialize disposal with initialization. | `test_engine_initialization.py`: 24 simultaneous callers share one engine; failed initialization can retry. |
| `routers/public.py`: `dashboard_route_by_coords()` | The draft-coordinate route path retained its database connection during subsequent navmesh I/O and route computation. | Materialize the graph and required georeference, then release the read session before navmesh access, snapping and graph work. Existing public route/asset/metadata early-release behavior remains covered. | `test_public_connection_lifetime.py` verifies no checked-out connection during graph/file/HTTP work and preserves publication, PIN and path restrictions. |
| `deploy/start-api.sh` | The Uvicorn entrypoint did not bound admitted connections/tasks or the accept backlog. | Keep existing worker/thread/pool settings; set validated positive `API_MAX_CONCURRENCY` and `API_BACKLOG`, defaults 128 / 128. This bounds admission rather than creating more threads. | Invalid-setting startup tests; [controlled admission test](evidence/unc-demo-admission-recovery.json): seven accepted / nine deliberately rejected requests with limit 8, followed by three healthy 200 responses. The final default-128 run passed through 40 users, then stopped at 60 after two database pool timeouts. |
| `viewer/wf_navmesh_route.js`: `route()` | Every route created a native/WASM `NavMeshQuery` without destroying it on success, early return or exception. | Release the query in `finally` after copying the existing JavaScript result. Retain coordinates, path calculations, distances, restrictions and error results. Bundled runtime is unchanged. | `viewer_navmesh_lifecycle.test.cjs`; 100 local routes: 100 creations / 0 destroys before, 100 creations / 100 destroys after. [Evidence](evidence/uncc-demo/navmesh-query-after.json). This is not a device/GPU memory measurement. |
| `viewer/mp_app.js`: `ensureNavmesh()`; `viewer/wf_navmesh_bridge.js`: `ensureRuntime()`; `viewer/wf_navmesh_route.js`: `load()` | Rejected initialization promises remained cached and permanently prevented a fresh route request from recovering after a transient failure. | Clear only the rejected promise; keep in-flight sharing and ready-cache reuse. No iframe source, SDK initialization, camera transition or cinematic changes. | `viewer_loading.test.cjs`, `viewer_navmesh_initialization.test.cjs`: failure then retry succeeds; ten pending routes share one initialization and only the newest commits; clearing the route suppresses stale work. [Before](evidence/uncc-demo/navmesh-retry-before.json) / [after](evidence/uncc-demo/navmesh-retry-after.json). |
| `viewer/index.html`; `tests/viewer_navigation_mode.test.cjs` | Updated JavaScript needs distinct asset query revisions; two existing extracted-function tests lacked the browser `window` global used by diagnostics. | Bump three script query versions only. Add `window: {}` to the two test VM contexts after reproducing the identical failures on frozen live-base source. No layout/control/navigation redesign. | Current targeted tests pass. The test-fixture failures were baseline failures, not regressions introduced by this candidate. |

Graph state and download sharing are per worker/process. Different workers or Render instances can independently prepare/download the same publication. No distributed lock or cross-instance cache was added. Cache retention accounting is not a whole-process RSS limit; simultaneous preparation and route responses still require memory.

The current `/unc-charlotte` alias already selects `mp_app.js` and skips eager `nav_graph.json`, ArcGIS and legacy routing libraries. The regular 2D/3D `app.js` still needs the graph for its existing fallback routing. Its graph download was preserved. See [mode audit](evidence/unc-demo-frontend-graph-audit.json); the audit is a timestamped source snapshot from before the narrowly scoped retry fix/query-version bumps.

### Connection budget and configuration decision

The application defaults and comparative tests retain pool `3 + 2` and a five-second checkout wait. The historically reviewed hosted wait is 15 seconds and remains explicit in the example configuration; effective production overrides were not exported. Render reports one instance, and the entrypoint defaults to one worker unless `WEB_CONCURRENCY` overrides it. For that reviewed one-worker budget:

```text
Maximum application database connections = 1 × 1 × (3 + 2) = 5
```

A read-only hosted snapshot found max connections 60, three superuser-reserved, 13 client connections, three reader-role connections and zero idle-in-transaction sessions. Instantaneous nonreserved client headroom was 44, not a future capacity guarantee. A proposed 50-connection application pool plus the other observed clients would exceed that nonreserved budget. No increase to 20 + 30 was made. See [sanitized database snapshot](evidence/uncc-demo/database-budget.json). All retained local load tiers reached at most five simultaneous checked-out connections and returns to zero after each tier. The benchmark's physical-connect count is cumulative connection creation, not simultaneous connection usage. This five-connection formula covers the application engine; dedicated execute-only administrative viewpoint writers and other clients require additional hosted headroom and were not included in the visitor load test. Hosted pooler mode, available Supabase headroom and effective production overrides remain release checks; a five-connection app pool alone does not certify hosted capacity. Each extra instance/worker multiplies the pool and graph-memory budget.

## C. Performance comparison and verification

### Retained candidate versus frozen source

Use [the final comparison](evidence/unc-demo-benchmark-comparison.json), [baseline](evidence/unc-demo-baseline.json), and [retained 40-token/admission-128 run](evidence/unc-demo-stabilized-bounded128.json). Historical PDF figures are a separate reference, not this test's denominator.

| Metric | Before | Retained candidate | Result |
|---|---|---|---|
| HTTP failures at 40 local users | 2 / 200 (1.0%) | 0 / 200 | PASS at this tier; not a production capacity claim. |
| Route P95 at 40 users | 6,534.50 ms | 2,552.19 ms (60.94% lower) | PASS, same route response hashes. |
| Peak process RSS at 40 users | 476.64 MiB | 266.66 MiB (44.05% lower) | PASS finite-run reduction; no soak/mobile-memory claim. |
| HTTP failures at 60 users | Not escalated after baseline failure | 2 / 300 (0.667%), database wait timeouts | FAIL under the stricter stop-on-any-failure gate. 100 not escalated in this run. |
| DB connection demand | Pool cap five | Pool cap five, checked-out count returns to zero | PASS for cleanup/bounds; timeouts remain at saturation. |
| Cold Floor 2 upstream downloads at 40 users | 40 | 1 | PASS per worker; cross-instance deduplication not provided. |
| Floor 2 HTTP P95 at 40 users | 245.69 ms | 193.82 ms | PASS local delivery; different from PDF's 23.28-second browser floor switch. |
| Warm graph builds at 40 users | 78 for 78 successful route responses | Zero extra builds after one preflight preparation | PASS. Cold preparation builds both policies. |
| Route correctness | Frozen implementation reference | Zero measured geometry mismatches; 21 direct cases exactly equal | PASS for sampled standard, step-free and no-route cases. |
| Initial process memory tradeoff | One-user peak 226.05 MiB | One-user peak 261.31 MiB | Expected retained-cache overhead; high-concurrency memory is lower. |

### Final retained tier measurements

Latencies are milliseconds; CPU is a percentage of one local core. Each tier is one finite paced journey per user, not a long soak.

| Users | Requests / failures | All HTTP P50 / P95 / P99 | Route P95 | Floor HTTP P95 | Peak RSS MiB | CPU % |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 / 0 | 79.54 / 165.20 / 180.92 | 86.27 | 184.84 | 261.31 | 17.5 |
| 10 | 50 / 0 | 166.05 / 574.05 / 646.23 | 631.66 | 184.96 | 262.34 | 74.8 |
| 25 | 125 / 0 | 180.96 / 1,696.85 / 2,439.68 | 2,222.88 | 199.09 | 264.22 | 90.9 |
| 40 | 200 / 0 | 378.98 / 2,377.98 / 2,974.56 | 2,552.19 | 193.82 | 266.66 | 93.4 |
| 60 | 300 / 2 | 288.66 / 4,067.63 / 5,609.20 | 5,182.62 | 296.62 | 267.73 | 97.4 |
| 100 | NOT ESCALATED after 60-user failure | — | — | — | — | — |
| 150 | NOT TESTED | — | — | — | — | — |

All recovery readiness probes returned 200, the process stayed alive, and there were no persistent 502/504s or corrupted cache entries in the measured runs. The historical worker-thread crash was **not** reproduced; local observed failures were controlled pool-timeout responses. Thread tokens reached 40 and CPU approached one full core at 60, leaving little spare capacity. Main tier graphs were warm after four reference routes. The retained publication accounts for 49,421,477 bytes (47.13 MiB) within the 96 MiB cache budget; this is retained-container accounting, not a whole-process RSS cap.

The separate [24-request cold graph cohort](evidence/unc-demo-cold-routing.json) passed 24/24 with zero geometry differences: one publication load, one read/parse per graph/POI/navmesh file, two graph-policy builds, ten shared waiters, P95 2,305.68 ms, peak five checked-out connections and recovery 200. It evicted the in-memory cache while retaining unchanged disk files; it is not a cold remote-storage/startup measurement. High-water RSS rose from 265.05 to 289.73 MiB during that separate run.

An earlier uncapped warm run reached 100 with zero failures, but repeatability did not hold. It is retained in [initial warm evidence](evidence/unc-demo-stabilized.json) and must not override the final failure gate. Harness-only experiments retained the same five-connection pool and five-second wait: 16 tokens / admission 128 encountered admission rejections; 16 / 256 initially passed all tiers plus a cold cohort, but its independent 100-only repeat had eight transport `ReadError` failures (1.6%) and no database/admission 503s. That repeat's specific transport cause was not established. The second repeat was canceled and neither experimental setting entered application defaults. All experiment artifacts remain in `docs/evidence/`.

The local host is arm64 macOS, eight logical CPUs, Python 3.13.13, PostgreSQL 18.6, FastAPI 0.142.2, Uvicorn 0.54.0 and NetworkX 3.7. Production's Docker Python 3.12, hosted PostgreSQL 17, half-CPU/512 MiB plan, remote storage and live Studio metadata were **not** represented fully. Benchmark fixtures use the existing pipeline publication rather than current Studio's curated POI list. Production pool wait was historically reviewed at 15 seconds; the comparative harness explicitly used five seconds for both sources. Effective production overrides were not exported or changed. These are material limits on extrapolation.

### Targeted checks and builds

- **224 Python tests passed, one skipped** across 16 relevant files. The skipped existing integration fixture requires an onboarded Greenland workspace and is not counted as a pass.
- **173 Node tests passed** across 16 controller/runtime files, including lifecycle, search/route races, 2D/3D mapping adapters, pause/Exit timing, distances and languages. These are controlled SDK/DOM tests, not physical-device rendering.
- Real Chromium + the bundled Recast WASM completed ten existing UNC navmesh routes before and after query cleanup. Both response SHA256 values are `03c1c474c3ed16183d88640ca8c8326f9d421f2b9774e8978d81d4dfa136c318`; query destroys changed from zero to ten. [Evidence](evidence/uncc-demo/real-recast-browser.json).
- All three production Vite builds passed: dashboard, 2D and standalone 3D. Existing large-chunk warnings remain. No dependency or lockfile change was made. The production API Docker image was not rebuilt/tested here.
- Standalone 3D TypeScript `--noEmit` passed. **2D TypeScript failed with 24 errors / 59 diagnostic lines**, exactly matching the frozen live source after checkout-path normalization. No TypeScript source was changed; this pre-existing failure was not hidden or counted as a pass.
- Changed JavaScript syntax checks and `git diff --check` passed. [Preservation evidence](evidence/uncc-demo/preservation.json) confirms unchanged HTML layout after normalizing only three script cache-version strings, no CSS/assets/geometry changes, and the original dirty feature patch's identical SHA256.

[Validation summary and configuration](evidence/uncc-demo/validation.json), [backend output](evidence/uncc-demo/backend-tests.txt), [frontend output](evidence/uncc-demo/frontend-tests.txt), [dashboard build](evidence/uncc-demo/dashboard-build.txt), [2D build](evidence/uncc-demo/2d-build.txt), [3D build](evidence/uncc-demo/3d-build.txt), [2D typecheck](evidence/uncc-demo/2d-typecheck.txt), [frozen-base typecheck](evidence/uncc-demo/2d-typecheck-baseline.txt).

### Real-browser observation: blocked external startup

The local Chrome mobile-emulation attempt used a 390 px viewport with the real external Matterport embed. It did **not** complete model/SDK readiness: the Matterport frame displayed a Cloudflare challenge, and startup timed out. Search/POI interaction then could not run because startup had not completed. Desktop startup was interrupted before completion. These are not browser journey passes.

The available local observation includes a 390 px document width and scroll width of 390, no `nav_graph.json` request, one host iframe creation/source assignment and one SDK initialization start. Three frame load events were recorded; the screenshot shows external challenge navigation, so they are not evidence of three host remounts or successful SDK connections. A direct local navmesh route returned 7.1 m/two points, but that does not establish a working Matterport journey. The raw browser log also recorded a local `/ar_webxr/launch.js` 404 and one resource diagnostic; AR/full-page error-free behavior is not certified.

Sanitized evidence: [browser result](evidence/uncc-demo/browser-blocked.json) and [external challenge screenshot](evidence/uncc-demo/matterport-verification-block.png). Physical Android Chrome and iPhone Safari, full model navigation, battery/GPU behavior and successful before/after screenshots remain **NOT TESTED**. No attempt was made to bypass the external challenge or hide a loading failure.

## D. Regression checklist

PASS below applies only to the named test type. It is not a claim of a successful physical-device or real-Matterport journey. The original interface remains the reference; no new controls were added. Twenty-six critical feature entries are recorded, including rapid interaction safety.

| # | Feature | Status | Evidence and scope |
|---:|---|---|---|
| 1 | UNC Charlotte campus landing | NOT TESTED | Controlled boot/alias tests pass and local HTML loads; actual model-ready landing was blocked by the external challenge. |
| 2 | Student Union building experience | NOT TESTED | Existing UNC v2 publication used read-only in backend fixtures; real model-ready Student Union journey did not complete. |
| 3 | Building selection | PASS | Controlled Node URL/selection tests preserve the selected campus and Matterport mode; browser selection remains unverified. |
| 4 | Floor selection/switching | NOT TESTED | Controlled floor hydration/camera-fit tests pass without rebuilding runtime; actual SDK floor-switch journey not completed. |
| 5 | 2D floor plans | NOT TESTED | Existing files/2D runtime preserved; no completed real-browser plan-rendering journey in this run. |
| 6 | Matterport 3D viewer | NOT TESTED | Controlled initialization/reuse tests pass; real SDK/model readiness was blocked. |
| 7 | 2D-to-3D location navigation | PASS | Controlled `plan_navigation` adapter tests verify model/floor restrictions, coordinate transforms and confirmed SDK movement. Real browser mapping remains unverified. |
| 8 | Double-click mapped-location journey | NOT TESTED | Underlying controlled navigation adapter passes; actual browser double-click-to-model journey was not run successfully. |
| 9 | POI search | NOT TESTED | Controller search/lifecycle boundaries are covered; attempted real input sequence could not run after blocked startup. |
| 10 | POI selection and saved viewpoint | PASS | Controlled Node selection/viewpoint tests verify fresh saved views, marker preservation and stale-response rejection. Real Matterport camera behavior remains unverified. |
| 11 | Category filters | NOT TESTED | No category/visible-filter journey completed after startup blockage; category UI/source unchanged. |
| 12 | From/To selection | PASS | Controlled route-runtime/viewpoint tests retain endpoints and only commit the latest pending route. Real From/To UI journey remains unverified. |
| 13 | Standard routing | PASS | Real local API requests and exact reference hashes; native query cleanup preserves copied path output. |
| 14 | Step-free routing | PASS | Controlled graph/public-handler equality tests preserve stairs restrictions and existing no-route results; physical accessibility is not assessed. |
| 15 | Multi-floor routing | PASS | Controlled route-policy/geometry fixtures and sampled real-publication equality; live multi-floor camera journey remains unverified. |
| 16 | Elevator transitions | NOT TESTED | Route restrictions/data unchanged; no real browser elevator-transition journey completed. |
| 17 | Stair transitions | NOT TESTED | Standard/step-free graph policy tests pass; actual camera stair transitions remain unverified. |
| 18 | Automated route preview | PASS | Controlled Node playback schedule, live-connection reuse, pause/stall and startup sequencing tests pass. Real preview not completed. |
| 19 | Preview Exit | PASS | Controlled Node tests cancel timers/late camera work and retain iframe/SDK without reload. Real browser Exit not exercised. |
| 20 | Existing distance and preview-time information | PASS | Controlled feet conversion, playback duration, MM:SS, pause/stall and finish-at-zero tests pass; no UI controls added. |
| 21 | Existing loading/error/retry states | PASS | Controlled tests distinguish iframe load/model readiness and preserve failure/retry states; real external startup failure remained visible. |
| 22 | Existing language functionality | NOT TESTED | Controlled locale regression passed; a real locale-switch journey was not completed. Locale files/UI remain unchanged. |
| 23 | Desktop responsiveness | NOT TESTED | No CSS/responsive change; desktop browser startup interrupted before a full comparison. |
| 24 | Mobile responsiveness | NOT TESTED | 390 px page had no horizontal overflow while blocked; full interactive mobile layout and physical devices not verified. |
| 25 | Existing published data | PASS | Copied local fixture hashes match across baseline/candidate; tracked published assets, POIs and route geometry were not modified. Current-live data equivalence is not newly certified. |
| 26 | Rapid repeated interaction and stale-request safety | PASS | Controlled Node tests share pending model/route initialization, reject obsolete configuration/SDK/POI responses, and prevent cleared routes from reappearing. |

The controlled lifecycle tests retain **one iframe source assignment and one SDK initialization** during same-model UI/POI/camera interactions both before and after these stabilization fixes. They do not prove that an external browser, GPU failure or Matterport internal transition cannot reload. The confirmed native query cleanup issue may contribute to client resource growth, but this task did not prove it caused the historical mobile black-screen cycle.

## E. Production readiness

**HOLD for production release and any 100-user production capacity claim.** The isolated candidate is reviewable and reversible; live production remains the last verified working release. It improves measured backend behavior without changing the visible interface, but has not met all requested acceptance conditions.

Release gates:

1. Complete repeated representative hosted-capacity testing with the selected configuration. The retained local run passed through 40 users and failed at 60; even 40 local users is not a Render capacity guarantee. Do not advertise 100-user support based on the earlier single passing run.
2. Complete a real Matterport desktop journey and Android Chrome/iPhone Safari journeys from a supported browser/network: landing → search → POI → directions → preview → Exit, second POI, zoom/rotation, mapped 2D location, floor changes and unchanged iframe/SDK counts. The external challenge blocked this verification.
3. Verify effective `WEB_CONCURRENCY`/worker, pool and timeout overrides, hosted headroom, live publication identity and deployment runtime compatibility. Do not raise the connection budget blindly or deploy experimental 16/256 settings.
4. Retain the pre-existing 2D typecheck failure and local AR-resource limitation explicitly; neither is a newly passing check.
5. Obtain explicit approval only after a reviewable, verified release is available. A push to `main` can auto-deploy; no push, deployment or restart was performed.

The four-hour deadline is 21:19:55 Asia/Calcutta; freeze by 21:04:55 at the latest. Candidate code was frozen after final validation at approximately 18:00 Asia/Calcutta; no experimental thread/admission changes were adopted. Development is stopped rather than continuing emergency optimizations. Preserve the successful deployment for the demonstration. Optional 150-user testing was not attempted after a failure gate.

Remaining limits: per-worker caches do not coalesce across Render instances; oversized/evicted publications can rebuild; the byte budget is not a hard RSS limit; no long soak, mobile GPU/battery, remote storage load or current SQL/session count was certified. The existing console-only `routeDebug()` still lacks query cleanup, and direct concurrent low-level mesh loads can duplicate imports; normal public route calls are coalesced and cleaned. Those unused diagnostic/lower-level paths were left outside the tested visitor-path patch. No new historical black-screen root cause is claimed from the confirmed query leak.

## F. Rollback

- Original IDE commit: `33a01cc242d09b10a3abe79cc5a159ca6ab4260b`.
- Last known working production/stabilization-base commit: `74f37ed55f62d921ced485020389a1150f47facc`.
- Tested stabilization implementation commit: `0d527b08e764369ee8fe5195e53374c31bab4838`. The subsequent report-only commit does not alter application code. Production remains the frozen commit above.
- Successful retained Render deployment: `dep-dbtel0etlv9c73f542v0`.

For development, create a new known-good checkout without altering either working branch:

```sh
git worktree add --detach /private/tmp/navme-uncc-known-good 74f37ed55f62d921ced485020389a1150f47facc
```

For a future explicitly approved release that fails, use Render's retained successful artifact: open <https://dashboard.render.com/web/srv-db32v3bncjis73e9l2cg/deploys>, select `dep-dbtel0etlv9c73f542v0`, choose **Rollback to this deploy**, and wait for the new rollback deployment to become `live`. Do not equate a triggered rollback with successful recovery. The exact API/CLI fallback commands, environment references and auto-deploy precautions are in [UNCC_DEMO_ROLLBACK.md](UNCC_DEMO_ROLLBACK.md).

After any approved rollback:

```sh
curl --fail --silent --show-error https://wayfinding.navme.space/api/health
curl --fail --silent --show-error --output /dev/null https://wayfinding.navme.space/unc-charlotte
```

Confirm the deployed commit in Render, then run one normal UNC landing/search/POI/directions/preview/Exit journey and inspect the lifecycle counters. Do not load-test production during recovery. Preserve existing environment references; no database or infrastructure reversal is needed for this candidate because none was modified. A later code rollback would not undo unrelated data/environment changes made outside this task.

Unresolved risks remain the external Matterport challenge, failed repeatable high-concurrency acceptance, incomplete real-device/runtime verification, unverified effective hosted overrides, finite-test rather than soak coverage, and the documented existing 2D typecheck failure. The unfinished navigation-image feature remains excluded and preserved in the original workspace.

Operational references: [Uvicorn resource limits](https://uvicorn.dev/settings/#resource-limits), [Starlette thread pool](https://starlette.dev/threadpool/). Connection/task admission includes idle keep-alive connections; it is not a count of visitors.
