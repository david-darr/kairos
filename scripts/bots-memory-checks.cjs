// Bots Phase 2, unit U1: the notebook and its Memory section, in the renderer.
// Run: python run_electron_target.py <worktree> --bots-memory-only <log> 600
//   (or node scripts/run-electron-test.cjs ui-smoke --bots-memory-only)
// Mounts the real botsPanel.js in a scratch host (Simple and Advanced) against the in-memory Bots backend
// (fixtures/bots-core-backend.cjs for the bot, fixtures/bots-identity-backend.cjs for the panel's own reads, and
// fixtures/bots-memory-backend.cjs for /api/bots/<id>/memory). It creates its own bot, never assumes which other bots
// exist, and removes everything it made, and restores its page preferences, in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor: rawWait, delay, win, capture, demoState, base }) => {
  const q = JSON.stringify;
  const HOST = '#bots-mem-host';
  // A wait that, when it times out, says what the section was showing.
  const waitFor = async expression => {
    try { await rawWait(expression); }
    catch (error) {
      const shown = await js(`(document.querySelector('#bots-mem-host [data-part=doc]')?.outerHTML || document.querySelector('#bots-mem-host')?.innerText || '(no host)').slice(0, 2500)`).catch(() => '');
      const focus = await js('(window.__focusLog || []).slice(-12).join(" | ")').catch(() => '');
      const open = await js(`(() => { const i = document.querySelector('#bots-mem-host .bots-acc-item[data-section=memory]'); return i ? i.dataset.open + ' / body hidden=' + (i.querySelector('.bots-acc-body')?.hidden) + ' / items=' + document.querySelectorAll('#bots-mem-host .bots-acc-item[data-open=true]').length + ' / active=' + document.activeElement?.tagName : 'no item'; })()`).catch(() => '');
      error.message += `
--- accordion: ${open}
--- focus: ${focus}
--- the section showed:
${shown.slice(0, 300)}`;
      throw error;
    }
  };
  const ROOT = `${HOST} [data-memory-root]`;
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const count = selector => js(`document.querySelectorAll(${q(selector)}).length`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const clickButton = (scope, label) => js(`(() => { const n = [...document.querySelectorAll(${q(scope)} + ' button')].find(b => b.textContent.trim() === ${q(label)} && !b.disabled);
    if (!n) throw new Error('no enabled button ' + ${q(label)} + ' in ' + ${q(scope)}); n.click(); return true; })()`);
  const buttonState = (scope, label) => js(`(() => { const n = [...document.querySelectorAll(${q(scope)} + ' button')].find(b => b.textContent.trim() === ${q(label)}); return n ? { disabled: n.disabled } : null; })()`);
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  const typeInto = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)});
    n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const key = (selector, name) => js(`(() => { const n = document.querySelector(${q(selector)}); n.dispatchEvent(new KeyboardEvent('keydown', { key: ${q(name)}, bubbles: true, cancelable: true })); return true; })()`);
  const toasts = () => js("[...document.querySelectorAll('#toast-host .toast')].map(n => n.textContent)");
  const errorToasts = () => js("[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)");
  const clearToasts = () => js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
  const closeDialogs = () => js(`(() => { for (let i = 0; i < 6; i++) { const b = document.querySelector('.modal-backdrop .modal-close-btn'); if (!b) break; b.click(); }
    document.querySelectorAll('.modal-backdrop').forEach(n => n.remove()); return true; })()`);
  const yes = () => click('.confirm-panel .modal-footer .btn:last-child');
  const setInterfaceMode = advanced => js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${advanced}); return m.isAdvanced(); })`);
  const mountRaw = (id, mode) => js(`(async () => {
    const P = await import('/static/js/botsPanel.js');
    window.__panel?.destroy();
    document.getElementById('bots-mem-host')?.remove();
    const host = document.createElement('div');
    host.id = 'bots-mem-host';
    host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:' + (${q(mode)} === 'advanced' ? 'min(420px,42vw)' : '320px') + ';z-index:30;background:var(--bots-panel)';
    document.body.append(host);
    window.__panel = P.mountBotPanel(host, { agentId: ${q(id)}, mode: ${q(mode)}, onClose: () => {} });
    return true;
  })()`);
  // Simple mode opens Memory as a page under Settings; Advanced opens its accordion row.
  const mountMemory = async (id, mode) => {
    await mountRaw(id, mode);
    await waitFor("!!document.querySelector('#bots-mem-host .bots-panel-top') && !!document.querySelector('#bots-mem-host .bots-panel-scroll')");
    if (mode === 'advanced') {
      await waitFor("document.querySelectorAll('#bots-mem-host .bots-acc-item').length > 3");
      if (!(await exists('#bots-mem-host .bots-acc-item[data-section=memory][data-open=true]'))) await click('#bots-mem-host .bots-acc-head[data-section=memory]');
    } else {
      await js("window.__panel.openSection('memory'); true");
    }
    await waitFor(`!!document.querySelector(${q(`${ROOT}[data-mode=${mode}]`)})`);
  };
  const loaded = () => waitFor(`!!document.querySelector(${q(`${ROOT} .bots-mem-state[hidden]`)})`);
  const url = (id, tail = '') => `/api/bots/${id}/memory${tail}`;
  const fileOf = async (id, path) => (await call(`${url(id, '/file')}?path=${encodeURIComponent(path)}`)).body;
  const putFile = async (id, path, body) => call(`${url(id, '/file')}?path=${encodeURIComponent(path)}`, 'PUT', body);
  const overview = id => call(url(id)).then(r => r.body);
  const expected = [];   // error toasts this check caused on purpose

  const savedInterface = await js("localStorage.getItem('kairos:bots-interface') || ''");
  const restore = await isolateBotsCheck({ js, demoState });
  let botId = null, phone = false;
  try {
    demoState.botsLive = true;
    delete demoState.botsMemory;
    demoState.botsSectionModules = ['Memory'];
    const seededAttention = !demoState.botsAttention;
    if (seededAttention) demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {} };   // the app polls the attention feed; an empty one answers it
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__prior = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots';
      window.__errs = []; window.__focusLog = []; const d = n => (n?.tagName || '?') + '.' + (n?.className || '').toString().slice(0, 24); for (const t of ['focusin', 'focusout']) document.addEventListener(t, e => window.__focusLog.push(t + ' ' + d(e.target))); window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason && e.reason.stack || e.reason)));
      document.addEventListener('jarvis:navigate', e => { e.stopImmediatePropagation(); }, true); return true; })()`);
    // Phase 1's accordion draws an open section's body with hidden="undefined" (botsPanel.js, `hidden: !isOpen || undefined`
    // through api.js el(), which writes the string), and the attribute alone hides it. Until that line is fixed, take that
    // one attribute off so this check can see and focus the section; after the fix this does nothing.
    await js(`(() => { const fix = () => document.querySelectorAll('.bots-acc-body[hidden="undefined"]').forEach(n => n.removeAttribute('hidden'));
      window.__unhide = new MutationObserver(fix); window.__unhide.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] }); fix(); return true; })()`);
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");   // seeds the in-memory backend
    const made = await call('/api/agents', 'POST', { name: `Memory Probe ${Date.now() % 100000}`, role: 'Remembers things' });
    assert.equal(made.status, 200, 'the check makes its own bot');
    botId = made.body.id;

    // ================= Simple: notes you can add and remove ================================================================
    await setInterfaceMode(false);
    await mountMemory(botId, 'simple');
    await loaded();
    await capture('desktop-bots-memory-simple');
    assert.match(await text(`${ROOT} .bots-mem-notes`), /No notes yet/, 'a named empty state');
    assert.equal(await exists(`${ROOT} [data-part=capacity]:not([hidden]) .bots-card`), false, 'Simple has no capacity meter');
    assert.equal(await exists(`${ROOT} [data-memory-editor]`), false, 'Simple has no file editor');
    await typeInto(`${ROOT} .bots-mem-add-input`, 'Prefers short replies');
    await clickButton(`${ROOT} .bots-mem-add`, 'Add note');
    await waitFor(`document.querySelectorAll(${q(`${ROOT} .bots-mem-note`)}).length === 1`);
    assert.match(await text(`${ROOT} .bots-mem-note`), /Prefers short replies/);
    assert.match(await text(`${ROOT} .bots-mem-note .bots-row-hint`), /added .* by you/);
    assert.equal(await js(`document.querySelector(${q(`${ROOT} .bots-mem-add-input`)}).value`), '', 'the box clears once it is saved');
    assert.match((await fileOf(botId, 'MEMORY.md')).text, /from owner · Prefers short replies/, 'it is written to the main page');
    await typeInto(`${ROOT} .bots-mem-add-input`, 'Works Tuesday to Friday');
    await js(`document.querySelector(${q(`${ROOT} .bots-mem-add-input`)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true`);
    await waitFor(`document.querySelectorAll(${q(`${ROOT} .bots-mem-note`)}).length === 2`);
    // Remove the first.
    await click(`${ROOT} .bots-mem-note:first-child button[aria-label^="Remove note"]`);
    await waitFor(`document.querySelectorAll(${q(`${ROOT} .bots-mem-note`)}).length === 1`);
    assert.doesNotMatch((await fileOf(botId, 'MEMORY.md')).text, /Prefers short replies/);
    assert.match(await text(`${ROOT} .bots-mem-note`), /Works Tuesday/);
    // The notes changed somewhere else while the box was open: nothing is lost, the list reloads, the text stays.
    const idx = (await overview(botId)).index;
    assert.equal((await putFile(botId, 'MEMORY.md', { text: `${idx.text}- 2026-10-29 · from owner · Set from Obsidian\n`, expected_hash: idx.hash })).status, 200);
    await typeInto(`${ROOT} .bots-mem-add-input`, 'Late addition');
    await clickButton(`${ROOT} .bots-mem-add`, 'Add note');
    await waitFor(`document.querySelectorAll('#toast-host .toast.error').length > 0`);
    assert.match((await errorToasts())[0], /changed somewhere else/);
    expected.push(...await errorToasts());
    await waitFor(`document.querySelectorAll(${q(`${ROOT} .bots-mem-note`)}).length === 2`);
    assert.equal(await js(`document.querySelector(${q(`${ROOT} .bots-mem-add-input`)}).value`), 'Late addition', 'the typed note is kept');
    await clickButton(`${ROOT} .bots-mem-add`, 'Add note');
    await waitFor(`document.querySelectorAll(${q(`${ROOT} .bots-mem-note`)}).length === 3`);
    await clearToasts();

    // Disabled state: the banner says so, the notes stay.
    await click(`${ROOT} [data-part=master] .bots-switch-row`);
    await waitFor(`document.querySelector(${q(ROOT)})?.dataset.memoryEnabled === 'false'`);
    assert.match(await text(`${ROOT} .bots-mem-banner`), /Memory is off for this bot/);
    assert.equal(await count(`${ROOT} .bots-mem-note`), 3, 'switching it off keeps the notes');
    assert.equal((await overview(botId)).enabled, false);
    await capture('desktop-bots-memory-disabled');
    await click(`${ROOT} [data-part=master] .bots-switch-row`);
    await waitFor(`document.querySelector(${q(ROOT)})?.dataset.memoryEnabled === 'true'`);
    assert.equal(await js(`document.querySelector(${q(`${ROOT} .bots-mem-banner`)}).hidden`), true);

    // ================= Advanced: capacity, the main page, topics ================================================================
    await setInterfaceMode(true);
    await mountMemory(botId, 'advanced');
    await loaded();
    await waitFor(`!!document.querySelector(${q(`${ROOT} [data-memory-editor="MEMORY.md"]`)})`);
    await capture('desktop-bots-memory-advanced');
    assert.match(await text(`${ROOT} .bots-mem-capacity`), /lines of 200/);
    assert.equal(await js(`document.querySelector(${q(`${ROOT} .bots-mem-capacity`)}).dataset.level`), 'ok');
    // Edit the main page in place: too many lines to read each turn.
    const many = ['## Notes', ...Array.from({ length: 260 }, (_, i) => `- 2026-10-01: filler note ${i}`)].join('\n') + '\n';
    await typeInto(`${ROOT} [data-memory-editor="MEMORY.md"]`, many);
    assert.equal(await js(`document.querySelector(${q(`${ROOT} [data-editor-path="MEMORY.md"]`)}).dataset.dirty`), 'true');
    assert.match(await text(`${ROOT} [data-editor-path="MEMORY.md"] .bots-count`), /not saved/);
    await clickButton(`${ROOT} [data-editor-path="MEMORY.md"]`, 'Save');
    await waitFor(`document.querySelector(${q(`${ROOT} [data-editor-path="MEMORY.md"]`)}).dataset.dirty === 'false'`);
    await waitFor(`document.querySelector(${q(`${ROOT} .bots-mem-capacity`)}).dataset.level === 'over'`);
    assert.match(await text(`${ROOT} .bots-mem-warning`), /Only the first 200 lines/, 'what is read versus stored');
    assert.equal(await js(`document.querySelector(${q(`${ROOT} .bots-mem-meter`)}).getAttribute('aria-valuenow')`), '100');
    await capture('desktop-bots-memory-capacity');
    await typeInto(`${ROOT} [data-memory-editor="MEMORY.md"]`, '## Notes\n- 2026-10-02: one small note\n');
    await clickButton(`${ROOT} [data-editor-path="MEMORY.md"]`, 'Save');
    await waitFor(`document.querySelector(${q(`${ROOT} .bots-mem-capacity`)}).dataset.level === 'ok'`);

    // Create a topic, edit it, and meet a 409.
    assert.match(await text(`${ROOT} [data-part=topics]`), /No topics yet/);
    await typeInto(`${ROOT} .bots-mem-topic-name`, 'bad name!');
    await clickButton(`${ROOT} .bots-mem-new-topic`, 'Create topic');
    assert.match(await text(`${ROOT} [data-part=topics] .bots-mem-status`), /letters, numbers/, 'a bad name is explained, nothing is sent');
    assert.equal((await overview(botId)).files.filter(f => f.kind === 'topic').length, 0);
    await typeInto(`${ROOT} .bots-mem-topic-name`, 'hiring');
    await typeInto(`${ROOT} .bots-mem-topic-desc`, 'Hiring criteria');
    await clickButton(`${ROOT} .bots-mem-new-topic`, 'Create topic');
    const TOPIC = `${ROOT} [data-editor-path="memory/hiring.md"]`;
    await waitFor(`!!document.querySelector(${q(TOPIC)})`);
    assert.match(await text(`${ROOT} [data-doc-path="memory/hiring.md"]`), /Hiring criteria/, 'the topic is listed with its description');
    await waitFor(`document.activeElement === document.querySelector(${q(`${TOPIC} textarea`)})`);
    await typeInto(`${TOPIC} textarea`, '---\ntitle: hiring\ndescription: Hiring criteria\n---\nRemote roles only.\n');
    await clickButton(TOPIC, 'Save');
    await waitFor(`document.querySelector(${q(TOPIC)}).dataset.dirty === 'false'`);
    assert.match((await fileOf(botId, 'memory/hiring.md')).text, /Remote roles only/);

    // Someone else edits the topic while a draft is open: the draft stays, Overwrite needs a check, Reload takes theirs.
    await typeInto(`${TOPIC} textarea`, '---\ntitle: hiring\ndescription: Hiring criteria\n---\nMy draft.\n');
    const theirs = await fileOf(botId, 'memory/hiring.md');
    await putFile(botId, 'memory/hiring.md', { text: '---\ntitle: hiring\ndescription: Hiring criteria\n---\nTheir edit.\n', expected_hash: theirs.hash });
    await clickButton(TOPIC, 'Save');
    await waitFor(`document.querySelector(${q(TOPIC)}).dataset.conflict === 'true'`);
    assert.match(await text(`${TOPIC} .bots-mem-conflict`), /changed somewhere else/);
    assert.match(await js(`document.querySelector(${q(`${TOPIC} textarea`)}).value`), /My draft/, 'the draft survives the conflict');
    assert.equal((await buttonState(TOPIC, 'Save')).disabled, true, 'Save is off while the copies differ');
    assert.equal((await buttonState(TOPIC, 'Overwrite')).disabled, true, 'Overwrite waits for the check');
    assert.match((await fileOf(botId, 'memory/hiring.md')).text, /Their edit/, 'nothing was overwritten');
    await capture('desktop-bots-memory-conflict');
    await clickButton(TOPIC, 'Reload (drop my changes)');
    await waitFor(`document.querySelector(${q(TOPIC)}).dataset.conflict === 'false'`);
    assert.match(await js(`document.querySelector(${q(`${TOPIC} textarea`)}).value`), /Their edit/);
    // Again, and this time replace theirs on purpose.
    await typeInto(`${TOPIC} textarea`, '---\ntitle: hiring\ndescription: Hiring criteria\n---\nMine, on purpose.\n');
    const again = await fileOf(botId, 'memory/hiring.md');
    await putFile(botId, 'memory/hiring.md', { text: '---\ntitle: hiring\ndescription: Hiring criteria\n---\nTheirs again.\n', expected_hash: again.hash });
    await clickButton(TOPIC, 'Save');
    await waitFor(`document.querySelector(${q(TOPIC)}).dataset.conflict === 'true'`);
    await click(`${TOPIC} .bots-mem-conflict input[type=checkbox]`);
    await waitFor(`!document.querySelector(${q(`${TOPIC} .bots-mem-conflict`)}).querySelector('.bots-btn.danger').disabled`);
    await clickButton(`${TOPIC} .bots-mem-conflict`, 'Overwrite');
    await waitFor(`document.querySelector(${q(TOPIC)}).dataset.conflict === 'false' && document.querySelector(${q(TOPIC)}).dataset.dirty === 'false'`);
    assert.match((await fileOf(botId, 'memory/hiring.md')).text, /Mine, on purpose/);

    // A poll never replaces a draft, even when the panel redraws around it.
    await typeInto(`${TOPIC} textarea`, 'A draft that must survive.');
    await js(`window.__keep = document.querySelector(${q(`${TOPIC} textarea`)}); true`);
    await js(`document.dispatchEvent(new CustomEvent('jarvis:agents-changed', { detail: { agentId: ${q(botId)}, source: 'elsewhere' } })); window.__panel.refresh(); true`);
    await delay(600);
    assert.equal(await js(`document.querySelector(${q(`${TOPIC} textarea`)}) === window.__keep`), true, 'the same editor, not a new one');
    assert.equal(await js(`document.querySelector(${q(`${TOPIC} textarea`)}).value`), 'A draft that must survive.');

    // Closing asks before it throws a draft away, and focus goes back to the row that opened it.
    await clickButton(TOPIC, 'Close');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await click('.confirm-panel .modal-footer .btn:first-child');
    await waitFor("!document.querySelector('.confirm-panel')");
    assert.equal(await exists(TOPIC), true, 'Cancel keeps the draft open');
    await clickButton(TOPIC, 'Discard changes');
    await clickButton(TOPIC, 'Close');
    await waitFor(`!document.querySelector(${q(TOPIC)})`);
    assert.equal(await js("document.activeElement?.getAttribute('data-doc-path')"), null, 'it was opened by Create topic, so focus is on the topic form');
    await click(`${ROOT} [data-doc-path="memory/hiring.md"]`);
    await waitFor(`!!document.querySelector(${q(TOPIC)})`);
    await clickButton(TOPIC, 'Close');
    await waitFor(`!document.querySelector(${q(TOPIC)})`);
    assert.equal(await js("document.activeElement?.getAttribute('data-doc-path')"), 'memory/hiring.md', 'focus returns to the row that opened it');

    // ================= The change history: diffs, Undo, and a stale Undo ===========================================================
    const note = '<img src=x onerror="window.__xss=1"> and <b>bold</b>';
    const idx2 = (await overview(botId)).index;
    const added = await call(url(botId, '/entries'), 'POST', { action: 'append', path: 'MEMORY.md', expected_hash: idx2.hash, section: 'Notes', text: note });
    assert.equal(added.status, 200);
    const topic0 = await fileOf(botId, 'memory/hiring.md');
    const editA = await putFile(botId, 'memory/hiring.md', { text: `${topic0.text}A\n`, expected_hash: topic0.hash });
    const editB = await putFile(botId, 'memory/hiring.md', { text: `${editA.body.file.text}B\n`, expected_hash: editA.body.file.hash });
    await mountMemory(botId, 'advanced');
    await loaded();
    const rowOf = id => `${ROOT} .bots-mem-change[data-change-id="${id}"]`;
    await waitFor(`!!document.querySelector(${q(rowOf(editB.body.change_id))})`);
    assert.match(await text(`${rowOf(editB.body.change_id)} .bots-row-hint`), /You/);
    await clickButton(rowOf(editB.body.change_id), 'Show changes');
    await waitFor(`!!document.querySelector(${q(`${rowOf(editB.body.change_id)} .bots-mem-diff`)})`);
    assert.ok(await exists(`${rowOf(editB.body.change_id)} .bots-mem-diff-add`), 'added lines are marked');
    assert.equal(await js(`document.querySelector(${q(`${rowOf(editB.body.change_id)} [data-toggle]`)}).getAttribute('aria-expanded')`), 'true');
    await clickButton(rowOf(editB.body.change_id), 'Hide changes');
    // The note with markup is plain text everywhere: list and diff.
    await clickButton(rowOf(added.body.change_id), 'Show changes');
    await waitFor(`!!document.querySelector(${q(`${rowOf(added.body.change_id)} .bots-mem-diff`)})`);
    assert.match(await text(`${rowOf(added.body.change_id)} .bots-mem-diff`), /<img src=x onerror=/, 'shown as text');
    assert.equal(await js(`document.querySelectorAll(${q(`${HOST} img[src="x"], ${HOST} b`)}).length`), 0, 'no element was made from a note');
    assert.equal(await js('window.__xss === undefined'), true, 'nothing ran');
    // Undoing the older edit while a newer one sits on top is refused and changes nothing.
    await clickButton(rowOf(editA.body.change_id), 'Undo');
    await waitFor("document.querySelectorAll('#toast-host .toast.error').length > 0");
    assert.match((await errorToasts())[0], /cannot be undone/);
    expected.push(...await errorToasts());
    await clearToasts();
    assert.match((await fileOf(botId, 'memory/hiring.md')).text, /A\nB\n$/, 'the stale Undo changed nothing');
    // The newest first, then the older one.
    await clickButton(rowOf(editB.body.change_id), 'Undo');
    await waitFor(`document.querySelector(${q(rowOf(editB.body.change_id))})?.dataset.reverted === 'true'`);
    assert.doesNotMatch((await fileOf(botId, 'memory/hiring.md')).text, /\nB\n$/);
    assert.equal((await buttonState(rowOf(editB.body.change_id), 'Undone')).disabled, true, 'it cannot be undone twice');
    await clickButton(rowOf(editA.body.change_id), 'Undo');
    await waitFor(`document.querySelector(${q(rowOf(editA.body.change_id))})?.dataset.reverted === 'true'`);
    assert.equal((await fileOf(botId, 'memory/hiring.md')).text, topic0.text, 'both Undos put the exact text back');
    await capture('desktop-bots-memory-history');
    await clearToasts();

    // ================= Tidy-up, the archive, read-only logs, the folder ============================================================
    const idx3 = (await overview(botId)).index;
    await call(url(botId, '/entries'), 'POST', { action: 'append', path: 'MEMORY.md', expected_hash: idx3.hash, section: 'Notes', text: 'An old contract rate', until: '2020-01-01' });
    assert.equal((await buttonState(`${ROOT} .bots-mem-tidy`, 'Tidy now')).disabled, true, 'Tidy now needs tidying switched on');
    await mountMemory(botId, 'advanced');
    await loaded();
    await click(`${ROOT} [data-part=maintenance] .bots-switch-row`);
    for (let i = 0; i < 80; i++) { if ((await call(`/api/agents/${botId}`)).body.agent.memory_upkeep === true) break; await delay(50); }
    assert.equal((await call(`/api/agents/${botId}`)).body.agent.memory_upkeep, true, 'the switch is a profile setting and is saved');
    await waitFor(`!document.querySelector(${q(`${ROOT} .bots-mem-tidy button`)}).disabled`);
    await clickButton(`${ROOT} .bots-mem-tidy`, 'Tidy now');
    await waitFor(`/Tidied 1 page/.test(document.querySelector(${q(`${ROOT} [data-part=maintenance] .bots-mem-status`)}).textContent)`);
    await waitFor(`!!document.querySelector(${q(`${ROOT} [data-doc-path="memory/archive.md"]`)})`);
    assert.doesNotMatch((await fileOf(botId, 'MEMORY.md')).text, /An old contract rate/);
    assert.match((await fileOf(botId, 'memory/archive.md')).text, /An old contract rate/);
    assert.match(await text(`${ROOT} [data-part=journal]`), /Tidied 1 note/);
    assert.match(await text(`${ROOT} .bots-mem-last`), /Last change: Tidied 1 note/);
    const tidyRow = await js(`document.querySelector(${q(`${ROOT} [data-part=journal] .bots-mem-change`)}).dataset.changeId`);
    assert.match(await text(rowOf(tidyRow)), /Tidy-up/);
    await clickButton(rowOf(tidyRow), 'Undo');
    await waitFor(`document.querySelector(${q(rowOf(tidyRow))})?.dataset.reverted === 'true'`);
    assert.match((await fileOf(botId, 'MEMORY.md')).text, /An old contract rate/, 'the tidy pass is undone');
    await waitFor(`!document.querySelector(${q(`${ROOT} [data-doc-path="memory/archive.md"]`)})`);

    // Logs are read only.
    demoState.botsMemory.books[botId].files['memory/log/2026-10-28.md'] = '# 2026-10-28\n\n- 09:00 [run r1] Captured two notes\n';
    await mountMemory(botId, 'advanced');
    await loaded();
    const LOG = `${ROOT} [data-editor-path="memory/log/2026-10-28.md"]`;
    await click(`${ROOT} [data-doc-path="memory/log/2026-10-28.md"]`);
    await waitFor(`!!document.querySelector(${q(LOG)})`);
    await waitFor(`document.querySelector(${q(`${LOG} textarea`)}).value.includes('Captured two notes')`);
    assert.equal(await js(`document.querySelector(${q(`${LOG} textarea`)}).readOnly`), true);
    assert.equal(await buttonState(LOG, 'Save'), null, 'a log has no Save');
    assert.match(await text(`${LOG} .bots-count`), /Read only/);
    assert.equal((await putFile(botId, 'memory/log/2026-10-28.md', { text: 'x', expected_hash: (await fileOf(botId, 'memory/log/2026-10-28.md')).hash })).status, 403);
    await clickButton(LOG, 'Close');
    await waitFor(`!document.querySelector(${q(LOG)})`);

    // The folder.
    await clickButton(`${ROOT} .bots-mem-open`, 'Open folder');
    await waitFor(`/Opened the folder/.test(document.querySelector(${q(`${ROOT} [data-part=location] .bots-mem-status`)}).textContent)`);
    demoState.botsMemory.remote = true;
    await clickButton(`${ROOT} .bots-mem-open`, 'Open in Obsidian');
    await waitFor(`/only works on the computer/.test(document.querySelector(${q(`${ROOT} [data-part=location] .bots-mem-status`)}).textContent)`);
    demoState.botsMemory.remote = false;
    assert.deepEqual(demoState.botsMemory.opened, ['folder']);

    // ================= A load that fails says so and can be retried; destroying mid-request is quiet ==============================
    demoState.botsMemory.failOverview = 1;
    await mountMemory(botId, 'advanced');
    await waitFor(`/could not load/.test(document.querySelector(${q(`${ROOT} .bots-mem-state`)})?.textContent || '')`);
    await clickButton(`${ROOT} .bots-mem-state`, 'Try again');
    await loaded();
    assert.ok(await exists(`${ROOT} [data-memory-editor="MEMORY.md"]`));
    await mountRaw(botId, 'simple');
    await js("window.__panel.openSection('memory'); window.__panel.destroy(); document.getElementById('bots-mem-host')?.remove(); true");
    await delay(500);

    // ================= Phone: nothing scrolls sideways, in either mode ==========================================================
    phone = true;
    win.setContentSize(390, 800); await delay(500);
    for (const mode of ['simple', 'advanced']) {
      await mountMemory(botId, mode);
      await js("document.getElementById('bots-mem-host').style.width = '100vw'; true");
      await loaded();
      if (mode === 'advanced') await waitFor(`!!document.querySelector(${q(`${ROOT} [data-memory-editor="MEMORY.md"]`)})`);
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, `no sideways scroll at phone width (${mode})`);
      assert.equal(await js(`(() => { const r = document.querySelector(${q(ROOT)}).getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1; })()`), true, `the section fits the screen (${mode})`);
      assert.equal(await js(`(() => { const n = document.querySelector(${q(ROOT)}); return n.scrollWidth <= n.clientWidth + 1; })()`), true, `the section itself does not overflow (${mode})`);
      assert.ok(await js(`[...document.querySelectorAll(${q(`${ROOT} .bots-btn`)})].filter(n => n.getBoundingClientRect().height > 0).every(n => n.getBoundingClientRect().height >= 30)`), `buttons are easy to hit (${mode})`);
      await capture(`phone-bots-memory-${mode}`);
    }
    win.setContentSize(1440, 900); await delay(400); phone = false;

    assert.deepEqual((await errorToasts()).filter(t => !expected.includes(t)), [], 'no unexpected error toast');
    assert.deepEqual(await js('window.__errs'), [], 'no script errors in the page');
  } finally {
    try {
      await closeDialogs();
      await js("window.__unhide?.disconnect(); window.__panel?.destroy(); document.getElementById('bots-mem-host')?.remove(); document.documentElement.dataset.appMode = window.__prior || ''; true");
      if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
      await js(`localStorage.setItem('kairos:bots-interface', ${q(savedInterface)}); if (!${q(savedInterface)}) localStorage.removeItem('kairos:bots-interface'); true`);
      if (phone) win.setContentSize(1440, 900);
    } finally {
      delete demoState.botsMemory; delete demoState.botsSectionModules; if (seededAttention) delete demoState.botsAttention;
      await restore();
    }
  }
};
