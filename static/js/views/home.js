import { api, apiRecent, el, modelMark, openPanelDialog } from "../api.js";
import { createMascot, STATE_WORDS } from "../mascot.js";
import { wireKipSwitch } from "../kipPicker.js";
import * as chatStream from "../chatStream.js";
import { openModelSetup } from "../modelSetup.js";
import { ICONS } from "../icons.js";
import { mountBackgroundEffect } from "../backgroundEffects.js";
import { halftonePalette, halftoneSource, halftoneFocus, halftoneVersion } from "../appearance.js";
import { homeLayout, setHomeCards, knownHomeCards, knownTabs } from "../layout.js";
import { mountRedesignHome } from "../redesignHome.js";
import { isForgeChat, forgeTag } from "../sidebarNav.js";
import { loadQuotas } from '../kairosParts.js';
import { mountMobileHome } from '../mobileShell.js';
import { SIGN_IN, toSnap, toneOf, usedCopy, pctText, resetCopy, ago, staleOf } from "../quotaReadings.js";

import { settingsOpen } from "../settingsOpen.js";
// Home cards use list rows, system status dots and usage rings.
const navigate = (tab, options = {}) => document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab, ...options } }));
function icon(name) {
  const node = el("span", { class: "dashboard-icon", "aria-hidden": "true" });
  node.innerHTML = ICONS[name] || ICONS.notes;
  return node;
}
function action(label, tab, primary = false, options = {}) {
  return el("button", { type: "button", class: primary ? "btn primary" : "btn quiet", text: label, onclick: () => navigate(tab, options) });
}
function section(title, link, tab, tabIcon = null) {
  const body = el("div", { class: "dashboard-section-body" });
  const arrow = action("↗", tab);
  arrow.title = link;
  arrow.setAttribute("aria-label", link);
  const heading = el("h2", { text: title });
  if (tabIcon !== null) {
    const mark = icon("library");
    if (tabIcon) mark.innerHTML = tabIcon;
    heading.prepend(mark);
  }
  const panel = el("section", { class: "dashboard-section" }, [
    el("div", { class: "dashboard-section-header" }, [heading, arrow]), body,
  ]);
  return { panel, body };
}
function empty(body, message, failed = false, plain = message) {
  body.replaceChildren(el("div", { class: "dashboard-empty", text: failed ? "Couldn't load this section. Try opening it again." : plain }));

}
function badge(text, tone = '') {
  return el('span', { class: 'dashboard-badge ' + tone, text });
}
function row(title, detail, onclick) {
  return el(onclick ? "button" : "div", { class: "dashboard-row", ...(onclick ? { type: "button", onclick } : {}) }, [
    el("span", { class: "dashboard-row-title", text: title, title }),
    el("span", { class: "dashboard-row-detail", text: detail, title: detail }),
  ]);
}
function compactTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// What a model row may honestly claim (2026-09-22). This used to show each
// model's share of all Kairos-recorded tokens labelled "% used", which read
// as a quota and was inflated by cache reads. A subscription CLI's real usage
// comes only from the provider's own limits, so those rows show nothing here
// until that source is wired in (the parked desktop usage overlay reads it).
// Everything else shows tokens actually spent through Kairos, with cache
// reuse - cheap re-reads of a prompt the provider already holds - kept apart.
function usageLabel(endpoint, usage) {
  if (!usage || endpoint.kind === "claude_cli" || endpoint.kind === "codex_cli" || endpoint.kind === "antigravity_cli") return null;
  const spent = usage.fresh_tokens + usage.unsplit_tokens;
  if (!spent) return null;
  const cached = usage.cache_read_tokens ? ` · ${compactTokens(usage.cache_read_tokens)} reused from cache` : "";
  return {
    text: `${compactTokens(spent)} tokens via Kairos${cached}`,
    title: "Tokens this Kairos install sent and received through this model: new input, cache writes and output. Not a quota.",
  };
}

