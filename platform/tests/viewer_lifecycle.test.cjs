// Real controller with a controlled iframe and SDK: lifecycle, not renderer mocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_preview.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return {promise, resolve, reject}; }

function fixture({holdConnections = false, holdConfig = false, holdPlaying = false} = {}) {
  const elements = new Map(), writes = [], attempts = [], events = [], idle = [];
  const element = id => {
    const classes = new Set(id === 'body' ? ['mp-bg-mode'] : []);
    return {id, hidden: false, isConnected: true, style: {}, dataset: {}, attributes: {},
      classList: {add(...xs) { xs.forEach(x => classes.add(x)); }, remove(...xs) { xs.forEach(x => classes.delete(x)); }, contains: x => classes.has(x), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }},
      addEventListener() {}, removeEventListener() {}, removeAttribute(name) { delete this.attributes[name]; },
      setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name] || ''; }, querySelector: () => null};
  };
  const $ = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const frame = $('mpFrame'); let currentSrc = '';
  Object.defineProperty(frame, 'src', {get: () => currentSrc, set: value => { writes.push(value); currentSrc = value; }});
  frame.getAttribute = name => name === 'src' ? currentSrc : '';
  frame.contentWindow = {}; frame.parentElement = element('wrap');
  let startupGeneration = 0, starts = 0, ready = 0;
  const startup = {begin(generation) { startupGeneration = generation; starts++; events.push('startup.begin'); },
    isCurrent: generation => generation === startupGeneration, modelVisible() {}, modelReady() { ready++; },
    uiReady() {}, fail() { events.push('startup.fail'); }, status() {}, get pending() { return !ready; }};
  const configWait = deferred(), playingWait = deferred();
  const c = {window: null, document: {body: element('body'), getElementById: $, querySelector: () => null},
    navigator: {userAgent: 'mobile-test'}, location: {href: 'https://viewer.test/unc-charlotte', search: ''},
    performance, URL, URLSearchParams, console: {warn() {}, info() {}, error() {}},
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: callback => { queueMicrotask(callback); return 1; }, cancelAnimationFrame() {},
    requestIdleCallback: callback => { idle.push(callback); return idle.length; }, cancelIdleCallback() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({matches: true}),
    fetch: async () => ({ok: false, status: 404, json: async () => ({})}),
    localStorage: {getItem: () => null}, sessionStorage: {getItem: () => null},
    WF: {configReady: Promise.resolve(), ready: Promise.resolve(), cfg: {slug: 'uncc-main-campus', matterport_model_id: 'model-a'}, building: {slug: 'uncc-main-campus'}},
    WFStartup: startup, MP_SDK: {connect(iframe) {
      assert.equal(iframe, frame);
      const wait = deferred(); attempts.push(wait); events.push('sdk.connect');
      if (!holdConnections) wait.resolve(makeSdk('sdk-' + attempts.length));
      return wait.promise;
    }}
  };
  c.window = c;
  vm.createContext(c);
  const hooked = source.replace('  window.MpPreview = {', `
    window.__lifecycleTest = {
      setup: function() {
        ensureOverlay = function() {};
        loadSdkScript = async function() {};
        waitIframeLoad = async function() {};
        waitPlaying = async function() { if (window.__holdPlaying) await window.__playingWait; return true; };
        frameWholeBuilding = async function() {};
        resolveConfig = async function() {
          const snapshot = {modelId: WF.cfg.matterport_model_id, applicationKey: 'public-test-key'};
          if (window.__holdConfig) await window.__configWait;
          return snapshot;
        };
      },
      state: function() { return {sdk: mpSdk, modelId: modelId, epoch: viewerEpoch, openGen: openGen}; },
      unrelatedUi: function() { openGen++; focusGen++; },
      stubRouteStart: function() { openUsingLiveConnection = async function() { window.__routeStarts = (window.__routeStarts || 0) + 1; }; },
      connect: connectSdk
    };
    window.__lifecycleTest.setup();
    window.MpPreview = {`);
  c.__holdConfig = holdConfig; c.__configWait = configWait.promise;
  c.__holdPlaying = holdPlaying; c.__playingWait = playingWait.promise;
  vm.runInContext(hooked, c);
  function makeSdk(id) {
    let pose = {position: {x: 0, y: 1.6, z: 0}, rotation: {x: 0, y: 0}, sweep: 'one', mode: 'mode.inside'};
    const moves = [], modes = [], rotations = [], zooms = [], phaseListeners = new Set(), poseListeners = new Set();
    const points = [{sid: 'one', position: {x: 0, y: 1.6, z: 0}}, {sid: 'two', position: {x: 10, y: 1.6, z: 0}}];
    const emitPose = () => { for (const callback of poseListeners) callback(pose); };
    const sdk = {id, moves, modes, rotations, zooms, disconnected: 0,
      emitPhase(phase) { for (const callback of phaseListeners) callback({phase}); },
      disconnect() { this.disconnected++; },
      App: {Phase: {PLAYING: 'appphase.playing'}, state: {getLatest: () => ({phase: 'appphase.playing'}), subscribe(callback) { phaseListeners.add(callback); callback({phase: 'appphase.playing'}); return {cancel() { phaseListeners.delete(callback); }}; }}},
      Mode: {Mode: {DOLLHOUSE: 'mode.dollhouse', INSIDE: 'mode.inside'}, moveTo: async mode => { modes.push(mode); }},
      Model: {getData: async () => ({sweeps: points})},
      Sweep: {Transition: {FLY: 'fly', INSTANT: 'instant'}, moveTo: async (sid, options) => { moves.push({sid, options}); pose = {...pose, position: points.find(point => point.sid === sid).position, rotation: options.rotation || pose.rotation, sweep: sid}; emitPose(); }},
      Camera: {getPose: async () => pose, pose: {getLatest: () => pose, subscribe(callback) { poseListeners.add(callback); callback(pose); return {cancel() { poseListeners.delete(callback); }}; }},
        setRotation: async rotation => { rotations.push(rotation); pose.rotation = rotation; emitPose(); }, zoomTo: async value => { zooms.push(value); }, zoomBy: async value => { zooms.push(value); }}
    };
    return sdk;
  }
  return {c, frame, writes, attempts, events, makeSdk, configWait, playingWait, elements,
    reloadControllerScript: () => vm.runInContext(hooked, c),
    model(value) { c.WF.cfg = {...c.WF.cfg, matterport_model_id: value}; },
    counts: () => ({iframeElements: 1, srcWrites: writes.length, sdkInitializations: attempts.length, starts, ready})};
}

