"""Step thumbs: small photo thumbnails (Matterport pano skybox faces) for POI sweeps and stair sweeps,
shown on place cards and floor-change cards. Signed skybox URLs expire, so static copies are stored.

Resilience, so coverage doesn't come down to luck on one run:
  - each fetch gets a few retries with backoff. A single build showed stair sweeps landing 429/429 and
    POI sweeps landing only 14/83 in the same run against the same API — that gap is almost certainly
    transient network/rate-limit failures, not missing skybox data, and a bare single attempt (the old
    behaviour) had no way to recover from either.
  - already-downloaded thumbnails are left alone, so re-running this step only backfills the gaps
    instead of re-downloading everything from scratch every time.
  - a sweep that still has no skybox after retries (a real gap, not a transient failure) borrows its
    nearest neighbour sweep's thumbnail instead of being left with nothing.

A second, separate gap: admin-curated POIs (e.g. "HMD Room no.[333]") live in Supabase
and are merged into the viewer's POI list live, client-side, at runtime — they never
appear in this workspace's own pois.json, so their nearest sweep was never even a
candidate here, retries or not. _live_poi_sweep_ids() pulls that same Supabase POI set
and snaps each one to the nearest sweep in nav_graph.json so those get covered too.

Optional: failures only warn."""
import json, os, time, urllib.request, urllib.error
from pathlib import Path
import numpy as np, cv2
from .fetch_mp import gql

Q = 'query($id:ID!){model(id:$id){locations{id pano{skyboxes{resolution status urlTemplate}}}}}'

RETRIES = 3
RETRY_DELAY_S = 1.5


