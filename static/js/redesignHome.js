// Redesign preview, Home (step 4). views/home.js calls mountRedesignHome() once
// and forwards three things: arrange (the order/visibility pass), update (each
// data key as it lands) and dispose. Everything here is a no-op while the
// preview is off, and it undoes itself live when the switch is turned off
// (the `kairos:appearance` event), so Home looks and behaves as it does today.
//
// What it adds with the switch on:
//  - a 12-column packed card grid (natural spans 4/6/8/12; the last card of a
//    row widens to fill it, so every row sums to 12),
//  - the "Needs you" card (agent questions, results to approve, trigger
//    approvals, failed deliveries),
//  - "At a glance" (the number strip, as a card),
//  - the Customize sheet, which edits the SAME saved arrangement Settings >
//    Layout edits (layout.js: homeLayout/getLayout/saveLayout), so the two stay
//    in sync,
//  - usage rings on the model limits.
import { api, el, toast } from "./api.js";
import { agentAvatar } from "./agentAvatar.js";
import { getLayout, saveLayout, homeLayout, resetHomeLayout, knownHomeCards, HOME_SECTIONS } from "./layout.js";

const on = () => document.documentElement.classList.contains("kairos-redesign");
const navigate = (tab, options = {}) => document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab, ...options } }));
const isTab = (id) => id.startsWith("tab:");

// Natural column span and Customize-sheet wording per built-in card.
const META = {
  needs: { label: "Needs you", sub: "Replies, approvals and failures", span: 8 },
  chats: { label: "Recent chats", sub: "Your latest conversations", span: 4 },
  schedule: { label: "Upcoming", sub: "Events from the next seven days", span: 4 },
  models: { label: "Models", sub: "Providers, usage limits and tokens", span: 4 },
  system: { label: "Systems", sub: "Vault, scheduler, Discord, computer use", span: 4 },
  stats: { label: "At a glance", sub: "Counts for chats, notes, automations", span: 12 },
  projects: { label: "Projects", sub: "Project shelf with document counts", span: 4 },
  agents: { label: "Agents", sub: "Who is working and who needs you", span: 4 },
  activity: { label: "Activity", sub: "Recent events", span: 8 },
  store: { label: "Tool Store", sub: "Installed items and updates", span: 4 },
};
const TAB_SPAN = 4;
const spanOf = (id) => (META[id] ? META[id].span : TAB_SPAN);

// The redesign's default: these five, in this order, then the rest hidden.
const DEFAULT_ORDER = ["needs", "chats", "schedule", "models", "system", "stats", "projects", "agents", "activity", "store"];
const DEFAULT_SHOWN = 5;
// What an untouched arrangement looks like in the saved layout (layout.js).
const LEGACY_ORDER = HOME_SECTIONS.map((s) => s.id).filter((id) => id !== "needs");

const AUTO_KEY = "kairos:redesign-home-auto";
const readAuto = () => { try { return localStorage.getItem(AUTO_KEY); } catch { return null; } };
const writeAuto = (value) => { try { value ? localStorage.setItem(AUTO_KEY, value) : localStorage.removeItem(AUTO_KEY); } catch { /* optional */ } };

// The built-in part of an arrangement, comparable as a string.
const snapshot = (layout) => JSON.stringify({
  order: layout.home.filter((id) => !isTab(id) && id !== "needs"),
  hidden: layout.hiddenHome.filter((id) => !isTab(id) && id !== "needs").sort(),
});

// True when nobody has arranged Home: built-ins in today's default order,
// none hidden (the redesign-only "needs" aside), and no tab card turned on.
function untouched(layout) {
  const order = layout.home.filter((id) => !isTab(id) && id !== "needs");
  if (order.join() !== LEGACY_ORDER.join()) return false;
  if (layout.hiddenHome.some((id) => !isTab(id) && id !== "needs")) return false;
  return layout.home.filter(isTab).every((id) => layout.hiddenHome.includes(id));
}

