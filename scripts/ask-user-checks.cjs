// Real Chromium and a synthetic live feed on a fresh loopback port.
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/review/ask-user');
const questionText = '<img src=x onerror="window.__pwned=1"><b>Bold?</b> Pick one';
const optionText = '<script>window.__pwned=2</script>Yes';
const request = { id: 'question-check', kind: 'question', tool: 'AskUserQuestion', title: 'Waiting for your response', choices: [], arguments: {}, expires_at: Date.now() / 1000 + 1800,
  questions: [{ question: questionText, header: 'Layout', multiSelect: false, options: [{ label: optionText, description: 'Literal text' }, { label: 'No' }] },
    { question: 'Which widgets should be on it?', header: 'Widgets', multiSelect: true, options: [{ label: 'Calendar' }, { label: 'Tasks' }, { label: 'Weather' }] }] };
const startedAt = Date.now() / 1000;
const chat = { id: 's1', title: 'Question check', model_endpoint_id: 'claude', messages: [{ role: 'user', content: 'Please ask me.', ts: startedAt }] };
let run = { turnId: 't1', sessionTitle: chat.title, prompt: 'Please ask me.', text: '', startedAt, status: 'processing', stopping: false, permission: request, revision: 1, toolSteps: [], toolEvents: [] };
const clients = new Set(), posts = [];
let liveConnections = 0;
const snapshot = () => ({ type: 'snapshot', runs: run ? { s1: run } : {} });
const broadcast = packet => { for (const client of clients) client.write(`data: ${JSON.stringify(packet)}\n\n`); };
function change(permission) {
  run.permission = permission; run.revision++;
  broadcast({ type: 'update', sessionId: 's1', turnId: run.turnId, revision: run.revision, changes: { permission } });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      ['kairos-theme','style','chat','question-prompt','interface','redesign','redesign-motion','redesign-mobile','redesign-tabbar'].map(name => `<link rel="stylesheet" href="/static/css/${name}.css">`).join('') +
      '</head><body><div id="view-content" class="view active" style="height:100dvh"></div></body></html>'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/chat/live/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      liveConnections++; clients.add(res); res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      res.on('close', () => clients.delete(res)); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : {};
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname.endsWith('/respond')) { posts.push({ path: url.pathname, data }); return json({ status: data.skip ? 'skipped' : 'answered' }); }
    if (url.pathname === '/api/chat/live/snapshot') return json(snapshot());
    if (url.pathname === '/api/auth/status') return json({ auth_enabled: false, setup_required: false, username: 'Alex', is_admin: true });
    if (url.pathname === '/api/sessions') return json([chat]);
    if (url.pathname === '/api/sessions/s1') return json(chat);
    if (url.pathname.endsWith('/context')) return json({ available: false });
    if (url.pathname === '/api/models' || url.pathname === '/api/models/choices') return json([{id:'claude',name:'Claude Code',kind:'claude_cli',supports_images:true}]);
    if (url.pathname === '/api/models/catalog') return json({ claude_cli: [] });
    if (url.pathname.includes('catalog')) return json([]);
    if (url.pathname === '/api/speech/status') return json({engine_available:false,models:[]});
    return json([]);
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Interrupted runs must not hold the next run's Chromium profile lock.
app.setPath('userData', path.join(output, 'profile-' + process.pid));
app.whenReady().then(async () => {
  fs.mkdirSync(output, {recursive:true});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({cancel: !details.url.startsWith(base + '/') && !details.url.startsWith('about:') && !details.url.startsWith('data:')}));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize:true, show:false, webPreferences:{offscreen:true, contextIsolation:true, nodeIntegration:false} });
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async code => { for (let i=0;i<125;i++) { if (await js(code)) return; await delay(40); } throw Error('Timed out: ' + code); };
  const mount = async (phone, expectQuestion = true) => {
    const connectionsBefore = liveConnections;
    await win.loadURL(base);
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await js(`document.documentElement.dataset.appMode = 'kairos'; document.documentElement.classList.toggle('kairos-redesign', ${!!phone}); document.body.classList.toggle('kairos-redesign', ${!!phone});
      // The normal app connects the shared feed before mounting views.
      import('/static/js/chatStream.js').then(async stream => {
        await stream.connect();
        const m = await import('/static/js/views/chat.js');
        window.cleanup = await m.render(document.querySelector('#view-content'), 'chat', {sessionId:'s1'});
      })`);
    for (let i=0;liveConnections===connectionsBefore;i++) { if (i===125) throw Error('Live feed did not connect'); await delay(40); }
    await waitFor('document.querySelector("#chat-messages")?.dataset.sessionId === "s1" && !!window.cleanup');
    if (expectQuestion) {
      assert.equal(await js(`import('/static/js/chatStream.js').then(m => m.getInFlight('s1')?.permission?.id)`), request.id, 'Snapshot loaded before chat opens');
      await waitFor('!!document.querySelector(".chat-question-host .question-card")');
    }
  };
  const settleAnimations = async () => {
    let timeout;
    try {
      await Promise.race([
        js("Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))"),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Finite UI animations did not settle within 5 seconds')), 5000); }),
      ]);
    } finally { clearTimeout(timeout); }
  };
  const capture = async name => { await settleAnimations(); await delay(300); const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); console.log(file); };
  try {
    await mount(false);
    const card = await js(`(() => { const c=document.querySelector('.question-card'), d=c.closest('.chat-composer-dock'); return { dock:!!d, before:!!(c.compareDocumentPosition(d.querySelector('.chat-input-bar')) & Node.DOCUMENT_POSITION_FOLLOWING), visible:c.getBoundingClientRect().height>0, title:c.querySelector('h2').textContent, text:c.textContent, tags:c.querySelectorAll('img,script,b').length, pwned:window.__pwned, disabled:c.querySelector('.primary').disabled }; })()`);
    assert.equal(card.dock,true); assert.equal(card.before,true); assert.equal(card.visible,true);
    assert.equal(card.title,'Waiting for your response'); assert.equal(card.tags,0); assert.equal(card.pwned,undefined); assert.equal(card.disabled,true);
    assert.ok(card.text.includes('<img')); assert.ok(card.text.includes('<script>'));
    await capture('desktop');
    await js(`document.querySelector('.question-item input[type=radio]').click(); const t=document.querySelectorAll('.question-item')[1].querySelector('input[type=text]'); t.value='Custom widget'; t.dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.equal(await js('document.querySelector(".question-card .primary").disabled'),false);
    await js('document.querySelector(".question-card .primary").click()');
    await waitFor('!document.querySelector(".question-card")');
    assert.deepEqual(posts.shift(),{path:'/api/permissions/question-check/respond',data:{answers:{[questionText]:optionText,'Which widgets should be on it?':['Custom widget']}}});
    // The snapshot is deliberately still pending, as if reloading before the feed update.
    await mount(false);
    await js('document.querySelector(".question-actions button").click()');
    await waitFor('!document.querySelector(".question-card")');
    assert.deepEqual(posts.shift(),{path:'/api/permissions/question-check/respond',data:{skip:true}});
    await mount(false);
    change(null); await waitFor('!document.querySelector(".question-card")');
    change(request); win.setContentSize(390,844); await mount(true);
    await waitFor('!!document.querySelector(".chat-question-host dialog[open].ms-sheet-surface")');
    await settleAnimations();
    assert.equal(await js(`document.querySelector('.chat-activity').open`), false, 'Transport details start collapsed');
    assert.equal(await js(`getComputedStyle(document.querySelector('.chat-activity-steps')).animationName`), 'none', 'Collapsed transport details have no pending entrance');
    await js(`document.querySelector('.chat-activity').open = true`);
    assert.equal(await js(`getComputedStyle(document.querySelector('.chat-activity-steps')).animationName`), 'activity-reveal', 'Opening transport details preserves their entrance');
    await settleAnimations();
    await js(`document.querySelector('.chat-activity').open = false`);
    await settleAnimations();
    const phone = await js(`(() => { const c=document.querySelector('.question-card'), s=c.closest('dialog'), r=c.getBoundingClientRect(), sr=s.getBoundingClientRect(); return {left:r.left,right:r.right,sheetLeft:sr.left,sheetRight:sr.right,sheetBottom:sr.bottom,sheetWidth:sr.width,viewportWidth:innerWidth,height:r.height,viewport:innerHeight,buttons:[...c.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom}})}; })()`);
    // Phase 3 presents phone questions as full-width sheets. Their cards keep
    // the chat host and height cap, but no longer match the inset composer's width.
    assert.ok(Math.abs(phone.sheetWidth-phone.viewportWidth)<1);
    assert.ok(Math.abs(phone.sheetBottom-phone.viewport)<1);
    assert.ok(phone.left>=phone.sheetLeft && phone.right<=phone.sheetRight);
    assert.ok(phone.height<=phone.viewport*.65+1);
    for (const button of phone.buttons) { assert.ok(button.height>=44); assert.ok(button.top>=0); assert.ok(button.bottom<=phone.viewport); }
    await capture('phone');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await js('getComputedStyle(document.querySelector(".question-pulse")).animationName'),'none');

    // An already-open chat must attach remote turns without a reload.
    // Each mount starts idle so a leftover per-turn listener cannot hide the bug.
    for (const permission of [request, null]) {
      run = null;
      await mount(false, false);
      assert.equal(await js('!!document.querySelector("[data-live-turn], .question-card")'), false);
      run = { turnId: permission ? 'remote-question' : 'remote-reply', sessionTitle: chat.title,
        prompt: 'Started on another device', text: '', startedAt: Date.now()/1000,
        status: 'processing', stopping: false, permission, revision: 1, toolSteps: [], toolEvents: [] };
      broadcast({ type: 'started', sessionId: 's1', run });
      await waitFor(`import('/static/js/chatStream.js').then(m => m.getInFlight('s1')?.turnId === ${JSON.stringify(run.turnId)})`);
      if (permission) {
        await waitFor('!!document.querySelector(".chat-question-host .question-card")');
        assert.equal(await js('!!document.querySelector(".chat-composer-dock .question-card")'), true);
      } else {
        run.text = 'Reply from another device'; run.revision++;
        broadcast({ type: 'chunk', sessionId: 's1', turnId: run.turnId, revision: run.revision, chunk: run.text });
        await waitFor('document.querySelector("[data-live-turn] .msg-body")?.textContent.includes("Reply from another device")');
      }
    }
    console.log('ask-user Chromium checks passed');
    win.destroy(); for (const client of clients) client.end(); server.close(); exitAfterFlush(0);
  } catch (error) {
    console.error(error); await capture('failure').catch(()=>{}); win.destroy(); for (const client of clients) client.end(); server.close(); exitAfterFlush(1);
  }
}).catch(error => {console.error(error); exitAfterFlush(1);});
