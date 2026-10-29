// The Automations API, in memory, for scripts/bots-automations-checks.cjs (Bots Phase 3 unit U3, 2026-10-29).
// Spec: Kairos Projects/Agents Redesign/phase-3-design.md section 6 (the routes) and section 4.2 (the routine shape).
// ui-smoke.cjs consults every scripts/fixtures/bots-*-backend.cjs while demoState.botsLive is set: read(path, query) and
// mutate(path, method, body, query) answer a route or return undefined to let the next backend (and the demo) have it.
//
// This file answers ONLY its own namespace: /api/bot-automations, /api/bot-routines*, /api/bot-routine-runs*,
// /api/bot-limit-resets*, /api/bot-app-triggers*, /api/bot-webhooks*, plus the receipt routes it issued itself
// (/api/bot-automation-changes/<its receipt>/undo). And only while a check has set demoState.botsAutomations:
// {owning: true, seed: {a, b}} with the ids of two bots the check made. /api/triggers (the existing webhook routes) is answered
// the same way, never otherwise, so other checks keep the demo's own. State lives in demoState.botsAutomations.
//
// The dates here are the fixture's own arithmetic so a check has something to draw. The real engine (services/bot_routines.py,
// U2) decides when anything runs; nothing in the product reads these.
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

class Refusal extends Error { constructor(status, detail, extra = {}) { super(detail); this.status = status; this.extra = extra; } }
const bad = detail => new Refusal(400, detail);

