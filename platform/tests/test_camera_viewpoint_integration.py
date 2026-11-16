"""Camera capture proof against PostgreSQL in a transaction-private namespace.

The application/test schemas are never rebuilt. Every ORM statement is schema
translated, every service commit releases only a savepoint, and the outer
transaction removes the entire fixture when the test ends.
"""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
from geoalchemy2.elements import WKTElement
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateSchema

from wayfinding_api import main, models
from wayfinding_api.auth import current_admin
from wayfinding_api.config import Settings, get_settings
from wayfinding_api.db import Base, engine, get_db
from wayfinding_api.routers import admin
from wayfinding_api.services import camera_viewpoints as views


def camera(model="modelAlpha", sweep="alphaScan", *, pitch=6.5, yaw=43):
    return {
        "model_id": model, "sweep_id": sweep,
        "camera_position": {"x": 11.25, "y": 1.68, "z": -3.75},
        "camera_rotation": {"pitch": pitch, "yaw": yaw},
        "floor_id": "floor-one", "captured_at": "2026-11-16T10:30:00Z",
    }


def update(viewpoint, *, model=None, revision="default"):
    return views.CameraViewpointUpdate(
        model_id=model or viewpoint["model_id"], viewpoint=viewpoint, revision=revision
    )


@pytest.fixture
def storage(monkeypatch, tmp_path):
    url = make_url(get_settings().database_url)
    assert url.host in {"localhost", "127.0.0.1", "::1"}
    assert (url.database or "").endswith("_test")
    namespace = "camera_capture_proof_" + uuid4().hex
    source_id = str(uuid4())
    with engine().connect() as raw_connection:
        outer = raw_connection.begin()
        raw_connection.execute(CreateSchema(namespace))
        connection = raw_connection.execution_options(schema_translate_map={None: namespace})
        Base.metadata.create_all(connection)
        sessions = sessionmaker(bind=connection, expire_on_commit=False,
                                join_transaction_mode="create_savepoint")
        # Check schema translation actually created private tables instead of
        # allowing PostgreSQL search_path to find preexisting public test tables.
        assert connection.execute(text("SELECT to_regclass(:qualified)"),
                                  {"qualified": namespace + ".pois"}).scalar()
        try:
            with sessions() as db:
                alpha = models.Building(slug="capture-alpha", name="Alpha rooms",
                                        matterport_model_id="modelAlpha", status="published")
                beta = models.Building(slug="capture-beta", name="Beta rooms",
                                       matterport_model_id="modelBeta", status="published")
                db.add_all([alpha, beta]); db.flush()
                pois = []
                for building, key, source, published in [
                    (alpha, "alpha-room", "admin", True),
                    (alpha, "alpha-neighbor", "csv", True),
                    (alpha, "draft-room", "admin", False),
                    (beta, "beta-mirror", "supabase", True),
                ]:
                    extra = {"preserved": {"details": [1, 2, "three"]},
                             "expected_pos_x": 19.5, "expected_pos_y": 2.1,
                             "directions_viewpoint": {"legacy": "unchanged"}}
                    if source == "supabase":
                        extra["gmap_src_id"] = source_id
                    poi = models.POI(
                        building_id=building.id, key=key, name=key, category="room", floor="F1",
                        geom=WKTElement("POINT(-80.73 35.30)", srid=4326),
                        model_x=12.34, model_y=-56.78, model_z=1.23,
                        nearest_node="route-node-kept", nearest_sweep_label="marker-scan-kept",
                        room_id="room-marker-kept", published=published, source=source,
                        locked=True, extra=extra,
                        updated_at=datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc),
                    )
                    db.add(poi); pois.append(poi)
                db.add_all([
                    models.MapVersion(building_id=b.id, version=1, path=str(tmp_path / b.slug),
                                      is_current=True, summary={"kept": True})
                    for b in (alpha, beta)
                ])
                db.commit()
                ids = {"alpha": alpha.id, "beta": beta.id,
                       **{p.key: p.id for p in pois}}

            cfg = Settings(_env_file=None, worker_inline=False, data_dir=tmp_path,
                           viewer_dir=None, admin_dir=None)
            monkeypatch.setattr(main, "get_settings", lambda: cfg)
            monkeypatch.setattr(admin, "get_settings", lambda: cfg)
            app = main.create_app()

            def fresh_session():
                with sessions() as db:
                    yield db

            app.dependency_overrides[get_db] = fresh_session
            client = TestClient(app)

            def snapshot():
                result = {}
                for table in ("pois", "buildings", "map_versions"):
                    records = connection.execute(text(
                        f'SELECT id,to_jsonb(row) FROM "{namespace}".{table} AS row ORDER BY id'
                    )).all()
                    result[table] = {key: value for key, value in records}
                return result

            def save(building_id, poi_id, value, *, model=None, revision="default"):
                with sessions() as db:
                    b = db.get(models.Building, building_id)
                    return views.write_local(db, b, poi_id,
                                             update(value, model=model, revision=revision))

            yield SimpleNamespace(sessions=sessions, connection=connection, ids=ids, client=client,
                                  app=app, snapshot=snapshot, save=save, source_id=source_id)
        finally:
            outer.rollback()
            assert raw_connection.execute(text("SELECT to_regclass(:qualified)"),
                                          {"qualified": namespace + ".pois"}).scalar() is None


