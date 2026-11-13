# ArcGIS validation

**Latest production acceptance: PASS for the existing read-only GCU v5 release.** After explicit LIVE confirmation of Render deploy `dep-dbrjjlcipgvc73fq761g` / commit `6527ba8` at 16:25:56 UTC on 13 November 2026, the real HTTPS root passed **52/52** unchanged viewer assertions across 1440×900, 768×1024, 390×844 and 360×800. This run used isolated Chromium 158 with native Apple M2 Metal WebGL2. [Exact production evidence](evidence/browser/production-gcu-v5-corrected/arcgis-acceptance.json), [overall scoped result](evidence/browser/production-gcu-v5-corrected/summary.json).

The existing 99-record published public mirror remains a separate scope from the preserved 235 active canonical CMS records and repaired local 235-record mirror. All four views loaded GCU v5, model `jdjvM17BPEh`, five floors and 99 curated public POIs; the initial active 3D view had 60 current-floor POI graphics. Visible map-mode switching, categories, floor selection, autocomplete/place details, same-floor navmesh directions, navigation controls, multi-floor routing, French/English UI changes and refresh passed. No unhandled page error, outgoing mutation attempt, or HTTP 503 occurred. The only ArcGIS-run HTTP error was the known optional `/ar_webxr/launch.js` 404. [Desktop map](evidence/browser/production-gcu-v5-corrected/desktop-map.png), [mobile map](evidence/browser/production-gcu-v5-corrected/mobile-map.png), [mobile cross-floor route](evidence/browser/production-gcu-v5-corrected/mobile-multi-floor-route.png).

Measured initial live map readiness was 25.5 s desktop, 18.0 s tablet, 16.8 s mobile and 17.2 s small mobile. These individual browser observations include network/assets/UI startup and are not an SLA or physical-phone benchmark. Ordinary selected routes passed; this does not clear the previously recorded step-free or geometric source-data limitations.

The first activated production release remains preserved: it executed 40 viewer checks with 36 passes and four failures, including a desktop required-asset 503 and three late-translation mode-label failures. The corrective release returns database connections before blocking external I/O and restores the active target-mode label after boot translation; the label's stored translation key also tracks later language changes. No assertion was removed. [Initial live attempt](evidence/browser/production-gcu-v5-corrected/initial-live-attempt-summary.json).

## Earlier pre-cutover and shadow evidence

The following observations predate the corrected production run above.

**Earlier production check: NOT CUT OVER / HOLD.** On 13 November 2026 at 19:54 IST (14:24 UTC), four fresh GETs returned homepage 200, backend health 500, venue manifest 500, and public runtime config 200 with no `read_only` flag. Repository write permission remains unavailable, so the local release has not reached remote/Render. No new production deployment or production browser acceptance is claimed. [Sanitized final live status](evidence/browser/production-gcu-v5/final-live-status.json). The 52/52 shadow PASS below is preserved and remains a separate result.

**Earlier preflight: PASS for the read-only Supabase GCU v5 shadow, 52/52 viewer checks across four viewports. Production cutover/live acceptance remain separate gates.** The earlier Chrome/WebGL2 limitation below was resolved using an isolated Chromium 158.0.8127.18 runtime and native Apple M2 Metal rendering; it is no longer a current blocker. No system browser was upgraded.

The final shadow loaded actual destination GCU v5 (`jdjvM17BPEh`), five published floors, and 99 curated public POIs. Every initial active 3D view was ready, had a rendered canvas and 60 current-floor POI graphics, and had finished updating at capture time. Visible 3D→2D controls, category filters, category floor selectors, search/autocomplete, place details, ordinary navmesh routing, navigation controls, multi-floor routes, English/French UI switching, and refresh all passed on all four viewports. [Exact final shadow evidence](evidence/browser/shadow-gcu-v5/acceptance.json), [desktop map](evidence/browser/shadow-gcu-v5/desktop-map.png), [mobile map](evidence/browser/shadow-gcu-v5/mobile-map.png), [mobile multi-floor route](evidence/browser/shadow-gcu-v5/mobile-multi-floor-route.png).

An independent SDK/basemap probe in the new runtime also passed: ready MapView, loaded World Imagery layer, one canvas, approximately 1,124 ms from probe initialization through rendering. This diagnostic used no NavMe venue data. The actual GCU acceptance above additionally establishes real application behavior; it does not rely on SDK initialization alone.

The test exposed an existing default-3D startup race: the automatic view switch bypassed the public mode label/widget synchronization. The local fix synchronizes the label and default ArcGIS widgets after view changes and when the UI attaches to an existing view. Final native-browser acceptance exercises that fix. The initial untranslated failure-message fix also remains covered by eight isolated failure regressions.

The final browser contexts attempted no outgoing mutations; the shadow separately enforces read-only HTTP and verified PostgreSQL sessions. No unhandled page errors occurred. `/ar_webxr/launch.js` still returns 404; AR-launch functionality is not included in the passing ArcGIS wayfinding assertions. Existing published geometry metadata defects and unsampled accessibility paths remain documented in the asset report.

