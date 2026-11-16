const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../viewer', file), 'utf8');

function bridge() {
  const scripts = [];
  const context = {window: {WFNavmeshRoute: {load: async () => {}}},
    document: {createElement: () => ({}), head: {appendChild: script => scripts.push(script)}},
    fetch: async () => ({ok: true, json: async () => ({url: '/local-test.navmesh'})}),
  };
  vm.runInNewContext(read('wf_navmesh_bridge.js'), context);
  return {context, scripts, init: () => context.window.WFNav.initNavmesh('uncc', {})};
}

test('a failed runtime script can be requested again on a later route', async () => {
  const f = bridge();
  const first = f.init();
  f.scripts[0].onerror();
  await assert.rejects(first, /runtime download failed/);
  const retry = f.init();
  assert.equal(f.scripts.length, 2);
  f.context.window.NavMeshRT = {};
  f.scripts[1].onload();
  await retry;
  assert.equal(f.context.window.WFNav.navmeshReady(), true);
  await f.init();
  assert.equal(f.scripts.length, 2, 'a ready runtime is reused');
});

test('concurrent initialization shares the pending runtime script request', async () => {
  const f = bridge();
  const requests = Array.from({length: 10}, () => f.init());
  assert.equal(f.scripts.length, 1);
  f.context.window.NavMeshRT = {};
  f.scripts[0].onload();
  await Promise.all(requests);
  assert.equal(f.context.window.WFNav.navmeshReady(), true);
});

function router({initialize, download = async () => ({ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer})}) {
  let initializations = 0, fetches = 0;
  const context = {Uint8Array,
    window: {NavMeshRT: {init: () => { initializations++; return initialize(); },
      importNavMesh: () => ({navMesh: {destroy() {}}})}},
    fetch: url => { fetches++; return download(url); },
  };
  vm.runInNewContext(read('wf_navmesh_route.js'), context);
  return {load: () => context.window.WFNavmeshRoute.load('/local-test.navmesh', 'uncc'),
    counts: () => ({initializations, fetches}), context};
}

test('a rejected runtime initialization can retry and the ready mesh stays cached', async () => {
  let attempts = 0;
  const f = router({initialize: async () => { if (++attempts === 1) throw new Error('temporary init failure'); }});
  await assert.rejects(f.load(), /temporary init failure/);
  await f.load();
  assert.equal(f.context.window.WFNavmeshRoute.isLoaded(), true);
  await f.load();
  assert.deepEqual(f.counts(), {initializations: 2, fetches: 1});
});

test('concurrent loads share the pending native runtime initialization', async () => {
  let finish;
  const f = router({initialize: () => new Promise(resolve => { finish = resolve; })});
  const requests = Array.from({length: 10}, () => f.load());
  assert.equal(f.counts().initializations, 1);
  finish();
  await Promise.all(requests);
  assert.equal(f.counts().initializations, 1);
});

test('a transient mesh download failure retries without reinitializing the native runtime', async () => {
  let downloads = 0;
  const f = router({initialize: async () => {}, download: async () => {
    if (++downloads === 1) return {ok: false, status: 503};
    return {ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer};
  }});
  await assert.rejects(f.load(), /navmesh download failed \(503\)/);
  await f.load();
  assert.deepEqual(f.counts(), {initializations: 1, fetches: 2});
});
