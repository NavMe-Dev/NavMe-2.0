"""Publishing: freeze the current workspace artefacts + DB edits into an immutable, versioned bundle
<DATA_DIR>/published/<slug>/v<N>/ that the public API (and the static export) serve."""
import json, shutil
from pathlib import Path
from geoalchemy2.shape import to_shape
from sqlalchemy.orm import Session
from ..config import get_settings
from .. import models
from .workspace import ws_dir

COPY_SKIP = {"building.json"}

def _media_src_to_published(src: str, slug: str, copied_names: set[str]) -> str:
    """Map draft admin media URLs / relative media/ paths to published relative paths."""
    if not src:
        return src
    s = str(src).strip()
    # Already relative under published data
    if s.startswith("media/"):
        return s
    # Admin draft: /api/v1/admin/buildings/<slug>/media/<file>
    marker = f"/api/v1/admin/buildings/{slug}/media/"
    if marker in s:
        name = s.split(marker, 1)[1].split("?", 1)[0]
        if name in copied_names or True:
            return f"media/{Path(name).name}"
    # Absolute same-origin path ending in media/file
    if "/media/" in s and not s.startswith("http"):
        name = s.rsplit("/media/", 1)[-1].split("?", 1)[0]
        if name:
            return f"media/{Path(name).name}"
    return s


def write_media_panels(b: models.Building, dest: Path):
    """Freeze pipeline_config.media_panels (+ referenced local files) into the publish bundle."""
    panels_in = list((b.pipeline_config or {}).get("media_panels") or [])
    media_src = ws_dir(b) / "media"
    media_dest = dest / "media"
    copied: set[str] = set()
    if media_src.is_dir():
        media_dest.mkdir(parents=True, exist_ok=True)
        for f in media_src.iterdir():
            if f.is_file():
                shutil.copy2(f, media_dest / f.name)
                copied.add(f.name)
    out = []
    for p in panels_in:
        if not isinstance(p, dict):
            continue
        if p.get("published") is False:
            continue
        rec = dict(p)
        rec.pop("draft", None)
        kind = str(rec.get("kind") or "image").lower()
        if kind not in ("image", "video", "text"):
            kind = "image"
        rec["kind"] = kind
        if rec.get("src"):
            rec["src"] = _media_src_to_published(rec["src"], b.slug, copied)
        if rec.get("poster"):
            rec["poster"] = _media_src_to_published(rec["poster"], b.slug, copied)
        # Normalize optional CTA buttons: [{label, url}]
        buttons_in = rec.get("buttons") or rec.get("ctas") or []
        buttons_out = []
        if isinstance(buttons_in, list):
            for btn in buttons_in:
                if not isinstance(btn, dict):
                    continue
                label = str(btn.get("label") or btn.get("text") or "").strip()
                url = str(btn.get("url") or btn.get("href") or "").strip()
                if label and url:
                    buttons_out.append({"label": label, "url": url})
        if buttons_out:
            rec["buttons"] = buttons_out
        else:
            rec.pop("buttons", None)
        rec.pop("ctas", None)
        # Content required: image/video need src; text needs body (src optional)
        body = rec.get("body")
        if body is None:
            body = rec.get("text")
        if kind == "text":
            if body is not None:
                rec["body"] = str(body)
            has_content = bool(str(rec.get("body") or "").strip()) or bool(rec.get("src"))
            if not has_content and not buttons_out:
                continue
        else:
            if not rec.get("src"):
                continue
            # Drop text-only fields on image/video
            rec.pop("body", None)
            rec.pop("text", None)
        m = rec.get("model") or {}
        if m.get("x") is None or m.get("y") is None:
            continue
        out.append(rec)
    (dest / "media_panels.json").write_text(
        json.dumps({"schema": "wayfinding.media_panels/v1", "building": b.slug, "panels": out}, indent=1)
    )
    return out



