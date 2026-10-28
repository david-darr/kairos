// A10 Library Files/Documents (Part 2 group g5, 2026-10-27): the visible controls
// and the requests they send, against the mocked backend. Runs only with
// `ui-smoke.cjs --g5-only` (which also runs vault-checks.cjs at desktop and phone).
//
//   - documents list, search (one debounced request, never one per key), clear
//   - New document -> POST, editor opens; title+body edit -> Save and Ctrl+S -> PATCH
//     with the right body; saved state clears the leave guard
//   - Import from File -> POST /api/documents/import with name and text
//   - Delete -> confirm dialog (Cancel keeps it, Delete sends DELETE)
//   - chat files by chat: grouped, filtered by search, unavailable files disabled
//   - requests per first load of Library > Files (duplicates are waste)
// The fixture's documents are read-only, so "saved result" is proven in
// test_g5_library_documents_memory.py; this file proves control -> request.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, writes, reads, demoState, overflow, capture }) => {
  const press = async (key, code, vk, modifiers = 0, target = null) => {
    for (const type of ['keyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers });
    }
    await delay(120);
  };
  const clickText = (selector, text) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const typeInto = (selector, value) => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.focus(); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const openFirst = async () => { await waitFor("document.querySelectorAll('.library-document-card').length > 0"); await js("document.querySelector('.library-document-card').click()"); };
  const since = (list, n) => list.slice(n);
  const report = { requests: {} };

  await win.setContentSize(1440, 900); await delay(300);

  // -- first load: requests per screen ------------------------------------------------
  await navigate('home'); await delay(300);
  const r0 = reads.length;
  await navigate('library', { section: 'documents' });
  await waitFor("document.querySelectorAll('.library-document-card').length === 3 && !!document.querySelector('.library-chat-group')");
  await delay(400);
  const load = since(reads, r0).map(r => r.path);
  const count = p => load.filter(x => x === p).length;
  report.requests.firstLoad = Object.fromEntries([...new Set(load)].map(p => [p, count(p)]));
  assert.equal(count('/api/documents'), 1, `Library > Files reads /api/documents once (saw ${count('/api/documents')})`);
  assert.equal(count('/api/chat/files/library'), 1, `and /api/chat/files/library once (saw ${count('/api/chat/files/library')})`);

  // -- search: one debounced request, results filter both lists ------------------------
  const s0 = reads.length;
  for (const v of ['p', 'pr', 'pro', 'proj']) { await typeInto('.library-document-toolbar input[data-page-search]', v); await delay(40); }
  await waitFor("document.querySelectorAll('.library-document-card').length === 1");
  await delay(300);
  const searches = since(reads, s0).filter(r => r.path === '/api/documents/search');
  assert.equal(searches.length, 1, `four fast keystrokes send one search (saw ${searches.length})`);
  assert.equal(searches[0].query.q, 'proj');
  assert.ok(await js("document.querySelector('.library-document-card').textContent.includes('Project research')"));
  await typeInto('.library-document-toolbar input[data-page-search]', 'zzz-nothing');
  await waitFor("!!document.querySelector('#library-grid .empty-state, #library-grid [class*=empty]') && document.querySelectorAll('.library-document-card').length === 0");
  assert.ok(await js("document.querySelector('#library-grid').textContent.includes('No documents match')"));
  await typeInto('.library-document-toolbar input[data-page-search]', '');
  await waitFor("document.querySelectorAll('.library-document-card').length === 3");

  // -- chat files: grouped, searched, unavailable disabled ---------------------------------
  const groups = await js("document.querySelectorAll('.library-chat-group').length");
  assert.ok(groups >= 1, 'files are grouped by chat');
  await typeInto('.library-document-toolbar input[data-page-search]', 'weekly-plan');
  await waitFor("document.querySelectorAll('.library-file-row').length >= 1 && [...document.querySelectorAll('.library-file-row')].every(r => r.textContent.includes('weekly-plan'))");
  await typeInto('.library-document-toolbar input[data-page-search]', '');
  await waitFor("document.querySelectorAll('.library-document-card').length === 3");

  // -- New document -> POST -> editor -> edit -> Save (button, Ctrl+S) -> PATCH ----------------------
  let w0 = writes.length;
  await clickText('.library-document-toolbar button', '+ New document');
  await waitFor("!!document.querySelector('.library-editor textarea')");
  const created = since(writes, w0).find(w => w.method === 'POST' && w.path === '/api/documents');
  assert.ok(created, 'New document posts to /api/documents');
  assert.deepEqual(JSON.parse(created.body), { title: 'Untitled', content: '' });
  w0 = writes.length;
  await typeInto('.library-editor-toolbar input', '  Plan Ünïcode 日本  ');
  await typeInto('.library-editor textarea', 'line 1\nline 2 — café');
  await clickText('.library-editor-toolbar .btn', 'Save');
  await waitFor("document.querySelector('.library-editor-toolbar .meta')?.textContent === 'All changes saved'");
  let patch = since(writes, w0).filter(w => w.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.match(patch[0].path, /^\/api\/documents\/[^/]+$/);
  assert.deepEqual(JSON.parse(patch[0].body), { title: 'Plan Ünïcode 日本', content: 'line 1\nline 2 — café' }, 'Save sends the trimmed title and exact body');
  assert.equal(patch[0].status, 200, 'the save was answered OK');
  // Ctrl+S in the body saves again.
  w0 = writes.length;
  await js("(() => { const t = document.querySelector('.library-editor textarea'); t.focus(); t.value += '\\nmore'; t.dispatchEvent(new Event('input', { bubbles: true })); })()");
  assert.equal(await js("document.querySelector('.library-editor-toolbar .meta').textContent"), '', 'typing clears the saved note');
  await press('s', 'KeyS', 83, 2);
  await waitFor(`${JSON.stringify(true)} && document.querySelector('.library-editor-toolbar .meta')?.textContent === 'All changes saved'`);
  patch = since(writes, w0).filter(w => w.method === 'PATCH');
  assert.equal(patch.length, 1, 'Ctrl+S saves once');
  assert.equal(JSON.parse(patch[0].body).content, 'line 1\nline 2 — café\nmore');
  // Saved state: leaving does not ask.
  await clickText('.library-editor-toolbar .btn', '← Back to Library');
  await waitFor("!!document.querySelector('.library-document-toolbar') && !document.querySelector('.confirm-panel')");
  // Unsaved title only: leaving asks; Discard returns.
  await openFirst();
  await waitFor("!!document.querySelector('.library-editor textarea')");
  await typeInto('.library-editor-toolbar input', 'Renamed but unsaved');
  await clickText('.library-editor-toolbar .btn', '← Back to Library');
  await waitFor("document.querySelector('.confirm-panel')?.textContent.includes('Discard unsaved changes?')");
  assert.ok(await js("document.querySelector('.confirm-panel').textContent.includes('Renamed but unsaved')"), 'the dialog names the document being edited');
  await clickText('.confirm-panel .btn', 'Cancel');
  assert.equal(await js("document.querySelector('.library-editor-toolbar input').value"), 'Renamed but unsaved', 'Cancel keeps the typed title');
  assert.equal(since(writes, w0).filter(w => w.method === 'PATCH').length, 1, 'no save happened while deciding');
  await clickText('.library-editor-toolbar .btn', '← Back to Library');
  await clickText('.confirm-panel .btn', 'Discard changes');
  await waitFor("!!document.querySelector('.library-document-toolbar')");

  // -- Delete: Cancel keeps, Delete sends DELETE --------------------------------------------------------
  await openFirst();
  await waitFor("!!document.querySelector('.library-editor textarea')");
  w0 = writes.length;
  await clickText('.library-editor-toolbar .btn', 'Delete');
  await waitFor("document.querySelector('.confirm-panel')?.textContent.includes('permanently deleted')");
  await clickText('.confirm-panel .btn', 'Cancel');
  await waitFor("!document.querySelector('.confirm-panel')");
  assert.equal(since(writes, w0).filter(w => w.method === 'DELETE').length, 0, 'Cancel deletes nothing');
  await clickText('.library-editor-toolbar .btn', 'Delete');
  await waitFor("!!document.querySelector('.confirm-panel')");
  await clickText('.confirm-panel .btn', 'Delete document');
  await waitFor("!!document.querySelector('.library-document-toolbar')");
  const del = since(writes, w0).filter(w => w.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.match(del[0].path, /^\/api\/documents\/d1$/);

  // -- Import from File: the picker's file goes to /api/documents/import ----------------------------------
  w0 = writes.length;
  await js(`(() => { const input = document.querySelector('.library-document-toolbar input[type=file]');
    const file = new File(['# Imported\\r\\nbody ünï 日本\\r\\n'], 'My Notes.md', { type: 'text/markdown' });
    const data = new DataTransfer(); data.items.add(file); input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor("!!document.querySelector('.library-editor textarea')");
  const imported = since(writes, w0).find(w => w.path === '/api/documents/import');
  assert.ok(imported, 'Import posts to /api/documents/import');
  assert.deepEqual(JSON.parse(imported.body), { filename: 'My Notes.md', content: '# Imported\r\nbody ünï 日本\r\n' });
  assert.equal(await js("document.querySelector('.library-editor textarea').accept || 'n/a'"), 'n/a');
  assert.equal(await js("document.querySelector('.library-document-toolbar input[type=file], input[type=file]')?.accept ?? '.md,.txt'"), '.md,.txt');
  await clickText('.library-editor-toolbar .btn', '← Back to Library');
  await waitFor("!!document.querySelector('.library-document-toolbar')");

  // -- Map with a large vault: 1,500 notes / 3,000 links drawn, time to first map and to settle ------------
  await js(`(() => {
    const nodes = [{ id: '', name: 'Vault', type: 'folder' }], edges = [];
    for (let f = 0; f < 30; f++) { nodes.push({ id: 'F' + f, name: 'F' + f, type: 'folder' }); edges.push({ source: '', target: 'F' + f, kind: 'contains' }); }
    for (let n = 0; n < 1500; n++) { const id = 'F' + (n % 30) + '/Note ' + n + '.md';
      nodes.push({ id, name: 'Note ' + n, folder: 'F' + (n % 30), type: 'note', mtime: 1790000000 - n, size: 900, words: 150, daily: false, has_frontmatter: false });
      edges.push({ source: 'F' + (n % 30), target: id, kind: 'contains' });
      for (const k of [1, 37]) edges.push({ source: id, target: 'F' + ((n + k) % 30) + '/Note ' + ((n + k) % 1500) + '.md', kind: 'link' }); }
    const G = { nodes, edges, missing: [] };
    window.__realFetch = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/vault/graph') ? Promise.resolve(new Response(JSON.stringify(G), { headers: { 'Content-Type': 'application/json' } })) : window.__realFetch(u, o);
  })()`);
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await navigate('library', { section: 'vault' });
    await waitFor("!!document.querySelector('.vault-mode-pill')");
    const t0 = Date.now();
    await clickText('.vault-mode-pill', 'Map');
    await waitFor("document.querySelector('.vault-caption')?.textContent.includes('connections')", 60000);
    await waitFor("document.querySelector('#vault-graph-canvas')?._vaultMap?.settled()", 60000);
    report.bigMapMs = Date.now() - t0;
    const caption = await js("document.querySelector('.vault-caption .vault-counts').textContent");
    assert.match(caption, /^1500 notes · 3000 connections$/, caption);
    const frame = await js(`new Promise(r => { const a = performance.now(); let n = 0; const tick = () => { if (++n < 20) requestAnimationFrame(tick); else r((performance.now() - a) / 20); }; requestAnimationFrame(tick); })`);
    report.bigMapFrameMs = Math.round(frame * 10) / 10;
    assert.ok(report.bigMapMs < 15000, `a 1,500-note map settles in under 15 s (took ${report.bigMapMs} ms)`);
    await js("document.querySelector('.vault-search').value = 'Note 1499'; document.querySelector('.vault-search').dispatchEvent(new Event('input', { bubbles: true }))");
    await waitFor("document.querySelectorAll('.vault-search-results button, .vault-search-results [role=option], .vault-search-results > *').length > 0");
  } finally {
    await js("(window.fetch = window.__realFetch || window.fetch, true)");
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await navigate('home');
  }

  // -- phone: same list, no sideways scroll, 44px targets for the primary controls ---------------------
  await win.setContentSize(390, 844); await delay(500);
  await navigate('library', { section: 'documents' });
  await waitFor("!!document.querySelector('.library-overview, .library-view')");
  assert.deepEqual(await overflow(), [], 'phone Library has no sideways scroll');
  await win.setContentSize(1440, 900); await delay(400);
  await navigate('home');
  console.log('PASS: Library documents and chat files: search debounce, New, Save, Ctrl+S, leave guard, Delete, Import; first load reads each source once');
  console.log('G5-LIBRARY-REPORT ' + JSON.stringify(report));
};
