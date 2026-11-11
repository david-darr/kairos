// electron/browser-browse.js — puts Browse together (vault: "Kairos Browser -
// Phase 1 (Build Spec)", U2): one gate, store, ad blocker, permission
// broker, downloads list and tab manager on the person's profile, plus the
// small surface main.js exposes over IPC.
//
// The person's profile is the side pane's partition, persist:jarvis-browser,
// so sign-ins made in the pane carry over. Browse owns that session's
// handlers (permissions, downloads, the request filter); browser.js stands
// back once shareSession() is called.

const fs = require("fs");
const path = require("path");
const { session, desktopCapturer, systemPreferences, webContents: webContentsModule } = require("electron");
const { createGate, SEARCH } = require("./browser-gate");
const { openStore } = require("./browser-store");
const { createAdblock, createListUpdater } = require("./browser-adblock");
const { createPermissions } = require("./browser-permissions");
const { createDownloads } = require("./browser-downloads");
const { createTabs } = require("./browser-tabs");
const { createPasswords } = require("./browser-passwords");
const { createAudio } = require("./browser-audio");
const { createMedia } = require("./browser-media");

const PERMISSION_TIMEOUT_MS = 60000;
const LIST_CHECK_MS = 6 * 60 * 60 * 1000;
// Settings a page's site panel may change. Anything else is refused.
const SITE_KEYS = /^(adblock|popups|permission:(camera|microphone|location|notifications|clipboard|screen))$/;
// Screen sharing is never allowed ahead of time (each share is picked), so it can only be blocked.
const SITE_VALUES = { adblock: ["off"], popups: ["allow"], permission: ["allow", "block"], "permission:screen": ["block"] };

// The home screen's settings (Speed Dial, David 2026-11-03), kept in the
// store's meta table. Anything unknown or malformed falls back to these.
const HOME_DEFAULTS = { background: "kairos", color: "#1b1f24", image: null, dim: 0.35, tileSize: "medium", search: true, suggestions: true };
const IMAGE_MAX = 6 * 1024 * 1024;
function cleanHome(value) {
  const v = value && typeof value === "object" ? value : {};
  const out = { ...HOME_DEFAULTS };
  if (["kairos", "color", "image"].includes(v.background)) out.background = v.background;
  if (typeof v.color === "string" && /^#[0-9a-f]{6}$/i.test(v.color)) out.color = v.color;
  if (typeof v.image === "string" && v.image.length <= IMAGE_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v.image)) out.image = v.image;
  if (typeof v.dim === "number" && v.dim >= 0 && v.dim <= 0.9) out.dim = Math.round(v.dim * 100) / 100;
  if (["small", "medium", "large"].includes(v.tileSize)) out.tileSize = v.tileSize;
  if (typeof v.search === "boolean") out.search = v.search;
  if (typeof v.suggestions === "boolean") out.suggestions = v.suggestions;
  if (out.background === "image" && !out.image) out.background = "kairos";
  return out;
}

