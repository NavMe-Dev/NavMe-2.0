from types import SimpleNamespace
from wayfinding_api.services import venue_info


def building(**values):
    return SimpleNamespace(slug='gcu', matterport_model_id='space-a', name='NavMe fallback', address='Known address', branding={}, model_info={}, **values)


def test_authoritative_model_name_and_address(monkeypatch):
    def gql(query, variables, timeout):
        assert variables == {'id': 'space-a'}
        assert timeout == 8
        return {'data': {'model': {'id': 'space-a', 'name': 'Actual space', 'address': {'lines': ['Street'], 'locality': 'City'}}}}
    monkeypatch.setattr(venue_info, 'gql', gql)
    b = building(); result = venue_info.venue_info(b)
    assert result['name'] == 'Actual space'
    assert result['address'] == 'Street, City'
    assert result['source'] == 'matterport'
    assert b.name == 'NavMe fallback'
    assert set(result) == {'building_slug', 'model_id', 'name', 'address', 'description', 'source'}


def test_wrong_space_never_supplies_a_name(monkeypatch):
    monkeypatch.setattr(venue_info, 'gql', lambda *args, **kwargs: {'data': {'model': {'id': 'other', 'name': 'Wrong space'}}})
    assert venue_info.venue_info(building())['name'] == 'NavMe fallback'


def test_confirmed_synchronized_metadata_is_used_when_fresh_request_fails(monkeypatch):
    def fail(*args, **kwargs): raise RuntimeError('unavailable')
    monkeypatch.setattr(venue_info, 'gql', fail)
    b = building(); b.model_info = {'model_id': 'space-a', 'mp_name': 'Synchronized'}
    assert venue_info.venue_info(b)['name'] == 'Synchronized'
    b.model_info = {'model_id': 'old-space', 'mp_name': 'Stale'}
    assert venue_info.venue_info(b)['name'] == 'NavMe fallback'


def test_no_name_or_model_has_neutral_fallback_and_no_remote_call(monkeypatch):
    def fail(*args, **kwargs): raise AssertionError('no model to query')
    monkeypatch.setattr(venue_info, 'gql', fail)
    b = building(); b.name = ''; b.matterport_model_id = ''
    result = venue_info.venue_info(b)
    assert result['name'] == 'Venue information'
    assert result['description'] == ''
