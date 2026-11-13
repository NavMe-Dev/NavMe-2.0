"""Recovery controls that do not need or mutate a database."""
import json
import os
from pathlib import Path
import subprocess
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from conftest import validate_test_database_url
from wayfinding_api.config import Settings
from wayfinding_api.db import connection_options, configure_database_session
from wayfinding_api.routers import public
from wayfinding_api.services import jobs


def settings(**kwargs):
    return Settings(_env_file=None, **kwargs)


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+psycopg"])
def test_hosted_url_uses_installed_driver_and_bounded_pool(scheme):
    cfg = settings(database_url=f"{scheme}://postgres:secret@pooler.example:5432/postgres?sslmode=require")
    url, options = connection_options(cfg)
    assert url.drivername == "postgresql+psycopg"
    assert url.query["sslmode"] == "require"
    assert options["pool_size"] + options["max_overflow"] == 5
    assert options["pool_pre_ping"] and options["hide_parameters"]
    assert options["connect_args"]["connect_timeout"] == 10
    assert "statement_timeout=30000" in options["connect_args"]["options"]
    assert "lock_timeout=5000" in options["connect_args"]["options"]


def test_ssl_override_and_existing_startup_options_are_preserved():
    cfg = settings(database_url="postgresql+psycopg://localhost/db?options=-c%20search_path%3Dprivate",
                   db_sslmode="verify-full", db_pool_size=2, db_max_overflow=0)
    _, options = connection_options(cfg)
    assert options["connect_args"]["sslmode"] == "verify-full"
    assert options["connect_args"]["options"].startswith("-c search_path=private ")
    assert options["pool_size"] == 2 and options["max_overflow"] == 0


@pytest.mark.parametrize("flag", ["db_read_only", "wf_read_only"])
def test_readonly_shadow_enforces_postgresql_session_setting(flag):
    _, options = connection_options(settings(database_url="postgresql://localhost/postgres", **{flag: True}))
    assert "default_transaction_read_only=on" in options["connect_args"]["options"]


def test_session_hook_enforces_and_verifies_readonly_despite_ignored_startup_options():
    connection = MagicMock()
    connection.autocommit = False
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = ("on",)
    configure_database_session(connection, settings(wf_read_only=True))
    statements = [call.args[0] for call in cursor.execute.call_args_list]
    assert statements == ["SELECT set_config('statement_timeout', %s, false), set_config('lock_timeout', %s, false)",
                          "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY", "SHOW default_transaction_read_only"]
    assert connection.autocommit is False


def test_session_hook_fails_closed_if_readonly_was_not_established():
    connection = MagicMock()
    connection.autocommit = False
    connection.cursor.return_value.__enter__.return_value.fetchone.return_value = ("off",)
    with pytest.raises(RuntimeError, match="read-only mode"):
        configure_database_session(connection, settings(wf_read_only=True))
    assert connection.autocommit is False


def test_readonly_cache_does_not_use_production_absolute_path(monkeypatch, tmp_path):
    from wayfinding_api.services import bundle_storage
    monkeypatch.setattr(bundle_storage, "get_settings", lambda: settings(wf_read_only=True, data_dir=tmp_path))
    assert bundle_storage.local_version_dir("/data/published/gcu/v5", "gcu", 5) == tmp_path / "published/gcu/v5"
    with pytest.raises(ValueError, match="cache path"):
        bundle_storage.local_version_dir("/data/elsewhere", "../../outside", 5)


@pytest.mark.parametrize("read_only", [False, True])
def test_readonly_database_environment_cannot_be_redirected_by_stale_overlay(monkeypatch, tmp_path, read_only):
    from wayfinding_api.config import get_settings
    from wayfinding_api.services import runtime_config
    reviewed = "postgresql+psycopg://fixture@127.0.0.1/reviewed_test"
    stale = "postgresql+psycopg://fixture@old-source.invalid/previous"
    monkeypatch.setenv("DATABASE_URL", reviewed)
    monkeypatch.setenv("WF_READ_ONLY", str(read_only).lower())
    monkeypatch.setenv("DB_READ_ONLY", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    def overlay(settings):
        settings.database_url = stale
        settings.jwt_secret = "synthetic-overlay-jwt-preserved"
    monkeypatch.setattr(runtime_config, "apply_overlays_to_settings", overlay)
    get_settings.cache_clear()
    try:
        result = get_settings()
        assert result.database_url == (reviewed if read_only else stale)
        assert result.jwt_secret == "synthetic-overlay-jwt-preserved"
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/v1/public/buildings/gcu/feedback"),
    ("POST", "/api/v1/public/dashboard/buildings"),
    ("POST", "/api/v1/public/dashboard/buildings/gcu/sync-pois"),
    ("POST", "/api/v1/auth/bootstrap-admin"),
    ("PATCH", "/api/v1/admin/buildings/gcu"),
    ("DELETE", "/api/v1/admin/buildings/gcu"),
])
def test_readonly_shadow_blocks_mutations_before_database_or_external_rest(monkeypatch, method, path):
    from wayfinding_api import main, db
    monkeypatch.setattr(main, "get_settings", lambda: settings(wf_read_only=True, worker_inline=False))
    factory = MagicMock(side_effect=AssertionError("No database dependency should run"))
    monkeypatch.setattr(db, "SessionLocal", factory)
    response = TestClient(main.create_app()).request(method, path, json={})
    assert response.status_code == 503
    assert response.json() == {"detail": "application is read-only"}
    factory.assert_not_called()


