// electron/browser-downloads.js — downloads for Browse tabs (vault: "Kairos
// Browser - Phase 1 (Build Spec)", U1).
//
// The side pane hands downloads to the system browser (browser.js). Browse
// is the system browser now, so it saves them itself, to the Downloads
// folder, and keeps a list with progress, pause, resume, cancel, open and
// show in folder.
//
// Every finished file gets the Windows "downloaded from the internet" mark
// (a Zone.Identifier stream, zone 3), so SmartScreen and Office's Protected
// View treat it as they would from any browser (D8). Kairos writes it
// itself rather than assume the engine does.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Windows-reserved names and characters, trailing dots and spaces.
function safeName(name) {
  let clean = String(name || "download").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 200);
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) clean = `download_${clean}`;
  return clean;
}

// "report.pdf", then "report (1).pdf", "report (2).pdf"...
function uniquePath(dir, name) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function zoneIdentifier(url, referrer) {
  const lines = ["[ZoneTransfer]", "ZoneId=3"];
  // Only web addresses, and never ones carrying credentials.
  for (const [key, value] of [["ReferrerUrl", referrer], ["HostUrl", url]]) {
    try {
      const u = new URL(value);
      if ((u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password) lines.push(`${key}=${u.toString()}`);
    } catch { /* left out */ }
  }
  return lines.join("\r\n") + "\r\n";
}

function markFromInternet(file, url, referrer, platform = process.platform) {
  if (platform !== "win32") return false;
  fs.writeFileSync(`${file}:Zone.Identifier`, zoneIdentifier(url, referrer));
  return true;
}

function createDownloads({ store, folder, notify = () => {}, shell }) {
  const items = new Map();

  function row(id, item, extra = {}) {
    return {
      id, url: item.getURL(), filename: path.basename(item.getSavePath() || item.getFilename()), path: item.getSavePath(),
      state: item.isPaused() ? "paused" : item.getState(), received: item.getReceivedBytes(), total: item.getTotalBytes(),
      startedAt: Math.round(item.getStartTime() * 1000) || Date.now(), ...extra,
    };
  }

  function attach(partitionSession) {
    partitionSession.on("will-download", (_event, item, webContents) => {
      const id = crypto.randomUUID();
      const dir = folder();
      fs.mkdirSync(dir, { recursive: true });
      item.setSavePath(uniquePath(dir, safeName(item.getFilename())));
      const referrer = webContents && !webContents.isDestroyed() ? webContents.getURL() : "";
      items.set(id, item);
      const report = (extra) => { const r = row(id, item, extra); store.putDownload(r); notify(r); };
      report();
      item.on("updated", () => report());
      item.once("done", (_e, state) => {
        items.delete(id);
        let marked = false;
        if (state === "completed") {
          try { marked = markFromInternet(item.getSavePath(), item.getURL(), referrer); }
          catch (err) { console.error(`[browser] could not mark a download as from the internet: ${err.message}`); }
        }
        report({ state, endedAt: Date.now(), marked });
      });
    });
  }

  function control(id, action) {
    const item = items.get(id);
    if (item) {
      if (action === "pause" && !item.isPaused()) item.pause();
      else if (action === "resume" && item.canResume()) item.resume();
      else if (action === "cancel") item.cancel();
      return { ok: true };
    }
    const saved = store.downloads(1000).find((d) => d.id === id);
    if (!saved || !saved.path) return { ok: false };
    // Only files this list saved, and only while they still exist.
    if (action === "open" && saved.state === "completed" && fs.existsSync(saved.path)) { shell.openPath(saved.path); return { ok: true }; }
    if (action === "show" && fs.existsSync(saved.path)) { shell.showItemInFolder(saved.path); return { ok: true }; }
    if (action === "forget") return { ok: store.removeDownload(id) > 0 };
    return { ok: false };
  }

  return { attach, control, list: () => store.downloads() };
}

module.exports = { createDownloads, _safeName: safeName, _uniquePath: uniquePath, _zoneIdentifier: zoneIdentifier, _markFromInternet: markFromInternet };
