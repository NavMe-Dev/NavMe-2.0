import hashlib
import json
from types import SimpleNamespace
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from wayfinding_api.auth import current_admin
from wayfinding_api.routers import plan_navigation
from wayfinding_api.services.plan_registration import fit_draft, load_context


def evidence():
    points = [[0,0],[200,0],[0,200],[200,200],[50,50],[150,150]]
    context = {'model_id':'model','source_version':'a'*64,'building_slug':'uncc-main-campus',
               'plan_versions':{},'approved_calibrations':{},'floors':{'L1':{'source_floor_id':'source-floor'}},
               'sweeps':[{'id':str(i),'floor_id':'L1','position':{'x':p[0]*.1,'y':10-p[1]*.1,'z':0}} for i,p in enumerate(points)]}
    body = {'source_version':'a'*64,'sdk_floor_id':'runtime-floor','floor_verified':True,
            'floor_evidence':'Physical first floor checked against floor thresholds',
            'anchors':[{'diagram':p,'sweep_id':str(i),'holdout':i>=4,'verified':True,
                        'evidence':'Same floor puck reference independently verified'} for i,p in enumerate(points)]}
    return context,body


def test_fit_supports_inverted_axis_with_independent_holdouts_and_stays_unpublished():
    context,body=evidence();result=fit_draft(context,'L1',body)
    assert result['status']=='validated_draft'
    assert result['validation']['max_error_m']<1e-8
    assert result['validation']['holdout_count']==2
    assert result['diagram_to_model']==pytest.approx([.1,0,0,-.1,0,10])
    assert result['published'] is False


@pytest.mark.parametrize('change', ['unverified','collinear','wrong_floor','duplicates','stale','no_holdout','different_level'])
def test_unreliable_correspondences_never_validate(change):
    context,body=evidence()
    if change=='unverified':body['anchors'][0]['verified']=False
    if change=='collinear':
        for a in body['anchors']:a['diagram'][1]=0
    if change=='wrong_floor':context['sweeps'][0]['floor_id']='L2'
    if change=='duplicates':body['anchors'][1]['sweep_id']='0'
    if change=='stale':body['source_version']='b'*64
    if change=='no_holdout':body['anchors'][4]['holdout']=False
    if change=='different_level':context['sweeps'][0]['position']['z']=3
    with pytest.raises(ValueError):fit_draft(context,'L1',body)


def test_bad_holdout_is_a_failed_draft_and_not_a_verified_transform():
    context,body=evidence();context['sweeps'][4]['position']['x']+=2
    result=fit_draft(context,'L1',body)
    assert result['status']=='draft'
    assert result['validation']['passed'] is False


@pytest.fixture
def api(tmp_path,monkeypatch):
    context,body=evidence();plans=tmp_path/'plans';plans.mkdir();(plans/'navigation-context.json').write_text(json.dumps(context))
    cfg=SimpleNamespace(floorplan_dir=plans,data_dir=tmp_path/'data',wf_read_only=False,db_read_only=False)
    monkeypatch.setattr(plan_navigation,'get_settings',lambda:cfg)
    app=FastAPI();app.include_router(plan_navigation.router)
    return TestClient(app),app,cfg,body


def test_public_evidence_does_not_expose_or_approve_drafts(api):
    client,app,cfg,body=api
    result=client.get('/api/v1/public/buildings/uncc-main-campus/floorplans/navigation/context')
    assert result.status_code==200
    assert result.headers['cache-control']=='no-store'
    assert result.json()['approved_calibrations']=={}
    assert client.get('/api/v1/public/buildings/uncc-main-campus/floorplans/navigation/version').json()['source_version']=='a'*64
    assert client.put('/api/v1/admin/buildings/uncc-main-campus/floorplans/calibration/L1',json=body).status_code==401
    assert not cfg.data_dir.exists()


def test_authenticated_save_is_atomic_file_only_and_requires_explicit_local_preview(api):
    client,app,cfg,body=api;app.dependency_overrides[current_admin]=lambda:SimpleNamespace(email='reviewer@example.test')
    url='/api/v1/admin/buildings/uncc-main-campus/floorplans/calibration/L1'
    result=client.put(url,json=body)
    assert result.status_code==200
    assert result.json()['published'] is False
    assert result.json()['status']=='validated_draft'
    assert client.get(url).json()['diagram_to_model']==pytest.approx([.1,0,0,-.1,0,10])
    files=list(cfg.data_dir.rglob('*'))
    assert len([p for p in files if p.is_file()])==1
    assert client.get('/api/v1/public/buildings/uncc-main-campus/floorplans/navigation/context').json()['approved_calibrations']=={}


def test_readonly_mode_forbids_draft_writes_and_payload_cannot_override_approval(api):
    client,app,cfg,body=api;app.dependency_overrides[current_admin]=lambda:SimpleNamespace(email='reviewer@example.test')
    url='/api/v1/admin/buildings/uncc-main-campus/floorplans/calibration/L1'
    assert client.put(url,json={**body,'status':'approved'}).status_code==422
    cfg.wf_read_only=True
    assert client.put(url,json=body).status_code==503


def test_rendering_change_invalidates_saved_evidence(tmp_path):
    context,_=evidence();file=tmp_path/'label-plan.svg';file.write_text('<svg/>')
    context['plan_versions']={'label-plan.svg':hashlib.sha256(file.read_bytes()).hexdigest()}
    (tmp_path/'navigation-context.json').write_text(json.dumps(context))
    assert load_context(tmp_path,'uncc-main-campus')['source_version']=='a'*64
    file.write_text('<svg viewBox="0 0 10 10"/>')
    with pytest.raises(ValueError):load_context(tmp_path,'uncc-main-campus')
