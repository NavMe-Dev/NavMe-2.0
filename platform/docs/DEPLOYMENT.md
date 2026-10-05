# Deployment

> Status: the Docker files are written and syntax-checked but **could not be run on the build box (no Docker there)**.
> The same code was tested natively (PostgreSQL 17 + PostGIS 3.5, Python 3.13) — see "Native install" below.
> First Docker deploy: watch `docker compose logs -f api worker` and report issues.

> **Own-cloud (Supabase + Render):** planned cutover only — see [`OWN_CLOUD.md`](OWN_CLOUD.md). Not deployed / not formally approved. Live demos still use box + Cloudflare quick tunnels ([`CONNECTIONS.md`](../../CONNECTIONS.md)).

## Option A – single Ubuntu VM with Docker (recommended)

Sizing: 2 vCPU / 2–4 GB RAM / 40 GB disk handles several buildings; onboarding is the only heavy task
(≈1.5 GB RAM peak, 2–3 min per 500k-face model). Examples: Hetzner CX22 (~€4–6/mo), DigitalOcean 2 GB ($12/mo),
AWS Lightsail 2 GB ($10–12/mo). Add ~$1/mo for backups/object storage if desired.

1. **Create the VM** (Ubuntu 22.04/24.04), add your SSH key.
2. **DNS**: create an `A` record `maps.example.org → <VM IPv4>` (and `AAAA` for IPv6). Wait until `dig +short maps.example.org` returns the IP.
3. **Install**:
   ```bash
   git clone <your repo> wayfinding && cd wayfinding/platform     # or scp the zip and unzip
   scripts/setup_ubuntu.sh        # Docker, ufw (22/80/443), .env with random POSTGRES_PASSWORD + JWT_SECRET
   nano .env                      # DOMAIN=maps.example.org, MATTERPORT_SDK_KEY=…, VPS_URL=… (optional)
   docker compose up -d --build   # db, api (runs migrations), worker, caddy
   docker compose exec api wayfinding create-admin you@example.com
   ```
4. **HTTPS** is automatic: Caddy obtains/renews Let's Encrypt certificates for `DOMAIN` (ports 80+443 must be reachable).
   For a LAN/test box set `DOMAIN=localhost` (self-signed) or `DOMAIN=:80` (plain HTTP).
5. Open `https://maps.example.org/admin/`, add a building. Large MatterPaks: `scp` them into `platform/matterpaks/` and use the server path `/matterpaks/<name>` in the wizard.

Services (`docker-compose.yml`): `db` (postgis/postgis:16-3.4, volume `pgdata`), `api` (FastAPI, 2 uvicorn workers, runs `wayfinding migrate` on start),
`worker` (same image, `wayfinding worker`, polls the jobs table), `caddy` (TLS, serves `viewer/` at `/` and `admin/` at `/admin/`, proxies `/api/*`).
The spec's separate "admin" and "viewer" containers were folded into Caddy's static file server (both are plain static files) – one less container, same result.

### Matterport SDK key & domain whitelisting
The Showcase iframe preview works without a key. SDK features (and future in-viewer Showcase embedding) need an
**SDK application key** from Matterport (Account → Settings → Developer Tools → SDK Key Management). Whitelist every
domain that will embed it (e.g. `maps.example.org`, and `localhost` for dev), then set `MATTERPORT_SDK_KEY` in `.env`
and `docker compose up -d`. The key is only ever sent to authenticated admins; public bundles contain just `sdk_key_configured: true/false`.

### Updates
```bash
git pull            # or unzip the new release over the folder (keep .env, matterpaks/)
docker compose up -d --build     # migrations run automatically on api start
```

### Backups
`scripts/backup.sh` → `backups/<timestamp>.tar.gz` (pg_dump custom format + `published/` and `buildings/` minus raw MatterPak copies/voxels).
Restore: `scripts/restore.sh backups/<ts>.tar.gz`. Cron example (daily 03:15, keep 14):
```
15 3 * * * cd /home/ubuntu/wayfinding/platform && scripts/backup.sh && ls -1t backups/*.tar.gz | tail -n +15 | xargs -r rm
```
Copy backups off the VM (rclone to S3/B2/Drive). Keep the original MatterPaks separately – they are the source of truth.

