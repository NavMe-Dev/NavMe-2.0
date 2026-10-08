#!/usr/bin/env python3
"""Prepare data/models/{model_id}/ for Image localize: mesh, georef, skyboxes, then build_db.

Usage:
  python prepare_model.py pAFsSSgF5kj \
    --mesh /path/to/mesh.npz \
    --georef /path/to/georef.json \
    [--skip-fetch] [--skip-build] [--views-fast]
"""
import argparse, json, os, shutil, sys, concurrent.futures as cf, urllib.request
from gql import q

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "data", "models")

SKY_Q = '''query($id:ID!){model(id:$id){floors{id label} locations{id index floor{id} neighbors position{x y z}
 pano{id position{x y z} rotation{x y z w} skyboxes{resolution url children}}}}}'''

def fetch_sky(model_id, dest):
    sky = os.path.join(dest, "sky"); os.makedirs(sky, exist_ok=True)
    d = q(SKY_Q, {"id": model_id})
    if not d.get("data") or not d["data"].get("model"):
        raise SystemExit(f"Matterport GraphQL returned no model for {model_id}: {d}")
    m = d["data"]["model"]
    meta = {"floors": m["floors"], "sweeps": [], "model_id": model_id}
    jobs = []
    for l in m["locations"]:
        p = l["pano"]
        skys = [s for s in (p.get("skyboxes") or []) if s.get("resolution") == "2k"]
        if not skys:
            continue
        sk = skys[0]
        meta["sweeps"].append({
            "id": l["id"], "index": l["index"], "floor": l["floor"]["id"],
            "position": l["position"], "cam": p["position"], "rot": p["rotation"],
            "neighbors": l["neighbors"],
        })
        for i, u in enumerate(sk["children"]):
            jobs.append((u, os.path.join(sky, f"{l['id']}_{i}.jpg")))
    json.dump(meta, open(os.path.join(dest, "sweeps.json"), "w"), indent=1)
    def get(j):
        u, f = j
        if os.path.exists(f) and os.path.getsize(f) > 1000:
            return
        r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
        open(f, "wb").write(urllib.request.urlopen(r, timeout=90).read())
    print(f"fetching {len(jobs)} sky faces for {len(meta['sweeps'])} sweeps…", flush=True)
    with cf.ThreadPoolExecutor(16) as ex:
        list(ex.map(get, jobs))
    print("sky done", flush=True)
    return meta

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_id")
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--georef", required=True)
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--views-fast", action="store_true", help="8 yaw views instead of 22 (faster, less robust)")
    args = ap.parse_args()
    dest = os.path.join(MODELS, args.model_id)
    os.makedirs(dest, exist_ok=True)
    shutil.copy2(args.mesh, os.path.join(dest, "mesh.npz"))
    shutil.copy2(args.georef, os.path.join(dest, "georef.json"))
    if not args.skip_fetch:
        fetch_sky(args.model_id, dest)
    if args.skip_build:
        print("skip build"); return
    # run build_db with env overrides
    env = os.environ.copy()
    env["VPS_MODEL_ID"] = args.model_id
    env["VPS_DATA"] = dest
    if args.views_fast:
        env["VPS_VIEWS_FAST"] = "1"
    print("building reference DB (CPU, ~20s/sweep)…", flush=True)
    os.execvpe(sys.executable, [sys.executable, os.path.join(HERE, "build_db.py")], env)

if __name__ == "__main__":
    main()
