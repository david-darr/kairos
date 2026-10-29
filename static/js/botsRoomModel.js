// Room wire data stays separate from the solo conversation contract.
export const roomPath = id => `/api/bot-rooms/${encodeURIComponent(id)}`;
export const memberId = member => member?.bot_id || member?.id || '';
export function responderLabel(responder = {}, members = []) {
  return { everyone: 'Everyone answers', mentions: 'Only mentioned bots answer', auto: 'Auto chooses who answers',
    member: `${members.find(m => memberId(m) === responder.bot_id)?.name || 'The lead'} answers` }[responder.kind] || 'Mention a bot to get an answer';
}
export function memberState(member) {
  return member.held ? 'held' : member.working ? 'working' : member.busy_elsewhere ? 'elsewhere' : member.waiting || member.queued ? 'queued' : 'ready';
}
export const memberStateLabel = member => ({ held: 'On hold', working: 'Working', queued: 'Waiting to reply', elsewhere: 'Busy elsewhere', ready: 'Ready' })[memberState(member)];
export const heldMembers = room => (room?.members || []).filter(m => m.held);
export function queuePositions(items = [], waiting = '') {
  return items.filter(i => !['cancelled', 'consumed'].includes(i.state)).map((item, i) => ({ ...item, position: i + 1,
    label: `${i + 1}. ${item.text || item.payload?.text || ''}${waiting ? ` (waiting for ${waiting})` : ''}` }));
}
export function roomMentionItems(token, members = []) {
  if (!token) return [];
  return [...members.map(m => ({ id: memberId(m), name: m.name, hint: memberStateLabel(m) })),
    { id: 'everyone', name: 'everyone', hint: 'Every member' }, { id: 'you', name: 'you', hint: 'Ask you' }]
    .map(m => ({ ...m, label: `@${m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || m.name.replace(/\s+/g, '')}`, kind: 'room' }))
    .filter(m => m.label.slice(1).toLowerCase().startsWith(token.query.toLowerCase()));
}
export function mentionPreview(text, members = []) {
  const plain = String(text).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/^\s*>.*$/gm, ' ').replace(/`[^`\n]*`/g, ' ');
  return roomMentionItems({ query: '' }, members).filter(m => [m.label, `@${m.name}`, `@${m.name.replace(/\s+/g, '')}`, `@${m.id}`].some(spelling => {
    const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w.])${escaped}(?![\\w-])`, 'i').test(plain);
  }));
}
export function mergeMessages(current, incoming) {
  const rows = new Map(current.map(m => [m.id, m]));
  incoming.forEach(m => rows.set(m.id, { ...rows.get(m.id), ...m }));
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}
export const anchorAfterLoad = (before, newHeight) => before.top + newHeight - before.height;
export function roomSendPayload(payload, threadId) {
  return { text: payload.text, send_id: payload.send_id, thread_id: threadId,
    mode: payload.mode === 'goal' ? 'goal' : 'text', reply_to_id: payload.reply_to_id || null };
}
// Per-turn chunk revisions are independent of the feed's global cursor. Terminal
// tombstones prevent a late chunk from resurrecting a completed reply.
export function createRoomModel(roomId, threadId = null) {
  const state = { room: null, threadId, messages: [], queue: [], goal: null, live: new Map(), ended: new Set(), hasMore: false, deleted: false };
  const matches = data => !data.thread_id || data.thread_id === state.threadId;
  function finish(id) { if (id) { state.live.delete(id); state.ended.add(id); } }
  return { state,
    hydrate({ room, page, queue, goal }) {
      const sameThread = state.threadId === page.thread_id;
      state.room = room; state.threadId = page.thread_id; state.messages = page.messages || [];
      state.hasMore = !!page.has_more; state.queue = queue?.items || []; state.goal = goal?.goal || null;
      if (!sameThread) { state.live.clear(); state.ended.clear(); }
      state.messages.forEach(m => { if (m.turn_id) finish(m.turn_id); });
      // HTTP snapshots do not contain partial reply text. Keep it while that
      // member still works; a terminal snapshot clears a missed end frame.
      for (const [id, turn] of state.live) {
        const member = room.members.find(m => memberId(m) === turn.bot_id);
        if (!member?.working && !member?.waiting) finish(id);
      }
    },
    apply(frame) {
      if (frame.room_id !== roomId) return false;
      const d = frame.data || {};
      if (frame.type === 'room.deleted') { state.deleted = true; return true; }
      if (frame.type === 'room') {
        if (!d.room || d.room.revision < (state.room?.revision || 0)) return false;
        state.room = d.room; return true;
      }
      if (frame.type === 'room.hold') {
        const member = state.room?.members.find(m => memberId(m) === d.bot_id);
        if (member) member.held = d.held;
        return !!member;
      }
      if (!matches(d)) return false;
      if (frame.type === 'room.message') {
        if (d.message?.thread_id !== state.threadId) return false;
        state.messages = mergeMessages(state.messages, [d.message]); finish(d.message.turn_id);
        if (d.message.meta?.kind_hint === 'busy-elsewhere') {
          const member = state.room?.members.find(m => memberId(m) === d.message.meta.bot_id);
          if (member) member.busy_elsewhere = true;
        }
        return true;
      }
      if (frame.type === 'room.queue') { state.queue = d.items || []; return true; }
      if (frame.type === 'room.goal') { state.goal = d.goal; return true; }
      if (frame.type === 'room.turn') {
        const member = state.room?.members.find(m => memberId(m) === d.bot_id);
        if (member) { member.working = d.status === 'working'; member.waiting = d.status === 'waiting'; if (d.status !== 'waiting') member.busy_elsewhere = false; }
        if (['ended', 'stopped'].includes(d.status)) finish(d.turn_id);
        else if (d.turn_id && !state.ended.has(d.turn_id)) state.live.set(d.turn_id, { startedAt: Date.now() / 1000, ...state.live.get(d.turn_id), ...d });
        return true;
      }
      if (frame.type === 'room.chunk') {
        if (!d.turn_id || state.ended.has(d.turn_id)) return false;
        const prev = state.live.get(d.turn_id) || { revision: 0, text: '' };
        if (!Number.isSafeInteger(d.revision) || d.revision <= (prev.revision || 0)) return false;
        const incomplete = prev.incomplete || d.revision > (prev.revision || 0) + 1;
        state.live.set(d.turn_id, { startedAt: Date.now() / 1000, ...prev, ...d, incomplete, text: incomplete ? '' : (prev.text || '') + (d.chunk || '') }); return true;
      }
      return false;
    },
  };
}
