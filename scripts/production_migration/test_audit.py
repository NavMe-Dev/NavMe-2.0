"""Backup tooling must protect credentials and preserve earlier evidence."""
from pathlib import Path
from types import SimpleNamespace
import pytest

from audit import backup, secure_json, postgres_url


def test_secure_output_is_exclusive_and_private(tmp_path):
    path = tmp_path / "inventory.json"
    secure_json(path, {"count": 3})
    assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        secure_json(path, {"count": 0})
    assert '3' in path.read_text()


def test_backup_rejects_unexpected_remote_host_before_creating_file(tmp_path):
    path = tmp_path / "source.dump"
    with pytest.raises(ValueError):
        backup("postgresql://user:secret@production.invalid/postgres", path,
               Path("/bin"), "127.0.0.1")
    assert not path.exists()


def test_backup_keeps_credentials_out_of_argv_and_requires_readable_archive(tmp_path, monkeypatch):
    calls = []
    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        if "pg_dump" in argv[0]:
            Path(argv[-1]).write_bytes(b"custom-format-fixture")
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr("audit.subprocess.run", run)
    path = tmp_path / "source.dump"
    report = backup("postgresql+psycopg://user:secret@127.0.0.1/db", path,
                    Path("/bin"), "127.0.0.1")
    assert len(calls) == 2
    assert all("secret" not in str(argv) for argv, _ in calls)
    assert calls[0][1]["env"]["PGPASSWORD"] == "secret"
    assert "--list" in calls[1][0]
    assert report["archive_directory_readable"] is True
    assert report["isolated_restore_verified"] is False
    assert path.stat().st_mode & 0o777 == 0o600


def test_unreadable_archive_is_not_reported_as_verified(tmp_path, monkeypatch):
    def run(argv, **kwargs):
        return SimpleNamespace(returncode=1 if "pg_restore" in argv[0] else 0)
    monkeypatch.setattr("audit.subprocess.run", run)
    with pytest.raises(RuntimeError):
        backup("postgresql://user:secret@127.0.0.1/db", tmp_path / "bad.dump",
               Path("/bin"), "127.0.0.1")


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+psycopg"])
def test_connect_panel_urls_use_installed_psycopg3_and_tls(scheme):
    url = postgres_url(f"{scheme}://user:fixture@db.project.invalid/postgres")
    assert url.drivername == "postgresql+psycopg"
    assert url.query["sslmode"] == "require"


def test_strict_tls_and_loopback_settings_are_preserved():
    url = postgres_url("postgresql://user:fixture@db.project.invalid/postgres?sslmode=verify-full&sslrootcert=/private/ca.pem")
    assert url.query["sslmode"] == "verify-full"
    assert url.query["sslrootcert"] == "/private/ca.pem"
    assert "sslmode" not in postgres_url("postgresql://user:fixture@[::1]/local").query


@pytest.mark.parametrize("mode", ["disable", "prefer", "allow"])
def test_remote_tls_downgrade_is_rejected_before_backup_output(tmp_path, mode):
    path = tmp_path / "source.dump"
    with pytest.raises(ValueError):
        backup(f"postgresql://user:fixture@db.project.invalid/postgres?sslmode={mode}",
               path, Path("/bin"), "db.project.invalid")
    assert not path.exists()
