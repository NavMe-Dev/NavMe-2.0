# Own-cloud shipping runbook — Supabase + Render

**Audience:** Suhas (DevOps) · MetaDigi Labs  
**Canonical path:** `platform/docs/OWN_CLOUD.md`  
**As of:** 2026-09-30 (ET)  
**Status:** **Planned cutover only — not deployed, not formally approved.**  
Live product remains on the Grok Bot box + Cloudflare **quick tunnels** (`CONNECTIONS.md` / `URLS.txt`). Do **not** treat this file as evidence that `navme.space` or Render/Supabase are already live.

**Consolidates (planning sources under `/workspace/reports/`):**

| Report | Role |
|---|---|
| [`navme-supabase-render-migration-strategy.md`](../../../reports/navme-supabase-render-migration-strategy.md) | Architecture, data move, phases, risks, rollback |
| [`navme-own-stack-cutover.md`](../../../reports/navme-own-stack-cutover.md) | `navme.space` DNS / subdomain / third-party inventory |
| [`navme-cloud-config-from-build.md`](../../../reports/navme-cloud-config-from-build.md) | Concrete env + Render sizing from this box |
| [`navme-render-matterpak-e57-steps.md`](../../../reports/navme-render-matterpak-e57-steps.md) | Worker MatterPak / E57 onboard steps |

Also see: [`DEPLOYMENT.md`](DEPLOYMENT.md) (box/Docker/static), [`ARCHITECTURE.md`](ARCHITECTURE.md), root [`CONTINUE.md`](../../CONTINUE.md), [`CONNECTIONS.md`](../../CONNECTIONS.md).

**Admin runtime knobs (this box):** Spatial Studio **Config** tab (`#/config`) — Config Option 2 (LLM + safe runtime overlay). Non-secrets → `var/runtime_settings.json`; secrets write-only → `var/runtime_secrets.env` (0600). Never echo secrets. Production cutover should still set secrets in **Render / Supabase dashboards**, not only the overlay file.

---

## 1. Architecture (target)

```
                     navme.space (owned) — PLANNED
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
   app.navme.space    api.navme.space    studio.navme.space
   (viewer + AR)      (/api/*)           (Spatial Studio)
         └──────────────────┬──────────────────┘
                            │  HTTPS (Render TLS)
                            ▼
              Render Web Service (Docker)
              · FastAPI + static mounts (viewer / admin / ar_webxr)
              · same shape as box :8780
                            │
              Render Background Worker
              · wayfinding worker (jobs table)
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
   Supabase Postgres    Supabase Storage    External ProjectX
   + PostGIS            published/          (optional)
   venues…jobs          matterpak/          VPS_URL → /localize
                        vps-db/             — NOT on Render
```

| Layer | Planned host | Notes |
|---|---|---|
| API + viewer + admin + `ar_webxr` | Render **Web** | Image `deploy/Dockerfile.api`; health `/api/health` |
| Onboard / rebuild / publish jobs | Render **Worker** | `wayfinding worker`; `WORKER_INLINE=false` on Web |
| Relational + geometry | **Supabase Postgres + PostGIS** | Platform already uses Postgres/PostGIS (not SQLite) |
| Object storage | Supabase Storage (P1); worker disk OK for P0 | Published small; MatterPak multi-GB |
| Admin auth | Keep bcrypt + JWT | Supabase Auth optional later |
| ProjectX (Image localize) | Separate GPU/CPU host | Set `VPS_URL` (base URL; proxy adds `/localize`) |
| Digital twin UX | Matterport (hybrid) | Owner scan + Showcase SDK whitelist |

**Out of scope for this stack:** SpaceCheckXR; church prototype `:8765` as production; Cloudflare Pages as primary host; forcing ProjectX onto Render.

**Correction:** Migration is **box Postgres/PostGIS → Supabase Postgres (enable PostGIS)**, not “SQLite → Postgres.”

---

## 2. Supabase PostGIS

1. Create project (prefer **same region as Render** — region TBD until approved).  
2. Enable extension: `create extension if not exists postgis;`  
3. Schema: `wayfinding migrate` (Alembic) **or** restore from box `pg_dump` — pick one before enqueueing jobs.  
4. App URL form (from `config.py` / `.env.example`):

