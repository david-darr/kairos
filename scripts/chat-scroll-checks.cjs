// Real backend and Chromium, isolated from every running Kairos instance.
const { app, BrowserWindow } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'chat-scroll-review', 'run-' + Date.now());
fs.mkdirSync(path.join(output, 'userData'), { recursive: true });
app.setPath('userData', path.join(output, 'userData'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const errors = [], checks = [], notes = [];
const note = message => { notes.push(message); console.log(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const transcript = "[...document.querySelectorAll('.forge-transcript')].find(n => n.getClientRects().length)";
let win, backend, data, project, log, base;
const titles = {};
// The visible transcript is this session's own panel (a switch can briefly show the previous one).
const shown = id => `(() => { const n=${transcript}; return !!n && n.closest('.forge-surface')?.getAttribute('aria-label') === ${JSON.stringify(titles[id])} && !!n.querySelector('.forge-turn'); })()`;
const js = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await js(code)) return; await delay(50); }
  throw new Error('Timed out: ' + code);
}
async function capture(name) {
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function api(route, body) {
  const response = await fetch(base + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, route + ': ' + response.status + ' ' + (!response.ok ? await response.text() : ''));
  return response.json();
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(port !== 8420 && port !== 8430);
  return port;
}
async function turn(id, message) {
  await api('/api/chat/live', { session_id: id, message, attachment_ids: [], references: [], request_id: require('node:crypto').randomUUID() });
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const run = (await api('/api/chat/live/snapshot')).runs?.[id];
    if (run && run.status !== 'processing') { assert.equal(run.status, 'done'); return; }
    await delay(50);
  }
  throw new Error('Turn timed out: ' + message);
}
async function openForge(id) {
  await js(`document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'forgeSession', sessionId: ${JSON.stringify(id)} } }))`);
  await waitFor(shown(id));
}
async function clickSession(id) {
  const selector = `.forge-session-cards [data-session-id="${id}"]`;
  const reachable = await js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  if (!reachable && await js('innerWidth <= 768')) {
    note('Phone Forge session cards are not reachable; switching via jarvis:navigate.');
    await openForge(id);
    return;
  }
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitFor(shown(id));
}
async function bottom(label) {
  const distance = await js(`(() => { const n=${transcript}; if (!n) return 99999; return n.scrollHeight-n.scrollTop-n.clientHeight; })()`);
  assert.ok(distance <= 2, label + ': distance ' + distance);
}
async function openPlain(id) {
  await js(`import('/static/js/app.js').then(m => m.switchTab('chat', { sessionId: ${JSON.stringify(id)} }))`);
  await waitFor("document.querySelectorAll('#chat-messages .artifact-card').length >= 2");
}
async function send(input, button, text, replySelector) {
  const before = await js(`document.querySelectorAll(${JSON.stringify(replySelector)}).length`);
  const visibleButton = `[...document.querySelectorAll(${JSON.stringify(button)})].find(n => n.getClientRects().length)`;
  await js(`(() => { const n=[...document.querySelectorAll(${JSON.stringify(input)})].find(n => n.getClientRects().length); n.value=${JSON.stringify(text)}; n.dispatchEvent(new Event('input', { bubbles:true })); })()`);
  // The phone composer shows Send a frame after text arrives.
  await waitFor(`!!(${visibleButton})`);
  await js(`(${visibleButton}).click()`);
  await waitFor(`document.querySelectorAll(${JSON.stringify(replySelector)}).length > ${before} && ![...document.querySelectorAll(${JSON.stringify(button)})].some(n => n.dataset.mode === 'stop')`);
}
async function checkViewport(label, a, b, plain, other) {
  await win.loadURL(base + '/');
  await waitFor("document.querySelector('#view-content')?.children.length > 0 && document.querySelector('#onboarding-overlay').classList.contains('hidden')");
  await openForge(a);
  await send('.forge-transcript-input', '.forge-send', 'lines 3', '.forge-turn');
  await send('.forge-transcript-input', '.forge-send', 'lines 4', '.forge-turn');
  await delay(1000);
  assert.ok(await js(`(() => { const n=${transcript}, turns=[...n.querySelectorAll('.forge-turn')]; return !n.querySelector('[aria-busy="true"]') && [...n.querySelectorAll('.forge-terminal-spinner')].filter(s => !s.closest('details').hidden).every(s => s.textContent==='✓') && turns.at(-2).textContent.includes('line 00003') && turns.at(-1).textContent.includes('line 00004'); })()`), label + ': earlier replies remain finished');
  await capture(label + '-finished-replies');
  checks.push(label + ': earlier Forge replies remain finished');
  if (label === 'desktop') {
    await openPlain(plain);
    await js(`import('/static/js/views/chat.js').then(m => m.openSessionById(${JSON.stringify(other)}))`);
    await js(`import('/static/js/sideChat.js').then(m => m.openSideChat(${JSON.stringify(plain)}))`);
    if (await js("!!document.querySelector('.side-chat-input')")) {
      await send('.side-chat-input', '.side-chat-send', 'lines 3', '.side-chat .msg.assistant');
      await send('.side-chat-input', '.side-chat-send', 'lines 4', '.side-chat .msg.assistant');
      assert.ok(await js("[...document.querySelectorAll('.side-chat .msg.assistant')].at(-2).textContent.includes('line 00003')"));
      checks.push('desktop: earlier side chat reply survives');
      await capture('desktop-side-chat');
      await js("import('/static/js/sideChat.js').then(m => m.closeSideChat())");
    } else note('Desktop side chat unavailable in this harness; skipped.');
  } else note('Phone side chat skipped: side by side requires a wide window.');

  await win.loadURL(base + '/');
  await waitFor("document.querySelector('#view-content')?.children.length > 0 && document.querySelector('#onboarding-overlay').classList.contains('hidden')");
  await js(String.raw`(() => { const original=window.fetch; let index=0; window.fetch=async function(...args) { const url=String(args[0]?.url || args[0]); if (/\/api\/(runs|file-checkpoints|forge\/sessions\/)/.test(url)) await new Promise(r => setTimeout(r,[250,600,900][index++%3])); return original.apply(this,args); }; })()`);
  await openForge(a);
  const samples = [];
  for (let i=0; i<30; i++) {
    await delay(100);
    const distance = await js(`(() => { const n=${transcript}; if (!n) return 99999; return n.scrollHeight-n.scrollTop-n.clientHeight; })()`);
    samples.push(distance);
    if (i >= 15) assert.ok(distance <= 2, label + ': late history sample ' + i + ' = ' + distance);
  }
  await bottom(label + ': final history sample');
  await js(String.raw`(() => { const n=(${transcript}).querySelector('.forge-turn:last-child .forge-prose'); const img=document.createElement('img'); img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="600"><rect width="200" height="600" fill="gray"/></svg>'); const pre=document.createElement('pre'), code=document.createElement('code'); code.textContent=Array.from({length:40},(_,i)=>'late code '+i).join('\n'); pre.append(code); n.append(img,pre); })()`);
  await delay(500); await bottom(label + ': late image and code');
  await clickSession(b); await delay(1500); await bottom(label + ': B opened');
  await js(`(() => { const n=${transcript}; n.dispatchEvent(new WheelEvent('wheel',{deltaY:-400,bubbles:true})); n.scrollTop=300; })()`);
  await delay(300);
  assert.ok(await js(`(() => { const n=${transcript}; return n.scrollHeight-n.scrollTop-n.clientHeight>100; })()`), 'Reader can leave bottom');
  await clickSession(a); await delay(1000); await bottom(label + ': A restored');
  await clickSession(b); await delay(1500); await bottom(label + ': B restored');
  checks.push(label + ': late content and restored Forge tabs follow newest message');
  note(label + ': Forge transcript has no mascot; mascot is in the Kairos activity row.');
  await capture(label + '-forge-bottom');

  await openPlain(plain);
  await js(`(() => { const n=document.querySelector('#chat-messages'), card=n.querySelector('.artifact-card'); n.scrollTop+=card.getBoundingClientRect().top-n.getBoundingClientRect().top-n.clientHeight/2; })()`);
  await delay(300);
  const offset = () => js("(() => { const n=document.querySelector('#chat-messages'); return n.querySelector('.artifact-card').getBoundingClientRect().top-n.getBoundingClientRect().top; })()");
  const before = await offset();
  // Keep the actual text position, so paragraph reflow cannot hide line drift.
  const lineBefore = await js(`(() => {
    const n=document.querySelector('#chat-messages'), rect=n.getBoundingClientRect();
    const caret=document.caretRangeFromPoint(rect.left+n.clientWidth/2,rect.top+n.clientHeight/2);
    if (caret?.startContainer.nodeType!==Node.TEXT_NODE || !n.contains(caret.startContainer)) return null;
    const node=caret.startContainer, offset=caret.startOffset;
    window.__chatScrollLineTop=() => {
      const range=document.createRange(); range.setStart(node,offset); range.setEnd(node,Math.min(offset+1,node.length));
      const line=range.getClientRects()[0] ?? range.getBoundingClientRect();
      return line && (line.width || line.height) ? line.top-n.getBoundingClientRect().top : null;
    };
    return window.__chatScrollLineTop();
  })()`);
  assert.notEqual(lineBefore, null, label + ': middle text line found');
  const checkLine = async action => {
    const top = await js('window.__chatScrollLineTop()');
    assert.notEqual(top, null, label + ': text line remains measurable');
    assert.ok(Math.abs(top-lineBefore)<=4, label + ': document ' + action + ' preserves text line');
  };
  await js("(async () => { const card = document.querySelector('#chat-messages .artifact-card'); card.click(); for (let i = 0; i < 600 && !document.querySelector('.media-viewer-pane:not([hidden])'); i++) await new Promise(r => setTimeout(r, 25)); const pane = document.querySelector('.media-viewer-pane:not([hidden])'); if (!pane) throw new Error('the viewer did not offer Open beside chat'); pane.click(); return true; })()");
  await waitFor("!!document.querySelector('[aria-label=\"Close file preview\"]')");
  await delay(900);
  assert.ok(Math.abs(await offset()-before)<=4, label + ': document opening preserves anchor');
  await checkLine('opening');
  await capture(label + '-document-open');
  await js("document.querySelector('[aria-label=\"Close file preview\"]').click()");
  await delay(900);
  assert.ok(Math.abs(await offset()-before)<=4, label + ': document closing preserves anchor');
  await checkLine('closing');
  await js('delete window.__chatScrollLineTop');
  // Programmatic clicks let the reader stay at the bottom while opening a card above it.
  await js("{ const n=document.querySelector('#chat-messages'); n.scrollTop=n.scrollHeight; }");
  await delay(300);
  await js("(async () => { const card = [...document.querySelectorAll('#chat-messages .artifact-card')].at(-1); card.click(); for (let i = 0; i < 600 && !document.querySelector('.media-viewer-pane:not([hidden])'); i++) await new Promise(r => setTimeout(r, 25)); const pane = document.querySelector('.media-viewer-pane:not([hidden])'); if (!pane) throw new Error('the viewer did not offer Open beside chat'); pane.click(); return true; })()");
  await delay(900);
  assert.ok(await js("(() => { const n=document.querySelector('#chat-messages'); return n.scrollHeight-n.scrollTop-n.clientHeight<=2; })()"), label + ': bottom stays pinned');
  await js("document.querySelector('[aria-label=\"Close file preview\"]').click()");
  await delay(900);
  checks.push(label + ': document open/close preserves card, text line and bottom pin');
}
app.whenReady().then(async () => {
  let code = 0;
  try {
    const port = await freePort(); base = 'http://127.0.0.1:' + port;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-chat-scroll-'));
    fs.mkdirSync(path.join(data, 'vault'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-chat-scroll-project-'));
    fs.writeFileSync(path.join(project, 'README.md'), 'Chat scroll fixture\n');
    for (const args of [['init'], ['add', '.'], ['-c','user.email=t@t','-c','user.name=t','commit','-m','Initial']]) {
      const result=spawnSync('git',args,{cwd:project,windowsHide:true,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
    }
    log = fs.openSync(path.join(output, 'backend.log'), 'w');
    const env = { ...process.env, JARVIS_DATA_DIR:data, JARVIS_VAULT_DIR:path.join(data,'vault'), APP_PORT:String(port), JARVIS_INSTANCE:'chatscroll' };
    delete env.JARVIS_UI_SECRET;
    backend = spawn(path.join(root,'.venv','Scripts','python.exe'), ['-m','uvicorn','cli_backend_fixture:app','--app-dir','scripts','--host','127.0.0.1','--port',String(port)], {cwd:root,env,windowsHide:true,stdio:['ignore',log,log]});
    let startupError;
    backend.on('error',error => { startupError=error; });
    let healthy=false;
    const until=Date.now()+60000;
    while(Date.now()<until) {
      if(startupError) throw startupError;
      assert.equal(backend.exitCode,null,'Backend exited; see backend.log');
      try { healthy=(await fetch(base+'/api/health')).status===200; } catch { /* Starting. */ }
      if(healthy) break;
      await delay(200);
    }
    assert.ok(healthy,'Backend health timeout');
    await api('/api/settings/onboarding-complete',{});
    const endpoint=(await api('/api/models/choices')).find(e=>e.name==='Scripted model');
    assert.ok(endpoint);
    const proj=await api('/api/forge/projects',{path:project});
    const a=await api('/api/forge/sessions',{project_id:proj.id,task:'A first',model_endpoint_id:endpoint.id,isolation:'in_place'});
    const b=await api('/api/forge/sessions',{project_id:proj.id,task:'B second',model_endpoint_id:endpoint.id,isolation:'in_place'});
    titles[a.id]=a.title; titles[b.id]=b.title;
    for(const message of ['lines 30','tool','file report.md Quarterly report body','lines 40','tool','lines 25']) await turn(a.id,message);
    for(const message of ['lines 40','tool','lines 30','lines 20']) await turn(b.id,message);
    const plain=await api('/api/sessions',{}), other=await api('/api/sessions',{});
    await api('/api/sessions/'+plain.id+'/model',{model_endpoint_id:endpoint.id,model_override:null});
    for(const message of ['lines 30','file brief.md The brief','lines 40','file plan.md The plan body','lines 30']) await turn(plain.id,message);
    win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
    win.webContents.on('console-message',(_event,level,message)=>{ if(level===3 && !/favicon.*404/i.test(message)) errors.push(message); });
    for(const [label,width,height] of [['desktop',1440,900],['phone',390,844]]) {
      win.setContentSize(width,height);
      await checkViewport(label,a.id,b.id,plain.id,other.id);
    }
    assert.deepEqual(errors,[],'Renderer console errors');
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,notes,errors},null,2));
    console.log('PASS '+output);
  } catch(error) {
    code=1;
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,notes,errors},null,2));
    if(win && !win.isDestroyed()) await capture('failure').catch(()=>{});
    console.error(error);
  } finally {
    win?.destroy();
    if(backend?.pid) {
      const exited = backend.exitCode!==null || backend.signalCode!==null ? Promise.resolve() : new Promise(resolve => {
        const done = () => { clearTimeout(timer); backend.removeListener('exit',done); resolve(); };
        const timer = setTimeout(() => { note('Backend exit wait reached 10s.'); done(); },10000);
        backend.once('exit',done);
      });
      if(process.platform==='win32') spawnSync('taskkill',['/PID',String(backend.pid),'/T','/F'],{windowsHide:true});
      else backend.kill('SIGTERM');
      await exited;
    }
    if(log!==undefined) fs.closeSync(log);
    for(const folder of [data,project]) if(folder) {
      try { fs.rmSync(folder,{recursive:true,force:true,maxRetries:20,retryDelay:250}); }
      catch(error) { note('Could not remove ' + folder + ': ' + error.message); }
    }
    exitAfterFlush(code);
  }
});
