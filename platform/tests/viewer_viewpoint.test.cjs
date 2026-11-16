// Camera behavior runs against the real controllers with a fake Matterport SDK.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../viewer/', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let n=0; n<6; n++) await new Promise(setImmediate); };

function environment() {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, {hidden: true, value: '', textContent: '', style: {},
      classList: {add(){}, remove(){}}, addEventListener(){}});
    return elements.get(id);
  };
  const context = {window: null, document: {getElementById, body:{classList:{add(){}, remove(){}}}},
    navigator: {userAgent:'test'}, console: {info(){}, warn(){}, error(){}},
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout(){},
    requestAnimationFrame: () => 1, cancelAnimationFrame(){}, URLSearchParams,
    location: {href:'https://viewer.test/unc-charlotte',search:''}, matchMedia: () => ({matches:false})};
  context.window = context;
  context.WF = {cfg: {slug:'uncc-main-campus', matterport_model_id:'test-model', mp_sdk_key:'public-test-key'}};
  vm.createContext(context);
  return context;
}

function fakeSdk() {
  const calls = [], rotations = [];
  let pose = {position:{x:10,y:1.6,z:-20},rotation:{x:0,y:0},sweepId:'destination'};
  const sdk = {Model:{getData:async()=>({sweeps:[]})},
    Sweep:{Transition:{INSTANT:'instant',FLY:'fly'},data:{},
      moveTo:async(sid,opts)=>{calls.push({sid,opts:plain(opts)}); if(opts?.rotation) pose.rotation=opts.rotation;}},
    Camera:{getPose:async()=>pose,zoomTo:async()=>{},
      setRotation:async rotation=>{rotations.push(plain(rotation));pose.rotation=rotation;}}};
  return {sdk,calls,rotations,setPose:value=>{pose=value;}};
}

function walkController() {
  const context = environment();
  let source = read('threed_nav.js');
  source = source.replace('  window.ThreeDNav = {', `
  // Test-only access to closure state; production exports are unchanged.
  window.__walk = {
    bind: function(sdk) { mpSdk=sdk; lastPose={position:{x:10,y:1.6,z:-20}}; currentSweepSid='destination'; },
    stopConnect: function() { connectSdk=function(){}; },
    state: function() { return {endpoint:destPtMp,look:destLookPtMp,path:navPathMp}; },
    arrive: showArrived,
    invalidate: function() { openGen++; },
  };
  window.ThreeDNav = {`);
  vm.runInContext(source, context);
  context.__walk.stopConnect();
  return context;
}

const route = target => ({navPath:[{x:0,y:20,z:0},{x:10,y:20,z:0}],
  _destXYZ:target,_destName:'Room',sweep_ids:['origin','destination']});

for (const reuse of [false,true]) {
  test(`${reuse?'reused':'standalone'} directions save an independent look target and re-aim once at arrival`, async () => {
    const c=walkController(), sdk=fakeSdk();
    let arrivals=0;
    c.wfShowArrivalCard=()=>arrivals++;
    if(reuse) c.MpPreview={getLiveConnection:()=>({sdk:sdk.sdk})};
    const input=route({x:13,y:20,z:2.6}), original=plain(input);
    await c.ThreeDNav.open(input);
    assert.deepEqual(plain(input),original);
    assert.deepEqual(plain(c.__walk.state()),{
      endpoint:{x:10,y:0,z:-20},look:{x:13,y:2.6,z:-20},
      path:[{x:0,y:0,z:-20},{x:10,y:0,z:-20}]});
    c.__walk.bind(sdk.sdk);
    c.__walk.arrive(); c.__walk.arrive();
    await flush();
    assert.equal(arrivals,1);
    assert.equal(sdk.calls.length,1);
    assert.equal(sdk.calls[0].sid,'destination','arrival may only re-aim the current scan point');
    assert.equal(sdk.calls[0].opts.transition,'instant');
    assert.equal(sdk.calls[0].opts.rotation.y,-90);
    assert.ok(Math.abs(sdk.calls[0].opts.rotation.x-18.43494882292201)<1e-8);
    assert.deepEqual(plain(c.__walk.state().endpoint),{x:10,y:0,z:-20});
  });
}

