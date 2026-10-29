import { h, Button, loadBotsCss } from './botsUi.js';
import { roomCall, roomDialog } from './botsRoomPanel.js';

export async function mount(host, { onCreated = () => {}, call = roomCall } = {}) {
  await loadBotsCss('/static/css/bots-rooms.css');
  const raw = await call('/api/agents');
  let bots = (Array.isArray(raw) ? raw : raw.agents || []).filter(b => !b.hidden);
  const name = h('input', { maxlength: '100', required: true, 'aria-label': 'Room name' });
  const context = h('input', { maxlength: '60', 'aria-label': 'Room context' });
  const picked = new Set(), error = h('p', { role: 'alert', hidden: true });
  const empty = h('p', { text: 'Create a bot first.', hidden: bots.length > 0 });
  let busy = false, disposed = false;
  const create = Button({ label: 'Create room', variant: 'primary', disabled: true, onClick: flush });
  const paint = () => { create.textContent = `Create room with ${picked.size} ${picked.size === 1 ? 'bot' : 'bots'}`; create.disabled = busy || !name.value.trim() || picked.size < 1 || picked.size > 20; empty.hidden = bots.length > 0; };
  name.addEventListener('input', paint);
  const pickerHost = h('div', { class: 'bots-room-picker', role: 'group', 'aria-label': 'Choose bots' });
  const drawChoices = () => pickerHost.replaceChildren(...bots.map(bot => {
    const input = h('input', { type: 'checkbox', 'data-bot-id': bot.id, 'aria-label': bot.name });
    input.checked = picked.has(bot.id);
    input.addEventListener('change', () => { if (input.checked) picked.add(bot.id); else picked.delete(bot.id); paint(); });
    return h('label', { class: 'bots-room-member-choice' }, [input, h('span', { text: bot.name })]);
  }));
  drawChoices();
  async function flush() {
    if (create.disabled) return { ok: false };
    busy = true; paint();
    try { const room = await call('/api/bot-rooms', 'POST', { name: name.value.trim(), context: context.value.trim(), bot_ids: [...picked] }); if (!disposed) await onCreated(room); return { ok: true }; }
    catch (problem) { if (!disposed) { error.hidden = false; error.textContent = problem.message; } return { ok: false, error: problem.message }; }
    finally { busy = false; paint(); }
  }
  const root = h('section', { class: 'bots-new-room' }, [h('label', {}, ['Name', name]), h('label', {}, ['Context', context]),
    pickerHost, empty, error, create]);
  host.append(root); paint(); name.focus();
  return { destroy() { disposed = true; root.remove(); }, async refresh() {
    const raw = await call('/api/agents'); if (disposed) return;
    bots = (Array.isArray(raw) ? raw : raw.agents || []).filter(b => !b.hidden);
    for (const id of picked) if (!bots.some(b => b.id === id)) picked.delete(id);
    drawChoices(); paint();
  }, flush };
}
export async function openNewRoom(ctx = {}) {
  const dialog = roomDialog('New room', ctx.opener, ctx.signal);
  try { dialog.own(await mount(dialog.content, { ...ctx, onCreated: async room => {
    dialog.close();
    if (ctx.onCreated) await ctx.onCreated(room);
    else document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'botsRoom', roomId: room.id } }));
  } })); } catch (error) { dialog.content.append(h('p', { role: 'alert', text: error.message })); }
  return dialog;
}
