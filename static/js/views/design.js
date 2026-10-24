// Designs in Library (vault: Design Canvas (Build Spec); David 2026-10-22
// moved them out of their own tab): Library > Designs lists every design as a
// card (renderDesignList), and a design opens full page inside Library
// (openDesignPage) on the canvas, with its own composer and the model picker
// for its linked chat. The old Design tab and #/design/<id> links redirect to
// Library > Designs (app.js).
import { api, el, toast, openPanelDialog } from '../api.js';
import { workspaceConfirm as confirmDialog, workspaceEmpty as emptyState, redesignOn } from '../workspaceParts.js';
import { mountSharedDesignCanvas as mountDesignCanvas } from '../sharedDesignCanvas.js';
import { mountDesignComposer } from '../designComposer.js';
import { mountDesignModelPicker } from '../designModelPicker.js';
import { mobileOn } from '../mobileShared.js';

const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
const ago = t => {
  if (!t) return '';
  const s = Date.now() / 1000 - t;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t * 1000).toLocaleDateString();
};
let cleanup = () => {};

// Library calls these (views/library.js): one design open at a time.
export function closeDesign() { cleanup(); }
let openParts = null;  // {canvas, composer} of the design on screen
// Library's leave guard (leaveGuard.js): a comment being written or token
// changes not yet saved are asked about before leaving. (An unsent message is
// kept with the design, as a chat keeps its draft; every other change is
// already saved as a version.)
export async function canLeaveDesign() {
  if (!openParts?.canvas.hasUnsaved()) return true;
  return confirmDialog({ title: 'Leave this design?', message: 'The comment you are writing or your unsaved token changes will be lost.', confirmLabel: 'Leave', danger: false });
}
export function openDesignPage(container, designId, options = {}) { cleanup(); return openDesign(container, designId, options); }

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
    go('library', { section: 'designs', designId: design.id });
  } catch { button.disabled = false; }
}

// The list of designs, in the Design tab and in Library > Designs.
export async function renderDesignList(host) {
  const create = el('button', { type: 'button', class: 'btn primary', text: 'New design', onclick: event => newDesign(event.currentTarget) });
  const withAi = el('button', { type: 'button', class: 'btn', text: 'Design with a model', title: 'A chat in Design mode: describe what you want and the model builds the boards',
    onclick: () => startDesignChat().catch(() => {}) });
  const grid = el('div', { class: 'design-grid rd-stagger', role: 'list', 'aria-label': 'Designs' });
  host.replaceChildren(el('div', { class: 'design-home-actions' }, [create, withAi]), grid);
  let designs = [], status = { available: false };
  try { [designs, status] = await Promise.all([api('/api/designs'), api('/api/designs/render-status').catch(() => ({ available: false }))]); }
  catch { grid.replaceChildren(el('p', { class: 'meta', role: 'status', text: 'Designs could not load. Open the tab again to retry.' })); return; }
  if (!designs.length) {
    grid.replaceChildren(emptyState({ title: 'No designs yet', hint: 'Start a blank design, or ask a model in a Design chat to build one.',
      actionLabel: 'New design', onAction: () => newDesign(create) }));
    return;
  }
  const cards = designs.map(design => {
    const preview = el('div', { class: 'design-card-preview', 'aria-hidden': 'true' });
    if (status.available && design.first_board) {
      const img = el('img', { alt: '', loading: 'lazy', src: `/api/designs/${design.id}/boards/${design.first_board}/thumb?k=${design.version}` });
      img.addEventListener('error', () => img.replaceWith(el('span', { class: 'design-card-boards', text: (design.board_titles || []).join(' · ') })));
      preview.append(img);
    } else preview.append(el('span', { class: 'design-card-boards', text: (design.board_titles || []).join(' · ') }));
    return el('button', { type: 'button', class: 'design-card', role: 'listitem', 'aria-label': `Open ${design.title}`, onclick: () => go('library', { section: 'designs', designId: design.id }) }, [
      preview,
      el('span', { class: 'design-card-copy' }, [el('strong', { text: design.title }),
        el('span', { class: 'meta', text: `${design.boards} board${design.boards === 1 ? '' : 's'} · edited ${ago(design.updated)}` }),
        design.chat_title ? el('span', { class: 'meta', text: `From ${design.chat_title}` }) : el('span')]),
    ]);
  });
  grid.replaceChildren(...cards);
  if (redesignOn()) {
    const search = el('input', { type: 'search', class: 'design-search', placeholder: 'Search designs', 'aria-label': 'Search designs' });
    search.addEventListener('input', () => {
      const query = search.value.trim().toLocaleLowerCase();
      const matches = cards.filter((card, i) => `${designs[i].title} ${(designs[i].board_titles || []).join(' ')}`.toLocaleLowerCase().includes(query));
      grid.replaceChildren(...(matches.length ? matches : [emptyState({ title: 'No designs match', hint: 'Try a different title or board name.',
        actionLabel: 'Clear search', onAction: () => { search.value = ''; search.dispatchEvent(new Event('input')); search.focus(); } })]));
    });
    host.querySelector('.design-home-actions').prepend(search);
  }
}

