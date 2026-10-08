"""Step vps_index: build a local "find my photo" reference index from Matterport's own
captured imagery, so the viewer's "Use image" button can work with zero external Visual
Positioning Service. For every sweep (scan point), fetch a few cardinal cubemap faces
(reusing the same public Matterport GraphQL skybox query thumbs.py already uses, and the
same retry/backoff pattern), extract ORB feature descriptors from each, and serialize one
compact per-building index (out/vps_index.npz) that api/wayfinding_api/services/vps_match.py
loads to match an uploaded photo against at request time — no network/Matterport calls at
request time, only here during onboarding.

Unlike thumbs.py (which only covers the ~half of sweeps adjacent to a POI/stair, for
place-card photos), this covers EVERY sweep: a user could be standing anywhere, not just
next to a named room.
"""
import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

Q = 'query($id:ID!){model(id:$id){locations{id pano{skyboxes{resolution status urlTemplate}}}}}'

RETRIES = 3
RETRY_DELAY_S = 1.5
# Cubemap face order is Matterport's own convention (0:front 1:right 2:back 3:left 4:top 5:bottom
# in practice, verified against thumbs.py already using face "1"); skip top/bottom (4,5) since
# floor/ceiling images rarely have enough distinctive texture to match against.
FACES = ["0", "1", "2", "3"]
IMG_SIDE = 384          # reference image size fed to ORB — bigger than thumbs.py's 320x192
                         # display thumbnails (which are for place cards, not matching)
MAX_FEATURES = 500       # per reference image
MAX_DESC_PER_IMAGE = 300  # cap after sorting by response, keeps the index matrix bounded


def _fetch_face(url_template, face):
    url = url_template.replace("<face>", face)
    last_err = None
    for attempt in range(RETRIES):
        try:
            b = urllib.request.urlopen(
                urllib.request.Request(url, headers={"User-Agent": "wayfinding-platform/0.1"}), timeout=30
            ).read()
            im = cv2.imdecode(np.frombuffer(b, np.uint8), 1)
            if im is None:
                raise ValueError("failed to decode image")
            im = cv2.resize(im, (IMG_SIDE, IMG_SIDE), interpolation=cv2.INTER_AREA)
            return im
        except Exception as e:
            last_err = e
            if attempt < RETRIES - 1:
                time.sleep(RETRY_DELAY_S * (attempt + 1))
    raise last_err


def run(ctx):
    if not ctx.cfg.get("vps_index", {}).get("enabled", True):
        np.savez(ctx.o("vps_index.npz"), descriptors=np.zeros((0, 32), dtype=np.uint8),
                  meta=np.array([], dtype=object))
        return {"enabled": False}

    nav = ctx.read_json(ctx.o("nav_graph.json"))
    sweeps = {n["id"]: n for n in nav["nodes"] if n.get("kind") == "sweep"}
    if not sweeps:
        ctx.warn("no sweep nodes in nav_graph.json — nothing to index")
        np.savez(ctx.o("vps_index.npz"), descriptors=np.zeros((0, 32), dtype=np.uint8),
                  meta=np.array([], dtype=object))
        return {"sweeps": 0, "images": 0, "descriptors": 0}

    try:
        d = json.load(urllib.request.urlopen(
            urllib.request.Request(
                "https://my.matterport.com/api/mp/models/graph",
                data=json.dumps({"query": Q, "variables": {"id": ctx.cfg["matterport_model_id"]}}).encode(),
                headers={"Content-Type": "application/json", "User-Agent": "wayfinding-platform/0.1"},
            ),
            timeout=90,
        ))
    except Exception as e:
        raise RuntimeError(f"skybox query failed: {e}")
    locs = (d.get("data") or {}).get("model", {}).get("locations") or []
    by_id = {l["id"]: l for l in locs}

    ref_dir = ctx.o("vps_refs")
    ref_dir.mkdir(exist_ok=True)

    # Build the (sweep, face, url) work list first, then fetch concurrently — this is
    # network-bound (one HTTPS round trip per image), and serially fetching up to
    # ~990 sweeps x 4 faces took ~13 minutes in testing. Already-cached files (a
    # resumed/retried run) are skipped without counting against the pool.
    jobs = []
    failed_no_skybox = []
    for sweep_id in sweeps:
        loc = by_id.get(sweep_id)
        skyboxes = [s for s in (loc.get("pano") or {}).get("skyboxes") or []] if loc else []
        if not skyboxes:
            failed_no_skybox.append(sweep_id)
            continue
        s = sorted(skyboxes, key=lambda s: {"512": 0, "high": 1, "2k": 2}.get(str(s["resolution"]), 3))[0]
        if not s.get("urlTemplate"):
            failed_no_skybox.append(sweep_id)
            continue
        for face in FACES:
            cache_path = ref_dir / f"{sweep_id}_{face}.jpg"
            if not cache_path.is_file():
                jobs.append((sweep_id, face, s["urlTemplate"], cache_path))

    def _download_one(job):
        sweep_id, face, url_template, cache_path = job
        try:
            im = _fetch_face(url_template, face)
            cv2.imwrite(str(cache_path), im, [cv2.IMWRITE_JPEG_QUALITY, 85])
            return True
        except Exception as e:
            ctx.warn(f"vps ref {sweep_id} face {face}: {e}")
            return False

    if jobs:
        with ThreadPoolExecutor(max_workers=12) as pool:
            list(pool.map(_download_one, jobs))

    # ORB extraction is CPU-bound and fast per image (milliseconds) — single-threaded
    # is fine here, unlike the network fetch above.
    orb = cv2.ORB_create(nfeatures=MAX_FEATURES)
    all_desc = []
    desc_image_idx = []    # one int per descriptor row, indexing into `images` below
    images = []             # one entry per reference image: {"sweep", "face", "x", "y", "z", "floor"}
    fetched_images = 0

    for sweep_id, node in sweeps.items():
        for face in FACES:
            cache_path = ref_dir / f"{sweep_id}_{face}.jpg"
            if not cache_path.is_file():
                continue
            im = cv2.imread(str(cache_path))
            if im is None:
                continue
            fetched_images += 1
            gray = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
            _, desc = orb.detectAndCompute(gray, None)
            if desc is None or not len(desc):
                continue
            if len(desc) > MAX_DESC_PER_IMAGE:
                desc = desc[:MAX_DESC_PER_IMAGE]
            img_idx = len(images)
            images.append({"sweep": sweep_id, "face": face, "x": node["x"], "y": node["y"], "z": node["z"],
                            "floor": node.get("floor")})
            all_desc.append(desc)
            desc_image_idx.extend([img_idx] * len(desc))

    failed = failed_no_skybox
    descriptors = np.concatenate(all_desc, axis=0) if all_desc else np.zeros((0, 32), dtype=np.uint8)
    # One meta entry per reference IMAGE (~4000), not per descriptor (~1M) — a first version
    # stored the full JSON dict once per descriptor and produced a 150MB file for one
    # building; descriptors carry only a compact int32 index back into `images`.
    np.savez(ctx.o("vps_index.npz"), descriptors=descriptors,
              desc_image_idx=np.array(desc_image_idx, dtype=np.int32),
              images=np.array([json.dumps(m) for m in images], dtype=object))

    return {"sweeps": len(sweeps), "images": fetched_images, "descriptors": int(descriptors.shape[0]),
            "sweeps_without_skybox": len(failed)}
