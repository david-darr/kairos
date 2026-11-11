// Durable approval and question cards and applied-change cards, in the renderer (Agents 3.0 Phase 3, unit U5).
// Run: node scripts/run-electron-test.cjs ui-smoke --bots-cards-only
// Mounts static/js/botsApprovalCards.js (composer and transcript slots) in scratch hosts under <html data-app-mode="bots">
// against scripts/fixtures/bots-cards-backend.cjs. Creates its own bot and thread, answers approval, question and typed
// cards, reloads and proves one settlement, applies a routine change, Pause, Edit, Undo, then a stale Undo that refuses.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base }) => {
  const q = JSON.stringify;
  const call = (path, method, body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const count = selector => js(`document.querySelectorAll(${q(selector)}).length`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)});
    n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const waitWrite = async (start, path, method, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      const hit = writes.slice(start).find(w => w.path === path && w.method === method && w.status);
      if (hit) return hit;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${method} ${path}`);
  };
  const body = write => JSON.parse(write.body || '{}');

  const restore = await isolateBotsCheck({ js, demoState });
  let phone = false, botId = null;
  try {
    demoState.botsLive = true;
    demoState.botsCards = undefined;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__cardsPriorMode = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots';
      window.__cardsErrs = []; window.addEventListener('error', e => window.__cardsErrs.push(String(e.message)));
      window.addEventListener('unhandledrejection', e => window.__cardsErrs.push('rejection: ' + String(e.reason && e.reason.stack || e.reason)));
      window.__navs = []; window.__settled = []; document.addEventListener('kairos:bots-card-settled', e => window.__settled.push(e.detail.card.id));
      return true; })()`);
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");   // seeds the in-memory backend

    // Its own bot and thread, never a demo bot.
    const stamp = Date.now().toString(36);
    const made = await call('/api/agents/configured', 'POST', { profile: { name: `Cards ${stamp}`, role: 'Tests cards' }, approval_mode: 'full', origin: { kind: 'blank' } });
    assert.equal(made.status, 200);
    botId = made.body.agent.id;
    const thread = await call(`/api/agents/${botId}/threads`, 'POST', { title: `Cards thread ${stamp}` });
    assert.equal(thread.status, 200);
    const threadId = thread.body.id;
    // Automation changes apply at every level. Ask is only available where the approval levels are enforced.
    const ask = await call(`/api/agents/${botId}/threads/${threadId}`, 'PATCH', { approval_mode: 'ask' });
    assert.ok([200, 409].includes(ask.status), 'a thread may be set to Ask where that level exists');

    const open = (extra) => call('/api/bot-cards/__fixture/open', 'POST', { thread_id: threadId, bot_id: botId, ...extra }).then(r => { assert.equal(r.status, 200); return r.body; });
    const rows = () => js("[...document.querySelectorAll('#cards-transcript .bots-card-row')].map(n => ({ id: n.dataset.cardId, status: n.dataset.status, text: n.querySelector('.bots-card-row-text').textContent }))");
    // The transcript slot learns of a settlement through its own refresh (a fetch after the event), so it can trail the composer
    // slot, which already shows the next card. Wait for the row to say it before asserting (found in the full run, 2026-11-10).
    const rowSays = (id, expected) => waitFor(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(id)}] .bots-card-row-text')?.textContent === ${q(expected)}`);
    const rowText = id => js(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(id)}] .bots-card-row-text')?.textContent || ''`);
    const mount = (slot, id, side) => js(`(async () => {
      const M = await import('/static/js/botsApprovalCards.js');
      window.__mounts ||= {};
      window.__mounts[${q(id)}]?.dispose(); document.getElementById(${q(id)})?.remove();
      const host = document.createElement('div'); host.id = ${q(id)};
      host.style.cssText = 'position:fixed;top:0;bottom:0;width:min(440px,100vw);overflow:auto;z-index:30;background:var(--bots-panel);padding:12px;box-sizing:border-box;${side}:0';
      document.body.append(host);
      window.__mounts[${q(id)}] = await M.mount(host, { agentId: ${q(botId)}, threadId: ${q(threadId)}, slot: ${q(slot)}, refresh: () => {},
        navigate: (...args) => { window.__navs.push(args); } });
      return true;
    })()`);
    const refresh = () => js("Promise.all(Object.values(window.__mounts).map(m => m.refresh())).then(() => true)");
    const mountBoth = async () => { await mount('transcript', 'cards-transcript', 'left'); await mount('composer', 'cards-composer', 'right'); };

    // ======================= Approval: allow once, reload, one settlement ============================================
    const approval = await open({ kind: 'approval', title: 'Run a command', details: { summary: 'Check the repo.', target: 'git status', tool: 'Bash',
      lines: [{ label: 'command', value: 'git status' }] } });
    const connector = await open({ kind: 'connector', title: 'Connect Gmail', details: { summary: 'Open Settings to connect it.', lines: [] } });
    const items = [1, 2, 3, 4, 5, 6].map(i => ({ question: `Question ${i}?`, header: `Q${i}`, multi_select: i === 2,
      options: [{ label: `A${i}`, description: i === 1 ? 'The first one' : '' }, { label: `B${i}`, description: '' }, { label: `C${i}`, description: '' }] }));
    const questions = await open({ kind: 'question', title: 'A few questions', questions: items });
    assert.equal(questions.questions.length, 6);

    await mountBoth();
    await waitFor("!!document.querySelector('#cards-composer .bots-cards-panel.approval')");
    assert.equal(await text('#cards-composer .bots-cards-title'), 'Run a command');
    assert.deepEqual(await js("[...document.querySelectorAll('#cards-composer .bots-cards-actions button')].map(b => b.textContent)"),
      ['Deny', 'Allow once', 'Always allow git status']);
    assert.equal(await text('#cards-composer .bots-cards-target code'), 'git status');
    assert.equal(await text('#cards-composer .bots-card-details dd'), 'git status');
    assert.deepEqual((await rows()).map(r => r.text), ['Waiting for you', 'Waiting for you', 'Waiting for you'], 'every card is a compact row in the transcript');
    assert.equal(await js("getComputedStyle(document.querySelector('#cards-composer .bots-cards-panel')).borderTopLeftRadius"), '14px', 'the Bots card corner');
    assert.equal(await js("document.querySelector('#cards-composer [role=group]').getAttribute('aria-labelledby') === document.querySelector('#cards-composer .bots-cards-title').id"), true);
    await capture('bots-cards-approval');

    let start = writes.length;
    await click('#cards-composer [data-action="allow-once"]');
    const first = await waitWrite(start, `/api/bot-cards/${approval.id}/respond`, 'POST');
    assert.deepEqual(body(first), { action: 'allow', remember: 'once', reviewed_revision: 1 });
    await waitFor("!!document.querySelector('#cards-composer .bots-cards-panel.connector, #cards-composer .bots-cards-panel.question')");
    await rowSays(approval.id, 'Allowed once');
    assert.equal(await rowText(approval.id), 'Allowed once');
    assert.equal(demoState.botsCards.settled[approval.id], 1, 'one settlement');
    assert.deepEqual(await js('window.__settled'), [approval.id], 'the page is told once');
    // Reload: a fresh mount shows the same settled row, and a second answer is refused.
    await mountBoth();
    await waitFor(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(approval.id)}]')?.dataset.status === 'allowed'`);
    assert.equal(await rowText(approval.id), 'Allowed once');
    const again = await call(`/api/bot-cards/${approval.id}/respond`, 'POST', { action: 'allow', remember: 'once' });
    assert.equal(again.status, 409);
    assert.equal(again.body.card.status, 'allowed');
    assert.equal(demoState.botsCards.settled[approval.id], 1, 'still one settlement');

    // ======================= Connector card: a typed card finishes through its resume route ===========================
    await waitFor("!!document.querySelector('#cards-composer .bots-cards-panel.connector')");
    assert.deepEqual(await js("[...document.querySelectorAll('#cards-composer .bots-cards-actions button')].map(b => b.textContent)"), ['Not now', 'Done']);
    start = writes.length;
    await click('#cards-composer [data-action="done"]');
    assert.deepEqual(body(await waitWrite(start, `/api/bot-cards/${connector.id}/resume`, 'POST')), { outcome: 'done' });
    await waitFor("!!document.querySelector('#cards-composer .bots-cards-panel.question')");
    await rowSays(connector.id, 'Answered');
    assert.equal(await rowText(connector.id), 'Answered');

    // ======================= Six questions =========================================================================
    assert.equal(await count('#cards-composer .bots-cards-tab'), 6);
    assert.equal(await js("document.querySelector('#cards-composer .bots-cards-tab[aria-selected=true]').textContent"), 'Q1');
    assert.equal(await text('#cards-composer .bots-cards-prompt'), 'Question 1?');
    assert.equal(await text('#cards-composer .bots-cards-option-hint'), 'The first one');
    // Keyboard: arrow keys move between tabs, then back.
    await js(`(() => { const t = document.querySelector('#cards-composer .bots-cards-tab[aria-selected=true]'); t.focus();
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); return true; })()`);
    assert.equal(await text('#cards-composer .bots-cards-prompt'), 'Question 2?');
    assert.equal(await js("document.activeElement.getAttribute('role')"), 'tab', 'focus stays on the tab row');
    await js(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); return true; })()`);
    assert.equal(await text('#cards-composer .bots-cards-prompt'), 'Question 1?');
    const pick = label => js(`(() => { const i = [...document.querySelectorAll('#cards-composer .bots-cards-option input')].find(n => n.value === ${q(label)});
      if (!i) throw new Error('no option ' + ${q(label)}); i.focus(); i.click(); return true; })()`);
    await pick('B1');
    assert.equal(await js("document.querySelector('#cards-composer .bots-cards-tab[aria-selected=true]').dataset.answered"), 'true');
    assert.equal(await js("document.activeElement.value"), 'B1', 'focus stays on the option after the panel redraws');
    await click('#cards-composer [data-action="next"]');
    assert.equal(await text('#cards-composer .bots-cards-prompt'), 'Question 2?');
    assert.match(await text('#cards-composer .bots-cards-hint'), /Pick all that apply/);
    assert.equal(await js("document.querySelector('#cards-composer .bots-cards-option input').type"), 'checkbox');
    await pick('A2'); await pick('C2');
    // Typed text is cut at 2,000 characters and counted.
    await fill('#cards-composer .bots-cards-custom', 'z'.repeat(2500));
    assert.equal(await js("document.querySelector('#cards-composer .bots-cards-custom').value.length"), 2000);
    assert.match(await text('#cards-composer .bots-cards-count'), /2000 of 2000/);
    await fill('#cards-composer .bots-cards-custom', 'my own');
    assert.equal(await js("document.activeElement.className"), 'bots-cards-custom', 'typing keeps focus');
    // The 3-second poll leaves an unchanged card alone: the same box keeps its text and the focus (found live 2026-11-02).
    await js("document.querySelector('#cards-composer .bots-cards-custom').__kept = true");
    await new Promise(r => setTimeout(r, 3800));
    assert.deepEqual(await js("[document.activeElement.__kept === true, document.activeElement.value]"), [true, 'my own'], 'a poll never rebuilds the card under the person');
    for (let i = 3; i <= 5; i++) {
      await click('#cards-composer [data-action="next"]');
      assert.equal(await text('#cards-composer .bots-cards-prompt'), `Question ${i}?`);
      await pick(`A${i}`);
    }
    await click('#cards-composer [data-action="next"]');
    assert.equal(await text('#cards-composer .bots-cards-prompt'), 'Question 6?');
    assert.equal(await exists('#cards-composer [data-action="next"]'), false, 'the last question offers Submit');
    start = writes.length;
    await click('#cards-composer [data-action="submit"]');
    await waitFor("document.querySelector('#cards-composer .bots-cards-error')?.textContent === 'Answer every question first.'");
    assert.equal(writes.slice(start).filter(w => w.path.endsWith('/respond')).length, 0, 'an unfinished card sends nothing');
    await pick('C6');
    await click('#cards-composer [data-action="submit"]');
    const sent = body(await waitWrite(start, `/api/bot-cards/${questions.id}/respond`, 'POST'));
    assert.equal(sent.action, 'answer');
    assert.deepEqual(Object.keys(sent.answers), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'], 'answers go by stable question id');
    assert.deepEqual([sent.answers.q1, sent.answers.q2, sent.answers.q6], ['B1', ['A2', 'C2', 'my own'], 'C6']);
    await waitFor(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(questions.id)}]')?.dataset.status === 'answered'`);
    assert.equal(await rowText(questions.id), 'Answered');
    assert.equal(await js(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(questions.id)}] .bots-card-row-answers summary').textContent`), '6 answers');
    assert.equal(await exists('#cards-composer .bots-cards-panel'), false, 'nothing is waiting, so the composer slot is empty');

    // ======================= Deny, Always allow, and a request that is no longer there ==============================
    const second = await open({ kind: 'approval', title: 'Delete a file', details: { target: 'notes', lines: [] } });
    await refresh();
    await waitFor("!!document.querySelector('#cards-composer .bots-cards-panel.approval')");
    start = writes.length;
    await click('#cards-composer [data-action="deny"]');
    assert.deepEqual(body(await waitWrite(start, `/api/bot-cards/${second.id}/respond`, 'POST')), { action: 'deny', reviewed_revision: 1 });
    await waitFor(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(second.id)}]')?.dataset.status === 'denied'`);
    assert.match(await rowText(second.id), /did not run/);
    const third = await open({ kind: 'approval', title: 'Run tests', details: { target: 'npm test', lines: [] } });
    await refresh();
    await waitFor("!!document.querySelector('#cards-composer [data-action=\"remember-always\"]')");
    start = writes.length;
    await click('#cards-composer [data-action="remember-always"]');
    assert.equal(body(await waitWrite(start, `/api/bot-cards/${third.id}/respond`, 'POST')).remember, 'always');
    await waitFor(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(third.id)}]')?.dataset.status === 'allowed'`);
    assert.equal(await rowText(third.id), 'Always allowed: npm test');
    const stale = await open({ kind: 'approval', title: 'Send a message', details: { target: 'mail', lines: [] } });
    await refresh();
    await waitFor(`!!document.querySelector('#cards-composer .bots-cards-panel[data-card-id=${q(stale.id)}]')`);
    await call(`/api/bot-cards/__fixture/expire/${stale.id}`, 'POST', {});   // the provider went away under the open card
    await click('#cards-composer [data-action="allow-once"]');
    await waitFor(`document.querySelector('#cards-transcript .bots-card-row[data-card-id=${q(stale.id)}]')?.dataset.status === 'unavailable'`);
    assert.match(await rowText(stale.id), /did not run/);
    assert.equal(await exists('#cards-composer .bots-cards-panel'), false);

    // ======================= Applied change: Pause, Edit, Undo, and a stale Undo =====================================
    const applyChange = extra => call('/api/bot-automation-changes/__fixture/apply', 'POST', { bot_id: botId, thread_id: threadId, ...extra }).then(r => { assert.equal(r.status, 200); return r.body; });
    const stalePlan = await applyChange({ action: 'create', name: `Stale ${stamp}` });
    const plain = await applyChange({ action: 'create', name: `Brief ${stamp}`, run_time: '07:30' });
    await js("document.dispatchEvent(new CustomEvent('kairos:bot-automation-change')); true");
    await waitFor("document.querySelectorAll('#cards-transcript ~ .bots-cards-changes .bots-change-card, .bots-cards-changes .bots-change-card').length === 2", 8000);
    const card = id => `.bots-change-card[data-receipt-id=${q(id)}]`;
    assert.match(await text(`${card(plain.id)} .bots-change-line`), new RegExp(`^Added routine "Brief ${stamp}": every day at 07:30\\.`));
    assert.equal(await text(`${card(plain.id)} .bots-change-status`), 'Applied');
    assert.deepEqual(await js(`[...document.querySelectorAll(${q(card(plain.id) + ' .bots-cards-actions button')})].map(b => b.textContent)`), ['Pause', 'Edit', 'Undo']);
    await click(`${card(plain.id)} .bots-change-details summary`);
    assert.equal(await js(`document.querySelector(${q(card(plain.id) + ' .bots-change-details')}).open`), true);
    assert.deepEqual(await js(`[...document.querySelectorAll(${q(card(plain.id) + ' .bots-change-diff dt')})].map(n => n.textContent)`), ['name', 'run time']);
    await capture('bots-cards-change');

    // Pause the one we will make stale; the routine really changes.
    start = writes.length;
    await click(`${card(stalePlan.id)} [data-action="pause"]`);
    const paused = await waitWrite(start, `/api/bot-routines/${stalePlan.target_id}`, 'PATCH');
    assert.deepEqual(body(paused), { enabled: false });
    await waitFor(`document.querySelector(${q(card(stalePlan.id) + ' [data-action=pause]')}).textContent === 'Resume'`);
    assert.equal(demoState.botsCards.routines.find(r => r.id === stalePlan.target_id).enabled, false);

    // Edit opens the editor, or the Automations page when the editor is not built yet.
    await click(`${card(plain.id)} [data-action="edit"]`);
    await waitFor("window.__navs.some(a => a[0] === 'botsAutomations') || !!document.querySelector('.modal-backdrop, .bots-ed-dialog')", 6000);
    await js(`(() => { for (let i = 0; i < 4; i++) { const b = document.querySelector('.modal-backdrop .modal-close-btn'); if (!b) break; b.click(); }
      document.querySelectorAll('.modal-backdrop').forEach(n => n.remove());
      document.querySelectorAll('.bots-ed-dialog').forEach(n => { try { n.close(); } catch { /* not open */ } n.remove(); }); return true; })()`);

    // Undo works while nothing else changed it.
    start = writes.length;
    await click(`${card(plain.id)} [data-action="undo"]`);
    await waitWrite(start, `/api/bot-automation-changes/${plain.id}/undo`, 'POST');
    await waitFor(`document.querySelector(${q(card(plain.id) + ' .bots-change-status')})?.textContent === 'Undone'`);
    assert.equal(await exists(`${card(plain.id)} [data-action="undo"]`), false, 'an undone change offers no second Undo');
    assert.equal(demoState.botsCards.routines.some(r => r.id === plain.target_id), false, 'the routine is gone');
    const repeat = await call(`/api/bot-automation-changes/${plain.id}/undo`, 'POST');
    assert.deepEqual([repeat.status, repeat.body.already_undone], [200, true], 'a repeated Undo is a no-op');

    // A stale Undo refuses and leaves the routine as it is.
    start = writes.length;
    await click(`${card(stalePlan.id)} [data-action="undo"]`);
    const refused = await waitWrite(start, `/api/bot-automation-changes/${stalePlan.id}/undo`, 'POST');
    assert.equal(refused.status, 409);
    await waitFor(`!!document.querySelector(${q(card(stalePlan.id) + ' .bots-cards-error')})`);
    assert.match(await text(`${card(stalePlan.id)} .bots-cards-error`), /left it alone/);
    assert.equal(await text(`${card(stalePlan.id)} .bots-change-status`), 'Applied', 'the receipt stays for another try');
    const kept = demoState.botsCards.routines.find(r => r.id === stalePlan.target_id);
    assert.deepEqual([kept.enabled, kept.name], [false, `Stale ${stamp}`], 'the later edit was not lost');

    // ======================= A phone: no sideways scroll, 44px targets ==============================================
    phone = true;
    win.setContentSize(390, 844);
    await delay(250);
    await open({ kind: 'approval', title: 'Run a command', details: { target: 'git log', lines: [] } });
    await refresh();
    await waitFor("!!document.querySelector('#cards-composer .bots-cards-panel.approval')");
    const metrics = await js(`(() => { const host = document.getElementById('cards-composer');
      return { over: host.scrollWidth - host.clientWidth, min: Math.min(...[...host.querySelectorAll('.bots-cards-actions .bots-btn')].map(b => b.getBoundingClientRect().height)),
        wide: [...host.querySelectorAll('.bots-cards-actions .bots-btn')].every(b => b.getBoundingClientRect().width >= host.clientWidth - 80) }; })()`);
    assert.ok(metrics.over <= 2, `no sideways scroll on a phone: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.min >= 44, `44px targets: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.wide, true, 'the actions stack full width');
    const transcript = await js("(() => { const h = document.getElementById('cards-transcript'); return h.scrollWidth - h.clientWidth; })()");
    assert.ok(transcript <= 2, 'the transcript slot does not scroll sideways either');
    await capture('bots-cards-phone');
    win.setContentSize(1440, 900);
    phone = false;

    assert.deepEqual(await js('window.__cardsErrs'), [], 'no renderer errors or unhandled rejections');
    assert.deepEqual(await js("[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)"), [], 'no stray error toast');
  } catch (error) {
    const seen = await js('window.__cardsErrs || []').catch(() => []);
    if (seen.length) console.error(['Renderer errors seen during the check:', ...seen].join('\n'));
    throw error;
  } finally {
    if (phone) win.setContentSize(1440, 900);
    await js(`(() => {
      for (const m of Object.values(window.__mounts || {})) { try { m.dispose(); } catch (e) {} }
      document.getElementById('cards-transcript')?.remove(); document.getElementById('cards-composer')?.remove();
      document.querySelectorAll('.modal-backdrop').forEach(n => n.remove());
      const prior = window.__cardsPriorMode;
      if (prior) document.documentElement.dataset.appMode = prior; else delete document.documentElement.dataset.appMode;
      delete window.__mounts; delete window.__navs; delete window.__settled; delete window.__cardsPriorMode;
      return true;
    })()`).catch(() => {});
    if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
    demoState.botsCards = undefined;
    await restore();
  }
};
