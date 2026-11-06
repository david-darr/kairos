import { ICONS } from "./icons.js";
import { WORDMARK, ICON as KAIROS_MARK } from "./brand.js";
import { api, useAppMenusForSelects } from "./api.js";
import * as onboarding from "./onboarding.js";
import * as auth from "./auth.js";
import * as commandPalette from "./commandPalette.js";
import * as floatingProgress from "./floatingProgress.js";
import * as chatStream from "./chatStream.js";
import { setupSidebar, restoreSidebar } from "./sidebar.js";
import { parseChatWindow } from './chatWindowRoute.js';
import { setPaneUser } from './chatPaneStack.js';
import { closeBrowser, openBrowser } from "./browserPane.js";
import { initAppearance } from "./appearance.js";
import { initLayout, setKnownTabs, sidebarLayout, pinnedTabs } from "./layout.js";
import { renderDesktopNav, clearDesktopNav, mountSearchRow } from "./sidebarNav.js";
import { registration as notificationRegistration } from './mobileNotifications.js';
import { mountMobileChrome } from './mobileChrome.js';
import { mountPageSearch } from './mobilePageSearch.js';
import { phoneRoute, initMobileShell, isPhoneShell } from './mobileShell.js';
import { hasLeaveGuard, canLeaveView } from './leaveGuard.js';

import { mountForgeRail } from './forgeRail.js';
import { mountBotsRail } from './botsRail.js';
import { MODES, FORGE_NAV, BOTS_NAV, MODE_SWITCH, MODE_BADGES, TAB_LABELS, restoreMode, modeForTab, homeTabFor, railLabel, nextRailMode } from './appModes.js';
import { normalizeBotsTarget, notificationTarget, sessionTarget } from './botsNavigation.js';
import { createWatcher as watchBotInbox, prefs as botNotifyPrefs } from './botNotifications.js';
import './cliPair.js'; // terminal pairing prompts (Kairos CLI)
import { mascotPng } from './mascot.js';
import { avatarSpec } from './agentAvatar.js';
import { notchNavigation, whenReady } from './notchNavigate.js';

let forgeRailCleanup = () => {};
let botsRailCleanup = () => {};
let forgeSearchCleanup = null;
restoreSidebar();
if (window.jarvis?.browser) document.documentElement.classList.add("electron-shell");
if (/mac/i.test(navigator.userAgentData?.platform || navigator.platform || "")) document.documentElement.classList.add("platform-mac");

// Nav order matches David's Figma wireframe, minus "New Chat" and "Search"
// as separate items (David's call, 2026-08-31) — both live inside the Chats
// view itself (its own "+ New Chat" button, and chat-message search once
// that's built server-side), so dedicated top-level nav entries were just
// redundant with Chats. Settings moved out of this list entirely (David's
// ask, 2026-08-31) — it's now the sidebar-footer user card instead of a
// top-level nav item, matching the Odysseus screenshot's bottom-left
// avatar+username+gear pattern.
// The order and groups shown come from layout.js (Settings > Layout). The old
// Agents tab is retired: its links still work, but they open Bots (botsNavigation.js).
const NAV = [
  { id: "home", label: "Home", icon: "home" },
  { id: "chat", label: "Chats", icon: "chats" },
  { id: "notes", label: "Notes", icon: "notes" },
  { id: "library", label: "Library", icon: "library" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "email", label: "Email", icon: "email" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "tool-store", label: "Tool Store", icon: "store" },
  { id: "cookbook", label: "Cookbook", icon: "cookbook" },
];

// No tabs currently stubbed — Gallery was removed entirely (David's ask
// 2026-09-01, "we don't need it anymore"), Library shipped for real in
// Phase 7. Left as a real (if empty) mechanism rather than deleted outright:
// still the honest place a future genuinely-deferred tab would go, matching
// the project's "no fake UI" rule.
const STUB_TABS = new Set();
// Tabs either mode may open without switching mode (none since the Design tab
// moved into Library, David 2026-10-22).
const SHARED_TABS = new Set();
let forgeAccess = false; // this account may use this computer's shell and files (Forge needs it)
let appMode = 'kairos';
// Whether this person has machine access is not known yet; buildSidebar() puts an account without it back out of Forge.
try { appMode = restoreMode(localStorage.getItem('kairos:app-mode'), true, true); } catch { /* Device storage is optional. */ }
// The marker must match a mode restored at startup, not only one switched to.
document.documentElement.dataset.appMode = appMode;
// Bots is for every account; Forge needs machine access (it builds and runs apps on this computer).
function modeAllowed(mode) { return mode === 'kairos' || mode === 'bots' || (mode === 'forge' && forgeAccess); }
function allowedModes() { return MODES.filter(modeAllowed); }
function rememberMode(mode) {
  appMode = mode;
  document.documentElement.dataset.appMode = mode;
  try { localStorage.setItem('kairos:app-mode', mode); } catch { /* Device storage is optional. */ }
}
export async function switchMode(mode) {
  if (!modeAllowed(mode)) return;
  rememberMode(MODES.includes(mode) ? mode : 'kairos');
  await buildSidebar();
  return switchTab(homeTabFor(appMode));
}

