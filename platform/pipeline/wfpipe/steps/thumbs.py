"""Step thumbs: small photo thumbnails (Matterport pano skybox faces) for POI sweeps and stair sweeps,
shown on place cards and floor-change cards. Signed skybox URLs expire, so static copies are stored.
Optional: failures only warn."""
import json, urllib.request
import numpy as np, cv2
from .fetch_mp import gql

Q = 'query($id:ID!){model(id:$id){locations{id pano{skyboxes{resolution status urlTemplate}}}}}'


def run(ctx):
    d = ctx.o("thumbs"); d.mkdir(exist_ok=True)
    if not ctx.cfg["thumbs"].get("enabled", True):
        ctx.write_json(d / "index.json", []); return {"enabled": False}
    pois = ctx.read_json(ctx.o("pois.json"))["pois"]; nav = ctx.read_json(ctx.o("nav_graph.json"))
    kinds = {n["id"]: n["kind"] for n in nav["nodes"]}
    want = {p["nearest_node"] for p in pois if kinds.get(p["nearest_node"]) == "sweep"}
    for e in nav["edges"]:
        if e.get("stairs"):
            want |= {x for x in (e["u"], e["v"]) if kinds.get(x) == "sweep"}
    W, H = ctx.cfg["thumbs"].get("size", [320, 192])
    done = []
    try:
        locs = gql(Q, {"id": ctx.cfg["matterport_model_id"]})["data"]["model"]["locations"]
    except Exception as e:
        ctx.warn(f"skybox query failed: {e}"); ctx.write_json(d / "index.json", []); return {"thumbs": 0}
    for l in locs:
        if l["id"] not in want: continue
        sk = [s for s in (l.get("pano") or {}).get("skyboxes") or [] if s.get("urlTemplate")]
        if not sk: continue
        s = sorted(sk, key=lambda s: {"512": 0, "high": 1, "2k": 2}.get(str(s["resolution"]), 3))[0]
        try:
            u = s["urlTemplate"].replace("<face>", "1")
            b = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "wayfinding-platform/0.1"}), timeout=30).read()
            im = cv2.imdecode(np.frombuffer(b, np.uint8), 1); h, w = im.shape[:2]
            sc = W / w; im = cv2.resize(im, (W, int(h * sc)), interpolation=cv2.INTER_AREA)
            y = max(0, (im.shape[0] - H) // 2); im = im[y:y + H]
            cv2.imwrite(str(d / f"{l['id']}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 80]); done.append(l["id"])
        except Exception as e:
            ctx.warn(f"thumb {l['id']}: {e}")
    ctx.write_json(d / "index.json", done)
    return {"thumbs": len(done), "wanted": len(want)}
