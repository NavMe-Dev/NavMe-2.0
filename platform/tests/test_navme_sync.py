"""Regression coverage for complete, idempotent dashboard-to-viewer POI sync."""
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from uuid import uuid4
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text
from wayfinding_api import models
from wayfinding_api.config import get_settings
from wayfinding_api.db import Base, engine, SessionLocal
from wayfinding_api.main import app
from wayfinding_api.services import navme_sync

class Response:
    def __init__(self, rows, content_range=None):
        self.rows = rows
        self.headers = {"Content-Range": content_range} if content_range else {}
    def read(self): return json.dumps(self.rows).encode()
    def __enter__(self): return self
    def __exit__(self, *args): pass

@pytest.mark.parametrize("exact_count", [True, False])
def test_pages_past_server_cap_in_stable_order(monkeypatch, exact_count):
    rows = [{"id": str(i)} for i in range(1205)]
    offsets = []
    def request(req, **kwargs):
        q = parse_qs(urlparse(req.full_url).query)
        assert q["order"] == ["id.asc"]
        assert q["poi_type"] == ['eq."GCU Campus"']
        offset = int(q["offset"][0]); offsets.append(offset)
        page = rows[offset:offset + 100]
        return Response(page, f"{offset}-{offset + len(page) - 1}/{len(rows)}" if exact_count else None)
    monkeypatch.setattr(navme_sync.urllib.request, "urlopen", request)
    cfg = SimpleNamespace(supabase_url="https://test.invalid", supabase_anon_key="test")
    assert navme_sync.fetch_rows(cfg, "navme_pois", {"poi_type": 'eq."GCU Campus"'}) == rows
    assert offsets[-1] >= 1200

@pytest.fixture
def building():
    with engine().begin() as c: c.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    Base.metadata.create_all(engine())
    with SessionLocal() as db:
        b = models.Building(slug="sync-" + uuid4().hex[:12], name="Sync test", pipeline_config={"navme_poi_type": "GCU"})
        db.add(b); db.commit()
        yield db, b
        db.rollback()
        db.query(models.POI).filter_by(building_id=b.id).delete()
        db.delete(b); db.commit()

def mock_source(monkeypatch, rows):
    def fetch(cfg, table, filters):
        assert filters["poi_type"] == "eq.GCU"
        if table == "navme_pois":
            assert filters["is_active"] == "is.true"
            return rows
        if table == "navme_floors": return [{"id": "floor", "name": "Ground"}]
        return [{"id": "cat", "name": "Library", "sort_order": 1}]
    monkeypatch.setattr(navme_sync, "fetch_rows", fetch)

def row(**values):
    return {"id": str(uuid4()), "poi_name": "Library", "pos_x": 0, "pos_y": 0, "pos_z": 0,
            "floor_id": "floor", "category_type": "cat", "expected_pos_x": 0,
            "expected_pos_y": 2, "expected_pos_z": 3, **values}

def test_235_pois_visible_and_repeat_sync_idempotent(building, monkeypatch):
    db, b = building
    rows = [row(poi_name=f"Room {i}") for i in range(235)]
    mock_source(monkeypatch, rows)
    first = navme_sync.sync_pois(db, b, get_settings()); db.commit()
    assert (first["created"], first["updated"], first["skipped"]) == (235, 0, 0)
    second = navme_sync.sync_pois(db, b, get_settings()); db.commit()
    assert (second["created"], second["updated"]) == (0, 235)
    # A complete sync remains draft-only until the building is published.
    draft_response = TestClient(app).get(f"/api/v1/public/dashboard/buildings/{b.slug}/navme-pois")
    assert draft_response.status_code == 200 and draft_response.json() == []
    db.add(models.MapVersion(building_id=b.id, version=1,
                            path=str(get_settings().published_dir / b.slug / "v1"),
                            is_current=True, summary={}))
    db.commit()
    response = TestClient(app).get(f"/api/v1/public/dashboard/buildings/{b.slug}/navme-pois")
    assert response.status_code == 200
    assert len(response.json()) == 235
    assert {r["id"] for r in response.json()} == {r["id"] for r in rows}
    p = db.query(models.POI).filter_by(building_id=b.id).first()
    assert (p.model_x, p.model_y, p.model_z) == (0, 0, 0)
    assert p.extra["expected_pos_x"] == 0
    assert (p.floor, p.category) == ("Ground", "library")

def test_legacy_row_becomes_visible_without_duplicate(building, monkeypatch):
    db, b = building
    r = row()
    db.add(models.POI(building_id=b.id, key="sb_" + r["id"], source="admin", name="Old", floor="F1")); db.commit()
    mock_source(monkeypatch, [r])
    result = navme_sync.sync_pois(db, b, get_settings()); db.commit()
    assert (result["created"], result["updated"]) == (0, 1)
    p = db.query(models.POI).filter_by(building_id=b.id).one()
    assert p.source == "supabase"

def test_invalid_rows_reported_without_losing_valid_rows(building, monkeypatch):
    db, b = building
    mock_source(monkeypatch, [row(), row(pos_y=None), row(pos_x=float("nan")), row(poi_name=" ")])
    result = navme_sync.sync_pois(db, b, get_settings()); db.commit()
    assert (result["source_total"], result["synced"], result["skipped"]) == (4, 1, 3)
    assert len(result["errors"]) == 3
    assert db.query(models.POI).filter_by(building_id=b.id).count() == 1

