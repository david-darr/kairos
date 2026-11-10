// The Design canvas's render worker (vault: Design Canvas (Build Spec), 3g).
// The backend cannot ask Electron for work on its own, so this main-process
// module holds one loopback stream to the backend (GET /api/design-render/jobs),
// authenticated by a per-launch token main.js handed the backend at spawn
// (KAIROS_RENDER_TOKEN). Each job names one board render URL carrying a
// short-lived signed token; it is loaded in an offscreen window in its own
// partition (persist:design-render) with no preload, every permission denied,
// downloads and new windows refused, and every request outside that board's
// render route, its assets and the design fonts cancelled. The window
// captures a PNG, prints a PDF (the size of the board, or a document's own
// pages), or measures the board's layout for the editable PowerPoint export,
// and the bytes go back to POST /api/design-render/result/<job>. Modelled on
// forgePreview.js.
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:design-render';
// Render tokens name the account they were made for (core/design_render.sign): expiry.mac.account.mac.
const JOB_PATH = /^\/api\/designs\/([a-f0-9]{12})\/boards\/([a-z0-9][a-z0-9-]{0,47})\/render\?rt=[0-9]{10}\.[A-Za-z0-9_-]{24}\.[a-z0-9]{1,32}\.[A-Za-z0-9_-]{24}(?:&v=\d{1,6})?$/;
// `&layer=overlay` is the Blender renderer's overlay pass (core/video_blender.py): the same player with its 3D stage
// shots left transparent, captured as PNG with alpha and the 3D pose of every frame.
const VIDEO_PATH = /^\/api\/videos\/([a-f0-9]{12})\/player\?aspect=(16%3A9|9%3A16|1%3A1)&rt=[0-9]{10}\.[A-Za-z0-9_-]{24}\.[a-z0-9]{1,32}\.[A-Za-z0-9_-]{24}&v=[1-9][0-9]*(&layer=overlay)?$/;
// Pack B's 3D stage (static/motion/stage3d.js) loads three.js and only these example files from static/vendor/three
// (each listed with its hash in static/vendor/three/VENDORED.txt).
const THREE_PATH = /^\/static\/vendor\/three\/(three\.module|three\.core|examples\/jsm\/(environments\/RoomEnvironment|lights\/RectAreaLight(UniformsLib|TexturesLib)|postprocessing\/(EffectComposer|RenderPass|ShaderPass|MaskPass|Pass|GTAOPass|OutputPass)|shaders\/(CopyShader|GTAOShader|PoissonDenoiseShader|OutputShader|HorizontalBlurShader|VerticalBlurShader)|math\/SimplexNoise))\.js$/;
// A character's reference sheet (core/character_sheet.py): a PNG job on its own signed page.
const SHEET_PATH = /^\/api\/characters\/([a-f0-9]{12})\/sheet\?v=[1-9][0-9]{0,2}&rt=[0-9]{10}\.[A-Za-z0-9_-]{24}\.[a-z0-9]{1,32}\.[A-Za-z0-9_-]{24}$/;
let activeWindow = null, activeJob = '';
let running = false, stopped = false, controller = null, configured = false;
// The content's height: the bottom of the body's last child (the viewer script measures the same way).
const MEASURE = `(() => { let bottom = 0; for (const c of document.body.children) { if (c.tagName === 'SCRIPT') continue; const r = c.getBoundingClientRect(); if (r.height) bottom = Math.max(bottom, r.bottom + (parseFloat(getComputedStyle(c).marginBottom) || 0)); } return Math.ceil(bottom + scrollY); })()`;
// The board the current job renders: the request filter allows only its routes.
const current = { designId: '', videoId: '', path: '', look: '', characterId: '' };
const KD_ID = /^[a-z][a-z0-9-]{0,47}$/;
// What a PNG job may hide, for the PowerPoint background picture (core/design_pptx.py): an element's
// text, its own box paint, or all of it. Fixed rules; only ids that match KD_ID are used.
const HIDE_RULES = {
  text: 'color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important',
  box: 'background: transparent !important; border-color: transparent !important; box-shadow: none !important; outline: none !important',
  all: 'visibility: hidden !important',
};
// The layout job: every element's box and the computed style the PowerPoint builder maps, plus the
// text runs of each block that holds only inline content. Read only; nothing on the page changes.
const LAYOUT = `(() => {
  const INLINE = new Set(['B','STRONG','I','EM','SPAN','A','SMALL','SUP','SUB','BR','MARK','CODE','U','S']);
  const keep = ['color','backgroundColor','backgroundImage','borderTopWidth','borderTopStyle','borderTopColor',
    'borderRightWidth','borderBottomWidth','borderLeftWidth','borderTopLeftRadius','fontFamily','fontSize','fontWeight',
    'fontStyle','lineHeight','letterSpacing','textAlign','textTransform','opacity','transform','filter','boxShadow',
    'visibility','display','clipPath','mixBlendMode','paddingTop','paddingRight','paddingBottom','paddingLeft',
    'objectFit','listStyleType','writingMode','textDecorationLine','whiteSpace','position','backdropFilter','maskImage'];
  const style = el => { const s = getComputedStyle(el), o = {}; for (const k of keep) o[k] = s[k]; return o; };
  const runs = el => {
    const list = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (!child.data) continue;
          const s = getComputedStyle(node);
          list.push({ text: child.data, color: s.color, weight: s.fontWeight, italic: s.fontStyle === 'italic',
            size: s.fontSize, family: s.fontFamily, transform: s.textTransform,
            underline: s.textDecorationLine.includes('underline') });
        } else if (child.nodeType === 1) {
          if (child.tagName === 'BR') list.push({ br: true }); else walk(child);
        }
      }
    };
    walk(el);
    return list;
  };
  const inlineOnly = el => [...el.querySelectorAll('*')].every(c => INLINE.has(c.tagName));
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    const entry = { id: el.getAttribute('data-kd') || '', tag: el.tagName.toLowerCase(),
      parent: (el.parentElement && el.parentElement.getAttribute('data-kd')) || '',
      x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, style: style(el) };
    if (el.hasAttribute('data-chart')) entry.chart = el.getAttribute('data-chart');
    if (el.tagName === 'IMG') { entry.src = el.getAttribute('src') || ''; entry.natural = [el.naturalWidth, el.naturalHeight]; }
    if (!INLINE.has(el.tagName) && el.textContent.trim() && inlineOnly(el)) entry.runs = runs(el);
    out.push(entry);
  }
  return JSON.stringify({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, elements: out });
})()`;

