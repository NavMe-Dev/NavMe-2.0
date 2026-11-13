# Release report — local walkthrough/categories fixed; production push blocked

**Local category update, 2026-11-13:** The missing Basketball Court/BHM Block entries were existing local CMS mirrors incorrectly marked stale by a pipeline import. The recovery publication filter then hid them. A fresh full local backup passed isolated restore; a bounded repair restored only the visibility/stale flags on 127 existing records. The local API/viewer now expose **235 POIs, Basketball Court 8 and BHM Block 28**. All 536 existing POI records preserve their original content outside those two flags, and the other ten tables are unchanged. Import/sync ownership rules are fixed; **200 platform tests pass, 2 skip**. Final browser verification is **7/7 PASS**, including actual cards, camera focus, floor filtering, restored-name search and a real **147.3 m route**. No page errors or Supabase application-data writes occurred. See [category visibility repair](18-local-category-visibility-repair.md) for proof and screenshots.

**Local recovery update, 2026-11-13:** The screenshot's exact `/gcu-omr` failure is fixed locally. Matterport rejected `127.0.0.1` with `KeyReferrerMismatchError`, while the same key/model worked on `localhost`. Browser entry pages now redirect IP loopback addresses to localhost, preserving the complete path/query. The original link renders the real walkthrough on desktop and mobile; the platform admin also loads. Search and a real 22.5 m route pass. A separate ArcGIS camera call in Matterport category/floor controls was fixed; the final replay has no page errors. **197 platform tests passed, 2 skipped**, including 15 origin regressions; three camera regression cases also pass. The read-only GCU v5 Matterport preview works separately. See [local walkthrough recovery](17-local-walkthrough-recovery.md). This is separate from public Render deployment, which remains blocked below. The runtime fix is commit **`49eefbc`**; its fresh production push was also rejected with HTTP 403 for `AdhamNG`. Deploy the current reviewed recovery branch, including these fixes, rather than only the original `616b4a9` commit.

Updated 2026-11-13, Asia/Kolkata, after explicit autonomous **GO-LIVE** authorization. **The requested platform is not yet recovered live.** The tested public read-only recovery is local commit **`616b4a9`**. GitHub rejects the production push with **HTTP 403: account `AdhamNG` cannot write to `NavMe-Dev/NavMe-2.0`**. HTTPS and SSH identify the same account; retries after the user's “Ready” replies still failed. No additional go-live approval is required, but repository access must work. GitHub API inspection confirms `pull=true`, `push=false` and no pending matching repository invitation.

## Completed recovery and preservation

- Fully captured and restored the occupied Supabase destination **`kzpvhzyefdtrtidrbuxb`** in isolated matching PostgreSQL 17.11/PostGIS 3.3.7. **All 130 table counts/digests match**, along with seven extensions, migrations, 30 original roles, 24 memberships, ten schemas, 80 policies, seven event triggers, 415 relation ACLs, 1,098 function ACLs and database settings/ICU/ownership. All 15 original sequence states match; original capture checksums remain unchanged.
- Restored the independent local backup and verified its 11 table fingerprints/sequences. Its production provenance remains **unknown**. Local GCU v1/UNCC differences stay quarantined: five matches, 232 content conflicts, 215 insertion candidates and 101 key collisions. **No source data was merged into Supabase.**
- Applied additive migration **`20261113135823`**, `wayfinding_public_reader_recovery`, adding a restricted reader group, read grants and ten SELECT policies. Separately provisioned SCRAM login **`navme_wayfinding_live_v1`**; actual TLS/session/read-only/timeout/privilege checks passed. It cannot mutate tables/sequences or invoke privileged legacy application functions. Existing anonymous/authenticated/ConnectLabs grants and RLS flags remain unchanged.
- Verified **every original record in all 130 tables remains unchanged** after reader preparation. Exactly one expected migration-history row was added. No application INSERT/UPDATE/DELETE, source merge, publication replacement or sequence write occurred.
- Implemented bounded PostgreSQL connections, honest dependency 503s, publication checks, explicit read-only sessions, the HTTP mutation gate and worker/migration shutdown for recovery. Database readiness runs before HTTP binds. Fixed draft curated-POI filtering, viewer mode controls and readable startup failures.
- Validated the actual reader in a separate shadow API: **22 API, 24 privacy/guard and 52 browser checks passed**. Current Chromium rendered authentic GCU v5 through WebGL2 on desktop, tablet, mobile and small mobile, exercising floors, categories, search, routes, navigation, language and refresh. These are shadow tests, not production acceptance.

