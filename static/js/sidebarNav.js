// The desktop sidebar (desktop redesign, 2026-10-28; canvas boards Main and
// Rail). Expanded: Home, New chat and Chat history, the pinned strip
// with Edit, then the running and today's chats. The footer gains All tabs,
// which lists every shown tab by its Settings > Layout group. Collapsed, the
// same items are a 56 px icon rail (redesign-sidebar.css). Phones and Forge
// mode keep app.js's own nav. Every tab button stays a `.nav-item[data-tab]`,
// so app.js marks the open tab and the Agents badge the same way as before.
import { api, el } from './api.js';
import { ICONS } from './icons.js';
import * as chatStream from './chatStream.js';

let cleanup = () => {};

function tabButton(item, onClick, extra = '') {
  const button = el('button', { type: 'button', class: `nav-item ${extra}`.trim(), 'data-tab': item.id, 'aria-label': item.label });
  button.innerHTML = `${item.svg}<span></span>`;
  button.querySelector('span').textContent = item.label;
  button.addEventListener('click', onClick);
  return button;
}

function actionButton(icon, label, cls, onClick) {
  const button = el('button', { type: 'button', class: `nav-item rd-nav-action ${cls}`, 'aria-label': label });
  button.innerHTML = `${icon}<span></span>`;
  button.querySelector('span').textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// A chat that belongs to Forge (the list's is_forge, or a session's forge record) carries a Forge
// mark wherever chats are listed, and opens in Forge (David, 2026-10-28).
export const isForgeChat = session => !!(session?.is_forge || session?.forge);
export const FORGE_MARK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h11l-2 4H6z"/><path d="M15 9h3a2 2 0 0 1 0 4h-1"/><path d="M9 13v5M7 18h6"/></svg>';
export function forgeTag() {
  const tag = el('span', { class: 'rd-forge-tag', title: 'A Forge chat' }, [el('span', { text: 'Forge' })]);
  tag.insertAdjacentHTML('afterbegin', FORGE_MARK);
  return tag;
}

const sameDay = (seconds, now = new Date()) => {
  const date = new Date(seconds * 1000);
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
};

/**
 * Build the desktop sidebar into #nav and the footer.
 * @param {object} o
 * @param {HTMLElement} o.nav            #nav
 * @param {Map} o.items                  every known tab: id -> {id, label, svg}
 * @param {Array} o.groups               layout.js sidebarLayout() groups (hidden tabs left out)
 * @param {string[]} o.pinned            pinned tab ids, in order
 * @param {(id: string, options?: object) => void} o.switchTab
 * @param {() => void} o.openSearch
 * @param {() => void} o.openHistory
 * @param {() => void} o.editPins
 */
export function renderDesktopNav({ nav, items, groups, pinned, switchTab, openSearch, openHistory, editPins }) {
  // A rebuild (layout change, resize across the desktop width) keeps keyboard focus on the same tab.
  const focusedTab = document.activeElement?.closest?.('#sidebar .nav-item[data-tab]')?.dataset.tab;
  cleanup();
  const sidebar = document.getElementById('sidebar');
  const go = id => () => switchTab(id);
  const newChat = () => {
    // On Chats already, start fresh the way its own New chat does.
    const own = document.querySelector('#chat-sessions .chat-new-btn');
    if (own && document.documentElement.dataset.view === 'chat') own.click(); else switchTab('chat');
  };
  const home = items.get('home');
  const primary = el('div', { id: 'rd-primary', class: 'rd-primary', role: 'group', 'aria-label': 'Main actions' }, [
    tabButton(home, go('home')),
    actionButton(ICONS.plus, 'New chat', 'rd-new-chat', newChat),
    actionButton(ICONS.chats, 'Chat history', 'rd-history-trigger', openHistory),
  ]);
  document.getElementById('rd-primary')?.remove();
  // Search sits at the bottom of the sidebar, just above the line over All tabs (David, 2026-10-28).
  const search = actionButton(ICONS.search, 'Search', 'rd-search', openSearch);
  search.id = 'rd-search';
  // The collapse button sits beside Search (David, 2026-10-28); it goes back to the header when
  // this sidebar is cleared (phones, Forge).
  const toggle = document.getElementById('sidebar-toggle');
  const searchRow = el('div', { id: 'rd-search-row', class: 'rd-search-row' }, [search, toggle]);
  document.getElementById('rd-search-row')?.remove();
  document.getElementById('sidebar-footer').before(searchRow);
  // Before the Updates row (redesignShell.js), which sits just above #nav.
  (document.getElementById('rd-jump') || nav).before(primary);

  const edit = el('button', { type: 'button', class: 'rd-pins-edit', text: 'Edit', 'aria-label': 'Edit pinned tabs', onclick: editPins });
  const grid = el('div', { class: 'rd-pin-grid', role: 'group', 'aria-label': 'Pinned tabs' },
    pinned.map(id => tabButton(items.get(id), go(id), 'rd-pin')));
  const pins = el('section', { class: 'rd-pins' }, [
    el('div', { class: 'rd-nav-section-head' }, [el('span', { class: 'nav-group-label', text: 'Pinned' }), edit]), grid]);

  const activeList = el('div', { class: 'rd-chat-list', role: 'list' });
  const todayList = el('div', { class: 'rd-chat-list', role: 'list' });
  const activeSection = el('section', { class: 'rd-chats rd-chats-active', hidden: true }, [el('span', { class: 'nav-group-label', text: 'Active' }), activeList]);
  const todaySection = el('section', { class: 'rd-chats rd-chats-today', hidden: true }, [el('span', { class: 'nav-group-label', text: 'Today' }), todayList]);
  nav.replaceChildren(pins, activeSection, todaySection);
  if (focusedTab && (!document.activeElement || document.activeElement === document.body)) {
    document.querySelector(`#sidebar .nav-item[data-tab="${CSS.escape(focusedTab)}"]`)?.focus({ preventScroll: true });
  }

  let sessions = [], disposed = false, timer = null;
  const row = (session, running) => {
    const forge = isForgeChat(session);
    const button = el('button', { type: 'button', class: `rd-chat-row${forge ? ' is-forge' : ''}`, role: 'listitem', 'data-session-id': session.id, title: session.title,
      'aria-label': `${session.title}${forge ? ', Forge' : ''}${running ? ', working' : ''}`,
      onclick: () => switchTab(forge ? 'forgeSession' : 'chat', { sessionId: session.id }) }, [
      el('span', { class: `rd-chat-dot${running ? ' is-running' : ''}`, 'aria-hidden': 'true' }),
      el('span', { class: 'rd-chat-row-name', text: session.title || 'New chat' })]);
    if (forge) button.append(forgeTag());
    return button;
  };
  const paint = () => {
    if (disposed) return;
    const running = new Map(chatStream.listInFlight().filter(entry => entry.status === 'processing').map(entry => [entry.sessionId, entry]));
    const active = [...running.values()].map(entry => sessions.find(s => s.id === entry.sessionId) || { id: entry.sessionId, title: entry.sessionTitle || 'Chat' });
    const today = sessions.filter(s => !running.has(s.id) && sameDay(s.updated_at)).slice(0, 6);
    activeList.replaceChildren(...active.slice(0, 6).map(s => row(s, true)));
    todayList.replaceChildren(...today.map(s => row(s, false)));
    activeSection.hidden = !active.length; todaySection.hidden = !today.length;
  };
  const load = async () => {
    const list = await api('/api/sessions').catch(() => null);
    if (disposed || !Array.isArray(list)) return;
    sessions = list.slice().sort((a, b) => b.updated_at - a.updated_at);
    paint();
  };
  // A turn starting or ending repaints at once; the list itself reloads when one ends.
  let wasRunning = new Set();
  const unsubscribe = chatStream.subscribeAll(() => {
    const now = new Set(chatStream.listInFlight().filter(e => e.status === 'processing').map(e => e.sessionId));
    const ended = [...wasRunning].some(id => !now.has(id));
    wasRunning = now; paint();
    if (ended) { clearTimeout(timer); timer = setTimeout(load, 400); }
  });
  const onChats = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  document.addEventListener('kairos:chat-session', onChats);
  load();

  // All tabs: every shown tab, by group, in a popover above the footer.
  const allPanel = el('div', { id: 'rd-all-tabs', class: 'rd-all-tabs', role: 'dialog', 'aria-label': 'All tabs', hidden: true });
  for (const group of groups) {
    if (!group.ids.length) continue;
    allPanel.append(el('span', { class: 'nav-group-label', text: group.label || 'Kairos' }),
      el('div', { class: 'rd-all-tabs-grid' }, group.ids.map(id => tabButton(items.get(id), () => { closeAll(); switchTab(id); }))));
  }
  const allButton = el('button', { type: 'button', id: 'rd-all-tabs-btn', class: 'nav-item rd-nav-action rd-all-tabs-btn',
    'aria-label': 'All tabs', 'aria-expanded': 'false', 'aria-controls': 'rd-all-tabs' });
  allButton.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></svg><span>All tabs</span>`;
  const place = () => {
    const box = allButton.getBoundingClientRect(), side = sidebar.getBoundingClientRect();
    allPanel.style.left = `${side.right + 8}px`;
    allPanel.style.bottom = `${Math.max(8, innerHeight - box.bottom)}px`;
  };
  const openAll = () => { allPanel.hidden = false; allButton.setAttribute('aria-expanded', 'true'); place(); allPanel.querySelector('.nav-item')?.focus(); };
  function closeAll(restore = false) {
    if (allPanel.hidden) return;
    allPanel.hidden = true; allButton.setAttribute('aria-expanded', 'false');
    if (restore) allButton.focus();
  }
  allButton.addEventListener('click', event => { event.stopPropagation(); allPanel.hidden ? openAll() : closeAll(); });
  const outside = event => { if (!allPanel.contains(event.target) && event.target !== allButton) closeAll(); };
  const onKey = event => { if (event.key === 'Escape' && !allPanel.hidden) { event.preventDefault(); closeAll(true); } };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', onKey);
  addEventListener('resize', place);
  document.getElementById('rd-all-tabs')?.remove();
  document.body.append(allPanel);

  cleanup = () => {
    disposed = true; clearTimeout(timer); unsubscribe();
    document.removeEventListener('kairos:chat-session', onChats);
    document.removeEventListener('click', outside); document.removeEventListener('keydown', onKey);
    removeEventListener('resize', place);
    document.querySelector('#sidebar .sidebar-header')?.append(toggle);
    primary.remove(); searchRow.remove(); allPanel.remove(); allButton.remove();
    cleanup = () => {};
  };
  return { allButton };
}

// Back to app.js's own nav (phones, Forge mode).
export function clearDesktopNav() { cleanup(); }
