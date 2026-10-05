"""Platform Config Option 2: runtime overlay + admin API (no secret echo)."""
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from wayfinding_api.auth import hash_password
from wayfinding_api.config import get_settings, reload_settings
from wayfinding_api.db import SessionLocal
from wayfinding_api import models
from wayfinding_api.main import app
from wayfinding_api.services import runtime_config as rt


@pytest.fixture(autouse=True)
def _isolate_overlay(tmp_path, monkeypatch):
    settings_path = tmp_path / "runtime_settings.json"
    secrets_path = tmp_path / "runtime_secrets.env"
    monkeypatch.setattr(rt, "SETTINGS_PATH", settings_path)
    monkeypatch.setattr(rt, "SECRETS_PATH", secrets_path)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
    # clean files
    for p in (settings_path, secrets_path):
        if p.is_file():
            p.unlink()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth(client):
    with SessionLocal() as db:
        u = db.query(models.User).filter_by(email="admin@cfg-test").first()
        if not u:
            db.add(models.User(email="admin@cfg-test", password_hash=hash_password("pw-123456"), is_admin=True))
            db.commit()
    r = client.post("/api/v1/auth/login", data={"username": "admin@cfg-test", "password": "pw-123456"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["access_token"]}


def test_config_requires_auth(client):
    r = client.get("/api/v1/admin/platform/config")
    assert r.status_code == 401


def test_get_config_no_secret_values(client, auth, monkeypatch):
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "sk-test-should-never-appear")
    monkeypatch.setenv("MATTERPORT_SDK_KEY", "mp-secret-xyz")
    get_settings.cache_clear()
    r = client.get("/api/v1/admin/platform/config", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    text = json.dumps(body)
    assert "sk-test-should-never-appear" not in text
    assert "mp-secret-xyz" not in text
    assert "values" in body and "secrets" in body and "status" in body
    assert body["secrets"]["WF_CHAT_LLM_API_KEY"] is True
    assert body["secrets"]["MATTERPORT_SDK_KEY"] is True
    assert isinstance(body["secrets"]["WF_CHAT_LLM_API_KEY"], bool)


def test_patch_non_secrets_overlay(client, auth):
    r = client.patch(
        "/api/v1/admin/platform/config",
        headers=auth,
        json={
            "values": {
                "wf_chat_enabled": True,
                "wf_chat_llm_base_url": "http://127.0.0.1:11434/v1",
                "wf_chat_llm_model": "qwen2.5:3b",
                "wf_chat_rate_limit_per_min": 15,
                "geocoder": "nominatim",
            }
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["values"]["wf_chat_enabled"] is True
    assert body["values"]["wf_chat_llm_model"] == "qwen2.5:3b"
    assert body["values"]["geocoder"] == "nominatim"
    assert "wf_chat_enabled" in body["overlay_keys"]
    s = reload_settings()
    assert s.wf_chat_enabled is True
    assert s.wf_chat_llm_model == "qwen2.5:3b"
    # warnings may include private-host note
    assert isinstance(body.get("warnings"), list)


def test_secret_set_clear_never_echoed(client, auth):
    r = client.patch(
        "/api/v1/admin/platform/config",
        headers=auth,
        json={"secrets": {"WF_CHAT_LLM_API_KEY": "super-secret-key-xyz"}},
    )
    assert r.status_code == 200, r.text
    assert "super-secret-key-xyz" not in r.text
    assert r.json()["secrets"]["WF_CHAT_LLM_API_KEY"] is True
    s = reload_settings()
    assert s.wf_chat_llm_api_key == "super-secret-key-xyz"
    r2 = client.patch(
        "/api/v1/admin/platform/config",
        headers=auth,
        json={"clear_secrets": ["WF_CHAT_LLM_API_KEY"]},
    )
    assert r2.status_code == 200
    assert "super-secret-key-xyz" not in r2.text
    assert r2.json()["secrets"]["WF_CHAT_LLM_API_KEY"] is False


def test_vps_metadata_blocked(client, auth):
    r = client.patch(
        "/api/v1/admin/platform/config",
        headers=auth,
        json={"values": {"vps_url": "http://169.254.169.254/latest"}},
    )
    assert r.status_code == 400


def test_probe_llm_mocked(client, auth):
    with patch.object(rt, "probe_llm", return_value={"ok": True, "reachable": True, "status": 200, "error": None}):
        r = client.post(
            "/api/v1/admin/platform/config/probe-llm",
            headers=auth,
            json={"wf_chat_llm_base_url": "http://127.0.0.1:11434/v1"},
        )
    assert r.status_code == 200, r.text
    assert r.json()["probe"]["reachable"] is True


def test_validate_cors_star_warns():
    u, w = rt.validate_cors_origins("*")
    assert u == "*"
    assert w


def test_js_helper():
    import subprocess
    js = Path(__file__).resolve().parents[1] / "admin" / "runtime_config.js"
    node = r"""
const fs = require("fs");
const vm = require("vm");
const sandbox = { global: {} };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), sandbox);
const W = sandbox.WFRuntimeConfig;
const p = W.parsePayload({
  values: { wf_chat_enabled: true, wf_chat_llm_model: "m" },
  secrets: { WF_CHAT_LLM_API_KEY: true },
  status: { chat_enabled: true, llm_probe: { ok: true, reachable: true } }
});
if (!p.values.wf_chat_enabled || p.values.wf_chat_llm_model !== "m") process.exit(1);
if (!p.secrets.WF_CHAT_LLM_API_KEY) process.exit(2);
const body = W.buildPatch(p, { WF_CHAT_LLM_API_KEY: { value: "abc", clear: false } });
if (!body.values.wf_chat_enabled || body.secrets.WF_CHAT_LLM_API_KEY !== "abc") process.exit(3);
const body2 = W.buildPatch(p, { WF_CHAT_LLM_API_KEY: { value: "", clear: true } });
if (!body2.clear_secrets || body2.clear_secrets.indexOf("WF_CHAT_LLM_API_KEY") < 0) process.exit(4);
console.log("ok");
"""
    r = subprocess.run(["node", "-e", node, str(js)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr or r.stdout
    assert r.stdout.strip() == "ok"
