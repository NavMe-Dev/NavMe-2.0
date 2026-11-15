"""Exercise Studio reads through public routes without a database or network.

The fake query applies the real route's filters, so unpublished and unrelated
POIs cannot accidentally authorize source UUIDs in these regressions.
"""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
import urllib.request

from fastapi import HTTPException
import pytest

from wayfinding_api import models
from wayfinding_api.routers import public
from wayfinding_api.services import studio_live


def test_studio_explore_keeps_only_published_source_ids(environment, monkeypatch):
    from wayfinding_api.services import explore
    env = environment

    def metadata(cfg, building):
        assert env.db.expunged and env.db.closed
        assert cfg.supabase_url == "https://studio.invalid"
        return {"building_slug": building.slug, "facilities": [], "pois": [
            {"id": identifier, "name": "Current place"}
            for identifier in (PUBLISHED_ID, UNPUBLISHED_ID, OTHER_SOURCE_ID, "new-studio-id")]}

    monkeypatch.setattr(explore, "metadata", metadata)
    response = public.public_explore(env.building.slug, db=env.db)
    assert [p["id"] for p in json.loads(response.body)["pois"]] == [PUBLISHED_ID]


def test_unpublished_studio_explore_does_not_read_source(environment, monkeypatch):
    from wayfinding_api.services import explore
    environment.version = None

    def no_source(*args):
        pytest.fail("unpublished Explore must not read Studio")

    monkeypatch.setattr(explore, "metadata", no_source)
    response = public.public_explore(environment.building.slug, db=environment.db)
    assert json.loads(response.body)["pois"] == []


PUBLISHED_ID = "11111111-1111-4111-8111-111111111111"
UNPUBLISHED_ID = "22222222-2222-4222-8222-222222222222"
OTHER_SOURCE_ID = "33333333-3333-4333-8333-333333333333"
PRIVATE = "private-calibration-and-internal-data-must-not-be-public"


class MemoryQuery:
    def __init__(self, db, model, rows):
        self.db, self.model, self.rows = db, model, rows

    def filter_by(self, **filters):
        assert not self.db.closed, "query attempted after releasing the connection"
        self.db.filters.append((self.model, filters))
        return MemoryQuery(self.db, self.model, [row for row in self.rows
                           if all(getattr(row, key) == value for key, value in filters.items())])

    def first(self):
        assert not self.db.closed
        return self.rows[0] if self.rows else None

    def all(self):
        assert not self.db.closed
        return list(self.rows)


class MemorySession:
    def __init__(self, building, pois):
        self.building, self.pois = building, pois
        self.filters = []
        self.expunged = self.closed = False

    def query(self, model):
        assert not self.closed, "query attempted after releasing the connection"
        rows = [self.building] if model is models.Building else self.pois
        assert model in (models.Building, models.POI)
        return MemoryQuery(self, model, rows)

    def expunge_all(self):
        assert not self.closed, "detach loaded values before closing"
        self.expunged = True

    def close(self):
        assert self.expunged
        self.closed = True


