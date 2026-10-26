const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../viewer/category_markers.js');
const category = (id = 'a', name = 'A') => ({ id, name });
const poi = (id, x, y, z, more = {}) => ({ id, x, y, z, venue: 'gcu', category_ids: ['a'], is_active: true, ...more });
const config = { venue: 'gcu' };

test('uses average X/Z and highest SDK Y with the configured offset', () => {
  const result = M.calculate([category()], [poi('1', 10, 2, 20), poi('2', 14, 2, 24), poi('3', 12, 5, 22), poi('4', 16, 5, 26)], config);
  assert.deepEqual(result.markers[0].position, { x: 13, y: 7, z: 23 });
  assert.equal(result.markers.length, 1);
  assert.equal(result.markers[0].name, 'A');
  assert.deepEqual(M.calculate([category()], [poi('one', 0, 0, 0)], { ...config, heightOffset: 4 }).markers[0].position, { x: 0, y: 4, z: 0 });
});
test('validates coordinates, preserving zero and numeric strings but never inventing an origin', () => {
  const rows = [poi('valid', '0', '0', '0'), ...[null, undefined, '', ' ', NaN, Infinity, false, [], {}].map((value, i) => poi('bad' + i, value, 1, 1))];
  const result = M.calculate([category(), category('empty', 'Empty')], rows, config);
  assert.deepEqual(result.markers[0].position, { x: 0, y: 2, z: 0 });
  assert.deepEqual(result.markers[0].poiIds, ['valid']);
  assert.deepEqual(result.diagnostics, [{ categoryId: 'empty', name: 'Empty', reason: 'no-valid-pois' }]);
});
test('deduplicates by source ID and excludes foreign, hidden and inactive POIs', () => {
  const result = M.calculate([category()], [poi('one', 1, 2, 3), poi('one', 1, 2, 3), poi('foreign', 100, 100, 100, { venue: 'other' }), poi('hidden', 50, 50, 50, { hidden: true }), poi('inactive', 50, 50, 50, { is_active: false })], config);
  assert.deepEqual(result.markers[0].poiIds, ['one']);
  assert.deepEqual(result.markers[0].position, { x: 1, y: 4, z: 3 });
});
test('memberships use category IDs, including secondary categories and equal names', () => {
  const result = M.calculate([category('a', 'Same'), category('b', 'Same')], [poi('one', 1, 2, 3, { category_ids: ['a', 'a', 'b', 'foreign-id'] }), poi('two', 3, 6, 5, { category_ids: ['b'] })], config);
  assert.equal(result.markers.length, 2);
  assert.deepEqual(result.markers.find(c => c.id === 'b').position, { x: 2, y: 8, z: 4 });
});
test('multiple floors use the highest Y; disconnected horizontal clusters are reported and skipped', () => {
  const rows = [poi('low', 0, -3, 0), poi('upper', 10, 15, 10)];
  assert.equal(M.calculate([category()], rows, config).markers[0].position.y, 17);
  const result = M.calculate([category()], [...rows, poi('far', 200, 1, 200)], config);
  assert.equal(result.markers.length, 0);
  assert.deepEqual(result.diagnostics[0].groups, [2, 1]);
  assert.equal(result.diagnostics[0].reason, 'distant-clusters');
});
test('visibility follows Dollhouse mode even while directions or navigation UI is open', () => {
  const visible = { background: true, rendered: true, mode: 'mode.dollhouse', uiMode: 'home' };
  assert.equal(M.isVisible(visible), true);
  assert.equal(M.isVisible({ ...visible, uiMode: 'nav' }), true);
  assert.equal(M.isVisible({ ...visible, uiMode: 'dir' }), true);
  for (const next of [{ mode: 'mode.inside' }, { mode: 'mode.floorplan' }, { background: false }, { rendered: false }, { transitioning: true }, { blocked: true }, { fullscreenTour: true }, { failed: true }]) assert.equal(M.isVisible({ ...visible, ...next }), false);
});
test('projection accounts for iframe cropping and rejects behind-camera and offscreen labels', () => {
  const pose = { position: { x: 0, y: 0, z: 10 }, rotation: { x: 0, y: 0 } };
  const frame = { left: 0, top: -56, width: 400, height: 928 }, bounds = { left: 0, top: 0, width: 400, height: 800 };
  const project = (point, convert = () => ({ x: 100, y: 100 })) => M.project(point, pose, frame, bounds, { w: 400, h: 928 }, convert);
  assert.deepEqual(project({ x: 0, y: 0, z: -10 }), { x: 100, y: 44 });
  assert.equal(project({ x: 0, y: 0, z: 20 }), null);
  assert.equal(project({ x: 0, y: 0, z: -10 }, () => ({ x: 100, y: 20 })), null);
  assert.equal(project({ x: 0, y: 0, z: -10 }, () => ({ x: NaN, y: 100 })), null);
});
test('projection follows yaw, pitch and viewport scaling during camera movements', () => {
  const frame = { left: 50, top: 20, width: 800, height: 600 }, bounds = { left: 50, top: 20, width: 800, height: 600 };
  const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: -90 } };
  assert.deepEqual(M.project({ x: 10, y: 0, z: 0 }, pose, frame, bounds, { w: 400, h: 300 }, () => ({ x: 100, y: 50 })), { x: 200, y: 100 });
  assert.equal(M.project({ x: -10, y: 0, z: 0 }, pose, frame, bounds, { w: 400, h: 300 }, () => ({ x: 100, y: 50 })), null);
});

