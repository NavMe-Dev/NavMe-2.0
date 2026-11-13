# Production deployment — public read-only recovery is live

Updated 2026-11-13, Asia/Kolkata, under the user's explicit **“GO-LIVE, take full decisions on your own”** authorization. The existing Render service now runs `6527ba8`, including the public connection-lifetime and translated view-mode label fixes, against the independently credentialed Supabase reader. **Final actual-domain API, privacy, ArcGIS and Matterport acceptance passed.** The initial `a787124` recovery became live but failed subsequent concurrency/UI acceptance and is superseded. The accepted scope remains existing GCU v5 public reads; editing, publishing and feedback remain paused. This is not a completed source-data merge or a full writable-platform release.

## Executed release

| Item | Verified state |
|---|---|
| Production URL | `https://wayfinding.navme.space` |
| Existing Render workspace | `tea-d9dsalurnols73d3t4cg` |
| Existing service | `srv-db32v3bncjis73e9l2cg` / navme-wayfinding-platform |
| Repository / branch | Original `NavMe-Dev/NavMe-2.0` / `main` |
| Live commit | `6527ba88daa577514385ab65a8fb4830c8bb450a` |
| Live deployment | `dep-dbrjjlcipgvc73fq761g` |
| Live completion | **2026-11-13 16:25:56 UTC / 21:55:56 IST** |
| Destination | Existing Supabase project `kzpvhzyefdtrtidrbuxb` |
| Database login | Server-only `navme_wayfinding_live_v1`, member only of the scoped reader group |
| Public dataset | Existing GCU publication v5; five floors; 99 existing curated POIs |
| Previous guarded release | `dep-dbrj8c8ae00c73fr4130`, `a78712453b0d16a7e60b95cb906994a51a3f9748`; retains read-only guards but has known pool/UI defects |
| Historical unguarded release | `dep-dbgre2h42hec73drki50`, old commit `78e309de5938b46d50f9fd38763d9ea70a209405`; unsafe with the reader URL |

The user's original merges delivered the reviewed initial code: `a787124` contains reviewed `464d13a`, with all thirteen checked runtime/guard/viewer files matching it byte for byte. Subsequently, the official GitHub device authorization completed as **`NavMe-Dev`**, repository owner permissions reported **PUSH=true**, and the final `6527ba8` fix was successfully pushed directly to original `NavMe-Dev/NavMe-2.0/main`. The earlier `AdhamNG` 403 is historical and no longer blocks source delivery. No authentication bypass occurred.

The domain, Render service, repository and existing Supabase project were preserved. No DNS change, replacement web service/project, paid resource creation or expired Render-database upgrade occurred.

## Deployment sequence and startup proof

| Stage | Actual outcome |
|---|---|
| Initial recovery flags on old code | `dep-dbrhjhgu01pc73b9cdig` selected old `78e309d` and failed; the prior live instance was retained. |
| Code-first deployment | `dep-dbrj6ic9v7es73cojnr0` built exact `a787124`. With the old database URL still in place, it disabled migrations, retried database readiness and failed closed before opening the listener. Status `update_failed` at 15:58:47 UTC. |
| Reviewed reader configuration activation | Twenty reviewed keys were merged into the existing service configuration, including the private reader `DATABASE_URL`; unrelated variables were preserved. No credential value was printed or committed. |
| Initial reader deployment | `dep-dbrj8c8ae00c73fr4130` used exact `a787124` and became live at 16:01:55 UTC. Initial native API reads passed, but later browser concurrency and label checks failed. |
| Acceptance-driven fix | `6527ba8` releases SQLAlchemy connections before public network/file/routing work and fixes view-mode labels after translation. Full platform suite: **219 passed, 2 skipped**. Actual-reader shadow: **32/32 GETs**, twelve concurrent clients, unchanged five-connection cap. |
| Final reviewed setting | Only `DB_POOL_TIMEOUT_SECONDS=15` was merged for this follow-up; pool size `3` plus overflow `2` and all prior read-only controls were retained. This triggered the exact final source deploy. |
| Final live deployment | `dep-dbrjjlcipgvc73fq761g` used exact `6527ba8`, started at 16:24:53 UTC and became **live at 16:25:56 UTC**. |
| Final production acceptance | ArcGIS **52/52** across four viewports; Matterport **15/15** across desktop/mobile; GET-only privacy **18/18**; bounded production reads **16/16 HTTP 200**, zero 503s. |
| Final preservation checkpoint | **16:29:21 UTC:** all 130 original table scopes match the frozen baseline, zero drift; only the previously approved migration-history addition is present. |

The final deployment's runtime sequence is directly verified:

1. **16:25:42 UTC:** automatic migrations disabled.
2. **16:25:48 UTC:** database startup readiness passed.
3. **16:25:53 UTC:** application startup completed and Uvicorn opened the listener.
4. **16:25:56 UTC:** Render marked the deployment live.

The code-first failure proved the startup module and fail-closed behavior before a working connection was supplied. Unguarded old `78e309d` never received the activated reader URL. The failed code-first deployment is historical evidence of that gate, not the outcome of either reader-backed release. The final deployment's startup log window contains no `OperationalError`, `TimeoutError` or `DatabaseNotReady` marker; full workload acceptance is checked separately.

The first reader-backed release logged actual SQLAlchemy `TimeoutError`/503 bursts around 16:05 and 16:08 UTC, including critical `nav_graph.json` and metadata requests; the first desktop ArcGIS startup therefore failed. Public requests were retaining their SQLAlchemy sessions through slow HTTP/storage calls and `FileResponse` delivery. The narrow fix materializes required records, detaches them and returns the connection before that work. Current-publication, draft, path, Matterport PIN and read-only guards remain tested. The UI fix resynchronizes the view-mode control after translation and updates its target translation key; the viewer cache version is `20261113viewmode2`. Increasing only the bounded pool wait from five to fifteen seconds complements the lifetime fix without increasing the database connection cap.

