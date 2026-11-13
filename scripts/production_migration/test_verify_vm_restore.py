from copy import deepcopy
import pytest

from verify_vm_restore import compare_snapshot, compare_metadata, snapshot_query


def snapshots():
    source = {"tables": {"public.buildings": {"row_count": 1, "content_digest": "original"}},
              "alembic_version": ["0001"], "supabase_migrations": [{"version": "1", "name": "initial"}]}
    target = {**deepcopy(source), "extensions": [{"name": "postgis", "version": "3.3.7"}],
              "server_version": "PostgreSQL 17.11"}
    required = {"extensions": deepcopy(target["extensions"]), "server_version": "PostgreSQL 17.11"}
    return source, target, required


def test_equal_counts_do_not_hide_overwritten_records():
    source, target, required = snapshots()
    target["tables"]["public.buildings"]["content_digest"] = "different"
    assert not compare_snapshot(source, target, required)["snapshot_verification_pass"]


def test_full_inventory_and_migrations_and_extensions_must_match():
    source, target, required = snapshots()
    assert compare_snapshot(source, target, required)["snapshot_verification_pass"]
    target["extensions"][0]["version"] = "3.6.4"
    assert not compare_snapshot(source, target, required)["snapshot_verification_pass"]


def test_empty_source_snapshot_cannot_pass_verification():
    with pytest.raises(ValueError):
        snapshot_query({"tables": {}})


def test_catalog_oid_and_staging_database_name_are_not_business_differences():
    source = {"database": [{"datname": "postgres", "owner_name": "postgres"}],
              "roles": [{"oid": 10, "rolname": "postgres", "rolsuper": False}]}
    target = {"database": [{"datname": "navme_destination_restore_test", "owner_name": "postgres"}],
              "roles": [{"oid": 42, "rolname": "postgres", "rolsuper": False}]}
    for key in ("memberships", "schemas", "policies", "event_triggers", "database_role_settings", "relation_acls", "function_acls"):
        source[key] = []
        target[key] = []
    assert compare_metadata(source, target)["all_metadata_categories_match"]
    target["roles"][0]["rolsuper"] = True
    assert not compare_metadata(source, target)["all_metadata_categories_match"]


def test_wrong_server_major_cannot_pass_even_when_data_hashes_match():
    source, target, required = snapshots()
    target["server_version"] = "PostgreSQL 18.6"
    assert not compare_snapshot(source, target, required)["snapshot_verification_pass"]


def test_digest_query_preserves_source_serialization_instead_of_rounding_data():
    source, _, _ = snapshots()
    settings = {"extra_float_digits": "0", "timezone": "UTC", "bytea_output": "hex",
                "lc_numeric": "en_US.UTF-8", "datestyle": "ISO, MDY", "intervalstyle": "postgres"}
    query = snapshot_query(source, settings)
    assert 'SET LOCAL "extra_float_digits"=' in query
    assert "round(" not in query


def test_incomplete_catalogs_cannot_be_claimed_as_fully_preserved():
    with pytest.raises(ValueError):
        compare_metadata({"database": []}, {"database": []})