async function openDesign(container, designId, options) {
  let design = null, sessions = [], admin = false;
  const back = el('button', { type: 'button', class: 'btn quiet design-back', text: 'All designs', 'aria-label': 'All designs, in Library',
    onclick: () => go('library', { section: 'designs' }) });
  const chatPick = el('select', { 'aria-label': 'Chat that changes this design' });
  const forge = el('button', { type: 'button', class: 'btn quiet', text: 'Build in Forge', hidden: true, onclick: event => buildInForge(event.currentTarget) });
  const more = el('button', { type: 'button', class: 'btn quiet', text: 'Duplicate', onclick: async () => {
    const copy = await api(`/api/designs/${designId}/duplicate`, { method: 'POST', body: '{}' }).catch(() => null);
    if (copy) go('library', { section: 'designs', designId: copy.id });
  } });
  const remove = el('button', { type: 'button', class: 'btn quiet danger', text: 'Delete', onclick: async () => {
    const ok = await confirmDialog({ title: 'Delete this design?', message: 'Its boards, versions and comments are removed. This cannot be undone.', confirmLabel: 'Delete' });
    if (!ok) return;
    await api(`/api/designs/${designId}`, { method: 'DELETE' }); go('library', { section: 'designs' });
  } });
  const modelHost = el('div', { class: 'design-model-host' });
  const header = el('div', { class: 'design-page-header' }, [back, el('span', { class: 'design-spacer' }),
    el('label', { class: 'design-chat-pick' }, [el('span', { class: 'meta', text: 'Chat' }), chatPick]), modelHost, forge, more, remove]);
  if (redesignOn()) {
    const controls = el('div', { class: 'design-page-options' });
    controls.append(header.querySelector('.design-chat-pick'), modelHost, forge, more, remove);
    const optionsButton = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round', text: '…', 'aria-label': 'Design options', onclick: () => {
      const dialog = openPanelDialog({ title: 'Design options', body: controls, owner: container, opener: optionsButton,
        onClose: () => header.append(controls) });
      dialog.panel.dataset.view = 'library';
    } });
    header.append(optionsButton, controls);
  }
  const canvasHost = el('div', { class: 'design-page-canvas' });
  const composerHost = el('div', { class: 'design-page-composer' });
  const identity = el('div', { class: 'design-page-identity' });
  if (redesignOn()) header.insertBefore(identity, header.children[1]);
  const page = el('div', { class: 'design-page rd-push-in', 'data-design-id': designId }, [header, canvasHost, composerHost]);
  container.replaceChildren(page);
  container.classList.add('library-design-open');
  try { history.replaceState(null, '', `#/library/designs/${designId}`); } catch { /* Not essential. */ }

  const linked = () => {
    const id = chatPick.value;
    return id ? { id, title: chatPick.selectedOptions[0]?.textContent || 'Design chat' } : null;
  };
  // The model of the linked chat (designModelPicker.js): the composer's sends use it.
  const picker = mountDesignModelPicker(modelHost, { getSession: linked });
  const composer = mountDesignComposer(composerHost, {
    getSession: linked, draftKey: designId,
    onStartChat: async () => { await startDesignChat(designId, design?.title || 'Design').catch(() => {}); },
    onOpenChat: () => { const s = linked(); if (s) go('chat', { sessionId: s.id, openDesign: designId, mobileConversation: true }); },
  });
  const canvas = mountDesignCanvas(canvasHost, {
    designId,
    onSelection: (item, previous) => composer.setSelection(item, previous),
    onComments: items => { if (!linked()) { toast('Link a chat first, or start a design chat.'); return; } composer.addComments(items); },
    onLoaded: data => { design = data; identity.replaceChildren(el('h2', { class: 'workspace-phone-only', text: 'Library' }), el('strong', { text: data.title }), el('small', { text: `Library · v${data.version}` })); paintChats(data); },
  });
  openParts = { canvas, composer };
  cleanup = () => {
    openParts = null;
    canvas.dispose(); composer.dispose(); picker.dispose(); container.classList.remove('library-design-open');
    try { if (/^#\/(design|library\/designs)\//.test(location.hash)) history.replaceState(null, '', location.pathname); } catch { /* Not essential. */ }
    cleanup = () => {};
  };

  function paintChats(data) {
    const linkedChats = data.chats || [];
    const options = [el('option', { value: '', text: linkedChats.length ? 'No chat' : 'No chat linked' }),
      ...linkedChats.map(c => el('option', { value: c.id, text: c.title })),
      el('option', { value: '__link', text: 'Link another chat...' })];
    chatPick.replaceChildren(...options);
    chatPick.value = linkedChats.at(-1)?.id || '';
    composer.update(); picker.update();
  }
  chatPick.addEventListener('change', async () => {
    if (chatPick.value !== '__link') { composer.update(); picker.update(); return; }
    sessions = sessions.length ? sessions : await api('/api/sessions').catch(() => []);
    const menu = el('div', { class: 'design-menu rd-menu-in', role: 'menu', 'aria-label': 'Link a chat' }, sessions.filter(s => !s.forge).slice(0, 30).map(s =>
      el('button', { type: 'button', role: 'menuitem', class: 'design-menu-item', text: s.title || 'Chat', onclick: async () => {
        menu.remove();
        const data = await api(`/api/designs/${designId}/link`, { method: 'POST', body: JSON.stringify({ session_id: s.id }) }).catch(() => null);
        if (data) { design = { ...design, ...data }; paintChats(data); chatPick.value = s.id; composer.update(); picker.update(); toast(`Linked to ${s.title}`, 'success'); }
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
    const menu = el('div', { class: 'design-menu design-forge-menu rd-menu-in', role: 'dialog', 'aria-label': 'Build in Forge' }, [
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
