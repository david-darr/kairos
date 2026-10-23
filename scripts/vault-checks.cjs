// Library > Vault (Library Vault Polish, locked 2026-10-22), against the
// synthetic backend (demo/fixtures.js). Run by ui-smoke.cjs at desktop
// (1440x900) and phone (390x844) sizes:
//   await require('./vault-checks.cjs').run({ ...ctx, label })
// Every write stays in the test process; no real vault is touched.
const assert = require('node:assert/strict');

async function run(ctx) {
  const { js, waitFor, delay, navigate, capture, overflow, writes, demoState, label, win } = ctx;
  let assertions = 0;
  const ok = (value, message) => { assertions++; assert.ok(value, `${label}: ${message}`); };
  const eq = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, `${label}: ${message}`); };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = (selector, text) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const since = start => writes.slice(start);
  const cm = code => js(`import('/static/js/vendor/forge-vendor.js').then(cm => { const view = cm.EditorView.findFromDOM(document.querySelector('.vault-editor .cm-editor')); ${code} })`);
  const small = scope => js(`[...document.querySelectorAll(${JSON.stringify(scope)})].filter(n => !n.disabled && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').filter(n => { const r = n.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map(n => (n.getAttribute('aria-label') || n.textContent || n.placeholder || n.className).trim().slice(0, 30) + ' ' + Math.round(n.getBoundingClientRect().width) + 'x' + Math.round(n.getBoundingClientRect().height))`);
  // Fresh vault state for each size.
  demoState.vault = undefined;
  const phone = label === 'mobile';

  await navigate('library', { section: 'vault' });
  await waitFor("!!document.querySelector('.vault-home-grid')");
  await delay(300);

  // -- One header, Home instead of a dead end -------------------------------------
  ok(await js("!document.querySelector('.library-vault-intro, .library-vault-modes')"), 'the VAULT eyebrow, second description and mode switch are gone');
  ok(await js("[...document.querySelectorAll('.vault-mode-pill')].map(b => b.textContent.trim()).join() === 'Home,Map'"), 'Home and Map are pills in the sidebar head');
  ok(await js("document.querySelector('.vault-create-today')?.textContent === \"Create today's note\""), "Home offers today's note from the template");
  ok(await js("[...document.querySelectorAll('.vault-home-card h3')].map(h => h.firstChild.textContent).join() === 'Today,Pinned,Daily notes,Recently changed,Needs attention,Browse by property'"), 'Home has its six cards');
  ok(await js("document.querySelectorAll('.vault-month-day.has-note').length >= 15"), 'the month strip marks the days with a note');
  ok(await js("[...document.querySelectorAll('.vault-home-card')].find(c => c.textContent.startsWith('Pinned')).textContent.includes('Projects')"), 'Pinned shows the pinned note');
  ok(await js("[...document.querySelectorAll('.vault-home-card')].find(c => c.textContent.startsWith('Recently changed')).textContent.includes('Chat: Connecting ideas across the vault')"), 'Recently changed names the chat that changed a note');
  if (phone) {
    ok(await js("document.querySelector('.vault-home-host').parentElement.classList.contains('library-vault-sidebar')"), 'phone: Home sits on the list page above the folders');
    await waitFor("!!document.querySelector('.ms-dock input')");
    eq(await js("document.querySelector('.ms-dock input').placeholder"), 'Search vault', 'phone: the vault search is in the dock');
    eq(await js("[...document.querySelectorAll('.ms-dock button')].map(b => b.getAttribute('aria-label'))"), ["Today's note"], "phone: the dock's + is Today's note");
    eq(await small('.library-vault-browser button, .library-vault-browser summary, .ms-dock button, .ms-dock input'), [], 'phone: list page controls are 44px');
    await delay(300);
    const barDock = await js("(() => { const bar = document.querySelector('.ms-tabbar'); const dock = document.querySelector('.ms-dock'); if (!bar || !dock) return null; return { up: document.documentElement.classList.contains('ms-tabbar-up'), dock: dock.getBoundingClientRect().bottom, bar: bar.getBoundingClientRect().top }; })()");
    ok(barDock && barDock.up && barDock.dock <= barDock.bar + 0.5, 'phone: the tab bar shows on the list page and the dock sits above it: ' + JSON.stringify(barDock));
  }
  await capture(label + '-vault-home');
  eq(await overflow(), [], 'Vault Home has no overflow');

  // -- The tree: folder icons, natural sort, index first, dailies newest first ------
  await js("[...document.querySelectorAll('.library-vault-folder-summary')].find(s => s.textContent.includes('Daily notes')).click()");
  await delay(150);
  const daily = await js("[...[...document.querySelectorAll('.library-vault-folder')].find(d => d.querySelector('summary').textContent.includes('Daily notes')).querySelectorAll(':scope > .library-vault-children > *')].map(n => n.classList.contains('vault-month-head') ? '#' + n.textContent : n.querySelector('.vault-row-name').textContent + (n.querySelector('.vault-row-tag') ? '*' : ''))");
  eq(daily[0], 'Daily notes*', 'the folder index note is first, labelled Index');
  const dated = daily.filter(n => /^\d{4}-/.test(n));
  eq(dated, [...dated].sort().reverse(), 'daily notes are newest first');
  ok(daily.some(n => n.startsWith('#')), 'dated notes have month headers');
  ok(await js("document.querySelector('.library-vault-folder-summary svg') !== null"), 'folders have a folder icon');
  eq(await js("[...document.querySelectorAll('.vault-group-folders > .vault-group-body > .library-vault-folder > summary .vault-row-name')].map(n => n.textContent)"), ['Daily notes', 'Learning', 'Personal', 'Projects', 'Resources'], 'folders are in natural order');
  await js("[...document.querySelectorAll('.library-vault-folder-summary')].find(s => s.textContent.includes('Projects')).click()");
  await delay(150);
  const projects = await js("[...[...document.querySelectorAll('.library-vault-folder')].find(d => d.querySelector('summary').textContent.includes('Projects')).querySelectorAll('.library-vault-note .vault-row-name')].map(n => n.textContent)");
  eq(projects.slice(0, 4), ['Projects', 'Projects note 1', 'Projects note 2', 'Projects note 3'], 'natural sort puts note 2 before note 10');
  ok(projects.indexOf('Projects note 2') < projects.indexOf('Projects note 10'), 'note 2 comes before note 10');

  // -- Full-text search with highlighting -----------------------------------------------
  const searchField = '.library-vault-search'; // on a phone it lives in the dock
  await js(`(() => { const i = document.querySelector('${searchField}'); i.value = 'connected place'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor("!!document.querySelector('.vault-group-text .vault-search-hit mark')");
  eq(await js("[...document.querySelectorAll('.vault-group-text .vault-search-hit mark')].map(m => m.textContent).slice(0, 2)"), ['connected', 'place'], 'a phrase inside a note body is found with its words highlighted');
  ok(await js("document.querySelector('.vault-group-text .vault-search-hit .vault-row-name').textContent === 'Projects'"), 'the hit names its note');
  await capture(label + '-vault-search');
  await click('.vault-group-text .vault-search-hit');
  await waitFor("!!document.querySelector('.vault-note-body') && document.querySelector('.vault-note-title').textContent.startsWith('Projects')");
  await js(`(() => { const i = document.querySelector('${searchField}'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await delay(200);

  // -- The reader --------------------------------------------------------------------
  ok(await js("document.querySelector('.vault-note-body h1')?.hidden === true"), 'a leading H1 equal to the note name is hidden, so the title shows once');
  eq(await js("document.querySelector('.vault-note-body strong')?.textContent"), 'connected place', 'Markdown renders');
  ok(await js("!document.querySelector('.vault-note-body').textContent.includes('status: active')"), 'frontmatter is hidden');
  eq(await js("document.querySelector('.vault-note-body .vault-note-link')?.textContent"), 'the next note', 'an aliased path link has a readable label');
  ok(await js("document.querySelector('.vault-link-missing')?.title === 'Not in vault' && document.querySelector('.vault-link-missing').textContent === 'Not written yet'"), 'an unresolved link is dimmed and says Not in vault');
  ok(await js("document.querySelector('.vault-callout-note .vault-callout-title')?.textContent === 'How this folder works'"), 'a callout renders as a block');
  ok(await js("document.querySelectorAll('.vault-note-body img').length === 0 && document.querySelector('.vault-remote-image')?.textContent.includes('images.example.com')"), 'a remote image is not loaded; it is offered');
  ok(await js("/^Edited 2h ago by Kairos · \\d+ words$/.test(document.querySelector('.vault-note-meta').textContent)"), 'the meta line says when and that Kairos edited it');
  eq(await js("[...document.querySelectorAll('.vault-crumb')].map(c => c.textContent)"), ['Vault', 'Projects'], 'the breadcrumb shows the folder');
  if (!phone) {
    ok(await js("getComputedStyle(document.querySelector('.vault-rail')).display !== 'none'"), 'desktop: the context rail is open');
    eq(await js("[...document.querySelectorAll('.vault-rail-section > summary')].map(s => s.firstChild.textContent)"), ['Properties', 'Linked from', 'Links out', 'Related by keywords', 'Local graph', 'History'], 'the rail has its six sections');
    eq(await js("[...document.querySelectorAll('.vault-rail-properties .vault-pill')].map(p => p.textContent)"), ['active', 'kairos', 'index'], 'properties show as pills');
    eq(await js("document.querySelector('.vault-rail-backlinks .vault-rail-count').textContent"), '4', 'Linked from counts the backlinks');
    eq(await js("document.querySelector('.vault-rail-backlinks .vault-rail-snippet').textContent"), 'Back to Projects.', 'a backlink has its context line, with links as plain text');
    eq(await js("[...document.querySelectorAll('.vault-rail-links .vault-rail-name')].map(n => n.textContent)"), ['Projects note 1', 'Projects note 4', 'Not written yet'], 'Links out lists resolved links, then missing ones');
    ok(await js("!!document.querySelector('.vault-local-canvas')"), 'the local graph draws');
    await capture(label + '-vault-note');
  } else {
    ok(await js("document.querySelector('.library-vault-browser').classList.contains('vault-phone-detail') && document.querySelector('.library-vault-sidebar').hidden"), 'phone: the note pushes in as its own page');
    ok(await js("!!document.querySelector('.vault-phone-back')"), 'phone: the note page has a back button');
    await delay(400);
    ok(await js("document.documentElement.classList.contains('ms-tabbar-up') && document.querySelector('.ms-tabbar')?.dataset.state === 'shown'"), 'phone: the pushed note page keeps the tab bar');
    eq(await js("document.querySelectorAll('.ms-dock').length"), 0, 'phone: the dock leaves with the list page');
    eq(await small('.vault-phone-detail .library-vault-reader-head button, .vault-phone-back'), [], 'phone: note controls are 44px');
    await capture(label + '-vault-note');
    await click('.vault-links-pill');
    await waitFor("!!document.querySelector('dialog.ms-sheet[open] .vault-rail-body')");
    eq(await js("[...document.querySelectorAll('dialog.ms-sheet[open] .vault-rail-section > summary')].map(s => s.firstChild.textContent)"), ['Properties', 'Linked from', 'Links out', 'Related by keywords', 'Local graph', 'History'], 'phone: the rail is a bottom sheet with the same sections');
    eq(await small('dialog.ms-sheet[open] .vault-rail-row, dialog.ms-sheet[open] summary'), [], 'phone: rail rows are 44px');
    await capture(label + '-vault-rail');
    await js("document.querySelector('dialog.ms-sheet[open] .ms-sheet-header button').click()");
    await waitFor("!document.querySelector('dialog.ms-sheet[open]')");
  }
  eq(await overflow(), [], 'the note has no overflow');

  // -- Pins ----------------------------------------------------------------------------
  let start = writes.length;
  await click('.vault-pin');
  await waitFor("document.querySelector('.vault-pin').textContent === 'Pin'");
  eq(JSON.parse(since(start).find(w => w.path === '/api/vault/pins' && w.method === 'PUT').body), { pins: [] }, 'unpinning saves the pins on the server');
  await click('.vault-pin');
  await waitFor("document.querySelector('.vault-pin').textContent === 'Pinned'");
  eq(demoState.vault.pins, ['Projects/Projects.md'], 'pins are stored per user on the server (so phone and desktop agree)');

  // -- History: diff first, then a checked restore ----------------------------------------
  if (phone) { await click('.vault-links-pill'); await waitFor("!!document.querySelector('dialog.ms-sheet[open] .vault-rail-history')"); }
  const history = phone ? 'dialog.ms-sheet[open] .vault-rail-history' : '.vault-rail-history';
  await js(`document.querySelector('${history} > summary').click()`);
  await waitFor(`!!document.querySelector('${history} button.vault-history-row')`);
  eq(await js(`[...document.querySelectorAll('${history} .vault-history-label')].map(n => n.textContent)`), ['Chat: Connecting ideas across the vault', 'You, in Library'], 'History names each change in plain words');
  await js(`document.querySelector('${history} button.vault-history-row').click()`);
  await waitFor("!!document.querySelector('.vault-change-dialog .vault-diff')");
  ok(await js("document.querySelector('.vault-change-dialog .vault-diff-add').textContent.includes('connected place')"), 'the change opens on its diff');
  await capture(label + '-vault-history');
  start = writes.length;
  await clickText('.vault-change-dialog .btn', 'Restore before this change');
  await waitFor("!!document.querySelector('.confirm-panel, .panel-dialog:not(.vault-change-dialog)')");
  await js("[...document.querySelectorAll('.panel-dialog .btn')].find(b => b.textContent === 'Restore note').click()");
  await delay(400);
  const restore = since(start).find(w => w.path === '/api/file-checkpoints/vault-cp1/restore');
  ok(restore && JSON.parse(restore.body).files[0].path === 'Projects/Projects.md', 'restore goes through the existing checkpoint restore, for this note only');
  await waitFor("!document.querySelector('.vault-change-dialog')");
  if (phone) await js("document.querySelectorAll('dialog.ms-sheet[open]').forEach(d => d.querySelector('.ms-sheet-header button')?.click())");
  await waitFor("!!document.querySelector('.vault-note-body')");

  // -- The editor: CodeMirror, preview, version-checked save, 409 ------------------------
  await clickText('.library-vault-reader-actions .btn', 'Edit');
  await waitFor("!!document.querySelector('.vault-editor .cm-editor')");
  await delay(200);
  ok(await js("document.querySelector('.vault-editor .cm-content').textContent.includes('status: active')"), 'the editor holds the raw text, frontmatter included');
  if (phone) ok(await js("[...document.querySelectorAll('.vault-editor-modes button')].map(b => b.textContent).join() === 'Write,Preview' && getComputedStyle(document.querySelector('.vault-editor-preview-wrap')).display === 'none'"), 'phone: a Write / Preview switch');
  else ok(await js("getComputedStyle(document.querySelector('.vault-editor-preview-wrap')).display !== 'none' && !!document.querySelector('.vault-editor-preview strong')"), 'desktop: the preview sits beside the editor');
  await cm("view.dispatch({ changes: { from: view.state.doc.length, insert: '\\nAdded in the Library.\\n' } });");
  await waitFor("document.querySelector('.vault-note-title').classList.contains('dirty')");
  ok(true, 'a dirty dot shows on the title');
  await click(phone ? '.ms-tabbar [data-tabbar=home]' : '#nav .nav-item[data-tab=home]');
  await waitFor("!!document.querySelector('.confirm-panel')");
  ok(await js("document.querySelector('.confirm-panel').textContent.includes('Discard note edits?')"), 'tab navigation asks before discarding note edits');
  await clickText('.confirm-panel .btn', 'Cancel');
  await waitFor("!document.querySelector('.confirm-panel')");
  eq(await js("document.documentElement.dataset.view"), 'library', 'Cancel keeps Library open');
  ok(await js("document.querySelector('.vault-editor .cm-content').textContent.includes('Added in the Library.')"), 'Cancel preserves the note edit');
  ok(await js("document.querySelector('.vault-note-title').classList.contains('dirty')"), 'Cancel preserves the dirty title dot');
  // [[ completion offers vault notes.
  await cm("view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });");
  // Typed as the keyboard would, so completion opens as it does for a person.
  for (const ch of '[[Projects note 1') await cm(`const pos = view.state.selection.main.head; view.dispatch({ changes: { from: pos, insert: ${JSON.stringify(ch)} }, selection: { anchor: pos + 1 }, userEvent: 'input.type' });`);
  await delay(600);
  const completion = await js("[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(li => li.textContent).slice(0, 3)");
  ok(completion.some(text => text.startsWith('Projects note 1')), '[[ offers notes from the vault: ' + JSON.stringify(completion));
  await cm("const doc = view.state.doc.toString(); const at = doc.lastIndexOf('[[Projects note 1'); view.dispatch({ changes: { from: at, to: doc.length, insert: '' } });");
  await capture(label + '-vault-editor');
  if (phone) { await clickText('.vault-editor-modes button', 'Preview'); await delay(250); ok(await js("document.querySelector('.vault-editor-preview').textContent.includes('Added in the Library.')"), 'phone: Preview shows the edit'); await clickText('.vault-editor-modes button', 'Write'); }
  start = writes.length;
  const ctrlS = () => js("document.querySelector('.vault-editor .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))");
  await ctrlS();
  await waitFor("document.querySelector('.vault-editor-status').textContent === 'Saved' && !document.querySelector('.vault-note-title').classList.contains('dirty')");
  ok(await js("!!document.querySelector('.vault-editor')"), 'Ctrl+S saves and keeps the editor open');
  const save = JSON.parse(since(start).find(w => w.path === '/api/vault/note').body);
  eq([save.path, save.version, save.content.endsWith('Added in the Library.\n'), save.content.startsWith('---\nstatus: active')], ['Projects/Projects.md', 'v1', true, true], 'the save sends the version it opened and the raw text');
  // An outside edit in the meantime: 409, nothing lost, Reload or Copy my version.
  demoState.vault.versions['Projects/Projects.md'] = 'v9';
  await cm("view.dispatch({ changes: { from: view.state.doc.length, insert: 'Mine.\\n' } });");
  await clickText('.vault-editor-bar .btn', 'Save');
  await waitFor("!!document.querySelector('.vault-conflict-dialog')");
  ok(await js("document.querySelector('.vault-conflict-dialog').textContent.includes('Nothing was overwritten')"), 'a save after an outside edit is refused and says so');
  ok(await js("[...document.querySelectorAll('.vault-conflict-dialog .btn')].map(b => b.textContent).join() === 'Copy my version,Reload their version'"), 'the conflict offers Copy my version and Reload');
  ok(await js("document.querySelector('.vault-editor .cm-content').textContent.includes('Mine.')"), 'the edit is still in the editor');
  await capture(label + '-vault-conflict');
  await clickText('.vault-conflict-dialog .btn', 'Reload their version');
  await waitFor("!document.querySelector('.vault-conflict-dialog') && !document.querySelector('.vault-editor .cm-content').textContent.includes('Mine.')");
  ok(true, 'Reload loads the latest version');
  // Removing the properties block asks first.
  const original = await cm("return view.state.doc.toString();");
  await cm("const doc = view.state.doc.toString(); const end = doc.indexOf('---', 3) + 4; view.dispatch({ changes: { from: 0, to: end, insert: '' } });");
  await clickText('.vault-editor-bar .btn', 'Save');
  await waitFor("[...document.querySelectorAll('.panel-dialog')].some(d => d.textContent.includes('Remove the properties block?'))");
  start = writes.length;
  await js("document.querySelector('.panel-dialog .modal-close-btn').click()");
  await delay(250);
  eq(since(start).filter(w => w.path === '/api/vault/note').length, 0, 'cancelling keeps the properties block: nothing is saved');
  // The Save button saves and returns to the reading view.
  await cm(`view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(original + 'Saved and closed.' + String.fromCharCode(10))} } });`);
  await clickText('.vault-editor-bar .btn', 'Save');
  await waitFor("!document.querySelector('.vault-editor') && !!document.querySelector('.vault-note-body')");
  ok(since(start).some(w => w.path === '/api/vault/note' && JSON.parse(w.body).content.endsWith('Saved and closed.' + String.fromCharCode(10))), 'Save persists and returns to reading');
  await clickText('.library-vault-reader-actions .btn', 'Edit');
  await waitFor("!!document.querySelector('.vault-editor .cm-editor')");
  await cm("view.dispatch({ changes: { from: view.state.doc.length, insert: 'Unsaved.' } });");
  // Leaving with unsaved changes asks first.
  await click('.vault-mode-pill');
  await waitFor("[...document.querySelectorAll('.panel-dialog')].some(d => d.textContent.includes('Discard note edits?'))");
  await js("[...document.querySelectorAll('.panel-dialog .btn')].find(b => /Discard/.test(b.textContent)).click()");
  await waitFor("!!document.querySelector('.vault-home-grid')");

  // -- Today's note and the index prompt ------------------------------------------------------
  start = writes.length;
  if (phone) { await js("document.querySelector('.ms-dock button[aria-label=\"Today\\'s note\"]').click()"); }
  else await click('.vault-create-today');
  await waitFor("!!document.querySelector('.vault-index-prompt')");
  ok(since(start).some(w => w.path === '/api/vault/daily' && w.method === 'POST'), "today's note is created through POST /api/vault/daily");
  ok(await js("document.querySelector('.vault-note-title').textContent.startsWith(new Date().toISOString().slice(0, 4))"), "today's note opens");
  ok(await js("document.querySelector('.vault-index-prompt .vault-diff-add').textContent.includes(': daily session log.')"), 'the index line is shown as a diff');
  eq(since(start).filter(w => w.path === '/api/vault/note').length, 0, 'the index line is not written until clicked');
  await capture(label + '-vault-today');
  await clickText('.vault-index-prompt .btn', 'Add line');
  await waitFor("!document.querySelector('.vault-index-prompt')");
  const indexSave = JSON.parse(since(start).find(w => w.path === '/api/vault/note').body);
  ok(indexSave.path === 'Daily notes/Daily notes.md' && indexSave.content.includes('daily session log.') && indexSave.version === 'v1', 'Add line goes through the same version-checked save');

  // -- Ask Kairos: a new chat with the note attached, nothing sent ----------------------------
  if (phone) await js("document.querySelector('.vault-phone-back').click()");
  await js("[...document.querySelectorAll('.library-vault-note')].find(b => b.querySelector('.vault-row-name')?.textContent === 'Projects').click()");
  await waitFor("!!document.querySelector('.vault-ask')");
  start = writes.length;
  await click('.vault-ask');
  await waitFor("[...document.querySelectorAll('.chat-reference-chip')].some(c => c.textContent.includes('Vault note · Projects'))");
  await delay(300);
  ok(await js("document.activeElement?.id === 'chat-input'"), 'Ask Kairos focuses the composer');
  eq(since(start).filter(w => /\/api\/chat\/(live|stream)/.test(w.path)).length, 0, 'Ask Kairos sends nothing');
  await capture(label + '-vault-ask');

  // -- Map: links first, filters, focus, reduced motion ----------------------------------------
  await navigate('library', { section: 'vault' });
  await waitFor("!!document.querySelector('.vault-mode-pill')");
  await clickText('.vault-mode-pill', 'Map');
  await waitFor("document.querySelector('.vault-caption')?.textContent.includes('connections')");
  await delay(phone ? 600 : 400);
  const map = "document.querySelector('#vault-graph-canvas')._vaultMap";
  eq(await js(`${map}.links()`), 30, 'all 30 fixture links are drawn at fit view');
  ok(await js(`${map}.linkAlpha >= .4`), 'link edges are clearly visible (about .45)');
  eq(await js("document.querySelector('.vault-caption .vault-counts').textContent"), '131 notes · 30 connections', "the caption counts notes (130 and today's) and links");
  await capture(label + '-vault-map');
  await capture(label + '-vault'); // docs/img/vault.png (--update-doc-images)
  await clickText('.vault-map-filters .vault-map-pill', 'Orphans');
  await delay(200);
  ok(await js(`${map}.visible().every(id => !['Projects/Projects.md', 'Projects/Projects note 4.md'].includes(id))`), 'Orphans hides linked notes');
  await clickText('.vault-map-filters .vault-map-pill', 'Orphans');
  // Focus mode at depth 2 shows only notes connected within two links.
  if (phone) {
    await js("(() => { const i = document.querySelector('.ms-dock input') || document.querySelector('.vault-search'); i.value = 'Projects note 4'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor("!!document.querySelector('.vault-search-result')");
    await click('.vault-search-result');
    await waitFor("!!document.querySelector('dialog.ms-sheet[open] .vault-peek')");
    ok(await js("[...document.querySelectorAll('dialog.ms-sheet[open] .vault-peek .btn')].map(b => b.textContent).join() === 'Open,Show around'"), 'phone: tapping a node opens a peek sheet');
    await capture(label + '-vault-map-peek');
    await clickText('dialog.ms-sheet[open] .vault-peek .btn', 'Show around');
  } else {
    await js("(() => { const i = document.querySelector('.vault-search'); i.value = 'Projects note 4'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor("!!document.querySelector('.vault-search-result')");
    await click('.vault-search-result');
    await waitFor("!!document.querySelector('.vault-panel.open .vault-note-body')");
    ok(await js("!!document.querySelector('.vault-panel .vault-note-title') && !!document.querySelector('.vault-panel .vault-properties')"), 'desktop: the side panel is the shared reader');
    await clickText('.vault-panel .btn', 'Show around');
  }
  await waitFor(`${map}.focus() === 'Projects/Projects note 4.md'`);
  await clickText('.vault-focus-bar .vault-map-pill', '2');
  await delay(300);
  const expected = await js(`(async () => {
    const g = await (await fetch('/api/vault/graph')).json(); const links = g.edges.filter(e => e.kind === 'link');
    let seen = new Set(['Projects/Projects note 4.md']), frontier = [...seen];
    for (let d = 0; d < 2; d++) { const next = []; for (const id of frontier) for (const e of links) { const other = e.source === id ? e.target : e.target === id ? e.source : null; if (other && !seen.has(other)) { seen.add(other); next.push(other); } } frontier = next; }
    return [...seen].sort(); })()`);
  eq((await js(`${map}.visible()`)).sort(), expected, 'focus mode at depth 2 shows only notes connected within two links');
  ok(expected.length > 2 && expected.length < 20, 'depth 2 is a real neighbourhood: ' + expected.length);
  await capture(label + '-vault-map-focus');
  if (phone) await js("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  // Reduced motion: a static, settled layout.
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await clickText('.vault-focus-bar .btn', 'Whole vault');
  await delay(100);
  const first = await js(`${map}.positions()`);
  await delay(500);
  eq(await js(`${map}.positions()`), first, 'reduced motion: the layout is already settled and does not move');
  ok(await js(`${map}.settled()`), 'reduced motion: the simulation ran to the end before the first draw');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  eq(await overflow(), [], 'the map has no overflow');

  // -- Read-only users: no Edit, no Today's note ----------------------------------------------
  demoState.vaultReadOnly = true;
  await navigate('library', { section: 'vault' });
  await waitFor("!!document.querySelector('.vault-home-grid')");
  ok(await js("!document.querySelector('.vault-create-today') && document.querySelector('.vault-today-btn').hidden"), "a non-admin is not offered today's note");
  await js("[...document.querySelectorAll('.library-vault-note')].find(b => b.querySelector('.vault-row-name')?.textContent === 'Projects').click()");
  await waitFor("!!document.querySelector('.vault-note-body')");
  ok(await js("![...document.querySelectorAll('.library-vault-reader-actions .btn')].some(b => b.textContent === 'Edit')"), 'a non-admin reads but has no Edit');
  demoState.vaultReadOnly = false;

  // -- The redesign switch off (classic look) ------------------------------------------------
  if (!phone) {
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ classic: true }))");
    await navigate('library', { section: 'vault' });
    await waitFor("!!document.querySelector('.vault-home-grid') && !document.documentElement.classList.contains('kairos-redesign')");
    await js("[...document.querySelectorAll('.library-vault-note')].find(b => b.querySelector('.vault-row-name')?.textContent === 'Projects').click()");
    await waitFor("!!document.querySelector('.vault-note-body') && !!document.querySelector('.vault-rail-body')");
    ok(await js("getComputedStyle(document.querySelector('.library-vault-browser')).display === 'grid' && getComputedStyle(document.querySelector('.vault-rail')).display !== 'none'"), 'switch off: sidebar, reader and rail still lay out');
    eq(await overflow(), [], 'switch off: no overflow');
    await capture(label + '-vault-classic');
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ classic: false }))");
    await waitFor("document.documentElement.classList.contains('kairos-redesign') && !!document.querySelector('.sidebar-settings-btn')");
  }
  demoState.vault = undefined;
  // Leave the app as the next checks expect it: Home, with the sidebar built.
  await navigate('home');
  await waitFor("!!document.querySelector('.sidebar-settings-btn') && !document.querySelector('.panel-dialog, dialog[open]')");
  await delay(300);
  return { assertions };
}

module.exports = { run };
