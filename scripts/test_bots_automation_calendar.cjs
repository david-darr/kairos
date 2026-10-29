// The Automations calendar's rules (Agents 3.0 Phase 3, unit U3): plain-Node checks of the functions in
// static/js/botsAutomationCalendar.js that need no DOM. Run: node scripts/test_bots_automation_calendar.cjs
//   - geometry: 64 px an hour, five-minute snap, a block under 30 minutes is one line
//   - collision packing: overlapping blocks share a column; touching blocks do not
//   - weeks start Monday; the month grid is Monday-first; days are DST-safe
//   - projection (drawing only): once and daily are drawn, anything else only at its next run; the engine's
//     occurrences replace a projection; a time that already has a run is dropped; at most 12 receipts a routine
//   - drag: once moves, a daily moves its time (and its weekday), an interval moves its anchor, cron opens its
//     editor, a limit-reset refuses, "only the next time" defers
//   - resize: five-minute steps, 5 to 240
//   - the CSS constants match the JavaScript constants
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', 'static');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };
const ZONE = 'America/New_York';
const iso = ms => new Date(ms).toISOString();

(async () => {
  const C = await load('js/botsAutomationCalendar.js');
  const M = await load('js/botsAutomationModel.js');
  const routine = (id, schedule, extra = {}) => M.normalizeRoutine({ id, agent_id: 'a1', name: `R${id}`, prompt: 'p', enabled: true, revision: 2, schedule, duration_minutes: 30, ...extra });

  check('64 px an hour, five-minute snap, one line under 30 minutes', () => {
    assert.equal(C.HOUR_PX, 64); assert.equal(C.SLOT_MIN, 5); assert.equal(C.BODY_PX, 1536);
    assert.equal(C.minutesToY(60), 64); assert.equal(C.minutesToY(90), 96);
    assert.equal(C.yToMinutes(64), 60);
    assert.equal(C.yToMinutes(66), 60, '2 px is under half a slot');
    assert.equal(C.yToMinutes(70), 65, '6 px is past half a slot (5.3 px per slot): round to 65');
    assert.equal(C.yToMinutes(-30), 0); assert.equal(C.yToMinutes(99999), 1440);
    assert.deepEqual(C.eventBox(540, 30), { top: 576, height: 32, oneLine: false });
    assert.equal(C.eventBox(540, 25).oneLine, true);
    assert.equal(C.eventBox(540, 5).height, C.MIN_EVENT_PX, 'a very short block still holds a line of text');
    assert.equal(C.eventBox(0, 120).height, 128);
    assert.equal(C.snapMinutes(62), 60); assert.equal(C.snapMinutes(63), 65);
  });

  check('overlapping blocks share columns; blocks that only touch do not', () => {
    const pack = C.packColumns([{ key: 'a', start: 540, end: 600 }, { key: 'b', start: 570, end: 630 }, { key: 'c', start: 600, end: 660 }, { key: 'd', start: 900, end: 930 }]);
    assert.deepEqual(pack.get('a'), { col: 0, cols: 2 }, 'a, b and c chain into one overlap group of two columns');
    assert.deepEqual(pack.get('b'), { col: 1, cols: 2 });
    assert.deepEqual(pack.get('c'), { col: 0, cols: 2 }, 'c reuses a column once a has ended');
    assert.deepEqual(pack.get('d'), { col: 0, cols: 1 });
    const touching = C.packColumns([{ key: 'x', start: 60, end: 90 }, { key: 'y', start: 90, end: 120 }]);
    assert.deepEqual([touching.get('x'), touching.get('y')], [{ col: 0, cols: 1 }, { col: 0, cols: 1 }]);
    const same = C.packColumns([{ key: 'p', start: 60, end: 90 }, { key: 'q', start: 60, end: 90 }, { key: 'r', start: 60, end: 90 }]);
    assert.deepEqual([...same.values()].map(v => v.cols), [3, 3, 3]);
    assert.equal(C.packColumns([]).size, 0);
  });

  check('the week starts on Monday and the month grid is Monday-first', () => {
    const wed = Date.parse('2026-11-04T17:00:00Z');   // Wednesday
    const range = C.viewRange('week', wed, ZONE);
    assert.equal(range.days.length, 7);
    assert.equal(M.dateKey(range.days[0] + 12 * 3600000, ZONE), '2026-11-02');
    assert.equal(M.zonedParts(range.days[0] + 12 * 3600000, ZONE).weekday, 0);
    assert.equal(range.to - range.from, 7 * 86400000, 'an ordinary week is 168 hours');
    const fall = C.viewRange('week', Date.parse('2026-10-29T17:00:00Z'), ZONE);
    assert.equal(fall.to - fall.from, 7 * 86400000 + 3600000, 'the week of the fall-back is 169 hours long');
    assert.equal(fall.days.length, 7);
    assert.equal(C.viewRange('day', wed, ZONE).days.length, 1);
    const grid = C.monthGrid(wed, ZONE);
    assert.ok(grid.length >= 5 && grid.length <= 6 && grid.every(week => week.length === 7));
    assert.equal(M.zonedParts(grid[0][0].ms + 12 * 3600000, ZONE).weekday, 0, 'each week opens on Monday');
    assert.equal(grid.flat().filter(c => c.inMonth).length, 30, 'November has 30 days');
    assert.equal(M.dateKey(C.stepAnchor('week', wed, 1, ZONE) + 12 * 3600000, ZONE), '2026-11-11');
    assert.equal(M.dateKey(C.stepAnchor('day', wed, -1, ZONE) + 12 * 3600000, ZONE), '2026-11-03');
    // The day of the spring-forward is 23 hours: nextDay does not add 24.
    const spring = Date.parse('2027-03-14T12:00:00Z');
    assert.equal(C.nextDay(C.startOfDay(spring, ZONE), ZONE) - C.startOfDay(spring, ZONE), 23 * 3600000);
  });

  check('a daily routine is drawn each day it runs; others only at their next run', () => {
    const range = C.viewRange('week', Date.parse('2026-11-04T17:00:00Z'), ZONE);
    const daily = routine('d1', { kind: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4], time_zone: ZONE });
    const at = C.projectOccurrences(daily, range.from, range.to);
    assert.equal(at.length, 5, 'Monday to Friday');
    assert.deepEqual(at.map(ms => M.timeKey(ms, ZONE)), Array(5).fill('09:00'));
    assert.deepEqual(at.map(ms => M.zonedParts(ms, ZONE).weekday), [0, 1, 2, 3, 4]);
    const every = routine('d2', { kind: 'daily', time: '23:30', time_zone: ZONE });
    assert.equal(C.projectOccurrences(every, range.from, range.to).length, 7);
    const once = routine('o1', { kind: 'once', at: '2026-11-05T15:00:00Z' });
    assert.deepEqual(C.projectOccurrences(once, range.from, range.to), [Date.parse('2026-11-05T15:00:00Z')]);
    assert.deepEqual(C.projectOccurrences(routine('o2', { kind: 'once', at: '2026-12-25T15:00:00Z' }), range.from, range.to), []);
    const cron = routine('c1', { kind: 'cron', expression: '0 9 * * 1', time_zone: ZONE }, { next_run_at: '2026-11-09T14:00:00Z' });
    assert.deepEqual(C.projectOccurrences(cron, range.from, range.to), [], 'next run is outside this week');
    const cron2 = routine('c2', { kind: 'cron', expression: '0 9 * * 1', time_zone: ZONE }, { next_run_at: '2026-11-05T14:00:00Z' });
    assert.deepEqual(C.projectOccurrences(cron2, range.from, range.to), [Date.parse('2026-11-05T14:00:00Z')], 'only the single next run is drawn');
    const interval = routine('i1', { kind: 'interval', every_minutes: 15 }, { next_run_at: '2026-11-04T18:00:00Z' });
    assert.equal(C.projectOccurrences(interval, range.from, range.to).length, 1);
  });

  check('engine occurrences replace a projection; a run stands in for its planned time; receipts are capped', () => {
    const range = C.viewRange('week', Date.parse('2026-11-04T17:00:00Z'), ZONE);
    const daily = routine('d1', { kind: 'daily', time: '09:00', time_zone: ZONE });
    const now = Date.parse('2026-11-04T12:00:00Z');
    const projected = C.buildEvents([daily], { from: range.from, to: range.to, now });
    assert.equal(projected.length, 7);
    const served = C.buildEvents([daily], { from: range.from, to: range.to, now, occurrences: [{ routine_id: 'd1', at: '2026-11-04T14:00:00Z' }, { routine_id: 'zzz', at: '2026-11-04T14:00:00Z' }] });
    assert.deepEqual(served.map(e => e.at), [Date.parse('2026-11-04T14:00:00Z')], 'the server wins, and a stranger routine is ignored');
    const ran = C.buildEvents([daily], { from: range.from, to: range.to, now, runs: [{ id: 'run1', routine_id: 'd1', status: 'completed', started_at: '2026-11-04T14:00:20Z' }] });
    assert.equal(ran.length, 7, 'the run replaces its own planned time instead of doubling it');
    assert.deepEqual(ran.filter(e => e.kind === 'run').map(e => [e.status, e.future]), [['completed', false]]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, routine_id: 'd1', status: 'completed', started_at: iso(range.from + 3600000 * (i + 1)) }));
    assert.equal(C.buildEvents([daily], { from: range.from, to: range.to, now, runs: many }).filter(e => e.kind === 'run').length, 12, 'at most 12 receipts a routine in a range');
    const paused = routine('p1', { kind: 'daily', time: '09:00', time_zone: ZONE }, { enabled: false });
    const drawn = C.buildEvents([paused], { from: range.from, to: range.to, now });
    assert.ok(drawn.length && drawn.every(e => e.paused), 'a paused routine is still drawn, marked paused');
  });

  check('dragging asks for the right change', () => {
    const base = Date.parse('2026-11-05T14:00:00Z');                       // Thu 9:00 AM EST... (EST after Nov 1)
    const moved = base + 3600000 + 5 * 60000;                              // an hour and five minutes later
    const once = routine('o', { kind: 'once', at: iso(base) });
    assert.deepEqual(C.moveRequest(once, base, moved), { patch: { schedule: { kind: 'once', at: iso(moved) } } });
    const daily = routine('d', { kind: 'daily', time: '09:00', time_zone: ZONE });
    assert.deepEqual(C.moveRequest(daily, base, moved, 'all'), { patch: { schedule: { kind: 'daily', time: '10:05', time_zone: ZONE } } });
    const days = routine('w', { kind: 'daily', time: '09:00', weekdays: [0, 3], time_zone: ZONE });
    const nextDay = base + 86400000;                                        // Friday
    assert.deepEqual(C.moveRequest(days, base, nextDay, 'all').patch.schedule.weekdays, [0, 4], 'Thursday moves to Friday');
    const all = routine('x', { kind: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5], time_zone: ZONE });
    assert.deepEqual(C.moveRequest(all, base, base + 3 * 86400000 + 0, 'all').patch.schedule.weekdays, [0, 1, 2, 4, 5, 6], 'a day swapped in stays a list');
    assert.deepEqual(C.moveRequest(daily, base, moved, 'next'), { defer: { until: iso(moved) } }, '"only the next time" defers one run');
    const interval = routine('i', { kind: 'interval', every_minutes: 60, anchor_at: iso(base) });
    assert.equal(C.moveRequest(interval, base, moved, 'all').patch.schedule.anchor_at, iso(moved));
    assert.equal(C.moveRequest(interval, base, moved, 'all').patch.schedule.every_minutes, 60, 'the rest of the schedule comes along');
    const windowed = routine('iw', { kind: 'interval', every_minutes: 30, window: { start: '09:00', end: '17:00' } });
    assert.deepEqual(C.moveRequest(windowed, base, moved, 'all'), { editor: true });
    assert.deepEqual(C.moveRequest(routine('c', { kind: 'cron', expression: '0 9 * * 1', time_zone: ZONE }), base, moved), { editor: true });
    assert.match(C.moveRequest(routine('l', { kind: 'limit_reset', endpoint_id: 'c', repeat: 'once' }), base, moved).refuse, /usage limit/);
    assert.deepEqual([C.canDrag(once.schedule), C.canDrag(interval.schedule), C.canDrag(routine('c2', { kind: 'cron', expression: '* * * * *', time_zone: ZONE }).schedule),
      C.canDrag(routine('l2', { kind: 'limit_reset', endpoint_id: 'c', repeat: 'once' }).schedule)], [true, true, true, false]);
    assert.deepEqual([C.isRecurring(once.schedule), C.isRecurring(daily.schedule)], [false, true]);
  });

  check('a call resizes in five-minute steps between 5 and 240', () => {
    assert.equal(C.resizeDuration(30, 64), 90);
    assert.equal(C.resizeDuration(30, 5), 35, '5 px is about 4.7 minutes: one step');
    assert.equal(C.resizeDuration(30, 1), 30);
    assert.equal(C.resizeDuration(30, -640), 5, 'never under 5');
    assert.equal(C.resizeDuration(200, 6400), 240, 'never over 240');
    assert.equal(C.resizeDuration(30, 32) % 5, 0);
  });

  check('the stylesheet geometry matches the script constants', () => {
    const css = fs.readFileSync(path.join(root, 'css', 'bots-automation-calendar.css'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'css', 'bots-automations.css'), 'utf8');
    assert.ok(css.includes(`${C.RAIL_PX}px minmax(0, 1fr)`), 'the 320 px mini-month rail');
    assert.ok(css.includes(`background-size: 100% ${C.HOUR_PX}px, 100% ${C.HOUR_PX / 2}px`), 'hour and half-hour lines at 64 px');
    assert.ok(page.includes(`${C.DRAWER_PX}px`), 'the 310 px details drawer');
    assert.ok(/border-left: 3px solid var\(--bots-bot-color\)/.test(css), 'a 3 px bot-coloured border');
    assert.equal(C.RAIL_PX, 320); assert.equal(C.DRAWER_PX, 310);
  });

  console.log(`PASS: ${passed.length} automation calendar checks`);
  for (const name of passed) console.log('  ok  ' + name);
})().catch(error => { console.error(error); process.exit(1); });
