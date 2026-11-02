// The Bots conversation contract, in memory, for the Electron checks (Phase 1, unit U3).
// Spec: Kairos Projects/Agents Redesign/phase-1-design.md section 5.1 (U1's /api/bot-chat). ui-smoke.cjs consults every
// scripts/fixtures/bots-*-backend.cjs before demo/fixtures.js while demoState.botsLive is set: read(path, query) and
// mutate(path, method, body, query) answer a route or return undefined. This file answers /api/bot-chat/* only, plus the
// attachment staging routes while a check has switched `state.botsChat.uploads` on; every other route is left to the
// core fixture. A session must belong to a bot in the core fixture (state.botsCore.threads), else 404.
//
// Live turns: the check owns the smoke server's live registry, so it hands this backend a small adapter,
// require('./bots-chat-backend.cjs').hooks.live = { start(sid, turnId, text), finish(sid, status), text(sid) }, and this file
// persists the conversation around it: send accepts or queues, complete() saves the reply and drains the queue, interrupt
// is guarded by the turn ID. Not part of the site demo.
const MAX_LIMIT = 200;

class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const hooks = { live: null };

module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const root = () => (state.botsChat ||= { sessions: {}, counter: 0, turns: 0, failNext: null, uploads: false, nextUpload: null, log: [] });
  const owned = sid => !!state.botsCore?.threads?.some(t => t.id === sid);
  const store = sid => {
    if (!owned(sid)) throw new Refusal(404, 'conversation not found');
    return root().sessions[sid] ||= { messages: [], leaf: null, revision: 1, queue: [], queueRevision: 1, paused: false, pinned: null, read: null, turn: null, receipts: {}, reactions: {}, consumed: [], goal: null, context: 12 };
  };
  const byId = (s, id) => s.messages.find(m => m.id === id);
  const nextId = sid => `${sid}-m${++root().counter}`;
  const add = (sid, s, fields) => {
    const message = { id: nextId(sid), parent_id: s.leaf, ts: clock(), content: '', attachments: [], citations: [], ...fields };
    s.messages.push(message); s.leaf = message.id; return message;
  };
  const path = s => { const out = []; for (let m = byId(s, s.leaf); m; m = m.parent_id ? byId(s, m.parent_id) : null) out.unshift(m); return out; };
  const children = (s, parent) => s.messages.filter(m => m.parent_id === parent && m.kind !== 'stop');
  const deepest = (s, id) => { let m = byId(s, id); for (let kids = children(s, m.id); kids.length; kids = children(s, m.id)) m = kids.at(-1); return m.id; };
  const present = (s, m) => {
    const siblings = children(s, m.parent_id).filter(x => x.role === m.role);
    const reactions = Object.entries(s.reactions[m.id] || {}).filter(([, who]) => who.length).map(([emoji, who]) => ({ emoji, count: who.length, mine: who.includes('me') }));
    const out = { ...m, reactions, ...(siblings.length > 1 ? { version: { index: siblings.indexOf(m), count: siblings.length, ids: siblings.map(x => x.id) } } : {}) };
    const quoted = m.reply_to_id && byId(s, m.reply_to_id);
    if (quoted) out.reply_to = { id: quoted.id, role: quoted.role, snippet: quoted.content.slice(0, 140) };
    return out;
  };
  const queueView = s => ({ items: s.queue.map(q => ({ id: q.id, text: q.payload.text, state: q.state, attachment_ids: q.payload.attachment_ids })), revision: s.queueRevision, paused: s.paused });

  function begin(sid, s, text) {
    const turnId = `chat-turn-${++root().turns}`;
    s.turn = { id: turnId, text };
    hooks.live?.start(sid, turnId, text);
    return turnId;
  }
  // Save a finished reply, then start the next queued message unless the person stopped the thread.
  function complete(sid, status = 'done', text = '') {
    const s = store(sid), turn = s.turn; if (!turn) return null;
    s.turn = null;
    if (text) add(sid, s, { role: 'assistant', content: text, status: status === 'done' ? undefined : status });
    if (status === 'stopped') { add(sid, s, { role: 'system', kind: 'stop', content: 'You stopped this.' }); s.paused = true; }
    else if (status === 'done' && s.digestNext) { add(sid, s, { role: 'system', kind: 'digest', content: '', digest: { seconds: 12, tools: 3, files: 1 } }); }
    // The reply is saved before the feed says the turn ended, so a viewer that reloads on the end sees it.
    hooks.live?.finish(sid, status);
    drain(sid, s);
    return s.turn?.id || null;
  }
  function drain(sid, s) {
    if (s.turn || s.paused) return;
    const items = s.queue.filter(q => q.state === 'pending');
    if (!items.length) return;
    const item = items[0]; item.state = 'consumed'; s.consumed.push(item.id); s.queueRevision++;
    s.queue = s.queue.filter(q => q.state !== 'consumed');
    const message = add(sid, s, { role: 'user', content: item.payload.text, attachments: item.payload.attachment_ids.map(id => ({ id, name: id })) });
    begin(sid, s, message.content);
  }
  const stopCurrent = (sid, s) => {
    complete(sid, 'stopped', hooks.live?.text(sid) || '');
  };
  const need = (cond, status, detail) => { if (!cond) throw new Refusal(status, detail); };
  const text = value => { need(typeof value === 'string' && value.trim() && value.length <= 20000, 400, 'text is 1 to 20000 characters'); return value; };

  function read(route, query) {
    let m;
    if (!(m = route.match(/^\/api\/bot-chat\/([^/]+)\/(state|messages|queue|export)$/)) && route !== '/api/bot-chat/search') return undefined;
    if (m && state.botsRuntime?.convs?.[m[1]]) return undefined;   // the runtime fixture owns its own conversations
    if (route === '/api/bot-chat/search') {
      const q = String(query.q || '').toLowerCase(); need(q, 400, 'q is required');
      const hits = [];
      for (const [sid, s] of Object.entries(root().sessions)) {
        if (query.session_id && query.session_id !== sid) continue;
        const live = new Set(path(s).map(x => x.id));
        for (const x of s.messages) if (x.content && x.content.toLowerCase().includes(q)) hits.push({ message_id: x.id, session_id: sid, leaf_id: live.has(x.id) ? null : deepest(s, x.id), active: live.has(x.id), snippet: x.content.slice(0, 200), ts: x.ts });
      }
      return { hits: hits.reverse().slice(0, Number(query.limit) || 100) };
    }
    if (!owned(m[1])) return undefined;   // another fixture (the runtime's) may own this conversation
    const s = store(m[1]);
    if (m[2] === 'state') return { active_leaf_id: s.leaf, branch_revision: s.revision, last_read_message_id: s.read, pinned_message_id: s.pinned, queue: queueView(s), goal: s.goal,
      model: { label: 'Fixture model' }, capabilities: { steer: false, queueing: true, images: true, speech: false }, turn: s.turn ? { id: s.turn.id } : null, context: { percent: s.context } };
    if (m[2] === 'queue') return queueView(s);
    if (m[2] === 'export') return { format: query.format || 'markdown', messages: path(s).map(x => ({ role: x.role, content: x.content })) };
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || 50)), all = path(s).map(x => present(s, x));
    let start, end;
    if (query.around) { const at = all.findIndex(x => x.id === query.around); need(at >= 0, 404, 'message not found'); start = Math.max(0, at - Math.floor(limit / 2)); end = Math.min(all.length, start + limit); }
    else if (query.before) { const at = all.findIndex(x => x.id === query.before); need(at >= 0, 404, 'message not found'); end = at; start = Math.max(0, end - limit); }
    else if (query.after) { const at = all.findIndex(x => x.id === query.after); need(at >= 0, 404, 'message not found'); start = at + 1; end = Math.min(all.length, start + limit); }
    else { end = all.length; start = Math.max(0, end - limit); }
    return { messages: all.slice(start, end), has_before: start > 0, has_after: end < all.length, active_leaf_id: s.leaf, branch_revision: s.revision };
  }

  function handle(route, method, body) {
    const r = root();
    if (r.uploads && route === '/api/chat/attachments' && method === 'POST') {
      const plan = r.nextUpload || {}; r.nextUpload = null;
      if (plan.fail) throw new Refusal(plan.status || 400, plan.detail || 'That file could not be attached');
      return { id: `att-${++r.counter}`, name: plan.name || 'file.txt' };
    }
    if (r.uploads && route === '/api/chat/validate-attachments' && method === 'POST') return { ok: true };
    let m;
    // routes/bot_chat_routes.py PresenceBody forbids other fields: a wrong name is a 422 there, so it is one here too.
    if (route === '/api/bot-chat/presence' && method === 'POST') {
      const extra = Object.keys(body || {}).filter(k => !['timezone', 'language', 'focused_thread'].includes(k));
      if (extra.length) return { _status: 422, detail: `Unknown presence fields: ${extra.join(', ')}` };
      r.log.push(['presence', body]); return { ok: true };
    }
    if (!(m = route.match(/^\/api\/bot-chat\/([^/]+)\/(send|interrupt|regenerate|active-branch|pin|read|compact|queue\/resume|queue\/([^/]+)(?:\/(edit|steer))?|messages\/([^/]+)\/(edit|reaction))$/))) return undefined;
    if (state.botsRuntime?.convs?.[m[1]]) return undefined;   // the runtime fixture owns its own conversations
    if (!owned(m[1])) return undefined;   // not ours: fall through to the next fixture
    const sid = m[1], s = store(sid), what = m[2];
    if (what === 'send' && method === 'POST') {
      const plan = r.failNext; r.failNext = null;
      if (plan?.mode === 'before') throw new Refusal(plan.status || 503, 'The server is busy');
      if (!(body.attachment_ids || []).length) text(body.text);
      need(typeof body.send_id === 'string' && body.send_id.length >= 8, 400, 'send_id is required');
      // services/bot_chat_service.py MODES: none, 'goal' or 'spoken'. Anything else is refused there, so here too.
      need([undefined, null, 'goal', 'spoken'].includes(body.mode), 422, 'Unknown message mode');
      const fingerprint = JSON.stringify([body.text, body.attachment_ids || [], body.reply_to_id || null, body.mode || 'chat']);
      const seen = s.receipts[body.send_id];
      if (seen) { need(seen.fingerprint === fingerprint, 409, 'That send ID was used for a different message'); return seen.result; }
      need((body.expected_leaf_id ?? null) === s.leaf, 409, 'The conversation moved on');
      let result;
      if (s.turn) {
        const item = { id: `q${++r.counter}`, state: 'pending', payload: { text: body.text, attachment_ids: body.attachment_ids || [], reply_to_id: body.reply_to_id || null, citations: body.citations || [], mode: body.mode || 'chat' } };
        s.queue.push(item); s.queueRevision++;
        result = { queued: true, queue_id: item.id, reason: 'busy', _status: 202 };
      } else {
        const message = add(sid, s, { role: 'user', content: body.text, reply_to_id: body.reply_to_id || null, citations: body.citations || [], attachments: (body.attachment_ids || []).map(id => ({ id, name: id })) });
        if (body.mode === 'goal') s.goal = { status: 'running', title: body.text.slice(0, 80), step: 1, max_steps: 13 };
        result = { message: present(s, message), turn_id: begin(sid, s, body.text), _status: 202 };
      }
      s.receipts[body.send_id] = { fingerprint, result };
      if (plan?.mode === 'after') throw new Refusal(plan.status || 503, 'The connection dropped');
      return result;
    }
    if (what === 'interrupt') {
      if (!s.turn || s.turn.id !== body.turn_id) return { outcome: 'already-stopped' };
      stopCurrent(sid, s); return { outcome: 'stopping' };
    }
    if (what === 'queue/resume') { s.paused = false; drain(sid, s); return queueView(s); }
    if (m[3]) {
      const item = s.queue.find(q => q.id === m[3]); need(item, 404, 'queue item not found');
      if (!m[4] && method === 'DELETE') { s.queue = s.queue.filter(q => q !== item); s.queueRevision++; return { ok: true }; }
      if (m[4] === 'edit') { s.queue = s.queue.filter(q => q !== item); s.queueRevision++; return { payload: item.payload }; }
      if (m[4] === 'steer') {
        need(body.queue_revision === s.queueRevision, 409, 'The queue changed');
        s.paused = false;
        if (s.turn) { need(body.turn_id === s.turn.id, 409, 'That turn already ended'); stopCurrent(sid, s); }
        s.paused = false; drain(sid, s);
        return { consumed_ids: [item.id] };
      }
    }
    if (m[6] === 'edit') {
      need(!s.turn, 409, 'The bot is replying'); const original = byId(s, m[5]); need(original && original.role === 'user', 404, 'message not found');
      need(body.expected_revision === s.revision, 409, 'The conversation changed'); text(body.text);
      s.leaf = original.parent_id; const message = add(sid, s, { role: 'user', content: body.text }); s.revision++;
      return { message: present(s, message), turn_id: begin(sid, s, body.text), branch_revision: s.revision };
    }
    if (m[6] === 'reaction') {
      const target = byId(s, m[5]); need(target, 404, 'message not found');
      const set = s.reactions[target.id] ||= {};
      for (const who of Object.values(set)) { const i = who.indexOf('me'); if (i >= 0) who.splice(i, 1); }
      if (body.on) (set[body.emoji] ||= []).push('me');
      return { reactions: Object.entries(set).filter(([, who]) => who.length).map(([emoji, who]) => ({ emoji, count: who.length, mine: who.includes('me') })) };
    }
    if (what === 'regenerate') {
      need(!s.turn, 409, 'The bot is replying'); need(body.expected_revision === s.revision, 409, 'The conversation changed');
      const last = path(s).filter(x => x.role === 'assistant' && !x.kind).at(-1); need(last, 409, 'Nothing to regenerate');
      s.leaf = last.parent_id; s.revision++;
      return { turn_id: begin(sid, s, ''), branch_revision: s.revision };
    }
    if (what === 'active-branch') {
      need(body.expected_revision === s.revision, 409, 'The conversation changed'); need(byId(s, body.message_id), 404, 'message not found');
      s.leaf = deepest(s, body.message_id); s.revision++; return { active_leaf_id: s.leaf, branch_revision: s.revision };
    }
    if (what === 'pin') { need(body.message_id === null || byId(s, body.message_id), 404, 'message not found'); s.pinned = body.message_id; return { pinned_message_id: s.pinned }; }
    if (what === 'read') { s.read = body.message_id; r.log.push(['read', sid, body.message_id]); return { ok: true }; }
    if (what === 'compact') { need(!s.turn, 409, 'The bot is replying'); s.context = 12; return { ok: true }; }
    return undefined;
  }

  const api = {
    // Test controls: seed a conversation, finish a turn, read what was saved.
    seed(sid, list) { const s = store(sid); for (const item of list) add(sid, s, item); return s.messages.map(x => x.id); },
    complete, session: sid => store(sid), root, hooks,
  };
  module.exports.latest = api;
  const guard = fn => (route, ...rest) => {
    if (!state.botsLive) return undefined;
    try { return fn(route, ...rest); }
    catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
  };
  return { read: guard((route, query) => read(route, query || {})), mutate: guard((route, method, body) => handle(route, method, body || {})) };
};
module.exports.hooks = hooks;
