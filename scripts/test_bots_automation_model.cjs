// The Automations model's rules (Agents 3.0 Phase 3, unit U3): plain-Node checks of static/js/botsAutomationModel.js.
// Run: node scripts/test_bots_automation_model.cjs
//   - list order: needs-you, working, paused, done, then next time, then name
//   - the bot filter shows from nine automations with more than one bot
//   - needs-you rules and the ONE fix each maps to
//   - a routine reads from the new shape, the flat shape and an old bot goal
//   - the editor draft round-trips to the design's schedule union; validation catches what it should
//   - zoned wall times: spring-forward gaps move ahead, repeated fall-back times take the first
//   - webhook attempts deduplicate by delivery id, newest first, at most thirty
//   - limit-reset helpers: near-limit threshold, pill text, automations due before the reset
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };
const NOW = Date.parse('2026-11-03T15:00:00Z');
const iso = ms => new Date(ms).toISOString();
const routineRaw = (id, extra = {}) => ({ id, agent_id: 'a1', name: `Routine ${id}`, prompt: 'Do it.', enabled: true, revision: 1,
  schedule: { kind: 'daily', time: '09:00', time_zone: 'America/New_York' }, next_run_at: iso(NOW + 3600000), ...extra });
const row = (raw, kind = 'routine') => ({ kind, id: raw.id, bot_id: raw.agent_id || 'a1', name: raw.name, enabled: raw.enabled, ...(kind === 'routine' ? { routine: raw } : { trigger: raw, problem: raw.problem }) });

