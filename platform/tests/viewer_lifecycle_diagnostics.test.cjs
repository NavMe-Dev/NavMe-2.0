// Local-only diagnostic evidence must distinguish lifecycle events without retaining secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/viewer_lifecycle.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function target() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      const callbacks = listeners.get(name);
      if (callbacks) { callbacks.delete(callback); if (!callbacks.size) listeners.delete(name); }
    },
    dispatch(name, event = {}) {
      for (const callback of Array.from(listeners.get(name) || [])) callback({currentTarget: this, ...event});
    },
    listenerCount() { return Array.from(listeners.values()).reduce((sum, callbacks) => sum + callbacks.size, 0); }
  };
}

function fixture(navigationType = 'navigate') {
  let currentFrame = null;
  const observers = [];
  const document = Object.assign(target(), {documentElement: {}, visibilityState: 'visible',
    getElementById: id => id === 'mpFrame' ? currentFrame : null});
  const window = Object.assign(target(), {document,
    location: {href: 'https://viewer.test/unc-charlotte?access=SECRET_ACCESS'},
    performance: {now: () => 1234.5, getEntriesByType: () => [{type: navigationType}]}});
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(node) { this.node = node; this.active = true; }
    disconnect() { this.active = false; }
  }
  const context = {window, MutationObserver, URL, Date, Math, Number, Set, WeakMap};
  vm.createContext(context);
  const install = () => vm.runInContext(source, context);
  install();
  function mutate(node, changes) {
    for (const observer of Array.from(observers)) if (observer.active && observer.node === node) observer.callback(changes);
  }
  function frame(src = '') {
    const result = Object.assign(target(), {isConnected: true, src, contentDocument: null,
      getAttribute(name) { return name === 'src' ? this.src : null; }});
    return result;
  }
  function attach(next, removedNodes = []) {
    currentFrame = next;
    mutate(document.documentElement, [{removedNodes}]);
  }
  return {window, document, observers, install, frame, attach,
    api: window.WFViewerLifecycle,
    snapshot: () => plain(window.WFViewerLifecycle.snapshot()),
    source(next, value) { const oldValue = next.src; next.src = value; mutate(next, [{oldValue}]); }
  };
}

test('lifecycle metadata excludes credentials, URLs, POIs, search text and raw JavaScript errors', () => {
  const f = fixture();
  f.api.record('sdk.init.start', {attempt: 1, generation: 2, modelId: 'PRIVATE_MODEL',
    password: 'SECRET_PASSWORD', applicationKey: 'SECRET_KEY', url: 'https://viewer.test/?token=SECRET_TOKEN'});
  f.api.record('navigation', {action: 'poi-select', poi: 'SECRET_POI', search: 'SECRET_SEARCH'});
  f.api.record('loading', {phase: 'ready', reason: 'SECRET_REASON', message: 'SECRET_MESSAGE'});
  f.window.dispatch('error', {error: new Error('WebGL context lost; password=SECRET_ERROR')});
  f.window.dispatch('unhandledrejection', {reason: new Error('Failed to fetch token SECRET_REJECTION')});
  f.api.record('SECRET_EVENT', {attempt: 3});
  const snapshot = f.snapshot(), serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /SECRET|PRIVATE_MODEL|https:\/\//);
  assert.equal(snapshot.counts['sdk.init.start'], 1);
  assert.equal(snapshot.counts['javascript.error'], 2);
  assert.match(snapshot.events.find(event => event.event === 'sdk.init.start').modelId, /^model-[0-9a-f]+$/);
  assert.deepEqual(snapshot.events.filter(event => event.event === 'javascript.error').map(event => event.kind), ['webgl', 'network']);
  assert.ok(snapshot.events.every(event => /^\d{4}-\d{2}-\d{2}T/.test(event.time) && event.elapsedMs === 1235));
});

test('diagnostic history is bounded while total counters and snapshot isolation remain accurate', () => {
  const f = fixture();
  for (let i = 0; i < 300; i++) f.api.record('loading', {phase: 'ready', generation: i});
  const snapshot = f.snapshot();
  assert.equal(snapshot.events.length, 256);
  assert.equal(snapshot.counts.loading, 300);
  assert.equal(snapshot.events[0].generation, 44);
  assert.equal(snapshot.events.at(-1).generation, 299);
  const mutable = f.api.snapshot();
  mutable.counts.loading = 0; mutable.events[0].phase = 'tampered';
  assert.equal(f.snapshot().counts.loading, 300);
  assert.equal(f.snapshot().events[0].phase, 'ready');
});

