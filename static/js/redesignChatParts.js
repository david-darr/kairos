import { api, el } from './api.js';
import { emptyState } from './kairosParts.js';
import { createMascot } from './mascot.js';
import * as chatStream from './chatStream.js';

export function chatAge(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || !timestamp) return '';
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - Number(timestamp)) / 60));
  return minutes < 1 ? 'Now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

// Only the stream's real processing sessions appear here. Static roster faces
// are deliberately avoided so live activity and the mascot preference agree.
export function workingChats(sessions, open) {
  const live = sessions.filter(session => chatStream.getInFlight(session.id)?.status === 'processing');
  const section = el('section', { class: 'rd-chat-working', 'aria-label': 'Working now', hidden: !live.length });
  section.append(el('h2', { text: 'Working now' }));
  const row = el('div', { class: 'rd-chat-working-row' });
  for (const session of live) {
    const title = session.title || 'Untitled conversation';
    const button = el('button', { type: 'button', title, 'aria-label': `Open working chat: ${title}`, onclick: () => open(session.id) });
    if (document.documentElement.dataset.mascot !== 'off') button.append(createMascot({ state: 'thinking', size: 42, decorative: true }));
    button.append(el('span', { text: title })); row.append(button);
  }
  section.append(row); return section;
}

// Presentation outside #chat-messages: it must stay empty on New so the
// controller's figure/sky choice and reading-position anchor remain intact.
export function mountChatParts(container) {
  const main = container.querySelector('#chat-main');
  const list = container.querySelector('#sessions-list');
  const panel = container.querySelector('#chat-sessions');
  if (!main || !list || !panel) return () => {};
  const menus = [...container.querySelectorAll('.overflow-menu, .model-picker-menu')].filter(node => !node.classList.contains('rd-menu-in'));
  menus.forEach(node => node.classList.add('rd-menu-in'));
  const idle = emptyState({ mascotState: 'sleeping', title: 'What should we work on?', text: 'Kip is resting until you need it.' });
  idle.classList.add('rd-chat-idle'); idle.hidden = true;
  // The phone launch shell already owns its idle content and bottom dock.
  const dock = container.classList.contains('ms-launch-chat') ? null : main.querySelector('.chat-composer-dock');
  const idleLayout = el('div', { class: 'rd-chat-idle-layout' });
  if (dock) {
    dock.before(idleLayout);
    idleLayout.append(idle, dock);
  }
  const search = el('input', { type: 'search', class: 'rd-chat-search', placeholder: 'Search chats', 'aria-label': 'Search conversations' });
  const recent = el('h2', { class: 'rd-chat-recent', text: 'Recent' });
  let working = workingChats([], () => {}), disposed = false, revision = 0, cachedSessions = [], liveKey = '', firstRows = true;
  const heading = el('h2', { class: 'rd-chat-panel-title', text: 'Conversations' });
  panel.prepend(heading, search, working, recent);
  list.before(working, recent);
  const originals = new Map();
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of list.querySelectorAll('.session-item')) row.hidden = !row.dataset.title?.toLowerCase().includes(query);
  };
  search.addEventListener('input', filter);
  const enabled = () => document.documentElement.classList.contains('kairos-redesign');
  const sync = () => {
    idle.hidden = !enabled() || !main.classList.contains('is-empty');
    const busy = chatStream.listInFlight().some(entry => entry.status === 'processing');
    idle.querySelector('p').textContent = busy ? 'Start something new while your other work continues.' : 'Kip is resting until you need it.';
    idle.querySelector('kairos-mascot')?.setAttribute('state', busy ? 'idle' : 'sleeping');
    for (const node of [heading, search, recent, working]) node.hidden = !enabled() || (node === working && !node.querySelector('button'));
    if (!enabled()) {
      for (const row of list.querySelectorAll('.session-item')) row.hidden = false;
      for (const [row, nodes] of originals) { if (row.isConnected) row.replaceChildren(...nodes); }
      originals.clear(); list.classList.remove('rd-stagger');
    } else { decorate(); drawWorking(); }
  };
  function decorate() {
    for (const row of list.querySelectorAll('.session-item')) {
      if (originals.has(row)) continue;
      const nodes = [...row.childNodes]; originals.set(row, nodes);
      const title = row.dataset.title || row.title || 'Untitled conversation';
      row.replaceChildren(el('span', { class: 'rd-chat-initial', text: Array.from(title.trim())[0] || 'K', 'aria-hidden': 'true' }),
        el('span', { class: 'rd-chat-row-title' }, nodes));
    }
    for (const row of originals.keys()) if (!row.isConnected) originals.delete(row);
    filter();
  }
  async function metadata() {
    const current = ++revision;
    if (!enabled()) return;
    decorate();
    try {
      const sessions = await api('/api/sessions');
      if (disposed || current !== revision || !enabled()) return;
      cachedSessions = sessions;
      for (const row of list.querySelectorAll('.session-item')) {
        const session = sessions.find(session => session.id === row.dataset.sessionId);
        row.querySelector('.rd-chat-row-age')?.remove();
        if (session) row.append(el('small', { class: 'rd-chat-row-age', text: chatAge(session.updated_at) }));
      }
      drawWorking();
    } catch { /* Titles remain usable when metadata is unavailable. */ }
  }
  function drawWorking() {
    const visible = cachedSessions.filter(session => list.querySelector(`[data-session-id="${CSS.escape(session.id)}"]`));
    const next = workingChats(visible, id => list.querySelector(`[data-session-id="${CSS.escape(id)}"]`)?.click());
    next.hidden ||= !enabled();
    working.replaceWith(next); working = next;
  }
  // Observe direct row replacement only, never streamed prose or our own row decoration.
  const rows = new MutationObserver(() => {
    if (!enabled()) return;
    if (list.querySelector('.session-item')) {
      if (firstRows) list.classList.add('rd-stagger'); else list.classList.remove('rd-stagger');
      firstRows = false;
    }
    metadata();
  });
  rows.observe(list, { childList: true });
  const state = new MutationObserver(sync); state.observe(main, { attributes: true, attributeFilter: ['class'] });
  const detach = chatStream.subscribeAll(() => {
    const key = chatStream.listInFlight().filter(entry => entry.status === 'processing').map(entry => entry.sessionId).sort().join('|');
    if (key === liveKey) return;
    liveKey = key; sync(); drawWorking();
  });
  document.addEventListener('kairos:appearance', sync);
  sync(); metadata();
  return () => {
    disposed = true; revision++; rows.disconnect(); state.disconnect(); detach();
    document.removeEventListener('kairos:appearance', sync);
    if (dock) idleLayout.before(dock);
    idleLayout.remove();
    for (const [row, nodes] of originals) if (row.isConnected) row.replaceChildren(...nodes);
    for (const node of [idle, heading, search, recent, working]) node.remove();
    list.classList.remove('rd-stagger');
    menus.forEach(node => node.classList.remove('rd-menu-in'));
  };
}
