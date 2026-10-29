import { h, Button } from './botsUi.js';
import { roomPath, memberId, memberStateLabel } from './botsRoomModel.js';
import { roomCall } from './botsRoomPanel.js';

export async function mount(host, { roomId, onChanged = () => {}, onSaved = () => {}, call = roomCall }) {
  let [room, raw] = await Promise.all([call(roomPath(roomId)), call('/api/agents')]);
  const bots = Array.isArray(raw) ? raw : raw.agents || [];
  const picked = new Set(room.members.map(memberId));
  let blocked = room.working || room.members.some(m => m.waiting), dirty = false, stale = false;
  const note = h('p', { class: 'bots-hint', text: blocked ? 'This room is working or waiting on a card. Change members when it is idle.' : 'A room needs at least one bot. Up to 20 can join.' });
  const error = h('p', { role: 'alert', hidden: true });
  let busy = false, disposed = false;
  const save = Button({ label: 'Save', variant: 'primary', disabled: blocked, onClick: flush });
  const fields = bots.filter(b => !b.hidden || picked.has(b.id)).map(bot => {
    const checkbox = h('input', { type: 'checkbox', 'data-bot-id': bot.id, 'aria-label': bot.name }); checkbox.checked = picked.has(bot.id); checkbox.disabled = blocked;
    checkbox.addEventListener('change', () => { dirty = true; if (checkbox.checked) picked.add(bot.id); else picked.delete(bot.id); paint(); });
    const member = room.members.find(m => memberId(m) === bot.id);
    return h('label', { class: 'bots-room-member-choice' }, [checkbox, h('span', { text: bot.name }), member ? h('span', { class: 'bots-hint', text: memberStateLabel(member) }) : null]);
  });
  function paint() { save.textContent = `Save with ${picked.size} ${picked.size === 1 ? 'bot' : 'bots'}`; save.disabled = stale || blocked || busy || picked.size < 1 || picked.size > 20; }
  async function flush() {
    if (save.disabled) return { ok: false };
    busy = true; paint();
    try { const updated = await call(roomPath(roomId), 'PATCH', { member_ids: [...picked], expected_revision: room.revision }); if (!disposed) { onChanged(updated); onSaved(updated); } return { ok: true }; }
    catch (problem) { if (!disposed) { error.hidden = false; error.textContent = problem.message; } return { ok: false, error: problem.message }; }
    finally { busy = false; paint(); }
  }
  const root = h('section', { class: 'bots-room-members' }, [note, ...fields, error, save]); host.append(root); paint();
  return { destroy() { disposed = true; root.remove(); }, async refresh() {
    const latest = await call(roomPath(roomId)); if (disposed) return;
    blocked = latest.working || latest.members.some(m => m.waiting);
    stale = dirty && latest.revision !== room.revision;
    if (stale) { error.hidden = false; error.textContent = 'The room changed. Close and reopen to reload.'; }
    if (!dirty) { room = latest; picked.clear(); room.members.forEach(m => picked.add(memberId(m))); }
    note.textContent = blocked ? 'This room is working or waiting on a card. Change members when it is idle.' : 'A room needs at least one bot. Up to 20 can join.';
    fields.forEach(row => { const input = row.firstElementChild; input.disabled = blocked; input.checked = picked.has(input.getAttribute('data-bot-id')); });
    paint();
  }, flush };
}