The destination archive is 6,995,284 bytes, SHA-256 `4f1781bb50419e25cafb8938a6cf7c3ef5e3bc7851613f2769b6c97c6ccb08bf`. The independently restored local archive SHA-256 is `13f3998a7de60096a2e17cc05d7dca5fa8b20137136d14c59d286f5766d9ae24`. Backups and credentials remain private and ignored. Database backups contain Storage metadata, not object bytes; GCU v5 public references were checked separately and were not overwritten.

## Actual production state

The existing Render service **`srv-db32v3bncjis73e9l2cg`** and **`https://wayfinding.navme.space`** are preserved. No new paid service/project, expired-database upgrade, DNS change or replacement production database was created.

Six recovery flags were merged into Render without replacing unrelated variables. The connector automatically triggered **`dep-dbrhjhgu01pc73b9cdig`** against the old remote commit. It ended **update_failed** and retained deployment **`dep-dbgre2h42hec73drki50`**, commit **`78e309de5938b46d50f9fd38763d9ea70a209405`**. The old code still targets the expired Render database. A new-code production build has not run because GitHub rejected the push.

**The reader DATABASE_URL is not activated on Render.** Supplying it to old code would bypass the reviewed HTTP recovery boundary. Reader preparation is complete; code deployment, connection activation and actual-domain acceptance remain pending repository access.

The fresh actual-domain baseline at **19:54 IST** was homepage 200, health 500 and venue manifest 500; the old public config has no read-only flag. See [latest production check](evidence/browser/production-gcu-v5/final-live-status.json) and [repository permission evidence](evidence/github-deployment-access.json).

## Latest evidence

Independent suites/proofs are listed separately; repeated subsets are not added into a synthetic total.

| Validation | Result | Scope |
|---|---|---|
| Platform pytest | **200 passed, 2 skipped** | Local suite, including privacy/startup, local-origin and CMS ownership/recovery regressions |
| Reader authorization suite | **10 passed** | Real isolated PG18 synthetic fixtures; SCRAM/denied writes |
| Exact PG17 reader/template rehearsal | **PASS** | Restored destination; frozen records/sequences preserved |
| Destination full restore | **130/130 table digests + metadata PASS** | Isolated matching PG17 |
| Actual reader connection | **PASS** | Supabase TLS/session/privilege inspection |
| Actual-reader shadow API | **22/22 PASS** | Existing destination GCU v5 |
| Shadow privacy/guard | **24/24 PASS** | Mutations tested only on localhost |
| Shadow browser acceptance | **52/52 PASS** | Four viewports, real map and routing |
| New-code production acceptance | **NOT RUN** | Code not pushed/deployed |

The two skips concern an absent Greenland workspace and an absent E57 ZIP fixture. The earlier 15 live-browser failures are the original outage baseline, not failures of the verified shadow candidate. The old test-browser WebGL2 limitation was resolved using current Chromium/Metal. All three frontend builds passed earlier; the new Render container build remains unverified.

Evidence: [platform tests](evidence/platform-pytest.txt), [full restore](evidence/destination-restore-verification.json), [preservation](evidence/production-reader-preservation-summary.json), [reader connection](evidence/actual-reader-connection.json), [shadow API](evidence/actual-reader-shadow-api.json), [privacy](evidence/actual-reader-shadow-privacy.json), [52 browser checks](evidence/browser/shadow-gcu-v5/acceptance.json), [functional report](11-functional-test-report.md), [mobile report](12-mobile-test-report.md).

## Scope and remaining limitations

The initial recovery uses the **existing GCU v5 publication in read-only mode**. Editing, publishing, onboarding and feedback stay paused. The destination is not claimed to contain a complete replacement for the unavailable expired source. Unknown-provenance source reconciliation remains unresolved.

The shared legacy project still has **30 RLS-disabled tables** and existing sensitive anonymous grants/privileged-RPC findings. The restricted backend reader does not repair legacy consumers or establish full writable-platform security. A complete writable production-release PASS is not claimed.

Existing selected step-free route pairs have no route; UNCC has a missing walkgrid/unsnapped POIs; floor-elevation findings remain. The faithfully restored `public.navme_ar_events_id_seq` counter is behind allocated IDs. Its immediate next ID was free, so no immediate collision was demonstrated; future collision risk requires a separate reviewed correction. The reader cannot use sequences.

## Next action and conditional ETA

Correct repository write access for this workspace, then publish the reviewed commit to the existing auto-deploy main branch. No database password input or additional go-live approval is needed. Activate only the reviewed reader configuration after the new guarded code is selected, then verify the real domain before reporting LIVE.

Repository access has no reliable ETA. Once it works, approximately **10–20 minutes** is a conditional estimate for a successful Render build and final production verification. See [deployment sequence](13-production-deployment.md), [rollback boundaries](14-rollback-plan.md) and [recovery decision](16-read-only-recovery-decision.md).
