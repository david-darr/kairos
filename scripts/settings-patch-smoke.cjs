// Isolated Settings renderer; fixture data only, no backend or user profile.
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'data', 'settings-patch-profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const { fixture } = require('../demo/fixtures.js')({ now: Date.now() / 1000, state: {} });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const data = fixture(url);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data ?? {})); return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/css/kairos-theme.css"><link rel="stylesheet" href="/static/css/style.css"><link rel="stylesheet" href="/static/css/settings.css"><body>'); return;
  }
  const file = path.resolve(root, '.' + url.pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const mime = { '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
});
let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(base + '/') }));
  win = new BrowserWindow({ width:1440, height:900, show:false, webPreferences:{ offscreen:true, contextIsolation:true, nodeIntegration:false } });
  win.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message); });
  await win.loadURL(base);
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async condition => { for (let i=0; i<80; i++) { if (await js(condition)) return; await delay(50); } throw new Error('Timed out: '+condition); };
  const capture = async name => {
    const output = path.join(root, 'data', 'settings-patch-review'); fs.mkdirSync(output, { recursive:true });
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  await require('./settings-patch-checks.cjs')({ js, win, waitFor, delay, capture });
}).then(() => exitAfterFlush(0), error => { console.error(error); exitAfterFlush(1); }).finally(() => { win?.destroy(); server.close(); });
