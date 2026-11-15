"""Publication, privacy, freshness and calibration tests without database writes."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import logging
import threading
from types import SimpleNamespace
from uuid import uuid4

import pytest

from wayfinding_api.services import studio_live


@pytest.fixture(autouse=True)
def empty_cache():
    studio_live._slots.clear()
    yield
    studio_live._slots.clear()


@pytest.fixture
def settings():
    return SimpleNamespace(supabase_url="https://destination.invalid", supabase_anon_key="destination-test-key",
                           studio_supabase_url="https://studio.invalid/", studio_supabase_anon_key="studio-test-key",
                           studio_live_buildings="uncc-main-campus")


@pytest.fixture
def building():
    return SimpleNamespace(slug="uncc-main-campus", pipeline_config={
        "navme_poi_type": "Uncc_Navme",
        "navme_categories": [{"id": "old-category", "name": "Old category", "icon_key": "building2", "sort_order": 0}],
        "navme_stair_chains": [],
    })


def published(identifier=None, **values):
    return {"id": identifier or str(uuid4()), "name": "Published name", "category": "old category", "floor": "Ground",
            "x": 11, "y": 12, "z": 13, "expected_pos_x": 21, "expected_pos_y": 22, "expected_pos_z": 23, **values}


def row(identifier, **values):
    return {"id": identifier, "poi_type": "Uncc_Navme", "poi_name": "Current Studio name",
            "poi_names": {"en": "Current Studio name", "es": "Nombre actual"},
            "description": "Current description", "descriptions": {"en": "Current description", "es": "Descripcion"},
            "amenities_desc": "Accessible entrance", "highlight_desc": "Public highlight", "technology_desc": "Public technology",
            "icon_url": "https://images.invalid/public-icon.png", "pos_x": 1, "pos_y": 2, "pos_z": 3,
            "expected_pos_x": 4, "expected_pos_y": 5, "expected_pos_z": 6,
            "category_type": "cat", "category_types": ["cat", "other-cat"], "floor_id": "floor",
            "is_active": True, "translate_name": True, **values}


def mock_source(monkeypatch, rows, *, categories=None, floors=None, failing=None):
    calls = []
    data = {
        "navme_pois": rows,
        "navme_categories": categories if categories is not None else [
            {"id": "cat", "poi_type": "Uncc_Navme", "name": "Student Union", "category_names": {"es": "Union"}, "sort_order": 1, "icon_key": "building2"},
            {"id": "other-cat", "poi_type": "Uncc_Navme", "name": "Other category", "sort_order": 2},
        ],
        "navme_floors": floors if floors is not None else [{"id": "floor", "poi_type": "Uncc_Navme", "name": "First Floor"}],
    }
    def fetch(cfg, table, filters, **options):
        calls.append((cfg, table, filters, options))
        if table == failing:
            raise RuntimeError("sensitive-response-body-with-source-credential")
        return deepcopy(data[table])
    monkeypatch.setattr(studio_live.navme_sync, "fetch_rows", fetch)
    return calls, data


def test_source_is_opt_in_per_exact_building(settings, building, monkeypatch):
    def should_not_fetch(*args, **kwargs):
        pytest.fail("Disabled building must not read Studio")
    monkeypatch.setattr(studio_live.navme_sync, "fetch_rows", should_not_fetch)
    settings.studio_live_buildings = "uncc-main-campus-extra, *"
    original = published()
    assert not studio_live.enabled(settings, building)
    assert studio_live.metadata_settings(settings, building) is settings
    assert studio_live.load(settings, building, [original])["pois"][0]["name"] == "Published name"
    settings.studio_live_buildings = " other, uncc-main-campus "
    assert studio_live.enabled(settings, building)
    source = studio_live.metadata_settings(settings, building)
    assert source is not settings
    assert source.supabase_url == "https://studio.invalid"
    assert source.supabase_anon_key == "studio-test-key"
    assert settings.supabase_url == "https://destination.invalid"
    settings.studio_supabase_anon_key = ""
    assert not studio_live.enabled(settings, building)


def test_live_projection_updates_public_fields_only_for_published_ids(settings, building, monkeypatch):
    original = published()
    new_id = str(uuid4())
    calls, _ = mock_source(monkeypatch, [row(original["id"], created_by="private-owner", api_key="private-source-key"), row(new_id)])
    result = studio_live.load(settings, building, [original])
    assert [p["id"] for p in result["pois"]] == [original["id"]]
    current = result["pois"][0]
    assert current["name"] == "Current Studio name"
    assert current["names"]["es"] == "Nombre actual"
    assert current["description"] == "Current description"
    assert current["descriptions"]["es"] == "Descripcion"
    assert current["amenities_desc"] == "Accessible entrance"
    assert (current["category"], current["floor"]) == ("student union", "First Floor")
    assert current["category_ids"] == ["cat", "other-cat"]
    assert (current["x"], current["y"], current["z"]) == (1, 2, 3)
    assert result["categories"][0]["names"]["es"] == "Union"
    assert "private-source-key" not in json.dumps(result)
    assert "created_by" not in json.dumps(result)
    assert len(calls) == 3
    for cfg, table, filters, options in calls:
        assert cfg.supabase_url == "https://studio.invalid"
        assert filters["poi_type"] == "eq.Uncc_Navme"
        assert options["timeout"] == 4
        assert "*" not in filters["select"]
        assert "created_by" not in filters["select"] and "api_key" not in filters["select"]
        if table == "navme_pois":
            assert original["id"] in filters["id"] and new_id not in filters["id"]
            assert "descriptions" in filters["select"] and "poi_descriptions" not in filters["select"]
            assert "photo_url" not in filters["select"] and "hours" not in filters["select"]


@pytest.mark.parametrize("rows", [[], "inactive"])
def test_successful_source_read_removes_deleted_or_inactive_published_ids(settings, building, monkeypatch, rows):
    original = published()
    source = [] if rows == [] else [row(original["id"], is_active=False)]
    mock_source(monkeypatch, source)
    assert studio_live.load(settings, building, [original])["pois"] == []


def test_source_failure_preserves_snapshot_and_strips_private_fields(settings, building, monkeypatch, caplog):
    original = published(_studio_calibration={"source_position": [1, 2, 3]}, api_key="private-published-key",
                         extra={"secret": "private-extra"}, names={"en": "Published", "api_key": "private-translation"},
                         code="R1", hours="9 to 5", photo_url="https://images.invalid/published.jpg",
                         photo_urls=["https://images.invalid/second.jpg", "javascript:alert(1)"])
    building.pipeline_config["navme_categories"][0]["created_by"] = "private-owner"
    calls, _ = mock_source(monkeypatch, [], failing="navme_pois")
    with caplog.at_level(logging.WARNING):
        result = studio_live.load(settings, building, [original])
    current = result["pois"][0]
    assert current["name"] == "Published name" and current["code"] == "R1"
    assert current["hours"] == "9 to 5"
    assert current["photo_url"] == "https://images.invalid/published.jpg"
    assert current["photo_urls"] == ["https://images.invalid/second.jpg"]
    assert result["categories"][0]["name"] == "Old category"
    encoded = json.dumps(result)
    for forbidden in ["_studio_calibration", "api_key", "created_by", "private-published-key", "private-extra", "private-translation"]:
        assert forbidden not in encoded
    assert "RuntimeError" in caplog.text
    assert "sensitive-response-body" not in caplog.text
    assert "studio-test-key" not in caplog.text
    studio_live.load(settings, building, [original])
    assert len(calls) == 3, "Failures are cached briefly instead of hammering the source"


def test_cross_tenant_source_response_falls_back_without_exposing_it(settings, building, monkeypatch):
    original = published()
    mock_source(monkeypatch, [row(original["id"], poi_type="another-tenant", poi_name="Wrong tenant name")])
    result = studio_live.load(settings, building, [original])
    assert result["pois"][0]["name"] == "Published name"
    assert "Wrong tenant name" not in json.dumps(result)


def test_cache_refreshes_real_content_without_updated_at_timestamps(settings, building, monkeypatch):
    original = published()
    clock = [100.0]
    monkeypatch.setattr(studio_live.time, "monotonic", lambda: clock[0])
    calls, data = mock_source(monkeypatch, [row(original["id"])])
    first = studio_live.load(settings, building, [original])
    first["pois"][0]["name"] = "Caller mutation"
    data["navme_pois"][0].update(poi_name="Renamed without timestamp", description="New details", pos_x=9)
    data["navme_categories"][0]["name"] = "Renamed category"
    data["navme_floors"][0]["name"] = "Renamed floor"
    cached = studio_live.load(settings, building, [original])
    assert cached["pois"][0]["name"] == "Current Studio name" and len(calls) == 3
    clock[0] += 5.01
    fresh = studio_live.load(settings, building, [original])["pois"][0]
    assert fresh["name"] == "Renamed without timestamp"
    assert fresh["names"]["en"] == fresh["name"]
    assert fresh["description"] == "New details"
    assert (fresh["category"], fresh["floor"], fresh["x"]) == ("renamed category", "Renamed floor", 9)
    assert len(calls) == 6


def test_changed_publication_cannot_reuse_a_cache_with_extra_ids(settings, building, monkeypatch):
    first, second = published(), published()
    calls, _ = mock_source(monkeypatch, [row(first["id"]), row(second["id"])])
    assert len(studio_live.load(settings, building, [first, second])["pois"]) == 2
    assert [r["id"] for r in studio_live.load(settings, building, [first])["pois"]] == [first["id"]]
    assert len(calls) == 6


def test_source_reads_run_in_parallel_and_concurrent_viewers_share_one_snapshot(settings, building, monkeypatch):
    original = published()
    barrier = threading.Barrier(3, timeout=2)
    calls = []
    def fetch(cfg, table, filters, **options):
        calls.append(table)
        barrier.wait()
        if table == "navme_pois": return [row(original["id"])]
        if table == "navme_categories": return [{"id": "cat", "name": "Student Union"}]
        return [{"id": "floor", "name": "First Floor"}]
    monkeypatch.setattr(studio_live.navme_sync, "fetch_rows", fetch)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: studio_live.load(settings, building, [original]), range(4)))
    assert len(calls) == 3
    assert all(result["pois"][0]["name"] == "Current Studio name" for result in results)


def test_rounding_never_replaces_reviewed_coordinates_but_a_real_studio_move_does(settings, building, monkeypatch):
    original = published(_studio_calibration={"source_position": [1, 2, 3], "source_expected_position": [4, 5, 6]})
    clock = [10.0]
    monkeypatch.setattr(studio_live.time, "monotonic", lambda: clock[0])
    _, data = mock_source(monkeypatch, [row(original["id"], pos_x=1.0004, pos_y=2.0003,
                                          expected_pos_x=4.0004, expected_pos_y=5.0003)])
    current = studio_live.load(settings, building, [original])["pois"][0]
    assert [current[k] for k in ("x", "y", "z")] == [11, 12, 13]
    assert [current[k] for k in ("expected_pos_x", "expected_pos_y", "expected_pos_z")] == [21, 22, 23]
    data["navme_pois"][0].update(pos_x=1.05, expected_pos_x=4.05)
    clock[0] += 6
    current = studio_live.load(settings, building, [original])["pois"][0]
    assert [current[k] for k in ("x", "y", "z")] == [1.05, 2.0003, 3]
    assert [current[k] for k in ("expected_pos_x", "expected_pos_y", "expected_pos_z")] == [4.05, 5.0003, 6]
    assert "_studio_calibration" not in current


def test_cleared_expected_vector_is_removed_and_zero_source_positions_survive(settings, building, monkeypatch):
    original = published(_studio_calibration={"source_position": [1, 2, 3], "source_expected_position": [4, 5, 6]})
    mock_source(monkeypatch, [row(original["id"], pos_x=0, pos_y=0, pos_z=0,
                                 expected_pos_x=None, expected_pos_y=None, expected_pos_z=None)])
    current = studio_live.load(settings, building, [original])["pois"][0]
    assert [current[k] for k in ("x", "y", "z")] == [0, 0, 0]
    assert not any(k.startswith("expected_pos_") for k in current)


@pytest.mark.parametrize("position", [None, float("nan"), float("inf"), True])
def test_invalid_source_positions_are_not_rendered(settings, building, monkeypatch, position):
    original = published()
    mock_source(monkeypatch, [row(original["id"], pos_x=position)])
    assert studio_live.load(settings, building, [original])["pois"] == []


def test_empty_publication_does_not_fetch_or_publish_source(settings, building, monkeypatch):
    calls, _ = mock_source(monkeypatch, [row(str(uuid4()))])
    assert studio_live.load(settings, building, [])["pois"] == []
    assert not calls
