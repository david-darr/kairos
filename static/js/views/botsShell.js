// One bot's page (Agents 3.0 Phase 0 unit U3, Phase 1 unit U3). Options: agentId, sessionId,
// messageId (a message to land on), panel (a section id, or true), panelPage, panelCard.
//
// The header is the Simple pill from OMB 3.5: a 24 px live Kip, the bot's name and
// "> thread title" when away from the main thread; pressing it opens or closes the
// bot panel. Below it is the conversation, mountBotsChat (botsChat.js): streaming,
// drafts, queue, branches, search. The conversation list is a popover from the
// header's Conversations button; it lists this bot's sessions and opens one at a time.
//
// The panel itself is drawn by botsPanelHost.js, which loads U4's botsPanel.js.
import { api, confirmDialog, toast } from '../api.js';
import { mountBotsChat } from '../botsChat.js';
import { botKip, stateForBot } from '../botsKip.js';
import { botStatus, botStatusLine } from '../botStatus.js';
import { loadBotsCss, withBotColor, applyBotsInterface } from '../botsUi.js';
import { icon } from '../botsIcons.js';
import { visibleBots } from '../botsRail.js';
import { openNewBot, openBotSettings, closeBotSettings, toggleBotSettings, onBotPanelChange, botPanelState } from '../botsPanelHost.js';
import * as chatStream from '../chatStream.js';

const SHELL_CSS = '/static/css/bots-shell.css';
const LAST_BOT = 'kairos:bots-last-bot';
const LAST_THREAD = 'jarvis:agent-chat:';
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
const lastThread = botId => { try { return localStorage.getItem(LAST_THREAD + botId) || ''; } catch { return ''; } };
const rememberThread = (botId, id) => { try { id ? localStorage.setItem(LAST_THREAD + botId, id) : localStorage.removeItem(LAST_THREAD + botId); } catch { /* Device storage is optional. */ } };