def mirror(identifier, **overrides):
    values = dict(building_id=7, key="mirror-" + identifier, name="Published snapshot",
                  published=True, source="supabase", floor="Ground Floor", category="old category",
                  model_x=100, model_y=200, model_z=300, code="A101", hours="09:00–17:00",
                  description="Published description", photo_url="https://images.invalid/public.png",
                  internal_json={"credential": PRIVATE}, extra={
                      "gmap_src_id": identifier,
                      "names": {"en": "Published snapshot", "es": "Nombre publicado"},
                      "descriptions": {"en": "Published description", "es": "Descripcion publicada"},
                      "expected_pos_x": 21, "expected_pos_y": 22, "expected_pos_z": 23,
                      "studio_calibration": {"source_position": [1, 2, 3],
                                             "source_expected_position": [4, 5, 6], "private_note": PRIVATE},
                      "internal_json": {"credential": PRIVATE}, "api_key": PRIVATE,
                  })
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture
def environment(monkeypatch):
    cfg = SimpleNamespace(supabase_url="https://destination.invalid", supabase_anon_key="destination-test-key",
                          studio_supabase_url="https://studio.invalid", studio_supabase_anon_key="studio-test-key",
                          studio_live_buildings="uncc-main-campus")
    building = SimpleNamespace(id=7, slug="uncc-main-campus", pipeline_config={
        "navme_poi_type": "Uncc_Navme", "internal_json": {"credential": PRIVATE},
        "navme_categories": [{"id": "cat", "name": "Old category", "icon_key": "building2", "sort_order": 0,
                              "category_names": {"es": "Categoria publicada"}, "internal_json": PRIVATE}],
        "navme_stair_chains": [{"id": "stairs", "name": "Public stairs", "sweep_numbers": [1, 2],
                                "internal_json": PRIVATE}],
    }, branding={"private": PRIVATE}, model_info={"private": PRIVATE})
    db = MemorySession(building, [mirror(PUBLISHED_ID), mirror(UNPUBLISHED_ID, published=False),
                                  mirror(OTHER_SOURCE_ID, source="admin")])
    env = SimpleNamespace(cfg=cfg, building=building, db=db,
                          version=SimpleNamespace(path="unused", version=3))
    monkeypatch.setattr(public, "get_settings", lambda: cfg)
    monkeypatch.setattr(public, "current_version", lambda session, b: env.version)
    monkeypatch.setattr(public.bundle_storage, "local_version_dir", lambda *args: Path("/unused/published"))

    def read_bundle_file(root, slug, number, filename):
        assert db.expunged and db.closed, "release the database before file storage access"
        assert (slug, number, filename) == (building.slug, 3, "georef.json")
        return json.dumps({"coordinate_system": "matterport-sdk-y-up"}).encode()

    monkeypatch.setattr(public.bundle_storage, "read_bundle_file", read_bundle_file)

    def no_network(*args, **kwargs):
        pytest.fail("unmocked external request from a pure route test")

    monkeypatch.setattr(urllib.request, "urlopen", no_network)
    studio_live._slots.clear()
    yield env
    studio_live._slots.clear()


def invoke(route, env):
    if route == "pois":
        return public.dashboard_navme_pois(env.building.slug, request=None, db=env.db)
    functions = {"viewer": public.dashboard_viewer_data, "translations": public.building_translations,
                 "categories": public.dashboard_navme_categories, "markers": public.category_marker_data,
                 "floors": public.building_navme_floors, "experience": public.building_ar_experience_ref}
    return functions[route](env.building.slug, db=env.db)


@pytest.mark.parametrize("route", ["pois", "viewer", "translations", "categories", "markers", "floors", "experience"])
def test_unpublished_building_is_gated_before_studio_or_poi_access(environment, monkeypatch, route):
    env = environment
    env.version = None

    def no_studio(*args, **kwargs):
        pytest.fail("an unpublished building must never read Studio")

    monkeypatch.setattr(studio_live, "load", no_studio)
    monkeypatch.setattr(studio_live.navme_sync, "fetch_rows", no_studio)
    if route == "viewer":
        with pytest.raises(HTTPException) as exc:
            invoke(route, env)
        assert exc.value.status_code == 404
    else:
        response = invoke(route, env)
        assert PUBLISHED_ID not in json.dumps(response)
        if route in ("pois", "categories"):
            assert response == []
        elif route == "translations":
            assert response == {"poi_names": {}, "category_names": {}}
        elif route == "markers":
            assert response == {"building_slug": env.building.slug, "categories": [], "pois": []}
        elif route == "floors":
            assert response == {"floors": []}
        else:
            assert all(value is None for value in response.values())
    assert not any(model is models.POI for model, _ in env.db.filters)


@pytest.mark.parametrize("route,destination_configured", [("pois", True), ("viewer", True), ("translations", True),
                                                        ("categories", True), ("markers", True), ("translations", False)])
