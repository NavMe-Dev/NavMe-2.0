"""Marker metadata is read-only, active-only and scoped to one dashboard venue."""
from types import SimpleNamespace
from wayfinding_api.services import category_markers


def test_actual_primary_array_and_link_relationships_are_deduplicated(monkeypatch):
    calls = []
    def fetch(cfg, table, filters, **kwargs):
        calls.append((table, filters))
        if table == 'navme_categories':
            assert filters['poi_type'] == 'eq.GCU'
            return [{'id': 'a', 'name': 'A', 'icon_key': 'home'}, {'id': 'b', 'name': 'B', 'icon_key': 'book-open'}]
        if table == 'navme_pois':
            assert filters['poi_type'] == 'eq.GCU'
            assert filters['is_active'] == 'is.true'
            return [{'id': 'one', 'category_type': 'a', 'category_types': ['a', 'b'], 'pos_x': 0, 'pos_y': 2, 'pos_z': -4, 'is_active': True}]
        assert table == 'navme_poi_categories'
        assert filters['poi_id'] == 'in.(one)'
        assert kwargs['order'] == 'poi_id.asc,category_id.asc'
        return [{'poi_id': 'one', 'category_id': 'b'}, {'poi_id': 'one', 'category_id': 'outside-venue'}]
    monkeypatch.setattr(category_markers.navme_sync, 'fetch_rows', fetch)
    result = category_markers.marker_data(None, SimpleNamespace(slug='gcu', pipeline_config={'navme_poi_type': 'GCU'}))
    assert result['building_slug'] == 'gcu'
    assert result['coordinate_system'] == 'matterport-sdk-y-up'
    assert result['pois'] == [{'id': 'one', 'venue': 'gcu', 'category_ids': ['a', 'b'], 'x': 0, 'y': 2, 'z': -4, 'is_active': True}]
    assert len(calls) == 3


def test_empty_venue_does_not_query_unscoped_category_links(monkeypatch):
    def fetch(cfg, table, filters, **kwargs):
        assert table != 'navme_poi_categories'
        assert filters['poi_type'] == 'eq.other'
        return []
    monkeypatch.setattr(category_markers.navme_sync, 'fetch_rows', fetch)
    assert category_markers.marker_data(None, SimpleNamespace(slug='other', pipeline_config={}))['pois'] == []


def test_link_queries_stay_bounded_for_large_venues(monkeypatch):
    sizes = []
    def fetch(cfg, table, filters, **kwargs):
        if table == 'navme_categories': return []
        if table == 'navme_pois': return [{'id': str(i), 'is_active': True} for i in range(235)]
        sizes.append(len(filters['poi_id'][4:-1].split(',')))
        return []
    monkeypatch.setattr(category_markers.navme_sync, 'fetch_rows', fetch)
    category_markers.marker_data(None, SimpleNamespace(slug='gcu', pipeline_config={}))
    assert sizes == [100, 100, 35]


def test_optional_endpoint_handles_failures_without_raw_backend_details(monkeypatch):
    from fastapi.testclient import TestClient
    from wayfinding_api.main import app
    from wayfinding_api.db import get_db
    from wayfinding_api.routers import public
    class DB:
        def query(self, model): return self
        def filter_by(self, **filters): return self
        def first(self): return SimpleNamespace(slug='gcu')
    monkeypatch.setattr(public, 'get_settings', lambda: SimpleNamespace(supabase_url='https://test.invalid', supabase_anon_key='test'))
    def fail(*args): raise RuntimeError('private backend detail')
    monkeypatch.setattr(category_markers, 'marker_data', fail)
    app.dependency_overrides[get_db] = lambda: DB()
    try:
        response = TestClient(app).get('/api/v1/public/buildings/gcu/category-marker-data')
        assert response.status_code == 502
        assert response.json()['detail'] == 'Category labels are unavailable right now.'
        assert 'private backend' not in response.text
    finally:
        app.dependency_overrides.pop(get_db, None)
