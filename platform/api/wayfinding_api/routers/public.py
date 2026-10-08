"""Public, read-only endpoints consumed by the viewer. They serve the CURRENT PUBLISHED version only.
Paths mirror the static export layout, so the viewer works against the API or a static host:
  /api/v1/public/venues/{venue}/manifest.json
  /api/v1/public/buildings/{slug}/data/{file}      (config.json, pois.json, nav_graph.json, indoor_F1.geojson, …)"""
import json, mimetypes
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy.orm import Session
from ..db import get_db
from ..config import get_settings
from .. import models, schemas
from ..services.publish import current_version
from ..services import navgraph, bundle_storage

router = APIRouter(prefix="/api/v1/public", tags=["public"])


def building_or_404(db, slug):
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b: raise HTTPException(404, "unknown building")
    return b


def venue_manifest(db, venue_slug):
    # Virtual venue "all" always lists every published building, even if a
    # real Venue row named "all" exists (e.g. from add-building --venue all).
    if venue_slug == "all":
        bs = db.query(models.Building).all(); v = None
    else:
        v = db.query(models.Venue).filter_by(slug=venue_slug).first()
        if not v:
            raise HTTPException(404, "unknown venue")
        bs = v.buildings
    items = []
    for b in bs:
        mv = current_version(db, b)
        if not mv: continue
        try:
            raw = bundle_storage.read_bundle_file(Path(mv.path), b.slug, mv.version, "config.json")
        except FileNotFoundError:
            continue  # this building's local+Storage copies are both gone — skip rather than 500 the whole manifest
        cfg = json.loads(raw)
        items.append({"slug": b.slug, "name": b.name, "address": b.address, "center": cfg["center"], "bounds": cfg["bounds"],
                      "floors": [{"id": f["id"], "label": f["label"], "short": f["short"]} for f in cfg["floors"]],
                      "version": mv.version, "data": f"buildings/{b.slug}/data/"})
    return {"schema": "wayfinding.venue/v1", "slug": v.slug if v else "all", "name": v.name if v else "All buildings",
            "branding": (v.branding if v else {}) or {}, "buildings": items}


@router.get("/venues")
def venues(db: Session = Depends(get_db)):
    return [{"slug": v.slug, "name": v.name, "buildings": [b.slug for b in v.buildings]} for v in db.query(models.Venue).all()]


@router.get("/venues/{venue}/manifest.json")
def manifest(venue: str, db: Session = Depends(get_db)):
    return venue_manifest(db, venue)


@router.get("/buildings")
def buildings(db: Session = Depends(get_db)):
    out = []
    for b in db.query(models.Building).order_by(models.Building.name):
        mv = current_version(db, b)
        if mv: out.append({"slug": b.slug, "name": b.name, "address": b.address, "version": mv.version, "venue": b.venue.slug if b.venue else None})
    return out


@router.api_route("/buildings/{slug}/data/{path:path}", methods=["GET", "HEAD"])
def data_file(slug: str, path: str, db: Session = Depends(get_db)):
    b = building_or_404(db, slug); mv = current_version(db, b)
    if not mv: raise HTTPException(404, "building not published yet")
    root = Path(mv.path).resolve(); f = (root / path).resolve()
    if root not in f.parents:
        raise HTTPException(404, "not found")
    mt = "application/json" if f.suffix in (".json", ".geojson") else (mimetypes.guess_type(f.name)[0] or "application/octet-stream")
    if f.is_file():
        return FileResponse(f, media_type=mt, headers={"Cache-Control": "public, max-age=60"})
    # Local disk was wiped (Render free-tier restart, including automatic idle
    # spin-down) — the DB still thinks this version is published, but its files are
    # gone. Recover from Supabase Storage and re-cache locally. No-op (raises
    # immediately) unless bundle_storage is configured. See services/bundle_storage.py.
    try:
        data = bundle_storage.read_bundle_file(root, slug, mv.version, path)
    except FileNotFoundError:
        raise HTTPException(404, "not found")
    return Response(content=data, media_type=mt, headers={"Cache-Control": "public, max-age=60"})


