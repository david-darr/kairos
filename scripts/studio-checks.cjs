// Standalone offline UI checks: node scripts/studio-checks.cjs
// Uses the real shell, folder tab renderer, motion engine and chat renderer.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const binary = process.env.JARVIS_ELECTRON_BINARY || require('../electron/node_modules/electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(binary, [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 420000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const assert = require('node:assert/strict');
const fixture = require('../demo/fixtures.js')({ state: { empty: false } }).fixture;
const output = path.join(root, 'data/ui-review', 'studio-' + Date.now());
const lock = path.join(root, 'data/electron.lock');
let ownsLock = false, win, server;
const errors = [], outside = [], writes = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = 'abcdef123456';
const project = { id, owner: 'local', title: 'Spring season', look: 'sport', bpm: 120, fps: 30, aspects: ['16:9', '9:16', '1:1'],
  beats: [{ id: 'title', kind: 'title', text: 'Spring season is here', bars: 1 }, { id: 'message', kind: 'statement', text: 'Every kid plays', bars: 1 }, { id: 'end', kind: 'end', text: 'Find your team', bars: 1 }],
  music: { mood: 'energetic', volume: .7 }, version: 1, updated: Date.now() / 1000, created: Date.now() / 1000 };
const original = structuredClone(project), history = [structuredClone(project)], jobs = [], renders = [];
const tokens = { '--ds-bg': '#101418', '--ds-surface': '#1b2129', '--ds-text': '#ffffff', '--ds-text-dim': '#b4bdc8', '--ds-accent': '#c6ff3d',
  '--ds-accent-2': '#ff5a1f', '--ds-on-accent': '#101418', '--ds-font-display': 'Arial, sans-serif', '--ds-font-sans': 'Arial, sans-serif', '--ds-radius-m': '4px' };