test('same-model requests share pending initialization and reuse the ready iframe/SDK', async () => {
  const f = fixture({holdConnections: true});
  const first = f.c.MpPreview.showBackground();
  const concurrent = f.c.MpPreview.showBackground();
  await flush();
  assert.equal(f.attempts.length, 1);
  const sdk = f.makeSdk('ready-sdk'); f.attempts[0].resolve(sdk);
  assert.equal(await first, true); assert.equal(await concurrent, true);
  const count = f.counts(), pose = await sdk.Camera.getPose();
  f.c.WF.cfg = {...f.c.WF.cfg, branding: {theme: 'light'}};
  f.c.WF.building = {...f.c.WF.building};
  assert.equal(await f.c.MpPreview.showBackground(), true);
  assert.deepEqual(f.counts(), count);
  assert.equal(f.c.__lifecycleTest.state().sdk, sdk);
  assert.deepEqual(await sdk.Camera.getPose(), pose);
  assert.equal(f.writes.length, 1);
});

test('a genuine model change starts once and keeps the existing iframe element', async () => {
  const f = fixture(); assert.equal(await f.c.MpPreview.showBackground(), true);
  const frame = f.frame, oldSdk = f.c.__lifecycleTest.state().sdk;
  f.model('model-b');
  assert.equal(await f.c.MpPreview.showBackground(), true);
  assert.equal(f.frame, frame);
  assert.equal(f.attempts.length, 2);
  assert.equal(f.counts().starts, 2);
  assert.equal(f.c.__lifecycleTest.state().modelId, 'model-b');
  assert.notEqual(f.c.__lifecycleTest.state().sdk, oldSdk);
  const count = f.counts(); await f.c.MpPreview.showBackground();
  assert.deepEqual(f.counts(), count);
});