// The conversation that is open, for the navigation layer: land on a message, or insert text into the composer.
let active = null;
export const currentBotsChat = () => active;
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

  // -- Conversations popover ---------------------------------------------------------------------
  const convos = h('div', { id: 'bots-convos', class: 'bots-convos', role: 'dialog', 'aria-label': `Conversations with ${agent.name}`, hidden: true });
  const convoList = h('div', { class: 'bots-convo-list', role: 'list', 'aria-label': `Chats with ${agent.name}` });
  const newConvo = h('button', { type: 'button', class: 'bots-btn bots-convo-new', text: 'New conversation' });
  convos.append(h('div', { class: 'bots-convo-head' }, [h('h3', { text: 'Conversations' }), newConvo]), convoList);
  const setConvos = open => {
    convos.hidden = !open; convoButton.setAttribute('aria-expanded', String(open));
    if (open) (convos.querySelector('.bots-convo-item.active .bots-convo-open, .bots-convo-open, .bots-convo-new') || convos).focus?.();
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
  let threads = [], currentId = '';
  const threadIds = () => new Set(threads.map(item => item.id));
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
    const activeThread = threads.find(item => item.id === currentId);
    const away = !!activeThread && !!mainId && activeThread.id !== mainId;
    threadEl.textContent = away ? `> ${activeThread.title || 'Untitled'}` : '';
    threadEl.hidden = !away;
    pill.setAttribute('aria-label', `${agent.name}${away ? `, ${threadEl.textContent.slice(2)}` : ''}, settings and details`);
  };
  offs.push(chatStream.subscribeAll(paintState));
  paintState(); paintTitle();

  // The session list carries each conversation's thread record (core/session_manager_store.py), and an older
  // record has none: the main thread is the one marked so, which needs no label in the header.
  const paintConvos = () => {
    convoList.replaceChildren(...threads.map(chat => h('div', { class: `bots-convo-item${chat.id === currentId ? ' active' : ''}`, role: 'listitem', 'data-session': chat.id }, [
      h('button', { type: 'button', class: 'bots-convo-open', 'aria-current': String(chat.id === currentId), onclick: () => openThread(chat.id) }, [
        h('span', { class: 'bots-convo-title', text: chat.title || 'Untitled' }),
        h('span', { class: 'bots-convo-meta', text: chat.updated_at ? new Date(chat.updated_at * 1000).toLocaleDateString() : '' })]),
      h('button', { type: 'button', class: 'bots-icon-btn bots-convo-delete', 'aria-label': `Delete ${chat.title || 'conversation'}`, title: 'Delete conversation', onclick: () => deleteThread(chat) }, [icon('trash-2', { size: 15 })]),
    ])));
    if (!threads.length) convoList.append(h('div', { class: 'bots-convo-none', text: 'No conversations yet.' }));
  };
  const readThreads = async () => {
    const list = await api(`/api/sessions?agent_id=${encodeURIComponent(agent.id)}`).catch(() => null);
    if (disposed || !Array.isArray(list)) return threads;
    threads = list;
    mainId = String(list.find(item => item.thread?.main)?.id || '');
    paintConvos(); paintTitle();
    return threads;
  };

  // A fresh read of the bot keeps its name, job and status current while the page is open.
  const reread = async () => {
    try {
      const next = (await api(`/api/agents/${encodeURIComponent(agent.id)}`))?.agent;
      if (disposed || !next) return;
      agent = { ...agent, ...next };
      chat?.update?.({ agent: next });
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
  let chat = null, opening = 0;
  const closeChat = () => { chat?.dispose(); chat = null; if (active?.owner === shell) active = null; };
  async function openThread(id, { landOn = '' } = {}) {
    const mine = ++opening;
    setConvos(false);
    closeChat();
    currentId = id; rememberThread(agent.id, id);
    paintConvos(); paintTitle(); paintState();
    // The front desk (Phase 5) has its own page around the conversation: Chat, Tasks and Make tabs.
    const next = agent.builtin === 'front_desk'
      ? (await import('../botsFrontDesk.js')).mountFrontDesk(chatHost, { agent, sessionId: id, onThreadChanged: () => { readThreads(); } })
      : await mountBotsChat(chatHost, { agent, sessionId: id, initialMessage: landOn, onRetry: () => openThread(id),
        onThreadChanged: () => { readThreads(); }, mentions: () => visibleBots(knownBots).filter(bot => bot.id !== agent.id) });
    if (disposed || mine !== opening || !shell.isConnected) { next.dispose(); return; }
    chat = next;
    const none = () => {};
    active = { owner: shell, jumpToMessage: next.jumpToMessage || none, insert: next.insert || none, focus: next.focus || none, sessionId: () => id };
    paintState();
  }
  async function newThread() {
    try {
      const created = await api(`/api/agents/${encodeURIComponent(agent.id)}/chat`, { method: 'POST' });
      await readThreads();
      await openThread(created.id);
      chat?.focus?.();
    } catch (problem) { toast(problem.message, 'error'); }
  }
  async function deleteThread(item) {
    if (!await confirmDialog({ title: 'Delete this conversation?', message: `"${item.title || 'Untitled'}" will be deleted.`, confirmLabel: 'Delete conversation' })) return;
    try { await api(`/api/sessions/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); }
    catch (problem) { toast(problem.message, 'error'); return; }
    await readThreads();
    if (item.id === currentId) { rememberThread(agent.id, null); await openThread(pickThread('')); }
  }
  newConvo.addEventListener('click', () => { setConvos(false); newThread(); });
  // Which conversation opens: the one asked for, the one left open last time, the main one, then the newest.
  const pickThread = wanted => [wanted, lastThread(agent.id), mainId, threads[0]?.id].find(id => id && threads.some(item => item.id === id)) || '';
  let knownBots = [];
  api('/api/agents').then(list => { knownBots = Array.isArray(list) ? list : []; }).catch(() => {});
  await readThreads();
  if (disposed || !shell.isConnected) return undefined;
  const first = pickThread(options.sessionId || '');
  if (first) await openThread(first, { landOn: options.messageId || '' });
  else await newThread();
  if (disposed) return undefined;

  if (options.panel) {
    openBotSettings(agent.id, { section: typeof options.panel === 'string' ? options.panel : '', page: options.panelPage || '', card: options.panelCard || '', opener: pill });
  }

  return () => {
    disposed = true;
    for (const off of offs) off();
    closeBotSettings({ restoreFocus: false });
    opening++; closeChat();
    if (document.documentElement.dataset.botsAgent === agent.id) delete document.documentElement.dataset.botsAgent;
    document.dispatchEvent(new CustomEvent('kairos:bots-selected', { detail: { agentId: '' } }));
  };
}
