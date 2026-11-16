const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../viewer', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function actualFunction(file, name) {
  const source = read(file), start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `${name} exists in ${file}`);
  for (let end = source.indexOf('}', start); end >= 0; end = source.indexOf('}', end + 1)) {
    const candidate = source.slice(start, end + 1);
    try { new vm.Script('(' + candidate + ')'); return candidate; } catch (_) {}
  }
  throw Error(`Cannot extract ${file}:${name}`);
}
function loadFunctions(file, names, context) {
  vm.createContext(context);
  vm.runInContext(names.map(name => actualFunction(file, name)).join('\n'), context);
  return context;
}
function formatter(config = {building:{slug:'uncc-main-campus'}}) {
  return loadFunctions('mp_preview.js', ['usesFeet', 'fmtMeters'], {window:{WF:config}});
}

test('Matterport distance formatter converts UNCC metres to feet, including small and long distances', () => {
  const c = formatter();
  for (const [metres, wanted] of [[91,'299 ft'],[0,'0 ft'],[0.1,'<1 ft'],[0.3048,'1 ft'],[3.048,'10 ft'],[1000,'3281 ft'],[-1,'0 ft']]) {
    assert.equal(c.fmtMeters(metres), wanted);
  }
  for (const invalid of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(c.fmtMeters(invalid),'—');
});

test('Matterport feet policy works for standalone config and retains other campuses metric display', () => {
  assert.equal(formatter({cfg:{slug:'uncc-main-campus'}}).fmtMeters(91),'299 ft');
  const c = formatter({building:{slug:'gcu'}});
  assert.equal(c.fmtMeters(91),'91 m');assert.equal(c.fmtMeters(1000),'1.0 km');assert.equal(c.fmtMeters(0.1),'<1 m');
  assert.equal(formatter({}).fmtMeters(91),'91 m');
});

function element() {
  return {textContent:'',hidden:true,attributes:{},classList:{add(){},remove(){}},
    setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}};
}

test('actual Matterport dock shows total route feet while the HUD retains remaining distance and next leg', () => {
  const ids = Object.fromEntries(['mpDistRem','mpDistLeg','mpDistLegRow','mpDockEta','mpDockDist','mpDockLbl'].map(id=>[id,element()]));
  const hud=element(), metres={remaining:91,leg:3.048};
  const c=loadFunctions('mp_preview.js',['usesFeet','fmtMeters','updateDistHud'],{
    window:{WF:{building:{slug:'uncc-main-campus'}}},$:id=>ids[id],ensureDistHudMount:()=>hud,
    playing:true,stopped:false,sweepIds:['a','b'],stepI:0,destName:'Library',
    routeTotalM:424*0.3048,previewLabel:(_key,fallback)=>fallback,
    remainingDistM:()=>metres.remaining,nextLegDistM:()=>metres.leg,updateTravelTime(){},hideDistHud(){throw Error('active route should remain visible');},
  });
  c.updateDistHud(0);
  assert.equal(ids.mpDockDist.textContent,'424 ft');assert.equal(ids.mpDistRem.textContent,'299 ft');assert.equal(ids.mpDistLeg.textContent,'10 ft');
  assert.equal(ids.mpDockLbl.textContent,'Distance');assert.equal(ids.mpDockEta.hidden,false);
  assert.deepEqual(metres,{remaining:91,leg:3.048});
});

function walkthrough(config) {
  const ids=Object.fromEntries(['n3dDock','n3dDistV','n3dDistU','n3dDistLbl'].map(id=>[id,element()]));
  let remaining=91;
  const c=loadFunctions('threed_nav.js',['usesFeet','updateDistDisplay'],{
    window:{WF:config},$:id=>ids[id],destName:'Library',remainingMetres:()=>remaining,updateTravelTime(){},
  });
  return {c,ids,set:value=>{remaining=value;}};
}

test('actual walkthrough dock uses feet for building and standalone config contexts', () => {
  for (const config of [{building:{slug:'uncc-main-campus'}},{cfg:{slug:'uncc-main-campus'}}]) {
    const {c,ids,set}=walkthrough(config);
    for (const [metres,wanted] of [[91,'299'],[0,'0'],[0.1,'<1'],[1000,'3281']]) {
      set(metres);c.updateDistDisplay();assert.equal(ids.n3dDistV.textContent,wanted);assert.equal(ids.n3dDistU.textContent,'ft');
    }
    assert.equal(ids.n3dDock.hidden,false);assert.equal(ids.n3dDistLbl.textContent,'To Library');
  }
});

test('walkthrough zero and unknown values reset a previous kilometre unit after campus changes', () => {
  const {c,ids,set}=walkthrough({building:{slug:'gcu'}});
  set(1000);c.updateDistDisplay();assert.equal(ids.n3dDistV.textContent,'1.00');assert.equal(ids.n3dDistU.textContent,'km');
  set(0);c.updateDistDisplay();assert.equal(ids.n3dDistV.textContent,'0');assert.equal(ids.n3dDistU.textContent,'m');
  c.window.WF={cfg:{slug:'uncc-main-campus'}};
  for (const value of [null,undefined,NaN,Infinity]) {
    ids.n3dDistU.textContent='km';set(value);c.updateDistDisplay();assert.equal(ids.n3dDistV.textContent,'—');assert.equal(ids.n3dDistU.textContent,'ft');
  }
  set(0);c.updateDistDisplay();assert.equal(ids.n3dDistV.textContent,'0');assert.equal(ids.n3dDistU.textContent,'ft');
  c.window.WF={building:{slug:'gcu'}};set(null);c.updateDistDisplay();assert.equal(ids.n3dDistU.textContent,'m');
});

test('navmesh walking guidance changes display units while preserving metre distances and XYZ', () => {
  const points=[{x:0,y:0,z:0},{x:0,y:0,z:-91}], before=plain(points);
  function guidance(config) {
    const c={window:{WF:config}};vm.runInNewContext(read('wf_navmesh_route.js'),c);
    return plain(c.window.WFNavmeshRoute.guidance(points,{}));
  }
  const metric=guidance({building:{slug:'gcu'}}),feet=guidance({building:{slug:'uncc-main-campus'}}),standalone=guidance({cfg:{slug:'uncc-main-campus'}});
  assert.equal(metric.find(step=>step.type==='walk').text,'Walk ahead 91 m');
  assert.equal(feet.find(step=>step.type==='walk').text,'Walk ahead 299 ft');assert.deepEqual(standalone,feet);
  const withoutText=steps=>steps.map(({text,...rest})=>rest);
  assert.deepEqual(withoutText(feet),withoutText(metric));assert.equal(feet.find(step=>step.type==='walk').dist_m,91);assert.deepEqual(points,before);
});
