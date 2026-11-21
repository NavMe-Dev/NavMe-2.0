const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../viewer/ui.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

// Run the complete UI script and its real field/list handlers. Only the unrelated
// sheet layout, toast, and twin SDK are replaced, so these tests exercise the
// public openDirections -> focus -> autocomplete -> map picker -> route path.
function fixture({mp = true, locale = 'en'} = {}) {
  const nodes = new Map(), timers = [], routes = [], picks = [], localizeCalls = [], storage = new Map();
  const dictionary = JSON.parse(fs.readFileSync(path.join(__dirname, `../locales/${locale}.json`), 'utf8'));
  const document = {activeElement: null};
  const classes = () => {
    const values = new Set();
    return {add: (...names) => names.forEach(n => values.add(n)), remove: (...names) => names.forEach(n => values.delete(n)),
      contains: name => values.has(name), toggle(name, on = !values.has(name)) { on ? values.add(name) : values.delete(name); return on; }};
  };
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map(), attributes = new Map();
    const element = {id, value: '', hidden: true, classList: classes(), style: {setProperty() {}}, children: [],
      setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: key => attributes.get(key) ?? null,
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
      dispatch(name, props = {}) { const event = {preventDefault() {}, stopPropagation() {}, ...props}; for (const fn of listeners.get(name) || []) fn(event); this['on' + name]?.(event); },
      focus() { if (document.activeElement === this) return; document.activeElement?.blur(); document.activeElement = this; this.dispatch('focus'); },
      blur() { if (document.activeElement === this) { document.activeElement = null; this.dispatch('blur'); } },
      click() { this.dispatch('click'); }, select() {}, scrollIntoView() {},
      closest(selector) { return selector === '#chipsWrap' ? null : this; },
      getBoundingClientRect: () => ({top: 0, bottom: 60}),
      querySelectorAll(selector) { return selector === 'li[role=option]' ? this.children.filter(c => c.getAttribute('role') === 'option') : []; },
      querySelector() { return null; }};
    Object.defineProperty(element, 'innerHTML', {get() { return this.html || ''; }, set(html) {
      this.html = html; this.children = [];
      for (const match of html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)) {
        const idMatch = /\bid="([^"]+)"/.exec(match[1]);
        const childId = idMatch ? idMatch[1] : 'anonymous-' + nodes.size;
        nodes.delete(childId); // innerHTML replaces elements and their attributes.
        const child = node(childId);
        for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attr[1], attr[2]);
        child.textContent = match[2].replace(/<[^>]+>/g, ''); this.children.push(child);
      }
      for (const match of html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)) node(match[1]);
    }});
    nodes.set(id, element); return element;
  }
  for (const id of ['q', 'fromQ', 'toQ', 'fromField', 'toField', 'btnDirBack', 'btnDirX', 'btnSwap', 'fromNotRight',
    'fromMeta', 'fromAcc', 'searchBox', 'dirBox', 'acClose', 'acList', 'sheet', 'top', 'chipsWrap', 'btnMe']) node(id);
  node('sheet').hidden = false;
  document.body = node('body');
  document.getElementById = id => nodes.get(id) || null;
  document.querySelectorAll = selector => selector === '.dir-focus' ? [...nodes.values()].filter(n => n.classList.contains('dir-focus')) : [];
  const pois = [{id: 'start', name: 'Library', category: 'room'}, {id: 'destination', name: 'Reception', category: 'room'}];
  let floor = 'F1';
  const adapter = {pois, lastLoc: null, is3D: () => false, currentFloor: () => floor,
    setFloor(value) { floor = value; }, modelToLL: (x, y) => [x / 100, y / 100],
    localizeAt(lon, lat, options) {
      this.lastLoc = {lon, lat, floor};
      if (mp && Number.isFinite(options?.modelHeight)) this.lastLoc.modelHeight = options.modelHeight;
    },
    startLocalize(on) { localizeCalls.push(on); },
    route(from, to, options) { routes.push({from, to, options}); }};
  const context = {window: null, document, console, URL, URLSearchParams, location: {href: 'https://wayfinding.navme.space/gcu-omr', search: mp ? '?mp=1' : ''},
    setInterval: () => 1, clearInterval() {}, setTimeout: fn => { timers.push(fn); return timers.length; },
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    WFi18n: {t: key => key.split('.').reduce((item, part) => item?.[part], dictionary) || key},
    WF: {cfg: {floors: [{id: 'F1', ordinal: 0}, {id: 'F2', ordinal: 1}]}},
    MpPreview: {pickOnMap() { const pick = deferred(); picks.push(pick); return pick.promise; }, focusPoi() {}},
    __adapter: adapter, __node: node, __sheetWrites: [], navigator: {userAgent: 'test', platform: '', maxTouchPoints: 0}};
  context.window = context;
  vm.runInNewContext(source.replace('  window.wfUI = {', `
    wf = window.__adapter; POIS = wf.pois; byId = Object.fromEntries(POIS.map(p => [p.id, p]));
    fuse = {search: query => POIS.filter(p => p.name.toLowerCase().includes(query.toLowerCase())).map(item => ({item}))};
    setUxMode = mode => { S.uxMode = mode; };
    setStyle = async style => { wf.style = style; };
    applyPadding = closePop = syncCategoryButtons = bindLocateChooser = bindLocateModal = placeMe = hideToast = toast = () => {};
    closeSheet = () => { $("sheet").hidden = true; };
    setSheet = (html, state) => { $("sheet").innerHTML = html; $("sheet").hidden = false; window.__sheetWrites.push(state); };
    window.__directionTest = {bindDirections, applyDeepLink};
    window.wfUI = {`), context);
  context.__directionTest.bindDirections();
  const options = () => node('acList').querySelectorAll('li[role=option]');
  const chooseMap = () => {
    const option = options().find(option => option.getAttribute('data-ac-action') === 'pick-map');
    assert.ok(option, 'From list exposes map picking'); option.dispatch('mousedown');
  };
  return {api: context.wfUI, node, adapter, routes, picks, localizeCalls, options, chooseMap, context,
    type(id, value) { node(id).value = value; node(id).dispatch('input'); },
    key(id, key) { node(id).dispatch('keydown', {key}); }};
}

