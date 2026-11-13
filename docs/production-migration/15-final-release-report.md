# Release report — public GCU recovery live in read-only mode

Updated 2026-11-13, Asia/Kolkata. **Public GCU read-only recovery is LIVE and verified.** Deployment **`dep-dbrjjlcipgvc73fq761g`**, commit **`6527ba88daa577514385ab65a8fb4830c8bb450a`**, became live at **21:55:56 IST / 16:25:56 UTC**. The real domain serves the corrected HTML/JavaScript and healthy database/manifest responses. Corrected production acceptance passed **101/101 defined checks**: 52 map, 15 walkthrough, 18 GET-only privacy and 16 concurrent-read checks, with **zero final-run 503s**. Earlier failed attempts are retained separately.

Public links: [GCU walkthrough](https://wayfinding.navme.space/gcu-omr), [map viewer](https://wayfinding.navme.space/), [admin login](https://wayfinding.navme.space/admin/). **Editing, publishing, onboarding, feedback and chat remain paused in this read-only recovery.** This is not a full writable-platform security release.

## Why the merged site still showed “Map unavailable”

The user merged the reviewed recovery branch into original GitHub main as **`a787124`**. Render was still serving October 28 commit **`78e309d`**, connected to the expired Render database hostname. Its logs showed DNS resolution failures and the venue manifest returned 500. The entire platform tree in that merge matched reviewed `464d13a`; the merged code had not become the running release.

A code-first deploy built the merge successfully and correctly refused to open HTTP while the expired database remained configured. The verified private Supabase reader connection and recovery settings were then merged into the existing service, producing initial live deployment `dep-dbrj8c8ae00c73fr4130` at 21:31:55 IST. Actual API, HTTPS walkthrough and privacy checks passed, but wider concurrent browser loading exposed connection-pool timeouts and a late-translation mode-label race. Those failures were preserved, not called a full pass.

The follow-up fix releases database connections before network/file/routing work and keeps the 2D/3D label synchronized after translations. It passed **219 platform tests, 2 skipped**, plus **32/32 concurrent shadow GETs** with the same five-connection cap. The user completed GitHub device authorization as `NavMe-Dev`; Write access was verified and **`6527ba8` was pushed successfully to the original repository's main branch**. The service was redeployed with a bounded 15-second pool wait, retaining the three-plus-two connection cap.

## Actual infrastructure and configuration

| Item | Executed state |
|---|---|
| Domain | `https://wayfinding.navme.space` |
| Existing Render service | `srv-db32v3bncjis73e9l2cg` / navme-wayfinding-platform |
| Confirmed workspace | MetaDigi Labs Workspace, `tea-d9dsalurnols73d3t4cg` |
| Source | `NavMe-Dev/NavMe-2.0`, main, corrected code `6527ba8` |
| Final runtime | `dep-dbrjjlcipgvc73fq761g`, live 21:55:56 IST |
| Destination | Existing Supabase `kzpvhzyefdtrtidrbuxb`, PostgreSQL 17.11 |
| Database login | Scoped `navme_wayfinding_live_v1`, TLS/session pooler |
| Publication | Existing GCU v5, 99 published curated mirror POIs |
| Recovery controls | Application/database read-only; workers/migrations disabled |
| Pool | Three connections plus two overflow, 15-second bounded wait |

Twenty reviewed environment keys were merged at initial activation, preserving unrelated secrets; only the pool wait was changed for the corrected rollout. No environment collection replacement, DNS change, source-database upgrade, new paid service or replacement production project occurred. Credentials remain private. Runtime logs verify migrations disabled, database readiness passed and HTTP started in that order.

## Data preservation

The complete occupied-destination archive was restored in matching isolated PostgreSQL 17.11/PostGIS 3.3.7. All **130 table counts/digests**, seven extensions, migration history and complete role/grant/policy metadata match. All 15 original archive sequence states match and original capture checksums are unchanged. Destination archive SHA-256: `4f1781bb50419e25cafb8938a6cf7c3ef5e3bc7851613f2769b6c97c6ccb08bf`.

Additive reader migration `20261113135823` created scoped read grants/group and ten SELECT policies; an independent SCRAM login was provisioned separately. It has no table/sequence mutation privileges or access to privileged legacy application functions. The first post-activation comparison at **21:34:02 IST** and final corrected-deployment comparison at **21:59:21 IST** both found **130/130 original table scopes unchanged, zero drift**, with all 21 original migration rows preserved and only the known additional migration row. The original baseline was not rewritten.

No production application INSERT/UPDATE/DELETE, local-source merge or publication overwrite was performed. Existing destination GCU v5, unrelated legacy records and ConnectLabs data remain intact. Unknown-provenance local source differences stay quarantined; a complete replacement for the unavailable expired Render source is not claimed.

The **local** GCU development database remains distinct. Its 235 active CMS mirrors include 127 records incorrectly retired by pipeline import. After a fresh full backup/isolated restore, only their visibility/stale flags were repaired; all 536 original local POI contents outside those two flags and the other ten tables were preserved. Local Basketball Court 8/BHM Block 28 and a 147.3 m route passed browser checks. That local repair was not copied into production. See [category repair](18-local-category-visibility-repair.md).

## Validation

Independent suites are listed separately; repeated subsets are not added into an artificial total.

| Check | Result and scope |
|---|---|
| Platform regression | **219 passed, 2 skipped**, final combined code |
| Reader authorization | **10 passed**, isolated synthetic PG18; exact PG17 role/template rehearsal also passed |
| Destination restore | **130/130 table fingerprints + full metadata PASS**, isolated matching PG17 |
| Final production preservation | **130/130 scopes unchanged, zero drift**, corrected `6527ba8` |
| Actual-reader concurrent shadow | **32/32 GETs PASS**, 12 clients, existing five-connection cap |
| Initial live ArcGIS attempt | **36/40 passed, 4 failed**; 12 intended desktop checks not executed after startup failure |
| Initial live Matterport / privacy | **15/15**, **18/18 GET-only PASS**, separately scoped |
| Corrected live map | **52/52 PASS**, desktop/tablet/mobile/small mobile, actual maps/search/floors/routes/navigation/language/refresh |
| Corrected live walkthrough | **15/15 PASS**, desktop/mobile; real SDK/model, categories and camera focus |
| Corrected live privacy | **18/18 GET-only PASS**, actual read-only runtime and admin authorization boundaries |
| Corrected live bounded reads | **16/16 PASS**, four clients, critical metadata/assets, zero 503s |

The two pytest skips concern the absent Greenland workspace and absent E57 ZIP fixture. Earlier failure screenshots and the initial production pool/label failures remain historical evidence. Native current-domain checks show health/manifest 200, GCU v5 and `read_only=true`; frontend hashes match `6527ba8`. No production mutation probes were run. The walkthrough test now waits for the existing loader fade to finish; its earlier transition-timing snapshot is retained. A separate bounded-probe geometry-size limit was recorded before using the small floors metadata endpoint; the complete floor geometry rendered in all four map runs.

Observed full-map startup times in the corrected run were **25.5 seconds desktop, 18.0 tablet, 16.8 mobile and 17.2 small mobile**. These are individual measurements, not guaranteed load times or an SLO. Actual same-floor and cross-floor routes, category results, navigation steps and refresh were exercised. Admin verification covers the login interface/anonymous denial, not editing or authenticated publishing.

Evidence: [final production summary](evidence/browser/production-gcu-v5-corrected/summary.json), [52 map checks](evidence/browser/production-gcu-v5-corrected/arcgis-acceptance.json), [16 bounded reads](evidence/browser/production-gcu-v5-corrected/critical-read-burst.json), [final platform suite](evidence/platform-pytest.txt), [concurrent shadow reads](evidence/shadow-public-pool-burst.json), [corrected live API/assets](evidence/corrected-live-api.json), [final preservation](evidence/final-preservation-summary.json), [destination restore](evidence/destination-restore-verification.json), [deployment](13-production-deployment.md), [rollback limits](14-rollback-plan.md).

## Remaining release limits

The shared legacy project still has 30 RLS-disabled tables and sensitive anonymous-grant/privileged-RPC findings. The backend reader and HTTP mutation gate do not remediate those separate legacy consumers. Full writable-platform release remains on HOLD pending that authorization design and authoritative reconciliation.

Pre-existing selected step-free routes have no route; UNCC has a missing walkgrid/unsnapped POIs; floor-elevation findings remain. The faithfully restored AR-event sequence is behind allocated IDs, although its immediate next ID was free. It was not changed, and the reader cannot consume sequences. Database backups contain Storage metadata, not object bytes; existing published assets were inspected without overwrite.

The previous GitHub push blocker is resolved. Code `6527ba8` is pushed to original main and deployed. Follow-up documentation/test-tool commits do not change the deployed runtime and use `[skip render]` to avoid an unnecessary release. The public recovery is verified within its read-only, existing-publication scope; full writable-platform readiness remains on HOLD.
