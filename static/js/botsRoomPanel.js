import { api } from './api.js';
import { h, Button, RadioGroup, loadBotsCss } from './botsUi.js';
import { roomPath, memberId } from './botsRoomModel.js';
import { mount as mountMembers } from './botsRoomMembers.js';

export async function roomCall(path, method = 'GET', body) {
  try { return await api(path, { method, cache: 'no-store', toast: false, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (error) { const match = /^(\d{3}): ([\s\S]*)$/.exec(error.message || ''); if (match) { error.status = +match[1]; error.message = match[2]; } throw error; }
}
export function roomDialog(title, opener = document.activeElement, signal) {
  loadBotsCss('/static/css/bots.css');
  loadBotsCss('/static/css/bots-rooms.css');
  const content = h('div', { class: 'bots-room-dialog-content' });
  const node = h('dialog', { class: 'bots-room-dialog', 'aria-label': title, 'data-app-mode': 'bots' }, [
    h('header', {}, [h('h2', { text: title }), Button({ label: 'Close', onClick: () => close() })]), content]);
  const scope = h('div', { 'data-app-mode': 'bots' }, [node]);
  let handle = null, closed = false;
  const close = () => { if (closed) return; closed = true; signal?.removeEventListener('abort', close); handle?.destroy(); node.close(); scope.remove(); if (opener?.isConnected) opener.focus(); };
  node.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.body.append(scope); node.showModal();
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return { node, content, close, own(value) { if (closed) value.destroy(); else handle = value; return value; } };
}
export function responderEditor(room) {
  let selected = room.default_responder?.kind || 'mentions';
  const lead = h('select', { 'aria-label': 'Lead bot' }, (room.members || []).map(m => h('option', { value: memberId(m), text: m.name })));
  lead.value = room.default_responder?.bot_id || memberId(room.members[0]);
  const radio = RadioGroup({ label: 'Who answers by default', value: selected,
    options: [{ value: 'auto', title: 'Auto', hint: 'Choose a member for each message' }, { value: 'member', title: 'Lead bot' },
      { value: 'everyone', title: 'Everyone' }, { value: 'mentions', title: 'Mentions only' }],
    onChange: value => { selected = value; lead.hidden = selected !== 'member'; } });
  lead.hidden = selected !== 'member';
  return { node: h('section', { class: 'bots-room-responders' }, [h('h3', { text: 'Who answers by default' }), radio, lead]),
    read: () => selected === 'member' ? { kind: selected, bot_id: lead.value } : { kind: selected } };
}
function folderField(input, error) {
  const choose = Button({ label: 'Choose folder', onClick: async () => {
    try { const folder = await globalThis.window.jarvis.pickVaultFolder(); if (folder) input.value = folder; }
    catch (problem) { error.hidden = false; error.textContent = problem.message; }
  } });
  choose.hidden = !globalThis.window?.jarvis?.pickVaultFolder;
  return h('label', {}, ['Working folder', input, choose]);
}
export function mountSetup(host, { room, onSaved, call = roomCall }) {
  const cwd = h('input', { type: 'text', maxlength: '1024', 'aria-label': 'Working folder' }); cwd.value = room.cwd || '';
  const bulletin = h('textarea', { rows: '4', maxlength: '12000', 'aria-label': 'Room instructions' }); bulletin.value = room.bulletin || '';
  const responder = responderEditor(room), error = h('p', { role: 'alert', hidden: true });
  let disposed = false, busy = false;
  const buttons = [];
  async function save(action) {
    if (busy) return; busy = true; buttons.forEach(b => { b.disabled = true; });
    try { const result = await call(`${roomPath(room.id)}/setup`, 'POST', { action, ...(action === 'complete' ? { cwd: cwd.value.trim() || null, bulletin: bulletin.value, default_responder: responder.read() } : {}) }); if (!disposed) await onSaved(result); }
    catch (problem) { if (!disposed) { error.hidden = false; error.textContent = problem.message; } }
    finally { busy = false; buttons.forEach(b => { b.disabled = false; }); }
  }
  buttons.push(Button({ label: 'Skip', onClick: () => save('skip') }), Button({ label: 'Save', variant: 'primary', onClick: () => save('complete') }));
  const root = h('section', { class: 'bots-room-setup' }, [h('h2', { text: 'Set up this room' }),
    folderField(cwd, error), responder.node, h('label', {}, ['Room instructions', bulletin]), error, h('div', { class: 'bots-room-actions' }, buttons)]);
  host.append(root);
  return { destroy() { disposed = true; root.remove(); }, refresh: () => call(roomPath(room.id)), flush: async () => ({ ok: !busy }) };
}
export async function mount(host, { roomId, room: initial, onChanged = () => {}, call = roomCall, signal }) {
  let room = initial || await call(roomPath(roomId)), disposed = false, busy = false;
  let child = null;
  const name = h('input', { maxlength: '100', 'aria-label': 'Room name' }); name.value = room.name;
  const cwd = h('input', { maxlength: '1024', 'aria-label': 'Working folder' }); cwd.value = room.cwd || '';
  const timeout = h('input', { type: 'number', min: '1', max: '1440', 'aria-label': 'Turn limit in minutes' }); timeout.value = room.turn_timeout_minutes;
  const bulletin = h('textarea', { rows: '6', maxlength: '12000', 'aria-label': 'Room instructions' }); bulletin.value = room.bulletin || '';
  let responder = responderEditor(room);
  const error = h('p', { role: 'alert', hidden: true });
  async function flush() {
    if (busy) return { ok: false, error: 'Wait for the save to finish.' };
    busy = true; save.disabled = true;
    try {
      room = await call(roomPath(roomId || room.id), 'PATCH', { expected_revision: room.revision, name: name.value.trim(), cwd: cwd.value.trim() || null,
        bulletin: bulletin.value, turn_timeout_minutes: Number(timeout.value), default_responder: responder.read() });
      if (!disposed) { error.hidden = true; onChanged(room); }
      return { ok: true };
    } catch (problem) { if (!disposed) { error.hidden = false; error.textContent = problem.status === 409 ? `${problem.message} Close and reopen to reload.` : problem.message; } return { ok: false, error: problem.message }; }
    finally { busy = false; save.disabled = false; }
  }
  const save = Button({ label: 'Save', variant: 'primary', onClick: flush });
  bulletin.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); flush(); } });
  const members = Button({ label: 'Members', onClick: async () => { child = await openRoomMembers({ roomId: room.id, onChanged, signal }); if (disposed) child.close(); } });
  const root = h('div', { class: 'bots-room-panel' }, [h('label', {}, ['Room name', name]), responder.node,
    folderField(cwd, error), h('label', {}, ['Turn limit in minutes', timeout]), h('label', {}, ['Room instructions', bulletin]), members, error, save]);
  host.append(root);
  return { destroy() { disposed = true; child?.close(); root.remove(); }, async refresh() {
    const latest = await call(roomPath(room.id)); if (disposed) return;
    const dirty = name.value !== room.name || cwd.value !== (room.cwd || '') || bulletin.value !== room.bulletin || Number(timeout.value) !== room.turn_timeout_minutes || JSON.stringify(responder.read()) !== JSON.stringify(room.default_responder);
    if (dirty) { if (latest.revision !== room.revision) { error.hidden = false; error.textContent = 'The room changed. Close and reopen to reload.'; } return latest; }
    room = latest; name.value = room.name; cwd.value = room.cwd || ''; bulletin.value = room.bulletin || ''; timeout.value = room.turn_timeout_minutes;
    const next = responderEditor(room); responder.node.replaceWith(next.node); responder = next;
    return latest;
  }, flush };
}
export async function openRoomPanel(ctx = {}) {
  const dialog = roomDialog('Room settings', ctx.opener, ctx.signal);
  try { dialog.own(await mount(dialog.content, ctx)); }
  catch (error) { dialog.content.append(h('p', { role: 'alert', text: error.message })); }
  return dialog;
}
export async function openRoomMembers(ctx = {}) {
  const dialog = roomDialog('Room members', ctx.opener, ctx.signal);
  try { dialog.own(await mountMembers(dialog.content, { ...ctx, onSaved: () => dialog.close() })); }
  catch (error) { dialog.content.append(h('p', { role: 'alert', text: error.message })); }
  return dialog;
}

