import { api, el, openPanelDialog, clearSharedReads } from './api.js';
import { Button, loadBotsCss } from './botsUi.js';
import { fileProblem, failure } from './botsPackageModel.js';
import { renderPreview } from './botsPackagePreview.js';

const BASE = '/api/bot-lifecycle';
export async function request(path, body, signal) {
  try { return await api(BASE + path, { method: 'POST', body: JSON.stringify(body), signal, toast: false }); }
  catch (error) { throw new Error(failure(error)); }
}
export async function uploadFile(path, file, signal, password) {
  const form = new FormData(); form.append('file', file);
  if (password !== undefined) form.append('password', password);
  const response = await fetch(BASE + path, { method: 'POST', body: form, signal });
  clearSharedReads();
  const result = await response.json();
  if (!response.ok) throw new Error(failure(result));
  return result;
}
export async function download(path, body, signal, filename) {
  const response = await api(BASE + path, { method: 'POST', body: JSON.stringify(body), signal, toast: false });
  const blob = await response.blob();
  if (signal.aborted) return;
  const url = URL.createObjectURL(blob), a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-lifecycle.css');
  const control = new AbortController(); let view = new AbortController(), destroyed = false, tab = ctx.tab || 'explore';
  const shell = el('div', { class: 'bots-lifecycle' }), tabs = el('div', { class: 'bots-lifecycle-tabs', role: 'tablist', 'aria-label': 'Templates' });
  const content = el('div', { class: 'bots-lifecycle-content', role: 'tabpanel' });
  const tabNames = [['explore', 'Explore'], ['import', 'Import'], ['folder', 'From folder'], ['share', 'Share']];
  const buttons = tabNames.map(([id, name]) => {
    const button = Button({ label: name, onClick: () => { tab = id; refresh(); } });
    button.setAttribute('role', 'tab'); button.dataset.tab = id; return button;
  });
  tabs.append(...buttons); shell.append(tabs, content); host.replaceChildren(shell);
  tabs.addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!step) return;
    e.preventDefault(); const next = (buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length; buttons[next].focus(); buttons[next].click();
  });
  function destroy() { destroyed = true; control.abort(); view.abort(); shell.remove(); ctx.signal?.removeEventListener('abort', destroy); }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  async function refresh() {
    if (destroyed) return;
    view.abort(); view = new AbortController(); const signal = view.signal;
    buttons.forEach(b => { const active = b.dataset.tab === tab; b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
    content.replaceChildren(el('p', { text: 'Loading...' }));
    const showError = error => { if (!signal.aborted) content.replaceChildren(el('p', { role: 'alert', text: failure(error) }), Button({ label: 'Retry', onClick: refresh })); };
    const act = async (button, fn, status) => { button.disabled = true; try { await fn(); } catch (error) { if (!signal.aborted) status.textContent = failure(error); } finally { if (!signal.aborted) button.disabled = false; } };
    const showImport = result => {
      if (signal.aborted) return;
      const status = el('p', { role: 'status' }); let preview;
      const add = Button({ label: 'Add', variant: 'primary', onClick: () => act(add, async () => {
        const result2 = await request('/packages/import', { token: result.token, selection: preview.selection() }, signal);
        if (signal.aborted) return;
        status.textContent = `Added ${result2.created.length} bots. ${(result2.warnings || []).join(' ')}`;
        add.remove(); document.dispatchEvent(new CustomEvent('jarvis:agents-changed'));
      }, status) });
      preview = renderPreview(result.preview); content.replaceChildren(preview.node, status, add);
    };
    try {
      if (tab === 'explore') {
        const data = await api(BASE + '/templates', { signal }); if (signal.aborted) return;
        content.replaceChildren(el('h2', { text: 'A team for your work' }));
        for (const team of data.teams || []) {
          const status = el('p', { role: 'status' });
          const load = Button({ label: `Preview ${team.name}`, onClick: () => act(load, async () => {
            const file = new File([JSON.stringify(team.package)], 'team.json', { type: 'application/json' });
            showImport(await uploadFile('/packages/inspect', file, signal));
          }, status) });
          content.append(el('section', { class: 'bots-lifecycle-card' }, [el('h3', { text: team.name }), el('p', { text: team.description }), load, status]));
        }
        const ready = Array.isArray(data.ready) ? data.ready : data.ready?.bots || [];
        for (const persona of ready) content.append(Button({ label: persona.name, onClick: async () => {
          try { const mod = await import('./botsCreate.js'); if (!signal.aborted) mod.openNewBot({ ready: persona }); }
          catch (e) { showError(e); }
        } }));
        if (!(data.teams || []).length && !ready.length) content.append(el('p', { text: 'No templates yet. Import a package to begin.' }));
      } else if (tab === 'import') {
        const input = el('input', { type: 'file', accept: '.json,.md', 'aria-label': 'Package file' });
        const status = el('p', { role: 'status' });
        const handle = async file => { const problem = fileProblem(file); if (problem) { status.textContent = problem; return; }
          input.disabled = true; status.textContent = 'Checking package...';
          try { showImport(await uploadFile('/packages/inspect', file, signal)); } catch (e) { if (!signal.aborted) status.textContent = failure(e); }
          finally { if (!signal.aborted) input.disabled = false; }
        };
        input.addEventListener('change', () => handle(input.files[0]));
        const zone = el('div', { class: 'bots-package-drop' }, [el('p', { text: 'Choose or drop a JSON or Markdown package. Up to 4 MB.' }), input]);
        zone.addEventListener('dragover', e => e.preventDefault()); zone.addEventListener('drop', e => { e.preventDefault(); handle(e.dataTransfer.files[0]); });
        content.replaceChildren(zone, status);
      } else if (tab === 'share') {
        const agents = await api('/api/agents', { signal }); if (signal.aborted) return;
        const chosen = new Set(), status = el('p', { role: 'status' });
        const options = { routines: true };
        const include = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Include paused routines' });
        include.addEventListener('change', () => { options.routines = include.checked; });
        content.replaceChildren(el('h2', { text: 'Share bot personas' }), el('p', { text: 'Preview what travels. Keys, models, access and chats stay here.' }));
        for (const agent of agents) { const box = el('input', { type: 'checkbox', 'aria-label': `Share ${agent.name}` }); box.addEventListener('change', () => box.checked ? chosen.add(agent.id) : chosen.delete(agent.id)); content.append(el('label', { class: 'bots-lifecycle-row' }, [box, el('span', { text: agent.name })])); }
        const previewHost = el('div'); const save = Button({ label: 'Download package', onClick: () => act(save, () => download('/packages/export', { bot_ids: [...chosen], options }, signal, 'bots.kairos.json'), status) }); save.hidden = true;
        const preview = Button({ label: 'Preview export', onClick: () => act(preview, async () => {
          const data = await request('/packages/export-preview', { bot_ids: [...chosen], options }, signal); if (signal.aborted) return;
          previewHost.replaceChildren(renderPreview(data, { selectable: false }).node); save.hidden = !!data.redacted?.length;
        }, status) });
        const invalidate = () => { save.hidden = true; previewHost.replaceChildren(); };
        content.addEventListener('change', invalidate, { signal });
        content.append(el('label', { class: 'bots-lifecycle-row' }, [include, 'Include paused routines']), preview, previewHost, save, status);
        if (!agents.length) content.append(el('p', { text: 'Create a bot before sharing a package.' }));
      } else {
        const mod = await import('./botsBackup.js'); // Scout view lives here to keep the dialog owner small.
        if (!signal.aborted) { const mounted = mod.mountScout(content, { signal, showImport }); signal.addEventListener('abort', () => mounted.destroy(), { once: true }); }
      }
    } catch (error) { showError(error); }
  }
  refresh(); return { destroy, refresh, flush: async () => {} };
}

export async function openTemplates({ tab = 'explore' } = {}) {
  await Promise.all([loadBotsCss('/static/css/bots.css'), loadBotsCss('/static/css/bots-lifecycle.css')]);
  const body = el('div', { 'data-bots-surface': '' }); let mounted;
  const dialog = openPanelDialog({ title: 'Templates', body, className: 'bots-lifecycle-dialog', onClose: () => mounted?.destroy() });
  mounted = mount(body, { tab }); return { ...dialog, destroy: () => dialog.close() };
}