for (const stale of ['resolve', 'reject']) {
  test(`stale SDK ${stale} cannot overwrite a newer successful model connection`, async () => {
    const f = fixture({holdConnections: true});
    const first = f.c.MpPreview.showBackground(); await flush();
    assert.equal(f.attempts.length, 1);
    f.model('model-b'); const second = f.c.MpPreview.showBackground(); await flush();
    assert.equal(f.attempts.length, 2);
    const newer = f.makeSdk('newer'); f.attempts[1].resolve(newer);
    assert.equal(await second, true);
    if (stale === 'resolve') f.attempts[0].resolve(f.makeSdk('stale'));
    else f.attempts[0].reject(new Error('old frame connection failed'));
    assert.equal(await first, false);
    assert.equal(f.c.__lifecycleTest.state().sdk, newer);
    assert.equal(f.c.__lifecycleTest.state().modelId, 'model-b');
    assert.equal(f.c.MpPreview.getLiveConnection().sdk, newer);
    assert.equal(f.counts().starts, 2);
  });
}

test('late config cannot restart or republish an obsolete model', async () => {
  const f = fixture({holdConfig: true});
  const old = f.c.MpPreview.showBackground(); await flush();
  f.model('model-b'); f.c.__holdConfig = false;
  assert.equal(await f.c.MpPreview.showBackground(), true);
  f.configWait.resolve(); assert.equal(await old, false);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.c.__lifecycleTest.state().modelId, 'model-b');
});

test('presentation generations and POI/camera navigation preserve model and initialization', async () => {
  const f = fixture(); assert.equal(await f.c.MpPreview.showBackground(), true);
  const sdk = f.c.__lifecycleTest.state().sdk, counts = f.counts();
  f.c.__lifecycleTest.unrelatedUi();
  assert.equal(await f.c.MpPreview.showBackground(), true);
  const poi = {id: 'poi-two', x: 10, y: 0, z: 0};
  assert.equal(await f.c.MpPreview.focusPoi(poi, {legacyFace: null}), true);
  assert.equal(sdk.moves.at(-1).sid, 'two');
  await f.c.MpPreview.zoomBy(0.1);
  await sdk.Camera.setRotation({x: 0, y: 45});
  const pose = await sdk.Camera.getPose();
  assert.equal(await f.c.MpPreview.showBackground(), true);
  assert.deepEqual(await sdk.Camera.getPose(), pose);
  assert.deepEqual(f.counts(), counts);
  assert.equal(f.c.MpPreview.getLiveConnection().sdk, sdk);
});

test('re-executing the controller script preserves its existing closure and connection', async () => {
  const f = fixture(); assert.equal(await f.c.MpPreview.showBackground(), true);
  const controller = f.c.MpPreview, sdk = f.c.__lifecycleTest.state().sdk, counts = f.counts();
  f.reloadControllerScript();
  assert.equal(f.c.MpPreview, controller);
  assert.equal(await f.c.MpPreview.showBackground(), true);
  assert.equal(f.c.__lifecycleTest.state().sdk, sdk);
  assert.deepEqual(f.counts(), counts);
});

test('presentation changes during pending startup cannot invalidate the model lifecycle', async () => {
  const f = fixture({holdConnections: true});
  const attempt = f.c.MpPreview.showBackground(); await flush();
  f.c.__lifecycleTest.unrelatedUi();
  f.attempts[0].resolve(f.makeSdk('ready'));
  assert.equal(await attempt, true);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.writes.length, 1);
});