function harness(fetcher) {
  const events = new Map(), frames = new Map(), all = [], cancelled = [];
  let frameId = 0;
  const eventTarget = () => ({ addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); } });
  const classSet = new Set(['mp-bg-mode', 'mp-frame-loaded']);
  const body = { classList: { contains: name => classSet.has(name) } };
  function element(tag) {
    const el = { tag, children: [], attributes: {}, hidden: false, style: { setProperty(key, value) { this[key] = value; } },
      setAttribute(key, value) { this.attributes[key] = value; },
      append(...nodes) { nodes.forEach(node => this.appendChild(node)); },
      appendChild(node) { this.children.push(node); node.parent = this; },
      remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
      getBoundingClientRect() {
        const x = parseFloat(this.style.left || '200'), y = parseFloat(this.style.top || '300');
        return { left: x - 50, right: x + 50, top: y - 44, bottom: y - 12, width: 100, height: 32 };
      } };
    all.push(el); return el;
  }
  const win = { AbortController, MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); }, ...eventTarget() };
  const doc = { defaultView: win, body, createElement: element, getElementById: () => null, querySelector: () => null, ...eventTarget() };
  const container = element('div'); container.ownerDocument = doc;
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 });
  const iframe = { clientWidth: 400, clientHeight: 928, getBoundingClientRect: () => ({ left: 0, top: -56, width: 400, height: 928 }) };
  const callbacks = {};
  const observable = (key, initial) => ({ getLatest: () => initial, subscribe(fn) { callbacks[key] = fn; fn(initial); return { cancel() { cancelled.push(key); } }; } });
  const initial = { position: { x: 0, y: 0, z: 20 }, rotation: { x: 0, y: 0 }, mode: 'mode.dollhouse' };
  const sdk = { Camera: { pose: observable('pose', initial) }, Mode: { current: observable('mode', 'mode.dollhouse'), transition: observable('transition', null) },
    Conversion: { worldToScreen: (position, pose) => ({ x: 200 + position.x - pose.position.x, y: 300 - position.y }) } };
  const context = { venue: 'gcu', pois: [{ id: 'one' }], uiMode: 'home' };
  const selections = [], diagnostics = [];
  let requests = 0;
  const controller = M.mount({ sdk, container, iframe, getContext: () => context, getStyle: c => ({ label: c.name, icon: 'menu_book', color: [10, 20, 30] }),
    onSelect: (...args) => selections.push(args), diagnostic: item => diagnostics.push(item), fetchData: async (...args) => { requests++; return fetcher ? fetcher(...args) : { building_slug: 'gcu', categories: [category()], pois: [poi('one', 0, 0, -10)] }; } });
  async function flush() {
    await new Promise(resolve => setImmediate(resolve));
    const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn());
  }
  return { controller, callbacks, cancelled, context, selections, diagnostics, events, container, sdk, body, classSet, all, flush, requests: () => requests };
}
test('DOM labels follow the camera without re-fetching data and clicks select a category, not a destination', async () => {
  const h = harness(); await h.flush();
  const layer = h.container.children[0], button = layer.children[0];
  assert.equal(layer.hidden, false); assert.equal(button.hidden, false);
  const firstX = button.style.left;
  h.callbacks.pose({ position: { x: 10, y: 0, z: 20 }, rotation: { x: 0, y: 0 }, mode: 'mode.dollhouse' }); await h.flush();
  assert.notEqual(button.style.left, firstX);
  button.onclick({ stopPropagation() {} });
  assert.deepEqual(h.selections, [['a', ['one'], 'A']]);
  h.callbacks.mode('mode.inside'); assert.equal(layer.hidden, true); await h.flush();
  button.onclick({ stopPropagation() {} }); assert.equal(h.selections.length, 1);
  assert.equal(h.requests(), 1);
  h.controller.dispose(); assert.equal(layer.removed, true);
  assert.deepEqual(h.cancelled.sort(), ['mode', 'pose', 'transition']);
  assert.equal(h.events.size, 0);
});
test('overlapping labels move apart without merging categories', async () => {
  const h = harness(async () => ({ building_slug: 'gcu', categories: [category(), category('b', 'B')], pois: [poi('one', 0, 0, -10, { category_ids: ['a', 'b'] })] }));
  await h.flush();
  const buttons = h.container.children[0].children;
  assert.equal(buttons.length, 2);
  assert.equal(buttons.filter(button => !button.hidden).length, 2);
  assert.notEqual(buttons[0].style.top, buttons[1].style.top);
  h.controller.dispose();
});
test('data updates recalculate centers without replacing the iframe or adding subscriptions', async () => {
  let x = 0;
  const h = harness(async () => ({ building_slug: 'gcu', categories: [category()], pois: [poi('one', x, 0, -10)] }));
  await h.flush(); const first = h.container.children[0].children[0].style.left;
  x = 30; h.events.get('wf-pois-updated')(); await h.flush();
  assert.notEqual(h.container.children[0].children[0].style.left, first);
  assert.equal(h.requests(), 2);
  assert.equal(Object.keys(h.callbacks).length, 3);
  h.controller.dispose();
});
test('optional data failure does not throw or leave blocking UI', async () => {
  const h = harness(async () => { throw new Error('unavailable'); }); await h.flush();
  assert.equal(h.container.children[0].hidden, true);
  assert.equal(h.diagnostics[0].reason, 'data-unavailable');
  h.controller.dispose();
});
test('stale venue responses never appear in another venue', async () => {
  let resolveFirst;
  const h = harness(venue => venue === 'gcu' ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ building_slug: 'new', categories: [], pois: [] }));
  h.context.venue = 'new'; h.controller.reload(); await h.flush();
  resolveFirst({ building_slug: 'gcu', categories: [category()], pois: [poi('one', 0, 0, -10)] }); await h.flush();
  assert.equal(h.container.children[0].children.length, 0);
  h.controller.dispose();
});
test('mismatched camera/mode events never flash labels over Inside view', async () => {
  const h = harness(); await h.flush();
  h.callbacks.pose({ position: { x: 0, y: 0, z: 20 }, rotation: { x: 0, y: 0 }, mode: 'mode.inside' });
  await h.flush(); assert.equal(h.container.children[0].hidden, true);
  h.controller.dispose();
});
test('Safari back/forward cache restores labels without another data fetch', async () => {
  const h = harness(); await h.flush();
  const layer = h.container.children[0];
  h.events.get('pagehide')({ persisted: true }); assert.equal(layer.hidden, true);
  h.events.get('pageshow')(); await h.flush(); assert.equal(layer.hidden, false);
  assert.equal(h.requests(), 1);
  h.controller.dispose();
});
test('opening a filtered POI list keeps every Dollhouse category marker visible', async () => {
  const h = harness(async () => ({ building_slug: 'gcu', categories: [category(), category('b', 'B')], pois: [poi('one', 0, 0, -10, { category_ids: ['a', 'b'] })] }));
  await h.flush(); assert.equal(h.container.children[0].children.length, 2);
  h.context.filter = 'b'; h.controller.refresh(); await h.flush();
  assert.equal(h.container.children[0].children.length, 2);
  assert.deepEqual(h.container.children[0].children.map(button => button.attributes['aria-label']).sort(), ['A', 'B']);
  assert.equal(h.requests(), 1);
  h.controller.dispose();
});
test('the actual category click handler reuses the list flow and preserves the destination', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../viewer/ui.js'), 'utf8');
  const start = source.indexOf('  function selectCategoryMarker('), end = source.indexOf('  function categoryMarkerContext(', start);
  const selected = [], destination = { id: 'existing-destination' }, S = { mode: 'home', to: destination, filter: 'library' };
  const handler = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
    wf: { categories: [{ id: 'library-id', name: 'Library' }] }, S,
    toggleChip: (key, ids) => selected.push({ key, ids: [...ids] }),
  });
  handler('library-id', ['one', 'two'], 'Library');
  assert.deepEqual(selected, [{ key: 'library', ids: ['one', 'two'] }]);
  assert.equal(S.to, destination);
  assert.equal(S.mode, 'home'); // Only toggleChip owns the existing list-state transition.
  S.mode = 'nav'; handler('library-id', ['one'], 'Library');
  assert.equal(selected.length, 1);
});

