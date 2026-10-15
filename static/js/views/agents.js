import { api, el, customSelect, toast, confirmDialog, emptyState } from "../api.js";
import { ICONS } from "../icons.js";
import { runHistory } from "../runHistory.js";
import { mountAgentChat } from "../agentChat.js";
import { mountComputerPanel } from "../computerPanel.js";
import { toggle } from "../settingsKit.js";
import { mountAgentProfile } from "../agentProfile.js";
import { agentAvatar } from "../agentAvatar.js";
import { botStatusLine } from "../botStatus.js";
import { openCreateAgent } from "../agentCreation.js";
import { openAgentItemSheet } from '../agentItemSheet.js';
import { cadence, routinesPanel } from "../routinesPanel.js";
import { agentModelSummary } from "../agentModelPicker.js";

// Agents (2026-10-04, after xAI's Grok Bot and OpenAI's Dots): named workers
// with a role, standing goals, their own memory and an inbox. Their work runs
// as ordinary Tasks and board cards; services/agent_service.py and the vault
// spec "Agents - Phase 1 Persistent Agents (Build Spec)" have the design.
// Teams (phase 5, 2026-10-05) are Swarm companies, shown here through
// views/swarm.js in its embedded mode; Swarm has no tab of its own any more.

const STATUS = { idle: "Idle", working: "Working", needs_you: "Needs you", off: "Off", capped: "Done for today" };
const POLL_MS = 10000;

// 2026-10-13: a changed response can replace a read-only card, but never a
// card with focus or unsaved controls. Snapshot values when the card mounts;
// this also covers form inputs that did not dispatch an input event yet.
function markDrafts(node) {
  for (const control of node.querySelectorAll('input, textarea, select')) control.dataset.draftBaseline = control.value;
  return node;
}
function hasDraft(node) {
  return node.contains(document.activeElement) || [...node.querySelectorAll('input, textarea, select')]
    .some(control => control.value !== control.dataset.draftBaseline);
}

export async function render(container, tabId, options = {}) {
  let timer = null;
  const cleanups = [];
  const root = el("div", { class: "view-constrained agents-view" });
  container.innerHTML = "";
  container.append(root);
  const schedule = (fn) => { clearTimeout(timer); timer = setTimeout(() => document.body.contains(root) && fn(), POLL_MS); };
  if (options.team) {
    const swarm = await import("./swarm.js");
    return swarm.render(container, tabId, { ...options, embedded: true, systemId: options.team });
  }
  if (options.agentId) await agentPage(root, options.agentId, schedule, cleanups, options.agentTab || "chat", !!options.computerTakeover, !!options.profile, options.sessionId, options.creationNotice);
  else await listPage(root, schedule);
  return () => { clearTimeout(timer); cleanups.forEach((cleanup) => cleanup()); };
}

export function avatar(agent, size = 28) {
  return agentAvatar(agent, size);
}

function open(agentId) {
  document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab: "agents", agentId } }));
}

// Unit 4-ii can call this without reaching into the sheet's DOM (2026-10-13).
export function openProfile(agentId) {
  document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'agents', agentId, profile: true } }));
}

function openTeam(team) {
  document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab: "agents", team } }));
}

const TEAM_STATE = { idle: "Idle", active: "Working", pausing: "Pausing", paused: "Paused", stopped: "Stopped", archived: "Archived" };

function channelOptions(channels, selected = "") {
  return [
    el("option", { value: "", text: "In the app only", ...(selected ? {} : { selected: "" }) }),
    ...channels.map((c) => el("option", { value: c.id, text: c.label, ...(c.id === selected ? { selected: "" } : {}) })),
  ];
}

// -- the list ---------------------------------------------------------------

