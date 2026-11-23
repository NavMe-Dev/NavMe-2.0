// Exercise the production controller with a fake SDK, including asynchronous camera failures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 6; n++) await new Promise(setImmediate); };

function controller(ios = false) {
  const context = { window: null, document: { body: { classList: { remove() {} } } },
    navigator: { userAgent: ios ? 'iPhone' : 'test', platform: '', maxTouchPoints: 0 },
    console: { warn() {}, info() {}, error() {} }, setTimeout, clearTimeout, URLSearchParams };
  context.window = context;
  const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_preview.js'), 'utf8')
    .replace('  window.MpPreview = {', `
    window.__home = {
      bind(sdk) { mpSdk = sdk; viewerEpoch++; backgroundSession = {}; homeTogglePose = null; homeToggleTask = null; },
      invalidate() { viewerEpoch++; backgroundSession = {}; homeTogglePose = null; homeToggleTask = null; },
      saved() { return homeTogglePose; }
    };
    window.MpPreview = {`);
  vm.runInNewContext(source, context);
  return context;
}

function fakeSdk(initial = {}) {
  let pose = { mode: 'mode.dollhouse', sweep: '', rotation: { x: -15, y: 40 }, ...initial };
  const calls = [], hooks = {};
  const sdk = {
    Camera: { TransitionType: { FLY: 'fly', FADEOUT: 'fade', INSTANT: 'instant' },
      getPose: async () => hooks.pose ? hooks.pose() : plain(pose),
      lookAt: async target => { calls.push({ type: 'frame', target: plain(target) }); } },
    Model: { getData: async () => hooks.model ? hooks.model() : ({ sweeps: [
      { id: 'entry', position: { x: 1, y: 2, z: 3 } },
      { id: 'room', position: { x: 5, y: 4, z: 9 } },
    ] }) },
    Mode: { Mode: { INSIDE: 'mode.inside', DOLLHOUSE: 'mode.dollhouse', FLOORPLAN: 'mode.floorplan' },
      Transition: { FLY: 'fly', FADEOUT: 'fade', INSTANT: 'instant' },
      moveTo: async (mode, options) => {
        calls.push({ type: 'mode', mode, options: plain(options) });
        if (hooks.mode) await hooks.mode(mode);
        pose = { ...pose, mode, sweep: mode === 'mode.inside' ? 'entry' : '', rotation: { x: 0, y: 0 } };
      } },
    Sweep: { Transition: { FLY: 'fly', FADEOUT: 'fade', INSTANT: 'instant' },
      moveTo: async (sweep, options) => {
        calls.push({ type: 'sweep', sweep, options: plain(options) });
        if (hooks.sweep) await hooks.sweep(sweep);
        pose = { ...pose, mode: 'mode.inside', sweep, rotation: options.rotation || pose.rotation };
      } },
  };
  return { sdk, calls, hooks, setPose: value => { pose = value; }, pose: () => plain(pose) };
}

for (const mode of ['mode.dollhouse', 'mode.floorplan']) {
  test(`the initial ${mode} button enters native Inside without selecting an arbitrary scan`, async () => {
    const c = controller(), f = fakeSdk({ mode }); c.__home.bind(f.sdk);
    assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: false, ok: true });
    assert.deepEqual(f.calls, [{ type: 'mode', mode: 'mode.inside', options: { transition: 'fly' } }]);
    assert.equal(c.__home.saved(), null);
  });
}

test('Inside opens the overview, then restores the exact scan and independent pitch/yaw', async () => {
  const c = controller(), f = fakeSdk({ mode: 'mode.inside', sweep: 'room', rotation: { x: -12.5, y: 78 } });
  c.__home.bind(f.sdk);
  assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: true, ok: true });
  assert.deepEqual(plain(c.__home.saved()), { sweep: 'room', rotation: { x: -12.5, y: 78 } });
  assert.deepEqual(f.calls.map(call => call.type), ['mode', 'frame']);
  assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: false, ok: true });
  assert.deepEqual(f.calls.at(-1), { type: 'sweep', sweep: 'room', options: { transition: 'fly', rotation: { x: -12.5, y: 78 } } });
  assert.equal(c.__home.saved(), null);
});

test('a failed restore keeps its scan and rotation for the next click', async () => {
  const c = controller(), f = fakeSdk({ mode: 'mode.inside', sweepId: 'room', rotation: { x: 8, y: -120 } });
  c.__home.bind(f.sdk); await c.MpPreview.toggleHomeView();
  f.hooks.sweep = async () => { throw Error('temporary failure'); };
  assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: true, ok: false });
  assert.deepEqual(plain(c.__home.saved()), { sweep: 'room', rotation: { x: 8, y: -120 } });
  delete f.hooks.sweep;
  assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: false, ok: true });
  assert.deepEqual(f.calls.filter(call => call.type === 'sweep').map(call => call.sweep), ['room', 'room']);
});

