// Electron half of scripts/test_mascot.cjs (run that, not this). Serves the
// repo's static files and a review page written to data/mascot-review/ (not
// shipped), renders Ajar and Kip in every state, size and four appearances,
// asserts what only a browser can show, and writes the captures there.
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data', 'mascot-review');
const THEMES = [['light', null], ['dark', '#533c32'], ['forest', '#23302e'], ['graphite', '#202127']];
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mascot review</title>
<link rel="stylesheet" href="/static/css/kairos-theme.css"><link rel="stylesheet" href="/static/css/style.css"><link rel="stylesheet" href="/static/css/appearance.css"><link rel="stylesheet" href="/static/css/mascot.css">
<style>body>:not(canvas){position:relative;z-index:1} body{margin:0;padding:20px;background:var(--bg);color:var(--text);font:13px var(--font-sans)} h2{font:italic 500 26px var(--font-display);margin:0 0 10px}
table{border-collapse:collapse} td,th{padding:6px 10px;text-align:center;vertical-align:middle;border-bottom:1px solid var(--hairline-soft)} th{font-weight:500;color:var(--text-dim)}
.panel{background:var(--bg-panel-solid);border:1px solid var(--hairline-soft);border-radius:16px;padding:12px;display:inline-block;margin:0 12px 12px 0;vertical-align:top}
.kip{image-rendering:pixelated;width:48px;height:48px}.row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}.row figure{margin:0;text-align:center}</style></head>
<body><h2 id="title">Ajar</h2><div class="panel"><table id="grid"></table></div><div class="panel"><div class="row" id="bots"></div></div><div class="panel"><div class="row" id="kips"></div></div>
<script type="module">
import * as M from '/static/js/mascot.js';
import { initAppearance, updateAppearance } from '/static/js/appearance.js';
window.M = M;
const q = new URLSearchParams(location.search);
await initAppearance('mascot-review');
updateAppearance(q.get('color') ? { mode: 'color', color: q.get('color'), halftone: false } : { mode: 'default', halftone: false });
document.getElementById('title').textContent = 'Kip · ' + (q.get('name') || 'light');
const grid = document.getElementById('grid');
const head = document.createElement('tr'); head.innerHTML = '<th>State</th><th>16</th><th>28</th><th>72</th><th>176</th><th>Static 72</th><th>Halftone style 96</th>'; grid.append(head);
for (const state of M.MASCOT_STATES) {
  const tr = document.createElement('tr'); const th = document.createElement('th'); th.textContent = M.STATE_WORDS[state]; tr.append(th);
  for (const size of [16, 28, 72, 176]) { const td = document.createElement('td'); td.append(M.createMascot({ state, size, decorative: false })); tr.append(td); }
  const td = document.createElement('td'); const img = document.createElement('img'); img.width = img.height = 72; img.alt = ''; img.src = M.mascotUrl(M.KAIROS_SPEC, state); td.append(img); tr.append(td);
  const tone = document.createElement('td'); tone.append(M.createMascot({ state, size: 96, finish: 'halftone' })); tr.append(tone);
  grid.append(tr);
}
const PRESETS = [['Scout', '#B9D2E3', 'spectacles', 'round'], ['Quill', '#E8C39E', 'quill', 'tall'], ['Atlas', '#B5C7A5', 'laurel', 'squircle'], ['Sol', '#D9B260', 'rays', 'round'], ['Rosa', '#D99A92', 'scarf', 'tall'], ['Iris', '#CDBFD9', 'none', 'squircle']];
for (const [name, color, acc, shape] of PRESETS) {
  const spec = { version: 3, character: 'ajar', shape, color, acc, finish: 'flat' };
  const fig = document.createElement('figure'); fig.append(M.createMascot({ spec, size: 72, label: name, decorative: false, state: name === 'Scout' ? 'needs' : 'idle' }));
  const cap = document.createElement('figcaption'); cap.textContent = name; fig.append(cap); document.getElementById('bots').append(fig);
}
for (const state of ['idle', 'thinking', 'needs', 'success', 'error', 'sleeping', 'walk']) for (const [name, color, acc, shape] of PRESETS.slice(0, 2)) {
  const fig = document.createElement('figure'); const img = document.createElement('img'); img.className = 'kip'; img.alt = '';
  img.src = M.kipUrl({ version: 3, character: 'ajar', shape, color, acc, finish: 'flat' }, state); fig.append(img);
  const cap = document.createElement('figcaption'); cap.textContent = state; fig.append(cap); document.getElementById('kips').append(fig);
}
window.ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/review.html') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(out, 'profile'));
const delay = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'review.html'), page);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb(d.url.startsWith(base) || d.url.startsWith('data:') ? {} : { cancel: true }));
  const win = new BrowserWindow({ width: 1180, height: 2250, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async c => { for (let i = 0; i < 100; i++) { if (await js(c)) return; await delay(50); } throw new Error('Timed out: ' + c); };
  const results = [];
  const check = async (name, fn) => { await fn(); results.push(name); };
  try {
    win.webContents.debugger.attach('1.3');
    for (const [name, color] of THEMES) {
      await win.loadURL(`${base}/review.html?name=${name}${color ? '&color=' + encodeURIComponent(color) : ''}`);
      await waitFor('window.ready === true && [...document.images].every(i => i.complete && i.naturalWidth > 0)');
      await delay(400);
      const picture = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `ajar-${name}.png`), picture.toPNG());
    }
    await check('every state renders at every size', async () => {
      const missing = await js(`window.M.MASCOT_STATES.flatMap(s => [16, 28, 72, 176].map(size => {
        const node = [...document.querySelectorAll('kairos-mascot')].find(n => n.getAttribute('state') === s && n.getAttribute('size') === String(size));
        const box = node?.querySelector('svg.ajar')?.getBoundingClientRect();
        return node && node.querySelector('svg').dataset.state === s && Math.round(box.width) === size ? null : s + '@' + size; })).filter(Boolean)`);
      assert.deepEqual(missing, []);
    });
    await check('static images load for every state', async () => {
      assert.equal(await js("[...document.querySelectorAll('#grid img')].filter(i => i.naturalWidth > 0).length"), 8);
    });
    await check('the label is the name and the state, as text', async () => {
      assert.equal(await js("document.querySelector('#bots kairos-mascot').getAttribute('aria-label')"), 'Scout, needs you');
      assert.equal(await js("document.querySelector('#bots kairos-mascot').getAttribute('role')"), 'img');
      assert.equal(await js("(() => { const n = window.M.createMascot({ label: '<b>x</b>', decorative: false }); document.body.append(n); const ok = n.getAttribute('aria-label') === '<b>x</b>, idle' && !n.querySelector('b'); n.remove(); return ok; })()"), true);
      assert.equal(await js("document.querySelector('#grid td:last-child kairos-mascot').getAttribute('aria-hidden')"), 'true', 'decorative mascots are hidden from assistive tech');
    });
    await check('no SVG filters, no canvas per instance', async () => {
      assert.equal(await js("document.querySelectorAll('kairos-mascot filter, kairos-mascot canvas').length"), 0);
      assert.equal(await js("[...document.images].some(i => decodeURIComponent(i.src).includes('<filter'))"), false);
    });
    await check('motion runs, and reduced motion leaves none', async () => {
      assert.ok(await js("document.getAnimations().filter(a => a.effect?.target?.closest?.('kairos-mascot')).length > 0"), 'animations run when motion is allowed');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await delay(500);
      assert.equal(await js("document.getAnimations().filter(a => a.effect?.target?.closest?.('kairos-mascot') && a.playState === 'running').length"), 0);
      const picture = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, 'ajar-reduced-motion.png'), picture.toPNG());
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    });
    await check('every state is a distinct still pose', async () => {
      const poses = await js(`window.M.MASCOT_STATES.map(s => decodeURIComponent(window.M.mascotUrl(window.M.KAIROS_SPEC, s)))`);
      assert.equal(new Set(poses).size, 8);
    });
    await check('success plays once, then settles to idle', async () => {
      await js("window.settled = 0; window.mx = window.M.createMascot({ state: 'success' }); window.mx.addEventListener('mascot-settled', () => window.settled++); document.body.append(window.mx)");
      await waitFor("window.mx.getAttribute('state') === 'idle'");
      assert.equal(await js('window.settled'), 1);
    });
    await check('off-screen mascots pause', async () => {
      await js("window.far = window.M.createMascot({ state: 'thinking' }); window.far.style.cssText = 'position:absolute;top:9000px'; document.body.append(window.far)");
      await waitFor("window.far.hasAttribute('data-offscreen')");
      assert.ok(await js("window.far.getAnimations({ subtree: true }).every(a => a.playState === 'paused')"));
    });
    await check('a voice level drives the speaking pose', async () => {
      await js("window.sp = window.M.createMascot({ state: 'speaking', size: 120 }); document.body.append(window.sp)");
      const quiet = await js("window.sp.querySelector('.aj-eye').getBoundingClientRect().height");
      await js("window.sp.style.setProperty('--level', '1')"); await delay(300);
      const loud = await js("window.sp.querySelector('.aj-eye').getBoundingClientRect().height");
      assert.ok(loud < quiet * .8, `eyes squash with the level (${quiet} -> ${loud})`);
    });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, results }, null, 2));
    console.log('PASS render: ' + results.join('; '));
    console.log('Captures: ' + out);
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    console.error('Passed before failing: ' + results.join('; '));
    app.exit(1);
  }
});
