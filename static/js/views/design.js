// The Design tab (vault: Design Canvas (Build Spec), decision 4): every
// design as a card, and one design full page on the canvas with its own
// composer. Library > Designs shows the same list (renderDesignList).
import { api, el, toast, confirmDialog, emptyState } from '../api.js';
import { mountDesignCanvas } from '../designCanvas.js';
import { mountDesignComposer } from '../designComposer.js';
import { mobileOn } from '../mobileShared.js';

const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
const ago = t => {
  if (!t) return '';
  const s = Date.now() / 1000 - t;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t * 1000).toLocaleDateString();
};
let cleanup = () => {};

export async function render(container, tabId, options = {}) {
  cleanup();
  if (options.designId) return openDesign(container, options.designId, options);
  const head = el('div', { class: 'view-header' }, [el('div', {}, [el('h2', { text: 'Design' }),
    el('div', { class: 'sub', text: 'Screens, pages and slides on a canvas, made and changed with any model.' })])]);
  container.replaceChildren(head);
  const host = el('div', { class: 'design-home' });
  container.append(host);
  await renderDesignList(host);
  return () => cleanup();
}

export async function startDesignChat(designId = null, title = 'Design') {
  const result = await api('/api/designs/chat', { method: 'POST', body: JSON.stringify({ design_id: designId, title }) });
  go('chat', { sessionId: result.session_id, openDesign: designId || null, mobileConversation: true });
  return result.session_id;
}

async function newDesign(button) {
  button.disabled = true;
  try {
    const design = await api('/api/designs', { method: 'POST', body: JSON.stringify({ title: 'Untitled design', frame: 'phone' }) });
    go('design', { designId: design.id });
  } catch { button.disabled = false; }
}

// The list of designs, in the Design tab and in Library > Designs.
export async function renderDesignList(host) {
  const create = el('button', { type: 'button', class: 'btn primary', text: 'New design', onclick: event => newDesign(event.currentTarget) });
  const withAi = el('button', { type: 'button', class: 'btn', text: 'Design with a model', title: 'A chat in Design mode: describe what you want and the model builds the boards',
    onclick: () => startDesignChat().catch(() => {}) });
  const grid = el('div', { class: 'design-grid', role: 'list', 'aria-label': 'Designs' });
  host.replaceChildren(el('div', { class: 'design-home-actions' }, [create, withAi]), grid);
  let designs = [], status = { available: false };
  try { [designs, status] = await Promise.all([api('/api/designs'), api('/api/designs/render-status').catch(() => ({ available: false }))]); }
  catch { grid.replaceChildren(el('p', { class: 'meta', role: 'status', text: 'Designs could not load. Open the tab again to retry.' })); return; }
  if (!designs.length) {
    grid.replaceChildren(emptyState({ title: 'No designs yet', hint: 'Start a blank design, or ask a model in a Design chat to build one.' }));
    return;
  }
  grid.replaceChildren(...designs.map(design => {
    const preview = el('div', { class: 'design-card-preview', 'aria-hidden': 'true' });
    if (status.available && design.first_board) {
      const img = el('img', { alt: '', loading: 'lazy', src: `/api/designs/${design.id}/boards/${design.first_board}/thumb?k=${design.version}` });
      img.addEventListener('error', () => img.replaceWith(el('span', { class: 'design-card-boards', text: (design.board_titles || []).join(' · ') })));
      preview.append(img);
    } else preview.append(el('span', { class: 'design-card-boards', text: (design.board_titles || []).join(' · ') }));
    return el('button', { type: 'button', class: 'design-card', role: 'listitem', 'aria-label': `Open ${design.title}`, onclick: () => go('design', { designId: design.id }) }, [
      preview,
      el('span', { class: 'design-card-copy' }, [el('strong', { text: design.title }),
        el('span', { class: 'meta', text: `${design.boards} board${design.boards === 1 ? '' : 's'} · edited ${ago(design.updated)}` }),
        design.chat_title ? el('span', { class: 'meta', text: `From ${design.chat_title}` }) : el('span')]),
    ]);
  }));
}