def test_source_failure_preserves_existing_pois(building, monkeypatch):
    db, b = building
    db.add(models.POI(building_id=b.id, key="keep", name="Keep", floor="F1", source="supabase")); db.commit()
    def fail(*args): raise RuntimeError("unavailable")
    monkeypatch.setattr(navme_sync, "fetch_rows", fail)
    with pytest.raises(HTTPException) as exc: navme_sync.sync_pois(db, b, get_settings())
    assert exc.value.status_code == 502
    assert db.query(models.POI).filter_by(building_id=b.id).one().name == "Keep"


def test_active_sync_recovers_only_pipeline_retired_mirrors(building, monkeypatch):
    db, b = building
    source_rows = {name: row(poi_name=name) for name in ["active", "draft", "locked", "inactive", "absent", "invalid"]}
    source_rows["invalid"]["pos_x"] = None
    original = {}
    for name, source in source_rows.items():
        extra = {"gmap_src_id": source["id"], "keep_metadata": name}
        if name != "draft":
            extra["stale"] = True
        poi = models.POI(building_id=b.id, key="existing_" + source["id"], name=name,
                         floor="F1", source="supabase", published=False, locked=name == "locked", extra=extra)
        db.add(poi); db.flush(); original[name] = (poi.id, poi.key)
    db.commit()
    # Inactive and absent records are not returned by the active-only query.
    mock_source(monkeypatch, [source_rows[name] for name in ["active", "draft", "locked", "invalid"]])
    result = navme_sync.sync_pois(db, b, get_settings()); db.commit()
    assert (result["created"], result["updated"], result["skipped"]) == (0, 3, 1)
    current = {p.name: p for p in db.query(models.POI).filter_by(building_id=b.id)}
    assert current["active"].published is True and "stale" not in current["active"].extra
    assert current["draft"].published is False and "stale" not in current["draft"].extra
    for name in ["locked", "inactive", "absent", "invalid"]:
        assert current[name].published is False and current[name].extra["stale"] is True
    assert current["locked"].locked is True
    for name, poi in current.items():
        assert (poi.id, poi.key) == original[name]
        assert poi.source == "supabase"
        assert poi.extra["gmap_src_id"] == source_rows[name]["id"]
        assert poi.extra["keep_metadata"] == name
    again = navme_sync.sync_pois(db, b, get_settings()); db.commit()
    assert (again["created"], again["updated"]) == (0, 3)
    assert db.query(models.POI).filter_by(building_id=b.id).count() == 6


@pytest.mark.parametrize("cms_in_pipeline", [False, True])
def test_pipeline_import_preserves_cms_ownership(building, monkeypatch, tmp_path, cms_in_pipeline):
    from wayfinding_api.services import workspace
    db, b = building
    records = [models.POI(building_id=b.id, key="cms-visible", name="CMS visible", category="CMS category", floor="F1", source="supabase", published=True,
                          model_x=1, model_y=2, model_z=3, nearest_node="old-node", extra={"gmap_src_id":"stable-cms-id", "keep_metadata":True}),
               models.POI(building_id=b.id, key="cms-draft", name="CMS draft", floor="F1", source="supabase", published=False),
               models.POI(building_id=b.id, key="generated-old", name="Old generated", floor="F1", source="auto", published=True)]
    db.add_all(records); db.commit()
    (tmp_path/"out").mkdir(); (tmp_path/"work").mkdir()
    fixture = {
        "out/georef.json": {}, "work/floors_resolved.json": {"floors": []},
        "work/mp_model.json": {"data": {"model": {"floors": [], "locations": [], "rooms": []}}},
        "out/config.json": {"center": {"lat": 1, "lon": 2}, "bounds": [1,1,2,2], "stats": {}},
        "out/nav_graph.json": {"nodes": [{"id":"new-node"}], "edges": []}, "out/pois.json": {"pois": []},
    }
    if cms_in_pipeline:
        fixture["out/pois.json"]["pois"] = [{"id":"cms-visible", "name":"Pipeline replacement", "category":"generated", "floor":"F2",
                                             "lonlat":[6,7], "model":{"x":9,"y":9,"z":9}, "nearest_node":"new-node", "source":"auto",
                                             "step_free_from_parking":True}]
    for path, value in fixture.items():
        (tmp_path/path).write_text(json.dumps(value))
    monkeypatch.setattr(workspace, "ws_dir", lambda building: tmp_path)
    workspace.import_outputs(db, b)
    by_key = {p.key: p for p in db.query(models.POI).filter_by(building_id=b.id)}
    assert by_key["cms-visible"].published is True and "stale" not in by_key["cms-visible"].extra
    cms = by_key["cms-visible"]
    assert (cms.name,cms.category,cms.source,cms.floor) == ("CMS visible","CMS category","supabase","F1")
    assert (cms.model_x,cms.model_y,cms.model_z) == (1,2,3)
    assert cms.extra == {"gmap_src_id":"stable-cms-id", "keep_metadata":True}
    if cms_in_pipeline:
        assert cms.nearest_node == "new-node" and cms.step_free_auto is True
    assert by_key["cms-draft"].published is False and "stale" not in by_key["cms-draft"].extra
    assert by_key["generated-old"].published is False and by_key["generated-old"].extra["stale"] is True