// Write the redesign's default arrangement through layout.js's own API.
function applyDefault({ remember = false } = {}) {
  const layout = getLayout();
  const tabs = layout.home.filter(isTab);
  saveLayout({ ...layout, home: [...DEFAULT_ORDER, ...tabs], hiddenHome: [...DEFAULT_ORDER.slice(DEFAULT_SHOWN), ...tabs] });
  writeAuto(remember ? snapshot(getLayout()) : null);
}

// A person who never arranged Home gets the redesign's default. Someone with
// their own saved arrangement keeps it.
function ensureArrangement() {
  if (untouched(getLayout())) applyDefault({ remember: true });
}

// Switching the preview off puts back what we applied on its behalf, but only
// if the person hasn't changed it since.
let wasOn = on();
document.addEventListener("kairos:appearance", () => {
  const now = on();
  if (wasOn && !now) {
    const remembered = readAuto();
    if (remembered && remembered === snapshot(getLayout())) resetHomeLayout();
    writeAuto(null);
  }
  wasOn = now;
});

// Natural spans packed into 12-column rows: when the next card doesn't fit,
// the last card of the row widens to fill it. Every row sums to 12.
export function packRows(items) {
  const rows = [];
  let row = [], sum = 0;
  for (const item of items) {
    if (sum + item.span > 12) { row[row.length - 1].span += 12 - sum; rows.push(row); row = []; sum = 0; }
    row.push({ ...item }); sum += item.span;
    if (sum === 12) { rows.push(row); row = []; sum = 0; }
  }
  if (row.length) { row[row.length - 1].span += 12 - sum; rows.push(row); }
  return rows;
}

function relative(seconds) {
  const age = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  if (age < 60) return "just now";
  if (age < 3600) return Math.floor(age / 60) + "m ago";
  if (age < 86400) return Math.floor(age / 3600) + "h ago";
  return Math.floor(age / 86400) + "d ago";
}

const FAILURE_TYPES = new Set(["delivery.failed", "task.delivery_failed", "connector.delivery_failed"]);
const FAILURE_WINDOW = 3 * 86400;
const LATER_KEY = "kairos:home:needs-later";
const readLater = () => { try { return JSON.parse(localStorage.getItem(LATER_KEY) || "[]"); } catch { return []; } };
const writeLater = (list) => { try { localStorage.setItem(LATER_KEY, JSON.stringify(list.slice(-60))); } catch { /* optional */ } };

