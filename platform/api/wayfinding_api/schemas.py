from typing import Any
from pydantic import BaseModel, Field


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class VenueIn(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,78}$")
    name: str
    description: str | None = None
    branding: dict = {}


class BuildingIn(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,78}$")
    name: str
    address: str | None = None
    lat: float | None = None
    lon: float | None = None
    matterport_model_id: str | None = None
    sdk_key_ref: str | None = "MATTERPORT_SDK_KEY"
    venue_slug: str | None = None
    matterpak_path: str | None = None
    pipeline_config: dict = {}
    branding: dict = {}


class BuildingPatch(BaseModel):
    name: str | None = None
    address: str | None = None
    lat: float | None = None
    lon: float | None = None
    matterport_model_id: str | None = None
    sdk_key_ref: str | None = None
    venue_slug: str | None = None
    matterpak_path: str | None = None
    pipeline_config: dict | None = None
    branding: dict | None = None


class FloorIn(BaseModel):
    fid: str
    label: str
    short_label: str
    ordinal: int
    elevation_m: float
    height_m: float


class POIIn(BaseModel):
    key: str | None = None
    name: str
    category: str = "room"
    floor: str
    lon: float | None = None
    lat: float | None = None
    model_x: float | None = None
    model_y: float | None = None
    model_z: float | None = None
    code: str | None = None
    nearest_node: str | None = None
    step_free: bool | None = None
    hours: str | None = None
    description: str | None = None
    photo_url: str | None = None
    published: bool = True
    extra: dict = {}


class POIPatch(BaseModel):
    name: str | None = None
    category: str | None = None
    floor: str | None = None
    lon: float | None = None
    lat: float | None = None
    code: str | None = None
    nearest_node: str | None = None
    step_free: bool | None = None
    clear_step_free: bool = False
    hours: str | None = None
    description: str | None = None
    photo_url: str | None = None
    published: bool | None = None
    extra: dict | None = None


class ControlPointIn(BaseModel):
    model_x: float
    model_y: float
    lat: float
    lon: float
    label: str | None = None
    enabled: bool = True
    source: str = "manual"


class GeorefFineTune(BaseModel):
    """Adjust current transform: shift (metres east/north) and rotate (deg CCW) about the model centre."""
    d_east_m: float = 0
    d_north_m: float = 0
    d_rot_deg: float = 0
    auto_rebuild: bool = False


class JobIn(BaseModel):
    steps: list[str] | None = None
    from_step: str | None = None
    force: bool = False


class RouteIn(BaseModel):
    from_key: str
    to_key: str
    step_free: bool = False
    draft: bool = True


class RouteAccessPreviewIn(BaseModel):
    """Admin Access tab: compare full draft graph vs excluded-edges filter (no publish)."""
    from_key: str
    to_key: str
    step_free: bool = False
    excluded_edge_ids: list[str] | None = None  # current UI selection; None → draft access config


class PublishIn(BaseModel):
    notes: str | None = None
