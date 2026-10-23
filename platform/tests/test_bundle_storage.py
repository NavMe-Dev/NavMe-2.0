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
