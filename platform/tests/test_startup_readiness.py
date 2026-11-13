"""The TCP listener must not bind until the recovery database is ready."""
import os
from pathlib import Path
import subprocess
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import OperationalError

from wayfinding_api.config import Settings
from wayfinding_api.readiness import DatabaseNotReady, inspect_readiness, wait_for_database


def ready_database(*, missing=None, readonly="on", revisions=None):
    database = MagicMock()
    connection = database.connect.return_value.__enter__.return_value
    schema, migration = MagicMock(), MagicMock()
    schema.mappings.return_value.one.return_value = {"postgis":"3.3", "read_only":readonly, "missing":missing or []}
    migration.scalars.return_value.all.return_value = revisions if revisions is not None else ["0001"]
    connection.execute.side_effect = [schema,migration]
    return database


def test_startup_requires_postgis_tables_revision_and_readonly():
    database = ready_database()
    inspect_readiness(database, require_read_only=True)
    assert database.connect.return_value.__enter__.return_value.execute.call_count == 2


@pytest.mark.parametrize("options", [{"missing":["buildings"]},{"readonly":"off"},{"revisions":[]},{"revisions":["0002"]}])
def test_missing_schema_wrong_revision_or_writable_session_refuses_readiness(options):
    with pytest.raises(DatabaseNotReady):
        inspect_readiness(ready_database(**options), require_read_only=True)


def test_unavailable_database_retry_is_bounded_and_does_not_log_connection_text(caplog):
    database = MagicMock()
    database.connect.side_effect = OperationalError("synthetic-private-query", {}, Exception("synthetic-secret-password"))
    now = [0]
    factory = MagicMock(return_value=database)
    with pytest.raises(DatabaseNotReady):
        wait_for_database(Settings(_env_file=None), timeout=3, interval=1, clock=lambda:now[0],
                          sleep=lambda seconds:now.__setitem__(0,now[0]+seconds),engine_factory=factory)
    assert database.connect.call_count == 3
    database.dispose.assert_called_once()
    assert "synthetic-secret-password" not in caplog.text
    assert "synthetic-private-query" not in caplog.text


def test_successful_startup_releases_probe_pool_without_sleeping():
    database = ready_database()
    sleep = MagicMock()
    wait_for_database(Settings(_env_file=None,wf_read_only=True), sleep=sleep,engine_factory=lambda settings:database)
    sleep.assert_not_called()
    database.dispose.assert_called_once()


def run_entrypoint(tmp_path, *, readiness_exit=0, migrations="false", readonly="true"):
    for command in ("python","wayfinding","uvicorn"):
        stub=tmp_path/command
        stub.write_text(f'#!/bin/sh\necho "{command} $*"\n' + ('exit "${FIXTURE_READINESS_EXIT:-0}"\n' if command=="python" else ''))
        stub.chmod(0o700)
    env={key:value for key,value in os.environ.items() if key not in {"WF_READ_ONLY","DB_READ_ONLY","DB_STARTUP_CHECK","RUN_MIGRATIONS"}}
    env.update(PATH=str(tmp_path),RUN_MIGRATIONS=migrations,WF_READ_ONLY=readonly,DB_STARTUP_CHECK="false",FIXTURE_READINESS_EXIT=str(readiness_exit))
    script=Path(__file__).resolve().parents[1]/"deploy/start-api.sh"
    return subprocess.run(["/bin/sh",str(script)],env=env,text=True,capture_output=True)


def test_readonly_readiness_passes_before_listener_and_never_runs_migration(tmp_path):
    result=run_entrypoint(tmp_path)
    assert result.returncode==0
    assert "wayfinding migrate" not in result.stdout
    assert result.stdout.index("python -m wayfinding_api.readiness") < result.stdout.index("uvicorn wayfinding_api.main:app")


def test_failed_readiness_never_starts_tcp_listener(tmp_path):
    result=run_entrypoint(tmp_path,readiness_exit=1)
    assert result.returncode==1
    assert "uvicorn" not in result.stdout


def test_readonly_mode_rejects_accidental_migrations_before_any_command(tmp_path):
    result=run_entrypoint(tmp_path,migrations="true",readonly="TRUE")
    assert result.returncode==1
    assert "wayfinding migrate" not in result.stdout and "uvicorn" not in result.stdout
