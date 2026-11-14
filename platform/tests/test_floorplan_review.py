import json
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI
from wayfinding_api.routers import floorplans


@pytest.fixture
def plans(tmp_path, monkeypatch):
    (tmp_path / 'floor-inventory.json').write_text(json.dumps({
        'parent_building_slug': 'uncc-main-campus', 'floors': [{'floor_id': 'L1'}]}))
    floor = tmp_path / 'floors' / 'L1'
    floor.mkdir(parents=True)
    (floor / 'floorplan.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    (tmp_path / 'audit').mkdir()
    (tmp_path / 'audit' / 'private.docx').write_bytes(b'private reference')
    monkeypatch.setattr(floorplans, 'get_settings', lambda: SimpleNamespace(floorplan_dir=tmp_path))
    app = FastAPI(); app.include_router(floorplans.router)
    return TestClient(app), tmp_path


def test_configured_plan_is_served_without_database_and_with_safe_headers(plans):
    client, _ = plans
    root = '/api/v1/public/buildings/uncc-main-campus/floorplans/'
    assert client.get(root + 'floor-inventory.json').status_code == 200
    response = client.get(root + 'floors/L1/floorplan.svg')
    assert response.status_code == 200
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['cache-control'].startswith('private')


@pytest.mark.parametrize('asset', ['audit/private.docx', 'floors/L2/floorplan.svg', 'floors/L1/secrets.json',
                                 'floors/L1/../../../.env', '%2e%2e/.env', 'QA_REPORT.md'])
def test_audit_files_unknown_levels_and_traversal_are_not_public(plans, asset):
    client, _ = plans
    assert client.get('/api/v1/public/buildings/uncc-main-campus/floorplans/' + asset).status_code == 404


def test_other_campuses_and_unconfigured_deployments_do_not_gain_review_assets(plans, monkeypatch):
    client, _ = plans
    assert client.get('/api/v1/public/buildings/gcu/floorplans/floor-inventory.json').status_code == 404
    monkeypatch.setattr(floorplans, 'get_settings', lambda: SimpleNamespace(floorplan_dir=None))
    assert client.get('/api/v1/public/buildings/uncc-main-campus/floorplans/floor-inventory.json').status_code == 404


def test_symlink_cannot_escape_configured_output_directory(plans, tmp_path):
    client, root = plans
    outside = tmp_path.parent / (tmp_path.name + '-outside.svg'); outside.write_text('private')
    asset = root / 'floors' / 'L1' / 'floorplan.svg'
    asset.unlink(); asset.symlink_to(outside)
    assert client.get('/api/v1/public/buildings/uncc-main-campus/floorplans/floors/L1/floorplan.svg').status_code == 404
