// The Bots rooms API (/api/bot-rooms), in memory, for the Electron checks (Phase 4 unit U2, 2026-10-29).
// Spec: Kairos Projects/Agents Redesign/phase-4-design.md, sections 4.2 and 5. ui-smoke.cjs consults every
// scripts/fixtures/bots-*-backend.cjs before demo/fixtures.js while demoState.botsLive is set: read(path, query) and
// mutate(path, method, body, query) answer a route or return undefined to let the demo have it.
//
// This fixture answers ONLY while a check has put an object in state.botsRooms (`{}` is enough); with nothing there it
// returns undefined for every route, so no other check can depend on it. It never assumes which bots exist: members are
// read from state.botsCore.agents (the bots the check created through /api/agents).
//
// The statuses and keys follow routes/bot_room_routes.py and services/bot_rooms.py; scripts/test_bots_rooms_fixture.cjs
// holds this file to them. What a model would do is replaced by a rule a check can steer:
//   - a bot "answers" at once with `${name}: noted.`, unless the message contains [slow]: then that bot works until the
//     check calls POST /api/bot-rooms/{id}/_release (checks only), or a Stop arrives, and later messages queue;
//   - responder `auto` picks state.botsRooms.autoPick (a bot id) when it is a member, else the fallback bot, else the
//     last speaker, else the first member, and reports auto: {p} only for a pick;
//   - a Goal-mode message starts a goal for the thread's coordinator; _release completes it, Stop ends it.
// GET /api/bot-rooms/_frames?after=N replays the live frames after a cursor ({reset: true} when it cannot), standing in
// for the SSE feed (services/bot_room_events.py), which a fixture cannot serve.
const MAX_MEMBERS = 20, PAGE_DEFAULT = 50, PAGE_MAX = 200, BULK_MAX = 500, MAX_FRAMES = 500;
const KINDS = ['everyone', 'mentions', 'member', 'auto'];
const refuse = (status, detail) => ({ _status: status, detail });
const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const STOP = /\b(stop|halt|pause|stand down)\b/, NEGATED = /(don'?t|do not|never|not|no need to|without)\s+(?:\w+\s+){0,2}(stop|halt|pause)\b/, RESUME = /\b(resume|unpause|carry on|go on|continue)\b/;
const PERSON_STOP = ['stop', 'stop all', 'stop everyone', 'stop everything', 'halt', 'stop it', 'stop now', 'please stop', 'stop please'];

module.exports = ({ state, now }) => {
  const store = () => (state.botsRooms && typeof state.botsRooms === 'object' ? state.botsRooms : null);
  const ensure = () => { const s = store(); if (!s.rooms) Object.assign(s, { rooms: [], messages: {}, queue: {}, working: {}, goals: {}, frames: [], cursor: 0, counter: 0, sends: {} }); return s; };
  const agents = () => (state.botsCore?.agents || []);
  const bot = id => agents().find(a => a.id === id);
  const next = prefix => `${prefix}${++ensure().counter}`;
  const frame = (type, roomId, data) => { const s = ensure(); s.cursor += 1; s.frames.push({ id: s.cursor, type, room_id: roomId, data: data || {} }); if (s.frames.length > MAX_FRAMES) s.frames.shift(); };
  const room = id => ensure().rooms.find(r => r.id === id);
  const threadOf = (r, id) => (id == null ? r.threads[0] : r.threads.find(t => t.id === id));
  const isWorking = r => Object.keys(ensure().working).some(k => k.startsWith(r.id + ':'));
  const visible = r => ({ ...r, members: r.member_ids.map(id => { const b = bot(id); return { bot_id: id, name: b ? b.name : id, held: !!r.held[id], working: Object.values(ensure().working).some(w => w.roomId === r.id && w.bot === id), waiting: false, seat_session_id: null, last_seen_seq: 0 }; }),
    working: isWorking(r), unread: r.messages_unread || 0, last_seq: (ensure().messages[r.id] || []).length, member_ids: undefined, held: undefined, messages_unread: undefined });
  const infos = r => r.member_ids.filter(id => bot(id)).map(id => ({ bot_id: id, name: bot(id).name, held: !!r.held[id] }));

  function mentions(text, members) {
    const plain = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/^[ \t]*>.*$/gm, ' ').replace(/`[^`\n]*`/g, ' ');
    const lower = plain.toLowerCase();
    const out = { ids: [], everyone: /(^|[^\w.])@(everyone|all)(?![\w-])/.test(lower), you: /(^|[^\w.])@you(?![\w-])/.test(lower) };
    const spellings = members.flatMap(m => [m.name.toLowerCase(), slug(m.name), m.name.toLowerCase().replace(/ /g, '')].map(s => [s, m.bot_id])).sort((a, b) => b[0].length - a[0].length);
    let at = -1;
    while ((at = lower.indexOf('@', at + 1)) >= 0) {
      if (at > 0 && /[\w.]/.test(lower[at - 1])) continue;
      const hit = spellings.find(([s]) => lower.startsWith(s, at + 1) && !/[\w-]/.test(lower[at + 1 + s.length] || ' '));
      if (hit && !out.ids.includes(hit[1])) out.ids.push(hit[1]);
    }
    return { ...out, plain };
  }
  function holdIntent(text, members) {
    const hold = [], release = [];
    const everyone = members.map(m => m.bot_id);
    for (const segment of mentions(text, members).plain.split(/[.!?;\n]+/)) {
      const found = mentions(segment, members);
      const targets = found.everyone ? everyone : found.ids;
      if (!targets.length) continue;
      const low = segment.toLowerCase();
      if (STOP.test(low) && !NEGATED.test(low)) targets.forEach(t => { if (!hold.includes(t)) hold.push(t); const i = release.indexOf(t); if (i >= 0) release.splice(i, 1); });
      else if (RESUME.test(low)) targets.forEach(t => { if (!release.includes(t)) release.push(t); const i = hold.indexOf(t); if (i >= 0) hold.splice(i, 1); });
    }
    const found = mentions(text, members);
    const left = found.plain.replace(/@[\w-]+/g, ' ').replace(/[\W_]+/g, '');
    members.forEach(m => { if (found.ids.includes(m.bot_id) && !left && !hold.includes(m.bot_id) && !release.includes(m.bot_id)) release.push(m.bot_id); });
    return { hold, release };
  }

  function add(r, threadId, role, text, extra = {}) {
    const s = ensure(), list = s.messages[r.id] || (s.messages[r.id] = []);
    const message = { id: next('m'), room_id: r.id, thread_id: threadId, seq: list.length + 1, role, bot_id: null, text, kind: 'text', reply_to_id: null, send_id: null, run_id: null, turn_id: null, meta: {}, created_at: now + list.length, ...extra };
    list.push(message);
    if (role === 'bot') r.messages_unread = (r.messages_unread || 0) + 1;
    frame('room.message', r.id, { message });
    return message;
  }
  function responders(r, text) {
    const open = infos(r).filter(i => !i.held), found = mentions(text, infos(r));
    if (found.everyone) return open.map(i => ({ bot_id: i.bot_id, how: 'everyone' }));
    if (found.ids.length) return open.filter(i => found.ids.includes(i.bot_id)).map(i => ({ bot_id: i.bot_id, how: 'mention' }));
    const d = r.default_responder;
    if (d.kind === 'everyone') return open.map(i => ({ bot_id: i.bot_id, how: 'everyone' }));
    if (d.kind === 'member') return open.filter(i => i.bot_id === d.bot_id).map(i => ({ bot_id: i.bot_id, how: 'default' }));
    if (d.kind === 'auto' && open.length) {
      const pick = ensure().autoPick;
      if (pick && open.some(i => i.bot_id === pick)) return [{ bot_id: pick, how: 'auto', p: 0.9 }];
      const fallback = open.find(i => i.bot_id === d.fallback_bot_id), last = [...(ensure().messages[r.id] || [])].reverse().find(m => m.role === 'bot' && open.some(i => i.bot_id === m.bot_id));
      return [{ bot_id: (fallback || (last && open.find(i => i.bot_id === last.bot_id)) || open[0]).bot_id, how: 'fallback' }];
    }
    return [];
  }
  function startRound(r, thread, rows) {
    const s = ensure(), text = rows.map(x => x.text).join('\n'), goal = rows.some(x => x.mode === 'goal');
    const picked = responders(r, text);
    if (goal) {
      const lead = picked[0] || infos(r).find(i => !i.held) || null;
      if (!lead) { add(r, thread.id, 'system', 'Everyone is on hold, so the goal could not start.', { kind: 'chip' }); return; }
      s.goals[`${r.id}:${thread.id}`] = { root_id: next('g'), status: 'working', turn: 1, max_turns: 13, goal: text.slice(0, 180), detail: '', bot: lead.bot_id };
      s.working[`${r.id}:${thread.id}`] = { roomId: r.id, bot: lead.bot_id, goal: true };
      thread.goal = s.goals[`${r.id}:${thread.id}`];
      frame('room.goal', r.id, { thread_id: thread.id, goal: thread.goal });
      return;
    }
    if (!picked.length) { add(r, thread.id, 'system', 'Mention a bot with @ to get an answer.', { kind: 'chip' }); return; }
    for (const pick of picked) {
      const b = bot(pick.bot_id);
      if (/\[slow\]/.test(text)) { s.working[`${r.id}:${thread.id}`] = { roomId: r.id, bot: pick.bot_id, pending: picked.slice(picked.indexOf(pick)), auto: pick }; frame('room.turn', r.id, { thread_id: thread.id, bot_id: pick.bot_id, status: 'working' }); return; }
      add(r, thread.id, 'bot', `${b.name}: noted.`, { role: 'bot', bot_id: pick.bot_id, meta: { hop: 0, attended: true, outcome: 'settled', ...(pick.how === 'auto' ? { auto: { p: pick.p, how: 'auto' } } : {}) } });
    }
  }
  function finishWork(r, thread, outcome) {
    const s = ensure(), key = `${r.id}:${thread.id}`, work = s.working[key];
    if (!work) return;
    delete s.working[key];
    const goal = s.goals[key];
    if (goal && goal.status === 'working') { goal.status = outcome === 'stopped' ? 'stopped' : 'completed'; goal.label = goal.status === 'stopped' ? 'Stopped' : 'Done'; thread.goal = goal; frame('room.goal', r.id, { thread_id: thread.id, goal }); }
    else if (outcome === 'settled') for (const pick of work.pending || []) add(r, thread.id, 'bot', `${bot(pick.bot_id).name}: noted.`, { bot_id: pick.bot_id, meta: { hop: 0, attended: true, outcome: 'settled' } });
    else add(r, thread.id, 'system', `${(bot(work.bot) || {}).name || 'A bot'} was stopped.`, { kind: 'chip', meta: { outcome: 'cancelled', retry: true, bot_id: work.bot } });
    frame('room.turn', r.id, { thread_id: thread.id, bot_id: work.bot, status: 'ended', outcome });
    drain(r, thread);
  }
  function drain(r, thread) {
    const s = ensure(), key = `${r.id}:${thread.id}`;
    const rows = (s.queue[r.id] || []).filter(q => q.thread_id === thread.id && q.state === 'pending');
    if (!rows.length || s.working[key]) return;
    rows.forEach(q => { q.state = 'consumed'; });
    frame('room.queue', r.id, { thread_id: thread.id, items: [] });
    startRound(r, thread, rows);
  }

  function validate(body, existing) {
    const text = (v, max, label, required) => { if (v == null) v = ''; if (typeof v !== 'string') return refuse(422, `${label} must be text`); v = v.trim(); if (required && !v) return refuse(422, `${label} is needed`); if (v.length > max) return refuse(422, `${label} is at most ${max} characters`); return v; };
    const out = {};
    for (const [key, max, label, required] of [['name', 100, 'The name', true], ['context', 60, 'The context'], ['description', 120, 'The description'], ['bulletin', 12000, 'The instructions']]) {
      if (key in body || (!existing && required)) { const v = text(body[key], max, label, required); if (v?._status) return v; out[key] = v; }
    }
    if ('turn_timeout_minutes' in body) { const v = body.turn_timeout_minutes; if (!Number.isInteger(v) || v < 1 || v > 1440) return refuse(422, 'The turn limit is 1 to 1440 minutes'); out.turn_timeout_minutes = v; }
    return out;
  }
  function memberCheck(ids, current = []) {
    if (!Array.isArray(ids) || !ids.length) return refuse(422, 'A room needs at least one bot');
    const unique = [...new Set(ids)];
    if (unique.length > MAX_MEMBERS) return refuse(422, `A room holds at most ${MAX_MEMBERS} bots`);
    for (const id of unique) { const b = bot(id); if (!b) return refuse(422, 'One of the bots no longer exists'); if (b.hidden && !current.includes(id)) return refuse(422, `${b.name} is hidden and cannot join a room`); }
    return unique;
  }
  function responderCheck(value, members) {
    if (!value || typeof value !== 'object' || !KINDS.includes(value.kind)) return refuse(422, 'Choose who answers by default: everyone, mentions, one bot or auto');
    if (value.kind === 'member') return members.includes(value.bot_id) ? { kind: 'member', bot_id: value.bot_id } : refuse(422, 'The bot that answers by default must be in the room');
    if (value.kind === 'auto') return value.fallback_bot_id && !members.includes(value.fallback_bot_id) ? refuse(422, 'The fallback bot must be in the room') : { kind: 'auto', ...(value.fallback_bot_id ? { fallback_bot_id: value.fallback_bot_id } : {}) };
    return { kind: value.kind };
  }
  const extraFields = (body, allowed) => Object.keys(body || {}).filter(k => !allowed.includes(k));
  const ROOM_FIELDS = ['name', 'context', 'description', 'bulletin', 'cwd', 'default_responder', 'turn_timeout_minutes'];

  function page(r, query) {
    const thread = threadOf(r, query.thread_id);
    if (!thread) return refuse(404, 'thread not found');
    const all = (ensure().messages[r.id] || []).filter(m => m.thread_id === thread.id);
    const limit = Math.max(1, Math.min(Number(query.limit) || PAGE_DEFAULT, PAGE_MAX));
    let rows;
    if (query.around) {
      const anchor = all.find(m => m.id === query.around);
      if (!anchor) return refuse(404, 'message not found');
      const i = all.indexOf(anchor), half = Math.floor(limit / 2);
      rows = all.slice(Math.max(0, i - half), Math.max(0, i - half) + limit);
    } else {
      const before = query.before != null ? Number(query.before) : Infinity;
      rows = all.filter(m => m.seq < before).slice(-limit);
    }
    return { thread_id: thread.id, messages: rows, has_more: rows.length > 0 && all.some(m => m.seq < rows[0].seq), last_seq: (ensure().messages[r.id] || []).length };
  }

  return {
    read(route, query = {}) {
      if (!state.botsLive || !store() || !route.startsWith('/api/bot-rooms')) return undefined;
      ensure();
      let m;
      if (route === '/api/bot-rooms') return { rooms: ensure().rooms.filter(r => !r.archived_at || query.include_archived === 'true').map(visible) };
      if (route === '/api/bot-rooms/_frames') {
        const s = ensure(), after = Number(query.after || 0), oldest = s.frames.length ? s.frames[0].id : s.cursor + 1;
        if (after > s.cursor || after < oldest - 1) return { cursor: s.cursor, reset: true, frames: [] };
        return { cursor: s.cursor, reset: false, frames: s.frames.filter(f => f.id > after) };
      }
      if (!(m = route.match(/^\/api\/bot-rooms\/([^/]+)(\/.*)?$/))) return undefined;
      const r = room(m[1]);
      if (!r) return refuse(404, 'room not found');
      const sub = m[2] || '';
      if (sub === '') return visible(r);
      if (sub === '/messages') return page(r, query);
      if (sub === '/queue') return { items: (ensure().queue[r.id] || []).filter(q => q.state === 'pending' && (!query.thread_id || q.thread_id === query.thread_id)).map((q, i) => ({ id: q.id, state: q.state, thread_id: q.thread_id, text: q.text, message_id: q.message_id, position: i + 1 })) };
      if (sub === '/threads') return { threads: r.threads.map(t => ({ id: t.id, title: t.title, goal: t.goal || null, created_at: t.created_at, working: !!ensure().working[`${r.id}:${t.id}`] })) };
      if ((m = sub.match(/^\/threads\/([^/]+)\/goal$/))) return { goal: ensure().goals[`${r.id}:${m[1]}`] || null };
      return undefined;
    },

    mutate(route, method, body = {}) {
      if (!state.botsLive || !store() || !route.startsWith('/api/bot-rooms')) return undefined;
      const s = ensure();
      let m;
      if (route === '/api/bot-rooms' && method === 'POST') {
        const unknown = extraFields(body, [...ROOM_FIELDS, 'bot_ids', 'setup_done']);
        if (unknown.length || typeof body !== 'object') return refuse(422, `Unknown field: ${unknown[0]}`);
        const fields = validate(body, null);
        if (fields._status) return fields;
        const members = memberCheck(body.bot_ids);
        if (members._status) return members;
        const responder = body.default_responder ? responderCheck(body.default_responder, members) : { kind: 'mentions' };
        if (responder._status) return responder;
        const id = next('r');
        const made = { id, name: fields.name, context: fields.context || '', description: fields.description || '', bulletin: fields.bulletin || '', cwd: body.cwd || null, default_responder: responder,
          turn_timeout_minutes: fields.turn_timeout_minutes || 5, setup_state: body.setup_done ? 'done' : 'pending', pinned_message_id: null, revision: 1, created_at: now, archived_at: null,
          member_ids: members, held: {}, threads: [{ id: next('t'), title: '', goal: null, created_at: now }] };
        s.rooms.push(made); frame('room', id, { room: visible(made) });
        return visible(made);
      }
      if (!(m = route.match(/^\/api\/bot-rooms\/([^/]+)(\/.*)?$/))) return undefined;
      const r = room(m[1]);
      if (!r) return refuse(404, 'room not found');
      const sub = m[2] || '';
      if (sub === '' && method === 'PATCH') {
        const unknown = extraFields(body, [...ROOM_FIELDS, 'member_ids', 'pinned_message_id', 'expected_revision']);
        if (unknown.length) return refuse(422, `Unknown field: ${unknown[0]}`);
        if (body.expected_revision != null && body.expected_revision !== r.revision) return refuse(409, 'The room changed. Reload and try again.');
        const fields = validate(body, r);
        if (fields._status) return fields;
        let members = r.member_ids;
        if ('member_ids' in body) {
          const checked = memberCheck(body.member_ids, r.member_ids);
          if (checked._status) return checked;
          if (checked.length !== r.member_ids.length || checked.some(id => !r.member_ids.includes(id))) {
            if (isWorking(r)) return refuse(409, 'This room is working or waiting on a card. Try changing who is in it when it is idle.');
          }
          members = checked;
        }
        let responder = r.default_responder;
        if ('default_responder' in body) { responder = responderCheck(body.default_responder, members); if (responder._status) return responder; }
        else if (responderCheck(responder, members)._status) responder = { kind: 'mentions' };
        if ('pinned_message_id' in body && body.pinned_message_id !== null && !(s.messages[r.id] || []).some(x => x.id === body.pinned_message_id)) return refuse(404, 'message not found');
        Object.assign(r, fields, { member_ids: members, default_responder: responder, revision: r.revision + 1 });
        if ('cwd' in body) r.cwd = body.cwd || null;
        if ('pinned_message_id' in body) r.pinned_message_id = body.pinned_message_id;
        frame('room', r.id, { room: visible(r) });
        return visible(r);
      }
      if (sub === '' && method === 'DELETE') {
        if (isWorking(r)) return refuse(409, 'This room is working. Stop it first, or wait for it to finish.');
        s.rooms.splice(s.rooms.indexOf(r), 1); delete s.messages[r.id]; delete s.queue[r.id];
        frame('room.deleted', r.id, {});
        return { deleted: true, id: r.id };
      }
      if (sub === '/setup' && method === 'POST') {
        if (!['complete', 'skip'].includes(body.action)) return refuse(422, 'Setup is complete or skip');
        if (body.action === 'complete') {
          if (body.bulletin != null) r.bulletin = String(body.bulletin).slice(0, 12000);
          if ('cwd' in body) r.cwd = body.cwd || null;
          if (body.default_responder) { const d = responderCheck(body.default_responder, r.member_ids); if (d._status) return d; r.default_responder = d; }
        }
        r.setup_state = body.action === 'complete' ? 'done' : 'skipped'; r.revision += 1;
        frame('room', r.id, { room: visible(r) });
        return visible(r);
      }
      if (sub === '/read' && method === 'POST') { r.messages_unread = 0; return { unread: 0 }; }
      if (sub === '/messages' && method === 'POST') {
        if (typeof body.text !== 'string' || !body.text.trim()) return refuse(422, 'Write a message');
        if (typeof body.send_id !== 'string' || body.send_id.length < 8 || body.send_id.length > 80) return refuse(422, 'A send id is needed');
        if (r.archived_at) return refuse(404, 'room not found');
        if (r.setup_state === 'pending') return refuse(409, 'Finish setting up this room first.');
        const thread = threadOf(r, body.thread_id);
        if (!thread) return refuse(404, 'thread not found');
        const mode = body.mode || 'text';
        if (!['text', 'goal'].includes(mode)) return refuse(422, 'Unknown message mode');
        if (mode === 'goal' && s.goals[`${r.id}:${thread.id}`]?.status === 'working') return refuse(409, 'This thread already has a goal running. Stop it first.');
        const earlier = s.sends[`${r.id}:${body.send_id}`];
        if (earlier) return { _status: 202, message: earlier, queued: false, queue_id: null, replayed: true };
        const message = add(r, thread.id, 'person', body.text.trim(), { send_id: body.send_id, reply_to_id: body.reply_to_id || null, meta: { mode } });
        s.sends[`${r.id}:${body.send_id}`] = message;
        const plain = body.text.toLowerCase().replace(/[^\w\s]/g, '').trim();
        if (PERSON_STOP.includes(plain)) { const out = this.mutate(`/api/bot-rooms/${r.id}/stop`, 'POST', { thread_id: thread.id }); return { _status: 202, message, queued: false, queue_id: null, stopped: out.stopped }; }
        const wanted = holdIntent(body.text, infos(r));
        wanted.hold.forEach(id => { if (!r.held[id]) { r.held[id] = true; frame('room.hold', r.id, { bot_id: id, held: true }); } });
        wanted.release.forEach(id => { if (r.held[id]) { delete r.held[id]; frame('room.hold', r.id, { bot_id: id, held: false }); } });
        const row = { id: next('q'), thread_id: thread.id, text: body.text.trim(), message_id: message.id, mode, state: 'pending' };
        (s.queue[r.id] || (s.queue[r.id] = [])).push(row);
        const waiting = !!s.working[`${r.id}:${thread.id}`];
        if (waiting) frame('room.queue', r.id, { thread_id: thread.id, items: s.queue[r.id].filter(q => q.state === 'pending') });
        else drain(r, thread);
        return { _status: 202, message, queued: waiting, queue_id: row.id, held: wanted.hold, released: wanted.release };
      }
      if (sub === '/holds' && method === 'POST') {
        if (!r.member_ids.includes(body.bot_id)) return refuse(404, 'that bot is not in this room');
        if (typeof body.held !== 'boolean') return refuse(422, 'held is true or false');
        const changed = !!r.held[body.bot_id] !== body.held;
        if (body.held) r.held[body.bot_id] = true; else delete r.held[body.bot_id];
        if (changed) frame('room.hold', r.id, { bot_id: body.bot_id, held: body.held });
        return { bot_id: body.bot_id, held: body.held, changed };
      }
      if (sub === '/stop' && method === 'POST') {
        if (body.bot_id && !r.member_ids.includes(body.bot_id)) return refuse(404, 'that bot is not in this room');
        const stopped = [];
        if (!body.bot_id) (s.queue[r.id] || []).forEach(q => { if (q.state === 'pending') q.state = 'cancelled'; });  // before the stop, so nothing queued starts
        for (const t of r.threads) {
          const work = s.working[`${r.id}:${t.id}`];
          if (work && (!body.bot_id || work.bot === body.bot_id)) { stopped.push(work.bot); finishWork(r, t, 'stopped'); }
        }
        return { stopped };
      }
      if (sub === '/_release' && method === 'POST') {
        for (const t of r.threads) finishWork(r, t, 'settled');
        return { ok: true };
      }
      if ((m = sub.match(/^\/queue\/([^/]+)$/)) && method === 'DELETE') {
        const q = (s.queue[r.id] || []).find(x => x.id === m[1]);
        if (!q) return refuse(404, 'queued message not found');
        if (q.state !== 'pending') return refuse(409, 'That message already started');
        q.state = 'cancelled';
        return { cancelled: true, queue_id: q.id };
      }
      if (sub === '/threads' && method === 'POST') {
        const title = String(body.title || '').trim();
        if (title.length > 100) return refuse(422, 'The title is at most 100 characters');
        const t = { id: next('t'), title, goal: null, created_at: now }; r.threads.push(t); frame('room', r.id, { room: visible(r) });
        return t;
      }
      if (sub === '/threads/delete' && method === 'POST') {
        const ids = body.thread_ids;
        if (!Array.isArray(ids) || !ids.length || ids.length > BULK_MAX) return refuse(422, `Choose 1 to ${BULK_MAX} threads`);
        return deleteThreads(r, ids);
      }
      if ((m = sub.match(/^\/threads\/([^/]+)$/))) {
        const t = r.threads.find(x => x.id === m[1]);
        if (!t) return refuse(404, 'thread not found');
        if (method === 'PATCH') { const title = String(body.title || '').trim(); if (title.length > 100) return refuse(422, 'The title is at most 100 characters'); t.title = title; return t; }
        if (method === 'DELETE') return deleteThreads(r, [t.id]);
      }
      return undefined;
    },
  };

  function deleteThreads(r, ids) {
    const s = ensure();
    let doomed = [...new Set(ids)].filter(id => r.threads.some(t => t.id === id));
    if (doomed.some(id => s.working[`${r.id}:${id}`])) return refuse(409, 'A thread you chose is working. Stop it first.');
    if (doomed.length >= r.threads.length) doomed = doomed.slice(0, -1);
    r.threads = r.threads.filter(t => !doomed.includes(t.id));
    s.messages[r.id] = (s.messages[r.id] || []).filter(x => !doomed.includes(x.thread_id));
    return { deleted: doomed };
  }
};
