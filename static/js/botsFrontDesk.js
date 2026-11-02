import { h, loadBotsCss, withBotColor } from './botsUi.js';
import { botKip } from './botsKip.js';
import { loadBotsModule, toggleBotSettings, closeBotSettings } from './botsPanelHost.js';
import { TABS, tabFor, badgeCount, badgeDigits, stepPill, kipState, watchLine, todayView } from './botsFrontDeskModel.js';
import { icon } from './botsIcons.js';

const sharedApi = async (...args) => (await import('./api.js')).api(...args);
const dispose = handle => typeof handle === 'function' ? handle() : (handle?.dispose || handle?.destroy)?.call(handle);
let nextId = 0;
// Two glyphs Lucide's Bots set does not carry; drawn from our own fixed strings, never from data.
const GLYPHS = {
  menu: '<path d="M4 7h16M4 12h12M4 17h16"/>',
  tasks: '<path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9"/>',
};
const glyph = name => { const node = h('span', { class: 'fd-glyph', 'aria-hidden': 'true' }); node.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]}</svg>`; return node; };
const TAB_ICONS = { chat: () => icon('message-square', { size: 20 }), tasks: () => glyph('tasks'), make: () => icon('pencil', { size: 20 }) };
// The Today panel shows beside the chat when there is room for it (sidebar, a 720px chat and the panel).
const wide = typeof matchMedia === 'function' ? matchMedia('(min-width: 1180px)') : { matches: false, addEventListener() {}, removeEventListener() {} };

// Synchronous lifecycle, even while a section is loading. A stale mount is always disposed.
export function mountFrontDesk(host, options = {}) {
  loadBotsCss('/static/css/bots.css'); loadBotsCss('/static/css/bots-frontdesk.css');
  const { agent, sessionId, api = sharedApi } = options;
  const navigate = options.navigate || (target => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: target })));
  const call = (path, body) => api(path, { cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const id = `fd-${++nextId}`;
  let disposed = false, selected = tabFor(options.tab || 'chat'), needsCount = 0, pendingRefresh = false;
  let live = {}, draft = '', answeredAt = null, finishedAt = null, changedAt = Date.now(), stepKey = '', kipPose = '';
  const handles = new Map(), mounting = new Map(), offs = [], timers = new Set();
  const kip = botKip(agent, { size: 54, beat: 'arrive' });
  const settings = h('button', { type: 'button', class: 'fd-identity', 'aria-label': `${agent.name}, settings and details`, onclick: () => toggleBotSettings(agent.id, settings) }, [kip, h('span', { class: 'fd-name', text: agent.name })]);
  // What Kip watches: under its name on a desktop, at the top of the composer on a phone.
  const watchHead = h('p', { class: 'fd-watching', hidden: true });
  const watchDock = h('p', { class: 'fd-watching fd-watching-dock', hidden: true });
  // A phone gets Kip's own floating controls: the bots list on the left, the account on the right.
  const menu = h('button', { type: 'button', class: 'fd-float fd-menu', 'aria-label': 'All bots and rooms', 'aria-haspopup': 'dialog',
    onclick: () => import('./mobileBots.js').then(m => m.openBotsList(menu)) }, [glyph('menu')]);
  const account = h('button', { type: 'button', class: 'fd-float fd-account', 'aria-label': 'Account and settings', 'aria-haspopup': 'dialog',
    onclick: () => import('./mobileTabSheet.js').then(m => m.openMoreSheet(account)) }, [icon('user', { size: 20 })]);
  const today = h('aside', { class: 'fd-today', 'aria-label': 'Today', hidden: true });
  const step = h('div', { class: 'fd-step', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const tabs = h('div', { class: 'fd-tabs', role: 'tablist', 'aria-label': 'Front desk' });
  const panels = new Map(), buttons = new Map();
  const pages = h('div', { class: 'fd-pages' });
  for (const tab of TABS) {
    const button = h('button', { type: 'button', role: 'tab', id: `${id}-${tab}`, 'aria-controls': `${id}-${tab}-page`, 'data-fd-tab': tab,
      onclick: () => selectTab(tab) }, [TAB_ICONS[tab](), h('span', { class: 'fd-tab-label', text: tab[0].toUpperCase() + tab.slice(1) })]);
    if (tab === 'tasks') button.append(h('span', { class: 'fd-badge', hidden: true, 'aria-hidden': 'true' }));
    const panel = h('section', { class: `fd-page fd-page-${tab}`, role: 'tabpanel', id: `${id}-${tab}-page`, 'aria-labelledby': button.id, tabindex: '0' });
    tabs.append(button); pages.append(panel); buttons.set(tab, button); panels.set(tab, panel);
  }
  const header = h('header', { class: 'fd-header' }, [
    h('button', { type: 'button', class: 'bots-btn fd-back', text: 'All bots', onclick: () => navigate({ tab: 'botsHome' }) }), menu,
    h('div', { class: 'fd-header-main' }, [settings, watchHead, step]), account]);
  const root = h('div', { class: 'bots-shell bots-frontdesk', 'data-agent-id': agent.id, 'data-bot-name': agent.name }, [header, tabs, h('div', { class: 'fd-body' }, [pages, today])]);
  withBotColor(root, agent.color); host.replaceChildren(root);

  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, ms); timers.add(timer); return timer; };
  function paint() {
    const needs = !!live.permission || !!live.needs_input;
    const working = live.status === 'processing' || live.working === true;
    step.textContent = stepPill({ working, needs, step: live.step, changedAt });
    step.dataset.active = String(!!step.textContent);
    const pose = kipState({ needs, working, draft, answeredAt, finishedAt, tab: selected, off: agent.enabled === false });
    if (pose !== kipPose) { kipPose = pose; kip.setState(pose); }
    root.dataset.kipState = pose;
  }
  function setLive(entry = {}) {
    const nextStep = entry.step || [...(entry.toolSteps || [])].reverse().find(s => s.summary)?.summary || '';
    const key = `${entry.turnId || ''}:${nextStep}`;
    if (key !== stepKey || (entry.status === 'processing' && live.status !== 'processing')) { changedAt = Date.now(); stepKey = key; }
    if (live.status === 'processing' && entry.status === 'done') { answeredAt = Date.now(); later(paint, 2600); }
    live = { ...entry, step: nextStep }; paint();
  }
  function setBadge(work) {
    needsCount = badgeCount(work); const badge = tabs.querySelector('.fd-badge');
    const value = badgeDigits(needsCount);
    if (badge.textContent !== value) { badge.textContent = value; badge.dataset.change = String(Date.now()); badge.classList.remove('fd-pop'); void badge.offsetWidth; badge.classList.add('fd-pop'); }
    badge.hidden = !value;
    buttons.get('tasks').setAttribute('aria-label', needsCount ? `Tasks, ${needsCount} need input` : 'Tasks');
  }
  function notice(tab, retry) {
    panels.get(tab).replaceChildren(h('div', { class: 'fd-notice', role: 'alert' }, [h('p', { text: `Could not load ${tab}.` }),
      h('button', { type: 'button', class: 'bots-btn', text: 'Try again', onclick: retry })]));
  }
  async function mountTab(tab) {
    if (handles.has(tab) || mounting.has(tab)) return mounting.get(tab);
    const panel = panels.get(tab);
    const promise = (async () => {
      try {
        let module;
        if (tab === 'chat') module = await loadBotsModule('frontdesk:chat').catch(() => import('./botsChat.js'));
        else module = await loadBotsModule(`section:${tab === 'tasks' ? 'Work' : 'Make'}`);
        if (disposed) return;
        const mount = tab === 'chat' ? module.mountBotsChat : module.mount;
        if (typeof mount !== 'function') throw new Error('Missing mount');
        const handle = await mount(panel, { ...options, agent, agentId: agent.id, sessionId, api, navigate,
          onWorkChanged: setBadge, onNeedsInputCount: n => setBadge({ needs_input_count: n }),
          onFinished: finish, onThreadChanged: (...args) => { refresh(); options.onThreadChanged?.(...args); } });
        if (disposed) dispose(handle); else handles.set(tab, handle || {});
        if (tab === 'chat') panel.querySelector('.bots-composer')?.prepend(watchDock);
      } catch { if (!disposed) notice(tab, () => { mounting.delete(tab); mountTab(tab); }); }
      finally { mounting.delete(tab); }
    })();
    mounting.set(tab, promise); return promise;
  }
  function selectTab(value, { focus = false } = {}) {
    const next = tabFor(value), before = selected; selected = next;
    tabs.style.setProperty('--fd-tab-index', TABS.indexOf(next));
    root.dataset.tab = next;
    for (const tab of TABS) {
      const on = tab === next;
      buttons.get(tab).setAttribute('aria-selected', String(on)); buttons.get(tab).tabIndex = on ? 0 : -1;
      panels.get(tab).hidden = !on; panels.get(tab).inert = !on;
    }
    if (focus) buttons.get(next).focus();
    mountTab(next).then(() => { if (before !== next && !disposed && selected === next) handles.get(next)?.refresh?.(); });
    paint(); options.onTabChanged?.(next);
  }
  tabs.addEventListener('keydown', event => {
    const index = TABS.indexOf(selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : -1;
    if (next >= 0) { event.preventDefault(); selectTab(TABS[next], { focus: true }); }
  });
  root.addEventListener('input', event => { if (panels.get('chat').contains(event.target) && event.target.matches('textarea, [contenteditable="true"]')) { draft = event.target.value ?? event.target.textContent; paint(); } });
  function finish() { finishedAt = Date.now(); kip.beat('celebrate'); paint(); later(paint, 2600); }
  const finished = event => { if (!event.detail?.agentId || event.detail.agentId === agent.id) finish(); };
  document.addEventListener('kairos:frontdesk-finished', finished); offs.push(() => document.removeEventListener('kairos:frontdesk-finished', finished));
  async function refresh() {
    if (disposed || pendingRefresh) return;
    pendingRefresh = true;
    try { const work = await call('/api/front-desk/work'); if (!disposed) setBadge(work); }
    catch { /* Retain the last known count. The Tasks view offers its own retry. */ }
    finally { pendingRefresh = false; }
  }
  // -- What Kip watches, and the Today panel ------------------------------------------
  let tabCards = [], watching = null;
  async function readCards() {
    try { const value = await call('/api/home/tab-cards'); tabCards = Array.isArray(value?.cards) ? value.cards : []; } catch { /* Keep the last cards. */ }
  }
  async function loadWatch() {
    try { watching = await call('/api/front-desk/watch'); } catch { watching = null; }
    if (disposed) return;
    const line = watchLine(watching, [...new Set(tabCards.map(card => card.tab_name).filter(Boolean))]);
    for (const node of [watchHead, watchDock]) { node.textContent = line; node.hidden = !line; node.dataset.on = String(watching?.state === 'working'); }
  }
  async function loadToday() {
    if (disposed || !wide.matches) { today.hidden = true; return; }
    let brief;
    try { brief = await call('/api/front-desk/today'); } catch { return; }  // A failed read keeps what is drawn.
    if (disposed) return;
    const view = todayView(brief, tabCards);
    const row = item => h('div', { class: 'fd-today-row' }, [h('p', { text: item.text }), item.note ? h('p', { class: 'fd-caption', text: item.note }) : null]);
    const block = part => h('section', { class: 'fd-today-section', 'data-section': part.id }, [
      h('h3', { text: part.label }), part.title && part.title !== part.label ? h('p', { class: 'fd-caption', text: part.title }) : null,
      ...(part.rows.length ? part.rows.map(row) : [h('p', { class: 'fd-caption', text: part.empty })]),
      part.more ? h('p', { class: 'fd-caption', text: `${part.more} more` }) : null]);
    today.replaceChildren(...[h('h2', { class: 'fd-today-title', text: 'Today' }), view.date ? h('p', { class: 'fd-caption', text: view.date }) : null,
      ...view.sections.map(block), ...view.tabs.map(block),
      h('button', { type: 'button', class: 'bots-btn fd-today-add', text: 'Add a tab for Kip to watch', onclick: () => navigate({ tab: 'tool-store' }) })].filter(Boolean));
    today.hidden = false;
  }
  const onWide = () => { loadToday(); };
  wide.addEventListener('change', onWide); offs.push(() => wide.removeEventListener('change', onWide));
  const around = async () => { await readCards(); await Promise.all([loadWatch(), loadToday()]); later(around, 300000); };
  around();
  const onWork = event => { if (event.detail?.groups || Number.isFinite(event.detail?.needs_input_count)) setBadge(event.detail); else refresh(); };
  document.addEventListener('kairos:frontdesk-work', onWork); offs.push(() => document.removeEventListener('kairos:frontdesk-work', onWork));
  const loop = () => { paint(); later(loop, 1000); }; later(loop, 1000);
  const poll = async () => { await refresh(); later(poll, 15000); }; poll();
  // Subscription is lazy so a shell fixture does not need the whole chat runtime.
  import('./chatStream.js').then(stream => {
    if (disposed) return;
    offs.push(stream.subscribe(sessionId, setLive));
    const current = stream.getInFlight(sessionId); if (current) setLive(current);
  }).catch(() => {});
  selectTab(selected);
  return { selectTab, refresh, setLive, setBadge, finish,
    dispose() { if (disposed) return; disposed = true; for (const off of offs) off(); for (const timer of timers) clearTimeout(timer); for (const handle of handles.values()) dispose(handle); clearTimeout(kip._beatTimer); closeBotSettings({ restoreFocus: false }); root.remove(); } };
}
