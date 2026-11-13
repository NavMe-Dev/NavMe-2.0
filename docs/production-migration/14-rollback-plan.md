# Rollback and recovery plan

Status: prepared, **not yet executable as a verified production recovery procedure**. No production mutation has occurred, so no rollback was needed. The expired Render database must not be relied on for rollback.

## Preserve before release

- Current service `srv-db32v3bncjis73e9l2cg`, deployment `dep-dbgre2h42hec73drki50`, commit `78e309de5938b46d50f9fd38763d9ea70a209405`, branch and auto-deploy settings. Confirm retained artifact availability at release time.
- Secure effective environment/group/secret-file/runtime-overlay snapshot. This has not been obtained: SSH authentication was denied and the connector has no environment read operation. Never write secret values to these reports.
- Restore-tested destination backup, schema/grant/policy/function/trigger/sequence definitions, migration versions, exact table counts and per-record preservation digests. Provider physical-backup metadata is insufficient as rehearsal evidence.
- All approved migration/merge scripts, their checksums, insert/remap ledger, conflict decisions, timing and transaction checkpoints. The current reconciliation tool intentionally has no production apply command.
- Published asset inventory and immutable object/version bytes. A database rollback does not restore deleted or overwritten Storage objects. Keep destination GCU v5 and all ConnectLabs assets unchanged.
- Verified application compatibility matrix: previous build against the reviewed destination schema/role/configuration. Current local tests do not establish previous-release Supabase compatibility.

## Failure responses

| Failure | Controlled response |
|---|---|
| New build/deploy fails | Retain the previous running release; inspect the first failing stage. If a rollback is needed, deploy a verified retained build using the **reviewed Supabase configuration**, not the expired source URL. Verify health and logs. |
| Merge transaction fails | Roll back that transaction. Compare all original destination record digests and count baselines. Do not proceed to environment cutover. |
| Partial nontransactional merge | Pause further application, identify committed checkpoints from the ledger, reconcile inserts and references in isolation, and obtain approval for narrowly scoped compensating changes. Never delete rows merely because their IDs occur in a source export. |
| Supabase connection fails | Keep the verified destination intact; inspect DNS/network/SSL/session mode/role/pool limits. Revert only the reviewed application configuration if its prior target is known healthy. The old Render URL is not a valid fallback. |
| Missing/conflicting records | Preserve current destination rows, mark affected publication unavailable, resolve provenance/business identity/asset-version differences in staging. Do not invent replacement rows or republish local versions over existing destination versions. |
| Authentication breaks | Compare JWT secret/issuer/token behavior and role/table/RPC grants with the secure baseline. Restore only reviewed scoped policies/grants when safe. Do not broadly disable RLS or expose private tables. |
| ArcGIS viewer breaks | Distinguish manifest failure, asset failure, credentials/CORS/CSP, geometric data and WebGL environment. Restore a verified application build/configuration or publication only after compatibility checks; keep DB data intact. |
| Destination data corruption | Rehearse restoring the verified backup into a **new isolated** database and compare changes since capture. Propose a selective, reviewed recovery. Do not restore over occupied production or lose unrelated ConnectLabs writes. |

## Recovery verification

For every rollback, record the new deployment ID, effective secret-free configuration diff, database role/network checks, health/manifest results, public/private authorization tests, expected publication versions, asset availability, desktop/mobile map/search/route behavior and actual screenshots. Preserve both pre-change and post-change audit ledgers. A previous build plus an incompatible schema is not a recovery.

Render's Dashboard rollback can disable auto-deploy; API behavior differs. Inspect the resulting setting rather than assuming it. Build retention may expire. Existing listed older releases are `dep-dbg9bsvlk1mc73b3t6lg` and `dep-dbg98tqvcj2c73bi1q20`, but their continued artifact availability and Supabase compatibility are unverified.

Forbidden recovery shortcuts: destructive resets, truncation/schema drops, clean restores against Supabase, blind update-on-conflict, database replacement, and reconnecting to the suspended source without evidence. Do not run the legacy `platform/scripts/restore.sh` on the occupied destination.

Reference: [Render rollback behavior and limitations](https://render.com/docs/rollbacks).
