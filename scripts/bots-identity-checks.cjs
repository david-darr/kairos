// Bots Phase 1, unit U2: identity, avatar and the fourteen-section panel, in the renderer.
// Run: python run_electron_target.py <worktree> --bots-identity-only <log> 600
//   (or node scripts/run-electron-test.cjs ui-smoke --bots-identity-only)
// Mounts the real botsPanel.js in a scratch host against the in-memory Bots backend (fixtures/bots-core-backend.cjs and
// fixtures/bots-identity-backend.cjs). It creates its own bot, never assumes which other bots exist, and removes
// everything it made, and restores its page preferences, in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

const SECTIONS = ['overview', 'identity', 'delivery', 'soul', 'skills', 'memory', 'routines', 'access', 'model', 'permissions', 'voice', 'who', 'history', 'usage'];

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base }) => {
  const q = JSON.stringify;
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const type = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const commit = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); n.blur(); n.dispatchEvent(new Event('blur')); return true; })()`);
  const key = (selector, name) => js(`(() => { const n = document.querySelector(${q(selector)}); n.dispatchEvent(new KeyboardEvent('keydown', { key: ${q(name)}, bubbles: true, cancelable: true })); return true; })()`);
  const toasts = () => js("[...document.querySelectorAll('#toast-host .toast')].map(n => n.textContent)");
  const errorToasts = () => js("[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)");
  const clearToasts = () => js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
  const yes = () => click('.confirm-panel .modal-footer .btn:last-child');
  const closeDialogs = () => js(`(() => { for (let i = 0; i < 6; i++) { const b = document.querySelector('.modal-backdrop .modal-close-btn'); if (!b) break; b.click(); }
    document.querySelectorAll('.modal-backdrop').forEach(n => n.remove()); return true; })()`);
  const mountPanel = async (id, mode) => { await mountRaw(id, mode); await waitFor("!!document.querySelector('#bots-id-host .bots-panel-top') && !!document.querySelector('#bots-id-host .bots-panel-scroll')"); };
  const mountRaw = (id, mode) => js(`(async () => {
    const P = await import('/static/js/botsPanel.js');
    window.__panel?.destroy();
    document.getElementById('bots-id-host')?.remove();
    const host = document.createElement('div');
    host.id = 'bots-id-host';
    host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:' + (${q(mode)} === 'advanced' ? 'min(420px,42vw)' : '320px') + ';z-index:30;background:var(--bots-panel)';
    document.body.append(host);
    window.__closed = 0;
    window.__panel = P.mountBotPanel(host, { agentId: ${q(id)}, mode: ${q(mode)}, onClose: () => { window.__closed++; } });
    return true;
  })()`);
  const setInterfaceMode = advanced => js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${advanced}); return m.isAdvanced(); })`);
  const openSection = async id => {
    if (!(await exists(`#bots-id-host .bots-acc-item[data-section=${id}][data-open=true]`))) await click(`#bots-id-host .bots-acc-head[data-section=${id}]`);
    await waitFor(`!!document.querySelector('#bots-id-host .bots-acc-item[data-section=${id}][data-open=true] .bots-acc-body')`);
  };
  const card = id => `#bots-id-host [data-panel-card=${id}]`;
  const botRecord = id => call(`/api/agents/${id}`).then(r => r.body);
  const waitSaved = async (id, test, what) => {
    for (let i = 0; i < 80; i++) { if (test(await botRecord(id))) return; await delay(50); }
    const last = (await botRecord(id)).agent;
    throw new Error(`Timed out waiting for the saved record: ${what}. Now: ${JSON.stringify({ name: last.name, role: last.role, reply_style: last.reply_style, notifications: last.notifications, soul: last.soul })}; writes: ${JSON.stringify(writes.slice(-4).map(w => [w.method, w.path, w.status, w.body.slice(0, 80)]))}`);
  };
  const upload = () => js(`(() => {
    const input = document.querySelector('#bots-id-host .bots-avatar-file');
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'face.png', { type: 'image/png' }));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const expected = [];   // error toasts this check caused on purpose

  const savedInterface = await js("localStorage.getItem('kairos:bots-interface') || ''");
  const restore = await isolateBotsCheck({ js, demoState });
  let botId = null, phone = false;
  try {
    demoState.botsLive = true;
    delete demoState.botsIdentity;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__prior = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots';
      window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason && e.reason.stack || e.reason)));
      window.__nav = []; document.addEventListener('jarvis:navigate', e => { window.__nav.push(e.detail); e.stopImmediatePropagation(); }, true); return true; })()`);
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");   // seeds the in-memory backend
    const made = await call('/api/agents', 'POST', { name: `Identity Probe ${Date.now() % 100000}`, role: 'Original job', soul: 'Be brief and kind.' });
    assert.equal(made.status, 200, 'the check makes its own bot');
    botId = made.body.id;
    await setInterfaceMode(true);

    // ================= All fourteen sections, in order, with real content ======================================================
    await mountPanel(botId, 'advanced');
    await waitFor("document.querySelectorAll('#bots-id-host .bots-acc-item').length === 14");
    assert.deepEqual(await js("[...document.querySelectorAll('#bots-id-host .bots-acc-item')].map(n => n.dataset.section)"), SECTIONS, 'fourteen sections in the designed order');
    assert.deepEqual(await js("[...document.querySelectorAll('#bots-id-host .bots-acc-head .bots-acc-label')].map(n => n.textContent).slice(10, 12)"), ['Voice and alerts', 'Who can see it']);
    await capture('desktop-bots-identity-advanced');
    await waitFor("!!document.querySelector('#bots-id-host .bots-glance')");
    assert.match(await text('#bots-id-host .bots-glance'), /Original job/, 'Overview: the facts come from the record');
    assert.ok(await exists('#bots-id-host .bots-prompt'), 'Overview: the exact prompt preview');
    await click('#bots-id-host .bots-prompt summary');
    await waitFor("!!document.querySelector('#bots-id-host .bots-prompt-part')");
    assert.match(await text('#bots-id-host .bots-prompt-summary'), /bytes/);

    await openSection('identity');
    await waitFor(`!!document.querySelector('${card('identity')} .bots-avatar-editor')`);
    assert.ok(await exists(`${card('identity')} .bots-identity`), 'Identity: fields and the avatar editor');

    await openSection('delivery');
    await waitFor(`!!document.querySelector('${card('delivery')} .bots-card')`);
    assert.match(await text(card('delivery')), /Where it reports|Tell me on/);

    await openSection('soul');
    assert.match(await text(`${card('soul')} .bots-count`), /^\d[\d,]* \/ 24,000 bytes$/, 'Soul: the byte counter');
    assert.equal(await js(`document.querySelector('${card('soul')} textarea').value`), 'Be brief and kind.');

    await openSection('skills');
    await waitFor(`!!document.querySelector('${card('skills')} .bots-switch-row') || /no skills/i.test(document.querySelector('${card('skills')}').textContent)`);
    assert.match(await text(card('skills')), /only reviewed skills switched on for this bot/i, 'Skills: the effective scope is stated');

    await openSection('memory');
    await waitFor(`!!document.querySelector('${card('memory')} textarea')`);
    assert.ok(await exists(`${card('memory')} textarea`), 'Memory: the editable notes');

    await openSection('routines');
    await waitFor(`document.querySelector('${card('routines')}').textContent.includes('Routines (0)')`);

    await openSection('access');
    await waitFor(`!!document.querySelector('${card('access')} .bots-card')`);
    assert.match(await text(card('access')), /Tool servers/);

    await openSection('model');
    await waitFor(`!!document.querySelector('${card('model')} .agent-model-picker')`);
    assert.match(await text(card('model')), /Keep warm/);
    assert.match(await text(card('model')), /If this model fails/);

    await openSection('permissions');
    assert.equal(await js(`document.querySelectorAll('${card('permissions')} [aria-label=Approval] [role=radio]').length`), 5, 'Permissions: all five levels are shown');
    assert.equal(await js(`document.querySelectorAll('${card('permissions')} [aria-label=Approval] [role=radio]:not([disabled])').length`), 5, 'every level can be picked');
    assert.equal(await js(`document.querySelector('${card('permissions')} [aria-label=Approval] [role=radio][data-value=full]').getAttribute('aria-checked')`), 'true');
    assert.match(await text(card('permissions')), /Tool and account grants still limit what it can reach/i, 'Full is described as limited by grants');
    assert.doesNotMatch(await text(card('permissions')), /saved choices for later|not available yet/i, 'no level is described as inactive');

    await openSection('voice');
    await waitFor(`!!document.querySelector('${card('voice')} .bots-switch-row ~ *') && /Call mode|Turns/.test(document.querySelector('${card('voice')}').textContent)`);
    await openSection('who');
    await waitFor(`/Account/.test(document.querySelector('${card('who')}').textContent)`);
    assert.match(await text(card('who')), /not shared with other people/);
    await openSection('history');
    await waitFor(`!!document.querySelector('${card('history')} .bots-history-rows')`);
    await openSection('usage');
    assert.match(await text(card('usage')), /daily runs used/);
    assert.match(await text(card('usage')), /Cost is not tracked/, 'Usage: unavailable cost is said, not invented');
    assert.deepEqual(await errorToasts(), [], 'no error toast from opening every section');

    // ================= Saved settings survive a reload of the panel ==========================================================
    await openSection('soul');
    await click(`${card('soul')} .bots-segmented [data-value=conversational]`);
    await openSection('voice');
    await waitFor(`!!document.querySelector('${card('voice')} .bots-switch-row')`);
    await click(`${card('voice')} .bots-switch-row`);   // notifications off
    await waitSaved(botId, r => r.agent.reply_style === 'conversational' && r.agent.notifications === false, 'reply style and notifications');
    await mountPanel(botId, 'advanced');
    await openSection('soul');
    assert.equal(await js(`document.querySelector('${card('soul')} .bots-segmented [data-value=conversational]').getAttribute('aria-checked')`), 'true', 'a saved reply style comes back after a reload');
    await openSection('voice');
    await waitFor(`document.querySelector('${card('voice')} .bots-switch-row .bots-switch')?.getAttribute('aria-checked') === 'false'`);

    // ================= Inline commits and Escape ==============================================================================
    await openSection('identity');
    const nameInput = `${card('identity')} .bots-identity .bots-text-row:nth-child(1) input`;
    await type(nameInput, 'Throwaway name');
    await key(nameInput, 'Escape');
    assert.equal(await js(`document.querySelector('${nameInput}').value`), await js(`'${made.body.name}'`), 'Escape puts the old name back');
    await commit(`${card('identity')} .bots-identity .bots-text-row:nth-child(2) input`, 'Checks the probes');
    await waitSaved(botId, r => r.agent.role === 'Checks the probes', 'the job');
    assert.equal((await botRecord(botId)).agent.name, made.body.name, 'the abandoned name was never sent');

    // ================= Soul drift, and a race with the file ===================================================================
    demoState.botsCore.soulFiles = { ...(demoState.botsCore.soulFiles || {}), [botId]: 'Edited in a text editor.' };
    await js('window.__panel.refresh()');
    await openSection('soul');
    await waitFor(`!!document.querySelector('${card('soul')} .bots-drift')`);
    assert.ok(await exists(`${card('soul')} .bots-drift .bots-diff-line.add`) && await exists(`${card('soul')} .bots-drift .bots-diff-line.del`), 'the drift shows what differs');
    assert.equal(await js(`document.querySelector('${card('soul')} textarea').disabled`), true, 'editing waits until the file edit is resolved');
    // The file moves again after it was read: the stale choice is refused and the new difference is shown.
    demoState.botsCore.soulFiles[botId] = 'Edited again, later.';
    const useFile = [...(await js(`[...document.querySelectorAll('${card('soul')} .bots-drift .bots-btn')].map(n => n.textContent)`))].indexOf('Use the file');
    await js(`document.querySelectorAll('${card('soul')} .bots-drift .bots-btn')[${useFile}].click()`);
    await waitFor("[...document.querySelectorAll('#toast-host .toast.error')].length > 0");
    expected.push(...(await errorToasts()));
    assert.equal((await botRecord(botId)).agent.soul, 'Be brief and kind.', 'a stale Apply changed nothing');
    await waitFor(`/Edited again, later\\./.test(document.querySelector('${card('soul')} .bots-drift')?.textContent || '')`);
    await clearToasts();
    await click(`${card('soul')} .bots-drift .bots-actions .bots-btn:nth-child(2)`);   // keep what Kairos has
    await waitFor(`!document.querySelector('${card('soul')} .bots-drift')`);
    assert.equal(await js(`document.querySelector('${card('soul')} textarea').disabled`), false);
    assert.equal((await botRecord(botId)).soul_file.in_sync, true);

    // ================= History: rows, a diff, and rolling instructions back ====================================================
    await commit(`${card('soul')} textarea`, 'Be brief and kind. Always say thanks.');
    await waitSaved(botId, r => r.agent.soul === 'Be brief and kind. Always say thanks.', 'the new soul');
    await openSection('history');
    await js('window.__panel.refresh()');
    await waitFor(`!!document.querySelector('${card('history')} .bots-history-row')`);
    assert.match(await text(`${card('history')} .bots-history-rows`), /changed the standing instructions/);
    await click(`${card('history')} .bots-history-row .bots-btn`);
    await waitFor(`!!document.querySelector('${card('history')} .bots-history-detail .bots-diff-line.add')`);
    const restoreIndex = await js(`[...document.querySelectorAll('${card('history')} .bots-history-row')].findIndex(r => /standing instructions/.test(r.textContent) && [...r.querySelectorAll('.bots-btn')].some(b => /Restore/.test(b.textContent)))`);
    assert.ok(restoreIndex >= 0, 'a soul row offers Restore');
    await js(`[...document.querySelectorAll('${card('history')} .bots-history-row')][${restoreIndex}].querySelectorAll('.bots-btn')[1].click()`);
    await waitFor("!!document.querySelector('.confirm-panel')");
    await yes();
    await waitSaved(botId, r => r.agent.soul === 'Be brief and kind.', 'the restored soul');
    assert.equal(await js(`document.querySelectorAll('${card('history')} .bots-history-row .bots-btn').length > 0`), true);

    // ================= A change the bot made to itself, with a stale-safe Undo ==================================================
    const bot = () => demoState.botsCore.agents.find(a => a.id === botId);
    bot().profile_proposals = [{ id: 'rcpt-one', kind: 'profile', reason: 'You asked me to.', ts: Date.now() / 1000, before: { role: 'Checks the probes' }, after: { role: 'Watches the probes' }, revision: (bot().revision || 0) + 1, state: 'applied' }];
    bot().role = 'Watches the probes'; bot().revision = (bot().revision || 0) + 1;
    await js('window.__panel.refresh()');
    await waitFor(`!!document.querySelector('${card('history')} .bots-proposal')`);
    assert.match(await text(`${card('history')} .bots-proposal`), /Why: You asked me to\./);
    await click(`${card('history')} .bots-proposal .bots-btn`);
    await waitSaved(botId, r => r.agent.role === 'Checks the probes', 'the undone role');
    await waitFor(`/Undone/.test(document.querySelector('${card('history')} .bots-proposal .bots-btn')?.textContent || '')`);
    bot().profile_proposals.push({ id: 'rcpt-two', kind: 'profile', reason: 'Because.', ts: Date.now() / 1000, before: { role: 'Checks the probes' }, after: { role: 'Third job' }, revision: (bot().revision || 0) + 1, state: 'applied' });
    bot().role = 'Third job'; bot().revision = (bot().revision || 0) + 1;
    await js('window.__panel.refresh()');
    await waitFor(`document.querySelectorAll('${card('history')} .bots-proposal').length === 2`);
    bot().revision += 1;   // someone edited it after: the receipt is stale
    await clearToasts();
    await js(`document.querySelector('${card('history')} .bots-proposal[data-receipt=rcpt-two] .bots-btn').click()`);
    await waitFor("[...document.querySelectorAll('#toast-host .toast.error')].some(n => /changed again/.test(n.textContent))");
    expected.push(...(await errorToasts()));
    assert.equal((await botRecord(botId)).agent.role, 'Third job', 'a stale Undo leaves the later edit alone');
    await clearToasts();

    // ================= Memory stays mounted, and routines work ================================================================
    await openSection('memory');
    await waitFor(`!!document.querySelector('${card('memory')} textarea')`);
    await type(`${card('memory')} textarea`, 'A draft the person has not saved');
    await openSection('usage');
    await js('window.__panel.refresh()');
    await openSection('memory');
    assert.equal(await js(`document.querySelector('${card('memory')} textarea').value`), 'A draft the person has not saved', 'a Memory draft survives leaving the section and a poll');
    const memoryMark = writes.length;   // earlier checks in a full run wrote to bots with the same IDs
    await click(`${card('memory')} .bots-actions .bots-btn`);
    for (let i = 0; i < 60 && !writes.slice(memoryMark).some(w => w.path === `/api/agents/${botId}/memory` && w.method === 'PUT' && w.status === 200); i++) await delay(50);
    assert.equal(demoState.botsCore.memoryText[botId], 'A draft the person has not saved');

    await openSection('routines');
    await waitFor(`!!document.querySelector('${card('routines')} .bots-actions .bots-btn')`);
    await click(`${card('routines')} .bots-actions .bots-btn`);
    await waitFor("!!document.querySelector('.panel-dialog [aria-label=\"Routine name\"]')");
    await type('.panel-dialog [aria-label="Routine name"]', 'Morning sweep');
    await type('.panel-dialog [aria-label="What to do"]', 'Look for new probe results.');
    await click('.panel-dialog .bots-dialog-footer .bots-btn.primary');
    await waitFor(`!!document.querySelector('${card('routines')} .bots-routine')`);
    assert.match(await text(`${card('routines')} .bots-routine`), /Morning sweep/);
    assert.match(await text(`${card('routines')} .bots-routine`), /At 08:00 every day/);
    await js(`[...document.querySelectorAll('${card('routines')} .bots-routine .bots-btn')].find(b => /Check now/.test(b.textContent)).click()`);
    for (let i = 0; i < 40 && !(demoState.botsIdentity.ran || []).length; i++) await delay(50);
    assert.equal((demoState.botsIdentity.ran || []).length, 1, 'Check now ran the routine');
    await js(`[...document.querySelectorAll('${card('routines')} .bots-routine .bots-btn')].find(b => /Pause/.test(b.textContent)).click()`);
    await waitFor(`/paused/.test(document.querySelector('${card('routines')} .bots-routine')?.textContent || '')`);
    await js(`[...document.querySelectorAll('${card('routines')} .bots-routine .bots-btn')].find(b => /Remove/.test(b.textContent)).click()`);
    await waitFor("!!document.querySelector('.confirm-panel')");
    await yes();
    await waitFor(`!document.querySelector('${card('routines')} .bots-routine')`);

    // ================= A later phase's module mounts, and a broken one falls back with a note =================================
    demoState.botsSectionModules = ['Memory'];
    await js(`(async () => { const host = await import('/static/js/botsPanelHost.js'); window.__mounts = []; window.__host = host;
      host.stubBotsModule('section:Memory', { mount(el, ctx) { el.textContent = 'Phase 2 memory for ' + ctx.agentId; window.__mounts.push('mount'); return { destroy() { window.__mounts.push('destroy'); }, refresh() {}, flush() {} }; } }); return true; })()`);
    await mountPanel(botId, 'advanced');
    await openSection('memory');
    await waitFor(`/Phase 2 memory for ${botId}/.test(document.querySelector('${card('memory')}')?.textContent || '')`);
    await mountPanel(botId, 'advanced');
    assert.deepEqual((await js('window.__mounts')).slice(0, 2), ['mount', 'destroy'], 'a section module is destroyed with the panel');
    await js(`window.__host.stubBotsModule('section:Memory', () => Promise.reject(new Error('stubbed failure')))`);
    await mountPanel(botId, 'advanced');
    await openSection('memory');
    await waitFor(`/could not load its full view/.test(document.querySelector('${card('memory')}')?.textContent || '') && !!document.querySelector('${card('memory')} textarea')`);
    await js('window.__host.clearBotsStubs()');
    demoState.botsSectionModules = [];

    // ================= Avatar: upload, framing, refusal, fallback, reset =======================================================
    await mountPanel(botId, 'advanced');
    await openSection('identity');
    await upload();
    await waitFor(`!!document.querySelector('${card('identity')} .bots-avatar-editor [role=radiogroup][aria-label="Picture shape"]')`);
    assert.ok(await exists(`${card('identity')} [data-control=zoom]`) && await exists(`${card('identity')} [data-control=focus_x]`), 'the framing controls appear');
    assert.equal((await botRecord(botId)).agent.avatar_image, null, 'a staged picture is not saved until it is applied');
    await click(`${card('identity')} .bots-segmented [data-value=rounded]`);
    await type(`${card('identity')} [data-control=zoom]`, '2');
    await type(`${card('identity')} [data-control=focus_x]`, '0.25');
    await capture('desktop-bots-identity-framing');
    await click(`${card('identity')} [data-action=apply]`);
    await waitSaved(botId, r => !!r.agent.avatar_image, 'the applied picture');
    const image = (await botRecord(botId)).agent.avatar_image;
    assert.deepEqual([image.shape, image.zoom, image.focus_x, image.focus_y], ['rounded', 2, 0.25, 0.5], 'the framing was saved as chosen');
    // The fixture cannot serve picture bytes, so the picture fails to load and the bot's own Kip takes its place.
    await waitFor("!document.querySelector('#bots-id-host .agent-avatar-picture') && !!document.querySelector('#bots-id-host .bots-adv-title img[src^=\"data:\"]')");
    // A refused file shows its reason beside the editor and keeps the saved picture.
    demoState.botsIdentity.uploadError = 'Use a PNG, JPEG, GIF or WebP picture.';
    await upload();
    await waitFor(`!!document.querySelector('${card('identity')} .bots-error')`);
    assert.match(await text(`${card('identity')} .bots-error`), /PNG, JPEG, GIF or WebP/);
    demoState.botsIdentity.uploadError = null;
    await clearToasts();
    await click(`${card('identity')} [data-action=reset]`);
    await waitSaved(botId, r => r.agent.avatar_image === null, 'the reset');
    assert.ok(Object.hasOwn((await botRecord(botId)).agent, 'avatar') && (await botRecord(botId)).agent.avatar.character === 'ajar', 'reset brings back the same Kip');

    // ================= Generate: the saved connection, and a late result that must not win =====================================
    await click(`${card('identity')} .bots-avatar-make summary`);
    assert.ok(await exists(`${card('identity')} [aria-label="Connection key"]`), 'with no connection, the editor asks for one');
    await type(`${card('identity')} [aria-label="Connection key"]`, 'sk-test-key-123456');
    await click(`${card('identity')} [data-action=save-provider]`);
    await waitFor(`!!document.querySelector('${card('identity')} .bots-avatar-direction')`);
    assert.equal(await js("document.body.innerHTML.includes('sk-test-key-123456')"), false, 'the key is never shown again');
    await type(`${card('identity')} .bots-avatar-direction`, 'a friendly fox in a scarf');
    await click(`${card('identity')} [data-action=generate]`);
    await waitFor(`!!document.querySelector('${card('identity')} [data-action=apply]:not([disabled])')`);
    // The look changes before the picture is applied: the late picture is refused.
    await call(`/api/agents/${botId}`, 'PATCH', { mascot_expression: 'thinking' });
    await clearToasts();
    await click(`${card('identity')} [data-action=apply]`);
    await waitFor("[...document.querySelectorAll('#toast-host .toast.error')].some(n => /look changed/.test(n.textContent))");
    expected.push(...(await errorToasts()));
    assert.equal((await botRecord(botId)).agent.avatar_image, null, 'a late generated picture did not overwrite the newer edit');
    await clearToasts();
    demoState.botsIdentity.generateError = 'The image connection took too long. Try again.';
    await click(`${card('identity')} [data-action=generate]`);
    await waitFor(`!!document.querySelector('${card('identity')} .bots-error')`);
    demoState.botsIdentity.generateError = null;
    await clearToasts();

    // ================= Simple: the three pages and the Settings stack ============================================================
    await setInterfaceMode(false);
    await mountPanel(botId, 'simple');
    await waitFor("!!document.querySelector('#bots-id-host .bots-hero-name')");
    assert.deepEqual(await js("[...document.querySelectorAll('#bots-id-host .bots-tabs [role=tab]')].map(n => n.textContent)"), ['Details', 'Library', 'Computer']);
    assert.equal(await js("document.querySelector('#bots-id-host .bots-tab[aria-selected=true]').textContent"), 'Details');
    assert.ok(await exists(card('model')) && await exists(card('conversations')), 'Details: model and conversations');
    await click('#bots-id-host #bots-tab-library');
    await waitFor(`!!document.querySelector('${card('library')}')`);
    assert.match(await text(card('library')), /Memory/);
    await click('#bots-id-host #bots-tab-computer');
    await waitFor(`!!document.querySelector('${card('computer')} .bots-card')`);
    assert.match(await text(card('computer')), /Contained computer/);
    assert.equal(writes.filter(w => /\/api\/computer\/.+\/(start|takeover)/.test(w.path)).length, 0, 'viewing the Computer page starts nothing');
    await js("document.querySelector('#bots-id-host .bots-tabs').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))");
    await waitFor("document.querySelector('#bots-id-host .bots-tab[aria-selected=true]').textContent === 'Library'");
    await click('#bots-id-host .bots-panel-bar .bots-icon-btn[aria-label=Settings]');
    await waitFor(`!!document.querySelector('${card('soul')}')`);
    const titles = () => js("[...document.querySelectorAll('#bots-id-host .bots-nav-row .bots-row-title')].map(n => n.textContent)");
    for (const label of ['Routines', 'Access', 'More settings']) assert.ok((await titles()).includes(label), `Settings lists ${label}`);
    await js("[...document.querySelectorAll('#bots-id-host .bots-nav-row')].find(n => /More settings/.test(n.textContent)).click()");
    await waitFor("document.querySelector('#bots-id-host .bots-page-title')?.textContent === 'More settings'");
    for (const label of ['Permissions', 'Skills', 'Memory', 'Voice and alerts', 'Who can see it', 'History', 'Usage']) assert.ok((await titles()).includes(label), `More settings lists ${label}`);
    await js("[...document.querySelectorAll('#bots-id-host .bots-nav-row')].find(n => /Who can see it/.test(n.textContent)).click()");
    await waitFor(`!!document.querySelector('${card('who')}')`);
    await key('#bots-id-host .bots-panel', 'Escape');
    await waitFor("document.querySelector('#bots-id-host .bots-page-title')?.textContent === 'More settings'");
    await key('#bots-id-host .bots-panel', 'Escape');
    await waitFor(`!!document.querySelector('${card('soul')}')`);
    assert.equal(await js('window.__closed'), 0, 'Escape pops a page before it would close the panel');
    // The hero editor opens in place and Escape closes only it.
    await click('#bots-id-host .bots-panel-bar .bots-icon-btn[aria-label=Settings]');
    await click('#bots-id-host .bots-hero-edit');
    await waitFor("!!document.querySelector('#bots-id-host .bots-popover .bots-avatar-editor')");
    await key('#bots-id-host .bots-popover', 'Escape');
    await waitFor("!document.querySelector('#bots-id-host .bots-popover')");

    // ================= The settings queue says whether it saved ================================================================
    const verdict = await js(`(async () => {
      const P = await import('/static/js/botsPanel.js');
      window.__panel.openSection('identity');
      return { ok: (await P.flushBotEdits(${q(botId)})).ok };
    })()`);
    assert.equal(verdict.ok, true, 'flushBotEdits reports success');
    // ================= Phone: the panel is a sheet and keeps focus inside ======================================================
    phone = true;
    win.setContentSize(390, 800); await delay(500);
    await mountPanel(botId, 'simple');
    await waitFor("!!document.querySelector('#bots-id-host .bots-hero-name')");
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll at phone width');
    assert.ok(await js("[...document.querySelectorAll('#bots-id-host .bots-tab')].every(n => n.getBoundingClientRect().height >= 32)"), 'tabs are easy to hit');
    await capture('phone-bots-identity-simple');
    win.setContentSize(1440, 900); await delay(400); phone = false;

    assert.deepEqual((await errorToasts()).filter(t => !expected.includes(t)), [], 'no unexpected error toast');
    assert.deepEqual(await js('window.__errs'), [], 'no script errors in the page');
  } finally {
    try {
      await closeDialogs();
      await js("window.__panel?.destroy(); document.getElementById('bots-id-host')?.remove(); document.documentElement.dataset.appMode = window.__prior || ''; true");
      if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
      await js(`localStorage.setItem('kairos:bots-interface', ${q(savedInterface)}); if (!${q(savedInterface)}) localStorage.removeItem('kairos:bots-interface'); true`);
      if (phone) win.setContentSize(1440, 900);
    } finally {
      delete demoState.botsIdentity; delete demoState.botsSectionModules;
      await restore();
    }
  }
};
