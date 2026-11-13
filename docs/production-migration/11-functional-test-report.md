# Functional test report

**Latest corrected production result: 101/101 scoped checks PASS.** The real `https://wayfinding.navme.space` deployment `dep-dbrjjlcipgvc73fq761g` / `6527ba8` was explicitly confirmed LIVE at 16:25:56 UTC on 13 November 2026. New acceptance ran from 16:27–16:35 UTC in fresh browser contexts, with heavyweight browsers sequential. The final runs had no HTTP 503s. [Sanitized final summary](evidence/browser/production-gcu-v5-corrected/summary.json).

| Final production suite | Executed | Passed | Failed |
|---|---:|---:|---:|
| Bare-root ArcGIS, four viewports | 52 | 52 | 0 |
| Exact `/gcu-omr` Matterport, desktop | 8 | 8 | 0 |
| Exact `/gcu-omr` Matterport, mobile | 7 | 7 | 0 |
| GET-only public privacy/authorization/runtime | 18 | 18 | 0 |
| Bounded critical public GETs, four clients | 16 | 16 | 0 |
| Final scoped total | 101 | 101 | 0 |

The production scope is the **existing published GCU v5 / 99 curated POIs**, with `read_only=true`. The 235 active canonical CMS metadata records and the separately repaired 235-record local mirror remain preserved, distinct datasets; this acceptance covers the existing 99-record public mirror. All four ArcGIS viewports passed 13 assertions each, including real map rendering, categories/floors, visible search and directions, route geometry, navigation, multi-floor routing, language changes, overflow and refresh. The selected same-floor route was 192.7 m with 38 nodes and 26 instructions; the F2→F1 route had nine instructions. Start/Next/exit advanced index 1→2 and returned to directions. [Exact 52 checks](evidence/browser/production-gcu-v5-corrected/arcgis-acceptance.json).

| Production viewport | Result | Initial map readiness | Search/selection | Same-floor directions | Multi-floor flow | Refresh |
|---|---|---:|---:|---:|---:|---:|
| 1440×900 | 13/13 PASS | 25,538 ms | 1,019 ms | 957 ms | 875 ms | 17,373 ms |
| 768×1024 | 13/13 PASS | 18,018 ms | 1,033 ms | 1,020 ms | 882 ms | 16,281 ms |
| 390×844 | 13/13 PASS | 16,808 ms | 1,045 ms | 1,016 ms | 859 ms | 16,283 ms |
| 360×800 | 13/13 PASS | 17,207 ms | 1,026 ms | 1,000 ms | 859 ms | 18,461 ms |

These are individual Chromium 158/native Metal measurements on a Mac. Startup includes navigation, authentic assets and UI initialization; interaction flows include browser waits and screenshot capture. They are not pure route-calculation timings, production capacity estimates, or physical-phone measurements.

Both production-domain Matterport sessions connected the real SDK, reached PLAYING, completed model/UI startup and hid the loader. Basketball Court exposed eight real POIs and BHM Block 28; actual selections opened their cards and the SDK acknowledged camera focus. Desktop also loaded the anonymous admin login UI without submitting a form. [Desktop eight checks](evidence/browser/production-gcu-v5-corrected/matterport-desktop.json), [mobile seven checks](evidence/browser/production-gcu-v5-corrected/matterport-mobile.json), [desktop model](evidence/browser/production-gcu-v5-corrected/matterport-desktop.png), [mobile model](evidence/browser/production-gcu-v5-corrected/matterport-mobile.png).

The privacy run confirmed 99 allowlisted curated records, no scanned private/credential/draft fields, `read_only=true`, protected anonymous/invalid-token reads 401, and traversal 404. It sent GETs only. The final bounded burst sent 16 GETs to eight critical endpoints with at most four clients: all HTTP 200 and valid bounded JSON, zero 503s, 0.79–3.63 s per response. It is not a load test. [Privacy evidence](evidence/browser/production-gcu-v5-corrected/privacy-preflight.json), [bounded reads](evidence/browser/production-gcu-v5-corrected/critical-read-burst.json).

