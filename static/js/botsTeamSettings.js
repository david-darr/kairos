import { h, Button } from './botsUi.js';
import { bulkPreviewRows } from './botsTeamDialogs.js';
import { departmentPath, teamRequest, teamError, teamChanged, openTeamSurface } from './botsTeamHost.js';
export { bulkPreviewRows } from './botsTeamDialogs.js';

export function mount(host, ctx = {}) {
  const abort = new AbortController(), request = (p, init = {}) => (ctx.api || teamRequest)(p, { ...init, signal: abort.signal });
  const path = departmentPath(ctx.departmentId);
  let disposed = false, busy = false, preview = null;
  const approval = h('select', { 'aria-label': 'Approval for every bot' }, [['', 'Keep approval'], ['ask', 'Ask first'], ['edits', 'Allow edits'], ['auto', 'Auto'], ['full', 'Full'], ['custom', 'Custom']].map(([value, text]) => h('option', { value, text })));
  const model = h('select', { 'aria-label': 'Model for every bot' }, [h('option', { value: '', text: 'Keep model' })]);
  const effort = h('select', { 'aria-label': 'Effort for every bot' }, ['', 'low', 'medium', 'high', 'xhigh'].map(value => h('option', { value, text: value || 'Keep effort' })));
  const status = h('p', { role: 'status', 'aria-live': 'polite' }), error = h('p', { class: 'bots-team-error', role: 'alert' }), rows = h('div');
  const show = Button({ label: 'Preview changes', onClick: previewChanges });
  const apply = Button({ label: 'Apply changes', variant: 'primary', disabled: true, onClick: applyChanges });
  host.append(h('label', { class: 'bots-team-field' }, ['Approval', approval]), h('label', { class: 'bots-team-field' }, ['Model', model]), h('label', { class: 'bots-team-field' }, ['Effort', effort]),
    h('div', { class: 'bots-team-actions' }, [show, apply]), status, error, rows);
  const payload = () => ({ ...(approval.value ? { approval_mode: approval.value } : {}), ...(model.value ? { model: { endpoint_id: model.value, ...(effort.value ? { model_effort: effort.value } : {}) } } : effort.value ? { model: { model_effort: effort.value } } : {}) });
  function paint(data) {
    rows.replaceChildren(...bulkPreviewRows(data).map(row => h('div', { class: 'bots-row', 'data-status': row.status }, [h('span', { class: 'bots-row-main' }, [h('strong', { text: row.name || row.bot_id || 'Bot' }), h('span', { text: `${row.status === 'will-change' ? 'Will change' : row.status === 'unchanged' ? 'Unchanged' : 'Skipped'}${row.reason ? `: ${row.reason}` : ''}` })])])));
  }
  const invalidate = () => { preview = null; apply.disabled = true; rows.replaceChildren(); status.textContent = 'Preview these changes before applying.'; };
  [approval, model, effort].forEach(n => n.addEventListener('change', invalidate));
  const lock = value => { busy = value; [approval, model, effort, show].forEach(n => { n.disabled = value; }); apply.disabled = value || !preview; };
  async function previewChanges() {
    if (busy) return;
    lock(true); error.textContent = ''; preview = null;
    try { const data = await request(`${path}/bulk-preview`, { method: 'POST', body: payload() }); if (disposed) return; preview = { data, body: payload() }; paint(data); status.textContent = 'Review each bot before applying.'; }
    catch (problem) { if (!disposed) error.textContent = teamError(problem); }
    finally { if (!disposed) lock(false); }
  }
  async function applyChanges() {
    if (busy || !preview) return;
    lock(true); error.textContent = ''; status.textContent = 'Applying changes...';
    try {
      const result = await request(`${path}/bulk-apply`, { method: 'POST', body: { ...preview.body, ...(preview.data.preview_id ? { preview_id: preview.data.preview_id } : {}), ...(preview.data.expected_revision !== undefined ? { expected_revision: preview.data.expected_revision } : {}) } });
      if (disposed) return;
      paint(result); status.textContent = `${result.completed ?? result.applied ?? bulkPreviewRows(result).filter(r => r.status !== 'skipped').length} bots updated`;
      preview = null; teamChanged(); ctx.onChanged?.();
    } catch (problem) { if (!disposed) { error.textContent = teamError(problem); preview = null; status.textContent = 'Preview again before retrying.'; } }
    finally { if (!disposed) lock(false); }
  }
  async function refresh() {
    try { const data = await request('/api/models'); if (disposed) return; const models = Array.isArray(data) ? data : data.models || data.endpoints || []; model.replaceChildren(h('option', { value: '', text: 'Keep model' }), ...models.map(m => h('option', { value: m.id, text: m.name || m.label || m.id }))); }
    catch (problem) { if (!disposed) error.replaceChildren(h('span', { text: `Models could not load. ${teamError(problem)}` }), Button({ label: 'Try again', onClick: refresh })); }
  }
  refresh(); return { refresh, flush: async () => ({ ok: !busy }), get busy() { return busy; }, destroy() { disposed = true; abort.abort(); host.replaceChildren(); } };
}
export function open(options = {}) {
  let handle;
  const dialog = openTeamSurface({ title: 'Team settings', width: 680, beforeClose: () => !handle?.busy, onClose: () => handle?.destroy() });
  handle = mount(dialog.body, options); return { ...dialog, refresh: handle.refresh, flush: handle.flush };
}