(async () => {
  const M = await load('js/botsAutomationModel.js');
  const names = { a1: 'Scout', a2: 'Archivist' };
  const opts = { botName: id => names[id] || '', now: NOW };

  check('rows sort needs-you, working, paused, done, then next time, then name', () => {
    const list = M.buildItems([
      row(routineRaw('w2', { name: 'Zed', next_run_at: iso(NOW + 7200000) })),
      row(routineRaw('w1', { name: 'Alpha', next_run_at: iso(NOW + 7200000) })),
      row(routineRaw('w0', { name: 'Soon', next_run_at: iso(NOW + 60000) })),
      row(routineRaw('p1', { name: 'Paused', enabled: false })),
      row(routineRaw('d1', { name: 'Done', schedule: { kind: 'once', at: iso(NOW - 3600000) }, next_run_at: null, recent_runs: [{ id: 'x', status: 'completed', started_at: iso(NOW - 3600000) }] })),
      row(routineRaw('n1', { name: 'Waiting', recent_runs: [{ id: 'rw', status: 'waiting', started_at: iso(NOW - 60000), thread_id: 't9' }] })),
    ], opts);
    assert.deepEqual(list.map(i => i.id), ['n1', 'w0', 'w1', 'w2', 'p1', 'd1']);
    assert.deepEqual(list.map(i => i.statusWord), ['Needs you', 'Working', 'Working', 'Working', 'Paused', 'Done']);
  });

  check('the bot filter shows from nine automations and only with more than one bot', () => {
    assert.equal(M.showBotFilter(8, 3), false);
    assert.equal(M.showBotFilter(9, 3), true);
    assert.equal(M.showBotFilter(9, 1), false);
    assert.equal(M.showBotFilter(40, 2), true);
  });

  check('needs-you rules each give one fix', () => {
    const fixOf = raw => M.automationItem(row(raw), opts).trouble?.fix;
    assert.deepEqual([fixOf(routineRaw('a', { recent_runs: [{ id: 'r1', status: 'waiting', started_at: iso(NOW) }] })).kind], ['open_run']);
    assert.equal(fixOf(routineRaw('b', { recent_runs: [{ id: 'r2', status: 'failed', error: 'You are signed out', started_at: iso(NOW) }] })).kind, 'open_run');
    assert.equal(fixOf(routineRaw('c', { recent_runs: [{ id: 'r3', status: 'failed', error: 'Usage limit reached', started_at: iso(NOW) }] })).kind, 'usage');
    assert.equal(fixOf(routineRaw('d', { recent_runs: [{ id: 'r4', status: 'failed', error: 'Setup is missing', started_at: iso(NOW) }] })).kind, 'edit');
    assert.equal(fixOf(routineRaw('e', { failure_streak: 2 })).kind, 'run');
    assert.equal(fixOf(routineRaw('f', { check_trouble: 'Could not read mail' })).kind, 'edit');
    assert.equal(fixOf(routineRaw('g', { check_trouble: { cause: 'signed_out', text: 'x' } })).kind, 'reconnect');
    assert.equal(fixOf(routineRaw('h')), undefined, 'a healthy routine offers no fix');
    const app = M.automationItem(row({ id: 'p', agent_id: 'a1', name: 'Mail', enabled: true, problem: 'Gmail needs to be connected again.' }, 'app'), opts);
    assert.equal(app.status, 'needs_you'); assert.equal(app.trouble.fix.kind, 'reconnect');
    const given = M.automationItem({ ...row(routineRaw('i')), fix: { kind: 'usage', label: 'See usage' }, reason: 'Hit a limit' }, opts);
    assert.deepEqual([given.trouble.fix.kind, given.trouble.reason], ['usage', 'Hit a limit'], 'a fix the server names is used as sent');
    const seen = M.automationItem(row(routineRaw('j', { recent_runs: [{ id: 'r5', status: 'failed', error: 'Usage limit', seen: true, started_at: iso(NOW) }] })), opts);
    assert.notEqual(seen.status, 'needs_you', 'a failure the person has seen is not shouted again');
  });

  check('a paused automation with trouble still says it needs you; a plain paused one says Paused', () => {
    const both = M.automationItem(row(routineRaw('k', { enabled: false, failure_streak: 3 })), opts);
    assert.equal(both.status, 'needs_you');
    assert.equal(M.automationItem(row(routineRaw('l', { enabled: false })), opts).status, 'paused');
  });

  check('a routine reads from the nested, flat and old-goal shapes', () => {
    const nested = M.normalizeRoutine({ id: 't1', agent_id: 'a1', name: 'N', prompt: 'p', schedule_kind: 'daily', run_time: '08:15', enabled: true,
      routine: { schema_version: 1, revision: 4, schedule: { kind: 'cron', expression: '0 9 * * 1-5', time_zone: 'America/New_York' }, duration_minutes: 45, overlap: 'queue' } });
    assert.deepEqual([nested.schedule.kind, nested.revision, nested.durationMinutes, nested.overlap], ['cron', 4, 45, 'queue']);
    const legacy = M.normalizeRoutine({ id: 't2', agent_id: 'a1', name: 'Old', prompt: 'p', schedule_kind: 'interval', interval_seconds: 5400, enabled: true });
    assert.deepEqual([legacy.schedule.kind, legacy.schedule.every_minutes], ['interval', 90]);
    const daily = M.normalizeRoutine({ id: 't3', name: 'D', schedule_kind: 'daily', run_time: '07:05', weekdays: [0, 2], time_zone: 'Europe/Paris' });
    assert.deepEqual([daily.schedule.time, daily.schedule.weekdays, daily.schedule.time_zone], ['07:05', [0, 2], 'Europe/Paris']);
    assert.equal(M.normalizeRoutine({ id: 't4', name: 'X', schedule: { kind: 'bogus' } }).schedule.kind, 'unknown');
    assert.deepEqual(M.normalizeRoutine({ id: 't5', name: 'Y', schedule: { kind: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] } }).schedule.weekdays, null, 'every day of the week is just daily');
  });

  check('schedules read as one plain sentence', () => {
    const zone = M.localZone();
    assert.equal(M.describeSchedule({ kind: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4], time_zone: zone }), 'Every weekday at 9:00 AM');
    assert.equal(M.describeSchedule({ kind: 'daily', time: '17:30', weekdays: null, time_zone: zone }), 'Every day at 5:30 PM');
    assert.equal(M.describeSchedule({ kind: 'daily', time: '09:00', weekdays: [0, 2], time_zone: zone }), 'Every Monday, Wednesday at 9:00 AM');
    assert.equal(M.describeSchedule({ kind: 'interval', every_minutes: 15, weekdays: null, window: { start: '09:00', end: '17:00' }, time_zone: zone }), 'Every 15 minutes, 9:00 AM to 5:00 PM');
    assert.equal(M.describeSchedule({ kind: 'interval', every_minutes: 120, weekdays: [0, 1, 2, 3, 4], window: null, time_zone: zone }), 'Every 2 hours on weekdays');
    assert.equal(M.describeSchedule({ kind: 'interval', every_minutes: 60, window: null }), 'Every hour');
    assert.equal(M.describeSchedule({ kind: 'limit_reset', endpoint_id: 'c', repeat: 'every_reset' }), 'After every usage limit reset');
    assert.match(M.describeSchedule({ kind: 'cron', expression: '0 9 L * *', time_zone: zone }), /custom schedule \(0 9 L \* \*\)/);
  });

  check('the grey line lists next, last ran and skipped, and a quiet check says so', () => {
    const item = M.automationItem(row(routineRaw('m', { next_run_at: iso(NOW + 3 * 3600000), skipped_today: 2, recent_runs: [{ id: 'r', status: 'completed', started_at: iso(NOW - 7200000), finished_at: iso(NOW - 7000000) }] })), opts);
    assert.match(item.timing, /^Next .+ · Last ran 2 h ago · Skipped 2 today$/);
    const quiet = M.automationItem(row(routineRaw('n', { quiet_check: true, recent_runs: [{ id: 'r', status: 'completed', started_at: iso(NOW - 600000) }] })), opts);
    assert.match(quiet.timing, /Checked, nothing new/);
    const paused = M.automationItem(row(routineRaw('o', { enabled: false })), opts);
    assert.match(paused.timing, /^Paused/);
  });

  check('wall times in a named zone: the gap moves ahead, the repeat takes the first', () => {
    const zone = 'America/New_York';
    // 2027-03-14 02:30 does not exist (clocks jump 02:00 to 03:00): it lands at 03:30 EDT = 07:30Z.
    assert.equal(iso(M.zonedWallToMs(2027, 3, 14, 2, 30, zone)), '2027-03-14T07:30:00.000Z');
    // 2026-11-01 01:30 happens twice: the first is EDT = 05:30Z.
    assert.equal(iso(M.zonedWallToMs(2026, 11, 1, 1, 30, zone)), '2026-11-01T05:30:00.000Z');
    assert.equal(iso(M.zonedWallToMs(2026, 11, 3, 9, 0, zone)), '2026-11-03T14:00:00.000Z');
    const parts = M.zonedParts(Date.parse('2026-11-03T14:00:00Z'), zone);
    assert.deepEqual([parts.hour, parts.weekday], [9, 1], 'Tuesday is 1, Monday is 0');
  });

  check('a draft becomes the schedule union and back', () => {
    const zone = 'America/New_York';
    const base = { ...M.emptyDraft('a1', NOW), timeZone: zone, date: '2026-11-10', time: '09:30', name: 'N', prompt: 'P' };
    assert.deepEqual(M.scheduleFromDraft({ ...base, repeat: 'daily' }), { kind: 'daily', time: '09:30', time_zone: zone });
    assert.deepEqual(M.scheduleFromDraft({ ...base, repeat: 'weekdays' }), { kind: 'daily', time: '09:30', weekdays: [0, 1, 2, 3, 4], time_zone: zone });
    assert.deepEqual(M.scheduleFromDraft({ ...base, repeat: 'weekly', weekdays: [2] }), { kind: 'daily', time: '09:30', weekdays: [2], time_zone: zone });
    assert.deepEqual(M.scheduleFromDraft({ ...base, repeat: 'once' }), { kind: 'once', at: '2026-11-10T14:30:00.000Z' });
    assert.deepEqual(M.scheduleFromDraft({ ...base, repeat: 'cron', cron: ' 0  9 L * * ' }), { kind: 'cron', expression: '0 9 L * *', time_zone: zone });
    const interval = M.scheduleFromDraft({ ...base, repeat: 'interval', everyMinutes: 30, windowOn: true, windowStart: '09:00', windowEnd: '17:00', weekdays: [0, 4], endsOn: '2026-12-01' });
    assert.deepEqual([interval.kind, interval.every_minutes, interval.window, interval.weekdays, interval.anchor_at], ['interval', 30, { start: '09:00', end: '17:00' }, [0, 4], '2026-11-10T14:30:00.000Z']);
    assert.deepEqual(M.scheduleFromDraft({ ...base, repeat: 'limit_reset', endpointId: 'claude', resetRepeat: 'every_reset' }), { kind: 'limit_reset', endpoint_id: 'claude', repeat: 'every_reset' });
    // And back: weekdays reads as the Weekdays chip, one day as Weekly, a cron as itself.
    const back = schedule => M.draftFromRoutine(M.normalizeRoutine({ id: 'x', agent_id: 'a1', name: 'N', prompt: 'p', revision: 3, schedule }), NOW);
    assert.equal(back({ kind: 'daily', time: '09:30', weekdays: [0, 1, 2, 3, 4], time_zone: zone }).repeat, 'weekdays');
    assert.equal(back({ kind: 'daily', time: '09:30', weekdays: [3], time_zone: zone }).repeat, 'weekly');
    assert.equal(back({ kind: 'daily', time: '09:30', time_zone: zone }).repeat, 'daily');
    const cron = back({ kind: 'cron', expression: '0 9 * * 1', time_zone: zone });
    assert.deepEqual([cron.repeat, cron.cron, cron.revision], ['cron', '0 9 * * 1', 3]);
    const once = back({ kind: 'once', at: '2026-11-10T14:30:00Z', time_zone: zone });
    assert.deepEqual([once.repeat, once.date, once.time], ['once', '2026-11-10', '09:30']);
  });

  check('the save body carries the revision on an edit and the bot on a create', () => {
    const draft = { ...M.emptyDraft('a1', NOW), name: ' Name ', prompt: ' Do it ', repeat: 'daily', time: '08:00', timeZone: 'UTC', durationMinutes: 45, timeoutMinutes: '' };
    const created = M.bodyFromDraft(draft);
    assert.deepEqual([created.bot_id, created.expected_revision, created.name, created.prompt, created.timeout_minutes, created.duration_minutes], ['a1', undefined, 'Name', 'Do it', null, 45]);
    const edited = M.bodyFromDraft({ ...draft, id: 'r9', revision: 6, timeoutMinutes: 20 });
    assert.deepEqual([edited.bot_id, edited.expected_revision, edited.timeout_minutes], [undefined, 6, 20]);
  });

  check('validation names the field and ignores nothing it should catch', () => {
    const ok = { ...M.emptyDraft('a1', NOW), name: 'N', prompt: 'P', repeat: 'daily', time: '09:00', timeZone: 'UTC' };
    assert.deepEqual(M.validateDraft(ok, NOW), {});
    assert.ok(M.validateDraft({ ...ok, name: '  ' }, NOW).name);
    assert.ok(M.validateDraft({ ...ok, name: 'x'.repeat(81) }, NOW).name);
    assert.ok(M.validateDraft({ ...ok, prompt: '' }, NOW).prompt);
    assert.ok(M.validateDraft({ ...ok, prompt: 'x'.repeat(20001) }, NOW).prompt);
    assert.ok(M.validateDraft({ ...ok, repeat: 'once', date: '2026-11-03', time: '09:00' }, NOW).date, 'a time that has passed');
    assert.deepEqual(M.validateDraft({ ...ok, repeat: 'once', date: '2026-11-04', time: '09:00' }, NOW), {});
    assert.ok(M.validateDraft({ ...ok, repeat: 'weekly', weekdays: [] }, NOW).weekdays);
    assert.ok(M.validateDraft({ ...ok, repeat: 'interval', everyMinutes: 4, date: '2026-11-04', time: '09:00' }, NOW).everyMinutes);
    assert.ok(M.validateDraft({ ...ok, repeat: 'interval', everyMinutes: 1441, date: '2026-11-04', time: '09:00' }, NOW).everyMinutes);
    const reversed = M.validateDraft({ ...ok, repeat: 'interval', everyMinutes: 30, windowOn: true, windowStart: '17:00', windowEnd: '09:00', date: '2026-11-04', time: '09:00' }, NOW);
    assert.match(reversed.window, /two routines/, 'an overnight window is refused with the way out');
    assert.ok(M.validateDraft({ ...ok, repeat: 'interval', everyMinutes: 120, windowOn: true, windowStart: '09:00', windowEnd: '10:00', date: '2026-11-04', time: '09:00' }, NOW).window, 'a window shorter than the cadence');
    assert.ok(M.validateDraft({ ...ok, repeat: 'cron', cron: '0 9 * *' }, NOW).cron, 'four fields');
    assert.ok(M.validateDraft({ ...ok, repeat: 'cron', cron: '0 9 * * 1', timeZone: '' }, NOW).timeZone, 'cron needs a named zone');
    assert.deepEqual(M.validateDraft({ ...ok, repeat: 'cron', cron: '0 9 L * *' }, NOW), {}, 'L is allowed');
    assert.ok(M.validateDraft({ ...ok, repeat: 'limit_reset', endpointId: '' }, NOW).endpointId);
    assert.ok(M.validateDraft({ ...ok, durationMinutes: 4 }, NOW).durationMinutes);
    assert.ok(M.validateDraft({ ...ok, durationMinutes: 241 }, NOW).durationMinutes);
    assert.ok(M.validateDraft({ ...ok, timeoutMinutes: 2 }, NOW).timeoutMinutes);
    assert.deepEqual(M.validateDraft({ ...ok, timeoutMinutes: '' }, NOW), {});
  });

  check('a server refusal reads as status and plain text', () => {
    assert.deepEqual(M.refusalOf(new Error('409: This changed since you opened it.')), { status: 409, message: 'This changed since you opened it.' });
    assert.deepEqual(M.refusalOf(new Error('Network down')), { status: 0, message: 'Network down' });
  });

  check('attempts deduplicate by delivery id, newest first, at most thirty', () => {
    const list = [{ id: 'a', delivery_id: 'd1', at: 1000, outcome: 'accepted' }, { id: 'b', delivery_id: 'd1', at: 2000, outcome: 'duplicate' }, { id: 'c', delivery_id: 'd2', at: 1500, outcome: 'rejected' }];
    assert.deepEqual(M.dedupeAttempts(list).map(a => a.id), ['b', 'c']);
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, delivery_id: `d${i}`, at: i * 1000, outcome: 'accepted' }));
    const out = M.dedupeAttempts(many);
    assert.equal(out.length, 30); assert.equal(out[0].id, 'x49');
    assert.deepEqual(M.attemptWord('rejected'), ['Turned away', 'bad']);
    assert.deepEqual(M.attemptWord('mystery'), ['mystery', 'muted']);
  });

  check('limit helpers: 90 percent or blocked is near, the pill reads plainly, due routines are those before the reset', () => {
    assert.equal(M.nearLimit({ used_percent: 89 }), false);
    assert.equal(M.nearLimit({ used_percent: 90 }), true);
    assert.equal(M.nearLimit({ used_percent: 10, blocked: true }), true);
    assert.match(M.limitPillText({ name: 'Claude', used_percent: 92, resets_at: iso(NOW + 3600000) }, NOW), /^Claude: 92% used, resets \d{1,2}:\d{2} (AM|PM)$/);
    assert.match(M.limitPillText({ name: 'Claude', blocked: true, resets_at: iso(NOW + 3600000) }, NOW), /limit reached/);
    const routines = [M.normalizeRoutine(routineRaw('s1', { next_run_at: iso(NOW + 1800000) })), M.normalizeRoutine(routineRaw('s2', { next_run_at: iso(NOW + 7200000 * 2) })),
      M.normalizeRoutine(routineRaw('s3', { enabled: false, next_run_at: iso(NOW + 600000) })), M.normalizeRoutine(routineRaw('s4', { schedule: { kind: 'limit_reset', endpoint_id: 'c', repeat: 'once' }, next_run_at: iso(NOW + 600000) }))];
    const endpoints = [{ endpoint_id: 'c', name: 'Claude', used_percent: 95, resets_at: iso(NOW + 3 * 3600000) }];
    assert.deepEqual(M.dueBeforeReset(routines, endpoints, NOW).map(d => d.routine.id), ['s1']);
    assert.deepEqual(M.dueBeforeReset(routines, [{ ...endpoints[0], used_percent: 10 }], NOW), [], 'nothing is due when no account is near its limit');
  });

  check('run status words and Kip states match the design', () => {
    assert.deepEqual(['running', 'waiting', 'completed', 'failed', 'missed', 'cancelled'].map(M.kipForRun), ['thinking', 'needs', 'success', 'error', 'error', 'sleeping']);
    assert.equal(M.RUN_WORDS.waiting, 'Waiting for you');
    assert.equal(M.normalizeRun({ id: 'r', status: 'ok' }).status, 'completed');
    assert.equal(M.normalizeRun({ id: 'r', automation_status: 'missed', status: 'ok' }).status, 'missed', 'the new status wins over the legacy outcome');
  });

  console.log(`PASS: ${passed.length} automation model checks`);
  for (const name of passed) console.log('  ok  ' + name);
})().catch(error => { console.error(error); process.exit(1); });
