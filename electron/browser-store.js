// electron/browser-store.js — Browse's own data (vault: "Kairos Browser -
// Phase 1 (Build Spec)", U1): history, pinned sites, per-site settings
// (permissions, zoom, ad blocking, pop-ups), the downloads list and the
// tabs to restore.
//
// node:sqlite, built into Electron 43's Node (proven in Phase 0), so no
// package. One file per profile at userData/browser/<profile>/browser.db.
// It is not encrypted, as in Chrome; it is included in Kairos backups (D9)
// and no bot can read it. Passwords and cookies never live here.

const fs = require("fs");
const path = require("path");

const MAX_TITLE = 500;
const MAX_URL = 8192;

function clip(text, max) { return String(text == null ? "" : text).slice(0, max); }

// Only real web addresses are remembered; data:, blob: and internal pages
// never reach history or suggestions.
function webUrl(url) {
  try {
    const parsed = new URL(String(url));
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && url.length <= MAX_URL ? parsed.toString() : null;
  } catch { return null; }
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function openStore(file) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT, visited_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS history_time ON history (visited_at);
    CREATE INDEX IF NOT EXISTS history_url ON history (url);
    CREATE TABLE IF NOT EXISTS pinned (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS site_settings (origin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (origin, key));
    CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, url TEXT, path TEXT, filename TEXT, state TEXT,
      received INTEGER, total INTEGER, started_at INTEGER, ended_at INTEGER);
  `);
  // Speed Dial pictures (home screen): a small JPEG of the site, taken
  // locally when it was last visited. Added after the first release of the
  // table, so older files gain the column here.
  if (!db.prepare("PRAGMA table_info(pinned)").all().some((c) => c.name === "thumb")) db.exec("ALTER TABLE pinned ADD COLUMN thumb TEXT");

  const q = {
    visit: db.prepare("INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)"),
    retitle: db.prepare("UPDATE history SET title = ? WHERE id = (SELECT id FROM history WHERE url = ? ORDER BY visited_at DESC LIMIT 1)"),
    recent: db.prepare("SELECT id, url, title, visited_at FROM history ORDER BY visited_at DESC LIMIT ?"),
    search: db.prepare("SELECT id, url, title, visited_at FROM history WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY visited_at DESC LIMIT ?"),
    suggest: db.prepare(`SELECT url, MAX(title) AS title, COUNT(*) AS visits, MAX(visited_at) AS last FROM history
      WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' GROUP BY url ORDER BY visits DESC, last DESC LIMIT ?`),
    deleteOne: db.prepare("DELETE FROM history WHERE id = ?"),
    deleteRange: db.prepare("DELETE FROM history WHERE visited_at >= ? AND visited_at < ?"),
    pinned: db.prepare("SELECT id, url, title, position, thumb FROM pinned ORDER BY position"),
    editPin: db.prepare("UPDATE pinned SET url = ?, title = ?, thumb = CASE WHEN url = ? THEN thumb ELSE NULL END WHERE id = ?"),
    thumb: db.prepare("UPDATE pinned SET thumb = ? WHERE id = ?"),
    visits: db.prepare("SELECT url, title FROM history ORDER BY visited_at DESC LIMIT 3000"),
    pin: db.prepare("INSERT INTO pinned (url, title, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM pinned)) ON CONFLICT(url) DO UPDATE SET title = excluded.title"),
    unpin: db.prepare("DELETE FROM pinned WHERE id = ?"),
    place: db.prepare("UPDATE pinned SET position = ? WHERE id = ?"),
    getSite: db.prepare("SELECT value FROM site_settings WHERE origin = ? AND key = ?"),
    setSite: db.prepare("INSERT INTO site_settings (origin, key, value) VALUES (?, ?, ?) ON CONFLICT(origin, key) DO UPDATE SET value = excluded.value"),
    clearSiteKey: db.prepare("DELETE FROM site_settings WHERE origin = ? AND key = ?"),
    listSite: db.prepare("SELECT key, value FROM site_settings WHERE origin = ? ORDER BY key"),
    listSites: db.prepare("SELECT origin, key, value FROM site_settings ORDER BY origin, key"),
    clearSite: db.prepare("DELETE FROM site_settings WHERE origin = ?"),
    putDownload: db.prepare(`INSERT INTO downloads (id, url, path, filename, state, received, total, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, filename = excluded.filename,
      state = excluded.state, received = excluded.received, total = excluded.total, ended_at = excluded.ended_at`),
    downloads: db.prepare("SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?"),
    dropDownload: db.prepare("DELETE FROM downloads WHERE id = ?"),
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  };

  const like = (text) => `%${String(text).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const limit = (n, max) => Math.max(1, Math.min(Number(n) || max, max));

  return {
    addVisit(url, title, at = Date.now()) {
      const clean = webUrl(url);
      if (clean) q.visit.run(clean, clip(title, MAX_TITLE), at);
      return !!clean;
    },
    setTitle(url, title) {
      const clean = webUrl(url);
      if (clean) q.retitle.run(clip(title, MAX_TITLE), clean);
    },
    recentHistory: (n = 100) => q.recent.all(limit(n, 1000)),
    searchHistory: (text, n = 100) => q.search.all(like(text), like(text), limit(n, 1000)),
    deleteHistory: (id) => q.deleteOne.run(Number(id)).changes,
    deleteHistoryRange: (from, to) => q.deleteRange.run(Number(from), Number(to)).changes,

    // Address-bar suggestions: pinned sites first, then the most visited.
    suggest(text, n = 8) {
      const needle = String(text || "").trim().toLowerCase();
      if (!needle) return [];
      const pins = q.pinned.all().filter((p) => p.url.toLowerCase().includes(needle) || (p.title || "").toLowerCase().includes(needle))
        .map((p) => ({ url: p.url, title: p.title, kind: "pinned" }));
      const seen = new Set(pins.map((p) => p.url));
      const visits = q.suggest.all(like(needle), like(needle), limit(n, 50)).filter((r) => !seen.has(r.url))
        .map((r) => ({ url: r.url, title: r.title, kind: "history" }));
      return [...pins, ...visits].slice(0, limit(n, 50));
    },

    pinned: () => q.pinned.all(),
    pin(url, title) {
      const clean = webUrl(url);
      if (!clean) return false;
      q.pin.run(clean, clip(title, MAX_TITLE));
      return true;
    },
    unpin: (id) => q.unpin.run(Number(id)).changes,
    // Change a tile's address or name. A new address drops the old picture.
    editPin(id, url, title) {
      const clean = webUrl(url);
      if (!clean) return false;
      try { return q.editPin.run(clean, clip(title, MAX_TITLE), clean, Number(id)).changes > 0; } catch { return false; }
    },
    setThumb: (id, dataUrl) => q.thumb.run(dataUrl == null ? null : String(dataUrl), Number(id)).changes,
    // The pinned site a page belongs to, by origin, if any.
    pinnedFor(url) {
      const origin = originOf(url);
      return origin ? q.pinned.all().find((p) => originOf(p.url) === origin) || null : null;
    },
    // Home screen suggestions: the most visited sites in recent history that
    // aren't pinned, one entry per origin.
    topSites(n = 8) {
      const pinnedOrigins = new Set(q.pinned.all().map((p) => originOf(p.url)));
      const counts = new Map();
      for (const row of q.visits.all()) {
        const origin = originOf(row.url);
        if (!origin || pinnedOrigins.has(origin)) continue;
        const entry = counts.get(origin) || { url: origin + "/", title: "", visits: 0 };
        entry.visits += 1;
        if (!entry.title && row.title) entry.title = row.title;
        counts.set(origin, entry);
      }
      return [...counts.values()].sort((a, b) => b.visits - a.visits).slice(0, limit(n, 24));
    },
    reorderPinned(ids) {
      db.exec("BEGIN");
      try { ids.forEach((id, i) => q.place.run(i, Number(id))); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    },

    // Per-site settings are keyed by origin (scheme, host and port).
    getSite(url, key) {
      const origin = originOf(url);
      const row = origin && q.getSite.get(origin, key);
      return row ? row.value : null;
    },
    setSite(url, key, value) {
      const origin = originOf(url);
      if (!origin) return false;
      if (value == null) q.clearSiteKey.run(origin, key); else q.setSite.run(origin, key, String(value));
      return true;
    },
    siteSettings(url) {
      const origin = originOf(url);
      return origin ? Object.fromEntries(q.listSite.all(origin).map((r) => [r.key, r.value])) : {};
    },
    allSiteSettings: () => q.listSites.all(),
    clearSite(url) { const origin = originOf(url); return origin ? q.clearSite.run(origin).changes : 0; },

    putDownload(d) {
      q.putDownload.run(d.id, d.url || "", d.path || "", d.filename || "", d.state || "progressing",
        Number(d.received) || 0, Number(d.total) || 0, Number(d.startedAt) || Date.now(), d.endedAt ? Number(d.endedAt) : null);
    },
    downloads: (n = 200) => q.downloads.all(limit(n, 1000)),
    removeDownload: (id) => q.dropDownload.run(String(id)).changes,

    // Session restore: the open tabs as one JSON value.
    saveSession(tabs) { q.setMeta.run("session", JSON.stringify(tabs || [])); },
    loadSession() {
      const row = q.getMeta.get("session");
      try { return row ? JSON.parse(row.value) : []; } catch { return []; }
    },
    getMeta(key) { const row = q.getMeta.get(key); return row ? row.value : null; },
    setMeta(key, value) { q.setMeta.run(key, String(value)); },

    close() { db.close(); },
  };
}

module.exports = { openStore, _webUrl: webUrl };
