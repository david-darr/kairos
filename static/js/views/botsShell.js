// One bot's page (Agents 3.0 Phase 0, unit U3). Options: agentId, sessionId,
// panel (a section id, or true), panelPage, panelCard.
//
// The header is the Simple pill from OMB 3.5: a 24 px live Kip, the bot's name and
// "> thread title" when away from the main thread; pressing it opens or closes the
// bot panel. Below it is the real conversation, mountAgentChat (agentChat.js), so
// the chat streams, keeps its queue, model picker, permission prompts and drafts.
// Phase 1 replaces it with the OMB chat screen. The conversation list is a popover
// from the header's Conversations button.
//
// The panel itself is drawn by botsPanelHost.js, which loads U4's botsPanel.js.
import { api } from '../api.js';
import { mountAgentChat } from '../agentChat.js';
import { botKip, stateForBot } from '../botsKip.js';
import { botStatus, botStatusLine } from '../botStatus.js';
import { loadBotsCss, withBotColor, applyBotsInterface } from '../botsUi.js';
import { icon } from '../botsIcons.js';
import { visibleBots } from '../botsRail.js';
import { openNewBot, openBotSettings, closeBotSettings, toggleBotSettings, onBotPanelChange, botPanelState } from '../botsPanelHost.js';
import * as chatStream from '../chatStream.js';

const SHELL_CSS = '/static/css/bots-shell.css';
const LAST_BOT = 'kairos:bots-last-bot';
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

const remembered = () => { try { return localStorage.getItem(LAST_BOT) || ''; } catch { return ''; } };
const remember = id => { try { localStorage.setItem(LAST_BOT, id); } catch { /* Device storage is optional. */ } };
const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));

// The Kip beat that goes with a change of state (OMB's beats, 1.4 s).
const BEATS = { thinking: 'thinking', needs: 'alert', error: 'failure' };

function message(container, text, actions = []) {
  container.classList.add('bots-shell-view');
  container.replaceChildren(h('div', { class: 'bots-home-message-page', role: 'alert' }, [h('p', { text }), ...actions]));
}
const button = (label, onClick, primary = false) => h('button', { type: 'button', class: `bots-btn${primary ? ' primary' : ''}`, text: label, onclick: onClick });