def _env(name):
    """os.environ first; falls back to reading platform/.env directly (pipeline steps
    don't go through the API's pydantic-settings loader, which is the only other place
    that normally reads this file)."""
    v = os.environ.get(name)
    if v:
        return v
    try:
        env_path = Path(__file__).resolve().parents[3] / ".env"
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def _live_poi_sweep_ids(ctx, nav):
    """Fetch the Supabase-managed POI list (same gmap_list_pois RPC the public API's
    /dashboard/.../navme-pois endpoint uses) and snap each POI to its nearest sweep node,
    so thumbnails get generated for admin-named rooms too, not just pois.json's
    auto-detected room centroids."""
    supabase_url = _env("SUPABASE_URL")
    supabase_key = _env("SUPABASE_ANON_KEY")
    slug = ctx.cfg.get("slug")
    if not supabase_url or not supabase_key or not slug:
        return set()
    try:
        req = urllib.request.Request(
            f"{supabase_url}/rest/v1/rpc/gmap_list_pois",
            data=json.dumps({"p_slug": slug}).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "apikey": supabase_key,
                     "Authorization": f"Bearer {supabase_key}"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            rows = json.loads(resp.read())
    except Exception as e:
        ctx.warn(f"live POI fetch failed (skipping Supabase-POI thumbnail coverage): {e}")
        return set()

    sweeps = [n for n in nav["nodes"] if n.get("kind") == "sweep"]
    if not sweeps:
        return set()

    result = set()
    for r in rows:
        px, py, pz = r.get("x"), r.get("y"), r.get("z")
        if px is None or py is None or pz is None:
            continue
        # SDK (Y-up) -> model (Z-up): same conversion the viewer applies to this table.
        mx, my, mz = px, -pz, py
        best_id, best_d = None, None
        for n in sweeps:
            dd = (n["x"] - mx) ** 2 + (n["y"] - my) ** 2 + (n["z"] - mz) ** 2
            if best_d is None or dd < best_d:
                best_d, best_id = dd, n["id"]
        if best_id:
            result.add(best_id)
    return result


def fetch_thumb(loc, W, H, d):
    """Download + crop one location's skybox face 1 to out/thumbs/<id>.jpg.
    Returns True if written, False if the location has no skybox to try at all."""
    sk = [s for s in (loc.get("pano") or {}).get("skyboxes") or [] if s.get("urlTemplate")]
    if not sk:
        return False
    s = sorted(sk, key=lambda s: {"512": 0, "high": 1, "2k": 2}.get(str(s["resolution"]), 3))[0]
    u = s["urlTemplate"].replace("<face>", "1")
    last_err = None
    for attempt in range(RETRIES):
        try:
            b = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "wayfinding-platform/0.1"}), timeout=30).read()
            im = cv2.imdecode(np.frombuffer(b, np.uint8), 1); h, w = im.shape[:2]
            sc = W / w; im = cv2.resize(im, (W, int(h * sc)), interpolation=cv2.INTER_AREA)
            y = max(0, (im.shape[0] - H) // 2); im = im[y:y + H]
            cv2.imwrite(str(d / f"{loc['id']}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 80])
            return True
        except Exception as e:
            last_err = e
            if attempt < RETRIES - 1:
                time.sleep(RETRY_DELAY_S * (attempt + 1))
    raise last_err


def run(ctx):
    d = ctx.o("thumbs"); d.mkdir(exist_ok=True)
    if not ctx.cfg["thumbs"].get("enabled", True):
        ctx.write_json(d / "index.json", []); return {"enabled": False}
    pois = ctx.read_json(ctx.o("pois.json"))["pois"]; nav = ctx.read_json(ctx.o("nav_graph.json"))
    kinds = {n["id"]: n["kind"] for n in nav["nodes"]}

    # sweep -> directly-linked sweep neighbours, for the neighbour-sweep fallback below.
    neighbours = {}
    for e in nav["edges"]:
        u, v = e["u"], e["v"]
        if kinds.get(u) == "sweep" and kinds.get(v) == "sweep":
            neighbours.setdefault(u, set()).add(v)
            neighbours.setdefault(v, set()).add(u)

    want = {p["nearest_node"] for p in pois if kinds.get(p["nearest_node"]) == "sweep"}
    for e in nav["edges"]:
        if e.get("stairs"):
            want |= {x for x in (e["u"], e["v"]) if kinds.get(x) == "sweep"}
    live_ids = _live_poi_sweep_ids(ctx, nav)
    want |= live_ids

    W, H = ctx.cfg["thumbs"].get("size", [320, 192])
    already = {p.stem for p in d.glob("*.jpg")}
    done = set(already)
    pending = want - already

    try:
        locs = gql(Q, {"id": ctx.cfg["matterport_model_id"]})["data"]["model"]["locations"]
    except Exception as e:
        ctx.warn(f"skybox query failed: {e}")
        ctx.write_json(d / "index.json", sorted(done))
        return {"thumbs": len(done), "wanted": len(want), "reused": len(already)}
    by_id = {l["id"]: l for l in locs}

    failed = []
    for loc_id in pending:
        loc = by_id.get(loc_id)
        if loc is None:
            failed.append(loc_id); continue
        try:
            if fetch_thumb(loc, W, H, d):
                done.add(loc_id)
            else:
                failed.append(loc_id)
        except Exception as e:
            ctx.warn(f"thumb {loc_id}: {e}"); failed.append(loc_id)

    # A sweep that still has no photo of its own borrows the nearest sweep's thumbnail
    # (one hop in the nav graph) rather than leaving that POI/stair with nothing at all.
    backfilled = 0
    for loc_id in failed:
        if loc_id in done:
            continue
        for nb in neighbours.get(loc_id, ()):
            if nb in done:
                try:
                    (d / f"{loc_id}.jpg").write_bytes((d / f"{nb}.jpg").read_bytes())
                    done.add(loc_id); backfilled += 1
                except Exception as e:
                    ctx.warn(f"thumb fallback {loc_id} <- {nb}: {e}")
                break

    ctx.write_json(d / "index.json", sorted(done))
    return {"thumbs": len(done), "wanted": len(want), "reused": len(already),
            "new": len(done) - len(already) - backfilled, "neighbour_fallback": backfilled,
            "live_poi_sweeps": len(live_ids)}