const modules = {};
// Folder views come from /tab-files; old split views use /custom-views.
// Their manifest supplies the module and optional stylesheet URLs.
const customViewUrls = {};
const customStyleUrls = {};
const customStyles = new Map();

async function loadModule(tabId) {
  const style = customStyleUrls[tabId];
  if (style) {
    if (!customStyles.has(style)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = style;
      // Rendering waits for the stylesheet; two simultaneous navigations
      // share the same link and promise instead of adding it twice.
      customStyles.set(style, new Promise((resolve, reject) => {
        link.onload = resolve;
        link.onerror = () => { customStyles.delete(style); link.remove(); reject(new Error(`Could not load ${style}`)); };
        document.head.appendChild(link);
      }));
    }
    await customStyles.get(style);
  }
  if (modules[tabId]) return modules[tabId];
  const custom = customViewUrls[tabId];
  const path = custom || (STUB_TABS.has(tabId) ? "./views/stub.js" : `./views/${tabId}.js`);
  modules[tabId] = await import(path);
  return modules[tabId];
}

let activeTab = null;
let activeAgentId = null;  // the bot page open now, if any (bot notifications skip it)
let activeUnmount = null; // set by a view's render() if it needs teardown (e.g. home.js's WebGL scene)

// Each navigation owns a fresh root. A late response from a previous view
// can only update its detached root, never overwrite the current screen.
// View modules must preserve this id and use classes for their layouts.
let view = document.getElementById("view-content");
let navigationVersion = 0;

// Home and Chat (David, 2026-10-07): Home's halftone card grows into the
// chat background, and shrinks back into the card on the way home, through
// the browser's view transitions. Both are named `kairos-backdrop` only
// while it runs (style.css, :root.tab-transition). The new screen is
// captured once the arriving view has drawn its halftone (and the chat has
// opened any chat it was asked for), or after 800 ms at most.
export function switchTab(tabId, options = {}) {
  // Unsaved edits (leaveGuard.js): the view on screen may ask first.
  if (hasLeaveGuard()) return canLeaveView().then(ok => ok ? switchTabNow(tabId, options) : undefined);
  return switchTabNow(tabId, options);
}

// Old Agents links, notifications and chips land on their Bots destination before
// the mode and the phone route are worked out (Phase 1 design, section 7). The
// normalizer keeps only the fields it knows; the panel page and card ride along.
function routeLegacy(tabId, options = {}) {
  if (tabId !== 'agents') return { tab: tabId, options };
  const { tab, ...rest } = normalizeBotsTarget('agents', options);
  for (const key of ['panelPage', 'panelCard']) if (tab === 'botsShell' && typeof options[key] === 'string') rest[key] = options[key];
  return { tab, options: rest };
}

function switchTabNow(tabId, options) {
  ({ tab: tabId, options } = routeLegacy(tabId, options));
  // Designs live in Library > Designs (David, 2026-10-22): the old Design tab and its links open there.
  if (tabId === 'design') { options = { ...options, section: 'designs' }; tabId = 'library'; }
  ({ tab: tabId, options } = phoneRoute(tabId, options));
  if (tabId === 'forgeSession') tabId = 'forgeShell';
  if (tabId === 'forgeShell' && activeTab === 'forgeShell' && modules.forgeShell) {
    closeMobileMenu();
    return modules.forgeShell.open(options);
  }
  const homeAndChat = (activeTab === "home" && tabId === "chat") || (activeTab === "chat" && tabId === "home");
  if (isPhoneShell() || !homeAndChat || !document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches
      || document.documentElement.dataset.halftone !== "on") {
    return performSwitch(tabId, options);
  }
  let landed;
  const ready = new Promise((resolve) => { landed = resolve; });
  const root = document.documentElement;
  root.classList.add("tab-transition");
  return new Promise((resolve) => {
    const transition = document.startViewTransition(() => {
      const run = performSwitch(tabId, { ...options, transitionReady: landed });
      run.then(resolve, resolve);
      // Not `run`: a view can finish rendering before its halftone is drawn.
      return Promise.race([ready, new Promise((r) => setTimeout(r, 800))]);
    });
    // A transition is skipped when another starts (a second click mid-way);
    // the switch itself still happens, so that's not an error.
    transition.ready.catch(() => {});
    transition.finished.finally(() => root.classList.remove("tab-transition"));
  });
}