def poi_json(p: models.POI):
    pt = to_shape(p.geom) if p.geom is not None else None
    sf = p.step_free if p.step_free is not None else bool(p.step_free_auto)
    return {"id": p.key, "name": p.name, "code": p.code, "category": p.category, "floor": p.floor,
            "model": {"x": p.model_x, "y": p.model_y, "z": p.model_z}, "lonlat": [round(pt.x, 8), round(pt.y, 8)] if pt else None,
            "nearest_node": p.nearest_node, "nearest_sweep_label": p.nearest_sweep_label, "room_id": p.room_id,
            "area_m2": (p.extra or {}).get("area_m2"), "step_free_from_parking": sf, "step_free_source": "admin" if p.step_free is not None else "graph",
            "hours": p.hours, "description": p.description, "note": p.description, "photo_url": p.photo_url, "source": p.source}


def build_bundle(db: Session, b: models.Building, dest: Path, published_only=True):
    src = ws_dir(b) / "out"
    if not (src / "config.json").exists():
        raise RuntimeError("building has no pipeline output yet – run onboarding first")
    if dest.exists(): shutil.rmtree(dest)
    shutil.copytree(src, dest, ignore=lambda d, names: [n for n in names if n in COPY_SKIP])
    q = db.query(models.POI).filter_by(building_id=b.id)
    pois = [poi_json(p) for p in q.order_by(models.POI.floor, models.POI.name) if (p.published or not published_only) and p.geom is not None]
    (dest / "pois.json").write_text(json.dumps({"schema": "wayfinding.pois/v1", "building": b.name, "pois": pois}, indent=1))
    by_room = {p["room_id"]: p for p in pois if p.get("room_id")}
    cfg = json.loads((dest / "config.json").read_text())
    fl = {f.fid: f for f in b.floors}
    for f in cfg["floors"]:
        if f["id"] in fl:
            f["label"] = fl[f["id"]].label; f["short"] = fl[f["id"]].short_label; f["ordinal"] = fl[f["id"]].ordinal
    cfg["floors"].sort(key=lambda f: f["ordinal"])
    cfg.update(name=b.name, address=b.address, slug=b.slug, branding=b.branding or {}, matterport_model_id=b.matterport_model_id,
               venue=b.venue.slug if b.venue else None, sdk_key_configured=bool(get_settings().matterport_sdk_key),
               vps_enabled=bool(get_settings().vps_url))
    cfg["stats"]["pois"] = len(pois)
    panels = write_media_panels(b, dest)
    cfg["media_panels"] = panels
    files = cfg.setdefault("files", {})
    files["media_panels"] = "media_panels.json"
    cfg["stats"]["media_panels"] = len(panels)
    # Interior tour modes (admin Tour tab → pipeline_config.tour_modes)
    tm_in = dict((b.pipeline_config or {}).get("tour_modes") or {})
    has_glb = (dest / "model_full.glb").exists() or any(dest.glob("model_F*.glb"))
    if (dest / "model_glb.json").exists():
        files.setdefault("model_glb", "model_glb.json")
    tour_modes = {
        "embed_showcase": tm_in.get("embed_showcase", True) is not False,
        "mesh_tour": bool(tm_in.get("mesh_tour")),
        "bundle_scene": bool(tm_in.get("bundle_scene")),
        "bundle_camera": "dollhouse",  # Matterport docs: free-cam only in dollhouse
        "bundle_configured": bool(str(tm_in.get("bundle_url") or "").strip()),
        "has_glb": has_glb,
    }
    if str(tm_in.get("bundle_url") or "").strip():
        tour_modes["bundle_url"] = str(tm_in["bundle_url"]).strip()
    if str(tm_in.get("bundle_note") or "").strip():
        tour_modes["bundle_note"] = str(tm_in["bundle_note"]).strip()
    cfg["tour_modes"] = tour_modes
    cfg["has_glb"] = has_glb
    cfg["stats"]["has_glb"] = has_glb
    # Access (twin/Tour gate + restricted routing). Never publish PIN / hash.
    from . import access as access_svc
    access_in = (b.pipeline_config or {}).get("access") or {}
    access_pub = access_svc.public_access_view(access_in if isinstance(access_in, dict) else {})
    cfg["access"] = access_pub
    # Filter published nav_graph edges (draft workspace graph stays full)
    nav_path = dest / "nav_graph.json"
    if nav_path.is_file() and access_pub.get("routing", {}).get("mode") == "exclude_edges":
        try:
            nav = json.loads(nav_path.read_text())
            filtered = access_svc.apply_routing_filter(nav, access_in if isinstance(access_in, dict) else {})
            nav_path.write_text(json.dumps(filtered, separators=(",", ":")))
            if isinstance(filtered.get("stats"), dict):
                cfg["stats"]["nav_edges"] = filtered["stats"].get("nav_edges", cfg["stats"].get("nav_edges"))
                if "excluded_edges" in filtered["stats"]:
                    cfg["stats"]["excluded_edges"] = filtered["stats"]["excluded_edges"]
        except Exception:
            pass  # keep unfiltered graph if parse fails; access still frozen
    # Debug mode (global + per-building override). Viewers also poll /api/v1/public/debug/status for live flips.
    from . import debug_log as dbg
    cfg["debug"] = bool(dbg.effective_enabled(pipeline_config=b.pipeline_config))
    cfg["debug_scope"] = "published_hint"  # live source of truth is public debug/status
    (dest / "config.json").write_text(json.dumps(cfg, indent=1))
    for f in cfg["floors"]:
        p = dest / f"indoor_{f['id']}.geojson"
        if not p.exists(): continue
        fc = json.loads(p.read_text())
        feats = []
        for ft in fc["features"]:
            pr = ft["properties"]
            if pr.get("feature_type") == "anchor": continue
            if pr.get("mp_room_id") and pr["mp_room_id"] in by_room:
                poi = by_room[pr["mp_room_id"]]; pr.update(name=poi["name"], poi_id=poi["id"], display_category=poi["category"])
            if pr.get("feature_type") == "level":
                pr["name"] = f"{b.name} – {f['label']}"; pr["level_name"] = f["label"]
            feats.append(ft)
        for poi in pois:
            if poi["floor"] == f["id"]:
                feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": poi["lonlat"]},
                              "properties": {"level_id": f["id"], "feature_type": "anchor", "category": poi["category"], "style": "anchor",
                                             "name": poi["name"], "poi_id": poi["id"], "floor_z": poi["model"]["z"]}})
        fc["features"] = feats
        p.write_text(json.dumps(fc, separators=(",", ":")))
    return cfg


