// The desktop notch's panels and steps, without a browser (Kairos Notch build
// spec, phases 2 and 3). The clicking itself runs in Electron in
// scripts/usage-overlay-smoke.cjs; here are the rules underneath it.
// Run: node scripts/test_notch_panels.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

(async () => {
  const P = await import(pathToFileURL(path.join(root, 'static/js/notchPanels.js')).href);
  const S = await import(pathToFileURL(path.join(root, 'static/js/notchSteps.js')).href);
  const G = await import(pathToFileURL(path.join(root, 'static/js/notchGlow.js')).href);
  const { setOverlayFocus, validId } = require(path.join(root, 'electron/usage-overlay-focus.js'));

  await check('an answer is only a real pointer click, 400 ms after the panel appears', () => {
    const shown = 1000, click = { isTrusted: true, detail: 1 };
    assert.equal(P.CLICK_GUARD_MS, 400);
    assert.equal(P.acceptsClick(click, shown, shown + 399), false, 'too soon after it appeared');
    assert.equal(P.acceptsClick(click, shown, shown + 400), true);
    assert.equal(P.acceptsClick({ isTrusted: true, detail: 0 }, shown, shown + 5000), false, 'Enter or Space on a focused button is not a click');
    assert.equal(P.acceptsClick({ isTrusted: false, detail: 1 }, shown, shown + 5000), false, 'a synthetic click is not the person');
    assert.equal(P.acceptsClick(null, shown, shown + 5000), false);
  });
  await check('always defaults to this conversation, its scope in words', () => {
    const choices = [{ id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' },
      { id: 'session', label: 'Always in this chat (ls -la)', behavior: 'allow', scope: 'session' },
      { id: 'forever', label: 'Always allow ls -la', behavior: 'allow', scope: 'forever' },
      { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' }];
    assert.deepEqual(P.notchChoices({ tool: 'Bash', choices }).map(c => c.id), ['once', 'session', 'reject']);
    assert.deepEqual(P.notchChoices({ tool: 'Bash', choices: [choices[0], choices[3]] }).map(c => c.id), ['once', 'reject'], 'unscoped: once or reject');
    const folder = [{ id: 'once', scope: 'session' }, { id: 'forever', scope: 'forever' }, { id: 'reject', scope: 'once' }];
    assert.deepEqual(P.notchChoices({ tool: 'folder_access', choices: folder }).map(c => c.id), ['once', 'forever', 'reject'], 'a folder: once, always, reject');
  });
  await check('the countdown reads minutes and seconds and stops at zero', () => {
    assert.equal(P.countdown(100, 0), '1:40');
    assert.equal(P.countdown(100, 99_500), '0:00');
    assert.equal(P.countdown(100, 200_000), '0:00');
  });
  await check('terminal pairings never get answer buttons, in code', () => {
    const panels = read('static/js/notchPanels.js'), shell = read('static/js/notchShell.js');
    const cli = panels.slice(panels.indexOf('export function cliPanel'), panels.indexOf('export function approvalPanel'));
    assert.ok(!/\/answer|\/respond|deps\.post/.test(cli), 'the pairing panel posts nothing');
    assert.match(cli, /'Open Kairos'/);
    assert.match(panels, /if \(request\.tool === CLI_TOOL\) return cliPanel/, 'an approval for the pairing tool becomes the pairing panel');
    assert.match(shell, /kairos:cli-pair'/, 'pairings from the feed are shown as pairings');
    assert.match(shell, /request\.tool === 'kairos_cli_pair'/);
  });
  await check('request text is never markup', () => {
    const panels = read('static/js/notchPanels.js');
    const writes = panels.match(/innerHTML\s*=\s*[^;]+/g) || [];
    assert.deepEqual(writes, ['innerHTML = icon'], 'only the fixed Retry glyph is markup');
    assert.match(panels, /const RETRY = '<svg/);
    assert.ok(!/icon: request|icon: choice|icon: title/.test(panels));
  });
  await check('collapsing or closing never answers', () => {
    const shell = read('static/js/notchShell.js'), panels = read('static/js/notchPanels.js');
    const collapse = shell.slice(shell.indexOf('function setExpanded'), shell.indexOf('function reset'));
    assert.ok(!/answer|respond|post/.test(collapse), 'setExpanded sends nothing');
    const dispose = panels.match(/dispose\(\) \{[^}]*\}/)[0];
    assert.ok(!/post|answer/.test(dispose), 'a panel going away sends nothing');
    assert.ok(!/addEventListener\('(mouseenter|mouseover|focus|blur)'/.test(panels), 'nothing answers on hover or focus');
  });
  await check('steps: only real tool steps, the turn state and queued items', () => {
    assert.equal(S.verbFor('Read'), 'Reading');
    assert.equal(S.verbFor('Grep'), 'Searching');
    assert.equal(S.verbFor('Bash'), 'Running');
    assert.equal(S.verbFor('Edit'), 'Editing');
    assert.equal(S.verbFor('Write'), 'Writing');
    assert.equal(S.verbFor('mcp__hive_mind__vault_search'), 'Searching');
    assert.equal(S.verbFor('mcp__hive_mind__agent_ask'), 'Using agent ask');
    const steps = [{ phase: 'started', id: 'a', name: 'Read', summary: 'notes/q4.md' }, { phase: 'finished', id: 'a', name: 'Read', summary: 'notes/q4.md', ok: true },
      { phase: 'started', id: 'b', name: 'Grep', summary: 'revenue' }];
    assert.deepEqual(S.chatRows({ toolSteps: steps, text: '' }), { before: 'Reading notes/q4.md', current: 'Searching revenue', after: '' });
    assert.deepEqual(S.chatRows({ toolSteps: steps.slice(0, 2), text: 'Draft' }), { before: 'Reading notes/q4.md', current: 'Writing the reply', after: '' });
    assert.deepEqual(S.chatRows({ toolSteps: [], text: '' }), { before: '', current: 'Waiting for the model', after: '' }, 'no step is invented');
    assert.equal(S.chatRows({ toolSteps: steps, permission: { kind: 'permission' } }).current, 'Waiting for your approval');
    assert.equal(S.chatRows({ toolSteps: [], permission: { kind: 'question' } }).current, 'Waiting for your answer');
    assert.equal(S.chatRows({ toolSteps: [{ phase: 'started', id: 'x', name: 'Bash' }, { phase: 'finished', id: 'x', name: 'Bash', ok: false }] }).before, 'Failed: Running');
    const items = [{ id: 'h1', label: 'Save to Library', status: 'queued' }, { id: 'h2', label: 'Index notes', status: 'done', endedAt: 5 }];
    assert.equal(S.chatRows({ toolSteps: [] }, items).after, 'Next: Save to Library');
    assert.deepEqual(S.taskRows({ id: 'h3', label: 'Scout', activity: 'Reading the inbox', status: 'running' }, [...items, { id: 'h3', label: 'Scout', status: 'running' }]),
      { before: 'Finished: Index notes', current: 'Scout · Reading the inbox', after: 'Next: Save to Library' });
  });
  await check('glows rise from the bottom or sit round Kip, and are drawn once per change', () => {
    assert.deepEqual(G.GLOW_TONES, ['gold', 'ember', 'sage', 'recover']);
    assert.ok(G.glowLevel('bottom', 50, 99, 100, 100) > G.glowLevel('bottom', 50, 10, 100, 100), 'brighter at the bottom');
    assert.equal(G.glowLevel('bottom', 50, 0, 100, 100), 0, 'gone by the top');
    assert.ok(G.glowLevel('halo', 50, 50, 100, 100) > .9 && G.glowLevel('halo', 0, 0, 100, 100) === 0, 'a halo round the centre');
    const glow = read('static/js/notchGlow.js');
    assert.ok(!/requestAnimationFrame|setInterval|<filter|filter:/.test(glow), 'no frame loop, no filter');
    assert.match(glow, /import \{ BAYER4 \} from '\.\/dither\.js'/);
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i.test(glow), 'colours are the notch tokens');
  });
  await check('the window takes the keyboard only while a field is open', () => {
    const calls = [];
    const win = { focused: false, isDestroyed: () => false, isFocused() { return this.focused; },
      setFocusable: on => calls.push(['focusable', on]), focus() { this.focused = true; calls.push(['focus']); }, blur() { this.focused = false; calls.push(['blur']); } };
    assert.equal(setOverlayFocus(win, true), true);
    assert.deepEqual(calls, [['focusable', true], ['focus']]);
    calls.length = 0;
    assert.equal(setOverlayFocus(win, false), false);
    assert.deepEqual(calls, [['blur'], ['focusable', false]], 'blur hands the keyboard back, then non-focusable');
    assert.equal(setOverlayFocus({ isDestroyed: () => true }, true), false);
    for (const good of ['a1b2c3d4e5f6', 'scout_1', 'x-y']) assert.ok(validId(good), good);
    for (const bad of ['../../etc', '', 'a b', 'x'.repeat(65), 5, null, 'id?tab=settings']) assert.ok(!validId(bad), String(bad));
    const main = read('electron/main.js');
    assert.match(main, /ipcMain\.on\("usage-overlay:focus", \(event, on\) => \{\s+if \(fromOverlayWindow\(event\) && typeof on === "boolean"\) setOverlayFocus\(usageOverlay, on\);/);
    assert.match(main, /focusable: false, show: false/, 'the notch starts non-focusable');
    assert.match(main, /setOverlayFocus\(usageOverlay, false\);\s+usageOverlay\.hide\(\);/, 'hiding the notch gives the keyboard back');
  });
  const D = await import(pathToFileURL(path.join(root, 'static/js/notchDrop.js')).href);
  const C = await import(pathToFileURL(path.join(root, 'static/js/notchComposer.js')).href);
  await check('a drop splits files from folders; a folder needs its path', () => {
    const file = { name: 'notes.md', size: 10 };
    const item = (directory, value) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: directory }), getAsFile: () => value });
    const data = { items: [item(true, { name: 'project' }), item(false, file), { kind: 'string' }] };
    assert.deepEqual(D.dropped(data, () => 'C:\\work\\project'), { files: [file], folders: ['C:\\work\\project'] });
    assert.deepEqual(D.dropped(data, () => ''), { files: [file], folders: [] }, 'no path, no folder');
  });
  await check('over 25 MB is refused in words, before any upload', () => {
    assert.equal(D.MAX_FILE_BYTES, 25 * 1024 * 1024);
    const big = { name: 'big.zip', size: D.MAX_FILE_BYTES + 1 }, ok = { name: 'a.pdf', size: D.MAX_FILE_BYTES };
    assert.deepEqual(D.splitBySize([big, ok]), { ok: [ok], refused: [big] });
    assert.equal(D.refusalLine([big]), 'big.zip is over the 25 MB limit, so it was not added.');
    assert.equal(D.refusalLine([big, big, big]), 'big.zip, big.zip and 1 more are over the 25 MB limit, so they were not added.');
    assert.equal(D.refusalLine([]), '');
  });
  await check('Send makes one chat and starts one turn, even when retried', async () => {
    const calls = [];
    let lose = true;
    const post = async (url, body) => {
      calls.push([url, body]);
      if (url === '/api/sessions') return { ok: true, json: async () => ({ id: 's1' }) };
      if (url === '/api/chat/live' && lose) { lose = false; return { ok: false, status: 502, json: async () => ({ detail: 'Lost on the way back.' }) }; }
      return { ok: true, json: async () => ({}) };
    };
    const draft = { text: ' Plan Friday ', files: [{ id: 'att-1', name: 'a.pdf' }], folders: [{ kind: 'folder', id: 'g1', session_id: 's1', label: 'project', path: 'C:\\work\\project' }],
      sessionId: null, requestId: null, modelSet: false, marked: false, model: 0 };
    await assert.rejects(C.sendDraft(draft, { post, models: [{ id: 'm1' }] }), /Lost on the way back/);
    assert.equal(await C.sendDraft(draft, { post, models: [{ id: 'm1' }] }), 's1');
    assert.deepEqual(calls.map(([url]) => url), ['/api/sessions', '/api/sessions/s1/model', '/api/notch/dropped', '/api/chat/live', '/api/chat/live'], 'nothing done twice but the send');
    const [first, second] = calls.filter(([url]) => url === '/api/chat/live').map(([, body]) => body);
    assert.equal(first.request_id, second.request_id, 'the same request id, so the server starts one turn');
    assert.deepEqual(second, { session_id: 's1', message: 'Plan Friday', attachment_ids: ['att-1'], request_id: first.request_id,
      references: [{ kind: 'folder', id: 'g1', session_id: 's1', label: 'project' }] }, 'a folder goes as its grant, never as a raw path');
    await assert.rejects(C.sendDraft({ ...draft, sessionId: 's2', modelSet: false }, { post, models: [] }), /Add a model in Kairos first/);
  });
  await check('the composer never sends by itself and has no global hotkey', () => {
    const composer = read('static/js/notchComposer.js'), shell = read('static/js/notchShell.js'), main = read('electron/main.js');
    assert.ok(!/navigator\.clipboard|readText\(|clipboardData|'paste'/.test(composer + shell), 'nothing pre-filled from the clipboard');
    assert.equal((composer.match(/(?<!function )\bsend\(\)/g) || []).length, 2, 'Send is the Enter key or the Send button, nothing else');
    assert.ok(!/globalShortcut\.register\([^)]*(notch|composer|usage)/i.test(main), 'no global hotkey for the notch');
    assert.match(shell, /function openComposer\(\) \{ if \(!identity\.signedIn\) return;/, 'signed-in people only');
  });
  await check('the floating bot window is retired, with its preload, page and setting', () => {
    for (const file of ['electron/bot-window.js', 'electron/bot-window-preload.js', 'static/bot-window.html', 'static/css/bot-window.css', 'static/js/botWindow.js'])
      assert.ok(!fs.existsSync(path.join(root, file)), file + ' is gone');
    for (const file of ['electron/main.js', 'electron/preload.js', 'static/js/app.js', 'static/js/views/settingsNotifications.js', 'app.py'])
      assert.ok(!/bot-window|botWindow|createBotWindow|Floating bot window/.test(read(file)), file + ' no longer opens it');
  });
  console.log('PASS: ' + passed.join('; '));
})().catch(error => { console.error(error.stack || error.message); console.error('Passed before failing: ' + passed.join('; ')); process.exit(1); });
