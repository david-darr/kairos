// The durable cards and applied-change routes, in memory, for the Electron checks (Phase 3 unit U5, 2026-10-29).
// Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 5.3, 6 and 9. ui-smoke.cjs consults every
// scripts/fixtures/bots-*-backend.cjs before demo/fixtures.js while demoState.botsLive is set: read(path, query) and
// mutate(path, method, body, query) answer a route or return undefined to let someone else have it.
//
// This backend answers only its own namespaces: /api/bot-cards and /api/bot-automation-changes. The one exception is
// PATCH /api/tasks/<id> for the routines this fixture itself made (ids start with "bcc-"), because the change card's
// Pause button uses the existing task route; every other task id falls through. State lives in state.botsCards.
//
// Test controls (fixture only, not routes of the real backend):
//   POST /api/bot-cards/__fixture/open               open a card: { kind, thread_id, bot_id, title, ... }
//   POST /api/bot-cards/__fixture/expire/<id>        settle a card as the backend would after a restart
//   POST /api/bot-automation-changes/__fixture/apply apply a bot's routine change and write its receipt
// The rules mirror services/bot_cards.py and services/bot_automation_changes.py: one settlement per card, answers only
// from the displayed choices, answers by question id, the six-question limit, and a revision-checked Undo.
class Refusal extends Error { constructor(status, detail, extra = {}) { super(detail); this.status = status; this.extra = extra; } }
const MAX_QUESTIONS = 6, MAX_OPTIONS = 12, MAX_CUSTOM = 2000;

