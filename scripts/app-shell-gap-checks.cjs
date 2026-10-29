// A01 remaining automatable gaps (Part 2, 2026-10-27), run from app-shell-checks.cjs:
// badges clear and cap, phone notifications and background sheets, the Library
// document leave guard, Vault drafts across Cancel / another note / reopen, and
// Profile's Admin and Member text. Restores every fixture it changes.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, capture, demoState, fixtures, press }) => {
  const size = async (w, h) => { win.setContentSize(w, h); await delay(400); };
  const clickText = (selector, text) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const refreshBadge = () => js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed')), true");
  const navBadge = "document.querySelector('#nav .nav-item[data-tab=botsHome] .nav-badge')?.textContent || ''";  // Agents became the Bots mode: its nav item carries the count
  const tabBadge = "(b => b && !b.hidden ? b.textContent.trim() : '')(document.querySelector('.ms-tabbar [data-badge=bots] .ms-tabbar-badge'))";
  const escape = () => press('Escape', 'Escape', 27);

  // -- badges ----------------------------------------------------------------
  const inbox = fixtures.agentInbox;
  const saved = inbox.splice(0), savedReview = demoState.agentReview;
  try {
    demoState.agentReview = false;
    await size(1440, 900); await navigate('botsHome'); await waitFor("!!document.querySelector('#nav .nav-item[data-tab=botsHome]')"); await refreshBadge();
    await waitFor(`${navBadge} === ''`);
    assert.equal(await js("document.querySelector('#nav .nav-item[data-tab=botsHome]').getAttribute('aria-label')"), 'Bots', 'an empty inbox clears the badge and its label');
    inbox.push(...saved); await refreshBadge();
    await waitFor(`${navBadge} === ${JSON.stringify(String(saved.length))}`);
    inbox.push(...Array.from({ length: 100 }, (_, i) => ({ ...saved[0], id: `bulk-${i}` }))); await refreshBadge();
    // Badge and label are written together; wait for both so an earlier refresh still in flight cannot interleave.
    await waitFor(`${navBadge} === '99+' && document.querySelector('#nav .nav-item[data-tab=botsHome]').getAttribute('aria-label') === ${JSON.stringify(`Bots, ${saved.length + 100} waiting on you`)}`)
      .catch(async () => assert.fail(`a large count caps the badge at 99+ but keeps the real number in its label: ${JSON.stringify(await js(`[${navBadge}, document.querySelector('#nav .nav-item[data-tab=botsHome]').getAttribute('aria-label')]`))}`));
    await size(390, 844); await navigate('botsHome');
    await waitFor(`${tabBadge} === '99+'`);
    inbox.splice(0); await refreshBadge();
    await waitFor(`${tabBadge} === ''`);
    assert.equal(await js("document.querySelector('.ms-tabbar [data-badge=bots]').getAttribute('aria-label')"), 'Bots', 'the phone tab bar clears its badge and label too');
  } finally {
    inbox.splice(0, inbox.length, ...saved); demoState.agentReview = savedReview; await refreshBadge();
  }
  await waitFor(`${tabBadge} === ${JSON.stringify(String(saved.length + (savedReview ? 1 : 0)))}`);
  await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
  console.log('PASS: badges clear at zero, cap at 99+, desktop and phone agree');

  // -- phone notifications sheet --------------------------------------------
  await navigate('home');
  await waitFor("!!document.querySelector('.hm-phone-notifications')?.getClientRects().length");
  await js("document.querySelector('.hm-phone-notifications').click()");
  await waitFor("!!document.querySelector('dialog.ms-notifications-sheet[open]')");
  const sheet = await js(`(() => ({ sections: [...document.querySelectorAll('.ms-notifications-sheet h3, .ms-notifications-sheet [class*=ms-notification-] > h3')].map(h => h.textContent.trim()),
    rows: document.querySelectorAll('.ms-notifications-sheet .ms-notification-row').length,
    text: document.querySelector('.ms-notifications-sheet').textContent }))()`);
  assert.ok(sheet.rows >= 1 && sheet.text.includes('Needs you'), `the notifications sheet lists what needs you ${JSON.stringify(sheet)}`);
  await capture('app-shell-phone-notifications');
  await escape();
  await waitFor("!document.querySelector('dialog.ms-notifications-sheet')");
  assert.equal(await js("document.activeElement?.classList.contains('hm-phone-notifications')"), true, 'closing the notifications sheet returns focus to its button');
  await js("document.querySelector('.hm-phone-notifications').click()");
  await waitFor("!!document.querySelector('dialog.ms-notifications-sheet[open] .ms-notification-row')");
  // A row opens the bot it is about (Bots mode), which the in-memory Bots backend answers.
  const priorBots = { live: demoState.botsLive, attention: demoState.botsAttention };
  demoState.botsLive = true; demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
  await js("document.querySelector('.ms-notifications-sheet .ms-notification-row').click()");
  await waitFor("!document.querySelector('dialog.ms-notifications-sheet')");
  await waitFor("document.documentElement.dataset.appMode === 'bots' && (!!document.querySelector('.bots-composer-input') || !!document.querySelector('.bots-home .bots-grid'))");
  await delay(800);
  await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
  // botsLive stays on for the rest of this file (a bot page's late polls must still be answered); restored at the end.
  console.log('PASS: phone notifications sheet lists, closes, returns focus and opens a row');

  // -- phone background-tasks sheet ------------------------------------------
  await navigate('chat', { sessionId: 's1' });
  await waitFor("!!document.querySelector('#chat-messages[data-session-id=\"s1\"]')");
  const packet = items => `document.dispatchEvent(new CustomEvent('kairos:bg-tasks', { detail: { sessionId: 's1', items: ${JSON.stringify(items)}, notes: [] } })), true`;
  const now = Date.now() / 1000;
  await js(packet([{ id: 't1', kind: 'command', label: 'npm test', status: 'running', startedAt: now - 30, activity: 'Running 40 tests' },
    { id: 't2', kind: 'agent', label: 'Research helper', status: 'waiting', startedAt: now - 90 }]));
  await waitFor("!!document.querySelector('.bg-tasks-pill')?.getClientRects().length");
  await js("document.querySelector('.bg-tasks-pill').click()");
  await waitFor("!!document.querySelector('dialog.ms-background-sheet[open]')");
  const bg = await js(`(() => ({ rows: [...document.querySelectorAll('.ms-background-sheet .bg-task-row')].map(r => r.dataset.itemId + ':' + r.dataset.status),
    summary: document.querySelector('.ms-background-sheet .bg-tasks-summary')?.textContent || '' }))()`);
  assert.deepEqual(bg.rows, ['t1:running', 't2:waiting'], 'the background sheet lists the running and waiting work');
  assert.ok(/1 running/.test(bg.summary) && /1 waiting/.test(bg.summary), `the summary counts them: ${bg.summary}`);
  await capture('app-shell-phone-background');
  await js("document.querySelector('.ms-background-sheet .ms-sheet-header button[aria-label=Close]').click()");
  await waitFor("!document.querySelector('dialog.ms-background-sheet')");
  assert.equal(await js("document.querySelector('.bg-tasks-pill').getAttribute('aria-expanded')"), 'false', 'the pill says the sheet is closed');
  assert.equal(await js("document.activeElement?.classList.contains('bg-tasks-pill')"), true, 'closing the sheet returns focus to the pill');
  await js(packet([]));
  await waitFor("!document.querySelector('.bg-tasks-pill')?.getClientRects().length");
  console.log('PASS: phone background sheet lists work, closes, returns focus and hides when empty');

  // -- Library document leave guard -------------------------------------------
  for (const [label, w, h, homeButton] of [['desktop', 1440, 900, '#sidebar .nav-item[data-tab=home]'], ['phone', 390, 844, '.ms-tabbar [data-tabbar=home]']]) {
    await size(w, h);
    await navigate('library', { section: 'documents' });
    await waitFor("!!document.querySelector('.library-document-card')");
    await js("document.querySelector('.library-document-card').click()");
    await waitFor("!!document.querySelector('.library-editor textarea')");
    const original = await js("document.querySelector('.library-editor textarea').value");
    await js("(() => { const t = document.querySelector('.library-editor textarea'); t.value += ' Unsaved edit.'; t.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await js(`document.querySelector(${JSON.stringify(homeButton)}).click()`);
    await waitFor("document.querySelector('.confirm-panel')?.textContent.includes('Discard unsaved changes?')");
    await clickText('.confirm-panel .btn', 'Cancel');
    await waitFor("!document.querySelector('.confirm-panel')");
    assert.equal(await js("document.documentElement.dataset.view"), 'library', `${label}: Cancel keeps the document open`);
    assert.ok(await js("document.querySelector('.library-editor textarea').value.endsWith(' Unsaved edit.')"), `${label}: Cancel keeps the unsaved edit`);
    await js(`document.querySelector(${JSON.stringify(homeButton)}).click()`);
    await waitFor("!!document.querySelector('.confirm-panel')");
    await clickText('.confirm-panel .btn', 'Discard changes');
    await waitFor("document.documentElement.dataset.view === 'home'");
    await navigate('library', { section: 'documents' });
    await waitFor("!!document.querySelector('.library-document-card')");
    await js("document.querySelector('.library-document-card').click()");
    await waitFor("!!document.querySelector('.library-editor textarea')");
    assert.equal(await js("document.querySelector('.library-editor textarea').value"), original, `${label}: after Discard the document reopens as saved`);
    await navigate('home');
  }
  await size(1440, 900);
  console.log('PASS: Library document leave guard: Cancel keeps the edit, Discard drops it, reopen shows the saved text');

  // -- Vault drafts: editor Cancel, another note, reopen -------------------------
  demoState.vault = undefined;
  const cm = code => js(`import('/static/js/vendor/forge-vendor.js').then(cm => { const view = cm.EditorView.findFromDOM(document.querySelector('.vault-editor .cm-editor')); ${code} })`);
  const openNote = async name => {
    await js("(() => { const f = [...document.querySelectorAll('.library-vault-folder')].find(d => d.querySelector('summary').textContent.includes('Projects')); if (!f.open) f.querySelector('summary').click(); })()");
    await delay(150);
    await js(`[...document.querySelectorAll('.library-vault-note')].find(n => n.querySelector('.vault-row-name')?.textContent === ${JSON.stringify(name)}).click()`);
  };
  await navigate('library', { section: 'vault' });
  await waitFor("!!document.querySelector('.vault-home-grid')");
  await openNote('Projects');
  await waitFor("document.querySelector('.vault-note-title')?.textContent.startsWith('Projects')");
  await clickText('.library-vault-reader-actions .btn', 'Edit');
  await waitFor("!!document.querySelector('.vault-editor .cm-editor')");
  await cm("view.dispatch({ changes: { from: view.state.doc.length, insert: '\\nDraft that must not survive Discard.\\n' } });");
  await waitFor("document.querySelector('.vault-note-title').classList.contains('dirty')");
  await clickText('.vault-editor-bar .btn', 'Done');
  await waitFor("[...document.querySelectorAll('.confirm-panel')].some(d => d.textContent.includes('Discard note edits?'))");
  await clickText('.confirm-panel .btn', 'Cancel');
  await waitFor("!document.querySelector('.confirm-panel')");
  assert.ok(await js("document.querySelector('.vault-editor .cm-content').textContent.includes('Draft that must not survive Discard.')"), 'the editor Done button asks first, and Cancel keeps the draft');
  await openNote('Projects note 1');
  await waitFor("[...document.querySelectorAll('.confirm-panel')].some(d => d.textContent.includes('Discard note edits?'))");
  await js("[...document.querySelectorAll('.confirm-panel .btn')].find(b => /Discard/.test(b.textContent)).click()");
  await waitFor("document.querySelector('.vault-note-title')?.textContent.startsWith('Projects note 1') && !document.querySelector('.vault-editor')");
  await openNote('Projects');
  await waitFor("document.querySelector('.vault-note-title')?.textContent.startsWith('Projects') && !!document.querySelector('.vault-note-body')");
  assert.equal(await js("document.querySelector('.vault-note-body').textContent.includes('Draft that must not survive Discard.')"), false, 'after Discard the note reopens as saved');
  assert.equal(await js("document.querySelector('.vault-note-title').classList.contains('dirty')"), false, 'and without the unsaved dot');
  await clickText('.library-vault-reader-actions .btn', 'Edit');
  await waitFor("!!document.querySelector('.vault-editor .cm-editor')");
  assert.equal(await js("document.querySelector('.vault-editor .cm-content').textContent.includes('Draft that must not survive Discard.')"), false, 'editing again starts from the saved text');
  await clickText('.vault-editor-bar .btn', 'Done');
  await navigate('home');
  console.log('PASS: Vault drafts: editor Done asks, another note asks, Discard drops the draft, reopen shows the saved note');

  // -- Profile role text with accounts on -------------------------------------
  await js(`(() => { window.__roleFetch = window.fetch; window.__roleStatus = null;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (window.__roleStatus && url.pathname === '/api/auth/status') {
        return Promise.resolve(new Response(JSON.stringify(window.__roleStatus), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return window.__roleFetch(input, init);
    }; return true; })()`);
  try {
    for (const [status, name, role, permissions] of [
      [{ auth_enabled: true, setup_required: false, username: 'david', is_admin: true }, 'david', 'Admin', true],
      [{ auth_enabled: true, setup_required: false, username: 'sam', is_admin: false }, 'sam', 'Member', false],
    ]) {
      await js(`window.__roleStatus = ${JSON.stringify(status)}, true`);
      await js("import('/static/js/workspaceProfile.js').then(m => m.openWorkspaceProfile(document.body))");
      await waitFor("!!document.querySelector('.workspace-profile-identity .meta')");
      const shown = await js(`(() => ({ name: document.querySelector('.workspace-profile-identity strong').textContent,
        role: document.querySelector('.workspace-profile-identity .meta').textContent,
        permissions: [...document.querySelectorAll('.workspace-profile-setting')].some(b => b.textContent.includes('Permissions')) }))()`);
      assert.deepEqual(shown, { name, role, permissions }, `${role}: Profile shows the account, its role and only the links it may use`);
      await escape();
      await waitFor("!document.querySelector('.workspace-profile-panel')");
    }
  } finally {
    await js("window.fetch = window.__roleFetch, window.__roleStatus = null, true");
  }
  console.log('PASS: Profile shows Admin and Member with accounts on, Permissions only for admins');
  for (const [key, value] of [['botsLive', priorBots.live], ['botsAttention', priorBots.attention]]) { if (value === undefined) delete demoState[key]; else demoState[key] = value; }
};
