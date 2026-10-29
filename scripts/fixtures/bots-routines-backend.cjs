// The routines API contract (Bots redesign, Phase 3 unit U2, 2026-10-29), in memory, for the Electron checks.
// Spec: phase-3-design.md section 6; the server is routes/bot_routine_routes.py. It answers only its own
// routes (/api/bot-routines*, /api/bot-routine-runs*) and returns undefined for the rest, like every Bots fixture.
// State lives in state.botsRoutines. scripts/test_bots_routine_contract.cjs holds it to the server's DTO keys.
const STATUSES = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'missed'];
// The legacy `outcome` every run record still carries, per canonical status.
const OUTCOME = { queued: 'queued', running: 'running', waiting: 'running', completed: 'succeeded', failed: 'failed', cancelled: 'stopped', missed: 'lost' };
const ROUTINE_KEYS = ['id', 'bot_id', 'name', 'instructions', 'enabled', 'report', 'schedule', 'sentence', 'next_run_at', 'overlap', 'access',
  'deliver', 'duration_minutes', 'timeout_minutes', 'continuity', 'call', 'run_on_startup', 'attachments', 'checks', 'source_thread_id',
  'results_thread_id', 'revision', 'legacy', 'state', 'status', 'running', 'waiting', 'recent_runs', 'last_run'];
const RUN_KEYS = ['id', 'routine_id', 'status', 'outcome', 'scheduled_for', 'started_at', 'finished_at', 'trigger_type', 'retry_count',
  'execution_thread_id', 'destination', 'attention', 'seen', 'report_state', 'output', 'error'];
const ACTIVE = ['queued', 'running', 'waiting'];

const refuse = (status, detail, field, code) => ({ _status: status, detail, code: code || (status === 409 ? 'stale' : 'invalid'), field: field || null });
const cronError = (expr) => {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length === 6) return refuse(400, 'Six fields means seconds, which are not supported. Use five: minute hour day month weekday.', 'expression');
  if (parts.length !== 5) return refuse(400, `A cron schedule needs five fields, and this has ${parts.length}.`, 'expression');
  return null;
};
const sentence = (s) => {
  if (s.kind === 'daily') return `Every ${s.weekdays && s.weekdays.length < 7 ? 'weekday' : 'day'} at ${s.time}`;
  if (s.kind === 'interval') return `Every ${s.every_minutes} minutes`;
  if (s.kind === 'cron') return `On the schedule ${s.expression}`;
  if (s.kind === 'once') return 'Once';
  return 'When the usage limit resets';
};
const nextTimes = (s, from, count) => {
  const step = s.kind === 'interval' ? s.every_minutes * 60 : 86400;
  return Array.from({ length: count }, (_, i) => new Date((from + step * (i + 1)) * 1000).toISOString());
};

