"""Model-bound camera views stored separately from POI marker/routing coordinates.

Each POI's existing ``extra`` JSONB keeps one record per Matterport model. The
normal application connection can save in writable installations. Read-only
deployments need a separately approved execute-only database capability; this
module never falls back to an owner credential or widens the old look-target
writer's permissions.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import logging
import math
import os
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from .. import models


logger = logging.getLogger(__name__)
ROLE = "navme_camera_viewpoint_writer"
SCHEMA = "navme_camera_viewpoint_private"
KEY = "camera_viewpoints"
SAVE_ERROR = "Couldn't save the viewpoint. Your previous saved view is unchanged."


class ViewpointError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message
        super().__init__(message)


class CameraPosition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float = Field(ge=-100000, le=100000)
    y: float = Field(ge=-100000, le=100000)
    z: float = Field(ge=-100000, le=100000)

    @field_validator("x", "y", "z", mode="before")
    @classmethod
    def real_number(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Camera coordinates must be numbers")
        return value


class CameraRotation(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    pitch: float = Field(ge=-90, le=90)
    yaw: float = Field(ge=-180, le=180)

    @field_validator("pitch", "yaw", mode="before")
    @classmethod
    def real_number(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Camera rotation must be numbers")
        return value


class CameraViewpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    sweep_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    camera_position: CameraPosition
    camera_rotation: CameraRotation
    floor_id: str | None = Field(default=None, max_length=80)
    captured_at: datetime

    @field_validator("floor_id")
    @classmethod
    def floor_identifier(cls, value):
        if value is not None and (not value.strip() or value != value.strip()):
            raise ValueError("Floor identifier must not be blank")
        return value

    @field_validator("captured_at", mode="before")
    @classmethod
    def explicit_timestamp(cls, value):
        if not isinstance(value, (str, datetime)):
            raise ValueError("Capture timestamp must be an ISO timestamp")
        return value

    @field_validator("captured_at")
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Capture timestamp must include a timezone")
        return value.astimezone(timezone.utc)


class CameraViewpointUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    viewpoint: CameraViewpoint | None
    revision: str = Field(max_length=40)

    @field_validator("revision")
    @classmethod
    def valid_revision(cls, value):
        if value != "default":
            try:
                if str(UUID(value)) != value:
                    raise ValueError()
            except ValueError:
                raise ValueError("Invalid viewpoint revision") from None
        return value

    @model_validator(mode="after")
    def same_model(self):
        if self.viewpoint is not None and self.viewpoint.model_id != self.model_id:
            raise ValueError("Viewpoint belongs to another Matterport model")
        return self


def _records(extra: Any) -> dict:
    values = extra.get(KEY) if isinstance(extra, dict) else None
    return values if isinstance(values, dict) else {}


def revision(extra: Any, model_id: str) -> str:
    record = _records(extra).get(model_id)
    candidate = record.get("revision") if isinstance(record, dict) else None
    try:
        if isinstance(candidate, str) and str(UUID(candidate)) == candidate:
            return candidate
    except ValueError:
        pass
    return "default"


def sanitize_viewpoint(value: Any, model_id: str | None) -> dict | None:
    """Validate an already-projected view at a public metadata boundary."""
    if not isinstance(value, dict):
        return None
    try:
        parsed = CameraViewpoint.model_validate(value)
    except ValueError:
        return None
    if parsed.model_id != model_id:
        return None
    return parsed.model_dump(mode="json")


def public_viewpoint(extra: Any, model_id: str | None) -> dict | None:
    """Return only a validated active-model view; never expose history/revision."""
    record = _records(extra).get(model_id)
    candidate = record.get("viewpoint") if isinstance(record, dict) else None
    return sanitize_viewpoint(candidate, model_id)


def status(extra: Any, model_id: str | None) -> str:
    if public_viewpoint(extra, model_id) is not None:
        return "saved"
    return "incompatible" if _records(extra) else "none"


def enabled(building) -> bool:
    model_id = getattr(building, "matterport_model_id", None)
    if not isinstance(model_id, str):
        return False
    # Use the same identifier bound as storage validation without accepting a
    # malformed active model just because a historical view exists.
    import re
    return re.fullmatch(r"[A-Za-z0-9_-]{1,40}", model_id) is not None


def read_only(cfg) -> bool:
    return bool(getattr(cfg, "wf_read_only", False) or getattr(cfg, "db_read_only", False))


def writer_allowed(cfg, building) -> bool:
    allowed = {part.strip() for part in str(getattr(cfg, "camera_viewpoint_buildings", "") or "").split(",") if part.strip()}
    return enabled(building) and ("*" in allowed or building.slug in allowed)


def writable(cfg, building) -> bool:
    if not enabled(building):
        return False
    if not read_only(cfg):
        return True
    return writer_allowed(cfg, building) and bool(getattr(cfg, "camera_viewpoint_database_url", ""))


def _marker_position(poi) -> dict | None:
    raw = [getattr(poi, "model_" + axis, None) for axis in ("x", "y", "z")]
    if not all(isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) for value in raw):
        return None
    x, y, z = raw
    if getattr(poi, "source", None) != "supabase":
        x, y, z = x, z, -y  # pipeline model Z-up -> SDK Y-up
    return {"x": x, "y": y, "z": z}


def admin_state(poi, model_id: str | None) -> dict:
    extra = getattr(poi, "extra", None) or {}
    return {
        "id": poi.id, "key": poi.key,
        "source_id": str(extra.get("gmap_src_id") or poi.key),
        "name": poi.name, "floor": poi.floor, "published": bool(poi.published),
        "position": _marker_position(poi),
        "viewpoint": public_viewpoint(extra, model_id),
        "revision": revision(extra, model_id), "status": status(extra, model_id),
        "history_model_ids": sorted(str(key) for key in _records(extra) if key != model_id),
    }


def response(poi_id: int, model_id: str, extra: dict) -> dict:
    return {"id": poi_id, "model_id": model_id, "viewpoint": public_viewpoint(extra, model_id),
            "revision": revision(extra, model_id), "status": status(extra, model_id)}


def updated_extra(extra: Any, inp: CameraViewpointUpdate) -> dict:
    """Pure, scoped mutation used after a row lock; leaves every other field intact."""
    if (extra is not None and not isinstance(extra, dict)) or (isinstance(extra, dict) and KEY in extra and not isinstance(extra[KEY], dict)):
        raise ViewpointError(422, "Invalid stored viewpoint. Reload locations before trying again.")
    original = extra if isinstance(extra, dict) else {}
    if inp.revision != revision(original, inp.model_id):
        raise ViewpointError(409, "This viewpoint changed in another tab. Reload locations before saving again.")
    wanted = inp.viewpoint.model_dump(mode="json") if inp.viewpoint is not None else None
    existing = public_viewpoint(original, inp.model_id)
    if wanted == existing and ((wanted is not None and revision(original, inp.model_id) != "default")
                               or (wanted is None and inp.model_id not in _records(original))):
        return deepcopy(original)
    result = deepcopy(original)
    records = deepcopy(_records(original))
    if wanted is None:
        records.pop(inp.model_id, None)
    else:
        records[inp.model_id] = {"viewpoint": wanted, "revision": str(uuid4())}
    if records:
        result[KEY] = records
    else:
        result.pop(KEY, None)
    return result


def write_local(db, building, poi_id: int, inp: CameraViewpointUpdate) -> dict:
    """Lock the selected model/POI and commit a JSON-only change, then read it back."""
    locked_building = (db.query(models.Building).filter_by(id=building.id)
                       .populate_existing().with_for_update(read=True).first())
    if locked_building is None or locked_building.matterport_model_id != inp.model_id:
        raise ViewpointError(409, "The Matterport model changed. Reload locations before capturing a new viewpoint.")
    poi = (db.query(models.POI).filter_by(id=poi_id, building_id=locked_building.id)
           .populate_existing().with_for_update().first())
    if poi is None:
        raise ViewpointError(404, "Location not found")
    new_extra = updated_extra(poi.extra, inp)
    if new_extra == (poi.extra or {}):
        return response(poi.id, inp.model_id, new_extra)
    try:
        # Suppress the POI timestamp's ORM onupdate default. Capturing a camera
        # does not edit the marker, source metadata, publishing state or route.
        db.execute(update(models.POI).where(models.POI.id == poi.id).values(
            extra=new_extra, updated_at=models.POI.updated_at).execution_options(synchronize_session=False))
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.warning("Camera viewpoint commit failed")
        raise ViewpointError(503, SAVE_ERROR) from None
    try:
        db.refresh(poi, attribute_names=["extra"])
        actual = response(poi.id, inp.model_id, poi.extra)
        if actual["viewpoint"] != response(poi.id, inp.model_id, new_extra)["viewpoint"] or actual["revision"] != revision(new_extra, inp.model_id):
            raise ValueError()
    except (SQLAlchemyError, ValueError):
        raise ViewpointError(503, "Couldn't verify the saved viewpoint. Reload locations before trying again.") from None
    return actual


def connection_arguments(cfg) -> dict:
    """Only the dedicated role at the current application database may write."""
    try:
        source = make_url(cfg.database_url)
        target = make_url(cfg.camera_viewpoint_database_url)
        allowed_drivers = {"postgres", "postgresql", "postgresql+psycopg"}
        if source.drivername not in allowed_drivers or target.drivername not in allowed_drivers:
            raise ValueError()
        if not source.host or (source.host, source.port or 5432, source.database) != (target.host, target.port or 5432, target.database):
            raise ValueError()
        if source.host.endswith(".pooler.supabase.com"):
            project = (source.username or "").partition(".")[2]
            if not project or target.username != ROLE + "." + project:
                raise ValueError()
        elif target.username != ROLE:
            raise ValueError()
        if not target.password or set(target.query) - {"sslmode"} or target.query.get("sslmode", "require") not in {"require", "verify-full"}:
            raise ValueError()
        return dict(host=target.host, port=target.port or 5432, dbname=target.database,
                    user=target.username, password=target.password,
                    sslmode=target.query.get("sslmode", "require"), connect_timeout=8,
                    options="-c statement_timeout=8000 -c lock_timeout=3000",
                    application_name="navme-camera-viewpoint", prepare_threshold=None)
    except Exception:
        raise ViewpointError(503, "Camera viewpoint saving is not configured") from None


def write_restricted(cfg, building, poi_id: int, inp: CameraViewpointUpdate) -> dict:
    if not writer_allowed(cfg, building) or not getattr(cfg, "camera_viewpoint_database_url", ""):
        raise ViewpointError(503, "Camera viewpoint saving is unavailable until database access is configured")
    if building.matterport_model_id != inp.model_id:
        raise ViewpointError(409, "The Matterport model changed. Reload locations before capturing a new viewpoint.")
    args = connection_arguments(cfg)
    try:
        if any(os.environ.get(key) for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE")):
            raise ViewpointError(503, "Camera viewpoint saving is unavailable")
        with psycopg.connect(**args) as connection:
            if not connection.pgconn.ssl_in_use:
                raise ViewpointError(503, "Camera viewpoint saving is unavailable")
            result = connection.execute(
                "SELECT navme_camera_viewpoint_private.set_viewpoint(%s,%s,%s,%s,%s)",
                (building.slug, poi_id, inp.model_id,
                 Jsonb(inp.viewpoint.model_dump(mode="json")) if inp.viewpoint else None, inp.revision)).fetchone()[0]
            expected = inp.viewpoint.model_dump(mode="json") if inp.viewpoint else None
            if not isinstance(result, dict) or result.get("id") != poi_id or result.get("model_id") != inp.model_id or result.get("viewpoint") != expected:
                raise ViewpointError(503, SAVE_ERROR)
            if (result.get("status") not in {"saved", "none", "incompatible"}
                    or (expected is not None and (result.get("status") != "saved" or result.get("revision") == "default"))
                    or (expected is None and (result.get("status") == "saved" or result.get("revision") != "default"))):
                raise ViewpointError(503, SAVE_ERROR)
            # Revalidate the capability's response before commit; malformed output
            # rolls back rather than claiming that an unverified view was saved.
            CameraViewpointUpdate.model_validate({"model_id": inp.model_id, "viewpoint": result["viewpoint"], "revision": result.get("revision")})
            result = {key: result.get(key) for key in ("id", "model_id", "viewpoint", "revision", "status")}
        return result
    except ViewpointError:
        raise
    except (psycopg.Error, ValueError) as error:
        code = getattr(error, "sqlstate", None)
        known = {"P0002": (404, "Location not found"),
                 "40001": (409, "This viewpoint changed in another tab. Reload locations before saving again."),
                 "22023": (422, "Invalid captured viewpoint")}
        status_code, message = known.get(code, (503, SAVE_ERROR))
        logger.warning("Restricted camera viewpoint write failed (%s)", type(error).__name__)
        raise ViewpointError(status_code, message) from None
