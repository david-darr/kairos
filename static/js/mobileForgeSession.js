import { api, el, toast } from './api.js';
import { mobileOn, phone, button, go, edgeBlur } from './mobileShared.js';
import { openMobileSheet } from './mobileSheet.js';

// The shell remains the surface owner. Phone navigation selects those same
// surfaces and presents sidebar tools with the shared modal/focus lifecycle.
export function mountMobileForgeSession(shell, bridge) {
  let sheet, surfaceKey, header, statusHome, countSession, countVersion = 0, disposed = false;
  const counts = new Map();
  const get = () => bridge.state();
  const backToSession = () => {
    const state = get(), tab = state.tabs.find(t => t.type === 'session' && t.sessionId === state.session?.id);
    if (tab) bridge.activate(tab.id); else go('forgeHome', { projectId: state.project?.id, mobilePage: 1 });
  };
  const back = () => { if (get().surface?.type !== 'session') backToSession(); else go('forgeHome', { projectId: get().project?.id, mobilePage: 1 }); };
  function tool(key) {
    sheet?.close();
    bridge.select(key);
    const panel = bridge.panel(key), anchor = document.createComment('Forge panel home'); panel.before(anchor);
    panel.hidden = false;
    const body = el('div', { class: `mf-tool mf-tool-${key}` }, [panel]);
    sheet = openMobileSheet({ title: { git: 'Changes', changes: 'Session baseline changes', explorer: 'Explorer' }[key], content: body, fullHeight: true,
      onClose: () => { anchor.after(panel); anchor.remove(); sheet = null; } });
  }
  function menu(opener) {
    const state = get(), body = el('div', { class: 'mf-session-actions' });
    const sessionPanel = bridge.sessionPanel();
    const controls = [...(sessionPanel?.querySelectorAll('.forge-session-header > button') || [])];
    const anchors = controls.map(node => { const a = document.createComment('Session action home'); node.before(a); body.append(node); return a; });
    const originalActions = controls.map(node => {
      const closeFirst = () => sheet?.close(); node.addEventListener('click', closeFirst, { capture: true }); return () => node.removeEventListener('click', closeFirst, { capture: true });
    });
    for (const [label, action] of [['Explorer', () => tool('explorer')], ['Editor', () => tool('explorer')], ['Changes', () => tool('git')], ['Session baseline changes', () => tool('changes')]]) body.append(button(label, () => { sheet?.close(); action(); }));
    body.append(button('Rename', async () => {
      sheet?.close();
      const field = el('div'), name = button(state.session?.title || 'Session', () => {}); field.append(name);
      sheet = openMobileSheet({ title: 'Rename session', content: field, opener });
      try { const chat = await import('./views/chat.js'); chat.startRename(name, state.session, null, null, () => { sheet?.close(); bridge.reload(); }); } catch (error) { toast(error.message, 'error'); }
    }));
    body.append(button('New session', () => { sheet?.close(); go('forgeHome', { projectId: state.project?.id, mobilePage: 0, compose: true }); }));
    body.append(button('Your workspace', () => { sheet?.close(); go('forgeHome', { projectId: state.project?.id, mobileWorkspace: true }); }));
    const surfaces = el('details', {}, [el('summary', { text: 'Open sessions and tools' })]);
    for (const tab of state.tabs) {
      const row = el('div', { class: 'mf-project-row' }, [button(`${tab.title}${tab.dirty ? ' *' : ''}`, () => { sheet?.close(); bridge.activate(tab.id); }), button('Close', async () => { sheet?.close(); await bridge.close(tab.id); })]);
      if (tab.preview) row.append(button('Keep open', () => { sheet?.close(); bridge.pin(tab.id); }));
      surfaces.append(row);
    }
    body.append(surfaces);
    const identity = sessionPanel?.querySelector('.forge-session-header .meta'); if (identity) body.append(el('p', { text: identity.textContent }));
    const notes = sessionPanel?.querySelector('.forge-plan-note'); if (notes) body.append(el('p', { text: notes.textContent }));
    sheet = openMobileSheet({ title: 'Session actions', content: body, opener, onClose: () => { originalActions.forEach(dispose => dispose()); controls.forEach((node, i) => { anchors[i].after(node); anchors[i].remove(); }); sheet = null; } });
  }
  async function loadCount() {
    const id = get().session?.id; if (!id || get().session.forge.removed || !mobileOn()) return;
    const version = ++countVersion;
    try { const state = await api(`/api/forge/sessions/${encodeURIComponent(id)}/git`); if (!disposed && version === countVersion) { counts.set(id, state.files.length); update(); } } catch { /* Existing Git panel owns detailed loading errors. */ }
  }
  function update() {
    if (!header) return;
    const state = get(), surface = state.surface, session = state.session;
    header.querySelector('strong').textContent = surface?.type === 'session' ? session?.title || 'Session' : surface?.title || 'Forge';
    header.querySelector('small').textContent = [state.project?.name, session?.forge.branch || 'In place'].filter(Boolean).join(' · ');
    header.querySelector('.mf-changes').replaceChildren('Changes ', el('span', { class: 'mf-count', text: String(counts.get(session?.id) ?? state.count ?? 0) }));
    header.querySelector('.mf-changes').disabled = !session || !!session.forge.removed;
    if (session?.id !== countSession) { countSession = session?.id; loadCount(); }
    const key = surface?.id;
    if (surfaceKey !== key) { surfaceKey = key; sheet?.close(); if (mobileOn()) header.querySelector('button').focus({ preventScroll: true }); }
  }
  const gate = () => {
    shell.classList.toggle('mf-session', mobileOn());
    if (mobileOn() && !header) {
      header = el('header', { class: 'mf-session-header' });
      const changes = button('Changes', () => tool('git'), 'mf-changes ms-glass');
      const more = button('...', () => menu(more)); more.setAttribute('aria-label', 'Session actions');
      const backButton = button('Back', back); backButton.classList.add('mf-back');
      header.append(edgeBlur('top'), backButton, el('div', { class: 'mf-session-heading' }, [el('strong'), el('small')]), changes, more); shell.prepend(header); const status = bridge.status; statusHome = document.createComment('Forge status home'); status.before(statusHome); header.after(status); update();
    } else if (!mobileOn() && header) { sheet?.close(); statusHome?.after(bridge.status); statusHome?.remove(); header.remove(); header = null; }
  };
  let edge;
  const start = e => { if (mobileOn() && e.touches.length === 1 && e.touches[0].clientX < 24 && !document.querySelector('dialog[open]')) edge = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const end = e => { if (edge && e.changedTouches[0].clientX - edge.x > 70 && Math.abs(e.changedTouches[0].clientY - edge.y) < 60) back(); edge = null; };
  const cancel = () => { edge = null; };
  shell.addEventListener('touchstart', start, { passive: true }); shell.addEventListener('touchend', end); shell.addEventListener('touchcancel', cancel);
  document.addEventListener('kairos:forge-review', loadCount);
  phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate); gate();
  return { update, tool, changes: () => tool('git'), dispose() { disposed = true; ++countVersion; document.removeEventListener('kairos:forge-review', loadCount); sheet?.close(); statusHome?.after(bridge.status); statusHome?.remove(); header?.remove(); shell.classList.remove('mf-session'); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); shell.removeEventListener('touchstart', start); shell.removeEventListener('touchend', end); shell.removeEventListener('touchcancel', cancel); } };
}
