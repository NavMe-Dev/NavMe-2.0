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
