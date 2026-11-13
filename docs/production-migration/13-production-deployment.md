# Production deployment — code push pending repository access

Updated 2026-11-13, Asia/Kolkata, following the user's explicit **“GO-LIVE, take full decisions on your own”** authorization. The reviewed recovery is committed locally as **`616b4a9`**. GitHub rejected its production push with HTTP 403: `Permission to NavMe-Dev/NavMe-2.0.git denied to AdhamNG`. HTTPS and the existing SSH identity both authenticate as that account. Retries after the user's “Ready” replies have not succeeded. GitHub API inspection confirms `pull=true`, `push=false` and zero pending invitations for this repository. This is repository authorization, not a request for another go-live approval. See [access evidence](evidence/github-deployment-access.json).

## Existing service and actual changes

| Item | Verified state |
|---|---|
| Render workspace | `tea-d9dsalurnols73d3t4cg` |
| Existing service | `srv-db32v3bncjis73e9l2cg` / navme-wayfinding-platform |
| Domain | `https://wayfinding.navme.space` |
| Repository / branch | `NavMe-Dev/NavMe-2.0` / main, auto-deploy enabled |
| Existing remote commit | `78e309de5938b46d50f9fd38763d9ea70a209405` |
| Previous retained live deployment | `dep-dbgre2h42hec73drki50` |
| Reviewed recovery branch, local only | `codex/supabase-readonly-recovery`, initial code `616b4a9` plus reviewed evidence and local walkthrough fixes |
| Destination | Existing Supabase `kzpvhzyefdtrtidrbuxb` |
| Initial recovery scope | Existing GCU v5, public read-only |

The connector merged six nonsecret flags, preserving all other variables: `WF_READ_ONLY=true`, `DB_READ_ONLY=true`, `WORKER_INLINE=false`, `RUN_MIGRATIONS=false`, `DB_STARTUP_CHECK=true`, `DB_STARTUP_TIMEOUT_SECONDS=60`. Its automatic deployment **`dep-dbrhjhgu01pc73b9cdig`**, started 14:08:06 UTC, selected the unchanged old commit and ended **update_failed** at 14:09:10 UTC. The previous live deployment was retained. This is an actual failed old-code deployment attempt, not the reviewed recovery build's result.

**The reader DATABASE_URL has not been activated on Render.** Old code ignores the new HTTP mutation gate, including the REST-backed feedback protection. The new guarded code must be available before the working reader connection is supplied. No new paid resource, source database upgrade, DNS change or replacement production project was created.

## Completed database and application preparation

The full destination archive was restored into matching isolated PostgreSQL 17.11/PostGIS 3.3.7 with seven extensions. All 130 table counts/digests, complete role/grant/policy metadata and all 15 archive sequence states match. See [restore verification](destination-restore-preflight.md).

Supabase migration **`20261113135823`**, `wayfinding_public_reader_recovery`, added the NOLOGIN group `navme_wayfinding_public_reader_v1`, scoped SELECT grants and ten SELECT-only RLS policies. Separately provisioned SCRAM login `navme_wayfinding_live_v1` inherits only that group. Actual TLS/read-only/timeouts/privileges passed inspection. No credential appears in migration history or Git.

Every original record across all 130 tables remains unchanged. Exactly one expected migration-history record was added. No source-derived application INSERT/UPDATE/DELETE, publication overwrite, sequence write, legacy grant change or RLS toggle occurred. The ignored service credential file has mode 0600. See [preservation proof](evidence/production-reader-preservation-summary.json) and [actual reader proof](evidence/actual-reader-connection.json).

The actual reader powers the isolated shadow API: **22 API, 24 privacy/guard and 52 browser checks passed**. These are shadow results; actual-domain recovery acceptance remains pending.

## Authorized continuation

1. Confirm remote main has not diverged; push the reviewed commit without force. Existing auto-deploy will build it. Do not trigger a duplicate deploy after the push.
2. Verify the selected commit. With the old DB URL, the new startup check fails before opening HTTP; the previous instance remains. Do not activate the reader URL for old commit `78e309d`.
3. Merge only reviewed recovery configuration and the private reader URL. Preserve unrelated JWT, Matterport, domain and service secrets. Use the exact-project session pooler, required TLS and bounded five-connection process pool. The environment-update connector automatically triggers deployment; verify it selects the reviewed new commit.
4. Monitor the new deployment ID, build/runtime logs and readiness. The guarded entrypoint disables migrations/workers and verifies database/PostGIS/schema/read-only sessions before binding HTTP.
5. Require health/manifest 200, GCU v5 and `read_only=true`; repeat 52 real-browser checks and 18 GET-only privacy checks on the actual domain. Never run production mutation probes or publishing scripts.
6. Record the actual deployment ID, commit and screenshots. Only successful actual-domain acceptance establishes public read-only LIVE. Editing/publishing/feedback and full legacy-security remediation remain distinct unresolved work.

After repository access is corrected, publish the current reviewed HEAD from `codex/supabase-readonly-recovery` using `git push origin HEAD:main`, so the later [local walkthrough fixes](17-local-walkthrough-recovery.md) are included. Confirm the branch and remote revision first; no force push is authorized. Repository access has no reliable ETA; a successful subsequent build/configuration activation and production acceptance may take approximately **10–20 minutes**.

References: [Render deployments](https://render.com/docs/deploys), [health checks](https://render.com/docs/health-checks), [environment variables](https://render.com/docs/configure-environment-variables), [official MCP environment update](https://github.com/render-oss/render-mcp-server/blob/main/pkg/service/tools.go).
