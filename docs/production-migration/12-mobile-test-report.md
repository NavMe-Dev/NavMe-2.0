# Mobile test report

**Latest production viewport acceptance: PASS for the read-only GCU v5 release.** Following the corrected deployment's explicit LIVE confirmation at 16:25:56 UTC on 13 November 2026, the actual HTTPS root passed **52/52** ArcGIS checks, including all three touch-emulated tablet/mobile sizes. Exact `/gcu-omr` separately passed seven mobile checks and eight desktop controls/anonymous-admin checks. [Final scoped summary](evidence/browser/production-gcu-v5-corrected/summary.json).

| Viewport | ArcGIS result | Map/category/floor/search | Routes/navigation | Horizontal fit | Refresh |
|---|---|---|---|---|---|
| 1440×900 | 13/13 PASS | PASS | PASS | PASS | PASS |
| 768×1024 | 13/13 PASS | PASS, touch | PASS | PASS | PASS |
| 390×844 | 13/13 PASS | PASS, touch | PASS | PASS | PASS |
| 360×800 | 13/13 PASS | PASS, touch | PASS | PASS | PASS |

Each real GCU v5 view loaded 99 curated POIs and five floors. The public floor selector changed to F2 and displayed 27 matching items; real autocomplete selected a POI and directions control. The same-floor navmesh route was 192.7 m/26 instructions, and the F2→F1 route displayed nine instructions and route graphics. Touch Start/Next/exit advanced instruction 1→2 and returned to directions. All tested states fit horizontally without a blocking overlay. Initial mobile map readiness measured 16.8 s at 390×844 and 17.2 s at 360×800 on this Mac/network; these are individual emulation measurements, not phone benchmarks. [Exact viewport results](evidence/browser/production-gcu-v5-corrected/arcgis-acceptance.json).

The actual production-domain Matterport mobile session connected the SDK, reached PLAYING at 9.5 s and model readiness at 11.6 s, and removed its loader. Basketball Court showed eight POIs and BHM Block 28; tapping actual list items opened the correct cards and acknowledged camera focus. No page error or NavMe/Supabase mutation attempt occurred. [Seven mobile checks](evidence/browser/production-gcu-v5-corrected/matterport-mobile.json).

Selected screenshots were visually inspected: [live mobile map](evidence/browser/production-gcu-v5-corrected/mobile-map.png), [mobile cross-floor route](evidence/browser/production-gcu-v5-corrected/mobile-multi-floor-route.png), [small-mobile place sheet](evidence/browser/production-gcu-v5-corrected/small-mobile-poi.png), [mobile Matterport model](evidence/browser/production-gcu-v5-corrected/matterport-mobile.png). The previous initial-production late-translation label failures are preserved separately and all four corrected label assertions passed; no assertion was skipped.

This is Chromium 158 viewport/touch emulation with native Apple M2 Metal, not physical iOS/Android or Safari testing. It does not establish every accessible path, on-site localization, AR launch, admin editing or publication. Existing optional asset 404s, SDK bootstrap/deprecation warnings and source geometry/accessibility findings remain recorded.

## Earlier pre-cutover and shadow viewport evidence

The following failures and shadow passes predate the corrected live run above.

**Earlier pre-cutover live mobile status: HOLD; production has not been cut over.** The 19:54 IST production baseline on 13 November 2026 still returned health/manifest HTTP 500. The release code remains local because repository write access is unavailable. The passing viewport results below are authentic shadow results, not production results; the full mobile suite was not rerun against the unchanged broken service. [Final live status](evidence/browser/production-gcu-v5/final-live-status.json).

**Earlier mobile preflight: PASS for the read-only GCU v5 shadow on all required viewports. Production and physical-device verification remain separate.** A current isolated Chromium 158 runtime with native Metal rendering removed the earlier browser limitation. Each viewport passed 13 real-data viewer assertions, for 52/52 overall.

