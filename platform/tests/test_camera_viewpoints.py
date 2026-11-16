"""Full camera capture storage: identity, persistence, permissions and preservation."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import MagicMock

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from wayfinding_api import main, models
from wayfinding_api.auth import current_admin
from wayfinding_api.config import Settings
from wayfinding_api.db import Base, engine, get_db
from wayfinding_api.routers import admin
from wayfinding_api.services import camera_viewpoints as views


def camera(model="modelA", sweep="scanA", yaw=45):
    return {"model_id": model, "sweep_id": sweep,
            "camera_position": {"x": 179.17958, "y": 1.454188, "z": -2.250899},
            "camera_rotation": {"pitch": 2.5, "yaw": yaw},
            "floor_id": "floorA", "captured_at": "2026-11-16T05:00:00Z"}


def request(viewpoint=None, *, model="modelA", revision="default"):
    return views.CameraViewpointUpdate(model_id=model, viewpoint=viewpoint, revision=revision)


def test_model_bound_record_upsert_preserves_history_and_unrelated_json():
    old = {"source": {"private": "kept"}, "directions_viewpoint": {"legacy": True},
           views.KEY: {"oldModel": {"viewpoint": camera("oldModel"), "revision": str(uuid4())}}}
    untouched = deepcopy(old)
    saved = views.updated_extra(old, request(camera()))
    assert old == untouched
    assert set(saved[views.KEY]) == {"oldModel", "modelA"}
    assert saved["source"] == old["source"]
    assert saved["directions_viewpoint"] == old["directions_viewpoint"]
    assert saved[views.KEY]["oldModel"] == old[views.KEY]["oldModel"]
    first_revision = views.revision(saved, "modelA")
    assert first_revision != "default"
    replacement = views.updated_extra(saved, request(camera(sweep="scanB", yaw=-120), revision=first_revision))
    assert len(replacement[views.KEY]) == 2
    assert views.public_viewpoint(replacement, "modelA")["sweep_id"] == "scanB"
    assert views.revision(replacement, "modelA") != first_revision
    assert replacement[views.KEY]["oldModel"] == old[views.KEY]["oldModel"]


def test_stale_write_is_rejected_and_identical_capture_is_a_noop():
    saved = views.updated_extra({}, request(camera()))
    with pytest.raises(views.ViewpointError) as error:
        views.updated_extra(saved, request(camera(sweep="scanB")))
    assert error.value.status == 409
    assert views.updated_extra(saved, request(camera(), revision=views.revision(saved, "modelA"))) == saved


def test_unversioned_record_is_repaired_and_malformed_history_is_not_overwritten():
    unversioned = {views.KEY: {"modelA": {"viewpoint": camera()}}}
    repaired = views.updated_extra(unversioned, request(camera()))
    assert views.revision(repaired, "modelA") != "default"
    for malformed in ([1, 2], {views.KEY: ["unknown history"]}):
        with pytest.raises(views.ViewpointError) as error:
            views.updated_extra(malformed, request(camera()))
        assert error.value.status == 422


def test_reset_only_removes_active_model_and_public_projection_strips_history():
    saved = views.updated_extra({}, request(camera("oldModel"), model="oldModel"))
    saved = views.updated_extra(saved, request(camera()))
    public = views.public_viewpoint(saved, "modelA")
    assert public == camera()
    assert "revision" not in public and views.KEY not in public
    reset = views.updated_extra(saved, request(None, revision=views.revision(saved, "modelA")))
    assert set(reset[views.KEY]) == {"oldModel"}
    assert views.public_viewpoint(reset, "modelA") is None
    assert views.status(reset, "modelA") == "incompatible"
    assert views.public_viewpoint(reset, "oldModel") == camera("oldModel")


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(camera_position={"x": True, "y": 1, "z": 2}),
    lambda p: p.update(camera_position={"x": "1", "y": 1, "z": 2}),
    lambda p: p.update(camera_position={"x": float("inf"), "y": 1, "z": 2}),
    lambda p: p.update(camera_position={"x": 0, "y": float("nan"), "z": 2}),
    lambda p: p.update(camera_position={"x": 100001, "y": 1, "z": 2}),
    lambda p: p.update(camera_rotation={"pitch": 91, "yaw": 0}),
    lambda p: p.update(camera_rotation={"pitch": 0, "yaw": -181}),
    lambda p: p.update(camera_rotation={"pitch": False, "yaw": 0}),
    lambda p: p.update(sweep_id=""),
    lambda p: p.update(sweep_id="wrong scan"),
    lambda p: p.update(model_id="modelB"),
    lambda p: p.update(captured_at="2026-11-16T05:00:00"),
    lambda p: p.update(captured_at=True),
    lambda p: p.update(extra="private"),
])
def test_capture_validation_rejects_invalid_or_cross_model_data(mutate):
    value = camera()
    mutate(value)
    with pytest.raises(ValidationError):
        request(value)


def test_invalid_or_wrong_model_record_is_not_returned_publicly():
    value = camera()
    value["private"] = "not public"
    stored = {views.KEY: {"modelA": {"viewpoint": value, "revision": str(uuid4())}}}
    assert views.public_viewpoint(stored, "modelA") is None
    assert views.status(stored, "modelA") == "incompatible"
    assert views.sanitize_viewpoint(camera("otherModel"), "modelA") is None
    assert views.sanitize_viewpoint(camera(), "modelA") == camera()


def test_writable_installations_support_any_registered_model_and_readonly_requires_capability():
    b = SimpleNamespace(slug="some-other-campus", matterport_model_id="modelA")
    cfg = Settings(_env_file=None)
    assert views.writable(cfg, b)
    cfg.db_read_only = True
    assert not views.writable(cfg, b)
    cfg.camera_viewpoint_database_url = "configured"
    cfg.camera_viewpoint_buildings = "another-campus"
    assert not views.writable(cfg, b)
    cfg.camera_viewpoint_buildings = "*"
    assert views.writable(cfg, b)
    b.matterport_model_id = None
    assert not views.writable(cfg, b)


@pytest.fixture
def database(monkeypatch, tmp_path):
    """Create test tables in a private schema and roll back everything afterward."""
    schema = "camera_views_" + uuid4().hex
    with engine().connect() as connection:
        outer = connection.begin()
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
        mapped = connection.execution_options(schema_translate_map={None: schema})
        Base.metadata.create_all(mapped)
        assert connection.execute(text("SELECT to_regclass(:name)"), {"name": schema + ".pois"}).scalar() is not None
        db = Session(bind=mapped, expire_on_commit=False, join_transaction_mode="create_savepoint")
        first = models.Building(slug="ordinary-campus", name="Ordinary campus", matterport_model_id="modelA")
        second = models.Building(slug="other-campus", name="Other campus", matterport_model_id="otherModel")
        db.add_all([first, second]); db.flush()
        for building, key, source in [(first, "room-one", "admin"), (first, "room-two", "supabase"), (second, "another-room", "auto")]:
            db.add(models.POI(building_id=building.id, key=key, name=key, category="room", floor="F1",
                              model_x=10, model_y=20, model_z=1.5, published=True, source=source,
                              extra={"private": {"kept": True}, "expected_pos_x": 7},
                              updated_at=datetime(2026, 11, 1, tzinfo=timezone.utc)))
        db.commit()
        cfg = Settings(_env_file=None, worker_inline=False, data_dir=tmp_path)
        monkeypatch.setattr(main, "get_settings", lambda: cfg)
        monkeypatch.setattr(admin, "get_settings", lambda: cfg)
        app = main.create_app()
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)
        try:
            yield SimpleNamespace(db=db, connection=connection, client=client, app=app, cfg=cfg,
                                  building=first, other_building=second)
        finally:
            db.close()
            outer.rollback()


def authorized(env):
    env.app.dependency_overrides[current_admin] = lambda: SimpleNamespace(is_admin=True)
    return env.client


def snapshot(env):
    return env.connection.execute(text("SELECT id,to_jsonb(p) FROM pois p ORDER BY id")).all()


def test_api_save_reload_replace_reset_preserves_all_markers_and_other_locations(database):
    env = database
    client = authorized(env)
    prefix = "/api/v1/admin/buildings/ordinary-campus"
    listing = client.get(prefix + "/camera-viewpoints").json()
    assert listing["enabled"] and listing["writable"]
    assert len(listing["pois"]) == 2
    pid = listing["pois"][0]["id"]
    before = dict(snapshot(env))
    path = prefix + f"/pois/{pid}/camera-viewpoint"
    body = {"model_id": "modelA", "viewpoint": camera(), "revision": "default"}
    saved = client.put(path, json=body)
    assert saved.status_code == 200, saved.text
    value = saved.json()
    assert value["viewpoint"] == camera() and value["status"] == "saved"
    after = dict(snapshot(env))
    expected = deepcopy(before[pid])
    expected["extra"][views.KEY] = {"modelA": {"viewpoint": camera(), "revision": value["revision"]}}
    assert after[pid] == expected
    assert {key: row for key, row in before.items() if key != pid} == {key: row for key, row in after.items() if key != pid}

    env.db.expire_all()  # force a database read, not reuse of the identity map
    reloaded = client.get(prefix + "/camera-viewpoints").json()["pois"][0]
    assert reloaded["viewpoint"] == camera() and reloaded["revision"] == value["revision"]
    replace = {"model_id": "modelA", "viewpoint": camera(sweep="scanB", yaw=-135), "revision": value["revision"]}
    result = client.put(path, json=replace)
    assert result.status_code == 200, result.text
    assert result.json()["viewpoint"]["sweep_id"] == "scanB"
    assert client.put(path, json=body).status_code == 409
    row = env.db.get(models.POI, pid)
    assert len(row.extra[views.KEY]) == 1
    reset = client.put(path, json={"model_id": "modelA", "viewpoint": None, "revision": result.json()["revision"]})
    assert reset.status_code == 200, reset.text
    assert reset.json()["viewpoint"] is None
    assert dict(snapshot(env)) == before


def test_api_requires_admin_and_rejects_cross_building_or_changed_model(database):
    env = database
    first = env.db.query(models.POI).filter_by(building_id=env.building.id).first()
    foreign = env.db.query(models.POI).filter_by(building_id=env.other_building.id).first()
    path = f"/api/v1/admin/buildings/ordinary-campus/pois/{first.id}/camera-viewpoint"
    payload = {"model_id": "modelA", "viewpoint": camera(), "revision": "default"}
    before = snapshot(env)
    assert env.client.put(path, json=payload).status_code == 401
    assert env.client.get("/api/v1/admin/buildings/ordinary-campus/camera-viewpoints").status_code == 401
    client = authorized(env)
    assert client.put(path.replace(f"/{first.id}/", f"/{foreign.id}/"), json=payload).status_code == 404
    payload.update(model_id="oldModel", viewpoint=camera("oldModel"))
    assert client.put(path, json=payload).status_code == 409
    assert snapshot(env) == before


def test_failed_commit_never_confirms_save_and_rolls_back_only_the_viewpoint(database, monkeypatch):
    env = database
    client = authorized(env)
    poi = env.db.query(models.POI).filter_by(building_id=env.building.id).first()
    before = snapshot(env)
    def fail():
        raise OperationalError("fixture commit", {}, Exception("database failure"))
    monkeypatch.setattr(env.db, "commit", fail)
    result = client.put(f"/api/v1/admin/buildings/ordinary-campus/pois/{poi.id}/camera-viewpoint",
                        json={"model_id": "modelA", "viewpoint": camera(), "revision": "default"})
    assert result.status_code == 503
    assert result.json()["detail"] == views.SAVE_ERROR
    assert snapshot(env) == before


def test_database_model_switch_preserves_historical_view_and_flags_review(database):
    env = database
    first = env.db.query(models.POI).filter_by(building_id=env.building.id).first()
    views.write_local(env.db, env.building, first.id, request(camera()))
    env.building.matterport_model_id = "modelB"
    env.db.commit()
    env.db.refresh(first)
    state = views.admin_state(first, "modelB")
    assert state["status"] == "incompatible" and state["viewpoint"] is None
    assert state["history_model_ids"] == ["modelA"]
    assert views.public_viewpoint(first.extra, "modelA") == camera()
    with pytest.raises(views.ViewpointError) as error:
        views.write_local(env.db, env.building, first.id, request(camera()))
    assert error.value.status == 409


@pytest.mark.parametrize("writer", [
    "postgresql://postgres:private@db.project.supabase.co/postgres?sslmode=require",
    "postgresql://navme_camera_viewpoint_writer:private@db.other.supabase.co/postgres?sslmode=require",
    "postgresql://navme_camera_viewpoint_writer:private@db.project.supabase.co/postgres?sslmode=disable",
    "postgresql://navme_camera_viewpoint_writer:private@db.project.supabase.co/postgres?hostaddr=127.0.0.1",
])
def test_restricted_writer_refuses_owner_other_database_or_routing_overrides(writer):
    cfg = SimpleNamespace(database_url="postgresql://reader:secret@db.project.supabase.co/postgres",
                          camera_viewpoint_database_url=writer)
    with pytest.raises(views.ViewpointError) as error:
        views.connection_arguments(cfg)
    assert error.value.status == 503 and "private" not in str(error.value)


def test_pooled_writer_keeps_current_project_and_dedicated_role():
    cfg = SimpleNamespace(database_url="postgresql://reader.projectA@aws-0.region.pooler.supabase.com/postgres",
                          camera_viewpoint_database_url="postgresql://navme_camera_viewpoint_writer.projectA:private@aws-0.region.pooler.supabase.com/postgres?sslmode=require")
    assert views.connection_arguments(cfg)["user"] == "navme_camera_viewpoint_writer.projectA"
    cfg.camera_viewpoint_database_url = cfg.camera_viewpoint_database_url.replace("projectA:", "projectB:")
    with pytest.raises(views.ViewpointError):
        views.connection_arguments(cfg)


def test_readonly_writer_is_opt_in_and_commits_only_verified_responses(monkeypatch):
    b = SimpleNamespace(slug="ordinary-campus", matterport_model_id="modelA")
    cfg = Settings(_env_file=None, db_read_only=True)
    with pytest.raises(views.ViewpointError):
        views.write_restricted(cfg, b, 7, request(camera()))
    cfg.camera_viewpoint_buildings = "ordinary-campus"
    cfg.camera_viewpoint_database_url = "configured"
    monkeypatch.setattr(views, "connection_arguments", lambda settings: {})
    connection = MagicMock()
    connection.pgconn.ssl_in_use = True
    value = {"id": 7, "model_id": "modelA", "viewpoint": camera(), "revision": str(uuid4()), "status": "saved"}
    connection.execute.return_value.fetchone.return_value = [value]
    context = MagicMock()
    context.__enter__.return_value = connection
    monkeypatch.setattr(views.psycopg, "connect", lambda **kwargs: context)
    result = views.write_restricted(cfg, b, 7, request(camera()))
    assert result == value
    context.__exit__.assert_called_with(None, None, None)
    assert "navme_camera_viewpoint_private.set_viewpoint" in connection.execute.call_args.args[0]
    connection.execute.return_value.fetchone.return_value = [{**value, "id": 8}]
    with pytest.raises(views.ViewpointError):
        views.write_restricted(cfg, b, 7, request(camera()))
