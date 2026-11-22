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
    return script.runInNewContext({trace() {}, ...dependencies});
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
test('late readiness and duplicate begin cannot reopen a completed loader', () => {
  const c = startup(true); c.state.begin(1); c.state.modelReady(1); c.state.uiReady(1);
  assert.equal(c.loader.hidden, true);
  c.state.uiReady(1); c.state.modelVisible(1); c.state.modelReady(1); c.state.begin(1);
  assert.equal(c.loader.hidden, true);
  assert.equal(c.body.classList.contains('mp-startup-complete'), true);
  assert.equal(c.body.classList.contains('booting'), false);
  assert.equal(c.timers.size, 0);
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
  const session = {epoch:1, identity:"test-model"};
  let onPhase = () => {};
  const sdk = { App: { state: { subscribe(callback) { onPhase = callback; return { cancel() { calls.push('unsubscribe'); } }; } } }, Mode: { Mode: { DOLLHOUSE: 'dollhouse' }, moveTo: async target => { calls.push(target === 'dollhouse' ? 'mode' : target); await mode.promise; } } };
  const deps = {
    backgroundSession:session, viewerEpoch:1, viewerIdentity:()=>"test-model", viewerTrace() {}, monitorBackground() {}, modelId:"test-model",
    categoryMarkers: null, openGen: 0, mpSdk: null, applicationKey: 'test', window: { WFStartup: c.state, WF: { ready: Promise.resolve() } },
    document: { body: c.body }, $: id => id === 'mpFrame' ? frame : overlay,
    ensureOverlay() {}, setStatus() {}, resolveConfig: async () => ({modelId:"test-model",applicationKey:"test"}),
    showcaseUrl: () => 'https://example.invalid/model', waitIframeLoad: () => load.promise,
    resetFrameIfNeeded: async () => {}, loadSdkScript: async () => {}, connectSdk: async () => sdk,
    phaseConsts: () => ({ STARTING: 'starting', PLAYING: 'playing' }),
    waitPlaying: () => playing.promise, frameWholeBuilding: async () => { calls.push('frame'); },
    requestAnimationFrame: fn => fn(), console: { warn() {} },
    ...overrides,
  };
  return { ...c, load, playing, mode, frame, calls, deps, session, emitPhase: phase => onPhase({ phase }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('cached model becomes visible before camera fly-in finishes, with controls still hidden', async () => {
  const c = modelContext();
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  await tick(); c.load.resolve(); await tick();
  assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
  c.playing.resolve(true); await tick();
  assert.equal(c.body.classList.contains('mp-frame-loaded'), true);
  assert.equal(c.body.classList.contains('booting'), true);
  c.mode.resolve(); assert.equal(await result, true);
  assert.deepEqual(c.calls, ['unsubscribe', 'mode', 'frame']);
  assert.equal(c.body.classList.contains('mp-frame-loaded'), true);
  assert.equal(c.text.textContent, 'Preparing your experience…');
  assert.equal(c.frame.src, 'https://example.invalid/model');
});
test('SDK/model connection failure keeps the branded error surface', async () => {
  const c = modelContext({ connectSdk: async () => null });
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  c.load.resolve();
  assert.equal(await result, false);
  assert.equal(c.loader.classList.contains('err'), true);
  assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
});
test('failed venue bootstrap never navigates the iframe to a fallback model', async () => {
  const c = modelContext();
  c.deps.window.WF.ready = Promise.reject(new Error('venue unavailable'));
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  assert.equal(await result, false);
  assert.equal(c.frame.src, '');
  assert.equal(c.loader.classList.contains('err'), true);
});

test('model starts from validated config while optional floor and DOM readiness are pending', async () => {
  const c = modelContext(), later = deferred();
  c.deps.window.WF.ready = later.promise;
  c.deps.window.WF.configReady = Promise.resolve({ matterport_model_id: 'campus-model' });
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  await tick();
  assert.equal(c.frame.src, 'https://example.invalid/model');
  assert.equal(c.body.classList.contains('booting'), true);
  c.load.resolve(); c.playing.resolve(true); c.mode.resolve();
  assert.equal(await result, true);
  later.resolve();
});

test('rejected early config prevents model navigation even while the remaining bootstrap is pending', async () => {
  const c = modelContext();
  c.deps.window.WF.ready = deferred().promise;
  c.deps.window.WF.configReady = Promise.reject(new Error('published config unavailable'));
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  assert.equal(await result, false);
  assert.equal(c.frame.src, '');
  assert.equal(c.loader.classList.contains('err'), true);
});

test('SDK bootstrap starts while the iframe is still loading', async () => {
  const c = modelContext();
  let sdkLoads = 0, connections = 0;
  const connect = c.deps.connectSdk;
  c.deps.loadSdkScript = async () => { sdkLoads++; };
  c.deps.connectSdk = async frame => { connections++; return connect(frame); };
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  await tick();
  assert.equal(c.frame.src, 'https://example.invalid/model');
  assert.equal(sdkLoads, 1);
  assert.equal(connections, 0, 'SDK connection still waits for the real iframe load');
  c.load.resolve(); c.playing.resolve(true); c.mode.resolve();
  assert.equal(await result, true);
  assert.equal(connections, 1);
});

test('Matterport STARTING reveals the original entrance effect before PLAYING', async () => {
  const c = modelContext();
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  c.load.resolve(); await tick();
  c.emitPhase('loading'); await tick();
  assert.equal(c.body.classList.contains('mp-frame-loaded'), false);
  c.emitPhase('starting'); await tick();
  assert.equal(c.body.classList.contains('mp-frame-loaded'), true);
  assert.equal(c.text.textContent, 'Preparing your experience…');
  assert.equal(c.body.classList.contains('booting'), true);
  assert.equal(c.calls.includes('mode'), false);
  c.playing.resolve(true); await tick();
  assert.equal(c.calls.includes('mode'), true);
  c.mode.resolve(); assert.equal(await result, true);
  assert.equal(c.calls.filter(call => call === 'mode').length, 1);
});
test('visible entrance animation does not by itself enable navigation controls', () => {
  const c = startup(); c.state.begin(1); c.state.uiReady(1); c.state.modelVisible(1);
  assert.equal(c.body.classList.contains('booting'), true);
  assert.equal(c.body.classList.contains('mp-startup-complete'), false);
  c.state.modelReady(1);
  assert.equal(c.body.classList.contains('mp-startup-complete'), true);
});

test('enhanceBgLoading removes subtitle during loading and animates progress smoothly without freezing', () => {
  const body = element();
  let observerCb = null;
  class MockMutationObserver {
    constructor(cb) { observerCb = cb; }
    observe() {}
    disconnect() {}
  }
  const subEl = { textContent: '' };
  const titleEl = { textContent: '' };
  const pctEl = { textContent: '' };
  let shellEl = null;
  const textEl = { textContent: 'Loading digital twin…' };
  const loader = {
    dataset: {},
    classList: body.classList,
    querySelector(sel) {
      if (sel === '#mpBgLoadingText') return textEl;
      return null;
    },
    insertBefore(child) { shellEl = child; },
    firstChild: null,
  };
  const doc = {
    body,
    createElement(tag) {
      return {
        tagName: tag,
        className: '',
        set innerHTML(html) {
          this._html = html;
          const subMatch = html.match(/<div class="navme-bg-splash-sub">(.*?)<\/div>/);
          subEl.textContent = subMatch ? subMatch[1] : '';
          const titleMatch = html.match(/<div class="navme-bg-splash-title">(.*?)<\/div>/);
          if (titleMatch) titleEl.textContent = titleMatch[1];
          const pctMatch = html.match(/<div class="navme-bg-splash-pct">(.*?)<\/div>/);
          if (pctMatch) pctEl.textContent = pctMatch[1];
        },
        querySelector(sel) {
          if (sel === '.navme-bg-splash-sub') return subEl;
          if (sel === '.navme-bg-splash-title') return titleEl;
          if (sel === '.navme-bg-splash-pct') return pctEl;
          return null;
        },
        classList: {
          toggle() {},
          contains() { return false; },
        },
      };
    },
  };
  let tickCb = null;
  const enhance = handler('mp_background.js', 'enhanceBgLoading', {
    document: doc,
    MutationObserver: MockMutationObserver,
    setInterval(fn) { tickCb = fn; return 100; },
    clearInterval() { tickCb = null; },
  });
  enhance(loader);
  assert.equal(loader.dataset.navmeEnhanced, '1');
  assert.equal(titleEl.textContent, 'Loading Wayfinding');
  assert.equal(subEl.textContent, ''); // Subtitle is empty during loading
  assert.equal(pctEl.textContent, '0%');
  assert.ok(tickCb !== null);

  // Smooth animation progresses toward 12% milestone
  tickCb();
  const tick1Pct = parseInt(pctEl.textContent, 10);
  assert.ok(tick1Pct >= 0 && tick1Pct <= 2);

  // Advance ticks until milestone target is reached
  for (let i = 0; i < 40; i++) tickCb();
  const midPct = parseInt(pctEl.textContent, 10);
  assert.ok(midPct >= 11, `Expected progress >= 11%, got ${midPct}%`);
  assert.equal(subEl.textContent, ''); // Subtitle remains empty

  // When approaching milestone target, continuous creep ensures it never freezes
  for (let i = 0; i < 40; i++) tickCb();
  const creepPct = parseInt(pctEl.textContent, 10);
  assert.ok(creepPct > midPct, `Expected continuous creep (${creepPct}% > ${midPct}%)`);
  assert.equal(subEl.textContent, '');

  // Update to waiting milestone (75%)
  textEl.textContent = 'Waiting for twin to be ready…';
  observerCb();
  assert.equal(subEl.textContent, '');

  // Advance ticks to reach ~75%
  for (let i = 0; i < 40; i++) tickCb();
  const waitingPct = parseInt(pctEl.textContent, 10);
  assert.ok(waitingPct >= 70, `Expected progress >= 70%, got ${waitingPct}%`);

  // Verify non-freezing progression past 73% (Problem 2)
  for (let i = 0; i < 50; i++) tickCb();
  const post75Pct = parseInt(pctEl.textContent, 10);
  assert.ok(post75Pct > waitingPct && post75Pct > 73, `Expected creep beyond 73%, got ${post75Pct}%`);
  assert.equal(subEl.textContent, '');

  // Error state displays error guidance and stops animation
  loader.classList.add('err');
  observerCb();
  assert.equal(titleEl.textContent, 'Unable to load NavMe');
  assert.equal(subEl.textContent, "We couldn't load your navigation experience. Please try again.");
  assert.equal(tickCb, null); // Timer cleared on error
});

test('startup lands in Dollhouse mode with category markers mounted and visible, without choosing a route', async () => {
  const c = modelContext();
  const sdk = { Mode: { Mode: { DOLLHOUSE: 'dollhouse', INSIDE: 'inside' },
    moveTo: async (mode, options) => {
      c.calls.push(mode);
      assert.equal(options.position, undefined);
    } }, Camera: { TransitionType: { FLY: 'fly' } } };
  c.deps.connectSdk = async () => sdk;
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  c.load.resolve(); c.playing.resolve(true); await tick();
  assert.deepEqual(c.calls, ['dollhouse', 'frame']);
  assert.equal(c.body.classList.contains('booting'), true);
  assert.equal(await result, true);
  assert.equal(c.frame.src, 'https://example.invalid/model');
});
test('failed Inside transition with deep link retains the working dollhouse and displays recovery guidance', async () => {
  const c = modelContext();
  const shown = [];
  c.deps.toast = text => shown.push(text);
  c.deps.WFQuery = () => new URLSearchParams('to=test');
  c.deps.connectSdk = async () => ({ Mode: { Mode: { DOLLHOUSE: 'dollhouse', INSIDE: 'inside' },
    moveTo: async mode => { if (mode === 'inside') throw new Error('SDK unavailable'); }
  } });
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  c.load.resolve(); c.playing.resolve(true);
  assert.equal(await result, true);
  assert.equal(c.loader.classList.contains('err'), false);
  assert.deepEqual(shown, ["We couldn't open the walkthrough right now. You can still explore the 3D view."]);
});

for (const slug of ['uncc-main-campus', 'gcu']) {
  test(`${slug} mobile restores dollhouse transition and mounts category markers`, async () => {
    const c = modelContext();
    let urlOptions = null, markerMounts = 0;
    c.deps.window.WF = { ready: Promise.resolve(), cfg: { slug } };
    c.deps.window.matchMedia = () => ({ matches: true });
    c.deps.window.WFCategoryMarkers = { mount() { markerMounts++; return { dispose() {} }; } };
    c.deps.showcaseUrl = (_key, _sweep, options) => { urlOptions = options; return 'https://example.invalid/native'; };
    const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
    c.mode.resolve();
    c.load.resolve(); c.playing.resolve(true);
    assert.equal(await result, true);
    assert.equal(!urlOptions || !urlOptions.nativeStartup, true);
    assert.deepEqual(c.calls, ['unsubscribe', 'mode', 'frame']);
    assert.equal(markerMounts, 1);
  });
}

test('iOS devices restore dollhouse transition and mount category markers even when matchMedia is desktop', async () => {
  const c = modelContext();
  let urlOptions = null, markerMounts = 0;
  c.deps.window.WF = { ready: Promise.resolve(), cfg: { slug: 'other-building' } };
  c.deps.window.matchMedia = () => ({ matches: false }); // desktop viewport
  c.deps.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone' };
  c.deps.window.WFCategoryMarkers = { mount() { markerMounts++; return { dispose() {} }; } };
  c.deps.showcaseUrl = (_key, _sweep, options) => { urlOptions = options; return 'https://example.invalid/native'; };
  const result = handler('mp_preview.js', 'initializeBackground', c.deps)(c.session);
  c.mode.resolve();
  c.load.resolve(); c.playing.resolve(true);
  assert.equal(await result, true);
  assert.equal(!urlOptions || !urlOptions.nativeStartup, true);
  assert.deepEqual(c.calls, ['unsubscribe', 'mode', 'frame']);
  assert.equal(markerMounts, 1);
});
