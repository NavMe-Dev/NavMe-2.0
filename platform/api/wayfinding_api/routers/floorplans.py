"""Explicitly configured floor-plan review assets. No database operations."""
import json
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from ..config import get_settings

router = APIRouter(prefix="/api/v1/public/buildings", tags=["public"])
ROOT_FILES = {"floor-inventory.json", "building-metadata.json", "student-union-floorplans.pdf"}
FLOOR_FILES = {"floorplan.svg", "floorplan.png", "floorplan.geojson", "rooms.geojson", "corridors.geojson",
               "walls.geojson", "source-spaces.geojson", "circulation-evidence.geojson", "metadata.json",
               "label-plan.svg", "label-plan.json"}


@router.get("/{slug}/floorplans/{asset:path}")
def floorplan_asset(slug: str, asset: str):
    configured = get_settings().floorplan_dir
    if not configured:
        raise HTTPException(404, "floor-plan review is not enabled")
    root = configured.resolve()
    try:
        catalog = json.loads((root / "floor-inventory.json").read_text())
    except (OSError, ValueError):
        raise HTTPException(404, "floor plans unavailable") from None
    if slug != catalog.get("parent_building_slug"):
        raise HTTPException(404, "floor plans unavailable for this building")
    pieces = asset.split("/")
    allowed = asset in ROOT_FILES
    if len(pieces) == 3 and pieces[0] == "floors" and pieces[2] in FLOOR_FILES:
        allowed = bool(re.fullmatch(r"[A-Za-z0-9_-]+", pieces[1])) and any(
            f.get("floor_id") == pieces[1] for f in catalog.get("floors", []))
    if not allowed:
        raise HTTPException(404, "unknown floor-plan asset")
    target = (root / asset).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, "floor-plan asset unavailable")
    return FileResponse(target, headers={"Cache-Control": "private, max-age=30", "X-Content-Type-Options": "nosniff"})