def public_read(storage, slug="capture-alpha", location="alpha-room"):
    response = storage.client.get(f"/api/v1/public/buildings/{slug}/camera-viewpoints/{location}")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_real_database_saves_multiple_buildings_and_fresh_public_reads_preserve_every_marker(storage):
    env = storage
    baseline = env.snapshot()
    alpha = env.save(env.ids["alpha"], env.ids["alpha-room"], camera())
    beta_view = camera("modelBeta", "betaScan", pitch=-8, yaw=-137)
    beta = env.save(env.ids["beta"], env.ids["beta-mirror"], beta_view)

    # Each service call uses a new SQLAlchemy session. This read opens yet another
    # session, proving the value comes from JSONB in PostgreSQL, not an identity map.
    with env.sessions() as db:
        first = db.get(models.POI, env.ids["alpha-room"])
        second = db.get(models.POI, env.ids["beta-mirror"])
        assert first.source == "admin"
        assert views.public_viewpoint(first.extra, "modelAlpha") == camera()
        assert views.public_viewpoint(second.extra, "modelBeta") == beta_view

    alpha_public = public_read(env)
    beta_public = public_read(env, "capture-beta", env.source_id)
    assert alpha_public["viewpoint"] == camera()
    assert beta_public["viewpoint"] == beta_view
    assert alpha_public["location_id"] == "alpha-room"
    assert beta_public["location_id"] == env.source_id
    assert "revision" not in str(alpha_public)
    assert "preserved" not in str(beta_public)

    expected = deepcopy(baseline)
    for key, model, value, result in [
        ("alpha-room", "modelAlpha", camera(), alpha),
        ("beta-mirror", "modelBeta", beta_view, beta),
    ]:
        expected["pois"][env.ids[key]]["extra"][views.KEY] = {
            model: {"viewpoint": value, "revision": result["revision"]}
        }
    assert env.snapshot() == expected


def test_replacement_is_fresh_without_republish_and_never_changes_a_neighbor_or_route_anchor(storage):
    env = storage
    saved = env.save(env.ids["alpha"], env.ids["alpha-room"], camera())
    env.save(env.ids["beta"], env.ids["beta-mirror"], camera("modelBeta", "betaScan"))
    before = env.snapshot()
    assert public_read(env)["viewpoint"]["sweep_id"] == "alphaScan"
    replacement = camera(sweep="newAlphaScan", pitch=-2.75, yaw=-91)
    changed = env.save(env.ids["alpha"], env.ids["alpha-room"], replacement,
                       revision=saved["revision"])
    assert changed["revision"] != saved["revision"]
    assert public_read(env)["viewpoint"] == replacement

    expected = deepcopy(before)
    expected["pois"][env.ids["alpha-room"]]["extra"][views.KEY]["modelAlpha"] = {
        "viewpoint": replacement, "revision": changed["revision"]
    }
    assert env.snapshot() == expected
    # Repeating an identical capture is a no-op and cannot create duplicates.
    repeated = env.save(env.ids["alpha"], env.ids["alpha-room"], replacement,
                        revision=changed["revision"])
    assert repeated == changed
    assert env.snapshot() == expected
    with pytest.raises(views.ViewpointError) as conflict:
        env.save(env.ids["alpha"], env.ids["alpha-room"], camera(), revision=saved["revision"])
    assert conflict.value.status == 409
    assert env.snapshot() == expected


