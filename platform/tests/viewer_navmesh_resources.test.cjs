const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../viewer/wf_navmesh_route.js'), 'utf8');
const from = {x: 0, y: 0, z: 0}, to = {x: 3, y: 0, z: 4};

async function fixture(options = {}) {
  const liveQueries = new Set(), livePolys = new Set();
  const events = [];
  let created = 0, destroyed = 0, polysDestroyed = 0, filtersCreated = 0;
  let meshesCreated = 0;
  class Query {
    constructor(mesh, config) {
      if (options.constructorError) throw new Error('query init failed');
      assert.equal(config.maxNodes, 16384);
      created++; liveQueries.add(this); this.snaps = 0;
      this.mesh = mesh;
      this.defaultFilter = config.defaultQueryFilter || {id: ++filtersCreated};
    }
    findClosestPoint(point) {
      const index = this.snaps++ % 2;
      if (options.snapError === index) throw new Error('snap failed');
      if (options.missingEndpoint === index) return {point: null};
      return {point, polyRef: index + 1};
    }
    computePath(a, b) {
      if (options.pathError) throw new Error('path failed');
      return {success: true, path: options.emptyPath ? [] : [a, b]};
    }
    findPath() {
      const polys = {size: 2, get: index => index + 1, destroy() {
        polysDestroyed++;
        assert.ok(livePolys.delete(polys), 'polygon allocation destroyed exactly once');
      }};
      livePolys.add(polys);
      return {success: true, polys};
    }
    destroy() {
      destroyed++;
      events.push('query-destroy:' + this.mesh.id);
      assert.ok(liveQueries.delete(this), 'query destroyed exactly once');
      if (options.destroyError) throw new Error('cleanup failed');
    }
  }
  const context = {
    window: {NavMeshRT: {init: async () => {}, importNavMesh() {
      const id = ++meshesCreated;
      return {navMesh: {id, destroy() { events.push('mesh-destroy:' + id); }}};
    }, NavMeshQuery: Query}},
    fetch: async () => ({ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer}),
  };
  vm.runInNewContext(source, context);
  const router = context.window.WFNavmeshRoute;
  await router.load('/campus.navmesh', 'campus');
  return {router, events, stats: () => ({created, destroyed, polysDestroyed, filtersCreated,
    liveQueries: liveQueries.size, livePolys: livePolys.size})};
}

function retained(fixture, count = 1) {
  assert.equal(fixture.stats().created, count);
  assert.equal(fixture.stats().destroyed, count - 1);
  assert.equal(fixture.stats().liveQueries, 1);
}

test('a successful route preserves its geometry and retains one reusable native query', async () => {
  const f = await fixture();
  const result = f.router.route(from, to);
  assert.equal(result.ok, true);
  assert.equal(result.length_m, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(result.path)), [from, to]);
  retained(f);
});

for (const missingEndpoint of [0, 1]) {
  test(`an unavailable ${missingEndpoint ? 'destination' : 'start'} retains the existing route error and query`, async () => {
    const f = await fixture({missingEndpoint});
    assert.equal(f.router.route(from, to).ok, false);
    retained(f);
  });
}

test('endpoint lookup errors retain their behavior without allocating another query', async () => {
  const f = await fixture({snapError: 0});
  assert.throws(() => f.router.route(from, to), /snap failed/);
  retained(f);
});

for (const option of ['pathError', 'emptyPath']) {
  test(`${option} returns the existing route error while retaining the native query`, async () => {
    const f = await fixture({[option]: true});
    const result = f.router.route(from, to);
    assert.equal(result.ok, false);
    assert.match(result.error, option === 'pathError' ? /path failed/ : /No path/);
    retained(f);
  });
}

test('100 route requests reuse one native query and filter', async () => {
  const f = await fixture();
  for (let index = 1; index <= 100; index++) {
    assert.equal(f.router.route(from, to).ok, true);
    retained(f);
    assert.equal(f.stats().filtersCreated, 1);
  }
});

test('visitor and diagnostic routes reuse one native filter across requests and models', async () => {
  const f = await fixture();
  f.router.route(from, to);
  f.router.routeDebug(from, to);
  await f.router.load('/another-campus.navmesh', 'another-campus');
  f.router.route(from, to);
  retained(f, 2);
  assert.equal(f.stats().filtersCreated, 1);
  assert.deepEqual(f.events, ['query-destroy:1', 'mesh-destroy:1']);
});

test('reloading the same navmesh preserves its cached query', async () => {
  const f = await fixture();
  f.router.route(from, to);
  await f.router.load('/campus.navmesh', 'campus');
  assert.equal(f.router.route(from, to).ok, true);
  retained(f);
  assert.deepEqual(f.events, []);
});

test('a replacement query cleanup failure cannot block the new mesh or change route results', async () => {
  for (const pathError of [false, true]) {
    const f = await fixture({destroyError: true, pathError});
    f.router.route(from, to);
    await f.router.load('/another-campus.navmesh', 'another-campus');
    const replacement = f.router.route(from, to);
    assert.equal(replacement.ok, !pathError);
    if (pathError) assert.match(replacement.error, /path failed/);
    retained(f, 2);
    assert.deepEqual(f.events, ['query-destroy:1', 'mesh-destroy:1']);
  }
});

test('a query constructor failure retains the existing initialization error', async () => {
  const f = await fixture({constructorError: true});
  assert.match(f.router.route(from, to).error, /query init failed/);
  assert.equal(f.stats().created, 0);
  assert.equal(f.stats().destroyed, 0);
});

test('route diagnostics retain the shared query and release their polygon allocation', async () => {
  const f = await fixture();
  const result = f.router.routeDebug(from, to);
  assert.equal(result.findPath_success, true);
  assert.equal(result.findPath_polys, 2);
  assert.equal(result.findPath_lastPoly_isEnd, true);
  assert.equal(result.pathPts, 2);
  retained(f);
  assert.equal(f.stats().polysDestroyed, 1);
  assert.equal(f.stats().livePolys, 0);
});

test('diagnostic path errors release polygons and retain the query before propagating', async () => {
  const f = await fixture({pathError: true});
  assert.throws(() => f.router.routeDebug(from, to), /path failed/);
  retained(f);
  assert.equal(f.stats().polysDestroyed, 1);
  assert.equal(f.stats().livePolys, 0);
});

test('diagnostic endpoint failures retain the query without allocating polygons', async () => {
  const f = await fixture({missingEndpoint: 0});
  assert.equal(f.router.routeDebug(from, to).pathPts, 0);
  retained(f);
  assert.equal(f.stats().polysDestroyed, 0);
});