for (const target of [null, {x:13,y:20}, {x:13,y:Infinity,z:2}, {x:false,y:20,z:2}]) {
  test(`missing/invalid target keeps directions arrival behavior (${JSON.stringify(target)})`,async()=>{
    const c=walkController(), sdk=fakeSdk();
    c.wfShowArrivalCard=()=>{};
    await c.ThreeDNav.open(route(target));
    c.__walk.bind(sdk.sdk); c.__walk.arrive(); await flush();
    assert.equal(c.__walk.state().look,null);
    assert.equal(sdk.calls.length,0);
    assert.equal(sdk.rotations.length,0);
  });
}

test('a closed or replaced directions session cannot apply a pending arrival aim',async()=>{
  const c=walkController(), sdk=fakeSdk();
  c.wfShowArrivalCard=()=>{};
  await c.ThreeDNav.open(route({x:13,y:20,z:2.6}));
  c.__walk.bind(sdk.sdk);
  c.__walk.arrive(); c.__walk.invalidate(); await flush();
  assert.equal(sdk.calls.length,0);
});

function previewController() {
  const c=environment();
  const source=read('mp_preview.js').replace('  window.MpPreview = {', `
    window.__preview={bind:function(sdk,model){mpSdk=sdk;modelId=model||'test-model';},prepare:prepareRoute,face:faceAlongRoute};
    window.MpPreview = {`);
  vm.runInContext(source,c);
  return c;
}

test('POI preview keeps its nearest sweep while facing the saved target and elevation',async()=>{
  const c=previewController(),sdk=fakeSdk();
  sdk.sdk.Model.getData=async()=>({sweeps:[
    {id:'destination',position:{x:10,y:1.6,z:-20}},
    {id:'near-look-target',position:{x:13,y:2.6,z:-20}}]});
  c.__preview.bind(sdk.sdk);
  assert.equal(await c.MpPreview.focusAt({x:10,y:20,z:0},{x:13,y:20,z:2.6}),true);
  assert.equal(sdk.calls.length,1);
  assert.equal(sdk.calls[0].sid,'destination');
  assert.equal(sdk.calls[0].opts.rotation.y,-90);
  assert.ok(Math.abs(sdk.calls[0].opts.rotation.x-18.43494882292201)<1e-8);
});

test('POI preview with no target retains its default orientation',async()=>{
  const c=previewController(),sdk=fakeSdk();
  sdk.sdk.Model.getData=async()=>({sweeps:[{id:'destination',position:{x:10,y:1.6,z:-20}}]});
  c.__preview.bind(sdk.sdk);
  await c.MpPreview.focusAt({x:10,y:20,z:0},null);
  assert.equal(sdk.calls[0].opts.rotation,undefined);
});

test('the default POI-position look target retains a level preview',async()=>{
  const c=previewController(),sdk=fakeSdk();
  sdk.sdk.Model.getData=async()=>({sweeps:[{id:'destination',position:{x:10,y:1.6,z:-20}}]});
  c.__preview.bind(sdk.sdk);
  const poi={x:13,y:20,z:0};
  await c.MpPreview.focusAt(poi,poi);
  assert.deepEqual(sdk.calls[0].opts.rotation,{x:0,y:-90});
});

test('tour aims along intermediate legs, then respects the final target elevation',async()=>{
  const c=previewController(),sdk=fakeSdk();
  sdk.sdk.Sweep.data={origin:{position:{x:0,y:1.6,z:-20}},destination:{position:{x:10,y:1.6,z:-20}}};
  c.__preview.bind(sdk.sdk);
  c.__preview.prepare({sweep_ids:['origin','destination'],_destXYZ:{x:13,y:20,z:2.6},
    nodes:[{id:'origin',kind:'sweep',x:0,y:20,z:1.6},{id:'destination',kind:'sweep',x:10,y:20,z:1.6}]});
  await c.__preview.face(0);
  assert.deepEqual(sdk.rotations.at(-1),{x:0,y:-90});
  await c.__preview.face(1);
  assert.equal(sdk.rotations.at(-1).y,-90);
  assert.ok(Math.abs(sdk.rotations.at(-1).x-18.43494882292201)<1e-8);
});

test('a path-derived arrival target keeps the existing level tour view',async()=>{
  const c=previewController(),sdk=fakeSdk();
  sdk.sdk.Sweep.data={origin:{position:{x:0,y:1.6,z:-20}},destination:{position:{x:10,y:1.6,z:-20}}};
  c.__preview.bind(sdk.sdk);
  c.__preview.prepare({sweep_ids:['origin','destination'],
    nodes:[{id:'origin',kind:'sweep',x:0,y:20,z:1.6},{id:'destination',kind:'sweep',x:10,y:20,z:1.6},
      {id:'poi',kind:'poi',x:13,y:20,z:0}]});
  await c.__preview.face(1);
  assert.deepEqual(sdk.rotations.at(-1),{x:0,y:-90});
});

