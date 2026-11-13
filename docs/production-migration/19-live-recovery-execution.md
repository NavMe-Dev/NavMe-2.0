# Live recovery execution — 2026-11-13

**Verified live:** https://wayfinding.navme.space/ and https://wayfinding.navme.space/gcu-omr. The existing service now serves GCU v5 through the scoped Supabase reader. This is public read-only recovery; editing, publishing, feedback and onboarding remain paused.

## Cause and executed correction

The user's GitHub merge `a787124` existed, but Render still ran old `78e309d` and queried the expired Render hostname. The old manifest returned 500. Explicit Git/source checks proved that the user's merged platform tree exactly matched reviewed `464d13a`.

The first deployment request was automatically rejected because it might select stale code. After proving the exact new original-main commit and guard files, the retry was accepted. No indirect workaround bypassed that rejection. Code-first deploy `dep-dbrj6ic9v7es73cojnr0` built the new merge and correctly failed readiness against the old database before opening HTTP.

The existing service environment was then patched with the privately held TLS reader URL and reviewed read-only/migration/worker/storage settings; unrelated variables were preserved. Initial activation `dep-dbrj8c8ae00c73fr4130` became live at 16:01:55 UTC / 21:31:55 IST. Serialized API/walkthrough checks passed, but full browser testing found real queue timeouts and a late-translation mode-label race.

The follow-up fixes release database sessions before network requests, file downloads/streaming and routing work, while preserving publication, path and PIN checks. Mode labels retain the current target through boot and later translation passes. The final combined suite passed 219 tests with two fixture skips. An actual-reader shadow served 32 concurrent GETs successfully using the same five-connection budget.

GitHub device authorization completed as repository owner `NavMe-Dev`; actual Write permission was checked without printing credentials. `6527ba88daa577514385ab65a8fb4830c8bb450a` was pushed successfully to the original main branch without force. A one-key environment patch set the pool wait to 15 seconds, retaining the three-plus-two connection cap, and triggered the final deployment.

## Final deployment

| Field | Verified value |
|---|---|
| Service | `srv-db32v3bncjis73e9l2cg` |
| Workspace | `tea-d9dsalurnols73d3t4cg`, previously confirmed by the user |
| Repository | `NavMe-Dev/NavMe-2.0`, main |
| Runtime commit | `6527ba88daa577514385ab65a8fb4830c8bb450a` |
| Deploy ID | `dep-dbrjjlcipgvc73fq761g` |
| Live | 16:25:56 UTC / **21:55:56 IST** |
| Startup | Migrations disabled → database readiness passed → application/listener started |
| Data | Existing Supabase project `kzpvhzyefdtrtidrbuxb`, existing GCU v5 |
| Public curated POIs | 99, including Basketball Court 8 and BHM Block 28 |
| Mode | Application and database read-only; workers/migrations disabled |
| Pool | Three plus two overflow; bounded wait 15 seconds |

No paid resource, project, DNS entry, source database upgrade or replacement database was created. No local GCU/UNCC records were merged into production. The working local development database's 235 curated POIs and its earlier 127-row visibility repair remain separate.

## Actual acceptance and preservation

- **52/52** map checks on desktop, tablet, mobile and small mobile.
- **15/15** real Matterport walkthrough checks on desktop/mobile, including SDK readiness and camera movement.
- **18/18** GET-only privacy/authorization checks with `read_only=true`.
- **16/16** bounded public reads, four clients; zero final-run 503s.
- Final read-only preservation at **16:29:21 UTC / 21:59:21 IST**: all **130 original table scopes** unchanged, zero drift; all **21 original migration rows** preserved, with only expected migration `20261113135823` added.

The final runtime HTML and UI JavaScript match the deployed commit byte-for-byte. Initial real failures and separate test-tool transition/size observations remain preserved. Known optional AR/prototype-script 404s and SDK deprecation warnings did not block the tested flows; this report does not claim AR launch readiness. No production mutation probes were performed.

Evidence: [production summary](evidence/browser/production-gcu-v5-corrected/summary.json), [API/source identity](evidence/corrected-live-api.json), [final preservation](evidence/final-preservation-summary.json), [test suite](evidence/platform-pytest.txt), [concurrent shadow](evidence/shadow-public-pool-burst.json), [deployment/rollback](13-production-deployment.md), [release limits](15-final-release-report.md).
