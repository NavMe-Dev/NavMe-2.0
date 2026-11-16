"""Local storage doubles only: exercise cold-cache contention without remote load."""
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import pytest

from wayfinding_api.services import bundle_storage


def install_storage(monkeypatch, download, *, timeout=2.0):
    calls = []
    calls_lock = threading.Lock()
    monkeypatch.setattr(bundle_storage, "get_settings", lambda: SimpleNamespace(
        supabase_url="https://storage.invalid", supabase_storage_bucket="public-bundles",
        bundle_cache_wait_timeout_seconds=timeout,
    ))

    class Response:
        status_code = 200

        def __init__(self, url):
            self.url = url

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def iter_bytes(self, chunk_size):
            assert chunk_size == 64 * 1024
            yield from download(self.url)

    class Client:
        def __init__(self, **kwargs):
            assert "headers" not in kwargs  # Public recovery never sends a server key.

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def stream(self, method, url):
            assert method == "GET"
            assert "/storage/v1/object/public/public-bundles/published/" in url
            with calls_lock:
                calls.append(url)
            return Response(url)

    monkeypatch.setattr(bundle_storage.httpx, "Client", Client)
    return calls


def test_concurrent_floor_file_and_byte_reads_share_one_atomic_download(monkeypatch, tmp_path):
    partial = threading.Event()
    finish = threading.Event()
    callers = threading.Barrier(24)

    def download(url):
        yield b"first-"
        partial.set()
        assert finish.wait(5)
        yield b"last"

    calls = install_storage(monkeypatch, download)
    target = tmp_path / "floors/2/walkgrid.json"

    def read(index):
        callers.wait(timeout=5)
        if index % 2:
            return bundle_storage.read_bundle_file(tmp_path, "uncc", 7, "floors/2/walkgrid.json")
        return bundle_storage.cache_bundle_file(tmp_path, "uncc", 7, "floors/2/walkgrid.json").read_bytes()

    with ThreadPoolExecutor(max_workers=24) as pool:
        futures = [pool.submit(read, index) for index in range(24)]
        try:
            assert partial.wait(5)
            assert not target.exists()
            assert all(not future.done() for future in futures)
        finally:
            finish.set()
        assert [future.result(timeout=5) for future in futures] == [b"first-last"] * 24
    assert len(calls) == 1
    assert target.read_bytes() == b"first-last"
    assert not list(tmp_path.rglob(".bundle-*"))


def test_different_floor_keys_download_in_parallel(monkeypatch, tmp_path):
    both_downloading = threading.Barrier(2)

    def download(url):
        both_downloading.wait(timeout=5)
        yield url.rsplit("/", 1)[1].encode()

    calls = install_storage(monkeypatch, download)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(bundle_storage.read_bundle_file, tmp_path, "uncc", 1, "floor1.json")
        second = pool.submit(bundle_storage.read_bundle_file, tmp_path, "uncc", 1, "floor2.json")
        assert first.result(timeout=5) == b"floor1.json"
        assert second.result(timeout=5) == b"floor2.json"
    assert len(calls) == 2


def test_failed_download_releases_waiters_and_next_request_can_retry(monkeypatch, tmp_path):
    started = threading.Event()
    finish = threading.Event()
    waiter_joined = threading.Event()
    fail = True

    class TrackedFuture(Future):
        def result(self, timeout=None):
            waiter_joined.set()
            return super().result(timeout)

    monkeypatch.setattr(bundle_storage, "Future", TrackedFuture)

    def download(url):
        yield b"partial"
        started.set()
        assert finish.wait(5)
        if fail:
            raise httpx.ReadError("interrupted")
        yield b"-complete"

    calls = install_storage(monkeypatch, download)
    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(bundle_storage.read_bundle_file, tmp_path, "uncc", 1, "floor.json")
        assert started.wait(5)
        waiter = pool.submit(bundle_storage.read_bundle_file, tmp_path, "uncc", 1, "floor.json")
        try:
            assert waiter_joined.wait(5)
        finally:
            finish.set()
        for future in (leader, waiter):
            with pytest.raises(FileNotFoundError):
                future.result(timeout=5)
    assert len(calls) == 1
    assert not list(tmp_path.iterdir())
    fail = False
    assert bundle_storage.read_bundle_file(tmp_path, "uncc", 1, "floor.json") == b"partial-complete"
    assert len(calls) == 2
    assert not bundle_storage._bundle_flights