def publish(db: Session, b: models.Building, user: str | None, notes: str | None):
    last = db.query(models.MapVersion).filter_by(building_id=b.id).order_by(models.MapVersion.version.desc()).first()
    ver = (last.version if last else 0) + 1
    dest = get_settings().published_dir / b.slug / f"v{ver}"
    cfg = build_bundle(db, b, dest)
    db.query(models.MapVersion).filter_by(building_id=b.id).update({"is_current": False})
    mv = models.MapVersion(building_id=b.id, version=ver, notes=notes, created_by=user, path=str(dest), is_current=True,
                           summary={"pois": cfg["stats"]["pois"], "floors": len(cfg["floors"]), "nav_nodes": cfg["stats"]["nav_nodes"]})
    db.add(mv); b.status = "published"; db.commit()
    return mv


def current_version(db: Session, b: models.Building):
    return db.query(models.MapVersion).filter_by(building_id=b.id, is_current=True).order_by(models.MapVersion.version.desc()).first()


def rollback(db: Session, b: models.Building, version: int):
    mv = db.query(models.MapVersion).filter_by(building_id=b.id, version=version).first()
    if not mv: raise ValueError("no such version")
    db.query(models.MapVersion).filter_by(building_id=b.id).update({"is_current": False}); mv.is_current = True; db.commit(); return mv
