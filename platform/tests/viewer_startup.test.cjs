// Run with: node --test platform/tests/viewer_startup.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const viewer = path.resolve(__dirname, '../viewer');
function handler(file, name, dependencies) {
  const source = fs.readFileSync(path.join(viewer, file), 'utf8');
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  for (let end = source.indexOf('}', start); end >= 0; end = source.indexOf('}', end + 1)) {
    let script;
    try { script = new vm.Script('(' + source.slice(start, end + 1) + ')'); } catch { continue; }
    return script.runInNewContext(dependencies);
  }
  throw Error('Cannot parse ' + name);
}
function element() {
  const classes = new Set();
  return {
    hidden: true, dataset: { navmeEnhanced: '1' }, attributes: {}, children: [], listeners: {},
    classList: {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
}
function startup(reducedMotion = false) {
  const body = element(), loader = element(), text = element(), shell = element();
  loader.querySelector = () => shell;
  const nodes = { mpBgLoading: loader, mpBgLoadingText: text };
  const timers = new Map();
  let reloaded = false;
  const state = handler('mp_background.js', 'createStartup', {
    document: { body, getElementById: id => nodes[id], createElement: () => element() },
    window: { matchMedia: () => ({ matches: reducedMotion }) },
    enhanceBgLoading() {}, location: { reload() { reloaded = true; } },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  })();
  return { state, body, loader, text, shell, timers, reloaded: () => reloaded };
}
test('iframe and percentage status changes alone never reveal an empty scene', () => {
  const c = startup(); c.state.begin(1);
  for (const status of ['Loading digital twin…', 'Connecting to digital twin…', 'Waiting for twin to be ready…', '100%']) {
    c.state.status(status);
    assert.equal(c.loader.hidden, false);
    assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
    assert.equal(c.body.classList.contains('booting'), true);
  }
});
test('slow venue/UI readiness keeps preparation visible over the rendered model', () => {
  const c = startup(); c.state.begin(1); c.state.modelReady(1);
  assert.equal(c.body.classList.contains('mp-frame-loaded'), true);
  assert.equal(c.text.textContent, 'Preparing your experience…');
  assert.equal(c.body.classList.contains('booting'), true);
  c.state.status(''); // Late SDK status clearing must not remove preparation.
  assert.equal(c.text.textContent, 'Preparing your experience…');
  assert.equal(c.loader.hidden, false);
  c.state.uiReady(1);
  assert.equal(c.body.classList.contains('booting'), false);
  assert.equal(c.body.classList.contains('mp-startup-complete'), true);
  c.loader.listeners.transitionend();
  assert.equal(c.loader.hidden, true);
  assert.equal(c.timers.size, 0);
});
test('cached data arriving before the model still waits for actual model readiness', () => {
  const c = startup(); c.state.begin(1); c.state.uiReady(1);
  assert.equal(c.body.classList.contains('booting'), true);
  c.state.modelReady(1);
  assert.equal(c.body.classList.contains('booting'), false);
});
test('reduced-motion startup dismisses without waiting for a nonexistent transition event', () => {
  const c = startup(true); c.state.begin(1); c.state.modelReady(1); c.state.uiReady(1);
  assert.equal(c.loader.hidden, true);
});
test('failed model or data loads produce a persistent error and working reload action', () => {
  for (const modelWasReady of [false, true]) {
    const c = startup(); c.state.begin(1);
    if (modelWasReady) c.state.modelReady(1);
    c.state.fail(1);
    assert.equal(c.loader.attributes.role, 'alert');
    assert.equal(c.loader.attributes['aria-busy'], 'false');
    assert.equal(c.text.textContent, "We couldn't load your navigation experience. Please try again.");
    c.shell.children[0].onclick();
    assert.equal(c.reloaded(), true);
    c.state.status(''); c.state.modelReady(1); c.state.uiReady(1);
    assert.equal(c.body.classList.contains('booting'), true);
    assert.equal(c.loader.classList.contains('err'), true);
    assert.equal(c.timers.size, 0);
  }
});
test('required-data errors arriving before model startup are not reset by begin', () => {
  const c = startup(); c.state.fail(); c.state.begin(1); c.state.modelReady(1); c.state.uiReady(1);
  assert.equal(c.loader.classList.contains('err'), true);
  assert.equal(c.state.isCurrent(1), false);
});
test('timeout reports failure rather than pretending the experience is ready', () => {
  const c = startup(); c.state.begin(1);
  [...c.timers.values()][0]();
  assert.equal(c.loader.classList.contains('err'), true);
  assert.equal(c.body.classList.contains('mp-startup-complete'), false);
});
test('stale callbacks cannot complete or fail a newer venue/model attempt', () => {
  const c = startup(); c.state.begin(1); c.state.begin(2);
  c.state.modelReady(1); c.state.uiReady(1); c.state.fail(1);
  assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
  assert.equal(c.loader.classList.contains('err'), false);
  c.state.modelReady(2); c.state.uiReady(2);
  assert.equal(c.body.classList.contains('mp-startup-complete'), true);
});
function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve };
}
function modelContext(overrides = {}) {
  const c = startup(), load = deferred(), playing = deferred(), mode = deferred();
  const frame = { src: '' }, overlay = element();
  const calls = [];
  const sdk = { Mode: { Mode: { DOLLHOUSE: 'dollhouse' }, moveTo: async () => { calls.push('mode'); await mode.promise; } } };
  const deps = {
    openGen: 0, mpSdk: null, applicationKey: 'test', window: { WFStartup: c.state, WF: { ready: Promise.resolve() } },
    document: { body: c.body }, $: id => id === 'mpFrame' ? frame : overlay,
    ensureOverlay() {}, setStatus() {}, resolveConfig: async () => {},
    showcaseUrl: () => 'https://example.invalid/model', waitIframeLoad: () => load.promise,
    resetFrameIfNeeded: async () => {}, connectSdk: async () => sdk,
    waitPlaying: () => playing.promise, frameWholeBuilding: async () => { calls.push('frame'); },
    requestAnimationFrame: fn => fn(), console: { warn() {} },
    ...overrides,
  };
  return { ...c, load, playing, mode, frame, calls, deps };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('the actual background loader waits for PLAYING and camera completion, not iframe load', async () => {
  const c = modelContext();
  const result = handler('mp_preview.js', 'showBackground', c.deps)();
  await tick(); c.load.resolve(); await tick();
  assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
  c.playing.resolve(true); await tick();
  assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
  c.mode.resolve(); assert.equal(await result, true);
  assert.deepEqual(c.calls, ['mode', 'frame']);
  assert.equal(c.body.classList.contains('mp-frame-loaded'), true);
  assert.equal(c.text.textContent, 'Preparing your experience…');
  assert.equal(c.frame.src, 'https://example.invalid/model');
});
test('SDK/model connection failure keeps the branded error surface', async () => {
  const c = modelContext({ connectSdk: async () => null });
  const result = handler('mp_preview.js', 'showBackground', c.deps)();
  c.load.resolve();
  assert.equal(await result, false);
  assert.equal(c.loader.classList.contains('err'), true);
  assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
});
test('failed venue bootstrap never navigates the iframe to a fallback model', async () => {
  const c = modelContext();
  c.deps.window.WF.ready = Promise.reject(new Error('venue unavailable'));
  const result = handler('mp_preview.js', 'showBackground', c.deps)();
  assert.equal(await result, false);
  assert.equal(c.frame.src, '');
  assert.equal(c.loader.classList.contains('err'), true);
});
