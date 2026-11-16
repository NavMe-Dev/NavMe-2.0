"""Real public route + bounded cache, against isolated local publication fixtures."""
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from test_public_connection_lifetime import public_pool
from wayfinding_api import main, models
from wayfinding_api.config import get_settings
from wayfinding_api.db import get_db
from wayfinding_api.services import bundle_storage, navgraph, routing_cache


@pytest.fixture
def public_routes(public_pool, monkeypatch):
    root = public_pool.root / "v5"
    root.mkdir()
    geo = {"model_to_epsg3857_affine": [[1, 0, 0], [0, 1, 0]]}
    transform = navgraph.GeoT(geo)
    nav = {"nodes": [{"id": name, "x": x, "y": 0, "z": z, "kind": "sweep", "floor": floor,
                      "label": name, "lonlat": list(transform.ll(x, 0))}
                     for name, x, z, floor in [("n1", 0, 0, "F1"), ("n2", 3, 0, "F1"),
                                               ("n3", 3, 3, "F2"), ("island", 20, 0, "F1")]],
           "edges": [{"u": "n1", "v": "n2", "length": 3, "step_free": True},
                     {"u": "n2", "v": "n3", "length": 3, "step_free": False, "stairs": "steps", "dz": 3}]}
    files = {"nav_graph.json": nav, "pois.json": {"pois": [{"id": "start", "nearest_node": "n1"},
                                                            {"id": "end", "nearest_node": "n2"},
                                                            {"id": "upstairs", "nearest_node": "n3"},
                                                            {"id": "island", "nearest_node": "island"}]},
             "navmesh.json": {"floors": {}}}
    for name, data in files.items():
        (root / name).write_text(json.dumps(data))
    with public_pool.sessions() as db:
        building = db.query(models.Building).filter_by(slug=public_pool.slug).one()
        building.georef = geo
        version = db.query(models.MapVersion).filter_by(building_id=building.id, is_current=True).one()
        version.path = str(root)
        db.commit()
    cache = routing_cache.PublishedRoutingCache()
    monkeypatch.setattr(routing_cache, "_cache", cache)
    # A missing fixture must never contact production storage during this test.
    monkeypatch.setattr(bundle_storage, "fetch_bytes", lambda *args: None)
    cfg = get_settings().model_copy(update={"worker_inline": False, "viewer_dir": None, "admin_dir": None})
    monkeypatch.setattr(main, "get_settings", lambda: cfg)
    app = main.create_app()

    def session():
        with public_pool.sessions() as db:
            yield db

    app.dependency_overrides[get_db] = session
    client = TestClient(app)
    return SimpleNamespace(client=client, cache=cache, root=root, files=files, nav=nav, geo=geo,
                           pool=public_pool, endpoint=f"/api/v1/public/buildings/{public_pool.slug}/route")


def route(env, from_key="start", to_key="end", **extra):
    return env.client.post(env.endpoint, json={"from_key": from_key, "to_key": to_key, **extra})


def test_actual_public_route_response_is_unchanged_and_warm(public_routes):
    env = public_routes
    original_read = bundle_storage.read_bundle_file

    def read(*args):
        assert env.pool.engine.pool.checkedout() == 0
        return original_read(*args)

    expected = navgraph.route(env.nav, "n1", "n2", georef=env.geo, navmesh=env.files["navmesh.json"])
    with patch.object(bundle_storage, "read_bundle_file", side_effect=read) as reads, \
         patch.object(navgraph, "build", wraps=navgraph.build) as builds:
        responses = [route(env) for _ in range(4)]
    assert all(response.status_code == 200 and response.json() == expected for response in responses)
    assert reads.call_count == 3
    assert builds.call_count == 2
    assert env.cache.cache_info()["hits"] == 3
    assert env.pool.engine.pool.checkedout() == 0


@pytest.mark.parametrize("from_key,to_key", [("unknown", "end"), ("start", "unknown")])
def test_unknown_poi_remains_404_without_poisoning_cache(public_routes, from_key, to_key):
    response = route(public_routes, from_key, to_key)
    assert response.status_code == 404
    assert response.json() == {"detail": "unknown POI"}
    assert route(public_routes).status_code == 200
    assert public_routes.cache.cache_info()["builds"] == 1


@pytest.mark.parametrize("to_key,step_free,detail", [("island", False, "no route"),
                                                    ("upstairs", True, "no route without steps")])
def test_unreachable_route_policy_remains_404(public_routes, to_key, step_free, detail):
    response = route(public_routes, to_key=to_key, step_free=step_free)
    assert response.status_code == 404
    assert response.json() == {"detail": detail}
    assert route(public_routes, to_key="upstairs").status_code == 200


def test_missing_publication_file_can_be_retried_after_recovery(public_routes):
    env = public_routes
    graph = env.root / "nav_graph.json"
    graph.unlink()
    response = route(env)
    assert response.status_code == 404
    assert response.json() == {"detail": "building not published yet"}
    assert env.cache.cache_info()["pending"] == 0
    assert env.cache.cache_info()["entries"] == 0
    graph.write_text(json.dumps(env.nav))
    assert route(env).status_code == 200
    assert env.cache.cache_info()["builds"] == 2


def test_missing_optional_navmesh_preserves_sweep_geometry(public_routes):
    env = public_routes
    (env.root / "navmesh.json").unlink()
    response = route(env)
    assert response.status_code == 200
    assert response.json() == navgraph.route(env.nav, "n1", "n2", georef=env.geo)


def test_unpublished_and_unknown_building_do_not_prepare_graphs(public_routes):
    env = public_routes
    with env.pool.sessions() as db:
        building = db.query(models.Building).filter_by(slug=env.pool.slug).one()
        db.query(models.MapVersion).filter_by(building_id=building.id).update({"is_current": False})
        db.commit()
    response = route(env)
    assert response.status_code == 404
    assert response.json() == {"detail": "not published"}
    response = env.client.post("/api/v1/public/buildings/unknown-test-fixture/route",
                               json={"from_key": "start", "to_key": "end"})
    assert response.status_code == 404
    assert response.json() == {"detail": "unknown building"}
    assert env.cache.cache_info()["builds"] == 0


def test_new_publication_version_uses_new_graph_without_stale_result(public_routes):
    env = public_routes
    assert route(env).json()["length_m"] == 3
    new_root = env.root.parent / "v6"
    new_root.mkdir()
    changed = json.loads(json.dumps(env.files))
    changed["nav_graph.json"]["edges"][0]["length"] = 8
    for name, data in changed.items():
        (new_root / name).write_text(json.dumps(data))
    with env.pool.sessions() as db:
        building = db.query(models.Building).filter_by(slug=env.pool.slug).one()
        db.query(models.MapVersion).filter_by(building_id=building.id).update({"is_current": False})
        db.add(models.MapVersion(building_id=building.id, version=6, path=str(new_root), is_current=True))
        db.commit()
    response = route(env)
    assert response.status_code == 200
    assert response.json()["length_m"] == 8
    assert env.cache.cache_info()["builds"] == 2
    assert env.cache.cache_info()["entries"] == 1


def test_cache_wait_timeout_is_sanitized_retryable_503(public_routes, monkeypatch):
    def busy(*args):
        raise routing_cache.RoutingCacheTimeout("private-internal-filesystem-path")

    monkeypatch.setattr(routing_cache, "get_for_publication", busy)
    response = route(public_routes)
    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    assert response.json() == {"detail": "published data temporarily unavailable"}
    assert "private-internal" not in response.text
    assert public_routes.pool.engine.pool.checkedout() == 0
