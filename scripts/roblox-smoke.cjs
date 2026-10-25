// Real Roblox renderer and reference composer with an isolated API. No account,
// native Studio mutation or outside network. Run through Electron (not Node).
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'ui-review', 'roblox-' + Date.now());
const writes = [], errors = [], clients = new Set();
const pid = 'a'.repeat(32);
let failValidation = true, upload = 0;
let permissionMode = 'base', failPermission = false, admin = true;
const runs = {};
const addons = [
  {id:'roblox',name:'Roblox Development',description:'Build in native Studio.',skills:['roblox-dev-skill'],installed:true,enabled:true},
  {id:'blender',name:'Blender',description:'Create native assets.',skills:['blender-creation'],installed:true,enabled:true},
  {id:'higgsfield',name:'Higgsfield',description:'Generate visual assets.',skills:['higgsfield-creation'],installed:true,enabled:true},
];
let style = { name: 'default', revision: 1, learning: true, account_id: '123', presets: ['default'], project_overrides: [], history: [], skill: '# Your Roblox style\nWarm colors',
  entries: [{ id: 'style1', category: 'ui', key: 'colors', value: 'warm sunset', status: 'suggested', locked: false, quote: 'I like warm sunset colors.' }] };
let selected = [], healthState = 'connected';
const creative = [{ id: 'blender', name: 'Blender', description: 'Create native 3D assets.', transport: 'managed-creative', connected: true, added: true, port: 9876, file: 'C:/test/game.blend', held_tools: [] },
  { id: 'higgsfield', name: 'Higgsfield', description: 'Generate visual assets.', transport: 'managed-creative', connected: false, added: false, held_tools: [] }];
