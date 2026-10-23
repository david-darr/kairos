// The Design canvas's render worker (vault: Design Canvas (Build Spec), 3g).
// The backend cannot ask Electron for work on its own, so this main-process
// module holds one loopback stream to the backend (GET /api/design-render/jobs),
// authenticated by a per-launch token main.js handed the backend at spawn
// (KAIROS_RENDER_TOKEN). Each job names one board render URL carrying a
// short-lived signed token; it is loaded in an offscreen window in its own
// partition (persist:design-render) with no preload, every permission denied,
// downloads and new windows refused, and every request outside that board's
// render route, its assets and the design fonts cancelled. The window
// captures a PNG or prints a PDF the size of the board, and the bytes go back
// to POST /api/design-render/result/<job>. Modelled on forgePreview.js.
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:design-render';
const JOB_PATH = /^\/api\/designs\/([a-f0-9]{12})\/boards\/([a-z0-9][a-z0-9-]{0,47})\/render\?rt=[0-9]{10}\.[A-Za-z0-9_-]{24}(?:&v=\d{1,6})?$/;
let running = false, stopped = false, controller = null, configured = false;
// The content's height: the bottom of the body's last child (the viewer script measures the same way).
const MEASURE = `(() => { let bottom = 0; for (const c of document.body.children) { if (c.tagName === 'SCRIPT') continue; const r = c.getBoundingClientRect(); if (r.height) bottom = Math.max(bottom, r.bottom + (parseFloat(getComputedStyle(c).marginBottom) || 0)); } return Math.ceil(bottom + scrollY); })()`;
// The board the current job renders: the request filter allows only its routes.
const current = { designId: '' };

function allowedRequest(raw, origin, designId) {
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password) return false;
    return url.pathname.startsWith(`/api/designs/${designId}/`) || url.pathname.startsWith('/api/design-fonts/');
  } catch { return false; }
}

function configure(origin) {
  const isolated = session.fromPartition(PARTITION);
  if (configured) return isolated;
  configured = true;
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setDevicePermissionHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowedRequest(details.url, origin, current.designId) }));
  return isolated;
}

async function renderJob(origin, job) {
  const match = JOB_PATH.exec(String(job.path || ''));
  const w = Math.max(64, Math.min(4000, Number(job.w) || 0));
  let h = Math.max(64, Math.min(8000, Number(job.h) || 0));
  if (!match || !['png', 'pdf'].includes(job.kind)) throw new Error('refused an invalid render job');
  current.designId = match[1];
  const isolated = configure(origin);
  const win = new BrowserWindow({
    show: false, width: w, height: h, useContentSize: true, frame: false, paintWhenInitiallyHidden: true,
    webPreferences: { session: isolated, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      javascript: true, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.setAudioMuted(true);
    // Device emulation crashes an offscreen window here (Electron 43), so the
    // page renders at the screen's scale and the capture is resized below.
    const painted = new Promise(resolve => win.webContents.once('paint', resolve));
    await win.loadURL(origin + job.path);
    await Promise.race([painted, new Promise(resolve => setTimeout(resolve, 3000))]);
    // Fonts first, then one frame, so the capture shows the real type.
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => 1)', true)
      .catch(() => 1);
    // A website or email board is as tall as its content (core/design_formats.py):
    // measure the page and render all of it, never cut at a stale height.
    if (job.grow) {
      const measured = Number(await win.webContents.executeJavaScript(MEASURE, true).catch(() => 0));
      if (measured >= 64 && Math.abs(measured - h) > 1) {
        h = Math.max(64, Math.min(8000, Math.max(Math.round(measured), Number(job.min_h) || 0)));
        win.setContentSize(w, h);
        // The page's own print size follows (its @page rule names the stored height).
        await win.webContents.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = '@page { size: ${w}px ${h}px; margin: 0 } @media print { html, body { height: ${h}px } }'; document.head.append(s); return 1; })()`, true).catch(() => 1);
        await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => 1)', true).catch(() => 1);
      }
    }
    if (job.kind === 'png') {
      // A rectangle capture fails (UnknownVizError) on an offscreen window: take
      // the whole page, which is the board, and size it to 1x or 2x exactly.
      const scale = job.scale === 2 ? 2 : 1;
      const image = (await win.webContents.capturePage()).resize({ width: w * scale, height: h * scale, quality: 'best' });
      return { type: 'image/png', body: image.toPNG() };
    }
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true,
      pageSize: { width: w / 96, height: h / 96 }, margins: { marginType: 'none' } });
    return { type: 'application/pdf', body: pdf };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function post(backendUrl, token, job, result, error) {
  await fetch(`${backendUrl}/api/design-render/result/${encodeURIComponent(job.id)}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'X-Kairos-Render-Token': token, 'Content-Type': result?.type || 'application/octet-stream',
      ...(error ? { 'X-Kairos-Render-Error': String(error).replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) } : {}) },
    body: result ? result.body : Buffer.alloc(0),
  }).catch(() => {});
}

// One job at a time, in arrival order: a board render is quick, and one
// offscreen window at a time keeps memory flat on a 40-board export.
async function serve(backendUrl, token) {
  const origin = new URL(backendUrl).origin;
  const queue = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      try { await post(backendUrl, token, job, await renderJob(origin, job)); }
      catch (error) { await post(backendUrl, token, job, null, error.message || 'render failed'); }
    }
    busy = false;
  };
  controller = new AbortController();
  const response = await fetch(`${backendUrl}/api/design-render/jobs`, {
    headers: { 'X-Kairos-Render-Token': token, Accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`render stream refused (${response.status})`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      const line = block.split('\n').find(part => part.startsWith('data: '));
      if (!line) continue;
      try { queue.push(JSON.parse(line.slice(6))); pump(); } catch { /* A malformed line is ignored. */ }
    }
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
      try { await serve(backendUrl, token); } catch { /* Retry below. */ }
      if (stopped) break;
      delay = Date.now() - began > 30000 ? 1000 : Math.min(delay * 2, 30000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    running = false;
  })();
}

function stop() { stopped = true; controller?.abort(); }

module.exports = { start, stop, allowedRequest, JOB_PATH };
