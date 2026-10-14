import { ICONS } from "./icons.js";
import { WORDMARK, ICON as KAIROS_MARK } from "./brand.js";
import { api, useAppMenusForSelects } from "./api.js";
import * as onboarding from "./onboarding.js";
import * as auth from "./auth.js";
import * as commandPalette from "./commandPalette.js";
import * as floatingProgress from "./floatingProgress.js";
import * as chatStream from "./chatStream.js";
import { setupSidebar, restoreSidebar } from "./sidebar.js";
import { closeBrowser, openBrowser } from "./browserPane.js";
import { initAppearance } from "./appearance.js";
import { initLayout, setKnownTabs, sidebarLayout } from "./layout.js";
import { registration as notificationRegistration } from './mobileNotifications.js';
import { registerMobileDrawer, isMainDrawerZone } from './mobileDrawers.js';

import { mountForgeRail } from './forgeRail.js';
import { mountSidebarBots } from './sidebarBots.js';

let forgeRailCleanup = () => {};
let peopleRail = null;
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
// The order and groups shown come from layout.js (Settings > Layout); Agents
// sits in the top group with Home and Chats by default (David, 2026-10-07).
const NAV = [
  { id: "home", label: "Home", icon: "home" },
  { id: "chat", label: "Chats", icon: "chats" },
  { id: "agents", label: "Agents", icon: "agents" },
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
const FORGE_NAV = [
  { id: 'forgeHome', label: 'Home', icon: 'home' },
];
let forgeAdmin = false;
let appMode = 'kairos';
try { appMode = localStorage.getItem('kairos:app-mode') === 'forge' ? 'forge' : 'kairos'; } catch { /* Device storage is optional. */ }
// The marker must match a mode restored at startup, not only one switched to.
document.documentElement.dataset.appMode = appMode;
function rememberMode(mode) {
  appMode = mode;
  document.documentElement.dataset.appMode = mode;
  try { localStorage.setItem('kairos:app-mode', mode); } catch { /* Device storage is optional. */ }
}
export async function switchMode(mode) {
  if (mode === 'forge' && !forgeAdmin) return;
  rememberMode(mode === 'forge' ? 'forge' : 'kairos');
  await buildSidebar();
  return switchTab(appMode === 'forge' ? 'forgeHome' : 'home');
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
  if (tabId === 'forgeSession') tabId = 'forgeShell';
  if (tabId === 'forgeShell' && activeTab === 'forgeShell' && modules.forgeShell) {
    closeMobileMenu();
    return modules.forgeShell.open(options);
  }
  const homeAndChat = (activeTab === "home" && tabId === "chat") || (activeTab === "chat" && tabId === "home");
  if (!homeAndChat || !document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches
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
  const mode = tabId === 'forgeShell' || FORGE_NAV.some(item => item.id === tabId) ? 'forge' : 'kairos';
  if (mode === 'forge' && !forgeAdmin) return;
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
  document.documentElement.dataset.view = tabId;
  const titlebarTab = document.getElementById("titlebar-tab");
  if (titlebarTab) titlebarTab.textContent = tabId === 'forgeShell' ? 'Forge' : NAV.find((item) => item.id === tabId)?.label || document.querySelector(`.nav-item[data-tab="${tabId}"]`)?.textContent?.trim() || "";
  document.querySelectorAll(".nav-item").forEach((item) => {
    const selected = item.dataset.tab === tabId;
    item.classList.toggle("active", selected);
    if (selected) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const nextView = document.createElement("div");
  nextView.id = "view-content";
  nextView.className = "view active";
  nextView.dataset.view = tabId;
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
let mobileMenuOpener = null;
const drawerControls = sidebar => [...sidebar.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
  .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[inert]'));
function syncMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  const open = mobileMenuMedia.matches && sidebar.classList.contains('open');
  document.documentElement.classList.toggle('mobile-menu-open', open);
  sidebar.inert = mobileMenuMedia.matches && !open;
  if (mobileMenuMedia.matches) sidebar.setAttribute('aria-hidden', String(!open));
  else sidebar.removeAttribute('aria-hidden');
  document.getElementById('mobile-menu-btn').setAttribute('aria-expanded', String(open));
  document.getElementById('mobile-menu-btn').setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
function openMobileMenu(opener = document.getElementById('mobile-menu-btn')) {
  if (!mobileMenuMedia.matches) return;
  mobileMenuOpener = opener;
  document.dispatchEvent(new CustomEvent('kairos:mobile-drawer-opening', { detail: { id: 'sidebar' } }));
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("mobile-backdrop").classList.remove("hidden");
  syncMobileMenu();
  drawerControls(document.getElementById('sidebar'))[0]?.focus({ preventScroll: true });
}
function closeMobileMenu(restoreFocus = true) {
  const wasOpen = document.getElementById('sidebar').classList.contains('open');
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("mobile-backdrop").classList.add("hidden");
  if (wasOpen && restoreFocus && mobileMenuMedia.matches) {
    const target = mobileMenuOpener?.isConnected && mobileMenuOpener.getClientRects().length ? mobileMenuOpener : document.getElementById('mobile-menu-btn');
    target.focus({ preventScroll: true });
  }
  syncMobileMenu();
}
function setupMobileMenu() {
  const btn = document.getElementById("mobile-menu-btn");
  const backdrop = document.getElementById("mobile-backdrop");
  const sidebar = document.getElementById('sidebar');
  btn.innerHTML = '<span class="menu-stroke"></span><span class="menu-stroke"></span><span class="menu-stroke"></span>';
  btn.setAttribute('aria-controls', 'sidebar');
  syncMobileMenu();
  btn.addEventListener("click", () => {
    document.getElementById("sidebar").classList.contains("open") ? closeMobileMenu() : openMobileMenu();
  });
  backdrop.addEventListener("click", () => closeMobileMenu());
  registerMobileDrawer({ panel: sidebar, backdrop,
    isOpen: () => sidebar.classList.contains('open'),
    // Leave the outermost edge to Safari's system Back gesture.
    canOpen: (target, touch) => isMainDrawerZone(touch) && !target.closest('.chat-mobile-header'),
    open: openMobileMenu, close: () => closeMobileMenu(),
    onDrag: (offset, width) => {
      btn.classList.add('menu-dragging');
      btn.style.setProperty('--menu-travel', `${Math.max(0, width + offset - 56 - parseFloat(getComputedStyle(btn).left))}px`);
      btn.style.setProperty('--menu-progress', String(1 + offset / width));
    },
    onDragEnd: () => {
      btn.classList.remove('menu-dragging');
      btn.style.removeProperty('--menu-travel');
      btn.style.removeProperty('--menu-progress');
    },
  });
  // Close before navigation or an account/settings panel opens, so a panel
  // outside the drawer can take focus without competing with its Tab trap.
  sidebar.addEventListener('click', event => {
    if (event.target.closest('.nav-item, .sidebar-settings-btn, .sidebar-user-card, .segmented-tab, .forge-mode-rail, .forge-project-row, .sidebar-bot-main, .sidebar-bot-add, .sidebar-thread, .sidebar-thread-all, .sidebar-team-row, .sidebar-pinned-row')) closeMobileMenu();
  }, true);
  document.addEventListener('kairos:mobile-drawer-opening', event => {
    if (event.detail?.id !== 'sidebar') closeMobileMenu(false);
  });
  mobileMenuMedia.addEventListener('change', () => {
    const hiddenFocus = mobileMenuMedia.matches && sidebar.contains(document.activeElement);
    closeMobileMenu(false);
    if (hiddenFocus) btn.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    if (!mobileMenuMedia.matches || !sidebar.classList.contains('open') || event.defaultPrevented) return;
    if (document.activeElement?.closest('dialog[open], [aria-modal="true"]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMobileMenu();
    } else if (event.key === 'Tab') {
      const controls = drawerControls(sidebar);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
  });
}

// How many agent inbox items and results wait on the person: a count on the
// Agents nav item. The same visible-page tick refreshes the bot rail once,
// rather than starting a timer per bot (Agents 2.0, 2026-10-14).
let agentBadgeTimer = null;
async function refreshAgentBadge() {
  clearTimeout(agentBadgeTimer);
  agentBadgeTimer = setTimeout(refreshAgentBadge, 30000);
  if (document.hidden) return;
  peopleRail?.refresh();
  const inbox = await api("/api/agents/inbox").catch(() => null);
  const item = document.querySelector('#nav .nav-item[data-tab="agents"]');
  if (!item || !inbox) return;
  let badge = item.querySelector(".nav-badge");
  if (!inbox.count) { badge?.remove(); item.setAttribute("aria-label", "Agents"); return; }
  if (!badge) item.append(badge = Object.assign(document.createElement("span"), { className: "nav-badge" }));
  badge.textContent = inbox.count > 99 ? "99+" : String(inbox.count);
  item.setAttribute("aria-label", `Agents, ${inbox.count} waiting on you`);
}
document.addEventListener("jarvis:agents-changed", refreshAgentBadge);

async function buildSidebar() {
  const identity = await api('/api/auth/status').catch(() => null);
  forgeAdmin = !!identity?.is_admin;
  if (!forgeAdmin) rememberMode('kairos');
  document.getElementById('forge-mode-switch')?.remove();
  if (forgeAdmin) {
    const control = document.createElement('div');
    control.id = 'forge-mode-switch';
    control.className = 'forge-mode-switch';
    control.setAttribute('role', 'group');
    control.setAttribute('aria-label', 'App mode');
    for (const [mode, label] of [['kairos', 'Kairos'], ['forge', 'Forge']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'segmented-tab'; button.dataset.mode = mode;
      button.setAttribute('aria-pressed', String(appMode === mode));
      button.classList.toggle('active', appMode === mode); button.textContent = label;
      if (mode === 'forge') { const badge = document.createElement('small'); badge.textContent = 'Preview'; button.append(badge); }
      button.onclick = () => switchMode(mode);
      control.append(button);
    }
    const rail = document.createElement('button'); rail.type = 'button'; rail.className = 'forge-mode-rail';
    rail.setAttribute('aria-label', appMode === 'forge' ? 'Switch to Kairos' : 'Switch to Forge Preview');
    rail.title = rail.getAttribute('aria-label'); rail.innerHTML = KAIROS_MARK; // The Kairos circle mark (David, 2026-10-09).
    rail.onclick = () => switchMode(appMode === 'forge' ? 'kairos' : 'forge'); control.append(rail);
    document.querySelector('.sidebar-header').after(control);
  }
  const brand = document.getElementById("brand");
  brand.innerHTML = WORDMARK;
  brand.firstElementChild.classList.add("brand-wordmark");
  brand.firstElementChild.setAttribute("role", "img");
  brand.firstElementChild.setAttribute("aria-label", "Kairos");
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
  peopleRail?.dispose(); peopleRail = null;
  const nav = document.getElementById("nav");
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
  const groups = appMode === 'forge' ? [{ ids: FORGE_NAV.map(item => item.id) }] : sidebarLayout([...items.keys()]);
  if (appMode === 'forge') for (const item of FORGE_NAV) items.set(item.id, { ...item, svg: ICONS[item.icon] });
  for (const group of groups) {
    if (!group.ids.length) continue;
    if (group.label) {
      const label = document.createElement("div");
      label.className = "nav-group-label";
      label.textContent = group.label;
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
  else peopleRail = mountSidebarBots(nav);
  refreshAgentBadge();

  nav.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === activeTab);
    if (item.dataset.tab === activeTab) item.setAttribute("aria-current", "page");
  });
  buildSidebarFooter();
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
  footer.innerHTML = "";

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

  const menu = document.createElement("div");
  menu.className = "overflow-menu hidden";
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
  card.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
  document.addEventListener("click", () => menu.classList.add("hidden"));

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "sidebar-settings-btn";
  settingsBtn.title = "Settings";
  settingsBtn.setAttribute("aria-label", "Settings");
  settingsBtn.innerHTML = ICONS.settings || "";
  settingsBtn.addEventListener("click", openSettings);

  row.append(cardWrap, settingsBtn);
  footer.appendChild(row);
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
  initLayout(identity.username);
  overlay.classList.add("hidden");

  const settings = await api("/api/settings");
  const app = document.getElementById("app");


  if (!settings.onboarding_complete) {
    app.style.display = "none";
    overlay.classList.remove("hidden");
    await onboarding.run(overlay, () => {
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
  const customTabs = await buildSidebar();
  setupSidebar();
  setupMobileMenu();
  document.addEventListener("jarvis:navigate", (event) => {
    const { tab, ...options } = event.detail;
    tab === "settings" ? openSettings(options) : switchTab(tab, options);
  });
  // Adding/removing a tab in the Tool Store rebuilds the nav so it
  // appears immediately instead of after a reload.
  document.addEventListener("jarvis:tabs-changed", async () => {
    for (const id of Object.keys(customViewUrls)) delete modules[id];
    const tabs = await buildSidebar();
    if (activeTab && activeTab !== 'forgeShell' && ![...NAV, ...FORGE_NAV].some((item) => item.id === activeTab) && !tabs.some((item) => item.id === activeTab)) switchTab("home");
  });
  document.addEventListener("kairos:layout", () => { buildSidebar(); });
  commandPalette.init({ nav: NAV, customTabs: customTabs || [], switchTab, openSettings });
  floatingProgress.init({ switchTab });
  await chatStream.connect();
  notificationRegistration().catch(() => {});
  const openNotificationChat = async url => {
    const link = new URL(url, location.origin);
    const id = link.searchParams.get('chat');
    if (link.origin !== location.origin || link.pathname !== '/' || !/^[a-f0-9]{12}$/.test(id || '')) return false;
    try {
      const session = await api(`/api/sessions/${id}`);
      await switchTab(session.forge ? 'forgeShell' : 'chat', { sessionId: id });
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
    if (activeTab !== "chat") await switchTab("chat");
    openBrowser(url);
  });
  window.jarvis?.screenGrab?.onModelsRequest(async (requestId) => {
    const models = await api("/api/models").catch(() => []);
    window.jarvis.screenGrab.replyModels(requestId, models.map(({ id, name, model, kind, supports_images }) =>
      ({ id, supportsImages: supports_images,
        label: `${name} (${kind === "claude_cli" || kind === "codex_cli" ? model || "CLI default" : model})` })));
  });
  window.jarvis?.screenGrab?.onQuickDraft(async (draft) => {
    try {
      await switchTab("chat");
      const chat = await loadModule("chat");
      await chat.acceptQuickEntryDraft(draft);
      window.jarvis.screenGrab.replyQuickDraft(draft.requestId, { ok: true });
    } catch (error) {
      window.jarvis.screenGrab.replyQuickDraft(draft.requestId, { ok: false, error: error.message });
    }
  });
  if (!await openNotificationChat(location.href)) {
    const launch = new URL(location.href).searchParams;
    const target = launch.get('newchat') === '1' ? 'chat' : launch.get('view');
    await switchTab(['chat', 'home', 'library', 'notes', 'tasks', 'calendar'].includes(target)
      ? target : appMode === 'forge' ? 'forgeHome' : 'home');
    if (launch.has('newchat') || launch.has('view')) history.replaceState(null, '', '/');
  }
}

useAppMenusForSelects();
boot();