const listStates = new WeakMap();
// 2026-10-13: an older poll must not land after a later answer or save and
// report stale server data as a new conflict.
const listRequests = new WeakMap();
async function listPage(root, schedule) {
  const version = (listRequests.get(root) || 0) + 1;
  listRequests.set(root, version);
  const [agents, inbox, teams] = await Promise.all([
    api("/api/agents"), api("/api/agents/inbox"), api("/api/swarm/systems").catch(() => null),
  ]);
  if (!document.body.contains(root) || version !== listRequests.get(root)) return;
  let state = listStates.get(root);
  if (!state) {
    const inboxHost = el('div', { class: 'agent-inbox-host' });
    const grid = el('div', { class: 'agent-grid' });
    const teamHost = el('div');
    root.append(el("div", { class: "view-header" }, [el("div", {}, [
      el("h2", { text: "Agents" }),
      el("div", { class: "sub", text: "Named helpers that work in the background and come back when they need you." }),
    ])]), el('h3', { class: 'agent-roster-title', text: 'Your bots' }), grid, inboxHost, teamHost);
    state = { inboxHost, grid, teamHost, tiles: new Map(), inbox: new Map(), teamsSignature: '' };
    listStates.set(root, state);
  }
  const byId = new Map(agents.map((a) => [a.id, a]));
  // 2026-10-13: reconcile by inbox/card ID. A poll may update a status but
  // must not replace a reply that is being composed in the same row.
  const incoming = [...inbox.items.map(item => ({ key: `item:${item.id}`, value: item,
    make: () => inboxItem(item, byId.get(item.agent_id), () => listPage(root, schedule)) })),
  ...inbox.reviews.map(card => ({ key: `review:${card.id}`, value: card,
    make: () => reviewItem(card, byId.get(card.agent_id), () => listPage(root, schedule)) }))];
  if (!state.inboxPanel) {
    state.inboxPanel = el('div', { class: 'glass card agent-inbox' }, [el('div', { class: 'title', text: 'Waiting on you' })]);
    state.inboxHost.append(state.inboxPanel);
  }
  const keys = new Set(incoming.map(row => row.key));
  for (const [key, row] of state.inbox) if (!keys.has(key)) {
    if (hasDraft(row.node)) {
      if (!row.notice) { row.notice = el('p', { class: 'agent-draft-notice', text: 'This item changed on the server. Your reply draft is kept here.' }); row.node.prepend(row.notice); }
    } else { row.node.remove(); state.inbox.delete(key); }
  }
  state.inboxHost.hidden = !inbox.count && !state.inbox.size;
  for (const [index, row] of incoming.entries()) {
    const signature = JSON.stringify([row.value, byId.get(row.value.agent_id)?.avatar]);
    let old = state.inbox.get(row.key);
    if (!old) { old = { node: markDrafts(row.make()), signature }; state.inbox.set(row.key, old); }
    else if (old.signature !== signature && !hasDraft(old.node)) { const next = markDrafts(row.make()); old.node.replaceWith(next); old.node = next; old.signature = signature; }
    if (state.inboxPanel.children[index + 1] !== old.node && !hasDraft(old.node))
      state.inboxPanel.insertBefore(old.node, state.inboxPanel.children[index + 1] || null);
  }
  const agentKeys = new Set(agents.map(agent => agent.id));
  for (const [id, tile] of state.tiles) if (!agentKeys.has(id)) { tile.node.remove(); state.tiles.delete(id); }
  if (agents.length && state.emptyNode) { state.emptyNode.remove(); state.emptyNode = null; }
  for (const [index, agent] of agents.entries()) {
    const signature = JSON.stringify([agent.name, agent.role, agent.avatar, agent.status, agent.status_detail, agent.needs_you, agent.enabled]);
    let tile = state.tiles.get(agent.id);
    if (tile?.signature === signature) {
      if (state.grid.children[index] !== tile.node) state.grid.insertBefore(tile.node, state.grid.children[index] || null);
      continue;
    }
    const node = el("button", { type: "button", class: "agent-tile", onclick: () => open(agent.id) }, [
      el("div", { class: "agent-tile-head" }, [avatar(agent, 88), el("div", { class: "agent-tile-name" }, [
        el("div", { class: "title", text: agent.name }),
        el("div", { class: "meta", text: agent.role || "No role yet" }),
      ])]),
      el("div", { class: "agent-tile-foot" }, [
        el("span", { class: `agent-status-line agent-status-${botStatusLine(agent).state}`, text: botStatusLine(agent).text }),
      ]),
    ]);
    if (tile) { tile.node.replaceWith(node); }
    tile = { node, signature }; state.tiles.set(agent.id, tile);
    if (state.grid.children[index] !== node) state.grid.insertBefore(node, state.grid.children[index] || null);
  }
  if (!agents.length && !state.emptyNode) { state.emptyNode = emptyState({ icon: ICONS.agents, title: 'No agents yet',
    hint: 'Create one with a name and a job to do.' }); state.grid.append(state.emptyNode); }
  // The creation action lives in the roster and remains the last card.
  if (!state.newCard) state.newCard = el('button', { type: 'button', class: 'agent-tile agent-new-card',
    text: '+ New agent', onclick: openCreateAgent });
  state.grid.append(state.newCard);
  const teamsSignature = JSON.stringify(teams);
  if (teamsSignature !== state.teamsSignature) { state.teamHost.replaceChildren(teams ? teamsSection(teams) : null); state.teamsSignature = teamsSignature; }
  if (agents.some((a) => a.status === "working")) schedule(() => listPage(root, schedule));
}

// Teams: a mission worked on by a lead and teammates, who can be your agents.
// null when Swarm is unavailable, so the section is left out, not faked.
function teamsSection(teams) {
  const grid = el("div", { class: "agent-grid" });
  for (const team of teams.items) {
    grid.append(el("button", { type: "button", class: "agent-tile team-tile", onclick: () => openTeam(team.id) }, [
      el("div", { class: "agent-tile-name" }, [
        el("div", { class: "title", text: team.name }),
        el("div", { class: "meta team-mission", text: team.mission }),
      ]),
      el("div", { class: "agent-tile-foot" }, [
        el("span", { class: `agent-status team-state-${team.state}`, text: TEAM_STATE[team.state] || team.state }),
        el("span", { class: "meta", text: team.active_tasks ? `${team.active_tasks} working now` : "" }),
      ]),
    ]));
  }
  return el("section", { class: "agent-teams", "aria-label": "Teams" }, [
    el("div", { class: "view-header agent-teams-header" }, [
      el("div", {}, [el("h3", { text: "Teams" }),
        el("div", { class: "sub", text: "Agents working together on one mission: a lead plans and reviews, teammates do the work." })]),
      el("button", { class: "btn", text: "+ New team", onclick: () => openTeam("new") }),
    ]),
    teams.items.length ? grid : el("div", { class: "meta", text: "No teams yet." }),
  ]);
}

// -- the inbox (shared by the list and the agent page) ----------------------

function inboxPanel(title, items, reviews, byId, refresh) {
  const panel = el("div", { class: "glass card agent-inbox" }, [el("div", { class: "title", text: title })]);
  for (const item of items) panel.append(inboxItem(item, byId.get(item.agent_id), refresh));
  for (const card of reviews) panel.append(reviewItem(card, byId.get(card.agent_id), refresh));
  if (!items.length && !reviews.length) panel.append(el("div", { class: "meta", text: "Nothing is waiting on you." }));
  return panel;
}

