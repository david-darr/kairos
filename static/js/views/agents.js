import { api, el, customSelect, toast, confirmDialog, emptyState } from "../api.js";
import { ICONS } from "../icons.js";
import { runHistory } from "../runHistory.js";
import { mountAgentChat } from "../agentChat.js";
import { mountComputerPanel } from "../computerPanel.js";
import { toggle } from "../settingsKit.js";
import { mountAgentProfile, portrait, profileColor } from "../agentProfile.js";

// Agents (2026-10-04, after xAI's Grok Bot and OpenAI's Dots): named workers
// with a role, standing goals, their own memory and an inbox. Their work runs
// as ordinary Tasks and board cards; services/agent_service.py and the vault
// spec "Agents - Phase 1 Persistent Agents (Build Spec)" have the design.
// Teams (phase 5, 2026-10-05) are Swarm companies, shown here through
// views/swarm.js in its embedded mode; Swarm has no tab of its own any more.

// The colors the backend accepts (services/agent_service.py COLORS).
const COLORS = ["#d9b260", "#b9d2e3", "#e8c39e", "#d99a92", "#b5c7a5", "#cdbfd9"];
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
function releasePortraits(node) {
  for (const face of [node, ...node.querySelectorAll('.agent-portrait')]) face.stopPortrait?.();
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
  if (options.agentId) await agentPage(root, options.agentId, schedule, cleanups, options.agentTab || "chat", !!options.computerTakeover, !!options.profile, options.sessionId);
  else await listPage(root, schedule);
  return () => { clearTimeout(timer); cleanups.forEach((cleanup) => cleanup()); releasePortraits(root); };
}

export function avatar(agent, size = 28) {
  const node = portrait(agent, size);
  node.classList.add('agent-avatar');
  return node;
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

function modelOptions(models, selected = "") {
  return [
    el("option", { value: "", text: "Claude (default)", ...(selected ? {} : { selected: "" }) }),
    ...models.map((m) => el("option", { value: m.id, text: m.name, ...(m.id === selected ? { selected: "" } : {}) })),
  ];
}

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
  const [agents, inbox, models, channels, teams] = await Promise.all([
    api("/api/agents"), api("/api/agents/inbox"), api("/api/models").catch(() => []), api("/api/channels").catch(() => []),
    api("/api/swarm/systems").catch(() => null),
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
    ])]), inboxHost, newAgentForm(models, channels, root, schedule), grid, teamHost);
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
    } else { releasePortraits(row.node); row.node.remove(); state.inbox.delete(key); }
  }
  state.inboxHost.hidden = !inbox.count && !state.inbox.size;
  for (const [index, row] of incoming.entries()) {
    const signature = JSON.stringify(row.value);
    let old = state.inbox.get(row.key);
    if (!old) { old = { node: markDrafts(row.make()), signature }; state.inbox.set(row.key, old); }
    else if (old.signature !== signature && !hasDraft(old.node)) { const next = markDrafts(row.make()); releasePortraits(old.node); old.node.replaceWith(next); old.node = next; old.signature = signature; }
    if (state.inboxPanel.children[index + 1] !== old.node && !hasDraft(old.node))
      state.inboxPanel.insertBefore(old.node, state.inboxPanel.children[index + 1] || null);
  }
  const agentKeys = new Set(agents.map(agent => agent.id));
  for (const [id, tile] of state.tiles) if (!agentKeys.has(id)) { releasePortraits(tile.node); tile.node.remove(); state.tiles.delete(id); }
  if (agents.length && state.emptyNode) { state.emptyNode.remove(); state.emptyNode = null; }
  for (const [index, agent] of agents.entries()) {
    const signature = JSON.stringify([agent.name, agent.role, agent.color, agent.status, agent.status_detail, agent.runs_today, agent.daily_run_cap]);
    let tile = state.tiles.get(agent.id);
    if (tile?.signature === signature) {
      if (state.grid.children[index] !== tile.node) state.grid.insertBefore(tile.node, state.grid.children[index] || null);
      continue;
    }
    const node = el("button", { type: "button", class: "agent-tile", onclick: () => open(agent.id) }, [
      el("div", { class: "agent-tile-head" }, [avatar(agent, 34), el("div", { class: "agent-tile-name" }, [
        el("div", { class: "title", text: agent.name }),
        el("div", { class: "meta", text: agent.role || "No role yet" }),
      ])]),
      el("div", { class: "agent-tile-foot" }, [
        el("span", { class: `agent-status agent-status-${agent.status}`, text: STATUS[agent.status] || agent.status }),
        el("span", { class: "meta", text: agent.status === "working" ? agent.status_detail
          : `${agent.runs_today} of ${agent.daily_run_cap} runs today` }),
      ]),
    ]);
    if (tile) { releasePortraits(tile.node); tile.node.replaceWith(node); }
    tile = { node, signature }; state.tiles.set(agent.id, tile);
    if (state.grid.children[index] !== node) state.grid.insertBefore(node, state.grid.children[index] || null);
  }
  if (!agents.length && !state.emptyNode) { state.emptyNode = emptyState({ icon: ICONS.agents, title: 'No agents yet',
    hint: 'Create one above: give it a name, a role, and something to watch or do.' }); state.grid.append(state.emptyNode); }
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