function allowedRequest(raw, origin, designId, videoId = '', playerPath = '', look = '', characterId = '') {
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password) return false;
    if (characterId) return url.pathname + url.search === playerPath || /^\/static\/motion\/(kit|layout|rig|sheet|sheet3d|stage|stage3d)\.js$/.test(url.pathname) || THREE_PATH.test(url.pathname);
    if (videoId) {
      return (url.pathname + url.search === playerPath) ||
        (url.pathname.startsWith(`/api/videos/${videoId}/assets/`) && /^\/api\/videos\/[a-f0-9]{12}\/assets\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(url.pathname)) ||
        /^\/static\/motion\/(engine|kit|layout|rig|scene|stage|stage3d|overlay)\.js$/.test(url.pathname) || THREE_PATH.test(url.pathname) ||
        (url.pathname.startsWith(`/api/design-fonts/${look}/`) && /^\/api\/design-fonts\/[a-z0-9_-]+\/[A-Za-z0-9_.-]+\.(woff2?|ttf|otf)$/.test(url.pathname));
    }
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
    callback({ cancel: !allowedRequest(details.url, origin, current.designId, current.videoId, current.path, current.look, current.characterId) }));
  return isolated;
}

async function renderJob(origin, job, backendUrl, token) {
  const video = job.kind === 'video';
  const sheet = job.kind === 'png' && SHEET_PATH.test(String(job.path || ''));
  const match = (video ? VIDEO_PATH : sheet ? SHEET_PATH : JOB_PATH).exec(String(job.path || ''));
  const w = Math.max(64, Math.min(4000, Number(job.w) || 0));
  let h = Math.max(64, Math.min(8000, Number(job.h) || 0));
  if (!match || (!video && !['png', 'pdf', 'layout'].includes(job.kind))) throw new Error('refused an invalid render job');
  current.designId = video || sheet ? '' : match[1];
  current.videoId = video ? match[1] : '';
  current.characterId = sheet ? match[1] : '';
  current.path = String(job.path);
  current.look = String(job.look || '');
  // A long video (core/video_longform.py) is rendered one chapter at a time: `first` and `count` name the chapter's
  // frames inside the whole video's `frames`. One job captures at most 14,400 frames (8 minutes); a video is at most 20 minutes.
  if (video && (!/^[a-z0-9_-]{1,60}$/.test(current.look) || job.fps !== 30 || !Number.isInteger(job.frames) || job.frames < 1 || job.frames > 36000)) throw new Error('refused invalid video timing');
  // Only the overlay pass captures PNG with alpha, and only from the overlay player.
  if (video && job.alpha !== undefined && (job.alpha !== true || !match[3] || job.preview)) throw new Error('refused an invalid overlay job');
  if (video && !job.preview) {
    const first = job.first ?? 0, count = job.count ?? job.frames;
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 1 || count > 14400 || first + count > job.frames) throw new Error('refused invalid video frame range');
  }
  const isolated = configure(origin);
  const win = new BrowserWindow({
    show: false, width: w, height: h, useContentSize: true, frame: false, paintWhenInitiallyHidden: true,
    webPreferences: { session: isolated, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      javascript: true, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  activeWindow = win; activeJob = job.id;
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.setAudioMuted(true);
    // Device emulation crashes an offscreen window here (Electron 43), so the
    // page renders at the screen's scale and the capture is resized below.
    const painted = new Promise(resolve => win.webContents.once('paint', resolve));
    await win.loadURL(origin + job.path);
    if (video) return await captureVideo(win, job, backendUrl, token);
    await Promise.race([painted, new Promise(resolve => setTimeout(resolve, 3000))]);
    // A 3D sheet (static/motion/sheet3d.js) draws after three.js loads: wait for it, at most a minute.
    if (sheet) await Promise.race([win.webContents.executeJavaScript('Promise.resolve(window.kdReady).then(() => 1)', true), new Promise(resolve => setTimeout(resolve, 60000))]).catch(() => 1);
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
        // The page's own print size follows (its @page rule names the stored height); a document
        // prints on its own pages instead (core/design_render.py PAGED_PRINT).
        if (!job.paged) await win.webContents.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = '@page { size: ${w}px ${h}px; margin: 0 } @media print { html, body { height: ${h}px } }'; document.head.append(s); return 1; })()`, true).catch(() => 1);
        await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => 1)', true).catch(() => 1);
      }
    }
    if (job.kind === 'layout') {
      const json = await win.webContents.executeJavaScript(LAYOUT, true);
      return { type: 'application/json', body: Buffer.from(String(json), 'utf8') };
    }
    const hide = Array.isArray(job.hide)
      ? job.hide.filter(item => item && KD_ID.test(String(item.id)) && HIDE_RULES[item.mode]).slice(0, 2000) : [];
    if (hide.length) {
      const css = hide.map(item => {
        const sel = `[data-kd="${item.id}"]`;
        return `${item.mode === 'text' ? `${sel}, ${sel} *, ${sel}::marker, ${sel} *::marker` : sel} { ${HIDE_RULES[item.mode]} }`;
      }).join('\n');
      await win.webContents.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.append(s); return 1; })()`, true);
      await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => 1)', true).catch(() => 1);
    }
    if (job.kind === 'png') {
      // A rectangle capture fails (UnknownVizError) on an offscreen window: take
      // the whole page, which is the board, and size it to 1x or 2x exactly.
      const scale = job.scale === 2 ? 2 : 1;
      const image = (await win.webContents.capturePage()).resize({ width: w * scale, height: h * scale, quality: 'best' });
      return { type: 'image/png', body: image.toPNG() };
    }
    // A document prints on the pages its CSS names (Letter or A4, flowing); any other board as one page its size.
    const pdf = job.paged
      ? await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'default' } })
      : await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true,
        pageSize: { width: w / 96, height: h / 96 }, margins: { marginType: 'none' } });
    return { type: 'application/pdf', body: pdf };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    if (activeWindow === win) { activeWindow = null; activeJob = ''; }
  }
}