async function answer(item, choice, text, refresh) {
  try {
    const result = await api(`/api/agents/inbox/${item.id}/answer`, { method: "POST", body: JSON.stringify({ choice, text: text || null }) });
    toast(result.next ? result.next[0].toUpperCase() + result.next.slice(1) : "Done", "success");
  } catch (problem) { toast(problem.message, "error"); }
  document.dispatchEvent(new CustomEvent("jarvis:agents-changed"));
  await refresh();
}

function relativeTime(seconds) {
  const age = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  if (age < 60) return 'now';
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return `${Math.floor(age / 86400)}d ago`;
}

function inboxItem(item, agent, refresh) {
  const kind = { question: "Question", report: "Report" }[item.kind];
  const reply = el("input", { class: "agent-reply", placeholder: item.kind === "question" ? "Your answer" : "Reply or guidance" });
  const button = (text, onclick, cls = "btn") => el("button", { class: cls, text, onclick });
  const send = (choice) => () => {
    if (choice === "reply" && !reply.value.trim()) { toast("Write a reply first", "error"); return; }
    answer(item, choice, reply.value.trim(), () => { if (reply.closest('.agent-inbox-item')?.contains(document.activeElement)) document.activeElement.blur();
      reply.dataset.draftBaseline = reply.value; return refresh(); });
  };
  const actions = el("div", { class: "agent-inbox-actions" });
  const compose = el('div', { class: 'agent-inbox-compose', hidden: true }, [reply,
    button('Send', send('reply'), 'btn primary'), button('Cancel', () => { compose.hidden = true; reply.value = ''; reply.dataset.draftBaseline = ''; }, 'btn quiet')]);
  if (/^(Ready for you: press|Needs you: sign in|Needs you: embedded frame)/.test(item.title)) {
    actions.append(button('Open computer', async () => {
      const running = await api('/api/computer').catch(() => []);
      if (!running.some(computer => computer.owner === `agent:${item.agent_id}`)) {
        toast('This computer is closed.', 'error'); return;
      }
      document.dispatchEvent(new CustomEvent('jarvis:navigate',
        { detail: { tab: 'agents', agentId: item.agent_id, agentTab: 'work', computerTakeover: true } }));
    }, 'btn primary'));
  }
  if (!actions.children.length) actions.append(button(item.kind === 'question' ? 'Reply' : 'Dismiss',
    item.kind === 'question' ? () => { compose.hidden = false; reply.focus(); } : send('dismiss'), 'btn primary'));
  if (item.kind === 'question') {
    if (actions.querySelector('.btn.primary')?.textContent === 'Open computer')
      actions.append(button('Reply', () => { compose.hidden = false; reply.focus(); }, 'btn quiet'));
    actions.append(button('Dismiss', send('dismiss'), 'btn quiet'));
  }
  else actions.append(button('Reply', () => { compose.hidden = false; reply.focus(); }, 'btn quiet'));
  return el("div", { class: `agent-inbox-item agent-inbox-${item.kind}` }, [
    el("div", { class: "agent-inbox-head" }, [
      agent ? avatar(agent, 22) : el("span"),
      el("span", { class: "agent-inbox-kind", text: kind }),
      el("span", { class: "agent-inbox-title", text: `${agent?.name || "Agent"}: ${item.title}` }),
      el("span", { class: "meta agent-inbox-time", text: relativeTime(item.created_at) }),
    ]),
    item.body ? el("div", { class: "agent-inbox-body", text: item.body }) : el("span"),
    actions, compose,
  ]);
}

function reviewItem(card, agent, refresh) {
  const result = [...(card.comments || [])].reverse().find((c) => c.kind === "result");
  const note = el("input", { class: "agent-reply", placeholder: "What should change? (it remembers this)" });
  const move = async (status, text) => {
    try {
      await api(`/api/tasks/${card.id}/status`, { method: "POST", body: JSON.stringify({ status, note: text || null }) });
    } catch (problem) { toast(problem.message, "error"); }
    document.dispatchEvent(new CustomEvent("jarvis:agents-changed"));
    if (note.closest('.agent-inbox-item')?.contains(document.activeElement)) document.activeElement.blur();
    note.dataset.draftBaseline = note.value;
    await refresh();
  };
  const compose = el('div', { class: 'agent-inbox-compose', hidden: true }, [note,
    el('button', { class: 'btn primary', text: 'Send changes', onclick: () => {
      if (!note.value.trim()) { toast('Say what should change', 'error'); return; }
      move('ready', note.value.trim());
    } }), el('button', { class: 'btn quiet', text: 'Cancel', onclick: () => { compose.hidden = true; note.value = ''; } })]);
  return el("div", { class: "agent-inbox-item agent-inbox-review" }, [
    el("div", { class: "agent-inbox-head" }, [
      agent ? avatar(agent, 22) : el("span"),
      el("span", { class: "agent-inbox-kind", text: "Result" }),
      el("span", { class: "agent-inbox-title", text: `${agent?.name || "Agent"}: ${card.name}` }),
      el('span', { class: 'meta agent-inbox-time', text: relativeTime(card.updated_at || card.created_at || Date.now() / 1000) }),
    ]),
    el("div", { class: "agent-inbox-body", text: result ? result.text : "(no result text)" }),
    el("div", { class: "agent-inbox-actions" }, [
      el("button", { class: "btn primary", text: "Approve", onclick: () => move("done") }),
      el('button', { class: 'btn quiet', text: 'Request changes', onclick: () => { compose.hidden = false; note.focus(); } }),
    ]), compose,
  ]);
}

