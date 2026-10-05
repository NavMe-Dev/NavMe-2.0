"""Admin scan-planning API: upload CAD/floor drawings, auto-place Matterport scan points, export CSV/PDF."""
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, Query
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session
from ..auth import current_admin, oauth2
from ..config import get_settings
from ..db import get_db
from ..services import scan_plan as sp

router = APIRouter(prefix="/api/v1/admin/scan-plans", tags=["scan-plans"], dependencies=[Depends(current_admin)])

# Binary assets loaded by <img> (no Authorization header) — accept ?token= like building files.
files_router = APIRouter(prefix="/api/v1/admin/scan-plans", tags=["scan-plans"])


def _data():
    return get_settings().data_dir


def _plan_or_404(plan_id: str):
    try:
        return sp.get_plan(_data(), plan_id)
    except FileNotFoundError:
        raise HTTPException(404, "unknown scan plan")


@router.get("")
def list_plans():
    return sp.list_plans(_data())


@router.post("")
def create_plan(body: dict):
    name = (body or {}).get("name") or "Untitled scan plan"
    return sp.create_plan(_data(), name)


@router.get("/{plan_id}")
def get_plan(plan_id: str):
    return _plan_or_404(plan_id)


@router.delete("/{plan_id}")
def delete_plan(plan_id: str):
    _plan_or_404(plan_id)
    sp.delete_plan(_data(), plan_id)
    return {"deleted": plan_id}


@router.post("/{plan_id}/upload")
async def upload(plan_id: str, file: UploadFile = File(...)):
    _plan_or_404(plan_id)
    raw = await file.read()
    if len(raw) > (get_settings().max_upload_mb << 20):
        raise HTTPException(413, "file too large")
    try:
        return sp.ingest_upload(_data(), plan_id, file.filename or "upload.bin", raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.post("/{plan_id}/scale")
def scale(plan_id: str, body: dict):
    _plan_or_404(plan_id)
    try:
        return sp.set_scale(_data(), plan_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{plan_id}/address")
def address_lookup(plan_id: str, body: dict):
    """Geocode a street address, fetch nearby OSM building footprints, save scale hint on the plan.

    Body: { address: string, osm_id?: int, osm_type?: "way"|"relation", provider?: "nominatim"|"esri",
            radius_m?: number, refresh?: bool }
    Returns: { meta, candidates }
    """
    _plan_or_404(plan_id)
    from ..services.address_footprint import AddressLookupError
    try:
        # Prefer Nominatim (OSS) for scan-plan; body.provider can force esri. Falls back inside service.
        return sp.apply_address_lookup(
            _data(), plan_id, body or {}, geocoder=(body or {}).get("provider") or "nominatim"
        )
    except AddressLookupError as e:
        raise HTTPException(e.status_code, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{plan_id}/scale-hint")
def scale_hint(plan_id: str, body: dict):
    """Apply footprint long/short side (or custom metres) as the scale line length.

    Body: { edge: "long"|"short"|"custom", meters?: number, x1,y1,x2,y2, confirm?: bool }
    Does not overwrite an existing scale unless confirm=true.
    """
    _plan_or_404(plan_id)
    try:
        return sp.apply_scale_hint(_data(), plan_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{plan_id}/walkable")
def walkable(plan_id: str, body: dict):
    _plan_or_404(plan_id)
    try:
        return sp.set_walkable(_data(), plan_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{plan_id}/generate")
def generate(plan_id: str, body: dict | None = None):
    _plan_or_404(plan_id)
    try:
        return sp.generate(_data(), plan_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))




@router.post("/{plan_id}/auto-generate")
def auto_generate(plan_id: str, body: dict | None = None):
    """Estimate scale when unknown (area / footprint / existing), then generate Pro3 points.

    Body (all optional): { area_m2, assume_area_m2, px_per_m, spacing_m, clearance_m,
    los_filter, capture_s, walk_mps, overhead_s, floor, confirm? }.
    If scale is already set and points exist, require confirm=true to overwrite.
    """
    _plan_or_404(plan_id)
    try:
        return sp.auto_generate(_data(), plan_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.patch("/{plan_id}/points")
def patch_points(plan_id: str, body: dict):
    _plan_or_404(plan_id)
    try:
        return sp.update_points(_data(), plan_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/{plan_id}/export.csv")
def export_csv(plan_id: str):
    _plan_or_404(plan_id)
    name, data = sp.export_csv(_data(), plan_id)
    return Response(data, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/{plan_id}/export.pdf")
def export_pdf(plan_id: str):
    _plan_or_404(plan_id)
    try:
        name, data = sp.export_pdf(_data(), plan_id)
    except Exception as e:
        raise HTTPException(500, f"PDF export failed: {e}")
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@files_router.get("/{plan_id}/preview.png")
def preview_png(plan_id: str, token: str | None = None, overlay: int = Query(1),
                hdr: str | None = Depends(oauth2), db: Session = Depends(get_db)):
    current_admin(hdr or token, db)
    meta = _plan_or_404(plan_id)
    d = sp.plan_dir(_data(), plan_id)
    if overlay and (d / "overlay.png").is_file():
        return FileResponse(d / "overlay.png", media_type="image/png")
    if meta.get("preview") and (d / meta["preview"]).is_file():
        return FileResponse(d / meta["preview"], media_type="image/png")
    raise HTTPException(404, "no preview")


@files_router.get("/{plan_id}/walkable.png")
def walkable_png(plan_id: str, token: str | None = None,
                 hdr: str | None = Depends(oauth2), db: Session = Depends(get_db)):
    current_admin(hdr or token, db)
    _plan_or_404(plan_id)
    f = sp.plan_dir(_data(), plan_id) / "walkable.png"
    if not f.is_file():
        raise HTTPException(404, "no walkable mask")
    return FileResponse(f, media_type="image/png")
