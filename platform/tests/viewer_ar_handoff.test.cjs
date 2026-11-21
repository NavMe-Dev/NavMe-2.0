const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../viewer/ui.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'Expected existing AR handler in viewer UI');
  return source.slice(from, to);
}

function fixture(ref = 'published-experience') {
  const buttons = {p3d: {}, dViewAr: {}}, popups = [], messages = [];
  const poi = {id: 'room & 2', name: 'Cafétéria / GCU'};
  const context = {window: null, WF: {arExperienceRef: ref}, p: poi, S: {to: poi},
    $: id => buttons[id], isMpMode: () => true, t: key => key,
    toast: text => messages.push(text),
    open: (...args) => popups.push(args),
    toggle3D: () => { throw Error('External AR must not open the regular map viewer'); },
    flyTo3D: () => { throw Error('External AR must not move the regular map viewer'); }};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(section('  function slugifyPoiShareName(', '  function selectPlace('), context);
  vm.runInContext(section('    $("p3d").onclick =', '    // mp mode hides the ArcGIS'), context);
  vm.runInContext(section('    if ($("dViewAr")) $("dViewAr").onclick =', '    if ($("dTourMp"))'), context);
  return {context, buttons, popups, messages, poi};
}

test('place and route AR handoffs work without the optional legacy WebXR launcher', () => {
  const f = fixture();
  assert.equal(f.context.WFAR, undefined);
  f.buttons.p3d.onclick();
  f.buttons.dViewAr.onclick();
  assert.equal(f.popups.length, 2);
  for (const [address, target, features] of f.popups) {
    const url = new URL(address);
    assert.equal(url.origin, 'https://share.navme.space');
    assert.equal(url.pathname, '/cafeteria-gcu');
    assert.equal(url.searchParams.get('p'), f.poi.id);
    assert.equal(url.searchParams.get('x'), 'published-experience');
    assert.equal(target, '_blank');
    assert.equal(features, 'noopener');
  }
  assert.deepEqual(f.messages, []);
});

test('unpublished AR experiences report availability rather than opening a broken URL', () => {
  const f = fixture(null);
  f.buttons.p3d.onclick();
  f.buttons.dViewAr.onclick();
  assert.deepEqual(f.popups, []);
  assert.deepEqual(f.messages, ['viewer.arLocked', 'viewer.arLocked']);
});

test('route AR action requires an actual destination and preserves encoded experience references', () => {
  const f = fixture('experience & other=123');
  f.context.S.to = 'me';
  f.buttons.dViewAr.onclick();
  assert.deepEqual(f.popups, []);
  f.context.S.to = f.poi;
  f.buttons.dViewAr.onclick();
  const url = new URL(f.popups[0][0]);
  assert.equal(url.searchParams.get('x'), 'experience & other=123');
  assert.equal(url.searchParams.has('other'), false);
});