// -- one agent ----------------------------------------------------------------

async function agentPage(root, agentId, schedule, cleanups, tab = "chat", takeOver = false, profileOpen = false, sessionId = null, creationNotice = null) {
  let detail;
  try {
    detail = await api(`/api/agents/${agentId}`);
  } catch {
    root.innerHTML = "";
    root.append(emptyState({ icon: ICONS.agents, title: "That agent no longer exists", hint: "Go back to Agents to see the others." }));
    return;
  }
  const [models, channels] = await Promise.all([api("/api/models").catch(() => []), api("/api/channels").catch(() => [])]);
  let catalogEndpoint = detail.agent.endpoint_id, modelCatalog = catalogEndpoint
    ? await api(`/api/models/${catalogEndpoint}/catalog`).catch(() => []) : [];
  if (!document.body.contains(root)) return;
  root.innerHTML = "";

  // 2026-10-14: keep the top bar and all tab hosts mounted; polls reconcile data
  // panels without rebuilding a chat or replacing a half-typed field.
  root.classList.add('agent-conversation-page');
  const header = el('div', { class: 'agent-header' });
  const live = el('section', { class: 'agent-live-panel glass card', 'aria-label': 'Live state' });
  const upcoming = el('section', { class: 'agent-next-panel glass card', 'aria-label': 'Next routines' });
  const activity = el('div', { class: 'agent-inline-activity', 'aria-label': 'Waiting on you' });
  const side = el('aside', { class: 'agent-live-panels', 'aria-label': 'Live work' }, [live, activity, upcoming]);
  const search = el('input', { type: 'search', class: 'agent-thread-search', placeholder: 'Search chats',
    'aria-label': 'Search this bot’s loaded conversation titles', title: 'Filters loaded conversation titles' });
  const profile = mountAgentProfile(root, detail, models, channels, () => redraw());
  // 2026-10-14: keep a failed first routine visible above the new profile's
  // settings, since the sheet covers the page-level notice after creation.
  if (creationNotice) root.querySelector('.agent-profile-body')?.prepend(
    el('p', { class: 'agent-create-notice', role: 'alert', text: creationNotice }));
  cleanups.push(profile.dispose, () => document.querySelector('.agent-item-sheet')?.close());
  const chatTab = el("button", { type: "button", role: "tab", class: "agent-tab", text: "Chat" });
  const workTab = el("button", { type: "button", role: "tab", class: "agent-tab" });
  const routinesTab = el('button', { type: 'button', role: 'tab', class: 'agent-tab', text: 'Routines' });
  const memoryTab = el('button', { type: 'button', role: 'tab', class: 'agent-tab', text: 'Memory' });
  const chatHost = el("div", { role: "tabpanel", class: "agent-tab-panel agent-chat-host" });
  const workHost = el("div", { role: "tabpanel", class: "agent-tab-panel agent-work-host" });
  const routinesHost = el('div', { role: 'tabpanel', class: 'agent-tab-panel agent-routines-host' });
  const memoryHost = el('div', { role: 'tabpanel', class: 'agent-tab-panel agent-memory-host' });
  const computerHost = el('div', { class: 'glass card agent-computer-section', hidden: true });
  let computerView = null;
  const syncComputer = async () => {
    const running = (await api('/api/computer').catch(() => []))
      .find(item => item.owner === `agent:${agentId}`);
    if (!document.body.contains(root)) return;
    if (!['chat', 'work'].includes(root.dataset.agentTab)) {
      if (computerView) { computerView.dispose(); computerView = null; computerHost.replaceChildren(); }
      return;
    }
    const stream = chatHost.querySelector('.agent-conversation-stream');
    if (root.dataset.agentTab === 'chat' && stream && computerHost.parentNode !== stream) stream.append(computerHost);
    else if (root.dataset.agentTab === 'work' && computerHost.parentNode !== workHost) workHost.insertBefore(computerHost, workHost.children[1] || null);
    computerHost.hidden = !running;
    if (running && !computerView) {
      computerHost.append(el('div', { class: 'title', text: 'Computer' }));
      const content = el('div');
      computerHost.append(content);
      computerView = mountComputerPanel(content, `agent:${agentId}`, running,
        { takeOver, onClose: () => { computerView?.dispose(); computerView = null; computerHost.replaceChildren(); computerHost.hidden = true; } });
      takeOver = false;
    } else if (!running && computerView) {
      computerView.dispose(); computerView = null; computerHost.replaceChildren();
    }
    const forget = workHost.querySelector('.agent-forget-logins');
    if (forget) forget.disabled = !!running;
  };
  const computerTimer = setInterval(syncComputer, 2000);
  cleanups.push(() => { clearInterval(computerTimer); computerView?.dispose(); });
  let chatMounted = false;
  const show = (which) => {
    for (const [button, host, name] of [[chatTab, chatHost, "chat"], [workTab, workHost, "work"],
      [routinesTab, routinesHost, 'routines'], [memoryTab, memoryHost, 'memory']]) {
      button.setAttribute("aria-selected", String(which === name));
      button.tabIndex = which === name ? 0 : -1;
      button.classList.toggle("active", which === name);
      host.hidden = which !== name;
    }
    root.dataset.agentTab = which;
    side.hidden = which !== 'chat';
    search.hidden = which !== 'chat';
    const active = [chatTab, workTab, routinesTab, memoryTab].findIndex(button => button.classList.contains('active'));
    segments.style.setProperty('--segment', active);
    if (which === "chat" && !chatMounted) {
      chatMounted = true;
      mountAgentChat(chatHost, detail.agent, sessionId, { search, activity }).then((cleanup) => cleanups.push(cleanup));
    }
    if (which === 'work' || which === 'chat') syncComputer();
    else if (computerView) { computerView.dispose(); computerView = null; computerHost.replaceChildren(); }
  };
  chatTab.addEventListener("click", () => show("chat"));
  workTab.addEventListener("click", () => show("work"));
  routinesTab.addEventListener('click', () => show('routines'));
  memoryTab.addEventListener('click', () => show('memory'));
  const segments = el('div', { class: 'agent-tabs', role: 'tablist', 'aria-label': 'Agent' }, [chatTab, workTab, routinesTab, memoryTab]);
  const tabs = [chatTab, workTab, routinesTab, memoryTab];
  tabs.forEach((button, index) => {
    const host = [chatHost, workHost, routinesHost, memoryHost][index];
    button.id = `agent-tab-${index}`; host.id = `agent-panel-${index}`;
    button.setAttribute('aria-controls', host.id); host.setAttribute('aria-labelledby', button.id);
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
      tabs[next].click(); tabs[next].focus();
    });
  });
  const back = el('button', { type: 'button', class: 'btn quiet agent-back', text: '\u2190', 'aria-label': 'All agents',
    onclick: () => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'agents' } })) });
  // 2026-10-14: reserve the app menu’s place; reuse its drawer and focus logic.
  const menu = el('span', { class: 'agent-mobile-menu-slot', 'aria-hidden': 'true' });
  root.append(el('div', { class: 'agent-conversation-topbar' }, [back, menu, segments, el('div', { class: 'agent-topbar-tools' }, [search, header])]),
    ...(creationNotice ? [el('p', { class: 'agent-create-notice', role: 'alert', text: creationNotice })] : []),
    el('div', { class: 'agent-conversation-layout' }, [side, chatHost]), workHost, routinesHost, memoryHost);
  const giveJob = () => {
    show('work');
    const flow = workHost.querySelector('.agent-job-flow');
    if (flow) { flow.open = true; flow.querySelector('input')?.focus(); }
  };
  side.append(el('button', { type: 'button', class: 'btn agent-give-job', text: '+ Give it a job', onclick: giveJob }));

  let headerSignature = '';
  const drawHeader = (agent) => {
    // A scheduled run can be stopped through the same route as a card.
    const stoppable = new Map([
      ...detail.cards.filter(card => card.status === 'running').map(card => [card.id, card]),
      ...detail.runs.filter(run => run.outcome === 'running' && run.task_id).map(run => [run.task_id, { id: run.task_id }]),
    ]);
    const signature = JSON.stringify([agent, [...stoppable.keys()]]);
    if (signature === headerSignature) return;
    headerSignature = signature;
    header.replaceChildren(el('button', { type: 'button', class: 'agent-profile-face', 'aria-label': `Open ${agent.name}’s profile`,
      onclick: () => profile.open() }, [avatar(agent, 42), el('h2', { text: agent.name })]),
      el('button', { type: 'button', class: 'btn agent-profile-open', text: 'Settings', onclick: () => profile.open() }));
    live.replaceChildren(el('div', { class: 'title', text: 'Right now' }),
      el('span', { class: `agent-status-line agent-status-${botStatusLine(agent).state}`, text: botStatusLine(agent).text }),
      el('p', { class: 'agent-model-summary', text: agentModelSummary(agent, models, modelCatalog) }),
      el('div', { class: 'agent-header-actions' }, [el('button', { type: 'button', class: 'btn quiet', text: agent.enabled ? 'Turn off' : 'Turn on',
        onclick: async () => { await api(`/api/agents/${agentId}`, { method: 'PATCH', body: JSON.stringify({ enabled: !agent.enabled }) }); redraw(); } }),
        ...[...stoppable.values()].map(card => el('button', { type: 'button', class: 'btn', text: 'Stop',
          onclick: async () => { try { await api(`/api/tasks/${card.id}/stop`, { method: 'POST' }); redraw(); } catch (problem) { toast(problem.message, 'error'); } } }))]));
    workTab.textContent = agent.needs_you ? `Work (${agent.needs_you})` : 'Work';
  };

  const panels = new Map();
  let refreshVersion = 0;
  const reconcile = (key, value, make) => {
    const signature = JSON.stringify(value);
    let entry = panels.get(key);
    if (!entry) { entry = { node: markDrafts(make()), signature }; panels.set(key, entry); }
    else if (signature !== entry.signature) {
      if (hasDraft(entry.node)) {
        if (!entry.notice) { entry.notice = el('p', { class: 'agent-draft-notice', text: 'New server data is available. Your draft is kept; save or clear it to refresh this section.' }); entry.node.prepend(entry.notice); }
      } else {
        const next = markDrafts(make()); entry.node.replaceWith(next); entry.node = next; entry.signature = signature; entry.notice = null;
      }
    }
    return entry.node;
  };
  const drawWork = () => {
    const { agent } = detail;
    const reviews = detail.cards.filter((c) => c.status === "review");
    const byId = new Map([[agent.id, agent]]);
    // 2026-10-14: each waiting ID has its own reconciled control tree. A poll
    // can refresh neighbours without replacing an answer being composed.
    const keys = new Set();
    for (const [kind, items, make] of [['item', detail.inbox, inboxItem], ['review', reviews, reviewItem]]) {
      for (const item of items) {
        const key = `waiting:${kind}:${item.id}`; keys.add(key);
        const node = reconcile(key, [item, agent.avatar], () => {
          const card = make(item, agent, redraw); card.classList.add('agent-approval-card');
          card.prepend(el('div', { class: 'agent-blocked-status', text: kind === 'review' ? 'Work · Waiting for review' : 'Bot · Waiting for you' }));
          return card;
        });
        if (node.parentNode !== activity) activity.append(node);
        const title = node.querySelector('.agent-inbox-title');
        if (title && title.tagName !== 'BUTTON') {
          const button = el('button', { type: 'button', class: 'agent-inbox-title agent-waiting-details', text: title.textContent,
            onclick: () => openAgentItemSheet({ title: item.title || item.name, description: item.body || node.querySelector('.agent-inbox-body')?.textContent,
              agent, primary: kind === 'review' ? 'Review result' : 'Answer',
              onPrimary: () => { show('chat'); node.scrollIntoView({ block: 'center' }); node.querySelector('.btn.primary')?.click(); },
              secondary: 'Open Work', onSecondary: () => show('work') }) });
          title.replaceWith(button);
        }
      }
    }
    for (const [key, entry] of panels) {
      if (!key.startsWith('waiting:') || keys.has(key)) continue;
      if (!hasDraft(entry.node)) { entry.node.remove(); panels.delete(key); }
      else if (!entry.notice) {
        entry.notice = el('p', { class: 'agent-draft-notice', text: 'This item changed on the server. Your reply draft is kept here.' });
        entry.node.prepend(entry.notice);
      }
    }
    const next = reconcile('next-routines', detail.goals, () => el('div', {}, [
      el('div', { class: 'title', text: 'Next routines' }),
      ...detail.goals.filter(r => r.enabled).sort((a, b) => String(a.next_run_at || '').localeCompare(String(b.next_run_at || ''))).slice(0, 3).map(routine =>
        el('button', { type: 'button', class: 'agent-routine-preview', onclick: () => openAgentItemSheet({ title: routine.name, agent,
          description: routine.prompt || cadence(routine), details: `${cadence(routine)} · ${routine.next_run_at ? new Date(routine.next_run_at).toLocaleString() : 'Next run not scheduled'}`,
          primary: 'Check now', onPrimary: async () => { try { await api(`/api/tasks/${routine.id}/run`, { method: 'POST' }); redraw(); } catch (problem) { toast(problem.message, 'error'); } },
          secondary: 'Edit routine', onSecondary: () => { show('routines'); routinesHost.querySelector(`[data-routine-id="${CSS.escape(routine.id)}"] .agent-row-actions button:nth-child(3)`)?.click(); } }),
        }, [el('strong', { text: routine.name }), el('span', { text: cadence(routine) }), el('span', { text: routine.next_run_at ? new Date(routine.next_run_at).toLocaleString() : 'Next run not scheduled' })])),
      ...(!detail.goals.some(r => r.enabled) ? [el('p', { text: 'No upcoming routines.' })] : [])]));
    if (next.parentNode !== upcoming) upcoming.append(next);
    const rows = [
      reconcile('inbox', [detail.inbox, reviews, agent.avatar], () => inboxPanel('Inbox', detail.inbox, reviews, byId, redraw)),
      computerHost,
      reconcile('cards', [detail.cards, agent.avatar], () => workPanel(agentId, detail.cards, redraw, agent)),
      reconcile('history', detail.runs, () => el('div', { class: 'glass card' }, [el('div', { class: 'title', text: 'History' }), runHistory(detail.runs)])),
      reconcile('teams', detail.teams || [], () => teamsPanel(detail.teams || [])),
    ];
    if ((detail.triggers || []).length) rows.push(reconcile('triggers', detail.triggers, () => triggersPanel(detail.triggers)));
    else { panels.get('triggers')?.node.remove(); panels.delete('triggers'); }
    rows.push(reconcile('settings', [agent.role, agent.instructions, agent.endpoint_id, agent.model_override, agent.model_effort, agent.deliver_to_channel,
      agent.daily_run_cap, agent.keep_signed_in, agent.status], () => settingsPanel(agent, models, modelCatalog, channels, redraw)));
    for (const row of rows) if (row && row.parentNode !== workHost && !(row === computerHost && root.dataset.agentTab === 'chat' && row.parentNode?.classList.contains('agent-conversation-stream'))) workHost.append(row);
    const goals = reconcile('goals', detail.goals, () => routinesPanel(agentId, detail.goals, redraw, agent));
    if (goals.parentNode !== routinesHost) routinesHost.append(goals);
    const memory = panels.has('memory') ? panels.get('memory').node : reconcile('memory', detail.memory, () => memoryPanel(agentId, detail.memory));
    if (memory.parentNode !== memoryHost) memoryHost.append(memory);
    panels.get('memory').node.syncMemory(detail.memory);
    const journal = reconcile('memory-journal', detail.memory_upkeep_journal || [],
      () => memoryJournal(agentId, detail.memory_upkeep_journal || [], redraw));
    if (journal.parentNode !== memoryHost) memoryHost.append(journal);
  };

  async function redraw() {
    const version = ++refreshVersion;
    let next;
    try { next = await api(`/api/agents/${agentId}`); } catch { return; }
    if (version !== refreshVersion) return;
    detail = next;
    if (!document.body.contains(root)) return;
    if (catalogEndpoint !== detail.agent.endpoint_id) {
      catalogEndpoint = detail.agent.endpoint_id;
      modelCatalog = catalogEndpoint ? await api(`/api/models/${catalogEndpoint}/catalog`).catch(() => []) : [];
    }
    drawHeader(detail.agent);
    drawWork();
    profile.update(detail);
    if (detail.agent.status === "working") schedule(redraw);
  }

  drawHeader(detail.agent);
  drawWork();
  show(tab);
  if (profileOpen) profile.open();
  syncComputer();
  if (detail.agent.status === "working") schedule(redraw);
}