| Viewport | Map/data identity | Category/floor controls | Search/place details | Routes/navigation | Horizontal fit | Refresh |
|---|---|---|---|---|---|---|
| 1440×900 | PASS, actual GCU v5 | PASS | PASS | PASS | PASS | PASS |
| 768×1024 | PASS, actual GCU v5 | PASS, touch | PASS | PASS | PASS | PASS |
| 390×844 | PASS, actual GCU v5 | PASS, touch | PASS | PASS | PASS | PASS |
| 360×800 | PASS, actual GCU v5 | PASS, touch | PASS | PASS | PASS | PASS |

The public category-floor selector changed the displayed floor to F2 and showed 27 matching items. Search selected an authentic POI and opened its details/directions control. Same-floor directions used the visible starting-point autocomplete and produced a 192.7 m navmesh route with 26 instructions; a separate F2→F1 route displayed nine instructions and visible path graphics. Start, Next (instruction 1→2), and exit worked with touch in each emulated mobile context. No blocking overlay or horizontal overflow prevented the tested flows. The standalone floor FAB is intentionally hidden by existing product code; tests use the actual visible category-floor controls.

Screenshots were visually inspected for real map/POI rendering, responsive place-sheet placement, and the mobile route panel: [mobile map](evidence/browser/shadow-gcu-v5/mobile-map.png), [mobile multi-floor directions](evidence/browser/shadow-gcu-v5/mobile-multi-floor-route.png), [small-mobile place details](evidence/browser/shadow-gcu-v5/small-mobile-poi.png), [tablet map](evidence/browser/shadow-gcu-v5/tablet-map.png). [Exact results](evidence/browser/shadow-gcu-v5/acceptance.json).

These are Chrome viewport/touch emulations on Apple M2, not physical phone tests. They do not establish iOS Safari behavior, real mobile GPU/memory limits, on-site localization, accessibility of every route, or AR-launch functionality. The optional AR script 404 and published source metadata defects remain recorded. Repeat the same acceptance against the real production release before declaring the live mobile gate passed.

## Earlier production failure baseline

Recorded 13 November 2026. **Mobile release gate: HOLD.** Tests used headless Chrome viewport/touch emulation, not physical iOS/Android devices or Safari.

| Device | Viewport | Horizontal document width | Map | Retry |
|---|---|---:|---|---|
| Desktop control | 1440×900 | 1440 px | Unavailable | Reloads, failure persists |
| Tablet | 768×1024 | 768 px | Unavailable | Reloads, failure persists |
| Mobile | 390×844 | 390 px | Unavailable | Reloads, failure persists |
| Small mobile | 360×800 | 360 px | Unavailable | Reloads, failure persists |

All four live screenshots display the blocking startup error and untranslated `viewer.loadError`. The Retry target is approximately 72×21 pixels, below the prepared local minimum of 44 pixels high. Error text stays within the viewport. No working map, floor selector, place popup, navigation control flow, or search result was available to assess.

## Local remediation verification

The bootloader now shows a readable fallback when the manifest fails before a translation dictionary loads, preserves any available translation, exposes the error as an alert, and sets a minimum 44×44-pixel Retry target. Eight isolated regression cases cover desktop/mobile, loaded/unloaded translation dictionaries, HTTP 503/network interruption, horizontal fit, and renewed request on Retry. All pass locally. A failed request continues to show a failure; the fix does not fabricate a successful map.

## Checks blocked during the earlier outage

Touch usability of actual search results, floor selection, correct popup placement, responsive map rendering, route entry/exit, multi-floor navigation, and absence of blocking overlays during successful startup must be tested after data recovery and application cutover. The present failure overlay intentionally blocks map interaction. A passing overflow check on an error page does not establish responsive application usability.

Repeat the four viewport checks against the approved release, including route and search flows, and verify on physical iOS/Android browsers. The isolated current Chromium/Metal runtime later resolved that browser limitation, as shown in the live evidence above.

Actual production screenshots: [tablet](evidence/browser/tablet-before.png), [mobile](evidence/browser/mobile-before.png), [small mobile](evidence/browser/small-mobile-before.png). These are pre-deployment failure evidence. Full measurements: [live baseline JSON](evidence/browser/live-baseline.json).
