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
  const mounted = [], unmount = [], watchers = [], calls = [];
  const frame = options.frame || {clientWidth: 1000, clientHeight: 500};
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

test('current-view capture uses the center surface rather than the stale floor pointer, then previews before saving', async () => {
  const position = {x: 179.17958068847656, y: 1.454188346862793, z: -2.250899076461792};
  const door = {x: 179.095, y: 1.8, z: -3.134};
  const moves = [], rays = []; let pointerReads = 0;
  const sdk = {
    Renderer: {getWorldPositionData: async point => { rays.push(point); return {position: door}; }},
    Sweep: {getData: async () => ({near: {sid: 'near', position}}),
      moveTo: async (...args) => moves.push(args), Transition: {INSTANT: 'instant'}},
  };
  const session = {ok: true, sdk, disconnect() {}, pointerModelXY() {
    pointerReads++; return {x: 179.825, y: 2.442, z: 0.361};
  }};
  const r = runtime({session, rows: [{id: 454, name: '110 Starbucks',
    position: {x: 179.8464, y: 0.4, z: -2.7561},
    target: {x: 179.825, y: 0.361, z: -2.442}, override: true, revision: 'saved'}]});
  await r.mount(); await r.state.openTwin();
  const originalPoi = JSON.stringify(r.state.selected.value);
  await r.state.captureCurrentView();

  assert.equal(pointerReads, 0, 'moving the pointer to the capture button must not choose a new floor point');
  assert.deepEqual(JSON.parse(JSON.stringify(rays)), [{x: 500, y: 250}], 'raycast uses the center of the iframe in local pixels');
  assert.deepEqual(JSON.parse(JSON.stringify(r.state.draft)), door);
  assert.equal(moves.length, 1, 'capturing the view must demonstrate the result in the twin');
  assert.equal(moves[0][0], 'near');
  const wanted = r.context.WFPoiViewpoint.facingRotation(position, door);
  assert.ok(Math.abs(moves[0][1].rotation.x - wanted.x) < 1e-8);
  assert.ok(Math.abs(moves[0][1].rotation.y - wanted.y) < 1e-8);
  assert.ok(moves[0][1].rotation.x > 0, 'the door point must face above the camera rather than down at the floor');
  assert.equal(r.state.dirty.value, true);
  assert.equal(r.state.error.value, '');
  assert.equal(r.calls.length, 1, 'capture and preview must not save to the server');
  assert.equal(JSON.stringify(r.state.selected.value), originalPoi, 'capturing cannot move or mutate the POI');

  await r.state.save();
  assert.deepEqual(r.calls[1].args.json.target, door);
  assert.equal(r.calls[1].args.json.revision, 'saved');
});

test('current-view capture rejects empty or invalid center hits without changing the draft or claiming success', async () => {
  const cases = [
    undefined, {position: null}, {position: {x: 10, y: 2}},
    {position: {x: 10, y: NaN, z: 20}}, {position: {x: 10, y: 2, z: Infinity}},
  ];
  for (const hit of cases) {
    const moves = [];
    const r = runtime({sdk: {
      Renderer: {getWorldPositionData: async () => hit},
      Sweep: {getData: async () => ({near: {sid: 'near', position: {x: 10, y: 2, z: 20}}}),
        moveTo: async (...args) => moves.push(args)},
    }});
    await r.mount(); await r.state.openTwin();
    const before = JSON.stringify(r.state.draft);
    await r.state.captureCurrentView();
    assert.equal(JSON.stringify(r.state.draft), before);
    assert.match(r.state.error.value, /surface|center|view|point|door/i);
    assert.equal(r.state.message.value, '');
    assert.equal(moves.length, 0);
    assert.equal(r.calls.length, 1);
    assert.equal(r.state.twinBusy.value, false);
  }
});

test('current-view capture reports renderer failure without changing the draft or claiming success', async () => {
  const r = runtime({sdk: {Renderer: {getWorldPositionData: async () => { throw new Error('Renderer is unavailable'); }}}});
  await r.mount(); await r.state.openTwin();
  const before = JSON.stringify(r.state.draft);
  await r.state.captureCurrentView();
  assert.equal(JSON.stringify(r.state.draft), before);
  assert.match(r.state.error.value, /renderer.*unavailable/i);
  assert.equal(r.state.message.value, '');
  assert.equal(r.state.twinBusy.value, false);
});