function teamsPanel(teams) {
  const panel = el("div", { class: "glass card agent-teams-panel" }, [
    el("div", { class: "title", text: "Teams" }),
    el("div", { class: "meta", style: "margin:4px 0 10px;", text: teams.length
      ? "On a team it works only with the team's tools. What it learns there comes back here as reports and corrections."
      : "Not on a team. Add it to one from Teams on the Agents page." }),
  ]);
  for (const team of teams) {
    panel.append(el("div", { class: "card-row", style: "justify-content:space-between;gap:10px;" }, [
      el("span", { text: `${team.name} · ${team.is_lead ? "lead" : "teammate"} · ${TEAM_STATE[team.state] || team.state}` }),
      el("button", { class: "btn quiet", text: "Open", onclick: () => openTeam(team.id) }),
    ]));
  }
  return panel;
}

// The webhook triggers that start this agent's work (Tasks > Triggers).
function triggersPanel(triggers) {
  const panel = el("div", { class: "glass card agent-triggers-panel" }, [
    el("div", { class: "title", text: "Triggers" }),
    el("div", { class: "meta", style: "margin:4px 0 10px;", text: "Outside events that start work for this agent. Manage them in Tasks." }),
  ]);
  for (const t of triggers) {
    panel.append(el("div", { class: "card-row", style: "justify-content:space-between;gap:10px;" }, [
      el("span", { text: `${t.name} · ${t.enabled ? (t.auto_run ? "runs straight away" : "asks you first") : "off"}` }),
      el("button", { class: "btn quiet", text: "Open", onclick: () => document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab: "tasks" } })) }),
    ]));
  }
  return panel;
}