export async function render(container, tabId, options = {}) {
  await loadBotsCss(SHELL_CSS);
  applyBotsInterface();
  let agentId = options.agentId || '';
  if (!agentId) {
    // No bot named: the one the person had open last, else the first.
    const bots = visibleBots(await api('/api/agents').catch(() => []));
    agentId = (bots.find(bot => bot.id === remembered()) || bots[0])?.id || '';
    if (!agentId) {
      message(container, 'You have no bots yet.', [button('Create your first bot', () => openNewBot(), true), button('All bots', () => go('botsHome'))]);
      return undefined;
    }
  }
  let detail;
  try { detail = await api(`/api/agents/${encodeURIComponent(agentId)}`); }
  catch {
    message(container, 'That bot could not be found. It may have been deleted.', [button('All bots', () => go('botsHome'), true)]);
    return undefined;
  }
  let agent = detail.agent;
  remember(agent.id);

  container.classList.add('bots-shell-view');
  let disposed = false, mainId = '', kipState = '';
  const offs = [];

  // -- Header ----------------------------------------------------------------------
  const kip = botKip(agent, { size: 24, state: 'idle', beat: 'arrive' });
  const nameEl = h('span', { class: 'bots-head-name', text: agent.name });
  const threadEl = h('span', { class: 'bots-head-thread', hidden: true });
  const roleEl = h('span', { class: 'bots-head-role', text: agent.role || '' });
  const pill = h('button', { type: 'button', class: 'bots-head-pill', 'aria-expanded': 'false', 'aria-controls': 'bots-panel', 'aria-haspopup': 'dialog',
    title: 'Settings and details' }, [kip, nameEl, threadEl, roleEl, icon('chevron-down', { size: 14 })]);
  pill.addEventListener('click', () => toggleBotSettings(agent.id, pill));
  const statusEl = h('span', { class: 'bots-head-status', 'aria-live': 'polite' });
  const back = h('button', { type: 'button', class: 'bots-head-back', 'aria-label': 'All bots', title: 'All bots', onclick: () => go('botsHome') }, [icon('arrow-left', { size: 18 })]);
  const convoButton = h('button', { type: 'button', class: 'bots-icon-btn bots-head-convos', 'aria-label': 'Conversations', title: 'Conversations',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'bots-convos' }, [icon('messages-square', { size: 18 })]);
  const header = h('header', { class: 'bots-shell-header' }, [back, pill, statusEl, h('span', { class: 'bots-head-fill' }), convoButton]);

  // -- Conversations popover: the list mountAgentChat draws ---------------------------
  const convos = h('div', { id: 'bots-convos', class: 'bots-convos', role: 'dialog', 'aria-label': `Conversations with ${agent.name}`, hidden: true });
  const setConvos = open => {
    convos.hidden = !open; convoButton.setAttribute('aria-expanded', String(open));
    if (open) (convos.querySelector('.agent-chat-item.active .agent-chat-open, .agent-chat-open, .agent-chat-new') || convos).focus?.();
  };
  convoButton.addEventListener('click', () => { const open = convos.hidden; setConvos(open); if (!open) convoButton.focus(); });
  const onKey = event => {
    if (event.key !== 'Escape' || convos.hidden) return;
    event.preventDefault(); setConvos(false); convoButton.focus();
  };
  const onPointer = event => { if (!convos.hidden && !convos.contains(event.target) && !convoButton.contains(event.target)) setConvos(false); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer, true);
  offs.push(() => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer, true); });

  const chatHost = h('div', { class: 'bots-chat-host' });
  const main = h('div', { class: 'bots-shell-main' }, [header, convos, chatHost]);
  const shell = h('div', { class: 'bots-shell', 'data-agent-id': agent.id, 'data-bot-name': agent.name }, [main]);
  withBotColor(shell, agent.color);
  container.replaceChildren(shell);
  document.documentElement.dataset.botsAgent = agent.id;
  document.dispatchEvent(new CustomEvent('kairos:bots-selected', { detail: { agentId: agent.id } }));

  // -- State: the Kip pose, the status line, the thread title --------------------------
  const threadIds = () => new Set([...convos.querySelectorAll('.agent-chat-item')].map(item => item.dataset.session));
  const paintState = () => {
    if (disposed) return;
    const ids = threadIds();
    const live = chatStream.listInFlight().some(entry => entry.status === 'processing' && ids.has(entry.sessionId));
    const status = botStatus(agent, [], live);
    const line = botStatusLine(agent, [], live);
    const next = stateForBot(agent, { status: line.state === 'off' ? 'off' : status, live });
    statusEl.textContent = line.text; statusEl.dataset.state = line.state;
    if (next !== kipState) {
      const before = kipState; kipState = next; kip.setState(next);
      if (before && BEATS[next]) kip.beat(BEATS[next]);
      else if (before === 'thinking' && next === 'idle') kip.beat('success');
    }
  };
  const paintTitle = () => {
    const active = convos.querySelector('.agent-chat-item.active');
    const away = !!active && !!mainId && active.dataset.session !== mainId;
    threadEl.textContent = away ? `> ${active.querySelector('.agent-chat-title')?.textContent || ''}` : '';
    threadEl.hidden = !away;
    pill.setAttribute('aria-label', `${agent.name}${away ? `, ${threadEl.textContent.slice(2)}` : ''}, settings and details`);
  };
  new MutationObserver(paintTitle).observe(convos, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  offs.push(chatStream.subscribeAll(paintState));
  paintState(); paintTitle();

  // The main thread tells which conversation needs no label: the session list carries each one's
  // thread record (core/session_manager_store.py), and an older record has none.
  const readMain = () => api(`/api/sessions?agent_id=${encodeURIComponent(agent.id)}`).then(list => {
    if (disposed) return;
    mainId = String((Array.isArray(list) ? list.find(item => item.thread?.main) : null)?.id || ''); paintTitle();
  }).catch(() => {});
  readMain();

  // A fresh read of the bot keeps its name, job and status current while the page is open.
  const reread = async () => {
    try {
      const next = (await api(`/api/agents/${encodeURIComponent(agent.id)}`))?.agent;
      if (disposed || !next) return;
      agent = { ...agent, ...next };
      nameEl.textContent = agent.name; roleEl.textContent = agent.role || ''; shell.dataset.botName = agent.name;
      withBotColor(shell, agent.color);
      paintState();
    } catch { /* The next poll tries again. */ }
  };
  const timer = setInterval(() => { if (!document.hidden) reread(); }, POLL_MS);
  document.addEventListener('jarvis:agents-changed', reread);
  offs.push(() => { clearInterval(timer); document.removeEventListener('jarvis:agents-changed', reread); });

  // -- The panel's state on the pill ---------------------------------------------------
  const paintPanel = state => {
    const open = !!state?.open && state.agentId === agent.id;
    pill.setAttribute('aria-expanded', String(open)); shell.classList.toggle('has-panel', open);
  };
  offs.push(onBotPanelChange(paintPanel)); paintPanel(botPanelState());

  // -- The conversation ----------------------------------------------------------------
  let disposeChat = () => {};
  const mounted = await mountAgentChat(chatHost, agent, options.sessionId || null, { conversations: convos, onPick: () => setConvos(false) });
  if (disposed || !shell.isConnected) { mounted?.(); return undefined; }
  disposeChat = mounted || disposeChat;
  paintState(); paintTitle();

  if (options.panel) {
    openBotSettings(agent.id, { section: typeof options.panel === 'string' ? options.panel : '', page: options.panelPage || '', card: options.panelCard || '', opener: pill });
  }

  return () => {
    disposed = true;
    for (const off of offs) off();
    closeBotSettings({ restoreFocus: false });
    disposeChat();
    if (document.documentElement.dataset.botsAgent === agent.id) delete document.documentElement.dataset.botsAgent;
    document.dispatchEvent(new CustomEvent('kairos:bots-selected', { detail: { agentId: '' } }));
  };
}
