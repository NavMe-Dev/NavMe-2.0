"""Reader-specific shadow routing must not weaken owner-only backup capture."""
import pytest

from capture_destination import validate_target
from launch_readonly_shadow import PROJECT, REVIEWED_READER_LOGIN, validate_shadow_target

POOL=f"postgresql://{REVIEWED_READER_LOGIN}.{PROJECT}:synthetic-fixture@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
DIRECT=f"postgresql://{REVIEWED_READER_LOGIN}:synthetic-fixture@db.{PROJECT}.supabase.co/postgres"


@pytest.mark.parametrize("value",[POOL,DIRECT])
def test_reader_target_requires_explicit_reviewed_shadow_role(value):
    assert validate_shadow_target(value, REVIEWED_READER_LOGIN).database == "postgres"
    with pytest.raises(ValueError):
        validate_shadow_target(value)
    with pytest.raises(ValueError):
        validate_target(value)


@pytest.mark.parametrize("value",[
    POOL.replace(PROJECT,"other-project"),
    POOL.replace(REVIEWED_READER_LOGIN,"arbitrary_user"),
    POOL.replace(":5432/",":6543/"),
    POOL+"?sslmode=disable",POOL+"?hostaddr=192.0.2.1",POOL+"?service=unexpected",
    POOL+"?HOST=unexpected.invalid",POOL+"?dbname=unexpected",
])
def test_reader_shadow_rejects_routing_project_and_tls_changes(value):
    with pytest.raises(ValueError):
        validate_shadow_target(value,REVIEWED_READER_LOGIN)


def test_shadow_role_selection_cannot_approve_arbitrary_login():
    with pytest.raises(ValueError):
        validate_shadow_target(POOL,"arbitrary_user")
