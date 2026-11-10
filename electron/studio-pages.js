// electron/studio-pages.js — page-read analytics for Content Studio (vault: "Content Studio Team (Build Spec)",
// section 7: TikTok and Instagram numbers read from the signed-in pages in the Kairos Browser, read-only).
//
// The backend cannot ask Electron for work on its own, so, like designRender.js, this holds one loopback stream to
// GET /api/content-studio/page-reads/jobs, authenticated by the per-launch render token main.js gave the backend.
// Each job names one creator page of the person's own post (the backend builds it from the post's recorded link on a
// channel the person registered; services/content_studio/page_reads.py) and the Kairos account's Browse profile.
//
// The page is loaded in a hidden window on that profile's partition, so it sees the person's own sign-in, and only
// read: the window has no preload, every permission is denied by Browse's own handler (it is not a Browse tab),
// pop-ups and downloads are refused, and navigation off the platform's own site is stopped (a sign-in on another
// site counts as signed out). After the page settles, its visible text is read in an isolated world and sent back.
// Nothing is clicked, typed or filled. One page at a time; the backend spaces them out and caps them per day.

const { BrowserWindow, session } = require('electron');
const { partitionFor, validProfile } = require('./browser-browse');
const { hostAllowed } = require('./studio-prepare');

const PLATFORMS = new Set(['tiktok', 'instagram']);
const SETTLE_MS = 25000;
const MAX_TEXT = 200000;
let running = false, stopped = false, controller = null, activeWindow = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// One page, read-only. `partition` and `extraHosts` are for tests' local pages; the app passes the profile.
async function readPage({ profile, partition, platform, url, extraHosts = [], settleMs = SETTLE_MS }) {
  if (!PLATFORMS.has(platform)) throw new Error('page reads are for TikTok and Instagram');
  if (!hostAllowed(platform, url, extraHosts)) throw new Error('that page is not on the platform');
  const part = partition || partitionFor(validProfile(profile) || '');
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    session: session.fromPartition(part), sandbox: true, contextIsolation: true, nodeIntegration: false,
    webviewTag: false, backgroundThrottling: false, spellcheck: false } });
  activeWindow = win;
  const wc = win.webContents;
  let left = '';
  const refuse = (event, target) => { if (!hostAllowed(platform, target, extraHosts)) { event.preventDefault(); left = left || target; } };
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', refuse);
  wc.on('will-redirect', refuse);
  const noDownload = (event, _item, source) => { if (source === wc) event.preventDefault(); };
  wc.session.on('will-download', noDownload);
  try {
    try { await wc.loadURL(url); } catch { /* a stopped redirect aborts the load; what was reached is reported */ }
    if (left) return { url: left, title: '', text: '' };
    let text = '', same = 0;
    const until = Date.now() + settleMs;
    while (Date.now() < until && !wc.isDestroyed()) {
      await pause(1000);
      const now = String(await wc.executeJavaScriptInIsolatedWorld(1003, [{ code: 'document.body ? document.body.innerText : ""' }]).catch(() => '') || '');
      // Settled: the text stopped changing for two looks and holds a number (the counts load after the page).
      same = now === text ? same + 1 : 0;
      text = now;
      if (same >= 2 && /\d/.test(text)) break;
    }
    return { url: left || wc.getURL(), title: wc.isDestroyed() ? '' : wc.getTitle(), text: text.slice(0, MAX_TEXT) };
  } finally {
    wc.session.removeListener('will-download', noDownload);
    activeWindow = null;
    if (!win.isDestroyed()) win.destroy();
  }
}

async function post(backendUrl, token, job, page, error) {
  await fetch(`${backendUrl}/api/content-studio/page-reads/result/${encodeURIComponent(job.id)}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'X-Kairos-Render-Token': token, 'Content-Type': 'application/json',
      ...(error ? { 'X-Kairos-Render-Error': String(error).replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) } : {}) },
    body: page ? JSON.stringify(page) : '{}',
  });
}

async function serve(backendUrl, token) {
  const queue = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && !stopped) {
      const job = queue.shift();
      try { await post(backendUrl, token, job, await readPage({ profile: job.profile, platform: job.platform, url: job.url })); }
      catch (error) { await post(backendUrl, token, job, null, error.message || 'read failed').catch(() => {}); }
    }
    busy = false;
  };
  controller = new AbortController();
  const response = await fetch(`${backendUrl}/api/content-studio/page-reads/jobs`, {
    headers: { 'X-Kairos-Render-Token': token, Accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`page-read stream refused (${response.status})`);
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const line = block.split('\n').find(part => part.startsWith('data: '));
        if (!line) continue;
        try { queue.push(JSON.parse(line.slice(6))); pump(); } catch { /* a malformed line is ignored */ }
      }
    }
  } finally {
    queue.length = 0;
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
  }
}

// Reconnects with a growing delay while the app runs; the backend may restart.
function start({ backendUrl, token }) {
  if (running || !token) return;
  running = true; stopped = false;
  (async () => {
    let delay = 1000;
    while (!stopped) {
      const began = Date.now();
      try { await serve(backendUrl, token); } catch { /* retry below */ }
      if (stopped) break;
      delay = Date.now() - began > 30000 ? 1000 : Math.min(delay * 2, 30000);
      await pause(delay);
    }
    running = false;
  })();
}

function stop() { stopped = true; controller?.abort(); if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy(); }

module.exports = { start, stop, readPage };
