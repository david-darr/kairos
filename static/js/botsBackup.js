import { api, el } from './api.js';
import { Button, loadBotsCss } from './botsUi.js';
import { request, uploadFile, download } from './botsTemplates.js';
import { canRestore, failure } from './botsPackageModel.js';

export function mountScout(host, { signal, showImport }) {
  let destroyed = false;
  const path = el('input', { type: 'text', 'aria-label': 'Project folder', placeholder: 'Full folder path' });
  const status = el('p', { role: 'status' }), evidence = el('div');
  const run = Button({ label: 'Find a team', onClick: async () => {
    run.disabled = true; status.textContent = 'Reading folder evidence...';
    try {
      const result = await request('/packages/scout', { path: path.value }, signal);
      if (destroyed || signal.aborted) return;
      // Each row names the suggested bot and the file that suggested it ('.' is the folder as a whole).
      const named = new Map((result.preview?.bots || []).map(bot => [bot.key, bot.name]));
      evidence.replaceChildren(...result.evidence.map(e => el('p', { text: `${named.get(e.key) || e.key}${e.file === '.' ? '' : `, from ${e.file}`}: ${e.reason}` })));
      const next = Button({ label: 'Preview team', onClick: () => showImport(result) }); evidence.append(next); status.textContent = 'Suggested from files. Nothing has been created.';
    } catch (error) { if (!destroyed && !signal.aborted) status.textContent = failure(error); }
    finally { if (!destroyed) run.disabled = false; }
  } });
  const root = el('div', {}, [el('h2', { text: 'Build a team from a folder' }), el('p', { text: 'Reads the top-level listing, README and package file. Files stay here.' }), path, run, status, evidence]);
  host.replaceChildren(root);
  return { destroy() { destroyed = true; root.remove(); }, refresh: async () => {}, flush: async () => {} };
}

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-lifecycle.css');
  const control = new AbortController(), signal = control.signal;
  let uploadId = '', destroyed = false;
  const password = el('input', { type: 'password', minlength: '12', maxlength: '1024', autocomplete: 'new-password', 'aria-label': 'Backup password' });
  const file = el('input', { type: 'file', accept: '.kbackup', 'aria-label': 'Backup file' });
  const confirm = el('input', { type: 'text', 'aria-label': 'Type REPLACE', placeholder: 'REPLACE', autocomplete: 'off' });
  const status = el('p', { role: 'status' }), preview = el('div');
  const work = async (button, fn) => { button.disabled = true; try { await fn(); } catch (e) { if (!signal.aborted) status.textContent = failure(e); } finally { if (!destroyed) validate(); } };
  const save = Button({ label: 'Download encrypted backup', onClick: () => work(save, async () => { await download('/backups/export', { password: password.value }, signal, 'workspace.kbackup'); if (!signal.aborted) status.textContent = 'Backup downloaded. Keep the password separately.'; }) });
  const inspect = Button({ label: 'Preview backup', onClick: () => work(inspect, async () => {
    if (!file.files[0]?.name.toLowerCase().endsWith('.kbackup')) throw new Error('Choose a .kbackup file.');
    const data = await uploadFile('/backups/preview', file.files[0], signal, password.value); if (signal.aborted) return;
    uploadId = data.upload_id; preview.replaceChildren(el('p', { text: `${data.counts.bots} bots, ${data.counts.routines} routines, ${data.counts.chats} chats, ${data.counts.triggers} triggers` }));
    status.textContent = 'Preview only. Restore replaces this workspace and pauses all automation.';
  }) });
  const restore = Button({ label: 'Replace workspace', variant: 'danger', onClick: () => work(restore, async () => {
    const result = await request('/backups/restore', { upload_id: uploadId, password: password.value, confirm: confirm.value }, signal);
    if (signal.aborted) return;
    status.textContent = result.restart_required ? 'Restore is staged. Restart Kairos to apply it. Automation will stay paused.' : 'Restore staged.'; uploadId = ''; password.value = ''; confirm.value = '';
  }) });
  function validate() { save.disabled = password.value.length < 12; inspect.disabled = password.value.length < 12 || !file.files.length; restore.disabled = !uploadId || !canRestore(password.value, confirm.value); }
  password.addEventListener('input', () => { uploadId = ''; preview.replaceChildren(); validate(); }); file.addEventListener('change', () => { uploadId = ''; preview.replaceChildren(); validate(); }); confirm.addEventListener('input', validate);
  const root = el('div', { class: 'bots-lifecycle' }, [el('h2', { text: 'Workspace backup' }), el('p', { text: 'Use at least 12 characters. Saved browser sign-ins and bot secrets stay out.' }), password, save, el('h3', { text: 'Restore a backup' }), file, inspect, preview, el('p', { text: 'Type REPLACE after reviewing the preview.' }), confirm, restore, status]);
  host.replaceChildren(root); validate();
  function destroy() { destroyed = true; control.abort(); password.value = ''; root.remove(); ctx.signal?.removeEventListener('abort', destroy); }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  return { destroy, refresh: async () => {}, flush: async () => {} };
}