async function performSwitch(tabId, options = {}) {
  const mode = SHARED_TABS.has(tabId) ? appMode : modeForTab(tabId);
  if (!modeAllowed(mode)) return;
  if (mode !== appMode) { rememberMode(mode); await buildSidebar(); }
  const version = ++navigationVersion;
  // The side browser's chrome lives in the Chat view's DOM, but in the
  // desktop app the page itself is a NATIVE view owned by the main process.
  // Replacing the view container below removes the chrome and would leave
  // that native layer floating over the new tab, still loaded and still
  // running scripts. Closing it here is what actually disposes of it.
  closeBrowser();
  // Views that own real resources (currently just home.js's WebGL scene)
  // return a cleanup function from render(). Without calling it here before
  // wiping the DOM, a canvas's animation loop and GPU buffers would keep
  // running forever in the background every time you left that tab — the
  // canvas element is gone, but requestAnimationFrame doesn't know that.
  if (activeUnmount) { activeUnmount(); activeUnmount = null; }

  activeTab = tabId;
  activeAgentId = tabId === 'botsShell' ? (options.agentId || null) : null;
  document.documentElement.dataset.view = tabId;
  const titlebarTab = document.getElementById("titlebar-tab");
  if (titlebarTab) titlebarTab.textContent = TAB_LABELS[tabId] || NAV.find((item) => item.id === tabId)?.label || document.querySelector(`.nav-item[data-tab="${tabId}"]`)?.textContent?.trim() || "";
  document.querySelectorAll(".nav-item").forEach((item) => {
    // The Bots rail marks its own rows: they all share one tab id (botsRail.js).
    if (item.dataset.agentId !== undefined) return;
    const selected = item.dataset.tab === (tabId === 'mobileLaunch' ? 'chat' : tabId);
    item.classList.toggle("active", selected);
    if (selected) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const nextView = document.createElement("div");
  nextView.id = "view-content";
  nextView.className = "view active";
  nextView.dataset.view = tabId;
  // Installed views share a host-level design contract regardless of their ID.
  if (customViewUrls[tabId]) nextView.dataset.customTab = 'true';
  view.replaceWith(nextView);
  view = nextView;
  nextView.innerHTML = `<div class="empty-state" role="status">Loading...</div>`;
  try {
    const mod = await loadModule(tabId);
    if (version !== navigationVersion) return;
    const result = await mod.render(nextView, tabId, { ...options, registerCleanup(cleanup) {
      if (version === navigationVersion) activeUnmount = cleanup;
      else cleanup();
    } });
    if (typeof result === "function") {
      if (version === navigationVersion) activeUnmount = result;
      else result();
    }
    if (version === navigationVersion) {
      const disposeSearch = mountPageSearch(nextView, tabId);
      const previousUnmount = activeUnmount;
      activeUnmount = () => { disposeSearch(); previousUnmount?.(); };
    }
  } catch (error) {
    if (version !== navigationVersion) return;
    if (activeUnmount) { activeUnmount(); activeUnmount = null; }
    nextView.replaceChildren();
    const message = document.createElement("div");
    message.className = "empty-state";
    message.textContent = "This view couldn't load. Try opening it again.";
    nextView.appendChild(message);
    console.error("View failed to load", tabId, error);
  }
  closeMobileMenu();
}

const mobileMenuMedia = matchMedia('(max-width: 768px)');
function syncMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  const open = false;
  document.documentElement.classList.toggle('mobile-menu-open', open);
  sidebar.inert = mobileMenuMedia.matches && !open;
  if (mobileMenuMedia.matches) sidebar.setAttribute('aria-hidden', String(!open));
  else sidebar.removeAttribute('aria-hidden');
}
function closeMobileMenu() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobile-backdrop').classList.add('hidden');
  syncMobileMenu();
}
// Phone navigation is the sliding sidebar (mobileSidebar.js, 2026-11-02);
// this desktop sidebar stays hidden and inert at phone width.
function setupMobileMenu() {
  mountMobileChrome();
  mobileMenuMedia.addEventListener('change', () => closeMobileMenu(false));
  syncMobileMenu();
}

// How many bot inbox items and results wait on the person: a count on the
// Bots nav item, refreshed every 30 seconds while the page is visible.
let agentBadgeTimer = null;
// Native notifications for new bot items, one per bot per poll (botNotifications.js).
// Electron and browsers both support the Notification API; in Electron no
// permission prompt appears, and a click brings the app window forward.
// The icon is the bot's own face in its needs-you pose (Kairos Mascot build
// spec, 2026-10-22), rasterized once per look; phone push stays generic.
let notifiedAgents = [];
const botInboxWatcher = watchBotInbox({
  names: async () => { notifiedAgents = await api('/api/agents').catch(() => []); return Object.fromEntries(notifiedAgents.map(agent => [agent.id, agent.name])); },
  focusedAgentId: () => {
    if (!document.hasFocus()) return null;
    return activeAgentId;
  },
  show: async ({ agentId, kind, title, body }) => {
    if (!('Notification' in window) || Notification.permission === 'denied') return;
    const agent = notifiedAgents.find(a => a.id === agentId);
    const icon = await mascotPng(avatarSpec(agent || { id: agentId }), kind === 'needs_you' ? 'needs' : 'success', 64).catch(() => null);
    const notify = () => {
      const note = new Notification(title, { body, tag: `kairos-bot-${agentId}`, silent: false, ...(icon ? { icon } : {}) });
      note.onclick = () => {
        window.jarvis?.showWindow?.(); window.focus();
        document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'botsShell', agentId } }));
        note.close();
      };
    };
    if (Notification.permission === 'granted') notify();
    else Notification.requestPermission().then(result => { if (result === 'granted') notify(); });
  },
});

