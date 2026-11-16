"""Registered camera locations join public directories without widening Studio scope."""
from copy import deepcopy
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from wayfinding_api import models
from wayfinding_api.routers import public
from wayfinding_api.services import camera_viewpoints as views, studio_live


def camera(model="modelA", sweep="scanA"):
    return {"model_id": model, "sweep_id": sweep,
            "camera_position": {"x": 99.25, "y": 2.5, "z": -33.75},
            "camera_rotation": {"pitch": 7, "yaw": -140},
            "floor_id": "capture-floor", "captured_at": "2026-11-16T12:00:00Z"}


def saved(viewpoint=None):
    viewpoint = viewpoint or camera()
    return {viewpoint["model_id"]: {"viewpoint": viewpoint, "revision": str(uuid4())}}


def row(key, *, source="admin", viewpoint=None, **overrides):
    extra = {"api_key": "private-poi-secret", "internal": {"keep": True},
             "names": {"en": key, "es": "Sala"}}
    if source == "supabase":
        extra["gmap_src_id"] = key
    if viewpoint is not None:
        extra[views.KEY] = {**saved(camera("historicalModel", "oldScan")), **saved(viewpoint)}
    values = {"id": 1, "key": key, "building_id": 7, "name": key,
              "category": "room", "floor": "F1", "published": True, "source": source,
              "model_x": 10.5, "model_y": 20.25, "model_z": 1.75,
              "code": "R1", "description": "Room description", "hours": "09:00–17:00",
              "photo_url": "https://images.invalid/room.jpg", "extra": extra}
    values.update(overrides)
    return SimpleNamespace(**values)


class Query:
    def __init__(self, rows):
        self.rows = rows

    def filter_by(self, **filters):
        return Query([item for item in self.rows
                      if all(getattr(item, key) == value for key, value in filters.items())])

    def all(self):
        return list(self.rows)

    def first(self):
        return self.rows[0] if self.rows else None


class Database:
    def __init__(self, rows, building=None):
        self.rows, self.building = rows, building

    def query(self, model):
        if model is models.Building:
            return Query([self.building])
        assert model is models.POI
        return Query(self.rows)

    def expunge_all(self):
        pass

    def close(self):
        pass


@pytest.fixture
def building():
    return SimpleNamespace(id=7, slug="ordinary-campus", matterport_model_id="modelA",
                           pipeline_config={"navme_poi_type": "OrdinaryRooms"})


@pytest.fixture
def cfg():
    return SimpleNamespace(studio_live_buildings="ordinary-campus",
                           studio_supabase_url="https://studio.invalid", studio_supabase_anon_key="public-test-key")


@pytest.fixture(autouse=True)
def empty_cache():
    studio_live._slots.clear()
    yield
    studio_live._slots.clear()


def test_building_without_mirrors_uses_registered_public_locations_and_converts_only_marker_coordinates(building, cfg, monkeypatch):
    rows = [row("admin-room"), row("pipeline-room", source="matterport_room", viewpoint=camera()),
            row("draft-room", published=False, viewpoint=camera()),
            row("other-building", building_id=8, viewpoint=camera())]
    original = deepcopy([vars(item) for item in rows])
    monkeypatch.setattr(studio_live, "_fetch", lambda *args: pytest.fail("local rooms must not read Studio"))
    projected = public._dashboard_pois(building, Database(rows))
    data = studio_live.load(cfg, building, projected)["pois"]
    assert {item["id"] for item in data} == {"admin-room", "pipeline-room"}
    by_id = {item["id"]: item for item in data}
    assert [by_id["admin-room"][axis] for axis in ("x", "y", "z")] == [10.5, 1.75, -20.25]
    assert by_id["pipeline-room"]["camera_viewpoint"] == camera()
    assert by_id["pipeline-room"]["camera_viewpoint"]["camera_position"] != {
        axis: by_id["pipeline-room"][axis] for axis in ("x", "y", "z")
    }
    assert [vars(item) for item in rows] == original
    serialized = json.dumps(data)
    assert "_studio_source" not in serialized
    assert "private-poi-secret" not in serialized
    assert "historicalModel" not in serialized and "revision" not in serialized


def test_existing_mirror_directory_only_adds_local_locations_with_current_model_camera_views(building):
    mirror_id = str(uuid4())
    rows = [row(mirror_id, source="supabase"), row("new-captured-room", viewpoint=camera()),
            row("ordinary-local-room"), row("old-model-room", viewpoint=camera("otherModel")),
            row("draft-captured-room", viewpoint=camera(), published=False),
            row("other-building", viewpoint=camera(), building_id=8)]
    projected = public._dashboard_pois(building, Database(rows))
    assert {item["id"] for item in projected} == {mirror_id, "new-captured-room"}
    mirror = next(item for item in projected if item["id"] == mirror_id)
    assert [mirror[axis] for axis in ("x", "y", "z")] == [10.5, 20.25, 1.75]
    assert "_studio_source" not in mirror
    local = next(item for item in projected if item["id"] == "new-captured-room")
    assert local["_studio_source"] is False
    assert local["camera_viewpoint"] == camera()
    building.matterport_model_id = "changedModel"
    assert [item["id"] for item in public._dashboard_pois(building, Database(rows))] == [mirror_id]


