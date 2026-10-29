// Bots home (Agents 3.0 Phase 0, unit U3): the roster. A grid of the person's
// bots, each a card with its Kip face, name, job and one status line; the last
// card is "New bot". Beside the heading: Ready-made bots (F3) and Archived (F4).
// All three go through botsPanelHost.js to U4's modules, so a module that is not
// there shows a message, not a broken page. With no bots there is a real empty
// state that opens the same dialog (no "coming soon" placeholders).
//
// Cards use the static face (agentAvatar); the live Kip appears only in the empty
// state, per the 2026-10-14 lesson in agentAvatar.js.
import { api } from '../api.js';
import { agentAvatar } from '../agentAvatar.js';
import { botKip } from '../botsKip.js';
import { botStatusLine } from '../botStatus.js';
import { loadBotsCss, withBotColor, applyBotsInterface } from '../botsUi.js';
import { icon } from '../botsIcons.js';
import { visibleBots, archivedBots, railRow, openBot } from '../botsRail.js';
import { openNewBot, openArchived } from '../botsPanelHost.js';

const SHELL_CSS = '/static/css/bots-shell.css';
const POLL_MS = 10000;

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

function actionButton(label, iconName, onClick, primary = false) {
  return h('button', { type: 'button', class: `bots-btn${primary ? ' primary' : ''}`, onclick: onClick }, [icon(iconName, { size: 16 }), label]);
}

function card(bot) {
  const fact = railRow(bot);
  const line = botStatusLine(bot);
  const node = h('button', { type: 'button', class: 'bots-bot-card', role: 'listitem', 'data-agent-id': bot.id, 'data-state': line.state,
    'aria-label': `${fact.name}, ${bot.role ? bot.role + ', ' : ''}${line.text}`, onclick: () => openBot(bot.id) }, [
    h('span', { class: 'bots-bot-card-top' }, [
      agentAvatar(bot, 48),
      fact.needs ? h('span', { class: 'bots-rail-count', text: fact.needs > 99 ? '99+' : String(fact.needs) }) : null,
    ]),
    h('span', { class: 'bots-bot-card-name', text: fact.name }),
    h('span', { class: 'bots-bot-card-job', text: bot.role || bot.blurb || 'No job yet' }),
    h('span', { class: 'bots-bot-card-status' }, [h('span', { class: 'bots-status-dot', 'data-state': line.state, 'aria-hidden': 'true' }), h('span', { text: line.text })]),
  ]);
  return withBotColor(node, bot.color);
}

export async function render(container) {
  await loadBotsCss(SHELL_CSS);
  applyBotsInterface();
  container.classList.add('bots-home-view');
  let disposed = false, version = 0, signature = '', agents = null;

  const heading = h('h1', { class: 'bots-home-title', text: 'Your bots' });
  const archived = actionButton('Archived', 'archive', () => openArchived());
  archived.hidden = true;
  const actions = h('div', { class: 'bots-home-actions' }, [
    actionButton('Ready-made bots', 'sparkles', () => openNewBot({ gallery: true })),
    archived,
    actionButton('New bot', 'plus', () => openNewBot(), true),
  ]);
  const body = h('div', { class: 'bots-home-body' });
  const root = h('div', { class: 'bots-home' }, [h('header', { class: 'bots-home-header' }, [heading, actions]), body]);
  container.replaceChildren(root);

  function empty() {
    const kip = botKip({ id: 'bots-home-empty' }, { size: 96, state: 'idle', beat: 'arrive' });
    return h('div', { class: 'bots-home-empty' }, [
      kip,
      h('h2', { text: 'No bots yet' }),
      h('p', { text: 'A bot has a name, a job and a memory of its own. Make one and start talking to it.' }),
      actionButton('Create your first bot', 'plus', () => openNewBot(), true),
    ]);
  }

  function draw() {
    if (disposed || !agents) return;
    const bots = visibleBots(agents), hidden = archivedBots(agents);
    const next = JSON.stringify([bots.map(b => [b.id, b.name, b.role, b.blurb, b.color, b.avatar, b.status, b.status_detail, b.needs_you, b.enabled]), hidden.length]);
    if (next === signature) return;
    signature = next;
    archived.lastChild.textContent = `Archived (${hidden.length})`;
    archived.hidden = !hidden.length;
    if (!bots.length) { body.replaceChildren(empty()); return; }
    const newCard = h('button', { type: 'button', class: 'bots-bot-card bots-new-card', role: 'listitem', 'aria-label': 'New bot', onclick: () => openNewBot() },
      [h('span', { class: 'bots-new-mark' }, [icon('plus', { size: 22 })]), h('span', { class: 'bots-bot-card-name', text: 'New bot' })]);
    // A re-draw while a card has focus keeps the focus on the same bot.
    const focused = document.activeElement?.closest?.('.bots-bot-card')?.dataset.agentId;
    body.replaceChildren(h('div', { class: 'bots-grid', role: 'list', 'aria-label': 'Your bots' }, [...bots.map(card), newCard]));
    if (focused) body.querySelector(`.bots-bot-card[data-agent-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  async function refresh() {
    const at = ++version;
    try {
      const next = await api('/api/agents');
      if (disposed || at !== version || !Array.isArray(next)) return;
      agents = next; draw();
    } catch {
      if (!disposed && at === version && !agents) body.replaceChildren(h('p', { class: 'bots-home-message', role: 'alert', text: 'Bots could not load. Try opening this page again.' }));
    }
  }
  document.addEventListener('jarvis:agents-changed', refresh);
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  await refresh();
  return () => {
    disposed = true; ++version; clearInterval(timer);
    document.removeEventListener('jarvis:agents-changed', refresh);
  };
}