// The Bots attention host (botsAttentionHost.js, unit U5) owns notifications once it is mounted:
// it is imported lazily, so a tree without it keeps the older inbox poll below.
let attentionHost = null;
async function mountAttention() {
  if (attentionHost) return;
  attentionHost = import('./botsAttentionHost.js').then(module => { module.mountAttentionHost({ notify: true }); return true; }).catch(() => false);
  await attentionHost;
}
// Outside Bots mode (or for a non-admin) the host stops polling; the older inbox watcher covers notices.
function unmountAttention() {
  if (!attentionHost) return;
  const pending = attentionHost;
  attentionHost = null;
  pending.then(ok => ok && import('./botsAttentionHost.js').then(module => module.attentionHost()?.dispose())).catch(() => {});
}

async function refreshAgentBadge() {
  clearTimeout(agentBadgeTimer);
  agentBadgeTimer = setTimeout(refreshAgentBadge, 30000);
  // Bot notifications need this poll most when the window is hidden, so it
  // keeps running then unless they are turned off (2026-10-14).
  if (document.hidden && !botNotifyPrefs().enabled) return;
  const inbox = await api("/api/agents/inbox").catch(() => null);
  // Once the attention host is notifying, the older watcher stays quiet so nothing alerts twice.
  if (inbox && (!attentionHost || await attentionHost.catch(() => false) !== true)) botInboxWatcher(inbox).catch(() => {});
  if (!inbox) return;
  // In Bots mode the Bots home button carries the count of what waits on the person.
  for (const item of document.querySelectorAll('#nav .nav-item[data-tab="botsHome"]')) {
    const name = 'Bots';
    let badge = item.querySelector(".nav-badge");
    if (!inbox.count) { badge?.remove(); item.setAttribute("aria-label", name); continue; }
    if (!badge) item.append(badge = Object.assign(document.createElement("span"), { className: "nav-badge" }));
    badge.textContent = inbox.count > 99 ? "99+" : String(inbox.count);
    item.setAttribute("aria-label", `${name}, ${inbox.count} waiting on you`);
  }
}
document.addEventListener("jarvis:agents-changed", refreshAgentBadge);

const desktopSidebar = matchMedia("(min-width: 769px)");
desktopSidebar.addEventListener("change", () => { if (document.getElementById("nav")?.childElementCount) buildSidebar(); });

