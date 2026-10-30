// The Bots sidebar (Agents 3.0 Phase 0 unit U3, extended by Phase 1 unit U4).
// Under the Bots home button it lists the visible bots, each a `.nav-item` that
// opens that bot's page, with a "New bot" row, the Archived row and the Simple /
// Advanced switch at the foot (OMB 3.3, in Kairos's colourway through the --bots-*
// tokens in bots.css, bots-shell.css and bots-sidebar.css).
//
//   Simple    pinned circles above one tile per bot.
//   Advanced  Pinned, Needs attention and Bots sections; each bot opens into its
//             folders and conversations (botsSidebarModel.js decides which six
//             ordinary threads show, plus pinned, current and attention ones).
//
// Per person (kept in this browser): density, section order and collapse, which bots
// are open, folder collapse, widths and pinned order. Server thread data stays the
// authority; these choices only change how it is shown.
//
// Rows keep to the static face (agentAvatar) and never a live mascot, the
// 2026-10-14 lesson in agentAvatar.js: a roster of live SVGs made ui-smoke flaky.
//
// The ordering and row facts are plain functions with no DOM, so
// scripts/test_bots_rail.cjs loads this file in Node. Every import below loads in
// Node; api.js is reached lazily.
import { botStatusLine } from './botStatus.js';
import { agentAvatar } from './agentAvatar.js';
import { icon } from './botsIcons.js';
import { Segmented, isAdvanced, setAdvanced, onBotsInterface, loadBotsCss, openMenu } from './botsUi.js';
import { openNewBot, openArchived, openBotSettings } from './botsPanelHost.js';
import { targetId } from './botsNavigation.js';
import { openNewRoom, openTeamDialog, openTeamInstructions, openTeamMemory, openTeamSettings, teamNavigate } from './botsTeamHost.js';
import {
  sidebarPreferenceKey, teamSidebarPreferences as sidebarPreferences, teamGroups, roomRow, reorder, orderedPins, botTree, railWidth, nextDensity, widthAfterKey, widthBounds,
  clampSidebarWidth, searchMatches, searchReady, attentionBots, canMoveThread, afterDelete, threadAttention,
} from './botsSidebarModel.js';
import { botsThreadApi, threadMenuItems, folderMenuItems, botMenuItems, movedFolderIds, copyableLink } from './botsThreadMenu.js';
import { buildItems, needsYouCount } from './botsAutomationModel.js';

const SHELL_CSS = '/static/css/bots-shell.css';
const SIDEBAR_CSS = '/static/css/bots-sidebar.css';
const POLL_MS = 10000;
const SEARCH_DELAY = 250;

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The order the rail and Home show bots in: the person's own order first, then by
// name; a bot with no order yet sorts after the ordered ones.
export function compareBots(a, b) {
  const ao = finite(a.order), bo = finite(b.order);
  if (ao !== bo) {
    if (ao === null) return 1;
    if (bo === null) return -1;
    return ao - bo;
  }
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    || String(a.id || '').localeCompare(String(b.id || ''));
}
export function visibleBots(agents) {
  return (Array.isArray(agents) ? agents : []).filter(agent => agent && !agent.hidden).sort(compareBots);
}
export function archivedBots(agents) {
  return (Array.isArray(agents) ? agents : []).filter(agent => agent && agent.hidden).sort(compareBots);
}

// What a row says about a bot. The state comes from botStatus.js (needs you beats
// working beats waiting beats idle; off wins when the bot is turned off).
export function railRow(agent) {
  const line = botStatusLine(agent);
  const needs = Math.max(0, Number(agent?.needs_you) || 0);
  return { id: agent.id, name: agent.name || 'Bot', state: line.state, text: line.text, needs,
    label: `${agent.name || 'Bot'}, ${line.text}` };
}

// What a conversation row says: its title, whether it needs a look, and a spoken label.
export function threadRowFacts(row, currentId = '') {
  const title = String(row?.title || '').trim() || 'New conversation';
  const rank = threadAttention(row || {}, currentId);
  const marks = [];
  if (rank === 0) marks.push('needs you');
  else if (rank === 1) marks.push('working');
  else if (rank === 2) marks.push('waiting on a teammate');
  else if (rank === 3) marks.push('queued');
  if (row?.thread?.unread || row?.unread) marks.push('unread');
  if (row?.thread?.pinned) marks.push('pinned');
  return { id: row?.id, title, rank, state: rank === 0 ? 'needs_you' : rank === 1 ? 'working' : rank === 2 ? 'teammate' : rank === 3 ? 'queued' : 'idle',
    unread: !!(row?.thread?.unread || row?.unread), pinned: !!row?.thread?.pinned, main: !!row?.thread?.main,
    label: marks.length ? `${title}, ${marks.join(', ')}` : title };
}

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

const go = detail => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail }));
export function openBot(agentId) { go({ tab: 'botsShell', agentId }); }
export function openThread(agentId, sessionId) { go({ tab: 'botsShell', agentId, ...(targetId(sessionId) ? { sessionId } : {}) }); }

const lazyApi = async (path, init) => (await import('./api.js')).api(path, init);
const say = async (message, type = 'error') => { try { (await import('./api.js')).toast(message, type); } catch { /* nothing to tell */ } };

