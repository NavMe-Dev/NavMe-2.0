from restore_preflight import assess, local_inspection_url, inspect_target
import pytest


def manifests():
    source = {"server_version": "17.11", "extensions": [{"name": "plpgsql", "version": "1.0"}],
              "roles": ["postgres"], "publications": []}
    target = {"server_version": "17.11", "database": "inspection_only", "extensions": [
        {"name": "plpgsql", "version": "1.0"}], "roles": ["postgres"],
        "is_superuser": True, "shared_preload_libraries": "", "wal_level": "replica"}
    return source, target


@pytest.mark.parametrize("url", ["postgresql://u:fixture@production.invalid/postgres",
                                 "postgresql://u:fixture@10.0.0.1/postgres",
                                 "postgresql:///postgres"])
def test_production_or_implicit_hosts_are_rejected(url):
    with pytest.raises(ValueError):
        local_inspection_url(url)


def test_compatibility_does_not_claim_an_executed_restore_or_production_approval():
    report = assess(*manifests())
    assert report["preflight_pass"]
    assert not report["restore_executed"]
    assert not report["full_restore_verified"]
    assert not report["production_apply_allowed"]


def test_missing_managed_extension_and_wrong_major_block_full_restore():
    source, target = manifests()
    source["extensions"].append({"name": "supabase_vault", "version": "0.3.1"})
    target["server_version"] = "18.6"
    report = assess(source, target)
    assert not report["preflight_pass"]
    assert len(report["blockers"]) == 3
    assert report["external_recovery_requirements"]


def test_different_extension_version_is_not_silently_substituted():
    source, target = manifests()
    source["extensions"].append({"name": "postgis", "version": "3.3.7"})
    target["extensions"].append({"name": "postgis", "version": "3.6.4"})
    assert not assess(source, target)["preflight_pass"]


def test_roles_and_logical_replication_configuration_must_be_accounted_for():
    source, target = manifests()
    source["roles"].append("supabase_auth_admin")
    source["publications"] = ["supabase_realtime"]
    report = assess(source, target)
    assert report["missing_global_roles"] == ["supabase_auth_admin"]
    assert len(report["blockers"]) == 2


def test_incomplete_metadata_cannot_pass_recovery_preflight():
    source, target = manifests()
    del source["roles"]
    assert not assess(source, target)["preflight_pass"]
    source["extensions"] = []
    with pytest.raises(ValueError):
        assess(source, target)


@pytest.mark.parametrize("key", ["host", "hostaddr", "service", "servicefile", "dbname", "database", "port", "user", "password"])
def test_loopback_host_cannot_be_overridden_in_query(key):
    with pytest.raises(ValueError):
        local_inspection_url(f"postgresql://u:fixture@127.0.0.1/local?{key}=remote.invalid")


def test_nested_connection_database_is_rejected():
    with pytest.raises(ValueError):
        local_inspection_url("postgresql://u:fixture@127.0.0.1/postgresql%3A%2F%2Fremote.invalid%2Fpostgres")


def test_preflight_excludes_inherited_libpq_routing_and_restores_after_failure(monkeypatch):
    import os
    monkeypatch.setenv("PGHOSTADDR", "198.51.100.1")
    monkeypatch.setenv("PGSERVICE", "untrusted-route")
    monkeypatch.setenv("PGSERVICEFILE", "/private/fixture-service.conf")
    def create(*args, **kwargs):
        assert not any(key.startswith("PG") for key in os.environ)
        raise RuntimeError("fixture connection failure")
    monkeypatch.setattr("restore_preflight.create_engine", create)
    with pytest.raises(RuntimeError):
        inspect_target("postgresql://u:fixture@127.0.0.1/local")
    assert os.environ["PGHOSTADDR"] == "198.51.100.1"
    assert os.environ["PGSERVICE"] == "untrusted-route"
    assert os.environ["PGSERVICEFILE"] == "/private/fixture-service.conf"


def vault_manifests():
    source, target = manifests()
    extension = {"name": "supabase_vault", "version": "0.3.1"}
    source["extensions"].append(extension)
    target["extensions"].append(extension)
    source["vault_secret_count_snapshot_verified"] = True
    return source, target


def test_verified_empty_vault_snapshot_does_not_require_hypothetical_key_recovery():
    source, target = vault_manifests()
    source["vault_secret_count"] = 0
    report = assess(source, target)
    assert report["preflight_pass"]
    assert report["external_recovery_requirements"] == []
    assert not report["vault"]["encrypted_secret_recovery_required"]
    assert report["vault"]["extension_still_required"]


def test_verified_positive_vault_count_requires_real_key_recovery():
    source, target = vault_manifests()
    source["vault_secret_count"] = 1
    report = assess(source, target)
    assert not report["preflight_pass"]
    assert report["vault"]["encrypted_secret_recovery_required"]


def test_zero_without_verified_snapshot_evidence_cannot_bypass_vault_gate():
    source, target = vault_manifests()
    source["vault_secret_count"] = 0
    source["vault_secret_count_snapshot_verified"] = False
    assert not assess(source, target)["preflight_pass"]


@pytest.mark.parametrize("count", [False, "0", -1])
def test_invalid_zero_like_or_negative_vault_counts_are_rejected(count):
    source, target = vault_manifests()
    source["vault_secret_count"] = count
    with pytest.raises(ValueError):
        assess(source, target)


def test_empty_vault_does_not_exempt_the_required_extension():
    source, target = vault_manifests()
    source["vault_secret_count"] = 0
    target["extensions"] = [r for r in target["extensions"] if r["name"] != "supabase_vault"]
    report = assess(source, target)
    assert not report["preflight_pass"]
    assert any("extension/version unavailable: supabase_vault" in b for b in report["blockers"])
