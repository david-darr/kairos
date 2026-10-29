// The Bots attention API (/api/bot-attention), in memory, for the Electron checks (Phase 1 unit U5, 2026-10-29).
// ui-smoke.cjs consults every scripts/fixtures/bots-*-backend.cjs before demo/fixtures.js while demoState.botsLive is
// set: read(path, query) and mutate(path, method, body, query) answer a route or return undefined to let the demo have it.
// A check seeds state.botsAttention itself (items, feed, events, runs) and restores it when done; nothing is seeded here,
// so no check can depend on rows another check left. The projection, buckets, revisions, statuses and refusals follow
// services/bot_attention.py and routes/bot_attention_routes.py (scripts/test_bots_attention.py holds the real ones).
//
// state.botsAttention = {
//   items: [{ id: 'item:x', kind, bot, subject, body, at, status: 'open'|'resolved', actions, questions, session, messageId, answer }],
//   feed: [{ id, kind, agent_id, title, body, at, read, pinned, target, backlog }],
//   events: { [sessionId]: [{ id, at, source, data }] }, runs: { [sessionId]: [{ id, started_at, outcome, model, input_tokens, output_tokens }] },
//   prefs: { [itemId]: { read, done } }, failNext: { status, detail } | null, responses: [] (what was dispatched, newest last) }
const SECRET = /\bsk-ant-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const clean = value => String(value ?? '').replace(SECRET, '[REDACTED]');

module.exports = ({ state, now }) => {
  const store = () => state.botsAttention;
  const agents = () => (state.botsCore?.agents || []);
  const sender = id => { const a = agents().find(x => x.id === id); return { id, name: a ? a.name : 'A bot' }; };
  const refuse = (status, detail) => ({ _status: status, detail });
  const revisionOf = item => JSON.stringify([item.id, item.status, item.answer || null, item.subject, item.body, item.actions, item.questions || null]);
  const target = item => ({ tab: 'botsShell', agentId: item.bot, ...(item.session ? { sessionId: item.session } : {}), ...(item.messageId ? { messageId: item.messageId } : {}) });

  function rows() {
    const s = store();
    const prefs = s.prefs || (s.prefs = {});
    const out = (s.items || []).map(item => {
      const pref = prefs[item.id] || {};
      const open = item.status === 'open';
      const done = !!pref.done;
      return { id: item.id, source_id: item.id, kind: item.kind, sender: sender(item.bot), subject: clean(item.subject), snippet: clean(item.body).slice(0, 240),
        body: clean(item.body), at: item.at, status: open ? 'open' : 'resolved', target: target(item), actions: open ? item.actions : [], revision: revisionOf(item),
        answer: item.answer ? clean(item.answer) : null, questions: item.questions || [], read: !!pref.read, done,
        bucket: done || !open ? 'done' : item.kind === 'report' ? 'news' : 'needs-you' };
    });
    out.sort((a, b) => b.at - a.at);
    const counts = { 'needs-you': 0, news: 0, done: 0 };
    out.forEach(r => { counts[r.bucket] += 1; });
    return { rows: out, counts, count: counts['needs-you'] };
  }
  const find = id => (store().items || []).find(item => item.id === id);
  const withPref = (id, change) => { const prefs = store().prefs || (store().prefs = {}); prefs[id] = { ...(prefs[id] || {}), ...change }; };
  const entries = list => (list || []).map(e => ({ ...e, data: Object.fromEntries(Object.entries(e.data || {}).map(([k, v]) => [k, typeof v === 'string' ? clean(v) : v])) }))
    .sort((a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id)));

  return {
    read(route, query = {}) {
      if (!state.botsLive || !store()) return undefined;
      let m;
      if (route === '/api/bot-attention/inbox') return rows();
      if (route === '/api/bot-attention/needs-you') return { rows: rows().rows.filter(r => r.status === 'open' && r.kind !== 'report') };
      if (route === '/api/bot-attention/notifications') {
        const list = [...(store().feed || [])].sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at));
        return { rows: list, unread: list.filter(r => !r.read).length };
      }
      if (route === '/api/bot-attention/today') return { since: now - 86400, finished: [], counts: {}, needs_you: rows().rows.filter(r => r.status === 'open' && r.kind !== 'report') };
      if ((m = route.match(/^\/api\/bot-attention\/bots\/([^/]+)\/activity$/))) {
        const all = Object.entries(store().events || {}).flatMap(([sid, list]) => list.filter(e => e.bot === m[1]).map(e => ({ ...e, target: { tab: 'botsShell', agentId: m[1], sessionId: sid } })));
        const list = entries(all);
        return { entries: list, total: list.length };
      }
      if ((m = route.match(/^\/api\/bot-attention\/threads\/([^/]+)\/events$/))) {
        const sid = decodeURIComponent(m[1]);
        if (!(store().events || {})[sid] && !(store().runs || {})[sid]) return refuse(404, 'Conversation not found');
        const list = entries(store().events[sid]);
        return { entries: list, total: list.length, runs: (store().runs || {})[sid] || [] };
      }
      return undefined;
    },

    mutate(route, method, body = {}) {
      if (!state.botsLive || !store() || !route.startsWith('/api/bot-attention/')) return undefined;
      let m;
      if ((m = route.match(/^\/api\/bot-attention\/inbox\/(.+)\/(read|done|reopen|respond)$/)) && method === 'POST') {
        const id = decodeURIComponent(m[1]), item = find(id);
        if (!item) return refuse(404, 'Inbox item not found');
        if (m[2] === 'read') { withPref(id, { read: true }); return { ok: true }; }
        if (m[2] === 'done') { withPref(id, { read: true, done: true }); return { ok: true }; }
        if (m[2] === 'reopen') { withPref(id, { done: false }); return { ok: true }; }
        const s = store();
        const row = rows().rows.find(r => r.id === id);
        if (row.revision !== body.expected_revision || row.status !== 'open' || !row.actions.includes(body.action) || body.action === 'open')
          return refuse(409, 'That request is no longer available. Reload and try again.');
        if (s.failNext) { const failure = s.failNext; s.failNext = null; return refuse(failure.status || 409, failure.detail || 'The reply could not be delivered.'); }
        if (body.action === 'reply' && !String(body.text || '').trim()) return refuse(409, 'Write a reply first.');
        s.responses = [...(s.responses || []), { id, action: body.action, text: body.text || null, answers: body.answers || null }];
        item.status = 'resolved';
        item.answer = body.action === 'reply' ? body.text : body.action === 'respond' ? JSON.stringify(body.answers) : body.action;
        withPref(id, { read: true });
        return { ok: true, result: 'answered' };
      }
      if (route === '/api/bot-attention/notifications/read-all' && method === 'POST') { (store().feed || []).forEach(r => { r.read = true; }); return { ok: true }; }
      if ((m = route.match(/^\/api\/bot-attention\/notifications\/([^/]+)\/(read|pin)$/)) && method === 'POST') {
        const note = (store().feed || []).find(r => r.id === decodeURIComponent(m[1]));
        if (!note) return refuse(404, 'Notification not found');
        if (m[2] === 'read') note.read = true; else note.pinned = body.pinned !== false;
        return { ok: true };
      }
      if ((m = route.match(/^\/api\/bot-attention\/threads\/([^/]+)\/read$/)) && method === 'POST') {
        (store().feed || []).filter(r => r.target?.sessionId === decodeURIComponent(m[1])).forEach(r => { r.read = true; });
        return { ok: true };
      }
      return undefined;
    },
  };
};
