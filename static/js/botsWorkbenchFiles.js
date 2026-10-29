import { api, el } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { lifetime } from './botsWorkbenchModel.js';

export async function mount(host, ctx) {
  loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx), root = el('section', { class: 'bots-workbench-files' });
  host.replaceChildren(root);
  async function refresh() {
    root.replaceChildren(el('p', { role: 'status', text: 'Loading files' }));
    try {
      const data = await api(`/api/bot-workbench/${encodeURIComponent(ctx.agentId)}/files${ctx.threadId ? `?thread_id=${encodeURIComponent(ctx.threadId)}` : ''}`, { signal: life.signal });
      if (!life.active) return;
      root.replaceChildren(el('h3', { text: data.folder.private ? 'Private folder' : data.folder.label }), el('p', { text: 'Recent files' }));
      if (!data.recent.length) root.append(el('p', { text: 'No recent files' }));
      for (const file of data.recent) {
        const row = el('div', { class: 'bots-workbench-row' }, [el('span', { text: file.name }), el('small', { text: `${file.bytes.toLocaleString()} bytes` })]);
        if (file.url) row.append(el('button', { type: 'button', class: 'bots-btn', text: 'Open', onclick: async () => {
          try { const viewer = await import('./chatContent.js'); if (life.active) await viewer.openArtifact(file.thread_id || ctx.threadId, file.url, file.name, row); }
          catch (e) { if (life.active) row.append(el('p', { role: 'alert', text: e.message })); }
        } }));
        if (!file.shared) row.append(el('small', { text: 'Not shared' }));
        root.append(row);
      }
    } catch (e) { if (life.active) root.replaceChildren(el('p', { role: 'alert', text: e.message }), el('button', { class: 'bots-btn', text: 'Retry', onclick: refresh })); }
  }
  await refresh();
  return life.handle(refresh);
}
