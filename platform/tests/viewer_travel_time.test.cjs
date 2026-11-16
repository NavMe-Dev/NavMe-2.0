const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/travel_time.js'), 'utf8');
function load(window = {}) { vm.runInNewContext(source, { window }); return window.WFTravelTime; }

test('route time scales with actual remaining route distance and never counts down by itself', () => {
  const eta = load(), route = { time_s: 180, total_m: 120 };
  assert.equal(eta.estimate(route, 120), 180);
  assert.equal(eta.estimate(route, 60), 90);
  assert.equal(eta.estimate(route, 60), 90);
  assert.equal(eta.estimate(route, 240), 180);
  assert.equal(eta.estimate(route, 0), 0);
  assert.deepEqual(route, { time_s: 180, total_m: 120 });
});
test('fallback speed follows route mode and validated configuration', () => {
  const eta = load({ WF_CONFIG: { navigation_eta: { walking_speed_mps: 1, step_free_speed_mps: 0.5 } } });
  assert.equal(load().estimate({}, 80), 100);
  assert.equal(load().estimate({ _stepFree: true }, 70), 100);
  assert.equal(load().estimate({ mode: 'stepfree' }, 70), 100);
  assert.equal(eta.estimate({}, 80), 80);
  assert.equal(eta.estimate({ _stepFree: true }, 80), 160);
  assert.equal(eta.estimate({}, 80, { walking_speed_mps: 2 }), 40);
  assert.equal(eta.estimate({}, 80, { walking_speed_mps: 0 }), 100);
  assert.equal(eta.estimate({ time_s: NaN, total_m: 50 }, 80), 80);
});
test('invalid route or remaining distance hides the estimate', () => {
  const eta = load();
  for (const distance of [undefined, null, NaN, Infinity, -1, '12']) assert.equal(eta.estimate({}, distance), null);
  assert.equal(eta.estimate(null, 80), null);
  for (const value of [null, undefined, NaN, Infinity, -1]) assert.equal(eta.format(value), '');
});
test('approximate formatting rounds short estimates and long minutes, and supports localization', () => {
  const eta = load();
  for (const [seconds, expected] of [[0, '~0 sec'], [1, '~5 sec'], [42, '~40 sec'], [59, '~1 min'], [162, '~2 min 40 sec'], [299, '~5 min'], [301, '~6 min']]) assert.equal(eta.format(seconds), expected);
  const localized = load({ WFi18n: { t: (key, args) => key === 'viewer.etaSeconds' ? `environ ${args.seconds} s` : key } });
  assert.equal(localized.format(20), 'environ 20 s');
  assert.equal(localized.format(120), '~2 min');
});