Verification before deployment used a real one-connection PostgreSQL pool to prove that blocked optional metadata leaves the connection available for the critical navigation graph, plus asset recovery/streaming, routing, publication/path, compound category-link fetch and PIN tests. The full combined suite includes the three final translation tests: [219 passed, 2 skipped](evidence/platform-pytest-pool-fix.txt). The actual-reader shadow handled [32/32 public GETs from twelve clients](evidence/shadow-public-pool-burst.json) in 2.719 seconds with the same five-connection cap. These are staging results, not a substitute for final actual-domain QA.

## Effective recovery configuration

The initial twenty-key merge and final single-key wait adjustment retained unrelated JWT, Matterport, domain and other existing service settings. The reviewed recovery controls now include:

| Key | Activated value / requirement |
|---|---|
| `DATABASE_URL` | Private exact-project session-pooler URL using the independent reader; never the owner credential |
| `WF_READ_ONLY` | `true` |
| `DB_READ_ONLY` | `true` |
| `WORKER_INLINE` | `false` |
| `RUN_MIGRATIONS` | `false` |
| `DB_STARTUP_CHECK` | `true` |
| `DB_STARTUP_TIMEOUT_SECONDS` | `60` |
| `DB_SSLMODE` | `require`; actual TLS verified |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | `3` / `2` per process |
| `DB_POOL_TIMEOUT_SECONDS` / `DB_POOL_RECYCLE_SECONDS` | `15` / `300` |
| `DB_CONNECT_TIMEOUT_SECONDS` | `10` |
| `DB_STATEMENT_TIMEOUT_MS` / `DB_LOCK_TIMEOUT_MS` | `30000` / `5000`, explicitly applied to each session |
| Public Supabase metadata / bundle configuration | Exact existing project and reviewed public metadata key/bucket settings; no service credential exposed to clients |
| `WF_CHAT_ENABLED` | `false` |

The database role has no application mutation, sequence, schema-creation, unrelated-column or custom privileged-RPC access. Explicit session initialization verifies read-only state because the pooler was observed to ignore libpq startup options. The HTTP gate independently blocks mutations, including feedback that otherwise writes through REST. Workers and automatic migrations remain disabled. The only retained POST operations are reviewed query operations such as routing and login.

## Data preservation and live API result

The complete destination archive was restored in isolated matching PostgreSQL 17.11/PostGIS 3.3.7 with all seven extensions. Source recovery verified all 130 frozen table counts/digests, security metadata, all fifteen archived sequence states and full-precision coordinate checks. The scoped reader and synthetic authentication were tested there before production provisioning.

Credential-free migration `20261113135823`, `wayfinding_public_reader_recovery`, added the NOLOGIN reader group, SELECT grants and ten SELECT-only policies. Its separately provisioned login used only a SCRAM verifier in SQL. All original destination records were preserved; the one expected migration-history row is separately accounted for. The application release performed **zero source-derived application INSERT/UPDATE/DELETE, no publication overwrite and no data merge**. Legacy grants and RLS-disabled tables were not silently changed. See [preservation proof](evidence/production-reader-preservation-summary.json), [post-activation proof](evidence/post-activation-preservation-summary.json), and [reader verification](evidence/actual-reader-connection.json).

Final `6527ba8` actual-domain native checks passed: health **200**, manifest **200** with GCU v5/five floors and runtime `read_only=true`. The served `index.html` and `ui.js` hashes match the final source commit; see [corrected live asset/API evidence](evidence/corrected-live-api.json). The accepted existing mirror contains 99 curated POIs including Basketball Court **8** and BHM Block **28**. A bounded repetition of sixteen actual production reads returned **16/16 HTTP 200 with zero 503s**. Initial serialized `a787124` passes are historical and were not substituted for these corrected-release checks.

Actual-domain browser acceptance passed on the corrected release: [ArcGIS 52/52 across four viewports](evidence/browser/production-gcu-v5-corrected/arcgis-acceptance.json), Matterport [desktop 8/8](evidence/browser/production-gcu-v5-corrected/matterport-desktop.json) and [mobile 7/7](evidence/browser/production-gcu-v5-corrected/matterport-mobile.json), and [GET-only privacy 18/18](evidence/browser/production-gcu-v5-corrected/privacy-preflight.json). Screenshots and full QA records are in [corrected production evidence](evidence/browser/production-gcu-v5-corrected/), with reports [10](10-arcgis-validation.md), [11](11-functional-test-report.md) and [12](12-mobile-test-report.md). The earlier failed attempt remains recorded rather than erased; the corrected passes are actual-domain results, not shadow results relabeled as production.

The final read-only preservation comparison at **16:29:21 UTC** verified **130/130 original table scopes, zero drift**, preserved every original migration record and confirmed only the one approved migration-history addition. See [final preservation evidence](evidence/final-preservation-summary.json). The 99-record production mirror remains the existing destination dataset; the repaired 235-record local mirror was not promoted or merged into production. The full release assessment, remaining legacy security/data limitations and chosen scope are recorded separately in reports [15](15-final-release-report.md) and [16](16-read-only-recovery-decision.md).

References: [Render deployments](https://render.com/docs/deploys), [health checks](https://render.com/docs/health-checks), [environment variables](https://render.com/docs/configure-environment-variables).