// Backpressure comes from awaiting each acknowledged part before capturing more.
async function captureVideo(win, job, backendUrl, token) {
  // A cancel destroys the window, and a script call in flight then never settles (found 2026-11-10: a stopped long
  // render left the worker waiting, so the resume never started). Every call also ends when the window goes.
  const gone = new Promise((_, reject) => { if (win.isDestroyed()) reject(new Error('video cancelled')); else win.once('closed', () => reject(new Error('video cancelled'))); });
  gone.catch(() => {});
  const evaluate = code => Promise.race([win.webContents.executeJavaScript(code, true), gone]);
  const info = await evaluate('Promise.resolve(window.kdReady).then(() => document.fonts.ready).then(() => window.kdInfo)');
  if (!info || info.width !== job.w || info.height !== job.h || info.fps !== 30 ||
      !Number.isFinite(info.duration) || info.duration <= 0 || Math.ceil(info.duration * 30 - 1e-7) !== job.frames) {
    throw new Error('The motion player dimensions or timing do not match this video job');
  }
  const first = job.first ?? 0;
  const times = job.preview ? job.times : Array.from({ length: job.count ?? job.frames }, (_, i) => (first + i) / job.fps);
  if (!Array.isArray(times) || !times.length || (job.preview && times.length > 12) ||
      times.some(t => !Number.isFinite(t) || t < 0 || t >= info.duration)) throw new Error('invalid video sample times');
  const sampleTimes = job.layoutTimes;
  if (!Array.isArray(sampleTimes) || sampleTimes.length > 120 ||
      sampleTimes.some(t => !Number.isFinite(t) || t < 0 || t >= info.duration)) throw new Error('invalid layout sample times');
  const layouts = [];
  for (const t of sampleTimes) {
    if (stopped || win.isDestroyed()) throw new Error('video cancelled');
    const elements = await evaluate(`Promise.resolve(window.kdDrawFrame(${t})).then(() => window.kdLayout(${t}))`);
    layouts.push({ time: t, elements });
  }
  // The overlay pass: PNG with alpha, the 3D pose of each frame, and the stage models once (Blender builds them).
  const alpha = job.alpha === true, size = alpha ? 5 : 15, mime = alpha ? 'image/png' : 'image/jpeg';
  const stage = alpha ? await evaluate('JSON.stringify(window.kdStageModels ? window.kdStageModels() : {})') : null;
  let frames = [], poses = [], part = 0;
  for (let i = 0; i < times.length; i++) {
    if (stopped || win.isDestroyed()) throw new Error('video cancelled');
    const grab = alpha
      ? `Promise.resolve(window.kdDrawFrame(${times[i]})).then(() => JSON.stringify([document.getElementById('kd-canvas').toDataURL('image/png'), window.kdPose(${times[i]})]))`
      : `Promise.resolve(window.kdDrawFrame(${times[i]})).then(() => document.getElementById('kd-canvas').toDataURL('image/jpeg', 0.92))`;
    let data = await evaluate(grab);
    if (alpha) { const [image, pose] = JSON.parse(data); data = image; poses.push(pose); }
    if (typeof data !== 'string' || !data.startsWith(`data:${mime};base64,`)) throw new Error(`motion player did not return a ${alpha ? 'PNG' : 'JPEG'}`);
    frames.push(data.slice(data.indexOf(',') + 1));
    if (frames.length === size || i === times.length - 1) {
      const packet = { frames, layouts: part === 0 ? layouts : [] };
      if (alpha) { packet.poses = poses; if (part === 0) packet.stage = stage; }
      await post(backendUrl, token, job, { type: 'application/json', body: JSON.stringify(packet) }, null, part++);
      frames = []; poses = [];
    }
  }
  return { type: 'application/json', body: JSON.stringify({ frames: times.length }) };
}

