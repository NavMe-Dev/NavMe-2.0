"""Admin API (JWT required): buildings, uploads, onboarding jobs, floors, POIs, georef, routing test, publish."""
import csv, io, json, math, shutil, re
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, Body, Request
from fastapi.responses import FileResponse, StreamingResponse, PlainTextResponse
from geoalchemy2.elements import WKTElement
from geoalchemy2.shape import to_shape
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from ..db import get_db
from ..auth import current_admin, oauth2
from ..config import get_settings
from .. import models, schemas
from ..services import workspace, publish as pub, navgraph

router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(current_admin)])
PIPE_STEPS = ["ingest", "fetch_mp", "mesh", "colorplan", "imagery", "georef", "floors", "overlays", "glb", "voxel", "osm", "graph", "navmesh", "pois", "indoor", "thumbs", "export"]
CATEGORIES = ["room", "hall", "corridor", "entrance", "stairs", "elevator", "restroom", "parking", "outdoor", "info", "office", "worship", "kitchen", "other"]


def B(db, slug) -> models.Building:
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b: raise HTTPException(404, "unknown building")
    return b


def bjson(db, b: models.Building):
    mv = pub.current_version(db, b)
    lastjob = db.query(models.Job).filter_by(building_id=b.id).order_by(models.Job.id.desc()).first()
    s = get_settings()
    return {"id": b.id, "slug": b.slug, "name": b.name, "address": b.address, "lat": b.lat, "lon": b.lon, "venue": b.venue.slug if b.venue else None,
            "matterport_model_id": b.matterport_model_id, "sdk_key_ref": b.sdk_key_ref, "sdk_key_configured": bool(s.matterport_sdk_key),
            "matterpak_path": b.matterpak_path, "status": b.status, "model_info": b.model_info, "pipeline_config": b.pipeline_config, "branding": b.branding,
            "georef": {k: (b.georef or {}).get(k) for k in ("mode", "method", "rotation_deg", "scale", "model_origin_wgs84", "rms_m", "max_err_m", "model_to_epsg3857_affine", "auto")} if b.georef else None,
            "floors": [{"fid": f.fid, "label": f.label, "short_label": f.short_label, "ordinal": f.ordinal, "elevation_m": f.elevation_m, "height_m": f.height_m, "mp_floor_id": f.mp_floor_id} for f in b.floors],
            "published_version": mv.version if mv else None, "last_job": {"id": lastjob.id, "status": lastjob.status, "kind": lastjob.kind} if lastjob else None,
            "poi_count": db.query(models.POI).filter_by(building_id=b.id).count(), "updated_at": b.updated_at}


# ---------------- venues ----------------
@router.get("/venues")
def list_venues(db: Session = Depends(get_db)):
    return [{"slug": v.slug, "name": v.name, "description": v.description, "branding": v.branding, "buildings": [b.slug for b in v.buildings]} for v in db.query(models.Venue).all()]


@router.post("/venues")
def create_venue(v: schemas.VenueIn, db: Session = Depends(get_db)):
    if db.query(models.Venue).filter_by(slug=v.slug).first(): raise HTTPException(409, "venue slug exists")
    row = models.Venue(**v.model_dump()); db.add(row); db.commit(); return {"slug": row.slug}


@router.patch("/venues/{slug}")
def patch_venue(slug: str, v: dict, db: Session = Depends(get_db)):
    row = db.query(models.Venue).filter_by(slug=slug).first()
    if not row: raise HTTPException(404)
    for k in ("name", "description", "branding"):
        if k in v: setattr(row, k, v[k])
    db.commit(); return {"ok": True}


# ---------------- buildings ----------------
@router.get("/buildings")
def list_buildings(db: Session = Depends(get_db)):
    return [bjson(db, b) for b in db.query(models.Building).order_by(models.Building.name)]


@router.post("/buildings")
def create_building(inp: schemas.BuildingIn, db: Session = Depends(get_db)):
    if db.query(models.Building).filter_by(slug=inp.slug).first(): raise HTTPException(409, "building slug exists")
    d = inp.model_dump(); vs = d.pop("venue_slug")
    b = models.Building(**d)
    if vs:
        v = db.query(models.Venue).filter_by(slug=vs).first()
        if not v: v = models.Venue(slug=vs, name=vs.replace("-", " ").title()); db.add(v)
        b.venue = v
    if b.lat is not None and b.lon is not None:
        b.location = WKTElement(f"POINT({b.lon} {b.lat})", srid=4326)
    db.add(b); db.commit(); return bjson(db, b)


@router.get("/buildings/{slug}")
def get_building(slug: str, db: Session = Depends(get_db)):
    return bjson(db, B(db, slug))


@router.patch("/buildings/{slug}")
def patch_building(slug: str, p: schemas.BuildingPatch, db: Session = Depends(get_db)):
    from sqlalchemy.orm.attributes import flag_modified
    from ..services import access as access_svc
    b = B(db, slug); d = p.model_dump(exclude_unset=True)
    if "venue_slug" in d:
        vs = d.pop("venue_slug")
        v = db.query(models.Venue).filter_by(slug=vs).first() if vs else None
        if vs and not v: v = models.Venue(slug=vs, name=vs.replace("-", " ").title()); db.add(v)
        b.venue = v
    if "pipeline_config" in d and d["pipeline_config"] is not None:
        pc = dict(d["pipeline_config"] or {})
        if "access" in pc:
            try:
                pc["access"] = access_svc.sanitize_access(pc.get("access"), (b.pipeline_config or {}).get("access"))
            except ValueError as e:
                raise HTTPException(400, detail=str(e))
        d["pipeline_config"] = pc
    for k, v in d.items(): setattr(b, k, v)
    if "pipeline_config" in d:
        flag_modified(b, "pipeline_config")
    if b.lat is not None and b.lon is not None: b.location = WKTElement(f"POINT({b.lon} {b.lat})", srid=4326)
    db.commit(); return bjson(db, b)


@router.delete("/buildings/{slug}")
def delete_building(slug: str, delete_files: bool = False, db: Session = Depends(get_db)):
    b = B(db, slug); d = workspace.ws_dir(b); db.delete(b); db.commit()
    if delete_files and d.exists(): shutil.rmtree(d)
    return {"deleted": slug}



def _inspect_matterpak_path(raw: str) -> dict:
    """Validate a server-side MatterPak / E57 path. Returns {path, format, bytes, ...}."""
    from pathlib import Path as P
    import zipfile
    p = P(raw.strip()).expanduser()
    if not p.exists():
        raise HTTPException(404, f"path not found: {p}")
    if p.is_dir():
        e57s = sorted(p.rglob("*.e57"))
        objs = sorted(p.rglob("*.obj"))
        zips = sorted(p.glob("*.zip")) + sorted(p.glob("mp_e57_*.zip"))
        if objs:
            return {"path": str(p.resolve()), "format": "matterpak_dir", "bytes": None,
                    "files": sum(1 for _ in p.rglob("*") if _.is_file()),
                    "colorplans": sum(1 for x in p.rglob("*") if "colorplan" in x.name.lower())}
        if len(e57s) == 1:
            p = e57s[0]
        elif e57s:
            raise HTTPException(400, f"folder has {len(e57s)} .e57 files; point at one file")
        elif len(zips) == 1:
            p = zips[0]
        else:
            raise HTTPException(400, "folder has neither .obj (MatterPak) nor a single .e57 / mp_e57_*.zip")
    if not p.is_file():
        raise HTTPException(400, "path must be a file or a MatterPak/E57 folder")
    size = p.stat().st_size
    name_l = p.name.lower()
    if name_l.endswith(".e57"):
        if size < 64:
            raise HTTPException(400, "e57 file is empty/truncated")
        return {"path": str(p.resolve()), "format": "e57", "bytes": size}
    if name_l.endswith(".zip"):
        try:
            names = zipfile.ZipFile(p).namelist()
        except zipfile.BadZipFile:
            raise HTTPException(400, "not a valid zip")
        has_obj = any(n.lower().endswith(".obj") for n in names)
        has_e57 = any(n.lower().endswith(".e57") for n in names)
        if has_obj:
            return {"path": str(p.resolve()), "format": "matterpak", "bytes": size, "files": len(names),
                    "colorplans": sum(1 for n in names if "colorplan" in n.lower())}
        if has_e57:
            return {"path": str(p.resolve()), "format": "e57", "bytes": size, "files": len(names),
                    "e57_files": [Path(n).name for n in names if n.lower().endswith(".e57")]}
        raise HTTPException(400, "zip contains neither .obj (MatterPak) nor .e57 (point cloud)")
    raise HTTPException(400, "path must be .zip, .e57, or a MatterPak/E57 folder")