function savedView(overrides={}) {
  return {model_id:'test-model',sweep_id:'saved-sweep',
    camera_position:{x:50,y:4,z:6},camera_rotation:{pitch:-12.5,yaw:38},
    floor_id:'floor-two',captured_at:'2026-11-16T10:00:00Z',...overrides};
}
function savedPoi(overrides={}) {
  return {id:'room-one',name:'Room one',x:10,y:20,z:0,expected_x:13,expected_y:20,expected_z:2.6,
    nearest_node:'marker-node',lonlat:[-80,35],...overrides};
}
function savedResponse(viewpoint,status='saved',overrides={}) {
  return {ok:true,status:200,json:async()=>({building_slug:'uncc-main-campus',location_id:'room-one',
    model_id:'test-model',viewpoint,status,...overrides})};
}
function cameraScenario() {
  const c=previewController(),sdk=fakeSdk(),messages=[],requests=[];
  sdk.sdk.Model.getData=async()=>({sweeps:[
    {id:'marker-near',position:{x:10,y:1.6,z:-20}},
    {id:'saved-sweep',position:{x:50,y:4,z:6}},
    {id:'replacement-sweep',position:{x:-30,y:2,z:9}},
    {id:'disabled-sweep',position:{x:80,y:2,z:0},enabled:false},
  ]});
  c.wfUI={toast:message=>messages.push(message)};
  c.fetch=async(url,options)=>{requests.push({url,options});return savedResponse(savedView());};
  c.__preview.bind(sdk.sdk);
  return {c,sdk,messages,requests};
}

test('selecting a POI loads its fresh camera viewpoint and restores its exact scan and direction without moving its marker',async()=>{
  const {c,sdk,requests,messages}=cameraScenario();
  const poi=savedPoi({camera_viewpoint:savedView({sweep_id:'replacement-sweep'})}),before=plain(poi);
  let zooms=0; sdk.sdk.Camera.zoomTo=async()=>zooms++;
  assert.equal(await c.MpPreview.focusPoi(poi),true);
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/api/v1/public/buildings/uncc-main-campus/camera-viewpoints/room-one');
  assert.equal(requests[0].options.cache,'no-store');
  assert.equal(sdk.calls.length,1);
  assert.equal(sdk.calls[0].sid,'saved-sweep','saved camera scan takes precedence over a scan near the marker');
  assert.deepEqual(sdk.calls[0].opts.rotation,{x:-12.5,y:38});
  assert.equal(zooms,0,'a saved view does not apply the legacy preview zoom');
  assert.deepEqual(plain({...poi,camera_viewpoint:before.camera_viewpoint}),before);
  assert.deepEqual(messages,[]);
});

test('on iOS devices, focusPoi and focusAt use mobile-safe transition and skip zoomTo', async () => {
  const {c,sdk}=cameraScenario();
  sdk.sdk.Sweep.Transition = { INSTANT: 'instant', FLY: 'fly', FADEOUT: 'fade' };
  c.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone' };
  let zooms = 0;
  sdk.sdk.Camera.zoomTo = async () => zooms++;

  const poi = savedPoi();
  assert.equal(await c.MpPreview.focusPoi(poi), true);
  assert.equal(sdk.calls[0].opts.transition, 'fade', 'iOS must use FADEOUT transition to prevent GPU memory spike');
  assert.equal(sdk.calls[0].opts.transitionTime, 600);
  assert.equal(zooms, 0);

  await c.MpPreview.focusAt({x:10,y:20,z:0}, null);
  assert.equal(sdk.calls[1].opts.transition, 'fade', 'iOS focusAt must use FADEOUT transition');
  assert.equal(sdk.calls[1].opts.transitionTime, 600);
  assert.equal(zooms, 0, 'iOS must skip Camera.zoomTo');
});

test('selecting again uses a replacement saved on the server without reloading the model',async()=>{
  const {c,sdk,requests}=cameraScenario();
  const poi=savedPoi();
  await c.MpPreview.focusPoi(poi);
  c.fetch=async(url,options)=>{requests.push({url,options});return savedResponse(savedView({
    sweep_id:'replacement-sweep',camera_position:{x:-30,y:2,z:9},camera_rotation:{pitch:5,yaw:-122}}));};
  await c.MpPreview.focusPoi(poi);
  assert.equal(requests.length,2);
  assert.equal(sdk.calls[1].sid,'replacement-sweep');
  assert.deepEqual(sdk.calls[1].opts.rotation,{x:5,y:-122});
});

