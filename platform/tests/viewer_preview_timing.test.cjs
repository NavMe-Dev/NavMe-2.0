const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/preview_timing.js'), 'utf8');

function fixture() {
  const window = {};
  vm.runInNewContext(source, { window });
  let now = 0;
  let id = 0;
  const timers = new Map();
  const updates = [];
  const clock = window.WFPreviewTiming.create({
    now: () => now,
    setInterval: (callback, delay) => { assert.equal(delay, 200); timers.set(++id, callback); return id; },
    clearInterval: (timer) => timers.delete(timer),
    onUpdate: (value) => updates.push(value)
  });
  return {
    clock, timers, updates, format: window.WFPreviewTiming.formatMMSS,
    advance(milliseconds) { now += milliseconds; for (const callback of Array.from(timers.values())) callback(); }
  };
}

test('playback duration is the sum of supplied transition and pause budgets', () => {
  const { clock, advance, updates } = fixture();
  const schedule = [3000, 700, 1200, 400];
  clock.reset(schedule.reduce((sum, duration) => sum + duration, 0));
  assert.equal(clock.remainingMs(), 5300);
  clock.begin(schedule[0]);
  advance(1000);
  assert.equal(clock.remainingMs(), 4300);
  assert.equal(updates.at(-1), 4300);
  clock.complete();
  assert.equal(clock.remainingMs(), 2300);
  for (const duration of schedule.slice(1)) {
    clock.begin(duration);
    advance(duration);
    clock.complete();
  }
  assert.equal(clock.remainingMs(), 0);
});

test('pause freezes the active phase and resume counts only active time', () => {
  const { clock, advance, timers } = fixture();
  clock.reset(5000);
  clock.begin(3000);
  advance(1000);
  clock.freeze();
  assert.equal(timers.size, 0);
  advance(60000);
  assert.equal(clock.remainingMs(), 4000);
  clock.resume();
  assert.equal(timers.size, 1);
  advance(500);
  assert.equal(clock.remainingMs(), 3500);
  clock.freeze();
  clock.freeze();
  advance(60000);
  assert.equal(clock.remainingMs(), 3500);
});

test('a stalled phase cannot count down future camera moves or pauses', () => {
  const { clock, advance, timers } = fixture();
  clock.reset(5000);
  clock.begin(1000);
  advance(30000);
  assert.equal(clock.remainingMs(), 4000);
  assert.equal(timers.size, 0);
  advance(30000);
  assert.equal(clock.remainingMs(), 4000);
  clock.complete();
  advance(30000);
  assert.equal(clock.remainingMs(), 4000);
  clock.begin(4000);
  advance(500);
  assert.equal(clock.remainingMs(), 3500);
});

test('cancel removes callbacks and ignores late SDK completions until reset', () => {
  const { clock, advance, timers, updates } = fixture();
  clock.reset(5000);
  clock.begin(3000);
  const staleTick = Array.from(timers.values())[0];
  advance(1000);
  clock.cancel();
  const updateCount = updates.length;
  assert.equal(timers.size, 0);
  advance(30000);
  clock.complete();
  clock.begin(1000);
  clock.resume();
  assert.equal(clock.remainingMs(), 4000);
  assert.equal(updates.length, updateCount);
  assert.equal(timers.size, 0);
  clock.reset(2000);
  clock.begin(2000);
  const freshUpdateCount = updates.length;
  staleTick();
  assert.equal(updates.length, freshUpdateCount);
  advance(1000);
  assert.equal(clock.remainingMs(), 1000);
});

test('finish emits zero, cleans up the interval, and ignores late transitions', () => {
  const { clock, advance, timers, updates, format } = fixture();
  clock.reset(5000);
  clock.begin(3000);
  advance(1000);
  clock.finish();
  assert.equal(clock.remainingMs(), 0);
  assert.equal(format(updates.at(-1)), '00:00');
  assert.equal(timers.size, 0);
  clock.begin(3000);
  advance(30000);
  assert.equal(clock.remainingMs(), 0);
});

test('MM:SS formatting rounds up active fractions and never invents invalid time', () => {
  const { format } = fixture();
  for (const [milliseconds, expected] of [[0, '00:00'], [1, '00:01'], [59000, '00:59'], [59001, '01:00'], [75000, '01:15'], [3600000, '60:00'], [-1, '00:00'], [NaN, '00:00'], [Infinity, '00:00'], [undefined, '00:00']]) {
    assert.equal(format(milliseconds), expected);
  }
});
