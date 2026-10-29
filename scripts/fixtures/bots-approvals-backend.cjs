// The approvals lane of the Bots fixture backend (Phase 3 unit U1): /api/bots-approvals/:bot[...] and the desktop
// handshake's /api/internal/bots-approvals/:step. It follows core/bot_policy.py: five levels, a conversation may narrow its bot
// but not widen it, raising a level takes prepare -> confirm -> activate -> commit, and sends draw on a daily allowance.
// State lives under state.botsApprovals, keyed by bot id:
//   bots[id]  {mode, revision, threads:{id:mode|null}, used, requests:{rid:{...phase}}, rules:[], outbound:{policy, cap}}
// Fixture-only helpers (not real routes), under /api/bots-approvals-fixture/:bot/:thing:
//   threads (POST {count})  makes conversations;  send (POST {thread_id})  one outside send at the current level.
// Handlers return undefined for routes they do not own.
const core = require('./bots-core-backend.cjs');

class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }

const MODES = ['ask', 'edits', 'auto', 'full', 'custom'];
const LABEL = { ask: 'Ask', edits: 'Edits', auto: 'Auto', full: 'Full', custom: 'Custom' };
const BLURB = {
  ask: 'Reads go ahead. Changes and running things ask you first.',
  edits: 'Edits to its own folders go ahead. Running things and outside changes ask.',
  auto: 'A careful reviewer allows safe steps. Anything it doubts asks you.',
  full: 'Goes ahead without asking, including sending on its own.',
  custom: 'Codex only. Exact commands you have approved go ahead. Everything else asks.',
};
const RANK = { ask: 0, custom: 0.5, edits: 1, auto: 2, full: 3 };
const raises = (current, target) => target !== current && (target === 'custom' || RANK[target] > RANK[current]);

