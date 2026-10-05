"""Data model (PostgreSQL + PostGIS). Geometry columns are WGS84 (SRID 4326).
Large derived artefacts (nav graph, indoor GeoJSON, GLB, overlays) live as files in the building
workspace / published versions; the DB keeps editable data (buildings, floors, POIs, control points),
the latest nav graph as JSONB (for server-side routing / pgRouting export) and job/version records."""
from datetime import datetime, timezone
from sqlalchemy import (String, Integer, Float, Boolean, Text, DateTime, ForeignKey, UniqueConstraint, JSON, Index)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from geoalchemy2 import Geometry
from .db import Base


def now():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Venue(Base):
    """A campus / site grouping one or more buildings shown on one map."""
    __tablename__ = "venues"
    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    branding: Mapped[dict] = mapped_column(JSONB, default=dict)   # {title, primary_color, logo_url, default_style}
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    buildings: Mapped[list["Building"]] = relationship(back_populates="venue")


class Building(Base):
    """One Matterport model (MatterPak) = one building."""
    __tablename__ = "buildings"
    id: Mapped[int] = mapped_column(primary_key=True)
    venue_id: Mapped[int | None] = mapped_column(ForeignKey("venues.id", ondelete="SET NULL"))
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    address: Mapped[str | None] = mapped_column(String(300))
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    location = mapped_column(Geometry("POINT", srid=4326), nullable=True)
    matterport_model_id: Mapped[str | None] = mapped_column(String(40))
    sdk_key_ref: Mapped[str | None] = mapped_column(String(80), default="MATTERPORT_SDK_KEY")  # env var NAME, never the key
    matterpak_path: Mapped[str | None] = mapped_column(String(500))
    georef: Mapped[dict | None] = mapped_column(JSONB)             # latest georef.json (transform + residuals)
    pipeline_config: Mapped[dict] = mapped_column(JSONB, default=dict)  # extra pipeline options (stairs, elevators, georef mode, osm …)
    model_info: Mapped[dict] = mapped_column(JSONB, default=dict)  # Matterport name, dims, counts
    status: Mapped[str] = mapped_column(String(30), default="new")  # new|processing|ready|failed|published
    branding: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    venue: Mapped[Venue | None] = relationship(back_populates="buildings")
    floors: Mapped[list["Floor"]] = relationship(back_populates="building", cascade="all, delete-orphan", order_by="Floor.ordinal")


class Floor(Base):
    __tablename__ = "floors"
    __table_args__ = (UniqueConstraint("building_id", "fid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"), index=True)
    fid: Mapped[str] = mapped_column(String(20))               # F1, F2 …
    label: Mapped[str] = mapped_column(String(100))
    short_label: Mapped[str] = mapped_column(String(10))
    ordinal: Mapped[int] = mapped_column(Integer)
    elevation_m: Mapped[float] = mapped_column(Float, default=0.0)   # model z of the floor
    height_m: Mapped[float] = mapped_column(Float, default=3.0)
    mp_floor_id: Mapped[str | None] = mapped_column(String(40))
    building: Mapped[Building] = relationship(back_populates="floors")


class POI(Base):
    __tablename__ = "pois"
    __table_args__ = (UniqueConstraint("building_id", "key"), Index("ix_pois_geom", "geom", postgresql_using="gist"))
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(80))                 # stable id (poi_…), used by the viewer / deep links
    name: Mapped[str] = mapped_column(String(200))
    code: Mapped[str | None] = mapped_column(String(40))
    category: Mapped[str] = mapped_column(String(40), default="room")
    floor: Mapped[str] = mapped_column(String(20))
    geom = mapped_column(Geometry("POINT", srid=4326, spatial_index=False))
    model_x: Mapped[float | None] = mapped_column(Float)
    model_y: Mapped[float | None] = mapped_column(Float)
    model_z: Mapped[float | None] = mapped_column(Float)
    nearest_node: Mapped[str | None] = mapped_column(String(80))
    nearest_sweep_label: Mapped[str | None] = mapped_column(String(80))
    room_id: Mapped[str | None] = mapped_column(String(40))
    step_free: Mapped[bool | None] = mapped_column(Boolean)      # None = auto from graph
    step_free_auto: Mapped[bool | None] = mapped_column(Boolean)
    hours: Mapped[str | None] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    photo_url: Mapped[str | None] = mapped_column(String(500))
    published: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String(40), default="auto")   # auto|matterport_room|seed|admin|csv
    locked: Mapped[bool] = mapped_column(Boolean, default=False)      # edited by admin -> pipeline won't overwrite
    extra: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class ControlPoint(Base):
    __tablename__ = "control_points"
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"), index=True)
    model_x: Mapped[float] = mapped_column(Float)
    model_y: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    label: Mapped[str | None] = mapped_column(String(200))
    source: Mapped[str] = mapped_column(String(40), default="manual")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    residual_m: Mapped[float | None] = mapped_column(Float)


class NavGraph(Base):
    __tablename__ = "nav_graphs"
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"), index=True)
    data: Mapped[dict] = mapped_column(JSONB)
    stats: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class MapVersion(Base):
    __tablename__ = "map_versions"
    __table_args__ = (UniqueConstraint("building_id", "version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(200))
    path: Mapped[str] = mapped_column(String(500))
    summary: Mapped[dict] = mapped_column(JSONB, default=dict)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int | None] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40), default="onboard")   # onboard|rebuild|publish
    params: Mapped[dict] = mapped_column(JSONB, default=dict)          # {steps, from_step, force}
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)  # queued|running|succeeded|failed|cancelled
    step: Mapped[str | None] = mapped_column(String(40))
    steps: Mapped[dict] = mapped_column(JSONB, default=dict)           # per-step status
    log: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