## Earlier live outage baseline

Recorded 13 November 2026, approximately 17:20–17:23 IST. **Release status: HOLD.** These are live failure-baseline results, not post-deployment acceptance results.

## Request and initialization trace

The live public HTML responds HTTP 200. `wf-config.js` selects `/api/v1/public/` and venue `all`. `wf-boot.js` requests `/api/v1/public/venues/all/manifest.json`; that request responds HTTP 500 with a non-JSON error. It rejects `WF.ready` before building configuration, floors, georeferencing, graph, and POIs load. `app.js` consequently never initializes the NavMe map. All four measured viewports have zero map canvases, zero generated floor buttons, and no ready map.

The deployment's primary database failure is documented in the infrastructure/API reports. The browser trace independently confirms the failing manifest dependency. Returning an empty manifest would conceal missing published data and would not satisfy acceptance.

## ArcGIS checks independent of the manifest

Repository and live page use ArcGIS Maps SDK for JavaScript 4.34 from the CDN. The AMD loader is available in all four browser contexts. This establishes SDK loading only. The code constructs a Map/Basemap/TileLayer directly, using Esri World Imagery; it does not load a WebMap/WebScene ID or configure an ArcGIS API key for that basemap.

A separate browser-only diagnostic attempted to instantiate the same public basemap without NavMe venue records. It failed with `WebGL2 is required but not supported.` The installed headless Chrome 124.0.6367.119 returns no WebGL2 context, confirmed in two launch configurations. This is a test-environment limitation; it does not establish that users' browsers lack WebGL2. Independent basemap rendering, tile availability, and GPU suitability remain unverified. Diagnostic logs and screenshot are in ignored `platform/var/production-migration/browser/arcgis-independent-probe.*`.

No ArcGIS credential rejection or CORS/CSP rejection was observed in the captured request failures. Those checks remain incomplete until real venue assets load. The failed live manifest prevents visual validation of POI placement, layer alignment, graph rendering, and floor bounds. A subsequent read-only storage audit validated real published JSON references separately, as described below.

## Warnings and independent defects

| Observation | Classification |
|---|---|
| Manifest HTTP 500 | Release-critical application/data dependency failure |
| `viewer.loadError` displayed verbatim | Confirmed user-facing startup error bug; fixed locally |
| ArcGIS CDN loaded through `document.write` | Browser warning about parser blocking; not the observed manifest failure |
| `allow` takes precedence over `allowfullscreen` | Browser warning; not evidence of map failure |
| `/ar_webxr/launch.js` HTTP 404 | Separate missing optional AR asset; viewer symlink points to an absent repository directory |
| No unhandled `pageerror` events | Narrow observation; handled console errors and fatal map failure still exist |

The local bootloader fix uses a readable fallback when dictionaries have not initialized, adds an alert role, and makes Retry at least 44 pixels tall. It retains failure visibility and reload behavior. Eight isolated browser regression cases exercise HTTP and network failures before/after translation initialization on desktop and mobile. These do not imply that the database or map has recovered.

## Earlier outage acceptance status

| Acceptance area | Result |
|---|---|
| Public HTML and SDK loader | PASS |
| Correct published manifest and venue assets | FAIL / blocked by database outage |
| ArcGIS view and real venue rendering | BLOCKED |
| Building, floor, POI display | BLOCKED |
| Categories and search | BLOCKED |
| Route calculation, visualization, multi-floor routes | BLOCKED |
| Loading/error recovery | FAIL live; error readability and target sizing fixed/tested locally |
| Mobile working map | BLOCKED |

Evidence: [sanitized browser baseline](evidence/browser/live-baseline.json), [desktop screenshot](evidence/browser/desktop-before.png), [mobile screenshot](evidence/browser/mobile-before.png). The screenshots show the actual production failure state. Re-run live acceptance with recovered authentic venue data and a WebGL2-capable browser before release.

## Published storage follow-up

Authentic GCU v5 assets are recoverable from the exact Supabase project's public bundle bucket: all 27 config-referenced objects exist, and the parsed POI/graph/floor data have valid internal identity references. This supports a recovery path without fabricating a manifest or venue. It does not replace the destination backup, identity reconciliation, or production-write approval gates.

UNCC v2 has 20 unsnapped POIs and a missing walkgrid in both v1/v2; the regular ArcGIS path depends on that file, while canonical UNCC Matterport mode skips it. Both inspected bundles contain negative floor heights and nonmonotonic elevations that require review for affected features. Four ordinary offline route probes on real data found routes; four corresponding step-free requests did not. Rendering and mobile interaction were blocked during that earlier outage assessment. See [published asset integrity](published-asset-integrity.md) for bounded request counts, checksums, exact findings, route measurements, and local-only manifest results.
