// Bots redesign, Phase 5 units U2 and U3 (2026-10-29): the front desk's Tasks list and Up next, mounted in a scratch
// container. Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-fdwork-only
// The front-desk work lane (scripts/fixtures/bots-fdwork-backend.cjs) answers /api/front-desk/work, tasks, suggestions
// and the watch from demoState.botsFdWork. The day-checks card is stubbed so this check needs no watch routine.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, win, capture, demoState, base }) => {
  const now = Date.now() / 1000;
  const work = {
    tasks: [
      { id: 't-review', title: 'Draft the newsletter', state: 'ready_for_review', next_step: 'Ready to read.', turn_count: 2, updated_at: now - 60 },
      { id: 't-input', title: 'Book the venue', state: 'needs_input', next_step: 'Which date works?', turn_count: 1, updated_at: now - 120 },
      { id: 't-failed', title: 'Sort the receipts', state: 'failed', next_step: 'The model stopped.', turn_count: 1, updated_at: now - 30 },
      { id: 't-working', title: 'Plan the trip', state: 'working', next_step: 'Comparing trains.', turn_count: 0, updated_at: now - 10 },
    ],
    up_next: [{ id: 's-1', title: 'Reply to Sam about Friday', detail: 'Sam asked twice.', origin: 'noticed', source: { app: 'mail', ref: 'm1' }, created_at: now - 50 }],
    watch: { state: 'idle', last_check_at: now - 3600, last_result: 'ok' }, runNowFinds: null, log: [],
  };
  const restore = await isolateBotsCheck({ js, demoState }, { botsFdWork: work });
  const body = () => js("document.getElementById('fdwork-host').textContent");
  const clickText = (selector, text) => js(`[...document.querySelectorAll(${JSON.stringify('#fdwork-host ' + selector)})].find(n => n.textContent.trim() === ${JSON.stringify(text)}).click()`);
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { try { localStorage.removeItem('kairos:bots-tasks-view'); } catch {}
      const box = document.createElement('div'); box.id = 'fdwork-host'; box.dataset.appMode = 'bots';
      box.style.cssText = 'position:fixed;inset:0 auto auto 0;width:360px;height:100vh;overflow:auto;z-index:9999;background:var(--bots-app, #fff)';
      document.body.append(box); })()`);
    await js(`import('/static/js/botsSectionWork.js').then(m => { window.__fdwork = m.mount(document.getElementById('fdwork-host'), {
      agent: { id: 'kip', name: 'Kip' }, agentId: 'kip', navigate: (...args) => { window.__fdworkNav = args; },
      loadWatch: async () => ({ mount: host => { host.textContent = 'Day checks stub'; return { dispose() {} }; } }) }); })`);

    // Active: one group per state, newest first, the resolved group folded away.
    await waitFor("document.getElementById('fdwork-host').textContent.includes('Plan the trip')");
    assert.deepEqual(await js("[...document.querySelectorAll('#fdwork-host .bots-work-group')].map(g => g.dataset.group)"),
      ['ready_for_review', 'needs_input', 'failed', 'working'], 'groups in the design order');
    assert.match(await body(), /Needs input 1/);
    assert.match(await body(), /Needs input · Which date works\?/, 'a row says its state and next step');
    assert.match(await body(), /Updated just now/);
    await capture?.('phone-bots-fdwork-active');

    // Done: the checkbox resolves the task; it moves under Resolved, which opens on request.
    await js("document.querySelector('#fdwork-host [data-task-id=\"t-working\"] .bots-work-checkbox').click()");
    await waitFor("!document.querySelector('#fdwork-host [data-task-id=\"t-working\"]')");
    assert.deepEqual(work.log.at(-1), { kind: 'tasks', id: 't-working', action: 'resolve', body: {} });
    await clickText('.bots-work-fold', 'Resolved');
    await waitFor("!!document.querySelector('#fdwork-host [data-task-id=\"t-working\"] .bots-work-checkbox[aria-checked=\"true\"]')");

    // A failed task offers Try again, sent with the turn it saw.
    await js("document.querySelector('#fdwork-host [data-task-id=\"t-failed\"] .bots-btn.primary').click()");
    await waitFor("!document.querySelector('#fdwork-host [data-group=\"failed\"]')");
    assert.deepEqual(work.log.at(-1), { kind: 'tasks', id: 't-failed', action: 'again', body: { turn_count: 1 } });

    // Search narrows by title.
    await js("[...document.querySelectorAll('#fdwork-host .bots-work-toolbar button')].find(b => b.textContent === 'Search').click()");
    await js("(() => { const s = document.querySelector('#fdwork-host input[type=search]'); s.value = 'venue'; s.dispatchEvent(new Event('input')); })()");
    assert.deepEqual(await js("[...document.querySelectorAll('#fdwork-host .bots-work-row')].map(r => r.dataset.taskId)"), ['t-input']);
    await js("(() => { const s = document.querySelector('#fdwork-host input[type=search]'); s.value = ''; s.dispatchEvent(new Event('input')); })()");

    // Up next: the noticed suggestion with its source; Start makes a task, and the day-checks card loads.
    await clickText('[role=tab]', 'Up next');
    await waitFor("!!document.querySelector('#fdwork-host [data-suggestion-id=\"s-1\"]')");
    assert.match(await body(), /Noticed · From Mail/);
    await waitFor("document.getElementById('fdwork-host').textContent.includes('Day checks stub')");
    await clickText('[data-suggestion-id="s-1"] button', 'Start');
    await waitFor("!document.querySelector('#fdwork-host [data-suggestion-id=\"s-1\"]')");
    assert.deepEqual(work.log.at(-1), { kind: 'suggestions', id: 's-1', action: 'start', body: {} });
    assert.ok(work.tasks.some(t => t.id === 'task-s-1'), 'starting a suggestion makes a task');

    // Empty Up next: Show me runs the check now and reports what it found.
    work.runNowFinds = null;
    await waitFor("!!document.querySelector('#fdwork-host .bots-work-show-me')");
    await js("document.querySelector('#fdwork-host .bots-work-show-me').click()");
    await waitFor("document.getElementById('fdwork-host').textContent.includes('Nothing new right now. I will keep checking.')", 8000);
    assert.ok(work.log.some(entry => entry.action === 'run-now'));

    // Phone width: no sideways overflow, 44 px targets.
    assert.deepEqual(await js("[...document.querySelectorAll('#fdwork-host *')].filter(n => n.getBoundingClientRect().right > 361).map(n => n.tagName + '.' + n.className)"), [], 'no sideways overflow');
    assert.deepEqual(await js("[...document.querySelectorAll('#fdwork-host button')].filter(n => n.getClientRects().length && n.getBoundingClientRect().height < 43.5).map(n => (n.getAttribute('aria-label') || n.textContent).slice(0, 30))"), [], '44 px targets');
    await capture?.('phone-bots-fdwork-next');
  } finally {
    try { await js("(() => { window.__fdwork?.dispose(); delete window.__fdwork; delete window.__fdworkNav; document.getElementById('fdwork-host')?.remove(); try { localStorage.removeItem('kairos:bots-tasks-view'); } catch {} })()"); }
    finally { await restore(); }
  }
};
