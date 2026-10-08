"""FastAPI multi-building VPS. Run: uvicorn service:app --host 127.0.0.1 --port 8770

POST /localize  multipart: image=<file>, model_id=<Matterport id> (optional hfov, max_side)
GET  /health    -> {ok, models:[{id, ready, ref_images}]}
GET  /models    -> list registered models
"""
import os, sys, time, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from localize import Localizer, list_models, model_ready

DEFAULT_MODEL = os.environ.get("VPS_DEFAULT_MODEL", "Hn36TwktGgz")

app = FastAPI(title="NavMe Visual Positioning (multi-building)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_cache: dict[str, Localizer] = {}

def get_localizer(model_id: str) -> Localizer:
    mid = (model_id or DEFAULT_MODEL).strip()
    if mid not in _cache:
        if not model_ready(mid):
            raise HTTPException(501, f"no Image reference DB for model {mid}; build is pending")
        _cache[mid] = Localizer(model_id=mid)
    return _cache[mid]

@app.on_event("startup")
def _warm():
    # Warm default if present so first church localize is fast
    if model_ready(DEFAULT_MODEL):
        try:
            get_localizer(DEFAULT_MODEL)
        except Exception as e:
            print("warm failed:", e, flush=True)

@app.get("/health")
def health():
    models = []
    for mid in list_models():
        ready = model_ready(mid)
        n = None
        if ready and mid in _cache:
            n = len(_cache[mid].crops)
        elif ready:
            try:
                import json
                from localize import model_dir
                meta = json.load(open(os.path.join(model_dir(mid), "db", "meta.json")))
                n = len(meta.get("crops") or [])
            except Exception:
                n = None
        models.append({"id": mid, "ready": ready, "ref_images": n})
    return {"ok": True, "default_model": DEFAULT_MODEL, "models": models}

@app.get("/models")
def models():
    return health()

@app.post("/localize")
async def localize(
    image: UploadFile = File(...),
    model_id: str | None = Form(None),
    building: str | None = Form(None),
    hfov: float | None = Form(None),
    max_side: int = Form(1024),
):
    mid = model_id or DEFAULT_MODEL
    loc = get_localizer(mid)
    buf = np.frombuffer(await image.read(), np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "could not decode image")
    r = loc.localize(img, hfov=hfov, max_side=max_side)
    r["model_id"] = mid
    if building:
        r["building"] = building
    keys = [
        "success", "x", "y", "z", "floor", "floor_id", "heading", "pitch", "lat", "lon",
        "confidence", "inliers", "inlier_ratio", "hfov", "nearest_sweep", "n_matches",
        "time", "yaw_model", "retrieved", "timing", "model_id", "building",
    ]
    return {k: r[k] for k in keys if k in r}
