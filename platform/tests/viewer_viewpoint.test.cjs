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
    window.__preview={bind:function(sdk){mpSdk=sdk;},prepare:prepareRoute,face:faceAlongRoute};
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