module.exports = ({ state, data, now }) => {
  const base = core({ state, data, now });
  const lane = () => (state.botsApprovals ||= { bots: {}, counter: 0 });
  const need = id => {
    const bot = base.store().agents.find(a => a.id === id);
    if (!bot) throw new Refusal(404, 'No such bot.');
    return bot;
  };
  const entry = id => {
    need(id);
    return (lane().bots[id] ||= { mode: 'full', revision: 0, threads: {}, used: 0, requests: {}, rules: [], outbound: { policy: 'allow', cap: 3 } });
  };
  const levels = () => MODES.map(mode => ({ mode, label: LABEL[mode], blurb: BLURB[mode], available: mode !== 'custom',
    reason: mode === 'custom' ? 'Custom is for Codex. This bot\'s AI runs at Ask, Edits, Auto or Full.' : null }));
  const effectiveOf = (e, thread) => {
    const override = thread ? e.threads[thread] : null;
    if (override && (RANK[override] <= RANK[e.mode] || e.grants?.[thread] === override)) return override;
    return e.mode;
  };
  const view = (id, thread) => {
    const e = entry(id);
    if (thread && !(thread in e.threads)) throw new Refusal(404, 'No such conversation for this bot.');
    const override = thread ? e.threads[thread] : null;
    const mode = effectiveOf(e, thread);
    return { bot_id: id, thread_id: thread || null, mode, stored: override || e.mode, source: override ? 'thread' : 'bot', inherited: !override,
      revision: e.revision, reason: null, supported: true, provider: 'claude', bot_mode: e.mode, thread_mode: override, levels: levels(),
      stored_bot: e.mode, commands: e.rules.length, state_corrupt: false };
  };

  function setMode(id, body) {
    const e = entry(id);
    if (body.expected_revision != null && body.expected_revision !== e.revision) throw new Refusal(409, 'Approval changed somewhere else. Reload and try again.');
    if (body.mode != null && !MODES.includes(body.mode)) throw new Refusal(422, 'bad mode');
    const scope = body.scope || 'bot';
    if (body.mode == null && scope !== 'thread') throw new Refusal(400, 'Only a conversation can follow its bot.');
    if (scope === 'thread') {
      if (!(body.thread_id in e.threads)) throw new Refusal(404, 'No such conversation for this bot.');
      if (body.mode != null && raises(effectiveOf(e, body.thread_id), body.mode)) throw new Refusal(409, `Raising approval to ${LABEL[body.mode]} needs your confirmation in the desktop app.`);
      e.threads[body.thread_id] = body.mode;
    } else {
      if (raises(e.mode, body.mode)) throw new Refusal(409, `Raising approval to ${LABEL[body.mode]} needs your confirmation in the desktop app.`);
      e.mode = body.mode;
      if (scope === 'all_threads') for (const t of Object.keys(e.threads)) e.threads[t] = null;
    }
    e.revision += 1;
    return view(id, scope === 'thread' ? body.thread_id : null);
  }

  function elevate(id, body) {
    const e = entry(id);
    if (!['edits', 'auto', 'full', 'custom'].includes(body.mode)) throw new Refusal(400, 'Only a higher level needs confirming.');
    if (body.expected_revision != null && body.expected_revision !== e.revision) throw new Refusal(409, 'Approval changed somewhere else. Reload and try again.');
    const thread = body.scope === 'thread' ? body.thread_id : null;
    if (thread && !(thread in e.threads)) throw new Refusal(404, 'No such conversation for this bot.');
    if (!raises(thread ? effectiveOf(e, thread) : e.mode, body.mode)) throw new Refusal(400, 'This is not higher than the current level. Use the ordinary change.');
    const request_id = `rq${++lane().counter}`;
    e.requests = { [request_id]: { bot_id: id, thread_id: thread, mode: body.mode, revision: e.revision, phase: 'prepared' } };
    return { request_id, bot_id: id, thread_id: thread, mode: body.mode, scope: thread ? 'thread' : 'bot', revision: e.revision, expires_in: 300, bot_name: need(id).name };
  }

  function step(name, body) {
    if (name === 'revoke') {
      for (const e of Object.values(lane().bots)) if (e.requests[body.request_id]) { delete e.requests[body.request_id]; return { revoked: true }; }
      return { revoked: false };
    }
    const e = lane().bots[body.bot_id];
    const request = e?.requests[body.request_id];
    if (!request) throw new Refusal(400, 'That request is not waiting for confirmation.');
    if (request.bot_id !== body.bot_id || (request.thread_id || null) !== (body.thread_id || null) || request.mode !== body.mode || request.revision !== body.revision) {
      throw new Refusal(400, 'That confirmation does not match the request.');
    }
    const order = { confirm: ['prepared', 'confirmed'], activate: ['confirmed', 'activated'], commit: ['activated', 'committed'] }[name];
    if (request.phase !== order[0]) throw new Refusal(400, `That step is out of order: the request is ${request.phase}.`);
    request.phase = order[1];
    if (name === 'commit') {
      if (request.thread_id) { e.threads[request.thread_id] = request.mode; (e.grants ||= {})[request.thread_id] = request.mode; }
      else e.mode = request.mode;
      e.revision += 1;
      delete e.requests[body.request_id];
      return { ...view(body.bot_id, request.thread_id), request_id: body.request_id, phase: 'committed' };
    }
    return { request_id: body.request_id, phase: request.phase };
  }

  const outbound = id => {
    const e = entry(id);
    return { policy: e.outbound.policy, cap: e.outbound.cap, used: e.used, reserved: 0, remaining: Math.max(0, e.outbound.cap - e.used), date: '2026-10-29', zone: 'UTC', resets_at: 1793318400 };
  };
  function send(id, body) {
    const e = entry(id);
    const mode = effectiveOf(e, body.thread_id);
    if (mode === 'full') return { decision: 'allow', source: 'full', mode };
    if (e.outbound.policy !== 'allow') return { decision: 'ask', source: 'outbound-ask', mode };
    if (e.used >= e.outbound.cap) return { decision: 'ask', source: 'allowance-exhausted', mode };
    e.used += 1;
    return { decision: 'allow', source: 'allowance', mode };
  }

  const wrap = fn => (route, ...rest) => {
    if (!state.botsLive) return undefined;
    try { return fn(route, ...rest); }
    catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
  };
  return {
    read: wrap((route, query = {}) => {
      let m = route.match(/^\/api\/bots-approvals\/([^/]+)$/);
      if (m) return view(m[1], query.thread_id || null);
      m = route.match(/^\/api\/bots-approvals\/([^/]+)\/outbound$/);
      if (m) return outbound(m[1]);
      m = route.match(/^\/api\/bots-approvals\/([^/]+)\/commands$/);
      if (m) return { rules: entry(m[1]).rules, limit: 200, state_corrupt: false };
      return undefined;
    }),
    mutate: wrap((route, method, body = {}) => {
      let m = route.match(/^\/api\/bots-approvals\/([^/]+)\/(mode|elevate)$/);
      if (m && method === 'POST') return m[2] === 'mode' ? setMode(m[1], body || {}) : elevate(m[1], body || {});
      m = route.match(/^\/api\/internal\/bots-approvals\/(confirm|activate|commit|revoke)$/);
      if (m && method === 'POST') return step(m[1], body || {});
      m = route.match(/^\/api\/bots-approvals\/([^/]+)\/commands\/([^/]+)$/);
      if (m && method === 'DELETE') {
        const e = entry(m[1]);
        if (!e.rules.some(r => r.id === m[2])) throw new Refusal(404, 'No such rule.');
        e.rules = e.rules.filter(r => r.id !== m[2]);
        return { status: 'removed' };
      }
      m = route.match(/^\/api\/bots-approvals-fixture\/([^/]+)\/(threads|send|rule)$/);
      if (m && method === 'POST') {
        const e = entry(m[1]);
        if (m[2] === 'threads') {
          const ids = [];
          for (let i = 0; i < (body.count || 1); i++) { const tid = `th${++lane().counter}`; e.threads[tid] = null; ids.push(tid); }
          return { ids };
        }
        if (m[2] === 'rule') { e.rules.push({ id: `rule${++lane().counter}`, command: body.command, cwd: body.cwd, provider: 'claude', created_at: 0 }); return { ok: true }; }
        return send(m[1], body || {});
      }
      return undefined;
    }),
  };
};
