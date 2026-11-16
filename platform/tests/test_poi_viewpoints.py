"""The only writable production operation must stay scoped to a look target."""
from copy import deepcopy
import json
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import MagicMock

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from pydantic import ValidationError
import pytest
from sqlalchemy.engine import make_url

from wayfinding_api.config import get_settings
from wayfinding_api.services import poi_viewpoints as vp, studio_live


@pytest.mark.parametrize("authorized", [False, True])
def test_readonly_exception_retains_admin_auth_and_never_uses_general_writes(monkeypatch, authorized):
    from fastapi.testclient import TestClient
    from wayfinding_api import main
    from wayfinding_api.auth import current_admin
    from wayfinding_api.db import get_db
    from wayfinding_api.routers import admin
    from wayfinding_api.config import Settings
    cfg = Settings(_env_file=None, wf_read_only=True, worker_inline=False,
                   poi_viewpoint_buildings="uncc-main-campus", poi_viewpoint_database_url="synthetic")
    monkeypatch.setattr(main, "get_settings", lambda: cfg)
    monkeypatch.setattr(admin, "get_settings", lambda: cfg)
    building = SimpleNamespace(id=3, slug="uncc-main-campus", matterport_model_id="kQBN52JqFE9")
    db = MagicMock()
    db.query.return_value.filter_by.return_value.first.return_value = building
    db.get.return_value = SimpleNamespace(id=11, building_id=3, source="supabase", published=True)
    monkeypatch.setattr(admin.pub, "current_version", lambda *args: object())
    writer = MagicMock(return_value={"id": 11, "target": {"x": 0, "y": 2, "z": 3}, "override": True, "revision": str(uuid4())})
    monkeypatch.setattr(vp, "write", writer)
    app = main.create_app()
    app.dependency_overrides[get_db] = lambda: db
    if authorized:
        app.dependency_overrides[current_admin] = lambda: SimpleNamespace(is_admin=True)
    client = TestClient(app)
    response = client.put("/api/v1/admin/buildings/uncc-main-campus/pois/11/viewpoint",
                          json={"target": {"x": 0, "y": 2, "z": 3}, "revision": "default"})
    assert response.status_code == (200 if authorized else 401)
    assert writer.call_count == int(authorized)
    db.commit.assert_not_called()
    if authorized:
        db.close.assert_called()
    assert client.patch("/api/v1/admin/buildings/uncc-main-campus/pois/11", json={"name": "changed"}).status_code == 503
    assert client.put("/api/v1/admin/buildings/gcu/pois/11/viewpoint", json={}).status_code == 503


def test_admin_listing_returns_current_effective_target_and_only_published_ids(monkeypatch):
    from wayfinding_api.routers import admin, public
    cfg = SimpleNamespace(poi_viewpoint_buildings="uncc-main-campus", poi_viewpoint_database_url="configured")
    building = SimpleNamespace(id=3, slug="uncc-main-campus", matterport_model_id="kQBN52JqFE9")
    db = MagicMock()
    db.query.return_value.filter_by.return_value.first.return_value = building
    identity = str(uuid4())
    db.query.return_value.filter_by.return_value.all.return_value = [SimpleNamespace(id=11,key="stored",extra={"gmap_src_id": identity})]
    monkeypatch.setattr(admin, "get_settings", lambda: cfg)
    monkeypatch.setattr(admin.pub, "current_version", lambda *args: object())
    monkeypatch.setattr(public, "_dashboard_pois", lambda *args: [{"id": identity}])

    def load(*args):
        db.close.assert_called()
        return {"pois": [{"id": identity, "name": "Current Studio name", "x": 1, "y": 2, "z": 3,
                          "expected_pos_x": 0, "expected_pos_y": 8, "expected_pos_z": 9},
                         {"id": "unpublished", "name": "hidden", "x": 0, "y": 0, "z": 0}]}

    monkeypatch.setattr(studio_live, "load", load)
    result = admin.poi_viewpoint_state(building.slug, db)
    assert result == {"enabled": True,"writable": True,"pois": [{"id": 11,"source_id":identity,
        "name":"Current Studio name","position":{"x":1,"y":2,"z":3},
        "target":{"x":0,"y":8,"z":9},"revision":"default","override":False}]}


@pytest.mark.parametrize("target", [
    {"x": True, "y": 1, "z": 2}, {"x": "1", "y": 1, "z": 2},
    {"x": float("nan"), "y": 1, "z": 2}, {"x": 1, "y": float("inf"), "z": 2},
    {"x": 100001, "y": 1, "z": 2}, {"x": 1, "y": 2},
    {"x": 1, "y": 2, "z": 3, "private": True},
])
def test_target_rejects_invalid_or_extra_fields(target):
    with pytest.raises(ValidationError):
        vp.ViewpointUpdate(target=target, revision="default")