@router.post("/buildings/{slug}/matterpak")
async def upload_matterpak(slug: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload a MatterPak .zip, an ASTM .e57, or a Matterport E57-export zip (contains *.e57, no .obj)."""
    b = B(db, slug)
    name_l = (file.filename or "").lower()
    if not (name_l.endswith(".zip") or name_l.endswith(".e57")):
        raise HTTPException(400, "upload a MatterPak .zip, an .e57, or an mp_e57_*.zip")
    dest = get_settings().uploads_dir / b.slug; dest.mkdir(parents=True, exist_ok=True)
    fn = dest / re.sub(r"[^A-Za-z0-9._-]", "_", file.filename); size = 0
    with open(fn, "wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > get_settings().max_upload_mb << 20: raise HTTPException(413, "file too large")
            f.write(chunk)
    if name_l.endswith(".e57"):
        if size < 64:
            fn.unlink(missing_ok=True); raise HTTPException(400, "e57 file is empty/truncated")
        b.matterpak_path = str(fn); db.commit()
        return {"path": str(fn), "bytes": size, "format": "e57"}
    import zipfile
    try:
        names = zipfile.ZipFile(fn).namelist()
    except zipfile.BadZipFile:
        fn.unlink(); raise HTTPException(400, "not a valid zip")
    has_obj = any(n.lower().endswith(".obj") for n in names)
    has_e57 = any(n.lower().endswith(".e57") for n in names)
    if has_obj:
        b.matterpak_path = str(fn); db.commit()
        return {"path": str(fn), "bytes": size, "format": "matterpak", "files": len(names),
                "colorplans": sum(1 for n in names if "colorplan" in n.lower())}
    if has_e57:
        b.matterpak_path = str(fn); db.commit()
        return {"path": str(fn), "bytes": size, "format": "e57", "files": len(names),
                "e57_files": [Path(n).name for n in names if n.lower().endswith(".e57")]}
    fn.unlink()
    raise HTTPException(400, "zip contains neither .obj (MatterPak) nor .e57 (point cloud)")


@router.post("/buildings/{slug}/matterpak/path")
def set_matterpak_path(slug: str, body: dict = Body(...), db: Session = Depends(get_db)):
    """Attach a MatterPak/E57 already on the server (preferred for files ≳ 2 GB).

    Body: {"path": "/workspace/wayfinding/matterpak/<slug>/cloud_0.e57"}
    Validates the path exists and looks like MatterPak zip, E57, or folder.
    """
    b = B(db, slug)
    raw = (body or {}).get("path") or (body or {}).get("matterpak_path")
    if not raw or not str(raw).strip():
        raise HTTPException(400, "path is required")
    info = _inspect_matterpak_path(str(raw))
    b.matterpak_path = info["path"]
    db.commit()
    return info


@router.get("/buildings/{slug}/matterpak/matterport-availability")
def matterpak_matterport_availability(slug: str, db: Session = Depends(get_db)):
    """Check whether this building's Matterport model has an unlocked MatterPak mesh
    available via the authenticated Model API (no download, no DB write)."""
    b = B(db, slug)
    if not b.matterport_model_id:
        raise HTTPException(400, "set a Matterport model id first (step 1)")
    s = get_settings()
    if not s.matterport_token_id or not s.matterport_token_secret:
        raise HTTPException(400, "MATTERPORT_TOKEN_ID / MATTERPORT_TOKEN_SECRET not configured on the server")
    from ..services import matterport_fetch as mpf
    try:
        data = mpf.fetch_model_mesh_assets(b.matterport_model_id)
    except Exception as e:
        raise HTTPException(502, f"Matterport API error: {e}")
    meshes = data.get("meshes") or []
    available = [m for m in meshes if (m.get("format") or "").lower() == "obj" and m.get("status") == "available"]
    return {"model_id": b.matterport_model_id, "available": bool(available),
            "resolutions": [m.get("resolution") for m in available],
            "meshes": [{"format": m.get("format"), "resolution": m.get("resolution"), "status": m.get("status")} for m in meshes]}


@router.post("/buildings/{slug}/matterpak/fetch-from-matterport")
def fetch_matterpak_from_matterport(slug: str, db: Session = Depends(get_db)):
    """Fetch a bare, untextured OBJ mesh straight from Matterport's authenticated Model API
    instead of a manual upload/server-path. Requires the MatterPak add-on to be unlocked
    (purchased) for this model — Matterport gates mesh export behind that regardless of
    API credentials; this never calls the paid unlock mutation. Unlike a manually exported
    MatterPak zip, assets.meshes carries no .mtl/textures/colorplan_*.jpg — the pipeline
    still runs (ingest.py only warns on those), but auto-georeference and texture overlays
    are unavailable; georeference via control points instead."""
    b = B(db, slug)
    if not b.matterport_model_id:
        raise HTTPException(400, "set a Matterport model id first (step 1)")
    s = get_settings()
    if not s.matterport_token_id or not s.matterport_token_secret:
        raise HTTPException(400, "MATTERPORT_TOKEN_ID / MATTERPORT_TOKEN_SECRET not configured on the server")
    from ..services import matterport_fetch as mpf
    try:
        data = mpf.fetch_model_mesh_assets(b.matterport_model_id)
    except Exception as e:
        raise HTTPException(502, f"Matterport API error: {e}")
    meshes = [m for m in (data.get("meshes") or [])
              if (m.get("format") or "").lower() == "obj" and m.get("status") == "available" and m.get("downloadUrl")]
    if not meshes:
        raise HTTPException(409, "MatterPak add-on is not unlocked for this model (no OBJ mesh available via API) — "
                                  "export it manually from the Matterport dashboard and upload/path it instead")

    def _res_key(m):
        try:
            return int(str(m.get("resolution") or "0").rstrip("kK"))
        except ValueError:
            return 0
    meshes.sort(key=_res_key, reverse=True)
    best = meshes[0]

    # assets.meshes returns a bare, untextured .obj (no .mtl/textures, no colorplan_*.jpg) —
    # not the full manual-export MatterPak zip. Stage it as a one-file "matterpak folder";
    # ingest.py accepts a dir with *.obj and only warns (not errors) on missing textures/colorplans.
    dest_dir = s.uploads_dir / b.slug / f"matterport_api_{best.get('resolution') or 'na'}"
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    fn = dest_dir / (best.get("filename") or f"model_{best.get('resolution') or 'na'}.obj")
    try:
        size = mpf.download_to(best["downloadUrl"], fn, max_bytes=s.max_upload_mb << 20)
    except Exception as e:
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise HTTPException(502, f"download failed: {e}")
    if size < 1024:
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise HTTPException(502, "downloaded file is empty/truncated")

    info = _inspect_matterpak_path(str(dest_dir))
    info["textured"] = False
    b.matterpak_path = info["path"]
    db.commit()
    return {**info, "resolution": best.get("resolution"), "source": "matterport-api"}


@router.get("/matterpak/suggestions")
def matterpak_suggestions():
    """List known large MatterPak/E57 paths under /workspace/wayfinding/matterpak for the wizard."""
    root = Path("/workspace/wayfinding/matterpak")
    out = []
    if not root.is_dir():
        return {"paths": out}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        n = p.name.lower()
        if not (n.endswith(".e57") or n.endswith(".zip") or n.endswith(".obj")):
            continue
        # skip tiny junk
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        if sz < 1024 * 1024 and n.endswith(".obj"):
            continue
        out.append({"path": str(p), "name": p.name, "bytes": sz,
                    "label": f"{p.relative_to(root)} ({sz / 1e9:.2f} GB)" if sz >= 1e9 else f"{p.relative_to(root)} ({sz / 1e6:.0f} MB)"})
    # prefer largest first
    out.sort(key=lambda x: -x["bytes"])
    return {"paths": out[:40]}



@router.get("/geocode")
def geocode(q: str, provider: str | None = None):
    from wfpipe.cli import geocode as gc
    try:
        r = gc(q, provider or get_settings().geocoder)
    except Exception as e:
        raise HTTPException(502, f"geocoder failed: {e.__class__.__name__}")
    if not r: raise HTTPException(404, "address not found")
    return {"lat": r[0], "lon": r[1], "label": r[2]}


@router.get("/matterport/{model_id}")
def mp_info(model_id: str, geocode: bool = True):
    """Fetch Add-building details from Matterport (public GraphQL).

    Returns name, floors, sweeps, rooms, address (when Matterport has one),
    geocoordinates when permitted, and — if geocode=true and lat/lon are still
    missing — an Esri/Nominatim geocode of a street-like model name or address.
    Accepts a bare model id or a Showcase URL containing m=.
    """
    import re
    from wfpipe.steps.fetch_mp import gql
    from wfpipe.cli import geocode as gc

    raw = (model_id or "").strip()
    m_url = re.search(r"[?&]m=([A-Za-z0-9]+)", raw)
    mid = m_url.group(1) if m_url else re.sub(r"[^A-Za-z0-9]", "", raw)
    if not mid or len(mid) < 8:
        raise HTTPException(400, "invalid Matterport model id")

    Q = """query($id:ID!){model(id:$id){
      id name created
      address{address administrativeArea countryCode countryName locality postalCode status lines
        geolocation{lat long}}
      geolocation{lat long}
      geocoordinates{latitude longitude altitude source}
      floors{id label sequence}
      locations{id}
      rooms{id}
    }}"""
    try:
        d = gql(Q, {"id": mid}, timeout=45)
    except Exception as e:
        raise HTTPException(502, f"Matterport unreachable: {e.__class__.__name__}")
    m = (d.get("data") or {}).get("model")
    if not m:
        raise HTTPException(404, "model not found or not public")

    # Prefer Matterport address object; else street-like model name
    addr_obj = m.get("address") or {}
    parts = []
    if addr_obj.get("address"):
        parts.append(addr_obj["address"])
    elif addr_obj.get("lines"):
        parts.extend([x for x in addr_obj["lines"] if x])
    loc_bits = [addr_obj.get("locality"), addr_obj.get("administrativeArea"), addr_obj.get("postalCode"), addr_obj.get("countryName")]
    parts.extend([x for x in loc_bits if x])
    address = ", ".join(parts) if parts else None

    name = (m.get("name") or "").strip()
    streetish = bool(re.match(r"^\d+\s+\S+", name))  # e.g. "2400 Greenland Ave"

    lat = lon = None
    geo_source = None
    g = m.get("geocoordinates") or {}
    if g.get("latitude") is not None and g.get("longitude") is not None:
        lat, lon = float(g["latitude"]), float(g["longitude"]); geo_source = "matterport_geocoordinates"
    if lat is None:
        gl = m.get("geolocation") or {}
        if gl.get("lat") not in (None, "") and gl.get("long") not in (None, ""):
            try:
                lat, lon = float(gl["lat"]), float(gl["long"]); geo_source = "matterport_geolocation"
            except (TypeError, ValueError):
                pass
    if lat is None:
        ag = (addr_obj.get("geolocation") or {})
        if ag.get("lat") not in (None, "") and ag.get("long") not in (None, ""):
            try:
                lat, lon = float(ag["lat"]), float(ag["long"]); geo_source = "matterport_address"
            except (TypeError, ValueError):
                pass

    suggested_address = address or (name if streetish else None)
    geocode_label = None
    if geocode and lat is None and suggested_address:
        try:
            r = gc(suggested_address, get_settings().geocoder)
            if r:
                lat, lon, geocode_label = float(r[0]), float(r[1]), r[2]
                geo_source = "geocoded_from_matterport_name"
                if not address:
                    address = geocode_label or suggested_address
        except Exception:
            pass

    floors = m.get("floors") or []
    return {
        "model_id": mid,
        "name": name,
        "created": m.get("created"),
        "floors": floors,
        "floor_count": len(floors),
        "sweeps": len(m.get("locations") or []),
        "rooms": len(m.get("rooms") or []),
        "address": address,
        "suggested_address": suggested_address,
        "geocoordinates": {"latitude": lat, "longitude": lon} if lat is not None else None,
        "lat": lat,
        "lon": lon,
        "geo_source": geo_source,
        "geocode_label": geocode_label,
        "showcase_url": f"https://my.matterport.com/show/?m={mid}",
    }


@router.get("/buildings/{slug}/showcase")
def showcase(slug: str, sweep: str | None = None, sdk: int = 0, db: Session = Depends(get_db)):
    """Showcase iframe URL for admin preview.

    By default omits applicationKey so the twin loads on ephemeral hosts
    (trycloudflare) without a Matterport domain whitelist. Pass sdk=1 to
    append the key when this exact host is whitelisted for SDK features.
    """
    b = B(db, slug); s = get_settings()
    url = f"https://my.matterport.com/show/?m={b.matterport_model_id}&play=1&qs=1&brand=0"
    if sweep:
        nav = workspace.latest_nav(db, b) or {"nodes": []}
        n = next((n for n in nav["nodes"] if n["id"] == sweep), None)
        if n and n.get("kind") == "sweep": url += f"&ss={n['label'].lstrip('S')}"
    used_sdk = False
    application_key = None
    if sdk and s.matterport_sdk_key:
        url += f"&applicationKey={s.matterport_sdk_key}"
        used_sdk = True
        application_key = s.matterport_sdk_key
    out = {"url": url, "sdk": used_sdk, "sdk_key_configured": bool(s.matterport_sdk_key)}
    if application_key:
        out["application_key"] = application_key
    return out


# ---------------- jobs ----------------
@router.post("/buildings/{slug}/jobs")
def start_job(slug: str, j: schemas.JobIn, db: Session = Depends(get_db), u: models.User = Depends(current_admin)):
    b = B(db, slug)
    if not b.matterpak_path or not b.matterport_model_id: raise HTTPException(400, "set Matterport model id and upload a MatterPak first")
    if j.steps and any(s not in PIPE_STEPS for s in j.steps): raise HTTPException(400, f"unknown step; valid: {PIPE_STEPS}")
    if db.query(models.Job).filter(models.Job.building_id == b.id, models.Job.status.in_(["queued", "running"])).first():
        raise HTTPException(409, "a job is already queued/running for this building")
    row = models.Job(building_id=b.id, kind="onboard" if not j.steps and not j.from_step else "rebuild", params=j.model_dump(), created_by=u.email)
    db.add(row); b.status = "queued"; db.commit(); return {"id": row.id, "status": row.status}


@router.get("/jobs")
def list_jobs(building: str | None = None, limit: int = 50, db: Session = Depends(get_db)):
    q = db.query(models.Job)
    if building: q = q.filter_by(building_id=B(db, building).id)
    return [{"id": j.id, "building_id": j.building_id, "kind": j.kind, "status": j.status, "step": j.step, "params": j.params, "created_at": j.created_at,
             "started_at": j.started_at, "finished_at": j.finished_at, "error": j.error} for j in q.order_by(models.Job.id.desc()).limit(limit)]


@router.get("/jobs/{jid}")
def get_job(jid: int, offset: int = 0, db: Session = Depends(get_db)):
    j = db.get(models.Job, jid)
    if not j: raise HTTPException(404)
    return {"id": j.id, "status": j.status, "step": j.step, "steps": j.steps, "error": j.error, "log": (j.log or "")[offset:], "log_len": len(j.log or ""),
            "created_at": j.created_at, "started_at": j.started_at, "finished_at": j.finished_at}


@router.post("/jobs/{jid}/cancel")
def cancel_job(jid: int, db: Session = Depends(get_db)):
    j = db.get(models.Job, jid)
    if j and j.status == "queued": j.status = "cancelled"; db.commit()
    return {"status": j.status if j else None}


# ---------------- floors ----------------
@router.put("/buildings/{slug}/floors")
def put_floors(slug: str, floors: list[schemas.FloorIn], db: Session = Depends(get_db)):
    b = B(db, slug); have = {f.fid: f for f in b.floors}
    for f in floors:
        row = have.get(f.fid)
        if not row: row = models.Floor(building_id=b.id, fid=f.fid); db.add(row)
        for k, v in f.model_dump().items(): setattr(row, k, v)
    b.pipeline_config = {**(b.pipeline_config or {}), "floors_locked": True}
    db.commit(); db.refresh(b)
    return bjson(db, b)["floors"]


# ---------------- POIs ----------------
def pjson(p: models.POI):
    pt = to_shape(p.geom) if p.geom is not None else None
    return {"id": p.id, "key": p.key, "name": p.name, "code": p.code, "category": p.category, "floor": p.floor, "lon": pt.x if pt else None, "lat": pt.y if pt else None,
            "model": [p.model_x, p.model_y, p.model_z], "nearest_node": p.nearest_node, "nearest_sweep_label": p.nearest_sweep_label, "room_id": p.room_id,
            "step_free": p.step_free, "step_free_auto": p.step_free_auto, "hours": p.hours, "description": p.description, "photo_url": p.photo_url,
            "published": p.published, "source": p.source, "locked": p.locked, "extra": p.extra}


def _locate(db, b, p: models.POI, lon, lat, snap_node=True):
    if not b.georef: raise HTTPException(400, "building has no georeference yet")
    T = navgraph.GeoT(b.georef); x, y = T.model(lon, lat)
    p.geom = WKTElement(f"POINT({lon} {lat})", srid=4326); p.model_x, p.model_y = round(x, 3), round(y, 3)
    nav = workspace.latest_nav(db, b)
    if nav and snap_node:
        n, d = navgraph.nearest_node(nav, x, y, p.floor); p.nearest_node = n["id"]; p.nearest_sweep_label = n.get("label"); p.model_z = n["z"]
        p.extra = {**(p.extra or {}), "node_distance_m": round(d, 2)}


@router.get("/buildings/{slug}/pois")
def list_pois(slug: str, floor: str | None = None, db: Session = Depends(get_db)):
    q = db.query(models.POI).filter_by(building_id=B(db, slug).id)
    if floor: q = q.filter_by(floor=floor)
    return [pjson(p) for p in q.order_by(models.POI.floor, models.POI.name)]


@router.get("/categories")
def categories():
    return CATEGORIES


@router.post("/buildings/{slug}/pois")
def create_poi(slug: str, inp: schemas.POIIn, db: Session = Depends(get_db)):
    b = B(db, slug); d = inp.model_dump()
    key = d.pop("key") or "poi_" + re.sub(r"[^a-z0-9]+", "_", d["name"].lower()).strip("_")[:40]
    base, i = key, 2
    while db.query(models.POI).filter_by(building_id=b.id, key=key).first(): key = f"{base}_{i}"; i += 1
    lon, lat = d.pop("lon"), d.pop("lat")
    p = models.POI(building_id=b.id, key=key, source="admin", locked=True, **{k: v for k, v in d.items() if k not in ("model_x", "model_y", "model_z")})
    if lon is None and d.get("model_x") is not None:
        lon, lat = navgraph.GeoT(b.georef).ll(d["model_x"], d["model_y"])
    if lon is None: raise HTTPException(400, "lon/lat or model_x/model_y required")
    _locate(db, b, p, lon, lat, snap_node=not d.get("nearest_node"))
    db.add(p); db.commit(); workspace.recompute_step_free(db, b); return pjson(p)


@router.patch("/buildings/{slug}/pois/{pid}")
def patch_poi(slug: str, pid: int, inp: schemas.POIPatch, db: Session = Depends(get_db)):
    b = B(db, slug); p = db.get(models.POI, pid)
    if not p or p.building_id != b.id: raise HTTPException(404)
    d = inp.model_dump(exclude_unset=True); lon, lat = d.pop("lon", None), d.pop("lat", None)
    if d.pop("clear_step_free", False): p.step_free = None
    for k, v in d.items(): setattr(p, k, v)
    if lon is not None and lat is not None: _locate(db, b, p, lon, lat, snap_node="nearest_node" not in d)
    elif "floor" in d and p.geom is not None:
        pt = to_shape(p.geom); _locate(db, b, p, pt.x, pt.y)
    p.locked = True; db.commit()
    if lon is not None or "floor" in d: workspace.recompute_step_free(db, b)
    return pjson(p)


@router.post("/buildings/{slug}/pois/{pid}/snap")
def snap_poi(slug: str, pid: int, db: Session = Depends(get_db)):
    """Move the POI onto its nearest sweep (exact routing anchor)."""
    b = B(db, slug); p = db.get(models.POI, pid)
    if not p or p.building_id != b.id: raise HTTPException(404)
    nav = workspace.latest_nav(db, b); pt = to_shape(p.geom); T = navgraph.GeoT(b.georef)
    n, _ = navgraph.nearest_node(nav, *T.model(pt.x, pt.y), p.floor)
    p.geom = WKTElement(f"POINT({n['lonlat'][0]} {n['lonlat'][1]})", srid=4326); p.model_x, p.model_y, p.model_z = n["x"], n["y"], n["z"]
    p.nearest_node = n["id"]; p.nearest_sweep_label = n.get("label"); p.locked = True; db.commit(); return pjson(p)


@router.delete("/buildings/{slug}/pois/{pid}")
def delete_poi(slug: str, pid: int, db: Session = Depends(get_db)):
    b = B(db, slug); p = db.get(models.POI, pid)
    if not p or p.building_id != b.id: raise HTTPException(404)
    db.delete(p); db.commit(); return {"deleted": pid}


CSV_FIELDS = ["key", "name", "category", "floor", "lon", "lat", "code", "step_free", "hours", "description", "photo_url", "published", "nearest_node"]


@router.get("/buildings/{slug}/pois.csv", response_class=PlainTextResponse)
def export_csv(slug: str, db: Session = Depends(get_db)):
    b = B(db, slug); s = io.StringIO(); w = csv.DictWriter(s, CSV_FIELDS); w.writeheader()
    for p in db.query(models.POI).filter_by(building_id=b.id).order_by(models.POI.floor, models.POI.name):
        j = pjson(p); w.writerow({k: ("" if j.get(k) is None else j.get(k)) for k in CSV_FIELDS})
    return PlainTextResponse(s.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{slug}_pois.csv"'})


@router.post("/buildings/{slug}/pois/import")
async def import_csv(slug: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Bulk upsert by `key` (new keys are created). Columns: see GET pois.csv."""
    b = B(db, slug); txt = (await file.read()).decode("utf-8-sig")
    created = updated = 0; errors = []
    for i, r in enumerate(csv.DictReader(io.StringIO(txt)), start=2):
        try:
            key = (r.get("key") or "").strip() or None
            p = db.query(models.POI).filter_by(building_id=b.id, key=key).first() if key else None
            if p is None:
                p = models.POI(building_id=b.id, key=key or f"poi_csv_{i}", source="csv", name=r["name"], floor=r["floor"], category=r.get("category") or "room"); db.add(p); created += 1
            else:
                updated += 1
            for k in ("name", "category", "floor", "code", "hours", "description", "photo_url", "nearest_node"):
                if r.get(k) not in (None, ""): setattr(p, k, r[k])
            if r.get("step_free") not in (None, ""): p.step_free = r["step_free"].strip().lower() in ("1", "true", "yes", "y")
            if r.get("published") not in (None, ""): p.published = r["published"].strip().lower() in ("1", "true", "yes", "y")
            if r.get("lon") and r.get("lat"): _locate(db, b, p, float(r["lon"]), float(r["lat"]), snap_node=not r.get("nearest_node"))
            elif p.geom is None: raise ValueError("lon/lat required for new POIs")
            p.locked = True
        except Exception as e:
            errors.append(f"line {i}: {e}"); db.rollback()
    db.commit(); workspace.recompute_step_free(db, b)
    return {"created": created, "updated": updated, "errors": errors}


@router.post("/buildings/{slug}/pois/sync-supabase")
def sync_pois_from_supabase(slug: str, db: Session = Depends(get_db)):
    """Pull POIs from Supabase navme_gmap_pois (synced from navme_pois) and upsert into wayfinding."""
    import urllib.request, urllib.error
    cfg = get_settings()
    if not cfg.supabase_url or not cfg.supabase_anon_key:
        raise HTTPException(400, "SUPABASE_URL / SUPABASE_ANON_KEY not configured")
    b = B(db, slug)
    if not b.georef:
        raise HTTPException(400, "Building has no georef — set georef before syncing POIs")
    T = navgraph.GeoT(b.georef)
    url = f"{cfg.supabase_url}/rest/v1/rpc/gmap_list_pois"
    body = json.dumps({"p_slug": slug}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "apikey": cfg.supabase_anon_key,
        "Authorization": f"Bearer {cfg.supabase_anon_key}",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            rows = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Supabase error {e.code}: {e.read().decode()}")
    if not rows:
        return {"synced": 0, "skipped": 0, "errors": []}
    created = updated = skipped = 0; errors = []
    for row in rows:
        try:
            src_id = row.get("src_id") or ""
            key = f"sb_{src_id[:32]}" if src_id else None
            name = (row.get("label") or "").strip()
            if not name: skipped += 1; continue
            x, y, z = float(row.get("x") or 0), float(row.get("y") or 0), float(row.get("z") or 0)
            lon, lat = T.ll(x, y)
            floor = str(row.get("floor_id") or "F1")
            category = str(row.get("category") or "General")
            if key:
                existing = db.query(models.POI).filter_by(building_id=b.id, key=key).first()
            else:
                existing = None
            if existing:
                existing.name = name; existing.floor = floor; existing.category = category
                existing.model_x, existing.model_y, existing.model_z = x, y, z
                existing.geom = WKTElement(f"POINT({lon} {lat})", srid=4326)
                existing.locked = False; updated += 1
            else:
                if not key:
                    key = "sb_" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:36]
                p = models.POI(building_id=b.id, key=key, name=name, floor=floor,
                               category=category, model_x=x, model_y=y, model_z=z,
                               geom=WKTElement(f"POINT({lon} {lat})", srid=4326),
                               source="supabase", locked=False)
                db.add(p); created += 1
        except Exception as e:
            errors.append(f"{row.get('label','?')}: {e}"); db.rollback()
    db.commit()
    workspace.recompute_step_free(db, b)
    return {"synced": created + updated, "created": created, "updated": updated, "skipped": skipped, "errors": errors}


@router.post("/buildings/{slug}/navme-gmap/sync")
def sync_navme_gmap(slug: str, db: Session = Depends(get_db)):
    """Pull this building's NavMe Dashboard POI list (Supabase gmap_list_pois RPC, same
    source as the pre-existing /pois/sync-supabase) and its active navmesh (Supabase
    navme_media, media_type='navmesh') in — no new tables: POIs upsert into the existing
    `pois` table (source="supabase", same as sync-supabase already does; dashboard-only
    fields like expected_pos_* and the Supabase row id live in POI.extra, which already
    exists), and the navmesh file is downloaded to local disk with its pointer kept in
    Building.pipeline_config["navme_navmesh"] (also an existing JSONB column — no schema
    change). Run this once (or whenever the dashboard changes POIs/navmesh); after that,
    /dashboard/buildings/{slug}/navme-pois and /navmesh-url serve straight from Postgres /
    local disk and never call Supabase again at request time."""
    import urllib.request, urllib.error, urllib.parse
    cfg = get_settings()
    if not cfg.supabase_url or not cfg.supabase_anon_key:
        raise HTTPException(400, "SUPABASE_URL / SUPABASE_ANON_KEY not configured")
    b = B(db, slug)
    if not b.georef:
        raise HTTPException(400, "Building has no georef — set georef before syncing POIs")
    T = navgraph.GeoT(b.georef)
    headers = {"apikey": cfg.supabase_anon_key, "Authorization": f"Bearer {cfg.supabase_anon_key}"}

    def _get(url):
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())

    # ---- POIs: gmap_list_pois RPC + expected_pos_* straight off navme_pois ----
    rpc_url = f"{cfg.supabase_url}/rest/v1/rpc/gmap_list_pois"
    req = urllib.request.Request(rpc_url, data=json.dumps({"p_slug": slug}).encode(), method="POST",
                                  headers={**headers, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            rows = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Supabase RPC error {e.code}: {e.read().decode()}")
    except Exception as e:
        raise HTTPException(502, f"Supabase unreachable: {e}")

    staged, seen = [], set()
    for r in (rows or []):
        meta = r.get("metadata") or {}
        src_id = str(r.get("src_id") or meta.get("src_id") or r.get("id") or "")
        label = str(r.get("label") or r.get("name") or "")
        if not label or not src_id or src_id in seen:
            continue
        seen.add(src_id); staged.append((src_id, r, meta))

    expected_by_id = {}
    if staged:
        id_list = ",".join(urllib.parse.quote(sid, safe="") for sid, _, _ in staged)
        try:
            exp_rows = _get(f"{cfg.supabase_url}/rest/v1/navme_pois?id=in.({id_list})"
                             f"&select=id,expected_pos_x,expected_pos_y,expected_pos_z")
            expected_by_id = {str(r.get("id")): r for r in exp_rows if r.get("id")}
        except Exception:
            pass

    # key is the full src_id (not truncated) so two POIs never collide on a shared prefix.
    poi_created = poi_updated = 0
    for src_id, r, meta in staged:
        exp = expected_by_id.get(src_id) or {}
        key = "gmap_" + re.sub(r"[^a-z0-9]+", "_", src_id.lower())[:70]
        name = str(r.get("label") or r.get("name") or "")
        x, y, z = r.get("x") or 0, r.get("y") or 0, r.get("z") or 0
        lon, lat = T.ll(float(x), float(y))
        existing = db.query(models.POI).filter_by(building_id=b.id, key=key).first()
        if not existing:
            existing = models.POI(building_id=b.id, key=key, source="supabase", locked=False)
            db.add(existing); poi_created += 1
        else:
            poi_updated += 1
        existing.name = name
        existing.category = str(r.get("category") or "room")
        existing.floor = str(r.get("floor_id") or "F1")
        existing.model_x, existing.model_y, existing.model_z = x, y, z
        existing.geom = WKTElement(f"POINT({lon} {lat})", srid=4326)
        existing.extra = {**(existing.extra or {}), "gmap_poi_type": slug, "gmap_src_id": src_id,
                           "gmap_metadata": meta, "expected_pos_x": exp.get("expected_pos_x"),
                           "expected_pos_y": exp.get("expected_pos_y"), "expected_pos_z": exp.get("expected_pos_z")}

    # ---- Navmesh media: find the active row, download the file onto local disk ----
    base = slug.split("-")[0]
    seen_c, candidates = set(), []
    for c in (slug, slug.upper(), base, base.upper()):
        if c not in seen_c:
            seen_c.add(c); candidates.append(c)
    media_row = None
    for cand in candidates:
        q = urllib.parse.urlencode({"select": "poi_type,label,media_url,updated_at", "media_type": "eq.navmesh",
                                     "is_active": "is.true", "poi_type": f"eq.{cand}", "order": "updated_at.desc", "limit": "1"})
        try:
            found = _get(f"{cfg.supabase_url}/rest/v1/navme_media?{q}")
        except Exception:
            found = []
        if found:
            media_row = found[0]; break
    if not media_row:
        q = urllib.parse.urlencode({"select": "poi_type,label,media_url,updated_at", "media_type": "eq.navmesh",
                                     "is_active": "is.true", "poi_type": f"ilike.{base.upper()}*", "order": "updated_at.desc", "limit": "1"})
        try:
            found = _get(f"{cfg.supabase_url}/rest/v1/navme_media?{q}")
        except Exception:
            found = []
        if found:
            media_row = found[0]

    media_synced = False
    if media_row and media_row.get("media_url"):
        try:
            data = urllib.request.urlopen(media_row["media_url"], timeout=60).read()
            local_path = Path(cfg.viewer_dir) / f"{slug}_navmesh.navmesh"
            local_path.write_bytes(data)
            b.pipeline_config = {**(b.pipeline_config or {}), "navme_navmesh": {
                "label": media_row.get("label"), "url": f"/{slug}_navmesh.navmesh",
                "updated_at": media_row.get("updated_at")}}
            media_synced = True
        except Exception as e:
            raise HTTPException(502, f"navmesh download failed: {e}")

    # ---- Categories: navme_categories (dashboard-curated POI category chips) ----
    categories = []
    try:
        q = urllib.parse.urlencode({"select": "id,name,icon_key,sort_order", "poi_type": f"ilike.{slug}",
                                     "order": "sort_order.asc,name.asc"})
        rows = _get(f"{cfg.supabase_url}/rest/v1/navme_categories?{q}")
        categories = [{"id": r.get("id"), "name": r.get("name"), "icon_key": r.get("icon_key"),
                       "sort_order": r.get("sort_order")} for r in (rows or [])]
    except Exception:
        pass  # best-effort; categories are optional chrome, never block the rest of the sync
    b.pipeline_config = {**(b.pipeline_config or {}), "navme_categories": categories}

    db.commit()
    workspace.recompute_step_free(db, b)
    return {"pois_created": poi_created, "pois_updated": poi_updated, "pois_total": len(staged),
            "navmesh_synced": media_synced, "categories_synced": len(categories)}


# ---------------- georef ----------------
@router.get("/buildings/{slug}/georef")
def get_georef(slug: str, db: Session = Depends(get_db)):
    b = B(db, slug); cps = db.query(models.ControlPoint).filter_by(building_id=b.id).order_by(models.ControlPoint.id).all()
    ov = None; f = workspace.ws_dir(b) / "out" / "floors.json"
    if f.exists(): ov = [{k: o[k] for k in ("id", "image", "corners_model", "corners_lonlat")} for o in json.loads(f.read_text())["floors"]]
    return {"georef": b.georef, "overlays": ov, "control_points": [{"id": c.id, "model_x": c.model_x, "model_y": c.model_y, "lat": c.lat, "lon": c.lon, "label": c.label,
            "enabled": c.enabled, "residual_m": c.residual_m, "source": c.source} for c in cps]}


@router.post("/buildings/{slug}/control_points")
def add_cp(slug: str, c: schemas.ControlPointIn, db: Session = Depends(get_db)):
    b = B(db, slug); row = models.ControlPoint(building_id=b.id, **c.model_dump()); db.add(row); db.commit(); return {"id": row.id}


@router.delete("/buildings/{slug}/control_points/{cid}")
def del_cp(slug: str, cid: int, db: Session = Depends(get_db)):
    b = B(db, slug); row = db.get(models.ControlPoint, cid)
    if row and row.building_id == b.id: db.delete(row); db.commit()
    return {"deleted": cid}


@router.post("/buildings/{slug}/georef/fit")
def fit_cps(slug: str, apply: bool = False, db: Session = Depends(get_db)):
    """Fit a unit-scale similarity to enabled control points; returns residuals. apply=true stores it (mode=fixed)."""
    from wfpipe.geo import georef_from_control_points
    b = B(db, slug); cps = db.query(models.ControlPoint).filter_by(building_id=b.id, enabled=True).all()
    if len(cps) < 2: raise HTTPException(400, "need at least 2 enabled control points")
    A, e, info = georef_from_control_points([{"model_xy": [c.model_x, c.model_y], "wgs84": [c.lat, c.lon]} for c in cps])
    for c, err in zip(cps, e): c.residual_m = round(float(err), 3)
    if apply:
        b.pipeline_config = {**(b.pipeline_config or {}), "georef": {**((b.pipeline_config or {}).get("georef") or {}), "mode": "fixed", "affine": A}}
        b.georef = {**(b.georef or {}), "model_to_epsg3857_affine": A, "mode": "fixed", "rotation_deg": info["rotation_deg"], "rms_m": info["rms_m"]}
    db.commit()
    return {"affine": A, "rms_m": info["rms_m"], "max_err_m": info["max_err_m"], "rotation_deg": info["rotation_deg"], "residuals": [{"id": c.id, "residual_m": c.residual_m} for c in cps], "applied": apply}


@router.post("/buildings/{slug}/georef/finetune")
def finetune(slug: str, t: schemas.GeorefFineTune, db: Session = Depends(get_db), u: models.User = Depends(current_admin)):
    """Nudge the transform (metres / degrees) about the model centre; stored as mode=fixed.
    Pass auto_rebuild=true to immediately queue downstream pipeline steps so routes update."""
    import numpy as np
    b = B(db, slug)
    if not b.georef: raise HTTPException(400, "no georef yet")
    A = np.array(b.georef["model_to_epsg3857_affine"], float)
    c = (b.model_info or {}).get("center"); T = navgraph.GeoT(b.georef)
    cx, cy = T.model(c["lon"], c["lat"]) if c else (0.0, 0.0)
    k = 1 / math.cos(math.radians(c["lat"] if c else 0))
    th = math.radians(t.d_rot_deg); Rm = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    P = A[:, :2] @ np.array([cx, cy]) + A[:, 2]
    L = Rm @ A[:, :2]; tr = P - L @ np.array([cx, cy]) + np.array([t.d_east_m, t.d_north_m]) * k
    A2 = np.c_[L, tr].tolist()
    from wfpipe.geo import unmerc
    olon, olat = unmerc(*tr)
    b.pipeline_config = {**(b.pipeline_config or {}), "georef": {**((b.pipeline_config or {}).get("georef") or {}), "mode": "fixed", "affine": A2}}
    b.georef = {**b.georef, "model_to_epsg3857_affine": A2, "mode": "fixed",
                "rotation_deg": math.degrees(math.atan2(A2[1][0], A2[0][0])),
                "model_origin_wgs84": {"lat": olat, "lon": olon}}
    db.commit()

    job_id = None
    if getattr(t, "auto_rebuild", False):
        # Queue only the downstream steps that depend on georef; skip expensive mesh/imagery steps.
        rebuild_steps = ["georef", "overlays", "osm", "graph", "navmesh", "pois", "indoor", "thumbs", "export"]
        no_job_running = not db.query(models.Job).filter(
            models.Job.building_id == b.id,
            models.Job.status.in_(["queued", "running"])
        ).first()
        if no_job_running:
            job = models.Job(
                building_id=b.id, kind="rebuild",
                params={"steps": rebuild_steps},
                created_by=u.email,
            )
            db.add(job); b.status = "queued"; db.commit()
            job_id = job.id

    return {
        "affine": A2,
        "rotation_deg": b.georef["rotation_deg"],
        "model_origin_wgs84": b.georef["model_origin_wgs84"],
        "job_id": job_id,
    }


@router.post("/buildings/{slug}/georef/mode")
def georef_mode(slug: str, body: dict, db: Session = Depends(get_db)):
    b = B(db, slug); mode = body.get("mode")
    if mode not in ("auto", "control_points", "fixed"): raise HTTPException(400, "mode must be auto|control_points|fixed")
    g = {**((b.pipeline_config or {}).get("georef") or {}), "mode": mode}
    b.pipeline_config = {**(b.pipeline_config or {}), "georef": g}; db.commit(); return {"mode": mode}


# Draft files are also loaded by <img>/MapLibre image sources, which cannot send an Authorization header,
# so this route lives on its own router and accepts the JWT as ?token= as well.

# ---------------- debug mode + dashboard logs ----------------
from ..services import debug_log as dbg
from fastapi.responses import Response


@router.get("/debug/settings")
def get_debug_settings(db: Session = Depends(get_db)):
    s = dbg.read_platform_settings()
    buildings = []
    for b in db.query(models.Building).order_by(models.Building.name):
        ov = dbg.building_override(b.pipeline_config)
        buildings.append({
            "slug": b.slug, "name": b.name,
            "override": ov,
            "effective": dbg.effective_enabled(pipeline_config=b.pipeline_config),
        })
    return {
        "debug": s.get("debug") or {"enabled": False},
        "buildings": buildings,
        "log_buffered": dbg.query_logs(limit=1)["total_buffered"],
    }


@router.patch("/debug/settings")
def patch_debug_settings(body: dict = Body(...), db: Session = Depends(get_db)):
    """Update global debug and/or a building override.
    Body: { "enabled": bool } and/or { "building": "<slug>", "override": true|false|null }
    """
    out = {}
    if "enabled" in body:
        s = dbg.write_platform_settings({"debug": {"enabled": bool(body.get("enabled"))}})
        out["debug"] = s["debug"]
        dbg.log_server("info", "admin.debug", f"global debug → {bool(body.get('enabled'))}")
    if "building" in body:
        slug = str(body.get("building") or "").strip()
        if not slug:
            raise HTTPException(400, "building slug required")
        b = B(db, slug)
        ov = body.get("override", None)
        if ov is not None and ov is not True and ov is not False:
            # allow string "inherit"/null
            if str(ov).lower() in ("null", "none", "inherit", ""):
                ov = None
            else:
                ov = bool(ov)
        pc = dbg.set_building_override(b.pipeline_config, ov)
        b.pipeline_config = pc
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(b, "pipeline_config")
        db.commit()
        out["building"] = {
            "slug": b.slug,
            "override": dbg.building_override(b.pipeline_config),
            "effective": dbg.effective_enabled(pipeline_config=b.pipeline_config),
        }
        dbg.log_server("info", "admin.debug", f"building {slug} override → {ov}", building=slug)
    if not out:
        out = dbg.read_platform_settings()
    return out


@router.get("/debug/logs")
def get_debug_logs(after_id: int = 0, limit: int = 200, level: str | None = None,
                   building: str | None = None, source: str | None = None):
    return dbg.query_logs(after_id=after_id, limit=limit, level=level, building=building, source=source)


@router.delete("/debug/logs")
def clear_debug_logs():
    dbg.log_server("info", "admin.debug", "logs cleared")
    return dbg.clear_logs()


@router.get("/debug/logs/export")
def export_debug_logs(level: str | None = None, building: str | None = None):
    text = dbg.export_text(level=level, building=building)
    return Response(text, media_type="text/plain; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=wayfinding-debug-logs.txt"})




# ---- Platform runtime Config (Option 2: LLM + safe runtime overlay) ----
from ..services import runtime_config as rtcfg
from ..config import reload_settings


@router.get("/platform/config")
def get_platform_config():
    """JWT admin: non-secret values + secret configured yes/no + status. Never returns secret values."""
    s = reload_settings()
    return rtcfg.public_safe_view(s)


@router.patch("/platform/config")
def patch_platform_config(body: dict = Body(...)):
    """Update non-secret runtime overlay and/or write-only secrets.
    Body: { values?: {...}, clear_values?: [attr...], secrets?: {ENV_KEY: value|null}, clear_secrets?: [ENV_KEY...] }
    Secret values are never echoed back.
    """
    body = body or {}
    warnings: list[str] = []
    restart_hints: list[str] = []
    values_in = body.get("values") if isinstance(body.get("values"), dict) else {}
    # Also accept flat non-secret keys at top level for convenience
    flat = {k: body[k] for k in rtcfg.NON_SECRET_KEYS if k in body}
    if flat:
        values_in = {**values_in, **flat}
    clear_values = body.get("clear_values") or body.get("clear") or []
    if not isinstance(clear_values, list):
        clear_values = []
    clear_values = [k for k in clear_values if k in rtcfg.NON_SECRET_KEYS]

    if values_in:
        try:
            clean, w, rh = rtcfg.validate_non_secrets(values_in)
        except ValueError as e:
            raise HTTPException(400, str(e))
        warnings.extend(w)
        restart_hints.extend(rh)
        rtcfg.write_non_secret_overlay(clean, clear_keys=clear_values)
    elif clear_values:
        rtcfg.write_non_secret_overlay({}, clear_keys=clear_values)

    secrets_in = body.get("secrets") if isinstance(body.get("secrets"), dict) else {}
    clear_secrets = body.get("clear_secrets") or []
    if not isinstance(clear_secrets, list):
        clear_secrets = []
    set_map = {}
    clear_list = [k for k in clear_secrets if k in rtcfg.SECRET_ENV_KEYS]
    for k, v in secrets_in.items():
        if k not in rtcfg.SECRET_ENV_KEYS:
            raise HTTPException(400, f"unknown secret key: {k}")
        if v is None or v == "":
            clear_list.append(k)
        else:
            # Never log/store in response
            set_map[k] = str(v)
            if k in ("JWT_SECRET", "DATABASE_URL"):
                restart_hints.append(k)
    if set_map or clear_list:
        rtcfg.write_secret_overlay(set_map=set_map, clear_keys=clear_list)
        # Restart hint for secrets that bind at import
        for k in set_map:
            if k in ("JWT_SECRET", "DATABASE_URL"):
                restart_hints.append(k)

    s = reload_settings()
    out = rtcfg.public_safe_view(s)
    out["warnings"] = warnings
    out["restart_hints"] = sorted(set(restart_hints))
    if out["restart_hints"]:
        out["restart_note"] = (
            "Some settings bind at process start (CORS middleware, DB engine, JWT). "
            "Run: scripts/dev_server.sh restart  (or restart the Render Web service)."
        )
    return out


@router.post("/platform/config/probe-llm")
def probe_platform_llm(body: dict | None = Body(None)):
    """Safe LLM reachability probe (GET /models). Does not call chat completions. Never echoes API key."""
    s = reload_settings()
    body = body or {}
    base = str(body.get("wf_chat_llm_base_url") or body.get("base_url") or s.wf_chat_llm_base_url or "").strip()
    # Use configured key silently; never accept echoing. Optional one-shot key for probe only (not stored).
    key = (s.wf_chat_llm_api_key or "").strip()
    probe_key = body.get("api_key")
    if probe_key is not None and str(probe_key).strip():
        key = str(probe_key).strip()
    result = rtcfg.probe_llm(base, key)
    return {"probe": result, "base_url": base}


# ---- Admin chat (Option 4 phase 1: Studio FAB + Access / ops tools) ----
class AdminChatMessageIn(BaseModel):
    role: str
    content: str


class AdminChatIn(BaseModel):
    messages: list[AdminChatMessageIn] = Field(default_factory=list)
    building: str | None = None
    locale: str | None = None
    tab: str | None = None
    path: str | None = None
    page: str | None = None
    route: str | None = None


@router.post("/chat")
def admin_chat(body: AdminChatIn, request: Request, db: Session = Depends(get_db)):
    """JWT-required NavMe Spatial Assistant. Tools include public-safe + Access / jobs / debug_logs.
    Read-only: no Save/Publish/delete. Same WF_CHAT_LLM_* config as public chat."""
    from ..services import chat as chat_svc
    from ..services import admin_chat as admin_chat_svc
    if not chat_svc.chat_enabled():
        raise HTTPException(404, "chat disabled")
    client = request.client.host if request.client else "unknown"
    forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    chat_svc.check_rate_limit("admin:" + (forwarded or client))
    msgs = [{"role": m.role, "content": m.content} for m in (body.messages or []) if m.content]
    if not msgs:
        raise HTTPException(400, "messages required")
    if sum(len(m["content"]) for m in msgs) > 12000:
        raise HTTPException(400, "messages too long")
    return admin_chat_svc.run_admin_chat(
        db,
        msgs,
        building=body.building,
        locale=body.locale,
        tab=body.tab,
        path=body.path or body.route,
        page=body.page,
        route=body.route or body.path,
    )


files_router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


@files_router.api_route("/buildings/{slug}/files/{path:path}", methods=["GET", "HEAD"])
def ws_file(slug: str, path: str, token: str | None = None, hdr: str | None = Depends(oauth2), db: Session = Depends(get_db)):
    """Draft artefacts from the building workspace (out/…, or work/sat.png, work/georef_preview.jpg)."""
    current_admin(hdr or token, db)
    b = B(db, slug); root = workspace.ws_dir(b).resolve()
    f = (root / path).resolve()
    allowed = [root / "out", root / "work" / "sat.png", root / "work" / "sat.json", root / "work" / "georef_preview.jpg", root / "work" / "colorplan_match.png"]
    ok = f.is_file() and any(f == a or a in f.parents for a in allowed)
    # MatterPak colour plans for Floors tab visual (jpg/png/webp only; no PDF/E57)
    if not ok and f.is_file():
        mp = (root / "work" / "matterpak").resolve()
        try:
            f.relative_to(mp)
            name = f.name.lower()
            if name.startswith("colorplan") and f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
                ok = True
        except ValueError:
            pass
    if not ok:
        raise HTTPException(404)
    return FileResponse(f)


# ---------------- routing / publish ----------------
@router.post("/buildings/{slug}/route")
def route(slug: str, r: schemas.RouteIn, db: Session = Depends(get_db)):
    b = B(db, slug); nav = workspace.latest_nav(db, b)
    if not nav: raise HTTPException(400, "no nav graph")
    get = lambda k: db.query(models.POI).filter_by(building_id=b.id, key=k).first()
    a, z = get(r.from_key), get(r.to_key)
    if not a or not z: raise HTTPException(404, "unknown POI key")
    res = navgraph.route(nav, a.nearest_node, z.nearest_node, r.step_free, georef=b.georef, navmesh=workspace.latest_navmesh(b))
    if not res: raise HTTPException(404, "no route" + (" without steps" if r.step_free else ""))
    return res


@router.post("/buildings/{slug}/route-access-preview")
def route_access_preview(slug: str, r: schemas.RouteAccessPreviewIn, db: Session = Depends(get_db)):
    """Full draft route vs filtered (excluded edges) without re-publish. For Access tab impact preview."""
    from ..services import access as access_svc
    b = B(db, slug)
    nav = workspace.latest_nav(db, b)
    if not nav:
        raise HTTPException(400, "no nav graph")
    get = lambda k: db.query(models.POI).filter_by(building_id=b.id, key=k).first()
    a, z = get(r.from_key), get(r.to_key)
    if not a or not z:
        raise HTTPException(404, "unknown POI key")
    if not a.nearest_node or not z.nearest_node:
        raise HTTPException(400, "POI missing nearest_node (snap POIs first)")
    if r.excluded_edge_ids is not None:
        excl = list(r.excluded_edge_ids)
    else:
        acc = access_svc.parse_access((b.pipeline_config or {}).get("access"))
        excl = list(acc["routing"]["excluded_edge_ids"]) if acc["routing"]["mode"] == "exclude_edges" else []
    out = access_svc.preview_route_impact(
        nav, a.nearest_node, z.nearest_node, excl, step_free=r.step_free, route_fn=navgraph.route
    )
    out["from_key"] = r.from_key
    out["to_key"] = r.to_key
    out["from_node"] = a.nearest_node
    out["to_node"] = z.nearest_node
    out["step_free"] = bool(r.step_free)
    return out


@router.get("/buildings/{slug}/nav")
def nav_geojson(slug: str, db: Session = Depends(get_db)):
    from ..services import access as access_svc
    b = B(db, slug); nav = workspace.latest_nav(db, b) or {"nodes": [], "edges": []}
    N = {n["id"]: n for n in nav["nodes"]}
    feats = []
    for e in nav["edges"]:
        if e["u"] not in N or e["v"] not in N: continue
        eid = access_svc.edge_id_from_edge(e)
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [N[e["u"]]["lonlat"], N[e["v"]]["lonlat"]]},
              "properties": {"edge_id": eid, "u": e["u"], "v": e["v"], "length": e.get("length"),
                             "floor": N[e["u"]]["floor"], "stairs": bool(e.get("stairs")), "step_free": bool(e.get("step_free")),
                             "u_label": N[e["u"]].get("label"), "v_label": N[e["v"]].get("label")}})
    feats += [{"type": "Feature", "geometry": {"type": "Point", "coordinates": n["lonlat"]}, "properties": {"id": n["id"], "kind": n["kind"], "label": n.get("label"), "floor": n["floor"]}} for n in nav["nodes"]]
    return {"type": "FeatureCollection", "features": feats}



