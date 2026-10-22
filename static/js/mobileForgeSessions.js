import { el, toast } from './api.js';
import { button, go, longPress, edgeBlur } from './mobileShared.js';
import { sessionStatus } from './forgeUi.js';

// Presentation of the existing project catalog. Rename and delete retain the
// shared conversation actions, including their confirmation and error flow.
export function mountForgeSessions(page) {
  let sessions = [], models = [], query = '', working = false, model = '', opened, timer, signature;
  let presses = [];
  const list = el('div', { class: 'ms-history-list', 'aria-label': 'Forge sessions' });
  const search = el('input', { type: 'search', placeholder: 'Search sessions', 'aria-label': 'Search sessions' });
  const state = el('select', { 'aria-label': 'Filter sessions' }, [el('option', { value: '', text: 'All sessions' }), el('option', { value: 'working', text: 'Working now' })]);
  const provider = el('select', { 'aria-label': 'Filter by model' });
  const filters = el('div', { class: 'ms-history-filters ms-glass', hidden: true }, [state, provider]);
  const toggle = button('Filter', () => { filters.hidden = !filters.hidden; toggle.setAttribute('aria-expanded', String(!filters.hidden)); });
  toggle.setAttribute('aria-expanded', 'false');
  const dock = el('div', { class: 'ms-history-dock ms-glass' }, [edgeBlur('bottom'), search, toggle, filters]);
  page.append(list, dock);
  const close = () => { opened?.classList.remove('ms-actions-open'); opened = null; };
  const outside = event => { if (!dock.contains(event.target)) { filters.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } };
  document.addEventListener('click', outside);
  async function action(kind, main, session) {
    try {
      const chat = await import('./views/chat.js');
      if (!page.isConnected) return;
      if (kind === 'rename') chat.startRename(main, session, null, null, () => { list.querySelector('.session-rename-input')?.remove(); signature = null; const task = refresh(); draw(); return task; });
      else if (await chat.deleteSession(session)) await refresh();
    } catch (error) { toast(error.message, 'error'); }
  }
  let refresh = () => {};
  function draw() {
    if (list.querySelector('.session-rename-input')) return;
    const next = JSON.stringify([query, working, model, sessions.map(s => [s.id, s.title, s.updated_at, s.forge, s.model_endpoint_id, s.model_override, sessionStatus(s).key]), models]);
    if (next === signature) return; signature = next;
    presses.forEach(dispose => dispose()); presses = []; close();
    const rows = sessions.filter(s => (!working || ['working', 'approval'].includes(sessionStatus(s).key)) && (!model || s.model_endpoint_id === model) &&
      [s.title, s.forge.branch, s.model_override, models.find(m => m.id === s.model_endpoint_id)?.name].join(' ').toLowerCase().includes(query))
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
    list.replaceChildren();
    for (const session of rows) {
      const row = el('div', { class: 'ms-history-row', 'data-session-id': session.id });
      const reveal = () => { close(); row.classList.add('ms-actions-open'); opened = row; };
      const main = button('', () => { if (opened === row) close(); else go('forgeShell', { sessionId: session.id, closeSheet: true }); }, 'ms-history-main');
      const minutes = Math.max(0, Math.floor((Date.now() / 1000 - session.updated_at) / 60));
      const status = sessionStatus(session);
      const age = minutes < 1 ? 'Now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
      main.append(el('strong', { text: session.title }), el('span', { class: 'ms-history-age', text: status.key === 'approval' ? 'Needs approval' : status.key === 'working' ? 'Working' : age }),
        el('small', { class: 'mf-session-meta' }, [el('span', { text: session.forge.removed ? 'Worktree removed' : session.forge.branch || 'In place' }), el('span', { text: session.model_override || models.find(m => m.id === session.model_endpoint_id)?.name || 'Default model' })]));
      const actions = el('div', { class: 'ms-row-actions' }, [button('Rename', () => action('rename', main, session)), button('Delete', () => action('delete', main, session))]);
      const more = button('...', reveal, 'ms-row-more'); more.setAttribute('aria-label', `Actions for ${session.title}`);
      presses.push(longPress(main, reveal));
      let touch;
      row.addEventListener('touchstart', e => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
      row.addEventListener('touchmove', e => {
        if (!touch) return;
        const dx = e.touches[0].clientX - touch.x, dy = e.touches[0].clientY - touch.y;
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { touch = null; return; }
        if (dx < -10) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }
      }, { passive: false });
      row.addEventListener('touchend', e => { if (touch && e.changedTouches[0].clientX - touch.x < -40) { e.preventDefault(); reveal(); } touch = null; });
      row.addEventListener('touchcancel', () => { touch = null; });
      row.append(actions, main, more); list.append(row);
    }
    if (!rows.length) list.append(el('p', { role: 'status', text: sessions.length ? 'No matching sessions.' : 'No sessions yet.' }));
  }
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim().toLowerCase(); draw(); }, 250); };
  state.onchange = () => { working = !!state.value; draw(); };
  provider.onchange = () => { model = provider.value; draw(); };
  list.addEventListener('scroll', close, { passive: true });
  dock.addEventListener('keydown', event => { if (event.key === 'Escape' && !filters.hidden) { event.preventDefault(); filters.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } });
  return { update(next, endpoints, reload) { sessions = next; models = endpoints; refresh = reload;
    provider.replaceChildren(el('option', { value: '', text: 'Any model' }), ...models.map(m => el('option', { value: m.id, text: m.name }))); provider.value = model; draw();
  }, dispose() { clearTimeout(timer); presses.forEach(dispose => dispose()); document.removeEventListener('click', outside); } };
}
