"""Optional venue weather. No visitor location, DB writes, or startup dependency."""
from __future__ import annotations
import json
import logging
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

log = logging.getLogger(__name__)
TTL = 15 * 60
URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
USER_AGENT = 'NavMe/2.0 (+https://wayfinding.navme.space/)'
_cache = {}
_locks = {}
_guard = threading.Lock()


def coordinates(building):
    origin = (building.georef or {}).get('model_origin_wgs84') or {}
    for lat, lon in [(building.lat, building.lon), (origin.get('lat'), origin.get('lon'))]:
        if lat is None or lon is None or isinstance(lat, bool) or isinstance(lon, bool):
            continue
        try:
            lat, lon = float(lat), float(lon)
            if math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
                return (round(lat, 4), round(lon, 4))
        except (TypeError, ValueError):
            pass
    return None


def condition(symbol):
    symbol = str(symbol or '')
    if 'thunder' in symbol: return 'Thunderstorms', 'thunderstorm'
    if 'snow' in symbol or 'sleet' in symbol: return 'Snow or sleet', 'weather_snowy'
    if 'rain' in symbol: return 'Rain', 'rainy'
    if 'fog' in symbol: return 'Fog', 'foggy'
    if 'partlycloudy' in symbol or 'fair' in symbol: return 'Partly cloudy', 'partly_cloudy_day'
    if 'cloudy' in symbol: return 'Cloudy', 'cloud'
    if 'clearsky' in symbol: return ('Clear', 'dark_mode') if symbol.endswith('_night') else ('Clear', 'wb_sunny')
    return 'Outdoor weather', 'device_thermostat'


def current(payload, now):
    rows = (payload.get('properties') or {}).get('timeseries') or []
    candidates = []
    for row in rows:
        try:
            stamp = datetime.fromisoformat(row['time'].replace('Z', '+00:00')).timestamp()
            value = row['data']['instant']['details']['air_temperature']
            if isinstance(value, bool) or value is None: continue
            temperature = float(value)
            if not math.isfinite(temperature) or abs(stamp - now) > 3 * 3600: continue
            candidates.append((stamp, temperature, row))
        except (KeyError, TypeError, ValueError):
            continue
    if not candidates: raise ValueError('No current weather period')
    past = [item for item in candidates if item[0] <= now]
    stamp, temperature, row = max(past, key=lambda item: item[0]) if past else min(candidates, key=lambda item: item[0])
    data = row['data']
    symbol = next((data[key].get('summary', {}).get('symbol_code') for key in ['next_1_hours', 'next_6_hours', 'next_12_hours']
                   if data.get(key, {}).get('summary', {}).get('symbol_code')), '')
    description, icon = condition(symbol)
    return {'temperature_c': temperature, 'condition': description, 'icon': icon, 'valid_at': row['time'],
            'updated_at': ((payload.get('properties') or {}).get('meta') or {}).get('updated_at')}


def venue_weather(building):
    position = coordinates(building)
    unavailable = {'building_slug': building.slug, 'available': False, 'cache_seconds': 60}
    if position is None:
        return {**unavailable, 'cache_seconds': TTL, 'reason': 'venue-location-unavailable'}
    with _guard:
        lock = _locks.setdefault(position, threading.Lock())
    with lock:
        now = time.time()
        cached = _cache.get(position)
        if not cached or now >= cached['expires']:
            headers = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
            if cached and cached.get('modified'): headers['If-Modified-Since'] = cached['modified']
            try:
                request = urllib.request.Request(URL + '?' + urllib.parse.urlencode({'lat': position[0], 'lon': position[1]}), headers=headers)
                try:
                    with urllib.request.urlopen(request, timeout=6) as response:
                        payload = json.load(response)
                        response_headers = response.headers
                except urllib.error.HTTPError as error:
                    if error.code != 304 or not cached or not cached.get('payload'): raise
                    payload, response_headers = cached['payload'], error.headers
                expires = now + TTL
                try: expires = max(expires, parsedate_to_datetime(response_headers.get('Expires', '')).timestamp())
                except (TypeError, ValueError, IndexError): pass
                cached = {'payload': payload, 'expires': expires,
                          'modified': response_headers.get('Last-Modified') or (cached or {}).get('modified')}
                _cache[position] = cached
            except Exception as exc:
                log.warning('Venue weather unavailable for %s (%s)', building.slug, type(exc).__name__)
                _cache[position] = {'expires': now + 60, 'payload': None}
                return {**unavailable, 'reason': 'weather-unavailable'}
        try:
            data = current(cached['payload'], now)
        except (TypeError, ValueError, AttributeError):
            return {**unavailable, 'reason': 'weather-unavailable'}
        return {'building_slug': building.slug, 'available': True, 'cache_seconds': TTL,
                **data, 'provider': 'MET Norway', 'provider_url': 'https://api.met.no/',
                'license_url': 'https://creativecommons.org/licenses/by/4.0/'}
