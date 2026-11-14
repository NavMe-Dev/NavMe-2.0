/* Student Union diagram labels/divisions and separate scan-derived assets in NavMe.
 * Reuses wfUI selection/search, existing floor IDs and the actual navigation mesh.
 * Does not modify campus geometry, publication records or Matterport state. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  let catalog, base, activeFloor, meta, svg, selectedPoi, lastRoute, ticket = 0;
  const official = () => catalog?.presentation === 'official_labels_divisions';
  let view = [40, 180, 1080, 1080], pan = null;
  const cache = new Map(), metadata = new Map();
  async function json(url) { const r = await fetch(url); if (!r.ok) throw Error('Floor plan unavailable'); return r.json(); }
  function screenPoint(event) { return new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse()); }
  function applyView() { if (svg) svg.setAttribute('viewBox',view.join(' ')); }
  function zoom(factor, point) {
    if (!svg) return;
    const p = point || {x:view[0]+view[2]/2,y:view[1]+view[3]/2};
    const width = Math.max(100,Math.min(2200,view[2]*factor)), ratio=width/view[2];
    view=[p.x-(p.x-view[0])*ratio,p.y-(p.y-view[1])*ratio,width,view[3]*ratio]; applyView();
  }
  function fit() { view=meta?.view_box?.slice() || [40,180,1080,1080]; applyView(); }
  function toSvg(x,y) { const [a,b,c,d,e,f]=meta.model_to_svg; return [a*x+c*y+e,b*x+d*y+f]; }
  function nearestFloor(z) { return catalog.floors.reduce((a,b)=>Math.abs(a.elevation_model_m-z)<Math.abs(b.elevation_model_m-z)?a:b).floor_id; }
  function drawRoute(route) {
    lastRoute=route;
    if (!svg || !meta) return;
    svg.querySelector('#fpRoute')?.remove();
    $('fpRouteNote').textContent='';
    if (!route) return;
    if (meta.presentation === 'official_labels_divisions' && !meta.model_registered) return;
    const points=route.navPath || route.nodes || (route.path||[]).map(p=>({x:p.x,y:-p.z,z:p.y}));
    let d='',previous=false,shown=0;
    for (const p of points) {
      const onFloor=Number.isFinite(p.z)&&nearestFloor(p.z)===activeFloor&&Math.abs(p.z-meta.elevation_model_m)<1.5;
      const inCrop=p.x>=meta.bounds_model_xy[0]&&p.x<=meta.bounds_model_xy[2]&&p.y>=meta.bounds_model_xy[1]&&p.y<=meta.bounds_model_xy[3];
      if (!onFloor || !inCrop) { previous=false; continue; }
      const [x,y]=toSvg(p.x,p.y);d+=(previous?' L':' M')+x.toFixed(2)+','+y.toFixed(2);previous=true;shown++;
    }
    if (shown>1) { const path=document.createElementNS(NS,'path');path.id='fpRoute';path.setAttribute('class','fp-route');path.setAttribute('d',d);svg.append(path); }
    $('fpRouteNote').textContent=shown>1?'Existing navigation route · current level only':'The selected route has no mapped segment on this level.';
  }
  function highlight(id) {
    selectedPoi=String(id);
    if (!svg) return;
    svg.querySelectorAll('[data-poi-id]').forEach(el=>el.classList.toggle('fp-selected',el.dataset.poiId===selectedPoi));
    if (official()) {
      const label=(meta.labels||[]).find(p=>p.id===selectedPoi);
      svg.querySelectorAll('[data-label-id]').forEach(el=>el.classList.toggle('fp-selected',el.dataset.labelId===selectedPoi));
      svg.querySelectorAll('.division').forEach(el=>el.classList.toggle('fp-region-selected',el.id===label?.region_id));
      $('fpPoi').value=label?selectedPoi:'';
    } else $('fpPoi').value=(meta.pois||[]).some(p=>p.id===selectedPoi)?selectedPoi:'';
  }
  async function selectLabel(id, focus=false) {
    const match=[...metadata.values()].find(m=>(m.labels||[]).some(p=>p.id===String(id)));
    if (!match) return false;
    if (activeFloor!==match.floor_id) await selectFloor(match.floor_id);
    highlight(id);
    if (focus) {
      const label=match.labels.find(p=>p.id===String(id));
      const width=Math.min(900,Math.max(450,Math.max(...label.lines.map(s=>s.length))*label.size*1.8));
      const height=width*view[3]/view[2];
      view=[label.position[0]-width/2,label.position[1]-height/2,width,height];applyView();
    }
    return true;
  }
  function labelForPlace(id) {
    const poi=window.wf?.pois?.find(p=>String(p.id)===String(id));
    if(!poi)return null;
    const normal=s=>String(s).toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
    const labels=[...metadata.values()].flatMap(m=>m.labels||[]);
    return labels.find(l=>normal(l.text)===normal(poi.name)) ||
      (/^260\b/.test(poi.name)?labels.find(l=>l.id==='L2-meeting-260'):null);
  }
  async function selectPoi(id, sync=true) {
    if(official()){const label=labelForPlace(id);return label?selectLabel(label.id):false;}
    const match=[...metadata.values()].find(m=>(m.pois||[]).some(p=>p.id===String(id)));
    if (!match) return false;
    if (activeFloor!==match.floor_id) await selectFloor(match.floor_id);
    highlight(id);
    if (sync && window.wfUI) wfUI.selectPlace(String(id));
    return true;
  }
  function bindCanvas() {
    svg.addEventListener('wheel',event=>{event.preventDefault();zoom(Math.exp(event.deltaY*.001),screenPoint(event));},{passive:false});
    svg.addEventListener('pointerdown',event=>{
      if (event.target.closest('[data-poi-id],[data-label-id]')) return;
      const matrix=svg.getScreenCTM();pan={x:event.clientX,y:event.clientY,box:view.slice(),scale:matrix.a};svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove',event=>{if(!pan)return;view=[pan.box[0]-(event.clientX-pan.x)/pan.scale,pan.box[1]-(event.clientY-pan.y)/pan.scale,pan.box[2],pan.box[3]];applyView();});
    const stop=()=>{pan=null;};svg.addEventListener('pointerup',stop);svg.addEventListener('pointercancel',stop);
    svg.querySelectorAll('[data-label-id]').forEach(el=>{
      el.onclick=()=>void selectLabel(el.dataset.labelId);
      el.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();void selectLabel(el.dataset.labelId);}};
    });
    svg.querySelectorAll('[data-poi-id]').forEach(el=>{
      el.onclick=()=>void selectPoi(el.dataset.poiId);
      el.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();void selectPoi(el.dataset.poiId);}};
    });
  }
  async function selectFloor(id) {
    if (!catalog.floors.some(f=>f.floor_id===id)) throw Error('Unknown floor');
    const request=++ticket;
    $('fpStatus').textContent='Loading floor plan…';
    if (!cache.has(id)) cache.set(id,(async()=>{
      const floor=catalog.floors.find(f=>f.floor_id===id);
      const [m,r]=await Promise.all([json(base+'floors/'+id+'/'+(official()?floor.label_metadata:'metadata.json')),fetch(base+'floors/'+id+'/'+(official()?floor.label_plan:'floorplan.svg'))]);
      if(!r.ok)throw Error('Floor drawing unavailable');
      const text=await r.text();return {meta:m,text};
    })().catch(e=>{cache.delete(id);throw e;}));
    const data=await cache.get(id); if(request!==ticket)return;
    activeFloor=id;meta=data.meta;metadata.set(id,meta);
    const doc=new DOMParser().parseFromString(data.text,'image/svg+xml');
    if (doc.querySelector('parsererror')||doc.querySelector('script,foreignObject')) throw Error('Invalid floor drawing');
    svg=document.importNode(doc.documentElement,true);
    svg.removeAttribute('aria-labelledby');svg.setAttribute('role','group');
    svg.setAttribute('aria-label',meta.label+' interactive floor plan');
    // The downloadable sheet has a title, scale and provenance legend. The
    // interactive map uses its vector geometry; controls carry the title.
    const geometry=svg.querySelector('#plan-geometry');
    if(!geometry)throw Error('Floor geometry unavailable');
    svg.replaceChildren(...svg.querySelectorAll(':scope > style'),geometry);$('fpStage').replaceChildren(svg);bindCanvas();fit();
    $('fpFloor').value=id;$('fpStatus').dataset.provisional=String(!official()&&id==='M');
    $('fpStatus').textContent=official()?'University floor plan · Labels and divisions':id==='M'?'Mezzanine: provisional geometry and elevation. Partial scan; manual review required.':'Partial scan. White areas have no reconstructed geometry. Room identities are not verified.';
    $('fpPoi').replaceChildren(new Option(official()?'Find a label':'Select a mapped place',''),...(official()?meta.labels||[]:meta.pois||[]).map(p=>new Option(p.text||p.name,p.id)));
    $('fpLabelCaption').textContent=official()?'Labels':'Mapped places';
    if(selectedPoi)highlight(selectedPoi);
    drawRoute(lastRoute||window.wf?.lastRoute);
  }
  async function open(id) {
    $('unionFloorplanViewer').hidden=false;document.body.classList.add('floorplan-open');$('btnFloorplans').setAttribute('aria-pressed','true');
    $('sheetClose')?.click();
    await selectFloor(id||activeFloor||'L1');
    for (const f of catalog.floors) if(!metadata.has(f.floor_id))json(base+'floors/'+f.floor_id+'/'+(official()?f.label_metadata:'metadata.json')).then(m=>metadata.set(f.floor_id,m)).catch(()=>{});
    return true;
  }
  function close() { $('unionFloorplanViewer').hidden=true;document.body.classList.remove('floorplan-open');$('btnFloorplans').setAttribute('aria-pressed','false'); }
  function error(e) { $('fpStatus').textContent=e.message||'Floor plan unavailable. Try selecting the level again.'; }
  function mount() {
    const panel=document.createElement('section');panel.id='unionFloorplanViewer';panel.hidden=true;panel.setAttribute('aria-label','Student Union 2D floor plans');
    panel.innerHTML='<div class="fp-stage" id="fpStage"></div><div class="fp-toolbar"><label>Building<select id="fpBuilding"><option value="student-union">Student Union</option></select></label><label>Floor<select id="fpFloor"></select></label><label class="fp-poi-label"><span id="fpLabelCaption">Mapped places</span><select id="fpPoi"><option value="">Select a mapped place</option></select></label><p class="fp-status" id="fpStatus" role="status"></p><div class="fp-tools"><button id="fpZoomIn" aria-label="Zoom in on floor plan">+</button><button id="fpZoomOut" aria-label="Zoom out on floor plan">−</button><button id="fpFit">Fit</button><button id="fpClose" aria-label="Close floor plans">×</button></div><p class="fp-route-note" id="fpRouteNote"></p><a class="fp-reference" href="https://studentunion.charlotte.edu/about/floor-plans" target="_blank" rel="noopener">University floor plans ↗</a></div>';
    document.body.append(panel);
    $('fpFloor').replaceChildren(...catalog.floors.map(f=>new Option(f.label+(!official()&&f.floor_id==='M'?' (review)':''),f.floor_id)));
    $('fpFloor').onchange=()=>selectFloor($('fpFloor').value).catch(error);
    $('fpPoi').onchange=()=>{if($('fpPoi').value)(official()?selectLabel($('fpPoi').value,true):selectPoi($('fpPoi').value)).catch(error);};
    $('fpZoomIn').onclick=()=>zoom(.75);$('fpZoomOut').onclick=()=>zoom(1.33);$('fpFit').onclick=fit;$('fpClose').onclick=close;
    const button=document.createElement('button');button.id='btnFloorplans';button.type='button';button.textContent='2D';button.className='fab txt';button.setAttribute('aria-label','Open 2D floor plans');button.setAttribute('aria-pressed','false');
    button.onclick=()=>document.body.classList.contains('floorplan-open')?close():open().catch(error);$('btnMe').before(button);
    window.addEventListener('wf-place-selected',event=>{if(document.body.classList.contains('floorplan-open'))selectPoi(event.detail.id,false).catch(error);});
    window.addEventListener('wf-route-changed',event=>drawRoute(event.detail));
    window.WFPlanViewer={open,close,selectFloor,selectPoi,selectLabel,drawRoute,get activeFloor(){return activeFloor;}};
    if(new URLSearchParams(location.search).get('plan')==='student-union')open().catch(error);
  }
  if (!window.WF?.ready) return;
  WF.ready.then(async()=>{
    if (WF.building?.slug!=='uncc-main-campus') return;
    base='/api/v1/public/buildings/uncc-main-campus/floorplans/';
    const r=await fetch(base+'floor-inventory.json');if(!r.ok)return;
    catalog=await r.json();if(catalog.building_id!=='student-union'||catalog.model_id!==WF.cfg.matterport_model_id)return;
    mount();
  }).catch(()=>{});
})();