async function openDesign(container, designId, options) {
  let design = null, sessions = [], admin = false;
  const back = el('button', { type: 'button', class: 'btn quiet', text: 'All designs', onclick: () => go('design') });
  const chatPick = el('select', { 'aria-label': 'Chat that changes this design' });
  const forge = el('button', { type: 'button', class: 'btn quiet', text: 'Build in Forge', hidden: true, onclick: event => buildInForge(event.currentTarget) });
  const more = el('button', { type: 'button', class: 'btn quiet', text: 'Duplicate', onclick: async () => {
    const copy = await api(`/api/designs/${designId}/duplicate`, { method: 'POST', body: '{}' }).catch(() => null);
    if (copy) go('design', { designId: copy.id });
  } });
  const remove = el('button', { type: 'button', class: 'btn quiet danger', text: 'Delete', onclick: async () => {
    const ok = await confirmDialog({ title: 'Delete this design?', message: 'Its boards, versions and comments are removed. This cannot be undone.', confirmLabel: 'Delete' });
    if (!ok) return;
    await api(`/api/designs/${designId}`, { method: 'DELETE' }); go('design');
  } });
  const header = el('div', { class: 'design-page-header' }, [back, el('span', { class: 'design-spacer' }),
    el('label', { class: 'design-chat-pick' }, [el('span', { class: 'meta', text: 'Chat' }), chatPick]), forge, more, remove]);
  const canvasHost = el('div', { class: 'design-page-canvas' });
  const composerHost = el('div', { class: 'design-page-composer' });
  const page = el('div', { class: 'design-page' }, [header, canvasHost, composerHost]);
  container.replaceChildren(page);
  try { history.replaceState(null, '', `#/design/${designId}`); } catch { /* Not essential. */ }

  const linked = () => {
    const id = chatPick.value;
    return id ? { id, title: chatPick.selectedOptions[0]?.textContent || 'Design chat' } : null;
  };
  const composer = mountDesignComposer(composerHost, {
    getSession: linked,
    onStartChat: async () => { await startDesignChat(designId, design?.title || 'Design').catch(() => {}); },
    onOpenChat: () => { const s = linked(); if (s) go('chat', { sessionId: s.id, openDesign: designId, mobileConversation: true }); },
  });
  const canvas = mountDesignCanvas(canvasHost, {
    designId,
    onSelection: (item, previous) => composer.setSelection(item, previous),
    onComments: items => { if (!linked()) { toast('Link a chat first, or start a design chat.'); return; } composer.addComments(items); },
    onLoaded: data => { design = data; paintChats(data); },
  });
  cleanup = () => { canvas.dispose(); composer.dispose(); try { if (location.hash.startsWith('#/design/')) history.replaceState(null, '', location.pathname); } catch { /* Not essential. */ } cleanup = () => {}; };

  function paintChats(data) {
    const linkedChats = data.chats || [];
    const options = [el('option', { value: '', text: linkedChats.length ? 'No chat' : 'No chat linked' }),
      ...linkedChats.map(c => el('option', { value: c.id, text: c.title })),
      el('option', { value: '__link', text: 'Link another chat...' })];
    chatPick.replaceChildren(...options);
    chatPick.value = linkedChats.at(-1)?.id || '';
    composer.update();
  }
  chatPick.addEventListener('change', async () => {
    if (chatPick.value !== '__link') { composer.update(); return; }
    sessions = sessions.length ? sessions : await api('/api/sessions').catch(() => []);
    const menu = el('div', { class: 'design-menu', role: 'menu', 'aria-label': 'Link a chat' }, sessions.filter(s => !s.forge).slice(0, 30).map(s =>
      el('button', { type: 'button', role: 'menuitem', class: 'design-menu-item', text: s.title || 'Chat', onclick: async () => {
        menu.remove();
        const data = await api(`/api/designs/${designId}/link`, { method: 'POST', body: JSON.stringify({ session_id: s.id }) }).catch(() => null);
        if (data) { design = { ...design, ...data }; paintChats(data); chatPick.value = s.id; composer.update(); toast(`Linked to ${s.title}`, 'success'); }
      } })));
    chatPick.value = design?.chats?.at(-1)?.id || '';
    header.append(menu);
    const off = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
    menu.querySelector('button')?.focus();
  });
  api('/api/auth/status').then(s => { admin = !!s.is_admin; forge.hidden = !admin || mobileOn(); }).catch(() => {});

  // Phase 4: a Forge session with this design linked; it reads the design
  // through design_read and design_tokens and names the board behind each screen.
  async function buildInForge(button) {
    const [projects, models] = await Promise.all([api('/api/forge/projects').catch(() => []), api('/api/models/choices').catch(() => [])]);
    if (!projects.length) { toast('Add a project in Forge first.'); return; }
    const project = el('select', { 'aria-label': 'Project' }, projects.map(p => el('option', { value: p.id, text: p.name })));
    const model = el('select', { 'aria-label': 'Agent' }, models.map(m => el('option', { value: m.id, text: `${m.name} · ${m.model || 'CLI default'}` })));
    const start = el('button', { type: 'button', class: 'btn primary', text: 'Start session', onclick: async () => {
      start.disabled = true;
      try {
        const result = await api(`/api/designs/${designId}/forge`, { method: 'POST', body: JSON.stringify({ project_id: project.value, model_endpoint_id: model.value || null }) });
        menu.remove(); go('forgeSession', { sessionId: result.session_id, initialMessage: result.task });
      } catch { start.disabled = false; }
    } });
    const menu = el('div', { class: 'design-menu design-forge-menu', role: 'dialog', 'aria-label': 'Build in Forge' }, [
      el('p', { class: 'meta', text: 'A Forge session builds this design in a project, reading its boards and tokens.' }),
      el('label', { class: 'design-field' }, [el('span', { text: 'Project' }), project]),
      el('label', { class: 'design-field' }, [el('span', { text: 'Agent' }), model]), start]);
    header.querySelectorAll('.design-forge-menu').forEach(n => n.remove());
    header.append(menu); project.focus();
    const off = e => { if (!menu.contains(e.target) && e.target !== button) { menu.remove(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  }
  await canvas.ready;
  return () => cleanup();
}
