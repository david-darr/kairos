import { el } from './api.js';
import { createMascot } from './mascot.js';
import * as chatStream from './chatStream.js';

let activeMenu = null;
export function closeConversationMenu() { activeMenu?.(); }

// Body-mounted so the scrollable history cannot clip the menu.
export function showConversationMenu({ row, session, x, y, actions, open }) {
  closeConversationMenu();
  const menu = el('div', { class: 'rd-conversation-menu rd-menu-in', role: 'menu', 'aria-label': 'Conversation actions' });
  const items = open ? [
    { label: 'Open', icon: '\u2192', run: open },
    ...(typeof window.jarvis?.openChatWindow === 'function' ? [{ label: 'Open in new window', icon: '\u2197', run: () => window.jarvis.openChatWindow(session.id) }] : []),
    ...actions,
  ] : actions;
  const close = () => {
    if (activeMenu !== close) return;
    activeMenu = null; menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('click', outside, true);
    document.removeEventListener('scroll', dismiss, true);
    document.removeEventListener('keydown', keydown, true);
    window.removeEventListener('resize', dismiss);
    row.focus({ preventScroll: true });
  };
  const outside = event => { if (!menu.contains(event.target)) close(); };
  const dismiss = () => close();
  const buttons = items.map(action => el('button', {
    type: 'button', role: 'menuitem', tabindex: '-1', class: `rd-conversation-menu-item${action.danger ? ' danger' : ''}`,
    onclick: event => { event.stopPropagation(); close(); action.run(); },
  }, [el('span', { class: 'rd-conversation-menu-icon', text: action.icon, 'aria-hidden': 'true' }), el('span', { text: action.label })]));
  const keydown = event => {
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation(); close();
    }
  };
  menu.append(...buttons); document.body.append(menu); activeMenu = close;
  const anchor = row.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x ?? anchor.left, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y ?? anchor.bottom, window.innerHeight - rect.height - 8))}px`;
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('click', outside, true);
  document.addEventListener('scroll', dismiss, true);
  document.addEventListener('keydown', keydown, true);
  window.addEventListener('resize', dismiss);
  buttons[0]?.focus({ preventScroll: true });
  return close;
}

// Use local calendar boundaries, including DST. Weeks start on Monday.
export function conversationGroups(sessions, inflight = [], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const working = new Set(inflight.filter(run => run.status === 'processing').map(run => run.sessionId));
  const groups = new Map(['Working now', 'Today', 'Yesterday', 'Earlier this week', 'Older'].map(label => [label, []]));
  for (const session of [...sessions].sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0))) {
    const stamp = Number(session.updated_at) * 1000;
    const label = working.has(session.id) ? 'Working now' : stamp >= today ? 'Today' : stamp >= yesterday ? 'Yesterday' : stamp >= week ? 'Earlier this week' : 'Older';
    groups.get(label).push(session);
  }
  return [...groups].filter(([, rows]) => rows.length).map(([label, rows]) => ({ label, rows }));
}
export function conversationCounts(sessions, filters) {
  return filters.map(filter => ({ ...filter, count: sessions.filter(session => filter.id === null || session.project_id === filter.id).length }));
}

export function mountConversations(container) {
  const panel = container.querySelector('#chat-sessions');
  const list = container.querySelector('#sessions-list');
  const newChat = panel?.querySelector('.chat-new-btn');
  if (!panel || !list || !newChat) return () => {};
  const desktop = matchMedia('(min-width: 769px)');
  const enabled = () => desktop.matches && document.documentElement.classList.contains('kairos-redesign');
  const heading = el('header', { class: 'rd-conversations-header' }, [el('h2', { text: 'Conversations' })]);
  const close = el('button', { type: 'button', class: 'rd-conversations-close', text: '\u2039', 'aria-label': 'Close conversations', onclick: () => {
    container.querySelector('#chat-history-toggle')?.click(); container.querySelector('#chat-history-toggle')?.focus();
  } });
  const search = el('input', { class: 'rd-chat-search', type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats' });
  const searchPill = el('label', { class: 'rd-conversations-search' }, [el('span', { text: '\u2315', 'aria-hidden': 'true' }), search, el('kbd', { text: 'Ctrl F' })]);
  const segments = el('div', { class: 'rd-conversations-filters', role: 'group', 'aria-label': 'Filter conversations by project' });
  const footer = el('footer', { class: 'rd-conversations-footer' });
  const added = [heading, searchPill, segments, footer];
  const originals = new Map();
  let applied = false, firstOpen = false;
  const newNext = newChat.nextSibling;
  function restore() {
    for (const [row, nodes] of originals) if (row.isConnected) { row.replaceChildren(...nodes); row.hidden = false; list.append(row); }
    originals.clear();
    list.querySelectorAll('.rd-conversations-group').forEach(node => node.remove());
    list.classList.remove('rd-stagger');
  }
  function draw() {
    if (!enabled()) {
      closeConversationMenu();
      if (applied) { restore(); panel.insertBefore(newChat, newNext?.parentNode === panel ? newNext : list); added.forEach(node => node.remove()); applied = false; }
      return;
    }
    if (!applied) { panel.prepend(heading, searchPill, segments); panel.append(footer); heading.append(newChat, close); applied = true; }
    const rows = [...list.querySelectorAll('.session-item')];
    for (const row of originals.keys()) if (!row.isConnected) originals.delete(row);
    for (const row of rows) if (!originals.has(row)) originals.set(row, [...row.childNodes]);
    const sessions = list.chatSessions || [];
    const byId = new Map(sessions.map(session => [session.id, session]));
    const query = search.value.trim().toLowerCase();
    const shown = rows.filter(row => !row.querySelector('.session-rename-input') && (row.dataset.title || '').toLowerCase().includes(query));
    const groups = conversationGroups(shown.map(row => byId.get(row.dataset.sessionId) || { id: row.dataset.sessionId, title: row.dataset.title }), chatStream.listInFlight());
    list.querySelectorAll('.rd-conversations-group').forEach(node => node.remove());
    for (const row of rows) row.hidden = !shown.includes(row) && !row.querySelector('.session-rename-input');
    for (const group of groups) {
      list.append(el('h3', { class: 'rd-conversations-group', text: group.label }));
      for (const session of group.rows) {
        const row = rows.find(row => row.dataset.sessionId === session.id);
        const run = chatStream.getInFlight(session.id);
        const state = el('span', { class: `rd-conversation-state${run?.status === 'done' ? ' is-finished' : ''}`, 'aria-hidden': 'true' });
        if (run?.status === 'processing' && document.documentElement.dataset.mascot !== 'off') state.append(createMascot({ state: 'thinking', size: 28, decorative: true }));
        const title = el('span', { class: 'rd-chat-row-title', text: `${session.starred ? '\u2605 ' : ''}${session.title || 'Untitled conversation'}` });
        const copy = el('span', { class: 'rd-conversation-copy' }, [title]);
        const detail = el('span', { class: 'rd-conversation-detail' });
        if (session.forge) detail.append(el('span', { class: 'rd-conversation-tag', text: 'Forge' }));
        if (session.last_message_preview) detail.append(el('span', { text: session.last_message_preview }));
        if (detail.childNodes.length) copy.append(detail);
        const stamp = Number.isFinite(Number(session.updated_at)) ? Number(session.updated_at) : 0;
        const age = el('time', { class: 'rd-chat-row-age', text: run?.status === 'processing' ? 'now' : stamp ? new Date(stamp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '' });
        const actions = el('span', { class: 'rd-conversation-actions', role: 'button', tabindex: '0', text: '\u22ef', 'aria-label': `Actions for ${session.title || 'conversation'}` });
        const openActions = event => { event.preventDefault(); event.stopPropagation(); const rect = actions.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left, clientY: rect.bottom })); };
        actions.addEventListener('click', openActions);
        actions.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') openActions(event); });
        row.replaceChildren(state, copy, age, actions); list.append(row);
      }
    }
    segments.replaceChildren(...conversationCounts(sessions, list.chatFilters || [{ id: null, label: 'All' }]).map(filter => el('button', {
      type: 'button', text: `${filter.label} \u00b7 ${filter.count}`, 'aria-pressed': String(filter.id === (list.chatProject ?? null)), onclick: () => filter.select?.(),
    })));
    footer.textContent = `${sessions.length} conversation${sessions.length === 1 ? '' : 's'}`;
    if (!firstOpen && !container.classList.contains('chat-history-collapsed') && rows.length) { list.classList.add('rd-stagger'); firstOpen = true; }
    else list.classList.remove('rd-stagger');
  }
  const find = event => {
    if (enabled() && !panel.inert && !event.shiftKey && !event.altKey && !document.querySelector('.modal-backdrop:not(.hidden)') && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); search.focus(); }
  };
  search.addEventListener('input', draw);
  list.addEventListener('kairos:conversations', draw);
  document.addEventListener('keydown', find, true);
  document.addEventListener('kairos:appearance', draw);
  desktop.addEventListener('change', draw);
  const state = new MutationObserver(draw); state.observe(container, { attributes: true, attributeFilter: ['class'] });
  let liveKey = '';
  const detach = chatStream.subscribeAll(() => {
    const key = chatStream.listInFlight().map(run => `${run.sessionId}:${run.status}`).sort().join('|');
    if (key !== liveKey) { liveKey = key; draw(); }
  });
  draw();
  return () => {
    closeConversationMenu();
    state.disconnect(); detach(); restore();
    if (applied) panel.insertBefore(newChat, newNext?.parentNode === panel ? newNext : list);
    added.forEach(node => node.remove());
    list.removeEventListener('kairos:conversations', draw);
    document.removeEventListener('keydown', find, true);
    document.removeEventListener('kairos:appearance', draw);
    desktop.removeEventListener('change', draw);
  };
}
