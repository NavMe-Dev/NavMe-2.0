# Initial recovery scope and data decision

User authorization: 2026-11-13, “GO-LIVE, take full decisions on your own.”
Operational authorization is explicit. Existing data-preservation and verified
recovery requirements remain in force; no unknown-source updates are approved.

## Chosen data scope

The initial recovery candidate uses the **existing destination GCU v5 publication**
and existing related Supabase records unchanged. It does not transfer local GCU
v1 edits or create UNCC relational records from unknown-provenance local data.
This is restoration of the known existing publication, not an assertion that
Supabase contains a complete replacement for the expired Render database.

Proposed source-derived production INSERT/UPDATE/DELETE count: **zero**. All 232
local identity/content conflicts, 101 key collisions and remaining candidates
stay quarantined in the private captured source and machine-readable reports.
No destination-only record is removed or changed. Recovery of additional real
publications remains a separate reviewed reconciliation task.

## Candidate application mode

- Preserve the existing Render service and `wayfinding.navme.space`.
- Enforce read-only database sessions with explicit session initialization and
  verification; the session pooler was observed to ignore libpq startup options.
- Enforce an HTTP mutation gate, disable job workers and automatic migrations,
  and retain only reviewed query-like POST endpoints such as routing/login.
- Use a newly scoped independent reader database role after its exact grants,
  RLS behavior and reachable privileged functions are tested on the restored
  PG17 copy. No anonymous/authenticated grants or legacy table changes are
  implied by this role.
- Preserve existing unrelated Render secrets, domain, storage, JWT and service
  configuration by patching only the reviewed recovery keys.

This candidate can restore public viewing while leaving editing/publishing
unavailable. It must not be described as the full requested writable production
platform or as remediation of the pre-existing legacy anonymous Data API risks.
The 30 RLS-disabled tables and legacy identity architecture remain explicit
security findings; a reader role does not resolve those application consumers.

## Required evidence before cutover

1. Complete full archive restoration and all-schema integrity comparison in
   the fresh isolated matching PG17/Vault/PostGIS environment now being built.
2. Verify the exact scoped reader role and policies on that clone, with no
   legacy RPC access except reviewed read-only extension helpers.
3. Pass actual GCU v5 manifest, asset, publication/privacy, search, floor,
   category and routing tests in a read-only shadow API and current browser.
4. Review the exact application/configuration patch and safe recovery behavior.
   Any release-critical failure keeps the corresponding cutover on HOLD.
5. After any authorized deployment, verify the real domain and report the
   actual public/editing/security state separately. Never call the complete
   release PASS based solely on a working public map.

## Execution update

The matching PG17 full restore, exact reader-role rehearsal and actual-reader shadow acceptance passed: all 130 original table fingerprints and metadata match. The shadow API passed 22 checks, privacy/guard passed 24 checks and four-viewport browser acceptance passed 52 checks.

Production migration `20261113135823`, `wayfinding_public_reader_recovery`, added the reader group/grants and ten SELECT-only policies. Independent SCRAM login `navme_wayfinding_live_v1` was provisioned and verified. Every original record across 130 tables remains unchanged; exactly one expected migration-history row was added. Legacy grants and RLS flags remain intact.

Six Render recovery flags were merged. The environment connector automatically triggered `dep-dbrhjhgu01pc73b9cdig` against unchanged old code; it failed and retained the previous live release. The reader database URL has **not** been activated on Render.

The reviewed code is local commit `616b4a9`. GitHub rejected HTTPS/SSH pushes because saved account `AdhamNG` lacks repository write access. Its API confirms `pull=true`, `push=false` and no pending matching invitation. Retries after the user's access-ready messages still failed. Production code deployment and actual-domain acceptance remain pending authorized repository authentication; no additional go-live approval is required. See [deployment status](13-production-deployment.md) and [release report](15-final-release-report.md).
