# Functional test report

**Latest production status: NOT CUT OVER / HOLD.** A fresh four-request GET baseline at 19:54 IST on 13 November 2026 confirmed homepage 200, `/api/health` 500, venue manifest 500, and runtime config 200 without the new read-only flag. The local release commit `616b4a960216cd0e500c5dd113480d1f3059eec9` is recorded as local context, not as a deployed commit; repository write permission is still unavailable. No full acceptance suite was run against the unchanged broken production deployment. [Final live status and commit context](evidence/browser/production-gcu-v5/final-live-status.json).

**Latest GCU v5 preflight: 52/52 real-data viewer checks pass against the verified read-only destination shadow.** Production verification must repeat against the deployed public URL. The earlier 15 live failures below remain historical outage evidence and have not been relabeled as passes.

## Latest real-data viewer acceptance

Chromium 158.0.8127.18 was downloaded into isolated temporary storage and used native Apple M2 Metal WebGL2. Tests read the actual destination through `127.0.0.1:8782`, without database writes, login, editing, publishing, or network mutations. All four viewport runs passed 13 checks each: correct GCU v5/model identity and rendered active view; initial horizontal fit; actual POI graphics; visible map-mode switching; category filtering; visible category floor selection; autocomplete search and POI selection; directions input and same-floor route geometry; navigation start/Next/exit; a multi-floor route; French/English UI switching; post-navigation fit; and refresh.

The selected same-floor navmesh route contained 38 nodes, 192.7 m, and 26 instructions. The different-floor F2→F1 route contained nine instructions and visible route graphics. Every navigation run advanced from instruction index 1 to 2 and returned to directions. This uses the viewer's authentic curated POIs/navmesh, distinct from the earlier offline published-graph probes that found no step-free routes for their selected pairs.

| Viewport | Result | Initial rendered map readiness | Search/selection flow | Same-floor directions flow | Cross-floor flow | Refresh |
|---|---|---:|---:|---:|---:|---:|
| 1440×900 | 13/13 PASS | 12,821 ms | 1,046 ms | 989 ms | 900 ms | 3,747 ms |
| 768×1024 | 13/13 PASS | 7,080 ms | 1,056 ms | 1,011 ms | 887 ms | 3,878 ms |
| 390×844 | 13/13 PASS | 6,773 ms | 1,072 ms | 1,007 ms | 877 ms | 3,881 ms |
| 360×800 | 13/13 PASS | 7,621 ms | 1,095 ms | 1,301 ms | 868 ms | 3,229 ms |

These are individual local-shadow measurements on a Mac, with viewport/touch emulation and shared server-side asset cache. Initial readiness includes authentic asset loading, UI startup, and a bounded settling wait. Interaction timings include browser actions, waiting for results, and evidence capture; they are not pure algorithm latency. They are not production latency or physical-phone performance. All initial views had `updating=false` when inspected. [Full machine-readable evidence](evidence/browser/shadow-gcu-v5/acceptance.json).

The 52-check run exited zero. It captured no unhandled page errors and no mutation attempts. The known optional AR script 404 persists; admin authentication, physical-device behavior, accessible routing, unpublished edit/publish workflows, and live production cutover are not established by these 52 checks. Earlier exploratory runs are preserved separately: an explicit `?b=gcu` followed the saved production walkthrough URL; a test initially assumed a 2D active view although the app defaults to 3D; software-rendered captures timed out; and a refresh assertion had an undeclared-global race. Those diagnostic issues were resolved before the final 52/52 run.

An independent final privacy preflight also passed 24/24 actual shadow endpoint/authorization/read-only-guard checks, with three targeted safety tests passing. The public curated POI query now excludes unpublished rows and buildings without a current publication. Current GCU output remains 99. These scoped checks do not clear the pre-existing whole-project RLS findings or make live CMS metadata an immutable snapshot. See the [independent public-response review](public-response-review.md).

Local viewer changes include a readable pre-i18n failure message and 44-pixel Retry target, plus synchronization of the public 2D/3D label and map widgets after automatic view changes. Run the new acceptance with `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/navme-playwright-browsers PLAYWRIGHT_MODULE=/path/to/playwright WEBGL_BACKEND=metal BASE_URL=http://127.0.0.1:8782 node platform/tools/viewer_acceptance.cjs`. It blocks outgoing non-read requests and exits nonzero on failed assertions. Use a separate evidence directory when rerunning against production.

## Earlier outage baseline and local regressions

Recorded 13 November 2026. **PRODUCTION RELEASE — HOLD.** The production failure is reproduced; no deployment or production data change was made by this browser assessment.

## Executed checks

| Suite | Executed | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Read-only live API/browser baseline | 32 | 17 | 15 | 0 |
| Supplemental live anonymous admin GET | 1 | 1 | 0 | 0 |
| Isolated viewer failure browser regressions | 8 | 8 | 0 | 0 |
| Read-only development API health/manifest smoke | 2 | 2 | 0 | 0 |
| Frontend/API assessment subtotal | 43 | 28 | 15 | 0 |