function newAgentForm(models, channels, root, schedule) {
  const form = el("details", { class: "disclosure-panel" });
  const name = el("input", { placeholder: "e.g. Scout", maxlength: '100' });
  const role = el("input", { placeholder: "e.g. Watches my job applications and new postings", maxlength: '200' });
  const instructions = el("textarea", { rows: "3", placeholder: "How it should work: sources to use, what to leave out, how to report." });
  const model = customSelect({}, modelOptions(models));
  const channel = customSelect({}, channelOptions(channels));
  let color = COLORS[0];
  const swatches = el("div", { class: "agent-swatches", role: "radiogroup", "aria-label": "Color" });
  const paint = () => swatches.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === color)));
  for (const c of COLORS) {
    swatches.append(el("button", { type: "button", role: "radio", "data-color": c, "aria-label": c, style: `background:${c}`,
      onclick: () => { color = c; paint(); } }));
  }
  paint();
  const create = async () => {
    if (!name.value.trim()) { toast("Give the agent a name", "error"); return; }
    try {
      const agent = await api("/api/agents", { method: "POST", body: JSON.stringify({
        name: name.value.trim(), role: role.value.trim(), instructions: instructions.value.trim(),
        endpoint_id: model.value || null, color, deliver_to_channel: channel.value || null }) });
      toast(`${agent.name} is ready`, "success");
      open(agent.id);
    } catch (problem) { toast(problem.message, "error"); }
  };
  form.append(el("summary", { text: "+ New agent" }), el("div", { class: "form-grid" }, [
    el("div", { class: "field" }, [el("label", { text: "Name" }), name]),
    el("div", { class: "field field-grow" }, [el("label", { text: "Role" }), role]),
    el("div", { class: "field field-grow", style: "flex-basis:100%;" }, [el("label", { text: "How it should work" }), instructions]),
    el("div", { class: "field" }, [el("label", { text: "Model" }), model]),
    el("div", { class: "field" }, [el("label", { text: "Tell me on" }), channel]),
    el("div", { class: "field" }, [el("label", { text: "Color" }), swatches]),
    el("button", { class: "btn primary", text: "Create agent", onclick: create }),
  ]));
  return form;
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

