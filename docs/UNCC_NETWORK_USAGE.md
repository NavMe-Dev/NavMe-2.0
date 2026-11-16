# UNC NavMe network usage — users and administrators

Measured on 2026-11-16 against https://wayfinding.navme.space/unc-charlotte. **MB means 1,000,000 bytes; MiB is used only for server-memory reporting.**

## What a visitor downloads

One completed cold desktop journey with two POI selections, camera movement and route preview recorded **about 130.39 MB of browser-reported encoded HTTP traffic**. The equivalent 390-px mobile-emulation journey recorded **128.83 MB**. These are this model and these test journeys, not a fixed allowance for every visit.

| Completed cold browser journey | NavMe MB | Google Fonts MB | Matterport MB | Total recorded MB |
|---|---:|---:|---:|---:|
| Desktop | 3.35 | 1.49 | 125.55 | 130.39 |
| 390-px mobile emulation | 3.44 | 1.49 | 123.90 | 128.83 |
| 390-px observer during load | 3.44 | 1.49 | 124.26 | 129.20 |

For the desktop sample, Matterport supplied **96.3%** of recorded bytes. Most visitor data consumption comes from 3D panoramas/textures downloaded as the camera moves. NavMe's APIs supply the location/configuration/viewpoint information; the browser computes normal routes using Recast and the native navmesh. The lightweight UNC viewer did not download `nav_graph.json`.

The desktop native navmesh response was approximately **2.30 MB**; the bundled Recast runtime was about **0.42 MB**. These are already included in the NavMe total above. Do not add them again. Google fonts contributed about 1.49 MB. New locations/preview movement can fetch additional Matterport imagery after the first screen is visible.

### Reading these numbers correctly

The browser used a fresh context and a read-only interception guard, which disables the HTTP cache. This is a conservative cold-cache trace, not measured warm-return usage. The reported encoded response/download counters had unavailable/unsplit header sizes: despite legacy raw JSON names containing `body`, they can include HTTP headers. TLS, retransmissions and failed-request partial bytes are not fully measured. **Treat the table as approximate recorded HTTP transfer, not an exact data-plan or billing meter.** CDP counters are a separate diagnostic with different iframe coverage and were not added to these totals.

A few Matterport tile/telemetry requests and an existing AR-script resource failed or were canceled; their partial bytes are unknown. Successful model playback and stable lifecycle were verified. Headless runs blocked by external verification recorded only partial startup traffic and are excluded from the complete-session table.

For planning only, 60 identical cold desktop journeys would project to about **7.82 GB** of client traffic, including about **201 MB** from NavMe. This multiplication is **not a measured 60-rendering-browser test**. Cache reuse, device resolution, chosen locations, duration and image refinement can change the result.

## What the production API test transferred

The passing run used 60 concurrent API visitor tasks at its largest stage; it did not stream 60 copies of the full Matterport model. All stages together simulated 136 bootstrap journeys.

| Scope | Measured encoded response-body data | Meaning |
|---|---:|---|
| Complete 1/10/25/40/60-user run | 317.30 MB | 2,992 measured API/static requests, zero failures |
| 60-user stage, bootstrap + two-minute loaded period | 140.14 MB | 1,906 HTTP 200 responses, includes probes |
| 60 bootstrap journeys within that stage | 139.82 MB | About 2.33 MB per API bootstrap; no full 3D imagery/fonts |
| Native navmesh for those 60 visitors | 137.67 MB | 60 copies of the same existing binary, 2.29 MB each |
| Location-viewpoint lookups during the loaded stage | 0.321 MB | 1,109 responses; roughly 289 body bytes each on average |

HTTPX's API byte counter measures encoded body bytes and excludes headers/TLS. The browser counter above has different header coverage, so the measurement methods are labeled separately. Do not add the API load-test total to one browser session and call that a per-user footprint. API-only success does not establish 60 functioning WebGL renderers.

## For users

- The 3D experience can use substantially more data than the location list. The recorded cold journey was around 129–130 MB with the tested movements.
- Opening another location or playing a preview can download more imagery. The small viewpoint API response does not represent the imagery needed to show that view.
- The viewer now stayed mounted through tested location changes and preview Exit. Keeping the loaded experience avoids the repeated full startup cycle; return-visit/cache savings were not quantified here.

## For administrators

- NavMe/Render first-party traffic, Matterport/CDN traffic and Google font traffic are separate sources. Render's own bandwidth meter is not the visitor's complete data consumption.
- Render bandwidth is reported in delayed hourly windows, so immediate test-window numbers come from the client captures. Provider billing and protocol overhead can differ.
- The successful deployed app uses one instance/worker with pool 8+4, capped at 12 database connections, inside the reviewed 57-slot non-reserved database budget. No compute-plan upgrade was used.
- Model detail/quality and movement dominate this observed data budget. No image-quality, map, UI or route feature was removed for the benchmark.
- Admin login, editing and saving were not load-tested; the measured workload was public and read-only. The user's separate phone check confirmed stable loading but did not measure network bytes.

Evidence: [network accounting note](evidence/prod60/network-accounting-note.json), [browser summary](evidence/prod60/browser-network-summary.json), [desktop trace](evidence/prod60/browser-headed/report.json), [mobile trace](evidence/prod60/browser-mobile-headed/report.json), [during-load trace](evidence/prod60/browser-mobile-during60/report.json), [API run](evidence/prod60/production-visitors-pool12.json). [Deployment and stability report](UNCC_PRODUCTION_60_REPORT.md).