function workPanel(agentId, cards, refresh, agent) {
  const panel = el("div", { class: "glass card" }, [el("div", { class: "title", text: "Work" })]);
  const open = cards.filter((c) => c.status !== "done");
  if (!open.length) panel.append(el("div", { class: "meta", style: "margin:6px 0;", text: "Nothing assigned right now." }));
  const label = { backlog: "Backlog", ready: "Up next", running: "Working on it", review: "Waiting for your review", blocked: "Blocked" };
  for (const card of open) {
    panel.append(el("button", { type: 'button', class: "agent-row agent-assignment-card", onclick: () => openAgentItemSheet({
      title: card.name, agent, description: card.prompt || label[card.status] || card.status,
      primary: card.status === 'running' ? 'Stop' : 'Open task board',
      onPrimary: async () => { if (card.status === 'running') { try { await api(`/api/tasks/${card.id}/stop`, { method: 'POST' }); refresh(); } catch (problem) { toast(problem.message, 'error'); } }
        else document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'tasks' } })); },
      secondary: 'Back to conversation', onSecondary: () => open(agentId) }) }, [
      avatar(agent, 36),
      el("div", {}, [el("div", { text: card.name }), el("div", { class: "meta", text: label[card.status] || card.status })]),
    ]));
  }
  const name = el("input", { placeholder: "e.g. Shortlist five roles" });
  const prompt = el("textarea", { rows: "2", placeholder: "What to do, as you would tell a person" });
  panel.append(el("details", { class: "disclosure-panel agent-job-flow" }, [el("summary", { text: "+ Give it a job" }), el("div", { class: "form-grid" }, [
    el("div", { class: "field field-grow" }, [el("label", { text: "Name" }), name]),
    el("div", { class: "field field-grow", style: "flex-basis:100%;" }, [el("label", { text: "What to do" }), prompt]),
    el("button", { class: "btn primary", text: "Assign", onclick: async () => {
      if (!name.value.trim() || !prompt.value.trim()) { toast("A job needs a name and what to do", "error"); return; }
      try { await api(`/api/agents/${agentId}/cards`, { method: "POST", body: JSON.stringify({ name: name.value.trim(), prompt: prompt.value.trim() }) }); refresh(); }
      catch (problem) { toast(problem.message, "error"); }
    } }),
  ])]));
  return panel;
}