@router.post("/buildings/{slug}/route")
def public_route(slug: str, r: schemas.RouteIn, db: Session = Depends(get_db)):
    """Server-side route between two published POIs (the viewer normally routes client-side)."""
    b = building_or_404(db, slug); mv = current_version(db, b)
    if not mv: raise HTTPException(404, "not published")
    root = Path(mv.path)
    try:
        nav = json.loads(bundle_storage.read_bundle_file(root, slug, mv.version, "nav_graph.json"))
        pois = {p["id"]: p for p in json.loads(bundle_storage.read_bundle_file(root, slug, mv.version, "pois.json"))["pois"]}
    except FileNotFoundError:
        raise HTTPException(404, "building not published yet")
    if r.from_key not in pois or r.to_key not in pois: raise HTTPException(404, "unknown POI")
    try:
        navmesh = json.loads(bundle_storage.read_bundle_file(root, slug, mv.version, "navmesh.json"))
    except FileNotFoundError:
        navmesh = None
    res = navgraph.route(nav, pois[r.from_key]["nearest_node"], pois[r.to_key]["nearest_node"], r.step_free, georef=b.georef, navmesh=navmesh)
    if not res: raise HTTPException(404, "no route" + (" without steps" if r.step_free else ""))
    return res


@router.get("/buildings/{slug}/matterport")
def public_matterport(slug: str, request: Request, access: str | None = None, db: Session = Depends(get_db)):
    """Return Matterport model id + application key for client Showcase embeds.
    Application keys are domain-bound and designed to be used client-side in embeds.
    Honours published config.access (twin public|pin|disabled, tour_public).
    PIN: header X-WF-Access or query ?access= (compared to draft twin_pin_hash; never published)."""
    from ..services import access as access_svc
    b = building_or_404(db, slug)
    s = get_settings()
    mid = b.matterport_model_id or ""
    if not mid:
        raise HTTPException(404, detail="building has no Matterport model id")

    published_cfg = None
    mv = current_version(db, b)
    if mv:
        try:
            published_cfg = json.loads(bundle_storage.read_bundle_file(Path(mv.path), slug, mv.version, "config.json"))
        except Exception:
            published_cfg = None
    policy = access_svc.resolve_access_policy(b.pipeline_config, published_cfg)
    draft_access = access_svc.parse_access((b.pipeline_config or {}).get("access"))
    pin = access or request.headers.get("X-WF-Access") or request.query_params.get("access")
    ok, status, detail = access_svc.matterport_allowed(policy, pin, draft_access.get("twin_pin_hash"))
    if not ok:
        # Prefer 403 for policy deny; 404 only when twin disabled and we want to hide existence of key
        raise HTTPException(status_code=status, detail=detail)

    key = s.matterport_sdk_key or ""
    # Never return application_key when twin is pin/disabled (disabled already returned).
    # For pin mode, only return key after successful PIN verify (above).
    if policy.get("twin") == "pin" and not key:
        raise HTTPException(404, detail="Matterport SDK key not configured")
    if not key:
        raise HTTPException(404, detail="Matterport SDK key not configured")
    return {
        "model_id": mid,
        "application_key": key,
        "access": {"twin": policy.get("twin"), "tour_public": policy.get("tour_public", True)},
    }


@router.get("/config")
def runtime_config():
    """Runtime options for viewers (no secrets): VPS availability, SDK key presence, debug."""
    from ..services import debug_log as dbg
    s = get_settings()
    from ..services import chat as chat_svc
    return {"vps_enabled": bool(s.vps_url), "vps_endpoint": "/api/v1/public/vps/localize" if s.vps_url else None,
            "matterport_sdk": bool(s.matterport_sdk_key),
            "debug_enabled": bool(dbg.global_enabled()),
            "debug_status_url": "/api/v1/public/debug/status",
            "chat_enabled": bool(chat_svc.chat_enabled()),
            "chat_configured": bool(chat_svc.llm_configured()),
            "chat_url": "/api/v1/public/chat"}


