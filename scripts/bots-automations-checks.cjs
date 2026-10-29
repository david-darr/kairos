// Bots Automations page, editors, calendar and the routines section, in the renderer (Agents 3.0 Phase 3, unit U3).
// Run by ui-smoke behind --bots-automations-only (the generic Bots loader):
//   node scripts/run-electron-test.cjs ui-smoke --bots-automations-only
//
// The fixture backend scripts/fixtures/bots-automations-backend.cjs answers the Phase 3 routes while
// demoState.botsAutomations is set; the Bots core backend answers /api/agents. This check makes its own two bots, reads
// their ids back and seeds the Automations fixture with them, so it never assumes which other bots exist.
//
// The page is mounted straight into the view container: registering it in the Bots nav is Phase 1 unit U4's hook, and
// until that lands app.js would treat an unknown tab as Kairos mode. Navigation requests (open a run, reconnect, Logs) are
// caught on window in the capture phase, so the check reads where the app WOULD go without leaving the page.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base, overflow }) => {
  const q = selector => JSON.stringify(selector);
  const has = selector => js(`!!document.querySelector(${q(selector)})`);
  const count = selector => js(`document.querySelectorAll(${q(selector)}).length`);
  const textOf = selector => js(`document.querySelector(${q(selector)})?.textContent?.trim() ?? null`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.focus(); n.click(); return true; })()`);   // a real click focuses a button first
  const waitSel = (selector, extra = '') => waitFor(`!!document.querySelector(${q(selector)})${extra}`);
  const gone = selector => waitFor(`!document.querySelector(${q(selector)})`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";
  const navs = () => js('window.__autoNavs.splice(0)');
  const lastWrite = (since, method, path) => [...writes.slice(since)].reverse().find(w => w.method === method && (typeof path === 'string' ? w.path === path : path.test(w.path)));
  const bodyOf = write => JSON.parse(write.body || '{}');
  const waitWrite = async (since, method, path) => {
    for (let i = 0; i < 80 && !lastWrite(since, method, path)?.status; i++) await delay(50);
    const write = lastWrite(since, method, path);
    assert.ok(write, `${method} ${path} was sent`);
    return write;
  };
  const resize = size => { win.setContentSize(size[0], size[1]); return delay(500); };
  const rows = "[...document.querySelectorAll('.bots-auto-row')].map(n => ({ key: n.dataset.key, status: n.dataset.status, sentence: n.querySelector('.bots-auto-row-sentence').textContent, timing: n.querySelector('.bots-auto-row-timing').textContent }))";

  const restore = await isolateBotsCheck({ js, demoState }, { botsAutomations: undefined });
  const made = [];
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const stamp = Date.now() % 100000;
    for (const name of [`Auto Alpha ${stamp}`, `Auto Beta ${stamp}`]) {
      const result = await call('/api/agents', 'POST', { name });
      assert.equal(result.status, 200, 'the check makes its own bot');
      made.push(result.body);
    }
    const [alpha, beta] = made;
    demoState.botsAutomations = { owning: true, seed: { a: alpha.id, b: beta.id } };
    await js("localStorage.removeItem('kairos:bots-automations-view'); true");

    // Bots mode, then the page mounted into the view.
    await js("document.querySelector('#forge-mode-switch [data-mode=bots]').click()");
    await waitFor("document.documentElement.dataset.appMode === 'bots' && !!document.querySelector('.bots-home')");
    await js(`(() => {
      window.__autoNavs = [];
      window.__autoNavHandler = event => { window.__autoNavs.push(event.detail); event.stopImmediatePropagation(); };
      window.addEventListener('jarvis:navigate', window.__autoNavHandler, true);
      return true;
    })()`);
    const openPage = (options = {}) => js(`(async () => {
      window.__autoDispose?.();
      const host = document.getElementById('view-content');
      host.replaceChildren();
      const mod = await import('/static/js/views/botsAutomations.js');
      window.__autoDispose = await mod.render(host, 'botsAutomations', ${JSON.stringify(options)});
      return true;
    })()`);
    await openPage();
    await waitSel('.bots-auto-list .bots-auto-row');

    // -- The list: nine automations from three sources, needs-you first --------------------------
    const list = await js(rows);
    assert.equal(list.length, 9, 'seven routines, a webhook and an app automation');
    const order = ['needs_you', 'working', 'paused', 'done'];
    assert.deepEqual(list.map(r => order.indexOf(r.status)), [...list.map(r => order.indexOf(r.status))].sort((a, b) => a - b), 'sorted needs-you, working, paused, done');
    assert.deepEqual(list.filter(r => r.status === 'needs_you').map(r => r.key).sort(), ['app:p1', 'routine:r2', 'routine:r7'], 'waiting, failing and the app that needs reconnecting');
    assert.equal(list.at(-1).key, 'routine:r4', 'the finished one-time routine is last, as Done');
    assert.equal(list.find(r => r.key === 'routine:r5').status, 'paused');
    assert.match(list.find(r => r.key === 'routine:r1').sentence, /^Every day at 9:00 AM, .+ follows: Summarize my inbox/, 'one plain sentence');
    assert.match(list.find(r => r.key === 'routine:r1').timing, /^Next .+ · Last ran 3 h ago$/);
    assert.match(list.find(r => r.key === 'routine:r2').timing, /^Waiting for your answer/, 'a needs-you row says why');
    assert.match(await textOf('.bots-auto-count'), /^9 automations, 3 need you$/);
    assert.equal(await js("[...document.querySelectorAll('.bots-auto-row-main')].every(n => n.tagName === 'BUTTON')"), true, 'rows are real buttons');
    assert.equal(await js("[...document.querySelectorAll('.bots-auto-row .bots-switch')].every(n => n.getAttribute('role') === 'switch' && /on$/.test(n.getAttribute('aria-label')))"), true, 'every switch has a name');
    assert.equal(await js("[...document.querySelectorAll('.bots-auto-row')].filter(n => n.querySelector('.bots-auto-fix')).map(n => n.dataset.key).sort().join()"), 'app:p1,routine:r2,routine:r7', 'a fix button only on needs-you rows');
    assert.equal(await js("document.querySelector('.bots-auto-row[data-key=\"routine:r2\"] .bots-auto-fix').textContent"), 'Answer', 'the one relevant fix');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-auto-row-sentence')).fontFamily.includes('Geist')"), true, 'the page uses the Bots type');
    await capture?.('desktop-bots-automations-list');

    // -- The bot filter appears from nine automations -------------------------------------------
    assert.equal(await js("!document.querySelector('.bots-auto-filter').hidden"), true, 'the bot filter shows with nine automations and several bots');
    await fill('.bots-auto-filter', beta.id);
    await waitFor("document.querySelectorAll('.bots-auto-row').length === 2");
    assert.deepEqual((await js(rows)).map(r => r.key).sort(), ['app:p1', 'routine:r7'], 'only the other bot\'s automations');
    await fill('.bots-auto-filter', '');
    await waitFor("document.querySelectorAll('.bots-auto-row').length === 9");

    // -- Fix buttons ---------------------------------------------------------------------------
    await navs();
    await click('.bots-auto-row[data-key="routine:r2"] .bots-auto-fix');
    const opened = (await navs())[0];
    assert.deepEqual([opened.tab, opened.agentId, opened.sessionId], ['botsShell', alpha.id, 'auto-t-run2'], 'Answer opens the waiting run\'s conversation');
    await click('.bots-auto-row[data-key="app:p1"] .bots-auto-fix');
    assert.equal((await navs())[0].tab, 'tool-store', 'Reconnect goes to the apps');
    let mark = writes.length;
    await click('.bots-auto-row[data-key="routine:r7"] .bots-auto-fix');
    const started = bodyOf(await waitWrite(mark, 'POST', '/api/bot-routines/r7/run'));
    assert.ok(started.request_id, 'Run now carries a request id so a retry is not a second run');

    // -- Switch and details ---------------------------------------------------------------------
    mark = writes.length;
    await click('.bots-auto-row[data-key="routine:r5"] .bots-switch');
    const enabled = bodyOf(await waitWrite(mark, 'PATCH', '/api/bot-routines/r5'));
    assert.deepEqual([enabled.enabled, enabled.expected_revision], [true, 1], 'the switch writes with the revision it saw');
    await waitFor("document.querySelector('.bots-auto-row[data-key=\"routine:r5\"]').dataset.status === 'working'");
    await click('.bots-auto-row[data-key="routine:r1"] .bots-auto-row-main');
    await waitSel('.bots-auto-details:not([hidden]) .bots-auto-next li');
    assert.equal(await textOf('.bots-auto-details-title h2'), 'Morning summary');
    assert.equal(await js("document.querySelector('.bots-auto-instructions').textContent"), 'Summarize my inbox and calendar for the day.');
    assert.equal(await count('.bots-auto-next li'), 3, 'the next three times come from the engine\'s preview');
    assert.equal(await count('.bots-auto-run'), 1, 'recent runs');
    assert.equal(await js("document.querySelector('.bots-auto-details-live').getAttribute('aria-live')"), 'polite');
    assert.equal(await js("document.querySelector('.bots-auto-row[data-key=\"routine:r1\"]').getAttribute('aria-current')"), 'true');
    mark = writes.length;
    await click('.bots-auto-details [data-action="run"]');
    assert.ok(bodyOf(await waitWrite(mark, 'POST', '/api/bot-routines/r1/run')).request_id, 'Run now from the panel');
    await waitFor("document.querySelectorAll('.bots-auto-run').length === 2");
    assert.equal(await js("document.querySelector('.bots-auto-run-open').dataset.status"), 'running');
    // Cancel the run the check just started.
    mark = writes.length;
    await click('.bots-auto-details [data-action^="run-"]');
    await waitWrite(mark, 'POST', /^\/api\/bot-routine-runs\/run\d+\/cancel$/);
    await waitFor("document.querySelector('.bots-auto-run-open').dataset.status === 'cancelled'");
    await navs();
    await click('.bots-auto-run-open:not([disabled])');
    assert.equal((await navs())[0].tab, 'botsShell', 'a run opens its conversation');
    await capture?.('desktop-bots-automations-details');

    // Webhook details: the address is never drawn; recent calls deduplicate; payloads expand.
    await click('.bots-auto-row[data-key="webhook:w1"] .bots-auto-row-main');
    await waitSel('.bots-ev-webhook .bots-ev-attempt');
    assert.equal(await count('.bots-ev-attempt'), 2, 'one call per delivery id, newest first');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-ev-attempt-text > span:first-child')].map(n => n.textContent)"), ['Already received', 'Turned away']);
    assert.match(await textOf('.bots-ev-attempt[data-outcome="rejected"] .bots-ev-reason'), /secret did not match/);
    await click('.bots-ev-attempt[data-outcome="duplicate"] .bots-ev-attempt-head');
    assert.equal(await js("!document.querySelector('.bots-ev-attempt[data-outcome=\"duplicate\"] .bots-ev-payload').hidden"), true, 'the payload preview opens');
    assert.match(await js("document.querySelector('.bots-ev-attempt[data-outcome=\"duplicate\"] .bots-ev-payload').textContent"), /order\.created/);
    mark = writes.length;
    await js("[...document.querySelectorAll('.bots-ev-actions .bots-btn')].find(n => n.textContent.includes('Send a test')).click()");
    await waitWrite(mark, 'POST', '/api/bot-webhooks/w1/test');
    await js("[...document.querySelectorAll('.bots-ev-actions .bots-btn')].find(n => n.textContent.includes('Capture')).click()");
    await waitWrite(mark, 'POST', '/api/bot-webhooks/w1/capture');
    await js("[...document.querySelectorAll('.bots-ev-actions .bots-btn')].find(n => n.textContent.includes('Copy address')).click()");
    await delay(300);
    assert.equal(await js("document.body.textContent.includes('SECRET-ADDRESS-KEY')"), false, 'the webhook address is copied, never drawn');
    // An app automation: problem line, recent arrivals, Check now.
    await click('.bots-auto-row[data-key="app:p1"] .bots-auto-row-main');
    await waitSel('.bots-ev-app .bots-ev-attempt');
    assert.match(await textOf('.bots-ev-app .bots-ev-bad'), /connected again/);
    assert.equal(await count('.bots-ev-app .bots-ev-attempt'), 2);
    assert.match(await textOf('.bots-ev-app .bots-ev-note'), /Gmail \(work@example\.com\) · Checks every 15 minutes/, 'honest about polling');
    mark = writes.length;
    await js("[...document.querySelectorAll('.bots-ev-app .bots-btn')].find(n => n.textContent.includes('Check now')).click()");
    await waitWrite(mark, 'POST', '/api/bot-app-triggers/p1/sync');

    // -- Delete and bring it back ---------------------------------------------------------------
    await click('.bots-auto-row[data-key="routine:r5"] .bots-auto-row-main');
    await waitSel('.bots-auto-details [data-action="delete"]');
    await click('.bots-auto-details [data-action="delete"]');
    await waitSel('.confirm-panel');
    assert.equal(await js("document.activeElement.className.includes('danger')"), true, 'the confirm focuses its action');
    mark = writes.length;
    await js("document.querySelector('.confirm-panel .btn.danger').click()");
    const removed = await waitWrite(mark, 'DELETE', '/api/bot-routines/r5');
    assert.equal(removed.status, 200);
    assert.ok(Number.isInteger(Number(removed.query.expected_revision)), 'a delete names the revision it saw');
    await waitFor("!document.querySelector('.bots-auto-row[data-key=\"routine:r5\"]')");
    await waitSel('.bots-auto-banner:not([hidden]) [data-action="restore"]');
    assert.match(await textOf('.bots-auto-banner span'), /Deleted "Paused digest"/);
    mark = writes.length;
    await click('.bots-auto-banner [data-action="restore"]');
    await waitWrite(mark, 'POST', /^\/api\/bot-automation-changes\/rc\d+\/undo$/);
    await waitSel('.bots-auto-row[data-key="routine:r5"]');
    assert.equal(await has('.bots-auto-banner:not([hidden])'), false, 'the banner goes once it is undone');

    // -- A stale save is refused, never merged -------------------------------------------------
    await js("document.querySelector('.bots-auto-row[data-key=\"routine:r5\"] .bots-auto-row-main').click()");
    await waitSel('.bots-auto-details [data-action="edit"]');
    await click('.bots-auto-details [data-action="edit"]');
    await waitSel('.bots-ed-dialog input[name="name"]');
    assert.equal(await js("document.activeElement.name"), 'name', 'focus goes into the editor');
    assert.equal(await js("document.querySelector('.bots-ed-dialog').getAttribute('aria-modal')"), 'true');
    assert.equal((await call('/api/bot-routines/r5', 'PATCH', { name: 'Changed elsewhere', expected_revision: 2 })).status, 200, 'someone else saves first');
    await fill('.bots-ed-dialog input[name="name"]', 'My edit');
    mark = writes.length;
    await click('.bots-ed-dialog .bots-btn.primary');
    await waitFor("!!document.querySelector('.bots-ed-dialog .bots-ed-error:not([hidden])') && document.querySelector('.bots-ed-dialog .bots-ed-form > .bots-ed-error:not([hidden])')?.textContent.includes('changed since you opened it')");
    assert.equal((await waitWrite(mark, 'PATCH', '/api/bot-routines/r5')).status, 409, 'the server refused the stale revision');
    await js("document.querySelector('.bots-ed-dialog .modal-close-btn').click()");
    await gone('.bots-ed-dialog');
    assert.equal(await js("document.activeElement?.dataset?.action"), 'edit', 'focus returns to the button that opened the editor');

    // -- The routine editor: validation, chips, preview, cron, saving --------------------------
    await js("document.querySelector('.bots-auto-row[data-key=\"routine:r3\"] .bots-auto-row-main').click()");
    await waitFor("document.querySelector('.bots-auto-details-title h2')?.textContent === 'Weekly report'");
    await click('.bots-auto-details [data-action="edit"]');
    await waitSel('.bots-ed-dialog input[name="name"]');
    assert.equal(await js("document.querySelector('.bots-ed-dialog input[name=\"name\"]').value"), 'Weekly report');
    assert.equal(await has('.bots-ed-dialog .bots-ed-advanced:not([hidden])'), true, 'a cron routine opens with More options showing');
    assert.equal(await js("document.querySelector('.bots-ed-dialog select[name=\"repeatKind\"]').value"), 'cron', 'the advanced select shows the current repeat');
    assert.equal(await js("[...document.querySelectorAll('.bots-ed-chip')].filter(n => n.getAttribute('aria-checked') === 'true').length"), 0, 'no simple chip is falsely chosen');
    assert.equal(await js("document.querySelectorAll('.bots-ed-chip[tabindex=\"0\"]').length"), 1, 'the chips stay reachable by keyboard');
    assert.equal(await js("document.querySelector('.bots-ed-dialog input[name=\"cron\"]').value"), '0 9 * * 1');
    await waitSel('.bots-ed-preview:not([hidden]) .bots-ed-next li');
    assert.equal(await count('.bots-ed-preview .bots-ed-next li'), 3, 'the next three times from the preview');
    await fill('.bots-ed-dialog input[name="cron"]', '0 9 * *');
    await waitFor("document.querySelector('.bots-ed-dialog input[name=\"cron\"]').getAttribute('aria-invalid') === 'true'");
    assert.match(await textOf('.bots-ed-field[data-field="cron"] .bots-ed-error'), /five fields/, 'the error is on the field, in plain words');
    assert.equal(await js("document.querySelector('.bots-ed-dialog input[name=\"cron\"]').getAttribute('aria-describedby')"), await js("document.querySelector('.bots-ed-field[data-field=\"cron\"] .bots-ed-error').id"));
    await fill('.bots-ed-dialog input[name="cron"]', '0 9 L * *');
    await waitFor("document.querySelector('.bots-ed-dialog input[name=\"cron\"]').getAttribute('aria-invalid') === null");
    await waitFor("document.querySelector('.bots-ed-sentence')?.textContent.includes('0 9 L * *')");
    mark = writes.length;
    await click('.bots-ed-dialog .bots-btn.primary');
    const cron = bodyOf(await waitWrite(mark, 'PATCH', '/api/bot-routines/r3'));
    assert.deepEqual([cron.schedule.kind, cron.schedule.expression, !!cron.schedule.time_zone, cron.expected_revision], ['cron', '0 9 L * *', true, 1], 'cron saves with a named zone and the revision it opened');
    await gone('.bots-ed-dialog');
    assert.equal(await js("document.activeElement?.dataset?.action"), 'edit', 'saving also returns focus');
    await waitFor("document.querySelector('.bots-auto-row[data-key=\"routine:r3\"] .bots-auto-row-sentence').textContent.includes('0 9 L * *')");

    // A new routine: empty save names the first bad field and focuses it.
    await click('.bots-auto-new');
    await click('.bots-auto-manual');
    await waitSel('.bots-menu');
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('On a schedule')).click()");
    await waitSel('.bots-ed-dialog input[name="name"]');
    assert.equal(await js("document.querySelector('.bots-ed-dialog .modal-header span').textContent"), 'New routine');
    await click('.bots-ed-dialog .bots-btn.primary');
    await waitFor("document.querySelector('.bots-ed-dialog input[name=\"name\"]').getAttribute('aria-invalid') === 'true'");
    assert.equal(await js("document.activeElement.name"), 'name', 'focus lands on the first invalid field');
    assert.equal(await textOf('.bots-ed-field[data-field="name"] .bots-ed-error'), 'Give it a name.');
    assert.equal(await js("document.querySelector('.bots-ed-dialog textarea[name=\"prompt\"]').getAttribute('aria-invalid')"), 'true');
    await fill('.bots-ed-dialog input[name="name"]', 'Evening wrap-up');
    await fill('.bots-ed-dialog textarea[name="prompt"]', 'Wrap up the day.');
    // Simple chips: Weekly shows the days; Once asks for a date and refuses the past.
    await js("[...document.querySelectorAll('.bots-ed-chip')].find(n => n.textContent === 'Weekly').click()");
    assert.equal(await js("!document.querySelector('.bots-ed-field[data-field=\"weekdays\"]').hidden"), true, 'Weekly asks which days');
    await js("[...document.querySelectorAll('.bots-ed-field[data-field=\"weekdays\"] .bots-ed-day')].find(n => n.textContent === 'Wed').click()");
    assert.equal(await js("document.querySelectorAll('.bots-ed-field[data-field=\"weekdays\"] .bots-ed-day[aria-pressed=\"true\"]').length"), 2, 'today\'s day and Wednesday');
    await js("[...document.querySelectorAll('.bots-ed-chip')].find(n => n.textContent === 'Once').click()");
    await fill('.bots-ed-dialog input[name="date"]', '2020-01-02');
    await waitFor("document.querySelector('.bots-ed-dialog input[name=\"date\"]').getAttribute('aria-invalid') === 'true'");
    assert.match(await textOf('.bots-ed-field[data-field="date"] .bots-ed-error'), /has passed/);
    // Advanced: a reversed window is refused with the way out.
    await js("[...document.querySelectorAll('.bots-ed-dialog select[name=\"repeatKind\"] option')].length");
    await click('.bots-ed-more');
    await fill('.bots-ed-dialog select[name="repeatKind"]', 'interval');
    await fill('.bots-ed-dialog input[name="everyMinutes"]', '30');
    await js("document.querySelector('.bots-ed-dialog .bots-ed-switch .bots-switch').click()");
    await fill('.bots-ed-dialog input[name="windowStart"]', '17:00');
    await fill('.bots-ed-dialog input[name="windowEnd"]', '09:00');
    await waitFor("!!document.querySelector('.bots-ed-field[data-field=\"window\"] .bots-ed-error:not([hidden])')");
    assert.match(await textOf('.bots-ed-field[data-field="window"] .bots-ed-error'), /two routines/);
    assert.equal(await js("document.querySelector('.bots-ed-dialog input[name=\"date\"]').getAttribute('aria-invalid')"), null, 'the stale date error cleared when the repeat changed');
    // Back to a plain daily routine and save.
    await fill('.bots-ed-dialog select[name="repeatKind"]', 'daily');
    await fill('.bots-ed-dialog input[name="time"]', '18:15');
    await waitSel('.bots-ed-preview:not([hidden])');
    await fill('.bots-ed-dialog select[name="bot"]', beta.id);
    await capture?.('desktop-bots-automations-editor');
    mark = writes.length;
    await click('.bots-ed-dialog .bots-btn.primary');
    const created = bodyOf(await waitWrite(mark, 'POST', '/api/bot-routines'));
    assert.deepEqual([created.name, created.bot_id, created.schedule.kind, created.schedule.time, created.expected_revision], ['Evening wrap-up', beta.id, 'daily', '18:15', undefined], 'a create names the bot and sends no revision');
    assert.equal(created.schedule.weekdays, undefined, 'a daily routine has no weekday list');
    await gone('.bots-ed-dialog');
    await waitSel('.bots-auto-row[data-kind="routine"] .bots-auto-row-sentence');
    await waitFor("[...document.querySelectorAll('.bots-auto-row-sentence')].some(n => n.textContent.includes('Wrap up the day.'))");
    assert.equal(await js("document.querySelector('.bots-auto-row[aria-current=\"true\"] .bots-auto-row-sentence').textContent.includes('Wrap up')"), true, 'the new routine is selected');

    // -- New automation: a message to a bot, and the other two editors ----------------------------
    await click('.bots-auto-new');
    await waitSel('.bots-auto-composer:not([hidden]) textarea');
    await click('.bots-auto-composer [data-action="say"]');
    assert.match(await textOf('.bots-auto-composer .bots-ed-error'), /Say what should happen first/, 'an empty message is refused plainly');
    await fill('.bots-auto-composer .bots-auto-who', alpha.id);
    await fill('.bots-auto-composer textarea', 'Every weekday at 9, summarize my inbox');
    await navs();
    mark = writes.length;
    await click('.bots-auto-composer [data-action="say"]');
    const chat = bodyOf(await waitWrite(mark, 'POST', '/api/chat/live'));
    assert.equal(chat.message, 'Every weekday at 9, summarize my inbox', 'it is an ordinary message to the bot');
    await waitFor("window.__autoNavs.length > 0");
    const toChat = (await navs())[0];
    assert.deepEqual([toChat.tab, toChat.agentId, !!toChat.sessionId], ['botsShell', alpha.id, true], 'and the bot\'s conversation opens');
    await click('.bots-auto-new');   // close the composer again
    await click('.bots-auto-new');
    await waitSel('.bots-auto-composer:not([hidden]) .bots-auto-manual');
    await click('.bots-auto-manual');
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('When another app calls')).click()");
    await waitSel('.bots-ed-dialog input[name="name"]');
    await click('.bots-ed-dialog .bots-btn.primary');
    await waitFor("document.querySelector('.bots-ed-dialog textarea[name=\"prompt\"]').getAttribute('aria-invalid') === 'true'");
    await fill('.bots-ed-dialog select[name="bot"]', alpha.id);
    await fill('.bots-ed-dialog input[name="name"]', `Orders ${stamp}`);
    await fill('.bots-ed-dialog textarea[name="prompt"]', 'Summarize each order.');
    assert.equal(await js("document.querySelector('.bots-ed-dialog .bots-switch').getAttribute('aria-checked')"), 'false', 'Run straight away is off unless chosen');
    mark = writes.length;
    await click('.bots-ed-dialog .bots-btn.primary');
    const hook = bodyOf(await waitWrite(mark, 'POST', '/api/triggers'));
    assert.deepEqual([hook.auto_run, hook.max_pending, hook.agent_id], [false, 3, alpha.id], 'default admission approval');
    await waitSel('.bots-ed-connect:not([hidden]) .bots-ed-code');
    assert.match(await js("document.querySelector('.bots-ed-connect').textContent"), /shown only this once/);
    assert.equal(await js("document.querySelector('.bots-ed-copy[data-secret] .bots-ed-code').textContent"), 'whsec_FIXTURE_ONE_TIME_SECRET');
    await click('.bots-ed-dialog .bots-btn.primary');
    await gone('.bots-ed-dialog');
    await delay(300);
    assert.equal(await js("document.body.textContent.includes('whsec_FIXTURE_ONE_TIME_SECRET')"), false, 'the secret is gone once the dialog closes');
    await waitFor(`[...document.querySelectorAll('.bots-auto-row-sentence')].some(n => n.textContent.includes('Summarize each order.'))`);

    await click('.bots-auto-new');
    await waitSel('.bots-auto-composer:not([hidden]) .bots-auto-manual');
    await click('.bots-auto-manual');
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('something happens in an app')).click()");
    await waitSel('.bots-ed-dialog select[name="app"]');
    assert.equal(await js("document.querySelector('.bots-ed-dialog select[name=\"app\"]').options.length"), 3, 'only connected apps are offered');
    assert.match(await js("document.querySelector('.bots-ed-unavailable').textContent"), /Slack: not connected yet/, 'an app that is not connected says so');
    await fill('.bots-ed-dialog select[name="app"]', 'gmail');
    assert.equal(await js("document.querySelector('.bots-ed-dialog select[name=\"event\"]').value"), 'new_email', 'the only event is chosen');
    assert.equal(await js("!document.querySelector('.bots-ed-field[data-field=\"account\"]').hidden"), true, 'an account choice appears with more than one account');
    assert.match(await textOf('.bots-ed-delivery'), /checks regularly/i, 'polling is labelled honestly');
    await click('.bots-ed-dialog .bots-btn.primary');
    await waitFor("document.querySelector('.bots-ed-dialog textarea[name=\"prompt\"]').getAttribute('aria-invalid') === 'true'");
    await fill('.bots-ed-dialog textarea[name="prompt"]', 'Tell me what matters.');
    mark = writes.length;
    await click('.bots-ed-dialog .bots-btn.primary');
    const appBody = bodyOf(await waitWrite(mark, 'POST', '/api/bot-app-triggers'));
    assert.deepEqual([appBody.app, appBody.event, appBody.prompt_template], ['gmail', 'new_email', 'Tell me what matters.']);
    await gone('.bots-ed-dialog');

    // -- Usage limits: the banner, the pill, continue ---------------------------------------------
    await waitSel('.bots-limit-warn:not([hidden]) li[data-routine-id="r2"]');
    assert.match(await textOf('.bots-limit-warn-title'), /Claude is near its limit and resets/);
    mark = writes.length;
    await click('.bots-limit-warn li[data-routine-id="r2"] .bots-btn');
    const movedWrite = await waitWrite(mark, 'POST', '/api/bot-limit-resets/after-reset');
    assert.deepEqual([bodyOf(movedWrite).routine_id, movedWrite.status], ['r2', 200], 'Move to after reset changes only that routine');
    await js(`(async () => {
      const mod = await import('/static/js/botsLimitReset.js');
      const host = document.createElement('div'); host.id = 'auto-limit-host'; host.style.cssText = 'position:fixed;top:0;left:0;z-index:99'; document.body.append(host);
      window.__limit = await mod.mount(host, { agentId: ${JSON.stringify(alpha.id)}, threadId: 'bots-limit-thread', stoppedByLimit: () => true });
      return true;
    })()`);
    await waitSel('#auto-limit-host .bots-limit-pill');
    assert.match(await textOf('#auto-limit-host .bots-limit-pill'), /^Claude: 92% used, resets \d{1,2}:\d{2} (AM|PM)$/);
    mark = writes.length;
    await click('#auto-limit-host .bots-limit-continue');
    const cont = bodyOf(await waitWrite(mark, 'POST', '/api/bot-limit-resets/continue'));
    assert.deepEqual([cont.bot_id, cont.thread_id], [alpha.id, 'bots-limit-thread'], 'one continuation, in that thread');
    await js("window.__limit.dispose(); document.getElementById('auto-limit-host')?.remove(); true");

    // -- The bot panel's Routines section ---------------------------------------------------------
    await js(`(async () => {
      const mod = await import('/static/js/botsSectionRoutines.js');
      const host = document.createElement('div'); host.id = 'auto-section-host'; host.style.cssText = 'position:fixed;top:60px;right:0;width:360px;z-index:99;background:var(--bots-panel)'; document.body.append(host);
      window.__section = await mod.mount(host, { agentId: ${JSON.stringify(alpha.id)}, navigate: (tab, options) => window.__autoNavs.push({ tab, ...options }) });
      return true;
    })()`);
    await waitSel('#auto-section-host .bots-routines-row');
    const sectionRows = await js("[...document.querySelectorAll('#auto-section-host .bots-routines-row')].map(n => ({ id: n.dataset.routineId, on: n.dataset.enabled }))");
    assert.ok(sectionRows.length >= 6, 'this bot\'s routines');
    assert.deepEqual(sectionRows.map(r => r.on), [...sectionRows.map(r => r.on)].sort().reverse(), 'enabled routines come first');
    assert.equal(sectionRows.some(r => r.id === 'r7'), false, 'only this bot\'s routines');
    assert.match(await textOf('#auto-section-host .bots-routines-row[data-routine-id="r2"] .bots-routines-attention'), /which account/, 'attention shows, clamped to two lines');
    assert.equal(await js("getComputedStyle(document.querySelector('#auto-section-host .bots-routines-attention')).webkitLineClamp"), '2');
    await navs();
    await click('#auto-section-host .bots-routines-row[data-routine-id="r1"] .bots-routines-links .bots-btn');
    const logs = (await navs())[0];
    assert.deepEqual([logs.tab, logs.botId, logs.select], ['botsAutomations', alpha.id, 'routine:r1'], 'Logs opens the page on that routine');
    mark = writes.length;
    await click('#auto-section-host .bots-routines-row[data-routine-id="r1"] .bots-switch');
    assert.equal(bodyOf(await waitWrite(mark, 'PATCH', '/api/bot-routines/r1')).enabled, false, 'the switch pauses it');
    await click('#auto-section-host .bots-routines-add');
    await waitSel('.bots-ed-dialog input[name="name"]');
    assert.equal(await js("document.querySelector('.bots-ed-dialog select[name=\"bot\"]').value"), alpha.id, 'Add starts a routine for this bot');
    await js("document.querySelector('.bots-ed-dialog .modal-close-btn').click()");
    await gone('.bots-ed-dialog');
    await js("window.__section.dispose(); true");
    assert.equal(await has('#auto-section-host .bots-routines'), false, 'dispose removes what it drew');
    await js("document.getElementById('auto-section-host')?.remove(); true");

    // -- The calendar ---------------------------------------------------------------------------
    await openPage({ mode: 'calendar' });
    await waitSel('.bots-cal-event');
    assert.equal(await js("document.querySelector('.bots-segmented.bots-auto-mode [aria-checked=true]').textContent"), 'Calendar');
    assert.equal(await count('.bots-cal-col'), 7, 'a week');
    assert.equal(await js("document.querySelector('.bots-cal-rail').getBoundingClientRect().width"), 320, 'the 320 px mini-month rail');
    assert.equal(await js("document.querySelector('.bots-cal-body').getBoundingClientRect().height"), 1536, '24 hours at 64 px');
    assert.equal(await js("document.querySelector('.bots-cal-day[aria-pressed=true]') !== null && document.querySelectorAll('.bots-cal-day').length >= 35"), true, 'the mini-month marks the selected day');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-cal-event')).borderLeftWidth"), '3px', 'a 3 px bot border');
    assert.equal(await js("document.querySelector('.bots-cal-month-grid .bots-cal-dow').textContent"), 'M', 'Monday first');
    await waitSel('.bots-cal-now');
    assert.equal(await has('.bots-cal-day[data-today]'), true, 'today has its ring');
    // The engine's occurrences (cron) are drawn; paused ones are marked.
    assert.ok(await count('.bots-cal-event[data-routine-id="r3"]') >= 1, 'the cron routine is drawn at the engine\'s own occurrences');
    assert.ok(await count('.bots-cal-event[data-routine-id="r1"]') >= 6, 'a daily routine is drawn on each day');
    // Pick the week that holds a future block of each routine the drag tests need.
    const ensure = async selector => {
      for (let i = 0; i < 2 && !await has(selector); i++) { await click('.bots-cal-nav [aria-label="Next week"]'); await delay(400); }
      assert.ok(await has(selector), `${selector} is on screen`);
    };

    // Select a block: the page's details panel is the 310 px drawer.
    await ensure('.bots-cal-event[data-routine-id="r6"][data-draggable]');
    await click('.bots-cal-event[data-routine-id="r6"][data-draggable]');
    await waitSel('.bots-auto-details:not([hidden])');
    assert.equal(await js("document.querySelector('.bots-auto-details').getBoundingClientRect().width"), 310, 'the 310 px details drawer');
    assert.equal(await textOf('.bots-auto-details-title h2'), 'Standup call');
    assert.equal(await js("document.querySelector('.bots-cal-event[data-routine-id=\"r6\"][aria-pressed=true]') !== null"), true);
    await capture?.('desktop-bots-automations-calendar');

    // Drag a daily call: the page asks whether to move every time, then writes the new time.
    const route = await call('/api/bot-routines', 'GET');
    const standup = route.body.routines.find(r => r.id === 'r6');
    const [sh, sm] = standup.schedule.time.split(':').map(Number);
    const startMinute = sh * 60 + sm, delta = startMinute <= 22 * 60 ? 60 : -60;
    const drag = (selector, { dy = 0, toX = null, toY = null, handle = false } = {}) => js(`(() => {
      const node = document.querySelector(${q(selector)}); if (!node) return 'missing';
      const target = ${handle ? "node.querySelector('[data-resize]')" : 'node'};
      const r = node.getBoundingClientRect(), x = r.left + 12, y = r.top + 8;
      const mk = (type, cx, cy) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true });
      const endX = ${toX === null ? 'x' : toX}, endY = ${toY === null ? `y + ${dy}` : toY};
      target.dispatchEvent(mk('pointerdown', x, y));
      document.dispatchEvent(mk('pointermove', x + 2, y + 10));
      document.dispatchEvent(mk('pointermove', endX, endY));
      document.dispatchEvent(mk('pointerup', endX, endY));
      return 'ok';
    })()`);
    mark = writes.length;
    assert.equal(await drag('.bots-cal-event[data-routine-id="r6"][data-draggable]', { dy: (delta / 60) * 64 }), 'ok');
    await waitSel('.bots-choose-dialog [data-choice="all"]');
    assert.match(await js("document.querySelector('.bots-choose-dialog .modal-header span').textContent"), /Move every time it repeats\?/);
    await click('.bots-choose-dialog [data-choice="all"]');
    const moved = bodyOf(await waitWrite(mark, 'PATCH', '/api/bot-routines/r6'));
    const expectMinute = Math.round((startMinute + delta) / 5) * 5;   // the drop snaps to five minutes
    assert.equal(moved.schedule.time, `${String(Math.floor(expectMinute / 60)).padStart(2, '0')}:${String(expectMinute % 60).padStart(2, '0')}`, 'snapped to five minutes and moved by the drag');
    assert.equal(moved.expected_revision, standup.revision, 'a drag writes with the revision it saw');
    await gone('.bots-choose-dialog');
    // Cancelling the question writes nothing.
    await waitFor(`document.querySelector('.bots-cal-event[data-routine-id="r6"][data-draggable]') && !document.querySelector('.bots-cal-event[data-dragging]')`);
    mark = writes.length;
    await drag('.bots-cal-event[data-routine-id="r6"][data-draggable]', { dy: 64 * (delta > 0 ? -1 : 1) });
    await waitSel('.bots-choose-dialog [data-choice="cancel"]');
    await click('.bots-choose-dialog [data-choice="cancel"]');
    await gone('.bots-choose-dialog');
    await delay(200);
    assert.equal(writes.slice(mark).some(w => w.method === 'PATCH'), false, 'cancel changes nothing');
    // Resize a call: five-minute steps, a PATCH of the block length.
    await waitSel('.bots-cal-event[data-routine-id="r6"][data-kind="occurrence"] [data-resize]');
    mark = writes.length;
    await drag('.bots-cal-event[data-routine-id="r6"][data-kind="occurrence"]', { dy: 64, handle: true });
    const resized = bodyOf(await waitWrite(mark, 'PATCH', '/api/bot-routines/r6'));
    assert.equal(resized.duration_minutes, 90, '30 minutes plus an hour of drag');
    assert.equal(await has('.bots-cal-event[data-routine-id="r1"] [data-resize]'), false, 'only calls have a resize handle');
    // A cron block opens its editor instead of moving.
    await ensure('.bots-cal-event[data-routine-id="r3"][data-draggable]');
    mark = writes.length;
    await drag('.bots-cal-event[data-routine-id="r3"][data-draggable]', { dy: 64 });
    await waitSel('.bots-ed-dialog input[name="cron"]');
    assert.equal(writes.slice(mark).some(w => w.method === 'PATCH'), false, 'dragging cron moved nothing');
    await js("document.querySelector('.bots-ed-dialog .modal-close-btn').click()");
    await gone('.bots-ed-dialog');
    // Drop on the usage-limit marker: choose how to follow the reset.
    await ensure('.bots-cal-reset');
    assert.match(await textOf('.bots-cal-reset-label'), /^Claude resets \d{1,2}:\d{2} (AM|PM)$/, 'a dashed marker where the limit resets');
    await ensure('.bots-cal-event[data-routine-id="r1"][data-draggable]');
    const marker = await js("(() => { const r = document.querySelector('.bots-cal-reset').getBoundingClientRect(); return { x: r.left + 24, y: r.top }; })()");
    mark = writes.length;
    await drag('.bots-cal-event[data-routine-id="r1"][data-draggable]', { toX: marker.x, toY: marker.y + 8 });
    await waitSel('.bots-choose-dialog [data-choice="move"]');
    assert.equal(await count('.bots-choose-dialog [data-choice]'), 4, 'move the next run, once, every reset, or cancel');
    await click('.bots-choose-dialog [data-choice="move"]');
    const after = bodyOf(await waitWrite(mark, 'POST', '/api/bot-limit-resets/after-reset'));
    assert.deepEqual([after.routine_id, after.endpoint_id], ['r1', 'claude'], 'only that routine\'s next run moves');
    await gone('.bots-choose-dialog');
    // An empty slot opens the editor on that day and time.
    await click('.bots-cal-nav [aria-label="Next week"]');
    await delay(400);
    await js(`(() => { const col = document.querySelector('.bots-cal-col'); const r = col.getBoundingClientRect(); col.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 8, clientY: r.top + 64 * 14 + 4 })); return true; })()`);
    await waitSel('.bots-ed-dialog input[name="date"]');
    assert.equal(await js("document.querySelector('.bots-ed-dialog input[name=\"time\"]').value"), '14:00', 'the click\'s half hour');
    assert.equal(await js("document.querySelector('.bots-ed-chip[aria-checked=true]').textContent"), 'Once');
    assert.equal(await js("document.querySelector('.bots-ed-dialog input[name=\"date\"]').value === document.querySelector('.bots-cal-col').dataset.day"), true);
    await js("document.querySelector('.bots-ed-dialog .modal-close-btn').click()");
    await gone('.bots-ed-dialog');
    // Switching to Day shows one column; the mini-month moves the week.
    await js("[...document.querySelectorAll('.bots-cal-bar .bots-segmented button')].find(n => n.textContent === 'Day').click()");
    await waitFor("document.querySelectorAll('.bots-cal-col').length === 1");
    assert.equal(await js("document.querySelector('.bots-cal').dataset.view"), 'day');

    // -- Phone: one day, a sheet for the details, nothing overflowing ---------------------------
    await resize([390, 844]);
    await openPage({ mode: 'calendar' });
    await waitSel('.bots-cal-event');
    assert.equal(await count('.bots-cal-col'), 1, 'a phone shows one day');
    assert.equal(await js("document.querySelector('.bots-cal').dataset.view"), 'day');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-cal-rail')).display"), 'none', 'the rail goes on a phone');
    assert.equal(await js("document.documentElement.scrollWidth <= window.innerWidth"), true, 'no horizontal page scroll on a phone');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-auto, .bots-auto-main, .bots-auto-head')].filter(e => e.scrollWidth > e.clientWidth + 2).map(e => e.className)"), [], 'nothing overflows');
    await js("[...document.querySelectorAll('.bots-auto-mode button')].find(n => n.textContent === 'List').click()");
    await waitSel('.bots-auto-list .bots-auto-row');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-auto-row')].filter(e => e.scrollWidth > e.clientWidth + 2).map(e => e.dataset.key)"), [], 'list rows fit a phone');
    await click('.bots-auto-row[data-key="routine:r1"] .bots-auto-row-main');
    await waitSel('.bots-auto-details[data-open="true"]');
    await waitFor("document.querySelector('.bots-auto-details').getBoundingClientRect().left < 2");   // after its entrance
    const sheet = await js("(() => { const r = document.querySelector('.bots-auto-details').getBoundingClientRect(); return { w: r.width, h: r.height, pos: getComputedStyle(document.querySelector('.bots-auto-details')).position, iw: innerWidth, ih: innerHeight }; })()");
    assert.deepEqual([sheet.pos, Math.round(sheet.w), Math.round(sheet.h)], ['fixed', sheet.iw, sheet.ih], 'the details fill the phone as a sheet');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-auto-details *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className).slice(0, 5)"), [], 'the sheet does not overflow');
    await capture?.('phone-bots-automations-details');
    await click('.bots-auto-details-back');
    await waitFor("document.querySelector('.bots-auto-details').hidden");
    // The editor on a phone fills the screen and keeps its footer reachable.
    await click('.bots-auto-new');
    await click('.bots-auto-manual');
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('On a schedule')).click()");
    await waitSel('.bots-ed-dialog input[name="name"]');
    await waitFor("document.querySelector('.bots-ed-dialog').getBoundingClientRect().top < 2");   // after its entrance
    const dialog = await js(`(() => {
      const d = document.querySelector('.bots-ed-dialog'), r = d.getBoundingClientRect(), f = d.querySelector('.modal-footer').getBoundingClientRect();
      return { w: r.width, iw: innerWidth, footer: f.bottom <= innerHeight + 1 };
    })()`);
    assert.deepEqual([Math.round(dialog.w), dialog.footer], [dialog.iw, true], 'the editor fills a phone, footer in view');
    assert.deepEqual(await overflow(), [], 'no overflow with the editor open');
    await js("document.querySelector('.bots-ed-dialog .modal-close-btn').click()");
    await gone('.bots-ed-dialog');
    await resize([1440, 900]);

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    try {
      await js(`(() => {
        window.__autoDispose?.(); window.__limit?.dispose?.(); window.__section?.dispose?.();
        if (window.__autoNavHandler) window.removeEventListener('jarvis:navigate', window.__autoNavHandler, true);
        for (const id of ['auto-limit-host', 'auto-section-host']) document.getElementById(id)?.remove();
        document.querySelectorAll('.bots-auto-dialog').forEach(n => n.closest('.modal-backdrop')?.remove());
        const host = document.getElementById('view-content'); host?.classList.remove('bots-auto-view'); host?.replaceChildren();
        return true;
      })()`);
      for (const bot of made) await call(`/api/agents/${bot.id}`, 'DELETE').catch(() => {});
      win.setContentSize(1440, 900);
    } finally {
      delete demoState.botsAutomations;
      await restore();
    }
  }
};
