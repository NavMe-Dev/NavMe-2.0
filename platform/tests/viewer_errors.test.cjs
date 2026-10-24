// Run with: node --test platform/tests/viewer_errors.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const viewer = path.resolve(__dirname, '../viewer');
const messages = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../locales/en.json'))).viewer;
const read = name => fs.readFileSync(path.join(viewer, name), 'utf8');
// Execute the actual legacy handler with controlled browser dependencies, without
// initializing the map renderer or connecting to external services.
function handler(file, name, dependencies) {
  const source = read(file);
  const pattern = new RegExp('(?:async )?function ' + name + '\\(');
  const start = source.search(pattern);
  assert.ok(start >= 0, name);
  for (let end = source.indexOf('}', start); end >= 0; end = source.indexOf('}', end + 1)) {
    let script;
    try { script = new vm.Script('(' + source.slice(start, end + 1) + ')'); } catch { continue; }
    return script.runInNewContext(dependencies);
  }
  throw Error('Cannot parse ' + name);
}
const quiet = { warn() {}, info() {} };
const t = key => messages[key.replace('viewer.', '')];
function photoContext(response) {
  const shown = [], applied = [], logged = [];
  return { shown, applied, logged, deps: {
    toast: msg => shown.push(msg), t, shrinkImage: async () => ({}),
    FormData: class { append() {} }, window: {}, vpsLocalizeUrl: () => '/photo',
    fetch: async () => response, wfDbg: (...args) => logged.push(args),
    applyVpsResult: result => applied.push(result),
  }};
}
test('failed photo match hides raw server details and never applies a position', async () => {
  const c = photoContext({ ok: true, json: async () => ({ success: false, message: 'private backend detail' }) });
  await handler('ui.js', 'runVpsLocalize', c.deps)({});
  assert.equal(c.shown.at(-1), messages.vpsFailed);
  assert.equal(c.applied.length, 0);
  assert.ok(!c.shown.join().includes('private backend detail'));
});
test('uncertain photo fix preserves the previously selected location', async () => {
  const c = photoContext({ ok: true, json: async () => ({ success: true, confidence: 0.1, x: 42 }) });
  await handler('ui.js', 'runVpsLocalize', c.deps)({});
  assert.equal(c.shown.at(-1), messages.vpsLowConf);
  assert.equal(c.applied.length, 0);
});
test('confident photo fix still follows the existing apply workflow', async () => {
  const result = { success: true, confidence: 0.9, x: 42 };
  const c = photoContext({ ok: true, json: async () => result });
  await handler('ui.js', 'runVpsLocalize', c.deps)({});
  assert.deepEqual(c.applied, [result]);
});
test('photo HTTP errors hide backend details while recording status', async () => {
  for (const status of [404, 500, 501]) {
    const c = photoContext({ ok: false, status, json: async () => ({ detail: 'private backend detail' }) });
    await handler('ui.js', 'runVpsLocalize', c.deps)({});
    assert.equal(c.shown.at(-1), status === 501 ? messages.vpsNotConfigured : messages.vpsError);
    assert.equal(c.logged[0][3].status, status);
    assert.equal(c.applied.length, 0);
  }
});
test('denied GPS permission shows settings guidance without requesting GPS again', async () => {
  const shown = [];
  let requested = false;
  await handler('ui.js', 'locateMe', {
    navigator: { permissions: { query: async () => ({ state: 'denied' }) },
      geolocation: { getCurrentPosition() { requested = true; } } },
    t, showLocateFallback: msg => shown.push(msg),
  })();
  assert.equal(requested, false);
  assert.deepEqual(shown, [messages.geoDeniedRetry]);
});
test('GPS timeout, denial and unavailability retain recovery guidance', async () => {
  for (const [code, key] of [[1, 'geoDeniedRetry'], [2, 'geoFailed'], [3, 'geoTimeout']]) {
    const shown = [];
    await handler('ui.js', 'locateMe', {
      navigator: { geolocation: { getCurrentPosition(ok, fail) { fail({ code }); } } },
      t, showLocateFallback: msg => shown.push(msg), setLocateBusy() {}, toast() {},
    })();
    assert.deepEqual(shown, [messages[key]]);
  }
});
test('poor GPS is rejected outdoors as well as indoors; accuracy remains available to caller', () => {
  for (const indoors of [true, false]) {
    const snap = handler('ui.js', 'snapGpsToGraph', {
      wf: { llToModel: () => [1, 2] }, insideModel: () => indoors,
      GPS_ACC_OK: 50, GPS_INDOOR_ACC: 15,
    })(10, 20, 100);
    assert.equal(snap.kind, 'indoor_poor');
    assert.equal(snap.indoors, indoors);
  }
});
test('step-free failure offers Walking with a stairs warning and reuses recalculation', () => {
  let html, recalculated = false;
  const button = {};
  const state = { mode: 'dir', stepFree: true };
  handler('ui.js', 'onRoute', {
    S: state, t, esc: value => value, setSheet: value => { html = value; },
    $: () => button, syncDirFields() {}, computeRoute() { recalculated = true; },
  })(null);
  assert.ok(html.includes(messages.noRouteStepFree));
  assert.ok(html.includes('Walking may include stairs.'));
  button.onclick();
  assert.equal(state.stepFree, false);
  assert.equal(recalculated, true);
});
test('camera permission denial ends live retries and never uploads an image', async () => {
  const shown = [], timers = [];
  let stopped = false, uploaded = false;
  const deps = {
    locateActive: true, locateBusy: false, setStatus: msg => shown.push(msg),
    captureFrameBlob: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
    console: quiet, stopLocateFromMe() { stopped = true; deps.locateActive = false; },
    wait: async () => {}, setTimeout: fn => timers.push(fn), fetch: () => { uploaded = true; },
  };
  // The sandbox object itself is contextified, so stopping updates locateActive.
  await handler('threed_nav.js', 'runLocateCycle', deps)(true);
  assert.equal(stopped, true);
  assert.equal(uploaded, false);
  assert.equal(timers.length, 0);
  assert.equal(shown.at(-1), messages.cameraUnavailable);
});
test('fullscreen missing/corrupt payload shows a safe, working back action', () => {
  for (const file of ['tour.html', 'walkthrough.html']) {
    for (const payload of [null, '{broken']) {
      const boot = { append(...children) { this.children = children; } };
      let wentBack = false;
      const scripts = [...read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)];
      vm.runInNewContext(scripts[0][1], {
        window: {}, document: { getElementById: () => boot, createElement: () => ({ style: {} }) },
        sessionStorage: { getItem: () => payload },
        history: { length: 2, back() { wentBack = true; } },
      });
      assert.ok(boot.children[0].textContent.startsWith("Couldn't open"));
      const back = boot.children.at(-1);
      assert.equal(back.href, './');
      back.onclick({ preventDefault() {} });
      assert.equal(wentBack, true);
    }
  }
});
test('chat HTTP and network failures never render server error details', async () => {
  for (const networkFailure of [false, true]) {
    const shown = [];
    const input = { value: 'help' };
    const elements = { wfChatInput: input, wfChatSend: {}, wfChatLog: { lastElementChild: {} } };
    const state = { busy: false, history: [] };
    await handler('wf_chat.js', 'onSubmit', {
      $: key => elements[key], STATE: state, addBubble() {}, API_CHAT: '/chat',
      buildingSlug: () => 'test', localeHint: () => 'en', console: quiet,
      fetch: async () => {
        if (networkFailure) throw new Error('private network detail');
        return { ok: false, status: 500, json: async () => ({ detail: 'private backend detail' }) };
      },
      setBubbleContent: (bubble, text) => shown.push(text),
    })({ preventDefault() {} });
    assert.deepEqual(shown, ["We couldn't connect to the chat right now. Check your internet connection and try again."]);
    assert.equal(state.busy, false);
    assert.equal(elements.wfChatSend.disabled, false);
  }
});
test('partially completed tours preserve skipped counts and singular/plural grammar', async () => {
  for (const failures of [1, 2, 5]) {
    const shown = [];
    await handler('mp_preview.js', 'play', {
      mpSdk: {}, phaseConsts: () => ({}), readPhase: async () => null,
      sweepIds: Array(failures + 1).fill('stop'), stepI: 0, playing: false, stopped: false,
      setStatus: text => shown.push(text), startCountdown() {}, updateDirArrow() {},
      updateDistHud() {}, moveTo: async i => i === 0, tourPaceScale: 1,
      setTimeout: fn => fn(), stopCountdown() {}, hideDirArrow() {}, hideDistHud() {}, window: {},
    })();
    assert.equal(shown.at(-1), `Your tour is complete, but ${failures} ${failures === 1 ? 'stop' : 'stops'} couldn't be shown. You can explore the available stops again.`);
  }
});
test('tour failure does not claim completion when every stop fails', async () => {
  const shown = [];
  await handler('mp_preview.js', 'play', {
    mpSdk: {}, phaseConsts: () => ({}), readPhase: async () => null,
    sweepIds: ['stop'], stepI: 0, playing: false, stopped: false,
    setStatus: text => shown.push(text), startCountdown() {}, updateDirArrow() {},
    updateDistHud() {}, moveTo: async () => false, tourPaceScale: 1,
    setTimeout: fn => fn(), stopCountdown() {}, hideDirArrow() {}, hideDistHud() {}, window: {},
  })();
  assert.equal(shown.at(-1), messages.tourUnavailable);
});
test('map boot failure hides internal fetch details and retry preserves the current URL', async () => {
  const attached = [];
  let reloaded = false;
  const context = {
    window: { WF_CONFIG: {} }, location: { search: '?b=test&mp=1', reload() { reloaded = true; } },
    URLSearchParams, fetch: async () => { throw new Error('private server detail'); },
    document: { createElement: () => ({ style: {}, append(...children) { this.children = children; } }),
      body: { appendChild: el => attached.push(el) } }, console: { error() {} },
  };
  vm.runInNewContext(read('wf-boot.js'), context);
  await context.window.WF.ready.catch(() => {});
  assert.equal(attached.length, 1);
  const [heading, description, retry] = attached[0].children;
  assert.equal(heading.textContent, 'Map unavailable');
  assert.equal(description.textContent, messages.loadError);
  assert.ok(!description.textContent.includes('private server detail'));
  retry.onclick();
  assert.equal(reloaded, true);
  assert.equal(context.location.search, '?b=test&mp=1');
});