test('mobile packing displays ten crowded labels rather than hiding all but the first', () => {
  const bounds = { left: 0, top: 0, right: 390, bottom: 700 };
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i), rect: { left: 130 + i, right: 250 + i, top: 300, bottom: 332 } }));
  const placed = M.layout(items, bounds, true);
  assert.equal(placed.size, 10);
  const rects = [...placed.values()].map(item => item.rect);
  for (let i = 0; i < rects.length; i++) {
    assert.ok(rects[i].left >= 6 && rects[i].right <= 384);
    assert.ok(rects[i].top >= 6 && rects[i].bottom <= 694);
    for (let j = i + 1; j < rects.length; j++) assert.equal(M.overlaps(rects[i], rects[j], 3), false);
  }
  for (const item of placed.values()) assert.ok(Math.hypot(item.x, item.y) <= 120);
});
test('labels at viewport edges are kept visible with bounded connector offsets', () => {
  const placed = M.layout([{ id: 'edge', rect: { left: -40, right: 80, top: -10, bottom: 22 } }], { left: 0, top: 0, right: 390, bottom: 700 }, true);
  assert.equal(placed.size, 1);
  assert.ok(placed.get('edge').rect.left >= 6);
  assert.ok(placed.get('edge').rect.top >= 6);
});
test('unchanged camera positions keep label placements stable across repeated frames', () => {
  const bounds = { left: 0, top: 0, right: 390, bottom: 700 };
  const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), rect: { left: 130 + i, right: 250 + i, top: 300, bottom: 332 } }));
  const first = M.layout(items, bounds, true);
  const second = M.layout(items.map(item => ({ ...item, previous: first.get(item.id) })), bounds, true);
  assert.deepEqual([...second].map(([id, p]) => [id, p.x, p.y]), [...first].map(([id, p]) => [id, p.x, p.y]));
});

test('category markers avoid the weather badge while retaining a selectable label', () => {
  const obstacle = { left: 300, right: 382, top: 66, bottom: 98 };
  const placed = M.layout([{ id: 'cafeteria', rect: { left: 270, right: 380, top: 65, bottom: 97 } }],
    { left: 0, top: 0, right: 390, bottom: 700 }, true, [obstacle]);
  assert.equal(placed.size, 1);
  assert.equal(M.overlaps(placed.get('cafeteria').rect, obstacle, 3), false);
});