test('a captured point is retained for retry but never reported as previewed when camera movement fails', async () => {
  const target = {x: 8, y: 3, z: 20};
  const r = runtime({sdk: {
    Renderer: {getWorldPositionData: async () => ({position: target})},
    Sweep: {getData: async () => ({near: {sid: 'near', position: {x: 10, y: 2, z: 20}}}),
      moveTo: async () => { throw new Error('Camera movement failed'); }},
  }});
  await r.mount(); await r.state.openTwin();
  await r.state.captureCurrentView();
  assert.deepEqual(JSON.parse(JSON.stringify(r.state.draft)), target);
  assert.match(r.state.error.value, /camera movement failed/i);
  assert.equal(r.state.message.value, '');
  assert.equal(r.state.dirty.value, true);
  assert.equal(r.state.twinBusy.value, false);
  assert.equal(r.calls.length, 1);
});

test('current-view capture fails clearly when the SDK cannot raycast or the twin has no size', async () => {
  for (const options of [
    {sdk: {}},
    {frame: {clientWidth: 0, clientHeight: 0}, sdk: {Renderer: {getWorldPositionData: async () => { throw new Error('must not raycast hidden twin'); }}}},
  ]) {
    const r = runtime(options); await r.mount(); await r.state.openTwin();
    const before = JSON.stringify(r.state.draft);
    await r.state.captureCurrentView();
    assert.equal(JSON.stringify(r.state.draft), before);
    assert.ok(r.state.error.value, 'unavailable capture must explain how to recover');
    assert.doesNotMatch(r.state.error.value, /must not raycast/);
    assert.equal(r.state.message.value, '');
    assert.equal(r.state.twinBusy.value, false);
    assert.equal(r.calls.length, 1);
  }
});

test('current-view capture prevents POI switching and duplicate capture while reading the center point', async () => {
  const hit = deferred(); let reads = 0;
  const sdk = {
    Renderer: {getWorldPositionData: () => { reads++; return hit.promise; }},
    Sweep: {getData: async () => ({near: {sid: 'near', position: {x: 10, y: 2, z: 20}}}),
      moveTo: async () => {}, Transition: {INSTANT: 'instant'}},
  };
  const r = runtime({sdk}); await r.mount(); await r.state.openTwin();
  const capturedId = r.state.selected.value.id;
  const capture = r.state.captureCurrentView();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.state.twinBusy.value, true);
  r.state.select(r.state.rows.value[1]);
  assert.equal(r.state.selected.value.id, capturedId);
  await r.state.captureCurrentView();
  assert.equal(reads, 1);
  hit.resolve({position: {x: 8, y: 3, z: 20}});
  await capture;
  assert.equal(r.state.twinBusy.value, false);
  assert.equal(r.calls.length, 1);
});

for (const action of ['close', 'unmount']) {
  test(`a pending current-view capture cannot change the draft or move the camera after ${action}`, async () => {
    const hit = deferred(), moves = [];
    const sdk = {
      Renderer: {getWorldPositionData: () => hit.promise},
      Sweep: {getData: async () => ({near: {sid: 'near', position: {x: 10, y: 2, z: 20}}}),
        moveTo: async (...args) => moves.push(args)},
    };
    const r = runtime({sdk}); await r.mount(); await r.state.openTwin();
    const before = JSON.stringify(r.state.draft);
    const capture = r.state.captureCurrentView();
    await new Promise(resolve => setImmediate(resolve));
    if (action === 'close') r.state.closeTwin(); else r.unmount();
    hit.resolve({position: {x: 8, y: 3, z: 20}});
    await capture;
    assert.equal(JSON.stringify(r.state.draft), before);
    assert.equal(moves.length, 0);
    assert.equal(r.state.message.value, '');
    assert.equal(r.state.twinBusy.value, false);
    assert.equal(r.calls.length, 1);
  });
}

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

