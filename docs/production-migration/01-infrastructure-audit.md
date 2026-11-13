# Infrastructure audit

Audit: 2026-11-13, Asia/Kolkata. Strategy: preserve and merge. Production mutations performed: **none**. Workspace was explicitly confirmed by the user before Render inspection.

## Verified resources

| Resource | Observed configuration |
|---|---|
| Render workspace | MetaDigi Labs Workspace, `tea-d9dsalurnols73d3t4cg` |
| Existing production web service | `navme-wayfinding-platform`, `srv-db32v3bncjis73e9l2cg` |
| Production domain | `wayfinding.navme.space`; Render request logs identify this host on the service |
| Render service URL | `https://navme-wayfinding-platform-mawd.onrender.com` |
| Source repository / branch | `https://github.com/NavMe-Dev/NavMe-2.0`, `main` |
| Runtime / region / instances | Docker, Oregon, one instance, plan `0.5c-512mb` |
| Build configuration | Context `platform`; Dockerfile `platform/deploy/Dockerfile.api` |
| Current live deployment | `dep-dbgre2h42hec73drki50`, finished 2026-10-28 08:50:25 UTC |
| Current live/local commit | `78e309de5938b46d50f9fd38763d9ea70a209405` |
| Auto-deploy | Enabled on commit; do not push `main` before release gates pass |
| Health-check configuration | Render HTTP health path empty; TCP listener on port 10000 |
| Expired Render source | `dpg-db32uq3ncjis73e9k3q0-a`, PG16, suspended/billing, Free, empty external IP allowlist |
| Source expiry | 2026-11-06 11:39:20 UTC / 17:09:20 IST |
| Exact occupied destination | `NavMe-2.0`, `kzpvhzyefdtrtidrbuxb`, Singapore, ACTIVE_HEALTHY |
| Destination PostgreSQL | 17.11; host `db.kzpvhzyefdtrtidrbuxb.supabase.co`; PostGIS 3.3.7 |

The database ID is distinct from the web-service ID. No replacement service, database, project, domain, DNS record, or paid recovery upgrade was created. Other services, including ConnectLabs, remain out of scope.

## Application and data architecture

- Public production frontend: static HTML/CSS/plain JavaScript, ArcGIS JS **4.34** loaded from its CDN. The real viewer bootloader first requests a venue manifest; SDK availability does not prove map initialization.
- Platform administration: bundled **Vue 3.5.43** and MapLibre, no frontend build required for the container.
- Separate repository dashboard: plain JavaScript/TypeScript and Three.js, Vite **6.4.1**; embedded 2D/3D subapps use Vite **5.4.21**. The dashboard is not the ArcGIS production viewer. README's broad Vue description does not accurately describe this separate dashboard entrypoint.
- Backend: FastAPI, SQLAlchemy/GeoAlchemy2, psycopg 3, PostgreSQL/PostGIS. Observed local versions and deployed-version limitations are in `08-backend-integration.md`.
- Routing: `/api/v1/public/*`, `/api/v1/admin/*`, `/api/v1/auth/*`, `/api/health`, `/api/docs`; static viewer `/` and admin `/admin/`.
- Platform authentication: bcrypt + HS256 bearer JWT, database `users.is_admin`; separate from Supabase Auth.
- Legacy dashboard authentication: credential-checking RPCs, then requests authorized with the same Supabase anonymous API token. Account/organization filters in browser state are not database authorization. This blocks a blanket RLS cutover; see `07-security-review.md`.
- Schema management: Alembic revision `0001`, shared by local and destination. Existing container startup automatically migrates; prepared code adds an explicit `RUN_MIGRATIONS=false` option for an audited occupied destination.
- Publication: backend tables store editable building/floor/POI records, graphs and version metadata; versioned JSON, images, GLBs and navigation files live on disk and Supabase Storage. `all` is a virtual venue and does not require a `venues` row.
- Background work: database job queue, `FOR UPDATE SKIP LOCKED`; optional inline worker or management CLI worker. The inspected Render service list contains no separate NavMe worker/cron service. Other external schedulers were not established.
- Storage: `wayfinding-bundles` public; `wayfinding-sources` private; `project-media` public; ConnectLabs `spatial-images` and `spatial-models` private. Database dumps do not include these object bytes.
- Existing tests: platform pytest, dashboard builds, previous Playwright tooling. Existing `e2e_screens.py` edits/publishes content, so it was not used against production. New read-only smoke and isolated failure regressions provide safe evidence.

## Environment configuration and access limits

The local root `.env` is ignored; platform/dashboard `.env` paths symlink to it. Only key presence was inspected for reporting. Backend settings also allow local runtime overlays; overlay values must be inspected on the deployed service before final cutover.

Repository setting names include `DATABASE_URL`, `JWT_SECRET`, `DATA_DIR`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, `VIEWER_DIR`, `ADMIN_DIR`, `WORKER_INLINE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, storage buckets, and Matterport/ArcGIS-related runtime configuration. The exact live environment-key inventory and secret snapshot remain **unverified**: Render MCP offers environment updates but no read operation, no Render API credential is available locally, and SSH authentication failed with `Permission denied (publickey)` after validating the official Oregon host fingerprint. No SSH key was registered and no host verification was bypassed.

Actual live runtime logs prove the database target is still the expired source hostname: `psycopg.OperationalError: failed to resolve host 'dpg-db32uq3ncjis73e9k3q0-a'`. This is evidence of the target being used, not a claim that every live variable was read. `POSTGRES_URL`, `PGHOST`, linked environment groups, mounted secret files and effective runtime overrides cannot be conclusively inventoried without service access.

Supabase Management API confirms Data API schemas `public,graphql_public`, `max_rows=1000`, search path `public,extensions`. It reports pooler host `aws-0-ap-southeast-1.pooler.supabase.com`, transaction port 6543, but no explicit pool-size limits. A subsequently supplied private database credential was verified through the documented session endpoint on **5432**, with client TLS and read-only mode; PostgreSQL 17.11 and Alembic `0001` match the project. The local migration URI now uses that working endpoint. The direct host does not resolve on this machine. This verifies administrative read-only access, not the intended restricted backend role or Render-origin connectivity. Never substitute the Supabase REST URL for `DATABASE_URL`.

## Findings

1. **Outage root cause confirmed:** live manifest and health fail because the expired database hostname cannot resolve.
2. **Preservation required:** destination already contains backend GCU data, legacy NavMe data and ConnectLabs data. Local data differs materially.
3. **Security critical:** 30 public tables have RLS disabled, including private account/login/user tables with anonymous grants; 39 callable SECURITY DEFINER signatures are flagged for each browser role.
4. **Backup gate incomplete:** a full 130-table logical archive with owners/ACLs and separate password-free roles has been captured and fully decoded, but an isolated complete destination restore has not passed. See report 03.
5. **Independent defects:** untranslated startup error and tiny Retry target fixed locally; `/ar_webxr/launch.js` still 404s because its repository symlink target is absent. ArcGIS rendering and navigation cannot pass while the manifest fails.

Evidence: `evidence/render-baseline.json`, `evidence/supabase-management.json`, `evidence/destination-baseline.json`, browser reports 10–12, and private catalog files under ignored `platform/var/data/production_migration/`.

References: [Render SSH access and fingerprints](https://render.com/docs/ssh), [Render environment variables](https://render.com/docs/configure-environment-variables), [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres).
