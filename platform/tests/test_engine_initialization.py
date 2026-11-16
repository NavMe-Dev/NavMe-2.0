"""Concurrent cold requests must share one engine and its bounded pool."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

from wayfinding_api import db


def test_concurrent_first_requests_create_only_one_pool(monkeypatch):
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_Session", None)
    builds = []
    start = threading.Barrier(24)

    def build(settings):
        candidate = MagicMock()
        builds.append(candidate)
        time.sleep(0.05)  # Slow construction opens the real cold-start race.
        return candidate

    monkeypatch.setattr(db, "build_engine", build)
    monkeypatch.setattr(db, "get_settings", lambda: object())

    def request():
        start.wait(timeout=3)
        return db.engine()

    with ThreadPoolExecutor(max_workers=24) as pool:
        results = list(pool.map(lambda _: request(), range(24)))
    assert len(builds) == 1
    assert all(result is builds[0] for result in results)
    assert db._Session.kw["bind"] is builds[0]


def test_failed_initialization_can_retry_without_publishing_partial_state(monkeypatch):
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_Session", None)
    candidate = MagicMock()
    factory = MagicMock(side_effect=[RuntimeError("unavailable"), candidate])
    monkeypatch.setattr(db, "build_engine", factory)
    monkeypatch.setattr(db, "get_settings", lambda: object())
    try:
        db.engine()
    except RuntimeError:
        pass
    else:
        raise AssertionError("First initialization should fail")
    assert db._engine is None and db._Session is None
    assert db.engine() is candidate
    assert factory.call_count == 2