async function buildSidebar() {
  const identity = await api('/api/auth/status').catch(() => null);
  forgeAccess = !!(identity?.machine_access || identity?.is_admin);
  if (!modeAllowed(appMode)) rememberMode('kairos');
  if (appMode === 'bots') mountAttention(); else unmountAttention();
  document.getElementById('forge-mode-switch')?.remove();
  {
    const modes = allowedModes();
    const control = document.createElement('div');
    control.id = 'forge-mode-switch';
    control.className = 'forge-mode-switch';
    control.setAttribute('role', 'group');
    control.setAttribute('aria-label', 'App mode');
    for (const [mode, label] of MODE_SWITCH.filter(([mode]) => modes.includes(mode))) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'segmented-tab'; button.dataset.mode = mode;
      button.setAttribute('aria-pressed', String(appMode === mode));
      button.classList.toggle('active', appMode === mode); button.textContent = label;
      if (MODE_BADGES[mode]) { const badge = document.createElement('small'); badge.textContent = MODE_BADGES[mode]; button.append(badge); }
      button.onclick = () => switchMode(mode);
      control.append(button);
    }
    const rail = document.createElement('button'); rail.type = 'button'; rail.className = 'forge-mode-rail';
    rail.setAttribute('aria-label', railLabel(appMode, modes));
    rail.title = rail.getAttribute('aria-label'); rail.innerHTML = KAIROS_MARK; // The Kairos circle mark (David, 2026-10-09).
    rail.onclick = () => switchMode(nextRailMode(appMode, modes)); control.append(rail);
    document.querySelector('.sidebar-header').after(control);
  }
  const brand = document.getElementById("brand");
  brand.setAttribute('role', 'img'); brand.setAttribute('aria-label', 'Kairos');
  brand.innerHTML = WORDMARK;
  brand.firstElementChild.classList.add("brand-wordmark");
  brand.firstElementChild.setAttribute("role", "img");
  brand.firstElementChild.setAttribute("aria-label", "Kairos");
  const redesignBrand = document.createElement('span');
  redesignBrand.className = 'rd-sidebar-brand'; redesignBrand.setAttribute('aria-hidden', 'true');
  redesignBrand.innerHTML = `<svg width="26" height="26" viewBox="0 0 40 40"><circle cx="20" cy="21" r="15" fill="currentColor"/><circle cx="30" cy="10" r="7" class="rd-kip-cut"/><circle cx="30" cy="10" r="3.4" class="rd-kip-point"/><rect x="13" y="16" width="4" height="9" rx="2" class="rd-kip-cut"/><rect x="21" y="16" width="4" height="9" rx="2" class="rd-kip-cut"/></svg><span>KAIROS</span>`;
  brand.append(redesignBrand);
  // In the desktop app the wordmark lives in the title bar instead.
  const titlebarBrand = document.getElementById("titlebar-brand");
  if (titlebarBrand) titlebarBrand.innerHTML = brand.innerHTML;
  // A development copy (scripts/dev_instance.py) says so on every page, so it
  // is never mistaken for the real app.
  api("/api/auth/status").then((status) => {
    if (!status?.instance) return;
    const badge = () => Object.assign(document.createElement("span"), { className: "instance-badge", textContent: status.instance.toUpperCase(),
      title: `Development copy "${status.instance}": its own data, separate from your real Kairos` });
    brand.append(badge());
    document.getElementById("titlebar-brand")?.append(badge());
    document.title = `Kairos (${status.instance})`;
  }).catch(() => {});

  forgeRailCleanup();
  botsRailCleanup();
  const nav = document.getElementById("nav");
  nav.classList.toggle('rd-stagger', !matchMedia('(max-width: 768px)').matches);
  // Cleared before rebuilding — buildSidebar() now also runs whenever
  // Approved and enabled tabs supply their own sidebar manifests.
  const customTabs = await api("/api/system/custom-tabs").catch(() => []);
  for (const id of Object.keys(customViewUrls)) { delete customViewUrls[id]; delete customStyleUrls[id]; }
  nav.innerHTML = "";
  const items = new Map(NAV.map((item) => [item.id, { id: item.id, label: item.label, svg: ICONS[item.icon] || "" }]));
  for (const item of customTabs) {
    if (items.has(item.id)) continue;
    if (item.view_url) customViewUrls[item.id] = item.view_url;
    if (item.style_url) customStyleUrls[item.id] = item.style_url;
    items.set(item.id, { id: item.id, label: item.label, svg: item.icon_svg || ICONS.library });
  }
  setKnownTabs([...items.values()]);
  // Groups, order and hidden tabs: Settings > Layout (layout.js).
  const modeNav = appMode === 'forge' ? FORGE_NAV : appMode === 'bots' ? BOTS_NAV : null;
  const groups = modeNav ? [{ ids: modeNav.map(item => item.id) }] : sidebarLayout([...items.keys()]);
  if (modeNav) for (const item of modeNav) items.set(item.id, { ...item, svg: ICONS[item.icon] });
  // Desktop Kairos: the redesigned sidebar and rail (sidebarNav.js).
  let desktopNav = null;
  const openSearch = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  forgeSearchCleanup?.(); forgeSearchCleanup = null;
  if (appMode === 'kairos' && desktopSidebar.matches) {
    desktopNav = renderDesktopNav({ nav, items, groups, pinned: pinnedTabs([...items.keys()]), switchTab, openSearch,
      openHistory: () => import('./chatHistoryPopout.js').then(module => module.openChatHistory({ switchTab })),
      editPins: () => openSettings({ section: 'layout' }) });
  } else clearDesktopNav();
  // Forge and Bots on a desktop keep their own nav but have Search and collapse where Kairos has them.
  if (appMode !== 'kairos' && desktopSidebar.matches) forgeSearchCleanup = mountSearchRow(openSearch);
  for (const group of desktopNav ? [] : groups) {
    if (!group.ids.length) continue;
    if (group.label || group.id === 'main') {
      const label = document.createElement("div");
      label.className = "nav-group-label";
      label.textContent = group.label;
      if (!group.label) { label.textContent = 'Kairos'; label.classList.add('rd-nav-heading'); }
      nav.appendChild(label);
    }
    for (const id of group.ids) {
      const item = items.get(id);
      const navEl = document.createElement("button");
      navEl.type = "button";
      navEl.className = "nav-item";
      navEl.dataset.tab = item.id;
      navEl.setAttribute("aria-label", item.label);
      navEl.innerHTML = `${item.svg}<span></span>`;
      navEl.querySelector("span").textContent = item.label;
      navEl.addEventListener("click", () => switchTab(item.id));
      nav.appendChild(navEl);
    }
  }
  if (appMode === 'forge') forgeRailCleanup = mountForgeRail(nav);
  if (appMode === 'bots' && desktopSidebar.matches) botsRailCleanup = mountBotsRail(nav);
  refreshAgentBadge();

  document.querySelectorAll("#sidebar .nav-item[data-tab], #rd-all-tabs .nav-item").forEach((item) => {
    if (item.dataset.agentId !== undefined) return;
    item.classList.toggle("active", item.dataset.tab === (activeTab === 'mobileLaunch' ? 'chat' : activeTab));
    if (item.dataset.tab === (activeTab === 'mobileLaunch' ? 'chat' : activeTab)) item.setAttribute("aria-current", "page");
  });
  await buildSidebarFooter();
  if (desktopNav) document.getElementById("sidebar-footer").prepend(desktopNav.allButton);
  return customTabs.filter((item) => !NAV.some((builtIn) => builtIn.id === item.id));
}