def test_zero_coordinates_and_reset_are_valid():
    update = vp.ViewpointUpdate(target={"x": 0, "y": 0, "z": 0}, revision="default")
    assert update.target.model_dump() == {"x": 0, "y": 0, "z": 0}
    assert vp.ViewpointUpdate(target=None, revision="default").target is None


@pytest.mark.parametrize("dsn", [
    "postgresql://postgres:private@db.kzpvhzyefdtrtidrbuxb.supabase.co/postgres",
    "postgresql://navme_poi_viewpoint_writer:private@db.znfwcohrpkiccibqcfpn.supabase.co/postgres",
    "postgresql://navme_poi_viewpoint_writer:private@db.kzpvhzyefdtrtidrbuxb.supabase.co/postgres?sslmode=disable",
    "postgresql://navme_poi_viewpoint_writer:private@db.kzpvhzyefdtrtidrbuxb.supabase.co/postgres?hostaddr=127.0.0.1",
])
def test_writer_refuses_owner_other_project_or_routing_overrides(dsn):
    with pytest.raises(vp.ViewpointError) as error:
        vp.connection_arguments(dsn)
    assert error.value.status == 503
    assert "private" not in str(error.value)


def test_writer_role_and_building_are_explicit():
    args = vp.connection_arguments("postgresql://navme_poi_viewpoint_writer.kzpvhzyefdtrtidrbuxb:private@aws-0-ap-southeast-1.pooler.supabase.com/postgres?sslmode=require")
    assert args["user"] == vp.ROLE + ".kzpvhzyefdtrtidrbuxb"
    cfg = SimpleNamespace(poi_viewpoint_buildings="uncc-main-campus")
    building = SimpleNamespace(slug="uncc-main-campus", matterport_model_id="kQBN52JqFE9")
    assert vp.enabled(cfg, building)
    building.slug = "gcu"
    assert not vp.enabled(cfg, building)


def test_local_target_overrides_studio_and_is_not_returned_as_private_json(monkeypatch):
    identifier = str(uuid4())
    cfg = SimpleNamespace(studio_live_buildings="uncc-main-campus", studio_supabase_url="https://source.invalid", studio_supabase_anon_key="test")
    building = SimpleNamespace(slug="uncc-main-campus", pipeline_config={"navme_poi_type": "Uncc_Navme"})
    published = [{"id": identifier, "name": "Published", "x": 1, "y": 2, "z": 3,
                  "expected_pos_x": 4, "expected_pos_y": 5, "expected_pos_z": 6,
                  "_directions_viewpoint": {"target": {"x": 0, "y": 8, "z": 9}, "revision": str(uuid4())}}]
    rows = {"pois": [{"id": identifier, "poi_name": "Studio", "is_active": True,
                      "pos_x": 1, "pos_y": 2, "pos_z": 3,
                      "expected_pos_x": 40, "expected_pos_y": 50, "expected_pos_z": 60}],
            "categories": [], "floors": []}
    monkeypatch.setattr(studio_live, "_fetch", lambda *args: rows)
    studio_live._slots.clear()
    result = studio_live.load(cfg, building, published)["pois"][0]
    assert [result["expected_pos_" + axis] for axis in ("x", "y", "z")] == [0, 8, 9]
    assert [result[axis] for axis in ("x", "y", "z")] == [1, 2, 3]
    assert "_directions_viewpoint" not in result and "revision" not in json.dumps(result)
    cfg.studio_live_buildings = ""
    fallback = studio_live.load(cfg, building, published)["pois"][0]
    assert fallback["expected_pos_x"] == 0
    published[0].pop("_directions_viewpoint")
    cfg.studio_live_buildings = "uncc-main-campus"
    reset = studio_live.load(cfg, building, published)["pois"][0]
    assert reset["expected_pos_x"] == 40
    studio_live._slots.clear()


