"""Public I/O must not monopolize the bounded database connection pool."""
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import inspect
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

from wayfinding_api import models, schemas
from wayfinding_api.config import get_settings
from wayfinding_api.db import Base, build_engine
from wayfinding_api.routers import public
from wayfinding_api.services import access, explore, navme_sync, venue_info, weather


@pytest.fixture
def public_pool(tmp_path):
    # conftest validates this as an isolated loopback *_test database. One
    # physical connection reproduces contention without production access.
    pool = build_engine(get_settings(), pool_size=1, max_overflow=0, pool_timeout=0.2)
    Base.metadata.create_all(pool)
    sessions = sessionmaker(bind=pool, expire_on_commit=False)
    slug = "lifetime-" + uuid4().hex[:12]
    with sessions() as db:
        b = models.Building(slug=slug, name="Existing publication", address="Address",
                            matterport_model_id="fixture-model", georef={"fixture": True},
                            pipeline_config={"navme_poi_type": "Fixture venue"})
        db.add(b); db.flush()
        building_id = b.id
        db.add(models.MapVersion(building_id=b.id, version=5, path=str(tmp_path), is_current=True))
        db.commit()
    (tmp_path / "nav_graph.json").write_text('{"nodes":[],"edges":[]}')
    (tmp_path / "config.json").write_text(json.dumps({"center": [1, 2], "bounds": [0, 0, 2, 3],
        "floors": [{"id": "F1", "label": "Ground", "short": "G"}]}))
    try:
        yield SimpleNamespace(engine=pool, sessions=sessions, slug=slug, root=tmp_path)
    finally:
        with sessions() as db:
            db.query(models.MapVersion).filter_by(building_id=building_id).delete()
            db.query(models.Building).filter_by(id=building_id).delete()
            db.commit()
        pool.dispose()


def test_slow_metadata_leaves_connection_for_critical_nav_graph(public_pool, monkeypatch):
    entered, finish = threading.Event(), threading.Event()

    def slow_metadata(building):
        assert inspect(building).detached
        assert building.name == "Existing publication"
        entered.set()
        assert finish.wait(5)
        return {"building_slug": building.slug}

    monkeypatch.setattr(venue_info, "venue_info", slow_metadata)
    def metadata():
        with public_pool.sessions() as db:
            return public.public_venue_info(public_pool.slug, db)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(metadata)
        try:
            assert entered.wait(3)
            assert public_pool.engine.pool.checkedout() == 0
            with public_pool.sessions() as db:
                response = public.data_file(public_pool.slug, "nav_graph.json", db)
                assert response.path == public_pool.root / "nav_graph.json"
                assert public_pool.engine.pool.checkedout() == 0
        finally:
            finish.set()
        assert pending.result(timeout=3)["building_slug"] == public_pool.slug


@pytest.mark.parametrize("cached", [False, True])
def test_asset_download_and_file_response_release_connection(public_pool, monkeypatch, cached):
    target = public_pool.root / "large.glb"
    if cached:
        target.write_bytes(b"fixture")
    calls = []
    def cache(root, slug, version, path):
        calls.append(path)
        assert public_pool.engine.pool.checkedout() == 0
        assert (slug, version) == (public_pool.slug, 5)
        target.write_bytes(b"fixture")
        return target
    monkeypatch.setattr(public.bundle_storage, "cache_bundle_file", cache)
    with public_pool.sessions() as db:
        response = public.data_file(public_pool.slug, "large.glb", db)
        assert response.path == target
        assert public_pool.engine.pool.checkedout() == 0
    assert calls == ([] if cached else ["large.glb"])


def test_manifest_releases_connection_before_config_recovery(public_pool, monkeypatch):
    original = public.bundle_storage.read_bundle_file
    def read(*args):
        assert public_pool.engine.pool.checkedout() == 0
        return original(*args)
    monkeypatch.setattr(public.bundle_storage, "read_bundle_file", read)
    with public_pool.sessions() as db:
        # Scope the virtual venue to our publication, keeping other fixtures out.
        original_query = db.query
        def query(model):
            result = original_query(model)
            return result.filter_by(slug=public_pool.slug) if model is models.Building else result
        monkeypatch.setattr(db, "query", query)
        result = public.venue_manifest(db, "all")
        assert result["buildings"][0]["version"] == 5


@pytest.mark.parametrize("endpoint", [public.building_shops, public.building_ar_experience_ref,
                                     public.building_translations, public.building_navme_floors])
def test_live_metadata_http_does_not_hold_database_connection(public_pool, monkeypatch, endpoint):
    calls = []
    class Response:
        def read(self): return b'[]'
        def __enter__(self): return self
        def __exit__(self, *args): pass
    def request(req, **kwargs):
        assert public_pool.engine.pool.checkedout() == 0
        query = parse_qs(urlparse(req.full_url).query)
        assert query["poi_type"] == ['ilike."Fixture venue"']
        calls.append(req.full_url)
        return Response()
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(supabase_url="https://fixture.invalid", supabase_anon_key="synthetic"))
    monkeypatch.setattr(navme_sync.urllib.request, "urlopen", request)
    with public_pool.sessions() as db:
        endpoint(public_pool.slug, db)
    assert calls


