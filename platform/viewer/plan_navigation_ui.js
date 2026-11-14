/* Adds location actions/calibration to the existing floor-plan panel. */
(function(root){
  'use strict';
  function mount(api){
    const $=id=>document.getElementById(id),N=root.WFPlanNavigation;
    if(!N)return null;
    const toolbar=$('unionFloorplanViewer').querySelector('.fp-toolbar');
    const card=document.createElement('section');card.id='fpLocation';card.className='fp-location';card.hidden=true;
    card.innerHTML='<strong id="fpLocationName"></strong><div id="fpLocationFloor"></div><p id="fpNavStatus" role="status" aria-live="polite"></p><div class="fp-location-actions"><button id="fpEnter3D" type="button">Enter 3D</button><button id="fpNavigate" type="button">Navigate</button><button id="fpLocationClose" type="button" aria-label="Close selected location">×</button></div>';
    toolbar.append(card);
    const back=document.createElement('div');back.id='fp3DContext';back.hidden=true;back.innerHTML='<span id="fp3DLocation"></span><button type="button" id="fpBackToMap">Back to 2D</button>';document.body.append(back);
    let context=null,loading=null,navigator=null,selected=null,request=0,latestPosition=null,adminToken=null,anchors=[],draft=null,picking=false,disposed=false;
    const metrics=[];
    const status=text=>{$('fpNavStatus').textContent=text;};
    async function ensure(){
      if(navigator)return navigator;
      if(!loading)loading=(async()=>{
        const response=await fetch(api.base+'navigation/context',{cache:'no-store'});
        if(!response.ok)throw Error(N.unavailable);
        context=await response.json();
        if(context.model_id!==api.catalog.model_id||context.building_id!==api.catalog.building_id)throw Error(N.unavailable);
        navigator=N.createNavigator({context,calibrations:{...context.approved_calibrations},getConnection:()=>root.MpPreview?.getLiveConnection(),beforeMove:()=>root.MpPreview?.pauseForPlanNavigation?.(),onPosition:position=>{latestPosition=position;if(document.body.classList.contains('floorplan-open')&&!picking)void showPosition(position);},onMetrics:sample=>{metrics.push({...sample,at:Date.now()});if(metrics.length>100)metrics.shift();}});
        return navigator;
      })().catch(error=>{loading=null;throw error;});
      return loading;
    }
    function checkDiagram(){const asset=api.getState().planAsset;if(!asset||context.plan_versions?.[asset.path]!==asset.sha256)throw Error('The floor drawing changed. Reload before navigating.');}
    function poiForLabel(label){
      if(!label)return null;
      const norm=s=>String(s).toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
      return root.wf?.pois?.find(p=>norm(p.name)===norm(label.text))||
        (label.id==='L2-meeting-260'?root.wf?.pois?.find(p=>/^260\b/.test(p.name)):null);
    }
    function choose(detail){
      request++;navigator?.cancel();
      if(!detail||!api.validPoint(detail.point)){card.hidden=true;selected=null;return false;}
      selected={...detail,point:{x:detail.point.x,y:detail.point.y},floorId:api.getState().floorId};card.hidden=false;
      const state=api.getState();$('fpLocationName').textContent=detail.label?.text||'Selected location';$('fpLocationFloor').textContent=state.metadata.label;
      $('fpEnter3D').disabled=false;
      const poi=poiForLabel(detail.label);$('fpNavigate').disabled=!poi;
      $('fpNavigate').title=poi?'Get directions to this mapped destination':'Directions are available for mapped destinations.';
      status(root.matchMedia?.('(pointer: coarse)').matches?'Tap Enter 3D to open this location.':'Double-click to enter 3D, or use Enter 3D.');
      if(picking&&$('fpCalPoint'))$('fpCalPoint').textContent=detail.point.x.toFixed(2)+', '+detail.point.y.toFixed(2);
      return true;
    }
    async function enter(){
      if(!selected)return {ok:false,reason:'no_selection'};
      const id=++request,target=selected;status('Finding a verified 3D location…');$('fpEnter3D').disabled=true;
      try{
        const nav=await ensure();checkDiagram();if(id!==request)return {ok:false,reason:'cancelled'};
        // No SDK movement/readiness wait at all when registration is absent.
        if(!N.calibrationValid(nav.matcher.calibrations[target.floorId],context,target.floorId)){
          status(N.unavailable+' This floor needs verified alignment.');return {ok:false,reason:'alignment_required'};
        }
        const versionResponse=await fetch(api.base+'navigation/version',{cache:'no-store'});if(!versionResponse.ok||(await versionResponse.json()).source_version!==context.source_version)throw Error('Spatial evidence changed');
        if(id!==request)return {ok:false,reason:'cancelled'};
        const region=target.label?.region_id?api.regionPolygon(target.label.region_id):null;
        const result=await nav.navigate({...target.point,region},target.floorId,api.catalog.model_id);
        if(id!==request)return {ok:false,reason:'cancelled'};
        if(!result.ok){status(N.unavailable);return result;}
        $('fp3DLocation').textContent=(target.label?.text||'Selected location')+' · '+api.getState().metadata.label+(result.fallback?' · Verified entrance':'');
        back.hidden=false;api.close();return result;
      }catch(_){if(id===request)status(N.unavailable);return {ok:false,reason:'viewer_unavailable'};}
      finally{if(id===request)$('fpEnter3D').disabled=false;}
    }
    async function showPosition(position){
      if(disposed||picking)return;
      if(api.getState().floorId!==position.floorId)await api.selectFloor(position.floorId);
      if(disposed||latestPosition!==position)return;
      api.showPosition(position.point);
    }
    async function returnToMap(){
      request++;navigator?.cancel();back.hidden=true;
      await api.open(api.getState().floorId);
    }
    $('fpEnter3D').onclick=()=>void enter();
    $('fpLocationClose').onclick=()=>{request++;navigator?.cancel();card.hidden=true;selected=null;};
    $('fpNavigate').onclick=()=>{const poi=poiForLabel(selected?.label);if(poi){root.wfUI?.openDirections(null,poi.id);api.close();}};
    $('fpBackToMap').onclick=()=>void returnToMap();
    const floorChanged=()=>{request++;navigator?.cancel();selected=null;card.hidden=true;};
    const labelChanged=event=>{const state=api.getState(),label=state.metadata.labels?.find(l=>l.id===event.detail.id);if(label)choose({point:{x:label.position[0],y:label.position[1]},label});};
    root.addEventListener('wf-plan-label-selected',labelChanged);
    // Capture screen->SVG coordinates once through the existing current CTM.
    const stage=$('fpStage');
    const click=event=>{
      if(api.gestureBlocked()||event.target.closest('button,select'))return;
      const state=api.getState();if(!state.svg)return;
      const point=api.screenPoint(event),labelId=event.target.closest('[data-label-id]')?.dataset.labelId;
      const label=state.metadata.labels?.find(l=>l.id===labelId);
      choose({point,label});
    };
    const double=event=>{if(api.gestureBlocked())return;event.preventDefault();click(event);if(selected)void enter();};
    stage.addEventListener('click',click);stage.addEventListener('dblclick',double);
    async function adminFetch(path,options={}){
      const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json',...(options.headers||{})}});
      if(!response.ok){let message='Calibration request failed';try{const data=await response.json();message=typeof data.detail==='string'?data.detail:message;}catch(_){}throw Error(message);}
      return response.json();
    }
    function showAnchors(){
      const list=$('fpCalAnchors');list.replaceChildren();
      anchors.forEach((a,index)=>{const li=document.createElement('li');li.textContent=(index+1)+'. '+(a.holdout?'Check':'Fit')+' · '+a.sweep_id.slice(0,10)+' · '+a.diagram.map(n=>n.toFixed(1)).join(', ');list.append(li);});
    }
    async function mountCalibration(){
      if(new URLSearchParams(location.search).get('planCalibration')!=='1')return;
      const panel=document.createElement('details');panel.className='fp-calibration';panel.id='fpCalibration';
      const summary=document.createElement('summary');summary.textContent='Floor calibration · draft';panel.append(summary);toolbar.append(panel);
      try{adminToken=localStorage.getItem('wf_admin_token');}catch(_){}
      if(!adminToken){const p=document.createElement('p');p.textContent='Sign in to the existing admin panel to calibrate a floor.';panel.append(p);return;}
      try{const me=await adminFetch('/api/v1/auth/me');if(!me.is_admin)throw Error('Admin required');}catch(_){panel.append(document.createTextNode('Admin sign-in is required.'));return;}
      const body=document.createElement('div');body.innerHTML='<p>Match four or more physical reference points, plus two independent check points. Use the same floor surface visible in both views; room labels are not control points.</p><button type="button" id="fpCalStart">Select 2D reference</button><div>Diagram point: <output id="fpCalPoint">Choose a point</output></div><button type="button" id="fpCalInspect">Inspect existing 3D view</button><label><input type="checkbox" id="fpCalHoldout">Independent check point</label><label>Reference evidence<input id="fpCalEvidence" minlength="8" maxlength="500" placeholder="Physical feature verified in both views"></label><label><input id="fpCalVerified" type="checkbox">I verified this is the same physical point</label><button id="fpCalCapture" type="button">Capture current 3D reference</button><ol id="fpCalAnchors"></ol><label>Floor verification notes<input id="fpCalFloorEvidence" minlength="8" maxlength="1000" placeholder="Physical level and SDK floor confirmed"></label><label><input id="fpCalFloorVerified" type="checkbox">I verified the floor identity</label><div class="fp-cal-actions"><button type="button" id="fpCalSave">Save draft</button><button type="button" id="fpCalLoad">Load draft</button><button type="button" id="fpCalPreview" disabled>Preview draft locally</button></div><p id="fpCalStatus" role="status"></p>';
      panel.append(body);let sdkFloorId=null,calibrationFloor=null,diagramPoint=null;
      const calStatus=text=>{$('fpCalStatus').textContent=text;};
      $('fpCalStart').onclick=()=>{if(calibrationFloor!==api.getState().floorId){anchors=[];sdkFloorId=null;showAnchors();}picking=true;diagramPoint=null;calibrationFloor=api.getState().floorId;calStatus('Select a verified reference point on the 2D plan.');};
      const pickEvent=event=>{if(!picking)return;const point=api.screenPoint(event);if(api.validPoint(point)){diagramPoint=[point.x,point.y];$('fpCalPoint').textContent=diagramPoint.map(n=>n.toFixed(2)).join(', ');}};
      stage.addEventListener('click',pickEvent);
      $('fpCalInspect').onclick=()=>{if(!diagramPoint){calStatus('Select a 2D reference first.');return;}api.close();back.hidden=false;$('fp3DLocation').textContent='Inspect the matching reference, then return to 2D';};
      $('fpCalCapture').onclick=async()=>{try{
        if(!diagramPoint||calibrationFloor!==api.getState().floorId||!$('fpCalVerified').checked||$('fpCalEvidence').value.trim().length<8)throw Error('Select and verify a same-floor reference point first.');
        const nav=await ensure();checkDiagram();await nav.ready();const current=nav.adapter.current;
        if(!current?.floorInfo?.id||!current.puckPosition||nav.adapter.pose?.mode!=='mode.inside')throw Error('Stand at a placed Inside View sweep on the selected physical floor.');
        const reference=context.sweeps.find(s=>[current.id,current.sid,current.uuid].includes(s.id)&&s.floor_id===calibrationFloor);
        const puck=N.toModel(current.puckPosition);
        if(!reference||Math.hypot(reference.position.x-puck.x,reference.position.y-puck.y,reference.position.z-puck.z)>.3)throw Error('The SDK reference does not match the selected source floor.');
        if(sdkFloorId&&sdkFloorId!==current.floorInfo.id)throw Error('Use one verified SDK floor for this calibration.');
        sdkFloorId=current.floorInfo.id;
        anchors.push({diagram:diagramPoint,sweep_id:reference.id,holdout:$('fpCalHoldout').checked,verified:true,evidence:$('fpCalEvidence').value.trim()});
        diagramPoint=null;$('fpCalVerified').checked=false;showAnchors();calStatus('Reference captured. Choose the next point across the floor.');
      }catch(error){calStatus(error.message);}};
      const draftURL=()=>'/api/v1/admin/buildings/'+encodeURIComponent(api.catalog.parent_building_slug)+'/floorplans/calibration/'+encodeURIComponent(api.getState().floorId);
      $('fpCalSave').onclick=async()=>{try{
        if(calibrationFloor!==api.getState().floorId)throw Error('Return to the floor being calibrated.');
        draft=await adminFetch(draftURL(),{method:'PUT',body:JSON.stringify({source_version:(await ensure(),context.source_version),sdk_floor_id:sdkFloorId,floor_verified:$('fpCalFloorVerified').checked,floor_evidence:$('fpCalFloorEvidence').value,anchors})});
        $('fpCalPreview').disabled=!draft.validation.passed;calStatus(draft.validation.passed?'Draft saved. Control-point checks passed; live navigation still needs verification.':'Draft saved with failed alignment checks. Review reference points.');
      }catch(error){calStatus(error.message);}};
      $('fpCalLoad').onclick=async()=>{try{await ensure();draft=await adminFetch(draftURL());anchors=draft.anchors;sdkFloorId=draft.sdk_floor_id;calibrationFloor=draft.floor_id;showAnchors();$('fpCalPreview').disabled=!draft.validation.passed;calStatus('Unpublished draft loaded.');}catch(error){calStatus(error.message);}};
      $('fpCalPreview').onclick=async()=>{try{const nav=await ensure();if(!N.calibrationValid(draft,context,api.getState().floorId))throw Error('Draft is not valid for these source files.');nav.setCalibration(draft);picking=false;calStatus('Local draft preview enabled. Nothing is published.');}catch(error){calStatus(error.message);}};
      api.onDispose(()=>stage.removeEventListener('click',pickEvent));
    }
    void mountCalibration();
    return {choose,enter,ensure,returnToMap,floorChanged,mapOpened:()=>latestPosition&&!picking?showPosition(latestPosition):Promise.resolve(),get metrics(){return metrics;},get selected(){return selected;},
      dispose(){disposed=true;request++;navigator?.dispose();root.removeEventListener('wf-plan-label-selected',labelChanged);stage.removeEventListener('click',click);stage.removeEventListener('dblclick',double);card.remove();back.remove();}};
  }
  root.WFPlanNavigationUI={mount};
})(window);
