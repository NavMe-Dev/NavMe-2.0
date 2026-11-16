"""Rehearse only the pending camera capability in rollback-only local fixtures.

The production migration remains unapplied. Every schema, test table, function,
and NOLOGIN role below is private to one local ``*_test`` transaction.
"""
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
import pytest
from sqlalchemy.engine import make_url

from wayfinding_api.config import get_settings


MIGRATION = Path(__file__).resolve().parents[1] / "deploy/pending-migrations/20261116063201_capture_camera_viewpoint_writer.sql"


def view(model="modelA", sweep="scanA", yaw=45):
    return {"model_id": model, "sweep_id": sweep,
            "camera_position": {"x": 179.17958, "y": 1.454188, "z": -2.250899},
            "camera_rotation": {"pitch": 2.5, "yaw": yaw},
            "floor_id": "floorA", "captured_at": "2026-11-16T05:00:00Z"}


@pytest.fixture
def capability():
    url = make_url(get_settings().database_url)
    assert url.host in {"localhost", "127.0.0.1", "::1"} and url.database.endswith("_test")
    with psycopg.connect(host=url.host, port=url.port or 5432, dbname=url.database,
                         user=url.username, password=url.password) as connection:
        connection.execute("BEGIN")
        suffix = uuid4().hex
        data_schema, private_schema, role = "cv_data_" + suffix, "cv_private_" + suffix, "cv_writer_" + suffix
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(data_schema)))
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(private_schema)))
        connection.execute(sql.SQL("REVOKE ALL ON SCHEMA {} FROM PUBLIC").format(sql.Identifier(private_schema)))
        connection.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS").format(sql.Identifier(role)))
        connection.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(private_schema), sql.Identifier(role)))
        connection.execute(sql.SQL("CREATE TABLE {}.buildings (id integer PRIMARY KEY,slug text UNIQUE,matterport_model_id text)").format(sql.Identifier(data_schema)))
        connection.execute(sql.SQL("""CREATE TABLE {}.pois (
            id integer PRIMARY KEY,building_id integer,extra jsonb,
            model_x double precision,model_y double precision,model_z double precision,
            marker jsonb,nearest_node text,published boolean,source text,updated_at timestamptz
        )""").format(sql.Identifier(data_schema)))
        connection.execute(sql.SQL("INSERT INTO {}.buildings VALUES (1,'ordinary-campus','modelA'),(2,'other-campus','modelB')").format(sql.Identifier(data_schema)))
        history = {"viewpoint": view("oldModel"), "revision": str(uuid4())}
        for pid, bid, source, published in [(11, 1, "admin", True), (12, 1, "supabase", True), (13, 2, "auto", False)]:
            extra = {"keep": {"private": True}, "expected_pos_y": 7.5,
                     "directions_viewpoint": {"target": {"x": 1, "y": 2, "z": 3}},
                     "camera_viewpoints": {"oldModel": history}}
            connection.execute(sql.SQL("""INSERT INTO {}.pois
                VALUES (%s,%s,%s,10,20,30,%s,'unchanged-node',%s,%s,'2026-11-01T00:00:00Z')
            """).format(sql.Identifier(data_schema)), (pid, bid, Jsonb(extra), Jsonb({"geometry": [1, 2, 3]}), published, source))
        raw = MIGRATION.read_text()
        start = raw.index("CREATE OR REPLACE FUNCTION")
        end = raw.index("$function$;", start) + len("$function$;")
        function = raw[start:end].replace("public.", data_schema + ".").replace("navme_camera_viewpoint_private", private_schema)
        connection.execute(function)
        grant_section = raw[end:raw.index("COMMENT ON FUNCTION", end)]
        grants = grant_section.replace("navme_camera_viewpoint_private", private_schema).replace("navme_camera_viewpoint_writer", role)
        connection.execute(grants)
        try:
            yield connection, data_schema, private_schema, role
        finally:
            connection.rollback()


def call(fixture, captured, revision="default", *, slug="ordinary-campus", pid=11, model="modelA"):
    connection, _, private_schema, _ = fixture
    return connection.execute(sql.SQL("SELECT {}.set_viewpoint(%s,%s,%s,%s,%s)").format(sql.Identifier(private_schema)),
                              (slug, pid, model, Jsonb(captured) if captured is not None else None, revision)).fetchone()[0]


def rows(fixture):
    connection, data_schema, _, _ = fixture
    return dict(connection.execute(sql.SQL("SELECT p.id,to_jsonb(p) FROM {}.pois p ORDER BY p.id").format(sql.Identifier(data_schema))).fetchall())


def test_pending_capability_save_noop_replace_conflict_reset_preserves_markers_and_history(capability):
    connection, _, _, _ = capability
    before = rows(capability)
    saved = call(capability, view())
    assert saved["id"] == 11 and saved["model_id"] == "modelA" and saved["viewpoint"] == view()
    assert saved["status"] == "saved" and saved["revision"] != "default"
    after = rows(capability)
    expected = deepcopy(before)
    expected[11]["extra"]["camera_viewpoints"]["modelA"] = {"viewpoint": view(), "revision": saved["revision"]}
    assert after == expected
    assert call(capability, view(), saved["revision"]) == saved
    assert rows(capability) == after
    replacement = call(capability, view(sweep="scanB", yaw=-130), saved["revision"])
    assert replacement["viewpoint"]["sweep_id"] == "scanB"
    assert replacement["revision"] != saved["revision"]
    with pytest.raises(psycopg.errors.SerializationFailure), connection.transaction():
        call(capability, view(), saved["revision"])
    reset = call(capability, None, replacement["revision"])
    assert reset == {"id": 11, "model_id": "modelA", "viewpoint": None, "revision": "default", "status": "incompatible"}
    assert rows(capability) == before