test('save feedback is brought into view even when the server rejects the write', async () => {
  const scrolls = [];
  const r = runtime({api: async (url, args) => {
    if (args) throw new Error('Could not save the viewpoint. Please retry.');
    return {enabled: true, writable: true, pois: [{id: 454, name: '110 Starbucks', target: null, revision: 'default'}]};
  }});
  await r.mount();
  r.state.feedback.value = {scrollIntoView: options => scrolls.push(options)};
  Object.assign(r.state.draft, {x: 183.169, y: 0.352, z: -2.872});
  await r.state.save();
  assert.match(r.state.error.value, /Could not save/);
  assert.equal(r.state.message.value, '');
  assert.equal(scrolls.length, 1); assert.equal(scrolls[0].block, 'nearest');
  assert.equal(r.state.draft.x, 183.169);
});

test('save response must match the requested POI and target before confirming success', async () => {
  const r = runtime({api: async (url, args) => args ? {id: 999, target: args.json.target, override: true, revision: 'wrong-poi'}
    : {enabled: true, writable: true, pois: [{id: 454, name: '110 Starbucks', target: null, revision: 'default'}]}});
  await r.mount(); Object.assign(r.state.draft, {x: 183.169, y: 0.352, z: -2.872});
  await r.state.save();
  assert.match(r.state.error.value, /Could not verify/);
  assert.equal(r.state.message.value, ''); assert.equal(r.state.selected.value.revision, 'default');
});

