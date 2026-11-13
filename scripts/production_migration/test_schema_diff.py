from schema_diff import compare
import pytest


def catalogs(destination_not_null=True):
    column = {"schema": "public", "table": "buildings", "column": "id",
              "type": "integer", "not_null": True, "default_expr": None}
    source = {"tables": {"public.buildings": {"row_count": 2}}, "rls": []}
    source_catalog = {"columns": [column], "indexes": [], "constraints": [
        {"schema": "public", "table": "buildings", "type": "n", "definition": "NOT NULL id"}]}
    destination_columns = [{**column, "not_null": destination_not_null}]
    return source, source_catalog, [{"name": "public.buildings", "rows": 1}], destination_columns, {"constraints": [], "indexes": []}


def test_postgres_18_not_null_catalog_change_is_not_a_false_schema_difference():
    report = compare(*catalogs())
    assert report["tables"]["public.buildings"]["category"] == "existing and structurally compatible"


def test_real_not_null_change_is_still_reported_across_postgres_versions():
    report = compare(*catalogs(destination_not_null=False))
    table = report["tables"]["public.buildings"]
    assert table["category"] == "existing with schema differences"
    assert table["differences"]["changed_columns"][0]["differences"]["not_null"] == {"source": True, "destination": False}


def test_partial_catalog_export_cannot_produce_a_compatible_classification():
    source, source_catalog, destination_tables, _, destination_catalog = catalogs()
    with pytest.raises(ValueError):
        compare(source, source_catalog, destination_tables, [], destination_catalog)
