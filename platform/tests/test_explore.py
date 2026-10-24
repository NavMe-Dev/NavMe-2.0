from types import SimpleNamespace
import pytest
from wayfinding_api.services import explore


@pytest.fixture(autouse=True)
def clear_cache():
    explore._cache.clear()
    explore._locks.clear()


def building(slug='gcu'):
    return SimpleNamespace(id=1, slug=slug, matterport_model_id='model-'+slug,
                           pipeline_config={'navme_poi_type': slug.upper()})


def test_metadata_reads_actual_floor_relationship_and_keeps_missing_floor_unknown(monkeypatch):
    calls = []
    def fetch(cfg, table, filters):
        calls.append((table, filters))
        assert filters['poi_type'] == 'eq.GCU'
        if table == 'navme_pois':
            assert filters['is_active'] == 'is.true'
            return [{'id':'one','poi_name':'Actual room','floor_id':'floor-a'}, {'id':'two','poi_name':'Outdoor place','floor_id':None}]
        if table == 'navme_floors':
            return [{'id':'floor-a','name':'Ground','floor_names':{'hi':'भूतल'}}]
        assert filters['is_active'] == 'is.true'
        return [{'id':'facility','facility_name':'Water station','floor_name':'Ground'}]
    monkeypatch.setattr(explore.navme_sync, 'fetch_rows', fetch)
    data = explore.metadata(SimpleNamespace(supabase_url='https://project.supabase.co'), building())
    assert data['building_slug'] == 'gcu'
    assert data['pois'][0]['floor_name'] == 'Ground'
    assert data['pois'][1]['floor_name'] is None
    assert data['facilities'][0]['facility_name'] == 'Water station'
    assert len(calls) == 3


def test_reopening_tabs_reuses_cache_but_another_venue_gets_its_own_data(monkeypatch):
    calls = []
    def fetch(cfg, table, filters):
        calls.append(filters['poi_type'])
        return []
    monkeypatch.setattr(explore.navme_sync, 'fetch_rows', fetch)
    cfg = SimpleNamespace(supabase_url='https://project.supabase.co')
    explore.metadata(cfg, building());explore.metadata(cfg, building())
    assert calls == ['eq.GCU']*3
    result = explore.metadata(cfg, building('uncc'))
    assert calls[-3:] == ['eq.UNCC']*3
    assert result['building_slug'] == 'uncc'


def test_failed_fetch_is_not_cached_and_can_be_retried(monkeypatch):
    def fail(*args):raise RuntimeError('private provider detail')
    monkeypatch.setattr(explore.navme_sync, 'fetch_rows', fail)
    cfg = SimpleNamespace(supabase_url='https://project.supabase.co')
    with pytest.raises(RuntimeError):explore.metadata(cfg, building())
    assert not explore._cache
    monkeypatch.setattr(explore.navme_sync, 'fetch_rows', lambda *args: [])
    assert explore.metadata(cfg, building())['pois'] == []


def test_cache_expires_after_five_minutes(monkeypatch):
    now = [0];calls=[]
    monkeypatch.setattr(explore.time, 'monotonic', lambda:now[0])
    monkeypatch.setattr(explore.navme_sync, 'fetch_rows', lambda *args:calls.append(1) or [])
    cfg=SimpleNamespace(supabase_url='https://project.supabase.co')
    explore.metadata(cfg,building());now[0]=301;explore.metadata(cfg,building())
    assert len(calls)==6


def test_optional_endpoint_hides_backend_details_on_failure(monkeypatch):
    from fastapi.testclient import TestClient
    from wayfinding_api.main import app
    from wayfinding_api.db import get_db
    from wayfinding_api.routers import public
    class Query:
        def filter_by(self, **kwargs):return self
        def all(self):return []
    class DB:
        def query(self,*args):return Query()
    def fail(*args):raise RuntimeError('private provider detail')
    monkeypatch.setattr(public, 'building_or_404', lambda db,slug:building(slug))
    monkeypatch.setattr(public, 'get_settings', lambda:SimpleNamespace(supabase_url='https://project.supabase.co',supabase_anon_key='configured'))
    monkeypatch.setattr(explore, 'metadata', fail)
    app.dependency_overrides[get_db]=lambda:DB()
    try:
        response=TestClient(app).get('/api/v1/public/buildings/gcu/explore')
        assert response.status_code==503
        assert 'private provider detail' not in response.text
        assert response.headers['cache-control']=='no-store'
    finally:app.dependency_overrides.pop(get_db,None)
