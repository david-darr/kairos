import { el } from './api.js';
import { isAdvanced, loadBotsCss, onBotsInterface } from './botsUi.js';
import { openBotSettings } from './botsPanelHost.js';
import { WIDTH_KEY, clampWidth, tabsFor, lifetime } from './botsWorkbenchModel.js';

let current = null;
export const workbenchState = () => current ? { open: true, agentId: current.agentId, tab: current.tab } : { open: false };
export function onWorkbenchChange(fn) {
  const handler = event => fn(event.detail);
  document.addEventListener('kairos:bots-workbench', handler);
  return () => document.removeEventListener('kairos:bots-workbench', handler);
}
const announce = () => document.dispatchEvent(new CustomEvent('kairos:bots-workbench', { detail: workbenchState() }));
export function closeWorkbench({ restoreFocus = true } = {}) {
  if (!current) return;
  const previous = current; current = null;
  previous.handle.destroy();
  previous.aside.remove();
  if (restoreFocus && previous.opener?.isConnected) previous.opener.focus({ preventScroll: true });
  announce();
}

export async function mount(host, ctx) {
  loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx);
  let tabHandle = null, generation = 0, width = 400;
  try { width = clampWidth(localStorage.getItem(WIDTH_KEY)); } catch { /* device preference is optional */ }
  const resize = el('div', { class: 'bots-workbench-resize', role: 'separator', tabindex: '0', 'aria-label': 'Workbench width', 'aria-orientation': 'vertical', 'aria-valuemin': '360', 'aria-valuemax': '960' });
  const tabs = el('div', { class: 'bots-workbench-tabs', role: 'tablist', 'aria-label': 'Workbench' });
  const body = el('div', { class: 'bots-workbench-body', role: 'tabpanel', id: 'bots-workbench-tabpanel' });
  const root = el('div', { class: 'bots-workbench-content' }, [resize, el('header', { class: 'bots-workbench-header' }, [tabs,
    el('button', { type: 'button', class: 'bots-btn', text: 'Close', onclick: () => ctx.onClose?.() })]), body]);
  host.replaceChildren(root);
  const setWidth = value => {
    width = clampWidth(value); host.style.setProperty('--bots-workbench-width', `${width}px`);
    resize.setAttribute('aria-valuenow', String(width));
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* memory only */ }
  };
  setWidth(width);
  resize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); setWidth(event.key === 'Home' ? 360 : event.key === 'End' ? 960 : width + (event.key === 'ArrowLeft' ? 24 : -24));
  });
  resize.addEventListener('pointerdown', event => { resize.setPointerCapture(event.pointerId); });
  resize.addEventListener('pointermove', event => { if (resize.hasPointerCapture(event.pointerId)) setWidth(host.getBoundingClientRect().right - event.clientX); });
  resize.addEventListener('pointerup', event => { if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId); });
  const loaders = { computer: () => import('./botsWorkbenchComputer.js'), browser: () => import('./botsWorkbenchBrowser.js'),
    data: () => import('./botsWorkbenchData.js'), files: () => import('./botsWorkbenchFiles.js'), routines: () => import('./botsSectionRoutines.js') };
  async function select(tab) {
    if (!tabsFor(isAdvanced()).includes(tab)) tab = 'computer';
    const own = ++generation;
    tabHandle?.destroy?.(); tabHandle?.dispose?.(); tabHandle = null;
    // Abort old tab requests before loading the new one.
    tabLife?.destroy(); tabLife = lifetime({ signal: life.signal });
    const signal = tabLife.signal;
    if (current?.aside === host) { current.tab = tab; announce(); }
    for (const button of tabs.querySelectorAll('[role=tab]')) { const active = button.dataset.tab === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
    body.setAttribute('aria-label', tab[0].toUpperCase() + tab.slice(1));
    body.replaceChildren(el('p', { role: 'status', text: 'Loading workbench' }));
    try {
      const module = await loaders[tab]();
      if (!life.active || generation !== own) return;
      const handle = await module.mount(body, { ...ctx, advanced: isAdvanced(), signal });
      if (!life.active || generation !== own) { (handle.destroy || handle.dispose)?.(); return; }
      tabHandle = handle;
    } catch (e) { if (life.active && generation === own) body.replaceChildren(el('p', { role: 'alert', text: `This tab could not load. ${e.message}` }), el('button', { class: 'bots-btn', text: 'Retry', onclick: () => select(tab) })); }
  }
  let tabLife;
  function drawTabs() {
    tabs.replaceChildren(...tabsFor(isAdvanced()).map(tab => el('button', { type: 'button', role: 'tab', class: 'bots-workbench-tab',
      'aria-controls': body.id, 'aria-selected': 'false', 'data-tab': tab, text: tab[0].toUpperCase() + tab.slice(1), onclick: () => select(tab) })));
    if (isAdvanced()) tabs.append(el('button', { type: 'button', class: 'bots-btn', text: 'Settings', onclick: () => openBotSettings(ctx.agentId, { section: 'access' }) }));
  }
  tabs.addEventListener('keydown', event => {
    const items = [...tabs.querySelectorAll('[role=tab]')], index = items.indexOf(event.target);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items[next].focus(); select(items[next].dataset.tab);
  });
  drawTabs();
  life.own(onBotsInterface(() => { drawTabs(); select(current?.tab || 'computer'); }));
  life.own(() => { generation++; tabLife?.destroy(); (tabHandle?.destroy || tabHandle?.dispose)?.(); root.remove(); });
  const activity = event => { for (const button of tabs.querySelectorAll('[role=tab]')) button.classList.toggle('is-busy', event.detail?.agentId === ctx.agentId && event.detail?.tab === button.dataset.tab && !!event.detail?.busy); };
  document.addEventListener('kairos:bots-workbench-activity', activity); life.own(() => document.removeEventListener('kairos:bots-workbench-activity', activity));
  await select(ctx.tab || 'computer');
  return { ...life.handle(() => tabHandle?.refresh?.()), select };
}