```text
DATABASE_URL=postgresql+psycopg://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
```

5. **ASSUMPTION:** If Transaction pooler fights `SELECT … FOR UPDATE SKIP LOCKED`, use **Session** mode (5432 pooler or direct) for the **worker**; Web can stay on Transaction for HTTP.  
6. Proof: `GET /api/health` → `ok: true` and a `postgis` version string.

Do **not** store LLM / Matterport / JWT secrets in Postgres tables. Use host env or (dev-only) `var/runtime_secrets.env`.

---

## 3. Render Web + Worker

### Web (`navme-web`) — from live-build config snapshot

| Setting | Planned value |
|---|---|
| Instance | **Standard 1 CPU / 2 GB** (P0 locked in cloud-config report; not formally approved) |
| Start | `wayfinding migrate && uvicorn wayfinding_api.main:app --host 0.0.0.0 --port 8000 --proxy-headers` |
| Health | `/api/health` on port **8000** |
| `WORKER_INLINE` | **`false`** |
| Static | `VIEWER_DIR` / `ADMIN_DIR` (and sibling `ar_webxr`) available in image or mount |

### Worker (`navme-worker`) — MatterPak / E57 ready

| Setting | Planned value |
|---|---|
| Instance | **Pro 2 CPU / 4 GB** |
| Persistent disk | **~200 GB** at `DATA_DIR=/data` |
| Start | `wayfinding worker` |
| Concurrency | **1** instance (disk not shared with Web) |

**Do not** run long onboard on the Web service (HTTP time limits). Details: report `navme-render-matterpak-e57-steps.md`.

Dockerfile today installs `libgl1 libglib2.0-0`. Before first E57 onboard on Render, add **`libegl1`** and install `wfpipe[e57]` (**ASSUMPTION** — patch before cutover).

---

## 4. Storage

| Artefact | Box reality (order of magnitude) | P0 | P1 |
|---|---|---|---|
| Published `vN/` | ~3–64 MB / building version | Disk readable by Web | Supabase Storage `published/` + CDN |
| Draft `work/` / `out/` | ~0.2–5 GB / building | Worker disk | Private Storage or keep disk |
| MatterPak / E57 | 144 MB – **~12 GB** | Server path on disk | Storage `matterpak/` or external S3/R2/B2 |
| ProjectX DBs | ~0.5–2.6 GB / model | On ProjectX host | Cold copy in Storage `vps-db/` |
| Scan plans | Small | Disk / Storage | Storage `scan_plans/` |

Prefer **admin server-path** MatterPak ingest over browser uploads &gt;2 GB (`MAX_UPLOAD_MB`, ADM-001/002).

---

## 5. MatterPak / E57 on Worker (checklist)

1. Git remote for `platform/` that Render can build (**ASSUMPTION:** remote may not exist yet).  
2. Image = `deploy/Dockerfile.api` (+ e57 / EGL deps).  
3. Worker env: `DATABASE_URL`, `DATA_DIR=/data`, same secrets as needed for Matterport fetch.  
4. Web enqueues jobs with `WORKER_INLINE=false`; worker claims via `jobs` table.  
5. Smoke: small MatterPak **or** `fixtures/e57_synth` through full wfpipe.  
6. Monitor Render logs + `jobs` row; cancel/retry from admin Jobs tab.  
7. Keep box `matterpak/` until Storage copies are checksum-verified.

---

## 6. Ollama vs hosted LLM

Chat uses OpenAI-compatible `WF_CHAT_LLM_BASE_URL` + optional `WF_CHAT_LLM_API_KEY` (`config.py`). Same code path for:

| Mode | Example | Key |
|---|---|---|
| **Local Ollama** (box / private host) | `http://127.0.0.1:11434/v1` | Optional / empty |
| **Hosted** (OpenAI / compatible) | `https://api.openai.com/v1` | Required |

Admin **Config** tab can toggle `WF_CHAT_ENABLED`, base URL, model, rate limit, and probe `GET {base}/models` (safe — no completions). On Render, prefer **hosted** or a private Ollama sidecar/VPN — do not expose Ollama to the public internet.