let enabled = true;
const template = fs.readFileSync(path.join(root, 'static/motion/player.html'), 'utf8');
const customTab = { id: 'studio', label: 'Studio', user_tab: false, format: 'folder', view_url: '/tab-files/studio/view.js', style_url: '/tab-files/studio/view.css', icon_svg: '<svg viewBox="0 0 24 24"><path d="M3 6h18v15H3z"/></svg>' };
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
async function serve(req, res) {
  const url = new URL(req.url, 'http://localhost'), p = url.pathname;
  if (p === `/api/videos/${id}/player`) {
    res.setHeader('Content-Type', 'text/html');
    res.end(template.replace('<!--KD-TOKENS-->', `<style>:root{${Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(';')}}</style>`)
      .replace('<!--KD-PROJECT-->', `<script type="application/json" id="kd-project">${JSON.stringify(project)}</script>`)); return;
  }
  if (/^\/api\/videos\/[^/]+\/renders\/.+\.mp4$/.test(p)) {
    res.setHeader('Content-Type', 'video/mp4'); res.end(fs.readFileSync(path.join(root, 'docs/media/kairos-ad.mp4'))); return;
  }
  if (p.startsWith('/api/')) {
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : {};
      writes.push({ path: p, method: req.method, body });
    }
    if (p === '/api/system/custom-tabs') return json(res, enabled ? [customTab] : []);
    if (p === '/api/tab-studio/looks') return json(res, { default: 'sport', looks: [{ id: 'sport', name: 'Sport' }] });
    if (p === '/api/tab-studio/tokens/sport') return json(res, { variables: tokens, font_css: '' });
    if (p === '/api/videos/ffmpeg') return json(res, { found: false, message: 'Video needs FFmpeg. Windows: `winget install --id Gyan.FFmpeg -e`. Kairos never installs it for you.' });
    if (p === '/api/videos') return json(res, req.method === 'POST' ? Object.assign(project, body) : [project]);
    if (p === `/api/tab-studio/videos/${id}/resources`) return json(res, { assets: [], renders, jobs, thumbnail: null });
    if (p === `/api/videos/${id}`) {
      if (req.method === 'PUT') {
        if (!body.title) return json(res, { detail: [{ loc: ['body', 'title'], msg: 'Title must not be empty.' }] }, 422);
        if (body.beats[0].text === 'invalid fixture') return json(res, { detail: 'beats[0].text: shorten this text.' }, 422);
        Object.assign(project, body, { version: project.version + 1, updated: Date.now() / 1000 });
        history.unshift(structuredClone(project));
      }
      return json(res, project);
    }
    if (p === `/api/videos/${id}/history`) return json(res, history);
    if (p.startsWith(`/api/videos/${id}/restore/`)) {
      const prior = history.find(p => p.version === Number(url.pathname.split('/').pop()));
      Object.assign(project, structuredClone(prior), { version: project.version + 1 }); return json(res, project);
    }
    if (p === `/api/videos/${id}/render`) {
      const job = { id: 'job' + (jobs.length + 1), video_id: id, aspect: body.aspect, status: 'rendering 0/180', polls: 0 };
      jobs.push(job); return json(res, job);
    }
    if (p.startsWith('/api/video-jobs/')) {
      const job = jobs.find(j => j.id === p.split('/')[3]);
      if (p.endsWith('/cancel')) job.status = 'failed: cancelled';
      else if (!job.status.startsWith('failed:')) {
        job.polls++;
        job.status = job.polls === 1 ? 'rendering 90/180' : job.polls === 2 ? 'encoding' : 'ready';
        if (job.status === 'ready') {
          const slug = job.aspect.replace(':', '-'); job.file = `${slug}-v1.mp4`; job.notes = ['The end card stays still.'];
          if (!renders.includes(job.file)) renders.push(job.file, `sheet-${slug}.png`, 'soundtrack.wav');
        }
      }
      return json(res, job);
    }
    if (p === '/api/tab-studio/chat') return json(res, { session_id: 's1' });
    if (p === '/api/chat/live/events') {  // The chat's live stream: an open, quiet event stream.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: [] })}\n\n`);
      return;
    }
    if (p === '/api/system/tabs') return json(res, [{ slug: 'studio', name: 'Studio', blurb: 'Make and edit videos', enabled, kind: 'prebuilt' }]);
    try { return json(res, fixture(url)); } catch (error) { errors.push(error.message); return json(res, { detail: 'Missing fixture: ' + p }, 404); }
  }
  const tabFile = /^\/tab-files\/studio\/(view\.js|view\.css)$/.exec(p);
  const file = tabFile ? path.join(root, 'tabs/studio', tabFile[1]) : path.resolve(root, p === '/' ? 'static/index.html' : '.' + decodeURIComponent(p));
  if (!tabFile && !file.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
}
async function acquireLock() {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let n = 0; n < 120; n++) {
    try { fs.mkdirSync(lock); ownsLock = true; return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await pause(1000);
  }
  throw Error('Another Electron test holds data/electron.lock');
}
function cleanup() {
  if (win && !win.isDestroyed()) win.destroy();
  server?.close();
  if (ownsLock) { fs.rmdirSync(lock); ownsLock = false; }
}
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  try {
    await acquireLock(); fs.mkdirSync(output, { recursive: true });
    server = http.createServer((req, res) => { serve(req, res).catch(error => { errors.push(error.stack); json(res, { detail: error.message }, 500); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const allow = details.url.startsWith(base + '/') || details.url.startsWith('data:') || details.url.startsWith('blob:') || details.url === 'about:blank';
      if (!allow) outside.push(details.url); cb({ cancel: !allow });
    });
    win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async expression => {
      for (let n = 0; n < 300; n++) { if (await js(expression)) return; await pause(50); }
      throw Error('Timed out: ' + expression);
    };
    const click = async text => { await js(`[...document.querySelectorAll('.studio-view button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`); await pause(100); };
    const edit = async (label, value) => js(`(() => { const input=document.querySelector('[aria-label=${JSON.stringify(label)}]'); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const capture = async name => { await pause(150); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const noOverflow = async () => assert.equal(await js("document.documentElement.scrollWidth > innerWidth + 2 || [...document.querySelectorAll('.studio-view')].some(n=>n.scrollWidth>n.clientWidth+2)"), false, 'No sideways scroll');
    const labels = async () => assert.deepEqual(await js(`(() => {
      return [...document.querySelectorAll('.studio-view button,.studio-view input,.studio-view textarea,.studio-view select')].filter(n => {
        if(n.getAttribute('aria-label') || n.textContent.trim() || n.labels?.length) return false;
        return true;
      }).map(n=>n.outerHTML);
    })()`), [], 'Every control has a label');
    await win.loadURL(base + '/#/studio');
    await wait("!!document.querySelector('.studio-grid .studio-project')");
    await js("document.getElementById('onboarding-overlay')?.classList.add('hidden')");
    assert.ok(await js("document.querySelector('.studio-banner').textContent.includes('Kairos never installs')"));
    await wait("!!document.querySelector('.studio-thumbnail')?.width");
    await capture('desktop-projects'); await noOverflow(); await labels();
    win.setContentSize(390, 1000); await pause(350); await noOverflow(); await labels(); await capture('phone-projects');
    win.setContentSize(1440, 1000); await pause(350);
    await js("document.querySelector('.studio-project button').click()");
    await wait("!!document.querySelector('.studio-stage canvas')");
    assert.equal(await js('location.hash'), '#/studio/' + id);
    assert.equal(await js(`(() => { const c=document.querySelector('.studio-stage canvas'), pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return pixels.some((v,i)=>i%4===3 && v>0) && new Set(pixels).size>8; })()`), true, 'Preview draws real content');
    // A title beat shows only the fields it draws (click-through 2026-11-05: every field showed on every beat).
    const shown = label => js(`!document.querySelector('[aria-label=${JSON.stringify(label)}]').closest('[hidden]')`);
    assert.deepEqual([await shown('Text'), await shown('Supporting text'), await shown('Number'), await shown('List items, one per line'), await shown('Video image'), await shown('Upload an image')],
      [true, true, false, false, false, false], 'Title beat fields');
    await js("document.querySelector('[aria-label=\"Beat kind\"]').value='list'; document.querySelector('[aria-label=\"Beat kind\"]').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("!document.querySelector('[aria-label=\"List items, one per line\"]').closest('[hidden]')");
    assert.equal(await shown('Supporting text'), false, 'A list has no supporting text');
    await js("document.querySelector('[aria-label=\"Beat kind\"]').value='title'; document.querySelector('[aria-label=\"Beat kind\"]').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("!!document.querySelector('[aria-label=\"List items, one per line\"]').closest('[hidden]')");
    await edit('Text', 'Changed opening');
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.ok(writes.some(w => w.method === 'PUT' && w.body.beats[0].text === 'Changed opening'));
    await edit('Text', 'invalid fixture');
    await wait("document.querySelector('[data-error-path=\"beats[0].text\"]').textContent.includes('shorten')");
    await edit('Text', 'Valid opening');
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    await edit('Video title', '');
    await wait("document.querySelector('[data-error-path=title]').textContent.includes('must not be empty')");
    await edit('Video title', 'Spring season');
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    await js("document.querySelector('[aria-label=\"Move beat 1 down\"]').click()");
    await wait("document.querySelector('.studio-beat button').textContent.includes('Every kid plays')");
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.equal(project.beats[1].text, 'Valid opening');
    await click('Undo');
    await wait("document.querySelector('.studio-beat button').textContent.includes('Valid opening')");
    await js("document.querySelector('[aria-label=\"Preview aspect\"]').value='9:16'; document.querySelector('[aria-label=\"Preview aspect\"]').dispatchEvent(new Event('change'))");
    await wait("document.querySelector('.studio-stage canvas')?.height===1920");
    await click('Play'); await pause(300); await click('Pause');
    assert.ok(await js("parseFloat(document.querySelector('[aria-label=\"Preview time\"]').value)>0"));
    await capture('desktop-editor'); await noOverflow(); await labels();
    await click('Render 16:9');
    await wait("document.querySelector('.studio-job')?.textContent.includes('rendering')");
    await wait("document.querySelector('.studio-job')?.textContent.includes('encoding')");
    await wait("!!document.querySelector('.studio-download video')");
    assert.equal(await js("document.querySelectorAll('.studio-download a[download]').length"), 3);
    assert.ok(await js("document.querySelector('.studio-job').textContent.includes('end card stays still')"));
    await js("[...document.querySelectorAll('.studio-view summary')].find(n=>n.textContent==='Version history').click()");
    await wait("[...document.querySelectorAll('.studio-view button')].some(n=>n.textContent.startsWith('Restore version'))");
    await js("[...document.querySelectorAll('.studio-view button')].find(n=>n.textContent.startsWith('Restore version')).click()");
    await wait("!!document.querySelector('.confirm-panel')");
    await js("[...document.querySelectorAll('.confirm-panel button')].find(n=>n.textContent==='Cancel').click()");
    assert.equal(writes.filter(w => w.path.includes('/restore/')).length, 0, 'Restore requires confirmation');
    await js(`(async()=>{ const m=await import('/static/js/chatContent.js'); const body=document.createElement('div'); body.id='studio-chat-test'; document.querySelector('.studio-view').prepend(body); m.renderMessageBody(body,'[Video: Spring season](/videos/${id})','s1'); })()`);
    await wait("document.querySelector('.video-card-link button')?.textContent==='Open in Studio'");
    await js("document.querySelector('.video-card-link button').click()");
    await wait("!!document.querySelector('.studio-stage canvas')");
    // Jobs and downloads recover after the view has been torn down and mounted again.
    await wait("!!document.querySelector('.studio-download video')");
    for (const width of [390, 1440]) {
      win.setContentSize(width, 1000); await pause(350); await noOverflow(); await labels();
      await capture(width === 390 ? 'phone-editor' : 'desktop-ready');
      if (width === 390) assert.deepEqual(await js("[...document.querySelectorAll('.studio-view button,.studio-view select,.studio-view input:not([type=checkbox]),.studio-view summary')].filter(n=>n.getBoundingClientRect().height>0 && n.getBoundingClientRect().height<43).map(n=>n.outerHTML)"), [], 'Phone targets are at least 44px');
    }
    // Deep-link a fresh shell load.
    await win.loadURL(base + '/#/studio/' + id); await wait("!!document.querySelector('.studio-stage canvas')");
    enabled = false;
    await js(`(async()=>{const m=await import('/static/js/chatContent.js');const b=document.createElement('div');document.querySelector('.studio-view').prepend(b);m.renderMessageBody(b,'[Video: Spring season](/videos/${id})','s1')})()`);
    await wait("document.querySelector('.video-card-link button')?.textContent==='Turn on Studio'");
    await js("document.querySelector('.video-card-link button').click()");
    await wait("document.querySelector('.tool-store-search')?.value==='Studio'");
    assert.ok(await js("[...document.querySelectorAll('.tool-store-filters button')].some(b=>b.textContent==='Tabs'&&b.getAttribute('aria-pressed')==='true')"));
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    console.log(JSON.stringify({ ok: true, output, writes: writes.length, checks: ['projects', 'FFmpeg banner', 'live canvas', 'edit and PUT', 'inline validation', 'reorder', 'undo', 'aspect', 'playback', 'render progress', 'downloads', 'history confirmation', 'chat card', 'recovery', 'deep link', 'Studio enable handoff', '1440 and 390', 'labels', 'offline'] }));
  } catch (error) {
    console.error(error.stack);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(JSON.stringify({ errors, outside, output })); process.exitCode = 1;
  } finally { cleanup(); exitAfterFlush(process.exitCode || 0); }
}).catch(error => { console.error(error); cleanup(); exitAfterFlush(1); });
