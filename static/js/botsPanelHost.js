// The bot panel's host, and the lazy door to U4's modules (Agents 3.0 Phase 0,
// unit U3). Two jobs:
//
//  1. loadBotsModule(name): botsCreate.js, botsGallery.js, botsArchived.js and
//     botsPanel.js belong to unit U4 and load only when used, so a missing or
//     broken one shows a visible "could not load" message instead of breaking the
//     shell. stubBotsModule() lets a check replace one (a module object, or a
//     function returning one, or a rejecting function to test the failure).
//  2. The panel: one `aside role="dialog"` beside a bot's page. Simple is 320 px,
//     Advanced min(420px, 42vw) (OMB 3.4). openBotSettings(agentId, {section, page,
//     card}) is the deep link every Bots surface uses; Escape closes the panel and
//     focus goes back to what opened it. The sections inside belong to
//     botsPanel.js: mountBotPanel(host, {agentId, section, page, card, mode,
//     onClose}) draws them, and may return a cleanup function or {dispose}.
//
// Imports only botsUi.js and botsIcons.js (both load in plain Node); api.js is
// reached lazily, so scripts/test_bots_rail.cjs can load the rail.
import { loadBotsCss, isAdvanced, onBotsInterface, IconButton } from './botsUi.js';

const SHELL_CSS = '/static/css/bots-shell.css';

const LOADERS = {
  create: () => import('./botsCreate.js'),
  gallery: () => import('./botsGallery.js'),
  archived: () => import('./botsArchived.js'),
  panel: () => import('./botsPanel.js'),
};
const stubs = new Map();

export function stubBotsModule(name, stub) { stubs.set(name, stub); }
export function clearBotsStubs() { stubs.clear(); }

export async function loadBotsModule(name) {
  if (stubs.has(name)) {
    const stub = stubs.get(name);
    return typeof stub === 'function' ? stub() : stub;
  }
  // A later phase's panel section: 'section:Memory' loads botsSectionMemory.js (the panel asks the
  // server which exist first, so a file that is not there is never requested).
  const section = /^section:([A-Za-z]{1,32})$/.exec(name);
  if (section) return import(`./botsSection${section[1]}.js`);
  const load = LOADERS[name];
  if (!load) throw new Error(`There is no Bots module called ${name}`);
  return load();
}

async function say(message) {
  try { (await import('./api.js')).toast(message, 'error'); } catch { /* nowhere to show it */ }
}

// Call an export of a lazy module. A module that cannot load, or lacks the export,
// is reported to the person; an error inside the export is its own to show.
async function useModule(name, exports, what, args) {
  let run;
  try {
    const mod = await loadBotsModule(name);
    run = exports.map(key => mod?.[key]).find(fn => typeof fn === 'function');
    if (!run) throw new Error(`${name} has no ${exports[0]}`);
  } catch (error) {
    console.warn(`Bots: ${what} could not load`, error);
    await say(`${what} could not load. Try again in a moment.`);
    return undefined;
  }
  return run(...args);
}

// F1, F2, F3: the new-bot dialog. { gallery: true } opens it on the ready-made bots.
export function openNewBot(options = {}) { return useModule('create', ['openNewBot', 'default'], 'The new-bot dialog', [options]); }
// F4: the archived bots.
export function openArchived(options = {}) { return useModule('archived', ['openArchivedBots', 'openArchived', 'default'], 'The archived bots', [options]); }

// -- The panel ------------------------------------------------------------------

let panel = null;

export function botPanelState() {
  return panel ? { open: true, agentId: panel.agentId, section: panel.section } : { open: false, agentId: '', section: '' };
}
// Subscribe to the panel opening and closing; returns the unsubscribe function.
export function onBotPanelChange(fn) {
  const handler = event => fn(event.detail);
  document.addEventListener('kairos:bots-panel', handler);
  return () => document.removeEventListener('kairos:bots-panel', handler);
}
function announce() { document.dispatchEvent(new CustomEvent('kairos:bots-panel', { detail: botPanelState() })); }

const nestedOpen = () => !!document.querySelector('.bots-menu, dialog[open], .modal-panel, .custom-select-menu');

function fallback(body, retry) {
  const box = document.createElement('div');
  box.className = 'bots-panel-fallback'; box.setAttribute('role', 'alert');
  const text = document.createElement('p'); text.textContent = 'The bot panel could not load.';
  const again = document.createElement('button'); again.type = 'button'; again.className = 'bots-btn'; again.textContent = 'Try again';
  again.addEventListener('click', retry);
  box.append(text, again);
  body.replaceChildren(box);
}