test('failed initial entry and failed overview moves report failure and remain retryable', async () => {
  for (const mode of ['mode.dollhouse', 'mode.inside']) {
    const c = controller(), f = fakeSdk({ mode, sweep: mode === 'mode.inside' ? 'room' : '' }); c.__home.bind(f.sdk);
    f.hooks.mode = async () => { throw Error('temporary failure'); };
    assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: false, ok: false });
    assert.equal(c.__home.saved(), null);
    delete f.hooks.mode;
    assert.equal((await c.MpPreview.toggleHomeView()).ok, true);
  }
});

test('rapid clicks share one camera transition rather than starting overlapping toggles', async () => {
  const c = controller(), f = fakeSdk(), gate = deferred(); c.__home.bind(f.sdk);
  f.hooks.mode = () => gate.promise;
  const first = c.MpPreview.toggleHomeView(), second = c.MpPreview.toggleHomeView();
  assert.equal(first, second);
  await flush(); assert.equal(f.calls.length, 1);
  gate.resolve();
  assert.deepEqual(plain(await first), { active: false, ok: true });
});

test('a stale pose read cannot move the old camera or affect a new SDK operation', async () => {
  const c = controller(), old = fakeSdk(), next = fakeSdk(), gate = deferred(); c.__home.bind(old.sdk);
  old.hooks.pose = () => gate.promise;
  const pending = c.MpPreview.toggleHomeView();
  c.__home.bind(next.sdk);
  assert.equal((await c.MpPreview.toggleHomeView()).ok, true);
  gate.resolve({ mode: 'mode.dollhouse', sweep: '' });
  assert.deepEqual(plain(await pending), { active: false, ok: false, stale: true });
  assert.equal(old.calls.length, 0); assert.equal(next.calls.length, 1);
  assert.equal(c.__home.saved(), null);
});

test('a changed session stops overview framing and does not save the previous return pose', async () => {
  const c = controller(), f = fakeSdk({ mode: 'mode.inside', sweep: 'room' }), gate = deferred(); c.__home.bind(f.sdk);
  f.hooks.mode = () => gate.promise;
  const pending = c.MpPreview.toggleHomeView();
  await flush(); c.__home.invalidate(); gate.resolve();
  assert.deepEqual(plain(await pending), { active: false, ok: false, stale: true });
  assert.deepEqual(f.calls.map(call => call.type), ['mode']);
  assert.equal(c.__home.saved(), null);
});

test('a changed session during sweep loading cannot frame the previous model', async () => {
  const c = controller(), f = fakeSdk({ mode: 'mode.inside', sweep: 'room' }), gate = deferred(); c.__home.bind(f.sdk);
  f.hooks.model = () => gate.promise;
  const pending = c.MpPreview.toggleHomeView();
  await flush(); c.__home.invalidate(); gate.resolve({ sweeps: [{ id: 'room', position: { x: 1, y: 2, z: 3 } }] });
  assert.deepEqual(plain(await pending), { active: false, ok: false, stale: true });
  assert.deepEqual(f.calls.map(call => call.type), ['mode']);
});

test('iOS uses its existing fade transitions for native entry, overview and return', async () => {
  const c = controller(true), f = fakeSdk(); c.__home.bind(f.sdk);
  f.sdk.Mode.Transition = { FLY: 'deprecated-fly', FADEOUT: 'deprecated-fade' };
  await c.MpPreview.toggleHomeView(); await c.MpPreview.toggleHomeView(); await c.MpPreview.toggleHomeView();
  assert.deepEqual(f.calls.filter(call => call.type !== 'frame').map(call => call.options.transition), ['fade', 'fade', 'fade']);
});

test('entering a scan outside the toggle replaces the return pose with that current scan', async () => {
  const c = controller(), f = fakeSdk({ mode: 'mode.inside', sweep: 'old' }); c.__home.bind(f.sdk);
  await c.MpPreview.toggleHomeView();
  f.setPose({ mode: 'mode.inside', sweep: 'new', rotation: { x: 15, y: 25 } });
  assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: true, ok: true });
  assert.deepEqual(plain(c.__home.saved()), { sweep: 'new', rotation: { x: 15, y: 25 } });
  assert.equal(f.calls.some(call => call.type === 'sweep'), false);
});

test('an unavailable SDK or missing mode API reports failure without claiming a change', async () => {
  const c = controller();
  assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: false, ok: false });
  const f = fakeSdk(); delete f.sdk.Mode; c.__home.bind(f.sdk);
  assert.deepEqual(plain(await c.MpPreview.toggleHomeView()), { active: false, ok: false });
  assert.equal(f.calls.length, 0);
});
