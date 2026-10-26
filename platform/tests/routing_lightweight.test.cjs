const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('routing initializes without the optional walk grid in lightweight Matterport mode', () => {
  const graph = {addNode(){},addLink(){},getLink(){return null;}};
  const context = {window:{},createGraph:()=>graph,console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../viewer/routing.js'),'utf8'),context);
  assert.doesNotThrow(() => context.window.WFRouting.init({nodes:[],edges:[]},null,null));
  assert.equal(context.window.WFRouting.snap(0,0,'F1'),null);
});

test('navmesh guidance uses the reduced turn-angle thresholds', () => {
  const context = {window:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../viewer/wf_navmesh_route.js'),'utf8'),context);
  function turnAt(degrees) {
    const r = degrees * Math.PI / 180;
    const path = [
      {x:0,y:0,z:0},
      {x:0,y:0,z:-2},
      {x:2*Math.sin(r),y:0,z:-2-2*Math.cos(r)},
    ];
    return context.window.WFNavmeshRoute.guidance(path, {}).find(step => step.type === 'turn');
  }
  assert.equal(turnAt(19), undefined);
  assert.equal(turnAt(20).dir, 'slight-right');
  assert.equal(turnAt(50).dir, 'right');
  assert.equal(turnAt(110).dir, 'sharp-right');
  assert.equal(turnAt(150).dir, 'u-turn');
});