test('a registered location without marker coordinates can still open its saved scan and direction',async()=>{
  const {c,sdk}=cameraScenario();
  const poi=savedPoi({x:null,y:null,z:null,lonlat:undefined,nearest_node:null}),before=plain(poi);
  assert.equal(await c.MpPreview.focusPoi(poi),true);
  assert.deepEqual(sdk.calls.map(call=>call.sid),['saved-sweep']);
  assert.deepEqual(sdk.calls[0].opts.rotation,{x:-12.5,y:38});
  assert.deepEqual(plain({...poi,camera_viewpoint:undefined}),before,'restoring a camera must not invent a marker');
});

test('a location with neither marker nor saved view fails clearly without inventing a walkthrough position',async()=>{
  const {c,sdk,messages}=cameraScenario();
  c.fetch=async()=>savedResponse(null,'missing');
  assert.equal(await c.MpPreview.focusPoi(savedPoi({x:null,y:null,z:null})),false);
  assert.equal(sdk.calls.length,0);
  assert.deepEqual(messages,['No saved view is available for this location.']);
});

for(const missing of ['missing','legacy-404']) {
  test(`${missing} camera viewpoint uses the existing POI position and look-target fallback`,async()=>{
    const {c,sdk}=cameraScenario();
    c.fetch=async()=>missing==='missing'?savedResponse(null,'missing'):{ok:false,status:404};
    const poi=savedPoi({camera_viewpoint:savedView()});
    assert.equal(await c.MpPreview.focusPoi(poi),true);
    assert.equal(sdk.calls.length,1);
    assert.equal(sdk.calls[0].sid,'marker-near');
    assert.equal(sdk.calls[0].opts.rotation.y,-90);
    assert.ok(Math.abs(sdk.calls[0].opts.rotation.x-18.43494882292201)<1e-8);
    assert.equal(poi.camera_viewpoint,null,'a removed saved view cannot return from the startup snapshot');
  });
}

test('directions from-point retains its no-look-target fallback when there is no saved camera view',async()=>{
  const {c,sdk}=cameraScenario();
  c.fetch=async()=>savedResponse(null,'missing');
  await c.MpPreview.focusPoi(savedPoi(),{legacyFace:null});
  assert.equal(sdk.calls[0].sid,'marker-near');
  assert.equal(sdk.calls[0].opts.rotation,undefined);
});

test('a saved camera must match the selected building, location and active Matterport model',async()=>{
  const cases=[
    {envelope:{building_slug:'other-campus'}},
    {envelope:{location_id:'other-room'}},
    {envelope:{model_id:'different-model'}},
    {viewpoint:savedView({model_id:'different-model'})},
    {status:'incompatible',viewpoint:savedView()},
  ];
  for(const item of cases){
    const {c,sdk,messages}=cameraScenario();
    c.fetch=async()=>savedResponse('viewpoint'in item?item.viewpoint:savedView(),item.status||'saved',item.envelope);
    assert.equal(await c.MpPreview.focusPoi(savedPoi()),false);
    assert.equal(sdk.calls.length,0);
    assert.deepEqual(messages,['This saved view is no longer available. Please choose another location.']);
  }
});

test('history without an active-model view uses the existing marker focus and never restores historical coordinates',async()=>{
  const {c,sdk,messages}=cameraScenario();
  c.fetch=async()=>savedResponse(null,'incompatible');
  const poi=savedPoi({camera_viewpoint:savedView({model_id:'historical-model',sweep_id:'replacement-sweep'})});
  assert.equal(await c.MpPreview.focusPoi(poi),true);
  assert.equal(poi.camera_viewpoint,null);
  assert.deepEqual(sdk.calls.map(call=>call.sid),['marker-near']);
  assert.equal(sdk.calls[0].opts.rotation.y,-90);
  assert.deepEqual(messages,['This saved view is no longer available. Please choose another location.']);
});

