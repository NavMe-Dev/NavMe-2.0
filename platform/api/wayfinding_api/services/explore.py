"""Optional, cached, read-only metadata for the existing venue Explore panel."""
import threading
import time
from . import navme, navme_sync

_cache = {}
_locks = {}
_guard = threading.Lock()
TTL = 300


def metadata(cfg, building):
    ptype = navme.poi_type(building)
    key = (cfg.supabase_url, building.slug, ptype, building.matterport_model_id)
    with _guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        cached = _cache.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        filters = {'poi_type': 'eq.' + navme.pg_value(ptype)}
        rows = navme_sync.fetch_rows(cfg, 'navme_pois', {
            **filters, 'is_active': 'is.true', 'select': 'id,poi_name,poi_names,floor_id'})
        floors = navme_sync.fetch_rows(cfg, 'navme_floors', {
            **filters, 'select': 'id,name,floor_names'})
        facilities = navme_sync.fetch_rows(cfg, 'navme_facilities', {
            **filters, 'is_active': 'is.true',
            'select': 'id,facility_name,facility_category,facility_group,floor_name,icon_key'})
        by_floor = {str(f['id']): f for f in floors}
        pois = []
        for row in rows:
            floor = by_floor.get(str(row.get('floor_id')), {})
            pois.append({'id': str(row['id']), 'name': row.get('poi_name'), 'names': row.get('poi_names'),
                         'floor_name': floor.get('name'), 'floor_names': floor.get('floor_names')})
        data = {'building_slug': building.slug, 'source': 'dashboard', 'pois': pois,
                'facilities': facilities}
        _cache[key] = (time.monotonic() + TTL, data)
        return data