test('saved target survives Reload POIs and the next write uses the stored revision', async () => {
  let stored = {id: 454, name: '110 Starbucks', target: null, override: false, revision: 'default'};
  const r = runtime({api: async (url, args) => {
    if (!args) return {enabled: true, writable: true, pois: [JSON.parse(JSON.stringify(stored))]};
    assert.equal(args.json.revision, stored.revision);
    stored = {...stored, target: args.json.target, override: !!args.json.target,
      revision: '11111111-1111-4111-8111-111111111111'};
    return {...stored};
  }});
  await r.mount(); Object.assign(r.state.draft, {x: 183.169, y: 0.352, z: -2.872});
  await r.state.save(); await r.state.load();
  assert.equal(r.state.selected.value.override, true);
  assert.equal(r.state.draft.x, 183.169); assert.equal(r.state.draft.y, 0.352); assert.equal(r.state.draft.z, -2.872);
  assert.equal(r.state.dirty.value, false);
  r.state.draft.x = 183.171; await r.state.save();
  assert.equal(r.calls[3].args.json.revision, '11111111-1111-4111-8111-111111111111');
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

test('the camera-viewpoint entry is available for all building models and the selected POI', () => {
  const admin = fs.readFileSync(path.join(root, 'admin/admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
  assert.match(admin, /b\.matterport_model_id[^\n]+Set location viewpoints/);
  assert.match(admin, /<poi-viewpoints v-if="tab==='viewpoints'"/);
  assert.match(admin, /app\.component\("poi-viewpoints", WFPoiViewpoint\.createCameraComponent/);
  assert.match(admin, /viewpoints\?poi='\+sel\.id\+'&setup=1'/);
  assert.ok(html.indexOf('poi_viewpoint.js?v=') < html.indexOf('admin.js?v='));
});

function cameraRuntime(options = {}) {
  const mounted = [], unmount = [], watchers = [], calls = [], moves = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const model = options.model || 'model-A', slug = options.slug || 'any-registered-campus';
  const stored = clone(options.rows || [
    {id:101,name:'Room A',position:{x:500,y:0,z:400},viewpoint:null,revision:'default',status:'none'},
    {id:202,name:'Room B',position:{x:600,y:0,z:400},viewpoint:null,revision:'default',status:'none'},
  ]);
  let revision = 0;
  const defaultApi = async (url,args) => {
    if (!args) return {enabled:true,writable:options.writable !== false,model_id:model,pois:clone(stored)};
    assert.equal(args.method,'PUT');
    assert.equal(args.json.model_id,model);
    const id = Number(url.match(/pois\/(\d+)\/camera-viewpoint$/)[1]);
    const poi = stored.find(p=>p.id===id);
    assert.equal(args.json.revision,poi.revision);
    revision++;
    Object.assign(poi,{viewpoint:clone(args.json.viewpoint),status:args.json.viewpoint?'saved':'none',revision:`11111111-1111-4111-8111-${String(revision).padStart(12,'0')}`});
    return {id,model_id:model,viewpoint:clone(poi.viewpoint),revision:poi.revision,status:poi.status};
  };
  const api = async (url,args) => {calls.push({url,args:args&&clone(args)});return options.api ? options.api(url,args,defaultApi):defaultApi(url,args);};
  const sdkState = {pose:options.pose || {position:{x:10,y:2,z:20},rotation:{x:12,y:135},sweep:'scan-A',mode:'mode.inside'}};
  const catalog = options.catalog || {
    'scan-A':{sid:'scan-A',position:{x:10,y:2,z:20},floorInfo:{id:'floor-A'}},
    'scan-B':{sid:'scan-B',position:{x:20,y:5,z:30},floorInfo:{id:'floor-B'}},
  };
  const sdk = options.sdk || {
    Camera:{getPose:async()=>clone(sdkState.pose)},
    Model:{getData:async()=>({sweeps:Object.values(catalog)})},
    Sweep:{Transition:{INSTANT:'instant'},moveTo:async(id,args)=>{
      moves.push({id,args:clone(args)});sdkState.pose={position:clone(catalog[id].position),rotation:clone(args.rotation),sweep:id,mode:'mode.inside'};
    }},
    Mode:{Mode:{INSIDE:'mode.inside'}},
  };
  let disconnects = 0;
  const session = {ok:true,sdk,sweepData:()=>catalog,currentSweep:()=>({...catalog[sdkState.pose.sweep]}),disconnect:()=>disconnects++};
  const context = {console,URL,URLSearchParams,setTimeout,clearTimeout,location:{hash:options.hash || `#/b/${slug}/viewpoints`,href:'http://localhost:8780/admin/'},Vue:{
    ref:value=>({value}),computed:getter=>({get value(){return getter();}}),
    onMounted:callback=>mounted.push(callback),onBeforeUnmount:callback=>unmount.push(callback),watch:(getter,callback)=>watchers.push({getter,callback}),nextTick:()=>Promise.resolve(),
  }};
  context.window=context;vm.createContext(context);vm.runInContext(placement,context);vm.runInContext(source,context);
  context.MpPlace.connect=options.connect || (async()=>session);context.MpPlace.waitIframeLoad=async()=>{};
  const component=context.WFPoiViewpoint.createCameraComponent({api,viewerUrl:options.viewerUrl,fetchShowcaseUrl:async()=>`https://my.matterport.com/show/?m=${options.urlModel || model}&applicationKey=public-fixture-key`});
  const props={b:{slug,matterport_model_id:model,...options.building}};
  const state=component.setup(props);state.twinFrame.value={clientWidth:1000,clientHeight:500};
  return {state,context,component,props,calls,moves,sdk,sdkState,session,stored,catalog,watchers,
    mount:()=>Promise.all(mounted.map(callback=>callback())),unmount:()=>unmount.forEach(callback=>callback()),disconnects:()=>disconnects};
}

test('capture stores the actual enabled sweep and camera rotation for any registered location', async()=>{
  const r=cameraRuntime();await r.mount();
  const before=JSON.stringify(r.stored[0].position),other=JSON.stringify(r.stored[1]);
  assert.equal(r.calls[0].url,'/admin/buildings/any-registered-campus/camera-viewpoints');
  await r.state.beginSetup();assert.equal(r.state.setupMode.value,true);
  r.sdkState.pose.rotation={x:17.5,y:315};
  await r.state.captureCurrentViewpoint();
  const write=r.calls.find(call=>call.args);
  assert.equal(write.url,'/admin/buildings/any-registered-campus/pois/101/camera-viewpoint');
  assert.equal(write.args.json.model_id,'model-A');
  assert.deepEqual(write.args.json.viewpoint.camera_position,{x:10,y:2,z:20});
  assert.deepEqual(write.args.json.viewpoint.camera_rotation,{pitch:17.5,yaw:-45});
  assert.equal(write.args.json.viewpoint.sweep_id,'scan-A');
  assert.equal(write.args.json.viewpoint.floor_id,'floor-A');
  assert.ok(Number.isFinite(Date.parse(write.args.json.viewpoint.captured_at)));
  assert.equal(JSON.stringify(r.stored[0].position),before);
  assert.equal(JSON.stringify(r.stored[1]),other);
  assert.equal(r.state.setupMode.value,false);assert.equal(r.state.error.value,'');
  assert.match(r.state.message.value,/Viewpoint saved/);
  assert.equal(r.calls.filter(call=>!call.args).length,2,'confirm persistence with a fresh read');
});

test('saved views survive reload, restore their exact sweep, and can be replaced without touching another POI',async()=>{
  const r=cameraRuntime();await r.mount();await r.state.beginSetup();await r.state.captureCurrentViewpoint();
  const first=JSON.stringify(r.stored[0].viewpoint),other=JSON.stringify(r.stored[1]);
  await r.state.load();
  assert.equal(JSON.stringify(r.state.selected.value.viewpoint),first);
  r.sdkState.pose={position:{x:20,y:5,z:30},rotation:{x:0,y:0},sweep:'scan-B',mode:'mode.inside'};
  await r.state.previewSaved();
  assert.deepEqual(r.moves.at(-1),{id:'scan-A',args:{transition:'instant',rotation:{x:12,y:135}}});
  await r.state.beginSetup();
  r.sdkState.pose={position:{x:20,y:5,z:30},rotation:{x:-8,y:20},sweep:'scan-B',mode:'mode.inside'};
  await r.state.captureCurrentViewpoint();
  assert.equal(r.stored[0].viewpoint.sweep_id,'scan-B');
  assert.deepEqual(r.stored[0].viewpoint.camera_rotation,{pitch:-8,yaw:20});
  assert.equal(JSON.stringify(r.stored[1]),other);
  assert.equal(r.calls.filter(call=>call.args).length,2);
  assert.match(r.component.template,/Replace Viewpoint/);
});

test('capture cancellation preserves the selected location and previous saved view without writing',async()=>{
  const pose=deferred();const r=cameraRuntime();await r.mount();await r.state.beginSetup();
  r.sdk.Camera.getPose=()=>pose.promise;
  const selected=r.state.selected.value.id;
  const capture=r.state.captureCurrentViewpoint();
  await new Promise(resolve=>setImmediate(resolve));
  r.state.select(r.state.rows.value[1]);assert.equal(r.state.selected.value.id,selected);
  r.state.cancelSetup();pose.resolve({position:{x:10,y:2,z:20},rotation:{x:0,y:0},sweep:'scan-A',mode:'mode.inside'});
  await capture;
  assert.equal(r.state.setupMode.value,false);assert.equal(r.state.selected.value.id,selected);
  assert.equal(r.calls.filter(call=>call.args).length,0);assert.equal(r.state.captured.value,null);
});

test('duplicate captures are blocked while capture or persistence is pending and no early success is shown',async()=>{
  const pendingWrite=deferred(),pendingRead=deferred();let reads=0;
  const r=cameraRuntime({api:async(url,args,fallback)=>{
    if(args)return pendingWrite.promise;
    if(++reads===1)return fallback(url,args);
    return pendingRead.promise;
  }});
  await r.mount();await r.state.beginSetup();
  const capture=r.state.captureCurrentViewpoint();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.state.saving.value,true);assert.equal(r.state.message.value,'');
  await r.state.captureCurrentViewpoint();assert.equal(r.calls.filter(call=>call.args).length,1);
  const view=r.calls.find(call=>call.args).args.json.viewpoint,revision='11111111-1111-4111-8111-111111111111';
  pendingWrite.resolve({id:101,model_id:'model-A',viewpoint:view,revision});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.state.message.value,'');assert.equal(r.state.saving.value,true);
  pendingRead.resolve({model_id:'model-A',pois:[{...r.stored[0],viewpoint:view,revision}]});await capture;
  assert.match(r.state.message.value,/saved/);assert.equal(r.state.saving.value,false);
});

test('a failed write or unconfirmed readback retains the capture and never claims success or exposes raw errors',async()=>{
  for(const stage of ['write','readback']){
    let reads=0;
    const r=cameraRuntime({api:async(url,args,fallback)=>{
      if(args&&stage==='write')throw new Error('private database credentials in raw error');
      if(!args&&++reads>1&&stage==='readback')throw new Error('private readback failure');
      return fallback(url,args);
    }});
    await r.mount();await r.state.beginSetup();await r.state.captureCurrentViewpoint();
    assert.equal(r.state.message.value,'');assert.match(r.state.error.value,/Couldn't confirm/);
    assert.doesNotMatch(r.state.error.value,/private|credentials/);
    assert.ok(r.state.captured.value);assert.equal(r.state.setupMode.value,true);
    if(stage==='write')assert.equal(r.stored[0].viewpoint,null);
  }
});

test('a failed new capture cannot retry an older failed-save capture or alter the persisted view',async()=>{
  const previous={model_id:'model-A',sweep_id:'scan-A',camera_position:{x:10,y:2,z:20},camera_rotation:{pitch:0,yaw:0},floor_id:'floor-A',captured_at:'2026-11-16T10:00:00Z'};
  const r=cameraRuntime({rows:[{id:101,name:'Room A',position:{x:500,y:0,z:400},viewpoint:previous,revision:'default',status:'saved'}],
    api:async(url,args,fallback)=>{
      if(args)throw new Error('save unavailable');
      return fallback(url,args);
    }});
  await r.mount();await r.state.beginSetup();
  r.sdkState.pose.rotation={x:15,y:25};await r.state.captureCurrentViewpoint();
  assert.ok(r.state.captured.value,'a failed save retains that attempt for an explicit retry');
  assert.equal(r.calls.filter(call=>call.args).length,1);
  r.sdkState.pose.sweep='';
  await r.state.captureCurrentViewpoint();
  assert.match(r.state.error.value,/Couldn't capture/);
  assert.equal(r.state.captured.value,null,'starting a new attempt invalidates the earlier retry payload');
  await r.state.retrySave();
  assert.equal(r.calls.filter(call=>call.args).length,1,'retry cannot silently save the earlier camera view');
  assert.deepEqual(r.stored[0].viewpoint,previous);
  assert.deepEqual(JSON.parse(JSON.stringify(r.state.selected.value.viewpoint)),previous);
});

for(const pendingStage of ['write','readback']){
  test(`building navigation during a pending ${pendingStage} invalidates the old capture and loads the new building`,async()=>{
    const pending=deferred();let oldReads=0;
    const nextRow={id:101,name:'New building room',viewpoint:null,revision:'default',status:'none'};
    const r=cameraRuntime({api:async(url,args,fallback)=>{
      if(url.startsWith('/admin/buildings/next-building/'))return{enabled:true,writable:true,model_id:'model-A',pois:[structuredClone(nextRow)]};
      if(args&&pendingStage==='write')return pending.promise;
      if(!args&&++oldReads>1&&pendingStage==='readback')return pending.promise;
      return fallback(url,args);
    }});
    await r.mount();await r.state.beginSetup();
    const capture=r.state.captureCurrentViewpoint();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(r.state.saving.value,true);
    const oldWrite=r.calls.find(call=>call.args),oldView=oldWrite.args.json.viewpoint;
    r.props.b.slug='next-building';
    const reload=r.watchers[0].callback();
    assert.equal(r.state.saving.value,false,'superseded save must not leave the new building busy');
    assert.equal(r.state.setupMode.value,false);assert.equal(r.state.captured.value,null);
    assert.equal(r.state.selected.value,null,'do not display old POIs while the new building is loading');
    await reload;
    assert.equal(r.state.selected.value.name,nextRow.name);
    const revision='11111111-1111-4111-8111-111111111111';
    pending.resolve(pendingStage==='write'
      ?{id:101,model_id:'model-A',viewpoint:oldView,revision}
      :{model_id:'model-A',pois:[{id:101,name:'Old building room',viewpoint:oldView,revision}]});
    await capture;
    assert.equal(r.state.selected.value.name,nextRow.name);
    assert.equal(r.state.selected.value.viewpoint,null);
    assert.equal(r.state.message.value,'');assert.equal(r.state.error.value,'');
    assert.equal(r.state.saving.value,false);assert.equal(r.state.capturing.value,false);
    assert.equal(r.state.connected.value,false);assert.equal(r.disconnects(),1);
    assert.equal(r.calls.filter(call=>call.args).length,1,'an old capture cannot write to the next building');
  });
}

test('a superseded building save cannot clear a newer save in progress',async()=>{
  const oldWrite=deferred(),newWrite=deferred();let newReadback=false;
  const newView={model_id:'model-B',sweep_id:'scan-B',camera_position:{x:20,y:5,z:30},camera_rotation:{pitch:0,yaw:0},floor_id:null,captured_at:'2026-11-16T10:00:00Z'};
  const nextRow={id:101,name:'Next room',viewpoint:newView,revision:'11111111-1111-4111-8111-111111111111',status:'saved'};
  const nextRevision='22222222-2222-4222-8222-222222222222';
  const r=cameraRuntime({api:async(url,args,fallback)=>{
    if(url.startsWith('/admin/buildings/next-building/')){
      if(args)return newWrite.promise;
      return{enabled:true,writable:true,model_id:'model-B',pois:[newReadback?{...nextRow,viewpoint:null,revision:nextRevision}:structuredClone(nextRow)]};
    }
    return args?oldWrite.promise:fallback(url,args);
  }});
  await r.mount();await r.state.beginSetup();const oldCapture=r.state.captureCurrentViewpoint();
  await new Promise(resolve=>setImmediate(resolve));const oldView=r.calls.find(call=>call.args).args.json.viewpoint;
  r.props.b.slug='next-building';await r.watchers[0].callback();
  const remove=r.state.remove();await new Promise(resolve=>setImmediate(resolve));assert.equal(r.state.saving.value,true);
  oldWrite.resolve({id:101,model_id:'model-A',viewpoint:oldView,revision:'33333333-3333-4333-8333-333333333333'});await oldCapture;
  assert.equal(r.state.saving.value,true,'old finally handler cannot unlock the new save');
  assert.equal(r.state.selected.value.name,'Next room');assert.equal(r.state.message.value,'');
  newReadback=true;newWrite.resolve({id:101,model_id:'model-B',viewpoint:null,revision:nextRevision});await remove;
  assert.equal(r.state.saving.value,false);assert.equal(r.state.selected.value.viewpoint,null);
  assert.match(r.state.message.value,/removed/);
});

test('capture rejects dollhouse, transitions, malformed poses, disabled sweeps and invented scan positions',async()=>{
  const valid={position:{x:10,y:2,z:20},rotation:{x:0,y:0},sweep:'scan-A',mode:'mode.inside'};
  const cases=[
    {...valid,mode:'mode.dollhouse'}, {...valid,sweep:''}, {...valid,sweep:'not-in-model'},
    {...valid,position:{x:11,y:2,z:20}}, {...valid,position:{x:NaN,y:2,z:20}},
    {...valid,rotation:{x:Infinity,y:0}}, {...valid,rotation:{x:0,y:'30'}},
  ];
  for(const pose of cases){
    const r=cameraRuntime({pose});await r.mount();await r.state.beginSetup();await r.state.captureCurrentViewpoint();
    assert.match(r.state.error.value,/Couldn't capture/);assert.equal(r.state.message.value,'');
    assert.equal(r.calls.filter(call=>call.args).length,0);
  }
  const r=cameraRuntime({catalog:{'scan-A':{sid:'scan-A',enabled:false,position:{x:10,y:2,z:20}}}});
  await r.mount();await r.state.beginSetup();await r.state.captureCurrentViewpoint();
  assert.equal(r.calls.filter(call=>call.args).length,0);assert.match(r.state.error.value,/Couldn't capture/);
});

test('a model mismatch is flagged instead of loading or restoring the old model view',async()=>{
  const r=cameraRuntime({urlModel:'different-model'});await r.mount();await r.state.beginSetup();
  assert.equal(r.state.connected.value,false);assert.equal(r.state.twinBusy.value,false);
  assert.match(r.state.twinStatus.value,/Couldn't connect/);assert.equal(r.calls.filter(call=>call.args).length,0);
  const old={model_id:'old-model',sweep_id:'scan-A',camera_position:{x:10,y:2,z:20},camera_rotation:{pitch:0,yaw:0},floor_id:null,captured_at:'2026-11-16T10:00:00Z'};
  const incompatible=cameraRuntime({rows:[{id:101,name:'Room A',viewpoint:old,revision:'default',status:'incompatible'}]});
  await incompatible.mount();assert.equal(await incompatible.state.previewSaved(),false);
  assert.match(incompatible.state.error.value,/no longer available/);assert.equal(incompatible.moves.length,0);
});

test('read-only administrators can preview but cannot start capture, save or remove viewpoints',async()=>{
  const r=cameraRuntime({writable:false});await r.mount();await r.state.beginSetup();await r.state.captureCurrentViewpoint();await r.state.remove();
  assert.equal(r.state.setupMode.value,false);assert.equal(r.calls.filter(call=>call.args).length,0);
});

test('camera pose observable fallback captures the supported SDK state and unsubscribes',async()=>{
  const r=cameraRuntime();let cancels=0;delete r.sdk.Camera.getPose;
  r.sdk.Camera.pose={subscribe(callback){callback(r.sdkState.pose);return{cancel:()=>cancels++};}};
  await r.mount();await r.state.beginSetup();await r.state.captureCurrentViewpoint();
  assert.equal(cancels,1);assert.equal(r.stored[0].viewpoint.sweep_id,'scan-A');
});

test('the POI editor deep link selects and enters setup for the intended registered location',async()=>{
  const r=cameraRuntime({hash:'#/b/any-registered-campus/viewpoints?poi=202&setup=1'});await r.mount();
  assert.equal(r.state.selected.value.id,202);assert.equal(r.state.setupMode.value,true);assert.equal(r.state.connected.value,true);
  assert.equal(r.calls.filter(call=>call.args).length,0);
});

test('saved published location links enter Matterport mode and preserve the viewer route and public POI identity',async()=>{
  const saved={model_id:'model-A',sweep_id:'scan-A',camera_position:{x:10,y:2,z:20},camera_rotation:{pitch:0,yaw:20},floor_id:null,captured_at:'2026-11-16T10:00:00Z'};
  for(const example of [
    {slug:'another-campus',url:'/?b=another-campus&theme=night',source_id:'public/room 101',key:'ignored-key',path:'/',keep:['theme','night']},
    {slug:'gcu',url:'/gcu-omr?lang=es#visitor',source_id:null,key:'room-101',path:'/gcu-omr',keep:['lang','es']},
  ]){
    const r=cameraRuntime({slug:example.slug,building:{published_version:2},
      rows:[{id:101,name:'Room A',source_id:example.source_id,key:example.key,published:true,viewpoint:saved,revision:'default',status:'saved'}],
      viewerUrl:(building,matterport)=>{assert.equal(building.slug,example.slug);assert.equal(matterport,true);return example.url;}});
    await r.mount();const url=new URL(r.state.visitorViewUrl.value);
    assert.equal(url.pathname,example.path);assert.equal(url.searchParams.get('mp'),'1');
    assert.equal(url.searchParams.get('to'),example.source_id || example.key);
    assert.equal(url.searchParams.get(example.keep[0]),example.keep[1]);
    if(example.slug==='gcu')assert.equal(url.hash,'#visitor');
    assert.equal(r.calls.filter(call=>call.args).length,0);
  }
});

test('visitor links stay hidden for drafts or missing publication and saving a draft explains publication',async()=>{
  const saved={model_id:'model-A',sweep_id:'scan-A',camera_position:{x:10,y:2,z:20},camera_rotation:{pitch:0,yaw:20},floor_id:null,captured_at:'2026-11-16T10:00:00Z'};
  const row={id:101,name:'Room A',key:'room-A',published:true,viewpoint:saved,revision:'default',status:'saved'};
  for(const options of [
    {building:{published_version:null},rows:[row],viewerUrl:()=>'/viewer'},
    {building:{published_version:1},rows:[{...row,published:false}],viewerUrl:()=>'/viewer'},
    {building:{published_version:1},rows:[{...row,viewpoint:null}],viewerUrl:()=>'/viewer'},
    {building:{published_version:1},rows:[row]},
  ]){
    const r=cameraRuntime(options);await r.mount();assert.equal(r.state.visitorViewUrl.value,null);
  }
  const r=cameraRuntime({building:{published_version:null},viewerUrl:()=>'/viewer'});
  await r.mount();await r.state.beginSetup();await r.state.captureCurrentViewpoint();
  assert.match(r.state.message.value,/Publish this location/);assert.equal(r.state.visitorViewUrl.value,null);
});

test('capture setup offers touch controls outside the interactive twin without manual XYZ fields',()=>{
  const r=cameraRuntime();
  assert.match(r.component.template,/Capture Current Viewpoint/);assert.match(r.component.template,/Cancel Viewpoint Setup/);
  assert.doesNotMatch(r.component.template,/type="number"|allowfullscreen|viewpoint-crosshair/);
  const css=fs.readFileSync(path.join(root,'admin/admin.css'),'utf8');
  assert.match(css,/camera-viewpoints button[^}]+min-height:44px/);
  assert.match(css,/viewpoint-capture-panel\{position:sticky/);
});