for (const [locale, label] of [['en', 'Choose on Map'], ['fr', 'Choisir sur la carte'], ['ar', 'اختر على الخريطة']]) {
  test(`null From exposes the localized map option and POIs in ${locale}`, () => {
    const f = fixture({locale});
    f.api.openDirections(null, 'destination', false);
    assert.equal(f.node('acList').hidden, false);
    assert.equal(f.options()[0].getAttribute('aria-label'), label);
    assert.equal(f.options()[0].getAttribute('data-ac-action'), 'pick-map');
    assert.ok(f.options().some(option => option.getAttribute('aria-label') === 'Library'));
    assert.equal(f.api.S.to.id, 'destination');
    assert.equal(f.api.S.from, null);
  });
}

test('public From map selection leaves endpoints intact until confirmation, then routes from the picked point', async () => {
  const f = fixture(); f.api.openDirections(null, 'destination', false); f.chooseMap();
  assert.equal(f.picks.length, 1);
  assert.equal(f.node('sheet').hidden, true);
  assert.equal(f.node('acList').hidden, true);
  assert.equal(f.api.S.from, null);
  assert.equal(f.api.S.to.id, 'destination');
  assert.equal(f.routes.length, 0);
  f.picks[0].resolve({x: 120, y: 230, z: 4, floorIndex: 1}); await flush();
  assert.equal(f.api.S.from, 'me');
  assert.equal(f.api.S.to.id, 'destination');
  assert.equal(f.adapter.lastLoc.floor, 'F2');
  assert.equal(f.adapter.lastLoc.lon, 1.2);
  assert.equal(f.adapter.lastLoc.modelHeight, 4, 'the 3D picked height reaches localization');
  assert.equal(f.api.S.locMeta.source, 'map');
  assert.equal(f.routes.length, 1);
  assert.equal(f.routes[0].from, '__loc');
  assert.equal(f.routes[0].to, 'destination');
  assert.equal(f.localizeCalls.length, 0, 'MP entry never invokes the unavailable GPS/2D adapter');
});

test('canceling a null-start picker reopens the From choices and permits another map attempt', async () => {
  const f = fixture(); f.api.openDirections(null, 'destination', false); f.chooseMap();
  f.picks[0].resolve(null); await flush();
  assert.equal(f.api.S.from, null);
  assert.equal(f.api.S.to.id, 'destination');
  assert.equal(f.node('acList').hidden, false);
  f.chooseMap(); assert.equal(f.picks.length, 2);
  f.picks[1].resolve(null); await flush();
  assert.equal(f.routes.length, 0);
});

test('the existing map prompt hides the directions sheet while picking and restores it on cancel', async () => {
  const f = fixture(); f.api.openDirections('me', 'destination', false);
  assert.equal(f.node('sheet').hidden, false);
  f.node('dSetMe').click();
  assert.equal(f.node('sheet').hidden, true, 'directions actions cannot intercept picker Cancel on mobile');
  f.picks[0].resolve(null); await flush();
  assert.equal(f.node('sheet').hidden, false);
  assert.equal(f.api.S.from, 'me'); assert.equal(f.api.S.to.id, 'destination');
  f.node('dSetMe').click(); assert.equal(f.picks.length, 2);
  assert.equal(f.node('sheet').hidden, true);
  f.picks[1].resolve(null); await flush();
});

test('a stale canceled picker cannot reopen panels over a newer map attempt', async () => {
  const f = fixture(); f.api.openDirections('me', 'destination', false);
  f.node('dSetMe').click(); f.node('dSetMe').click();
  f.picks[0].resolve(null); await flush();
  assert.equal(f.node('sheet').hidden, true); assert.equal(f.node('acList').hidden, true);
  f.picks[1].resolve(null); await flush();
  assert.equal(f.node('sheet').hidden, false);
});