test('invalid or disabled saved scans and invalid camera data cannot move the visitor',async()=>{
  const invalid=[
    savedView({sweep_id:'deleted-sweep'}),savedView({sweep_id:'disabled-sweep'}),
    savedView({sweep_id:'bad sweep'}),savedView({camera_position:{x:true,y:2,z:3}}),
    savedView({camera_position:{x:1,y:Infinity,z:3}}),savedView({camera_position:{x:100001,y:2,z:3}}),
    savedView({camera_rotation:{pitch:91,yaw:0}}),savedView({camera_rotation:{pitch:0,yaw:-181}}),
    savedView({camera_rotation:{pitch:'0',yaw:10}}),savedView({camera_rotation:{pitch:0,yaw:NaN}}),
  ];
  for(const viewpoint of invalid){
    const {c,sdk,messages}=cameraScenario();
    c.fetch=async()=>savedResponse(viewpoint);
    assert.equal(await c.MpPreview.focusPoi(savedPoi()),false);
    assert.equal(sdk.calls.length,0);
    assert.equal(messages.length,1);
  }
});

test('a failed saved camera move reports a safe message without exposing the SDK error',async()=>{
  const {c,sdk,messages}=cameraScenario();
  sdk.sdk.Sweep.moveTo=async()=>{throw new Error('private SDK debug payload');};
  assert.equal(await c.MpPreview.focusPoi(savedPoi()),false);
  assert.deepEqual(messages,['This saved view is no longer available. Please choose another location.']);
});

test('a network failure can retain a compatible loaded camera view or use the existing marker fallback',async()=>{
  for(const cache of [null,savedView()]){
    const {c,sdk,messages}=cameraScenario();
    c.fetch=async()=>{throw new Error('private network error');};
    assert.equal(await c.MpPreview.focusPoi(savedPoi({camera_viewpoint:cache})),true);
    assert.equal(sdk.calls[0].sid,cache?'saved-sweep':'marker-near');
    assert.ok(messages.every(message=>!message.includes('private')));
  }
});

test('a late viewpoint response cannot override a newer POI selection',async()=>{
  const {c,sdk}=cameraScenario();
  let resolveFirst;
  const pending=new Promise(resolve=>{resolveFirst=resolve;});
  c.fetch=async()=>pending;
  const first=c.MpPreview.focusPoi(savedPoi());
  c.fetch=async()=>savedResponse(savedView({sweep_id:'replacement-sweep'}),'saved',{location_id:'room-two'});
  assert.equal(await c.MpPreview.focusPoi(savedPoi({id:'room-two'})),true);
  resolveFirst(savedResponse(savedView()));
  assert.equal(await first,false);
  assert.deepEqual(sdk.calls.map(call=>call.sid),['replacement-sweep']);
});

test('a later explicit camera focus cancels a pending saved-view lookup',async()=>{
  const {c,sdk}=cameraScenario();
  let resolveLookup;
  c.fetch=()=>new Promise(resolve=>{resolveLookup=resolve;});
  const pending=c.MpPreview.focusPoi(savedPoi());
  await c.MpPreview.focusAt({x:10,y:20,z:0},null);
  resolveLookup(savedResponse(savedView()));
  assert.equal(await pending,false);
  assert.deepEqual(sdk.calls.map(call=>call.sid),['marker-near']);
});

test('a replaced SDK connection cannot receive a pending saved camera move',async()=>{
  const {c,sdk}=cameraScenario();
  let resolveData;
  sdk.sdk.Model.getData=()=>new Promise(resolve=>{resolveData=resolve;});
  const pending=c.MpPreview.focusPoi(savedPoi());
  await flush();
  const replacement=fakeSdk();c.__preview.bind(replacement.sdk,'another-model');
  resolveData({sweeps:[{id:'saved-sweep',position:{x:50,y:4,z:6}}]});
  assert.equal(await pending,false);
  assert.equal(sdk.calls.length,0);
  assert.equal(replacement.calls.length,0);
});

function selectionController() {
  const calls=[],sheets=[],elements=new Map(),S={};
  const context={S,window:{WF:{shopsByPoiId:{},cfg:{name:'Campus'}}},
    document:{body:{classList:{remove(){}}}},
    $:id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false});return elements.get(id);},
    wf:{currentFloor:()=> 'F1',floorLabel:()=> 'Floor one'},
    markPlace(){},cat:()=>({label:'Room'}),poiGalleryUrls:()=>[],sfBadge:()=>'',
    setSheet:(html,state)=>sheets.push({html,state}),esc:value=>String(value),t:key=>key,
    isMpMode:()=>true,share(){},
  };
  context.window.MpPreview={focusPoi:(...args)=>calls.push(args),
    focusAt(){throw new Error('new selection must use the model-bound saved-view resolver');}};
  context.WF=context.window.WF;
  vm.createContext(context);
  const source=read('ui.js'),start=source.indexOf('function selectPlace(');
  let select;
  for(let end=source.indexOf('}',start);end>=0;end=source.indexOf('}',end+1)){
    try{select=new vm.Script('('+source.slice(start,end+1)+')').runInContext(context);break;}catch(_){}
  }
  assert.ok(select,'load the actual POI-selection handler');
  return {select,calls,sheets,S};
}

