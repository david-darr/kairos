// Bots attention panels, in the renderer (Agents 3.0 Phase 1, unit U5). Run by ui-smoke behind --bots-attention-only:
//   node scripts/run-electron-test.cjs ui-smoke --bots-attention-only
//
// Covers the Inbox (Needs you / News / Done, reply, approve, a refused answer and its retry, a stale answer, read versus
// done, Open in chat), the notification feed (unread, filter, pin, mark all read, open target), Activity and the Inspector
// (real recorded rows, secrets removed), and the same again in a phone-sized window (85 dvh sheet, Escape, focus).
//
// It creates its own bot through the fixture API and seeds demoState.botsAttention itself (scripts/fixtures/bots-attention-backend.cjs),
// never assuming which other bots exist, and puts every preference, size and fixture value back in `finally`.
// The drawer is mounted here with mountAttentionHost(), so the check does not depend on the sidebar buttons that unit U4 adds.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, demoState, base }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";
  const drawer = "document.querySelector('.bots-attn:not([hidden])')";
  const text = selector => js(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('no ${selector.replace(/'/g, '')}'); n.click(); return true; })()`);
  const clickText = (scope, label) => js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(b => b.textContent.trim().includes(${JSON.stringify(label)})); if (!n) throw new Error('no button ${label}'); n.click(); return true; })()`);
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const rowIds = scope => js(`[...document.querySelectorAll(${JSON.stringify(scope)} + ' .bots-attn-row')].map(n => n.dataset.id)`);
  const tab = value => click(`.bots-attn [data-value="${value}"]`);
  const width = () => js(`Math.round(${drawer}.getBoundingClientRect().width)`);
  const openPanel = (name, args = {}) => js(`import('/static/js/botsAttentionHost.js').then(m => { (m.attentionHost() || m.mountAttentionHost({ pollMs: 600000 })); return m.openAttention(${JSON.stringify(name)}, ${JSON.stringify(args)}); })`);
  const closePanel = () => js("import('/static/js/botsAttentionHost.js').then(m => m.closeAttention())");
  const pressEscape = () => js(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  const waitRows = async (scope, expected, label) => {
    for (let i = 0; i < 60; i++) { if (JSON.stringify(await rowIds(scope)) === JSON.stringify(expected)) return; await delay(50); }
    assert.deepEqual(await rowIds(scope), expected, label);
  };
  const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const original = win.getContentSize();
  const resize = size => { win.setContentSize(size[0], size[1]); return delay(450); };

  const restore = await isolateBotsCheck({ js, demoState });
  let botId = '';
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Its own bot, created through the fixture API; its main conversation is the target of every row.
    const name = `Attention ${Date.now() % 100000}`;
    const made = await call('/api/agents', 'POST', { name });
    assert.equal(made.status, 200, 'the fixture makes a bot');
    botId = made.body.id;
    // A new bot starts with no conversation: make its first one (it becomes the main), then read the main back.
    let sessionId = (await call(`/api/agents/${botId}/threads`, 'GET')).body.main_id;
    if (!sessionId) {
      const first = await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Attention check' });
      assert.equal(first.status, 200, 'the fixture makes a conversation');
      sessionId = (await call(`/api/agents/${botId}/threads`, 'GET')).body.main_id || first.body.id;
    }
    assert.ok(sessionId, 'the bot has a main conversation');
    const at = Date.now() / 1000;
    demoState.botsAttention = {
      items: [
        { id: 'item:q1', kind: 'question', bot: botId, subject: 'Which slot works?', body: 'Pick a time for the review call.', at: at - 60, status: 'open', actions: ['reply', 'close'], session: sessionId, messageId: 'm-q1' },
        { id: 'item:q2', kind: 'question', bot: botId, subject: 'Send the invoice today?', body: 'It is ready.', at: at - 120, status: 'open', actions: ['reply', 'close'], session: sessionId },
        { id: 'review:c1', kind: 'review', bot: botId, subject: 'Shortlist of venues', body: 'Three venues, ranked.', at: at - 180, status: 'open', actions: ['approve', 'reply', 'open'], session: sessionId },
        { id: 'item:r1', kind: 'report', bot: botId, subject: 'Weekly roundup', body: 'A quiet week.', at: at - 240, status: 'open', actions: ['reply', 'open'], session: sessionId },
        { id: 'permission:p1', kind: 'question', bot: botId, subject: 'Waiting for your response', body: '', at: at - 300, status: 'open', actions: ['respond', 'skip'], session: sessionId,
          questions: [{ question: 'Which format?', header: 'Format', multiSelect: false, options: [{ label: 'PDF', description: '' }, { label: 'Word', description: '' }] }] },
      ],
      feed: [
        { id: 'n1', kind: 'question', agent_id: botId, title: 'Which slot works?', body: '', at: at - 60, read: false, pinned: false, backlog: false, target: { tab: 'botsShell', agentId: botId, sessionId, messageId: 'm-q1' } },
        { id: 'n2', kind: 'turn-failed', agent_id: botId, title: 'Reply could not finish', body: '', at: at - 90, read: false, pinned: false, backlog: false, target: { tab: 'botsShell', agentId: botId, sessionId } },
        { id: 'n3', kind: 'done', agent_id: botId, title: 'Reply ready', body: '', at: at - 400, read: true, pinned: false, backlog: false, target: { tab: 'botsShell', agentId: botId, sessionId } },
      ],
      events: { [sessionId]: [
        { id: 'e1', bot: botId, at: at - 30, source: 'kairos-run-timeline', run_id: 'run1', data: { kind: 'tool', name: 'read_file', ok: true, detail: 'notes.md' } },
        { id: 'e2', bot: botId, at: at - 20, source: 'kairos-run-timeline', run_id: 'run1', data: { kind: 'tool', name: 'run_command', ok: false, detail: `curl failed with ${SECRET}` } },
        { id: 'e3', bot: botId, at: at - 10, source: 'kairos-runtime', data: { type: 'turn.completed', status: 'done', label: 'Reply sent' } },
      ] },
      runs: { [sessionId]: [{ id: 'run1', started_at: at - 40, ended_at: at - 5, outcome: 'completed', model: 'm1', input_tokens: 120, output_tokens: 30 }] },
      prefs: {}, failNext: null, responses: [],
    };
    const state = () => demoState.botsAttention;

    // Bots mode, with the page the rows point at open behind the drawer.
    await navigate('botsShell', { agentId: botId, sessionId });
    await waitFor("document.documentElement.dataset.appMode === 'bots'");
    await js("window.__nav = []; document.addEventListener('jarvis:navigate', e => window.__nav.push(e.detail)); true");

    // -- Inbox -----------------------------------------------------------------------------------------------------------
    await openPanel('inbox');
    await waitFor(`!!${drawer} && !!document.querySelector('.bots-attn .bots-attn-row')`);
    assert.equal(await js(`${drawer}.getAttribute('role')`), 'dialog');
    assert.equal(await width(), 380, 'the Inbox is 380 px wide');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-attn [role=radio]')].map(n => n.textContent)"), ['Needs you 4', 'News 1', 'Done'], 'sections carry their counts');
    await waitRows('.bots-attn', ['item:q1', 'item:q2', 'review:c1', 'permission:p1'], 'Needs you lists the waiting items, newest first');
    await tab('news');
    await waitRows('.bots-attn', ['item:r1'], 'a report is News');
    await tab('needs-you');
    await capture?.('desktop-bots-attention-inbox');

    // Opening reads it and answers nothing.
    await click('.bots-attn [data-id="item:q1"]');
    await waitFor("!!document.querySelector('.bots-attn .bots-attn-read')");
    assert.ok((await text('.bots-attn .bots-attn-read')).includes('Pick a time for the review call.'), 'the reading view shows the body');
    for (let i = 0; i < 40 && !state().prefs['item:q1']?.read; i++) await delay(50);
    assert.equal(state().prefs['item:q1']?.read, true, 'opening it marks it read');
    assert.deepEqual(state().responses, [], 'reading answers nothing');

    // A reply needs text; a refused delivery keeps it open and can be retried.
    await clickText('.bots-attn', 'Send reply');
    assert.ok((await text('.bots-attn .bots-attn-read')).includes('Write a reply first.'));
    assert.deepEqual(state().responses, [], 'an empty reply sends nothing');
    await fill('.bots-attn .bots-attn-reply', 'Tuesday at 3');
    state().failNext = { status: 409, detail: 'The team is unavailable right now.' };
    await clickText('.bots-attn', 'Send reply');
    await waitFor("document.querySelector('.bots-attn .bots-attn-read')?.textContent.includes('unavailable right now')");
    assert.ok(await js("!!document.querySelector('.bots-attn .bots-attn-read')"), 'a failed answer stays open');
    assert.deepEqual(state().responses, [], 'nothing was recorded as answered');
    assert.equal(state().items.find(i => i.id === 'item:q1').status, 'open', 'the source is still open');
    await fill('.bots-attn .bots-attn-reply', 'Tuesday at 3');
    await clickText('.bots-attn', 'Send reply');
    await waitFor("!document.querySelector('.bots-attn .bots-attn-read')");
    assert.deepEqual(state().responses.map(r => [r.id, r.action, r.text]), [['item:q1', 'reply', 'Tuesday at 3']], 'the retry went through');
    await waitRows('.bots-attn', ['item:q2', 'review:c1', 'permission:p1'], 'the answered item leaves Needs you');
    await tab('done');
    await waitRows('.bots-attn', ['item:q1'], 'and lands in Done');
    await tab('needs-you');

    // A stale answer: the source changed while the person read it.
    await click('.bots-attn [data-id="item:q2"]');
    await waitFor("!!document.querySelector('.bots-attn .bots-attn-read')");
    state().items.find(i => i.id === 'item:q2').body = 'It is ready, and the amount changed.';
    await fill('.bots-attn .bots-attn-reply', 'Yes');
    await clickText('.bots-attn', 'Send reply');
    await waitFor("document.querySelector('.bots-attn .bots-attn-read')?.textContent.includes('no longer available')");
    assert.equal(state().responses.length, 1, 'a stale answer is refused');
    assert.ok((await text('.bots-attn .bots-attn-read')).includes('the amount changed'), 'and the item is reread');
    await click('.bots-attn [data-action="back"]');

    // Read is not Done, and Done is not Approve.
    await click('.bots-attn [data-id="review:c1"]');
    await waitFor("!!document.querySelector('.bots-attn .bots-attn-read')");
    assert.ok(await js("[...document.querySelectorAll('.bots-attn .bots-attn-read button')].some(b => b.textContent.trim() === 'Approve')"), 'a review offers Approve');
    await clickText('.bots-attn .bots-attn-read', 'Mark done');
    await waitRows('.bots-attn', ['permission:p1', 'item:q2'], 'Done moves it out of Needs you (unread first)');
    assert.equal(state().items.find(i => i.id === 'review:c1').status, 'open', 'Done did not approve it');
    assert.deepEqual(state().responses.map(r => r.action), ['reply']);

    // A question card sends complete answers.
    await click('.bots-attn [data-id="permission:p1"]');
    await waitFor("!!document.querySelector('.bots-attn .bots-attn-questions')");
    await clickText('.bots-attn', 'Send answers');
    assert.ok((await text('.bots-attn .bots-attn-read')).includes('Answer every question first.'));
    await js("(() => { const r = document.querySelector('.bots-attn input[type=radio][value=Word]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await clickText('.bots-attn', 'Send answers');
    await waitFor("!document.querySelector('.bots-attn .bots-attn-read')");
    assert.deepEqual(state().responses.at(-1).answers, { 'Which format?': 'Word' });

    // Open in chat goes to the exact conversation and message.
    await click('.bots-attn [data-id="item:q2"]');
    await waitFor("!!document.querySelector('.bots-attn .bots-attn-read')");
    await js("window.__nav.length = 0; true");
    await click('.bots-attn [data-action="open-chat"]');
    await waitFor('!document.querySelector(".bots-attn:not([hidden])")');
    assert.deepEqual((await js('window.__nav'))[0], { tab: 'botsShell', agentId: botId, sessionId }, 'the exact conversation opens');
    assert.equal(await js('document.getElementById("view-content").dataset.view'), 'botsShell');

    // -- Notifications ----------------------------------------------------------------------------------------------------
    await openPanel('notifications');
    await waitFor("document.querySelectorAll('.bots-attn .bots-attn-row').length === 3");
    assert.equal(await width(), 300, 'Notifications are 300 px wide');
    assert.ok((await text('.bots-attn .bots-attn-count')).includes('2 unread'));
    await tab('problems');
    await waitRows('.bots-attn', ['n2'].map(String), 'the Problems filter');
    await tab('all');
    await js("document.querySelector('.bots-attn [data-id=n3]').closest('.bots-attn-feed-row').querySelector('.bots-attn-pin').click()");
    await waitRows('.bots-attn', ['n3', 'n1', 'n2'], 'a pinned alert leads the feed');
    for (let i = 0; i < 40 && !state().feed.find(r => r.id === 'n3').pinned; i++) await delay(50);
    assert.equal(state().feed.find(r => r.id === 'n3').pinned, true, 'the pin was saved');
    await clickText('.bots-attn', 'Mark all read');
    await waitFor("document.querySelector('.bots-attn .bots-attn-count').textContent.includes('All caught up')");
    for (let i = 0; i < 40 && !state().feed.every(r => r.read); i++) await delay(50);
    assert.equal(state().feed.every(r => r.read), true, 'everything is read');
    await js("window.__nav.length = 0; true");
    await click('.bots-attn [data-id="n1"]');
    await waitFor('!document.querySelector(".bots-attn:not([hidden])")');
    assert.deepEqual((await js('window.__nav'))[0], { tab: 'botsShell', agentId: botId, sessionId, messageId: 'm-q1' }, 'an alert opens its exact message');

    // -- Activity and Inspector --------------------------------------------------------------------------------------------
    await openPanel('activity', { agentId: botId });
    await waitFor("document.querySelectorAll('.bots-attn .bots-attn-entry').length === 3");
    assert.equal(await width(), 400, 'Activity is 400 px wide');
    const activity = await text('.bots-attn');
    assert.ok(activity.includes('Run timeline') && activity.includes('Runtime event'), 'each row says which Kairos record it is');
    assert.ok(!activity.includes(SECRET), 'no secret reaches Activity');
    assert.ok(!/provider trace|native trace/i.test(activity.replace('This is not a provider trace', '')), 'nothing claims to be a provider trace');
    await click('.bots-attn [data-action="inspect"]');
    await waitFor("document.querySelector('.bots-attn')?.dataset.panel === 'inspector'");
    await waitFor("document.querySelectorAll('.bots-attn .bots-attn-entry').length >= 3");
    const inspector = await text('.bots-attn');
    assert.ok(inspector.includes('[REDACTED]') && !inspector.includes(SECRET), 'the Inspector shows events with secrets removed');
    assert.ok(inspector.includes('completed') && inspector.includes('120 in, 30 out'), 'and the real run summary');
    const innerWidth = await js('innerWidth');
    assert.equal(await width(), Math.round(Math.min(460, innerWidth * 0.45)), 'the Inspector is min(460px, 45vw)');
    await tab('problems');
    await waitFor("document.querySelectorAll('.bots-attn .bots-attn-entry[class*=tone-bad]').length === document.querySelectorAll('.bots-attn [aria-label=Events] .bots-attn-entry').length");
    assert.equal(await js("document.querySelectorAll('.bots-attn [aria-label=Events] .bots-attn-entry').length"), 1, 'Problems keeps the failed command');
    await capture?.('desktop-bots-attention-inspector');
    await pressEscape();
    await waitFor('!document.querySelector(".bots-attn:not([hidden])")');

    // -- Phone ------------------------------------------------------------------------------------------------------------
    Object.assign(state(), {
      items: [
        { id: 'item:ph1', kind: 'question', bot: botId, subject: 'Phone question', body: 'Answer from a phone.', at: at - 10, status: 'open', actions: ['reply', 'close'], session: sessionId, messageId: 'm-ph1' },
        { id: 'item:ph2', kind: 'report', bot: botId, subject: 'Phone report', body: 'News on a phone.', at: at - 20, status: 'open', actions: ['reply', 'open'], session: sessionId },
      ],
      feed: [{ id: 'p1', kind: 'question', agent_id: botId, title: 'Phone alert', body: '', at: at - 5, read: false, pinned: false, backlog: false, target: { tab: 'botsShell', agentId: botId, sessionId } }],
      prefs: {}, responses: [], failNext: null,
    });
    await resize([390, 844]);
    await openPanel('inbox');
    await waitFor(`!!${drawer} && !!document.querySelector('.bots-attn .bots-attn-row')`);
    await delay(600);  // the sheet slides in over 350 ms
    const sheet = await js(`(() => { const r = ${drawer}.getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom), vh: innerHeight, vw: innerWidth }; })()`);
    assert.equal(sheet.width, sheet.vw, 'a phone sheet spans the screen');
    assert.ok(Math.abs(sheet.height - Math.round(sheet.vh * 0.85)) <= 2, `the sheet is 85 dvh (${sheet.height} of ${sheet.vh})`);
    assert.ok(Math.abs(sheet.bottom - sheet.vh) <= 1, `and rises from the bottom ${JSON.stringify(sheet)}`);
    assert.equal(await js(`${drawer}.scrollWidth <= ${drawer}.clientWidth + 1`), true, 'no sideways scroll inside the sheet');
    await capture?.('phone-bots-attention-inbox');
    await click('.bots-attn [data-id="item:ph1"]');
    await waitFor("!!document.querySelector('.bots-attn .bots-attn-read')");
    await fill('.bots-attn .bots-attn-reply', 'On it');
    await clickText('.bots-attn', 'Send reply');
    await waitFor("!document.querySelector('.bots-attn .bots-attn-read')");
    assert.deepEqual(state().responses.map(r => [r.id, r.text]), [['item:ph1', 'On it']], 'a phone answer reaches the source');
    await pressEscape();
    await waitFor('!document.querySelector(".bots-attn:not([hidden])")');
    await openPanel('notifications');
    await waitFor("document.querySelectorAll('.bots-attn .bots-attn-row').length === 1");
    await clickText('.bots-attn', 'Mark all read');
    await waitFor("document.querySelector('.bots-attn .bots-attn-count').textContent.includes('All caught up')");
    for (let i = 0; i < 40 && !state().feed[0].read; i++) await delay(50);
    assert.equal(state().feed[0].read, true, 'read state saved from the phone');
    // The scrim closes the sheet.
    await click('.bots-attn-scrim');
    await waitFor('!document.querySelector(".bots-attn:not([hidden])")');

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    try { await closePanel(); } catch { /* the page may be gone */ }
    try { win.setContentSize(original[0], original[1]); await delay(250); } catch { /* window closed */ }
    if (botId) { try { await call(`/api/agents/${botId}`, 'DELETE'); } catch { /* already removed */ } }
    delete demoState.botsAttention;
    await restore();
  }
};