test('canceling map replacement preserves the existing POI start and destination', async () => {
  const f = fixture(); f.api.openDirections('start', 'destination', false);
  f.node('fromQ').focus(); f.chooseMap();
  assert.equal(f.api.S.from.id, 'start');
  f.picks[0].resolve(null); await flush();
  assert.equal(f.api.S.from.id, 'start'); assert.equal(f.api.S.to.id, 'destination');
  assert.equal(f.routes.at(-1).from, 'start'); assert.equal(f.routes.at(-1).to, 'destination');
});

test('typed POI Enter selection keeps From/To autocomplete and swap working', () => {
  const f = fixture(); f.api.openDirections(null, 'destination', false);
  f.type('fromQ', 'Library'); f.key('fromQ', 'Enter');
  assert.equal(f.api.S.from.id, 'start', 'typed Enter chooses the matching POI rather than the map action');
  f.node('toQ').focus(); f.type('toQ', 'Reception');
  assert.equal(f.options().some(option => option.getAttribute('data-ac-action') === 'pick-map'), false);
  f.key('toQ', 'Enter');
  assert.equal(f.routes.at(-1).from, 'start'); assert.equal(f.routes.at(-1).to, 'destination');
  f.node('btnSwap').click();
  assert.equal(f.routes.at(-1).from, 'destination'); assert.equal(f.routes.at(-1).to, 'start');
});

test('keyboard selection can start map picking from an empty From field', () => {
  const f = fixture(); f.api.openDirections(null, 'destination', false);
  f.key('fromQ', 'Enter'); assert.equal(f.picks.length, 1);
});

test('Not right reopens the MP picker and cancellation preserves map metadata', async () => {
  const f = fixture(); f.api.openDirections('me', 'destination', false);
  f.adapter.lastLoc = {lon: 1, lat: 2, floor: 'F1'};
  const meta = {source: 'map', label: 'Previous pin', accuracy: null}; f.api.S.locMeta = meta;
  f.node('fromNotRight').click();
  assert.equal(f.picks.length, 1); assert.equal(f.localizeCalls.length, 0);
  f.picks[0].resolve(null); await flush();
  assert.equal(f.api.S.locMeta, meta); assert.equal(f.api.S.to.id, 'destination');
});

test('the regular map From action retains its tap-to-place flow', () => {
  const f = fixture({mp: false}); f.api.openDirections(null, 'destination', false); f.chooseMap();
  assert.equal(f.picks.length, 0);
  assert.deepEqual(f.localizeCalls, [true]);
  assert.equal(f.api.S.locThenRoute, true); assert.equal(f.api.S.to.id, 'destination');
});

test('a map-start share link preserves its height through deep-link restoration', async () => {
  const f = fixture(); f.api.openDirections(null, 'destination', false); f.chooseMap();
  f.picks[0].resolve({x: 120, y: 230, z: 8, floorIndex: 0}); await flush();
  const link = new URL(f.api.share({kind: 'dir'}));
  assert.deepEqual(link.searchParams.get('me').split(','), ['1.2000000', '2.3000000', 'F1', '8']);
  const restored = fixture(); restored.context.location.search = link.search;
  await restored.context.__directionTest.applyDeepLink();
  assert.equal(restored.adapter.lastLoc.modelHeight, 8);
  assert.equal(restored.adapter.lastLoc.floor, 'F1');
  assert.equal(restored.api.S.from, 'me'); assert.equal(restored.api.S.to.id, 'destination');
  assert.equal(restored.routes.at(-1).from, '__loc');
});

for (const height of [undefined, '', ' ', 'nonsense', 'Infinity', 'NaN']) {
  test(`legacy or invalid shared height ${JSON.stringify(height)} uses the floor fallback`, async () => {
    const f = fixture();
    const me = ['1', '2', 'F1']; if (height !== undefined) me.push(height);
    f.context.location.search = '?mp=1&from=me&to=destination&me=' + encodeURIComponent(me.join(','));
    await f.context.__directionTest.applyDeepLink();
    assert.equal(f.adapter.lastLoc.modelHeight, undefined);
    assert.equal(new URL(f.api.share({kind: 'dir'})).searchParams.get('me').split(',').length, 3);
    assert.equal(f.api.S.to.id, 'destination');
  });
}

test('zero shared model height stays explicit instead of becoming a missing height', async () => {
  const f = fixture(); f.context.location.search = '?mp=1&from=me&to=destination&me=1,2,F1,0';
  await f.context.__directionTest.applyDeepLink();
  assert.equal(f.adapter.lastLoc.modelHeight, 0);
  assert.equal(new URL(f.api.share({kind: 'dir'})).searchParams.get('me').split(',')[3], '0');
});

test('the ordinary 2D localizer ignores optional shared model-height options', async () => {
  const f = fixture({mp: false}); f.context.location.search = '?from=me&to=destination&me=1,2,F1,8';
  await f.context.__directionTest.applyDeepLink();
  assert.equal(f.adapter.lastLoc.lon, 1); assert.equal(f.adapter.lastLoc.lat, 2);
  assert.equal(f.adapter.lastLoc.modelHeight, undefined);
  assert.equal(f.routes.at(-1).from, '__loc'); assert.equal(f.routes.at(-1).to, 'destination');
});
