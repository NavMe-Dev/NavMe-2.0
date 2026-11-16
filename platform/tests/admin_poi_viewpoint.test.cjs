const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'admin/poi_viewpoint.js'), 'utf8');
const placement = fs.readFileSync(path.join(root, 'admin/mp_place.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function runtime(options = {}) {
  const mounted = [], unmount = [], watchers = [], calls = [], frame = {};
  const rows = options.rows || Array.from({length: 47}, (_, index) => ({
    id: index + 1, source_id: 'source-' + index, name: `Room ${index + 1}`,
    position: {x: 10 + index, y: 2, z: 20}, target: {x: 0, y: 3, z: 30}, override: false, revision: 'default',
  }));
  const clone = value => JSON.parse(JSON.stringify(value));
  const context = {console, URLSearchParams, setTimeout, clearTimeout, Vue: {
    ref: value => ({value}), reactive: value => value,
    computed: getter => ({get value() { return getter(); }}),
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmount.push(callback),
    watch: (getter, callback) => watchers.push({getter, callback}), nextTick: () => Promise.resolve(),
  }};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(placement, context);
  vm.runInContext(source, context);
  const api = async (url, args) => {
    calls.push({url, args: args && clone(args)});
    if (options.api) return options.api(url, args);
    if (!args) return {enabled: true, writable: options.writable !== false, pois: clone(rows)};
    return {id: Number(url.match(/pois\/(\d+)/)[1]), target: args.json.target || {x: 0, y: 3, z: 30}, override: !!args.json.target, revision: args.json.target ? 'saved-revision' : 'default'};
  };
  const sdk = options.sdk || {Sweep: {getData: async () => ({}), moveTo: async () => {}}};
  const session = options.session || {ok: true, sdk, disconnect() {}, pointerModelXY: () => ({x: 4, y: -6, z: 5})};
  context.MpPlace.connect = options.connect || (async () => session);
  context.MpPlace.waitIframeLoad = options.waitIframeLoad || (async () => {});
  const component = context.WFPoiViewpoint.createComponent({api, fetchShowcaseUrl: async (slug, params) => {
    assert.equal(slug, 'uncc-main-campus'); assert.equal(params.sdk, 1);
    return 'https://my.matterport.com/show/?m=fixture&applicationKey=public-key';
  }});
  const props = {b: {slug: 'uncc-main-campus'}};
  const state = component.setup(props);
  state.twinFrame.value = frame;
  return {context, state, props, calls, rows, component,
    mount: () => Promise.all(mounted.map(callback => callback())),
    unmount: () => unmount.forEach(callback => callback()), watchers};
}

test('editor lists all published POIs independently of floor filters', async () => {
  const r = runtime(); await r.mount();
  assert.equal(r.state.rows.value.length, 47);
  assert.equal(r.state.filtered.value.length, 47);
  r.state.query.value = 'Room 47';
  assert.equal(r.state.filtered.value.length, 1);
  assert.equal(r.state.filtered.value[0].id, 47);
  assert.equal(r.calls[0].url, '/admin/buildings/uncc-main-campus/poi-viewpoints');
  assert.equal(r.state.selected.value.id, 1);
});

test('typed target permits zero and rejects empty, infinite or boolean coordinates', async () => {
  const r = runtime(); await r.mount();
  for (const invalid of ['', ' ', Infinity, NaN, true, undefined]) {
    r.state.draft.x = invalid;
    await r.state.save();
    assert.equal(r.calls.length, 1);
    assert.match(r.state.error.value, /all three coordinates/);
  }
  Object.assign(r.state.draft, {x: '0', y: '2.5', z: '-4'});
  await r.state.save();
  assert.deepEqual(r.calls[1].args, {method: 'PUT', json: {target: {x: 0, y: 2.5, z: -4}, revision: 'default'}});
  assert.equal(r.state.dirty.value, false);
  assert.equal(r.state.selected.value.override, true);
  assert.match(r.state.message.value, /saved/);
});

test('pointer selection converts model coordinates back to SDK Y-up without moving the POI', async () => {
  const r = runtime(); await r.mount();
  const before = JSON.stringify(r.state.selected.value.position);
  assert.equal(await r.state.openTwin(), true);
  r.state.capturePointer();
  assert.equal(r.state.draft.x, 4); assert.equal(r.state.draft.y, 5); assert.equal(r.state.draft.z, 6);
  assert.equal(JSON.stringify(r.state.selected.value.position), before);
  await r.state.save();
  assert.deepEqual(r.calls[1].args.json.target, {x: 4, y: 5, z: 6});
  assert.deepEqual(Object.keys(r.calls[1].args.json).sort(), ['revision', 'target']);
});

test('reset removes the local override and shows the effective Studio target returned by the server', async () => {
  const r = runtime(); await r.mount();
  Object.assign(r.state.draft, {x: 1, y: 4, z: 12});
  await r.state.save();
  await r.state.reset();
  assert.deepEqual(r.calls[2].args.json, {target: null, revision: 'saved-revision'});
  assert.equal(r.state.selected.value.override, false);
  assert.equal(r.state.draft.x, 0); assert.equal(r.state.draft.y, 3); assert.equal(r.state.draft.z, 30);
  assert.equal(r.state.dirty.value, false);
});

test('failed or conflicting saves keep edits and never report success', async () => {
  const r = runtime({api: async (url, args) => {
    if (args) throw new Error('This viewpoint changed. Reload POIs before saving.');
    return {enabled: true, writable: true, pois: [{id: 1, name: 'Room', target: {x: 0, y: 1, z: 2}, revision: 'old'}]};
  }});
  await r.mount(); r.state.draft.x = 12;
  await r.state.save();
  assert.equal(r.state.draft.x, 12);
  assert.equal(r.state.selected.value.revision, 'old');
  assert.match(r.state.error.value, /Reload POIs/);
  assert.equal(r.state.message.value, '');
  assert.equal(r.state.saving.value, false);
});

test('selection is frozen during a save and response updates the matching POI only', async () => {
  const pending = deferred();
  const r = runtime({api: async (url, args) => args ? pending.promise : {enabled: true, writable: true,
    pois: [{id: 1, name: 'A', target: null, revision: 'default'}, {id: 2, name: 'B', target: null, revision: 'default'}]}});
  await r.mount(); Object.assign(r.state.draft, {x: 1, y: 2, z: 3});
  const save = r.state.save();
  r.state.select(r.state.rows.value[1]);
  assert.equal(r.state.selected.value.id, 1);
  pending.resolve({id: 1, target: {x: 1, y: 2, z: 3}, revision: 'new', override: true});
  await save;
  assert.equal(r.state.rows.value[0].revision, 'new');
  assert.equal(r.state.rows.value[1].revision, 'default');
});

test('preview chooses the nearest POI sweep and faces the draft target without saving', async () => {
  const moves = [], look = [];
  const sdk = {Sweep: {
    getData: async () => ({far: {sid: 'far', position: {x: 40, y: 2, z: 20}}, near: {sid: 'near', position: {x: 11, y: 2, z: 20}}}),
    moveTo: async (...args) => moves.push(args), Transition: {INSTANT: 'instant'},
  }, Camera: {lookAt: async point => look.push(point)}};
  const r = runtime({sdk}); await r.mount();
  Object.assign(r.state.draft, {x: 11, y: 3, z: 10});
  await r.state.preview();
  assert.equal(moves.length, 1); assert.equal(moves[0][0], 'near');
  assert.ok(Math.abs(moves[0][1].rotation.y) < 0.000001);
  assert.ok(Math.abs(moves[0][1].rotation.x - Math.atan2(1, 10) * 180 / Math.PI) < 0.000001);
  assert.equal(look.length, 0, 'Inside preview must use supported sweep rotation rather than Camera.lookAt');
  assert.equal(r.calls.length, 1);
});

test('observable-only sweep SDK previews from cached collection and releases its subscription', async () => {
  const moves = []; let observer, cancellations = 0;
  const sdk = {Sweep: {data: {subscribe(value) {
    observer = value;
    observer.onCollectionUpdated(new Map([
      ['far', {id: 'far', position: {x: 40, y: 2, z: 20}}],
      ['near', {id: 'near', position: {x: 11, y: 2, z: 20}}],
    ]));
    return {cancel: () => cancellations++};
  }}, moveTo: async (...args) => moves.push(args)}};
  const r = runtime({sdk}); await r.mount();
  await r.state.openTwin();
  assert.ok(observer, 'subscribe as soon as the SDK session connects');
  await r.state.preview(); assert.equal(moves[0][0], 'near');
  observer.onRemoved('near');
  observer.onAdded('added', {uuid: 'added', position: {x: 10, y: 2, z: 20}});
  await r.state.preview(); assert.equal(moves[1][0], 'added');
  observer.onUpdated('added', {uuid: 'added', enabled: false, position: {x: 10, y: 2, z: 20}});
  await r.state.preview(); assert.equal(moves[2][0], 'far');
  r.state.closeTwin(); assert.equal(cancellations, 1);
});

test('Model.getData supplies and caches sweeps when the observable initial event was missed', async () => {
  const moves = []; let reads = 0, unsubscriptions = 0;
  const sdk = {Sweep: {data: {subscribe: () => () => unsubscriptions++}, moveTo: async (...args) => moves.push(args)},
    Model: {getData: async () => { reads++; return {sweeps: [{uuid: 'model-sweep', pose: {position: {x: 11, y: 2, z: 20}}}]}; }}};
  const r = runtime({sdk}); await r.mount();
  await r.state.preview(); await r.state.preview();
  assert.equal(moves.length, 2); assert.equal(moves[0][0], 'model-sweep');
  assert.equal(reads, 1);
  r.unmount(); assert.equal(unsubscriptions, 1);
});

test('actual MpPlace captures the one early sweep event before PLAYING and exposes it after readiness', async () => {
  const r = runtime();
  vm.runInContext(placement, r.context);
  let observer, subscriptions = 0, cancellations = 0, disconnected = 0;
  const sdk = {Sweep: {data: {subscribe(value) { subscriptions++; observer = value; return {cancel: () => cancellations++}; }}},
    App: {state: {getLatest() {
      assert.ok(observer, 'sweep subscription must precede readiness checks');
      observer.onCollectionUpdated(new Map([['early', {uuid: 'early', position: {x: 10, y: 2, z: 20}}]]));
      return {phase: 'appphase.playing'};
    }}}, disconnect: () => disconnected++};
  r.context.MP_SDK = {connect: async () => sdk};
  const session = await r.context.MpPlace.connect({iframe: {}, applicationKey: 'public-fixture-key'});
  assert.equal(session.ok, true);
  assert.equal(session.sweepData().early.uuid, 'early');
  const reader = r.context.WFPoiViewpoint.createSweepReader(session.sdk, session.sweepData);
  assert.equal((await reader.read()).early.position.x, 10);
  assert.equal(subscriptions, 1, 'consume the early snapshot without a second late subscription');
  reader.close(); session.disconnect(); session.disconnect();
  assert.equal(cancellations, 1);
  assert.equal(disconnected, 1);
});

test('actual MpPlace cancels the early sweep subscription when readiness fails', async () => {
  const r = runtime();
  vm.runInContext(placement, r.context);
  let cancellations = 0, disconnected = 0;
  const sdk = {Sweep: {data: {subscribe: () => ({cancel: () => cancellations++})}},
    App: {state: {getLatest: () => ({phase: 'appphase.error'})}}, disconnect: () => disconnected++};
  r.context.MP_SDK = {connect: async () => sdk};
  const session = await r.context.MpPlace.connect({iframe: {}, applicationKey: 'public-fixture-key'});
  assert.equal(session.ok, false);
  assert.equal(cancellations, 1); assert.equal(disconnected, 1);
});

test('preview rotation respects saved target height and bounds extreme up/down pitch', () => {
  const r = runtime(), rotate = r.context.WFPoiViewpoint.facingRotation;
  assert.equal(rotate({x: 0, y: 2, z: 0}, {x: 0, y: 1000, z: -1}).x, 28);
  assert.equal(rotate({x: 0, y: 2, z: 0}, {x: 0, y: -1000, z: -1}).x, -58);
  const normal = rotate({x: 0, y: 2, z: 0}, {x: -10, y: 4, z: 0});
  assert.equal(normal.y, 90);
  assert.ok(Math.abs(normal.x - Math.atan2(2, 10) * 180 / Math.PI) < 0.000001);
});

test('unmount disconnects an active SDK session', async () => {
  let disconnected = 0;
  const r = runtime({session: {ok: true, disconnect: () => disconnected++}});
  await r.mount(); await r.state.openTwin();
  r.unmount();
  assert.equal(disconnected, 1);
  assert.equal(r.state.connected.value, false);
});

test('a late SDK connection is disconnected after the editor has unmounted', async () => {
  const pending = deferred(); let disconnected = 0;
  const r = runtime({connect: () => pending.promise}); await r.mount();
  const opening = r.state.openTwin();
  await new Promise(resolve => setImmediate(resolve));
  r.unmount();
  pending.resolve({ok: true, disconnect: () => disconnected++});
  await opening;
  assert.equal(disconnected, 1);
  assert.equal(r.state.connected.value, false);
});

test('closing the twin while its iframe loads prevents a stale SDK connection', async () => {
  const waiting = deferred(); let connections = 0;
  const r = runtime({waitIframeLoad: () => waiting.promise, connect: async () => { connections++; return {ok: true}; }});
  await r.mount();
  const opening = r.state.openTwin();
  await new Promise(resolve => setImmediate(resolve));
  r.state.closeTwin();
  waiting.resolve();
  await opening;
  assert.equal(connections, 0);
  assert.equal(r.state.connected.value, false);
});

test('read-only configuration allows preview but cannot save', async () => {
  const r = runtime({writable: false}); await r.mount();
  Object.assign(r.state.draft, {x: 1, y: 2, z: 3});
  await r.state.save(); await r.state.reset();
  assert.equal(r.calls.length, 1);
});

test('the UNCC admin entry and versioned asset are wired into the actual page', () => {
  const admin = fs.readFileSync(path.join(root, 'admin/admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
  assert.match(admin, /b\.slug==='uncc-main-campus'[^\n]+Adjust POI viewpoints/);
  assert.match(admin, /tab==='viewpoints' && b\.slug==='uncc-main-campus'/);
  assert.match(admin, /app\.component\("poi-viewpoints", WFPoiViewpoint\.createComponent/);
  assert.ok(html.indexOf('poi_viewpoint.js?v=') < html.indexOf('admin.js?v='));
});