export async function openWorkbench(agentId, options = {}) {
  if (current?.agentId === agentId && current.aside.isConnected) { await current.handle.select(options.tab || 'computer'); return current.handle; }
  closeWorkbench({ restoreFocus: false });
  const shell = document.querySelector('.bots-shell');
  const opener = options.opener || document.activeElement;
  const aside = el('aside', { class: 'bots-workbench', role: 'dialog', 'aria-label': 'Bot workbench', tabindex: '-1' });
  (shell || document.body).append(aside);
  const life = lifetime();
  const state = { agentId, tab: options.tab || 'computer', aside, opener, handle: life.handle(async () => {}) };
  current = state;
  const onKey = event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open], .bots-menu')) { event.preventDefault(); closeWorkbench(); }
    if (event.key === 'Tab' && matchMedia('(max-width: 767px)').matches) {
      const nodes = [...aside.querySelectorAll('button, input, select, [tabindex="0"]')].filter(n => !n.disabled && n.offsetParent !== null);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && [first, aside].includes(document.activeElement)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  document.addEventListener('keydown', onKey); life.own(() => document.removeEventListener('keydown', onKey));
  const observer = new MutationObserver(() => { if (!aside.isConnected && current === state) closeWorkbench({ restoreFocus: false }); });
  observer.observe(document.body, { childList: true, subtree: true }); life.own(() => observer.disconnect());
  announce(); aside.focus({ preventScroll: true });
  const handle = await mount(aside, { agentId, threadId: options.threadId, tab: state.tab, signal: life.signal, onClose: closeWorkbench, ...options.ctx });
  life.own(handle.destroy);
  if (current === state) state.handle = { ...handle, destroy: life.destroy };
  else handle.destroy();
  return state.handle;
}
