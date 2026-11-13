# Local GCU walkthrough recovery

Recorded 2026-11-13, Asia/Kolkata. The user's screenshot was the Matterport-first **`/gcu-omr`** page, which is separate from the bare-root ArcGIS map checked earlier. The initial local verification missed this exact path.

## Confirmed cause

The unchanged SDK key rejects the browser referrer **`http://127.0.0.1:8780`** with **`KeyReferrerMismatchError`**. The same model, API data, application code and key succeed on **`http://localhost:8780/gcu-omr`**. The native model renders behind NavMe's controls and startup completes; this was checked visually and through SDK state.

The GCU manifest, configuration and Matterport metadata all return 200 and identify model `jdjvM17BPEh`. Missing data or the API is not the cause of this screenshot. The unrelated Matterport user-check 400 and deprecated connection-signature warning are not the observed SDK rejection. No key, account setting, domain authorization or license restriction was changed or bypassed.

## Applied fix

The platform redirects GET/HEAD browser entry pages on literal IP loopback hosts (`127.0.0.1` and `::1`) to **localhost**, preserving scheme, port, path and query parameters. This covers the viewer, GCU alias, dedicated walkthrough/localization pages and admin entry pages. The redirect is 307 with `Cache-Control: no-store`.

API requests, static assets, non-read methods and existing deployed domains retain their URLs. The main local API was gracefully restarted with the fix, still targeting local PostgreSQL. No migration or production application-data write was executed. The separate dashboard servers remain stopped.

Browser testing also identified a separate category/floor error: the shared UI called ArcGIS `Extent.expand()` in the lightweight Matterport runtime, where that method is unavailable. `fitLonLat()` now leaves Matterport camera handling to its existing controller. Normal ArcGIS 2D/3D extent fitting is unchanged, and the UI script's cache version was advanced.

Working local links:

- Viewer: `http://localhost:8780/gcu-omr`
- Admin: `http://localhost:8780/admin/`
- Health: `http://127.0.0.1:8780/api/health`

## Validation

- **197 platform tests passed, 2 skipped**. This includes 15 new browser-origin regression cases; they are a subset, not an additional test count. The cases cover IPv4/IPv6 aliases, port/query preservation, public-domain behavior, API/assets and non-read methods.
- The original IP-based GCU link and admin link now follow the expected localhost redirect and return 200. Health remains 200.
- Desktop and 390×844 mobile browser startup from the original IP link pass: Matterport connects, the actual GCU scene renders, NavMe controls become ready and the failed loader disappears. The mobile floor/style query is preserved. Both use the existing local GCU v1 publication and 108 current curated POIs; these are not the destination GCU v5 data.
- Before-fix localhost connection completed in approximately 5.6 seconds in the diagnostic run; the same IP origin rejected the SDK connection in approximately 1.8 seconds. These are individual observations, not performance guarantees.
- Three camera regression tests pass: Matterport does not call missing ArcGIS APIs, while regular 2D and 3D fitting still executes. The focused real-browser category/floor replay passes 3/3 with zero page errors: nine cafeteria POIs and eleven F3 items are shown through the visible controls.
- Search selected an authentic local POI; visible directions produced a real **22.5 m navmesh route**. The original admin URL redirects to the localhost login UI. No user data was submitted.
- The independent **read-only Supabase GCU v5** preview also renders its Matterport scene at `http://localhost:8782/gcu-omr`, with 99 curated POIs, SDK PLAYING and a hidden startup loader. This is shadow acceptance, not a public-domain deployment.

Evidence: [197 platform tests](evidence/platform-pytest.txt), [before/after origin timelines](evidence/local-walkthrough/origin-verification.json), [current category/floor results](evidence/local-walkthrough/category-floor-after.json), [desktop walkthrough](evidence/local-walkthrough/after-desktop.png), [mobile walkthrough](evidence/local-walkthrough/after-mobile.png), [route](evidence/local-walkthrough/route.png), [admin](evidence/local-walkthrough/admin-login.png), [GCU v5 reader preview](evidence/local-walkthrough/reader-shadow-v5.png). The [earlier controls record](evidence/local-walkthrough/controls-before-adapter-fix.json) retains the two errors observed before the camera guard; it is historical, not the final result. SDK key values and raw exception prefixes are excluded.

## Production boundary

The verified runtime fix is committed as **`49eefbc`**. A new `git push origin HEAD:main` attempt returned HTTP 403, `Permission to NavMe-Dev/NavMe-2.0.git denied to AdhamNG`. This fixes the observed local walkthrough failure. It does **not** establish a new public Render release. GitHub still reports effective account `AdhamNG` with repository `push=false`; the existing production deployment remains unchanged. The independent restricted-reader GCU v5 recovery still requires the reviewed code push, connection activation and actual-domain acceptance described in [deployment sequence](13-production-deployment.md). No reader URL has been activated on old production code.