def test_pending_capability_is_generic_for_registered_locations_including_drafts(capability):
    before = rows(capability)
    saved = call(capability, view("modelB"), slug="other-campus", pid=13, model="modelB")
    assert saved["status"] == "saved"
    after = rows(capability)
    assert before[11] == after[11] and before[12] == after[12]
    assert after[13]["published"] is False and after[13]["source"] == "auto"
    assert after[13]["extra"]["camera_viewpoints"]["oldModel"] == before[13]["extra"]["camera_viewpoints"]["oldModel"]


@pytest.mark.parametrize("kwargs,error_type", [
    ({"pid": 999}, psycopg.errors.NoDataFound),
    ({"slug": "missing-campus"}, psycopg.errors.NoDataFound),
    ({"slug": "other-campus", "model": "modelB", "pid": 11}, psycopg.errors.NoDataFound),
    ({"model": "oldModel"}, psycopg.errors.SerializationFailure),
])
def test_pending_capability_rejects_wrong_location_building_or_model(capability, kwargs, error_type):
    connection, _, _, _ = capability
    before = rows(capability)
    captured = view(kwargs.get("model", "modelA"))
    with pytest.raises(error_type), connection.transaction():
        call(capability, captured, **kwargs)
    assert rows(capability) == before


@pytest.mark.parametrize("value", [
    True, 12, "not an object", [],
    {**view(), "private": True},
    {**view(), "model_id": "anotherModel"},
    {**view(), "sweep_id": ""},
    {**view(), "sweep_id": "bad scan"},
    {**view(), "camera_position": False},
    {**view(), "camera_position": {"x": True, "y": 1, "z": 2}},
    {**view(), "camera_position": {"x": "1", "y": 1, "z": 2}},
    {**view(), "camera_position": {"x": 100001, "y": 1, "z": 2}},
    {**view(), "camera_position": {"x": 1, "y": 1}},
    {**view(), "camera_rotation": {"pitch": True, "yaw": 0}},
    {**view(), "camera_rotation": {"pitch": 0, "yaw": "1"}},
    {**view(), "camera_rotation": {"pitch": 91, "yaw": 0}},
    {**view(), "camera_rotation": {"pitch": 0, "yaw": 181}},
    {**view(), "floor_id": []},
    {**view(), "floor_id": "  "},
    {**view(), "captured_at": "2026-11-16T05:00:00"},
    {**view(), "captured_at": "2026-99-99T05:00:00Z"},
    {**view(), "captured_at": "2026-11-16T05:00:00+99:99"},
])
def test_pending_capability_rejects_invalid_json_without_touching_rows(capability, value):
    connection, _, _, _ = capability
    before = rows(capability)
    with pytest.raises(psycopg.errors.InvalidParameterValue), connection.transaction():
        call(capability, value)
    assert rows(capability) == before


def test_pending_capability_repairs_an_unversioned_record_without_losing_history(capability):
    connection, data_schema, _, _ = capability
    connection.execute(sql.SQL("UPDATE {}.pois SET extra=jsonb_set(extra,'{{camera_viewpoints,modelA}}',%s) WHERE id=11").format(sql.Identifier(data_schema)),
                       (Jsonb({"viewpoint": view()}),))
    result = call(capability, view())
    assert result["revision"] != "default"
    assert rows(capability)[11]["extra"]["camera_viewpoints"]["modelA"]["revision"] == result["revision"]


def test_pending_capability_role_can_only_execute_and_public_execution_is_revoked(capability):
    connection, data_schema, private_schema, role = capability
    exposed = connection.execute("""SELECT EXISTS(
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE n.nspname=%s AND a.grantee=0 AND a.privilege_type='EXECUTE')""", (private_schema,)).fetchone()[0]
    assert not exposed
    connection.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
    saved = call(capability, view())
    assert saved["status"] == "saved"
    with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
        connection.execute(sql.SQL("UPDATE {}.pois SET model_x=999 WHERE id=11").format(sql.Identifier(data_schema)))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
        connection.execute(sql.SQL("SELECT * FROM {}.pois").format(sql.Identifier(data_schema)))
    assert not connection.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE WITH GRANT OPTION')",
                                  (private_schema + ".set_viewpoint(text,integer,text,jsonb,text)",)).fetchone()[0]
    # PostgreSQL warns and ignores a GRANT with no grant option; check the ACL
    # rather than requiring an error that PostgreSQL does not promise here.
    connection.execute(sql.SQL("GRANT EXECUTE ON FUNCTION {}.set_viewpoint(text,integer,text,jsonb,text) TO PUBLIC").format(sql.Identifier(private_schema)))
    assert not connection.execute("""SELECT EXISTS(
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE n.nspname=%s AND a.grantee=0 AND a.privilege_type='EXECUTE')""", (private_schema,)).fetchone()[0]
    connection.execute("RESET ROLE")


def test_pending_migration_is_opt_in_not_in_automatic_migration_paths():
    assert "pending-migrations" in MIGRATION.parts
    raw = MIGRATION.read_text()
    assert "PENDING APPROVAL" in raw and "NOLOGIN" in raw
    assert "CREATE TABLE" not in raw and "ALTER TABLE" not in raw
    assert "REVOKE ALL ON FUNCTION" in raw and "FROM PUBLIC" in raw