function memoryPanel(agentId, memory) {
  const area = el("textarea", { class: "agent-memory", rows: "12", spellcheck: "false" });
  area.value = memory;
  let baseline = memory, server = memory;
  const conflict = el('div', { class: 'agent-profile-conflict', hidden: true });
  const useServer = el('button', { class: 'btn quiet', type: 'button', text: 'Use server version' });
  const serverText = el('pre', { class: 'agent-profile-file-text' });
  conflict.append(el('span', { text: 'Memory changed on the server. Your draft is kept; save it or use the server version.' }), serverText, useServer);
  const count = el("span", { class: "meta" });
  const update = () => { count.textContent = `${area.value.length} / 8000`; count.classList.toggle("is-error", area.value.length > 8000);
    conflict.hidden = area.value === baseline || server === baseline; };
  area.addEventListener("input", update);
  useServer.onclick = () => { baseline = server; area.value = server; area.dataset.draftBaseline = server; update(); };
  update();
  const panel = el("div", { class: "glass card" }, [
    el("div", { class: "title", text: "Memory" }),
    el("div", { class: "meta", style: "margin:4px 0 10px;", text: "What it carries into every run. It adds to this itself; corrections land here too. Edit freely." }),
    area,
    conflict,
    el("div", { class: "agent-row-actions", style: "margin-top:8px;" }, [count, el("button", { class: "btn", text: "Save memory", onclick: async () => {
      try {
        // 2026-10-13: a bot can update memory between polls. Show that new
        // version before the first Save; a second Save chooses the draft.
        const fresh = await api(`/api/agents/${agentId}`);
        const unseen = fresh.memory !== baseline && conflict.hidden;
        panel.syncMemory(fresh.memory);
        if (unseen) { toast('Memory changed on the server. Review it, then save again if you want your draft.', 'info'); return; }
        await api(`/api/agents/${agentId}/memory`, { method: "PUT", body: JSON.stringify({ text: area.value }) });
        baseline = server = area.value; area.dataset.draftBaseline = area.value; update(); toast("Memory saved", "success"); }
      catch (problem) { toast(problem.message, "error"); }
    } })]),
  ]);
  panel.syncMemory = (value) => { server = value; serverText.textContent = value;
    if (area.value === value) { baseline = value; area.dataset.draftBaseline = value; }
    if (area.value === baseline && document.activeElement !== area) {
    area.value = value; baseline = value; area.dataset.draftBaseline = value;
  } update(); };
  return panel;
}