def test_readonly_shadow_retains_route_queries_and_login_reads(monkeypatch):
    from wayfinding_api import main, db
    monkeypatch.setattr(main, "get_settings", lambda: settings(wf_read_only=True, worker_inline=False))
    session = MagicMock()
    session.query.return_value.filter_by.return_value.first.return_value = None
    monkeypatch.setattr(db, "SessionLocal", lambda: session)
    client = TestClient(main.create_app())
    response = client.post("/api/v1/public/buildings/missing/route", json={"from_key": "a", "to_key": "b"})
    assert response.status_code == 404
    response = client.post("/api/v1/auth/login", data={"username": "synthetic@example.invalid", "password": "synthetic"})
    assert response.status_code == 401
    session.commit.assert_not_called()


def test_readonly_shadow_does_not_start_or_requeue_jobs(monkeypatch):
    from wayfinding_api import main, db
    monkeypatch.setattr(main, "get_settings", lambda: settings(wf_read_only=True, worker_inline=True))
    start = MagicMock()
    monkeypatch.setattr(jobs, "start_inline_worker", start)
    monkeypatch.setattr(db, "dispose_engine", MagicMock())
    with TestClient(main.create_app()):
        start.assert_not_called()


@pytest.mark.parametrize("url", [
    "postgresql://localhost/wayfinding",
    "postgresql://db.example/wayfinding_test",
    "postgresql://db.kzpvhzyefdtrtidrbuxb.supabase.co/postgres",
    "postgresql+psycopg://localhost/wayfinding_test?host=remote.example",
    "postgresql+psycopg://localhost/wayfinding_test?hostaddr=192.0.2.1",
    "postgresql+psycopg://localhost/wayfinding_test?dbname=postgres",
    "postgresql+psycopg://localhost/wayfinding_test?service=production",
])
def test_integration_test_guard_rejects_production_targets(url):
    with pytest.raises(RuntimeError, match="local PostgreSQL"):
        validate_test_database_url(url)


def test_integration_test_guard_accepts_isolated_local_test_database():
    url = "postgresql+psycopg://localhost/wayfinding_test"
    assert validate_test_database_url(url) == url


def test_database_outage_is_503_without_credentials_and_liveness_still_works(monkeypatch, caplog):
    from wayfinding_api import main, db
    monkeypatch.setattr(main, "get_settings", lambda: settings(worker_inline=False))
    fake = MagicMock()
    fake.connect.side_effect = OperationalError("secret SQL", {}, Exception("password=do-not-print"))
    monkeypatch.setattr(db, "engine", lambda: fake)
    client = TestClient(main.create_app())
    response = client.get("/api/health")
    assert response.status_code == 503
    assert response.json() == {"detail": "database unavailable"}
    assert response.headers["retry-after"] == "5"
    assert "do-not-print" not in response.text + caplog.text
    assert "secret SQL" not in response.text + caplog.text
    assert client.get("/api/live").status_code == 200


def test_readiness_rejects_missing_application_schema(monkeypatch):
    from wayfinding_api import main, db
    monkeypatch.setattr(main, "get_settings", lambda: settings(worker_inline=False))
    fake = MagicMock()
    connection = fake.connect.return_value.__enter__.return_value
    postgis, relations = MagicMock(), MagicMock()
    postgis.scalar.return_value = "3.6"
    relations.scalars.return_value.all.return_value = ["buildings"]
    connection.execute.side_effect = [postgis, relations]
    monkeypatch.setattr(db, "engine", lambda: fake)
    response = TestClient(main.create_app()).get("/api/health")
    assert response.status_code == 503
    assert response.json() == {"detail": "database schema unavailable"}


def test_shutdown_signals_worker_and_disposes_pool(monkeypatch):
    from wayfinding_api import main, db
    monkeypatch.setattr(main, "get_settings", lambda: settings(worker_inline=True))
    worker = MagicMock()
    start = MagicMock(return_value=worker)
    dispose = MagicMock()
    monkeypatch.setattr(jobs, "start_inline_worker", start)
    monkeypatch.setattr(db, "dispose_engine", dispose)
    with TestClient(main.create_app()):
        stop = start.call_args.kwargs["stop_event"]
        assert not stop.is_set()
    assert stop.is_set()
    worker.join.assert_called_once_with(timeout=10)
    dispose.assert_called_once()


