// A navigation shell around the existing agent chats and real team threads.
import { api, el } from './api.js';
import { ICONS } from './icons.js';
import { agentAvatar } from './agentAvatar.js';
import { stateForStatus } from './mascot.js';
import { botStatusLine } from './botStatus.js';
import { openCreateAgent } from './agentCreation.js';
import { mountAgentEcosystem } from './agentEcosystem.js';
import * as chatStream from './chatStream.js';

export async function mountAgentsMessenger(container, tabId, options, mountAgent, mountInbox) {
  container.classList.add('agents-shell-view');
  let disposed = false, generation = 0, refreshVersion = 0, poll = null, stageTimer = null, stageCleanups = [];
  let selected = '', agents = [], teams = [], metadata = { agents: [], preferences: {} }, rowsSignature = '', collapsed = false;
  const media = matchMedia('(max-width: 768px)');
  const root = el('div', { class: 'agents-messenger is-messages' });
  const workspace = el('div', { class: 'agents-workspace' });
  const ecosystemHost = el('section', { class: 'agent-ecosystem', id: 'agents-ecosystem-panel', role: 'tabpanel', 'aria-labelledby': 'agents-ecosystem-tab', hidden: true });
  const ecosystem = mountAgentEcosystem(ecosystemHost, async (kind, id) => {
    showView('chats'); await select(kind, id);
    if (!disposed) (stage.querySelector('textarea, input') || stage).focus();
  }, refresh);
  const views = ['chats', 'ecosystem'].map(view => el('button', { type: 'button', role: 'tab',
    id: `agents-${view}-tab`, 'aria-controls': view === 'chats' ? 'agents-chats-panel' : ecosystemHost.id,
    'aria-selected': String(view === 'chats'), tabindex: view === 'chats' ? '0' : '-1',
    text: view === 'chats' ? 'Chats' : 'Ecosystem', onclick: () => showView(view) }));
  root.id = 'agents-chats-panel'; root.setAttribute('role', 'tabpanel'); root.setAttribute('aria-labelledby', 'agents-chats-tab');
  const viewTabs = el('div', { class: 'agents-workspace-tabs', role: 'tablist', 'aria-label': 'Agents view' }, views);
  viewTabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - views.indexOf(document.activeElement);
    views[index]?.click(); views[index]?.focus();
  });
  function showView(view) {
    closeDrawer(false);
    root.hidden = view !== 'chats'; root.inert = root.hidden;
    ecosystemHost.hidden = view !== 'ecosystem'; ecosystemHost.inert = ecosystemHost.hidden;
    phoneOpen.hidden = view !== 'chats';
    views.forEach((button, index) => { const active = index === (view === 'chats' ? 0 : 1);
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
    if (view === 'ecosystem') ecosystem.reveal();
    else ecosystem.conceal();
  }
  const stage = el('main', { class: 'agents-messenger-stage', 'aria-label': 'Conversation', tabindex: '-1' });
  const history = el('details', { class: 'agents-rail-history', hidden: true }, [el('summary', { text: 'Conversation history' })]);
  const historyContent = el('div'); history.append(historyContent);
  const lists = el('div', { class: 'agents-rail-lists' });
  const search = el('input', { type: 'search', placeholder: 'Find a chat', 'aria-label': 'Find an agent or team', class: 'agents-rail-search' });
  const iconButton = (label, icon, click, cls = '') => {
    const node = el('button', { type: 'button', class: `agents-rail-action ${cls}`, 'aria-label': label, title: label, onclick: click });
    const glyph = el('span', { 'aria-hidden': 'true' }); glyph.innerHTML = icon; node.append(glyph); return node;
  };
  const rail = el('aside', { class: 'agents-chat-rail', id: 'agents-chat-rail', 'aria-label': 'Agent and team chats' });
  const toggle = iconButton('Collapse chat sidebar', ICONS.sidebar || ICONS.menu || ICONS.agents, () => {
    if (media.matches) closeDrawer();
    else { collapsed = !collapsed; applyRail(); }
  }, 'agents-rail-toggle');
  toggle.setAttribute('aria-controls', rail.id);
  const phoneOpen = iconButton('Open chats', ICONS.chats, () => openDrawer(phoneOpen), 'agents-chats-open');
  phoneOpen.setAttribute('aria-controls', rail.id); phoneOpen.setAttribute('aria-expanded', 'false');
  const scrim = el('button', { class: 'agents-rail-scrim', type: 'button', 'aria-label': 'Close chats', hidden: true, onclick: () => closeDrawer() });
  const railTop = el('div', { class: 'agents-rail-top' }, [el('h2', { text: 'Chats' }), toggle]);
  const newTeam = () => select('team', 'new');
  rail.append(railTop, search, el('div', { class: 'agents-rail-create' }, [
    el('button', { type: 'button', class: 'btn', text: '+ Agent', title: 'New agent', 'aria-label': 'New agent', onclick: openCreateAgent }),
    el('button', { type: 'button', class: 'btn', text: '+ Team', title: 'New team', 'aria-label': 'New team', onclick: newTeam }),
  ]), lists, history, el('button', { type: 'button', class: 'btn quiet agents-rail-inbox', text: 'Inbox & approvals', title: 'Inbox and approvals', onclick: () => select('inbox', '') }));
  root.append(rail, scrim, el('div', { class: 'agents-messenger-body' }, [stage]));
  workspace.append(el('header', { class: 'agents-workspace-bar' }, [el('h2', { text: 'Agents' }), el('div', { class: 'agents-workspace-controls' }, [phoneOpen, viewTabs])]), root, ecosystemHost);
  container.replaceChildren(workspace);
  let drawerOpener = null;
  function applyRail() {
    root.classList.toggle('is-rail-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(media.matches ? root.classList.contains('is-rail-open') : !collapsed));
    toggle.setAttribute('aria-label', media.matches ? 'Close chats' : collapsed ? 'Expand chat sidebar' : 'Collapse chat sidebar');
    toggle.title = toggle.getAttribute('aria-label');
  }
  function openDrawer(opener = document.activeElement) {
    drawerOpener = opener;
    root.classList.add('is-rail-open'); scrim.hidden = false; stage.inert = true;
    applyRail();
    rail.setAttribute('role', 'dialog'); rail.setAttribute('aria-modal', 'true');
    phoneOpen.setAttribute('aria-expanded', 'true'); search.focus();
  }
  function closeDrawer(refocus = true) {
    const wasOpen = root.classList.contains('is-rail-open');
    root.classList.remove('is-rail-open'); scrim.hidden = true; stage.inert = false;
    applyRail();
    rail.removeAttribute('role'); rail.removeAttribute('aria-modal'); phoneOpen.setAttribute('aria-expanded', 'false');
    if (wasOpen && refocus) (drawerOpener?.isConnected && drawerOpener.getClientRects().length ? drawerOpener : phoneOpen).focus();
  }
  const resize = () => closeDrawer(false);
  media.addEventListener('change', resize);
  rail.addEventListener('keydown', event => {
    if (!root.classList.contains('is-rail-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...rail.querySelectorAll('button:not(:disabled),input')].filter(n => n.getClientRects().length);
    if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
  });
  function filter() {
    const q = search.value.trim().toLocaleLowerCase();
    for (const row of lists.querySelectorAll('.agents-rail-item')) { row.hidden = !row.dataset.search.includes(q); row.parentElement.hidden = row.hidden; }
    for (const group of lists.querySelectorAll('.agents-rail-group')) group.hidden = !group.querySelector('.agents-rail-item:not([hidden])');
    const empty = lists.querySelector('.agents-rail-no-match');
    if (empty) empty.hidden = !!lists.querySelector('.agents-rail-item:not([hidden])') || !q;
  }
  search.addEventListener('input', filter);
  function drawRows() {
    const signature = JSON.stringify([agents, teams, metadata, selected]);
    if (signature === rowsSignature) return;
    rowsSignature = signature;
    const focused = lists.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const rows = [...agents.map(item => ({ kind: 'agent', item, ...(metadata.agents || []).find(row => row.id === item.id) })),
      ...teams.map(item => ({ kind: 'team', item, ...(metadata.preferences || {})['team:' + item.id] }))];
    rows.sort((a,b) => Number(!!b.pinned) - Number(!!a.pinned) || (Number(b.at) || 0) - (Number(a.at) || 0) || (a.item.name || '').localeCompare(b.item.name || ''));
    const group = el('section', { class: 'agents-rail-group', 'aria-label': 'Conversations' });
    for (const row of rows) {
      const { kind, item } = row, key = `${kind}:${item.id}`, label = item.name || 'Untitled team';
      const preview = row.preview || (kind === 'agent' ? 'Start a conversation' : item.mission || 'Team work chat');
      const face = kind === 'agent' ? agentAvatar(item, 42, stateForStatus(botStatusLine(item).state)) : el('span', { class: 'agents-team-avatar', 'aria-hidden': 'true' });
      if (kind === 'team') {
        const members = [item.lead, ...(item.specialists || [])].map(member => agents.find(a => a.id === member?.agent_id)).filter(Boolean).slice(0, 3);
        if (members.length) face.append(...members.map(member => agentAvatar(member, 26))); else face.innerHTML = ICONS.agents;
      }
      const at = Number(row.at) ? new Date(Number(row.at) * 1000) : null;
      const time = at ? (at.toDateString() === new Date().toDateString() ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString([], { month: 'short', day: 'numeric' })) : '';
      const node = el('button', { type: 'button', class: `agents-rail-item ${kind === 'agent' ? 'agent-tile' : 'team-tile'}`, 'data-key': key,
        'data-search': `${label} ${preview}`.toLocaleLowerCase(), 'aria-label': `${label}, ${kind === 'agent' ? 'direct message' : 'team work chat'}${row.unread ? ', unread' : ''}`, title: `${label} ? ${preview}`,
        ...(selected === key ? { 'aria-current': 'page' } : {}), onclick: () => select(kind, item.id) }, [face,
        el('span', { class: 'agents-rail-copy' }, [el('strong', { text: label }), el('span', { text: preview })]),
        el('span', { class: 'agents-rail-meta' }, [el('time', { text: time, ...(at ? { datetime: at.toISOString() } : {}) }),
          ...(row.pinned ? [el('span', { text: 'Pinned', class: 'agents-chat-pin' })] : []),
          ...(row.unread ? [el('span', { class: 'agents-chat-unread', text: String(row.unread === true ? 1 : row.unread), 'aria-label': 'Unread messages' })] : [])])]);
      node.addEventListener('contextmenu', event => { event.preventDefault(); organize(kind, item, row); });
      node.addEventListener('keydown', event => { if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); organize(kind, item, row); } });
      const menu = el('button', { type: 'button', class: 'agents-row-menu', text: '\u22ef', 'aria-label': `Chat actions for ${label}`, onclick: () => organize(kind, item, row) });
      group.append(el('div', { class: 'agents-rail-row' }, [node, menu]));
    }
    lists.replaceChildren(group, el('p', { class: 'agents-rail-no-match', text: 'No matching chats.', hidden: true }));
    filter();
    if (focused) [...lists.querySelectorAll('button')].find(b => b.dataset.key === focused)?.focus();
  }
  async function organize(kind, item, row) {
    const dialog = el('dialog', { class: 'agents-chat-actions', 'aria-label': `Chat actions for ${item.name}` });
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.append(el('h2', { text: item.name }), ...[[row.pinned ? 'unpin' : 'pin', row.pinned ? 'Unpin chat' : 'Pin chat'], [row.unread ? 'read' : 'unread', row.unread ? 'Mark as read' : 'Mark as unread']].map(([action, text]) => el('button', { type: 'button', class: 'btn', text, onclick: async () => {
      try { await api(`/api/agents/conversations/${kind}/${encodeURIComponent(item.id)}`, { method: 'POST', body: JSON.stringify({ action }) }); close(); await refresh(); }
      catch {} // api presents errors; keep this dialog available to retry.
    } })), el('button', { class: 'btn quiet', text: 'Cancel', onclick: close }));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(dialog); dialog.showModal();
    stageCleanups.push(close);
  }
  async function refresh() {
    const version = ++refreshVersion;
    try {
      const [nextAgents, nextTeams, nextMetadata] = await Promise.all([api('/api/agents'), api('/api/swarm/systems').catch(() => null), api('/api/agents/conversations').catch(() => ({ agents: [], preferences: {} }))]);
      if (disposed || version !== refreshVersion) return;
      agents = nextAgents; metadata = nextMetadata; if (nextTeams) teams = nextTeams.items || []; drawRows();
      ecosystem.update({ agents, teams, teamsError: !nextTeams });
      if (nextTeams) lists.querySelector('.agents-team-error')?.remove();
      if (!nextTeams && !lists.querySelector('.agents-team-error')) lists.append(el('p', { class: 'agents-team-error', role: 'status', text: 'Teams unavailable. Reconnecting…' }));
    } catch (problem) {
      if (!disposed && version === refreshVersion) { ecosystem.update({ agents, teams, agentsError: true, teamsError: true }); rowsSignature = ''; lists.replaceChildren(el('p', { role: 'alert', text: 'Chats could not load.' }), el('button', { class: 'btn', text: 'Retry', onclick: refresh })); }
    } finally { if (!disposed && version === refreshVersion) { clearTimeout(poll); poll = setTimeout(refresh, 10000); } }
  }
  function clearStage() {
    clearTimeout(stageTimer); const old = stageCleanups; stageCleanups = []; old.forEach(fn => fn()); historyContent.replaceChildren(); stage.replaceChildren();
  }
  async function select(kind, id, initial = {}) {
    const key = `${kind}:${id}`;
    if (selected === key) { closeDrawer(); return; }
    selected = key; const token = ++generation; clearStage(); drawRows(); closeDrawer();
    root.dataset.agentId = kind === 'agent' ? id : '';
    history.hidden = kind !== 'agent';
    if (id !== 'new' && ['agent', 'team'].includes(kind)) api(`/api/agents/conversations/${kind}/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action: 'read' }), toast: false }).then(refresh).catch(() => {});
    const page = el('div', { class: 'agents-messenger-page agents-view' }); stage.append(page);
    const cleanups = stageCleanups;
    const schedule = fn => { clearTimeout(stageTimer); stageTimer = setTimeout(() => !disposed && token === generation && fn(), 10000); };
    try {
      if (kind === 'agent') await mountAgent(page, id, schedule, cleanups, initial, {
        history: historyContent, open: () => { if (media.matches) openDrawer(); else { collapsed = false; applyRail(); } history.open = true; history.querySelector('input')?.focus(); }, close: closeDrawer,
      });
      else if (kind === 'team') {
        const swarm = await import('./views/swarm.js');
        if (disposed || token !== generation) return;
        cleanups.push(swarm.render(page, tabId, { embedded: true, messenger: true, systemId: id }));
      } else { page.classList.add('agents-inbox-view'); await mountInbox(page, schedule); }
      if (disposed || token !== generation) cleanups.splice(0).forEach(fn => fn());
    } catch (problem) {
      if (!disposed && token === generation) page.replaceChildren(el('p', { role: 'alert', text: 'This conversation could not load.' }), el('button', { class: 'btn', text: 'Retry', onclick: () => { selected = ''; select(kind, id, initial); } }));
    }
  }
  function welcome() {
    const faces = el('div', { class: 'agents-messenger-faces', 'aria-hidden': 'true' }, agents.slice(0, 3).map(a => agentAvatar(a, 64)));
    if (!agents.length) faces.innerHTML = ICONS.agents;
    stage.append(el('div', { class: 'agents-messenger-welcome' }, [faces, el('h1', { text: 'A few minds. One place.' }),
      el('p', { text: 'Message an agent, or bring a team together.' }),
      el('div', { class: 'agents-welcome-actions' }, [el('button', { class: 'btn primary', text: 'New agent', onclick: openCreateAgent }), el('button', { class: 'btn', text: 'New team', onclick: newTeam })])]));
  }
  const unsubscribeChats = chatStream.subscribeAll((id, entry) => {
    if (!entry || entry.status === 'processing' || disposed) return;
    const [kind, agentId] = selected.split(':');
    if (kind === 'agent' && !root.hidden && !document.hidden && (metadata.agents || []).some(row => row.id === agentId && row.session_id === id))
      api(`/api/agents/conversations/agent/${encodeURIComponent(agentId)}`, { method: 'POST', body: JSON.stringify({ action: 'read' }), toast: false }).then(refresh).catch(() => {});
    else refresh();
  });
  applyRail();
  document.addEventListener('jarvis:agents-changed', refresh);
  const cleanup = () => { disposed = true; unsubscribeChats(); generation++; clearTimeout(poll); clearStage(); ecosystem.destroy(); media.removeEventListener('change', resize); document.removeEventListener('jarvis:agents-changed', refresh); };
  options.registerCleanup?.(cleanup);
  await refresh();
  if (disposed) return cleanup;
  if (options.team) await select('team', options.team, options);
  else if (options.agentId) await select('agent', options.agentId, options);
  else welcome();
  return cleanup;
}
