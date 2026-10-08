"""Local "Use image" localization — matches an uploaded photo against the reference index
built by pipeline/wfpipe/steps/vps_index.py (ORB descriptors extracted from Matterport's own
captured cubemap images, one set per sweep). No external Visual Positioning Service, no
network call at request time.

This is nearest-scan-point matching by visual similarity, not true 6-DoF pose estimation —
it can be wrong in texture-poor or repetitive spaces. Fails closed (returns no match) rather
than guessing when the photo itself has too few features or no sweep stands out clearly.
"""
import io
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

from ..services import bundle_storage
from ..services.publish import current_version

# Tuned against the ORB defaults in vps_index.py (nfeatures=500/image); recalibrate once
# real phone photos have been tried against a real building — these are reasoned starting
# points, not measured thresholds.
MIN_QUERY_KEYPOINTS = 15        # fewer than this -> the photo itself is too texture-poor to trust
RATIO_TEST_THRESHOLD = 0.75     # Lowe's ratio test
MIN_GOOD_MATCHES = 12           # best sweep needs at least this many good matches
MIN_MARGIN_RATIO = 1.3          # best sweep's good-match count must beat the 2nd-best by this factor

_CACHE = {}      # slug -> (descriptors, meta_list, cache_key)
_CACHE_ORDER = []  # simple LRU: most-recently-used slug at the end
_CACHE_MAX = 4


# OpenCV's BFMatcher packs a train-image index into part of each DMatch's internal
# encoding; a single training matrix larger than ~2^18 (262144) rows trips an internal
# assertion ("trainDescCollection[iIdx].rows < IMGIDX_ONE") — confirmed hitting this with
# ~1.1M reference descriptors for one building. Match against chunks under that limit and
# merge the true global top-2 per query descriptor ourselves (each chunk's local top-2
# necessarily contains the global top-2 candidates, so this is exact, not approximate).
_MATCH_CHUNK = 200_000


def _knn_match_chunked(query_desc, ref_desc):
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    n_query = len(query_desc)
    best_dist = np.full(n_query, np.inf)
    second_dist = np.full(n_query, np.inf)
    best_idx = np.full(n_query, -1, dtype=np.int64)

    for start in range(0, len(ref_desc), _MATCH_CHUNK):
        chunk = ref_desc[start:start + _MATCH_CHUNK]
        knn = bf.knnMatch(query_desc, chunk, k=min(2, len(chunk)))
        for qi, pair in enumerate(knn):
            for m in pair:
                d = m.distance
                if d < best_dist[qi]:
                    second_dist[qi] = best_dist[qi]
                    best_dist[qi] = d
                    best_idx[qi] = start + m.trainIdx
                elif d < second_dist[qi]:
                    second_dist[qi] = d

    good = []
    for qi in range(n_query):
        if best_idx[qi] < 0 or second_dist[qi] == np.inf:
            continue
        if best_dist[qi] < RATIO_TEST_THRESHOLD * second_dist[qi]:
            good.append(int(best_idx[qi]))
    return good


def _load_image_bgr(image_bytes: bytes):
    """EXIF-correct orientation (phone photos default to portrait + an EXIF rotation tag;
    comparing against square-ish reference crops without this skews matching badly), then
    hand back an OpenCV BGR array."""
    pil = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
    arr = np.array(pil)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def _load_index(db, slug: str):
    from .. import models
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        return None
    mv = current_version(db, b)
    if not mv:
        return None
    cache_key = (slug, mv.version)
    cached = _CACHE.get(slug)
    if cached and cached[3] == cache_key:
        if slug in _CACHE_ORDER:
            _CACHE_ORDER.remove(slug)
        _CACHE_ORDER.append(slug)
        return cached[0], cached[1], cached[2]

    try:
        raw = bundle_storage.read_bundle_file(Path(mv.path), slug, mv.version, "vps_index.npz")
    except FileNotFoundError:
        return None
    npz = np.load(io.BytesIO(raw), allow_pickle=True)
    descriptors = npz["descriptors"]
    desc_image_idx = npz["desc_image_idx"]
    images = [json.loads(m) for m in npz["images"]]
    if not descriptors.shape[0]:
        return None

    entry = (descriptors, desc_image_idx, images)
    _CACHE[slug] = (*entry, cache_key)
    _CACHE_ORDER.append(slug)
    while len(_CACHE_ORDER) > _CACHE_MAX:
        evict = _CACHE_ORDER.pop(0)
        _CACHE.pop(evict, None)
    return entry


def match(db, slug: str, image_bytes: bytes) -> dict:
    loaded = _load_index(db, slug)
    if not loaded:
        return {"success": False, "message": "no VPS reference index for this building yet — "
                                              "run the vps_index pipeline step and publish"}
    ref_desc, desc_image_idx, images = loaded

    try:
        bgr = _load_image_bgr(image_bytes)
    except Exception:
        return {"success": False, "message": "could not read the uploaded image"}
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(nfeatures=500)
    _, query_desc = orb.detectAndCompute(gray, None)
    if query_desc is None or len(query_desc) < MIN_QUERY_KEYPOINTS:
        return {"success": False, "message": "photo doesn't have enough distinctive detail to match — "
                                              "try a clearer shot of a distinctive wall, sign, or doorway"}

    good_ref_idx = _knn_match_chunked(query_desc, ref_desc)
    if not good_ref_idx:
        return {"success": False, "message": "couldn't find a confident match — try a clearer or "
                                              "more distinctive photo"}

    scores = {}  # sweep_id -> count of good matches (per-face max folded in below)
    per_face = {}  # (sweep_id, face) -> count
    for idx in good_ref_idx:
        img = images[int(desc_image_idx[idx])]
        key = (img["sweep"], img["face"])
        per_face[key] = per_face.get(key, 0) + 1
    for (sweep_id, _face), count in per_face.items():
        scores[sweep_id] = max(scores.get(sweep_id, 0), count)

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best_sweep, best_count = ranked[0]
    second_count = ranked[1][1] if len(ranked) > 1 else 0
    if best_count < MIN_GOOD_MATCHES or (second_count and best_count < second_count * MIN_MARGIN_RATIO):
        return {"success": False, "message": "couldn't find a confident match — try a clearer or "
                                              "more distinctive photo"}

    sweep_meta = next(m for m in images if m["sweep"] == best_sweep)
    confidence = min(1.0, best_count / 60.0)
    return {"success": True, "x": sweep_meta["x"], "y": sweep_meta["y"], "z": sweep_meta.get("z"),
            "floor": sweep_meta.get("floor"), "confidence": round(confidence, 2)}