@pytest.mark.parametrize("flag, expected", [(None, True), ("true", True), ("false", False)])
def test_startup_migrations_can_be_explicitly_disabled(tmp_path, flag, expected):
    for command in ("wayfinding", "uvicorn"):
        stub = tmp_path / command
        stub.write_text(f'#!/bin/sh\necho "{command} $*"\n')
        stub.chmod(0o700)
    env = {**os.environ, "PATH": str(tmp_path)}
    env.pop("RUN_MIGRATIONS", None)
    if flag is not None:
        env["RUN_MIGRATIONS"] = flag
    script = Path(__file__).resolve().parents[1] / "deploy/start-api.sh"
    result = subprocess.run(["/bin/sh", str(script)], env=env, text=True, capture_output=True, check=True)
    assert ("wayfinding migrate" in result.stdout) is expected
    assert "uvicorn wayfinding_api.main:app" in result.stdout


def manifest_db():
    building = SimpleNamespace(slug="real-building", name="Existing building", address="Address")
    db = MagicMock()
    db.query.return_value.all.return_value = [building]
    return db, building


def test_manifest_preserves_existing_schema_and_published_identity(monkeypatch):
    db, building = manifest_db()
    version = SimpleNamespace(path="/published/real-building/v3", version=3)
    monkeypatch.setattr(public, "current_version", lambda db, b: version)
    config = {"center": [-80.1, 35.1], "bounds": [-80.2, 35.0, -80.0, 35.2],
              "floors": [{"id": "F1", "label": "Ground", "short": "G"}]}
    monkeypatch.setattr(public.bundle_storage, "read_bundle_file", lambda *args: json.dumps(config).encode())
    manifest = public.venue_manifest(db, "all")
    assert manifest["schema"] == "wayfinding.venue/v1"
    assert manifest["slug"] == "all"
    assert manifest["buildings"][0] == {"slug": building.slug, "name": building.name, "address": building.address,
        "center": config["center"], "bounds": config["bounds"], "floors": config["floors"],
        "version": 3, "data": "buildings/real-building/data/"}


@pytest.mark.parametrize("payload", [None, b"not json", b"{}"])
def test_manifest_does_not_disguise_missing_or_corrupt_publication_as_empty_success(monkeypatch, payload):
    db, _ = manifest_db()
    monkeypatch.setattr(public, "current_version", lambda db, b: SimpleNamespace(path="/missing", version=1))
    def read(*args):
        if payload is None:
            raise FileNotFoundError("private-file-path")
        return payload
    monkeypatch.setattr(public.bundle_storage, "read_bundle_file", read)
    with pytest.raises(HTTPException) as error:
        public.venue_manifest(db, "all")
    assert error.value.status_code == 503
    assert error.value.detail == "published venue data unavailable"


def test_unknown_venue_remains_404():
    db = MagicMock()
    db.query.return_value.filter_by.return_value.first.return_value = None
    with pytest.raises(HTTPException) as error:
        public.venue_manifest(db, "unknown")
    assert error.value.status_code == 404


def test_polling_recovers_after_connection_interruption_without_replaying_a_job(monkeypatch, caplog):
    sessions = [MagicMock(), MagicMock()]
    session_factory = MagicMock(side_effect=sessions)
    claim = MagicMock(side_effect=[OperationalError("private SQL", {}, Exception("secret-password")), None])
    monkeypatch.setattr(jobs, "SessionLocal", session_factory)
    monkeypatch.setattr(jobs, "claim", claim)
    run = MagicMock()
    monkeypatch.setattr(jobs, "run_job", run)
    stop = MagicMock()
    stop.is_set.side_effect = [False, False, True]
    jobs.worker_loop(poll=0.01, stop_event=stop)
    assert claim.call_count == 2
    assert not run.called
    sessions[0].rollback.assert_called_once()
    for session in sessions:
        session.close.assert_called_once()
    assert "secret-password" not in caplog.text and "private SQL" not in caplog.text


def test_stopped_worker_does_not_claim_new_jobs(monkeypatch):
    factory = MagicMock()
    monkeypatch.setattr(jobs, "SessionLocal", factory)
    stop = threading.Event()
    stop.set()
    jobs.worker_loop(stop_event=stop)
    factory.assert_not_called()


def test_one_shot_worker_reports_database_failure(monkeypatch):
    monkeypatch.setattr(jobs, "SessionLocal", MagicMock())
    monkeypatch.setattr(jobs, "claim", MagicMock(side_effect=OperationalError("", {}, Exception())))
    with pytest.raises(OperationalError):
        jobs.worker_loop(once=True)
