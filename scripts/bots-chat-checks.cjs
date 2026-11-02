// Bots conversations, in the renderer (Agents 3.0 Phase 1, unit U3). Run behind --bots-chat-only:
//   python <supervisor> <worktree> --bots-chat-only <log> 600
// Runs against scripts/fixtures/bots-chat-backend.cjs (U1's /api/bot-chat contract, in memory). The check makes
// its own bot and conversations, never assumes which other bots exist, and puts every preference and fixture
// switch back in `finally`. Covers: the three composer forms, send, a refused settings save, a lost response and a
// refused send, the queue (edit, delete, steer), guarded Stop (also against the next turn), permission display,
// edit and versions, regenerate, reactions, reply, pin, citations, attachments, find across versions, a long
// transcript (window, older pages, anchor, streaming without pulling the reader), drafts and returning to a stream.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
const chatBackend = require('./fixtures/bots-chat-backend.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, demoState, base, writes, liveChunk, liveChange, liveRuns, liveBroadcast, liveFinish }) => {
  const q = JSON.stringify;
  const call = (path, method, body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const count = selector => js(`document.querySelectorAll(${q(selector)}).length`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const clickText = (selector, label) => js(`(() => { const n = [...document.querySelectorAll(${q(selector)})].find(x => x.textContent.trim() === ${q(label)}); if (!n) throw new Error('missing ' + ${q(label)}); n.click(); return true; })()`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const key = (selector, name, extra = {}) => js(`(() => { const n = document.querySelector(${q(selector)}); n.dispatchEvent(new KeyboardEvent('keydown', { key: ${q(name)}, bubbles: true, cancelable: true, ...${q(extra)} })); return true; })()`);
  const INPUT = '.bots-composer-input', PRIMARY = '.bots-composer-primary';
  const sendsTo = (sid, from = 0) => writes.slice(from).filter(w => w.path === `/api/bot-chat/${sid}/send` && w.method === 'POST');
  const mark = () => writes.length;
  const live = chatBackend.hooks;
  const run = {};
  live.live = {
    start(sid, turnId, prompt) {
      liveRuns[sid] = { turnId, sessionTitle: 'Chat', prompt, text: '', startedAt: Date.now() / 1000, status: 'processing', stopping: false, permission: null, toolEvents: [], toolSteps: [], handoffs: null, runId: null, error: null, revision: 1 };
      liveBroadcast({ type: 'started', sessionId: sid, run: structuredClone(liveRuns[sid]) });
    },
    finish(sid, status) { liveFinish(sid, status); },
    text: sid => liveRuns[sid]?.text || '',
  };
  const store = () => chatBackend.latest;
  const reply = (sid, body) => { liveChunk(sid, body); store().complete(sid, 'done', liveRuns[sid].text); };
  const turnIdOf = sid => store().session(sid).turn?.id;
  const messageTexts = () => js("[...document.querySelectorAll('.bots-log .bots-msg:not(.bots-live) .bots-msg-bubble')].map(n => n.textContent.trim())");

  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, liveHoldIds: undefined, sessionFields: { ...(demoState.sessionFields || {}) } });
  const originalSize = win.getContentSize();
  let botId = '', sid = '', sid2 = '';
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const name = `Chatter ${Math.random().toString(36).slice(2, 7)}`;
    botId = (await call('/api/agents', 'POST', { name })).body.id;
    assert.ok(botId, 'the check made its own bot');
    sid = (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Main' })).body.id;
    store().root();
    store().seed(sid, [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi! **Ready** when you are.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nSecond paragraph.', citations: [{ quote: 'Ready when', comment: 'Nice' }] },
    ]);
    const open = (id = sid, options = {}) => navigate('botsShell', { agentId: botId, sessionId: id, ...options });
    await open();
    await waitFor("document.querySelectorAll('.bots-log .bots-msg').length >= 2");

    // -- The transcript and its composer forms ---------------------------------------------------
    assert.equal(await js("document.querySelector('.bots-log').getAttribute('role')"), 'log');
    assert.equal(await js("document.querySelector('.bots-log').getAttribute('aria-live')"), 'off', 'the transcript is not a live region');
    assert.equal(await js("document.querySelector('.bots-announcer').getAttribute('aria-live')"), 'polite', 'a separate announcer speaks');
    assert.equal(await text('.bots-day'), 'Today');
    assert.ok((await text('.bots-citation')).includes('Ready when'), 'citations show as badges');
    assert.equal(await count('.bots-log pre'), 1, 'the fenced block stays one piece');
    assert.equal(await js(`document.querySelector('.bots-composer').dataset.form`), 'simple', 'Simple is the default form');
    assert.equal(await js(`document.querySelector(${q(PRIMARY)}).dataset.kind`), 'call', 'the round button calls when empty and idle');
    await fill(INPUT, 'typing');
    assert.equal(await js(`document.querySelector(${q(PRIMARY)}).dataset.kind`), 'send', 'and sends with content');
    await fill(INPUT, '');
    await js("import('/static/js/botsUi.js').then(m => m.setAdvanced(true))");
    await waitFor("document.querySelector('.bots-composer').dataset.form === 'advanced'");
    assert.ok(await js("document.querySelector('.bots-composer-clip').offsetParent !== null"), 'Advanced shows the paperclip');
    assert.ok(await js("document.querySelector('.bots-goal-chip').offsetParent !== null"), 'and the goal toggle');
    assert.equal(await text('.bots-composer-access'), 'Full access');
    await js("import('/static/js/botsUi.js').then(m => m.setAdvanced(false))");
    await waitFor("document.querySelector('.bots-composer').dataset.form === 'simple'");
    win.setContentSize(390, 800); await delay(500);
    await waitFor("document.querySelector('.bots-composer').dataset.form === 'phone'");
    assert.ok(await js(`document.querySelector(${q(PRIMARY)}).getBoundingClientRect().width >= 44`), 'phone targets are 44 px');
    assert.ok(await js("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'the phone layout does not scroll sideways');
    win.setContentSize(originalSize[0], originalSize[1]); await delay(500);

    // -- A refused settings save blocks the send and keeps the draft ---------------------------------
    const scratch = `(async () => { const host = document.createElement('div'); host.id = 'chat-scratch'; host.style.cssText = 'position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:var(--bots-app)';
      document.body.append(host); const m = await import('/static/js/botsChat.js'); const agent = (await (await fetch('/api/agents/${botId}')).json()).agent;
      window.__scratchChat = await m.mountBotsChat(host, { agent, sessionId: ${q(sid)}, person: 'barrier', flushSettings: async () => ({ ok: false, error: 'Settings did not save' }) }); return true; })()`;
    await js(scratch);
    let start = mark();
    await fill('#chat-scratch .bots-composer-input', 'blocked message');
    await key('#chat-scratch .bots-composer-input', 'Enter');
    await waitFor("document.querySelector('#chat-scratch .bots-send-error')?.textContent.includes('Settings did not save')");
    assert.equal(sendsTo(sid, start).length, 0, 'no turn starts on unsaved settings');
    assert.equal(await js("document.querySelector('#chat-scratch .bots-composer-input').value"), 'blocked message', 'the draft is untouched');
    await js("window.__scratchChat.dispose(); document.getElementById('chat-scratch').remove(); true");

    // -- Send, stream, finish ------------------------------------------------------------------------
    start = mark();
    await fill(INPUT, 'What changed today?');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-live')");
    assert.equal(sendsTo(sid, start).length, 1);
    const sent = JSON.parse(sendsTo(sid, start)[0].body);
    assert.deepEqual([sent.text, sent.expected_leaf_id, typeof sent.send_id, sent.mode], ['What changed today?', store().session(sid).messages[1].id, 'string', null], 'the send carries its leaf and a send ID; an ordinary message has no mode (bot_chat_service.MODES)');
    assert.equal(await js(`document.querySelector(${q(INPUT)}).value`), '', 'the field is clear as soon as it sends');
    assert.equal(await js("localStorage.getItem('kairos:bots-draft:local:" + botId + ":" + sid + "')"), null, 'and no draft stays behind');
    assert.ok((await messageTexts()).includes('What changed today?'), 'your message shows at once');
    liveChunk(sid, 'A partial finding');
    await waitFor("document.querySelector('.bots-live .bots-msg-body')?.textContent.includes('A partial finding')");
    assert.ok(await exists('.bots-live .msg-cursor'), 'a cursor trails the text');
    assert.match(await text('.bots-live-line'), /Writing|Thinking/);
    assert.equal(await js(`document.querySelector(${q(PRIMARY)}).dataset.kind`), 'stop', 'the round button stops while the bot works');
    reply(sid, ' with a conclusion.');
    await waitFor("!document.querySelector('.bots-live') && [...document.querySelectorAll('.bots-msg.bot')].some(n => n.textContent.includes('A partial finding with a conclusion.'))");
    assert.equal(await js(`document.querySelector(${q(PRIMARY)}).dataset.kind`), 'call', 'idle again');

    // -- A refused send frees the text; a lost response retries with the same send ID -------------------
    store().root().failNext = { mode: 'before', status: 503 };
    start = mark();
    await fill(INPUT, 'Retry me');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-outbox:not([hidden])')");
    assert.match(await text('.bots-outbox'), /Not sent: Retry me/);
    await clickText('.bots-outbox .bots-btn', 'Retry');
    await waitFor("document.querySelector('.bots-outbox')?.hidden === true && !!document.querySelector('.bots-live')");
    let tries = sendsTo(sid, start).map(w => JSON.parse(w.body));
    assert.equal(tries.length, 2); assert.equal(tries[0].send_id, tries[1].send_id, 'Retry keeps its send ID');
    assert.equal(store().session(sid).messages.filter(m => m.content === 'Retry me').length, 1, 'one message, not two');
    reply(sid, 'Done retrying.');
    await waitFor("!document.querySelector('.bots-live')");
    store().root().failNext = { mode: 'after', status: 503 };
    start = mark();
    await fill(INPUT, 'Lost reply');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-outbox:not([hidden])')");
    assert.equal(store().session(sid).messages.filter(m => m.content === 'Lost reply').length, 1, 'the server did accept the first try');
    await clickText('.bots-outbox .bots-btn', 'Retry');
    await waitFor("document.querySelector('.bots-outbox')?.hidden === true");
    tries = sendsTo(sid, start).map(w => JSON.parse(w.body));
    assert.equal(tries[0].send_id, tries[1].send_id);
    assert.equal(store().session(sid).messages.filter(m => m.content === 'Lost reply').length, 1, 'a lost response never duplicates the message');
    await waitFor("!!document.querySelector('.bots-live')");

    // -- The queue: a message sent while the bot works waits ------------------------------------------------
    await fill(INPUT, 'queued one');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-queue-item')");
    assert.equal(await text('.bots-queue-text'), 'queued one');
    assert.equal(await js(`document.querySelector(${q(PRIMARY)}).dataset.kind`), 'stop');
    await clickText('.bots-queue .bots-btn', 'Edit');
    await waitFor(`document.querySelector(${q(INPUT)}).value === 'queued one' && !document.querySelector('.bots-queue-item')`);
    assert.equal(store().session(sid).queue.length, 0, 'Edit takes it off the server queue');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-queue-item')");
    await clickText('.bots-queue .bots-btn', 'Delete');
    await waitFor("!document.querySelector('.bots-queue-item')");
    assert.equal(store().session(sid).queue.length, 0, 'Delete removes it');
    await fill(INPUT, 'steer me');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-queue-item')");
    liveChunk(sid, 'Half an answer');
    const oldTurn = turnIdOf(sid);
    await clickText('.bots-queue .bots-btn', 'Steer');
    await waitFor("[...document.querySelectorAll('.bots-msg.user')].some(n => n.textContent.includes('steer me'))");
    assert.notEqual(turnIdOf(sid), oldTurn, 'steering interrupted the turn and started the queued one');
    assert.ok(store().session(sid).messages.some(m => m.content === 'Half an answer'), 'the partial answer was kept');
    assert.ok(await exists('.bots-quiet-row'), 'the interruption leaves its quiet row');
    reply(sid, 'Steered answer.');
    await waitFor("!document.querySelector('.bots-live')");

    // -- Stop names its turn; a late Stop cannot end the next one -----------------------------------------------
    start = mark();
    await fill(INPUT, 'Stop this one');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-live')");
    const stoppedTurn = turnIdOf(sid);
    liveChunk(sid, 'Saved so far');
    await waitFor("document.querySelector('.bots-live .bots-msg-body')?.textContent.includes('Saved so far')");
    await click(PRIMARY);
    await waitFor("!document.querySelector('.bots-live') && !!document.querySelector('.bots-quiet-row')");
    const interrupt = writes.slice(start).find(w => w.path === `/api/bot-chat/${sid}/interrupt`);
    assert.deepEqual(JSON.parse(interrupt.body), { turn_id: stoppedTurn }, 'Stop sends the turn it means');
    assert.ok((await text('.bots-quiet-row')).includes('You stopped this.'));
    assert.ok((await messageTexts()).some(t => t.includes('Saved so far')), 'Stop keeps the partial text');
    assert.equal(await exists('.bots-live .msg-cursor'), false);
    await fill(INPUT, 'The next turn');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-live')");
    const stale = await call(`/api/bot-chat/${sid}/interrupt`, 'POST', { turn_id: stoppedTurn });
    assert.equal(stale.body.outcome, 'already-stopped', 'a stale Stop is a no-op');
    assert.equal(liveRuns[sid].status, 'processing', 'and the next turn keeps running');

    // -- A permission question shows and blocks the field --------------------------------------------------------
    liveChange(sid, { permission: { id: 'perm-chat-1', tool: 'run_command', title: 'Run a command', description: 'List the folder', target: 'ls' } });
    // The question itself is an approval card (services/bot_cards.py); the chat mounts the card host in its composer slot.
    const asked = (await call('/api/bot-cards/__fixture/open', 'POST', { kind: 'approval', thread_id: sid, bot_id: botId, title: 'Run a command',
      details: { summary: 'List the folder', target: 'ls', tool: 'run_command', lines: [] } })).body;
    assert.ok(asked.id, 'a card for the question');
    await js("document.dispatchEvent(new CustomEvent('kairos:bot-card')); true");
    await waitFor("document.querySelector('.bots-card-composer')?.textContent.includes('Run a command')");
    await waitFor("document.querySelector('.bots-composer-host').hidden === true");
    assert.equal(await js("document.querySelector('.bots-live').dataset.state"), 'needs');
    liveChange(sid, { permission: null });
    await call(`/api/bot-cards/__fixture/expire/${asked.id}`, 'POST', {});
    await js("document.dispatchEvent(new CustomEvent('kairos:bot-card')); true");
    await waitFor("document.querySelector('.bots-composer-host').hidden === false");
    await waitFor(`document.querySelector(${q(INPUT)}).disabled === false`);
    reply(sid, 'Next turn answer.');
    await waitFor("!document.querySelector('.bots-live')");

    // -- Edit makes a version; regenerate makes another answer --------------------------------------------------
    await js(`document.querySelector(${q(INPUT)}).focus()`);
    await key(INPUT, 'ArrowUp');
    await waitFor("!!document.querySelector('.bots-bubble-editor')");
    assert.equal(await js("document.querySelector('.bots-bubble-editor').value"), 'The next turn', 'ArrowUp on an empty field edits your last message');
    await key('.bots-bubble-editor', 'Escape');
    await waitFor("!document.querySelector('.bots-bubble-editor')");
    await key(INPUT, 'ArrowUp');
    await waitFor("!!document.querySelector('.bots-bubble-editor')");
    await js("(() => { const n = document.querySelector('.bots-bubble-editor'); n.value = 'The edited turn'; })()");
    await clickText('.bots-editor .bots-btn', 'Send edit');
    await waitFor("!!document.querySelector('.bots-live') && [...document.querySelectorAll('.bots-msg.user')].some(n => n.textContent.includes('The edited turn'))");
    await waitFor("!!document.querySelector('.bots-versions-count')");
    assert.equal(await text('.bots-versions-count'), '2/2');
    reply(sid, 'Edited answer.');
    await waitFor("!document.querySelector('.bots-live')");
    await click('.bots-versions [aria-label="Previous version"]');
    await waitFor("[...document.querySelectorAll('.bots-msg.user')].some(n => n.textContent.includes('The next turn')) && !document.querySelector('.bots-log').textContent.includes('Edited answer.')");
    assert.equal(await text('.bots-versions-count'), '1/2', 'the first version is back, the second is kept');
    await click('.bots-versions [aria-label="Next version"]');
    await waitFor("document.querySelector('.bots-log').textContent.includes('Edited answer.')");
    // Regenerate through the last reply's menu.
    await js("(() => { const cards = [...document.querySelectorAll('.bots-msg.bot')]; cards.at(-1).querySelector('[data-act=more]').click(); })()");
    await clickText('.bots-menu-row', 'Regenerate');
    await waitFor("!!document.querySelector('.bots-live')");
    reply(sid, 'Alternate answer.');
    await waitFor("!document.querySelector('.bots-live') && document.querySelector('.bots-log').textContent.includes('Alternate answer.')");
    assert.ok((await js("[...document.querySelectorAll('.bots-versions-count')].map(n => n.textContent)")).includes('2/2'), 'the alternate is a second version of the answer');

    // -- Reactions, reply, pin ----------------------------------------------------------------------------------
    const react = async emoji => {
      await js("(() => { document.querySelector('.bots-msg.bot [data-act=react]').click(); })()");
      await clickText('.bots-menu-row', emoji);
    };
    const botCard = "document.querySelector('.bots-msg.bot')";
    await react('\u{1F44D}  Thumbs up');
    await waitFor(`!!${botCard}.querySelector('.bots-reaction.mine')`);
    assert.equal(await js(`${botCard}.querySelector('.bots-reaction').getAttribute('aria-pressed')`), 'true');
    await react('❤️  Heart');
    await waitFor(`${botCard}.querySelectorAll('.bots-reaction').length === 1 && ${botCard}.querySelector('.bots-reaction').textContent.startsWith('❤')`);
    await click('.bots-msg.bot .bots-reaction');
    await waitFor(`!${botCard}.querySelector('.bots-reaction')`);
    await js("(() => { document.querySelector('.bots-msg.bot [data-act=reply]').click(); })()");
    await waitFor("!!document.querySelector('.bots-context-chip')");
    await fill(INPUT, 'About that');
    start = mark();
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-reply-quote')");
    assert.ok(JSON.parse(sendsTo(sid, start)[0].body).reply_to_id, 'the reply names its message');
    reply(sid, 'Replied.');
    await waitFor("!document.querySelector('.bots-live')");
    await js("(() => { document.querySelector('.bots-msg.bot [data-act=more]').click(); })()");
    await clickText('.bots-menu-row', 'Pin');
    await waitFor("document.querySelector('.bots-pinned')?.hidden === false");
    assert.ok(store().session(sid).pinned, 'the server holds the pin');
    await click('.bots-pinned [aria-label="Unpin"]');
    await waitFor("document.querySelector('.bots-pinned')?.hidden === true");
    assert.equal(store().session(sid).pinned, null);

    // -- Attachments: a refused upload shows, a good one is sent ---------------------------------------------------
    store().root().uploads = true;
    const attach = (name, body = 'hello') => js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${q(body)}], ${q(name)}, { type: 'text/plain' }));
      const input = document.querySelector('.bots-composer input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
    store().root().nextUpload = { fail: true, status: 400, detail: 'Too big' };
    await attach('big.txt');
    await waitFor("!!document.querySelector('.bots-staged.failed')");
    assert.ok((await text('.bots-staged.failed')).includes('Too big'), 'a failed upload says why');
    await click('.bots-staged .bots-msg-act');
    await waitFor("!document.querySelector('.bots-staged')");
    store().root().nextUpload = { name: 'notes.txt' };
    await attach('notes.txt');
    await waitFor("!!document.querySelector('.bots-staged.ready')");
    assert.equal(await js(`document.querySelector(${q(PRIMARY)}).dataset.kind`), 'send', 'an attachment alone is content');
    start = mark();
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-live')");
    assert.equal(JSON.parse(sendsTo(sid, start)[0].body).attachment_ids.length, 1);
    await waitFor("!!document.querySelector('.bots-file-chip')");
    assert.ok((await text('.bots-file-chip')).includes('att-'), 'the sent message shows its file');
    reply(sid, 'Got the file.');
    await waitFor("!document.querySelector('.bots-live')");
    store().root().uploads = false;

    // -- Find reaches another version and lands on it --------------------------------------------------------------
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))");
    await waitFor("document.querySelector('.bots-find')?.hidden === false");
    // The landing flash lasts 1.8 s; record it as it happens so a slow poll under load cannot miss it.
    await js("window.__flashSeen = false; window.__flashWatch = new MutationObserver(() => { if (document.querySelector('.bots-msg.flash')) window.__flashSeen = true; }); window.__flashWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); true");
    await fill('.bots-find-input', 'next turn');
    await waitFor("document.querySelector('.bots-find-count')?.textContent.includes('1 of')");
    assert.ok((await text('.bots-find-other')).includes('Other version'), 'a hit in another version is labelled');
    assert.equal(await js("document.querySelector('.bots-find-other').hidden"), false);
    await waitFor("[...document.querySelectorAll('.bots-msg.user')].some(n => n.textContent.includes('The next turn'))");
    await waitFor('window.__flashSeen === true');
    await js('window.__flashWatch.disconnect(); delete window.__flashWatch; delete window.__flashSeen; true');
    await key('.bots-find-input', 'Escape');
    await waitFor("document.querySelector('.bots-find')?.hidden === true");
    await click('.bots-versions [aria-label="Next version"]');

    // -- Drafts survive leaving and a reload ---------------------------------------------------------------------------
    await fill(INPUT, 'half written');
    await js(`document.querySelector(${q(INPUT)}).blur()`);
    await navigate('home');
    await open();
    await waitFor(`document.querySelector(${q(INPUT)})?.value === 'half written'`);
    await fill(INPUT, '');
    await js(`document.querySelector(${q(INPUT)}).blur()`);

    // -- A stream keeps going while you are away, and is there on return ------------------------------------------------
    await fill(INPUT, 'Stream while away');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-live')");
    liveChunk(sid, 'Before leaving. ');
    await navigate('home');
    liveChunk(sid, 'After leaving.');
    await open();
    await waitFor("document.querySelector('.bots-live .bots-msg-body')?.textContent.includes('Before leaving. After leaving.')");
    reply(sid, ' Finished.');
    await waitFor("!document.querySelector('.bots-live')");

    // -- A long transcript: a window, older pages, an anchored view, a stream that does not pull you down ----------------
    sid2 = (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Long' })).body.id;
    store().seed(sid2, Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Long message ${i}`, ts: Date.now() / 1000 - (400 - i) * 5 })));
    await open(sid2);
    await waitFor("document.querySelectorAll('.bots-log .bots-msg').length > 20");
    assert.ok(await count('.bots-log .bots-msg') <= 120, 'at most 120 messages are drawn');
    assert.ok((await text('.bots-log')).includes('Long message 399'), 'it opens at the latest message');
    await js("(() => { const s = document.querySelector('.bots-transcript'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true })); s.scrollTop = 0; })()");
    await waitFor("document.querySelector('.bots-log').textContent.includes('Long message 349')", 8000); // the older page loaded and its newest rows came into view
    assert.ok(await js("!document.querySelector('.bots-jump').hidden"), 'a jump-to-latest control shows when you are away from the end');
    // Streaming must not move a reader who scrolled up.
    await js("(() => { const s = document.querySelector('.bots-transcript'); s.scrollTop = 600; })()");
    await delay(200);
    const top = await js("document.querySelector('.bots-transcript').scrollTop");
    await fill(INPUT, 'Stream into the long one');
    await key(INPUT, 'Enter');
    await waitFor("!!document.querySelector('.bots-live')");
    for (let i = 0; i < 5; i++) { liveChunk(sid2, 'Long streamed line. '); await delay(60); }
    await delay(200);
    assert.ok(Math.abs((await js("document.querySelector('.bots-transcript').scrollTop")) - top) < 40, 'streaming leaves the reader where they were');
    reply(sid2, 'End.');
    await waitFor("!document.querySelector('.bots-live')");
    await click('.bots-jump');
    await waitFor("document.querySelector('.bots-jump')?.hidden === true || document.querySelector('.bots-transcript').scrollHeight - document.querySelector('.bots-transcript').scrollTop - document.querySelector('.bots-transcript').clientHeight < 120");
  } finally {
    try { win.setContentSize(originalSize[0], originalSize[1]); } catch { /* The window may be closing. */ }
    live.live = null;
    try { await js("(() => { document.getElementById('chat-scratch')?.remove(); try { import('/static/js/botsUi.js').then(m => m.setAdvanced(false)); } catch {} return true; })()"); } catch { /* Page gone. */ }
    try { await js(`Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-draft:')).forEach(k => localStorage.removeItem(k))`); } catch { /* Page gone. */ }
    if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
    void run; void sid2;
    await restore();
  }
  console.log('PASS: Bots conversations send, stream, queue, stop, branch, react, attach, search and window correctly.');
};
