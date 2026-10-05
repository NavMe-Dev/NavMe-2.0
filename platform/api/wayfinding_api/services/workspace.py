"""Bridge between DB records and pipeline workspaces (config in, artefacts out)."""
import json, shutil
from pathlib import Path
from sqlalchemy.orm import Session
from geoalchemy2.elements import WKTElement
from ..config import get_settings
from .. import models
from . import navgraph


def ws_dir(b: models.Building) -> Path:
    return get_settings().buildings_dir / b.slug


def pipeline_config(db: Session, b: models.Building) -> dict:
    cfg = dict(b.pipeline_config or {})
    cfg.update(slug=b.slug, name=b.name, address=b.address, matterport_model_id=b.matterport_model_id, matterpak=b.matterpak_path,
               branding=b.branding or {})
    if b.lat is not None and b.lon is not None:
        cfg.update(lat=b.lat, lon=b.lon)
    fl = [{"id": f.fid, "label": f.label, "short": f.short_label, "ordinal": f.ordinal, "elevation": f.elevation_m, "height": f.height_m}
          for f in b.floors if (b.pipeline_config or {}).get("floors_locked", True)]
    if fl:
        cfg["floors"] = fl
    cps = db.query(models.ControlPoint).filter_by(building_id=b.id).all()
    g = dict(cfg.get("georef") or {})
    if cps:
        g["control_points"] = [{"id": c.id, "model_xy": [c.model_x, c.model_y], "wgs84": [c.lat, c.lon], "source": c.label or c.source, "enabled": c.enabled} for c in cps]
    cfg["georef"] = g
    return cfg


def import_outputs(db: Session, b: models.Building):
    """Load pipeline outputs into the DB: georef, floors, model info, nav graph, POIs (merge by key)."""
    out = ws_dir(b) / "out"; work = ws_dir(b) / "work"
    J = lambda p: json.loads(Path(p).read_text())
    gj = J(out / "georef.json"); b.georef = gj
    for c in gj.get("control_points") or []:
        if c.get("id"):
            cp = db.get(models.ControlPoint, c["id"])
            if cp: cp.residual_m = c.get("residual_m")
    fr = J(work / "floors_resolved.json")["floors"]
    have = {f.fid: f for f in b.floors}
    for f in fr:
        row = have.get(f["id"])
        if not row:
            row = models.Floor(building_id=b.id, fid=f["id"]); db.add(row); b.floors.append(row)
            row.label, row.short_label, row.ordinal = f["label"], f["short"], f["ordinal"]
            row.elevation_m, row.height_m = f["elevation"], f["height"]
        row.mp_floor_id = f["mp_floor_id"]
    mp = J(work / "mp_model.json")["data"]["model"]
    cfg = J(out / "config.json")
    b.model_info = {"mp_name": mp.get("name"), "dimensions": mp.get("dimensions"), "floors": len(mp["floors"]), "sweeps": len(mp["locations"]),
                    "rooms": len(mp["rooms"]), "geocoordinates": mp.get("geocoordinates"), "center": cfg["center"], "bounds": cfg["bounds"],
                    "stats": cfg["stats"], "manifest": J(work / "matterpak_manifest.json") if (work / "matterpak_manifest.json").exists() else None}
    if b.lat is None:
        b.lat, b.lon = cfg["center"]["lat"], cfg["center"]["lon"]
    b.location = WKTElement(f"POINT({b.lon} {b.lat})", srid=4326)
    nav = J(out / "nav_graph.json")
    db.add(models.NavGraph(building_id=b.id, data=nav, stats=nav.get("stats", {})))
    pj = J(out / "pois.json")
    existing = {p.key: p for p in db.query(models.POI).filter_by(building_id=b.id)}
    seen = set()
    for p in pj["pois"]:
        seen.add(p["id"]); row = existing.get(p["id"])
        if row is None:
            row = models.POI(building_id=b.id, key=p["id"], published=True); db.add(row)
        elif row.locked:
            row.step_free_auto = p.get("step_free_from_parking")
            if row.nearest_node not in {n["id"] for n in nav["nodes"]}:
                row.nearest_node = p["nearest_node"]
            continue
        row.name = p["name"]; row.code = p.get("code"); row.category = p["category"]; row.floor = p["floor"]
        row.geom = WKTElement(f"POINT({p['lonlat'][0]} {p['lonlat'][1]})", srid=4326)
        row.model_x, row.model_y, row.model_z = p["model"]["x"], p["model"]["y"], p["model"]["z"]
        row.nearest_node = p["nearest_node"]; row.nearest_sweep_label = p.get("nearest_sweep_label"); row.room_id = p.get("room_id")
        row.step_free_auto = p.get("step_free_from_parking"); row.source = p.get("source", "auto")
        row.description = row.description or (p.get("note") or None)
        row.extra = {**(row.extra or {}), "area_m2": p.get("area_m2")}
    for k, row in existing.items():
        if k not in seen and not row.locked and row.source not in ("admin", "csv"):
            row.published = False; row.extra = {**(row.extra or {}), "stale": True}
    b.status = "ready"
    db.commit()
    return {"pois": len(pj["pois"]), "nav_nodes": len(nav["nodes"])}


def latest_nav(db: Session, b: models.Building):
    g = db.query(models.NavGraph).filter_by(building_id=b.id).order_by(models.NavGraph.id.desc()).first()
    return g.data if g else None


def latest_navmesh(b: models.Building):
    """Draft navmesh.json straight off disk — geometry-only, no DB row needed (unlike
    NavGraph, nothing else queries into it relationally)."""
    f = ws_dir(b) / "out" / "navmesh.json"
    if not f.exists():
        return None
    return json.loads(f.read_text())


def recompute_step_free(db: Session, b: models.Building):
    nav = latest_nav(db, b)
    if not nav: return
    arr = (b.pipeline_config or {}).get("arrival_poi")
    pois = db.query(models.POI).filter_by(building_id=b.id).all()
    src = next((p for p in pois if p.key == arr), None) or next((p for p in pois if p.category == "parking" and p.published), None)
    reach = navgraph.step_free_reachable(nav, src.nearest_node if src else None)
    for p in pois:
        p.step_free_auto = p.nearest_node in reach
    db.commit()
