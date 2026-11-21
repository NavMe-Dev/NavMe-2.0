const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_app.js'), 'utf8');
async function fixture({floors = [{id: 'F1', elevation: 0, ordinal: 0}], bands = null} = {}) {
  const routes = [], failures = [];
  const publication = {building_slug: 'gcu', pois: [{id: 9, name: 'Upper room', x: 3, y: 8, z: 4}],
    categories: [], stair_chains: [], georef: {model_to_epsg3857_affine: [[1, 0, 0], [0, 1, 0]]}};
  const context = {window: null, console: {warn() {}, error: (...args) => failures.push(args)},
    document: {getElementById: () => null}, dispatchEvent() {}, Event: class {},
    WF: {configReady: Promise.resolve(), ready: Promise.resolve(), viewerData: Promise.resolve(publication),
      cfg: {default_floor: 'F1', floors}, building: {slug: 'gcu'}},
    WFNav: {navmeshReady: () => true, routeNavmesh(from, to) {
      routes.push({from, to}); return {path: [from, to], total_m: 10, instructions: []};
    }},
    WFNavmeshRoute: {deriveLevels: () => bands},
    fetch: async url => ({ok: true, json: async () => url.endsWith('/shops') ? [] : {}})};
  context.window = context; vm.runInNewContext(source, context);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(failures, []); assert.ok(context.wf?.ready);
  return {api: context.wf, routes};
}

test('a picked upper height reaches the route even when the only configured floor is zero', async () => {
  const f = await fixture(); const ll = f.api.modelToLL(1, 2);
  f.api.localizeAt(...ll, {modelHeight: 8});
  f.api.route('__loc', '9');
  assert.equal(f.routes[0].from.y, 8);
  assert.ok(Math.abs(f.routes[0].from.x - 1) < 1e-8);
  assert.ok(Math.abs(f.routes[0].from.z + 2) < 1e-8);
});

test('localization callbacks and routes see the preserved height immediately', async () => {
  const f = await fixture(); let observed;
  f.api.onLocalized = loc => { observed = loc.modelHeight; f.api.route('__loc', '9'); };
  f.api.localizeAt(...f.api.modelToLL(1, 2), {modelHeight: 8});
  assert.equal(observed, 8); assert.equal(f.routes[0].from.y, 8);
});

test('legacy locations prefer derived level elevation before the configured floor elevation', async () => {
  const f = await fixture({bands: [{lo: 7, hi: 9, mid: 8}]});
  f.api.localizeAt(...f.api.modelToLL(1, 2)); f.api.route('__loc', '9');
  assert.equal(f.api.lastLoc.modelHeight, undefined); assert.equal(f.routes[0].from.y, 8);
});

test('legacy locations retain the configured floor elevation when no derived level exists', async () => {
  const f = await fixture({floors: [{id: 'F1', elevation: 3, ordinal: 0}]});
  f.api.localizeAt(...f.api.modelToLL(1, 2)); f.api.route('__loc', '9');
  assert.equal(f.routes[0].from.y, 3);
});

for (const height of [undefined, null, '', '8', NaN, Infinity]) {
  test(`invalid localization height ${String(height)} falls back without poisoning the route`, async () => {
    const f = await fixture({floors: [{id: 'F1', elevation: 3, ordinal: 0}]});
    f.api.localizeAt(...f.api.modelToLL(1, 2), {modelHeight: height}); f.api.route('__loc', '9');
    assert.equal(f.api.lastLoc.modelHeight, undefined); assert.equal(f.routes[0].from.y, 3);
  });
}

test('explicit zero height overrides a nonzero floor and a later legacy fix clears the previous height', async () => {
  const f = await fixture({floors: [{id: 'F1', elevation: 3, ordinal: 0}]});
  f.api.localizeAt(...f.api.modelToLL(1, 2), {modelHeight: 0}); f.api.route('__loc', '9');
  assert.equal(f.routes[0].from.y, 0);
  f.api.localizeAt(...f.api.modelToLL(1, 2)); f.api.route('__loc', '9');
  assert.equal(f.api.lastLoc.modelHeight, undefined); assert.equal(f.routes[1].from.y, 3);
});
