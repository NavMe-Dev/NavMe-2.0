"""Unit tests for public building version cache and single-flight data file serving."""
import json
import time
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from wayfinding_api.routers import public
from wayfinding_api import schemas


def test_building_version_cache_miss_then_hit(tmp_path):
    public.invalidate_building_cache()
    mock_db = MagicMock()
    
    mock_b = MagicMock()
    mock_b.id = 101
    mock_b.slug = "test-building"
    mock_b.georef = {"mode": "test"}

    mock_mv = MagicMock()
    mock_mv.version = 3
    mock_mv.path = str(tmp_path)

    # First call: query DB
    with patch("wayfinding_api.routers.public.building_or_404", return_value=mock_b), \
         patch("wayfinding_api.routers.public.current_version", return_value=mock_mv):
        bid, ver, path, georef = public.get_cached_building_version(mock_db, "test-building")
        assert bid == 101
        assert ver == 3
        assert path == str(tmp_path)
        assert georef == {"mode": "test"}

    # Second call immediately after: should hit cache without calling building_or_404 or current_version
    with patch("wayfinding_api.routers.public.building_or_404") as mock_b_call, \
         patch("wayfinding_api.routers.public.current_version") as mock_v_call:
        bid2, ver2, path2, georef2 = public.get_cached_building_version(mock_db, "test-building")
        assert bid2 == 101
        assert ver2 == 3
        assert path2 == str(tmp_path)
        assert georef2 == {"mode": "test"}
        assert mock_b_call.call_count == 0
        assert mock_v_call.call_count == 0

    # Invalidation clears cache
    public.invalidate_building_cache("test-building")
    with patch("wayfinding_api.routers.public.building_or_404", return_value=mock_b) as mock_b_call, \
         patch("wayfinding_api.routers.public.current_version", return_value=mock_mv) as mock_v_call:
        bid3, ver3, path3, georef3 = public.get_cached_building_version(mock_db, "test-building")
        assert bid3 == 101
        assert mock_b_call.call_count == 1
        assert mock_v_call.call_count == 1
