// The chat history popout (desktop redesign, 2026-10-28; canvas board Rail).
// Opened from the sidebar's Chat history and from the chat header's history
// button, it replaces the in-chat Conversations panel on desktop (phones keep
// their drawer). Chats: search, filters All, Working, Needs you and Pinned,
// rows grouped Working now / Today / Yesterday / earlier, each with its
// model's logo. Projects: each project with its letter and chat count; one
// opens to its chats, with Files and instructions and New chat in it.
// Row actions reuse the chat list's own routes, confirmations and menu.
import { api, apiRecent, el, modelMark } from './api.js';
import { ICONS } from './icons.js';
import * as chatStream from './chatStream.js';
import { showConversationMenu, conversationGroups } from './redesignConversations.js';
import { canSplit, openSideChat, sideChatSessionId, SESSION_MIME } from './sideChat.js';
import { isForgeChat, forgeTag } from './sidebarNav.js';

const KEEP_KEY = 'kairos:history-keep-open';
let current = null;

export function isChatHistoryOpen() { return !!current; }
export function closeChatHistory(restore = false) { current?.close(restore); }

function age(seconds) {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - Number(seconds || 0)) / 60));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** @param {{switchTab: Function, opener?: HTMLElement}} options */
export async function openChatHistory({ switchTab, opener = document.activeElement } = {}) {
  if (current) { current.close(true); return; }
  let keepOpen = false;
  try { keepOpen = localStorage.getItem(KEEP_KEY) === 'true'; } catch { /* optional */ }
  let mode = 'chats', filter = 'all', project = null, query = '', sessions = [], projects = [], endpoints = [], disposed = false;

  const title = el('h2', { class: 'rd-history-title', id: 'rd-history-title', text: 'Chats' });
  const keep = el('button', { type: 'button', class: 'rd-history-keep', 'aria-pressed': String(keepOpen), text: 'Keep open',
    title: 'Keep this open while you open chats' });
  keep.addEventListener('click', () => {
    keepOpen = !keepOpen; keep.setAttribute('aria-pressed', String(keepOpen));
    try { localStorage.setItem(KEEP_KEY, String(keepOpen)); } catch { /* optional */ }
  });
  const newChat = el('button', { type: 'button', class: 'rd-history-icon rd-history-new', 'aria-label': 'New chat', title: 'New chat' });
  newChat.innerHTML = ICONS.plus;
  newChat.addEventListener('click', () => { const id = project?.id || null; done(); switchTab('chat', id ? { projectId: id } : {}); });
  const closeBtn = el('button', { type: 'button', class: 'rd-history-icon', 'aria-label': 'Close chat history', title: 'Close' });
  closeBtn.innerHTML = ICONS.close;
  closeBtn.addEventListener('click', () => close(true));

  const tabs = el('div', { class: 'rd-history-switch', role: 'tablist', 'aria-label': 'Show' });
  const tab = (id, label) => {
    const button = el('button', { type: 'button', role: 'tab', class: 'rd-history-tab', 'data-mode': id, text: label, 'aria-selected': String(mode === id) });
    button.addEventListener('click', () => { mode = id; project = null; paint(); });
    return button;
  };
  tabs.append(tab('chats', 'Chats'), tab('projects', 'Projects'));
  const search = el('input', { type: 'search', class: 'rd-history-search', placeholder: 'Search chats', 'aria-label': 'Search chats' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); paint(); });
  const filters = el('div', { class: 'rd-history-filters', role: 'group', 'aria-label': 'Filter chats' });
  for (const [id, label] of [['all', 'All'], ['working', 'Working'], ['needs', 'Needs you'], ['pinned', 'Pinned']]) {
    const button = el('button', { type: 'button', 'data-filter': id, 'aria-pressed': String(filter === id) }, [el('span', { text: label }), el('small', { class: 'rd-history-count' })]);
    button.addEventListener('click', () => { filter = id; paint(); });
    filters.append(button);
  }
  const body = el('div', { class: 'rd-history-body' });
  const panel = el('aside', { id: 'rd-history', class: 'rd-history rd-menu-in', role: 'dialog', 'aria-labelledby': 'rd-history-title' }, [
    el('header', { class: 'rd-history-head' }, [title, keep, newChat, closeBtn]), tabs, search, filters, body]);
  document.body.append(panel);
  const place = () => {
    const side = document.getElementById('sidebar')?.getBoundingClientRect();
    panel.style.left = `${side ? side.right : 0}px`;
  };
  place();

  const running = () => new Map(chatStream.listInFlight().filter(e => e.status === 'processing').map(e => [e.sessionId, e]));
  const endpointFor = session => endpoints.find(e => e.id === session.model_endpoint_id);
  const state = (session, live) => live?.permission ? 'needs' : live ? 'working' : 'idle';

  function row(session, live) {
    const endpoint = endpointFor(session);
    const status = state(session, live);
    const forge = isForgeChat(session);
    const detail = [endpoint?.name, status === 'needs' ? 'Needs you' : status === 'working' ? 'Working' : null].filter(Boolean).join(' · ');
    const item = el('div', { class: `rd-history-row${forge ? ' is-forge' : ''}`, role: 'listitem' });
    // Drag a row onto the right half of a chat to open it side by side, as from the old chat list.
    const open = el('button', { type: 'button', class: 'rd-history-open', 'data-session-id': session.id, title: session.title, draggable: String(!forge),
      ondragstart: event => { event.dataTransfer.setData(SESSION_MIME, session.id); event.dataTransfer.effectAllowed = 'copy'; },
      onclick: () => { done(); switchTab(forge ? 'forgeSession' : 'chat', { sessionId: session.id }); } }, [
      el('span', { class: `rd-history-dot is-${status}`, 'aria-hidden': 'true' }),
      modelMark(endpoint?.mark, endpoint?.name) || el('span', { class: 'model-mark rd-history-nomark', 'aria-hidden': 'true' }),
      el('span', { class: 'rd-history-copy' }, [
        el('span', { class: 'rd-history-name-line' }, [el('span', { class: 'rd-history-name', text: `${session.starred ? '★ ' : ''}${session.title || 'New chat'}` }), forge ? forgeTag() : null]),
        el('span', { class: 'rd-history-detail', text: detail })]),
      el('span', { class: 'rd-history-age', text: age(session.updated_at) })]);
    const more = el('button', { type: 'button', class: 'rd-history-more', 'aria-label': `Actions for ${session.title}`, text: '⋯' });
    const menu = (x, y) => showConversationMenu({ row: open, session, x, y, open: () => open.click(), actions: actionsFor(session, open) });
    more.addEventListener('click', event => { event.stopPropagation(); const r = more.getBoundingClientRect(); menu(r.left, r.bottom); });
    open.addEventListener('contextmenu', event => { event.preventDefault(); menu(event.clientX, event.clientY); });
    item.append(open, more);
    return item;
  }

  function actionsFor(session, open) {
    return [
      { label: 'Rename', icon: '✎', run: async () => {
        const chat = await import('./views/chat.js');
        chat.startRename(open, session, null, null, reload);
      } },
      { label: session.starred ? 'Unstar' : 'Star', icon: '☆', run: async () => {
        await api(`/api/sessions/${session.id}/star`, { method: 'POST', body: JSON.stringify({ starred: !session.starred }) });
        reload();
      } },
      { label: 'Move to Project', icon: '□', run: () => showConversationMenu({ row: open, session,
        actions: [{ id: null, name: 'No Project' }, ...projects].map(p => ({ label: p.name, icon: session.project_id === p.id ? '✓' : '□', run: async () => {
          await api(`/api/sessions/${session.id}/project`, { method: 'POST', body: JSON.stringify({ project_id: p.id }) });
          reload();
        } })) }) },
      ...(!isForgeChat(session) && canSplit() && document.documentElement.dataset.view === 'chat' && sideChatSessionId() !== session.id && document.querySelector('#chat-messages')?.dataset.sessionId !== session.id
        ? [{ label: 'Open side by side', icon: '◫', run: () => { done(); openSideChat(session.id); } }] : []),
      { label: 'Delete', icon: '×', danger: true, run: async () => {
        const chat = await import('./views/chat.js');
        if (await chat.deleteSession(session)) reload();
      } },
    ];
  }

  function chatList(list) {
    const live = running();
    const host = el('div', { class: 'rd-history-list', role: 'list' });
    for (const group of conversationGroups(list, chatStream.listInFlight())) {
      host.append(el('div', { class: 'rd-history-group', text: group.label === 'Working now' ? 'Working' : group.label }));
      for (const session of group.rows) host.append(row(session, live.get(session.id)));
    }
    if (!host.childElementCount) host.append(el('p', { class: 'rd-history-empty', text: query || filter !== 'all' ? 'No chats match.' : 'No chats yet.' }));
    return host;
  }

  function paint() {
    if (disposed) return;
    // Never swap rows out from under an open row menu or a rename; the next change repaints.
    if (document.querySelector('.rd-conversation-menu') || panel.querySelector('.session-rename-input')) return;
    for (const button of tabs.children) button.setAttribute('aria-selected', String(button.dataset.mode === mode));
    const live = running();
    const matches = s => !query || (s.title || '').toLowerCase().includes(query);
    const filterOf = {
      all: () => true, working: s => live.has(s.id) && !live.get(s.id).permission,
      needs: s => !!live.get(s.id)?.permission, pinned: s => !!s.starred,
    };
    for (const button of filters.children) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
      button.querySelector('small').textContent = String(sessions.filter(filterOf[button.dataset.filter]).length);
    }
    filters.hidden = mode !== 'chats';
    search.placeholder = mode === 'chats' ? 'Search chats' : project ? `Search ${project.name}` : 'Search projects';
    title.textContent = project ? project.name : mode === 'chats' ? 'Chats' : 'Projects';
    if (mode === 'chats') { body.replaceChildren(chatList(sessions.filter(s => matches(s) && filterOf[filter](s)))); return; }
    if (project) {
      const back = el('button', { type: 'button', class: 'rd-history-back', text: '← All projects', onclick: () => { project = null; paint(); } });
      const files = el('button', { type: 'button', class: 'btn quiet rd-history-files', text: 'Files and instructions', onclick: async () => {
        const id = project.id; done();
        await switchTab('chat', { projectId: id });
        (await import('./views/chat.js')).openProjectSettings(id);
      } });
      body.replaceChildren(el('div', { class: 'rd-history-project-head' }, [back, files]),
        chatList(sessions.filter(s => s.project_id === project.id && matches(s))));
      return;
    }
    const list = el('div', { class: 'rd-history-list', role: 'list' });
    for (const p of projects.filter(p => !query || p.name.toLowerCase().includes(query))) {
      const count = sessions.filter(s => s.project_id === p.id).length;
      list.append(el('button', { type: 'button', class: 'rd-history-project', role: 'listitem', 'data-project-id': p.id, onclick: () => { project = p; search.value = ''; query = ''; paint(); } }, [
        el('span', { class: 'rd-history-letter', 'aria-hidden': 'true', text: (p.name || '?').slice(0, 1).toUpperCase() }),
        el('span', { class: 'rd-history-copy' }, [el('span', { class: 'rd-history-name', text: p.name }),
          el('span', { class: 'rd-history-detail', text: `${count} chat${count === 1 ? '' : 's'}` })])]));
    }
    if (!list.childElementCount) list.append(el('p', { class: 'rd-history-empty', text: query ? 'No projects match.' : 'No projects yet.' }));
    const add = el('button', { type: 'button', class: 'btn quiet rd-history-new-project', text: '+ New project', onclick: async () => {
      done(); await switchTab('chat'); (await import('./views/chat.js')).openProjectSettings(null);
    } });
    body.replaceChildren(list, add);
  }

  async function reload() {
    const [list, projectList, models] = await Promise.all([
      api('/api/sessions').catch(() => sessions), apiRecent('/api/projects').catch(() => projects), apiRecent('/api/models/choices').catch(() => endpoints)]);
    if (disposed) return;
    sessions = list || []; projects = projectList || []; endpoints = models || [];
    if (project) project = projects.find(p => p.id === project.id) || null;
    paint();
  }

  // Opening a chat closes the popout unless Keep open is on.
  function done() { if (!keepOpen) close(false); }
  // Repaint for a stream only when which chats are working or waiting changes, and never while a
  // row is being renamed (a repaint would drop the rename field and its text).
  let liveKey = '';
  const unsubscribe = chatStream.subscribeAll(() => {
    const key = [...running()].map(([id, entry]) => `${id}:${entry.permission ? 1 : 0}`).sort().join();
    if (key === liveKey || panel.querySelector('.session-rename-input')) return;
    liveKey = key; paint();
  });
  const outside = event => {
    // The buttons that open the popout toggle it with their own click.
    if (panel.contains(event.target) || event.target.closest?.('#chat-history-toggle, .rd-history-trigger, .rd-conversation-menu, .session-rename-input, dialog')) return;
    if (!keepOpen) close(false);
  };
  const onKey = event => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.rd-conversation-menu')) { event.preventDefault(); close(true); } };
  const onSession = () => reload();
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  document.addEventListener('keydown', onKey);
  document.addEventListener('kairos:chat-session', onSession);
  addEventListener('resize', place);
  // Phones keep their own history drawer: the popout closes at phone width.
  const desktop = matchMedia('(min-width: 769px)');
  const onWidth = () => { if (!desktop.matches) close(false); };
  desktop.addEventListener('change', onWidth);
  // The popout docks beside the sidebar and the page moves over for it (redesign-sidebar.css).
  document.documentElement.classList.add('rd-history-docked');
  document.dispatchEvent(new CustomEvent('kairos:chat-history', { detail: { open: true } }));

  function close(restore) {
    if (disposed) return;
    disposed = true; current = null; unsubscribe(); panel.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('kairos:chat-session', onSession);
    removeEventListener('resize', place);
    desktop.removeEventListener('change', onWidth);
    document.documentElement.classList.remove('rd-history-docked');
    document.dispatchEvent(new CustomEvent('kairos:chat-history', { detail: { open: false } }));
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  current = { close };
  paint();
  search.focus({ preventScroll: true });
  await reload();
}