---

## 7. VPS / Image (ProjectX)

- Platform proxies `POST /api/v1/public/vps/localize` → `{VPS_URL}/localize`.  
- **P0 default:** `VPS_URL` **empty** → Image returns 501 (viewer still works without Image).  
- **P2:** HTTPS ProjectX on specialty GPU/CPU cloud; set `VPS_URL` (no trailing `/localize`).  
- Config UI validates URL (http/https only; blocks cloud metadata; warns on private hosts).

---

## 8. DNS vs tunnels

| Today (live) | Planned (not done) |
|---|---|
| Cloudflare **quick tunnels** → `127.0.0.1:8780` | Custom domain → Render TLS |
| Ephemeral `*.trycloudflare.com` | `app` / `api` / `studio` on `navme.space` (or single host P0) |

P0 simplification (acceptable): one Render Web host serving `/`, `/admin/`, `/api/*`, `/ar_webxr/`; point `app.navme.space` (and optionally apex) at it.

Env sketch after cutover:

```text
PUBLIC_BASE_URL=https://app.navme.space
CORS_ORIGINS=https://app.navme.space,https://studio.navme.space,https://navme.space
```

Retire quick tunnels for **prod** only after DNS+HTTPS smoke passes. Keep tunnels as **rollback** until stable.

---

## 9. Matterport whitelist

Required for Tour / Elevators / Media twin SDK:

- Planned: `app.navme.space`, `studio.navme.space`, `localhost` (dev)  
- During tunnel demos: current `*.trycloudflare.com` host from `URLS.txt`  
- After cutover: remove unused tunnel hosts from the Matterport SDK key allowlist  

Never put the SDK key in static JS bundles. Admin Config shows **configured yes/no** only.

---

## 10. Security

- JWT admin only for `/api/v1/admin/*` (including `/admin/platform/config`).  
- Secrets never returned by API; Config UI never loads `.env` values.  
- Narrow `CORS_ORIGINS` before production (`*` is for box demos).  
- `VPS_URL` / LLM base URL: SSRF-aware validation (no metadata IPs; private-host warnings).  
- Supabase **service role** only on API/worker if Storage API is added — never in viewer.  
- Rotate `JWT_SECRET` at cutover; do not commit `.env` / `var/runtime_secrets.env`.

---

## 11. Smoke (after a future deploy — not run yet)

1. `GET https://app…/api/health` → PostGIS ok  
2. Admin login → Buildings list → open published viewer  
3. Tour twin connects (Matterport whitelist)  
4. Enqueue small onboard; worker completes; publish  
5. Optional: Config probe LLM; chat FAB if `WF_CHAT_ENABLED`  
6. Optional: Image localize only if `VPS_URL` set  

---

## 12. Rollback

1. Keep low DNS TTL during cutover; point DNS back to tunnel / previous host.  
2. Keep box Postgres dump + `matterpak/` + `vps/data/` until Storage copies verified.  
3. Do not delete Render disks / Supabase project until rollback window ends.  
4. Matterport whitelist: re-add tunnel host if rolling back to tunnels.

---

## 13. Explicit non-claims

- This runbook does **not** mean Supabase, Render, or `navme.space` are live.  
- Sizing numbers are **planning defaults from the build box**, not a purchase order.  
- Git remote for Render builds may still need creation.  
- Formal approval to cut over remains with Suhas / MetaDigi Labs.

---

## 14. Related admin UX (shipped on box)

| Surface | Route | Purpose |
|---|---|---|
| **Config** | `/admin/#/config` | Edit non-secret runtime overlay; secret yes/no + write-only set/clear; LLM probe; status |
| API | `GET/PATCH /api/v1/admin/platform/config` | Same data; JWT required |
| Probe | `POST /api/v1/admin/platform/config/probe-llm` | Safe `GET /models` |
| Overlay files | `platform/var/runtime_settings.json`, `platform/var/runtime_secrets.env` | Not Postgres |

After CORS / JWT / DB secret changes: `scripts/dev_server.sh restart` (or restart Render Web).
