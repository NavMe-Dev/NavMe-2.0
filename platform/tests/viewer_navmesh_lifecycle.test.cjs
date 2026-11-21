const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/wf_navmesh_route.js'), 'utf8');

async function fixture(scenario = 'success') {
  let created = 0, destroyed = 0, closest = 0;
  const points = [{x: 0, y: 0, z: 0}, {x: 3, y: 0, z: 4}];
  const context = {Uint8Array,
    window: {NavMeshRT: {
      init: async () => {},
      importNavMesh: () => ({navMesh: {destroy() {}}}),
      NavMeshQuery: class {
        constructor() {
          if (scenario === 'constructor-error') throw new Error('no query');
          created++;
        }
        findClosestPoint(point) {
          closest++;
          if (scenario === 'closest-error') throw new Error('closest failed');
          if (scenario === 'no-start' && closest === 1) return null;
          if (scenario === 'no-destination' && closest === 2) return null;
          return {point};
        }
        computePath() {
          if (scenario === 'path-error') throw new Error('path failed');
          return {path: scenario === 'empty-path' ? [] : points};
        }
        destroy() {
          destroyed++;
          if (scenario === 'cleanup-error') throw new Error('cleanup failed');
        }
      },
    }},
    fetch: async () => ({ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer}),
  };
  vm.runInNewContext(source, context);
  await context.window.WFNavmeshRoute.load('/local-test.navmesh', 'uncc-test');
  return {route: () => context.window.WFNavmeshRoute.route(points[0], points[1]),
    replace: () => context.window.WFNavmeshRoute.load('/replacement.navmesh', 'replacement'),
    counts: () => ({created, destroyed}), points};
}

test('repeated successful routes reuse one native query and retain exact copied geometry', async () => {
  const f = await fixture();
  for (let index = 0; index < 100; index++) {
    const result = f.route();
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.path)), f.points);
    assert.equal(result.length_m, 5);
    assert.equal(result.start_gap_m, 0);
    assert.equal(result.end_gap_m, 0);
    assert.equal(result.partial, false);
  }
  assert.deepEqual(f.counts(), {created: 1, destroyed: 0});
  await f.replace();
  assert.deepEqual(f.counts(), {created: 1, destroyed: 1});
  assert.equal(f.route().ok, true);
  assert.deepEqual(f.counts(), {created: 2, destroyed: 1});
});

for (const [scenario, error] of [['no-start', 'Start is not on the navmesh'],
  ['no-destination', 'Destination is not on the navmesh'],
  ['empty-path', 'No path between those points'], ['path-error', 'computePath: path failed']]) {
  test(`${scenario} preserves its error and releases the retained query on mesh replacement`, async () => {
    const f = await fixture(scenario);
    const result = f.route();
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.deepEqual(f.counts(), {created: 1, destroyed: 0});
    await f.replace();
    assert.deepEqual(f.counts(), {created: 1, destroyed: 1});
  });
}

test('closest-point errors preserve their exception and release the query on mesh replacement', async () => {
  const f = await fixture('closest-error');
  assert.throws(f.route, /closest failed/);
  assert.deepEqual(f.counts(), {created: 1, destroyed: 0});
  await f.replace();
  assert.deepEqual(f.counts(), {created: 1, destroyed: 1});
});

test('a constructor failure preserves the existing error without cleaning an absent query', async () => {
  const f = await fixture('constructor-error');
  assert.equal(f.route().error, 'NavMeshQuery failed: no query');
  assert.deepEqual(f.counts(), {created: 0, destroyed: 0});
});

test('query cleanup failure cannot block mesh replacement or replace a valid route', async () => {
  const f = await fixture('cleanup-error');
  assert.equal(f.route().ok, true);
  assert.deepEqual(f.counts(), {created: 1, destroyed: 0});
  await f.replace();
  assert.equal(f.route().ok, true);
  assert.deepEqual(f.counts(), {created: 2, destroyed: 1});
});