Counts describe explicit assertions/checks, including repeated device checks; they are not a claim that every implemented feature was tested. The local API smoke uses the confirmed development database and is not a live production pass. Three successful frontend build commands are separate validation results. Backend/database/reconciliation suite results are recorded by their owning reports and should be added separately to a whole-project total. One independent ArcGIS diagnostic was blocked by the available browser's lack of WebGL2, outside the tabulated suites. Eight later offline real-data routing diagnostics are also recorded separately as route/no-route observations, not additional passing browser tests.

## Live API results

| Request | Actual | Expected | Measured response |
|---|---:|---:|---:|
| `/api/health` | 500 | 200 | 310 ms |
| `/api/v1/public/venues/all/manifest.json` | 500 | 200, valid JSON | 261 ms |
| `/api/v1/public/venues/navme-qa-nonexistent/manifest.json` | 500 | 404 | 258 ms |
| `/admin/` | 200 | 200 | 243 ms |
| `/api/v1/admin/buildings`, no token | 401 | 401 | Not measured |

These are individual observations, not averages or service-level estimates. The first three responses were not valid JSON. The protected admin read rejects an anonymous request; login, token refresh, session persistence, user-level access, and administrative operations were not validated. No production credentials were used.

## Browser results

Headless installed Chrome 124.0.6367.119 visited the actual public URL in fresh contexts at 1440×900, 768×1024, 390×844, and 360×800. Every viewport loaded HTML and the ArcGIS AMD loader, showed the failure overlay with an untranslated `viewer.loadError`, and had no ready NavMe map. Retry caused a fresh navigation and another failed manifest request. All measured failure layouts fit horizontally. Console captures distinguish handled application errors from warnings.

| Device | DOM content loaded | Window load | Result |
|---|---:|---:|---|
| Desktop | 2,564 ms | 4,938 ms | Map unavailable |
| Tablet | 3,004 ms | 3,244 ms | Map unavailable |
| Mobile | 2,495 ms | 2,718 ms | Map unavailable |
| Small mobile | 2,475 ms | 2,706 ms | Map unavailable |

These Navigation Timing values measure the failed page load. They are not usable-map timings. ArcGIS view initialization, POI rendering, search response, and route calculation times were not measurable because required data never loaded.

## Local regression and builds

`platform/tools/viewer_failure.test.cjs` uses the actual viewer bootloader and translation dictionaries with browser-intercepted HTTP 503/network failures. It checks a readable error before and after French dictionary initialization, preserved failure without synthetic venue configuration, a 44-pixel Retry target, horizontal fit, and a new manifest request on Retry. All eight cases pass on desktop/mobile. It does not exercise a functioning venue or promise recovery while the backend remains unavailable.

Production frontend compilation passed, using existing installed dependencies without running the root build's dependency-reinstallation step:

1. Dashboard: `./node_modules/.bin/vite build` — PASS.
2. 2D viewer: `npm run build` in `dashboard/mini3d-2d` — PASS.
3. 3D viewer: `npm run build` in `dashboard/Tacoma_4926_3D_wayfinder` (`tsc --noEmit` then Vite) — PASS.

The commands were also rerun sequentially because the dashboard and child builds share `dashboard/dist`. Warnings remain for large JavaScript chunks, mixed dynamic/static imports, and duplicate `elevator`/`statue` switch cases in `Mini3dGtaEmbed.ts`. They did not fail compilation and have not been shown to cause the production outage.

## Unexecuted critical feature checks

Published venue loading, real building/floor selection, POI categories, search, route calculation/instructions, accessible routes, multi-floor navigation, map controls, translated functional flows, and published/draft separation are blocked by the missing working manifest and data. Admin login/logout, editing, asset management, and publishing require an isolated destination copy and approved test identities. The existing `platform/tools/e2e_screens.py` changes a POI and publishes; it was deliberately not run against production.

Database interruption/recovery, pool behavior, and record integrity are covered only to the extent explicitly stated in backend/reconciliation reports. This assessment did not interrupt the production database. API timeout handling, invalid real POI handling, and functional offline recovery remain unverified. Refresh/retry of the broken production page was tested and still fails. Subsequent [published asset integrity checks](published-asset-integrity.md) recovered authentic GCU/UNCC JSON, validated graph relationships, identified data defects, and exercised selected routes locally; those results do not establish live feature acceptance.

## Evidence and reproduction

Sanitized shareable results: [live baseline JSON](evidence/browser/live-baseline.json), [supplemental checks](evidence/browser/supplemental-checks.json), and screenshots in `evidence/browser/`. Full local console/request evidence, test output, build logs, and independent ArcGIS diagnostic are in ignored `platform/var/production-migration/browser/`.

Run `PLAYWRIGHT_MODULE=/path/to/playwright node platform/tools/production_smoke.cjs` for read-only baseline checks. It saves its report and exits nonzero when any assertion fails; the captured 15 failures must not be treated as a successful release smoke. Run `PLAYWRIGHT_MODULE=/path/to/playwright node --test platform/tools/viewer_failure.test.cjs` for isolated failure regression tests. The environment requires installed Google Chrome. This session reused the already-installed Playwright package from the sibling ConnectLabs checkout; no dependency or lockfile was changed. A WebGL2-capable test browser and authentic recovered data are still required for map acceptance.
