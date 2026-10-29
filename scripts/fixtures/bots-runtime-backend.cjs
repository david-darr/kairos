// The Bots conversation runtime's API contract, in memory, for the Electron checks (Phase 1 unit U1, 2026-10-29).
// Spec: Kairos Projects/Agents Redesign/phase-1-design.md, sections 3.2, 3.3, 4 and 5.1. It follows
// routes/bot_chat_routes.py and services/bot_chat_service.py: durable acceptance by send ID (409 on a different
// message), a message tree with edit/regenerate versions, a queue with reasons (busy, capacity, queued-ahead),
// guarded Stop (a stale turn ID is a no-op), steer by interruption, and a solo goal.
// ui-smoke.cjs consults this file before demo/fixtures.js while demoState.botsLive is set (read/mutate return
// undefined for a route that is not theirs). State lives in state.botsRuntime. A check drives the synthetic
// model through state.botsRuntimeControl (seed, finish, fail); scripts/test_bots_runtime_fixtures.cjs holds this
// file to the same cases as the Python suites. Not part of the site demo.
const REACTIONS = ['thumbs_up', 'thumbs_down', 'heart', 'laugh', 'tada', 'eyes'];
const COALESCE_SECONDS = 120, MAX_COALESCE = 30, MAX_GOAL_STEPS = 13, PAGE_MAX = 200;

class Refusal extends Error { constructor(status, detail, extra = {}) { super(detail); this.status = status; this.extra = extra; } }
const conflict = (detail) => new Refusal(409, detail);