// Settings' old nav-item slot replaced with the sidebar footer (David's ask
// 2026-08-31, follow-up same day: split into two separate controls rather
// than one combined card). The username card opens a Switch User/Log Out
// menu; the gear button is its own separate click straight into the
// floating Settings window — they're related but distinct actions, not one
// thing.
async function buildSidebarFooter() {
  const footer = document.getElementById("sidebar-footer");

  const status = await api("/api/auth/status").catch(() => null);
  const displayName = !status ? "…" : status.username === "local" ? "Local User" : status.username || "Local User";

  const row = document.createElement("div");
  row.className = "sidebar-footer-row";

  const card = document.createElement("button");
  card.type = "button";
  card.className = "sidebar-user-card";
  card.setAttribute("aria-label", displayName + " · Account menu");
  const avatar = document.createElement("span");
  avatar.className = "sidebar-avatar";
  avatar.textContent = displayName.slice(0, 1).toUpperCase();
  const userName = document.createElement("span");
  userName.className = "sidebar-user-name";
  userName.textContent = displayName;
  card.append(avatar, userName);

  // Profile reuses these hidden account actions and their authorization gates.
  const menu = document.createElement("div");
  menu.className = "overflow-menu rd-menu-in hidden";
  menu.style.cssText = "position:absolute;bottom:calc(100% + 6px);left:0;min-width:170px;";

  // No stored multi-account sessions exist to actually swap accounts without
  // re-entering a password (see core/auth.py) — "Switch User" logs out and
  // lands back on the real login screen for the next person to sign in,
  // same as Log Out. Real gating here, though (David's follow-up ask
  // 2026-08-31): Switch User is only enabled when a second account
  // genuinely exists (`other_users_exist` from /api/auth/status, a plain
  // boolean — the actual username list stays admin-only, see the route's
  // own comment) so it isn't offered as a meaningful action when there's
  // truly nowhere else to switch to.
  const authOff = status && !status.auth_enabled;
  const switchItem = document.createElement("button");
  switchItem.type = "button";
  switchItem.className = "overflow-menu-item";
  switchItem.textContent = "Switch User";
  const logoutItem = document.createElement("button");
  logoutItem.type = "button";
  logoutItem.className = "overflow-menu-item";
  logoutItem.textContent = "Log Out";

  if (authOff) {
    switchItem.disabled = true;
    switchItem.title = "Auth is off (single local user) — nothing to switch to.";
    logoutItem.disabled = true;
    logoutItem.title = "Auth is off (single local user) — nothing to log out of.";
  } else {
    if (!status.other_users_exist) {
      switchItem.disabled = true;
      switchItem.title = "No other users registered yet — add one in Settings > Admin > Users.";
    } else {
      switchItem.addEventListener("click", async () => {
        await api("/api/auth/logout", { method: "POST" });
        navigator.serviceWorker?.controller?.postMessage({ type: 'kairos:clear-notifications' });
        window.location.reload();
      });
    }
    logoutItem.addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST" });
      navigator.serviceWorker?.controller?.postMessage({ type: 'kairos:clear-notifications' });
      window.location.reload();
    });
  }
  menu.append(switchItem, logoutItem);

  const cardWrap = document.createElement("div");
  cardWrap.style.cssText = "position:relative;flex:1;min-width:0;";
  cardWrap.append(card, menu);
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    import('./workspaceProfile.js').then(module => module.openWorkspaceProfile(card));
  });

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "sidebar-settings-btn";
  settingsBtn.title = "Settings";
  settingsBtn.setAttribute("aria-label", "Settings");
  settingsBtn.innerHTML = ICONS.settings || "";
  settingsBtn.addEventListener("click", openSettings);

  row.append(cardWrap, settingsBtn);
  // Layout changes rebuild this asynchronously. Keep Settings and Account
  // available while auth is loading, then replace the footer in one step.
  footer.replaceChildren(row);
  if (navigator.userAgent.includes('KairosMobile/')) {
    const nativeSettings = document.createElement('a');
    nativeSettings.className = 'nav-item native-mobile-settings';
    nativeSettings.href = 'kairos-mobile://controls';
    nativeSettings.innerHTML = `${ICONS.settings}<span>iPhone & widgets</span>`;
    footer.prepend(nativeSettings);
  }
}

