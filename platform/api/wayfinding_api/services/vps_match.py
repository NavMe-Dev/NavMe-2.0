"""Local "Use image" localization — matches an uploaded photo against the reference index
built by pipeline/wfpipe/steps/vps_index.py (ORB descriptors extracted from Matterport's own
captured cubemap images, one set per sweep). No external Visual Positioning Service, no
network call at request time.

This is nearest-scan-point matching by visual similarity, not true 6-DoF pose estimation —
it can be wrong in texture-poor or repetitive spaces. Fails closed (returns no match) rather
than guessing when the photo itself has too few features or no sweep stands out clearly.

Matching is done PER REFERENCE IMAGE, not pooled into one global comparison. An earlier
version concatenated every reference image's descriptors into a single matrix and ran one
Lowe's-ratio-test pass against it — a real test photo of a real, visually-confirmed-correct
room scored 5 total matches across 1.1M reference descriptors for one building, even though
matching the SAME photo against just that room's own 4 reference images in isolation found
36-60 good matches. The difference: with everything pooled, a keypoint's true match has to
out-score every near-duplicate-looking corner/texture anywhere else in the building for the
ratio test's "second place" slot — plenty of unrelated descriptors are close enough to push
the ratio over threshold even when the best match is genuinely correct. Scoring each
reference image's own descriptors independently (ratio test only within that image) and
then ranking images avoids this distractor problem entirely.
"""
import io
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

from ..services import bundle_storage
from ..services.publish import current_version

# Tuned against vps_index.py's ORB settings (nfeatures=1000/image, 768px); recalibrated
# against one real phone photo of one real, visually-confirmed-correct room (see commit
# history) — still a starting point, not a broadly validated threshold.
MIN_QUERY_KEYPOINTS = 15        # fewer than this -> the photo itself is too texture-poor to trust
RATIO_TEST_THRESHOLD = 0.75     # Lowe's ratio test
MIN_GOOD_MATCHES = 10           # best sweep's best-scoring image needs at least this many good matches
MIN_MARGIN_RATIO = 1.3          # best sweep's good-match count must beat the 2nd-best sweep by this factor

_CACHE = {}        # slug -> (descriptors, image_offsets, images, cache_key)
_CACHE_ORDER = []  # simple LRU: most-recently-used slug at the end
_CACHE_MAX = 4


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
    image_offsets = npz["image_offsets"]
    images = [json.loads(m) for m in npz["images"]]
    if not descriptors.shape[0]:
        return None

    entry = (descriptors, image_offsets, images)
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
    ref_desc, image_offsets, images = loaded

    try:
        bgr = _load_image_bgr(image_bytes)
    except Exception:
        return {"success": False, "message": "could not read the uploaded image"}
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(nfeatures=1000)
    _, query_desc = orb.detectAndCompute(gray, None)
    if query_desc is None or len(query_desc) < MIN_QUERY_KEYPOINTS:
        return {"success": False, "message": "photo doesn't have enough distinctive detail to match — "
                                              "try a clearer shot of a distinctive wall, sign, or doorway"}

    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    scores = {}  # sweep_id -> best single reference image's good-match count
    for i, img in enumerate(images):
        start, end = int(image_offsets[i]), int(image_offsets[i + 1])
        if end - start < 2:
            continue
        knn = bf.knnMatch(query_desc, ref_desc[start:end], k=2)
        good = 0
        for pair in knn:
            if len(pair) < 2:
                continue
            m, n = pair
            if m.distance < RATIO_TEST_THRESHOLD * n.distance:
                good += 1
        if good > scores.get(img["sweep"], 0):
            scores[img["sweep"]] = good

    if not scores:
        return {"success": False, "message": "couldn't find a confident match — try a clearer or "
                                              "more distinctive photo"}
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