const project = { id: pid, name: 'Sky Islands', kind: 'experiment', studio_id: null, write_enabled: false,
  brief: 'A floating island obstacle course, warm sunset colors and a clean mobile HUD.', backup: false, updated_at: Date.now() / 1000,
  activity: [{ at: Date.now() / 1000, name: 'Opened in native Studio', ok: true, detail: 'Disposable baseplate' }] };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      ['/static/css/kairos-theme.css', '/static/css/style.css', '/static/css/chat.css', '/static/css/appearance.css', '/tab-files/roblox/view.css'].map(h => `<link rel="stylesheet" href="${h}">`).join('') +
      '<div id="fixture" style="padding:24px"></div><script type="module" src="/__fixture.js"></script>'); return;
  }
  if (url.pathname === '/__fixture.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end("import {render} from '/tab-files/roblox/view.js'; window.cleanup = await render(document.getElementById('fixture')); window.ready=true;"); return;
  }
  const addonFile = url.pathname.match(/^\/api\/addons\/([a-z_]+)\/files\/(static\/[A-Za-z]+\.js)$/);
  if (addonFile) {
    res.setHeader('Content-Type','text/javascript'); res.end(fs.readFileSync(path.join(root,'addon_packages',addonFile[1],addonFile[2]))); return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/api/chat/images/')) {
      res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from(png, 'base64')); return;
    }
    if (url.pathname === '/api/chat/live/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); clients.add(res);
      res.write(`data: ${JSON.stringify({type:'snapshot',runs})}\n\n`); res.on('close', () => clients.delete(res)); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    let fields = {}; if (body && req.headers['content-type']?.includes('application/json')) fields = JSON.parse(body);
    if (req.method !== 'GET') writes.push({ path: url.pathname, fields });
    let value;
    if (url.pathname === '/api/addons') value = addons;
    else if (/^\/api\/addons\/[a-z]+$/.test(url.pathname)) {
      const item = addons.find(a=>a.id===url.pathname.split('/').at(-1));
      item.installed = fields.action !== 'remove'; item.enabled = ['install','enable'].includes(fields.action); value = item;
    }
    else if (url.pathname === '/api/tab-roblox/status') value = { admin: true, account: { connected: false, oauth_configured: false },
      studio: { installed: true, mcp_available: true, instructions: 'In Studio: Assistant > Manage MCP Servers > Enable Studio as MCP server.' } };
    else if (url.pathname === '/api/tab-roblox/oauth/config') value = { configured: false, client_id: '', redirect_uri: '' };
    else if (url.pathname === '/api/tab-roblox/projects') value = [project];
    else if (url.pathname === `/api/tab-roblox/projects/${pid}`) value = project;
    else if (url.pathname.endsWith('/style') && url.pathname.includes('/tab-roblox/')) {
      if (req.method === 'PUT') {
        if (fields.action === 'confirm') style.entries[0].status = 'confirmed';
        if (fields.action === 'lock') style.entries[0].locked = fields.locked;
        if (fields.action === 'forget') style.entries = [];
        if (fields.action === 'add') style.entries.push({id:'style2', category:fields.category,key:fields.key,value:fields.value,status:'confirmed',locked:false});
        style.revision++;
      } value = style;
    }
    else if (url.pathname.endsWith('/connection') && url.pathname.includes('/tab-roblox/')) value = project.studio_id ? {state:healthState, message:healthState==='connected'?'Current Studio Mode: Edit':'Project identity unavailable; reconnect the original window.',write_enabled:project.write_enabled} : {state:'disconnected',message:'Choose your existing Studio window.'};
    else if (url.pathname.endsWith('/open') && url.pathname.includes('/tab-roblox/')) value = {opened:false,studio_id:'window-one',message:'Found existing project; no new window opened.'};
    else if (url.pathname.endsWith('/assets') && url.pathname.includes('/tab-roblox/')) value = [{ id:'asset1',name:'Island tree',source:'blender',import_status:'exported',local_file:'tree.glb' }];
    else if (url.pathname === '/api/creative') value = creative;
    else if (url.pathname === '/api/creative/selection') {
      if (req.method === 'PUT') selected = fields.providers;
      value = { connections: creative, selected };
    }
    else if (url.pathname === '/api/creative/jobs') value = [];
    else if (url.pathname === '/api/creative/blender/check') value = creative;
    else if (url.pathname === '/api/auth/status') value = {is_admin:admin};
    else if (['/api/skills', '/api/integrations', '/api/integrations/catalog', '/api/system/tabs'].includes(url.pathname)) value = [];
    else if (url.pathname === '/api/store/catalog') value = {items:[]};
    else if (url.pathname === '/api/store/github/status') value = {configured:false,signed_in:false};
    else if (url.pathname.endsWith('/session') && url.pathname.includes('/tab-roblox/')) value = { session_id: 'roblox-session' };
    else if (url.pathname.endsWith('/files') && url.pathname.includes('/tab-roblox/')) value = [];
    else if (url.pathname === '/api/tab-roblox/studios') value = [{ studio_id: 'window-one', name: 'Place1', place_id: '0' }];
    else if (url.pathname.endsWith('/studio')) { Object.assign(project, { studio_id: fields.studio_id, write_enabled: fields.allow_edits }); value = project; }
    else if (url.pathname.endsWith('/brief')) { project.brief = fields.text; value = project; }
    else if (url.pathname === '/api/sessions/roblox-session') value = { id: 'roblox-session', title: 'Roblox: Sky Islands', model_endpoint_id: 'model1', permission_mode:permissionMode, messages: [] };
    else if (url.pathname === '/api/sessions/roblox-session/permission-mode') {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (failPermission) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: 'Reply is still running.' })); return; }
      permissionMode = fields.mode; value = {mode:permissionMode};
    }
    else if (url.pathname === '/api/models/choices') value = [{ id: 'model1', name: 'Vision model', kind: 'api' }];
    else if (url.pathname === '/api/models/model1/catalog') value = [{ id: 'vision-1', display_name: 'Vision 1' }];
    else if (url.pathname === '/api/chat/attachments') value = { id: `ref-${++upload}`, name: body.includes('hud.png') ? 'hud.png' : 'model-reference.txt', size: 68 };
    else if (url.pathname === '/api/chat/validate-attachments') {
      if (failValidation) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: 'Choose a vision-capable model.' })); return; }
      value = { valid: true };
    }
    else if (url.pathname === '/api/chat/live/snapshot') value = { type: 'snapshot', runs };
    else if (url.pathname === '/api/chat/live') {
      runs['roblox-session'] = { turnId:'fixture-turn', status:'processing', revision:1, prompt:fields.message, text:'', startedAt:Date.now()/1000 };
      value = { turn_id: 'fixture-turn' };
    }
    else if (url.pathname === '/api/chat/live/stop') value = { stopping: true };
    else if (url.pathname === '/api/chat/references') value = [];
    else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: `Missing fixture ${url.pathname}` })); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return;
  }
  const tab = url.pathname.match(/^\/tab-files\/roblox\/(view\.(js|css))$/);
  const file = tab ? path.join(root, 'addon_packages', 'roblox', 'tabs', 'roblox', tab[1]) : path.resolve(root, '.' + url.pathname);
  if (!tab && !file.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
app.setPath('userData', path.join(root, 'data', 'roblox-smoke-profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(base + '/') }));
  const win = new BrowserWindow({ width: 1440, height: 1080, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', d => { if (d.level === 'error' && !d.message.includes('Content Security Policy')) errors.push(d.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async code => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await delay(50); } throw new Error('Timed out: ' + code); };
  const click = async text => { await js(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`); await delay(100); };
  const capture = async name => { await delay(150); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadURL(base); await wait('window.ready');
    await capture('desktop-projects');
    await js("document.querySelector('.roblox-project').click()");
    await wait("!!document.querySelector('.session-chat-models')");
    await click('Refresh Studio windows');
    await js("[...document.querySelectorAll('.custom-select-btn')].find(n=>n.textContent.includes('Choose a Studio window')).click()");
    await wait("!!document.querySelector('[role=option]')");
    await js("[...document.querySelectorAll('[role=option]')].find(n=>n.textContent.includes('Place1')).click()");
    await js("document.querySelector('.roblox-edit-choice input').checked=true");
    await click('Connect selected window');
    await wait("document.querySelector('.roblox-connection-bar').textContent.includes('AI edits enabled')");
    assert.equal(writes.find(w => w.path.endsWith('/studio')).fields.studio_id, 'window-one');
    await js("{const tab=document.querySelector('.roblox-inspector-tabs [role=tab]');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}");
    assert.equal(await js("document.querySelector('.roblox-inspector-tabs [aria-selected=true]').textContent"),'Brief');
    await click('Connection');
    await click('Style');
    await wait("document.body.textContent.includes('Your growing style skill') && document.body.textContent.includes('Accept suggestion')");
    await js("[...document.querySelectorAll('details')].find(n=>n.textContent.includes('colors')&&n.textContent.includes('Accept suggestion')).open=true");
    await click('Accept suggestion');
    await wait("document.body.textContent.includes('colors') && document.body.textContent.includes('confirmed')");
    await js("[...document.querySelectorAll('details')].find(n=>n.textContent.includes('colors') && n.textContent.includes('confirmed')).open=true");
    await click('Lock');
    await wait("document.body.textContent.includes('confirmed') && document.body.textContent.includes('locked')");
    await click('Connection');
    await js("document.querySelector('.side-chat-input').value='Keep this draft while reconnecting'");
    await click('Connect selected window');
    assert.equal(await js("document.querySelector('.side-chat-input').value"), 'Keep this draft while reconnecting');
    healthState = 'needs_attention'; await click('Check connection');
    await wait("document.querySelector('.roblox-state').textContent==='Connection needs attention'");
    assert.equal(await js("document.querySelector('.roblox-connection-bar .roblox-badge').textContent"), 'AI access paused');
    healthState = 'connected'; await click('Check connection');
    await capture('desktop-project-inspector');
    await click('Creative tools');
    await wait("!!document.querySelector('.panel-dialog input[type=checkbox]')");
    await js("document.querySelector('.panel-dialog input[type=checkbox]').checked=true");
    await click('Save creative tools');
    assert.deepEqual(selected, ['blender']);
    assert.equal(await js("document.querySelectorAll('.panel-dialog').length"), 0);

    await js(`{
      const bytes=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([bytes],'hud.png',{type:'image/png'}));
      document.querySelector('.side-chat-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
    }`);
    await wait("document.querySelectorAll('.session-attachments .session-attachment').length===1");
    await js(`{
      const transfer=new DataTransfer();transfer.items.add(new File(['Low-poly model reference'],'model-reference.txt',{type:'text/plain'}));
      document.querySelector('.roblox-chat').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
    }`);
    await wait("document.querySelectorAll('.session-attachments .session-attachment').length===2");
    await js("[...document.querySelectorAll('.session-attachments button')].find(n=>n.getAttribute('aria-label')==='Remove model-reference.txt').click()");
    await wait("document.querySelectorAll('.session-attachments .session-attachment').length===1");
    await js("document.querySelector('.side-chat-input').value='Match this HUD reference and build a checkpoint counter.'");
    const chooseMode = async mode => {
      await js("document.querySelector('.session-chat-permissions button').click()");
      await wait("!!document.querySelector('[role=option]')");
      await js(`[...document.querySelectorAll('[role=option]')].find(n=>n.textContent===${JSON.stringify(mode)}).click()`);
    };
    assert.equal(await js("document.querySelector('.session-chat-permissions .custom-select').value"), 'base');
    await chooseMode('Auto');
    assert.equal(await js("document.querySelector('.side-chat-send').disabled"), true, 'Cannot send while mode is saving');
    await wait("document.querySelector('.session-chat-permissions').dataset.mode==='auto'");
    assert.equal(permissionMode, 'auto');
    assert.equal(await js("document.querySelector('.chat-permission-notice').hidden"), false);
    failPermission = true;
    await chooseMode('Base');
    await wait("!document.querySelector('.session-chat-permissions button').disabled");
    assert.equal(await js("document.querySelector('.session-chat-permissions .custom-select').value"), 'auto', 'Failed save restores actual saved mode');
    failPermission = false;
    await click('Connect selected window');
    assert.equal(await js("document.querySelectorAll('.session-attachments .session-attachment').length"), 1, 'Reconnect preserves staged references');
    assert.equal(await js("document.querySelector('.side-chat-input').value"), 'Match this HUD reference and build a checkpoint counter.');
    await click('Send');
    assert.equal(writes.filter(w => w.path === '/api/chat/live').length, 0);
    assert.equal(await js("document.querySelector('.side-chat-input').value"), 'Match this HUD reference and build a checkpoint counter.');
    assert.equal(await js("document.querySelectorAll('.session-attachments .session-attachment').length"), 1);
    await capture('desktop-references');
    failValidation = false;
    await click('Send');
    await wait("document.querySelector('.side-chat-send').textContent==='Stop'");
    assert.equal(await js("document.querySelector('.session-chat-permissions button').disabled"), true, 'Cannot change permissions during a reply');
    assert.deepEqual(writes.find(w => w.path === '/api/chat/live').fields.attachment_ids, ['ref-1']);
    assert.equal(await js("document.querySelectorAll('.session-attachments .session-attachment').length"), 0);
    await capture('desktop-working');
    await click('Stop');
    assert.equal(writes.filter(w => w.path === '/api/chat/live/stop').length, 1);
    win.setContentSize(390, 844); await delay(200);
    await js("document.getElementById('toast-host')?.replaceChildren()");
    await js('window.scrollTo(0,0)'); await capture('phone-workspace');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth+2'), false, 'Phone has horizontal overflow');
    delete runs['roblox-session'];
    await win.loadURL(base); await wait('window.ready');
    await js("document.querySelector('.roblox-project').click()");
    await wait("!!document.querySelector('.session-chat-permissions')");
    assert.equal(await js("document.querySelector('.session-chat-permissions .custom-select').value"), 'auto', 'Saved mode survives reopening the project');
    permissionMode = 'base'; admin = false;
    await win.loadURL(base); await wait('window.ready');
    await js("document.querySelector('.roblox-project').click()");
    await wait("!!document.querySelector('.session-chat-permissions')");
    await js("document.querySelector('.session-chat-permissions button').click()");
    assert.equal(await js("[...document.querySelectorAll('[role=option]')].find(n=>n.textContent==='Auto').disabled"), true, 'Auto unavailable to non-admins');
    await js("document.body.click()");
    await js('window.cleanup()');
    admin = true;
    win.setContentSize(1440,1080);
    await js("import('/static/js/views/tool-store.js').then(m=>m.render(document.getElementById('fixture')))");
    await wait("!![...document.querySelectorAll('.tool-store-card .ts-desktop-name')].find(n=>n.textContent==='Blender')");
    assert.equal(await js("!![...document.querySelectorAll('.tool-store-card .ts-desktop-name')].find(n=>n.textContent==='Higgsfield')"), true);
    await click('Tools');
    assert.equal(await js("document.querySelectorAll('[data-addon]').length"), 3, 'All optional packages belong to Tools');
    assert.equal(await js("[...document.querySelectorAll('.tool-store-heading')].some(n=>n.textContent==='Optional add-ons')"), false);
    await click('Skills');
    assert.equal(await js("document.querySelectorAll('[data-addon]').length"), 0, 'Package cards are not duplicated in Skills');
    await click('Tools');
    await click('Manage connection');
    await wait("document.querySelector('.panel-dialog')?.textContent.includes('Download Kairos Blender add-on')");
    await click('Check connection and tools');
    await wait("!!document.querySelector('.panel-dialog input[aria-label=\"Blender pairing token\"]')");
    await capture('creative-blender');
    assert.equal(await js("document.querySelector('.panel-dialog input[type=password]').value"), '');
    await js("document.querySelector('.panel-dialog [aria-label=Close]').click()");
    const addonAction = async (ident, text) => {
      await js(`[...document.querySelectorAll('[data-addon="${ident}"] button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
      await delay(150);
    };
    await addonAction('higgsfield', 'Disable');
    await wait("document.querySelector('[data-addon=higgsfield]').textContent.includes('Disabled add-on')");
    assert.equal(addons.find(a=>a.id==='blender').enabled, true, 'Disabling Higgsfield preserves Blender');
    await addonAction('higgsfield', 'Remove add-on');
    await wait("document.querySelector('[data-addon=higgsfield]').textContent.includes('Install add-on')");
    await addonAction('higgsfield', 'Install add-on');
    await wait("document.querySelector('[data-addon=higgsfield]').textContent.includes('Enabled add-on')");
    await addonAction('blender', 'Disable');
    await addonAction('blender', 'Enable');
    await wait("document.querySelector('[data-addon=blender]').textContent.includes('Enabled add-on')");
    await js("document.getElementById('toast-host')?.replaceChildren()");
    await capture('optional-addons-desktop');
    win.setContentSize(390,844); await capture('optional-addons-phone');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth+2'), false, 'Optional add-on cards fit phone width');
    assert.equal(await js("[...document.querySelectorAll('[data-addon] button')].every(b=>{const r=b.getBoundingClientRect(),card=b.closest('article').getBoundingClientRect();return r.left>=card.left&&r.right<=card.right;})"), true, 'All add-on actions remain inside their cards on phone');

    assert.deepEqual(errors, []);
    console.log('PASS Roblox desktop/phone, Base/Auto persistence/rollback/admin/busy guards, private styles, references, Stop, creative selection, and optional add-on install/disable/remove/enable with provider isolation. Captures: ' + output);
    win.destroy(); for (const client of clients) client.end(); server.close(); exitAfterFlush(0);
  } catch (problem) {
    console.error(problem.stack); console.error('Browser errors:', errors); await capture('failure');
    win.destroy(); for (const client of clients) client.end(); server.close(); exitAfterFlush(1);
  }
});
