# UNC demo rollback checkpoint

Checkpoint confirmed before optimization: 2026-11-16 17:19:55 Asia/Calcutta (11:49:55 UTC).

## Frozen working production

- Original IDE branch: `main`.
- Original IDE commit: `33a01cc242d09b10a3abe79cc5a159ca6ab4260b`.
- Current successful production commit / stabilization base: `74f37ed55f62d921ced485020389a1150f47facc`.
- The IDE and production `platform/` and `dashboard/` trees compare identical before stabilization; their commit histories differ because releases were cherry-picked.
- Render deploy: `dep-dbtel0etlv9c73f542v0`, status **live**, finished 2026-11-16 17:06:05 Asia/Calcutta.
- Service: `srv-db32v3bncjis73e9l2cg` (`navme-wayfinding-platform`).
- Workspace: `tea-d9dsalurnols73d3t4cg` (MetaDigi Labs).
- Production URL: https://wayfinding.navme.space/unc-charlotte
- Git source: https://github.com/NavMe-Dev/NavMe-2.0, branch `main`.
- Runtime: Docker; context `platform`; Dockerfile `platform/deploy/Dockerfile.api`; entrypoint `platform/deploy/start-api.sh`.
- Render resources: 1 instance, `0.5c-512mb`, Oregon. Entrypoint starts one Uvicorn worker unless configuration overrides it; effective environment overrides are not yet verified.
- Render reports `autoDeploy=yes`. Treat any push to production `main` as deployment-capable; do not push there during preparation. The service has historically required manual deployment because of its public-repository connection.

## Uncommitted work preserved

The earlier navigation-image feature is **excluded** from this stabilization checkout. Its original workspace remains untouched.

Tracked edits: `platform/pipeline/wfpipe/steps/thumbs.py`, `platform/viewer/mp_app.js`, `platform/viewer/mp_preview.js`.
Untracked files: `platform/tests/test_thumbnail_provenance.py`, `platform/tests/viewer_step_capture.test.cjs`.

Additional private local backups:

- `/private/tmp/navme-uncc-demo-prior-feature.patch` (binary Git diff).
- `/private/tmp/navme-uncc-demo-prior-untracked.tar.gz` (untracked files).
- `/private/tmp/navme-uncc-demo-checkpoint.json` (paths, SHA256 checksums and original status).

Stabilization branch: `fix/uncc-demo-stabilization`, isolated checkout `/private/tmp/navme-uncc-demo-stabilization`.
Do not reset or clean the original workspace, and do not apply its feature patch to this branch.

## Environment configuration references

Values and credentials are deliberately excluded. Existing configuration references are Render service Environment / Environment Groups, repository `.env.example`, `platform/api/wayfinding_api/config.py`, and `platform/deploy/start-api.sh`.

Review these names only: `DATABASE_URL`, `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_POOL_TIMEOUT_SECONDS`, `DB_CONNECT_TIMEOUT_SECONDS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_READ_ONLY`, `WF_READ_ONLY`, `RUN_MIGRATIONS`, `WORKER_INLINE`, `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, `STUDIO_SUPABASE_URL`, `STUDIO_LIVE_BUILDINGS`, `VIEWER_DIR`, `ADMIN_DIR`, `DATA_DIR`, `PORT`, `API_MAX_CONCURRENCY`, `API_BACKLOG`, `BUNDLE_CACHE_WAIT_TIMEOUT_SECONDS`.

Do not copy secrets into this document or change production environment variables. No schema, RLS, publication or asset changes are part of stabilization.

## Development rollback, without overwriting work

Return to a clean copy of the frozen production code in a NEW worktree:

```sh
git worktree add --detach /private/tmp/navme-uncc-known-good 74f37ed55f62d921ced485020389a1150f47facc
```

This leaves both the original dirty workspace and the stabilization branch available for review. Never use `git reset --hard`, `git clean`, or force-push.

## Production rollback — only after explicit approval

No production deployment or restart is authorized by this preparation task. If a later approved release fails, the preferred rollback reuses the retained successful Render artifact:

1. Open https://dashboard.render.com/web/srv-db32v3bncjis73e9l2cg/deploys
2. Select `dep-dbtel0etlv9c73f542v0` and choose **Rollback to this deploy**.
3. Monitor the NEW rollback deployment until its status is `live`; the trigger alone is not success.
4. Verify the commit and health checks below.

Alternatively, with a securely supplied `RENDER_API_KEY`, the documented API command is:

```sh
curl --fail-with-body --request POST \
  --url https://api.render.com/v1/services/srv-db32v3bncjis73e9l2cg/rollback \
  --header "Authorization: Bearer ${RENDER_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{"deployId":"dep-dbtel0etlv9c73f542v0"}'
```

Do not run with shell tracing. The API rollback does not disable auto-deploy; the Dashboard rollback does. Inspect resulting settings and do not let a later branch push replace the rollback unintentionally.

If the artifact is no longer retained, an explicitly approved rebuild can target the exact source commit using the current Render CLI:

```sh
render deploys create srv-db32v3bncjis73e9l2cg --commit 74f37ed55f62d921ced485020389a1150f47facc --wait --output json --confirm
```

The CLI is not installed in the current execution environment; this is a reviewed fallback, not an executed action. Keep existing environment references intact. A code/artifact rollback does not undo data or environment-group changes; this task makes neither.

## Verification after any approved rollback

```sh
curl --fail --silent --show-error https://wayfinding.navme.space/api/health
curl --fail --silent --show-error --output /dev/null https://wayfinding.navme.space/unc-charlotte
```

Confirm the deployed SHA in Render, then run one normal UNC journey: landing → search → POI → directions → route preview → Exit. Confirm one Matterport initialization and no unexpected iframe replacement. Do not load-test production.

## Schedule and release gate

Four-hour deadline: 2026-11-16 **21:19:55 Asia/Calcutta**. Begin the 15-minute demo freeze by **21:04:55** at the latest. Earlier completion and freeze are preferred. No automatic deployment; a release requires explicit approval after the tested diff and report are available.

The supplied `UNCC wayfinder results.pdf` was subsequently located in the original repository root and all nine rendered pages were inspected. Its checksum and historical-versus-projection classification are recorded in `docs/evidence/uncc-demo/reference-report.json`; no historical figure is represented as a current measurement.

References reviewed: [Render rollbacks](https://render.com/docs/rollbacks), [rollback API](https://api-docs.render.com/reference/rollback-deploy), [Render CLI deploy command](https://render.com/docs/cli-reference#deploys).