def test_model_change_keeps_history_and_reset_removes_only_the_new_model_record(storage):
    env = storage
    baseline = env.snapshot()
    env.save(env.ids["alpha"], env.ids["alpha-room"], camera())
    with env.sessions() as db:
        b = db.get(models.Building, env.ids["alpha"])
        b.matterport_model_id = "modelAlphaV2"
        db.commit()
    invalid = public_read(env)
    assert invalid["status"] == "incompatible" and invalid["viewpoint"] is None
    with env.sessions() as db:
        poi = db.get(models.POI, env.ids["alpha-room"])
        assert views.admin_state(poi, "modelAlphaV2")["history_model_ids"] == ["modelAlpha"]
    with pytest.raises(views.ViewpointError) as mismatch:
        env.save(env.ids["alpha"], env.ids["alpha-room"], camera())
    assert mismatch.value.status == 409
    new_view = camera("modelAlphaV2", "newModelScan", yaw=10)
    saved = env.save(env.ids["alpha"], env.ids["alpha-room"], new_view)
    assert public_read(env)["viewpoint"] == new_view
    with env.sessions() as db:
        poi = db.get(models.POI, env.ids["alpha-room"])
        assert set(poi.extra[views.KEY]) == {"modelAlpha", "modelAlphaV2"}
        assert views.public_viewpoint(poi.extra, "modelAlpha") == camera()
    env.save(env.ids["alpha"], env.ids["alpha-room"], None,
             model="modelAlphaV2", revision=saved["revision"])
    assert public_read(env)["status"] == "incompatible"
    with env.sessions() as db:
        poi = db.get(models.POI, env.ids["alpha-room"])
        assert set(poi.extra[views.KEY]) == {"modelAlpha"}
        kept = deepcopy(poi.extra); kept.pop(views.KEY)
        assert kept == baseline["pois"][poi.id]["extra"]
    current = env.snapshot()
    for pid, row in baseline["pois"].items():
        if pid != env.ids["alpha-room"]:
            assert current["pois"][pid] == row


def test_http_permissions_and_publication_gates_with_real_private_database_rows(storage):
    env = storage
    pid = env.ids["alpha-room"]
    path = f"/api/v1/admin/buildings/capture-alpha/pois/{pid}/camera-viewpoint"
    payload = {"model_id": "modelAlpha", "viewpoint": camera(), "revision": "default"}
    before = env.snapshot()
    assert env.client.put(path, json=payload).status_code == 401
    assert env.client.get("/api/v1/admin/buildings/capture-alpha/camera-viewpoints").status_code == 401
    assert env.snapshot() == before

    env.app.dependency_overrides[current_admin] = lambda: SimpleNamespace(is_admin=True)
    response = env.client.put(path, json=payload)
    assert response.status_code == 200, response.text
    assert public_read(env)["viewpoint"] == camera()
    foreign = path.replace(f"/{pid}/", f'/{env.ids["beta-mirror"]}/')
    assert env.client.put(foreign, json=payload).status_code == 404

    # Registered draft locations can be prepared by an admin, but are not
    # accidentally exposed to visitors before publication.
    draft = path.replace(f"/{pid}/", f'/{env.ids["draft-room"]}/')
    assert env.client.put(draft, json=payload).status_code == 200
    public_draft = env.client.get("/api/v1/public/buildings/capture-alpha/camera-viewpoints/draft-room")
    assert public_draft.status_code == 404
    with env.sessions() as db:
        b = db.get(models.Building, env.ids["alpha"])
        version = db.query(models.MapVersion).filter_by(building_id=b.id).first()
        version.is_current = False
        db.commit()
    assert env.client.get("/api/v1/public/buildings/capture-alpha/camera-viewpoints/alpha-room").status_code == 404
