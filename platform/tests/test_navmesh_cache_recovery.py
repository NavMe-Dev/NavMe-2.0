"""Native Recast file recovery is shared and never exposes partial static files."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Barrier, Event
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from starlette.requests import Request

from wayfinding_api.routers import public
from wayfinding_api.services import bundle_storage


def settings(monkeypatch, root, *, timeout=2):
    cfg = SimpleNamespace(viewer_dir=root, bundle_cache_wait_timeout_seconds=timeout)
    monkeypatch.setattr(bundle_storage, "get_settings", lambda: cfg)
    monkeypatch.setattr(public, "get_settings", lambda: cfg)


def test_24_cold_native_reads_share_one_completed_file(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path)
    entered, finish = Event(), Event()
    start = Barrier(24)
    calls = []
    payload = b"native-mesh-" * 200_000

    def fetch(slug):
        calls.append(slug)
        entered.set()
        assert finish.wait(5)
        return payload

    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", fetch)
    def one(_):
        start.wait(timeout=5)
        return bundle_storage.cache_navmesh_file(tmp_path, "uncc").read_bytes()

    with ThreadPoolExecutor(max_workers=24) as pool:
        results = [pool.submit(one, n) for n in range(24)]
        try:
            assert entered.wait(3)
            assert not (tmp_path / "uncc_navmesh.navmesh").exists()
            assert not any(result.done() for result in results)
        finally:
            finish.set()
        assert [result.result(timeout=5) for result in results] == [payload] * 24
    assert calls == ["uncc"]
    assert not list(tmp_path.glob(".navmesh-*"))


def test_partial_native_write_stays_private_until_atomic_replace(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path)
    partial, finish = Event(), Event()
    original = bundle_storage.tempfile.NamedTemporaryFile
    payload = b"A" * 1024 + b"Z" * 1024
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", lambda slug: payload)

    @contextmanager
    def slow_temporary(**kwargs):
        with original(**kwargs) as out:
            class Writer:
                name = out.name
                def write(self, data):
                    out.write(data[:1024]); out.flush()
                    partial.set()
                    assert finish.wait(5)
                    out.write(data[1024:])
            yield Writer()

    monkeypatch.setattr(bundle_storage.tempfile, "NamedTemporaryFile", slow_temporary)
    target = tmp_path / "uncc_navmesh.navmesh"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(bundle_storage.cache_navmesh_file, tmp_path, "uncc")
        second = None
        try:
            assert partial.wait(3)
            assert not target.exists()
            private = list(tmp_path.glob(".navmesh-*"))
            assert len(private) == 1 and private[0].read_bytes() == payload[:1024]
            second = pool.submit(bundle_storage.cache_navmesh_file, tmp_path, "uncc")
            assert not second.done()
        finally:
            finish.set()
        assert first.result(timeout=3) == second.result(timeout=3) == target
    assert target.read_bytes() == payload
    assert not list(tmp_path.glob(".navmesh-*"))


def test_failed_native_write_cleans_private_file_and_can_retry(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path)
    original = bundle_storage.tempfile.NamedTemporaryFile
    calls = []
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", lambda slug: calls.append(slug) or b"complete")

    @contextmanager
    def full_disk(**kwargs):
        with original(**kwargs) as out:
            class Writer:
                name = out.name
                def write(self, data):
                    out.write(data[:2])
                    raise OSError("cache disk is full")
            yield Writer()

    monkeypatch.setattr(bundle_storage.tempfile, "NamedTemporaryFile", full_disk)
    assert bundle_storage.cache_navmesh_file(tmp_path, "uncc") is None
    assert not list(tmp_path.iterdir())
    monkeypatch.setattr(bundle_storage.tempfile, "NamedTemporaryFile", original)
    assert bundle_storage.cache_navmesh_file(tmp_path, "uncc").read_bytes() == b"complete"
    assert calls == ["uncc", "uncc"]


@pytest.mark.parametrize("payload", [None, b""])
def test_missing_native_storage_preserves_fallback(monkeypatch, tmp_path, payload):
    settings(monkeypatch, tmp_path)
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", lambda slug: payload)
    assert bundle_storage.cache_navmesh_file(tmp_path, "uncc") is None
    assert not list(tmp_path.iterdir())


def test_readonly_native_cache_preserves_fallback(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path)
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", lambda slug: b"complete")
    def denied(**kwargs):
        raise PermissionError("cache is read-only")
    monkeypatch.setattr(bundle_storage.tempfile, "NamedTemporaryFile", denied)
    assert bundle_storage.cache_navmesh_file(tmp_path, "uncc") is None
    assert not list(tmp_path.iterdir())


def test_native_wait_timeout_does_not_cancel_or_duplicate_leader(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path, timeout=.02)
    entered, finish = Event(), Event()
    calls = []
    def fetch(slug):
        calls.append(slug); entered.set()
        assert finish.wait(5)
        return b"complete"
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", fetch)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(bundle_storage.cache_navmesh_file, tmp_path, "uncc")
        try:
            assert entered.wait(3)
            with pytest.raises(bundle_storage.BundleCacheTimeout):
                bundle_storage.cache_navmesh_file(tmp_path, "uncc")
            assert not first.done()
            assert calls == ["uncc"]
        finally:
            finish.set()
        assert first.result(timeout=3).read_bytes() == b"complete"
    assert bundle_storage.cache_navmesh_file(tmp_path, "uncc").read_bytes() == b"complete"
    assert calls == ["uncc"]


@pytest.mark.parametrize("separate_roots", [False, True])
def test_native_cache_keys_load_independently(monkeypatch, tmp_path, separate_roots):
    settings(monkeypatch, tmp_path)
    downloading = Barrier(2)
    calls = []
    def fetch(slug):
        calls.append(slug)
        downloading.wait(timeout=3)
        return slug.encode()
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", fetch)
    args = [(tmp_path / "a", "uncc"), (tmp_path / "b", "uncc")] if separate_roots else [(tmp_path, "uncc"), (tmp_path, "gcu")]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(bundle_storage.cache_navmesh_file, *arg) for arg in args]
        assert [result.result(timeout=4).read_bytes() for result in results] == [arg[1].encode() for arg in args]
    assert len(calls) == 2


def test_existing_native_override_is_not_refetched_or_replaced(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path)
    target = tmp_path / "uncc_navmesh.navmesh"; target.write_bytes(b"existing-override")
    fetch = MagicMock(side_effect=AssertionError("Existing override must stay untouched"))
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", fetch)
    assert bundle_storage.cache_navmesh_file(tmp_path, "uncc") == target
    assert target.read_bytes() == b"existing-override"
    fetch.assert_not_called()


def test_native_cache_rejects_paths_outside_viewer_root(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path)
    fetch = MagicMock(side_effect=AssertionError("Invalid path must not fetch storage"))
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", fetch)
    with pytest.raises(FileNotFoundError):
        bundle_storage.cache_navmesh_file(tmp_path, "../outside")
    fetch.assert_not_called()


def test_public_native_handler_preserves_response_and_shares_cold_fetch(monkeypatch, tmp_path):
    settings(monkeypatch, tmp_path)
    start = Barrier(24); entered, finish = Event(), Event(); calls = []
    def fetch(slug):
        calls.append(slug); entered.set()
        assert finish.wait(5)
        return b"complete"
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", fetch)
    def one(_):
        db = MagicMock(); db.query.return_value.filter_by.return_value.first.return_value = None
        request = Request({"type": "http", "scheme": "http", "server": ("fixture.invalid", 80), "path": "/", "headers": []})
        start.wait(timeout=5)
        return public.dashboard_navmesh_url("uncc", request, db)
    with ThreadPoolExecutor(max_workers=24) as pool:
        futures = [pool.submit(one, n) for n in range(24)]
        try:
            assert entered.wait(3)
        finally:
            finish.set()
        results = [future.result(timeout=5) for future in futures]
    assert calls == ["uncc"]
    assert results == [{"url": "/uncc_navmesh.navmesh", "label": "local-override", "poi_type": "uncc", "updated_at": None}] * 24


@pytest.mark.parametrize("cache_readonly", [False, True])
def test_public_native_handler_keeps_configured_pointer_fallback(monkeypatch, tmp_path, cache_readonly):
    settings(monkeypatch, tmp_path)
    monkeypatch.setattr(bundle_storage, "fetch_navmesh_bytes", lambda slug: b"complete" if cache_readonly else None)
    if cache_readonly:
        def denied(**kwargs):
            raise PermissionError("cache is read-only")
        monkeypatch.setattr(bundle_storage.tempfile, "NamedTemporaryFile", denied)
    native = {"url": "https://assets.invalid/existing.navmesh", "label": "Existing", "updated_at": "fixture-time"}
    building = SimpleNamespace(slug="uncc", pipeline_config={"navme_navmesh": native, "navme_poi_type": "Existing venue"})
    db = MagicMock(); db.query.return_value.filter_by.return_value.first.return_value = building
    request = Request({"type": "http", "scheme": "http", "server": ("fixture.invalid", 80), "path": "/", "headers": []})
    assert public.dashboard_navmesh_url("uncc", request, db) == {
        "url": native["url"], "label": "Existing", "poi_type": "Existing venue", "updated_at": "fixture-time"}
