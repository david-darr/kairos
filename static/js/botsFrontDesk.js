import { h, loadBotsCss, withBotColor } from './botsUi.js';
import { botKip } from './botsKip.js';
import { loadBotsModule, toggleBotSettings, closeBotSettings } from './botsPanelHost.js';
import { TABS, tabFor, badgeCount, badgeDigits, stepPill, kipState } from './botsFrontDeskModel.js';

const sharedApi = async (...args) => (await import('./api.js')).api(...args);
const dispose = handle => typeof handle === 'function' ? handle() : (handle?.dispose || handle?.destroy)?.call(handle);
let nextId = 0;

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
  const settings = h('button', { type: 'button', class: 'fd-identity', 'aria-label': `${agent.name}, settings and details`, onclick: () => toggleBotSettings(agent.id, settings) }, [kip, h('span', { text: agent.name })]);
  const step = h('div', { class: 'fd-step', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const tabs = h('div', { class: 'fd-tabs', role: 'tablist', 'aria-label': 'Front desk' });
  const panels = new Map(), buttons = new Map();
  const pages = h('div', { class: 'fd-pages' });
  for (const tab of TABS) {
    const button = h('button', { type: 'button', role: 'tab', id: `${id}-${tab}`, 'aria-controls': `${id}-${tab}-page`, 'data-fd-tab': tab,
      onclick: () => selectTab(tab) }, [h('span', { text: tab[0].toUpperCase() + tab.slice(1) })]);
    if (tab === 'tasks') button.append(h('span', { class: 'fd-badge', hidden: true, 'aria-hidden': 'true' }));
    const panel = h('section', { class: `fd-page fd-page-${tab}`, role: 'tabpanel', id: `${id}-${tab}-page`, 'aria-labelledby': button.id, tabindex: '0' });
    tabs.append(button); pages.append(panel); buttons.set(tab, button); panels.set(tab, panel);
  }
  const header = h('header', { class: 'fd-header' }, [
    h('button', { type: 'button', class: 'bots-btn fd-back', text: 'All bots', onclick: () => navigate({ tab: 'botsHome' }) }),
    h('div', { class: 'fd-header-main' }, [settings, step]), tabs]);
  const root = h('div', { class: 'bots-shell bots-frontdesk', 'data-agent-id': agent.id, 'data-bot-name': agent.name }, [header, pages]);
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
