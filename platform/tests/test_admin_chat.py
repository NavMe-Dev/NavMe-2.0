"""Admin chat Option 4 phase 1: auth, Access tools strip secrets, explain_access."""
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm.attributes import flag_modified

from wayfinding_api.auth import hash_password
from wayfinding_api.config import get_settings
from wayfinding_api.db import SessionLocal
from wayfinding_api import models
from wayfinding_api.main import app
from wayfinding_api.services import access as access_svc
from wayfinding_api.services import admin_chat as admin_chat_svc
from wayfinding_api.services import chat as chat_svc


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth(client):
    """Ensure an admin user exists (shared test DB) and return Bearer headers."""
    with SessionLocal() as db:
        u = db.query(models.User).filter_by(email="admin@chat-test").first()
        if not u:
            db.add(models.User(email="admin@chat-test", password_hash=hash_password("pw-123456"), is_admin=True))
            db.commit()
    r = client.post("/api/v1/auth/login", data={"username": "admin@chat-test", "password": "pw-123456"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["access_token"]}


def test_admin_chat_requires_auth(client, monkeypatch):
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    get_settings.cache_clear()
    r = client.post("/api/v1/admin/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 401


def test_admin_chat_graceful_without_llm(client, auth, monkeypatch):
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "")
    get_settings.cache_clear()
    r = client.post(
        "/api/v1/admin/chat",
        headers=auth,
        json={"messages": [{"role": "user", "content": "What does twin=pin mean?"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is False
    assert "LLM" in body["message"] or "Ollama" in body["message"]


def test_get_building_access_strips_hash():
    pin_hash = access_svc.hash_pin("test12")
    with SessionLocal() as db:
        v = db.query(models.Venue).filter_by(slug="campus-chat").first()
        if not v:
            v = models.Venue(slug="campus-chat", name="Campus Chat")
            db.add(v)
            db.flush()
        b = db.query(models.Building).filter_by(slug="chat-access-demo").first()
        if not b:
            b = models.Building(slug="chat-access-demo", name="Chat Access Demo", venue=v)
            db.add(b)
            db.flush()
        b.pipeline_config = {
            "access": {
                "twin": "pin",
                "twin_pin_hash": pin_hash,
                "tour_public": True,
                "routing": {"mode": "exclude_edges", "excluded_edge_ids": ["a|b", "c|d"]},
            }
        }
        flag_modified(b, "pipeline_config")
        db.commit()

    with SessionLocal() as db:
        out = admin_chat_svc.tool_get_building_access(db, "chat-access-demo")
    assert out["access"]["twin"] == "pin"
    assert out["access"]["pin_set"] is True
    assert out["access"]["pin_required"] is True
    assert out["access"]["routing"]["mode"] == "exclude_edges"
    assert out["access"]["routing"]["excluded_edge_ids_count"] == 2
    blob = json.dumps(out)
    assert "twin_pin_hash" not in blob
    assert pin_hash not in blob
    assert "test12" not in blob
    assert "Publish" in out.get("note", "")


def test_explain_access_returns_content():
    out = admin_chat_svc.tool_explain_access("twin")
    assert "snippets" in out
    assert "twin" in out["snippets"]
    assert "pin" in out["snippets"]["twin"].lower() or "public" in out["snippets"]["twin"].lower()
    all_out = admin_chat_svc.tool_explain_access("all")
    assert "routing" in all_out["snippets"]
    assert "publish" in all_out["snippets"]
    assert "faq_excerpt" in all_out and "twin" in all_out["faq_excerpt"].lower()


def test_run_admin_tool_allowlist():
    with SessionLocal() as db:
        out = admin_chat_svc.run_admin_tool(db, "delete_building", {})
        assert "not allowed" in out.get("error", "")
        with patch.object(chat_svc, "run_tool", return_value={"buildings": [], "count": 0}) as m:
            r = admin_chat_svc.run_admin_tool(db, "list_buildings", {})
            assert m.called
            assert r["count"] == 0


def test_admin_chat_explain_force_path(client, auth, monkeypatch):
    """Mock LLM; Access how-to question should force explain_access tool results."""
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "test-key")
    get_settings.cache_clear()

    def fake_openai(messages, tools=None):
        return {"choices": [{"message": {"content": "twin=pin means a PIN is required for Tour."}}]}

    with patch.object(chat_svc, "_openai_chat", side_effect=fake_openai):
        r = client.post(
            "/api/v1/admin/chat",
            headers=auth,
            json={"messages": [{"role": "user", "content": "what does twin=pin mean"}]},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert "pin" in body["message"].lower() or "PIN" in body["message"]
    assert "explain_access" in (body.get("tools_used") or [])
    assert "twin_pin_hash" not in body["message"]


def _ensure_gcu_building():
    with SessionLocal() as db:
        b = db.query(models.Building).filter_by(slug="gcu-omr-libra").first()
        if not b:
            b = models.Building(slug="gcu-omr-libra", name="GCU OMR with Library", status="published")
            db.add(b)
            db.commit()
        return b.slug


def test_open_building_resolves_gcu():
    _ensure_gcu_building()
    with SessionLocal() as db:
        out = admin_chat_svc.tool_open_building(db, "gcu")
    assert out.get("slug") == "gcu-omr-libra", out
    assert out["admin_url"] == "#/b/gcu-omr-libra"
    assert out["access_url"] == "#/b/gcu-omr-libra/access"
    assert out["viewer_url"] == "/?b=gcu-omr-libra"
    assert out["actions"] and out["actions"][0]["intent"] == "admin_nav"
    assert "Google" not in (out.get("name") or "")


def test_force_open_building_phrase():
    _ensure_gcu_building()
    with SessionLocal() as db:
        out = admin_chat_svc._maybe_force_open_building(db, "open gcu")
        assert out and out.get("slug") == "gcu-omr-libra"
        assert admin_chat_svc._maybe_force_open_building(db, "open bathroom") is None


def test_admin_chat_open_gcu_no_llm(client, auth, monkeypatch):
    """open gcu short-circuits before LLM; still 200 with Studio deep_link."""
    _ensure_gcu_building()
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "test-key")
    get_settings.cache_clear()

    def boom(*a, **k):
        raise AssertionError("LLM should not be called for open gcu force path")

    with patch.object(chat_svc, "_openai_chat", side_effect=boom):
        r = client.post(
            "/api/v1/admin/chat",
            headers=auth,
            json={"messages": [{"role": "user", "content": "open gcu"}]},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert "gcu-omr-libra" in body["message"]
    assert "open_building" in (body.get("tools_used") or [])
    assert any(a.get("url") == "#/b/gcu-omr-libra" for a in (body.get("actions") or []))


def test_admin_chat_llm_error_is_graceful(client, auth, monkeypatch):
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "test-key")
    get_settings.cache_clear()

    def fail(*a, **k):
        raise chat_svc.LLMUnavailable("LLM provider error (500): boom")

    with patch.object(chat_svc, "_openai_chat", side_effect=fail):
        r = client.post(
            "/api/v1/admin/chat",
            headers=auth,
            json={"messages": [{"role": "user", "content": "list my buildings please"}]},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("error") == "llm_unavailable"
    assert "language model" in body["message"].lower() or "LLM" in body["message"]


def test_parse_admin_route_building_tab():
    out = admin_chat_svc.parse_admin_route(path="#/b/gcu-omr-libra/access")
    assert out["building"] == "gcu-omr-libra"
    assert out["tab"] == "access"
    assert out["page"] == "building"
    assert out["path"] == "/b/gcu-omr-libra/access"
    dash = admin_chat_svc.parse_admin_route(path="/dashboard")
    assert dash["page"] == "dashboard"
    ov = admin_chat_svc.parse_admin_route(path="/b/gcu-omr-libra")
    assert ov["tab"] == "overview"


def test_context_blurb_access_tab():
    bits = admin_chat_svc._context_blurb("gcu-omr-libra", "access", "/b/gcu-omr-libra/access")
    joined = " ".join(bits)
    assert "gcu-omr-libra" in joined
    assert "Access" in joined
    assert "Prefer Access tools" in joined


def test_force_list_entrances_uses_search_pois():
    _ensure_gcu_building()
    with SessionLocal() as db:
        out = admin_chat_svc._maybe_force_list_entrances(db, "gcu-omr-libra", "give list of entrances")
    assert out is not None
    assert "search_pois" in (out.get("tools_used") or [])
    assert "gcu-omr-libra" in out["message"]
    # Must be POI names, not other buildings' addresses
    low = out["message"].lower()
    assert "11328" not in low
    assert "tacoma" not in low
    assert "greenland" not in low
    assert "entrance" in low


def test_force_list_entrances_empty_honest(monkeypatch):
    _ensure_gcu_building()

    def empty_search(db, slug, query, category=None, limit=8):
        return {
            "slug": slug,
            "query": query,
            "results": [],
            "count": 0,
            "catalogue_size": 3,
            "available_categories": {"room": 3},
            "empty_reason": "no_entrance_tagged",
        }

    with patch.object(chat_svc, "tool_search_pois", side_effect=empty_search):
        with patch.object(admin_chat_svc, "tool_list_draft_pois_by_category", return_value={
            "slug": "gcu-omr-libra", "results": [], "count": 0,
            "available_categories": {"room": 3}, "empty_reason": "no_entrance_tagged",
        }):
            with SessionLocal() as db:
                out = admin_chat_svc._maybe_force_list_entrances(
                    db, "gcu-omr-libra", "list of entrances in gcu"
                )
    assert out is not None
    low = out["message"].lower()
    assert "no entrance-tagged" in low or "no entrance" in low
    assert "11328" not in low
    assert "will not list other buildings" in low


def test_force_lock_no_set_access():
    _ensure_gcu_building()
    with SessionLocal() as db:
        out = admin_chat_svc._maybe_force_lock_restrict(db, "gcu-omr-libra", "lock all entrances")
    assert out is not None
    low = out["message"].lower()
    assert "set_access" in low  # explains it does NOT exist / has no set_access
    assert "read-only" in low or "cannot lock" in low
    assert "i have not changed" in low
    assert "exclude_edges" in low or "access tab" in low
    # Must not claim it locked anything
    assert "locked all" not in low
    assert "successfully locked" not in low
    assert "explain_access" in (out.get("tools_used") or [])
    assert "get_building_access" in (out.get("tools_used") or [])


def test_admin_chat_list_entrances_no_llm(client, auth, monkeypatch):
    _ensure_gcu_building()
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "test-key")
    get_settings.cache_clear()

    def boom(*a, **k):
        raise AssertionError("LLM should not be called for list entrances force path")

    with patch.object(chat_svc, "_openai_chat", side_effect=boom):
        r = client.post(
            "/api/v1/admin/chat",
            headers=auth,
            json={
                "messages": [{"role": "user", "content": "list of entrances"}],
                "building": "gcu-omr-libra",
                "tab": "access",
                "path": "/b/gcu-omr-libra/access",
                "page": "building",
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert "search_pois" in (body.get("tools_used") or [])
    assert "gcu-omr-libra" in body["message"]
    assert "11328" not in body["message"].lower()
    assert "set_access" not in body["message"].lower() or "no set_access" in body["message"].lower()


def test_admin_chat_lock_entrances_no_llm(client, auth, monkeypatch):
    _ensure_gcu_building()
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "test-key")
    get_settings.cache_clear()

    def boom(*a, **k):
        raise AssertionError("LLM should not be called for lock force path")

    with patch.object(chat_svc, "_openai_chat", side_effect=boom):
        r = client.post(
            "/api/v1/admin/chat",
            headers=auth,
            json={
                "messages": [{"role": "user", "content": "lock all entrances"}],
                "building": "gcu-omr-libra",
                "tab": "access",
                "path": "/b/gcu-omr-libra/access",
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    msg = body["message"].lower()
    assert "cannot lock" in msg or "read-only" in msg
    assert "i have not changed" in msg
    assert "successfully locked" not in msg
    assert "explain_access" in (body.get("tools_used") or [])
    assert any(
        (a.get("url") or "").endswith("/access") for a in (body.get("actions") or [])
    )