def test_wait_timeout_does_not_cancel_or_duplicate_active_download(monkeypatch, tmp_path):
    started = threading.Event()
    finish = threading.Event()

    def download(url):
        started.set()
        assert finish.wait(5)
        yield b"complete"

    calls = install_storage(monkeypatch, download, timeout=0.02)
    with ThreadPoolExecutor(max_workers=1) as pool:
        leader = pool.submit(bundle_storage.cache_bundle_file, tmp_path, "uncc", 1, "floor.json")
        try:
            assert started.wait(5)
            for _ in range(2):
                with pytest.raises(bundle_storage.BundleCacheTimeout):
                    bundle_storage.read_bundle_file(tmp_path, "uncc", 1, "floor.json")
            assert len(calls) == 1
            assert not (tmp_path / "floor.json").exists()
        finally:
            finish.set()
        assert leader.result(timeout=5).read_bytes() == b"complete"
    assert bundle_storage.read_bundle_file(tmp_path, "uncc", 1, "floor.json") == b"complete"
    assert len(calls) == 1
    assert not bundle_storage._bundle_flights


def test_buildings_versions_and_cache_roots_do_not_share_inflight_results(monkeypatch, tmp_path):
    simultaneous = threading.Barrier(4)

    def download(url):
        simultaneous.wait(timeout=5)
        yield url.encode()

    calls = install_storage(monkeypatch, download)
    publications = [(tmp_path / "a/v1", "a", 1), (tmp_path / "a/v2", "a", 2),
                    (tmp_path / "b/v1", "b", 1), (tmp_path / "shadow-a/v1", "a", 1)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(bundle_storage.read_bundle_file, root, slug, version, "floor.json")
                   for root, slug, version in publications]
        for future, (root, slug, version) in zip(futures, publications):
            expected = f"/published/{slug}/v{version}/floor.json".encode()
            assert future.result(timeout=5).endswith(expected)
            assert (root / "floor.json").read_bytes().endswith(expected)
    assert len(calls) == 4


@pytest.mark.parametrize("relative", ["../outside.json", "nested/../../outside.json", "/outside.json", "", "."])
def test_invalid_paths_do_not_reach_storage(monkeypatch, tmp_path, relative):
    def forbidden(*args):
        raise AssertionError("Invalid paths must never contact storage")

    monkeypatch.setattr(bundle_storage.httpx, "Client", forbidden)
    for read in (bundle_storage.cache_bundle_file, bundle_storage.read_bundle_file):
        with pytest.raises(FileNotFoundError, match="Invalid bundle file path"):
            read(tmp_path, "uncc", 1, relative)
    assert not list(tmp_path.iterdir())


def test_symlink_outside_cache_root_is_not_read_or_written(monkeypatch, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "file.json").write_bytes(b"private")
    root = tmp_path / "cache"
    root.mkdir()
    (root / "link").symlink_to(outside, target_is_directory=True)
    for read in (bundle_storage.cache_bundle_file, bundle_storage.read_bundle_file):
        with pytest.raises(FileNotFoundError, match="Invalid bundle file path"):
            read(root, "uncc", 1, "link/file.json")
    assert (outside / "file.json").read_bytes() == b"private"


def test_unwritable_disk_preserves_shared_best_effort_byte_reads(monkeypatch, tmp_path):
    started = threading.Event()
    finish = threading.Event()
    waiter_joined = threading.Event()
    fetches = []

    class TrackedFuture(Future):
        def result(self, timeout=None):
            waiter_joined.set()
            return super().result(timeout)

    def cannot_write(**kwargs):
        raise PermissionError("read-only disk")

    def fetch(slug, version, relpath):
        fetches.append((slug, version, relpath))
        started.set()
        assert finish.wait(5)
        return b"uncached bytes"

    install_storage(monkeypatch, lambda url: iter(()))
    monkeypatch.setattr(bundle_storage, "Future", TrackedFuture)
    monkeypatch.setattr(bundle_storage.tempfile, "NamedTemporaryFile", cannot_write)
    monkeypatch.setattr(bundle_storage, "fetch_bytes", fetch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(bundle_storage.read_bundle_file, tmp_path, "uncc", 1, "config.json")
        assert started.wait(5)
        waiter = pool.submit(bundle_storage.read_bundle_file, tmp_path, "uncc", 1, "config.json")
        try:
            assert waiter_joined.wait(5)
        finally:
            finish.set()
        assert leader.result(timeout=5) == waiter.result(timeout=5) == b"uncached bytes"
    assert fetches == [("uncc", 1, "config.json")]
    with pytest.raises(FileNotFoundError):
        bundle_storage.cache_bundle_file(tmp_path, "uncc", 1, "config.json")
    assert not list(tmp_path.iterdir())
    assert not bundle_storage._bundle_flights
