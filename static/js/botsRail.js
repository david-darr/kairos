// The Bots sidebar (Agents 3.0 Phase 0, unit U3): the same shape as forgeRail.js.
// Under the Bots home button it lists the visible bots, each a `.nav-item` that
// opens that bot's page, with a "New bot" row, the Archived row and the
// Simple / Advanced switch at the foot (OMB 3.3, in Kairos's colourway through the
// --bots-* tokens in bots.css and bots-shell.css).
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
import { Segmented, isAdvanced, setAdvanced, onBotsInterface, loadBotsCss } from './botsUi.js';
import { openNewBot, openArchived } from './botsPanelHost.js';

const SHELL_CSS = '/static/css/bots-shell.css';
const POLL_MS = 10000;

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

export function openBot(agentId) {
  document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'botsShell', agentId } }));
}

export function mountBotsRail(nav) {
  // Hidden until the stylesheet is in, so the rail never shows unstyled.
  const styled = loadBotsCss(SHELL_CSS);
  let disposed = false, version = 0, agents = [], signature = '';

  const newBot = h('button', { type: 'button', class: 'nav-item bots-rail-new', 'aria-label': 'New bot', onclick: () => openNewBot() },
    [icon('plus', { size: 16 }), h('span', { text: 'New bot' })]);
  const list = h('div', { class: 'bots-rail-list', role: 'list' });
  const archived = h('button', { type: 'button', class: 'nav-item bots-rail-archived', hidden: true, onclick: () => openArchived() },
    [icon('archive', { size: 16 }), h('span', { class: 'bots-rail-archived-label' })]);
  const view = Segmented({ label: 'Interface', value: isAdvanced() ? 'advanced' : 'simple',
    options: [{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }], onChange: value => setAdvanced(value === 'advanced') });
  const foot = h('div', { class: 'bots-rail-foot' }, [view]);
  const section = h('section', { class: 'bots-rail', 'aria-label': 'Your bots' }, [
    h('div', { class: 'bots-rail-head' }, [h('span', { class: 'bots-caps', text: 'Your bots' })]),
    newBot, list, archived, foot,
  ]);
  section.style.visibility = 'hidden';
  styled.finally(() => { section.style.visibility = ''; });
  nav.append(section);

  // The open bot's row is marked here, not by app.js: every row shares one tab id.
  const markActive = () => {
    const open = document.documentElement.dataset.botsAgent || '';
    for (const row of list.querySelectorAll('.bots-rail-row')) {
      const on = !!open && row.dataset.agentId === open;
      row.classList.toggle('active', on);
      if (on) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
    }
  };
  const draw = () => {
    if (disposed) return;
    const bots = visibleBots(agents), hidden = archivedBots(agents);
    const facts = bots.map(railRow);
    const next = JSON.stringify([facts, bots.map(b => [b.id, b.color, b.avatar]), hidden.length]);
    if (next !== signature) {
      signature = next;
      list.replaceChildren(...bots.map((bot, i) => {
        const fact = facts[i];
        const row = h('button', { type: 'button', class: 'nav-item bots-rail-row', role: 'listitem', 'data-tab': 'botsShell', 'data-agent-id': bot.id,
          'data-state': fact.state, 'aria-label': fact.label, title: fact.text, onclick: () => openBot(bot.id) }, [
          agentAvatar(bot, 24),
          h('span', { class: 'bots-rail-name', text: fact.name }),
          h('span', { class: 'bots-status-dot', 'data-state': fact.state, 'aria-hidden': 'true' }),
          fact.needs ? h('span', { class: 'bots-rail-count', text: fact.needs > 99 ? '99+' : String(fact.needs) }) : null,
        ]);
        return row;
      }));
      if (!bots.length) list.append(h('p', { class: 'bots-rail-empty', text: 'No bots yet.' }));
      archived.hidden = !hidden.length;
      archived.querySelector('.bots-rail-archived-label').textContent = `Archived (${hidden.length})`;
      archived.setAttribute('aria-label', `Archived bots, ${hidden.length}`);
    }
    markActive();
  };
  async function refresh() {
    const at = ++version;
    try {
      const { api } = await import('./api.js');
      const next = await api('/api/agents');
      if (disposed || at !== version || !Array.isArray(next)) return;
      agents = next; draw();
    } catch {
      if (!disposed && at === version && !agents.length) list.replaceChildren(h('p', { class: 'bots-rail-empty', text: 'Bots could not load.' }));
    }
  }

  const onKey = event => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'n') return;
    if (document.documentElement.dataset.appMode !== 'bots') return;
    event.preventDefault(); openNewBot();
  };
  const sync = () => { view.querySelectorAll('button').forEach(b => { const on = b.dataset.value === (isAdvanced() ? 'advanced' : 'simple'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }); };
  const offInterface = onBotsInterface(sync);
  document.addEventListener('keydown', onKey);
  document.addEventListener('jarvis:agents-changed', refresh);
  document.addEventListener('kairos:bots-selected', markActive);
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  refresh();
  return () => {
    disposed = true; ++version; clearInterval(timer); offInterface();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('jarvis:agents-changed', refresh);
    document.removeEventListener('kairos:bots-selected', markActive);
    section.remove();
  };
}
