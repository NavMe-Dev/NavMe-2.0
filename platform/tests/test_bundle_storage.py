from types import SimpleNamespace

from wayfinding_api.services import bundle_storage


def test_public_bundle_reads_do_not_require_service_role_key(monkeypatch):
    settings = SimpleNamespace(
        supabase_url="https://project.supabase.co",
        supabase_storage_bucket="wayfinding-bundles",
        supabase_service_role_key="",
    )
    requested = []
    monkeypatch.setattr(bundle_storage, "get_settings", lambda: settings)
    monkeypatch.setattr(
        bundle_storage,
        "_get_chunked",
        lambda url: requested.append(url) or b"bundle file",
    )

    assert not bundle_storage.is_enabled()
    assert bundle_storage.is_read_enabled()
    assert bundle_storage.fetch_bytes("gcu", 5, "config.json") == b"bundle file"
    assert requested == [
        "https://project.supabase.co/storage/v1/object/public/"
        "wayfinding-bundles/published/gcu/v5/config.json"
    ]


def test_public_bundle_reads_need_project_url_and_bucket(monkeypatch):
    monkeypatch.setattr(
        bundle_storage,
        "get_settings",
        lambda: SimpleNamespace(supabase_url="", supabase_storage_bucket=""),
    )

    assert not bundle_storage.is_read_enabled()
    assert bundle_storage.fetch_bytes("gcu", 5, "config.json") is None


class StreamResponse:
    def __init__(self, status, chunks):
        self.status_code = status
        self.chunks = chunks

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    @property
    def content(self):
        raise AssertionError('Bundle downloads must not buffer response.content')

    def iter_bytes(self, chunk_size):
        assert chunk_size == 64 * 1024
        for chunk in self.chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


def storage_client(monkeypatch, responses, manifest=None):
    calls = []
    monkeypatch.setattr(bundle_storage, 'get_settings', lambda: SimpleNamespace(
        supabase_url='https://project.supabase.co', supabase_storage_bucket='bundles'))

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def stream(self, method, url):
            calls.append(url)
            suffix = url.split('/published/uncc/v1/', 1)[1]
            return StreamResponse(*responses[suffix])

        def get(self, url):
            calls.append(url)
            return SimpleNamespace(status_code=200 if manifest is not None else 404, text=manifest or '')

    monkeypatch.setattr(bundle_storage.httpx, 'Client', Client)
    return calls


def test_asset_download_streams_to_disk_and_reuses_cache(monkeypatch, tmp_path):
    calls = storage_client(monkeypatch, {'model.glb': (200, [b'first', b'second'])})
    path = bundle_storage.cache_bundle_file(tmp_path, 'uncc', 1, 'model.glb')
    assert path.read_bytes() == b'firstsecond'
    assert bundle_storage.cache_bundle_file(tmp_path, 'uncc', 1, 'model.glb') == path
    assert len(calls) == 1
    assert not list(tmp_path.glob('.bundle-*'))


def test_large_split_asset_is_reassembled_on_disk_in_order(monkeypatch, tmp_path):
    calls = storage_client(monkeypatch, {
        'walkgrid.json': (404, []),
        'walkgrid.json.part0': (200, [b'{"a":', b'1,']),
        'walkgrid.json.part1': (200, [b'"b":2}']),
    }, manifest='2')
    path = bundle_storage.cache_bundle_file(tmp_path, 'uncc', 1, 'walkgrid.json')
    assert path.read_bytes() == b'{"a":1,"b":2}'
    assert [url.rsplit('/', 1)[1] for url in calls] == [
        'walkgrid.json', 'walkgrid.json.chunks', 'walkgrid.json.part0', 'walkgrid.json.part1']


def test_interrupted_asset_never_becomes_a_partial_cache_hit(monkeypatch, tmp_path):
    import httpx
    import pytest
    storage_client(monkeypatch, {'model.glb': (200, [b'partial', httpx.ReadError('connection lost')])})
    with pytest.raises(FileNotFoundError):
        bundle_storage.cache_bundle_file(tmp_path, 'uncc', 1, 'model.glb')
    assert not (tmp_path / 'model.glb').exists()
    assert not list(tmp_path.glob('.bundle-*'))


def test_missing_split_part_does_not_publish_an_incomplete_file(monkeypatch, tmp_path):
    import pytest
    storage_client(monkeypatch, {
        'walkgrid.json': (404, []), 'walkgrid.json.part0': (200, [b'partial']),
        'walkgrid.json.part1': (404, []),
    }, manifest='2')
    with pytest.raises(FileNotFoundError):
        bundle_storage.cache_bundle_file(tmp_path, 'uncc', 1, 'walkgrid.json')
    assert not list(tmp_path.iterdir())