def test_routes_read_fresh_public_studio_data_only_after_releasing_published_projection(environment, monkeypatch, route, destination_configured):
    env = environment
    if not destination_configured:
        env.cfg.supabase_url = env.cfg.supabase_anon_key = ""
    reads, projections = [], []
    source_rows = {
        "navme_pois": [{"id": identifier, "poi_type": "Uncc_Navme", "is_active": True,
                        "poi_name": "Current Studio room", "poi_names": {"en": "Old English", "es": "Sala actual"},
                        "description": "Current Studio details", "descriptions": {"es": "Detalles actuales"},
                        "pos_x": 1, "pos_y": 2, "pos_z": 3,
                        "expected_pos_x": 4, "expected_pos_y": 5, "expected_pos_z": 6,
                        "category_type": "cat", "category_types": ["cat"], "floor_id": "floor",
                        "api_key": PRIVATE, "internal_json": {"credential": PRIVATE}}
                       for identifier in (PUBLISHED_ID, UNPUBLISHED_ID, OTHER_SOURCE_ID)],
        "navme_categories": [{"id": "cat", "poi_type": "Uncc_Navme", "name": "Current Studio building",
                              "category_names": {"es": "Edificio actual"}, "icon_key": "building2", "sort_order": 1,
                              "internal_json": PRIVATE}],
        "navme_floors": [{"id": "floor", "poi_type": "Uncc_Navme", "name": "Current floor"}],
    }

    def fetch(source, table, filters, **options):
        assert env.db.expunged and env.db.closed, "do not retain a DB connection during Studio HTTP reads"
        assert source.supabase_url == "https://studio.invalid"
        assert source.supabase_anon_key == "studio-test-key"
        assert filters["poi_type"] == "eq.Uncc_Navme"
        if table == "navme_pois":
            assert filters["id"] == "in.(" + PUBLISHED_ID + ")"
        reads.append(table)
        return deepcopy(source_rows[table])

    actual_load = studio_live.load

    def load(cfg, building, published):
        assert env.db.expunged and env.db.closed
        projections.append(deepcopy(published))
        return actual_load(cfg, building, published)

    monkeypatch.setattr(studio_live.navme_sync, "fetch_rows", fetch)
    monkeypatch.setattr(studio_live, "load", load)
    result = invoke(route, env)
    assert len(projections) == 1
    assert [poi["id"] for poi in projections[0]] == [PUBLISHED_ID]
    assert projections[0][0]["_studio_calibration"]["source_position"] == [1, 2, 3]
    assert "api_key" not in projections[0][0]
    assert "internal_json" not in projections[0][0]
    assert (models.POI, {"building_id": 7, "source": "supabase", "published": True}) in env.db.filters
    assert sorted(reads) == ["navme_categories", "navme_floors", "navme_pois"]
    serialized = json.dumps(result)
    assert PRIVATE not in serialized
    assert "_studio_calibration" not in serialized
    assert UNPUBLISHED_ID not in serialized and OTHER_SOURCE_ID not in serialized
    assert env.cfg.supabase_url == ("https://destination.invalid" if destination_configured else ""), \
        "source selection must not mutate shared settings"

    if route == "translations":
        assert result == {"poi_names": {PUBLISHED_ID: {"en": "Current Studio room", "es": "Sala actual"}},
                          "category_names": {"cat": {"en": "Current Studio building", "es": "Edificio actual"}}}
    elif route == "categories":
        assert result[0]["name"] == "Current Studio building"
        assert result[0]["names"]["es"] == "Edificio actual"
    elif route == "markers":
        assert result["pois"] == [{"id": PUBLISHED_ID, "venue": env.building.slug, "category_ids": ["cat"],
                                   "x": 100, "y": 200, "z": 300, "is_active": True}]
        assert result["categories"][0]["name"] == "Current Studio building"
    else:
        pois = result if route == "pois" else result["pois"]
        assert len(pois) == 1
        assert pois[0]["name"] == "Current Studio room"
        assert pois[0]["names"]["en"] == "Current Studio room"
        assert pois[0]["description"] == "Current Studio details"
        assert pois[0]["descriptions"]["es"] == "Detalles actuales"
        assert pois[0]["category"] == "current studio building"
        assert pois[0]["floor"] == "Current floor"
        assert [pois[0][axis] for axis in ("x", "y", "z")] == [100, 200, 300]
        if route == "viewer":
            assert set(result) == {"building_slug", "pois", "categories", "stair_chains", "georef"}
            assert result["georef"]["coordinate_system"] == "matterport-sdk-y-up"