test('document navigation, iframe source revisions and iframe load events remain distinct', () => {
  const f = fixture('reload');
  const frame = f.frame(); f.attach(frame);
  f.source(frame, 'https://my.matterport.com/show/?m=MODEL_A&applicationKey=SECRET_KEY');
  frame.dispatch('load');
  f.source(frame, 'about:blank');
  frame.dispatch('load');
  f.source(frame, 'https://my.matterport.com/show/?m=MODEL_B&applicationKey=SECRET_KEY');
  const snapshot = f.snapshot();
  assert.equal(snapshot.counts['document.load'], 1);
  assert.equal(snapshot.events[0].navigationType, 'reload');
  assert.equal(snapshot.counts['iframe.create'], 1);
  assert.equal(snapshot.counts['iframe.source'], 3);
  assert.equal(snapshot.counts['iframe.load'], 2);
  assert.deepEqual(snapshot.events.filter(event => event.event === 'iframe.source').map(event => event.source), ['matterport', 'blank', 'matterport']);
  assert.deepEqual(snapshot.events.filter(event => event.event === 'iframe.source').map(event => event.revision), [1, 2, 3]);
  assert.equal(new Set(snapshot.events.filter(event => event.frameId).map(event => event.frameId)).size, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /MODEL_A|MODEL_B|SECRET_KEY/);
  assert.match(snapshot.limitations[0], /load alone does not prove an iframe reload/);
});

test('same-node removal and reinsertion is distinguishable from creating a replacement iframe', () => {
  const f = fixture(), first = f.frame(); f.attach(first);
  // Browsers may have reinserted the node before MutationObserver runs.
  f.attach(first, [first]);
  let snapshot = f.snapshot();
  assert.equal(snapshot.counts['iframe.create'], 2);
  assert.equal(snapshot.counts['iframe.destroy'], 1);
  assert.deepEqual(snapshot.events.filter(event => event.event === 'iframe.create').map(event => event.frameId), [1, 1]);
  first.isConnected = false;
  const second = f.frame(); f.attach(second, [first]);
  snapshot = f.snapshot();
  assert.equal(snapshot.counts['iframe.create'], 3);
  assert.equal(snapshot.counts['iframe.destroy'], 2);
  assert.deepEqual(snapshot.events.filter(event => event.event === 'iframe.create').map(event => event.frameId), [1, 1, 2]);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 1);
});

test('duplicate script installation preserves one diagnostic observer and document identity', () => {
  const f = fixture(), original = f.api, identity = f.snapshot().documentId;
  const observers = f.observers.length, listeners = f.window.listenerCount();
  f.install(); f.install();
  assert.equal(f.window.WFViewerLifecycle, original);
  assert.equal(f.snapshot().documentId, identity);
  assert.equal(f.snapshot().counts['document.load'], 1);
  assert.equal(f.snapshot().counts['viewer.mount'], 1);
  assert.equal(f.observers.length, observers);
  assert.equal(f.window.listenerCount(), listeners);
});

test('BFCache preserves viewer identity; a real unload cleans diagnostic listeners and observers', () => {
  const f = fixture('back_forward'), frame = f.frame(); f.attach(frame);
  const identity = f.snapshot().documentId;
  f.window.dispatch('pagehide', {persisted: true});
  f.document.visibilityState = 'hidden'; f.document.dispatch('visibilitychange');
  f.window.dispatch('pageshow', {persisted: true});
  let snapshot = f.snapshot();
  assert.equal(snapshot.documentId, identity);
  assert.equal(snapshot.counts['viewer.mount'], 1);
  assert.equal(snapshot.counts['viewer.unmount'], undefined);
  assert.equal(snapshot.counts['iframe.create'], 1);
  assert.equal(snapshot.events.find(event => event.event === 'page.visibility').visibility, 'hidden');
  f.window.dispatch('pagehide', {persisted: false});
  snapshot = f.snapshot();
  assert.equal(snapshot.counts['viewer.unmount'], 1);
  assert.equal(f.window.listenerCount(), 0);
  assert.equal(f.document.listenerCount(), 0);
  assert.equal(frame.listenerCount(), 0);
  assert.ok(f.observers.every(observer => !observer.active));
  f.api.record('loading', {phase: 'ready'});
  assert.deepEqual(f.snapshot(), snapshot);
});

test('WebGL evidence records observable events and identifies cross-origin visibility limits', () => {
  const f = fixture(), frame = f.frame(), sameOriginDocument = target();
  frame.contentDocument = sameOriginDocument; f.attach(frame); frame.dispatch('load');
  sameOriginDocument.dispatch('webglcontextlost'); sameOriginDocument.dispatch('webglcontextrestored');
  f.document.dispatch('webglcontextlost');
  let snapshot = f.snapshot();
  assert.deepEqual(snapshot.events.filter(event => event.event === 'webgl.context.lost').map(event => event.scope), ['same-origin-frame', 'parent']);
  assert.equal(snapshot.counts['webgl.context.restored'], 1);
  Object.defineProperty(frame, 'contentDocument', {get() { throw new Error('Cross-origin access denied'); }});
  frame.dispatch('load'); snapshot = f.snapshot();
  assert.equal(snapshot.events.at(-1).scope, 'cross-origin-frame');
  assert.equal(sameOriginDocument.listenerCount(), 0);
});