export function mountBotsRail(nav) {
  // Hidden until the stylesheets are in, so the rail never shows unstyled.
  const styled = Promise.all([loadBotsCss(SHELL_CSS), loadBotsCss(SIDEBAR_CSS)]);
  const api = botsThreadApi(lazyApi);
  const root = document.documentElement;
  let disposed = false, version = 0, agents = [], pinnedIds = new Set(), signature = '';
  let departments = [], rooms = [];
  let prefs = sidebarPreferences(), user = 'local', query = '', searchTimer = 0, selection = null;
  const threads = new Map();   // agent id -> { rows, folders, main_id, at }
  const showAll = new Set();   // bots whose conversation list is not cut to the recent ones
  const loading = new Set();
  let renaming = null;         // { kind, id } while an inline name field is open
  const interfaceNow = () => (isAdvanced() ? 'advanced' : 'simple');

  // -- Preferences (per person, in this browser) ----------------------------------
  const storageKey = () => sidebarPreferenceKey(user);
  const loadPrefs = () => { try { prefs = sidebarPreferences(JSON.parse(localStorage.getItem(storageKey()) || '{}')); } catch { prefs = sidebarPreferences(); } };
  const savePrefs = next => {
    prefs = sidebarPreferences({ ...prefs, ...next });
    try { localStorage.setItem(storageKey(), JSON.stringify(prefs)); } catch { /* Device storage is optional. */ }
  };

  // -- Frame ---------------------------------------------------------------------
  const newBot = h('button', { type: 'button', class: 'nav-item bots-rail-new', 'aria-label': 'New bot', onclick: () => openNewBot() },
    [icon('plus', { size: 16 }), h('span', { text: 'New bot' })]);
  // Team templates, packages and imports (Phase 6, botsTemplates.js).
  const templates = h('button', { type: 'button', class: 'nav-item bots-rail-templates', 'aria-label': 'Templates',
    onclick: () => import('./botsTemplates.js').then(m => m.openTemplates()) }, [icon('layout-grid', { size: 16 }), h('span', { text: 'Templates' })]);
  const teamMap = h('button', { type: 'button', class: 'nav-item bots-rail-team-map', 'data-tab': 'botsTeamMap', 'aria-label': 'Team map', onclick: () => teamNavigate('botsTeamMap') }, [icon('map'), h('span', { text: 'Team map' })]);
  const search = h('input', { type: 'search', class: 'bots-rail-search', placeholder: 'Search bots and conversations', 'aria-label': 'Search bots and conversations', autocomplete: 'off' });
  const density = h('button', { type: 'button', class: 'bots-rail-density', 'aria-label': 'Sidebar density', title: 'Sidebar density' }, [icon('sliders-horizontal', { size: 15 })]);
  const list = h('div', { class: 'bots-rail-list', role: 'list' });
  const archived = h('button', { type: 'button', class: 'nav-item bots-rail-archived', hidden: true, onclick: () => openArchived() },
    [icon('archive', { size: 16 }), h('span', { class: 'bots-rail-archived-label' })]);
  const view = Segmented({ label: 'Interface', value: interfaceNow(), options: [{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }],
    onChange: value => setAdvanced(value === 'advanced') });
  const automationBadge = h('span', { class: 'bots-status-dot', 'data-state': 'needs_you', hidden: true, 'aria-hidden': 'true' });
  const automations = h('button', { type: 'button', class: 'nav-item', 'data-tab': 'botsAutomations', onclick: () => go({ tab: 'botsAutomations' }) }, [icon('calendar-clock', { size: 16 }), h('span', { text: 'Automations' }), automationBadge]);
  const foot = h('div', { class: 'bots-rail-foot' }, [automations, view]);
  const head = h('div', { class: 'bots-rail-head' }, [h('span', { class: 'bots-caps', text: 'Your bots' }), density]);
  // Inbox, Notifications, Activity and Inspector (unit U5's drawer). The row shows only when that module loads.
  const attention = h('div', { class: 'bots-rail-attention', role: 'group', 'aria-label': 'Attention', hidden: true },
    [['inbox', 'Inbox', 'message-square'], ['notifications', 'Notifications', 'bell'], ['activity', 'Activity', 'history'], ['inspector', 'Inspector', 'eye']].map(([name, label, glyph]) =>
      h('button', { type: 'button', class: 'bots-rail-attention-btn', 'data-panel': name, 'aria-label': label, title: label, 'aria-pressed': 'false',
        onclick: () => import('./botsAttentionHost.js').then(host => host.toggleAttention(name, { agentId: root.dataset.botsAgent || '', sessionId: root.dataset.botsSession || '' })).catch(() => {}) },
        [icon(glyph, { size: 15 })])));
  import('./botsAttentionHost.js').then(() => { if (!disposed) attention.hidden = false; }).catch(() => {});
  const section = h('section', { class: 'bots-rail', 'aria-label': 'Your bots' }, [head, attention, teamMap, newBot, templates, search, list, archived, foot]);
  section.style.visibility = 'hidden';
  styled.finally(() => { section.style.visibility = ''; });
  nav.append(section);

  // -- Width: the resize separator and the density widths -------------------------
  const separator = h('div', { class: 'bots-rail-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar', tabindex: '0' });
  const sidebar = document.getElementById('sidebar');
  const desktop = matchMedia('(min-width: 769px)');
  const widthNow = () => railWidth(prefs.density, isAdvanced(), prefs.widths, innerWidth);
  const applyWidth = () => {
    const collapsed = root.classList.contains('sidebar-collapsed');
    section.dataset.density = prefs.density;
    root.dataset.botsDensity = prefs.density;
    if (collapsed || !desktop.matches) { root.style.removeProperty('--sidebar-width'); separator.hidden = true; return; }
    const width = widthNow(), { min, max } = widthBounds(innerWidth);
    root.style.setProperty('--sidebar-width', `${width}px`);
    separator.hidden = prefs.density !== 'comfortable';
    separator.setAttribute('aria-valuemin', String(min)); separator.setAttribute('aria-valuemax', String(max)); separator.setAttribute('aria-valuenow', String(width));
    separator.setAttribute('aria-valuetext', `${width} pixels`);
  };
  const setWidth = value => {
    const key = isAdvanced() ? 'advanced' : 'simple';
    savePrefs({ widths: { ...prefs.widths, [key]: clampSidebarWidth(value, innerWidth) } }); applyWidth();
  };
  let drag = null;
  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, width: widthNow() }; separator.setPointerCapture?.(event.pointerId); separator.classList.add('dragging'); event.preventDefault();
  });
  separator.addEventListener('pointermove', event => { if (drag) setWidth(drag.width + event.clientX - drag.x); });
  const endDrag = () => { drag = null; separator.classList.remove('dragging'); };
  separator.addEventListener('pointerup', endDrag); separator.addEventListener('pointercancel', endDrag);
  separator.addEventListener('keydown', event => {
    const next = widthAfterKey(widthNow(), event.key, event.shiftKey, innerWidth);
    if (next === null) return;
    event.preventDefault(); setWidth(next);
  });
  separator.addEventListener('dblclick', () => setWidth(isAdvanced() ? 320 : 280));
  sidebar?.append(separator);
  const classWatch = new MutationObserver(applyWidth);
  classWatch.observe(root, { attributes: true, attributeFilter: ['class'] });
  desktop.addEventListener('change', applyWidth);
  addEventListener('resize', applyWidth);

  density.addEventListener('click', () => { savePrefs({ density: nextDensity(prefs.density) }); applyWidth(); draw(true); announce(`Sidebar density: ${prefs.density}`); });
  // The same choice from Settings > Bots (botsPrefs.js setSidebarDensity).
  const onPrefs = event => { if (event.detail?.name !== 'density' || event.detail.value === prefs.density) return; savePrefs({ density: event.detail.value }); applyWidth(); draw(true); };
  document.addEventListener('kairos:bots-prefs', onPrefs);
  const live = h('div', { class: 'bots-rail-live', role: 'status', 'aria-live': 'polite' });
  section.append(live);
  function announce(text) { live.textContent = ''; setTimeout(() => { if (!disposed) live.textContent = text; }, 30); }

  // -- Facts ---------------------------------------------------------------------
  const botById = id => agents.find(bot => bot.id === id);
  const stateOf = bot => botStatusLine(bot).state;
  const mainOf = id => threads.get(id)?.main_id || '';
  const currentSession = () => root.dataset.botsSession || '';
  const currentId = bot => (root.dataset.botsAgent === bot.id ? (currentSession() || mainOf(bot.id)) : '');
  const isOpen = id => prefs.expanded.includes(id);
  const isClosedFolder = (agentId, folderId) => prefs.closedFolders.includes(`${agentId}:${folderId}`);
  const bots = () => visibleBots(agents);

  async function readThreads(agentId, force = false) {
    if (loading.has(agentId) || disposed) return;
    const known = threads.get(agentId);
    if (!force && known && Date.now() - known.at < 2000) return;
    loading.add(agentId);
    try {
      const body = await api.list(agentId);
      const bot = botById(agentId);
      if (disposed || !body || !Array.isArray(body.threads)) return;
      threads.set(agentId, { rows: body.threads, main_id: body.main_id || '', folders: Array.isArray(bot?.folders) ? bot.folders : [], at: Date.now() });
    } catch { /* The next poll tries again; a bot with no list shows its row alone. */ }
    finally { loading.delete(agentId); }
  }
  // Which bots' conversations the sidebar needs now: the ones open in the tree, the one on screen, every bot while searching.
  const wanted = () => {
    if (searchReady(query)) return bots().map(bot => bot.id);
    if (!isAdvanced()) return [];
    return [...new Set([...prefs.expanded, root.dataset.botsAgent].filter(id => id && botById(id)))];
  };
  const readWanted = async force => { await Promise.all(wanted().map(id => readThreads(id, force))); };

  // -- Rows ----------------------------------------------------------------------
  const botKey = bot => `bot:${bot.id}`;
  function botRow(bot, { tree = false, section: from = '' } = {}) {
    const fact = railRow(bot);
    const open = isOpen(bot.id);
    const row = h('div', { class: 'bots-rail-line', role: 'listitem', 'data-key': `${from}${botKey(bot)}` });
    if (tree) {
      const toggle = h('button', { type: 'button', class: 'bots-rail-toggle', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} conversations with ${fact.name}`,
        onclick: () => toggleBot(bot.id) }, [icon(open ? 'chevron-down' : 'chevron-right', { size: 14 })]);
      row.append(toggle);
    }
    const main = h('button', { type: 'button', class: 'nav-item bots-rail-row', 'data-tab': 'botsShell', 'data-agent-id': bot.id,
      'data-state': fact.state, 'aria-label': fact.label, title: fact.text, onclick: () => openBot(bot.id) }, [
      agentAvatar(bot, 24),
      h('span', { class: 'bots-rail-name', text: fact.name }),
      departments.some(t => t.chief_bot_id === bot.id) ? icon('crown', { size: 13, label: 'Chief of Staff' }) : null,
      h('span', { class: 'bots-status-dot', 'data-state': fact.state, 'aria-hidden': 'true' }),
      fact.needs ? h('span', { class: 'bots-rail-count', text: fact.needs > 99 ? '99+' : String(fact.needs) }) : null,
    ]);
    main.addEventListener('contextmenu', event => { event.preventDefault(); botMenu(bot, main); });
    row.append(main);
    if (tree) row.append(h('button', { type: 'button', class: 'bots-rail-more', 'aria-label': `More for ${fact.name}`, 'aria-haspopup': 'menu', onclick: () => botMenu(bot, row.lastChild) }, [icon('ellipsis', { size: 15 })]));
    return row;
  }

  function pinCircle(bot) {
    const fact = railRow(bot);
    const circle = h('button', { type: 'button', class: 'bots-pin-circle', 'data-agent-id': bot.id, 'data-state': fact.state, 'aria-label': fact.label, title: fact.label,
      onclick: () => openBot(bot.id) }, [agentAvatar(bot, 36), fact.needs ? h('span', { class: 'bots-pin-count', 'aria-hidden': 'true', text: fact.needs > 99 ? '99+' : String(fact.needs) }) : null]);
    circle.dataset.key = `pin:${bot.id}`;
    circle.addEventListener('keydown', event => keyReorder(event, 'pin', bot.id));
    circle.addEventListener('contextmenu', event => { event.preventDefault(); botMenu(bot, circle); });
    return circle;
  }

  function threadRow(bot, row, folders) {
    const fact = threadRowFacts(row, currentId(bot));
    const node = h('div', { class: 'bots-thread-line', role: 'listitem', 'data-key': `thread:${row.id}`, 'data-thread-id': row.id, draggable: 'true' });
    node.dataset.state = fact.state;
    if (selection?.agentId === bot.id) {
      const box = h('input', { type: 'checkbox', class: 'bots-thread-check', 'aria-label': `Select ${fact.title}`, onchange: () => { box.checked ? selection.ids.add(row.id) : selection.ids.delete(row.id); paintSelection(); } });
      box.checked = selection.ids.has(row.id);
      node.append(box);
    }
    if (renaming?.kind === 'thread' && renaming.id === row.id) {
      node.append(nameField(fact.title, 'Conversation name', async value => { renaming = null; await run(() => api.rename(bot.id, row.id, value), bot.id); }, () => { renaming = null; draw(true); }));
      return node;
    }
    const mine = currentId(bot) === row.id;
    const button = h('button', { type: 'button', class: `bots-thread-row${mine && root.dataset.botsAgent === bot.id ? ' active' : ''}`, 'data-session-id': row.id,
      'aria-label': fact.label, onclick: () => (selection?.agentId === bot.id ? toggleSelected(row.id) : openThread(bot.id, row.id)) }, [
      h('span', { class: 'bots-status-dot', 'data-state': fact.state, 'aria-hidden': 'true' }),
      h('span', { class: 'bots-thread-title', text: fact.title }),
      fact.pinned ? icon('pin', { size: 12 }) : null,
      fact.unread ? h('span', { class: 'bots-thread-unread', 'aria-hidden': 'true' }) : null,
    ]);
    if (mine && root.dataset.botsAgent === bot.id) button.setAttribute('aria-current', 'page');
    node.append(button);
    const more = h('button', { type: 'button', class: 'bots-rail-more', 'aria-label': `More for ${fact.title}`, 'aria-haspopup': 'menu', onclick: () => threadMenu(bot, row, more) }, [icon('ellipsis', { size: 15 })]);
    node.append(more);
    node.addEventListener('contextmenu', event => { event.preventDefault(); threadMenu(bot, row, more); });
    node.addEventListener('dragstart', event => { event.dataTransfer?.setData('text/plain', row.id); event.dataTransfer && (event.dataTransfer.effectAllowed = 'move'); dragging = { agentId: bot.id, row }; });
    node.addEventListener('dragend', () => { dragging = null; });
    return node;
  }
  let dragging = null;

  function folderBlock(bot, group, folders, count) {
    const isFolder = group.id !== null;
    const closed = isFolder && isClosedFolder(bot.id, group.id);
    const block = h('div', { class: 'bots-folder', 'data-folder-id': group.id ?? '', role: 'group', 'aria-label': group.name });
    if (isFolder || folders.length) {
      let titleNode;
      if (renaming?.kind === 'folder' && renaming.id === group.id) {
        titleNode = nameField(group.name, 'Folder name', async value => { renaming = null; await run(() => api.renameFolder(bot.id, group.id, value), bot.id); }, () => { renaming = null; draw(true); });
      } else {
        titleNode = h('button', { type: 'button', class: 'bots-folder-head', 'aria-expanded': String(!closed), 'data-key': `folder:${bot.id}:${group.id ?? ''}`,
          onclick: () => isFolder && toggleFolder(bot.id, group.id) }, [
          isFolder ? icon(closed ? 'chevron-right' : 'chevron-down', { size: 12 }) : null,
          h('span', { class: 'bots-folder-name', text: `${group.emoji ? group.emoji + ' ' : ''}${group.name}` }),
          h('span', { class: 'bots-folder-count', text: String(group.threads.length) }),
        ]);
      }
      const headRow = h('div', { class: 'bots-folder-line' }, [titleNode]);
      if (isFolder && !(renaming?.kind === 'folder' && renaming.id === group.id)) {
        const index = folders.findIndex(folder => folder.id === group.id);
        const more = h('button', { type: 'button', class: 'bots-rail-more', 'aria-label': `More for folder ${group.name}`, 'aria-haspopup': 'menu',
          onclick: () => folderMenu(bot, group, index, folders.length, more) }, [icon('ellipsis', { size: 15 })]);
        headRow.append(more);
        headRow.addEventListener('contextmenu', event => { event.preventDefault(); folderMenu(bot, group, index, folders.length, more); });
      }
      block.append(headRow);
    }
    // A conversation dropped on a folder (or the unfiled group) moves there; the menu does the same by keyboard.
    block.addEventListener('dragover', event => { if (dragging?.agentId === bot.id && canMoveThread(dragging.row, group.id, folders)) { event.preventDefault(); block.classList.add('drop'); } });
    block.addEventListener('dragleave', () => block.classList.remove('drop'));
    block.addEventListener('drop', event => {
      block.classList.remove('drop');
      if (!dragging || dragging.agentId !== bot.id || !canMoveThread(dragging.row, group.id, folders)) return;
      event.preventDefault();
      const moved = dragging.row; dragging = null;
      run(() => api.move(bot.id, moved.id, group.id), bot.id);
    });
    if (!closed) for (const row of group.threads) block.append(threadRow(bot, row, folders));
    return block;
  }

  function botChildren(bot) {
    const data = threads.get(bot.id);
    const holder = h('div', { class: 'bots-rail-children', role: 'list', 'aria-label': `Conversations with ${bot.name || 'Bot'}` });
    if (!data) { holder.append(h('p', { class: 'bots-rail-empty', text: loading.has(bot.id) ? 'Loading...' : 'Conversations could not load.' })); return holder; }
    const folders = data.folders;
    const all = showAll.has(bot.id);
    const tree = botTree(data.rows, folders, { currentId: currentId(bot), all });
    const hidden = data.rows.filter(row => !row.thread?.archived_at && !row.thread?.routine_run_id).length
      - tree.reduce((sum, group) => sum + group.threads.length, 0);
    holder.append(h('button', { type: 'button', class: 'bots-rail-newthread', onclick: () => newThread(bot) }, [icon('plus', { size: 13 }), h('span', { text: 'New conversation' })]));
    if (renaming?.kind === 'newfolder' && renaming.id === bot.id) {
      // A conversation moved here from its menu goes into the new folder once it exists.
      const moving = renaming.moveId;
      holder.append(nameField('', 'New folder name', async value => {
        renaming = null;
        await run(async () => { const folder = await api.addFolder(bot.id, value); if (moving && folder?.id) await api.move(bot.id, moving, folder.id); }, bot.id, true);
      }, () => { renaming = null; draw(true); }));
    }
    for (const group of tree) {
      if (group.id === null && !group.threads.length && folders.length) continue;
      holder.append(folderBlock(bot, group, folders, folders.length));
    }
    if (hidden > 0 && !all) holder.append(h('button', { type: 'button', class: 'bots-rail-showall', onclick: () => { showAll.add(bot.id); draw(true); } }, [h('span', { text: `Show all (${hidden} more)` })]));
    else if (all && hidden <= 0 && data.rows.length > 6) holder.append(h('button', { type: 'button', class: 'bots-rail-showall', onclick: () => { showAll.delete(bot.id); draw(true); } }, [h('span', { text: 'Show fewer' })]));
    if (selection?.agentId === bot.id) holder.append(selectionBar(bot));
    return holder;
  }

  // -- Inline name fields, menus, selection ------------------------------------------
  function nameField(value, label, commit, cancel) {
    const input = h('input', { type: 'text', class: 'bots-rail-name-input', value, 'aria-label': label, maxlength: '200' });
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      const text = input.value.trim();
      if (ok && text && text !== value) commit(text); else cancel();
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    queueMicrotask(() => { if (input.isConnected) { input.focus(); input.select(); } });
    return input;
  }

  // One call, then a fresh read: a refused change says why and leaves the tree as the server has it.
  async function run(action, agentId, reload = false) {
    try { await action(); }
    catch (error) { await say(error?.message || 'That did not work.'); }
    await readThreads(agentId, true);
    if (reload) await refresh();
    draw(true);
    document.dispatchEvent(new CustomEvent('kairos:bots-threads-changed', { detail: { agentId } }));
  }

  function threadMenu(bot, row, anchor) {
    const data = threads.get(bot.id), folders = data?.folders || [];
    const handlers = {
      open: r => openThread(bot.id, r.id),
      rename: r => { renaming = { kind: 'thread', id: r.id }; draw(true); },
      pin: r => run(() => api.pin(bot.id, r), bot.id),
      unread: r => run(() => api.unread(bot.id, r), bot.id),
      move: (r, folderId) => run(() => api.move(bot.id, r.id, folderId), bot.id),
      moveToNewFolder: r => { savePrefs({ expanded: [...new Set([...prefs.expanded, bot.id])] }); renaming = { kind: 'newfolder', id: bot.id, moveId: r.id }; draw(true); },
      snooze: (r, kind) => run(() => api.snooze(bot.id, r.id, kind), bot.id),
      copyLink: async r => {
        try { await navigator.clipboard.writeText(copyableLink(location.origin, bot.id, r.id)); announce('Link copied'); await say('Link copied', 'success'); }
        catch { await say('The link could not be copied.'); }
      },
      select: r => { selection = { agentId: bot.id, ids: new Set([r.id]) }; draw(true); },
      makeMain: r => run(() => api.makeMain(bot.id, r.id), bot.id),
      archive: r => run(() => api.archive(bot.id, r.id), bot.id),
      remove: r => deleteThreads(bot, [r.id], r.title),
    };
    openMenu(anchor, threadMenuItems({ row, folders, main: !!row.thread?.main || mainOf(bot.id) === row.id, handlers }), { align: 'end' });
  }

  function folderMenu(bot, group, index, count, anchor) {
    const folders = threads.get(bot.id)?.folders || [];
    openMenu(anchor, folderMenuItems({ folder: group, index, count, handlers: {
      rename: folder => { renaming = { kind: 'folder', id: folder.id }; draw(true); },
      move: (folder, offset) => run(() => api.orderFolders(bot.id, movedFolderIds([...folders].sort((a, b) => a.order - b.order), folder.id, offset)), bot.id, true),
      remove: async folder => {
        const ok = await askConfirm('Delete this folder?', 'Its conversations stay, outside any folder.', 'Delete folder');
        if (ok) run(() => api.removeFolder(bot.id, folder.id), bot.id, true);
      },
    } }), { align: 'end' });
  }

  function botMenu(bot, anchor) {
    const items = botMenuItems({ bot, pinned: pinnedIds.has(bot.id), handlers: {
      open: b => openBot(b.id),
      pin: async b => {
        const next = !pinnedIds.has(b.id);
        try { await api.pinBot(b.id, next); next ? pinnedIds.add(b.id) : pinnedIds.delete(b.id); } catch (error) { await say(error?.message || 'That did not work.'); }
        draw(true);
      },
      newThread: b => newThread(b),
      newFolder: b => { savePrefs({ expanded: [...new Set([...prefs.expanded, b.id])] }); renaming = { kind: 'newfolder', id: b.id }; readThreads(b.id, true).then(() => draw(true)); },
      settings: b => { openBot(b.id); setTimeout(() => openBotSettings(b.id, { section: 'overview' }), 0); },
    } });
    items.push({ label: departments.some(t => t.chief_bot_id === bot.id) ? 'Remove chief' : 'Make chief', iconName: 'crown',
      disabled: bot.tools_available === false || bot.can_use_tools === false || !bot.section,
      meta: !bot.section ? 'Choose a team first' : bot.tools_available === false || bot.can_use_tools === false ? 'This model cannot use tools' : '',
      onSelect: () => openTeamDialog({ departmentId: departments.find(t => t.name === bot.section)?.id, agentId: bot.id, mode: 'chief' }) });
    openMenu(anchor, items, { align: 'end' });
  }

  async function newThread(bot) {
    try {
      const made = await api.create(bot.id);
      savePrefs({ expanded: [...new Set([...prefs.expanded, bot.id])] });
      await readThreads(bot.id, true); draw(true);
      if (made?.id) openThread(bot.id, made.id);
    } catch (error) { await say(error?.message || 'A new conversation could not be started.'); }
  }

  async function askConfirm(title, message, confirmLabel) {
    try { return await (await import('./api.js')).confirmDialog({ title, message, confirmLabel }); } catch { return false; }
  }
  async function deleteThreads(bot, ids, title = '') {
    const one = ids.length === 1;
    if (!await askConfirm(one ? `Delete "${title || 'this conversation'}"?` : `Delete ${ids.length} conversations?`,
      'This cannot be undone. The main conversation, and one that is working, stay.', 'Delete')) return;
    try {
      const result = await api.remove(bot.id, ids);
      const data = threads.get(bot.id);
      if (data) data.rows = afterDelete(data.rows, result);
      if (result?.busy?.length) await say('A conversation that is working was kept.', 'info');
    } catch (error) { await say(error?.message || 'That did not work.'); }
    selection = null;
    await readThreads(bot.id, true); draw(true);
  }

  const toggleSelected = id => { if (!selection) return; selection.ids.has(id) ? selection.ids.delete(id) : selection.ids.add(id); draw(true); };
  const paintSelection = () => { for (const count of list.querySelectorAll('.bots-selection-count')) count.textContent = `${selection?.ids.size || 0} selected`; };
  function selectionBar(bot) {
    const count = h('span', { class: 'bots-selection-count', 'aria-live': 'polite', text: `${selection.ids.size} selected` });
    const act = (label, fn, danger = false) => h('button', { type: 'button', class: `bots-btn small${danger ? ' danger' : ''}`, text: label, onclick: fn });
    return h('div', { class: 'bots-selection-bar', role: 'group', 'aria-label': 'Selected conversations' }, [count,
      act('Archive', async () => {
        const ids = [...selection.ids]; selection = null;
        await run(async () => { for (const id of ids) await api.archive(bot.id, id); }, bot.id);
      }),
      act('Delete', () => selection.ids.size && deleteThreads(bot, [...selection.ids]), true),
      act('Cancel', () => { selection = null; draw(true); })]);
  }

  // -- Open and close, order ------------------------------------------------------
  function toggleBot(id) {
    const open = isOpen(id);
    savePrefs({ expanded: open ? prefs.expanded.filter(x => x !== id) : [...prefs.expanded, id] });
    if (!open) readThreads(id, true).then(() => draw(true));
    draw(true);
  }
  function toggleFolder(agentId, folderId) {
    const key = `${agentId}:${folderId}`;
    savePrefs({ closedFolders: prefs.closedFolders.includes(key) ? prefs.closedFolders.filter(x => x !== key) : [...prefs.closedFolders, key] });
    draw(true);
  }
  // Alt and the arrow keys move a pinned circle or a section; the same change a drag would make.
  function keyReorder(event, kind, id) {
    if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    if (kind === 'pin') {
      const order = pinnedBotList().map(bot => bot.id);
      savePrefs({ pinnedOrder: reorder(order, id, offset) });
      announce('Pinned bots reordered');
    } else {
      savePrefs({ sections: reorder(prefs.sections, id, offset) });
      announce('Sections reordered');
    }
    draw(true);
    const key = kind === 'pin' ? `pin:${id}` : `section:${id}`;
    list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  const pinnedBotList = () => orderedPins(bots(), [...pinnedIds].map(id => ({ id, pinned: true })), prefs.pinnedOrder);

  function sectionBlock(id, label, body, count) {
    const collapsed = prefs.collapsed.includes(id);
    const head = h('button', { type: 'button', class: 'bots-section-head', 'aria-expanded': String(!collapsed), 'data-key': `section:${id}`,
      title: 'Alt and the arrow keys move this section',
      onclick: () => { savePrefs({ collapsed: collapsed ? prefs.collapsed.filter(x => x !== id) : [...prefs.collapsed, id] }); draw(true); } },
      [icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 12 }), h('span', { class: 'bots-caps', text: label }), h('span', { class: 'bots-folder-count', text: String(count) })]);
    head.addEventListener('keydown', event => keyReorder(event, 'section', id));
    const wrap = h('div', { class: 'bots-rail-section', 'data-section': id }, [head]);
    if (!collapsed) wrap.append(body);
    return wrap;
  }

  // -- Draw --------------------------------------------------------------------------
  const focusKey = () => document.activeElement?.closest?.('#nav [data-key]')?.dataset.key || '';
  function draw(force = false) {
    if (disposed) return;
    const advanced = isAdvanced();
    const roster = bots(), hidden = archivedBots(agents);
    const hold = focusKey();
    const facts = roster.map(railRow);
    const rows = [...threads.entries()].map(([id, data]) => [id, data.rows.map(r => [r.id, r.title, r.status, r.updated_at, r.thread?.pinned, r.thread?.unread, r.thread?.folder_id, r.thread?.snoozed_until])]);
    const next = JSON.stringify([advanced, prefs, departments, rooms, facts, roster.map(b => [b.id, b.color, b.avatar, b.folders, b.section]), hidden.length, [...pinnedIds], query, rows, root.dataset.botsAgent, root.dataset.botsSession, [...showAll],
      renaming, selection && [selection.agentId, [...selection.ids]]]);
    if (!force && next === signature) { markActive(); return; }
    signature = next;
    section.dataset.interface = advanced ? 'advanced' : 'simple';
    search.hidden = false;
    const nodes = [];
    if (searchReady(query)) nodes.push(searchResults(roster));
    else if (!advanced) nodes.push(...simpleRail(roster));
    else nodes.push(...advancedRail(roster));
    if (!roster.length) nodes.push(h('p', { class: 'bots-rail-empty', text: 'No bots yet.' }));
    list.replaceChildren(...nodes);
    archived.hidden = !hidden.length;
    archived.querySelector('.bots-rail-archived-label').textContent = `Archived (${hidden.length})`;
    archived.setAttribute('aria-label', `Archived bots, ${hidden.length}`);
    if (hold) list.querySelector(`[data-key="${CSS.escape(hold)}"]`)?.focus({ preventScroll: true });
    markActive();
  }

  function simpleRail(roster) {
    const pinned = pinnedBotList();
    const out = [];
    if (pinned.length) out.push(h('div', { class: 'bots-pins', role: 'group', 'aria-label': 'Pinned bots' }, pinned.map(pinCircle)));
    out.push(channelsBlock(), ...teamBlocks(roster, false));
    return out;
  }

  function advancedRail(roster) {
    const pinned = pinnedBotList();
    const needing = attentionBots(roster, stateOf);
    const blocks = {
      channels: channelsBlock,
      pinned: () => pinned.length && sectionBlock('pinned', 'Pinned', h('div', { class: 'bots-rail-group', role: 'list' }, pinned.map(bot => botRow(bot, { section: 'pinned:' }))), pinned.length),
      attention: () => needing.length && sectionBlock('attention', 'Needs attention', h('div', { class: 'bots-rail-group', role: 'list' }, needing.map(bot => botRow(bot, { section: 'attention:' }))), needing.length),
      bots: () => roster.length && sectionBlock('bots', 'Bots', h('div', { class: 'bots-rail-group', role: 'list' }, teamBlocks(roster, true)), roster.length),
    };
    return prefs.sections.map(id => blocks[id]?.()).filter(Boolean);
  }

  function channelsBlock() {
    const add = h('button', { type: 'button', class: 'bots-rail-newthread', onclick: () => openNewRoom() }, [icon('plus', { size: 13 }), h('span', { text: 'New room' })]);
    return sectionBlock('channels', 'Channels', h('div', { class: 'bots-rail-group' }, [
      ...rooms.filter(r => !r.archived_at).map(room => { const r = roomRow(room); return h('button', { type: 'button', class: 'bots-rail-room', 'data-room-id': r.id, 'data-working': String(r.working),
        'aria-label': `${r.name}${r.working ? ', Working' : ''}${r.unread ? `, ${r.unread} unread` : ''}`, onclick: () => teamNavigate('botsRoom', { roomId: r.id }) }, [
        icon('hash', { size: 16 }), h('span', { class: 'bots-thread-title', text: r.name }), r.working ? h('span', { class: 'bots-status-dot', 'data-state': 'working' }) : null,
        r.unread ? h('span', { class: 'bots-rail-count', text: String(Math.min(99, r.unread)) }) : null]); }), add,
    ]), rooms.length);
  }
  function teamBlocks(roster, tree) {
    return teamGroups(roster, departments, prefs.teamOrder).map(team => {
      if (team.ungrouped) return h('div', { class: 'bots-rail-group' }, team.members.flatMap(bot => [botRow(bot, { tree }), tree && isOpen(bot.id) ? botChildren(bot) : null].filter(Boolean)));
      const closed = prefs.closedTeams.includes(team.id);
      const toggle = h('button', { type: 'button', class: 'bots-section-head', 'aria-expanded': String(!closed), 'data-key': `team:${team.id}`, onclick: () => {
        savePrefs({ closedTeams: closed ? prefs.closedTeams.filter(id => id !== team.id) : [...prefs.closedTeams, team.id] }); draw(true);
      } }, [icon(closed ? 'chevron-right' : 'chevron-down', { size: 12 }), h('span', { class: 'bots-folder-name', text: team.name }), team.chief_bot_id ? icon('crown', { size: 13, label: 'Chief of Staff' }) : null]);
      toggle.addEventListener('keydown', e => {
        if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault(); savePrefs({ teamOrder: reorder(teamGroups(roster, departments, prefs.teamOrder).map(t => t.id), team.id, e.key === 'ArrowUp' ? -1 : 1) }); draw(true);
        list.querySelector(`[data-key="${CSS.escape(`team:${team.id}`)}"]`)?.focus();
      });
      const more = h('button', { type: 'button', class: 'bots-rail-more', 'aria-label': `Options for ${team.name}`, onclick: () => openMenu(more, [
        { label: 'Manage bots', iconName: 'users', onSelect: () => openTeamDialog({ departmentId: team.id }) },
        { label: 'Team instructions', iconName: 'book-open', onSelect: () => openTeamInstructions({ departmentId: team.id }) },
        { label: 'Team memory', iconName: 'brain', onSelect: () => openTeamMemory({ departmentId: team.id }) },
        { label: 'Team settings', iconName: 'settings', onSelect: () => openTeamSettings({ departmentId: team.id }) },
        { label: 'Rename', iconName: 'pencil', onSelect: () => openTeamDialog({ departmentId: team.id, mode: 'rename' }) },
        { label: 'Delete', iconName: 'trash-2', danger: true, onSelect: () => openTeamDialog({ departmentId: team.id, mode: 'delete' }) },
      ], { align: 'end' }) }, [icon('ellipsis', { size: 14 })]);
      return h('div', { class: 'bots-rail-team', 'data-department-id': team.id }, [h('div', { class: 'bots-rail-line' }, [toggle, more]),
        closed ? null : h('div', { class: 'bots-rail-group' }, team.members.flatMap(bot => [botRow(bot, { tree }), tree && isOpen(bot.id) ? botChildren(bot) : null].filter(Boolean)))]);
    });
  }

  function searchResults(roster) {
    const found = searchMatches(query, roster, Object.fromEntries([...threads.entries()].map(([id, data]) => [id, data.rows])));
    const out = [];
    if (found.bots.length) out.push(h('div', { class: 'bots-rail-group', role: 'list', 'aria-label': 'Bots found' }, found.bots.map(bot => botRow(bot, { section: 'found:' }))));
    if (found.threads.length) {
      out.push(h('div', { class: 'bots-rail-group', role: 'list', 'aria-label': 'Conversations found' }, found.threads.map(({ agentId, row }) => {
        const bot = botById(agentId), fact = threadRowFacts(row);
        const button = h('button', { type: 'button', class: 'nav-item bots-search-thread', 'data-key': `found:thread:${row.id}`, role: 'listitem', 'aria-label': `${fact.title}, with ${bot?.name || 'a bot'}`,
          onclick: () => openThread(agentId, row.id) }, [agentAvatar(bot || { id: agentId }, 20),
          h('span', { class: 'bots-thread-title', text: fact.title }), h('span', { class: 'bots-search-owner', text: bot?.name || '' })]);
        return button;
      })));
    }
    if (!found.bots.length && !found.threads.length) out.push(h('p', { class: 'bots-rail-empty', role: 'status', text: 'Nothing found.' }));
    return h('div', { class: 'bots-rail-results' }, out);
  }

  // The open bot's row is marked here, not by app.js: every row shares one tab id.
  const markActive = () => {
    const open = root.dataset.botsAgent || '';
    for (const row of list.querySelectorAll('.bots-rail-row')) {
      const on = !!open && row.dataset.agentId === open;
      row.classList.toggle('active', on);
      if (on) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
    }
    for (const circle of list.querySelectorAll('.bots-pin-circle')) circle.classList.toggle('active', !!open && circle.dataset.agentId === open);
  };

  async function refresh() {
    const at = ++version;
    try {
      const { api: request } = await import('./api.js');
      const [next, convos, teamData] = await Promise.all([request('/api/agents'), request('/api/agents/conversations').catch(() => null), request('/api/bot-team/map', { toast: false }).catch(() => null)]);
      if (disposed || at !== version || !Array.isArray(next)) return;
      agents = next;
      if (teamData) { departments = teamData.departments || teamData.teams || []; rooms = teamData.rooms || []; }
      const automationData = await request('/api/bot-automations').catch(() => ({ items: [] }));  // a missing count never stops the roster refresh
      if (disposed || at !== version) return;
      const needs = needsYouCount(buildItems(automationData.items || automationData.automations || []));
      automationBadge.hidden = needs === 0;
      automations.setAttribute('aria-label', needs ? `Automations, ${needs} need you` : 'Automations');
      if (convos?.agents) pinnedIds = new Set(convos.agents.filter(item => item.pinned).map(item => item.id));
      // A bot's folders ride on the bot record; keep each loaded list in step with it.
      for (const [id, data] of threads) { const bot = botById(id); if (bot && Array.isArray(bot.folders)) data.folders = bot.folders; }
      await readWanted(false);
      draw();
    } catch {
      if (!disposed && at === version && !agents.length) list.replaceChildren(h('p', { class: 'bots-rail-empty', text: 'Bots could not load.' }));
    }
  }

  const onKey = event => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'n') return;
    if (root.dataset.appMode !== 'bots') return;
    event.preventDefault(); openNewBot();
  };
  const sync = () => {
    view.querySelectorAll('button').forEach(b => { const on = b.dataset.value === interfaceNow(); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    applyWidth(); readWanted(false).then(() => draw(true));
  };
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => { query = search.value; await readWanted(false); draw(true); if (searchReady(query)) announce('Search results updated'); }, SEARCH_DELAY);
  });
  search.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !search.value) return;
    event.preventDefault(); event.stopPropagation(); search.value = ''; query = ''; clearTimeout(searchTimer); draw(true);
  });
  const offInterface = onBotsInterface(sync);
  const onSelected = () => { readWanted(false).then(() => draw()); markActive(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('jarvis:agents-changed', refresh);
  document.addEventListener('kairos:bots-selected', onSelected);
  document.addEventListener('kairos:bots-threads-changed', onSelected);
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  // The person's name keys the preferences; until it is known the local ones apply.
  lazyApi('/api/auth/status').then(status => { if (disposed || !status?.username) return; user = status.username; loadPrefs(); applyWidth(); draw(true); }).catch(() => {});
  loadPrefs(); applyWidth();
  refresh();
  return () => {
    disposed = true; ++version; clearInterval(timer); clearTimeout(searchTimer); offInterface(); classWatch.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('jarvis:agents-changed', refresh);
    document.removeEventListener('kairos:bots-selected', onSelected);
    document.removeEventListener('kairos:bots-threads-changed', onSelected);
    document.removeEventListener('kairos:bots-prefs', onPrefs);
    desktop.removeEventListener('change', applyWidth); removeEventListener('resize', applyWidth);
    root.style.removeProperty('--sidebar-width'); delete root.dataset.botsDensity;
    separator.remove();
    section.remove();
  };
}