@pytest.mark.parametrize("route", ["pois", "viewer"])
@pytest.mark.parametrize("scope", ["disabled-default", "other-building"])
def test_disabled_and_nonallowlisted_buildings_keep_public_snapshot_without_private_json(environment, monkeypatch, route, scope):
    env = environment
    if scope == "disabled-default":
        env.cfg.studio_live_buildings = ""
    else:
        env.building.slug = "gcu"
        env.building.pipeline_config["navme_poi_type"] = "GCU"

    def no_studio(*args, **kwargs):
        pytest.fail("default and nonallowlisted GCU publications must remain snapshots")

    monkeypatch.setattr(studio_live.navme_sync, "fetch_rows", no_studio)
    result = invoke(route, env)
    pois = result if route == "pois" else result["pois"]
    assert [poi["id"] for poi in pois] == [PUBLISHED_ID]
    assert pois[0]["name"] == "Published snapshot"
    assert pois[0]["description"] == "Published description"
    assert pois[0]["descriptions"]["es"] == "Descripcion publicada"
    assert [pois[0][axis] for axis in ("x", "y", "z")] == [100, 200, 300]
    assert [pois[0]["expected_pos_" + axis] for axis in ("x", "y", "z")] == [21, 22, 23]
    serialized = json.dumps(result)
    assert PRIVATE not in serialized
    assert "studio_calibration" not in serialized
    assert "internal_json" not in serialized
    assert "api_key" not in serialized
    if route == "viewer":
        assert result["categories"][0]["name"] == "Old category"
        assert result["stair_chains"] == [{"id": "stairs", "name": "Public stairs", "sweep_numbers": [1, 2]}]


@pytest.mark.parametrize("route,table", [("floors", "navme_floors"), ("experience", "navme_project_features")])
@pytest.mark.parametrize("scope", ["studio-unc", "studio-only-unc", "destination-gcu"])
def test_optional_metadata_routes_select_source_only_for_allowed_building_and_release_session(environment, monkeypatch, route, table, scope):
    env = environment
    allowed = scope != "destination-gcu"
    if scope == "studio-only-unc":
        env.cfg.supabase_url = env.cfg.supabase_anon_key = ""
    if not allowed:
        env.building.slug = "gcu"
        env.building.pipeline_config["navme_poi_type"] = "GCU"
    rows = ([{"id": "floor", "name": "Edited floor", "slice_y": 2.5, "sort_order": 0}]
            if route == "floors" else [{"experience_ref": "public-ref", "walkthrough_mode": "ar_first",
                                        "project_url": "https://ar.invalid/", "walkthrough_url": "https://viewer.invalid/"}])
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self):
            return json.dumps(rows).encode()

    def urlopen(request, **options):
        calls.append((request, env.db.expunged, env.db.closed))
        return Response()

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    result = invoke(route, env)
    assert len(calls) == 1
    request, expunged, closed = calls[0]
    assert expunged and closed
    source = "studio" if allowed else "destination"
    parsed = urlsplit(request.full_url)
    assert parsed.hostname == source + ".invalid"
    assert parsed.path == "/rest/v1/" + table
    assert parse_qs(parsed.query)["poi_type"] == [("eq.Uncc_Navme" if allowed else "ilike.GCU")]
    assert request.get_header("Apikey") == source + "-test-key"
    assert request.get_header("Authorization") == "Bearer " + source + "-test-key"
    assert env.cfg.supabase_url == ("" if scope == "studio-only-unc" else "https://destination.invalid")
    if route == "floors":
        assert result == {"floors": rows}
    else:
        assert result == {"experience_ref": "public-ref", "walkthrough_mode": "ar_first",
                          "ar_url": "https://ar.invalid/", "walkthrough_url": "https://viewer.invalid/"}