module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const store = () => (state.botsRoutines ||= { counter: 0, routines: [], runs: [] });
  const runView = (r) => ({ ...r, outcome: OUTCOME[r.status] });
  const view = (r) => {
    const runs = store().runs.filter(x => x.routine_id === r.id).map(runView);
    const attention = runs.some(x => x.attention && !x.seen);
    const { rev, ...rest } = r;
    return { ...rest, revision: `r${rev}`, state: attention || runs[0]?.status === 'waiting' ? 'needs_you' : r.enabled ? 'working' : 'paused',
      running: runs[0]?.status === 'running', waiting: runs[0]?.status === 'waiting', recent_runs: runs.slice(0, 5), last_run: runs[0] || null, sentence: sentence(r.schedule) };
  };
  const find = (id) => store().routines.find(r => r.id === id);
  return {
    read(path, query) {
      if (path === '/api/bot-routines') return { routines: store().routines.filter(r => !query?.bot_id || r.bot_id === query.bot_id).map(view) };
      let m = /^\/api\/bot-routines\/([^/]+)$/.exec(path);
      if (m) return find(m[1]) ? view(find(m[1])) : { _status: 404, detail: 'routine not found' };
      m = /^\/api\/bot-routines\/([^/]+)\/runs$/.exec(path);
      if (m) return { runs: store().runs.filter(x => x.routine_id === m[1]).map(runView) };
      return undefined;
    },
    mutate(path, method, body) {
      const s = store();
      if (path === '/api/bot-routines/preview' && method === 'POST') {
        const sch = body.schedule || {};
        if (sch.kind === 'cron') {
          const e = cronError(sch.expression);
          if (e) return e;
          if (!sch.time_zone) return refuse(400, 'A cron schedule needs a named time zone.', 'time_zone');
        }
        return { sentence: sentence(sch), next: nextTimes(sch, clock(), 3), time_zone: sch.time_zone || null, schedule: sch };
      }
      if (path === '/api/bot-routines' && method === 'POST') {
        const sch = body.schedule || {};
        if (sch.kind === 'cron') { const e = cronError(sch.expression); if (e) return e; }
        if (s.routines.some(r => r.bot_id === body.bot_id && r.name === body.name)) return refuse(409, 'A routine with that name already exists.', 'name', 'duplicate');
        const routine = { id: `rt${++s.counter}`, bot_id: body.bot_id, name: body.name, instructions: body.instructions, enabled: body.enabled !== false, report: body.report || 'notable',
          schedule: sch, next_run_at: nextTimes(sch, clock(), 1)[0], overlap: body.overlap || 'skip', access: body.access || 'normal', deliver: body.deliver || 'normal',
          duration_minutes: body.duration_minutes || 30, timeout_minutes: body.timeout_minutes ?? null, continuity: !!body.continuity, call: false, run_on_startup: !!body.run_on_startup,
          attachments: [], checks: body.checks || [], source_thread_id: body.source_thread_id || null, results_thread_id: body.results_thread_id || null,
          legacy: false, status: { skipped: {}, check_trouble: [], failure_streak: 0, weekly: {}, wake_at: null, queued: false }, rev: 1 };
        s.routines.push(routine);
        return view(routine);
      }
      let m = /^\/api\/bot-routines\/([^/]+)$/.exec(path);
      if (m) {
        const r = find(m[1]);
        if (!r) return { _status: 404, detail: 'routine not found' };
        if (method === 'DELETE') { s.routines = s.routines.filter(x => x !== r); return { ok: true, id: r.id }; }
        if (method === 'PATCH') {
          if (body.expected_revision && body.expected_revision !== `r${r.rev}`) return refuse(409, 'This routine changed since you opened it. Reload it and try again.');
          if (body.schedule?.kind === 'cron') { const e = cronError(body.schedule.expression); if (e) return e; }
          for (const [k, v] of Object.entries(body)) if (k !== 'expected_revision') r[k] = v;
          if (body.schedule) r.next_run_at = nextTimes(r.schedule, clock(), 1)[0];
          r.rev += 1;
          return view(r);
        }
      }
      m = /^\/api\/bot-routines\/([^/]+)\/run$/.exec(path);
      if (m && method === 'POST') {
        const r = find(m[1]);
        if (!r) return { _status: 404, detail: 'routine not found' };
        if (s.runs.some(x => x.routine_id === r.id && ACTIVE.includes(x.status))) return refuse(409, 'This routine is already running.', null, 'running');
        const id = `run${s.runs.length + 1}`;
        const run = { id, routine_id: r.id, status: 'waiting', scheduled_for: null, started_at: clock(), finished_at: null, trigger_type: 'manual',
          retry_count: 0, execution_thread_id: `th-${id}`, destination: r.results_thread_id, attention: null, seen: false, report_state: null, output: '', error: null };
        s.runs.unshift(run);
        return { started: true, run: runView(run) };
      }
      m = /^\/api\/bot-routine-runs\/([^/]+)\/(cancel|seen)$/.exec(path);
      if (m && method === 'POST') {
        const run = s.runs.find(x => x.id === m[1]);
        if (!run) return { _status: 404, detail: 'run not found' };
        if (m[2] === 'seen') { run.seen = true; return runView(run); }
        if (!ACTIVE.includes(run.status)) return refuse(409, 'That run is not active.', null, 'not_active');
        Object.assign(run, { status: 'cancelled', finished_at: clock() });
        return { ok: true, id: run.id };
      }
      return undefined;
    },
  };
};
module.exports.STATUSES = STATUSES;
module.exports.OUTCOME = OUTCOME;
module.exports.ROUTINE_KEYS = ROUTINE_KEYS;
module.exports.RUN_KEYS = RUN_KEYS;
