"""Read-only spatial evidence and authenticated, unpublished calibration drafts."""
from datetime import datetime, timezone
import json
import re
import tempfile
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat
from ..auth import current_admin
from ..config import get_settings
from ..services.plan_registration import load_context, fit_draft

router = APIRouter(prefix='/api/v1', tags=['floor-plan-navigation'])


class Anchor(BaseModel):
    model_config = ConfigDict(extra='forbid')
    diagram: tuple[FiniteFloat, FiniteFloat]
    sweep_id: str = Field(min_length=1, max_length=100)
    holdout: bool = False
    verified: bool
    evidence: str = Field(min_length=8, max_length=500)


class Draft(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_version: str = Field(pattern=r'^[a-f0-9]{64}$')
    sdk_floor_id: str = Field(min_length=1, max_length=100)
    floor_verified: bool
    floor_evidence: str = Field(min_length=8, max_length=1000)
    anchors: list[Anchor] = Field(min_length=6, max_length=40)


def context_for(slug):
    root = get_settings().floorplan_dir
    if not root:
        raise HTTPException(404, 'Floor navigation evidence unavailable')
    try:
        return load_context(Path(root), slug)
    except FileNotFoundError:
        raise HTTPException(404, 'Floor navigation evidence unavailable') from None
    except (OSError, ValueError, KeyError):
        raise HTTPException(409, 'Floor navigation evidence needs review') from None


def draft_path(slug, floor_id):
    context = context_for(slug)
    if floor_id not in context['floors'] or not re.fullmatch(r'[A-Za-z0-9_-]+', floor_id):
        raise HTTPException(404, 'Unknown floor')
    # Slug is accepted only after matching the configured evidence catalog.
    root = get_settings().data_dir.resolve() / 'floorplan-calibration-drafts'
    path = (root / slug / (floor_id+'.json')).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(404, 'Unknown building')
    return context, path


@router.get('/public/buildings/{slug}/floorplans/navigation/context')
def spatial_context(slug: str, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return context_for(slug)


@router.get('/admin/buildings/{slug}/floorplans/calibration/{floor_id}')
def get_draft(slug: str, floor_id: str, response: Response, admin=Depends(current_admin)):
    response.headers['Cache-Control'] = 'no-store'
    context, path = draft_path(slug, floor_id)
    if not path.exists():
        raise HTTPException(404, 'No saved draft for this floor')
    draft = json.loads(path.read_text())
    if draft['source_version'] != context['source_version']:
        raise HTTPException(409, 'Saved draft is stale')
    return draft


@router.put('/admin/buildings/{slug}/floorplans/calibration/{floor_id}')
def save_draft(slug: str, floor_id: str, body: Draft, admin=Depends(current_admin)):
    cfg = get_settings()
    if cfg.wf_read_only or cfg.db_read_only:
        raise HTTPException(503, 'Calibration drafts are disabled in read-only mode')
    context, path = draft_path(slug, floor_id)
    try:
        draft = fit_draft(context, floor_id, body.model_dump(mode='json'))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    draft.update(saved_at=datetime.now(timezone.utc).isoformat(), reviewed_by=admin.email)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic replacement of a draft file only. No POIs, published plans, model
    # tags or database records are modified by this route.
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, suffix='.tmp', delete=False) as stream:
        json.dump(draft, stream, allow_nan=False, indent=2)
        temporary = Path(stream.name)
    temporary.replace(path)
    return draft


@router.get('/public/buildings/{slug}/floorplans/navigation/version')
def spatial_version(slug: str, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    context = context_for(slug)
    return {'source_version': context['source_version']}
