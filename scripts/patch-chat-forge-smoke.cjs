// Isolated fixture server; run with the shared Electron binary. No live data.
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'patch-chat-forge-review', 'run-' + Date.now());
const demoState = { empty: false };
const { fixture, mutate, media } = require('../demo/fixtures.js')({ now: Date.now() / 1000, state: demoState });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' https:; img-src 'self' data: blob:");
  if (url.pathname.startsWith('/api/')) {
    const file = req.method === 'GET' && media(url);
    if (file) { res.setHeader('Content-Type', file.type); res.end(file.base64 ? Buffer.from(file.base64, 'base64') : file.body); return; }
    let result;
    if (req.method === 'GET') result = fixture(url);
    else { let body = ''; for await (const chunk of req) body += chunk; result = mutate(url.pathname, req.method, body ? JSON.parse(body) : {}, Object.fromEntries(url.searchParams)); }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
  }
  const file = path.resolve(root, url.pathname === '/' ? 'static/index.html' : '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('Content-Type', {'.js':'text/javascript', '.mjs':'text/javascript', '.wasm':'application/wasm', '.css':'text/css', '.html':'text/html', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff2':'font/woff2'}[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(root, 'data', 'patch-chat-forge-profile'));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(base + '/') && !details.url.startsWith('data:') && !details.url.startsWith('about:') }));
  const win = new BrowserWindow({width:1440, height:900, useContentSize:true, show:false, webPreferences:{offscreen:true, nodeIntegration:false, contextIsolation:true}});
  win.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message); });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { throw new Error(error.message + '\nRenderer expression: ' + code); } };
  const waitFor = async condition => { for (let i=0; i<100; i++) { if (await js(condition)) return; await delay(50); } throw new Error('Timed out: ' + condition); };
  const capture = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const navigate = async (tab, options = {}) => { await js(`import('/static/js/app.js').then(m => m.switchTab(${JSON.stringify(tab)}, ${JSON.stringify(options)}))`); await waitFor("!document.documentElement.classList.contains('tab-transition')"); };
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('#forge-mode-switch')");
    win.webContents.debugger.attach('1.3');
    await require('./patch-chat-forge-checks.cjs')({js, win, waitFor, capture, delay, navigate});
    if (process.argv.includes('--artifacts')) await require('./artifact-pane-checks.cjs')({js, win, waitFor, capture, delay, navigate, base});
    console.log('PASS ' + output);
  } catch (error) { await capture('failure'); console.error(error); process.exitCode = 1; }
  finally { win.destroy(); server.close(); exitAfterFlush(process.exitCode); }
});