export function mountRedesignHome({ container, content, header, grid, parts, data, refresh, rearrange }) {
  let disposed = false, active = false, sheet = null, customizeButton = null, glance = null;
  let triggers = [], failures = [], failuresLoaded = false, triggersLoaded = false, lastSignature = "";

  // -- "At a glance": the number strip, framed as a card ----------------------
  const makeGlance = () => {
    const body = el("div", { class: "dashboard-section-body" });
    const panel = el("section", { class: "dashboard-section hm-glance", "aria-label": "At a glance" }, [
      el("div", { class: "dashboard-section-header" }, [el("h2", { text: "At a glance" })]), body,
    ]);
    return { panel, body };
  };

  // -- "Needs you" ------------------------------------------------------------
  const needsBody = el("div", { class: "dashboard-section-body hm-needs-body" });
  const needsCount = el("span", { class: "hm-needs-count" });
  const needs = el("section", { class: "dashboard-section hm-needs", "aria-label": "Needs you", "data-home-section": "needs" }, [
    el("div", { class: "hm-needs-head" }, [el("h2", { text: "Needs you" }), needsCount]), needsBody,
  ]);
  needsBody.append(el("div", { class: "skeleton skeleton-line" }), el("div", { class: "skeleton skeleton-line" }));

  const agentOf = (id) => (Array.isArray(data().agents) ? data().agents.find((a) => a.id === id) : null);

  async function act(work, success) {
    try { const result = await work(); if (success) toast(success(result), "success"); }
    catch (problem) { toast(problem.message || "That didn't work", "error"); }
    document.dispatchEvent(new CustomEvent("jarvis:agents-changed"));
    loadTriggers(); loadFailures(); refresh();
  }

  const button = (label, tone, onclick) => el("button", { type: "button", class: "hm-btn hm-btn-" + tone, text: label, onclick });

  function itemRow({ lead, title, sub, subTone, body, actions, compose }) {
    const composeRow = compose ? el("div", { class: "hm-compose", hidden: true }) : null;
    let field = null;
    if (compose) {
      field = el("input", { class: "hm-compose-input", type: "text", placeholder: compose.placeholder, "aria-label": compose.placeholder });
      field.addEventListener("keydown", (e) => { if (e.key === "Enter") send.click(); });
      var send = button("Send", "primary", () => {
        if (!field.value.trim()) { toast(compose.empty, "error"); return; }
        compose.submit(field.value.trim());
      });
      composeRow.append(field, send, button("Cancel", "ghost", () => { composeRow.hidden = true; field.value = ""; }));
    }
    const open = () => { if (composeRow) { composeRow.hidden = false; field.focus(); } };
    const buttons = actions(open).map(([label, tone, handler]) => button(label, tone, handler));
    return el("div", { class: "hm-need" }, [
      lead,
      el("div", { class: "hm-need-text" }, [
        el("div", { class: "hm-need-title", text: title, title }),
        el("div", { class: "hm-need-sub" + (subTone ? " is-" + subTone : ""), text: sub }),
        body ? el("div", { class: "hm-need-body", text: body }) : el("span"),
      ]),
      el("div", { class: "hm-need-actions" }, buttons),
      ...(composeRow ? [composeRow] : []),
    ]);
  }

  const initial = (text, tone) => el("span", { class: "hm-need-lead" + (tone ? " is-" + tone : ""), "aria-hidden": "true", text });
  const lead = (agent) => {
    if (!agent) return initial("K");
    const wrap = el("span", { class: "hm-need-lead is-avatar", "aria-hidden": "true" });
    wrap.append(agentAvatar(agent, 32));
    return wrap;
  };

  function collect() {
    const inbox = data().inbox, rows = [];
    const answer = (item, choice, text) => act(
      () => api(`/api/agents/inbox/${item.id}/answer`, { method: "POST", body: JSON.stringify({ choice, text: text || null }) }),
      (result) => (result?.next ? result.next[0].toUpperCase() + result.next.slice(1) : "Done"));
    for (const item of inbox?.items || []) {
      const agent = agentOf(item.agent_id);
      const computer = /^(Ready for you: press|Needs you: sign in|Needs you: embedded frame)/.test(item.title || "");
      const question = item.kind === "question";
      rows.push({ key: "item:" + item.id, node: () => itemRow({
        lead: lead(agent), title: item.title || "A question", sub: `${agent?.name || "Agent"} · ${relative(item.created_at)}`, body: item.body,
        compose: { placeholder: question ? "Your answer" : "Reply or guidance", empty: "Write a reply first", submit: (text) => answer(item, "reply", text) },
        actions: (open) => {
          const list = [];
          if (computer) {
            list.push(["Dismiss", "ghost", () => answer(item, "dismiss")], ["Reply", "secondary", open], ["Open computer", "primary", async () => {
              const running = await api("/api/computer").catch(() => []);
              if (!running.some((c) => c.owner === `agent:${item.agent_id}`)) { toast("This computer is closed.", "error"); return; }
              navigate("agents", { agentId: item.agent_id, agentTab: "work", computerTakeover: true });
            }]);
          } else if (question) list.push(["Dismiss", "ghost", () => answer(item, "dismiss")], ["Reply", "primary", open]);
          else list.push(["Reply", "ghost", open], ["Dismiss", "primary", () => answer(item, "dismiss")]);
          return list;
        } }) });
    }
    for (const card of inbox?.reviews || []) {
      const agent = agentOf(card.agent_id);
      const result = [...(card.comments || [])].reverse().find((c) => c.kind === "result");
      const move = (status, text) => act(() => api(`/api/tasks/${card.id}/status`, { method: "POST", body: JSON.stringify({ status, note: text || null }) }));
      rows.push({ key: "review:" + card.id, node: () => itemRow({
        lead: lead(agent), title: card.name || "A result", sub: `${agent?.name || "Agent"} · result to approve`, body: result ? result.text : "",
        compose: { placeholder: "What should change? (it remembers this)", empty: "Say what should change", submit: (text) => move("ready", text) },
        actions: (open) => [["Request changes", "ghost", open], ["Approve", "primary", () => move("done")]] }) });
    }
    for (const pending of triggers) {
      const answerTrigger = (approve) => act(() => api(`/api/triggers/pending/${pending.id}`, { method: "POST", body: JSON.stringify({ approve }) }), (r) => r?.next || "Done");
      rows.push({ key: "trigger:" + pending.id, node: () => itemRow({
        lead: initial("T"), title: `${pending.trigger_name}: ${pending.summary}`, sub: `${pending.event_type} · waiting for your OK`,
        actions: () => [["Skip", "ghost", () => answerTrigger(false)], ["Approve", "primary", () => answerTrigger(true)]] }) });
    }
    const later = readLater();
    for (const event of failures) {
      const key = "failure:" + event.ts;
      if (later.includes(key)) continue;
      rows.push({ key, node: () => itemRow({
        lead: initial("!", "danger"), title: event.message, sub: "Delivery failed and was given up", subTone: "danger",
        actions: () => [["Later", "ghost", () => { writeLater([...readLater(), key]); renderNeeds(true); }], ["Open Channels", "secondary", () => navigate("settings", { section: "channels" })]] }) });
    }
    return rows;
  }

  function renderNeeds(force = false) {
    if (disposed || !active) return;
    const admin = !!data().auth?.is_admin;
    const known = data().auth !== undefined && data().feed !== undefined && failuresLoaded
      && (admin ? data().inbox !== undefined && data().agents !== undefined && triggersLoaded : true);
    if (!known) return;
    const rows = collect();
    const signature = rows.map((r) => r.key).join("|") + "#" + (data().agents?.length || 0);
    if (!force && signature === lastSignature) return;
    // Don't rebuild under a half-typed reply.
    const typing = needsBody.querySelector(".hm-compose:not([hidden]) .hm-compose-input");
    if (!force && typing && typing.value) return;
    lastSignature = signature;
    needsCount.textContent = rows.length ? rows.length + " waiting" : "All clear";
    needsBody.replaceChildren(...(rows.length ? rows.map((r) => r.node()) : [el("div", { class: "hm-clear", text: "Nothing waiting. The moment is yours." })]));
  }

  async function loadTriggers() {
    if (!data().auth?.is_admin) { triggers = []; triggersLoaded = true; return; }
    const result = await api("/api/triggers").catch(() => null);
    if (disposed) return;
    triggers = Array.isArray(result?.pending) ? result.pending : [];
    triggersLoaded = true;
    renderNeeds();
  }
  async function loadFailures() {
    const events = await api("/api/system/events?limit=60").catch(() => null);
    if (disposed) return;
    const cutoff = Date.now() / 1000 - FAILURE_WINDOW;
    failures = Array.isArray(events) ? events.filter((e) => FAILURE_TYPES.has(e.type) && e.ts >= cutoff).slice(0, 5) : [];
    failuresLoaded = true;
    renderNeeds();
  }

  // -- Usage rings on the model limits -----------------------------------------
  function decorateRings() {
    for (const window_ of parts.models?.querySelectorAll(".dashboard-quota-window") || []) {
      // Home's visual cards already draw a ring with the percentage inside it.
      if (window_.querySelector(".hm-ring, .dashboard-quota-ring")) continue;
      const meter = window_.querySelector('[role="meter"]');
      const fill = window_.querySelector(".dashboard-quota-fill");
      const tone = (fill?.className.match(/tone-(\w+)/) || [])[1] || "ample";
      window_.prepend(el("span", { class: "hm-ring tone-" + tone, "aria-hidden": "true", style: `--rd-pct:${meter?.getAttribute("aria-valuenow") || 0}` }));
    }
  }

  // -- The grid ------------------------------------------------------------------
  const cardFor = (id) => {
    if (id === "needs") return needs;
    if (id === "stats") {
      if (!glance) glance = makeGlance();
      if (parts.stats.parentElement !== glance.body) glance.body.append(parts.stats);
      return glance.panel;
    }
    return parts[id] || null;
  };
  const everyCard = () => [needs, glance?.panel, ...Object.values(parts)].filter(Boolean);

  function arrange(order, hidden) {
    if (!on()) { deactivate(); return false; }
    if (!active) {
      activate();
      // Applying the default saved a new arrangement; use it, not the stale one.
      ({ order, hidden } = homeLayout());
    }
    const cards = order.filter((id) => !hidden.includes(id)).map((id) => ({ id, node: cardFor(id) })).filter((c) => c.node && !c.node.hidden);
    const rows = packRows(cards.map((c) => ({ id: c.id, span: spanOf(c.id) })));
    const spans = new Map(rows.flat().map((c) => [c.id, c.span]));
    for (const card of everyCard()) card.style.removeProperty("--rd-span");
    for (const c of cards) { c.node.style.setProperty("--rd-span", String(spans.get(c.id))); c.node.dataset.rdSpan = String(spans.get(c.id)); }
    const current = [...grid.children];
    if (current.length !== cards.length || cards.some((c, i) => current[i] !== c.node)) grid.replaceChildren(...cards.map((c) => c.node));
    return true;
  }

  function activate() {
    active = true;
    ensureArrangement();
    if (!customizeButton) {
      customizeButton = el("button", { type: "button", class: "hm-customize", text: "Customize", "aria-haspopup": "dialog", onclick: openSheet });
      header.append(customizeButton);
    }
    content.classList.add("hm-home");
    loadTriggers(); loadFailures();
    decorateRings();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    closeSheet(false);
    customizeButton?.remove(); customizeButton = null;
    content.classList.remove("hm-home");
    for (const card of everyCard()) { card.style.removeProperty("--rd-span"); delete card.dataset.rdSpan; }
    for (const ring of container.querySelectorAll(".hm-ring")) ring.remove();
    needs.remove();
    lastSignature = "";
  }

  // -- Customize sheet -----------------------------------------------------------
  const tabCard = (id) => knownHomeCards().find((c) => c.id === id);
  function sheetRows() {
    const layout = getLayout();
    const main = layout.home.filter((id) => META[id]);
    const tabs = layout.home.filter((id) => isTab(id) && tabCard(id));
    return { layout, main, tabs };
  }
  function change(mutate) {
    const layout = getLayout();
    mutate(layout);
    saveLayout(layout);
  }
  function swap(id, step) {
    change((layout) => {
      const group = (x) => isTab(x);
      const i = layout.home.indexOf(id);
      let j = i + step;
      while (j >= 0 && j < layout.home.length && (group(layout.home[j]) !== group(id) || (isTab(layout.home[j]) && !tabCard(layout.home[j])) || (!isTab(layout.home[j]) && !META[layout.home[j]]))) j += step;
      if (j < 0 || j >= layout.home.length) return;
      [layout.home[i], layout.home[j]] = [layout.home[j], layout.home[i]];
    });
  }
  function toggleCard(id) {
    change((layout) => {
      layout.hiddenHome = layout.hiddenHome.includes(id) ? layout.hiddenHome.filter((x) => x !== id) : [...layout.hiddenHome, id];
    });
  }

  function sheetRow(id, label, sub, shown, first, last) {
    const toggle = el("button", { type: "button", class: "hm-switch", role: "switch", "aria-checked": String(shown), "aria-label": (shown ? "Hide " : "Show ") + label, "data-focus": id + ":toggle", onclick: () => toggleCard(id) }, [el("span", { class: "hm-switch-knob" })]);
    const up = el("button", { type: "button", class: "hm-ib", "aria-label": "Move " + label + " up", "data-focus": id + ":up", text: "↑", onclick: () => swap(id, -1) });
    const down = el("button", { type: "button", class: "hm-ib", "aria-label": "Move " + label + " down", "data-focus": id + ":down", text: "↓", onclick: () => swap(id, 1) });
    up.disabled = first; down.disabled = last;
    return el("div", { class: "hm-sheet-row" }, [el("div", { class: "hm-sheet-text" }, [el("div", { class: "hm-sheet-label", text: label }), el("div", { class: "hm-sheet-sub", text: sub })]), toggle, up, down]);
  }

  function drawSheet() {
    if (!sheet) return;
    const focused = document.activeElement?.dataset?.focus;
    const { layout, main, tabs } = sheetRows();
    const shownCount = [...main, ...tabs].filter((id) => !layout.hiddenHome.includes(id)).length;
    const list = (ids, labelOf, subOf) => ids.map((id, i) => sheetRow(id, labelOf(id), subOf(id), !layout.hiddenHome.includes(id), i === 0, i === ids.length - 1));
    sheet.list.replaceChildren(
      el("div", { class: "hm-sheet-group" }, [el("h3", { text: "Cards" }), el("span", { text: `${shownCount} of ${main.length + tabs.length} shown` })]),
      ...list(main, (id) => META[id].label, (id) => META[id].sub),
      ...(tabs.length ? [el("div", { class: "hm-sheet-group" }, [el("h3", { text: "From your tabs" })]), ...list(tabs, (id) => tabCard(id).title, (id) => "From " + tabCard(id).tab_name)] : []),
    );
    if (focused) sheet.list.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }

  function openSheet() {
    if (sheet) return;
    const returnTo = document.activeElement;
    const done = el("button", { type: "button", class: "hm-btn hm-btn-primary", text: "Done", onclick: () => closeSheet(true) });
    const list = el("div", { class: "hm-sheet-list" });
    const panel = el("aside", { class: "hm-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Customize Home" }, [
      el("div", { class: "hm-sheet-top" }, [el("h2", { text: "Customize Home" }), done]),
      el("p", { class: "hm-sheet-intro", text: "Switch cards on or off and move them up or down. Home fills each row on its own." }),
      list,
      el("div", { class: "hm-sheet-foot" }, [
        el("button", { type: "button", class: "hm-btn hm-btn-secondary", text: "Reset to default", onclick: () => applyDefault() }),
        el("button", { type: "button", class: "hm-link", text: "Layout settings ↗", onclick: () => { closeSheet(false); navigate("settings", { section: "layout" }); } }),
      ]),
    ]);
    const scrim = el("div", { class: "hm-scrim", "aria-hidden": "true", onclick: () => closeSheet(true) });
    const root = el("div", { class: "hm-sheet-root" }, [scrim, panel]);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeSheet(true); return; }
      if (e.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll("button:not([disabled])")];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.append(root);
    sheet = { root, list, returnTo };
    drawSheet();
    done.focus();
  }
  function closeSheet(restore) {
    if (!sheet) return;
    const { root, returnTo } = sheet;
    sheet = null;
    root.remove();
    if (restore && returnTo?.isConnected) returnTo.focus();
  }

  // -- Events --------------------------------------------------------------------
  const onLayout = () => { if (active) drawSheet(); };
  const onAppearance = () => { if (on() !== active) rearrange(); };
  const onAgents = () => { if (active) { loadTriggers(); } };
  document.addEventListener("kairos:layout", onLayout);
  document.addEventListener("kairos:appearance", onAppearance);
  document.addEventListener("jarvis:agents-changed", onAgents);

  return {
    arrange,
    update(key) {
      if (!on() || disposed) return;
      if (key === "inbox") { loadTriggers(); renderNeeds(); }
      if (key === "feed") loadFailures();
      if (key === "agents") renderNeeds();
      if (["endpoints", "usage", "quotas"].includes(key)) decorateRings();
      // Cards that appear or vanish as their admin data lands re-pack the grid.
      if (["agents", "skills", "integrations", "tabs", "catalog"].includes(key)) rearrange();
    },
    dispose() {
      disposed = true;
      closeSheet(false);
      document.removeEventListener("kairos:layout", onLayout);
      document.removeEventListener("kairos:appearance", onAppearance);
      document.removeEventListener("jarvis:agents-changed", onAgents);
    },
  };
}