// A subscription's account limits, as the desktop overlay shows them (David,
// 2026-10-07): each window's bar, how much is used and left, and when it
// resets; or why there's no reading. Shared wording: quotaReadings.js.
const QUOTA_PROVIDER = { claude_cli: "claude", codex_cli: "codex", antigravity_cli: "antigravity" };
function quotaBlock(providerId, reading) {
  const snap = toSnap(reading);
  const block = el("div", { class: "dashboard-quota", "data-provider": providerId });
  if (staleOf(snap) && snap.fetched_at) block.append(el("span", { class: "dashboard-quota-note", text: "Updated " + ago(snap.fetched_at) }));
  if (snap.status === "needsAuth") {
    block.append(el("span", { class: "dashboard-quota-note", text: [SIGN_IN[providerId], snap.note].filter(Boolean).join(" ") }));
    return block;
  }
  if (!snap.windows.length) {
    block.append(el("span", { class: "dashboard-quota-note", text: snap.note || "Waiting for the first reading…" }));
    return block;
  }
  for (const w of snap.windows) {
    const percent = Math.min(w.used, 1) * 100;
    // A plain meter; redesignHome.js draws the usage ring from it.
    block.append(el("div", { class: "dashboard-quota-window" }, [
      el("div", { class: "dashboard-quota-head", title: usedCopy(w) }, [el("span", { text: `${w.id === "session" ? "5h" : w.id === "weekly" ? "Week" : w.label} · ${pctText(w.used)}%` }), el("span", { class: "dashboard-quota-reset", text: resetCopy(w.resets_at).replace(/^Resets at /, "resets ").replace(/^Resets/, "resets") })]),
      el("div", { class: "dashboard-quota-track", role: "meter", "aria-label": `${w.label}: ${usedCopy(w)}`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) }, [
        el("span", { class: "dashboard-quota-fill tone-" + toneOf(w.used), style: `width:${percent.toFixed(0)}%` }),
      ]),
    ]));
  }
  return block;
}

function relativeTime(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp * 1000) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return minutes + "m ago";
  if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
  return Math.floor(minutes / 1440) + "d ago";
}
// Date-only calendar entries are local days, not UTC instants.
function eventDate(value) {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T00:00:00" : value);
}