function inboxItem(item, agent, refresh) {
  const kind = { question: "Question", report: "Report" }[item.kind];
  const reply = el("input", { class: "agent-reply", placeholder: item.kind === "question" ? "Your answer" : "Reply or guidance (optional)" });
  const button = (text, onclick, cls = "btn") => el("button", { class: cls, text, onclick });
  const send = (choice) => () => {
    if (choice === "reply" && !reply.value.trim()) { toast("Write a reply first", "error"); return; }
    answer(item, choice, reply.value.trim(), () => { if (reply.closest('.agent-inbox-item')?.contains(document.activeElement)) document.activeElement.blur();
      reply.dataset.draftBaseline = reply.value; return refresh(); });
  };
  const actions = el("div", { class: "agent-inbox-actions" });
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
  if (item.kind === "question") {
    actions.append(reply, button("Answer", send("reply"), "btn primary"), button("Dismiss", send("dismiss"), "btn quiet"));
  } else {
    actions.append(button("Dismiss", send("dismiss")), reply, button("Reply", send("reply"), "btn quiet"));
  }
  return el("div", { class: `agent-inbox-item agent-inbox-${item.kind}` }, [
    el("div", { class: "agent-inbox-head" }, [
      agent ? avatar(agent, 22) : el("span"),
      el("span", { class: "agent-inbox-kind", text: kind }),
      el("span", { class: "agent-inbox-title", text: `${agent?.name || "Agent"}: ${item.title}` }),
      el("span", { class: "meta", text: new Date(item.created_at * 1000).toLocaleString() }),
    ]),
    item.body ? el("div", { class: "agent-inbox-body", text: item.body }) : el("span"),
    actions,
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
  return el("div", { class: "agent-inbox-item agent-inbox-review" }, [
    el("div", { class: "agent-inbox-head" }, [
      agent ? avatar(agent, 22) : el("span"),
      el("span", { class: "agent-inbox-kind", text: "Result" }),
      el("span", { class: "agent-inbox-title", text: `${agent?.name || "Agent"}: ${card.name}` }),
    ]),
    el("div", { class: "agent-inbox-body", text: result ? result.text : "(no result text)" }),
    el("div", { class: "agent-inbox-actions" }, [
      el("button", { class: "btn primary", text: "Approve", onclick: () => move("done") }),
      note,
      el("button", { class: "btn quiet", text: "Request changes", onclick: () => {
        if (!note.value.trim()) { toast("Say what should change", "error"); return; }
        move("ready", note.value.trim());
      } }),
    ]),
  ]);
}

// -- one agent ----------------------------------------------------------------

async function agentPage(root, agentId, schedule, cleanups, tab = "chat", takeOver = false, profileOpen = false, sessionId = null) {
  let detail;
  try {
    detail = await api(`/api/agents/${agentId}`);
  } catch {
    root.innerHTML = "";
    root.append(emptyState({ icon: ICONS.agents, title: "That agent no longer exists", hint: "Go back to Agents to see the others." }));
    return;
  }
  const [models, channels] = await Promise.all([api("/api/models").catch(() => []), api("/api/channels").catch(() => [])]);
  if (!document.body.contains(root)) return;
  root.innerHTML = "";

  // Built once: the header and the two tabs. Only the header's status and
  // the Work tab redraw while the agent is busy, so an open chat is never
  // rebuilt under the person typing in it.
  const header = el("div", { class: "agent-header" });
  const profile = mountAgentProfile(root, detail, models, channels, () => redraw());
  cleanups.push(profile.dispose);
  const chatTab = el("button", { type: "button", role: "tab", class: "agent-tab", text: "Chat" });
  const workTab = el("button", { type: "button", role: "tab", class: "agent-tab" });
  const chatHost = el("div", { role: "tabpanel", class: "agent-tab-panel agent-chat-host" });
  const workHost = el("div", { role: "tabpanel", class: "agent-tab-panel agent-work-host" });
  const computerHost = el('div', { class: 'glass card agent-computer-section', hidden: true });
  let computerView = null;
  const syncComputer = async () => {
    const running = (await api('/api/computer').catch(() => []))
      .find(item => item.owner === `agent:${agentId}`);
    if (!document.body.contains(root)) return;
    if (workHost.hidden) {
      if (computerView) { computerView.dispose(); computerView = null; computerHost.replaceChildren(); }
      return;
    }
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
    for (const [button, host, name] of [[chatTab, chatHost, "chat"], [workTab, workHost, "work"]]) {
      button.setAttribute("aria-selected", String(which === name));
      button.classList.toggle("active", which === name);
      host.hidden = which !== name;
    }
    if (which === "chat" && !chatMounted) {
      chatMounted = true;
      mountAgentChat(chatHost, detail.agent, sessionId).then((cleanup) => cleanups.push(cleanup));
    }
    if (which === 'work') syncComputer();
    else if (computerView) { computerView.dispose(); computerView = null; computerHost.replaceChildren(); }
  };
  chatTab.addEventListener("click", () => show("chat"));
  workTab.addEventListener("click", () => show("work"));
  root.append(
    el("button", { class: "btn quiet agent-back", text: "← All agents", onclick: () => document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab: "agents" } })) }),
    header,
    el("div", { class: "agent-tabs", role: "tablist", "aria-label": "Agent" }, [chatTab, workTab]),
    chatHost, workHost,
  );

  let headerSignature = '';
  const drawHeader = (agent) => {
    const signature = JSON.stringify([agent.name, agent.role, agent.color, agent.enabled, agent.status,
      agent.status_detail, agent.runs_today, agent.daily_run_cap, agent.needs_you]);
    if (signature === headerSignature) return;
    headerSignature = signature;
    const toggle = el("button", { class: agent.enabled ? "btn" : "btn primary", text: agent.enabled ? "Turn off" : "Turn on",
      onclick: async () => { await api(`/api/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ enabled: !agent.enabled }) }); redraw(); } });
    releasePortraits(header);
    header.replaceChildren(
      avatar(agent, 48),
      el("div", { class: "agent-header-text" }, [
        el("h2", { text: agent.name }),
        el("div", { class: "sub", text: agent.role || "No role yet" }),
        el("div", { class: "agent-header-meta" }, [
          el("span", { class: `agent-status agent-status-${agent.status}`, text: STATUS[agent.status] || agent.status }),
          el("span", { class: "meta", text: [agent.status_detail, `${agent.runs_today} of ${agent.daily_run_cap} runs today`]
            .filter(Boolean).join(" · ") }),
        ]),
      ]),
      el("div", { class: "agent-header-actions" }, [
        el('button', { class: 'btn agent-profile-open', text: 'Profile', onclick: () => profile.open() }), toggle]),
    );
    workTab.textContent = agent.needs_you ? `Work (${agent.needs_you})` : "Work";
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
        const next = markDrafts(make()); releasePortraits(entry.node); entry.node.replaceWith(next); entry.node = next; entry.signature = signature; entry.notice = null;
      }
    }
    return entry.node;
  };
  const drawWork = () => {
    const { agent } = detail;
    const reviews = detail.cards.filter((c) => c.status === "review");
    const byId = new Map([[agent.id, agent]]);
    const rows = [
      reconcile('inbox', [detail.inbox, reviews], () => inboxPanel('Inbox', detail.inbox, reviews, byId, redraw)),
      computerHost,
      reconcile('goals', detail.goals, () => goalsPanel(agentId, detail.goals, redraw)),
      reconcile('cards', detail.cards, () => workPanel(agentId, detail.cards, redraw)),
      panels.has('memory') ? panels.get('memory').node : reconcile('memory', detail.memory, () => memoryPanel(agentId, detail.memory)),
      reconcile('history', detail.runs, () => el('div', { class: 'glass card' }, [el('div', { class: 'title', text: 'History' }), runHistory(detail.runs)])),
      reconcile('teams', detail.teams || [], () => teamsPanel(detail.teams || [])),
    ];
    if ((detail.triggers || []).length) rows.push(reconcile('triggers', detail.triggers, () => triggersPanel(detail.triggers)));
    else { panels.get('triggers')?.node.remove(); panels.delete('triggers'); }
    rows.push(reconcile('settings', [agent.role, agent.instructions, agent.endpoint_id, agent.deliver_to_channel,
      agent.daily_run_cap, agent.keep_signed_in, agent.status], () => settingsPanel(agent, models, channels, redraw)));
    for (const row of rows) if (row && row.parentNode !== workHost) workHost.append(row);
    panels.get('memory').node.syncMemory(detail.memory);
  };

  async function redraw() {
    const version = ++refreshVersion;
    let next;
    try { next = await api(`/api/agents/${agentId}`); } catch { return; }
    if (version !== refreshVersion) return;
    detail = next;
    if (!document.body.contains(root)) return;
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

function cadence(goal) {
  if (goal.schedule_kind === "daily") return `Every day at ${goal.run_time}`;
  const minutes = Math.round((goal.interval_seconds || 0) / 60);
  return minutes % 60 === 0 ? `Every ${minutes / 60 === 1 ? "hour" : `${minutes / 60} hours`}` : `Every ${minutes} minutes`;
}

function goalsPanel(agentId, goals, refresh) {
  const panel = el("div", { class: "glass card" }, [
    el("div", { class: "title", text: "Standing goals" }),
    el("div", { class: "meta", style: "margin:4px 0 10px;", text: "Checked on a schedule. Quiet goals only report when something turned up." }),
  ]);
  for (const goal of goals) {
    panel.append(el("div", { class: "agent-row" }, [
      el("div", {}, [el("div", { text: goal.name }), el("div", { class: "meta", text:
        `${cadence(goal)} · ${goal.report_when === "always" ? "always reports" : "reports when notable"}${goal.enabled ? "" : " · off"}` })]),
      el("div", { class: "agent-row-actions" }, [
        el("button", { class: "btn quiet", text: "Check now", onclick: async () => {
          try { await api(`/api/tasks/${goal.id}/run`, { method: "POST" }); toast("Checked", "success"); }
          catch (problem) { toast(problem.message, "error"); }
          refresh();
        } }),
        el("button", { class: "btn danger", text: "Remove", onclick: async () => {
          if (!await confirmDialog({ title: "Remove this goal?", message: `"${goal.name}" will stop being checked.`, confirmLabel: "Remove" })) return;
          await api(`/api/tasks/${goal.id}`, { method: "DELETE" }); refresh();
        } }),
      ]),
    ]));
  }
  const name = el("input", { placeholder: "e.g. New postings" });
  const prompt = el("textarea", { rows: "2", placeholder: "What to check, and what counts as worth telling you" });
  const kind = customSelect({}, [el("option", { value: "daily", text: "Every day at" }), el("option", { value: "interval", text: "Every N hours" })]);
  const time = el("input", { type: "time", value: "08:00" });
  const hours = el("input", { type: "number", min: "1", value: "6" });
  const timeField = el("div", { class: "field field-sm" }, [el("label", { text: "At" }), time]);
  const hoursField = el("div", { class: "field field-sm", style: "display:none;" }, [el("label", { text: "Hours" }), hours]);
  kind.addEventListener("change", () => {
    timeField.style.display = kind.value === "daily" ? "" : "none";
    hoursField.style.display = kind.value === "interval" ? "" : "none";
  });
  const report = customSelect({}, [el("option", { value: "notable", text: "Only when notable" }), el("option", { value: "always", text: "Every time" })]);
  const add = async () => {
    if (!name.value.trim() || !prompt.value.trim()) { toast("A goal needs a name and what to check", "error"); return; }
    const body = { name: name.value.trim(), prompt: prompt.value.trim(), schedule_kind: kind.value, report_when: report.value };
    if (kind.value === "daily") body.run_time = time.value; else body.interval_seconds = Math.max(1, parseInt(hours.value, 10) || 1) * 3600;
    try { await api(`/api/agents/${agentId}/goals`, { method: "POST", body: JSON.stringify(body) }); refresh(); }
    catch (problem) { toast(problem.message, "error"); }
  };
  panel.append(el("details", { class: "disclosure-panel" }, [el("summary", { text: "+ Add a goal" }), el("div", { class: "form-grid" }, [
    el("div", { class: "field field-grow" }, [el("label", { text: "Name" }), name]),
    el("div", { class: "field field-grow", style: "flex-basis:100%;" }, [el("label", { text: "What to check" }), prompt]),
    el("div", { class: "field" }, [el("label", { text: "When" }), kind]), timeField, hoursField,
    el("div", { class: "field" }, [el("label", { text: "Report" }), report]),
    el("button", { class: "btn primary", text: "Add goal", onclick: add }),
  ])]));
  return panel;
}

function workPanel(agentId, cards, refresh) {
  const panel = el("div", { class: "glass card" }, [el("div", { class: "title", text: "Work" })]);
  const open = cards.filter((c) => c.status !== "done");
  if (!open.length) panel.append(el("div", { class: "meta", style: "margin:6px 0;", text: "Nothing assigned right now." }));
  const label = { backlog: "Backlog", ready: "Up next", running: "Working on it", review: "Waiting for your review", blocked: "Blocked" };
  for (const card of open) {
    panel.append(el("div", { class: "agent-row" }, [
      el("div", {}, [el("div", { text: card.name }), el("div", { class: "meta", text: label[card.status] || card.status })]),
    ]));
  }
  const name = el("input", { placeholder: "e.g. Shortlist five roles" });
  const prompt = el("textarea", { rows: "2", placeholder: "What to do, as you would tell a person" });
  panel.append(el("details", { class: "disclosure-panel" }, [el("summary", { text: "+ Give it a job" }), el("div", { class: "form-grid" }, [
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

function settingsPanel(agent, models, channels, refresh) {
  const role = el("input", { value: agent.role || "" });
  const instructions = el("textarea", { rows: "3" });
  instructions.value = agent.instructions || "";
  const model = customSelect({}, modelOptions(models, agent.endpoint_id || ""));
  const channel = customSelect({}, channelOptions(channels, agent.deliver_to_channel || ""));
  const cap = el("input", { type: "number", min: "1", max: "200", value: String(agent.daily_run_cap) });
  const keep = toggle({ checked: !!agent.keep_signed_in, label: 'Keep this agent signed in' });
  const save = async () => {
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ role: role.value.trim(), instructions: instructions.value.trim(),
        endpoint_id: model.value || null, deliver_to_channel: channel.value || null, daily_run_cap: parseInt(cap.value, 10),
        keep_signed_in: keep.checked }) });
      toast("Saved", "success"); refresh();
    } catch (problem) { toast(problem.message, "error"); }
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: `Delete ${agent.name}?`,
      message: "Its memory, goals, unfinished work and inbox go. Its chats move to Chats; finished results and run history stay.", confirmLabel: "Delete agent" });
    if (!ok) return;
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab: "agents" } }));
    } catch (problem) { toast(problem.message, "error"); }
  };
  return el("details", { class: "disclosure-panel" }, [el("summary", { text: "Settings" }), el("div", { class: "form-grid" }, [
    el("div", { class: "field field-grow", style: "flex-basis:100%;" }, [el("label", { text: "Role" }), role]),
    el("div", { class: "field field-grow", style: "flex-basis:100%;" }, [el("label", { text: "How it should work" }), instructions]),
    el("div", { class: "field" }, [el("label", { text: "Model" }), model]),
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