@pytest.fixture
def capability_db():
    # conftest already rejects remote/non-test DATABASE_URL. Fixtures are private
    # transaction-local tables, so existing local application rows are untouched.
    url = make_url(get_settings().database_url)
    assert url.host in {"localhost", "127.0.0.1", "::1"} and url.database.endswith("_test")
    with psycopg.connect(host=url.host, port=url.port or 5432, dbname=url.database,
                         user=url.username, password=url.password) as c:
        c.execute("BEGIN")
        namespace = "viewpoint_fixture_" + uuid4().hex
        c.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOINHERIT").format(sql.Identifier(vp.ROLE)))
        c.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(vp.SCHEMA)))
        c.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(namespace)))
        c.execute(sql.SQL("REVOKE ALL ON SCHEMA {} FROM PUBLIC").format(sql.Identifier(vp.SCHEMA)))
        c.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(vp.SCHEMA), sql.Identifier(vp.ROLE)))
        c.execute(sql.SQL("CREATE TABLE {}.buildings(id integer,slug text,matterport_model_id text,pipeline_config jsonb)").format(sql.Identifier(namespace)))
        c.execute(sql.SQL("CREATE TABLE {}.pois(id integer,building_id integer,source text,published boolean,extra jsonb,model_x double precision,model_y double precision,model_z double precision,nearest_node text)").format(sql.Identifier(namespace)))
        c.execute(sql.SQL("CREATE TABLE {}.map_versions(building_id integer,is_current boolean)").format(sql.Identifier(namespace)))
        c.execute(sql.SQL("CREATE TABLE {}.navme_pois(id uuid,poi_type text)").format(sql.Identifier(namespace)))
        c.execute(sql.SQL("INSERT INTO {}.buildings VALUES (3,'uncc-main-campus','kQBN52JqFE9',%s),(4,'gcu','other',%s)").format(sql.Identifier(namespace)), (Jsonb({"navme_poi_type": "Uncc_Navme"}), Jsonb({})))
        identity = str(uuid4())
        original = {"gmap_src_id": identity, "keep": {"private": True}, "expected_pos_x": 123, "studio_calibration": {"keep": True}}
        for pid, bid, source, published in [(11, 3, "supabase", True), (12, 3, "supabase", False), (13, 4, "supabase", True), (14, 3, "admin", True)]:
            c.execute(sql.SQL("INSERT INTO {}.pois VALUES (%s,%s,%s,%s,%s,10,20,30,'unchanged-sweep')").format(sql.Identifier(namespace)), (pid, bid, source, published, Jsonb(original)))
        c.execute(sql.SQL("INSERT INTO {}.navme_pois VALUES (%s,'Uncc_Navme')").format(sql.Identifier(namespace)), (identity,))
        c.execute(sql.SQL("INSERT INTO {}.map_versions VALUES (3,true)").format(sql.Identifier(namespace)))
        c.execute(vp.FUNCTION_SQL.replace("public.", namespace + "."))
        try:
            yield c, namespace, original
        finally:
            c.rollback()


def call(c, target, revision="default", pid=11, slug="uncc-main-campus"):
    return c.execute("SELECT navme_viewpoint_private.set_viewpoint(%s,%s,%s,%s)",
                     (slug, pid, Jsonb(target) if target is not None else None, revision)).fetchone()[0]


def test_sql_save_noop_conflict_and_reset_preserve_entire_row(capability_db):
    c, schema, original = capability_db
    query = sql.SQL("SELECT to_jsonb(p) FROM {}.pois p WHERE id=11").format(sql.Identifier(schema))
    before = c.execute(query).fetchone()[0]
    result = call(c, {"x": 0, "y": 5.5, "z": -8})
    after = c.execute(query).fetchone()[0]
    wanted = deepcopy(before)
    wanted["extra"]["directions_viewpoint"] = {"target": result["target"], "revision": result["revision"]}
    assert wanted == after
    assert call(c, result["target"], result["revision"]) == result
    with pytest.raises(psycopg.errors.SerializationFailure), c.transaction():
        call(c, {"x": 1, "y": 2, "z": 3})
    reset = call(c, None, result["revision"])
    assert reset == {"id": 11, "target": None, "override": False, "revision": "default"}
    assert c.execute(query).fetchone()[0] == before


@pytest.mark.parametrize("pid,slug", [(12, "uncc-main-campus"), (13, "gcu"), (13, "uncc-main-campus"), (14, "uncc-main-campus"), (999, "uncc-main-campus")])
def test_sql_rejects_drafts_foreign_buildings_and_other_sources(capability_db, pid, slug):
    c, _, _ = capability_db
    with pytest.raises(psycopg.errors.NoDataFound), c.transaction():
        call(c, {"x": 1, "y": 2, "z": 3}, pid=pid, slug=slug)


def test_execute_only_role_cannot_update_tables_or_grant_public_execute(capability_db):
    c, namespace, _ = capability_db
    assert c.execute("""SELECT NOT EXISTS(SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE n.nspname='navme_viewpoint_private' AND a.grantee=0 AND a.privilege_type='EXECUTE')""").fetchone()[0]
    c.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(vp.ROLE)))
    result = call(c, {"x": 1, "y": 2, "z": 3})
    assert result["override"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege), c.transaction():
        c.execute(sql.SQL("UPDATE {}.pois SET model_x=999 WHERE id=11").format(sql.Identifier(namespace)))