@pytest.mark.parametrize("endpoint,service,name,result", [
    (public.public_weather, weather, "venue_weather", {"cache_seconds": 60}),
    (public.public_explore, explore, "metadata", {"pois": []}),
])
def test_optional_service_receives_detached_loaded_building(public_pool, monkeypatch, endpoint, service, name, result):
    def metadata(building):
        assert inspect(building).detached
        assert public_pool.engine.pool.checkedout() == 0
        assert building.pipeline_config["navme_poi_type"] == "Fixture venue"
        return result
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(supabase_url="https://fixture.invalid", supabase_anon_key="synthetic"))
    monkeypatch.setattr(service, name, (lambda cfg, b: metadata(b)) if name == "metadata" else metadata)
    with public_pool.sessions() as db:
        assert endpoint(public_pool.slug, db).status_code == 200


def test_matterport_pin_guard_survives_detaching_before_bundle_io(public_pool, monkeypatch):
    with public_pool.sessions() as db:
        b = db.query(models.Building).filter_by(slug=public_pool.slug).one()
        b.pipeline_config = {"access": {"twin": "pin", "twin_pin_hash": access.hash_pin("4242")}}
        db.commit()
    def read(*args):
        assert public_pool.engine.pool.checkedout() == 0
        return b'{"access":{"twin":"pin","pin_required":true}}'
    monkeypatch.setattr(public.bundle_storage, "read_bundle_file", read)
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(matterport_sdk_key="synthetic-client-key"))
    request = Request({"type": "http", "headers": [], "query_string": b""})
    with public_pool.sessions() as db, pytest.raises(HTTPException) as error:
        public.public_matterport(public_pool.slug, request, access="wrong", db=db)
    assert error.value.status_code == 403
    with public_pool.sessions() as db:
        result = public.public_matterport(public_pool.slug, request, access="4242", db=db)
        assert result["application_key"] == "synthetic-client-key"
        assert "twin_pin_hash" not in json.dumps(result)


def test_route_releases_connection_before_bundle_io_and_cpu(public_pool, monkeypatch):
    def read(root, slug, version, path):
        assert public_pool.engine.pool.checkedout() == 0
        if path == "pois.json":
            return json.dumps({"pois": [{"id": "a", "nearest_node": "n1"}, {"id": "b", "nearest_node": "n2"}]}).encode()
        if path == "navmesh.json":
            raise FileNotFoundError()
        return b'{}'
    def route(*args, **kwargs):
        assert public_pool.engine.pool.checkedout() == 0
        assert kwargs["georef"] == {"fixture": True}
        return {"path": ["n1", "n2"]}
    monkeypatch.setattr(public.bundle_storage, "read_bundle_file", read)
    monkeypatch.setattr(public.navgraph, "route", route)
    with public_pool.sessions() as db:
        result = public.public_route(public_pool.slug, schemas.RouteIn(from_key="a", to_key="b"), db)
        assert result == {"path": ["n1", "n2"]}


@pytest.mark.parametrize("path", ["../outside.json", "../../config.json"])
def test_early_release_keeps_path_traversal_guard(public_pool, path):
    with public_pool.sessions() as db, pytest.raises(HTTPException) as error:
        public.data_file(public_pool.slug, path, db)
    assert error.value.status_code == 404


def test_unpublished_building_cannot_trigger_bundle_io(public_pool, monkeypatch):
    with public_pool.sessions() as db:
        db.query(models.MapVersion).filter_by(path=str(public_pool.root)).update({"is_current": False})
        db.commit()
    def fail(*args):
        raise AssertionError("Unpublished assets must not be read")
    monkeypatch.setattr(public.bundle_storage, "cache_bundle_file", fail)
    with public_pool.sessions() as db, pytest.raises(HTTPException) as error:
        public.data_file(public_pool.slug, "nav_graph.json", db)
    assert error.value.status_code == 404


def test_category_marker_real_fetch_accepts_compound_link_order(public_pool, monkeypatch):
    calls = []
    class Response:
        headers = {"Content-Range": "0-0/1"}
        def __init__(self, rows): self.rows = rows
        def read(self): return json.dumps(self.rows).encode()
        def __enter__(self): return self
        def __exit__(self, *args): pass
    def request(req, **kwargs):
        assert public_pool.engine.pool.checkedout() == 0
        table = urlparse(req.full_url).path.rsplit("/", 1)[-1]
        query = parse_qs(urlparse(req.full_url).query)
        calls.append(table)
        if table == "navme_categories": return Response([{"id": "c", "name": "Category"}])
        if table == "navme_pois": return Response([{"id": "p", "is_active": True}])
        assert query["order"] == ["poi_id.asc,category_id.asc"]
        assert query["poi_id"] == ["in.(p)"]
        return Response([{"poi_id": "p", "category_id": "c"}])
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(supabase_url="https://fixture.invalid", supabase_anon_key="synthetic"))
    monkeypatch.setattr(navme_sync.urllib.request, "urlopen", request)
    with public_pool.sessions() as db:
        result = public.category_marker_data(public_pool.slug, db)
        assert result["pois"][0]["category_ids"] == ["c"]
    assert calls == ["navme_categories", "navme_pois", "navme_poi_categories"]
