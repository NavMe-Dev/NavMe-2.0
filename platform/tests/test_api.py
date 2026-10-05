"""API tests against a real PostGIS test DB. Schema is rebuilt at session start."""
import io, json, shutil, pytest
from conftest import GREENLAND_WS
from fastapi.testclient import TestClient
from sqlalchemy import text
from wayfinding_api.db import Base, engine, SessionLocal
from wayfinding_api import models
from wayfinding_api.auth import hash_password
from wayfinding_api.main import app


@pytest.fixture(scope="session")
def client():
    with engine().begin() as c:
        c.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    Base.metadata.drop_all(engine()); Base.metadata.create_all(engine())
    with SessionLocal() as db:
        db.add(models.User(email="admin@test", password_hash=hash_password("pw-123456"), is_admin=True)); db.commit()
    return TestClient(app)


@pytest.fixture(scope="session")
def auth(client):
    r = client.post("/api/v1/auth/login", data={"username": "admin@test", "password": "pw-123456"})
    assert r.status_code == 200
    return {"Authorization": "Bearer " + r.json()["access_token"]}


def test_health(client):
    assert client.get("/api/health").json()["ok"]


def test_login_rejects_bad_password(client):
    assert client.post("/api/v1/auth/login", data={"username": "admin@test", "password": "nope"}).status_code == 401


def test_admin_requires_auth(client):
    assert client.get("/api/v1/admin/buildings").status_code == 401


def test_building_and_poi_crud(client, auth):
    assert client.post("/api/v1/admin/venues", json={"slug": "campus", "name": "Campus"}, headers=auth).status_code == 200
    r = client.post("/api/v1/admin/buildings", json={"slug": "b1", "name": "B1", "lat": 35.2, "lon": -80.8, "venue_slug": "campus"}, headers=auth)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/admin/buildings/b1/pois", json={"name": "X", "floor": "F1", "lon": -80.8, "lat": 35.2}, headers=auth)
    assert r.status_code == 400                                   # POIs need a georeference first
    from wfpipe.geo import affine_from_params
    with SessionLocal() as db:
        b = db.query(models.Building).filter_by(slug="b1").one()
        b.georef = {"model_to_epsg3857_affine": [list(r) for r in affine_from_params(35.2, -80.8, 0)]}; db.commit()
    r = client.post("/api/v1/admin/buildings/b1/pois", json={"name": "Office", "category": "office", "floor": "F1", "lon": -80.8, "lat": 35.2}, headers=auth)
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    r = client.patch(f"/api/v1/admin/buildings/b1/pois/{pid}", json={"name": "Main office", "hours": "9-5"}, headers=auth)
    assert r.json()["name"] == "Main office" and r.json()["hours"] == "9-5"
    csv = client.get("/api/v1/admin/buildings/b1/pois.csv", headers=auth).text
    assert "Main office" in csv.splitlines()[1]
    r = client.post("/api/v1/admin/buildings/b1/pois/import", files={"file": ("p.csv", csv.replace("Main office", "Front office"), "text/csv")}, headers=auth)
    assert r.status_code == 200, r.text
    names = [p["name"] for p in client.get("/api/v1/admin/buildings/b1/pois", headers=auth).json()]
    assert "Front office" in names and len(names) == 1          # import upserts by key
    assert client.delete(f"/api/v1/admin/buildings/b1/pois/{pid}", headers=auth).status_code == 200


def test_public_unpublished_is_404(client):
    assert client.get("/api/v1/public/buildings/b1/data/config.json").status_code == 404


@pytest.mark.skipif(not (GREENLAND_WS / "out/config.json").exists(), reason="Greenland workspace not onboarded")
def test_import_publish_route_greenland(client, auth):
    from wayfinding_api.config import get_settings
    from wayfinding_api.services import workspace
    r = client.post("/api/v1/admin/buildings", json={"slug": "greenland", "name": "Shiloh", "lat": 35.2262, "lon": -80.8793, "venue_slug": "campus"}, headers=auth)
    assert r.status_code == 200
    dst = get_settings().buildings_dir / "greenland"
    shutil.copytree(GREENLAND_WS / "out", dst / "out"); shutil.copytree(GREENLAND_WS / "work", dst / "work", ignore=shutil.ignore_patterns("matterpak", "*.npz", "sat*"))
    with SessionLocal() as db:
        b = db.query(models.Building).filter_by(slug="greenland").one(); workspace.import_outputs(db, b); db.commit()
    pois = client.get("/api/v1/admin/buildings/greenland/pois", headers=auth).json()
    assert len(pois) > 10 and {p["floor"] for p in pois} == {"F1", "F2"}
    # edit a POI, publish, check the public bundle
    ent = next(p for p in pois if p["category"] == "entrance")
    client.patch(f"/api/v1/admin/buildings/greenland/pois/{ent['id']}", json={"name": "Front doors (test)"}, headers=auth)
    r = client.post("/api/v1/admin/buildings/greenland/publish", json={"notes": "t"}, headers=auth)
    assert r.status_code == 200, r.text
    pub = client.get("/api/v1/public/buildings/greenland/data/pois.json").json()
    feats = pub["pois"]
    assert any(f["name"] == "Front doors (test)" for f in feats)
    cfg = client.get("/api/v1/public/buildings/greenland/data/config.json").json()
    assert [f["id"] for f in cfg["floors"]] == ["F1", "F2"]
    man = client.get("/api/v1/public/venues/campus/manifest.json").json()
    assert any(b["slug"] == "greenland" for b in man["buildings"])
    # route between two POIs on different floors
    a = next(p for p in pois if p["floor"] == "F1"); z = next(p for p in pois if p["floor"] == "F2" and p["key"] != a["key"])
    r = client.post("/api/v1/public/buildings/greenland/route", json={"from_key": a["key"], "to_key": z["key"]})
    assert r.status_code == 200, r.text
    assert r.json()["length_m"] > 0
