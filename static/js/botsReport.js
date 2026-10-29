// Report a problem (Bots Phase 6, unit U4, F101). openReport({sessionId, messageId, botName}) drafts a redacted
// Markdown report about one bot reply: what went wrong, what you saw and the steps, plus the app's diagnostics added
// by the server (services/bot_report.py). It is saved on this computer and never sent; the person can copy it or
// open its folder. One report per message: asking again shows the first ("Already drafted").
import { api, openPanelDialog } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';

const BASE = '/api/bot-lifecycle/reports';
export const FIELDS = [
  { id: 'went_wrong', label: 'What went wrong', limit: 2000, required: true, rows: 4 },
  { id: 'you_saw', label: 'What you saw', limit: 3000, rows: 4 },
  { id: 'steps', label: 'Steps to see it again', limit: 2000, rows: 3 },
];

export function reportBody(values) {
  return Object.fromEntries(FIELDS.map(f => [f.id, String(values[f.id] || '').trim().slice(0, f.limit)]));
}

export function mountReport(host, { sessionId, messageId, botName = 'this bot', request = api, copy = text => navigator.clipboard.writeText(text) } = {}) {
  loadBotsCss('/static/css/bots-lifecycle.css');
  let destroyed = false, busy = false;
  const root = h('section', { class: 'bots-report', 'data-section': 'report' });
  const status = h('p', { class: 'bots-report-status', role: 'status', 'aria-live': 'polite' });
  const fields = FIELDS.map(field => {
    const input = h('textarea', { rows: String(field.rows), maxlength: String(field.limit), 'aria-label': field.label, 'data-field': field.id });
    const count = h('small', { class: 'bots-report-count', text: `0 of ${field.limit.toLocaleString()}` });
    input.addEventListener('input', () => { count.textContent = `${input.value.length.toLocaleString()} of ${field.limit.toLocaleString()}`; draft.disabled = busy || !fields[0].input.value.trim(); });
    return { field, input, node: h('label', { class: 'bots-report-field' }, [h('span', { text: field.label + (field.required ? '' : ' (optional)') }), input, count]) };
  });
  const draft = Button({ label: 'Draft report', variant: 'primary', disabled: true, onClick: () => submit() });
  function showForm() {
    root.replaceChildren(h('p', { text: `About a reply from ${botName}. The report is written on this computer with secrets removed. Nothing is sent.` }),
      ...fields.map(f => f.node), status, h('div', { class: 'bots-actions' }, [draft]));
  }
  function showReport(report) {
    const text = h('pre', { class: 'bots-report-text', tabindex: '0', 'aria-label': 'The report', text: report.markdown });
    const copied = h('p', { role: 'status', 'aria-live': 'polite' });
    root.replaceChildren(
      h('p', { text: report.already ? 'Already drafted for this message. Here it is.' : 'Drafted. Read it before you share it with anyone.' }),
      h('p', { class: 'bots-report-path', text: report.path }), text, copied,
      h('div', { class: 'bots-actions' }, [
        Button({ label: 'Copy', iconName: 'copy', onClick: async () => {
          try { await copy(report.markdown); copied.textContent = 'Copied.'; } catch { copied.textContent = 'Could not copy. Select the text instead.'; }
        } }),
        Button({ label: 'Open folder', iconName: 'folder', onClick: async () => {
          try { await request(`${BASE}/open-folder`, { method: 'POST', toast: false }); } catch (error) { copied.textContent = error.message || 'The folder could not open.'; }
        } }),
      ]));
  }
  async function submit() {
    if (busy || !fields[0].input.value.trim()) return;
    busy = true; draft.disabled = true; status.textContent = 'Drafting...';
    try {
      const values = Object.fromEntries(fields.map(f => [f.field.id, f.input.value]));
      const report = await request(BASE, { method: 'POST', toast: false, body: JSON.stringify({ session_id: sessionId, message_id: messageId, ...reportBody(values) }) });
      if (!destroyed) showReport(report);
    } catch (error) {
      if (!destroyed) { status.textContent = error.message || 'The report could not be drafted. Try again.'; draft.disabled = false; }
    } finally { busy = false; }
  }
  showForm(); host.append(root);
  return { destroy() { destroyed = true; root.remove(); } };
}

export function openReport({ sessionId, messageId, botName } = {}) {
  loadBotsCss('/static/css/bots.css');
  const body = h('div', { 'data-app-mode': 'bots' });
  let mounted;
  const dialog = openPanelDialog({ title: 'Report a problem', body, className: 'bots-lifecycle-dialog', onClose: () => mounted?.destroy() });
  mounted = mountReport(body, { sessionId, messageId, botName });
  return dialog;
}