// Shared by the sidebar gear button and the command palette (Ctrl+K).
async function openSettings(options = {}) {
  if (hasLeaveGuard() && !await canLeaveView()) return;
  const settings = await import("./views/settings.js");
  // Mobile gets a real full-screen page, not the floating popup window
  // (David's ask 2026-09-01) — same setup switchTab() does (stop any
  // running view's cleanup, clear nav highlighting, reset the shared
  // view container) since this bypasses switchTab() itself to avoid
  // settings.render()'s hardcoded desktop-modal behavior.
  if (window.matchMedia("(max-width: 768px)").matches) {
    // Back from the Settings list returns to the tab it was opened over
    // (David, 2026-10-05), not Home.
    const returnTo = activeTab || "home";
    ++navigationVersion;
    if (activeUnmount) { activeUnmount(); activeUnmount = null; }
    activeTab = null;
    document.documentElement.dataset.view = 'settings';
    document.querySelectorAll(".nav-item").forEach((item) => { item.classList.remove("active"); item.removeAttribute("aria-current"); });
    const settingsView = document.createElement("div");
    settingsView.id = "view-content";
    settingsView.className = "view active settings-mobile-page";
    settingsView.dataset.view = "settings";
    view.replaceWith(settingsView);
    view = settingsView;
    closeMobileMenu();
    await settings.renderMobilePage(view, options.section, () => switchTab(returnTo));
    return;
  }
  await settings.openSettingsWindow(options.section);
}

async function boot() {
  const overlay = document.getElementById("onboarding-overlay");

  // Must resolve (login/setup, or no-op if AUTH_ENABLED=false) before any
  // authenticated call below — /api/settings is admin-gated and used to
  // 401 silently here with nothing on screen to show for it.
  overlay.classList.remove("hidden");
  await auth.run(overlay);
  const identity = await api('/api/auth/status');
  await initAppearance(identity.username);
  setPaneUser(identity.username);
  initLayout(identity.username);
  overlay.classList.add("hidden");

  // An account that cannot read the install's settings still gets its app: an admin's failure is real and surfaces.
  const settings = await api("/api/settings").catch((error) => {
    if (identity.is_admin) throw error;
    return { onboarding_complete: true };
  });
  const app = document.getElementById("app");

  if (!settings.onboarding_complete) {
    // The live feed also carries terminal pairing prompts (cliPair.js), which
    // must reach the person even before setup is finished.
    chatStream.connect().catch(() => {});
    app.style.display = "none";
    overlay.classList.remove("hidden");
    await onboarding.run(overlay, identity, () => {
      overlay.classList.add("hidden");
      overlay.innerHTML = "";
      app.style.display = "";
      startApp();
    });
    return;
  }

  startApp();
}

