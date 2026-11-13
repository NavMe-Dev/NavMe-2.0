# Production deployment — HOLD

Audit date: 2026-11-13, Asia/Kolkata. **No new deployment was triggered. No production database writes, environment changes, DNS changes, service replacements or source upgrades occurred.**

The user's follow-up asks for autonomous routine decisions and a live platform. That does not remove the request's critical preservation, verified-backup, reconciliation and security gates. Local-source provenance was explicitly reported as unknown. A release cannot safely proceed through those failures.

## Existing release preserved

| Item | Verified value |
|---|---|
| Workspace | `tea-d9dsalurnols73d3t4cg` |
| Web service | `srv-db32v3bncjis73e9l2cg` / navme-wayfinding-platform |
| Existing live deployment | `dep-dbgre2h42hec73drki50` |
| Commit | `78e309de5938b46d50f9fd38763d9ea70a209405` |
| Finished | 2026-10-28 08:50:25 UTC |
| Branch / auto-deploy | main / enabled on commit |
| Production domain | `wayfinding.navme.space` |
| Proposed destination | Existing `kzpvhzyefdtrtidrbuxb` only |

Render calls the existing deployment live; this describes deployment state, **not application readiness**. Current health and manifest still fail. No new deployment identifier exists to report. Changes remain in the local working tree; nothing was pushed to the auto-deploy branch.

## Required release sequence

1. The exact-project session connection is now verified through the ignored local secret file. Inspect and preserve the existing Render environment through authenticated access; current connector cannot read it and SSH was denied. Validate the intended restricted backend role and connection from Render before cutover.
2. The **occupied destination** full logical backup is captured and decoded, with checksum and snapshot digests in report 03. Complete its isolated PG17 restore test, including schema, managed extensions, migration history, grants and all occupied data. Preserve Storage bytes separately.
3. Establish an authoritative source or explicitly approve a bounded reconciliation of the unknown-provenance local copy. Resolve the report's business-identity conflicts and ID collisions; preserve all destination data. Do not create a complete replacement schema or blindly restore into public.
4. Rehearse the reviewed insert-only/remapping plan against an isolated destination copy on PostgreSQL 17, with per-record preservation digests, FK/sequence/business-identity checks and untouched ConnectLabs data. No executable production merge has been generated while these inputs are unresolved.
5. Complete the legacy authorization design and staging tests for the critical RLS/RPC issues. The narrow backend security candidate is not remediation of all shared legacy findings.
6. Validate the exact PostgreSQL direct/session connection, SSL trust, limited role, process/connection budget, statement timeout, ORM queries, read/write boundaries and authentication in staging. Disable automatic startup DDL for the audited occupied database with `RUN_MIGRATIONS=false`.
7. Run critical API/frontend/mobile feature tests with authentic reviewed publications and a browser capable of ArcGIS WebGL2. Resolve required asset/floor-data defects. Confirm rollback compatibility and capture effective configuration securely.
8. Present the exact production data/schema/security/configuration changes and review evidence for release approval, as required by the original request. Preserve this report's distinction between prepared values and verified secrets.
9. Apply only the approved transactional merge/security work, verify destination integrity, update only reviewed Render keys, then deploy the reviewed commit to the **existing** service. Monitor the returned deployment identifier to live and inspect runtime logs.
10. Verify real production health, expected venue manifest, published assets, ArcGIS rendering, buildings/floors/POIs, search/routes, admin authorization and all four mobile/desktop viewports. Record actual screenshots and timings. Any critical failure keeps the release on HOLD.

## Configuration proposal

See `render-env.proposed.example` and report 08. Values are a review proposal; the database secret is deliberately absent. The Management API currently advertises transaction pooling on 6543; the application proposal uses a separately verified direct or session connection. Do not assume session-mode support or use an untested transaction endpoint.

An HTTP readiness path `/api/health` should be configured after its dependency behavior and Render rollout effect are reviewed. `/api/live` is process liveness only and must not make a broken database deployment appear healthy. Existing domain/JWT/storage settings remain part of the required configuration snapshot.

## ETA and blockers

Local preparation and destination capture have been executed; this is not a plan-only handoff. Administrative connection access is now available, but a reliable go-live ETA cannot be calculated until complete destination restore verification, authoritative data reconciliation and critical legacy security behavior are resolved. A routine deploy may be quick after gates pass, but that is not an estimate for completing this recovery. Do not promise a fixed restoration time based only on passing builds.

References: [Render deployments](https://render.com/docs/deploys), [health checks](https://render.com/docs/health-checks), [environment-variable save/deploy behavior](https://render.com/docs/configure-environment-variables).
