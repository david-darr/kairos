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
const { session } = require("electron");
const { createGate, SEARCH } = require("./browser-gate");
const { openStore } = require("./browser-store");
const { createAdblock, createListUpdater } = require("./browser-adblock");
const { createPermissions } = require("./browser-permissions");
const { createDownloads } = require("./browser-downloads");
const { createTabs } = require("./browser-tabs");

const PERMISSION_TIMEOUT_MS = 60000;
const LIST_CHECK_MS = 6 * 60 * 60 * 1000;
// Settings a page's site panel may change. Anything else is refused.
const SITE_KEYS = /^(adblock|popups|permission:(camera|microphone|location|notifications|clipboard))$/;
const SITE_VALUES = { adblock: ["off"], popups: ["allow"], permission: ["allow", "block"] };

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

function createBrowse({ host, partition, folder, downloadsFolder, reservedPorts, backendOrigin, send, shell, log = console }) {
  const partitionSession = session.fromPartition(partition);
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

  // The permission prompt is drawn by the app (U3). Only a Browse tab may
  // ask; the side pane and anything else is refused without a prompt.
  function ask({ webContents, origin, setting }) {
    const tab = tabs && tabs.list().tabs.find((t) => { const wc = tabs.webContentsOf(t.id); return wc && wc.id === webContents.id; });
    if (!tab) return { answer: "block", remember: false };
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ answer: "block", remember: false }); }, PERMISSION_TIMEOUT_MS);
      pending.set(requestId, (reply) => { clearTimeout(timer); pending.delete(requestId); resolve(reply); });
      send("browse:permission", { requestId, tabId: tab.id, origin, setting });
    });
  }

  createPermissions({ store, ask }).attach(partitionSession);
  const downloads = createDownloads({ store, folder: downloadsFolder, shell, notify: (d) => send("browse:download", d) });
  downloads.attach(partitionSession);
  adblock.attach(partitionSession, {
    enabledFor: (url) => store.getSite(url, "adblock") !== "off",
    onBlocked: (id) => tabs && tabs.countBlocked(id),
  });
  tabs = createTabs({
    host, session: partitionSession, gate, store, adblock,
    notify: (payload) => send(payload.event ? "browse:event" : "browse:state", payload),
    onShortcut: (name, tabId) => send("browse:shortcut", { name, tabId }),
  });

  function ensureRestored() {
    if (restored) return;
    restored = true;
    try { tabs.restore(); } catch (err) { log.error(`[browser] could not restore tabs: ${err.message}`); }
  }

  function setSite(url, key, value) {
    if (typeof key !== "string" || !SITE_KEYS.test(key)) return { ok: false };
    const kind = key.startsWith("permission:") ? "permission" : key;
    if (value !== null && !SITE_VALUES[kind].includes(value)) return { ok: false };
    return { ok: store.setSite(url, key, value) };
  }

  return {
    tabs, store, gate, ensureRestored,
    answerPermission(requestId, answer, remember) {
      const resolve = pending.get(requestId);
      if (resolve) resolve({ answer: answer === "allow" ? "allow" : "block", remember: !!remember });
      return { ok: !!resolve };
    },
    setSite,
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
    downloads,
    setReservedPorts: (ports) => gate.setReservedPorts(ports),
    close() {
      clearInterval(listTimer); clearTimeout(firstRefresh);
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

function browseFolder(userData) {
  const dir = path.join(userData, "browser", "default");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { createBrowse, kairosPorts, browseFolder, _SITE_KEYS: SITE_KEYS, _cleanHome: cleanHome };