async function startApp() {
  const chatWindow = parseChatWindow(location.search);
  if (chatWindow) document.documentElement.classList.add('single-chat-window');
  const customTabs = await buildSidebar();
  setupSidebar();
  setupMobileMenu();
  document.addEventListener("jarvis:navigate", async (event) => {
    const { tab, ...options } = event.detail;
    if (tab === "settings") { openSettings(options); return; }
    await switchTab(tab, options);
    if (tab === 'tool-store' && options.query) {
      const search = document.querySelector('.tool-store-search');
      if (search) { search.value = options.query; search.dispatchEvent(new Event('input')); }
      [...document.querySelectorAll('.tool-store-filters button')].find(b => b.textContent === options.category)?.click();
    }
  });
  window.jarvis?.usageOverlay?.onNavigate?.((target, detail) => {
    const { tab, options, then } = notchNavigation(target, detail);
    document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
    if (then) whenReady(then);
  });
  // The notch's Open chat and its agent chips.
  window.jarvis?.usageOverlay?.onOpen?.(({ tab, id }) => {
    if (tab === 'chat') floatingProgress.openSession(id);
    else document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'botsShell', agentId: id } }));
  });
  // Adding/removing a tab in the Tool Store rebuilds the nav so it
  // appears immediately instead of after a reload.
  document.addEventListener("jarvis:tabs-changed", async () => {
    for (const id of Object.keys(customViewUrls)) delete modules[id];
    const tabs = await buildSidebar();
    if (activeTab && activeTab !== 'forgeShell' && activeTab !== 'botsShell' && activeTab !== 'botsAutomations' && activeTab !== 'mobileLaunch' && ![...NAV, ...FORGE_NAV, ...BOTS_NAV].some((item) => item.id === activeTab) && !tabs.some((item) => item.id === activeTab)) switchTab("home");
  });
  document.addEventListener("kairos:layout", () => { buildSidebar(); });
  commandPalette.init({ nav: NAV, customTabs: customTabs || [], switchTab, openSettings });
  floatingProgress.init({ switchTab });
  initMobileShell();
  import('./redesignShell.js').then(shell => shell.init()).catch(() => {}); // the redesign preview's sidebar row; inert with the switch off
  await chatStream.connect();
  notificationRegistration().catch(() => {});
  const openNotificationChat = async url => {
    // A bot link opens that bot, and its conversation when it names one (2026-10-14);
    // botsNavigation.js refuses another origin or a malformed id.
    const target = notificationTarget(url, location.origin);
    if (target && target.tab !== 'chat') {
      const { tab, ...options } = target;
      await switchTab(tab, options);
      history.replaceState(null, '', '/');
      return true;
    }
    const link = new URL(url, location.origin);
    if (link.origin !== location.origin || link.pathname !== '/') return false;
    const id = link.searchParams.get('chat');
    if (!/^[a-f0-9]{12}$/.test(id || '')) return false;
    try {
      const session = await api(`/api/sessions/${id}`);
      // A chat that belongs to a bot opens inside that bot, wherever the link came from.
      const { tab, ...options } = session.bots_target || (session.agent_id || session.forge ? sessionTarget(session, id) : { tab: 'chat', sessionId: id });
      await switchTab(tab, options);
      history.replaceState(null, '', '/');
      return true;
    } catch (_) { return false; }
  };
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'kairos:open-chat') openNotificationChat(event.data.url);
  });
  // Activating an external link in a reply (David's ask 2026-09-15). Those
  // links carry target="_blank"; electron/main.js refuses to open a real
  // second window for them and routes the URL here instead, so a web page
  // always lands in the sandboxed pane with a visible address rather than a
  // chrome-less window. Registered globally because the click can happen
  // before the Chat view is mounted — the pane lives in Chat's layout, so
  // this switches there first.
  window.jarvis?.browser?.onOpenRequest(async (url) => {
    if (activeTab !== "chat") await switchTab("chat", { mobileConversation: true });
    openBrowser(url);
  });
  window.jarvis?.screenGrab?.onModelsRequest(async (requestId) => {
    const models = await api("/api/models").catch(() => []);
    window.jarvis.screenGrab.replyModels(requestId, models.map(({ id, name, model, kind, supports_images }) =>
      ({ id, supportsImages: supports_images,
        label: `${name} (${kind === "claude_cli" || kind === "codex_cli" || kind === "antigravity_cli" ? model || "CLI default" : model})` })));
  });
  window.jarvis?.screenGrab?.onQuickDraft(async (draft) => {
    try {
      await switchTab("chat", { mobileConversation: true });
      const chat = await loadModule("chat");
      await chat.acceptQuickEntryDraft(draft);
      window.jarvis.screenGrab.replyQuickDraft(draft.requestId, { ok: true });
    } catch (error) {
      window.jarvis.screenGrab.replyQuickDraft(draft.requestId, { ok: false, error: error.message });
    }
  });
  // A design link: #/library/designs/<id>, or the older #/design/<id>; both open in Library > Designs.
  const DESIGN_LINK = /^#\/(?:design|library\/designs)\/([a-f0-9]{12})$/;
  const designLink = DESIGN_LINK.exec(location.hash);
  const STUDIO_LINK = /^#\/studio(?:\/([a-f0-9]{12}))?$/;
  const openStudioLink = async match => {
    if (customViewUrls.studio) await switchTab('studio', { videoId: match[1] });
    else {
      document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'tool-store', category: 'Tabs', query: 'Studio' } }));
    }
  };
  window.addEventListener('hashchange', () => {
    const studio = STUDIO_LINK.exec(location.hash);
    if (studio) { openStudioLink(studio); return; }
    const match = DESIGN_LINK.exec(location.hash);
    if (match && !(activeTab === 'library' && document.querySelector(`.design-page[data-design-id="${match[1]}"]`))) {
      switchTab('library', { section: 'designs', designId: match[1] });
    }
  });
  if (chatWindow) await switchTab('chat', chatWindow);
  else if (STUDIO_LINK.test(location.hash)) await openStudioLink(STUDIO_LINK.exec(location.hash));
  else if (designLink) await switchTab('library', { section: 'designs', designId: designLink[1] });
  else if (!await openNotificationChat(location.href)) {
    const launch = new URL(location.href).searchParams;
    const target = launch.get('newchat') === '1' ? 'chat' : launch.get('view');
    await switchTab(['chat', 'home', 'library', 'notes', 'tasks', 'calendar'].includes(target)
      ? target : homeTabFor(appMode), { mobileNew: launch.get('newchat') === '1' });
    // A chat or bot link that could not open falls back here; drop it too, or every reload retries it.
    if (['newchat', 'view', 'chat', 'agent'].some(key => launch.has(key))) history.replaceState(null, '', '/');
  }
}

useAppMenusForSelects();
boot();