Earlier attempts remain separate. The first activated release executed 40 ArcGIS assertions (36 passed/four failed) before the connection-lifetime and late-i18n fixes. A corrected-release desktop Matterport probe initially sampled the loader between the completion class and its existing fade/`transitionend`; its full retry retained the hidden-loader assertion and passed. An initial bounded burst returned HTTP 200 for all 16 reads, but two large `floors.json` responses exceeded its 2 MB inspection bound; the final bounded burst used the small public floor metadata endpoint. Full geometry was already loaded by the 52 browser checks. [Initial release summary](evidence/browser/production-gcu-v5-corrected/initial-live-attempt-summary.json), [loader timing observation](evidence/browser/production-gcu-v5-corrected/matterport-observation-timing.json), [size-bound observation](evidence/browser/production-gcu-v5-corrected/critical-read-burst-geometry-bound.json).

No production mutation probe, login, data edit, or publication was performed. Existing optional AR/prototype SDK-config 404s and Matterport bootstrap 3.0/deprecation warnings remain recorded. Physical devices, admin editing/publishing, all accessible routes, unrelated venues and whole-project Supabase/RLS security are outside this passing scope. Local 235-POI and earlier shadow results below remain distinct.

Reproduce with `platform/tools/viewer_acceptance.cjs`, `platform/tools/matterport_acceptance.cjs`, `platform/tools/public_privacy_preflight.py --expect-read-only` and `platform/tools/public_read_burst.py`, using a fresh evidence directory and the production base/target environment arguments. Both browser tools block NavMe/Supabase mutations and fail the process on assertion failures. Do not use the privacy tool's loopback-only mutation-probe flag on production.

## Earlier pre-cutover and destination-shadow results

The following evidence predates the corrected production acceptance above.

**Earlier pre-cutover production status: NOT CUT OVER / HOLD.** A fresh four-request GET baseline at 19:54 IST on 13 November 2026 confirmed homepage 200, `/api/health` 500, venue manifest 500, and runtime config 200 without the new read-only flag. The local release commit `616b4a960216cd0e500c5dd113480d1f3059eec9` is recorded as local context, not as a deployed commit; repository write permission is still unavailable. No full acceptance suite was run against the unchanged broken production deployment. [Final live status and commit context](evidence/browser/production-gcu-v5/final-live-status.json).

**Earlier GCU v5 preflight: 52/52 real-data viewer checks pass against the verified read-only destination shadow.** That shadow result preceded live acceptance and remains a separate observation. The earlier 15 live failures below remain historical outage evidence and have not been relabeled as passes.

## Earlier destination-shadow viewer acceptance

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

## Checks unavailable during the earlier outage

Published venue loading, real building/floor selection, POI categories, search, route calculation/instructions, accessible routes, multi-floor navigation, map controls, translated functional flows, and published/draft separation are blocked by the missing working manifest and data. Admin login/logout, editing, asset management, and publishing require an isolated destination copy and approved test identities. The existing `platform/tools/e2e_screens.py` changes a POI and publishes; it was deliberately not run against production.

Database interruption/recovery, pool behavior, and record integrity are covered only to the extent explicitly stated in backend/reconciliation reports. This assessment did not interrupt the production database. API timeout handling, invalid real POI handling, and functional offline recovery remain unverified. Refresh/retry of the broken production page was tested and still fails. Subsequent [published asset integrity checks](published-asset-integrity.md) recovered authentic GCU/UNCC JSON, validated graph relationships, identified data defects, and exercised selected routes locally; those results do not establish live feature acceptance.

## Evidence and reproduction

Sanitized shareable results: [live baseline JSON](evidence/browser/live-baseline.json), [supplemental checks](evidence/browser/supplemental-checks.json), and screenshots in `evidence/browser/`. Full local console/request evidence, test output, build logs, and independent ArcGIS diagnostic are in ignored `platform/var/production-migration/browser/`.

Run `PLAYWRIGHT_MODULE=/path/to/playwright node platform/tools/production_smoke.cjs` for read-only baseline checks. It saves its report and exits nonzero when any assertion fails; the captured 15 failures must not be treated as a successful release smoke. Run `PLAYWRIGHT_MODULE=/path/to/playwright node --test platform/tools/viewer_failure.test.cjs` for isolated failure regression tests. The environment requires installed Google Chrome. This session reused the already-installed Playwright package from the sibling ConnectLabs checkout; no dependency or lockfile was changed. Those map-acceptance requirements were later satisfied by the corrected production run above.
