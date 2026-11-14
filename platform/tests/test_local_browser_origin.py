"""Matterport authorizes localhost, not IP loopback browser referrers."""
import pytest
from fastapi.testclient import TestClient
from wayfinding_api.config import Settings
from wayfinding_api import main


@pytest.fixture
def browser_app(monkeypatch, tmp_path):
    viewer = tmp_path / "viewer"
    admin = tmp_path / "admin"
    for directory in (viewer, admin):
        directory.mkdir()
        (directory / "index.html").write_text("<!doctype html><title>Local fixture</title>")
    (viewer / "wf-config.js").write_text("window.WF_CONFIG={};")
    settings = Settings(_env_file=None, viewer_dir=viewer, admin_dir=admin,
                        data_dir=tmp_path / "data", worker_inline=False)
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    return main.create_app()


@pytest.mark.parametrize("origin", ["http://127.0.0.1:8780", "http://[::1]:8780"])
@pytest.mark.parametrize("path", ["/", "/gcu-omr", "/gcu-omr/", "/uncc-charlotte", "/uncc-charlotte/", "/walkthrough.html", "/admin/"])
def test_local_browser_entry_preserves_path_port_and_query(browser_app, origin, path):
    query = "?b=gcu&mp=1&to=Library%20desk&floor=F2"
    response = TestClient(browser_app, base_url=origin).get(path + query, follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "http://localhost:8780" + path + query
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("origin", ["http://localhost:8780", "https://wayfinding.navme.space"])
@pytest.mark.parametrize("path", ["/gcu-omr", "/uncc-charlotte", "/uncc-charlotte/"])
def test_authorized_browser_origins_do_not_redirect(browser_app, origin, path):
    response = TestClient(browser_app, base_url=origin).get(path, follow_redirects=False)
    assert response.status_code == 200
    assert "location" not in response.headers


@pytest.mark.parametrize("path", ["/api/live", "/wf-config.js"])
def test_local_api_and_asset_requests_keep_their_origin(browser_app, path):
    response = TestClient(browser_app, base_url="http://127.0.0.1:8780").get(path, follow_redirects=False)
    assert response.status_code == 200
    assert "location" not in response.headers


def test_mutations_are_not_redirected(browser_app):
    response = TestClient(browser_app, base_url="http://127.0.0.1:8780").post("/gcu-omr", follow_redirects=False)
    assert response.status_code == 405
    assert "location" not in response.headers