function memoryJournal(agentId, entries, refresh) {
  const panel = el('section', { class: 'glass card agent-memory-journal' }, [
    el('div', { class: 'title', text: 'Upkeep journal' }),
    el('p', { class: 'meta', text: 'A record of memory that was tidied. You can undo an upkeep pass.' }),
  ]);
  if (!entries.length) panel.append(el('p', { class: 'meta', text: 'No upkeep yet.' }));
  for (const entry of entries) panel.append(el('div', { class: 'agent-row' }, [
    el('div', {}, [el('strong', { text: entry.topic || 'Main memory' }),
      el('div', { class: 'meta', text: `${(entry.changes || []).length} changes · ${relativeTime(entry.at)}` })]),
    entry.status === 'committed' ? el('button', { class: 'btn quiet', text: 'Undo', onclick: async () => {
      try { await api(`/api/agents/${agentId}/memory/upkeep/${entry.id}/undo`, { method: 'POST' });
        toast('Memory upkeep undone', 'success'); refresh(); }
      catch (problem) { toast(problem.message, 'error'); }
    } }) : el('span', { class: 'meta', text: entry.status }),
  ]));
  return panel;
}

function settingsPanel(agent, models, modelCatalog, channels, refresh) {
  const role = el("input", { value: agent.role || "" });
  const instructions = el("textarea", { rows: "3" });
  instructions.value = agent.instructions || "";
  const channel = customSelect({}, channelOptions(channels, agent.deliver_to_channel || ""));
  const cap = el("input", { type: "number", min: "1", max: "200", value: String(agent.daily_run_cap) });
  const keep = toggle({ checked: !!agent.keep_signed_in, label: 'Keep this agent signed in' });
  const save = async () => {
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ role: role.value.trim(), instructions: instructions.value.trim(),
        deliver_to_channel: channel.value || null, daily_run_cap: parseInt(cap.value, 10),
        keep_signed_in: keep.checked }) });
      toast("Saved", "success"); refresh();
    } catch (problem) { toast(problem.message, "error"); }
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: `Delete ${agent.name}?`,
      message: "Its memory, routines, unfinished work and inbox go. Its chats move to Chats; finished results and run history stay.", confirmLabel: "Delete agent" });
    if (!ok) return;
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab: "agents" } }));
    } catch (problem) { toast(problem.message, "error"); }
  };
  return el("details", { class: "disclosure-panel" }, [el("summary", { text: "Settings" }), el("div", { class: "form-grid" }, [
    el("div", { class: "field field-grow", style: "flex-basis:100%;" }, [el("label", { text: "Role" }), role]),
    el("div", { class: "field field-grow", style: "flex-basis:100%;" }, [el("label", { text: "How it should work" }), instructions]),
    el("div", { class: "field" }, [el("label", { text: "Model" }),
      el('span', { text: agentModelSummary(agent, models, modelCatalog) }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Choose model in profile', onclick: () => openProfile(agent.id) })]),
    el("div", { class: "field" }, [el("label", { text: "Tell me on" }), channel]),
    el("div", { class: "field field-sm" }, [el("label", { text: "Runs per day" }), cap]),
    el('div', { class: 'field field-grow' }, [el('label', { text: 'Keep signed in' }), keep,
      el('div', { class: 'meta', text: 'Keep this agent’s browser logins between runs.' })]),
    el('button', { class: 'btn quiet agent-forget-logins', text: 'Forget logins', disabled: true, onclick: async () => {
      await api(`/api/agents/${agent.id}/forget-logins`, { method: 'POST' });
      toast('Logins forgotten', 'success'); refresh();
    } }),
    el("button", { class: "btn primary", text: "Save", onclick: save }),
    el("button", { class: "btn danger", text: "Delete agent", onclick: remove }),
  ])]);
}
