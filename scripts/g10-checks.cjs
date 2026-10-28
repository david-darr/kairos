// Part 2 group g10, A16 Forge Home and sessions: gaps the default ui-smoke Forge block does not
// prove (request counts, session search, REA availability, Stop/queue, terminal paste / resize /
// reconnect / copy / links / close, end-session discard to a read-only session).
// Run: node scripts/run-electron-test.cjs ui-smoke --g10-only   (own mocked backend, demoState)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clipboard, ipcMain } = require('electron');

module.exports = async ({ js, win, waitFor, delay, navigate, writes, reads, demoState }) => {
  const metrics = { efficiency: [] };
  const tally = (from, filter = () => true) => reads.slice(from).filter(r => filter(r.path)).reduce((o, r) => (o[r.path] = (o[r.path] || 0) + 1, o), {});
  const waste = (what, counts, limit) => {
    for (const [route, n] of Object.entries(counts)) if (n > limit) {
      metrics.efficiency.push(`${what}: ${route} read ${n}x (expected <= ${limit})`);
    }
  };
  const sendInput = async text => js(`{ const i = document.querySelector('.forge-pane .forge-transcript-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); }`);
  const openSession = async () => {
    await js("document.querySelector('[data-forge-project=fp1]').click()");
    await waitFor("!!document.querySelector('[data-session-id=fs1]')");
    await js("document.querySelector('[data-session-id=fs1]').click()");
    await waitFor("document.getElementById('view-content').dataset.view === 'forgeShell' && !!document.querySelector('.forge-session-header') && !!document.querySelector('.forge-pane .forge-transcript-input')");
  };
  const reaButton = "[...document.querySelectorAll('.forge-session-header button')].find(b => /^REA/.test(b.textContent))";
  win.setContentSize(1440, 900); await delay(150);
  // REA is not in the shared fixtures (and demo/fixtures.js is mirrored into docs/demo), so the page
  // gets a fetch shim: /api/integrations lists an REA item in the state `window.__rea` names, and
  // the per-session integrations POST is recorded in `window.__reaPosts`.
  const installRea = () => js(`(() => { if (window.__reaShim) return true; window.__reaShim = true; window.__rea = null; window.__reaPosts = [];
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href), method = (init?.method || 'GET').toUpperCase();
      if (url.pathname === '/api/integrations' && method === 'GET' && window.__rea) {
        const list = await (await real(input, init)).json();
        list.unshift({ id: 'i-rea', kind: 'mcp_server', name: 'REA', rea_managed: true, status: { state: window.__rea, tools: 4, checked_at: 1, error: null }, held_tools: [] });
        return new Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/integrations') && method === 'POST') {
        window.__reaPosts.push({ path: url.pathname, body: JSON.parse(init.body) });
        return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return real(input, init);
    }; return true; })()`);

  // ---- Forge Home first load ---------------------------------------------------------------------
  await navigate('home');
  await waitFor("!!document.querySelector('#forge-mode-switch [data-mode=forge]')");
  const enterAt = reads.length; const t0 = Date.now();
  await js("document.querySelector('#forge-mode-switch [data-mode=forge]').click()");
  await waitFor("document.querySelectorAll('.forge-stats .forge-stat').length === 5 && document.querySelectorAll('.forge-widget-grid > section').length === 5");
  metrics.forgeHomeFirstContentMs = Date.now() - t0;
  await delay(1500);
  metrics.forgeHomeFirstLoadReads = tally(enterAt, p => p.startsWith('/api/forge'));
  waste('Forge Home first load', metrics.forgeHomeFirstLoadReads, 1);
  assert.deepEqual(metrics.efficiency, [], 'Forge Home first load reads each path once');

  // ---- Open a session: request counts ------------------------------------------------------------
  await js("document.querySelector('[data-forge-project=fp1]').click()");
  await waitFor("!!document.querySelector('[data-session-id=fs1]')");
  const cardTitle = await js("document.querySelector('[data-session-id=fs1] .forge-card-title').textContent");
  const openAt = reads.length; const t1 = Date.now();
  await js("document.querySelector('[data-session-id=fs1]').click()");
  await waitFor("document.getElementById('view-content').dataset.view === 'forgeShell' && !!document.querySelector('.forge-pane .forge-transcript-input') && !!document.querySelector('.forge-work, .forge-turn-review, .forge-transcript .forge-turn')");
  metrics.openSessionMs = Date.now() - t1;
  // Desktop redesign: Forge's prompt matches Kairos chat's: the prompt text, the model logo first
  // in the model pill, and the permission pill (Supervised / Full access, no "Mode" label).
  assert.equal(await js("document.querySelector('.forge-pane .forge-transcript-input').placeholder"), 'Ask, build, or describe a change…');
  await waitFor("!!document.querySelector('.forge-pane .session-chat-models')?.firstElementChild?.classList.contains('session-chat-model-mark') && !!document.querySelector('.forge-pane .session-chat-permission-pill')");
  assert.equal(await js("document.querySelector('.forge-pane .session-chat-permission-pill .custom-select-label')?.textContent"), 'Supervised');
  assert.equal(await js("!!document.querySelector('.forge-pane .session-chat-permission-pill .meta')"), false, 'the pill has no Mode label');
  await js("document.querySelector('.forge-pane .session-chat-permission-pill .custom-select-btn').click()");
  await waitFor("!!document.querySelector('.custom-select-menu .custom-select-item')");
  assert.deepEqual(await js("[...document.querySelectorAll('.custom-select-menu .custom-select-item')].map(o => o.textContent)"), ['Supervised', 'Full access']);
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor("!document.querySelector('.custom-select-menu')");
  await delay(1500);
  metrics.openSessionReads = tally(openAt);
  waste('Open one session', metrics.openSessionReads, 1);
  metrics.openSessionTotalRequests = Object.values(metrics.openSessionReads).reduce((a, b) => a + b, 0);
  // Regression bounds (Part 2 efficiency pass; before: 29 requests, /changes 5x; measured after: 12).
  assert.ok(metrics.openSessionTotalRequests <= 18, 'opening a session stays under 18 requests: ' + JSON.stringify(metrics.openSessionReads));
  for (const [route, n] of Object.entries(metrics.openSessionReads)) assert.ok(n <= 2, `opening a session reads ${route} at most twice, got ${n}`);
  assert.ok((metrics.openSessionReads['/api/forge/sessions/fs1/changes'] || 0) <= 1, 'session open reads /changes once');

  // ---- Session search is local, case-insensitive and reversible ---------------------------------
  const searchAt = reads.length;
  const search = value => js(`{ const i = document.querySelector('.forge-session-search input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await js("document.querySelector('[data-sidebar-tab=sessions]').click()");
  await search('zzz-no-such-session');
  assert.equal(await js("document.querySelectorAll('.forge-session-card').length"), 0, 'no card matches nonsense');
  assert.equal(await js("document.querySelector('#forge-panel-sessions .meta').textContent"), 'No matching sessions.');
  await search(cardTitle.slice(0, 5).toUpperCase());
  assert.ok(await js("!!document.querySelector('[data-session-id=fs1]')"), 'search matches case-insensitively');
  await search('');
  assert.ok(await js("document.querySelectorAll('.forge-session-card').length >= 1"), 'clearing the search restores the list');
  assert.equal(reads.length, searchAt, 'search never calls the server');

  // ---- REA availability --------------------------------------------------------------------------
  assert.equal(await js(`${reaButton}?.hidden`), true, 'REA hidden when the integration does not exist');
  await installRea(); await js("window.__rea = 'down'");
  await navigate('forgeHome'); await openSession();
  await waitFor(`${reaButton}?.hidden === false`);
  assert.equal(await js(`${reaButton}.disabled`), true, 'REA disabled until the tool is working');
  assert.equal(await js(`${reaButton}.title`), 'Check REA in Tool Store first');
  await js("window.__rea = 'working'");
  await navigate('forgeHome'); await openSession();
  await waitFor(`${reaButton}?.hidden === false && ${reaButton}.disabled === false`);
  const reaAt = await js('window.__reaPosts.length');
  await js(`${reaButton}.click()`);
  await waitFor(`${reaButton}.textContent === 'REA on'`);
  const enabled = (await js('window.__reaPosts'))[reaAt].body.enabled_integration_ids;
  assert.ok(enabled.includes('i-rea') && enabled.includes('i-notion'), 'turning REA on keeps the session\'s other default tools: ' + enabled);
  assert.equal(await js(`${reaButton}.getAttribute('aria-pressed')`), 'true');
  await js(`${reaButton}.click()`);
  await waitFor(`${reaButton}.textContent === 'REA tools'`);
  const off = (await js('window.__reaPosts')).at(-1).body.enabled_integration_ids;
  assert.ok(!off.includes('i-rea') && off.includes('i-notion'), 'turning REA off removes only REA: ' + off);

  // ---- Stop and queue while the agent works -------------------------------------------------------
  demoState.forgeHeldSession = 'fs1'; demoState.forgeRelease = false;
  const liveWrites = () => writes.filter(w => w.path === '/api/chat/live').map(w => JSON.parse(w.body).message);
  const liveBefore = liveWrites().length;
  await sendInput('First held task');
  await js("document.querySelector('.forge-pane .side-chat-send').click()");
  await waitFor("document.querySelector('.forge-pane .side-chat-send').dataset.mode === 'stop'");
  assert.equal(await js("document.querySelector('.forge-pane .side-chat-send').textContent"), 'Stop');
  await js(`${reaButton}.click()`);   // ignored while the agent runs
  assert.equal(await js(`${reaButton}.textContent`), 'REA tools', 'REA does not change mid-turn');
  await waitFor("[...document.querySelectorAll('.forge-pane button')].some(b => b.textContent === 'Queue' && !b.hidden)");
  await sendInput('Second queued task');
  await js("[...document.querySelectorAll('.forge-pane button')].find(b => b.textContent === 'Queue').click()");
  await waitFor("!document.querySelector('.forge-pane .session-chat-queue').hidden && document.querySelector('.forge-pane .session-chat-queue textarea').value === 'Second queued task'");
  assert.deepEqual(liveWrites().slice(liveBefore), ['First held task'], 'a queued message is not sent while the first turn runs');
  assert.equal(await js("document.querySelector('.forge-pane .forge-transcript-input').value"), '', 'queueing clears the composer');
  const stopAt = writes.length;
  await js("document.querySelector('.forge-pane .side-chat-send').click()");
  await waitFor("document.querySelector('.forge-pane .side-chat-send').dataset.mode === 'send'");
  const stopWrite = writes.slice(stopAt).find(w => w.path === '/api/chat/live/stop');
  assert.equal(JSON.parse(stopWrite.body).session_id, 'fs1', 'Stop targets this session');
  await delay(600);
  assert.deepEqual(liveWrites().slice(liveBefore), ['First held task'], 'after Stop the queue is paused, not silently sent');
  await waitFor("[...document.querySelectorAll('.forge-pane .session-chat-queue button')].some(b => b.textContent === 'Resume queue' && !b.disabled)");
  demoState.forgeRelease = true;
  await js("[...document.querySelectorAll('.forge-pane .session-chat-queue button')].find(b => b.textContent === 'Resume queue').click()");
  for (let i = 0; i < 100 && liveWrites().slice(liveBefore).length < 2; i++) await delay(50);
  assert.deepEqual(liveWrites().slice(liveBefore), ['First held task', 'Second queued task'], 'Resume sends the queued message once, in order');
  await waitFor("document.querySelector('.forge-pane .side-chat-send').dataset.mode === 'send'");
  delete demoState.forgeHeldSession; delete demoState.forgeRelease; await js('window.__rea = null');

  // ---- Idle cost: an open session, nothing happening, 31 s (one 30 s poll period) ---------------------
  await js("document.querySelector('[data-sidebar-tab=sessions]').click()");
  await delay(500);
  const idleAt = reads.length, idleWrites = writes.length;
  await delay(31000);
  metrics.idle31sSessionOpenReads = tally(idleAt);
  metrics.idle31sSessionOpenTotal = Object.values(metrics.idle31sSessionOpenReads).reduce((a, b) => a + b, 0);
  metrics.idle31sWrites = writes.length - idleWrites;
  assert.equal(writes.length - idleWrites, 0, 'an idle Forge session writes nothing');
  // Idle bounds: no app polling while no app runs; only the 30 s change poll remains (before: 10 status + 9 running + 7 changes + 9 list reads).
  const idleForge = Object.entries(metrics.idle31sSessionOpenReads).filter(([route]) => route.startsWith('/api/forge')).reduce((sum, [, n]) => sum + n, 0);
  metrics.idle31sForgeReads = idleForge;
  assert.ok(!metrics.idle31sSessionOpenReads['/api/forge/sessions/fs1/app/status'], 'no app status polling while no app runs');
  assert.ok(!metrics.idle31sSessionOpenReads['/api/forge/apps/running'], 'no running-apps polling while no app runs');
  assert.ok(idleForge <= 4, 'an idle open Forge session makes at most 4 Forge reads in 31 s: ' + JSON.stringify(metrics.idle31sSessionOpenReads));
  // Polling resumes while an app runs and stops when it ends. (Fixture state; the event is what start/stop dispatch.)
  const polls = from => tally(from, p => p.endsWith('/app/status') || p === '/api/forge/apps/running');
  const appSet = running => { demoState.forgeApps ||= {}; demoState.forgeApps.fs1 = { session_id: 'fs1', project_id: 'fp1', command: 'npm run dev', running, ready: running, port: 5173, ports: running ? [5173] : [], url: running ? 'http://127.0.0.1:5173/' : null, started_at: 1 }; };
  appSet(true);
  await js("document.dispatchEvent(new Event('kairos:forge-apps'))");
  await waitFor("[...document.querySelectorAll('.forge-session-header button')].some(b => b.textContent === 'Preview')");
  const pollAt = reads.length; await delay(7000);
  metrics.runningAppPolls7s = polls(pollAt);
  assert.ok((metrics.runningAppPolls7s['/api/forge/sessions/fs1/app/status'] || 0) >= 2, 'app status is polled (3 s) while the app runs: ' + JSON.stringify(metrics.runningAppPolls7s));
  assert.ok((metrics.runningAppPolls7s['/api/forge/apps/running'] || 0) >= 1, 'running apps are polled (5 s) while the app runs');
  appSet(false);
  await waitFor("[...document.querySelectorAll('.forge-session-header button')].some(b => b.textContent === 'Run app')", 8000);
  await delay(3500);
  const stoppedAt = reads.length; await delay(7000);
  assert.deepEqual(polls(stoppedAt)['/api/forge/sessions/fs1/app/status'] || 0, 0, 'app status polling stops once the app has stopped');
  delete demoState.forgeApps.fs1;

  // ---- Terminal: paste chunking, resize, reconnect, copy, links, close ---------------------------
  const openedUrls = [];
  const jarvisBridge = await js("typeof window.jarvis?.forgeTerminal?.openExternal");
  if (jarvisBridge === 'function') {
    try { ipcMain.removeHandler('forge-terminal:external'); } catch {}
    ipcMain.handle('forge-terminal:external', (_event, url) => { openedUrls.push(url); return { ok: true }; });
  } else {
    await js("window.__opened = []; window.open = (...args) => { window.__opened.push(args[0]); return null; }; true");
  }
  const terminalAt = writes.length;
  await js("document.querySelector('.forge-pane .forge-open-terminal').click()");
  await waitFor("!!document.querySelector('.forge-pane .xterm') && document.querySelector('.forge-pane .forge-terminal-surface')._terminal.buffer.active.getLine(0)?.translateToString().includes('Forge fixture shell')");
  assert.ok(writes.slice(terminalAt).some(w => /\/terminals$/.test(w.path) && w.method === 'POST'), 'Terminal creates a shell on the server');
  const terminalId = Object.keys(demoState.forgeTerminals).at(-1);
  const inputs = () => writes.filter(w => w.path.endsWith('/terminals/' + terminalId + '/input')).map(w => JSON.parse(w.body).data);
  const resizes = () => writes.filter(w => w.path.endsWith('/terminals/' + terminalId + '/resize')).map(w => JSON.parse(w.body));
  const terminal = "document.querySelector('.forge-pane .forge-terminal-surface')._terminal";
  // Paste: 20,000 characters, an astral character straddling the 8,192 boundary, and a CRLF.
  const pasted = 'x'.repeat(8191) + '\u{1F600}' + 'y'.repeat(11000) + '\r\nlast line';
  const before = inputs().length;
  await js(`${terminal}.paste(${JSON.stringify(pasted)})`);
  for (let i = 0; i < 100 && inputs().slice(before).join('').length < pasted.length - 1; i++) await delay(50);
  const chunks = inputs().slice(before);
  assert.ok(chunks.length >= 3, 'a 20k paste is split into several ordered requests: ' + chunks.length);
  assert.ok(chunks.every(c => c.length <= 8193), 'each paste request stays within the chunk size');
  assert.equal(chunks.join(''), pasted.replace(/\r?\n/g, '\r'), 'paste arrives complete, in order, with newlines as Enter and no split character');
  // Output replay shows what was typed exactly once.
  await waitFor(`${terminal}.buffer.active.length > 3`);
  // Resize: posts bounded sizes, debounced.
  const resizeAt = resizes().length;
  for (const w of [1300, 1200, 1100, 1000, 900, 1000, 1100, 1200]) { win.setContentSize(w, 800); await delay(30); }
  await delay(700);
  const after = resizes().slice(resizeAt);
  metrics.terminalResizePostsFor8Steps = after.length;
  assert.ok(after.length >= 1, 'a resized window posts the new size');
  const last = after.at(-1); assert.deepEqual([last.rows, last.cols], await js(`[${terminal}.rows, ${terminal}.cols]`), 'the server learns the real final size');
  assert.ok(after.every(r => r.rows >= 2 && r.rows <= 300 && r.cols >= 2 && r.cols <= 500), 'sizes stay within server bounds');
  if (after.length > 4) metrics.efficiency.push(`Terminal resize: ${after.length} POSTs for an 8-step drag (debounce 100 ms)`);
  win.setContentSize(1440, 900); await delay(400);
  // Reconnect: the server drops the stream; the client says so, resumes from its cursor, no duplicates.
  const outputReads = () => reads.filter(r => r.path.endsWith('/terminals/' + terminalId + '/output'));
  const streamsBefore = outputReads().length;
  await js(`${terminal}.input('echo once\\r\\n')`);
  await waitFor(`[...Array(${terminal}.buffer.active.length).keys()].some(i => ${terminal}.buffer.active.getLine(i).translateToString().includes('echo once'))`);
  demoState.forgeTerminalDrop = true;
  for (let i = 0; i < 80 && outputReads().length === streamsBefore; i++) await delay(50);
  assert.ok(outputReads().length > streamsBefore, 'client reconnects after the stream drops');
  assert.ok(Number(outputReads().at(-1).query.after) > 0, 'reconnect resumes from the last cursor, not from zero');
  await js(`${terminal}.input('echo twice\\r\\n')`);
  await waitFor(`[...Array(${terminal}.buffer.active.length).keys()].some(i => ${terminal}.buffer.active.getLine(i).translateToString().includes('echo twice'))`);
  const occurrences = await js(`[...Array(${terminal}.buffer.active.length).keys()].filter(i => ${terminal}.buffer.active.getLine(i).translateToString().includes('echo once')).length`);
  assert.equal(occurrences, 1, 'reconnect does not replay output already shown');
  // Copy and Paste buttons: selection goes to the OS clipboard.
  clipboard.writeText('before-copy');
  await js(`${terminal}.selectAll()`);
  await js("[...document.querySelectorAll('.forge-pane .forge-terminal-toolbar button')].find(b => b.textContent === 'Copy').click()");
  for (let i = 0; i < 40 && clipboard.readText() === 'before-copy'; i++) await delay(50);
  assert.ok(clipboard.readText().includes('Forge fixture shell'), 'Copy puts the selection on the clipboard');
  await js(`${terminal}.clearSelection()`);
  // Links: only http(s) text is clickable, and it goes to the OS handler, never into the app window.
  await js(`${terminal}.write('open http://127.0.0.1:5173/app now and javascript:alert(1) file:///C:/secret\\r\\n')`);
  const point = await js(`(() => { const t = ${terminal}, b = t.buffer.active; let row = -1, col = -1;
    for (let i = 0; i < b.length; i++) { const s = b.getLine(i).translateToString(); const at = s.indexOf('http://127.0.0.1:5173'); if (at >= 0) { row = i - b.viewportY; col = at + 6; } }
    const r = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: r.left + (col + .5) * r.width / t.cols, y: r.top + (row + .5) * r.height / t.rows, row }; })()`);
  assert.ok(point.row >= 0, 'link row is on screen');
  const click = type => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await click('mouseMoved'); await delay(150); await click('mousePressed'); await click('mouseReleased');
  const gotUrls = () => jarvisBridge === 'function' ? openedUrls : null;
  for (let i = 0; i < 40 && !(gotUrls() ? gotUrls().length : await js('window.__opened.length')); i++) await delay(50);
  const urls = gotUrls() || await js('window.__opened');
  assert.deepEqual(urls, ['http://127.0.0.1:5173/app'], 'clicking a terminal URL opens exactly that URL externally');
  // Close: the shell is deleted and the tab goes.
  await js("document.querySelector('.forge-surface-tab-group[data-surface-type=terminal] .forge-tab-close').click()");
  await waitFor("!document.querySelector('.forge-surface-tab-group[data-surface-type=terminal]')");
  assert.ok(writes.some(w => w.method === 'DELETE' && w.path.endsWith('/terminals/' + terminalId)), 'closing the tab deletes the shell');

  // ---- End session (discard): confirmation, request, read-only restored session -------------------
  await js("document.querySelector('.forge-surface-tab-group[data-surface-type=session] .forge-surface-tab')?.click()");
  await waitFor("!!document.querySelector('.forge-pane .forge-transcript-input')");
  const endAt = writes.length;
  await js("[...document.querySelectorAll('.forge-session-header button')].find(b => b.textContent === 'End session').click()");
  await waitFor("!!document.querySelector('.forge-end-options')");
  assert.ok(await js("!!document.querySelector('.forge-warning') && document.querySelector('.forge-warning').textContent.includes('uncommitted')"), 'dirty session is called out');
  assert.deepEqual(await js("[...document.querySelectorAll('.forge-end-options button')].map(b => b.textContent)"),
    ['Merge back and remove', 'Keep the branch, remove the worktree', 'Discard', 'Keep and leave']);
  await js("[...document.querySelectorAll('.forge-end-options button')].find(b => b.textContent === 'Keep the branch, remove the worktree').click()");
  await waitFor("[...document.querySelectorAll('.forge-end-options ~ *, .modal-body *, [role=alert]')].some(n => n.getAttribute?.('role') === 'alert' && /uncommitted/i.test(n.textContent))");
  assert.ok(!demoState.forgeSessions.fs1.forge.removed && await js("document.getElementById('view-content').dataset.view === 'forgeShell' && !!document.querySelector('.forge-end-options')"), 'a refused keep-branch leaves the session open');
  await js("[...document.querySelectorAll('.forge-end-options button')].find(b => b.textContent === 'Discard').click()");
  await waitFor("!!document.querySelector('.confirm-panel')");
  assert.ok(await js("document.querySelector('.confirm-panel').textContent.includes('Your main project folder')"), 'discard names what is kept');
  await js("[...document.querySelectorAll('.confirm-panel button')].find(b => /Cancel/i.test(b.textContent)).click()");
  await delay(200);
  assert.ok(!writes.slice(endAt).some(w => w.path === '/api/forge/sessions/fs1/end' && JSON.parse(w.body).option === 'discard'), 'cancelling the confirmation sends nothing');
  await js("[...document.querySelectorAll('.forge-end-options button')].find(b => b.textContent === 'Discard').click()");
  await waitFor("!!document.querySelector('.confirm-panel')");
  await js("[...document.querySelectorAll('.confirm-panel button')].find(b => b.textContent === 'Discard').click()");
  for (let i = 0; i < 60 && !writes.slice(endAt).some(w => w.path === '/api/forge/sessions/fs1/end' && JSON.parse(w.body).option === 'discard'); i++) await delay(50);
  const endWrite = writes.slice(endAt).find(w => w.path === '/api/forge/sessions/fs1/end' && JSON.parse(w.body).option === 'discard');
  assert.deepEqual(JSON.parse(endWrite.body), { option: 'discard', confirmed: true });
  await waitFor("document.getElementById('view-content').dataset.view !== 'forgeShell' || !document.querySelector('.forge-end-options')");
  assert.equal(demoState.forgeSessions.fs1.forge.removed, true);
  await navigate('forgeHome'); await js("document.querySelector('[data-forge-project=fp1]').click()");
  await waitFor("!!document.querySelector('[data-session-id=fs1]')");
  assert.ok(await js("document.querySelector('[data-session-id=fs1]').textContent.includes('Worktree removed')"), 'removed session stays listed as removed');
  await js("document.querySelector('[data-session-id=fs1]').click()");
  await waitFor("!!document.querySelector('.forge-pane .forge-transcript-input')");
  await waitFor("document.querySelector('.forge-pane .forge-transcript-input').disabled");
  assert.ok(await js("document.querySelector('.forge-pane .forge-transcript-input').disabled && document.querySelector('.forge-pane .side-chat-send').disabled"), 'removed session composer is read-only');
  assert.ok(await js("['Run app', 'Terminal'].every(t => [...document.querySelectorAll('.forge-session-header button')].find(b => b.textContent === t)?.disabled === true)"), 'Run app and Terminal are off for a removed worktree');

  fs.mkdirSync(path.join(os.tmpdir(), 'g10'), { recursive: true });
  fs.writeFileSync(path.join(os.tmpdir(), 'g10', 'electron-metrics.json'), JSON.stringify(metrics, null, 1));
  console.log('G10 METRICS ' + JSON.stringify(metrics));
};
