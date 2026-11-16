# UNC production deployment and 60-user verification

**Deployed and PASS for the executed 60-user public API profile.** Real desktop/mobile Chrome observations and the user's phone check also stayed loaded. Production data, RLS, schemas and visible UI were preserved. This is a finite test result, not a permanent no-crash guarantee or a 100-user claim.

## Live release

- URL: https://wayfinding.navme.space/unc-charlotte
- Application commit: `0d9fdbbb243a360db4a61ec0fee65e76012c7c02`.
- Current Render deployment: `dep-dbtfv3lckfvc73eophp0`, live at **2026-11-16 18:36:01 IST**.
- Instance: `srv-db32v3bncjis73e9l2cg-wpc8d`; existing one-instance, 0.5-CPU / 512-MiB plan.
- Effective logged limits: pool size **8**, overflow **4**; maximum **12** database connections per worker, wait **15 seconds**, **40** sync worker slots, admission/backlog **128**. Read-only protection remains enabled.
- The existing GitHub production branch was advanced normally; no force push, schema migration, role/RLS change, plan upgrade or production content edit was performed.
- Further tooling/report commits are local documentation changes; the live application remains the commit above.

## Confirmed problem and change

The first live attempt used the existing five-connection cap. Its 1/10/25/40-user stages passed, but the 60-user stage hit one viewer-data 503 and stopped. The application log at `12:58:13.238 UTC` confirms `Database request failed (TimeoutError)`. Recovery checks stayed 200 and the worker did not crash. CPU and memory still had headroom.

A read-only hosted snapshot showed 57 non-reserved connection slots and eight other client connections. The reviewed app cap of 12 plus those eight projects to 20 connections, leaving 37 slots of instantaneous headroom. That budget is not a reservation against future clients. Two local 60-user cap-12 trials passed 600/600, including a trial with 180 ms injected per SELECT. Only `DB_POOL_SIZE=8`, `DB_MAX_OVERFLOW=4` and `DB_POOL_TIMEOUT_SECONDS=15` were merged into the existing Render environment. Startup logs verified the effective values before the repeat.

The release also retains immutable publication graph caching, coalesced/atomic bundle recovery and query cleanup. An additional cold native-navmesh race was reproduced and fixed: 24 concurrent requests previously fetched the same 2.2-MiB binary 24 times; the new helper fetches it once and publishes it atomically. All 24 response contracts remain identical. No Matterport SDK/camera redesign was introduced.

Evidence: [first attempt](evidence/prod60/production-visitors.json), [confirmed error/monitoring](evidence/prod60/first-run-monitor-summary.json), [budget decision](evidence/prod60/pool-budget-decision.json), [actual startup limits](evidence/prod60/pool12-startup-runtime.json), [native-cache before](evidence/prod60/navmesh-cold-before.json) / [after](evidence/prod60/navmesh-cold-after.json).

## Production test results

Window: **2026-11-16 18:38:15 IST to 2026-11-16 18:44:35 IST** (379.5 seconds).

The test ramped through 1, 10, 25, 40 and 60 anonymous public API visitor tasks. Each visitor loaded the current landing/configuration/metadata and native navmesh, then selected locations every 3–7 seconds. The rate was capped at 25 requests/second. At 60 users, the loaded-session phase ran for 120 seconds. No cache purge, cache-busting flood, feedback write, login or administrative mutation was sent. Normal UNC routing uses client-side Recast; this production profile did not add artificial server-route computation to every interaction.

| Concurrent visitor tasks | Measured requests | Unexpected failures | HTTP P50 / P95 / P99, seconds | Peak simultaneous HTTP requests |
|---:|---:|---:|---|---:|
| 1 | 28 | 0 | 0.26 / 2.06 / 2.31 | 2 |
| 10 | 149 | 0 | 1.16 / 2.05 / 2.93 | 11 |
| 25 | 352 | 0 | 1.50 / 2.55 / 2.75 | 26 |
| 40 | 553 | 0 | 2.51 / 3.66 / 4.00 | 41 |
| 60 | 1906 | 0 | 1.36 / 5.01 / 5.94 | 61 |

- **2,992 measured requests, zero unexpected failures**, all recorded responses HTTP 200. Fifteen additional recovery-readiness probes also returned 200; these are separate from the measured-request counter.
- At 60 users: **1,906/1,906 HTTP 200**, median **1.36 s**, P95 **5.01 s**, P99 **5.94 s**. Peak 61 requests includes the liveness probe alongside visitor traffic.
- All 60 bootstrap journeys completed over 51.21 seconds under the paced schedule. This is the cohort's API bootstrap span, not an individual visual page-load measurement.
- At 40 users, overall P95 improved from **8.70 s** in the first attempt to **3.66 s** in the repeat. The first 60-user attempt was interrupted, so its partial interval is not presented as a like-for-like completed soak.
- Live discovery: publication v2, model `kQBN52JqFE9`, **46 current active POIs**, six categories. The old screenshots/report's 47 is not hardcoded into acceptance.

