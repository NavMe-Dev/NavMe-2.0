// Run with node --test platform/tests/viewer_camera.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = fs.readFileSync(path.join(__dirname, '../viewer/ui.js'), 'utf8');
const start = ui.indexOf('  function fitLonLat(');
const end = ui.indexOf('  // ---------------- directions', start);
assert.ok(start >= 0 && end > start);
function fit(context) {
  vm.createContext(context);
  vm.runInContext(ui.slice(start, end), context);
  return context.fitLonLat;
}

test('Matterport category/floor fitting never calls unavailable ArcGIS camera APIs', () => {
  const context = { isMpMode: () => true, wf: new Proxy({}, {
    get() { throw new Error('ArcGIS is unavailable in the Matterport runtime'); }
  }) };
  assert.doesNotThrow(() => fit(context)([[80.1, 13.2], [80.2, 13.3]], 1.8));
});

for (const is3D of [false, true]) {
  test(`regular ${is3D ? '3D' : '2D'} map retains extent fitting`, () => {
    const calls = [];
    const extent = { marker: 'expanded extent' };
    const context = { isMpMode: () => false, wf: {
      esri: { Extent: class {
        constructor(bounds) { assert.equal(bounds.spatialReference.wkid, 4326); }
        expand(factor) { assert.equal(factor, 1.8); return extent; }
      } },
      is3D: () => is3D,
      view: () => ({ goTo(target, options) { calls.push({ target, options }); return Promise.resolve(); } })
    } };
    fit(context)([[80.1, 13.2], [80.2, 13.3]], 1.8, true);
    assert.equal(calls.length, 1);
    assert.equal(is3D ? calls[0].target.target : calls[0].target, extent);
    assert.equal(calls[0].options.duration, is3D ? 0 : 900);
    if (!is3D) assert.equal(calls[0].options.animate, false);
  });
}