test('visitor POI selection invokes saved-camera restoration without changing the selected marker',()=>{
  const {select,calls,S}=selectionController(),poi=savedPoi({floor:'F1'}),before=plain(poi);
  select(poi,{fly:true});
  assert.equal(S.place,poi);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],poi);
  assert.deepEqual(plain(poi),before);
});

test('refreshing selected-POI text or photos does not fetch a view or reset a freely moved camera',()=>{
  const {select,calls,sheets,S}=selectionController(),poi=savedPoi({floor:'F1'});
  select(poi,{fly:false,sheet:'placeMp'});
  assert.equal(S.place,poi);
  assert.equal(sheets.length,1,'metadata still refreshes the place sheet');
  assert.equal(calls.length,0,'a text/photo update must leave the visitor camera alone');
});

test('selecting a camera-only location still invokes the saved-view resolver',()=>{
  const {select,calls,S}=selectionController(),poi=savedPoi({floor:'F1',x:null,y:null,z:null,lonlat:undefined});
  select(poi,{fly:true});
  assert.equal(S.place,poi);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],poi);
});

function viewerFunction(name,context){
  const source=read('ui.js'),start=source.indexOf('function '+name+'(');
  for(let end=source.indexOf('}',start);end>=0;end=source.indexOf('}',end+1)){
    let script;try{script=new vm.Script('('+source.slice(start,end+1)+')');}catch(_){continue;}
    return script.runInNewContext(context);
  }
  throw new Error('Cannot find '+name);
}

test('camera-only selection never constructs a map marker or flies the map to invented coordinates',()=>{
  let clears=0;
  const context={S:{uiLayer:{removeAll(){clears++;}}},wf:new Proxy({},{get(){throw new Error('camera-only location has no map position');}})};
  const poi={id:'camera-only',lonlat:null};
  assert.doesNotThrow(()=>viewerFunction('markPlace',context)(poi));
  assert.equal(clears,1);
  assert.doesNotThrow(()=>viewerFunction('flyTo',context)(poi));
  assert.doesNotThrow(()=>viewerFunction('flyTo3D',context)(poi));
});

function runtimePoiMapping(file,variable,input){
  const declaration=variable==='pois'?'const pois = (navmePois || []).map(':'const conv = pois._navme.map(';
  const source=read(file),start=source.indexOf(declaration);
  assert.ok(start>=0);
  const context={navmePois:input,pois:{_navme:input},ordered:[{id:'F1'}],poiNamesById:{},
    floorFor:()=> 'F1',modelToLL:(x,y)=>[x,y],WFRouting:{snap:()=>null}};
  for(let end=source.indexOf('});',start);end>=0;end=source.indexOf('});',end+1)){
    let script;try{script=new vm.Script(source.slice(start,end+3)+'\n'+variable);}catch(_){continue;}
    return plain(script.runInNewContext(context));
  }
  throw new Error('Cannot find mapping in '+file);
}

for(const [file,variable] of [['mp_app.js','pois'],['app.js','conv']]){
  test(`${file} preserves captured SDK camera data and leaves absent markers absent`,()=>{
    const camera=savedView(),raw={id:'camera-only',name:'Camera-only room',floor:'F1',x:null,y:null,z:null,camera_viewpoint:camera};
    const [mapped]=runtimePoiMapping(file,variable,[raw]);
    assert.equal(mapped.id,raw.id);
    assert.equal(mapped.name,raw.name);
    assert.equal(mapped.x,null);assert.equal(mapped.y,null);assert.equal(mapped.z,null);
    assert.equal(mapped.sdk,null);
    assert.equal(mapped.lonlat,undefined);
    assert.deepEqual(mapped.camera_viewpoint,camera);
    const [marker]=runtimePoiMapping(file,variable,[{...raw,x:10.5,y:1.75,z:-20.25}]);
    assert.deepEqual([marker.x,marker.y,marker.z],[10.5,20.25,1.75]);
    assert.deepEqual(marker.camera_viewpoint,camera,'camera coordinates must not follow marker coordinate conversion');
  });
}
