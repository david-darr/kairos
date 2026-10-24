import { api, el, toast } from './api.js';
import * as chatStream from './chatStream.js';
import { button, go, haptic, longPress, edgeBlur } from './mobileShared.js';
import { emptyState } from './kairosParts.js';
import { workingChats, chatAge } from './redesignChatParts.js';

const saved = { query: '', working: false, model: '', scroll: 0 };
export function mountHistory(page) {
  let sessions, models = [], query = saved.query.toLowerCase(), working = saved.working, model = saved.model, disposed = false, timer, opened = null, restored = false;
  let pressCleanups = [];
  const list = el('div', { class: 'ms-history-list', role: 'region', 'aria-label': 'Chat history' });
  const recent = el('h2', { class: 'rd-chat-recent', text: 'Recent' });
  let activity = workingChats([], () => {}), firstRender = true;
  const search = el('input', { type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats' });
  search.value = saved.query;
  const filter = el('select', { 'aria-label': 'Filter chats' }, [el('option', { value: 'all', text: 'All' }), el('option', { value: 'working', text: 'Working' })]);
  const modelFilter = el('select', { 'aria-label': 'Filter by model' }, [el('option', { value: '', text: 'Any model' })]);
  filter.value = working ? 'working' : 'all';
  const filters = el('div', { class: 'ms-history-filters ms-glass rd-menu-in', hidden: true }, [filter, modelFilter]);
  const toggle = button('Filter', () => { filters.hidden = !filters.hidden; toggle.setAttribute('aria-expanded', String(!filters.hidden)); });
  toggle.setAttribute('aria-label', 'Filter chats'); toggle.setAttribute('aria-expanded', 'false');
  if (working) toggle.textContent = 'Working';
  const searchIcon = el('span', { class: 'rd-chat-search-icon', 'aria-hidden': 'true' });
  searchIcon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
  const dock = el('div', { class: 'ms-history-dock ms-glass', 'data-mobile-hook': 'history-dock' }, [edgeBlur('bottom'), searchIcon, search, toggle, filters]);
  const closeFilters = () => { filters.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  const outside = e => { if (!dock.contains(e.target)) closeFilters(); };
  document.addEventListener('click', outside);
  dock.addEventListener('keydown', e => { if (e.key === 'Escape' && !filters.hidden) { e.preventDefault(); closeFilters(); toggle.focus(); } });
  page.append(dock, activity, recent, list);
  const refresh = async () => {
    try { const value = await api('/api/sessions'); if (!disposed) { sessions = value; draw(true); } }
    catch { if (!disposed) toast('Could not refresh chats', 'error'); }
  };
  const closeRows = () => { opened?.classList.remove('ms-actions-open'); opened = null; };
  function draw(force = false) {
    if (disposed) return;
    if (!force && list.querySelector('.session-rename-input')) return;
    pressCleanups.forEach(cancel => cancel()); pressCleanups = [];
    closeRows();
    if (!Array.isArray(sessions)) {
      list.replaceChildren(el('p', { role: 'status', text: sessions === null ? 'Could not load chats.' : 'Loading chats...' }));
      if (sessions === null) list.append(button('Try again', refresh)); return;
    }
    const filtered = [...sessions].sort((a, b) => b.updated_at - a.updated_at).filter(s => {
      const live = chatStream.getInFlight(s.id)?.status === 'processing';
      return (!working || live) && (!model || s.model_endpoint_id === model) &&
        `${s.title || ''} ${s.model || ''} ${models.find(m => m.id === s.model_endpoint_id)?.name || ''}`.toLowerCase().includes(query);
    });
    const scroll = restored ? list.scrollTop : saved.scroll;
    const nextActivity = workingChats(sessions, id => {
      const session = sessions.find(item => item.id === id);
      go(session?.forge || session?.is_forge ? 'forgeShell' : 'chat', { sessionId: id });
    });
    activity.replaceWith(nextActivity); activity = nextActivity;
    list.replaceChildren();
    if (firstRender && filtered.length) { list.classList.add('rd-stagger'); firstRender = false; }
    else list.classList.remove('rd-stagger');
    if (!filtered.length) {
      const empty = emptyState({ mascotState: 'sleeping', title: sessions.length ? 'No matching chats' : 'No chats yet',
      text: sessions.length ? 'Try another search or filter.' : 'Start a conversation in New.',
      action: sessions.length ? { text: 'Clear search and filters', onClick: () => {
        search.value = ''; query = ''; working = false; model = ''; filter.value = 'all'; modelFilter.value = ''; toggle.textContent = 'Filter'; draw();
      } } : { text: 'New chat', onClick: () => go('chat', { mobilePage: 0 }) } });
      empty.setAttribute('role', 'status'); list.append(empty);
    }
    for (const session of filtered) {
      const row = el('div', { class: 'ms-history-row', 'data-session-id': session.id });
      const showActions = () => { closeRows(); row.classList.add('ms-actions-open'); opened = row; haptic(); };
      const actions = el('div', { class: 'ms-row-actions' });
      const rename = button('Rename', async () => {
        const chat = await import('./views/chat.js');
        if (!row.isConnected) return;
        chat.startRename(main, session, null, null, refresh);
      });
      const remove = button('Delete', async () => {
        const chat = await import('./views/chat.js');
        if (await chat.deleteSession(session)) refresh();
      });
      actions.append(rename, remove);
      const main = button('', () => {
        if (opened === row) { closeRows(); return; }
        go(session.forge || session.is_forge ? 'forgeShell' : 'chat', { sessionId: session.id });
      }, 'ms-history-main');
      const age = chatAge(session.updated_at);
      main.append(el('span', { class: 'rd-chat-initial', text: Array.from((session.title || 'K').trim())[0] || 'K', 'aria-hidden': 'true' }),
        el('strong', { text: session.title || 'Untitled conversation' }),
        el('span', { class: 'ms-history-age', text: chatStream.getInFlight(session.id)?.status === 'processing' ? 'Working' : age }),
        el('small', { text: [session.starred ? 'Starred' : '', session.forge || session.is_forge ? 'Forge' : '', session.model || models.find(m => m.id === session.model_endpoint_id)?.name || 'Default model'].filter(Boolean).join(' · ') }));
      pressCleanups.push(longPress(main, showActions));
      main.addEventListener('keydown', e => { if (e.key === 'F10' && e.shiftKey) { e.preventDefault(); showActions(); rename.focus(); } });
      // Actions remain keyboard reachable without requiring a gesture.
      const more = button('...', showActions, 'ms-row-more'); more.setAttribute('aria-label', `Actions for ${session.title || 'chat'}`);
      let touch;
      row.addEventListener('touchstart', e => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
      row.addEventListener('touchmove', e => {
        if (!touch) return;
        const dx = e.touches[0].clientX - touch.x, dy = e.touches[0].clientY - touch.y;
        if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { touch = null; return; }
        if (dx < -10 && Math.abs(dx) > Math.abs(dy) * 1.15) { if (e.cancelable) e.preventDefault(); e.stopPropagation(); }
      }, { passive: false });
      row.addEventListener('touchend', e => { if (touch && e.changedTouches[0].clientX - touch.x < -40 && Math.abs(e.changedTouches[0].clientY - touch.y) < 40) { e.preventDefault(); showActions(); } touch = null; });
      row.append(actions, main, more); list.append(row);
    }
    list.scrollTop = scroll; restored = true;
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim().toLowerCase(); draw(); }, 250); });
  filter.addEventListener('change', () => { working = filter.value === 'working'; toggle.textContent = working ? 'Working' : 'Filter'; draw(); });
  modelFilter.addEventListener('change', () => { model = modelFilter.value; draw(); });
  list.addEventListener('scroll', closeRows, { passive: true });
  const detach = chatStream.subscribeAll((id, entry) => { if (!entry || entry.status !== 'processing' || !list.querySelector(`[data-session-id="${CSS.escape(id)}"] .ms-history-age`)?.textContent.includes('Working')) draw(); });
  draw();
  return { closeRows, update(key, value) {
    if (key === 'sessions') sessions = value;
    if (key === 'endpoints' && Array.isArray(value)) {
      models = value;
      modelFilter.replaceChildren(el('option', { value: '', text: 'Any model' }), ...models.map(m => el('option', { value: m.id, text: m.name })));
      modelFilter.value = model;
    }
    if (['sessions', 'endpoints'].includes(key)) draw();
  }, dispose() {
    Object.assign(saved, { query: search.value, working, model, scroll: list.scrollTop });
    pressCleanups.forEach(cancel => cancel());
    disposed = true; detach(); clearTimeout(timer); document.removeEventListener('click', outside);
  } };
}
