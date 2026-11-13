"""Mock-only safety tests: never read real secrets or connect to any database."""
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import capture_destination as capture

PROJECT = "kzpvhzyefdtrtidrbuxb"
FIXTURE_PASSWORD = "synthetic-fixture-password"
DIRECT = f"postgresql://postgres:{FIXTURE_PASSWORD}@db.{PROJECT}.supabase.co/postgres"
POOL = f"postgresql://postgres.{PROJECT}:{FIXTURE_PASSWORD}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"


@pytest.fixture(autouse=True)
def forbid_real_external_actions(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Real database/subprocess access is forbidden in these safety tests")
    monkeypatch.setattr(capture.psycopg, "connect", forbidden)
    monkeypatch.setattr(capture.subprocess, "run", forbidden)
    monkeypatch.setattr(capture, "dotenv_values", lambda *args, **kwargs: {"SUPABASE_DATABASE_URL": DIRECT})


@pytest.mark.parametrize("url", [DIRECT, POOL, DIRECT.replace("postgresql:", "postgresql+psycopg:")])
def test_validate_target_accepts_only_reviewed_project_routes(url):
    target = capture.validate_target(url)
    assert target.database == "postgres"
    assert (target.port or 5432) == 5432


@pytest.mark.parametrize("url", [
    DIRECT.replace(f"db.{PROJECT}.supabase.co", "db.other-project.supabase.co"),
    POOL.replace(PROJECT, "other-project"),
    POOL.replace(":5432/", ":6543/"),
    DIRECT.replace("/postgres", "/different_database"),
    DIRECT.replace("postgres:", "different_user:", 1),
    DIRECT.replace(FIXTURE_PASSWORD, ""),
    DIRECT + "?host=unexpected.invalid",
    DIRECT + "?hostaddr=192.0.2.1",
    DIRECT + "?dbname=different_database",
    DIRECT + "?service=unexpected",
    DIRECT + "?port=6543",
    DIRECT + "?sslmode=disable",
    DIRECT + "?sslmode=prefer",
    DIRECT + "?sslmode=allow",
])
def test_validate_target_refuses_other_projects_routing_overrides_and_tls_downgrades(url):
    with pytest.raises(ValueError):
        capture.validate_target(url)


def test_child_environment_discards_inherited_libpq_routes_and_requires_read_only_tls(monkeypatch):
    for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGDATABASE", "PGOPTIONS", "PGSSLMODE"):
        monkeypatch.setenv(key, "synthetic-untrusted-inherited-setting")
    monkeypatch.setenv("NAVME_UNRELATED_FIXTURE", "preserved")
    target = capture.validate_target(POOL + "?sslmode=verify-full&sslrootcert=/synthetic/ca.pem")
    env = capture.child_environment(target)
    assert all(key not in env for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE"))
    assert env["PGHOST"] == target.host and env["PGUSER"] == f"postgres.{PROJECT}"
    assert env["PGPORT"] == "5432" and env["PGDATABASE"] == "postgres"
    assert env["PGSSLMODE"] == "verify-full" and env["PGSSLROOTCERT"] == "/synthetic/ca.pem"
    assert "default_transaction_read_only=on" in env["PGOPTIONS"]
    assert env["NAVME_UNRELATED_FIXTURE"] == "preserved"


def test_snapshot_environment_isolated_and_restored_even_on_failure(monkeypatch):
    monkeypatch.setenv("PGHOSTADDR", "192.0.2.1")
    monkeypatch.setenv("PGSERVICE", "synthetic-wrong-route")
    with pytest.raises(RuntimeError):
        with capture.isolated_libpq_environment():
            assert not any(key.startswith("PG") for key in os.environ)
            os.environ["PGHOST"] = "temporary-synthetic-host"
            raise RuntimeError("synthetic failure")
    assert os.environ["PGHOSTADDR"] == "192.0.2.1"
    assert os.environ["PGSERVICE"] == "synthetic-wrong-route"
    assert os.environ.get("PGHOST") != "temporary-synthetic-host"


def test_private_files_are_exclusive_0600_and_do_not_follow_existing_symlinks(tmp_path):
    path = tmp_path / "private.json"
    capture.write_json(path, {"synthetic": "preserved"})
    assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        capture.write_json(path, {"synthetic": "overwritten"})
    assert json.loads(path.read_text()) == {"synthetic": "preserved"}
    alias = tmp_path / "alias.json"
    alias.symlink_to(path)
    with pytest.raises(FileExistsError):
        capture.private_file(alias)
    assert json.loads(path.read_text()) == {"synthetic": "preserved"}


def test_failed_subprocess_has_private_diagnostics_and_no_secret_output(tmp_path, monkeypatch, capsys):
    def run(argv, **kwargs):
        kwargs["stderr"].write(FIXTURE_PASSWORD.encode())
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(capture.subprocess, "run", run)
    with pytest.raises(RuntimeError) as error:
        capture.run_private(["synthetic-pg_dump"], {}, tmp_path, "dump-failure")
    assert FIXTURE_PASSWORD not in str(error.value)
    assert FIXTURE_PASSWORD not in capsys.readouterr().out
    diagnostics = tmp_path / "dump-failure.stderr"
    assert diagnostics.stat().st_mode & 0o777 == 0o600
    assert diagnostics.read_text() == FIXTURE_PASSWORD


class FakeSnapshot:
    def __init__(self, *, tls=True, read_only="on", isolation="repeatable read"):
        self.pgconn = SimpleNamespace(ssl_in_use=tls)
        self.read_only = read_only
        self.isolation = isolation
        self.queries = []
        self.result = []
        self.rolled_back = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self

    def execute(self, query):
        statement = query if isinstance(query, str) else query.as_string()
        self.queries.append(statement)
        assert statement.startswith(("SELECT", "SHOW", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "SET LOCAL"))
        if "pg_export_snapshot()" in statement:
            self.result = [("PostgreSQL 17.11 synthetic fixture", "postgres", self.read_only, "fixture-exported-snapshot")]
        elif statement == "SHOW transaction_isolation":
            self.result = [(self.isolation,)]
        elif "FROM pg_extension" in statement:
            self.result = [("postgis", "synthetic-extension-version")]
        elif "FROM pg_roles" in statement:
            self.result = [("postgres",), ("anon",)]
        elif "FROM pg_publication" in statement:
            self.result = []
        elif "FROM pg_class c" in statement:
            self.result = [("public", "users")]
        elif "string_agg(row_hash" in statement:
            self.result = [(2, "synthetic-row-digest")]
        elif "FROM public.alembic_version" in statement:
            self.result = [("0001",)]
        elif "FROM supabase_migrations.schema_migrations" in statement:
            self.result = [("synthetic-version", "synthetic-migration")]
        else:
            assert statement.startswith(("BEGIN", "SET LOCAL"))
            self.result = []

    def fetchone(self):
        return self.result[0]

    def fetchall(self):
        return self.result

    def rollback(self):
        self.rolled_back = True


def fake_actions(monkeypatch, snapshot=None, fail_dump=False):
    snapshot = snapshot or FakeSnapshot()
    actions = {"calls": [], "connect": []}
    def connect(**kwargs):
        assert not any(key.startswith("PG") for key in os.environ)
        actions["connect"].append(kwargs)
        return snapshot
    def run(argv, **kwargs):
        actions["calls"].append((argv, kwargs))
        program = Path(argv[0]).name
        if program == "pg_dump":
            archive = Path(next(arg.split("=", 1)[1] for arg in argv if arg.startswith("--file=")))
            assert archive.stat().st_mode & 0o777 == 0o600
            archive.write_bytes(b"synthetic-custom-archive-fixture")
            if fail_dump:
                kwargs["stderr"].write(FIXTURE_PASSWORD.encode())
                return SimpleNamespace(returncode=1)
        elif program in {"pg_dumpall", "pg_restore"}:
            if kwargs["stdout"] != capture.subprocess.DEVNULL:
                kwargs["stdout"].write(b"-- synthetic offline output fixture\n")
        else:
            raise AssertionError("Unexpected subprocess program")
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(capture.psycopg, "connect", connect)
    monkeypatch.setattr(capture.subprocess, "run", run)
    return snapshot, actions


def test_capture_uses_read_only_snapshot_keeps_acl_and_never_restores_to_database(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PGHOSTADDR", "192.0.2.1")
    snapshot, actions = fake_actions(monkeypatch)
    output = tmp_path / "new-private-capture"
    capture.capture(tmp_path / "unread-synthetic-secret.env", output, Path("/synthetic/bin"))
    report_text = capsys.readouterr().out
    report = json.loads(report_text)
    assert report["backup_captured"] and report["isolated_restore_verified"] is False
    assert FIXTURE_PASSWORD not in report_text
    assert output.stat().st_mode & 0o777 == 0o700
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in output.iterdir())
    assert actions["connect"][0]["autocommit"] is True
    assert snapshot.queries[0] == "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    assert snapshot.rolled_back
    dump = next(argv for argv, _ in actions["calls"] if Path(argv[0]).name == "pg_dump")
    assert "--snapshot=fixture-exported-snapshot" in dump
    assert "--no-owner" not in dump and "--no-acl" not in dump
    roles = next(argv for argv, _ in actions["calls"] if Path(argv[0]).name == "pg_dumpall")
    assert "--roles-only" in roles and "--no-role-passwords" in roles
    for argv, kwargs in actions["calls"]:
        assert FIXTURE_PASSWORD not in " ".join(argv)
        if Path(argv[0]).name == "pg_restore":
            assert not any(key.startswith("PG") for key in kwargs["env"])
            assert not any(arg.startswith(("--dbname", "--clean", "--create")) or arg in {"-d", "-c", "-C"} for arg in argv[1:])
        else:
            assert "default_transaction_read_only=on" in kwargs["env"]["PGOPTIONS"]
    manifest = json.loads((output / "capture-manifest.json").read_text())
    assert manifest["archive_retains_owners_and_acls"]
    assert manifest["role_passwords_included"] is False
    assert manifest["production_writes"] is False
    assert manifest["isolated_restore_verified"] is False
    assert manifest["files"]["destination.dump"]["sha256"] == capture.checksum(output / "destination.dump")


@pytest.mark.parametrize("snapshot", [FakeSnapshot(tls=False), FakeSnapshot(read_only="off"), FakeSnapshot(isolation="read committed")])
def test_capture_fails_closed_without_tls_and_exact_snapshot_isolation(tmp_path, monkeypatch, snapshot):
    _, actions = fake_actions(monkeypatch, snapshot=snapshot)
    output = tmp_path / "failed-preflight"
    with pytest.raises(RuntimeError):
        capture.capture(tmp_path / "synthetic.env", output, Path("/synthetic/bin"))
    assert not actions["calls"]
    assert not (output / "capture-manifest.json").exists()


def test_partial_dump_failure_never_reports_success_or_overwrites_previous_evidence(tmp_path, monkeypatch, capsys):
    fake_actions(monkeypatch, fail_dump=True)
    output = tmp_path / "failed-dump"
    with pytest.raises(RuntimeError):
        capture.capture(tmp_path / "synthetic.env", output, Path("/synthetic/bin"))
    assert not (output / "capture-manifest.json").exists()
    assert not capsys.readouterr().out
    before = (output / "destination.dump").read_bytes()
    with pytest.raises(ValueError, match="new capture directory"):
        capture.capture(tmp_path / "synthetic.env", output, Path("/synthetic/bin"))
    assert (output / "destination.dump").read_bytes() == before


def test_main_redacts_credential_bearing_exception(tmp_path, monkeypatch, capsys):
    def failure(*args, **kwargs):
        raise RuntimeError("Synthetic exception includes password=" + FIXTURE_PASSWORD)
    monkeypatch.setattr(capture, "capture", failure)
    monkeypatch.setattr("sys.argv", ["capture_destination.py", "--secret-file", str(tmp_path / "synthetic.env"),
                                    "--output", str(tmp_path / "private-output"), "--pg-bin", "/synthetic/bin"])
    assert capture.main() == 1
    output = capsys.readouterr()
    assert FIXTURE_PASSWORD not in output.out + output.err
    assert json.loads(output.out)["backup_captured"] is False