async function fill(state) {
  const { body, agentId, section, page, card } = state;
  const loading = document.createElement('p');
  loading.className = 'bots-panel-loading'; loading.setAttribute('role', 'status'); loading.textContent = 'Loading';
  body.replaceChildren(loading);
  try {
    const mod = await loadBotsModule('panel');
    const mount = mod?.mountBotPanel || mod?.default;
    if (typeof mount !== 'function') throw new Error('botsPanel has no mountBotPanel');
    if (panel !== state) return;
    body.replaceChildren();
    const handle = await mount(body, { agentId, section, page, card, mode: isAdvanced() ? 'advanced' : 'simple', onClose: () => closeBotSettings() });
    const dispose = typeof handle === 'function' ? handle : handle?.dispose || handle?.destroy;
    if (panel !== state) { dispose?.(); return; }
    state.dispose = typeof dispose === 'function' ? dispose : null;
  } catch (error) {
    console.warn('Bots: the panel could not load', error);
    if (panel === state) fallback(body, () => fill(state));
  }
}

function build(shell, agentId, { section = '', page = '', card = '', opener = null } = {}) {
  loadBotsCss(SHELL_CSS);
  const name = shell.dataset.botName || 'Bot';
  const aside = document.createElement('aside');
  aside.id = 'bots-panel'; aside.className = 'bots-panel-aside bots-panel-in'; aside.tabIndex = -1;
  aside.setAttribute('role', 'dialog'); aside.setAttribute('aria-label', `${name}, settings`);
  aside.dataset.mode = isAdvanced() ? 'advanced' : 'simple';
  const bar = document.createElement('div'); bar.className = 'bots-panel-bar';
  const close = IconButton({ iconName: 'x', label: 'Close panel', onClick: () => closeBotSettings() });
  close.classList.add('bots-panel-close');
  bar.append(close);
  const body = document.createElement('div'); body.className = 'bots-panel-body';
  aside.append(bar, body);
  shell.append(aside);
  shell.dataset.panel = 'open';
  const state = { aside, body, agentId, section, page, card, opener, dispose: null, off: [] };
  const onKey = event => {
    if (event.key !== 'Escape' || event.defaultPrevented || nestedOpen()) return;
    event.preventDefault(); closeBotSettings();
  };
  document.addEventListener('keydown', onKey);
  state.off.push(() => document.removeEventListener('keydown', onKey));
  // On a phone the panel is a sheet: Tab stays inside it.
  const trap = event => {
    if (event.key !== 'Tab' || !matchMedia('(max-width: 720px)').matches) return;
    const items = [...aside.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled && !n.hidden && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === aside)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  aside.addEventListener('keydown', trap);
  // Simple and Advanced size and lay out the panel differently: draw it again.
  state.off.push(onBotsInterface(() => {
    if (panel !== state) return;
    state.dispose?.(); state.dispose = null;
    aside.dataset.mode = isAdvanced() ? 'advanced' : 'simple';
    fill(state);
  }));
  return state;
}

// Open the panel for a bot (a section id, a page inside it, a card to scroll to). Opens the
// bot's page first when it is not the one on screen, so the same call works from the rail,
// Home and a notification.
export function openBotSettings(agentId, options = {}) {
  const shell = document.querySelector('.bots-shell');
  if (!shell || shell.dataset.agentId !== agentId) {
    document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'botsShell', agentId,
      panel: options.section || true, panelPage: options.page || '', panelCard: options.card || '' } }));
    return;
  }
  const opener = options.opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (panel && panel.agentId === agentId && panel.aside.isConnected) {
    // Already open: move it to the section asked for.
    if (options.section || options.page || options.card) {
      Object.assign(panel, { section: options.section || panel.section, page: options.page || '', card: options.card || '' });
      panel.dispose?.(); panel.dispose = null;
      fill(panel);
      announce();
    }
    return;
  }
  closeBotSettings({ restoreFocus: false });
  panel = build(shell, agentId, { ...options, opener });
  announce();
  fill(panel);
  panel.aside.focus({ preventScroll: true });
}

export function closeBotSettings({ restoreFocus = true } = {}) {
  const state = panel;
  if (!state) return;
  panel = null;
  state.dispose?.();
  for (const off of state.off) off();
  state.aside.remove();
  document.querySelector('.bots-shell')?.removeAttribute('data-panel');
  if (restoreFocus && state.opener?.isConnected) state.opener.focus({ preventScroll: true });
  announce();
}

export function toggleBotSettings(agentId, opener) {
  if (panel && panel.agentId === agentId) closeBotSettings();
  else openBotSettings(agentId, { opener });
}