export async function openRoomThreads({ roomId, threadId, opener, signal, onPick = () => {}, call = roomCall }) {
  const dialog = roomDialog('Room conversations', opener, signal);
  let disposed = false;
  dialog.own({ destroy() { disposed = true; }, refresh: () => draw(), flush: async () => ({ ok: true }) });
  const error = h('p', { role: 'alert', hidden: true });
  async function draw() {
    const { threads } = await call(`${roomPath(roomId)}/threads`);
    if (disposed) return;
    const rows = threads.map((thread, i) => {
      const title = h('input', { maxlength: '100', 'aria-label': `Conversation ${i + 1} title` }); title.value = thread.title || '';
      const run = async (method, body) => {
        try { await call(`${roomPath(roomId)}/threads/${encodeURIComponent(thread.id)}`, method, body); await draw(); return true; }
        catch (problem) { error.hidden = false; error.textContent = problem.message; return false; }
      };
      const remove = Button({ label: 'Delete', disabled: thread.working || threads.length === 1, onClick: async () => {
        const confirm = roomDialog('Delete conversation?', null, signal);
        const refused = h('p', { role: 'alert', hidden: true });
        confirm.content.append(h('p', { text: 'This removes this conversation and its messages.' }), Button({ label: 'Delete conversation', variant: 'danger', onClick: async () => {
          if (!await run('DELETE')) { refused.hidden = false; refused.textContent = error.textContent; return; }
          confirm.close(); if (thread.id === threadId) { const next = await call(`${roomPath(roomId)}/threads`); onPick(next.threads[0]?.id); dialog.close(); }
        } }), refused);
      } });
      return h('section', { class: 'bots-room-thread-row' }, [title, h('div', { class: 'bots-room-actions' }, [
        Button({ label: thread.id === threadId ? 'Open here' : 'Open', onClick: () => { onPick(thread.id); dialog.close(); } }),
        Button({ label: 'Save title', onClick: () => run('PATCH', { title: title.value }) }), remove])]);
    });
    const title = h('input', { maxlength: '100', 'aria-label': 'New conversation title', placeholder: 'New conversation' });
    const create = Button({ label: 'Create conversation', onClick: async () => {
      create.disabled = true;
      try { const thread = await call(`${roomPath(roomId)}/threads`, 'POST', { title: title.value }); if (!disposed) { onPick(thread.id); dialog.close(); } }
      catch (problem) { if (!disposed) { error.hidden = false; error.textContent = problem.message; } }
      finally { create.disabled = false; }
    } });
    dialog.content.replaceChildren(...rows, h('div', { class: 'bots-room-thread-row' }, [title, create]), error);
  }
  try { await draw(); } catch (problem) { if (!disposed) dialog.content.replaceChildren(h('p', { role: 'alert', text: problem.message })); }
  return dialog;
}