module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000) + (state.botsRuntime?.skew || 0);
  const store = () => state.botsRuntime || (state.botsRuntime = { counter: 0, convs: {}, bots: {}, skew: 0 });
  const id = (prefix) => `${prefix}${(++store().counter).toString(36).padStart(6, '0')}`;
  const conv = (sid) => { const c = store().convs[sid]; if (!c) throw new Refusal(404, 'conversation not found'); return c; };
  const byId = (c, mid) => c.messages.find(m => m.bot_message_id === mid);
  const path = (c) => { const out = []; let leaf = c.leaf; while (leaf) { const m = byId(c, leaf); out.unshift(m); leaf = m.parent_id; } return out; };
  const kids = (c, parent) => c.messages.filter(m => m.parent_id === parent).map(m => m.bot_message_id);
  const leafUnder = (c, mid) => { let cur = mid; for (;;) { const k = kids(c, cur); if (!k.length) return cur; cur = k.at(-1); } };
  const limitOf = (c) => store().bots[c.bot_id]?.limit ?? 3;
  const running = (bot, except) => Object.values(store().convs).filter(c => c.bot_id === bot && c.id !== except && c.turn?.status === 'running').length;
  const waiting = (c) => c.queue.filter(q => q.state === 'pending' || q.state === 'interrupted');
  const reasonFor = (c) => (c.turn?.status === 'running' || c.hold) ? 'busy' : waiting(c).length ? 'queued-ahead'
    : running(c.bot_id, c.id) >= limitOf(c) ? 'capacity' : null;
  const fingerprint = (p) => JSON.stringify([p.text, p.attachment_ids || [], p.reply_to_id || null, p.mode || null, p.kind || 'send', p.target || null]);

  function addMessage(c, role, content, extra = {}, parent) {
    const message = { bot_message_id: id('m'), parent_id: parent === undefined ? c.leaf : parent, role, content, ts: clock(), status: null, ...extra };
    c.messages.push(message); c.leaf = message.bot_message_id; c.revision += 1;
    if (role === 'assistant' && !extra.display_only) c.unread = true;
    return message;
  }
  function startTurn(c, message) {
    c.turn = { turn_id: id('t'), message_id: message.bot_message_id, status: 'running', started_at: clock() };
    return c.turn.turn_id;
  }
  function accept(c, owner, body, extra = {}) {
    const fp = fingerprint({ ...body, ...extra });
    const seen = c.receipts[body.send_id];
    if (seen) { if (seen.fp !== fp) throw conflict('This send ID was already used for a different message'); return { ...seen.result, replayed: true }; }
    if (body.expected_leaf_id !== c.leaf && !extra.existing) throw conflict('Conversation changed. Reload and try again.');
    if (extra.revision !== undefined && extra.revision !== c.revision) throw conflict('Conversation changed. Reload and try again.');
    const reason = extra.direct ? null : reasonFor(c);
    if (extra.direct && reasonFor(c)) throw conflict('This conversation is busy. Wait for the reply, or stop it first.');
    const result = { accepted: true, send_id: body.send_id, session_id: c.id, queued: !!reason, queue_id: null, reason, turn_id: null };
    if (reason) {
      const q = { id: id('q'), state: 'pending', send_id: body.send_id, text: body.text, mode: body.mode || null, created_at: clock(), attachment_ids: body.attachment_ids || [] };
      c.queue.push(q); result.queue_id = q.id; c.queueRevision += 1;
    } else {
      const message = extra.existing ? byId(c, extra.existing)
        : addMessage(c, 'user', body.text, { bot_send_id: body.send_id, mode: body.mode || null }, extra.parent);
      if (extra.existing) { c.leaf = message.bot_message_id; c.revision += 1; }
      result.turn_id = startTurn(c, message); result.message_id = message.bot_message_id; result.message = { ...message };
      if (body.mode === 'goal') c.goal = { root_id: id('g'), status: 'working', turn: 1, max_turns: MAX_GOAL_STEPS, goal: String(body.text).slice(0, 180), turn_id: result.turn_id };
    }
    Object.assign(result, { active_leaf_id: c.leaf, branch_revision: c.revision, queue_revision: c.queueRevision });
    c.receipts[body.send_id] = { fp, result };
    return result;
  }
  function drain(bot) {
    for (;;) {
      const next = Object.values(store().convs).filter(c => c.bot_id === bot && !c.paused && c.turn?.status !== 'running' && !c.hold && waiting(c).some(q => q.state === 'pending'))
        .sort((x, y) => waiting(x)[0].created_at - waiting(y)[0].created_at)[0];
      if (!next || running(bot) >= limitOf(next)) return;
      const rows = [];
      for (const q of next.queue.filter(x => x.state === 'pending')) {
        const last = rows.at(-1);
        if (last && (rows.length >= MAX_COALESCE || q.mode || last.mode || q.created_at - last.created_at > COALESCE_SECONDS)) break;
        rows.push(q);
      }
      const message = addMessage(next, 'user', rows.map(q => q.text).join('\n\n'), { bot_send_id: rows[0].send_id });
      rows.forEach(q => { q.state = 'consumed'; }); next.queueRevision += 1; startTurn(next, message);
    }
  }
  function finish(c, text, status) {
    const turn = c.turn; if (!turn || turn.status !== 'running') return false;
    addMessage(c, 'assistant', text, { status: status === 'failed' ? 'failed' : status === 'stopped' ? 'interrupted' : null }, turn.message_id);
    turn.status = status;
    if (status === 'stopped' && turn.reason !== 'steer') { addMessage(c, 'assistant', 'You stopped this.', { display_only: true, kind: 'stopped' }); c.paused = true; c.queueRevision += 1; }
    if (status === 'failed') { c.paused = true; c.queueRevision += 1; }
    if (c.goal && c.goal.status === 'working' && c.goal.turn_id === turn.turn_id && status !== 'done') c.goal.status = status === 'stopped' ? 'stopped' : 'failed';
    drain(c.bot_id); return true;
  }
  const reactionList = (reactions) => REACTIONS.filter(e => Object.values(reactions || {}).includes(e))
    .map(e => ({ emoji: e, count: Object.values(reactions).filter(x => x === e).length, mine: reactions.me === e }));
  const clientMessage = (m, c, versions) => { const { reactions, ...rest } = m;
    return { ...rest, id: m.bot_message_id, reply_to: m.reply_to_id ?? null, reactions: reactionList(reactions),
      ...(versions[m.bot_message_id] ? { version: { index: versions[m.bot_message_id].index, count: versions[m.bot_message_id].total, ids: versions[m.bot_message_id].ids } } : {}) }; };
  const versionsOf = (c) => { const out = {}; for (const m of path(c)) { const sib = kids(c, m.parent_id); if (sib.length > 1) out[m.bot_message_id] = { index: sib.indexOf(m.bot_message_id) + 1, total: sib.length, ids: sib }; } return out; };
  const queueView = (c) => ({ items: waiting(c).map(q => ({ ...q })), revision: c.queueRevision, paused: c.paused,
    consumed_queue_ids: c.queue.filter(q => q.state === 'consumed' || q.state === 'cancelled').slice(-64).map(q => q.id) });
  const page = (c, query = {}) => {
    const rows = path(c), limit = Math.max(1, Math.min(Number(query.limit) || 50, PAGE_MAX)); let start, end;
    if (query.around) { const i = rows.findIndex(m => m.bot_message_id === query.around);
      if (i < 0) { if (byId(c, query.around)) throw new Refusal(409, 'That message is in another version.', { branch_leaf: leafUnder(c, query.around) }); throw new Refusal(404, 'message not found'); }
      start = Math.max(0, Math.min(i - Math.floor(limit / 2), rows.length - limit)); end = Math.min(rows.length, start + limit);
    } else if (query.after) { const i = rows.findIndex(m => m.bot_message_id === query.after); if (i < 0) throw new Refusal(404, 'message not found'); start = i + 1; end = Math.min(rows.length, start + limit); }
    else if (query.before) { end = rows.findIndex(m => m.bot_message_id === query.before); if (end < 0) throw new Refusal(404, 'message not found'); start = Math.max(0, end - limit); }
    else { end = rows.length; start = Math.max(0, end - limit); }
    const versions = versionsOf(c), slice = rows.slice(start, end);
    return { messages: slice.map(m => clientMessage(m, c, versions)), has_before: start > 0, has_after: end < rows.length, first_id: slice[0]?.bot_message_id ?? null,
      last_id: slice.at(-1)?.bot_message_id ?? null, total: rows.length, active_leaf_id: c.leaf, branch_revision: c.revision, pinned_message_id: c.pinned, last_read_message_id: c.read };
  };
  const stateView = (c) => ({ session_id: c.id, bot_id: c.bot_id, active_leaf_id: c.leaf, branch_revision: c.revision,
    turn: c.turn ? { id: c.turn.turn_id, turn_id: c.turn.turn_id, status: c.turn.status, stopping: false, started_at: c.turn.started_at, permission: false } : null,
    queue: queueView(c), goal: c.goal ? { ...c.goal, label: c.goal.status } : null,
    context: { percent: null },
    model: { label: 'Test model', endpoint_id: 'm1', name: 'Test model', kind: 'claude_cli', model: null, effort: null },
    capabilities: { queue: true, steer: 'interrupt', edit: true, regenerate: true, images: true, compact: true, thread_limit: limitOf(c), steer_hint: 'This stops the current reply, then sends your message.' },
    pinned_message_id: c.pinned, last_read_message_id: c.read });

  state.botsRuntimeControl = {
    // A bot with a thread limit, and a conversation for it. Returns the conversation ID.
    seed(bot, limit = 3) { store().bots[bot] = { limit }; const sid = id('rt-'); store().convs[sid] = { id: sid, bot_id: bot, owner: 'david', messages: [], leaf: null, revision: 0,
      queue: [], queueRevision: 0, paused: false, turn: null, receipts: {}, pinned: null, read: null, goal: null, unread: false }; return sid; },
    thread(bot) { const sid = id('rt-'); store().convs[sid] = { id: sid, bot_id: bot, owner: 'david', messages: [], leaf: null, revision: 0, queue: [], queueRevision: 0, paused: false, turn: null, receipts: {}, pinned: null, read: null, goal: null, unread: false }; return sid; },
    finish(sid, text = 'ok') { return finish(conv(sid), text, 'done'); },
    fail(sid) { return finish(conv(sid), '', 'failed'); },
    skew(seconds) { store().skew += seconds; },
    tree(sid) { return conv(sid).messages.map(m => ({ ...m })); },
    reset() { delete state.botsRuntime; },
  };

  const handleRoute = (route, method, body, query) => {
    let m;
    if (!(m = route.match(/^\/api\/bot-chat\/([^/]+)(\/.*)?$/))) return undefined;
    if (m[1] === 'search') return { query: query.q, hits: Object.values(store().convs).flatMap(c => c.messages.filter(x => String(x.content).toLowerCase().includes(String(query.q || '').toLowerCase()))
      .map(x => ({ session_id: c.id, bot_id: c.bot_id, message_id: x.bot_message_id, leaf_id: leafUnder(c, x.bot_message_id), role: x.role, active: path(c).includes(x), other_version: !path(c).includes(x) }))) };
    if (m[1] === 'presence') return { ok: true, throttled: false };
    const c = conv(m[1]), tail = m[2] || '';
    let t;
    if (method === 'GET' && tail === '/state') return stateView(c);
    if (method === 'GET' && tail === '/messages') return page(c, query);
    if (method === 'GET' && tail === '/queue') return queueView(c);
    if (method === 'POST' && tail === '/send') {
      const text = body.text;
      if (typeof text !== 'string' || (!text.trim() && !(body.attachment_ids || []).length)) throw new Refusal(422, 'Write a message or attach a file');
      if (typeof body.send_id !== 'string' || body.send_id.length < 8) throw new Refusal(422, 'send_id is too short');
      return { ...accept(c, 'david', body), _status: 202 };
    }
    if (method === 'POST' && tail === '/queue/resume') { const moved = c.queue.filter(q => q.state === 'interrupted'); moved.forEach(q => { q.state = 'pending'; }); c.paused = false; c.queueRevision += 1; drain(c.bot_id); return { resumed: moved.length, ...queueView(c) }; }
    if ((t = tail.match(/^\/queue\/([^/]+)(\/edit|\/steer)?$/))) {
      const q = c.queue.find(x => x.id === t[1]); if (!q) throw new Refusal(404, 'queued message not found');
      if (method === 'DELETE' || t[2] === '/edit') {
        if (q.state !== 'pending' && q.state !== 'interrupted') throw conflict('This queued message has already changed');
        q.state = 'cancelled'; c.queueRevision += 1;
        return t[2] ? { queue_id: q.id, draft: { ...q }, ...queueView(c) } : { cancelled: true, queue_id: q.id, ...queueView(c) };
      }
      if (t[2] === '/steer' && method === 'POST') {
        if (body.queue_revision !== c.queueRevision) throw conflict('The queue changed. Reload and try again.');
        const head = waiting(c);
        const ids = body.group_ids || [q.id];
        if (!head.length || head[0].id !== q.id || ids.join() !== head.slice(0, ids.length).map(x => x.id).join()) return { steered: false, blocked: 'not-first' };
        if (c.turn?.status === 'running') {
          if (body.turn_id !== c.turn.turn_id) return { steered: false, blocked: 'turn-changed' };
          c.turn.reason = 'steer'; c.hold = true; finish(c, 'partial', 'stopped'); c.hold = false;
        }
        c.paused = false; const rows = head.slice(0, ids.length);
        const message = addMessage(c, 'user', rows.map(x => x.text).join('\n\n'), { bot_send_id: rows[0].send_id });
        rows.forEach(x => { x.state = 'consumed'; }); c.queueRevision += 1;
        return { steered: true, consumed_ids: rows.map(x => x.id), turn_id: startTurn(c, message), thread_id: c.id };
      }
    }
    if (method === 'POST' && tail === '/interrupt') {
      if (!c.turn || c.turn.turn_id !== body.turn_id || c.turn.status !== 'running') return { outcome: 'already-stopped', turn_id: body.turn_id };
      c.turn.reason = 'person'; finish(c, 'partial', 'stopped'); return { outcome: 'stopping', turn_id: body.turn_id };
    }
    if (method === 'POST' && tail === '/goal/stop') {
      if (!c.goal || c.goal.root_id !== body.root_id || c.goal.status !== 'working') return { outcome: 'already-stopped', root_id: body.root_id };
      c.goal.status = 'stopping'; c.turn.reason = 'person'; finish(c, 'partial', 'stopped'); c.goal.status = 'stopped'; return { outcome: 'stopping', root_id: body.root_id };
    }
    if ((t = tail.match(/^\/messages\/([^/]+)\/edit$/)) && method === 'POST') {
      const target = byId(c, t[1]); if (!target) throw new Refusal(404, 'message not found');
      if (!c.receipts[body.send_id] && (target.role !== 'user' || !path(c).includes(target))) throw conflict('Only a question in the selected version can be edited');
      return { _status: 202, ...accept(c, 'david', body, { kind: 'edit', target: t[1], parent: target.parent_id, direct: true, revision: body.expected_revision }) };
    }
    if (method === 'POST' && tail === '/regenerate') {
      const rows = path(c).filter(x => !x.display_only), last = rows.at(-1), question = last && byId(c, last.parent_id);
      if (!question || last.role !== 'assistant' || question.role !== 'user') throw conflict('There is no answer to redo');
      return { _status: 202, ...accept(c, 'david', { ...body, text: question.content }, { kind: 'regenerate', existing: question.bot_message_id, direct: true, revision: body.expected_revision }) };
    }
    if (method === 'POST' && tail === '/active-branch') {
      if (c.turn?.status === 'running') throw conflict('This conversation is busy. Wait for the reply, or stop it first.');
      if (body.expected_revision !== c.revision) throw conflict('Conversation changed. Reload and try again.');
      if (!byId(c, body.message_id)) throw new Refusal(404, 'message not found');
      c.leaf = leafUnder(c, body.message_id); c.revision += 1; return page(c, {});
    }
    if ((t = tail.match(/^\/messages\/([^/]+)\/reaction$/)) && method === 'POST') {
      const target = byId(c, t[1]); if (!target) throw new Refusal(404, 'message not found');
      if (!REACTIONS.includes(body.emoji)) throw new Refusal(422, 'Choose one of: ' + REACTIONS.join(', '));
      target.reactions ||= {}; if (body.on) target.reactions.me = body.emoji; else if (target.reactions.me === body.emoji) delete target.reactions.me;
      return { message_id: target.bot_message_id, reactions: reactionList(target.reactions) };
    }
    if (method === 'PATCH' && tail === '/pin') { if (body.message_id && !byId(c, body.message_id)) throw new Refusal(404, 'message not found'); c.pinned = body.message_id; return { pinned_message_id: c.pinned }; }
    if (method === 'POST' && tail === '/read') {
      const rows = path(c), target = body.message_id || rows.at(-1)?.bot_message_id;
      if (target && !rows.some(x => x.bot_message_id === target)) throw conflict('That message is not in the selected version');
      const cur = rows.findIndex(x => x.bot_message_id === c.read), at = rows.findIndex(x => x.bot_message_id === target);
      if (at > cur) { c.read = target; c.unread = rows.slice(at + 1).some(x => x.role === 'assistant' && !x.display_only); }
      return { last_read_message_id: c.read, unread: c.unread };
    }
    return undefined;
  };

  return {
    read(route, query = {}) {
      if (!state.botsLive) return undefined;
      try { return handleRoute(route, 'GET', {}, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message, ...error.extra }; throw error; }
    },
    mutate(route, method, body = {}, query = {}) {
      if (!state.botsLive) return undefined;
      try { return handleRoute(route, method, body || {}, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message, ...error.extra }; throw error; }
    },
  };
};
