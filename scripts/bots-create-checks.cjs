// Making and configuring bots, in the renderer (Agents 3.0 Phase 0, unit U4).
// Run: node scripts/run-electron-test.cjs ui-smoke --bots-create-only
// (U1's loader runs scripts/bots-<name>-checks.cjs for --bots-<name>-only, and the full run includes it.)
//
// Mounts U4's components directly (the new-bot dialogs, the gallery, the Archived panel and the bot
// panel) in a scratch container under <html data-app-mode="bots"> against U1's in-memory backend
// (demoState.botsLive), so it does not depend on the mode shell. Covers: Simple create; the Advanced
// dialog with Escape-to-confirm and phone full-screen; defaults and presets; gallery add, review,
// create; partial failure (warnings keep the bot); the 100-bot message; the panel in Simple and
// Advanced; deep links; one debounced PATCH for merged edits; a failing PATCH rolled back with a toast;
// archive with Undo; duplicate; the system-prompt preview; the setup checklist; conversations.
// Every scratch node is removed at the end and the mode attribute is put back.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const q = JSON.stringify;
  const call = (path, method, body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)});
    n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  // A row-kit text field commits on blur.
  const commit = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)});
    n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); n.blur(); n.dispatchEvent(new Event('blur')); return true; })()`);
  const key = (name, selector) => js(`(() => { const t = ${selector ? `document.querySelector(${q(selector)})` : 'document.activeElement'} || document.body;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: ${q(name)}, bubbles: true, cancelable: true })); return true; })()`);
  const waitWrite = async (start, path, method, matches = () => true, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      const hit = writes.slice(start).find(w => w.path === path && w.method === method && w.status && matches(JSON.parse(w.body || '{}'), w));
      if (hit) return hit;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${method} ${path}`);
  };
  const writesTo = (start, path, method) => writes.slice(start).filter(w => w.path === path && w.method === method);
  const toasts = () => js("[...document.querySelectorAll('#toast-host .toast')].map(n => n.textContent)");
  const errorToasts = () => js("[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)");
  const clearToasts = () => js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
  const dialogOpen = () => exists('.panel-dialog.bots-create-dialog');
  // Close through each dialog's own close button, so its listeners and the dialog stack are released.
  const closeDialogs = () => js(`(() => { for (let i = 0; i < 6; i++) { const b = document.querySelector('.modal-backdrop .modal-close-btn'); if (!b) break; b.click(); }
    document.querySelectorAll('.modal-backdrop').forEach(n => n.remove()); return true; })()`);
  const confirmYes = () => click('.confirm-panel .modal-footer .btn:last-child');
  const confirmNo = () => click('.confirm-panel .modal-footer .btn:first-child');
  const identityField = (index, tag = 'input') => `#bots-u4-host .bots-identity .bots-card-body > :nth-child(${index}) ${tag}`;
  const setInterfaceMode = advanced => js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${advanced}); return m.isAdvanced(); })`);
  const mountPanel = (mode, extra = {}) => js(`(async () => {
    const P = await import('/static/js/botsPanel.js');
    window.__panel?.destroy();
    document.getElementById('bots-u4-host')?.remove();
    const host = document.createElement('div');
    host.id = 'bots-u4-host';
    host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:' + (${q(mode)} === 'advanced' ? 'min(420px,42vw)' : '320px') + ';z-index:30;background:var(--bots-panel)';
    document.body.append(host);
    window.__closed = 0;
    window.__panel = P.mountBotPanel(host, Object.assign({ agentId: 'a1', mode: ${q(mode)}, onClose: () => { window.__closed++; } }, ${q(extra)}));
    return true;
  })()`);
  const reduce = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] });
  const botRow = id => js(`fetch('/api/agents').then(r => r.json()).then(list => list.find(a => a.id === ${q(id)}))`);

  const savedInterface = await js("localStorage.getItem('kairos:bots-interface') || ''");
  const savedSection = await js("localStorage.getItem('kairos:bots-last-section')");
  const restore = await isolateBotsCheck({ js, demoState });
  let phone = false;
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__botsCreatePriorMode = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots';
      localStorage.removeItem('kairos:bots-last-section');
      window.__botsErrs = []; window.addEventListener('error', e => window.__botsErrs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__botsErrs.push('rejection: ' + String(e.reason && e.reason.stack || e.reason))); window.__nav = []; document.addEventListener('jarvis:navigate', e => { window.__nav.push(e.detail); e.stopImmediatePropagation(); }, true);
      window.__changed = 0; document.addEventListener('jarvis:agents-changed', () => { window.__changed++; });
      return true; })()`);
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");  // seeds the in-memory backend
    const store = () => demoState.botsCore;
    assert.ok(['a1', 'a2'].every(id => store().agents.some(a => a.id === id)), 'the backend is seeded with the two demo bots');
    // The main demo's profile checks edit these records. Arrange the profile
    // this panel scenario exercises, in our private store only.
    assert.equal((await call('/api/agents/a1', 'PATCH', { name: 'Scout', role: 'Watches job postings and applications',
      soul: 'Be brief.', endpoint_id: null, integration_ids: null, daily_run_cap: 12, hidden: false })).status, 200);
    assert.equal((await call('/api/agents/a2', 'PATCH', { name: 'Archivist', hidden: false })).status, 200);

    // ======================= Simple create =================================================================
    await setInterfaceMode(false);
    let start = writes.length;
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.simple .bots-text-row input')");
    assert.equal(await js("document.querySelector('.bots-create-dialog .modal-header').textContent.includes('New bot')"), true);
    assert.ok(await js("document.querySelector('.bots-create-dialog.simple input[aria-label=Name]').value.length > 0"), 'the name starts as a free suggestion');
    assert.equal(await js("document.activeElement === document.querySelector('.bots-create-dialog.simple input[aria-label=Name]')"), true, 'the name has focus');
    assert.equal(await js("document.querySelectorAll('.bots-create-dialog.simple .bots-swatch').length"), 6, 'six Kip colours');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-create-dialog.simple')).borderTopLeftRadius"), '14px', 'the dialog takes the Bots corner radius');
    assert.ok((await js("getComputedStyle(document.querySelector('.bots-create-dialog.simple')).fontFamily")).includes('Geist'), 'and the Bots font');
    assert.equal(await js("document.querySelector('.bots-create-dialog.simple .bots-btn.primary').disabled"), false, 'a suggested name is enough to create');
    await fill('.bots-create-dialog.simple input[aria-label=Name]', '');
    assert.equal(await js("document.querySelector('.bots-create-dialog.simple .bots-btn.primary').disabled"), true, 'no name, no Create');
    assert.match(await text('.bots-create-dialog.simple .bots-validity'), /Give the bot a name/);
    await fill('.bots-create-dialog.simple input[aria-label=Name]', 'archivist');
    assert.match(await text('.bots-create-dialog.simple .bots-validity'), /already exists/, 'a taken name (any case) is refused before sending');
    await fill('.bots-create-dialog.simple input[aria-label=Name]', 'Fennel Test');
    await fill('.bots-create-dialog.simple input[aria-label=Job]', 'Keeps the reading list');
    await click('.bots-create-dialog.simple .bots-swatch[data-color="b5c7a5"]');
    assert.equal(await js("document.querySelector('.bots-create-dialog.simple .bots-swatch[aria-checked=true]').dataset.color"), 'b5c7a5');
    await capture('bots-create-simple');
    await click('.bots-create-dialog.simple .bots-btn.primary');
    const made = await waitWrite(start, '/api/agents/configured', 'POST');
    assert.equal(made.status, 200);
    const body = JSON.parse(made.body);
    assert.deepEqual([body.profile.name, body.profile.role, body.profile.color, body.profile.avatar.color, body.approval_mode, body.use_defaults, body.origin],
      ['Fennel Test', 'Keeps the reading list', '#b5c7a5', '#B5C7A5', 'full', true, { kind: 'blank' }]);
    assert.ok(!('model' in body) && !('routines' in body) && !('soul' in body), 'Simple sends no model, routines or soul: the defaults fill the rest');
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
    const fennel = store().agents.find(a => a.name === 'Fennel Test');
    assert.ok(fennel, 'the bot exists');
    assert.deepEqual([fennel.role, fennel.approval_mode, fennel.color], ['Keeps the reading list', 'full', '#b5c7a5']);
    assert.ok((await js('window.__nav')).some(n => n.tab === 'botsShell' && n.agentId === fennel.id), 'its page opens');
    assert.ok(await js('window.__changed') > 0, 'the rest of the app is told the list changed');
    assert.ok((await toasts()).some(t => t.includes('Fennel Test is ready')));
    await clearToasts();

    // ======================= Advanced dialog: Escape-to-confirm ==================================================
    await setInterfaceMode(true);
    start = writes.length;
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced .bots-create-nav')");
    const nav = await js("[...document.querySelectorAll('.bots-create-nav button')].map(b => b.textContent)");
    assert.deepEqual(nav, ['Identity', 'Soul', 'Model', 'Routines', 'Access', 'Delivery'], 'the left nav');
    assert.ok(await js("document.querySelector('.bots-create-dialog.advanced').getBoundingClientRect().width >= 800"), 'the dialog is wide on a desktop');
    // A clean dialog closes on Escape at once, even with a text field focused.
    await js("document.querySelector('.bots-create-dialog.advanced input[aria-label=Job]').focus()");
    await key('Escape');
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
    // A typed draft asks first.
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced .bots-create-nav')");
    await fill('.bots-create-dialog.advanced input[aria-label=Job]', 'A half-written job');
    await key('Escape');
    await waitFor("!!document.querySelector('.confirm-panel')");
    assert.match(await text('.confirm-panel'), /Discard this draft/);
    await confirmNo();
    await waitFor("!document.querySelector('.confirm-panel')");
    assert.equal(await js("document.querySelector('.bots-create-dialog.advanced input[aria-label=Job]').value"), 'A half-written job', 'cancelling keeps the draft');
    await key('Escape', '.bots-create-dialog.advanced input[aria-label=Job]');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await confirmYes();
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
    assert.equal(writesTo(start, '/api/agents/configured', 'POST').length, 0, 'a discarded draft creates nothing');

    // ======================= Advanced create: every field ===================================================================
    start = writes.length;
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced .bots-start-list')");
    // Starting roles: blank, the four built-ins, then saved presets.
    const starts = await js("[...document.querySelectorAll('.bots-start-row .bots-row-title')].map(n => n.textContent)");
    assert.deepEqual(starts.slice(0, 5), ['Blank', 'Researcher', 'Inbox triage', 'Writer', 'Watcher']);
    await click('.bots-start-row[data-start="starter-writer"] .bots-start-pick');
    assert.equal(await js("document.querySelector('.bots-create-dialog.advanced input[aria-label=Job]').value"), 'Drafts and tightens writing', 'a starting role fills the job');
    assert.match(await js("document.querySelector('#bots-create-soul textarea').value"), /Write plainly/, 'and the standing instructions');
    await fill('.bots-create-dialog.advanced input[aria-label=Name]', 'Quillfeather');
    await fill('.bots-create-dialog.advanced input[aria-label="Group"]', 'Writing room');
    await click('#bots-create-soul .bots-start-more .bots-btn');                  // Add a note
    await js(`(() => { const row = document.querySelector('#bots-create-soul .bots-note-row'); row.querySelector('select').value = 'Preferences'; row.querySelector('select').dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await fill('#bots-create-soul .bots-note-row textarea', 'Keeps drafts under 300 words.');
    await click('#bots-create-routines .bots-start-more .bots-btn');              // Add a routine
    await fill('#bots-create-routines .bots-routine-card input[aria-label="Routine 1 name"]', 'Weekly edit');
    await fill('#bots-create-routines .bots-routine-card textarea', 'Review what I wrote this week.');
    await js("document.querySelector('#bots-create-routines .bots-routine-card input[type=time]').value = '17:30'; document.querySelector('#bots-create-routines .bots-routine-card input[type=time]').dispatchEvent(new Event('input', { bubbles: true }))");
    await capture('bots-create-advanced');
    // The nav scrolls to a section and the section crossing the reading line is marked.
    await click('.bots-create-nav button[data-section="routines"]');
    await delay(500);
    await waitFor("document.querySelectorAll('.bots-create-nav button.active').length === 1", 4000);
    await click('.bots-create-dialog.advanced .bots-btn.primary');
    const adv = await waitWrite(start, '/api/agents/configured', 'POST');
    const advBody = JSON.parse(adv.body);
    assert.equal(advBody.profile.name, 'Quillfeather');
    assert.equal(advBody.profile.section, 'Writing room');
    assert.match(advBody.profile.soul, /Write plainly/);
    assert.deepEqual(advBody.origin, { kind: 'preset', id: 'starter-writer' });
    assert.deepEqual(advBody.memory_seed, [{ section: 'Preferences', text: 'Keeps drafts under 300 words.' }]);
    assert.deepEqual(advBody.routines.map(r => [r.name, r.schedule_kind, r.run_time]), [['Weekly edit', 'daily', '17:30']]);
    assert.equal(advBody.approval_mode, 'full');
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
    const quill = store().agents.find(a => a.name === 'Quillfeather');
    assert.ok(quill && quill.section === 'Writing room' && store().memories[quill.id].length === 1 && store().routines[quill.id].length === 1, 'bot, note and routine all exist');
    await clearToasts();

    // ======================= Partial failure keeps the bot; a hard failure keeps nothing =============================================
    demoState.botsConfiguredWarnings = ['The routine Weekly edit was made but could not be turned on: the schedule service is busy.'];
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced .bots-start-list')");
    await fill('.bots-create-dialog.advanced input[aria-label=Name]', 'Warned Bot');
    await click('#bots-create-routines .bots-start-more .bots-btn');
    await fill('#bots-create-routines .bots-routine-card input[aria-label="Routine 1 name"]', 'Weekly edit');
    await fill('#bots-create-routines .bots-routine-card textarea', 'Do it.');
    await click('.bots-create-dialog.advanced .bots-btn.primary');
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
    assert.ok(store().agents.some(a => a.name === 'Warned Bot'), 'the bot is kept when a routine could not be turned on');
    const warned = await errorToasts();
    assert.ok(warned.some(t => t.includes('Warned Bot was created') && t.includes('could not be turned on')), `a warning toast names the problem: ${warned}`);
    delete demoState.botsConfiguredWarnings;
    await clearToasts();

    const before = store().agents.length;
    demoState.botsConfiguredFail = { status: 500, detail: 'The routine could not be made', cleanup_errors: [] };
    await setInterfaceMode(false);
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.simple')");
    await fill('.bots-create-dialog.simple input[aria-label=Name]', 'Never Made');
    await click('.bots-create-dialog.simple .bots-btn.primary');
    await waitFor("document.querySelector('.bots-create-dialog .bots-validity')?.textContent.includes('could not be made')");
    assert.equal(store().agents.length, before, 'nothing was made');
    assert.ok(await dialogOpen(), 'the dialog stays open so the draft is not lost');
    assert.equal(await js("document.querySelector('.bots-create-dialog.simple .bots-btn.primary').disabled"), false, 'and can be tried again');
    demoState.botsConfiguredFail = { status: 500, detail: 'It broke', cleanup_errors: ['routine r9 was not removed'] };
    await click('.bots-create-dialog.simple .bots-btn.primary');
    await waitFor("document.querySelector('.bots-create-dialog .bots-validity')?.textContent.includes('left behind')");
    assert.match(await text('.bots-create-dialog .bots-validity'), /routine r9 was not removed/, 'leftovers are named');
    delete demoState.botsConfiguredFail;
    await closeDialogs();
    await clearToasts();

    // ======================= The 100-bot limit =============================================================================================
    store().maxBots = store().agents.length;
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.simple')");
    await fill('.bots-create-dialog.simple input[aria-label=Name]', 'One Too Many');
    await click('.bots-create-dialog.simple .bots-btn.primary');
    await waitFor("document.querySelector('.bots-create-dialog .bots-validity')?.textContent.includes('bots')");
    assert.match(await text('.bots-create-dialog .bots-validity'), /you can have up to \d+ bots; delete or archive one first/);
    assert.ok(!store().agents.some(a => a.name === 'One Too Many'));
    store().maxBots = 100;
    await closeDialogs();
    await clearToasts();

    // ======================= Defaults and presets ============================================================================================
    await setInterfaceMode(true);
    start = writes.length;
    await js("import('/static/js/botsCreate.js').then(m => { m.openBotDefaults(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced')");
    assert.match(await text('.bots-create-dialog .modal-header'), /New-bot defaults/);
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-create-nav button')].map(b => b.textContent)"), ['Identity', 'Soul', 'Routines', 'Access'], 'defaults have no model or delivery');
    assert.equal(await exists('.bots-create-dialog input[aria-label=Name]'), false, 'and no name');
    await fill('.bots-create-dialog input[aria-label=Job]', 'Answers in one paragraph');
    await fill('#bots-create-soul textarea', 'Always lead with the answer.');
    await click('.bots-create-dialog .bots-btn.primary');
    const saved = await waitWrite(start, '/api/agents/defaults', 'PUT');
    assert.deepEqual(JSON.parse(saved.body).defaults, { role: 'Answers in one paragraph', soul: 'Always lead with the answer.', color: '#d9b260' });
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced .bots-start-list')");
    assert.equal(await js("document.querySelector('.bots-create-dialog input[aria-label=Job]').value"), 'Answers in one paragraph', 'a new bot starts from the saved defaults');
    assert.equal(await js("document.querySelector('#bots-create-soul textarea').value"), 'Always lead with the answer.');
    await closeDialogs();

    // Save a bot as a preset from the panel menu; it appears as a starting role, applies, and can be deleted.
    await mountPanel('advanced');
    await waitFor("!!document.querySelector('#bots-u4-host .bots-acc-item')");
    await click('#bots-u4-host [aria-label="Bot menu"]');
    await waitFor("!!document.querySelector('.bots-menu')");
    start = writes.length;
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('Save as preset')).click()");
    const preset = await waitWrite(start, '/api/agents/presets', 'POST');
    assert.deepEqual(JSON.parse(preset.body), { from_agent_id: 'a1' });
    assert.equal(store().presets.length, 1);
    assert.deepEqual(Object.keys(store().presets[0]).filter(k => ['endpoint_id', 'model_override', 'approval_mode', 'integration_ids', 'place'].includes(k)), [], 'a preset never carries model, approval, apps or place');
    await js("window.__panel.destroy(); document.getElementById('bots-u4-host')?.remove()");
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.bots-start-row[data-start]:not([data-start=blank]):not([data-start^=starter])')");
    const savedStart = await js("document.querySelector('.bots-start-row[data-start]:not([data-start=blank]):not([data-start^=starter])').dataset.start");
    assert.equal(savedStart, store().presets[0].id);
    await click(`.bots-start-row[data-start="${savedStart}"] .bots-start-pick`);
    assert.equal(await js("document.querySelector('.bots-create-dialog input[aria-label=Job]').value"), 'Watches job postings and applications', 'the preset fills the job');
    start = writes.length;
    await click(`.bots-start-row[data-start="${savedStart}"] .bots-icon-btn`);
    await waitFor("!!document.querySelector('.confirm-panel')");
    await confirmYes();
    await waitWrite(start, `/api/agents/presets/${savedStart}`, 'DELETE');
    await waitFor(`!document.querySelector('.bots-start-row[data-start="${savedStart}"]')`);
    assert.equal(store().presets.length, 0);
    await closeDialogs();
    // Put the defaults back to blank.
    await call('/api/agents/defaults', 'PUT', { defaults: {} });

    // ======================= Ready-made gallery: add, review, create =============================================================================
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot({ gallery: true }); return true; })");
    await waitFor("document.querySelectorAll('.bots-ready-card').length >= 10");
    const cards = await js("[...document.querySelectorAll('.bots-ready-card')].map(c => c.dataset.ready)");
    assert.ok(cards.includes('harbor') && cards.length >= 10);
    await capture('bots-gallery');
    const chips = await js("[...document.querySelectorAll('.bots-chip')].map(c => c.textContent)");
    assert.equal(chips[0], 'All');
    assert.ok(chips.length >= 6, 'category chips');
    await click('.bots-chip[data-category="writing"]');
    const writing = await js("[...document.querySelectorAll('.bots-ready-card:not([hidden])')].map(c => c.dataset.category)");
    assert.ok(writing.length >= 2 && writing.every(c => c === 'writing'), 'a chip filters the grid');
    await click('.bots-chip[data-category="all"]');
    assert.equal(await js("document.querySelectorAll('.bots-ready-card[hidden]').length"), 0);
    assert.ok(await js("[...document.querySelectorAll('.bots-ready-card')].every(c => c.querySelector('.bots-ready-try') && c.querySelector('.bots-ready-role').textContent && c.querySelector('button').textContent.includes('Add'))"), 'every card has a job, a line to try and Add');
    start = writes.length;
    await click('.bots-ready-card[data-ready="harbor"] .bots-btn');
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced')");
    assert.equal(await js("!document.querySelector('.bots-gallery-dialog')"), true, 'the gallery closes');
    assert.equal(await js("document.querySelector('.bots-create-dialog input[aria-label=Name]').value"), 'Harbor', 'Add opens the dialog for review, named for the persona');
    assert.match(await js("document.querySelector('.bots-create-dialog input[aria-label=Job]').value"), /Sorts the inbox/);
    assert.match(await js("document.querySelector('#bots-create-soul textarea').value"), /triage incoming messages/);
    assert.equal(await js("document.querySelectorAll('#bots-create-routines .bots-routine-card').length"), 1, 'the suggested routine is shown');
    assert.equal(await js("document.querySelector('#bots-create-routines .bots-routine-card .bots-switch').getAttribute('aria-checked')"), 'false', 'switched off');
    assert.equal(writesTo(start, '/api/agents/configured', 'POST').length, 0, 'nothing is made before the person confirms');
    await click('.bots-create-dialog.advanced .bots-btn.primary');
    const ready = JSON.parse((await waitWrite(start, '/api/agents/configured', 'POST')).body);
    assert.deepEqual(ready.origin, { kind: 'ready', id: 'harbor' });
    assert.deepEqual(ready.routines, [], 'a routine left off is not created');
    assert.ok(!('model' in ready) && ready.approval_mode === 'full', 'the person’s own model and approval stand');
    assert.equal(ready.profile.avatar.color, '#D99A92');
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
    assert.ok(store().agents.some(a => a.name === 'Harbor'));
    await clearToasts();

    // ======================= The panel, Simple ===============================================================================================
    // More than three newer conversations: Main must survive the collapsed list.
    for (const title of ['Reading list', 'Ideas', 'Drafts', 'Questions']) await call('/api/agents/a1/threads', 'POST', { title });
    await setInterfaceMode(false);
    await mountPanel('simple');
    await waitFor("!!document.querySelector('#bots-u4-host .bots-hero-name') && !!document.querySelector('#bots-u4-host [data-panel-card=model] .agent-model-picker')");
    assert.equal(await js("document.querySelector('#bots-u4-host .bots-panel').dataset.mode"), 'simple');
    assert.equal(await js("document.querySelector('#bots-u4-host .bots-hero-name').value"), 'Scout');
    assert.equal(await js("document.querySelector('#bots-u4-host .bots-hero-job').value"), 'Watches job postings and applications');
    assert.ok(await exists('#bots-u4-host .bots-hero-face kairos-mascot'), 'a live Kip in the hero');
    assert.equal(await exists('#bots-u4-host .bots-acc-item'), false, 'Simple has no accordion');
    assert.ok(await exists('#bots-u4-host .bots-setup'), 'what is left to set up');
    assert.deepEqual(await js("[...document.querySelectorAll('#bots-u4-host .bots-setup-step')].map(n => [n.querySelector('.bots-row-title').textContent, n.dataset.done])"),
      // Scout's instructions became its soul when the record was upgraded (design 2.3), so that step is done.
      [['Give it a name and a job', 'true'], ['Write its standing instructions', 'true'], ['Choose its model', 'false'], ['Give it a schedule or a trigger', 'false']]);
    assert.ok(await exists('#bots-u4-host [data-panel-card="model"] .agent-model-picker'), 'the model row');
    const rows = await js("[...document.querySelectorAll('#bots-u4-host .bots-conv-row')].map(r => r.dataset.thread)");
    assert.ok(rows.length >= 3 && rows.includes('bots-t1'), `conversations are listed: ${rows}`);
    assert.ok(await js("document.querySelector('#bots-u4-host [data-thread=bots-t1] .bots-tag')?.textContent === 'Main'"), 'the main conversation is marked');
    assert.equal(rows.length, 4, 'three recent conversations plus Main');
    assert.ok(!rows.includes('bots-t2'), 'an older non-main conversation starts collapsed');
    assert.equal(await text('#bots-u4-host .bots-conv-foot .bots-btn'), 'Show 2 more', 'the count excludes Main, already visible');
    assert.equal(await js("getComputedStyle(document.querySelector('#bots-u4-host .bots-hero-name')).fontFamily.includes('Geist')"), true);
    assert.ok(await js("document.getElementById('bots-u4-host').getBoundingClientRect().width === 320"), 'Simple is 320 px');
    await capture('bots-panel-simple');
    // A conversation opens its chat.
    await js("window.__nav.length = 0");
    await click('#bots-u4-host .bots-conv-foot .bots-btn');
    await click('#bots-u4-host [data-thread=bots-t2] .bots-conv-open');
    assert.deepEqual((await js('window.__nav')).at(-1), { tab: 'botsShell', agentId: 'a1', sessionId: 'bots-t2' });
    // Each conversation exposes its model without changing the bot's default.
    await click('#bots-u4-host [data-thread=bots-t2] [aria-label="Options for Weekly postings"]');
    await waitFor("!!document.querySelector('.bots-menu')");
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('Model:')).click()");
    await waitFor("!!document.querySelector('.bots-dialog .agent-model-picker')");
    assert.match(await text('.bots-dialog .modal-header'), /Model for Weekly postings/);
    assert.ok(await js("[...document.querySelectorAll('.bots-dialog .bots-btn')].some(n => n.textContent === 'Follow bot model')"));
    await closeDialogs();
    // New conversation makes one and opens it.
    start = writes.length;
    await click('#bots-u4-host .bots-conv-head .bots-btn');
    await waitWrite(start, '/api/agents/a1/threads', 'POST');
    await waitFor("window.__nav.at(-1)?.sessionId && window.__nav.at(-1).sessionId !== 'bots-t2'");
    // Gear -> Settings page, Back link, drill-down pages.
    await click('#bots-u4-host [aria-label="Settings"]');
    await waitFor("document.querySelector('#bots-u4-host .bots-page-title')?.textContent === 'Settings'");
    assert.match(await text('#bots-u4-host .bots-back'), /Details/);
    assert.ok(await exists('#bots-u4-host [data-panel-card="soul"] textarea'), 'instructions on the Settings page');
    assert.ok(await exists('#bots-u4-host [data-panel-card="permissions"]'));
    assert.equal(await js("document.querySelectorAll('#bots-u4-host [aria-label=Approval] [role=radio]:not([disabled])').length"), 1, 'approval offers only Full');
    assert.match(await js("document.querySelector('#bots-u4-host [aria-label=Approval] [role=radio]').textContent"), /Full access/);
    const more = await js("[...document.querySelectorAll('#bots-u4-host .bots-nav-row .bots-row-title')].map(n => n.textContent)");
    assert.deepEqual(more, ['Overview', 'Skills', 'Memory', 'Routines', 'Access', 'Voice and alerts', 'Who can see it', 'History', 'Usage'], 'every section that is not on Details or Settings');
    await js("[...document.querySelectorAll('#bots-u4-host .bots-nav-row')].find(n => n.textContent.includes('Access')).click()");
    await waitFor("document.querySelector('#bots-u4-host .bots-page-title')?.textContent === 'Access'");
    assert.match(await text('#bots-u4-host .bots-back'), /Settings/);
    await waitFor("!!document.querySelector('#bots-u4-host .bots-card-body .bots-switch')");
    // Escape pops one page, then the next, and only then would the host close the panel.
    await key('Escape', '#bots-u4-host .bots-back');
    await waitFor("document.querySelector('#bots-u4-host .bots-page-title')?.textContent === 'Settings'");
    await key('Escape', '#bots-u4-host .bots-back');
    await waitFor("!document.querySelector('#bots-u4-host .bots-page-title')");
    assert.equal(await js('window.__closed'), 0, 'Escape inside the panel did not close it');

    // Hero edits and the look popover.
    start = writes.length;
    await commit('#bots-u4-host .bots-hero-job', 'Watches postings and replies');
    const heroPatch = await waitWrite(start, '/api/agents/a1', 'PATCH');
    assert.deepEqual(JSON.parse(heroPatch.body), { role: 'Watches postings and replies' });
    await click('#bots-u4-host .bots-hero-edit');
    await waitFor("!!document.querySelector('#bots-u4-host .bots-popover .agent-avatar-picker')");
    await key('Escape', '#bots-u4-host .bots-popover button');
    await waitFor("!document.querySelector('#bots-u4-host .bots-popover')");

    // ======================= The panel, Advanced ======================================================================================================
    await setInterfaceMode(true);
    await mountPanel('advanced');
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-acc-item').length === 14");
    assert.deepEqual(await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-label')].map(n => n.textContent)"),
      ['Overview', 'Identity', 'Delivery', 'Soul', 'Skills', 'Memory', 'Routines', 'Access', 'Model', 'Permissions', 'Voice and alerts', 'Who can see it', 'History', 'Usage'], 'all fourteen sections');
    assert.equal(await js("document.querySelectorAll('#bots-u4-host .bots-acc-item[data-open=true]').length"), 1, 'one open at a time');
    assert.equal(await js("document.querySelector('#bots-u4-host .bots-acc-item[data-open=true]').dataset.section"), 'overview');
    assert.ok(await js("document.getElementById('bots-u4-host').getBoundingClientRect().width > 330"), 'Advanced is wider than Simple');
    // The overview: facts, the checklist, the prompt preview with bytes.
    assert.ok(await exists('#bots-u4-host .bots-glance'));
    assert.match(await text('#bots-u4-host .bots-glance'), /Watches postings and replies/);
    await js("document.querySelector('#bots-u4-host .bots-prompt').open = true");
    await waitFor("document.querySelector('#bots-u4-host .bots-prompt-summary')?.textContent.includes('bytes')");
    assert.match(await text('#bots-u4-host .bots-prompt-summary'), /What the model sees: [\d,]+ bytes, about [\d,]+ tokens/);
    const parts = await js("[...document.querySelectorAll('#bots-u4-host .bots-prompt-part summary')].map(n => n.textContent)");
    assert.ok(parts.length >= 3 && parts.every(p => /\(\d[\d,]* bytes\)/.test(p)), `each part shows its size: ${parts}`);
    assert.match(await text('#bots-u4-host .bots-prompt-body .bots-hint'), /provider adds its own system prompt/);
    await capture('bots-panel-advanced');
    // A checklist step opens the section that does it.
    await js("[...document.querySelectorAll('#bots-u4-host .bots-setup-step')].find(n => n.textContent.includes('standing instructions')).click()");
    await waitFor("document.querySelector('#bots-u4-host .bots-acc-item[data-open=true]')?.dataset.section === 'soul'");
    assert.ok(await exists('#bots-u4-host .bots-acc-item[data-open=true] textarea'));
    // Every step now has a section to open (routines too), so each is a link.
    await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-head')].find(n => n.dataset.section === 'overview').click()");
    await waitFor("document.querySelector('#bots-u4-host .bots-acc-item[data-open=true]')?.dataset.section === 'overview'");
    assert.equal(await js("[...document.querySelectorAll('#bots-u4-host .bots-setup-step')].find(n => n.textContent.includes('schedule')).tagName"), 'BUTTON');
    // Search filters by label and keyword.
    await fill('#bots-u4-host .bots-search', 'instructions');
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-acc-item').length === 1");
    assert.equal(await js("document.querySelector('#bots-u4-host .bots-acc-item').dataset.section"), 'soul');
    await fill('#bots-u4-host .bots-search', 'zzzz');
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-acc-item').length === 0");
    assert.match(await text('#bots-u4-host .bots-accordion'), /Nothing matches/);
    await fill('#bots-u4-host .bots-search', '');
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-acc-item').length === 14");

    // ======================= Edits: one debounced PATCH, rollback, model at once ======================================================================
    await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-head')].find(n => n.dataset.section === 'identity').click()");
    await waitFor("document.querySelector('#bots-u4-host .bots-acc-item[data-open=true]')?.dataset.section === 'identity'");
    start = writes.length;
    await commit(identityField(2), 'Finds remote roles');
    await delay(120);
    await commit(identityField(3, 'textarea'), 'Quiet and thorough.');
    await delay(120);
    await commit(identityField(4), 'Hiring');
    assert.equal(writesTo(start, '/api/agents/a1', 'PATCH').length, 0, 'nothing is sent while edits keep arriving');
    const merged = await waitWrite(start, '/api/agents/a1', 'PATCH');
    assert.deepEqual(JSON.parse(merged.body), { role: 'Finds remote roles', blurb: 'Quiet and thorough.', section: 'Hiring' }, 'one PATCH carries all three edits');
    await delay(700);
    assert.equal(writesTo(start, '/api/agents/a1', 'PATCH').length, 1, 'and only one');
    assert.deepEqual([(await botRow('a1')).role, (await botRow('a1')).section], ['Finds remote roles', 'Hiring']);

    // A rejected edit is rolled back, with the reason in a toast.
    await clearToasts();
    start = writes.length;
    await commit(identityField(1), 'Archivist');
    await waitWrite(start, '/api/agents/a1', 'PATCH');
    await waitFor("document.querySelectorAll('#toast-host .toast.error').length > 0");
    assert.match((await errorToasts()).join(' '), /already exists/);
    await waitFor(`document.querySelector(${q(identityField(1))})?.value === 'Scout'`);
    assert.equal((await botRow('a1')).name, 'Scout', 'the stored name is unchanged');
    assert.equal(await js("document.querySelector('#bots-u4-host [data-live-name]').textContent"), 'Scout', 'and the header shows it');
    await clearToasts();

    // A model change is sent at once, not after the wait.
    await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-head')].find(n => n.dataset.section === 'model').click()");
    await waitFor("!!document.querySelector('#bots-u4-host select[aria-label=Connection]')");
    start = writes.length;
    await js(`(() => { const s = document.querySelector('#bots-u4-host select[aria-label=Connection]'); s.value = 'm3'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const modelPatch = await waitWrite(start, '/api/agents/a1', 'PATCH', undefined, 8);   // about 400 ms at most
    assert.equal(JSON.parse(modelPatch.body).endpoint_id, 'm3');
    assert.equal((await botRow('a1')).endpoint_id, 'm3');

    // Access: tool servers, with the choice kept.
    await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-head')].find(n => n.dataset.section === 'access').click()");
    await waitFor("!!document.querySelector('#bots-u4-host .bots-acc-item[data-open=true] .bots-card-body .bots-switch')");
    start = writes.length;
    await click('#bots-u4-host .bots-acc-item[data-open=true] .bots-card-body .bots-switch-row');   // "Every connected tool server" -> off
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-acc-item[data-open=true] .bots-card-body .bots-switch-row').length > 1");
    const picked = JSON.parse((await waitWrite(start, '/api/agents/a1', 'PATCH')).body);
    assert.ok(Array.isArray(picked.integration_ids), 'turning off "every server" sends a list');
    await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-head')].find(n => n.dataset.section === 'permissions').click()");
    await waitFor("!!document.querySelector('#bots-u4-host [data-panel-card=permissions]')");
    assert.equal(await js("document.querySelectorAll('#bots-u4-host [data-panel-card=permissions] [aria-label=Approval] [role=radio]:not([disabled])').length"), 1, 'approval offers only Full');
    await clearToasts();
    await commit('#bots-u4-host [data-panel-card=permissions] .bots-text-row input', '500');
    assert.match((await errorToasts()).join(' '), /1 to 200/, 'a bad run cap is refused before sending');
    await clearToasts();

    // History and Usage are real, derived from what the bot has done.
    await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-head')].find(n => n.dataset.section === 'history').click()");
    await waitFor("!!document.querySelector('#bots-u4-host [data-panel-card=history]')");
    assert.match(await text('#bots-u4-host [data-panel-card=history]'), /Settings version/);
    await js("[...document.querySelectorAll('#bots-u4-host .bots-acc-head')].find(n => n.dataset.section === 'usage').click()");
    await waitFor("!!document.querySelector('#bots-u4-host [data-panel-card=usage] .bots-meter')");
    assert.match(await text('#bots-u4-host [data-panel-card=usage]'), /of 12 daily runs used/);

    // ======================= Deep links ===============================================================================================================
    await mountPanel('advanced', { section: 'soul' });
    await waitFor("document.querySelector('#bots-u4-host .bots-acc-item[data-open=true]')?.dataset.section === 'soul'");
    assert.ok(await exists('#bots-u4-host .bots-acc-item[data-open=true] textarea'), 'the link lands on Soul in Advanced');
    assert.equal(await js("localStorage.getItem('kairos:bots-last-section')"), 'soul', 'the last section is remembered on this device');
    await mountPanel('advanced');
    await waitFor("document.querySelector('#bots-u4-host .bots-acc-item[data-open=true]')?.dataset.section === 'soul'");
    await mountPanel('simple', { section: 'soul' });
    await waitFor("document.querySelector('#bots-u4-host .bots-page-title')?.textContent === 'Settings'");
    assert.ok(await exists('#bots-u4-host [data-panel-card="soul"] textarea'), 'and on the instructions card in Simple');
    await mountPanel('simple', { section: 'usage' });
    await waitFor("document.querySelector('#bots-u4-host .bots-page-title')?.textContent === 'Usage'");
    assert.match(await text('#bots-u4-host .bots-back'), /Settings/);
    await js("window.__panel.openSection('access')");
    await waitFor("document.querySelector('#bots-u4-host .bots-page-title')?.textContent === 'Access'", 4000);
    assert.equal(await js("window.__panel.openSection('nope')"), false, 'an unknown section is refused, not drawn');
    // A section another phase registers appears without any change here.
    await js(`import('/static/js/botsPanel.js').then(P => { P.registerBotSection({ id: 'probe', label: 'Probe', iconName: 'zap', order: 90, keywords: 'later phase', render: () => { const n = document.createElement('p'); n.id = 'probe-body'; n.textContent = 'registered later'; return n; } }); return true; })`);
    await mountPanel('advanced', { section: 'probe' });
    await waitFor("!!document.querySelector('#probe-body')");
    assert.equal(await js("document.querySelectorAll('#bots-u4-host .bots-acc-item').length"), 15);

    // ======================= Archive with Undo, the Archived panel, duplicate ============================================================================
    await mountPanel('simple');
    await waitFor("!!document.querySelector('#bots-u4-host .bots-hero-name')");
    start = writes.length;
    await click('#bots-u4-host [aria-label="Bot menu"]');
    await waitFor("!!document.querySelector('.bots-menu')");
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('Archive')).click()");
    await waitFor("!!document.querySelector('.confirm-panel')");
    assert.match(await text('.confirm-panel'), /routines keep running/, 'the confirm says routines keep running');
    assert.match(await text('.confirm-panel'), /turn it off/);
    await confirmYes();   // Archive (not a danger action)
    const hid = await waitWrite(start, '/api/agents/a1', 'PATCH');
    assert.deepEqual(JSON.parse(hid.body), { hidden: true });
    assert.equal((await botRow('a1')).hidden, true);
    await waitFor("!!document.querySelector('.bots-notice')");
    assert.match(await text('.bots-notice'), /Scout is archived/);
    assert.match(await text('.bots-notice .bots-notice-action'), /Undo/);
    await capture('bots-archive-notice');
    start = writes.length;
    await click('.bots-notice .bots-notice-action');
    const back = await waitWrite(start, '/api/agents/a1', 'PATCH');
    assert.deepEqual(JSON.parse(back.body), { hidden: false });
    assert.equal((await botRow('a1')).hidden, false, 'Undo brings it back');
    await waitFor("!document.querySelector('.bots-notice')");

    // Archive Archivist, open the Archived panel, restore it; archive again and delete from there.
    const alreadyArchived = store().agents.filter(a => a.hidden).map(a => a.id);
    await call('/api/agents/a2', 'PATCH', { hidden: true });
    await js("import('/static/js/botsArchived.js').then(m => { m.openArchivedBots(); return true; })");
    await waitFor("!!document.querySelector('.bots-archived-row[data-agent=a2]')");
    assert.ok(await js("[...document.querySelectorAll('.bots-archived-row')].every(r => r.dataset.agent !== 'a1')"), 'only archived bots are listed');
    await capture('bots-archived');
    start = writes.length;
    await js("document.querySelector('.bots-archived-row[data-agent=a2] .bots-btn').click()");
    await waitWrite(start, '/api/agents/a2', 'PATCH');
    await waitFor("!document.querySelector('.bots-archived-row[data-agent=a2]')");
    assert.equal((await botRow('a2')).hidden, false, 'Restore brings it back');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-archived-row')].map(r => r.dataset.agent).sort()"), [...alreadyArchived].sort(), 'Restore leaves the previously archived bots alone');
    if (!alreadyArchived.length) assert.match(await text('.bots-archived-list'), /Nothing is archived/);
    assert.equal(await js("[...document.querySelectorAll('.bots-dialog-footer .bots-btn')].filter(b => b.disabled).length"), alreadyArchived.length ? 0 : 2, 'bulk actions are enabled exactly when archived bots remain');
    await closeDialogs();
    // Delete from the Archived panel, with its confirm and the server's guard.
    await call('/api/agents/a2', 'PATCH', { hidden: true });
    await js("import('/static/js/botsArchived.js').then(m => { m.openArchivedBots(); return true; })");
    await waitFor("!!document.querySelector('.bots-archived-row[data-agent=a2]')");
    start = writes.length;
    await js("document.querySelector('.bots-archived-row[data-agent=a2] .bots-btn.danger').click()");
    await waitFor("!!document.querySelector('.confirm-panel')");
    assert.match(await text('.confirm-panel'), /Delete Archivist\?/);
    await confirmYes();
    await waitWrite(start, '/api/agents/a2', 'DELETE');
    await waitFor("!document.querySelector('.bots-archived-row[data-agent=a2]')");
    assert.equal(store().agents.some(a => a.id === 'a2'), false);
    await closeDialogs();
    await clearToasts();

    // Duplicate from the panel menu.
    start = writes.length;
    await click('#bots-u4-host [aria-label="Bot menu"]');
    await waitFor("!!document.querySelector('.bots-menu')");
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('Duplicate')).click()");
    await waitWrite(start, '/api/agents/a1/duplicate', 'POST');
    const copy = store().agents.find(a => a.name === 'Scout copy');
    assert.ok(copy && copy.role === 'Finds remote roles' && copy.origin.kind === 'duplicate' && copy.origin.from_agent_id === 'a1', 'a copy with the same profile');
    assert.equal(store().memories?.[copy.id], undefined, 'and no notes');
    await waitFor(`window.__nav.at(-1)?.agentId === ${q(copy.id)}`);

    // ======================= Conversations: select and delete ==================================================================================================
    await mountPanel('simple');
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-conv-row').length >= 3");
    const total = store().threads.filter(t => t.agent_id === 'a1').length;
    await js("[...document.querySelectorAll('#bots-u4-host .bots-conv-head .bots-btn')].find(n => n.textContent === 'Select').click()");
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-conv-row input[type=checkbox]').length >= 3");
    await js("[...document.querySelectorAll('#bots-u4-host .bots-conv-bulk .bots-btn')].find(n => n.textContent === 'Select all').click()");
    await waitFor("[...document.querySelectorAll('#bots-u4-host .bots-conv-bulk .bots-btn')].some(n => n.textContent.startsWith('Delete (') && !n.disabled)");
    start = writes.length;
    await js("[...document.querySelectorAll('#bots-u4-host .bots-conv-bulk .bots-btn')].find(n => n.textContent.startsWith('Delete (')).click()");
    await waitFor("!!document.querySelector('.confirm-panel')");
    assert.match(await text('.confirm-panel'), /at least one/, 'the confirm says a bot always keeps one conversation');
    await confirmYes();
    const bulk = await waitWrite(start, '/api/agents/a1/threads/delete', 'POST');
    assert.equal(JSON.parse(bulk.body).thread_ids.length, total, 'Select all includes collapsed conversations');
    await waitFor("document.querySelectorAll('#bots-u4-host .bots-conv-row').length === 1");
    assert.ok(store().threads.filter(t => t.agent_id === 'a1').length === 1 && total > 1, 'one conversation is always kept');
    await clearToasts();

    // ======================= Look: a phone-width Advanced dialog fills the screen ==================================================================================
    await closeDialogs();
    await js("window.__panel?.destroy(); document.getElementById('bots-u4-host')?.remove()");
    await setInterfaceMode(true);
    phone = true;
    win.setContentSize(390, 844);
    await delay(400);
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot(); return true; })");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog.advanced .bots-create-nav')");
    await delay(450);   // the sheet settles
    const box = await js("(() => { const r = document.querySelector('.panel-dialog.bots-create-dialog.advanced').getBoundingClientRect(); return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight, radius: getComputedStyle(document.querySelector('.panel-dialog.bots-create-dialog.advanced')).borderTopLeftRadius }; })()");
    assert.ok(box.w >= box.iw - 2, `full width on a phone: ${JSON.stringify(box)}`);
    assert.ok(box.h >= box.ih * 0.85, `full height on a phone: ${JSON.stringify(box)}`);
    assert.equal(box.radius, '0px', 'no rounded corners when it fills the screen');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-create-nav')).flexDirection"), 'row', 'the section nav runs along the top');
    assert.ok((await js("document.querySelector('.bots-create-dialog.advanced .modal-body').scrollWidth <= document.querySelector('.bots-create-dialog.advanced .modal-body').clientWidth + 2")), 'nothing scrolls sideways');
    await capture('bots-create-phone');
    await closeDialogs();
    await js("import('/static/js/botsCreate.js').then(m => { m.openNewBot({ gallery: true }); return true; })");
    await waitFor("document.querySelectorAll('.bots-ready-card').length >= 10");
    await delay(400);
    assert.ok(await js("document.querySelector('.bots-gallery-dialog').getBoundingClientRect().width >= innerWidth - 2"), 'the phone gallery fills the screen');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-gallery-grid')).gridTemplateColumns.split(' ').length"), 1, 'one column on a phone');
    assert.ok(await js("document.querySelector('.bots-gallery-dialog .modal-body').scrollWidth <= document.querySelector('.bots-gallery-dialog .modal-body').clientWidth + 2"), 'the gallery does not scroll sideways');
    await capture('bots-gallery-phone');
    await closeDialogs();
    win.setContentSize(1440, 900);
    phone = false;
    await delay(300);

    // ======================= Reduced motion and an Appearance change ===========================================================================================================
    await setInterfaceMode(false);
    await mountPanel('simple');
    await waitFor("!!document.querySelector('#bots-u4-host .bots-hero-name')");
    await reduce(true);
    await js("document.querySelector('#bots-u4-host .bots-panel').classList.add('bots-panel-in')");
    assert.equal(await js("getComputedStyle(document.querySelector('#bots-u4-host .bots-panel')).animationName"), 'none', 'reduced motion stops the panel entrance');
    await reduce(false);
    const paint = () => js("(() => { const c = document.querySelector('#bots-u4-host .bots-panel'); return getComputedStyle(c).backgroundColor + '|' + getComputedStyle(c.querySelector('.bots-hero-name')).color; })()");
    const savedAppearance = await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); return { mode: a.mode, color: a.color }; })");
    try {
      await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: '#f3eadb' }))");
      await delay(200);
      const light = await paint();
      await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: '#1f1d24' }))");
      await waitFor(`(() => { const c = document.querySelector('#bots-u4-host .bots-panel'); return (getComputedStyle(c).backgroundColor + '|' + getComputedStyle(c.querySelector('.bots-hero-name')).color) !== ${q(light)}; })()`, 4000);
      await capture('bots-panel-dark');
    } finally {
      await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${q(savedAppearance)}))`);
    }

    // The renderer never raised an error toast we did not expect, and nothing leaked a dialog.
    assert.deepEqual(await errorToasts(), [], 'no stray error toast');
    assert.deepEqual(await js('window.__botsErrs'), [], 'no renderer errors or unhandled rejections');
    assert.equal(await js("document.querySelectorAll('.modal-backdrop').length"), 0, 'no dialog left open');
  } catch (error) {
    const seen = await js('window.__botsErrs || []').catch(() => []);
    if (seen.length) console.error(['Renderer errors seen during the check:', ...seen].join('\n'));
    const where = await js("[...document.querySelectorAll('.modal-backdrop > *')].map(n => n.className + ' :: ' + n.textContent.slice(0, 160))").catch(() => []);
    if (where.length) console.error(['Open dialogs at the failure:', ...where].join('\n'));
    throw error;
  } finally {
    if (phone) win.setContentSize(1440, 900);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    await js(`(async () => {
      try { window.__panel?.destroy(); } catch (e) {}
      document.getElementById('bots-u4-host')?.remove();
      document.querySelectorAll('.modal-backdrop, .bots-menu, .bots-notice').forEach(n => n.remove());
      document.documentElement.classList.remove('panel-dialog-open');
      const prior = window.__botsCreatePriorMode;
      if (prior) document.documentElement.dataset.appMode = prior; else delete document.documentElement.dataset.appMode;
      try { localStorage.setItem('kairos:bots-interface', ${q(savedInterface)}); if (!${q(savedInterface)}) localStorage.removeItem('kairos:bots-interface');
        if (${q(savedSection)} === null) localStorage.removeItem('kairos:bots-last-section'); else localStorage.setItem('kairos:bots-last-section', ${q(savedSection)}); } catch (e) {}
      const U = await import('/static/js/botsUi.js'); U.resetBotsInterfaceForTest();
      delete window.__panel; delete window.__nav; delete window.__changed; delete window.__closed; delete window.__botsCreatePriorMode;
      return true;
    })()`).catch(() => {});
    await restore();
  }
};
