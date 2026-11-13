import pytest
from prepare_restore_companions import database_acls, owners_settings, object_acls


def test_database_acl_companion_is_restricted_to_staging_and_original_grantor():
    source = {"database": [{"owner_name": "postgres", "datacl": ["postgres=CTc/postgres", "anon=c/postgres"]}]}
    sql = database_acls(source)
    assert "current_database()<>'navme_destination_restore_test'" in sql
    assert "SET LOCAL ROLE postgres" in sql
    source["database"][0]["datacl"] = ["anon=c/unreviewed_grantor"]
    with pytest.raises(ValueError):
        database_acls(source)


def test_database_list_settings_replay_preserves_internal_value_without_token_reparsing():
    source = {"function_acls": [], "relation_acls": [], "database": [{"datname": "postgres"}],
              "database_role_settings": [{"database": "postgres", "role": None,
                                           "settings": ["search_path=public, extensions"]}]}
    sql = owners_settings(source, {"function_acls": [], "relation_acls": []})
    assert "set_config('search_path','public, extensions',true)" in sql
    assert 'SET "search_path" FROM CURRENT' in sql


def test_unknown_default_acl_changes_fail_instead_of_widening_access():
    source = {"schemas": [{"schema": "graphql", "owner": "postgres", "acl": None}], "relation_acls": []}
    target = {"schemas": [{"schema": "graphql", "owner": "postgres", "acl": ["anon=U/postgres"]}], "relation_acls": []}
    with pytest.raises(ValueError):
        object_acls(source, target)
