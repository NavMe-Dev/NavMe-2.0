import json
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs,urlparse
import pytest
from wayfinding_api.services import weather

NOW = datetime(2026,10,24,12,tzinfo=timezone.utc).timestamp()
def building(slug='gcu',lat=12.9,lon=77.7,georef=None):
    return SimpleNamespace(slug=slug,lat=lat,lon=lon,georef=georef or {})
def payload(temperature=28.4):
    return {'properties':{'meta':{'updated_at':'2026-10-24T11:00:00Z'},'timeseries':[
        {'time':'2026-10-24T12:00:00Z','data':{'instant':{'details':{'air_temperature':temperature}},'next_1_hours':{'summary':{'symbol_code':'partlycloudy_day'}}}},
        {'time':'2026-10-24T13:00:00Z','data':{'instant':{'details':{'air_temperature':29.2}},'next_1_hours':{'summary':{'symbol_code':'clearsky_day'}}}}
    ]}}
class Response:
    headers={'Last-Modified':'Sat, 24 Oct 2026 11:00:00 GMT'}
    def __init__(self,data): self.data=data
    def read(self,*args): return json.dumps(self.data).encode()
    def __enter__(self): return self
    def __exit__(self,*args): pass
@pytest.fixture(autouse=True)
def cache(monkeypatch):
    weather._cache.clear();weather._locks.clear()
    monkeypatch.setattr(weather.time,'time',lambda:NOW)

def test_venue_coordinates_only_and_valid_zero():
    assert weather.coordinates(building(lat=0,lon=0))==(0,0)
    assert weather.coordinates(building(lat=None,lon=None,georef={'model_origin_wgs84':{'lat':12.123456,'lon':77.654321}}))==(12.1235,77.6543)
    assert weather.coordinates(building(lat=None,lon=None,georef={'model_to_epsg3857_affine':[[1,2,3],[4,5,6]]})) is None
    assert weather.coordinates(building(lat=999,lon=77)) is None
    assert weather.coordinates(building(lat=float('nan'))) is None

def test_provider_request_uses_venue_location_and_identifies_application(monkeypatch):
    calls=[]
    def fetch(req,timeout):
        calls.append(req)
        assert timeout==6
        assert parse_qs(urlparse(req.full_url).query)=={'lat':['12.9'],'lon':['77.7']}
        assert 'NavMe' in req.get_header('User-agent')
        return Response(payload())
    monkeypatch.setattr(weather.urllib.request,'urlopen',fetch)
    first=weather.venue_weather(building());second=weather.venue_weather(building('other'))
    assert first['available'] and first['temperature_c']==28.4
    assert first['cache_seconds']==900
    assert second['building_slug']=='other'
    assert len(calls)==1

def test_cache_refreshes_after_fifteen_minutes_and_revalidates(monkeypatch):
    requests=[]
    def fetch(req,timeout): requests.append(req);return Response(payload())
    monkeypatch.setattr(weather.urllib.request,'urlopen',fetch)
    weather.venue_weather(building())
    monkeypatch.setattr(weather.time,'time',lambda:NOW+899);weather.venue_weather(building());assert len(requests)==1
    monkeypatch.setattr(weather.time,'time',lambda:NOW+901);weather.venue_weather(building());assert len(requests)==2
    assert requests[-1].get_header('If-modified-since')

def test_provider_expiry_respected_while_current_hour_advances(monkeypatch):
    response=Response(payload());response.headers={'Expires':'Sat, 24 Oct 2026 14:00:00 GMT'}
    calls=[]
    monkeypatch.setattr(weather.urllib.request,'urlopen',lambda *args,**kwargs:(calls.append(1) or response))
    assert weather.venue_weather(building())['temperature_c']==28.4
    monkeypatch.setattr(weather.time,'time',lambda:NOW+3600)
    assert weather.venue_weather(building())['temperature_c']==29.2
    assert len(calls)==1

def test_failure_is_optional_and_negatively_cached(monkeypatch):
    calls=[]
    def fail(*args,**kwargs): calls.append(1);raise RuntimeError('private details')
    monkeypatch.setattr(weather.urllib.request,'urlopen',fail)
    result=weather.venue_weather(building())
    assert result['available'] is False
    assert 'private details' not in json.dumps(result)
    assert weather.venue_weather(building())['available'] is False
    assert len(calls)==1

def test_missing_coordinates_do_not_request_weather(monkeypatch):
    def fail(*args,**kwargs): raise AssertionError('must not call provider')
    monkeypatch.setattr(weather.urllib.request,'urlopen',fail)
    assert weather.venue_weather(building(lat=None,lon=None))['available'] is False

@pytest.mark.parametrize('value',[None,True,float('nan'),float('inf')])
def test_invalid_or_missing_temperature_never_becomes_fake_zero(value):
    with pytest.raises(ValueError): weather.current({'properties':{'timeseries':[payload(value)['properties']['timeseries'][0]]}},NOW)
