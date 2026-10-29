import { h, Button } from './botsUi.js';
import { byteCounter, isDirty } from './botsTeamDialogs.js';
import { departmentPath, teamRequest, teamError, teamChanged, openTeamSurface, confirmTeamAction } from './botsTeamHost.js';

export function mount(host, ctx = {}) {
  const abort = new AbortController(), request = (p, init = {}) => (ctx.api || teamRequest)(p, { ...init, signal: abort.signal });
  const path = `${departmentPath(ctx.departmentId)}/instructions`;
  let disposed = false, busy = false, baseline = null, hash = null;
  const area = h('textarea', { class: 'bots-team-instructions', 'aria-label': 'Team instructions', rows: '14', disabled: true });
  const counter = h('p', { class: 'bots-hint', role: 'status' });
  const error = h('p', { class: 'bots-team-error', role: 'alert' });
  const reload = Button({ label: 'Reload', onClick: async () => {
    if (dirty() && !await confirmTeamAction(host, { title: 'Discard your changes and reload?', confirmLabel: 'Reload' })) return;
    await refresh(true);
  } });
  const save = Button({ label: 'Save instructions', variant: 'primary', onClick: submit, disabled: true });
  const dirty = () => baseline !== null && isDirty(baseline, area.value);
  function paint() { const state = byteCounter(area.value); counter.textContent = state.label; counter.classList.toggle('bots-team-error', state.over); save.disabled = busy || baseline === null || state.over || !dirty(); }
  async function refresh(force = false) {
    if (busy || (!force && dirty())) return;
    busy = true; area.disabled = true; paint();
    try {
      const data = await request(path); if (disposed) return;
      area.value = data.text || ''; baseline = area.value; hash = data.hash ?? data.content_hash; error.textContent = '';
      if (typeof hash !== 'string') { baseline = null; throw new Error('The saved instructions have no content hash.'); }
    } catch (problem) { if (!disposed) error.textContent = `Instructions could not load. ${teamError(problem)}`; }
    finally { busy = false; if (!disposed) { area.disabled = baseline === null; paint(); } }
  }
  async function submit() {
    if (busy || baseline === null || byteCounter(area.value).over) return { ok: false };
    if (!dirty()) return { ok: true };
    busy = true; area.disabled = true; reload.disabled = true; paint();
    try {
      const data = await request(path, { method: 'PUT', body: { text: area.value, expected_hash: hash } });
      if (disposed) return { ok: false };
      // A re-read obtains the canonical hash even when PUT returns only an acknowledgment.
      const saved = typeof data.hash === 'string' ? data : await request(path);
      if (disposed) return { ok: false };
      baseline = area.value; hash = saved.hash ?? saved.content_hash;
      if (typeof hash !== 'string') { baseline = null; throw new Error('Reload before editing again.'); }
      error.textContent = ''; teamChanged(); ctx.onChanged?.(); return { ok: true };
    } catch (problem) { if (!disposed) error.textContent = /^409\b/.test(String(problem?.message)) || problem?.status === 409 ? 'These instructions changed. Your draft is kept. Reload to read the saved version.' : teamError(problem); return { ok: false, error: problem }; }
    finally { busy = false; if (!disposed) { area.disabled = false; reload.disabled = false; paint(); } }
  }
  area.addEventListener('input', paint);
  area.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
  host.append(area, counter, error, h('div', { class: 'bots-team-actions' }, [reload, save]));
  refresh();
  return { refresh, flush: submit, dirty, get busy() { return busy; }, destroy() { disposed = true; abort.abort(); host.replaceChildren(); } };
}
export function open(options = {}) {
  let handle;
  const dialog = openTeamSurface({ title: 'Team instructions', width: 680,
    beforeClose: async () => !handle?.busy && (!handle?.dirty() || await confirmTeamAction(dialog.body, { title: 'Discard your instructions?', confirmLabel: 'Discard' })), onClose: () => handle?.destroy() });
  handle = mount(dialog.body, options); return { ...dialog, refresh: handle.refresh, flush: handle.flush };
}