### Security checklist
- `.env` has a unique `JWT_SECRET` (≥32 random bytes) and DB password; never commit it.
- Only 22/80/443 open (ufw). Postgres is not published outside the Docker network.
- `CORS_ORIGINS` can be narrowed to your domain(s).
- Create admins only via CLI; there is no self-signup.

## Option B – native install (how it was tested)
```bash
sudo apt install postgresql postgis python3-venv
sudo -u postgres createuser -P wayfinding; sudo -u postgres createdb -O wayfinding wayfinding
sudo -u postgres psql -d wayfinding -c "CREATE EXTENSION postgis"
cd platform && make setup && cp .env.example .env    # edit DATABASE_URL, JWT_SECRET
set -a; . ./.env; set +a; .venv/bin/wayfinding migrate; .venv/bin/wayfinding create-admin you@example.com
scripts/dev_server.sh start      # API + viewer + admin + inline worker on 127.0.0.1:8780
```
For production natively: run `uvicorn wayfinding_api.main:app --app-dir api --port 8000` and `wayfinding worker` as systemd
services, and put Caddy/nginx in front using `deploy/caddy/Caddyfile` (replace `api:8000` with `127.0.0.1:8000`, and the `/srv/...` roots with the repo paths).

## Option C – static only (no server): Cloudflare Pages / GitHub Pages / Netlify / S3
The viewer does search and routing client-side, so a published building can be hosted as plain files.
```bash
.venv/bin/wayfinding export-static dist --viewer viewer            # all published buildings ("--venue <slug>" to limit)
npx wrangler pages deploy dist        # Cloudflare Pages   – or push dist/ to a gh-pages branch, or any static host
```
`dist/` contains the viewer, `wf-config.js` pointing at the relative `api/v1/public/` tree, and the published JSON/webp/glb files
(≈9 MB for the test site). Tested locally with `python3 -m http.server`. Limitations: no admin, no server-side route endpoint, no VPS proxy;
re-export after each publish. Do not put the SDK key in a static build unless the domain is whitelisted in Matterport.

## Costs (rough, 2026 prices)
| Item | Cost |
|---|---|
| VM (Hetzner / DO / Lightsail) | $5–20 / month |
| Domain | ~$10–15 / year |
| TLS | free (Let's Encrypt via Caddy) |
| Static-only hosting | free tier (Cloudflare Pages / GitHub Pages) |
| Esri World Imagery tiles, World Geocoder | used at onboarding time only, low volume; check Esri terms for production (an ArcGIS Location Platform free tier / API key may be required) |
| ArcGIS Maps SDK for JS in the viewer | free for non-commercial dev use; production use with Esri basemaps needs an ArcGIS account (free tier covers ~2M basemap tiles/month). Swapping to MapLibre + OSM is on the roadmap |
| Matterport | the scan, MatterPak and SDK key come from the building owner's Matterport plan |
| OSM / Overpass / Nominatim | free, respect usage policies (cache results; don't bulk-query) |


## Cloudflare quick tunnels (dev sharing only)

This project’s current public demos use **Cloudflare Quick Tunnels**, not Cloudflare Pages.

- Binary: `/workspace/cloudflared`
- Church app → `:8765` → log `/workspace/cloudflared.log`
- Platform → `:8780` → log `/workspace/cloudflared-admin.log`
- Full restart commands + live URL table: [`../../CONNECTIONS.md`](../../CONNECTIONS.md)

There is **no** `wrangler publish` / Pages pipeline in-repo. Production path remains Docker + Caddy (or static `wayfinding export-static`) on a real domain.

When a quick tunnel URL changes, whitelist the new hostname on the Matterport Showcase SDK key or embedded Tour interior fails to connect.

Production own-cloud path (Supabase Postgres/PostGIS + Render Web/Worker, `navme.space`): **planned** — [`OWN_CLOUD.md`](OWN_CLOUD.md).