# ---- Debug mode (public viewer / mobile clients ship logs when enabled) ----
from pydantic import BaseModel, Field
from ..services import debug_log as dbg


class DebugLogIn(BaseModel):
    level: str = "info"
    source: str = "client"
    message: str
    building: str | None = None
    ts: float | None = None
    meta: dict | None = None
    client: str | None = None


class DebugLogBatch(BaseModel):
    entries: list[DebugLogIn] = Field(default_factory=list)
    building: str | None = None
    client: str | None = None


@router.get("/debug/status")
def debug_status(b: str | None = None, db: Session = Depends(get_db)):
    """Live effective debug flag for viewers (no publish required for global toggle).
    Per-building override lives in draft pipeline_config; published config.debug is a hint."""
    global_on = dbg.global_enabled()
    override = None
    effective = global_on
    if b:
        building = db.query(models.Building).filter_by(slug=b).first()
        if building:
            override = dbg.building_override(building.pipeline_config)
            effective = dbg.effective_enabled(pipeline_config=building.pipeline_config)
            # Also honour published config.json debug if draft has no override and global off
            if override is None and not global_on:
                mv = current_version(db, building)
                if mv:
                    try:
                        cfg = json.loads((Path(mv.path) / "config.json").read_text())
                        if cfg.get("debug") is True:
                            effective = True
                    except Exception:
                        pass
    return {
        "enabled": bool(effective),
        "global": bool(global_on),
        "building": b,
        "override": override,
    }


@router.post("/debug/logs")
def debug_ingest(body: DebugLogBatch, db: Session = Depends(get_db)):
    """Accept client log batches when debug is effectively on for the building (or global)."""
    if not body.entries:
        return {"accepted": 0, "enabled": False}
    # Determine building from batch or first entry
    slug = body.building or next((e.building for e in body.entries if e.building), None)
    enabled = False
    if slug:
        enabled = dbg.effective_enabled(building_slug=slug, db=db)
        if not enabled:
            # published config hint
            building = db.query(models.Building).filter_by(slug=slug).first()
            if building:
                mv = current_version(db, building)
                if mv:
                    try:
                        cfg = json.loads((Path(mv.path) / "config.json").read_text())
                        enabled = bool(cfg.get("debug"))
                    except Exception:
                        pass
    else:
        enabled = dbg.global_enabled()
    if not enabled:
        return {"accepted": 0, "enabled": False}
    payload = []
    for e in body.entries[:100]:
        payload.append({
            "level": e.level,
            "source": e.source,
            "message": e.message,
            "building": e.building or slug,
            "ts": e.ts,
            "meta": e.meta,
            "client": e.client or body.client or "viewer",
        })
    n = dbg.append_entries(payload, force=True)
    return {"accepted": n, "enabled": True}