// The user agent sites see: Chrome's, without the "Electron/43.8.3" (and any
// app name) token Electron adds. Some sites refuse or break sign-in for an
// "embedded" Electron browser (David, 2026-11-06: X/Twitter); the engine is
// the same Chromium, so this is what Chrome of that version sends.
function cleanUserAgent(ua) {
  return String(ua || "").replace(/\s(?:Electron|Kairos|jarvis-app|JARVIS)\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}

// `passwordBackend(route, body)` reaches the backend's desktop password
// routes for the signed-in account (main.js); without it the password
// keeper is off and pages behave as before.
function createBrowse({ host, partition, folder, downloadsFolder, reservedPorts, backendOrigin, send, shell, log = console, passwordBackend = null }) {
  const partitionSession = session.fromPartition(partition);
  partitionSession.setUserAgent(cleanUserAgent(partitionSession.getUserAgent()));
  const store = openStore(path.join(folder, "browser.db"));
  const gate = createGate({ backendOrigin, reservedPorts, searchEngine: store.getMeta("searchEngine") || undefined });
  const adblock = createAdblock();
  // Lists are fetched on a session of their own, so the person's cookies
  // never go to the list hosts.
  const listSession = session.fromPartition("kairos-filter-lists");
  const lists = createListUpdater({
    adblock, dir: path.join(folder, "..", "filters"), log,
    fetchText: async (url) => { const r = await listSession.fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); },
  });
  try { lists.loadSaved(); } catch (err) { log.error(`[browser] saved filter lists unreadable: ${err.message}`); }
  const listTimer = setInterval(() => lists.refresh().catch(() => {}), LIST_CHECK_MS);
  const firstRefresh = setTimeout(() => lists.refresh().catch(() => {}), 30000);
  listTimer.unref?.(); firstRefresh.unref?.();

  let tabs = null;
  let restored = false;
  const pending = new Map();
  let nextRequest = 1;

  // The Browse tab showing these contents, or null (the side pane, a sign-in pop-up).
  function tabFor(webContents) {
    if (!tabs || !webContents) return null;
    return tabs.list().tabs.find((t) => { const wc = tabs.webContentsOf(t.id); return wc && wc.id === webContents.id; }) || null;
  }

  // The permission prompt is drawn by the app (U3). Only a Browse tab may
  // ask; the side pane and anything else is refused without a prompt. A
  // prompt left unanswered is withdrawn after a minute and counts as Block
  // for that one request (nothing is remembered).
  function ask({ webContents, origin, setting, embedded = null, canRemember = true }) {
    const tab = tabFor(webContents);
    if (!tab) return { answer: "block", remember: false };
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        send("browse:event", { event: "permission-closed", requestId });
        resolve({ answer: "block", remember: false });
      }, PERMISSION_TIMEOUT_MS);
      pending.set(requestId, (reply) => {
        clearTimeout(timer); pending.delete(requestId);
        resolve(canRemember ? reply : { answer: reply.answer, remember: false });
      });
      send("browse:permission", { requestId, tabId: tab.id, origin, setting, embedded, canRemember });
    });
  }

  // The audio output chosen in Browse settings (browser-audio.js).
  const audio = createAudio({ store });
  // Cameras, microphones and screen sharing (browser-media.js).
  const media = createMedia({
    store, tabFor, send, log, desktopCapturer, systemPreferences,
    fromFrame: (frame) => webContentsModule.fromFrame(frame),
    touch: () => tabs && tabs.touch(),
  });
  media.attach(partitionSession);
  const permissions = createPermissions({ store, ask, isTab: (wc) => !!tabFor(wc), beforeGrant: media.beforeGrant, pickScreen: media.pickScreen,
    speakerSelection: () => audio.allowSpeakerSelection() });
  permissions.attach(partitionSession);
  // A page's Allow once answers and in-use marks end when it navigates away or closes.
  function watchMedia(tab, wc) {
    const end = () => { permissions.forget(wc.id); media.forgetPick(wc.id); media.reset(tab.id); };
    wc.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) end(); });
    wc.once("destroyed", end);
  }
  const downloads = createDownloads({ store, folder: downloadsFolder, shell, notify: (d) => send("browse:download", d) });
  downloads.attach(partitionSession);
  adblock.attach(partitionSession, {
    enabledFor: (url) => store.getSite(url, "adblock") !== "off",
    onBlocked: (id) => tabs && tabs.countBlocked(id),
  });
  const passwords = createPasswords({
    backend: passwordBackend || (async () => { throw new Error("unavailable"); }),
    send, log,
  });
  tabs = createTabs({
    host, session: partitionSession, gate, store, adblock,
    notify: (payload) => send(payload.event ? "browse:event" : "browse:state", payload),
    onShortcut: (name, tabId) => send("browse:shortcut", { name, tabId }),
    onTabContents: (tab, wc) => { audio.attach(wc); watchMedia(tab, wc); if (passwordBackend) passwords.attach(tab, wc); },
    capturing: (tabId) => media.capturing(tabId),
  });

  function ensureRestored() {
    if (restored) return;
    restored = true;
    try { tabs.restore(); } catch (err) { log.error(`[browser] could not restore tabs: ${err.message}`); }
  }

  function setSite(url, key, value) {
    if (typeof key !== "string" || !SITE_KEYS.test(key)) return { ok: false };
    const kind = SITE_VALUES[key] ? key : key.startsWith("permission:") ? "permission" : key;
    if (value !== null && !SITE_VALUES[kind].includes(value)) return { ok: false };
    return { ok: store.setSite(url, key, value) };
  }

  // Every site's remembered permission answers, for Browser settings.
  function permissionList() {
    return store.allSiteSettings().filter((r) => SITE_KEYS.test(r.key) && r.key.startsWith("permission:"))
      .map((r) => ({ origin: r.origin, setting: r.key.slice("permission:".length), value: r.value }));
  }

  return {
    tabs, store, gate, ensureRestored,
    answerPermission(requestId, answer, remember) {
      const resolve = pending.get(requestId);
      if (resolve) resolve({ answer: answer === "allow" ? "allow" : "block", remember: !!remember });
      return { ok: !!resolve };
    },
    setSite,
    permissionList,
    media,
    answerScreen: (requestId, sourceId, audioOn) => media.answerScreen(requestId, sourceId, audioOn),
    stopCapture: (tabId) => media.stop(tabId),
    home() {
      let saved = null;
      try { saved = JSON.parse(store.getMeta("home") || "null"); } catch { saved = null; }
      return { settings: cleanHome(saved), pinned: store.pinned(), suggestions: store.topSites(12) };
    },
    setHome(value) { const clean = cleanHome(value); store.setMeta("home", JSON.stringify(clean)); return clean; },
    site: (url) => ({ settings: store.siteSettings(url), blocked: (tabs.list().tabs.find((t) => t.url === url) || {}).blocked || 0 }),
    setSearchEngine(id) { if (!SEARCH[id]) return { ok: false }; gate.setSearchEngine(id); store.setMeta("searchEngine", id); return { ok: true }; },
    searchEngines: () => ({ current: gate.searchEngine(), options: Object.keys(SEARCH) }),
    adblockStats: () => adblock.stats(),
    refreshLists: () => lists.refresh({ force: true }),
    downloads, passwords, audio,
    setReservedPorts: (ports) => gate.setReservedPorts(ports),
    close() {
      clearInterval(listTimer); clearTimeout(firstRefresh);
      passwords.close();
      media.close();
      for (const resolve of pending.values()) resolve({ answer: "block", remember: false });
      tabs.closeAll();
      try { store.close(); } catch { /* already closed */ }
    },
  };
}

