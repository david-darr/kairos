// Bot birth and first turns, migrated to Bots (Phase 1 check migration; flag --agents-birth-only).
// Same intent as the old Agents check: one creation dialog behind both entry points, a draft that asks
// before it is discarded, a name that gates creation, starting roles that fill editable fields, the exact
// connection/version/effort and look saved at creation, a partly failed creation that keeps the bot, and a
// first conversation that streams, survives leaving the page, and keeps its text on Stop. Everything runs in
// Bots mode against the in-memory Bots backend (demoState.botsLive); the check makes its own bot for the
// conversation and restores its preferences in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
const chatBackend = require('./fixtures/bots-chat-backend.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, base, writes, demoState, capture, liveChunk, liveFinish, liveRuns, liveBroadcast }) => {
  const q = JSON.stringify;
  const call = (path, method, body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const select = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); n.value = ${q(value)}; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const pressEscape = () => js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  const creates = from => writes.slice(from).filter(w => w.path === '/api/agents/configured' && w.method === 'POST');
  const waitCreate = async from => {
    for (let i = 0; i < 100; i++) { const hit = creates(from).find(w => w.status); if (hit) return hit; await delay(50); }
    throw new Error('Timed out waiting for the creation request');
  };
  const dialog = '.panel-dialog.bots-create-dialog';
  const setAdvanced = on => js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${on}); return true; })`);
  const store = () => chatBackend.latest;

  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, liveHoldIds: undefined, sessionFields: { ...(demoState.sessionFields || {}) } });
  const botsToRemove = [];
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");
    await navigate('botsHome');
    await waitFor("!!document.querySelector('.bots-home .bots-grid')");

    // 1. Both entry points open one dialog. An untouched dialog closes on Escape and writes nothing.
    await setAdvanced(false);
    let mark = writes.length;
    await click('.bots-home-actions .bots-btn.primary');
    await waitFor(`!!document.querySelector('${dialog}.simple')`);
    await capture?.('desktop-bots-birth-dialog');
    assert.equal(await js(`document.querySelectorAll('${dialog} .bots-swatch').length`), 6, 'creation leads with the six Kip colours');
    assert.ok(await js(`!!document.querySelector('${dialog} .bots-avatar-face img, ${dialog} img')`), 'creation shows a Kip face');
    await pressEscape();
    await waitFor(`!document.querySelector('${dialog}')`);
    assert.equal(creates(mark).length, 0, 'an untouched Escape creates nothing');
    await click('.bots-rail-new');
    await waitFor(`!!document.querySelector('${dialog}.simple')`);
    await pressEscape();
    await waitFor(`!document.querySelector('${dialog}')`);

    // 2. In Advanced, a typed draft asks before Escape can discard it; Keep editing keeps it; phone fills the screen.
    await setAdvanced(true);
    await click('.bots-home-actions .bots-btn.primary');
    await waitFor(`!!document.querySelector('${dialog}.advanced .bots-start-list')`);
    assert.ok(await js(`document.querySelectorAll('${dialog} .bots-text-row, ${dialog} .bots-card-body > *').length >= 8`), 'Advanced creation uses the Bots rows');
    await fill(`${dialog} input[aria-label=Name]`, 'Temporary');
    await pressEscape();
    await waitFor("!!document.querySelector('.confirm-panel')");
    assert.ok(await js(`!!document.querySelector('${dialog}')`));
    await click('.confirm-panel .modal-footer .btn:first-child');
    await waitFor("!document.querySelector('.confirm-panel')");
    assert.equal(await js(`document.querySelector('${dialog} input[aria-label=Name]').value`), 'Temporary', 'keeping the draft keeps the text');
    win.setContentSize(390, 844);
    await delay(300);
    assert.ok(await js(`(() => { const r = document.querySelector('${dialog}').getBoundingClientRect(); return r.width >= innerWidth - 2 && r.height >= innerHeight * 0.85; })()`), 'creation fills a phone');
    win.setContentSize(1440, 900);
    await delay(300);
    await pressEscape();
    await waitFor("!!document.querySelector('.confirm-panel')");
    await click('.confirm-panel .modal-footer .btn:last-child');
    await waitFor(`!document.querySelector('${dialog}')`);
    assert.equal(creates(mark).length, 0, 'a discarded draft creates nothing');

    // 3. A name gates creation; a starting role fills editable fields; the exact connection, version, effort and look are saved.
    await click('.bots-home-actions .bots-btn.primary');
    await waitFor(`!!document.querySelector('${dialog}.advanced .bots-start-list')`);
    await fill(`${dialog} input[aria-label=Name]`, '');
    assert.equal(await js(`document.querySelector('${dialog} .bots-btn.primary').disabled`), true, 'no name, no Create');
    assert.match(await js(`document.querySelector('${dialog} .bots-validity').textContent`), /name/);
    await click(`${dialog} .bots-start-row[data-start="starter-researcher"] .bots-start-pick`);
    const job = await js(`document.querySelector('${dialog} input[aria-label=Job]').value`);
    assert.match(job, /questions and checks the sources/, 'the Researcher role fills the job');
    assert.match(await js("document.querySelector('#bots-create-soul textarea').value"), /sources/, 'and the standing instructions');
    await fill('#bots-create-soul textarea', 'Custom standing text');
    const botName = `Birth Researcher ${Date.now() % 100000}`;
    await fill(`${dialog} input[aria-label=Name]`, botName);
    assert.equal(await js(`document.querySelector('${dialog} .bots-btn.primary').disabled`), false);
    await select(`${dialog} select[aria-label="Connection"]`, 'm1');
    await waitFor(`[...document.querySelector('${dialog} select[aria-label="Model version"]').options].some(o => o.value === 'workspace-large')`);
    assert.ok(await js(`[...document.querySelector('${dialog} select[aria-label="Model version"]').options].some(o => o.textContent === 'Workspace Large')`), 'versions show the catalog names');
    await select(`${dialog} select[aria-label="Model version"]`, 'workspace-large');
    await select(`${dialog} select[aria-label="Reasoning"]`, 'high');
    assert.ok(await js(`document.querySelector('${dialog} .agent-model-summary').textContent.includes('Claude · Workspace Large · high')`), 'the summary shows connection, version and effort');
    const firstFace = await js(`document.querySelector('${dialog} .agent-avatar-picker-preview img').src`);
    for (const [key, value] of [['shape', 'tall'], ['body', '#D99A92'], ['accessory', 'scarf']]) await click(`${dialog} [aria-label="Kip ${key}"] [data-value="${value}"]`);
    assert.notEqual(await js(`document.querySelector('${dialog} .agent-avatar-picker-preview img').src`), firstFace, 'the picker updates the live preview');
    assert.equal(await js(`document.querySelectorAll('${dialog} [aria-label="Kip body"] [role=radio]').length`), 6, 'the six pastels');
    await js(`(() => { const pick = document.querySelector('${dialog} [aria-label="Kip shape"] [aria-checked=true]'); pick.focus(); pick.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); })()`);
    assert.equal(await js(`document.querySelector('${dialog} [aria-label="Kip shape"] [aria-checked=true]').dataset.value`), 'squircle', 'arrow keys move the radio choice');
    const before = await js(`document.querySelector('${dialog} .agent-avatar-picker-preview img').src`);
    await click(`${dialog} .agent-avatar-shuffle`);
    assert.notEqual(await js(`document.querySelector('${dialog} .agent-avatar-picker-preview img').src`), before, 'Shuffle changes the face');
    mark = writes.length;
    await click(`${dialog} .bots-btn.primary`);
    const made = await waitCreate(mark);
    const body = JSON.parse(made.body);
    assert.equal(body.profile.name, botName);
    assert.equal(body.profile.soul, 'Custom standing text', 'the edited text, not the preset, is saved');
    assert.deepEqual(body.model, { endpoint_id: 'm1', model_override: 'workspace-large', model_effort: 'high' }, 'creation saves connection, version and reasoning');
    assert.ok(body.profile.avatar && body.profile.avatar.character, 'creation persists the picker look');
    await waitFor(`!document.querySelector('${dialog}')`);
    const bot = demoState.botsCore.agents.find(a => a.name === botName);
    assert.ok(bot, 'the bot exists');
    botsToRemove.push(bot.id);
    assert.equal(bot.endpoint_id, 'm1', 'the stored bot follows the chosen connection');
    await waitFor(`document.documentElement.dataset.botsAgent === ${q(bot.id)}`);

    // 4. A second write failing is explicit: the warning names it and the bot stays.
    demoState.botsConfiguredWarnings = ['The routine Daily watch was made but could not be turned on: Routine service unavailable'];
    await click('.bots-rail-new');
    await waitFor(`!!document.querySelector('${dialog}.advanced .bots-start-list')`);
    const survivor = `Routine Survivor ${Date.now() % 100000}`;
    await fill(`${dialog} input[aria-label=Name]`, survivor);
    await click('#bots-create-routines .bots-start-more .bots-btn');
    await fill('#bots-create-routines .bots-routine-card input[aria-label="Routine 1 name"]', 'Daily watch');
    await fill('#bots-create-routines .bots-routine-card textarea', 'Check for changes');
    await click(`${dialog} .bots-btn.primary`);
    await waitFor(`!document.querySelector('${dialog}')`);
    const survivorBot = demoState.botsCore.agents.find(a => a.name === survivor);
    assert.ok(survivorBot, 'the bot remains after the routine failed');
    botsToRemove.push(survivorBot.id);
    await waitFor("[...document.querySelectorAll('#toast-host .toast.error')].some(n => n.textContent.includes('could not be turned on'))");
    assert.ok(await js("[...document.querySelectorAll('#toast-host .toast.error')].some(n => n.textContent.includes('Routine Survivor') && n.textContent.includes('was created'))"), 'the notice says the bot was created');
    await js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
    delete demoState.botsConfiguredWarnings;

    // 5-8. A conversation streams, keeps its text across leaving the page, and keeps it on Stop.
    chatBackend.hooks.live = {
      start(sid, turnId, prompt) {
        liveRuns[sid] = { turnId, sessionTitle: 'Chat', prompt, text: '', startedAt: Date.now() / 1000, status: 'processing', stopping: false, permission: null, toolEvents: [], toolSteps: [], handoffs: null, runId: null, error: null, revision: 1 };
        liveBroadcast({ type: 'started', sessionId: sid, run: structuredClone(liveRuns[sid]) });
      },
      finish(sid, status) { liveFinish(sid, status); },
      text: sid => liveRuns[sid]?.text || '',
    };
    const sid = (await call(`/api/agents/${bot.id}/threads`, 'POST', { title: 'Main' })).body.id;
    store().root();
    const open = () => navigate('botsShell', { agentId: bot.id, sessionId: sid });
    const live = '.bots-live', liveBody = `${live} .bots-msg-body`;
    const send = async text => {
      await fill('.bots-composer-input', text);
      await js("document.querySelector('.bots-composer-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
      await waitFor(`!!document.querySelector('${live}')`);
    };
    await open();
    await waitFor("!!document.querySelector('.bots-composer-input')");
    await send('What changed today?');
    liveChunk(sid, 'A partial finding');
    await waitFor(`document.querySelector('${liveBody}')?.textContent.includes('A partial finding')`);
    assert.ok(await js(`!!document.querySelector('${live} .msg-cursor')`), 'a cursor trails the streaming text');
    assert.match(await js(`document.querySelector('${live} .bots-live-line')?.textContent || ''`), /\d+s/, 'the working line shows elapsed time');
    await navigate('home');
    liveChunk(sid, ' with a conclusion.');
    await open();
    await waitFor(`document.querySelector('${liveBody}')?.textContent.includes('A partial finding with a conclusion.')`);
    store().complete(sid, 'done', liveRuns[sid].text);
    await waitFor(`!document.querySelector('${live}') && [...document.querySelectorAll('.bots-msg.bot')].some(n => n.textContent.includes('A partial finding with a conclusion.'))`);
    await send('Stop this turn');
    liveChunk(sid, 'Saved so far');
    await waitFor(`document.querySelector('${liveBody}')?.textContent.includes('Saved so far')`);
    await click('.bots-composer-primary');
    await waitFor(`!document.querySelector('${live}') && !!document.querySelector('.bots-quiet-row')`);
    assert.ok(await js("[...document.querySelectorAll('.bots-msg.bot')].some(n => n.textContent.includes('Saved so far'))"), 'Stop keeps what streamed');
    assert.equal(await js("!!document.querySelector('.msg-cursor')"), false);
    chatBackend.hooks.live = null;

    // 9. A disabled bot can still be spoken to.
    demoState.botsCore.agents.find(a => a.id === bot.id).enabled = false;
    await navigate('home'); await open();
    await waitFor("!!document.querySelector('.bots-composer-input')");
    assert.equal(await js("document.querySelector('.bots-composer-input').disabled"), false, 'a switched-off bot can still be talked to');
    demoState.botsCore.agents.find(a => a.id === bot.id).enabled = true;

    // 10. Ordinary Chats keep their own renderer: each chunk paints at once.
    demoState.sessionFields = { ...(demoState.sessionFields || {}), s1: { agent_id: null } };
    demoState.liveHoldIds = ['s1'];
    await js("localStorage.setItem('kairos:app-mode', 'kairos'); true");
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await navigate('chat');
    await js("import('/static/js/views/chat.js').then(m => m.openSessionById('s1'))");
    await waitFor("!!document.querySelector('#chat-input')");
    await fill('#chat-input', 'Ordinary stream check');
    const previousTurn = liveRuns.s1?.turnId;
    await click('#chat-send');
    for (let tries = 0; liveRuns.s1?.status !== 'processing' || liveRuns.s1.turnId === previousTurn; tries++) {
      if (tries > 100) throw new Error('The ordinary chat turn never reached the test server');
      await delay(50);
    }
    liveChunk('s1', 'Visible before completion');
    await waitFor("[...document.querySelectorAll('#chat-messages .msg.assistant')].at(-1)?.textContent.includes('Visible before completion')");
    liveFinish('s1');
    await navigate('home');
    console.log('PASS: bot birth and first turns in Bots (10 cases).');
  } finally {
    chatBackend.hooks.live = null;
    delete demoState.botsConfiguredWarnings;
    win.setContentSize(1440, 900);
    await restore();
  }
};