module.exports = ({ state }) => {
  const live = () => !!(state.botsLive && state.botsAutomations?.owning);
  const clock = () => Date.now();

  // -- schedules (fixture arithmetic only)
  function wall(day, hh, mm) { const d = new Date(day); d.setHours(hh, mm, 0, 0); return d.getTime(); }
  function nextTimes(schedule, count, from = clock()) {
    const out = [];
    if (schedule.kind === 'once') { const at = Date.parse(schedule.at); return at > from ? [at] : []; }
    if (schedule.kind === 'daily' || schedule.kind === 'cron') {
      const [hh, mm] = schedule.kind === 'daily' ? schedule.time.split(':').map(Number) : [9, 0];
      for (let i = 0; i < 400 && out.length < count; i++) {
        const at = wall(from + i * DAY, hh, mm);
        const weekday = (new Date(at).getDay() + 6) % 7;
        if (at > from && (schedule.kind === 'cron' || !schedule.weekdays || schedule.weekdays.includes(weekday))) out.push(at);
      }
      return out;
    }
    if (schedule.kind === 'interval') { for (let i = 1; i <= count; i++) out.push(from + i * schedule.every_minutes * 60000); return out; }
    if (schedule.kind === 'limit_reset') { const e = state.botsAutomations.limit.find(x => x.endpoint_id === schedule.endpoint_id); return e ? [Date.parse(e.resets_at) + 60000] : []; }
    return out;
  }
  const sentence = schedule => {
    if (schedule.kind === 'daily') return `Every day at ${schedule.time}`;
    if (schedule.kind === 'once') return `Once, ${new Date(schedule.at).toLocaleString()}`;
    if (schedule.kind === 'interval') return `Every ${schedule.every_minutes} minutes`;
    if (schedule.kind === 'cron') return `On the schedule ${schedule.expression}`;
    return 'After the usage limit resets';
  };
  function validateSchedule(s) {
    if (!s || typeof s !== 'object') throw bad('schedule is required');
    if (s.kind === 'once') {
      if (!s.at || Number.isNaN(Date.parse(s.at))) throw bad('A once schedule needs at.');
      if (Date.parse(s.at) <= clock()) throw bad('That time has passed. Pick a time in the future.');
    } else if (s.kind === 'daily') {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.time || ''))) throw bad('A daily schedule needs time as HH:MM.');
    } else if (s.kind === 'interval') {
      if (!Number.isInteger(s.every_minutes) || s.every_minutes < 5 || s.every_minutes > 1440) throw bad('every_minutes is a whole number from 5 to 1440.');
      if (s.window) {
        const [a, b] = [s.window.start, s.window.end].map(t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; });
        if (b <= a || b - a < s.every_minutes) throw bad('The window stays within one day and is at least one interval long.');
      }
    } else if (s.kind === 'cron') {
      if (String(s.expression || '').trim().split(/\s+/).length !== 5) throw bad('cron needs five fields: minute hour day month weekday.');
      if (!s.time_zone) throw bad('A cron schedule needs a named time zone.');
    } else if (s.kind === 'limit_reset') {
      if (!s.endpoint_id) throw bad('A limit_reset schedule needs an endpoint.');
    } else throw bad('schedule kind is once, daily, interval, cron or limit_reset.');
  }
  function refresh(r) {
    const next = r.enabled ? nextTimes(r.schedule, 1)[0] : null;
    r.next_run_at = next ? iso(next) : null;
    return r;
  }

  // -- the seed
  function seeded() {
    const store = state.botsAutomations;
    if (store.built) return store;
    const { a, b } = store.seed;
    const now = clock();
    store.built = true; store.counter = 100; store.deleted = []; store.receipts = {}; store.requests = {}; store.attempts = {}; store.calls = [];
    const hh = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const run = (id, routine, agent, status, ago, extra = {}) => ({ id, routine_id: routine, agent_id: agent, automation_status: status, trigger_type: 'schedule',
      started_at: iso(now - ago), finished_at: ['running', 'waiting', 'queued'].includes(status) ? null : iso(now - ago + 60000), thread_id: `auto-t-${id}`, output: extra.output || '', error: extra.error || '', ...extra });
    const base = (id, agent, name, schedule, extra = {}) => refresh({ id, agent_id: agent, name, prompt: extra.prompt || `Do the ${name.toLowerCase()} task.`, enabled: true, revision: 1, schedule,
      duration_minutes: 30, timeout_minutes: null, overlap: 'skip', continuity: false, run_on_startup: false, results_thread_id: null, access: 'normal', call: false, recent_runs: [], ...extra });
    const standup = hh(now + 70 * 60000);
    store.routines = [
      base('r1', a, 'Morning summary', { kind: 'daily', time: '09:00', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { prompt: 'Summarize my inbox and calendar for the day.',
        recent_runs: [run('run1', 'r1', a, 'completed', 3 * 3600000, { output: 'Three meetings and two emails need replies.' })] }),
      base('r2', a, 'Inbox check', { kind: 'interval', every_minutes: 30 }, { prompt: 'Check for urgent mail.',
        recent_runs: [run('run2', 'r2', a, 'waiting', 600000, { output: 'I need to know which account to use.' })] }),
      base('r3', a, 'Weekly report', { kind: 'cron', expression: '0 9 * * 1', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { prompt: 'Write the weekly report.' }),
      base('r4', a, 'Old reminder', { kind: 'once', at: iso(now - 2 * 3600000) }, { prompt: 'Remind me about the form.',
        recent_runs: [run('run4', 'r4', a, 'completed', 2 * 3600000, { output: 'Reminded.' })] }),
      base('r5', a, 'Paused digest', { kind: 'daily', time: '18:00', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { enabled: false }),
      base('r6', a, 'Standup call', { kind: 'daily', time: standup, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { call: true, prompt: 'Run the standup.' }),
      base('r7', b, 'Failing sync', { kind: 'daily', time: '07:30', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { prompt: 'Sync the files.', failure_streak: 2,
        recent_runs: [run('run7', 'r7', b, 'failed', 5 * 3600000, { error: 'The sync failed twice.' })] }),
    ];
    store.webhooks = [{ id: 'w1', agent_id: a, name: 'Orders', enabled: true, auto_run: false, events: ['order.created'], prompt_template: 'Summarize each new order.', max_pending: 3, last_event_at: now / 1000 - 90, revision: 1 }];
    store.attempts.w1 = [
      { id: 'at1', delivery_id: 'd1', at: iso(now - 90000), outcome: 'accepted', status_code: 202, payload_preview: '{"event":"order.created","id":"o_42"}' },
      { id: 'at2', delivery_id: 'd2', at: iso(now - 300000), outcome: 'rejected', status_code: 401, payload_preview: '' },
      { id: 'at3', delivery_id: 'd1', at: iso(now - 80000), outcome: 'duplicate', status_code: 202, payload_preview: '{"event":"order.created","id":"o_42"}' },
    ];
    store.app = [{ id: 'p1', agent_id: b, name: 'Email from the boss', enabled: true, app: 'gmail', app_name: 'Gmail', event: 'new_email', delivery: 'poll', interval_minutes: 15, filters: { text: 'boss' },
      prompt_template: 'Tell me what the boss wants.', account_id: 'g1', account_label: 'work@example.com', revision: 1, problem: 'Gmail needs to be connected again.', last_event_at: now / 1000 - 3600,
      attempts: [{ id: 'ap1', at: iso(now - 3600000), outcome: 'started' }, { id: 'ap2', at: iso(now - 7200000), outcome: 'filtered' }] }];
    store.limit = [{ endpoint_id: 'claude', name: 'Claude', used_percent: 92, blocked: false, resets_at: iso(now + 3 * 3600000) }];
    store.catalog = { apps: [{ app: 'gmail', name: 'Gmail', connected: true, accounts: [{ id: 'g1', label: 'work@example.com' }, { id: 'g2', label: 'home@example.com' }],
      events: [{ event: 'new_email', name: 'A new email arrives', delivery: 'poll', config_fields: [] }] },
      { app: 'github', name: 'GitHub', connected: true, accounts: [], events: [{ event: 'push', name: 'Someone pushes', delivery: 'instant', config_fields: [{ key: 'repo', label: 'Repository', required: true }] }] }],
      unavailable: [{ app: 'slack', name: 'Slack', reason: 'not connected yet' }] };
    return store;
  }

  const routine = id => seeded().routines.find(r => r.id === id);
  const need = (list, id, what) => { const found = list.find(x => x.id === id); if (!found) throw new Refusal(404, `${what} not found`); return found; };
  const withStatus = r => {
    const last = r.recent_runs[0] || null;
    return { ...r, last_run: last, week_runs: { ok: r.recent_runs.filter(x => x.automation_status === 'completed').length, total: r.recent_runs.length },
      skipped_today: r.skipped_today || 0, failure_streak: r.failure_streak || 0 };
  };
  const trigger = t => ({ ...t, path: `/hooks/${t.id}`, secret: undefined });

  function items(botId) {
    const s = seeded();
    const out = [];
    for (const r of s.routines) if (!botId || r.agent_id === botId) out.push({ kind: 'routine', id: r.id, bot_id: r.agent_id, name: r.name, enabled: r.enabled, routine: withStatus(r) });
    for (const w of s.webhooks) if (!botId || w.agent_id === botId) out.push({ kind: 'webhook', id: w.id, bot_id: w.agent_id, name: w.name, enabled: w.enabled, trigger: trigger(w) });
    for (const p of s.app) if (!botId || p.agent_id === botId) out.push({ kind: 'app', id: p.id, bot_id: p.agent_id, name: p.name, enabled: p.enabled, trigger: p, problem: p.problem });
    return out;
  }

  function read(route, query = {}) {
    if (!live()) return undefined;
    try { return readRoute(route, query); } catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
  }
  function mutate(route, method, body = {}, query = {}) {
    if (!live()) return undefined;
    try { return handle(route, method, body || {}, query); } catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message, ...error.extra }; throw error; }
  }

  function readRoute(route, query) {
    let m;
    if (route === '/api/bot-automations') return { items: items(query.bot_id || '') };
    if (route === '/api/bot-routines') {
      const s = seeded();
      const list = s.routines.filter(r => !query.bot_id || r.agent_id === query.bot_id).map(withStatus);
      const from = query.from ? Date.parse(query.from) : null, to = query.to ? Date.parse(query.to) : null;
      // The engine's own occurrences for a cron routine: the calendar must prefer these to anything it would project.
      const occurrences = [];
      if (from !== null) for (const r of list.filter(x => x.schedule.kind === 'cron')) for (let i = 0; i < 8; i++) {
        const at = wall(from + i * DAY, 9, 0);
        if (at >= from && at < to) occurrences.push({ routine_id: r.id, at: iso(at) });
      }
      return { routines: list, occurrences: from === null ? null : occurrences, runs: [] };
    }
    if (route === '/api/bot-limit-resets') return { endpoints: seeded().limit };
    if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/address$/))) {
      need(seeded().webhooks, m[1], 'webhook');
      return { address: `https://example.test/hooks/${m[1]}/SECRET-ADDRESS-KEY` };
    }
    if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/attempts$/))) { need(seeded().webhooks, m[1], 'webhook'); return { attempts: seeded().attempts[m[1]] || [] }; }
    if (route === '/api/bot-app-triggers/events') return seeded().catalog;
    if ((m = route.match(/^\/api\/bot-app-triggers\/([^/]+)$/))) return need(seeded().app, m[1], 'app automation');
    if (route === '/api/bot-app-triggers') return { triggers: seeded().app };
    if (route === '/api/triggers') return { triggers: seeded().webhooks.map(trigger), pending: [] };
    return undefined;
  }

  const requireRevision = (record, body) => {
    if (body.expected_revision !== undefined && body.expected_revision !== record.revision) throw new Refusal(409, 'This changed since you opened it.', { code: 'stale' });
  };

  function handle(route, method, body, query) {
    const s = seeded();
    let m;
    s.calls.push({ route, method });
    if (route === '/api/bot-routines/preview' && method === 'POST') {
      const record = body.routine_id ? routine(body.routine_id) : null;
      const schedule = body.schedule || record?.schedule;
      validateSchedule(schedule);
      return { sentence: sentence(schedule), next: nextTimes(schedule, 3).map(iso), warnings: [] };
    }
    if (route === '/api/bot-routines' && method === 'POST') {
      const name = String(body.name || '').trim(), prompt = String(body.prompt || '').trim();
      if (!name) throw bad('A routine needs a name.'); if (!prompt) throw bad('A routine needs instructions.');
      validateSchedule(body.schedule);
      const r = refresh({ id: `r${++s.counter}`, agent_id: body.bot_id, name, prompt, enabled: body.enabled !== false, revision: 1, schedule: body.schedule, duration_minutes: body.duration_minutes || 30,
        timeout_minutes: body.timeout_minutes ?? null, overlap: body.overlap || 'skip', continuity: !!body.continuity, run_on_startup: !!body.run_on_startup, results_thread_id: body.results_thread_id || null,
        access: body.access || 'normal', call: !!body.call, recent_runs: [] });
      s.routines.push(r);
      return withStatus(r);
    }
    if ((m = route.match(/^\/api\/bot-routines\/([^/]+)$/)) && ['PATCH', 'DELETE'].includes(method)) {
      const r = need(s.routines, m[1], 'routine');
      if (method === 'DELETE') {
        requireRevision(r, { expected_revision: query.expected_revision === undefined ? undefined : Number(query.expected_revision) });
        const receipt = `rc${++s.counter}`;
        s.routines = s.routines.filter(x => x.id !== r.id);
        s.receipts[receipt] = r;
        return { ok: true, receipt_id: receipt };
      }
      requireRevision(r, body);
      for (const key of ['name', 'prompt', 'enabled', 'duration_minutes', 'timeout_minutes', 'overlap', 'continuity', 'run_on_startup', 'results_thread_id', 'access', 'call']) if (body[key] !== undefined) r[key] = body[key];
      if (body.schedule) { validateSchedule(body.schedule); r.schedule = body.schedule; }
      if (!String(r.name).trim()) throw bad('A routine needs a name.');
      r.revision += 1; refresh(r);
      return withStatus(r);
    }
    if ((m = route.match(/^\/api\/bot-routines\/([^/]+)\/(run|defer)$/)) && method === 'POST') {
      const r = need(s.routines, m[1], 'routine');
      if (m[2] === 'defer') { if (!body.until) throw bad('until is required'); r.next_run_at = body.until; return { ok: true, next_run_at: r.next_run_at }; }
      const key = body.request_id || '';
      if (key && s.requests[key]) return { ok: true, run_id: s.requests[key], duplicate: true };
      const id = `run${++s.counter}`;
      if (key) s.requests[key] = id;
      r.recent_runs.unshift({ id, routine_id: r.id, agent_id: r.agent_id, automation_status: 'running', trigger_type: 'manual', started_at: iso(clock()), thread_id: `auto-t-${id}` });
      return { ok: true, run_id: id };
    }
    if ((m = route.match(/^\/api\/bot-routine-runs\/([^/]+)\/(cancel|seen)$/)) && method === 'POST') {
      for (const r of s.routines) { const found = r.recent_runs.find(x => x.id === m[1]); if (found) { if (m[2] === 'cancel') found.automation_status = 'cancelled'; else found.seen = true; return { ok: true }; } }
      throw new Refusal(404, 'run not found');
    }
    if (route === '/api/bot-routine-runs/seen-all' && method === 'POST') { for (const r of s.routines) for (const x of r.recent_runs) x.seen = true; return { ok: true }; }
    if ((m = route.match(/^\/api\/bot-automation-changes\/([^/]+)\/undo$/)) && method === 'POST') {
      const r = s.receipts[m[1]];
      if (!r) return undefined;
      delete s.receipts[m[1]]; s.routines.push(refresh(r));
      return { ok: true };
    }
    if (route === '/api/bot-limit-resets/after-reset' && method === 'POST') {
      const r = need(s.routines, body.routine_id, 'routine'), e = s.limit.find(x => x.endpoint_id === body.endpoint_id);
      if (!e) throw new Refusal(404, 'limit not found');
      r.next_run_at = iso(Date.parse(e.resets_at) + 60000); return { ok: true };
    }
    if (route === '/api/bot-limit-resets/continue' && method === 'POST') {
      const e = s.limit[0];
      s.routines.push(refresh({ id: `r${++s.counter}`, agent_id: body.bot_id, name: 'Continue the chat', prompt: 'Carry on.', enabled: true, revision: 1, schedule: { kind: 'limit_reset', endpoint_id: e.endpoint_id, repeat: 'once' }, recent_runs: [] }));
      return { ok: true };
    }
    if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/restore$/)) && method === 'POST') {
      const at = s.deleted.findIndex(d => d.kind === 'webhook' && d.record.id === m[1]);
      if (at < 0) throw new Refusal(404, 'nothing to restore');
      s.webhooks.push(s.deleted.splice(at, 1)[0].record); return { ok: true };
    }
    if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/(test|capture|rotate)$/)) && method === 'POST') { need(s.webhooks, m[1], 'webhook'); return { ok: true }; }
    if (route === '/api/bot-app-triggers' && method === 'POST') {
      if (!body.app || !body.event) throw bad('app and event are required');
      if (!String(body.prompt_template || '').trim()) throw bad('instructions are required');
      const p = { id: `p${++s.counter}`, agent_id: body.agent_id, name: body.name || 'App automation', enabled: true, app: body.app, app_name: body.app, event: body.event, delivery: 'poll', interval_minutes: 15,
        filters: body.filters || {}, config: body.config || {}, prompt_template: body.prompt_template, account_id: body.account_id || null, revision: 1, attempts: [] };
      s.app.push(p); return p;
    }
    if ((m = route.match(/^\/api\/bot-app-triggers\/([^/]+)$/)) && ['PATCH', 'DELETE'].includes(method)) {
      const p = need(s.app, m[1], 'app automation');
      if (method === 'DELETE') { s.app = s.app.filter(x => x.id !== p.id); s.deleted.push({ kind: 'app', record: p }); return { ok: true }; }
      requireRevision(p, body);
      for (const key of ['enabled', 'name', 'prompt_template', 'filters', 'config', 'account_id']) if (body[key] !== undefined) p[key] = body[key];
      p.revision += 1; return p;
    }
    if ((m = route.match(/^\/api\/bot-app-triggers\/([^/]+)\/(test|sync|restore)$/)) && method === 'POST') {
      if (m[2] === 'restore') { const at = s.deleted.findIndex(d => d.kind === 'app' && d.record.id === m[1]); if (at < 0) throw new Refusal(404, 'nothing to restore'); s.app.push(s.deleted.splice(at, 1)[0].record); return { ok: true }; }
      need(s.app, m[1], 'app automation'); return { ok: true };
    }
    if (route === '/api/triggers' && method === 'POST') {
      if (!String(body.name || '').trim()) throw bad('name is required');
      const w = { id: `w${++s.counter}`, agent_id: body.agent_id, name: body.name, enabled: true, auto_run: !!body.auto_run, events: body.events || [], prompt_template: body.prompt_template || '', max_pending: body.max_pending || 3, revision: 1 };
      s.webhooks.push(w); s.attempts[w.id] = [];
      return { ...trigger(w), path: `/hooks/${w.id}`, secret: 'whsec_FIXTURE_ONE_TIME_SECRET' };
    }
    if ((m = route.match(/^\/api\/triggers\/([^/]+)$/)) && ['PATCH', 'DELETE'].includes(method)) {
      const w = need(s.webhooks, m[1], 'webhook');
      if (method === 'DELETE') { s.webhooks = s.webhooks.filter(x => x.id !== w.id); s.deleted.push({ kind: 'webhook', record: w }); return { ok: true }; }
      for (const key of ['enabled', 'name', 'prompt_template', 'events', 'auto_run', 'max_pending']) if (body[key] !== undefined) w[key] = body[key];
      w.revision += 1; return trigger(w);
    }
    return undefined;
  }

  return { read, mutate };
};