# ---------------- media panels (Option 4: Tag → glass_v1 HUD) ----------------
MEDIA_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
}
MEDIA_ALLOW = set(MEDIA_MIME)


def _media_dir(b: models.Building) -> Path:
    d = workspace.ws_dir(b) / "media"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/buildings/{slug}/media")
async def upload_media(slug: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload an image or short video for media_panels. Stored under buildings/<slug>/media/."""
    b = B(db, slug)
    name = re.sub(r"[^A-Za-z0-9._-]", "_", file.filename or "upload.bin")
    ext = Path(name).suffix.lower()
    if ext not in MEDIA_ALLOW:
        raise HTTPException(400, "allowed: jpg/png/webp/gif/mp4/webm/mov")
    dest_dir = _media_dir(b)
    # Keep original stem; uniquify if collision
    stem, suf = Path(name).stem[:80], Path(name).suffix
    fn = dest_dir / name
    n = 1
    while fn.exists():
        fn = dest_dir / f"{stem}_{n}{suf}"
        n += 1
    size = 0
    # Soft cap for media (videos): min(512 MiB, max_upload)
    cap = min(512 << 20, get_settings().max_upload_mb << 20)
    with open(fn, "wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > cap:
                f.close()
                fn.unlink(missing_ok=True)
                raise HTTPException(413, "media file too large (max 512 MiB)")
            f.write(chunk)
    rel = f"media/{fn.name}"
    # Admin draft URL (JWT). After publish, public path is …/data/media/<name>
    url = f"/api/v1/admin/buildings/{b.slug}/media/{fn.name}"
    return {"filename": fn.name, "bytes": size, "rel": rel, "url": url, "mime": MEDIA_MIME.get(ext, "application/octet-stream")}


@router.get("/buildings/{slug}/media/{filename}")
def get_media_draft(slug: str, filename: str, db: Session = Depends(get_db)):
    """Serve a draft media file (admin JWT). Public copies live under published …/data/media/."""
    b = B(db, slug)
    safe = Path(filename).name
    if safe != filename or ".." in filename:
        raise HTTPException(400, "bad filename")
    f = _media_dir(b) / safe
    if not f.is_file():
        raise HTTPException(404, "media not found")
    mt = MEDIA_MIME.get(f.suffix.lower(), "application/octet-stream")
    return FileResponse(f, media_type=mt, headers={"Cache-Control": "private, max-age=60"})


@router.get("/buildings/{slug}/media")
def list_media(slug: str, db: Session = Depends(get_db)):
    b = B(db, slug)
    d = _media_dir(b)
    out = []
    for f in sorted(d.iterdir()) if d.is_dir() else []:
        if not f.is_file():
            continue
        out.append({"filename": f.name, "bytes": f.stat().st_size, "url": f"/api/v1/admin/buildings/{b.slug}/media/{f.name}"})
    return {"files": out}


@router.post("/buildings/{slug}/publish")
def do_publish(slug: str, p: schemas.PublishIn, db: Session = Depends(get_db), u: models.User = Depends(current_admin)):
    b = B(db, slug)
    try:
        mv = pub.publish(db, b, u.email, p.notes)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"version": mv.version, "summary": mv.summary, "created_at": mv.created_at}


@router.get("/buildings/{slug}/versions")
def versions(slug: str, db: Session = Depends(get_db)):
    b = B(db, slug)
    return [{"version": v.version, "notes": v.notes, "created_by": v.created_by, "created_at": v.created_at, "is_current": v.is_current, "summary": v.summary}
            for v in db.query(models.MapVersion).filter_by(building_id=b.id).order_by(models.MapVersion.version.desc())]


@router.post("/buildings/{slug}/versions/{ver}/activate")
def activate(slug: str, ver: int, db: Session = Depends(get_db)):
    b = B(db, slug)
    try:
        mv = pub.rollback(db, b, ver)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"current": mv.version}


# ── AI Build-3D analyze endpoint ─────────────────────────────────────────────
class AiBuild3dIn(BaseModel):
    screenshot_b64: str = ""      # PNG data-URL from the Three.js canvas
    features_summary: list = []   # [{category, count, floor}] from the GeoJSON
    slug_hint: str = ""           # building name hint
    floor_count: int = 1
    anthropic_api_key: str = ""   # optional — user can supply their own key

# Building-type detection by name keywords → (theme_name, palette)
_THEMES: dict = {
    "university": {
        "building_type": "University / Academic Campus",
        "description": "Multi-floor academic building with lecture halls, labs, and circulation stairs",
        "styles": {
            "room":      {"color": "#388bfd", "opacity": 0.45, "height": 3.2},
            "walkway":   {"color": "#3fb950", "opacity": 0.30, "height": 2.8},
            "stairs":    {"color": "#ff8c00", "opacity": 0.55, "height": 3.5},
            "wall":      {"color": "#8b949e", "opacity": 0.72, "height": 3.2},
            "window":    {"color": "#79c0ff", "opacity": 0.22, "height": 2.0},
            "entrance":  {"color": "#2ea043", "opacity": 0.55, "height": 3.2},
            "building":  {"color": "#1f6feb", "opacity": 0.10, "height": 0.20},
            "pedestrian":{"color": "#3fb950", "opacity": 0.18, "height": 0.12},
            "default":   {"color": "#58a6ff", "opacity": 0.30, "height": 2.8},
        },
        "floor_height_m": 3.5, "wall_thickness_m": 0.18
    },
    "hospital": {
        "building_type": "Hospital / Healthcare Facility",
        "description": "Healthcare building with patient rooms, corridors, and service areas",
        "styles": {
            "room":      {"color": "#56d364", "opacity": 0.40, "height": 3.0},
            "walkway":   {"color": "#e3f9e5", "opacity": 0.25, "height": 2.6},
            "stairs":    {"color": "#f0883e", "opacity": 0.55, "height": 3.2},
            "wall":      {"color": "#c9d1d9", "opacity": 0.78, "height": 3.0},
            "window":    {"color": "#cae8ff", "opacity": 0.20, "height": 2.0},
            "entrance":  {"color": "#388bfd", "opacity": 0.52, "height": 3.2},
            "building":  {"color": "#56d364", "opacity": 0.08, "height": 0.20},
            "pedestrian":{"color": "#56d364", "opacity": 0.15, "height": 0.12},
            "default":   {"color": "#79c0ff", "opacity": 0.28, "height": 2.6},
        },
        "floor_height_m": 3.2, "wall_thickness_m": 0.20
    },
    "mall": {
        "building_type": "Shopping Mall / Retail",
        "description": "Retail complex with open floor plans and wide circulation corridors",
        "styles": {
            "room":      {"color": "#ffa657", "opacity": 0.42, "height": 4.0},
            "walkway":   {"color": "#f0e3c4", "opacity": 0.22, "height": 3.6},
            "stairs":    {"color": "#ff7b72", "opacity": 0.55, "height": 4.5},
            "wall":      {"color": "#a8a8a8", "opacity": 0.68, "height": 4.0},
            "window":    {"color": "#a5d6ff", "opacity": 0.18, "height": 3.0},
            "entrance":  {"color": "#d2a679", "opacity": 0.55, "height": 4.0},
            "building":  {"color": "#ffa657", "opacity": 0.08, "height": 0.25},
            "pedestrian":{"color": "#ffa657", "opacity": 0.15, "height": 0.12},
            "default":   {"color": "#d2a679", "opacity": 0.28, "height": 3.5},
        },
        "floor_height_m": 4.5, "wall_thickness_m": 0.22
    },
    "office": {
        "building_type": "Office Building",
        "description": "Corporate office building with open-plan floors and meeting rooms",
        "styles": {
            "room":      {"color": "#79c0ff", "opacity": 0.38, "height": 2.8},
            "walkway":   {"color": "#cae8ff", "opacity": 0.22, "height": 2.6},
            "stairs":    {"color": "#d29922", "opacity": 0.52, "height": 3.0},
            "wall":      {"color": "#6e7681", "opacity": 0.80, "height": 2.8},
            "window":    {"color": "#388bfd", "opacity": 0.18, "height": 2.2},
            "entrance":  {"color": "#56d364", "opacity": 0.50, "height": 3.0},
            "building":  {"color": "#79c0ff", "opacity": 0.08, "height": 0.20},
            "pedestrian":{"color": "#79c0ff", "opacity": 0.15, "height": 0.12},
            "default":   {"color": "#58a6ff", "opacity": 0.28, "height": 2.6},
        },
        "floor_height_m": 3.0, "wall_thickness_m": 0.15
    },
    "library": {
        "building_type": "Library / Study Space",
        "description": "Knowledge space with reading areas, stacks, and quiet study rooms",
        "styles": {
            "room":      {"color": "#c8a96e", "opacity": 0.40, "height": 3.5},
            "walkway":   {"color": "#d2a679", "opacity": 0.22, "height": 3.0},
            "stairs":    {"color": "#8b6914", "opacity": 0.60, "height": 3.8},
            "wall":      {"color": "#7a5c3c", "opacity": 0.75, "height": 3.5},
            "window":    {"color": "#e3c97b", "opacity": 0.20, "height": 2.5},
            "entrance":  {"color": "#6a9955", "opacity": 0.52, "height": 3.5},
            "building":  {"color": "#c8a96e", "opacity": 0.08, "height": 0.20},
            "pedestrian":{"color": "#c8a96e", "opacity": 0.15, "height": 0.12},
            "default":   {"color": "#d2a679", "opacity": 0.28, "height": 3.2},
        },
        "floor_height_m": 4.0, "wall_thickness_m": 0.20
    },
}

_KEYWORD_MAP = {
    "university": "university", "college": "university", "campus": "university",
    "school": "university", "institute": "university", "faculty": "university",
    "engineering": "university", "gcu": "university", "garden city": "university",
    "hospital": "hospital", "clinic": "hospital", "medical": "hospital",
    "health": "hospital", "care": "hospital", "pharmacy": "hospital",
    "mall": "mall", "shop": "mall", "retail": "mall", "market": "mall", "plaza": "mall",
    "office": "office", "corporate": "office", "tech": "office", "headquarter": "office",
    "library": "library", "archive": "library", "reading": "library",
}

def _detect_theme(name: str, slug: str) -> dict:
    text = (name + " " + slug).lower()
    for kw, theme in _KEYWORD_MAP.items():
        if kw in text:
            return _THEMES[theme]
    return _THEMES["university"]   # sensible default

def _adapt_theme(theme: dict, features_summary: list, floor_count: int) -> dict:
    """Tune heights based on actual floor count and stair/room ratios."""
    import copy, math
    result = copy.deepcopy(theme)
    cats = {f.get("category", "default"): f.get("count", 0) for f in features_summary}
    total = max(1, sum(cats.values()))
    stair_ratio = cats.get("stairs", 0) / total
    room_ratio  = cats.get("room", 0) / total

    # More stairs → taller floor-to-floor
    fh = theme["floor_height_m"]
    if stair_ratio > 0.15: fh = min(fh * 1.15, 5.5)
    # Fewer rooms, more corridors → open-plan
    if room_ratio < 0.08: fh = max(fh * 0.90, 2.5)
    # Scale wall height to floor height
    result["floor_height_m"] = round(fh, 2)
    for cat in result["styles"]:
        s = result["styles"][cat]
        if cat in ("room", "walkway", "stairs", "wall", "entrance", "window"):
            s["height"] = round(s["height"] * (fh / theme["floor_height_m"]), 2)

    # Taller buildings → slightly more transparent (aerial view legibility)
    if floor_count >= 5:
        for cat in ("room", "walkway"):
            result["styles"][cat]["opacity"] = round(
                max(0.18, result["styles"][cat]["opacity"] - 0.08), 2)
    return result

@router.post("/buildings/{slug}/ai-build3d")
def ai_build3d(slug: str, body: AiBuild3dIn, db: Session = Depends(get_db)):
    """Dynamically analyze building floor plan data and return 3D styling instructions.
    Uses Claude API if ANTHROPIC_API_KEY is set (or supplied in the request), otherwise
    falls back to a smart local rule-based analysis."""
    import os, httpx as _hx

    b = B(db, slug)
    s = get_settings()

    api_key = (body.anthropic_api_key or "").strip() or os.environ.get("ANTHROPIC_API_KEY", "").strip()
    llm_base = (s.wf_chat_llm_base_url or "").strip()
    llm_key  = (s.wf_chat_llm_api_key or "").strip()

    # ── Try Claude (Anthropic) if an API key is available ────────────────────
    if api_key:
        summary_lines = [
            f"  - {f.get('category','?')} count={f.get('count',1)}"
            for f in body.features_summary[:80]
        ]
        feature_text = "\n".join(summary_lines) or "  (no data)"
        user_text = (
            f"Building: {b.name} (slug: {slug}). "
            f"Floors: {body.floor_count}. Hint: {body.slug_hint or 'campus'}.\n\n"
            f"Floor plan feature counts:\n{feature_text}\n\n"
            "Return ONLY valid JSON with this exact structure (no markdown):\n"
            '{"building_type":"...","description":"...","styles":{'
            '"room":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"wall":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"stairs":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"walkway":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"entrance":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"window":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"building":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"pedestrian":{"color":"#hex","opacity":0.0,"height":0.0},'
            '"default":{"color":"#hex","opacity":0.0,"height":0.0}'
            '},"floor_height_m":3.5,"wall_thickness_m":0.15}'
        )
        messages_payload: list = []
        if body.screenshot_b64 and body.screenshot_b64.startswith("data:image"):
            img_b64 = body.screenshot_b64.split(",", 1)[-1]
            messages_payload.append({"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img_b64}},
                {"type": "text", "text": user_text}
            ]})
        else:
            messages_payload.append({"role": "user", "content": user_text})
        try:
            import anthropic as _ant
            client = _ant.Anthropic(api_key=api_key)
            resp = client.messages.create(
                model="claude-sonnet-4-6", max_tokens=1024,
                system=(
                    "You are an architectural 3D visualizer. Return ONLY raw JSON, "
                    "no markdown, no explanation. Choose colors suited to the building type. "
                    "Glass rooms: opacity 0.3-0.55. Walls more opaque: 0.65-0.85."
                ),
                messages=messages_payload
            )
            result = json.loads(resp.content[0].text.strip())
            result["source"] = "claude"
            return result
        except Exception as e:
            pass   # fall through to local analysis

    # ── Try the configured LLM (Ollama / OpenAI-compatible) ──────────────────
    if llm_base and "11434" not in llm_base:   # skip local Ollama (too slow / no vision)
        try:
            summary_text = "; ".join(
                f"{f.get('category')}×{f.get('count')}" for f in body.features_summary[:30]
            )
            payload = {
                "model": s.wf_chat_llm_model or "gpt-4o-mini",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content":
                    f"Building {b.name}, floors {body.floor_count}. Features: {summary_text}. "
                    "Return JSON styling for a Three.js glass building visualization with keys: "
                    "building_type, description, styles (room/wall/stairs/walkway/entrance/window/building/pedestrian/default "
                    "each with color hex, opacity, height), floor_height_m, wall_thickness_m."
                }]
            }
            headers = {"Content-Type": "application/json"}
            if llm_key: headers["Authorization"] = "Bearer " + llm_key
            r = _hx.post(llm_base.rstrip("/") + "/chat/completions", json=payload,
                         headers=headers, timeout=20)
            if r.status_code == 200:
                raw = r.json()["choices"][0]["message"]["content"].strip()
                raw = raw.split("```json")[-1].split("```")[0].strip()
                result = json.loads(raw)
                result["source"] = "llm"
                return result
        except Exception:
            pass   # fall through to local

    # ── Local smart analysis — always works, no API key needed ───────────────
    theme = _detect_theme(b.name, slug)
    result = _adapt_theme(theme, body.features_summary, body.floor_count)
    result["source"] = "local"
    return result