async function post(backendUrl, token, job, result, error, part = null) {
  const suffix = part === null ? '' : `?part=${part}`;
  const response = await fetch(`${backendUrl}/api/design-render/result/${encodeURIComponent(job.id)}${suffix}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { 'X-Kairos-Render-Token': token, 'Content-Type': result?.type || 'application/octet-stream',
      ...(error ? { 'X-Kairos-Render-Error': String(error).replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) } : {}) },
    body: result ? result.body : Buffer.alloc(0),
  });
  if (job.kind === 'video' && (!response.ok || !(await response.json()).ok)) throw new Error('video job cancelled or result refused');
}

// One job at a time, in arrival order: a board render is quick, and one
// offscreen window at a time keeps memory flat on a 40-board export.
async function serve(backendUrl, token) {
  const origin = new URL(backendUrl).origin;
  const queue = [];
  let busy = false;
  let pumping = Promise.resolve();
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && !stopped) {
      const job = queue.shift();
      try { await post(backendUrl, token, job, await renderJob(origin, job, backendUrl, token)); }
      catch (error) { await post(backendUrl, token, job, null, error.message || 'render failed').catch(() => {}); }
    }
    busy = false;
  };
  controller = new AbortController();
  const response = await fetch(`${backendUrl}/api/design-render/jobs`, {
    headers: { 'X-Kairos-Render-Token': token, Accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`render stream refused (${response.status})`);
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
        try {
          const job = JSON.parse(line.slice(6));
          if (job.kind === 'cancel') {
            const index = queue.findIndex(item => item.id === job.id);
            if (index >= 0) queue.splice(index, 1);
            if (activeJob === job.id && activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
          } else { queue.push(job); if (!busy) pumping = pump(); }
        } catch { /* A malformed line is ignored. */ }
      }
    }
  } finally {
    // A reconnect must not start a second window while the old stream's
    // pump is still rendering. Abandon its queue and drain the active job.
    queue.length = 0;
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
    await pumping;
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

function stop() { stopped = true; controller?.abort(); if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy(); }

module.exports = { start, stop, allowedRequest, JOB_PATH, VIDEO_PATH, SHEET_PATH, THREE_PATH, KD_ID, HIDE_RULES };