module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const seeded = () => (state.botsCards ||= { counter: 0, cards: [], changes: [], routines: [], settled: {}, answers: [] });
  const publicCard = (c) => ({ ...JSON.parse(JSON.stringify(c)), waiting: c.status === 'pending' || c.status === 'settling' });
  const publicChange = (r) => {
    const { _before, ...shown } = JSON.parse(JSON.stringify(r));
    return { ...shown, undoable: r.state === 'applied', undo_expired: false };
  };
  const card = (id) => { const c = seeded().cards.find(x => x.id === id); if (!c) throw new Refusal(404, 'No card with that id.'); return c; };
  const conflict = (c, detail) => new Refusal(409, detail, { card: publicCard(c) });

  const questions = (raw) => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_QUESTIONS) throw new Refusal(400, `Ask 1 to ${MAX_QUESTIONS} questions.`);
    return raw.map((q, i) => {
      if (!q.options || q.options.length > MAX_OPTIONS) throw new Refusal(400, `A question has at most ${MAX_OPTIONS} options.`);
      return { id: q.id || `q${i + 1}`, question: q.question, header: q.header || '', multi_select: q.multi_select === true,
        allow_custom: q.allow_custom !== false, options: q.options.map(o => ({ label: o.label, description: o.description || '' })) };
    });
  };
  const settle = (c, status, outcome = {}) => {
    const store = seeded();
    store.settled[c.id] = (store.settled[c.id] || 0) + 1;
    Object.assign(c, { status, settled_at: clock(), outcome });
  };

  const open = (body) => {
    const store = seeded();
    const kind = body.kind || 'approval';
    const base = { id: `bcard-${++store.counter}`, owner_user: 'local', bot_id: body.bot_id, thread_id: body.thread_id, run_id: null, generation: 0,
      kind, status: 'pending', revision: 1, title: body.title || 'Needs you', details: body.details || { summary: '', lines: [], target: '', tool: '' },
      choices: [], questions: null, persistent: !!body.persistent, source_key: null, resume: body.resume || null,
      created_at: clock() + store.counter, expires_at: clock() + 3600, settled_at: null, outcome: null };
    if (kind === 'approval') base.choices = body.choices || [
      { id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' },
      { id: 'forever', label: `Always allow ${base.details.target || 'this'}`, behavior: 'allow', scope: 'forever' },
      { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' }];
    if (kind === 'question') base.questions = questions(body.questions);
    store.cards.push(base);
    return publicCard(base);
  };

  const respond = (c, body) => {
    if (c.status !== 'pending') throw conflict(c, 'This was already settled.');
    if (body.reviewed_revision !== undefined && body.reviewed_revision !== c.revision) throw conflict(c, 'The details changed. Review them again.');
    const action = body.action;
    if (c.kind === 'approval') {
      if (!['allow', 'deny'].includes(action)) throw new Refusal(400, 'Choose Allow or Deny.');
      let choice;
      if (action === 'deny') choice = c.choices.find(x => x.behavior === 'deny');
      else {
        const scope = { once: 'once', session: 'session', always: 'forever' }[body.remember || 'once'];
        choice = c.choices.find(x => x.behavior === 'allow' && x.scope === scope);
        if (!choice) throw new Refusal(400, 'That kind of Always allow was not offered for this request.');
      }
      settle(c, choice.behavior === 'allow' ? 'allowed' : 'denied', { by: 'local', choice_id: choice.id, label: choice.label, scope: choice.scope, reason: '' });
      return { ok: true, card: publicCard(c), message: '' };
    }
    if (c.kind === 'question') {
      if (action === 'skip') { settle(c, 'skipped', { by: 'local', reason: '' }); return { ok: true, card: publicCard(c), message: '' }; }
      if (action !== 'answer' || !body.answers || typeof body.answers !== 'object') throw new Refusal(400, 'Answer the questions or skip them.');
      const clean = {};
      for (const q of c.questions) {
        const raw = body.answers[q.id] ?? body.answers[q.question];
        const labels = q.options.map(o => o.label);
        const one = v => typeof v === 'string' && v.trim() && v.trim().length <= MAX_CUSTOM && (labels.includes(v.trim()) || q.allow_custom) ? v.trim() : null;
        if (q.multi_select) {
          const list = (Array.isArray(raw) ? raw : [raw]).map(one);
          if (!list.length || list.some(v => v === null) || new Set(list).size !== list.length) throw new Refusal(400, 'Each question needs a valid answer.');
          clean[q.id] = list;
        } else {
          const single = typeof raw === 'string' ? one(raw) : null;
          if (single === null) throw new Refusal(400, 'Each question needs a valid answer.');
          clean[q.id] = single;
        }
      }
      seeded().answers.push({ id: c.id, answers: clean });
      settle(c, 'answered', { by: 'local', answers: clean, reason: '' });
      return { ok: true, card: publicCard(c), message: '' };
    }
    throw new Refusal(400, 'This card is answered through its own action.');
  };

  const routine = (id) => seeded().routines.find(r => r.id === id);
  const revision = (r) => `rev${r.rev}`;

  const apply = (body) => {
    const store = seeded();
    const make = (extra) => {
      const rid = `rcpt-${++store.counter}`;
      const r = { id: rid, owner_user: 'local', bot_id: body.bot_id, thread_id: body.thread_id, run_id: null, invocation_id: null, kind: 'routine',
        action: body.action || 'create', target_id: null, target_name: null, state: 'applied', tainted: false, unattended: false, summary: '',
        details: [], created_at: clock() + store.counter, applied_at: clock(), undone_at: null, error: null, last_undo_error: null, ...extra };
      store.changes.push(r);
      return r;
    };
    if (body.action === 'update') {
      const target = routine(body.target_id);
      const before = JSON.parse(JSON.stringify(target));
      Object.assign(target, body.patch || {}); target.rev += 1;
      const rows = Object.keys(body.patch || {}).map(k => ({ label: k, before: String(before[k] ?? ''), after: String(target[k]) }));
      const r = make({ target_id: target.id, target_name: target.name, summary: `Changed routine "${target.name}".`, details: rows });
      r._before = before; r.after_revision = revision(target);
      return publicChange(r);
    }
    const target = { id: `bcc-${++store.counter}`, bot_id: body.bot_id, name: body.name || 'Morning brief', prompt: 'Summarize my inbox.', enabled: true,
      run_time: body.run_time || '08:00', schedule_kind: 'daily', rev: 1 };
    store.routines.push(target);
    const r = make({ target_id: target.id, target_name: target.name, summary: `Added routine "${target.name}": every day at ${target.run_time}.`,
      details: [{ label: 'name', before: '', after: target.name }, { label: 'run time', before: '', after: target.run_time }] });
    r.after_revision = revision(target);
    return publicChange(r);
  };

  const undo = (id) => {
    const r = seeded().changes.find(x => x.id === id);
    if (!r) throw new Refusal(404, 'No change with that id.');
    if (r.state === 'undone') return { ...publicChange(r), already_undone: true };
    const target = routine(r.target_id);
    if (!target) throw new Refusal(409, 'It was already deleted, so there is nothing left to undo.', { code: 'stale' });
    if (revision(target) !== r.after_revision) {
      r.last_undo_error = 'It was changed after this, so Undo left it alone.';
      throw new Refusal(409, r.last_undo_error, { code: 'stale' });
    }
    if (r.action === 'create') seeded().routines.splice(seeded().routines.indexOf(target), 1);
    else { Object.assign(target, r._before); target.rev += 1; }
    r.state = 'undone'; r.undone_at = clock();
    return publicChange(r);
  };

  const wrap = (fn) => {
    try { return fn(); } catch (error) {
      if (error instanceof Refusal) return { _status: error.status, detail: error.message, ...error.extra };
      throw error;
    }
  };

  return {
    read(route, query = {}) {
      if (!state.botsLive) return undefined;
      return wrap(() => {
        if (route === '/api/bot-cards') {
          const list = seeded().cards.filter(c => (!query.thread_id || c.thread_id === query.thread_id) && (!query.bot_id || c.bot_id === query.bot_id)
            && (!query.status || (query.status === 'pending' ? c.status === 'pending' : c.status === query.status)));
          return { cards: list.map(publicCard), pending: list.filter(c => c.status === 'pending').length };
        }
        if (route === '/api/bot-automation-changes') {
          const list = seeded().changes.filter(r => (!query.thread_id || r.thread_id === query.thread_id) && (!query.bot_id || r.bot_id === query.bot_id));
          return { changes: list.map(publicChange) };
        }
        let m;
        if ((m = route.match(/^\/api\/bot-automation-changes\/([^/]+)$/))) {
          const r = seeded().changes.find(x => x.id === m[1]);
          if (!r) throw new Refusal(404, 'No change with that id.');
          return publicChange(r);
        }
        return undefined;
      });
    },

    mutate(route, method, body = {}) {
      if (!state.botsLive) return undefined;
      return wrap(() => {
        let m;
        if (route === '/api/bot-cards/__fixture/open' && method === 'POST') return open(body);
        if ((m = route.match(/^\/api\/bot-cards\/__fixture\/expire\/([^/]+)$/)) && method === 'POST') {
          const c = card(m[1]);
          if (c.status === 'pending') settle(c, 'unavailable', { reason: 'Kairos restarted before this was answered, so the action did not run.' });
          return publicCard(c);
        }
        if (route === '/api/bot-automation-changes/__fixture/apply' && method === 'POST') return apply(body);
        if ((m = route.match(/^\/api\/bot-cards\/([^/]+)\/respond$/)) && method === 'POST') return respond(card(m[1]), body);
        if ((m = route.match(/^\/api\/bot-cards\/([^/]+)\/resume$/)) && method === 'POST') {
          const c = card(m[1]);
          if (c.status !== 'pending') throw conflict(c, 'This was already settled.');
          if (!['connector', 'credential', 'signin', 'computer'].includes(c.kind)) throw new Refusal(400, 'This card is answered with Allow, Deny or its questions.');
          settle(c, body.outcome === 'done' ? 'answered' : 'skipped', { by: 'local', resume: body.outcome, reason: '' });
          return { ok: true, card: publicCard(c), message: '' };
        }
        if ((m = route.match(/^\/api\/bot-automation-changes\/([^/]+)\/undo$/)) && method === 'POST') return undo(m[1]);
        if ((m = route.match(/^\/api\/tasks\/(bcc-[^/]+)$/)) && method === 'PATCH') {
          const target = routine(m[1]);
          if (!target) throw new Refusal(404, 'task not found');
          for (const key of ['enabled', 'name', 'prompt']) if (key in body) target[key] = body[key];
          target.rev += 1;
          return { ...target };
        }
        return undefined;
      });
    },
  };
};
