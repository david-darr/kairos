import { api as sharedApi, el as h } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { STARTERS, starterSelection, validAsk, sendId } from './botsWorkModel.js';

// A native dialog supplies a keyboard focus trap and Escape, including when
// this sheet is mounted inside another front-desk surface.
export function openNewTask(host, ctx = {}) {
  loadBotsCss('/static/css/bots-work.css');
  const api = ctx.api || sharedApi;
  const opener = document.activeElement;
  let closed = false, busy = false;
  const controller = new AbortController();
  const id = sendId(); // Keep across a lost-response retry.
  const dialog = h('dialog', { class: 'bots-work-sheet bots-new-task', 'aria-label': ctx.makeKind ? 'New make task' : 'New task' });
  const title = h('h2', { text: ctx.makeKind ? 'What should Kip make?' : 'What should Kip do?' });
  const close = () => {
    if (closed) return;
    closed = true; controller.abort(); dialog.close(); dialog.remove();
    if (opener?.isConnected) opener.focus();
    ctx.onClose?.();
  };
  const field = h('textarea', { maxlength: '4000', rows: '5', placeholder: 'Describe the work', 'aria-label': 'Task' });
  const notice = h('p', { class: 'bots-work-notice', role: 'status', 'aria-live': 'polite' });
  const start = h('button', { type: 'button', class: 'bots-btn primary', text: 'Start now' });
  const save = h('button', { type: 'button', class: 'bots-btn', text: 'Save for Up next' });
  const update = () => { start.disabled = save.disabled = busy || !validAsk(field.value); };
  field.addEventListener('input', update);
  const submit = async later => {
    if (busy || !validAsk(field.value)) return;
    busy = true; update(); notice.textContent = later ? 'Saving...' : 'Starting...';
    try {
      const task = await api('/api/front-desk/tasks', { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ text: field.value.trim(), kind: ctx.makeKind ? 'make' : 'task',
          ...(ctx.makeKind ? { make_kind: ctx.makeKind } : {}), save_for_later: later, send_id: id,
          ...(ctx.channelTag ? { channel_tag: ctx.channelTag } : {}) }) });
      if (closed) return;
      ctx.onCreated?.(task, { saved: later }); close();
    } catch (error) { if (!closed) notice.textContent = error.message || 'Could not save. Try again.'; }
    finally { busy = false; if (!closed) update(); }
  };
  start.onclick = () => submit(false); save.onclick = () => submit(true);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); submit(false); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } });
  const starters = h('div', { class: 'bots-work-starters' });
  for (const [kind, text] of Object.entries(STARTERS)) {
    if (ctx.makeKind && ctx.makeKind !== kind || !ctx.makeKind && kind !== 'task') continue;
    starters.append(h('button', { type: 'button', class: 'bots-btn', text, onclick: () => choose(kind) }));
  }
  function choose(kind) {
    const starter = starterSelection(kind); field.value = starter.text; field.focus();
    field.setSelectionRange(starter.start, starter.end); update();
  }
  dialog.append(h('header', {}, [title, h('button', { type: 'button', class: 'bots-btn', text: 'Close', onclick: close })]), field,
    starters, notice, h('footer', {}, [save, start]));
  host.append(dialog); dialog.showModal(); field.focus();
  if (ctx.makeKind) choose(ctx.makeKind); else update();
  return { dispose: close, close };
}

export function mount(host, ctx) { return openNewTask(host, ctx); }