// The ports Browse never opens on localhost: every Kairos instance's backend
// (the ordinary app, named instances and their neighbours), remote access,
// and the sandbox egress proxy and its control port. The same list
// core/computer.py keeps for bots' computers.
function kairosPorts({ instancePort, remotePort }) {
  return [...new Set([8420, 8421, 8422, 8430, 8431, 8888, 8889, instancePort, instancePort + 1, remotePort || 8422].filter(Boolean))];
}

// Multi-account: one Browse profile per Kairos account. The backend names
// it (GET /api/browse/profile): "default" for the first admin, who keeps the
// profile Browse had before accounts (persist:jarvis-browser and
// browser/default), else the account's folder id. Each profile has its own
// partition (cookies, site storage, cache) and its own browser.db (history,
// pinned sites, site settings, downloads, session), so one account's
// browsing never shows in another's. Cookie values are encrypted by
// Chromium's own key (the cookie fuse), shared by the install; saved
// passwords are the backend's, under the account's own key.
const PROFILE = /^(default|[a-z0-9]{1,32})$/;
function validProfile(profile) { return typeof profile === "string" && PROFILE.test(profile) ? profile : null; }
function partitionFor(profile) {
  const p = validProfile(profile);
  if (!p) throw new Error("not a Browse profile");
  return p === "default" ? "persist:jarvis-browser" : `persist:jarvis-browser-${p}`;
}
function browseFolder(userData, profile = "default") {
  const p = validProfile(profile);
  if (!p) throw new Error("not a Browse profile");
  const dir = path.join(userData, "browser", p === "default" ? "default" : `account-${p}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { createBrowse, kairosPorts, browseFolder, partitionFor, validProfile, cleanUserAgent, _SITE_KEYS: SITE_KEYS, _cleanHome: cleanHome };