test('duplicate background script and duplicate DOM-ready callbacks cannot restart startup', async () => {
  const background = fs.readFileSync(path.join(__dirname, '../viewer/mp_background.js'), 'utf8');
  let calls = 0;
  const callbacks = [];
  const c = {window: null, document: {readyState: 'loading', head: {appendChild() {}},
    body: {classList: {add() {}}}, createElement: () => ({}), getElementById: () => null,
    addEventListener(name, callback) { if (name === 'DOMContentLoaded') callbacks.push(callback); }},
    localStorage: {getItem: () => null}, URLSearchParams, location: {search: '?mp=1'},
    MutationObserver: class {observe() {} disconnect() {}}, setTimeout: () => 1, clearTimeout() {}, Event: class {}, dispatchEvent() {}};
  c.window = c;
  c.MpPreview = {showBackground: async () => { calls++; c.WFStartup.begin(calls); return true; }};
  vm.createContext(c); vm.runInContext(background, c);
  const startup = c.WFStartup, ready = c.__mpBackgroundPromise;
  vm.runInContext(background, c);
  assert.equal(c.WFStartup, startup);
  assert.equal(c.__mpBackgroundPromise, ready);
  for (const callback of callbacks) { callback(); callback(); }
  await flush();
  assert.equal(calls, 1);
});

test('internal Matterport loading phases are observed without restarting the viewer', async () => {
  const f = fixture(); assert.equal(await f.c.MpPreview.showBackground(), true);
  const sdk = f.c.__lifecycleTest.state().sdk, counts = f.counts();
  for (const phase of ['appphase.loading', 'appphase.starting', 'appphase.playing']) sdk.emitPhase(phase);
  await flush();
  assert.equal(f.c.__lifecycleTest.state().sdk, sdk);
  assert.deepEqual(f.counts(), counts);
});

test('explicit same-model recovery reconnects once and restores the last camera scan and rotation', async () => {
  const f = fixture(); assert.equal(await f.c.MpPreview.showBackground(), true);
  const oldSdk = f.c.__lifecycleTest.state().sdk;
  await oldSdk.Sweep.moveTo('two', {rotation: {x: 10, y: 45}});
  await oldSdk.Camera.setRotation({x: 12, y: 50});
  const counts = f.counts();
  assert.equal(await f.c.MpPreview.showBackground({retry: true}), true);
  await flush();
  const sdk = f.c.__lifecycleTest.state().sdk;
  assert.notEqual(sdk, oldSdk);
  assert.equal(f.attempts.length, counts.sdkInitializations + 1);
  assert.equal(oldSdk.disconnected, 1);
  assert.equal(sdk.moves.at(-1).sid, 'two');
  assert.deepEqual(JSON.parse(JSON.stringify(sdk.moves.at(-1).options.rotation)), {x: 12, y: 50});
});

test('config changing during a fetch cannot label an old model as the new identity', async () => {
  const f = fixture({holdConfig: true});
  const first = f.c.MpPreview.showBackground(); await flush();
  f.model('model-b'); f.c.__holdConfig = false;
  f.configWait.resolve(); await first;
  assert.equal(await f.c.MpPreview.showBackground(), true);
  assert.equal(f.c.__lifecycleTest.state().modelId, 'model-b');
  assert.equal(f.attempts.length, 1, 'the obsolete config must not initialize a model');
  assert.ok(f.writes.every(url => new URL(url).searchParams.get('m') === 'model-b'));
});

for (const closeBeforeReady of [false, true]) {
  test(`a route requested after SDK connect waits for model readiness${closeBeforeReady ? ' and close cancels it' : ''}`, async () => {
    const f = fixture({holdPlaying: true});
    f.c.__lifecycleTest.stubRouteStart();
    const startup = f.c.MpPreview.showBackground(); await flush();
    assert.ok(f.c.__lifecycleTest.state().sdk, 'SDK is connected');
    assert.equal(f.counts().ready, 0, 'model startup has not finished');
    const route = f.c.MpPreview.open({sweep_ids: ['one', 'two']}); await flush();
    assert.equal(f.c.__routeStarts || 0, 0, 'camera navigation waits for model readiness');
    if (closeBeforeReady) f.c.MpPreview.close();
    f.playingWait.resolve();
    assert.equal(await startup, true); await route; await flush();
    assert.equal(f.c.__routeStarts || 0, closeBeforeReady ? 0 : 1);
    assert.equal(f.attempts.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.c.__lifecycleTest.state().sdk.moves.length, 0);
    assert.equal(f.elements.get('mpOverlay').hidden, false, 'closing a queued route keeps the permanent background visible');
  });
}