# ---- Public chat (Option 3 phase 1: viewer FAB + tool-calling) ----
class ChatMessageIn(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    messages: list[ChatMessageIn] = Field(default_factory=list)
    building: str | None = None
    locale: str | None = None


@router.post("/chat")
def public_chat(body: ChatIn, request: Request, db: Session = Depends(get_db)):
    """Same-origin chat for the public viewer. Tools: list_buildings, search_pois, get_poi, route, make_deep_link.
    LLM keys stay server-side. Returns a clear message when no LLM is configured."""
    from ..services import chat as chat_svc
    if not chat_svc.chat_enabled():
        raise HTTPException(404, "chat disabled")
    # Rate-limit by client IP (best-effort behind tunnel)
    client = request.client.host if request.client else "unknown"
    forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    chat_svc.check_rate_limit(forwarded or client)
    msgs = [{"role": m.role, "content": m.content} for m in (body.messages or []) if m.content]
    if not msgs:
        raise HTTPException(400, "messages required")
    # Cap payload size
    if sum(len(m["content"]) for m in msgs) > 12000:
        raise HTTPException(400, "messages too long")
    return chat_svc.run_chat(db, msgs, building=body.building, locale=body.locale)


# ──── Dashboard integration (NavMe Dashboard → Wayfinding) ────
# Authenticated by Supabase anon key instead of admin JWT.

def _verify_supabase_key(request: Request):
    key = request.headers.get("x-supabase-anon-key", "")
    cfg = get_settings()
    if not cfg.supabase_anon_key or key != cfg.supabase_anon_key:
        raise HTTPException(403, "invalid supabase key")


@router.get("/dashboard/matterport/{model_id}")
def dashboard_mp_info(model_id: str, request: Request):
    _verify_supabase_key(request)
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
    lat = lon = None
    g = m.get("geocoordinates") or {}
    if g.get("latitude") is not None and g.get("longitude") is not None:
        lat, lon = float(g["latitude"]), float(g["longitude"])
    if lat is None:
        gl = m.get("geolocation") or {}
        if gl.get("lat") not in (None, "") and gl.get("long") not in (None, ""):
            try: lat, lon = float(gl["lat"]), float(gl["long"])
            except (TypeError, ValueError): pass
    if lat is None:
        ag = (addr_obj.get("geolocation") or {})
        if ag.get("lat") not in (None, "") and ag.get("long") not in (None, ""):
            try: lat, lon = float(ag["lat"]), float(ag["long"])
            except (TypeError, ValueError): pass

    suggested_address = address or (name if re.match(r"^\d+\s+\S+", name) else None)
    if lat is None and suggested_address:
        try:
            r = gc(suggested_address, get_settings().geocoder)
            if r:
                lat, lon = float(r[0]), float(r[1])
                if not address: address = r[2] or suggested_address
        except Exception: pass

    floors = m.get("floors") or []
    return {
        "model_id": mid, "name": name,
        "floor_count": len(floors), "sweeps": len(m.get("locations") or []),
        "address": address, "lat": lat, "lon": lon,
    }


from pydantic import BaseModel as _BM, Field as _F

class _DashboardBuildingIn(_BM):
    slug: str = _F(pattern=r"^[a-z0-9][a-z0-9-]{1,78}$")
    name: str
    address: str | None = None
    lat: float | None = None
    lon: float | None = None
    matterport_model_id: str | None = None


def _building_detail(b, cfg):
    import json
    floors = []
    try:
        bj = cfg.buildings_dir / b.slug / "building.json"
        if bj.exists():
            floors = json.loads(bj.read_text()).get("floors", [])
    except Exception: pass
    return {"slug": b.slug, "status": getattr(b, "status", "unknown"), "name": b.name,
            "address": b.address, "lat": b.lat, "lon": b.lon,
            "matterport_model_id": b.matterport_model_id,
            "floors": [{"id": f["id"], "label": f.get("label", f["id"])} for f in floors]}


@router.get("/dashboard/buildings/by-sid/{model_id}")
def dashboard_building_by_sid(model_id: str, request: Request, db: Session = Depends(get_db)):
    _verify_supabase_key(request)
    b = db.query(models.Building).filter_by(matterport_model_id=model_id).first()
    if not b: raise HTTPException(404, "building not found")
    return _building_detail(b, get_settings())


@router.get("/dashboard/buildings/{slug}/status")
def dashboard_building_status(slug: str, request: Request, db: Session = Depends(get_db)):
    _verify_supabase_key(request)
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b: raise HTTPException(404, "building not found")
    return _building_detail(b, get_settings())


@router.post("/dashboard/buildings")
def dashboard_create_building(inp: _DashboardBuildingIn, request: Request, db: Session = Depends(get_db)):
    _verify_supabase_key(request)
    from geoalchemy2 import WKTElement
    if db.query(models.Building).filter_by(slug=inp.slug).first():
        raise HTTPException(409, "building slug already exists")
    b = models.Building(slug=inp.slug, name=inp.name, address=inp.address, lat=inp.lat, lon=inp.lon, matterport_model_id=inp.matterport_model_id)
    if b.lat is not None and b.lon is not None:
        b.location = WKTElement(f"POINT({b.lon} {b.lat})", srid=4326)
    db.add(b); db.commit()
    return {"slug": b.slug, "name": b.name, "id": b.id}


@router.post("/dashboard/buildings/{slug}/sync-pois")
def dashboard_sync_pois(slug: str, request: Request, db: Session = Depends(get_db)):
    _verify_supabase_key(request)
    import urllib.request, urllib.error, json
    cfg = get_settings()
    if not cfg.supabase_url or not cfg.supabase_anon_key:
        raise HTTPException(400, "SUPABASE_URL / SUPABASE_ANON_KEY not configured")

    # Resolve slug: if the given slug doesn't exist in our DB, try to find the real
    # building by Matterport model ID (slug-drift fix).
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        # Try to resolve via a building whose slug contains the given slug as a prefix
        b = db.query(models.Building).filter(
            models.Building.slug.like(f"{slug}%")
        ).first()
    if not b: raise HTTPException(404, f"building not found for slug '{slug}'")

    url = f"{cfg.supabase_url}/rest/v1/rpc/gmap_list_pois"
    # Use the POI type (original slug from the request) as the filter key so
    # Supabase returns POIs for this tenant regardless of the wayfinding slug.
    body = json.dumps({"p_slug": slug}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "apikey": cfg.supabase_anon_key,
        "Authorization": f"Bearer {cfg.supabase_anon_key}",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            rows = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_err = ""
        try: body_err = e.read().decode()
        except Exception: pass
        raise HTTPException(502, f"Supabase RPC error {e.code}: {body_err}")
    except Exception as e:
        raise HTTPException(502, f"Supabase unreachable: {e}")

    if not isinstance(rows, list) or not rows:
        return {"synced": 0, "created": 0, "updated": 0, "skipped": 0, "errors": [],
                "building_slug": b.slug, "note": "gmap_list_pois returned 0 rows — ensure POIs have x/y/z set"}

    # Build floor label → floor id map from the building's floors
    floor_label_to_id: dict = {}
    try:
        import json as _json
        bj_path = cfg.buildings_dir / b.slug / "building.json"
        if bj_path.exists():
            for fl in _json.loads(bj_path.read_text()).get("floors", []):
                for key_v in (fl.get("label"), fl.get("short"), fl.get("id")):
                    if key_v:
                        floor_label_to_id[str(key_v).lower()] = fl["id"]
    except Exception:
        pass

    created = updated = skipped = 0
    errors = []
    for r in rows:
        meta = r.get("metadata") or {}
        src_id = str(r.get("src_id") or meta.get("src_id") or r.get("id") or "")
        if not src_id: skipped += 1; continue
        poi_key = f"sb_{src_id}"
        name = str(r.get("label") or r.get("name") or "")
        # Matterport SDK coords (Y-up): x=right, y=elevation, z=depth
        # Map to wayfinding model coords: model_x=scan X, model_y=scan Z(depth), model_z=elevation(SDK Y)
        sdk_x = r.get("x") or r.get("pos_x")
        sdk_y = r.get("y") or r.get("pos_y")  # elevation in SDK coords
        sdk_z = r.get("z") or r.get("pos_z")
        # Resolve floor id from label
        raw_floor = str(r.get("floor_id") or r.get("floor_label") or r.get("floor") or "")
        floor_id = floor_label_to_id.get(raw_floor.lower(), raw_floor) or "F1"
        category = str(r.get("category") or "room")

        vals = dict(
            name=name,
            floor=floor_id,
            category=category,
            source="admin",
            model_x=float(sdk_x) if sdk_x is not None else None,
            model_y=float(sdk_z) if sdk_z is not None else None,  # SDK z → plan Y
            model_z=float(sdk_y) if sdk_y is not None else None,  # SDK y (elevation) → model_z
        )

        existing = db.query(models.POI).filter_by(building_id=b.id, key=poi_key).first()
        if existing:
            for k, v in vals.items():
                if v is not None: setattr(existing, k, v)
            updated += 1
        else:
            try:
                poi = models.POI(building_id=b.id, key=poi_key, locked=False, **vals)
                db.add(poi)
                created += 1
            except Exception as e:
                errors.append({"src_id": src_id, "error": str(e)})
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(500, f"DB commit failed: {e}")
    return {"synced": created + updated, "created": created, "updated": updated,
            "skipped": skipped, "errors": errors, "building_slug": b.slug}


# --------------- NavMe live POI list + coord-based route (no sync required) ---------------

def _verify_supabase_key_or_admin(request: Request):
    """Accept either the Supabase anon key (dashboard) or a valid admin JWT (admin UI)."""
    cfg = get_settings()
    if request.headers.get("x-supabase-anon-key", "") == (cfg.supabase_anon_key or "\0"):
        return
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        import jwt
        try:
            jwt.decode(auth[7:], cfg.jwt_secret, algorithms=["HS256"])
            return
        except Exception:
            pass
    raise HTTPException(403, "invalid supabase key or admin token")



@router.get("/dashboard/buildings/{slug}/navme-pois")
def dashboard_navme_pois(slug: str, request: Request, db: Session = Depends(get_db)):
    """Return the NavMe Dashboard POI list for a building slug — served straight from this
    server's own `pois` table (source="supabase"), no new table, self-hosted: no Supabase
    call at request time.

    Rows are upserted here by an admin POST to
    /api/v1/admin/buildings/{slug}/navme-gmap/sync whenever the dashboard's POIs change —
    the dashboard itself still owns and edits this data in Supabase as before.

    Unauthenticated: the public viewer renders this same POI set and has neither an admin
    token nor any Supabase credential. Note this does expose POI names and positions to
    anyone who can reach the server, same as before."""
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        return []
    rows = db.query(models.POI).filter_by(building_id=b.id, source="supabase").all()
    pois = []
    for r in rows:
        extra = r.extra or {}
        poi = {
            "id": extra.get("gmap_src_id") or r.key,
            "name": r.name,
            "floor": r.floor,
            "category": r.category,
            # SDK coords: x=right, y=elevation, z=depth → pass as-is for snapping
            "x": r.model_x, "y": r.model_y, "z": r.model_z,
        }
        if extra.get("expected_pos_x") is not None and extra.get("expected_pos_y") is not None and extra.get("expected_pos_z") is not None:
            poi["expected_pos_x"] = extra.get("expected_pos_x")
            poi["expected_pos_y"] = extra.get("expected_pos_y")
            poi["expected_pos_z"] = extra.get("expected_pos_z")
        pois.append(poi)
    pois.sort(key=lambda p: p["name"].lower())
    return pois


class _RouteByCoords(_BM):
    from_x: float; from_z: float; from_floor: str = "F1"
    to_x: float; to_z: float; to_floor: str = "F1"
    step_free: bool = False

@router.post("/dashboard/buildings/{slug}/route-by-coords")
def dashboard_route_by_coords(slug: str, r: _RouteByCoords, request: Request, db: Session = Depends(get_db)):
    """Route between two Matterport SDK coordinates (Y-up) without requiring synced POIs."""
    _verify_supabase_key_or_admin(request)
    from ..services import workspace

    from_x = r.from_x; from_z = r.from_z; from_floor = r.from_floor
    to_x = r.to_x; to_z = r.to_z; to_floor = r.to_floor
    step_free = r.step_free

    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        b = db.query(models.Building).filter(models.Building.slug.like(f"{slug}%")).first()
    if not b:
        raise HTTPException(404, f"building '{slug}' not found")

    nav = workspace.latest_nav(db, b)
    if not nav:
        raise HTTPException(400, "no nav graph — rebuild the building first")

    # SDK is Y-up: x=right, z=depth, y=elevation.
    # Nav graph is Z-up: x=scan X, y=scan Z(depth). Map SDK→nav:
    fn_x, fn_y = float(from_x), float(from_z)
    tn_x, tn_y = float(to_x), float(to_z)

    from_node, _ = navgraph.nearest_node(nav, fn_x, fn_y, from_floor)
    to_node, _ = navgraph.nearest_node(nav, tn_x, tn_y, to_floor)

    res = navgraph.route(nav, from_node["id"], to_node["id"], step_free,
                         georef=b.georef, navmesh=workspace.latest_navmesh(b))
    if not res:
        raise HTTPException(404, "no route" + (" without steps" if step_free else ""))
    return res


@router.get("/dashboard/buildings/{slug}/navmesh-url")
def dashboard_navmesh_url(slug: str, request: Request, db: Session = Depends(get_db)):
    """Resolve the active Recast navmesh for a building.

    The route is computed purely on this mesh (stairs are walkable geometry in it, so
    floor changes come from the mesh itself — there is no stair/door graph involved).

    Self-hosted, no new table: served straight from this building's existing
    pipeline_config["navme_navmesh"] pointer (JSONB column that already existed) + the
    navmesh file an admin sync already downloaded onto local disk — no Supabase call at
    request time. Run POST /api/v1/admin/buildings/{slug}/navme-gmap/sync (or drop a
    <slug>_navmesh.navmesh file directly in the viewer directory) to populate/refresh it.

    Unauthenticated: the public viewer needs this to route and has no admin token."""
    cfg = get_settings()
    base_url = str(request.base_url).rstrip("/")

    # Local file dropped directly next to the viewer (manual override / pre-sync state).
    if cfg.viewer_dir:
        local_nm = Path(cfg.viewer_dir) / f"{slug}_navmesh.navmesh"
        if not local_nm.exists():
            # Local disk wiped (Render free-tier restart) — recover from Supabase
            # Storage the same way published bundle files do. See bundle_storage.py.
            data = bundle_storage.fetch_navmesh_bytes(slug)
            if data:
                try:
                    local_nm.write_bytes(data)
                except OSError:
                    pass
        if local_nm.exists():
            return {"url": f"{base_url}/{slug}_navmesh.navmesh",
                    "label": "local-override", "poi_type": slug, "updated_at": None}

    b = db.query(models.Building).filter_by(slug=slug).first()
    nm = (b.pipeline_config or {}).get("navme_navmesh") if b else None
    if not nm or not nm.get("url"):
        raise HTTPException(404, f"no synced navmesh for '{slug}' — "
                                  f"run POST /api/v1/admin/buildings/{slug}/navme-gmap/sync first")
    url = nm["url"] if nm["url"].startswith("http") else f"{base_url}{nm['url']}"
    return {"url": url, "label": nm.get("label"), "poi_type": slug, "updated_at": nm.get("updated_at")}


@router.get("/dashboard/buildings/{slug}/navme-categories")
def dashboard_navme_categories(slug: str, db: Session = Depends(get_db)):
    """NavMe Dashboard's curated POI category list (navme_categories: name + icon_key +
    sort_order) for this building — served from Building.pipeline_config["navme_categories"]
    (synced by POST /api/v1/admin/buildings/{slug}/navme-gmap/sync), never live from
    Supabase. Used by the Matterport public viewer (?mp=1) to build its category chips
    from the dashboard's own categories instead of the viewer's fixed built-in set."""
    b = db.query(models.Building).filter_by(slug=slug).first()
    return (b.pipeline_config or {}).get("navme_categories", []) if b else []