// Counts a stat's number up from zero over 600 ms, easing out.
function countUp(node) {
  const target = Number(node.textContent);
  if (!Number.isFinite(target) || target <= 0) return;
  if (!node.isConnected) return;  // a hidden card: leave the real number, not a frozen 0
  const started = performance.now();
  const step = (now) => {
    if (!node.isConnected) { node.textContent = String(target); return; }  // hidden mid-count: keep the real number
    const t = Math.min(1, (now - started) / 600);
    node.textContent = String(Math.round(target * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  node.textContent = "0";
  requestAnimationFrame(step);
}

// Return cleanup synchronously: navigating away during a pending request
// releases the scene immediately. Home reads cheap summary APIs only.
export function render(container, tabId, options = {}) {
  container.replaceChildren();
  container.classList.add("dashboard");
  let disposed = false, refreshing = false, refreshQueued = false, nextTask = null;
  const statusLabel = el("span", { text: "Checking system" });
  const statusDot = el("span", { class: "status-dot" });
  // The banner: the Kairos figure as halftone (BRAND.md 6.8), still, with
  // the text over a parchment wash on its left.
  const banner = el("div", { class: "dashboard-core", "aria-hidden": "true" });
  const nextTaskLabel = el("span", { class: "dashboard-next", text: "Checking schedule…" });
  // Kairos beside the greeting (Kairos Mascot build spec, 2026-10-22), in
  // Kip in the person's chosen style (Appearance > Kip; halftone by default),
  // showing the app's aggregate state: needs you beats working beats idle
  // (botStatus.js order). Clicking Kip opens the style menu (kipPicker.js); when
  // he needs you the menu also offers Agents, where the waiting items are
  // answered, and it never answers anything itself. Hidden, the same spot reads Show Kip.
  const heroMascot = createMascot({ state: "idle", decorative: true });
  const heroMascotButton = el("button", { type: "button", class: "dashboard-mascot", "aria-label": "Kip, idle" }, [heroMascot]);
  let heroName = "Kip, idle";
  const kipSwitch = wireKipSwitch(heroMascotButton, { name: () => heroName,
    needs: () => heroMascotButton.dataset.state === "needs" ? () => navigate("agents") : null });
  const syncHeroMascot = () => {
    const agentList = Array.isArray(data.agents) ? data.agents : [];
    const state = (data.inbox?.count || 0) > 0 || agentList.some((a) => a.status === "needs_you" || a.needs_you > 0) ? "needs"
      : agentList.some((a) => a.status === "working") || chatStream.listInFlight().some((e) => e.status === "processing") ? "thinking" : "idle";
    if (heroMascot.getAttribute("state") !== state) heroMascot.setAttribute("state", state);
    heroMascotButton.dataset.state = state;
    heroName = `Kip, ${STATE_WORDS[state]}`;
    kipSwitch.sync();
  };
  const stopHeroStream = chatStream.subscribeAll(() => syncHeroMascot());
  const content = el("div", { class: "dashboard-content" });
  const header = el("header", { class: "dashboard-header" }, [
    el("div", {}, [el("div", { class: "eyebrow", text: "Overview" }), el("p", { text: new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) })]),
    el("div", { class: "dashboard-system-pill", role: "status" }, [statusDot, statusLabel]),
  ]);
  const hero = el("section", { class: "dashboard-hero" }, [
    banner,
    header,
    el("div", { class: "dashboard-intro" }, [
      heroMascotButton,
      el("div", { class: "eyebrow", text: "Kairos, the opportune moment" }),
      el("h1", { class: "k-display" }, ["Not more time. ", el("span", { text: "The right time." })]),
      el("p", { text: "Your conversations, notes and next steps, ready for the moment you need them." }),
      el("div", { class: "dashboard-actions" }, [action("Start a conversation", "chat", true), action("Explore your vault ↗", "library", false, { section: "vault" })]),
      nextTaskLabel,
    ]),
  ]);
  const stats = el("div", { class: "dashboard-stats" });
  const chats = section("Recent chats", "All chats", "chat", ICONS.chats);
  const schedule = section("Upcoming", "Calendar", "calendar", ICONS.calendar);
  const projects = section("Projects", "Open projects", "chat", ICONS.library);
  const activity = section("Activity", "Tasks", "tasks", ICONS.tasks);
  const system = section("Systems", "Settings", "settings", ICONS.settings);
  const models = section("Models", "Manage models", "settings", ICONS.brain);
  const agents = section("Bots", "Bots", "botsHome", ICONS.agents);
  const store = section("Tool Store", "Tool Store", "tool-store", ICONS.store);
  agents.panel.hidden = store.panel.hidden = true;
  system.panel.classList.add("dashboard-wide");
  // Order and visibility below the card: Settings > Layout (layout.js). The
  // numbers strip spans the grid; hidden parts still refresh, unseen.
  const parts = { stats, chats: chats.panel, schedule: schedule.panel, agents: agents.panel, store: store.panel, projects: projects.panel, models: models.panel, activity: activity.panel, system: system.panel };
  // When returning from Layout, known enabled cards get the same loading
  // lines as the built-in sections while their summaries refresh.
  const enabledTabs = new Set(knownTabs().map(t => t.id));
  for (const card of knownHomeCards().filter(c => enabledTabs.has(c.slug))) {
    const { panel, body } = section(card.title, "Open " + card.tab_name, card.slug, card.tab_icon || "");
    body.append(el("div", { class: "skeleton skeleton-line" }), el("div", { class: "skeleton skeleton-line" }));
    parts[card.id] = panel;
  }
  for (const [id, panel] of Object.entries(parts)) panel.dataset.homeSection = id;
  const grid = el("div", { class: "dashboard-grid" });
  let redesign = null;  // Mounted after the shared Home skeleton is ready.
  const arrange = () => {
    const { order, hidden } = homeLayout();
    if (redesign?.arrange(order, hidden)) return;
    grid.replaceChildren(...order.filter((id) => parts[id] && !hidden.includes(id)).map((id) => parts[id]));
  };
  arrange();
  document.addEventListener("kairos:layout", arrange);
  const customize = el("div", { class: "dashboard-customize" }, [action("Customize", "settings", false, { section: "layout" })]);
  content.append(hero, customize, grid);
  container.appendChild(content);
  const mobile = mountMobileHome({ container, content, banner, options });
  // Chat to Home (app.js switchTab) waits for the banner before animating
  // into it. It's drawn from the Home halftone slot (a custom picture, or
  // the Kairos figure), in the appearance's halftone colors, and redrawn
  // when any of those change.
  const bannerKey = () => JSON.stringify({ src: halftoneSource("home"), focus: halftoneFocus("home"), palette: halftonePalette() });
  const bannerOptions = () => {
    const focus = halftoneFocus("home");
    return { cell: 4, fade: [0.86, 1.0], focusX: focus ? focus.x : 0.7, focusY: focus ? focus.y : 0.4,
      palette: halftonePalette(), version: halftoneVersion("home") };
  };
  let bannerState = bannerKey();
  banner.dataset.halftoneSrc = halftoneSource("home");  // read by scripts/ui-smoke.cjs
  let disposeBanner = mountBackgroundEffect(banner, halftoneSource("home"), { ...bannerOptions(), onReady: options.transitionReady });
  const onAppearance = () => {
    const next = bannerKey();
    if (next === bannerState || disposed) return;
    bannerState = next;
    banner.dataset.halftoneSrc = halftoneSource("home");
    disposeBanner();
    disposeBanner = mountBackgroundEffect(banner, halftoneSource("home"), bannerOptions());
  };
  document.addEventListener("kairos:appearance", onAppearance);
  for (const item of [chats, schedule, projects, activity, system, models, agents, store]) {
    item.body.append(el("div", { class: "skeleton skeleton-line" }), el("div", { class: "skeleton skeleton-line" }));
  }
  function updateCountdown() {
    if (!nextTask) return;
    const minutes = Math.ceil((new Date(nextTask.next_run_at) - Date.now()) / 60000);
    const time = minutes <= 0 ? "due now" : minutes < 60 ? "in " + minutes + "m" : minutes < 1440 ? "in " + Math.floor(minutes / 60) + "h " + minutes % 60 + "m" : "in " + Math.floor(minutes / 1440) + "d";
    nextTaskLabel.textContent = "Next up: " + nextTask.name + " · " + time;
  }
  // Each request fills its own card. Quota or store reads cannot hold up chats.
  const data = {};
  redesign = mountRedesignHome({ container, content, hero, header, grid, parts, data: () => data, refresh: () => refresh(), rearrange: () => arrange(), launchSurface: !!options.mobileLaunchSurface });
  arrange();
  const statSpecs = [
    ["sessions", "chats", "chat"], ["notes", "open notes", "notes"],
    ["tasks", "automations on", "tasks"], ["events", "this week", "calendar"],
  ];
  const statValues = new Map();
  for (const [key, label, tab] of statSpecs) {
    const value = el("span", { class: "dashboard-stat-value", text: "…" });
    statValues.set(key, value);
    stats.append(el("button", { type: "button", class: "dashboard-stat", "data-stat": key, onclick: () => navigate(tab) }, [
      icon(({sessions:'chats',notes:'notes',tasks:'tasks',events:'calendar'})[key]), value, el("span", { class: "dashboard-stat-label", text: label }),
    ]));
  }
  const waiting = el("button", { type: "button", class: "dashboard-stat dashboard-attention", "data-stat": "waiting", hidden: true, onclick: () => navigate("agents") });
  stats.append(waiting);

  function drawModels() {
    if (data.endpoints === undefined) return;
    const { endpoints, usage, quotas } = data;
    models.body.replaceChildren();
    if (endpoints && !endpoints.length) models.body.append(el("div", { class: "model-setup-empty" }, [
      ...[el("h3", { text: "Set up a model" }), el("p", { text: "Choose how Kairos thinks. We'll help you connect it." })],
      el("button", { class: "btn", text: "Set up a model", onclick: () => openModelSetup() }),
    ]));
    else if (endpoints === null) empty(models.body, "", true);
    else {
      const quotaShown = new Set();
      endpoints.forEach((endpoint) => {
        const block = el("div", { class: "dashboard-model" });
        const modelRow = el("button", { type: "button", class: "dashboard-row dashboard-model-top", onclick: () => navigate("settings") }, [
          modelMark(endpoint.mark, endpoint.name) || icon("brain"),
          el("span", { class: "dashboard-model-name", text: endpoint.name, title: endpoint.name }),
          el("span", { class: "dashboard-model-variant", text: endpoint.model || endpoint.kind.replaceAll("_", " ") }),
        ]);
        block.append(modelRow);
        const label = usageLabel(endpoint, usage?.[endpoint.id]);
        if (label) block.append(el("span", { class: "dashboard-model-usage", text: label.text, title: label.title }));
        const providerId = QUOTA_PROVIDER[endpoint.kind];
        const reading = providerId && quotas?.providers?.find((p) => p.provider === providerId);
        if (reading && !quotaShown.has(providerId)) {
          quotaShown.add(providerId);
          block.append(quotaBlock(providerId, reading));
        } else if (providerId && providerId !== "antigravity" && !quotaShown.has(providerId) && quotas !== undefined) {
          block.append(el("span", { class: "dashboard-quota-note", text: "Usage limits unavailable." }));
        }
        models.body.append(block);
      });
    }
  }

  function drawSystems() {
    if (data.status === undefined) return;
    const { status, settings } = data;
    system.body.replaceChildren();
    if (!status) return empty(system.body, "", true);

    const chips = el("div", { class: "dashboard-system-chips" });
    const values = [
      ["Vault", status.vault_ok ? "connected" : "unavailable", status.vault_ok ? "ok" : "err"],
      ["Scheduler", status.scheduler_running ? status.enabled_task_count + (status.enabled_task_count === 1 ? " task" : " tasks") : "stopped", status.scheduler_running ? "ok" : "err"],
      ["Discord", status.discord_connected_bots.length ? status.discord_connected_bots.length + " connected" : "off", status.discord_connected_bots.length ? "ok" : "warn"],
      ["Models", String(status.model_endpoint_count), status.model_endpoint_count ? "ok" : "warn"],
    ];
    if (settings?.computer_use && typeof settings.computer_use.enabled === "boolean") {
      values.push(["Computer use", settings.computer_use.enabled ? "on" : "off", settings.computer_use.enabled ? "ok" : "warn"]);
    }
    for (const [name, value, state] of values) {
      chips.append(el("button", { type: "button", class: "dashboard-system-chip", "data-system": name.toLowerCase(), "aria-label": `${name}: ${value}`, onclick: () => navigate("settings") }, [
        el("span", { class: "status-dot " + state }), el("span", { text: name }), el("span", { class: "meta", text: value }),
      ]));
    }
    system.body.append(chips);
  }

  function drawStore() {
    if (!data.auth?.is_admin) return;
    const { skills, integrations, tabs, catalog, addons } = data;
    store.body.replaceChildren();
    store.panel.dataset.hasItems = 'false';
    if (Array.isArray(skills) && Array.isArray(integrations) && Array.isArray(tabs)) {
      // Match Tool Store's installed entries: MCP servers, configured services,
      // and installed user tabs or enabled built-in templates.
      const tools = integrations.filter((i) => i.kind === "mcp_server" || i.configured);
      const installedTabs = tabs.filter((t) => !addons?.some(addon => addon.id === t.slug) && (t.kind === "user" || t.enabled));
      const toolCount = tools.length + (addons?.filter(a=>a.installed).length || 0);
      store.panel.dataset.hasItems = String(skills.length + toolCount + installedTabs.length > 0);
      store.body.append(row("Installed", `${skills.length} skills · ${toolCount} tools · ${installedTabs.length} tabs`, () => navigate("tool-store")));

    }
    if (Array.isArray(catalog?.items)) {
      if (catalog.items.some(i => i.installed || !i.install_blocked)) store.panel.dataset.hasItems = 'true';
      const updates = catalog.items.filter((i) => i.installed && i.update_available);
      if (updates.length) store.body.append(row("Update available", updates.length <= 2 ? updates.map((i) => i.name).join(", ") : `${updates.length} items`, () => navigate("tool-store")));
      store.body.append(row("New in the store", `${catalog.items.filter((i) => !i.installed && !i.install_blocked).length} items`, () => navigate("tool-store")));
    }
    // Shares require GitHub and have no local cache. Home never requests them.
    if (!store.body.childElementCount) {
      if ([skills, integrations, tabs, catalog].some((v) => v === null)) empty(store.body, "", true);
      else store.body.append(el("div", { class: "skeleton skeleton-line" }));
    }
    store.panel.hidden = false;
  }

  // A redraw replaces the rows; keep keyboard focus on the equivalent element (same card, class, text or position).
  function draw(key, start) {
    const active = document.activeElement;
    const was = active && container.contains(active) && active.classList[0] ? active : null;
    const select = "." + CSS.escape(was?.classList[0] || "x");
    const sectionId = was?.closest("[data-home-section]")?.dataset.homeSection;
    const within = () => (sectionId && [...container.querySelectorAll("[data-home-section]")].find((n) => n.dataset.homeSection === sectionId)) || container;
    const at = was ? [...within().querySelectorAll(select)].indexOf(was) : -1;
    const text = was?.textContent;
    drawNow(key, start);
    if (!was || was.isConnected) return;
    const same = [...within().querySelectorAll(select)];
    (same.find((n) => n.textContent === text) || same[at])?.focus();
  }

  function drawNow(key, start) {
    const value = data[key];
    if (key === "tabCards") {
      // A failed optional endpoint cannot disturb Home's built-in sections.
      if (!Array.isArray(value?.cards)) {
        for (const [id, panel] of Object.entries(parts)) {
          if (id.startsWith("tab:")) empty(panel.querySelector('.dashboard-section-body'), "", true);
        }
        return;
      }
      for (const id of Object.keys(parts)) if (id.startsWith("tab:")) delete parts[id];
      for (const card of value.cards) {
        const { panel, body } = section(card.title, "Open " + card.tab_name, card.slug, card.tab_icon || "");
        panel.dataset.homeSection = card.id;
        panel.dataset.tabName = card.tab_name;
        if (card.kind === "list") {
          if (!card.rows.length) empty(body, card.empty_text || "All clear", false, card.empty_text || "Nothing here yet.");
          for (const entry of card.rows) {
            const item = row(entry.title, entry.meta || "", () => navigate(card.slug));

            if (entry.badge) item.append(el("span", { class: "dashboard-tab-badge tone-" + (entry.tone || "default"), text: entry.badge }));
            body.append(item);
          }
        } else {
          // The figure reads like Home's number chips: big value, short label.
          body.append(el("button", { type: "button", class: "dashboard-tab-figure", onclick: () => navigate(card.slug) }, [
            el("span", { class: "dashboard-stat-value", text: card.kind === "stat" ? String(card.value) : `${card.value} / ${card.total}` }),
            el("span", { class: "dashboard-stat-label", text: card.label }),
          ]));
          if (card.kind === "progress") body.append(el("div", { class: "dashboard-quota-track", role: "progressbar", "aria-label": card.label,
            "aria-valuemin": "0", "aria-valuemax": String(card.total), "aria-valuenow": String(Math.min(card.value, card.total)) }, [
            el("span", { class: "dashboard-quota-fill tone-ample", style: `width:${Math.min(1, card.value / card.total) * 100}%` }),
          ]));
          if (card.detail) body.append(el("p", { class: "dashboard-quota-note", text: card.detail }));
        }
        parts[card.id] = panel;
      }
      setHomeCards(value.cards);
      arrange();
    }
    if (statValues.has(key)) {
      const n = value === null ? null : key === "tasks" ? value.filter((t) => t.enabled).length : value.length;
      const node = statValues.get(key);
      const first = node.textContent === "…";
      node.textContent = n === null ? "Unavailable" : String(n);
      if (first && !matchMedia("(prefers-reduced-motion: reduce)").matches) countUp(node);
    }
    if (key === "sessions") {
      chats.body.replaceChildren();
      if (!value?.length) empty(chats.body, "Start a conversation", value === null, "Your next conversation starts here.");
      else [...value].sort((a, b) => b.updated_at - a.updated_at).slice(0, 4).forEach((s) => {
        // A Forge chat says so and opens in Forge (desktop redesign).
        const forge = isForgeChat(s);
        const item = row(s.title || 'Untitled conversation', relativeTime(s.updated_at), () => navigate(forge ? 'forgeSession' : 'chat', {sessionId:s.id}));
        if (forge) { item.classList.add('is-forge'); item.querySelector('.dashboard-row-title').after(forgeTag()); }

        chats.body.append(item);
      });
    }
    if (key === "events") {
      schedule.body.replaceChildren();
      const upcoming = value?.filter((e) => !e.completed && eventDate(e.end || e.start) >= (e.all_day ? start : new Date())).sort((a, b) => eventDate(a.start) - eventDate(b.start)).slice(0, 4);
      if (!upcoming?.length) empty(schedule.body, "Your week is clear", value === null, "A little breathing room. No upcoming events this week.");
      else upcoming.forEach((event) => {
        const date = eventDate(event.start);
        const time = event.all_day ? 'All day' : date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
        const short = date.toLocaleDateString([], { weekday: "short" }) + (event.all_day ? "" : " " + time);
        const quietRow = row(event.title, "", () => navigate("calendar"));
        quietRow.lastElementChild.remove();
        quietRow.prepend(el("time", { class: "dashboard-event-date", datetime: event.start, text: short, title: date.toLocaleString() }));
        schedule.body.append(quietRow);
      });
    }
    if (key === "projects") {
      projects.body.replaceChildren();
      if (!value?.length) empty(projects.body, "Create a project", value === null, "Group your chats and shared knowledge into a project.");
      else value.slice(0, 3).forEach((p) => projects.body.append(row(p.name, (p.document_ids?.length || 0) + " docs", () => navigate("chat", { projectId: p.id }))));
    }
    if (["endpoints", "usage", "quotas"].includes(key)) drawModels();
    if (key === "feed") {
      activity.body.replaceChildren();
      if (!value?.length) empty(activity.body, "No recent activity", value === null, "Task runs and channel activity will appear here.");
      else value.forEach((e) => {
        const item = row(e.message, relativeTime(e.ts), () => openPanelDialog({title:'Activity',owner:container,opener:item,body:el('div',{},[badge(e.level),el('p',{text:e.message}),el('small',{text:new Date(e.ts*1000).toLocaleString()})])}));
        item.classList.add("dashboard-activity");

        item.dataset.level = e.level;
        item.title = e.level + ": " + e.message;
        activity.body.append(item);
      });
    }
    if (key === "status") {
      statusDot.className = "status-dot " + (!value ? "warn" : !value.vault_ok || !value.scheduler_running ? "err" : "ok");
      statusLabel.textContent = !value ? "Status unavailable" : !value.vault_ok || !value.scheduler_running ? "Needs attention" : "Systems operational";
      nextTask = value?.next_task;
      nextTaskLabel.textContent = !value ? "Schedule unavailable" : nextTask ? "" : "No scheduled runs ahead";
      updateCountdown();
    }
    if (["status", "settings"].includes(key)) drawSystems();
    if (key === "agents") {
      agents.panel.hidden = !data.auth?.is_admin || (Array.isArray(value) && !value.length);
      agents.body.replaceChildren();
      if (value === null) empty(agents.body, "", true);
      else {
        const order = ["needs_you", "working", "idle", "capped", "off"];

        [...value].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).slice(0, 5).forEach((agent) => {
          const detail = agent.status === "working" ? agent.status_detail : agent.status === "needs_you" ? `${agent.needs_you} waiting on you` : agent.status === "idle" ? `Idle · ${agent.runs_today} runs today` : agent.status === "capped" ? `Paused: ${agent.status_detail}` : "Off";
          const quietRow = row(agent.name, detail, () => navigate("agents", { agentId: agent.id }));
          quietRow.prepend(el("span", { class: "dashboard-agent-dot " + agent.status, "aria-label": agent.status.replaceAll("_", " ") }));
          agents.body.append(quietRow);
        });

      }
    }
    if (key === "agents" || key === "inbox") syncHeroMascot();
    if (key === "inbox") {
      waiting.hidden = !data.auth?.is_admin || !(value?.count > 0);
      waiting.replaceChildren(el("span", { class: "dashboard-stat-value", text: String(value?.count || 0) }), el("span", { class: "dashboard-stat-label", text: "waiting on you" }));
    }
    if (["skills", "integrations", "tabs", "catalog", "addons"].includes(key)) drawStore();
    content.classList.add("is-filled");
    redesign?.update(key);
    mobile.update(key, value);
  }

  async function refresh() {
    if (disposed) return;
    if (refreshing) { refreshQueued = true; return; }
    refreshing = true;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const request = async (key, path) => {
      const value = await (key === 'quotas' ? loadQuotas() : api(path)).catch(() => null);
      if (disposed) return;
      data[key] = value;
      draw(key, start);
    };
    const publicReads = [
      ["sessions", "/api/sessions"], ["notes", "/api/notes?include_completed=false"], ["tasks", "/api/tasks"],
      ["events", "/api/calendar/events?start=" + start.toISOString() + "&end=" + end.toISOString()],
      ["projects", "/api/projects"], ["endpoints", "/api/models"], ["usage", "/api/models/usage"],
      ["status", "/api/system/status"], ["feed", "/api/system/events?limit=5"], ["quotas", "/api/models/quotas"],
      ["tabCards", "/api/home/tab-cards"],
      ["week", "/api/home/week"],
    ].map(([key, path]) => request(key, path));
    const adminReads = (async () => {
      const auth = await apiRecent("/api/auth/status").catch(() => null);
      if (disposed) return;
      data.auth = auth;
      redesign?.update("auth");
      if (!auth?.is_admin) {
        agents.panel.hidden = store.panel.hidden = waiting.hidden = true;
        delete data.settings;
        drawSystems();
        return;
      }
      await Promise.allSettled([
        ["agents", "/api/agents"], ["inbox", "/api/agents/inbox"], ["skills", "/api/skills"],
        ["integrations", "/api/integrations"], ["tabs", "/api/system/tabs"],
        ["catalog", "/api/store/catalog?cache_only=true"], ["settings", "/api/settings"],
        ["addons", "/api/addons"],
      ].map(([key, path]) => request(key, path)));
    })();
    await Promise.allSettled([...publicReads, adminReads]);
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refresh(); }
  }
  refresh();
  document.addEventListener("kairos:models-changed", refresh);
  document.addEventListener("jarvis:tabs-changed", refresh);
  // Paused while the page is hidden or Settings covers Home; resumes with one refresh when either ends.
  const refreshTimer = setInterval(() => { if (!document.hidden && !settingsOpen()) refresh(); }, 30000);
  const onResume = () => { if (!document.hidden && !settingsOpen()) refresh(); };
  document.addEventListener("visibilitychange", onResume);
  document.addEventListener("kairos:settings-visibility", onResume);
  const countdownTimer = setInterval(updateCountdown, 1000);
  return () => { disposed = true; stopHeroStream(); kipSwitch.dispose(); mobile.dispose(); redesign?.dispose(); disposeBanner(); document.removeEventListener("kairos:models-changed", refresh); document.removeEventListener("jarvis:tabs-changed", refresh); document.removeEventListener("kairos:appearance", onAppearance); document.removeEventListener("kairos:layout", arrange); clearInterval(refreshTimer); clearInterval(countdownTimer); document.removeEventListener("visibilitychange", onResume); document.removeEventListener("kairos:settings-visibility", onResume); };
}
