"""Step vps_index: build a local "find my photo" reference index from Matterport's own
captured imagery, so the viewer's "Use image" button can work with zero external Visual
Positioning Service. For every sweep (scan point), fetch cubemap faces (reusing the same
public Matterport GraphQL skybox query thumbs.py already uses, and the same retry/backoff
pattern), extract ORB feature descriptors from each, and serialize one compact per-building
index (out/vps_index.npz) that api/wayfinding_api/services/vps_match.py loads to match an
uploaded photo against at request time — no network/Matterport calls at request time, only
here during onboarding.

Unlike thumbs.py (which only covers the ~half of sweeps adjacent to a POI/stair, for
place-card photos), this covers EVERY sweep: a user could be standing anywhere, not just
next to a named room.

Earlier version history, kept here because the lessons shaped the current design:
  - v1 matched 90-degree-wide cubemap faces downscaled to 384px, pooling every reference
    image's descriptors into one global matrix and running a single Lowe's-ratio-test
    pass. A real phone photo of a real room scored 5 total matches across 1.1M reference
    descriptors for the whole building, despite the photo itself having 500+ keypoints.
  - v2 tried narrowing each face to 3 overlapping ~60-degree crops (closer to a phone's
    FOV). This made it WORSE (2 matches), ruling out FOV mismatch as the dominant cause.
  - Diagnosis: matching the SAME photo against ONLY the correct room's 4 reference faces
    in isolation (no competing images) found 36-60 good matches — the content matches
    fine. The problem was architectural: pooling millions of descriptors into one
    knnMatch() and taking a single global ratio test means a keypoint's true match in the
    right room has to out-score every near-duplicate-looking corner/texture anywhere else
    in a ~1000-room building for the *second-best* slot — plenty of unrelated "distractor"
    descriptors are close enough to push the ratio above threshold even when the best
    match is correct. Per-image (not pooled) ratio testing, scored and ranked per sweep
    afterward, avoids this entirely — see vps_match.py.
  - Given that, this version drops the narrow-crop idea (back to one image per face,
    resolution increased to counteract some of the detail lost at 384px — testing showed
    this helps too, independent of the pooling fix).
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
NATIVE_SIDE = 1024        # Matterport's native per-face resolution at the "high" skybox tier
IMG_SIDE = 768            # size each reference face is resized to before ORB runs — testing
                          # showed matching quality keeps improving with resolution up to at
                          # least native 1024; 768 is a middle ground for index size/runtime
MAX_FEATURES = 1000       # per reference image — doubling from an initial 500 roughly doubled
                          # good-match counts against a real test photo
MAX_DESC_PER_IMAGE = 600  # cap after sorting by response, keeps the index matrix bounded
# A texture-poor reference image (sky, blank wall) isn't just useless — it's actively
# dangerous: Lowe's ratio test against only a handful of reference descriptors is
# statistically unreliable and tends to pass far too often by chance. One outdoor sweep's
# near-blank sky face (5 keypoints, mostly JPEG-noise corner responses) outscored a
# visually-confirmed-correct room (11 genuine matches) with 194 "good" matches against a
# real test photo purely from this effect. Drop any reference image this weak outright.
MIN_REF_KEYPOINTS = 50


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
            if im.shape[0] != IMG_SIDE or im.shape[1] != IMG_SIDE:
                im = cv2.resize(im, (IMG_SIDE, IMG_SIDE), interpolation=cv2.INTER_AREA)
            return im
        except Exception as e:
            last_err = e
            if attempt < RETRIES - 1:
                time.sleep(RETRY_DELAY_S * (attempt + 1))
    raise last_err


def run(ctx):
    if not ctx.cfg.get("vps_index", {}).get("enabled", True):
        _save_empty(ctx)
        return {"enabled": False}

    nav = ctx.read_json(ctx.o("nav_graph.json"))
    sweeps = {n["id"]: n for n in nav["nodes"] if n.get("kind") == "sweep"}
    if not sweeps:
        ctx.warn("no sweep nodes in nav_graph.json — nothing to index")
        _save_empty(ctx)
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
    # resumed/retried run, or a resolution bump — stale-resolution files are deleted by
    # the caller rather than detected here) are skipped without counting against the pool.
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
            cv2.imwrite(str(cache_path), im, [cv2.IMWRITE_JPEG_QUALITY, 90])
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
    image_offsets = [0]   # length n_images+1; image i's descriptors are
                          # descriptors[image_offsets[i]:image_offsets[i+1]] — enables
                          # per-image (not globally pooled) matching in vps_match.py
    images = []            # one entry per reference image: {"sweep", "face", "x", "y", "z", "floor"}
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
            if desc is None or len(desc) < MIN_REF_KEYPOINTS:
                continue
            if len(desc) > MAX_DESC_PER_IMAGE:
                desc = desc[:MAX_DESC_PER_IMAGE]
            images.append({"sweep": sweep_id, "face": face, "x": node["x"], "y": node["y"], "z": node["z"],
                            "floor": node.get("floor")})
            all_desc.append(desc)
            image_offsets.append(image_offsets[-1] + len(desc))

    failed = failed_no_skybox
    descriptors = np.concatenate(all_desc, axis=0) if all_desc else np.zeros((0, 32), dtype=np.uint8)
    np.savez(ctx.o("vps_index.npz"), descriptors=descriptors,
              image_offsets=np.array(image_offsets, dtype=np.int64),
              images=np.array([json.dumps(m) for m in images], dtype=object))

    return {"sweeps": len(sweeps), "images": fetched_images, "descriptors": int(descriptors.shape[0]),
            "sweeps_without_skybox": len(failed)}


def _save_empty(ctx):
    np.savez(ctx.o("vps_index.npz"), descriptors=np.zeros((0, 32), dtype=np.uint8),
              image_offsets=np.array([0], dtype=np.int64), images=np.array([], dtype=object))