[Complete successful API evidence](evidence/prod60/production-visitors-pool12.json). Test-tool source SHA and selected settings: [repeat-tool.json](evidence/prod60/repeat-tool.json). The API profile represents 60 concurrent visitor tasks, **not 60 simultaneously rendering Matterport browsers**. Separate real browser evidence follows.

## No crash or repeated loading observed

Render monitoring covered the test, recovery and events through **2026-11-16 18:46:57 IST**:

- **Zero unexpected restarts, process failures, OOM/hardware/suspension events or database error messages** in the successful window.
- Sampled peak memory **149.83 MiB / 512 MiB**, recovery **146.61 MiB**. Sampled service CPU peak **33.22% of the allocated half CPU**.
- After load: 12 reader backends and eight other client connections; all readers idle, zero active reader queries, idle transactions or lock waits. These are server/pooler aggregate backends, not an instrumented per-instance checkout counter.
- Platform metrics use 30-second samples and can miss shorter spikes. The health-path setting remains the existing TCP check; the test independently used `/api/live` and database-backed `/api/health`.

Real normal Chrome desktop and 390-px mobile emulation reached Matterport PLAYING, selected two POIs with SDK acknowledgements, rotated/zoomed, calculated a real Recast route, started preview and clicked Exit. The model stayed ready with the loader hidden:

| Observation | Loaded observation | Result |
|---|---:|---|
| Desktop headed Chrome | 75.26 s | PASS |
| 390-px mobile emulation | 75.06 s | PASS |
| Additional 390-px observer during the API test | 60.80 s | PASS; approximately 39 s overlapped the 60-user loaded soak |
| User's actual phone | About 120 s, user reported | Stayed loaded after two POIs; device/browser unspecified |

Each instrumented loaded observation retained the same iframe, **one source assignment and one SDK initialization/success**, with iframe load count 2→2 and no new loading-state reset or unhandled page exception. The overlap is reconstructed because the browser helper did not persist an exact readiness UTC; the entire 60.8-second observation is not claimed to be under the 60-user soak.

[Monitor summary](evidence/prod60/second-run-monitor-summary.json), [desktop](evidence/prod60/browser-headed/report.json), [mobile](evidence/prod60/browser-mobile-headed/report.json), [during-load mobile](evidence/prod60/browser-mobile-during60/report.json), [manual phone report](evidence/prod60/manual-phone-observation.json).

## Network usage

The successful API run received **317.30 MB of encoded HTTP response bodies** across all five stages and 136 bootstrap journeys. That count excludes full Matterport/image/font rendering and is separate from browser captures. See [the user/admin network report](UNCC_NETWORK_USAGE.md) for measured per-session provider totals and projections.

## Checks and practical limits

- Release regression: **239 backend tests passed, one existing optional fixture skipped; 173 frontend tests passed**. Seven additional load-tool/accounting safety tests passed.
- All three Vite production builds and standalone 3D TypeScript had passed for the unchanged frontend source. The existing 2D TypeScript check still has 24 baseline errors; this deployment does not claim to fix them.
- Headless Chrome encountered Matterport's external verification. Ordinary headed Chrome worked without stealth or solving a challenge. Physical Android/iPhone browser fleets, long soaks, 100 users and 60 full rendering browsers were not tested.
- Existing initial `/ar_webxr/launch.js` resource failure and some canceled/failed Matterport tile/telemetry requests remain recorded. They did not reset the loaded model, but this is not a claim that every browser network request succeeded.
- No UI, POI, route-geometry or published-content change was used to reduce the workload. Original uncommitted image-feature work remains preserved in the original workspace.

## Rollback

The prior working deployment is `dep-dbtel0etlv9c73f542v0`, commit `74f37ed55f62d921ced485020389a1150f47facc`. The first deployed version of this same code with the five-connection cap is `dep-dbtfnkgn74is73bpmkq0`. Retained-artifact rollback is available through the [Render deploy history](https://dashboard.render.com/web/srv-db32v3bncjis73e9l2cg/deploys).

An unused local emergency commit `aa54eba363a2deba061efdcd8b6359e7e229bb6b` restores the application's API/viewer/deployment/example files exactly to the frozen production source while preserving evidence. It has not been pushed or deployed. If artifact access is unavailable, pushing that prepared fast-forward rollback commit and deploying the latest source is a rebuild fallback. Restoring the earlier pool setting separately means merging `DB_POOL_SIZE=3`, `DB_MAX_OVERFLOW=2`, `DB_POOL_TIMEOUT_SECONDS=15`; environment-only changes redeploy the service. No data deletion is required. Recheck `/api/health`, the deployed SHA and one normal viewer journey after rollback. Full prior instructions: [UNCC_DEMO_ROLLBACK.md](UNCC_DEMO_ROLLBACK.md).