def test_local_uuid_key_is_not_read_from_or_overwritten_by_studio(building, cfg, monkeypatch):
    mirror_id, local_id = str(uuid4()), str(uuid4())
    local = row(local_id, viewpoint=camera())
    # Source bookkeeping on an admin row must never change its public key.
    local.extra["gmap_src_id"] = str(uuid4())
    projected = public._dashboard_pois(building, Database([row(mirror_id, source="supabase"), local]))
    queried = []

    def fetch(source, b, identifiers):
        queried.append(set(identifiers))
        return {"pois": [
            {"id": identifier, "is_active": True, "poi_name": "Studio replacement",
             "pos_x": 100, "pos_y": 200, "pos_z": 300}
            for identifier in (mirror_id, local_id)
        ], "categories": [], "floors": []}

    monkeypatch.setattr(studio_live, "_fetch", fetch)
    data = studio_live.load(cfg, building, projected)["pois"]
    assert queried == [{mirror_id}]
    by_id = {item["id"]: item for item in data}
    assert by_id[mirror_id]["name"] == "Studio replacement"
    assert by_id[local_id]["name"] == local_id
    assert [by_id[local_id][axis] for axis in ("x", "y", "z")] == [10.5, 1.75, -20.25]
    assert by_id[local_id]["camera_viewpoint"] == camera()
    assert "_studio_source" not in json.dumps(data)


def test_local_uuid_only_directory_does_not_authorize_any_studio_reads(building, cfg, monkeypatch):
    local_id = str(uuid4())
    monkeypatch.setattr(studio_live, "_fetch", lambda *args: pytest.fail("local UUID is not a Studio identity"))
    result = studio_live.load(cfg, building, public._dashboard_pois(building, Database([row(local_id)])))
    assert [item["id"] for item in result["pois"]] == [local_id]


def test_local_camera_replacement_and_reset_change_the_cached_public_projection(building, cfg, monkeypatch):
    mirror_id = str(uuid4())
    local = row("captured-room", viewpoint=camera())
    db = Database([row(mirror_id, source="supabase"), local])
    reads = []

    def fetch(source, b, identifiers):
        reads.append(set(identifiers))
        return {"pois": [{"id": mirror_id, "is_active": True, "poi_name": "Mirror",
                          "pos_x": 1, "pos_y": 2, "pos_z": 3}], "categories": [], "floors": []}

    monkeypatch.setattr(studio_live, "_fetch", fetch)
    first = studio_live.load(cfg, building, public._dashboard_pois(building, db))
    assert next(item for item in first["pois"] if item["id"] == local.key)["camera_viewpoint"]["sweep_id"] == "scanA"
    local.extra[views.KEY]["modelA"] = saved(camera(sweep="replacementScan"))["modelA"]
    second = studio_live.load(cfg, building, public._dashboard_pois(building, db))
    assert next(item for item in second["pois"] if item["id"] == local.key)["camera_viewpoint"]["sweep_id"] == "replacementScan"
    local.extra[views.KEY].pop("modelA")
    reset = studio_live.load(cfg, building, public._dashboard_pois(building, db))
    assert [item["id"] for item in reset["pois"]] == [mirror_id]
    assert len(reads) == 3, "a changed local camera/membership must not reuse the previous Studio cache"


def test_camera_only_registered_location_preserves_null_marker_coordinates(building, cfg):
    local = row("camera-only-room", viewpoint=camera(), model_x=None, model_y=None, model_z=None)
    public_poi = studio_live.load(cfg, building, public._dashboard_pois(building, Database([local])))["pois"][0]
    assert not any(axis in public_poi for axis in ("x", "y", "z"))
    assert public_poi["camera_viewpoint"] == camera()


def test_camera_only_location_does_not_crash_or_invent_a_category_marker(building, cfg, monkeypatch):
    local = row("camera-only-room", viewpoint=camera(), model_x=None, model_y=None, model_z=None)
    monkeypatch.setattr(public, "get_settings", lambda: cfg)
    monkeypatch.setattr(public, "current_version", lambda *args: object())
    result = public.category_marker_data(building.slug, db=Database([local], building))
    assert result["building_slug"] == building.slug
    assert result["pois"] == []
