const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
const chatBackend = require('./fixtures/bots-chat-backend.cjs');

// Streaming bot replies (Phase 0 U5, rewritten for Phase 1 U3). Run behind --bots-stream-only.
// The bot is made here, with its own conversation, and removed with the fixture store afterwards: nothing
// assumes which bots exist. Bots mode streams through the new conversation (botsChat.js) against the chat
// fixture; the retired `agents` entry must land in the same place once U4's alias is in (until then the
// legacy tab renders and that step is reported, not asserted); ordinary Chats keep their own renderer.
module.exports = async ({ js, waitFor, delay, navigate, win, base, demoState, liveChunk, liveFinish, liveRuns, liveBroadcast }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const store = () => chatBackend.latest;
  chatBackend.hooks.live = {
    start(sid, turnId, prompt) {
      liveRuns[sid] = { turnId, sessionTitle: 'Chat', prompt, text: '', startedAt: Date.now() / 1000, status: 'processing', stopping: false, permission: null, toolEvents: [], toolSteps: [], handoffs: null, runId: null, error: null, revision: 1 };
      liveBroadcast({ type: 'started', sessionId: sid, run: structuredClone(liveRuns[sid]) });
    },
    finish(sid, status) { liveFinish(sid, status); },
    text: sid => liveRuns[sid]?.text || '',
  };
  const live = '.bots-live', body = `${live} .bots-msg-body`;
  const sendMessage = async text => {
    await fill('.bots-composer-input', text);
    await js("document.querySelector('.bots-composer-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
    await waitFor(`!!document.querySelector('${live}')`);
  };

  let restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, liveHoldIds: undefined });
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const botId = (await call('/api/agents', 'POST', { name: `Streamer ${Math.random().toString(36).slice(2, 7)}` })).body.id;
    const sid = (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Main' })).body.id;
    store().root();
    const surfaces = { 'Bots mode': () => navigate('botsShell', { agentId: botId, sessionId: sid }) };
    const aliasWorks = async () => {
      await navigate('agents', { agentId: botId, sessionId: sid });
      await delay(600);
      return js("document.getElementById('view-content')?.dataset.view === 'botsShell'");
    };
    for (const [surface, open] of Object.entries(surfaces)) {
      const say = text => `${surface}: ${text}`;
      await open();
      await waitFor("!!document.querySelector('.bots-composer-input')");
      await sendMessage('What changed today?');
      liveChunk(sid, 'A partial finding');
      await waitFor(`document.querySelector('${body}')?.textContent.includes('A partial finding')`);
      assert.ok(await js(`!!document.querySelector('${live} .msg-cursor')`), say('cursor shows while streaming'));
      assert.match(await js(`document.querySelector('${live} .bots-live-line')?.textContent || ''`), /Writing/, say('the working line says what it is doing'));
      assert.match(await js(`document.querySelector('${live} .bots-live-line')?.textContent || ''`), /\d+s/, say('and for how long'));

      // Leaving and returning keeps the text, and it keeps growing.
      await navigate('home');
      liveChunk(sid, ' with a conclusion.');
      await open();
      await waitFor(`document.querySelector('${body}')?.textContent.includes('A partial finding with a conclusion.')`);
      store().complete(sid, 'done', liveRuns[sid].text);
      await waitFor(`!document.querySelector('${live}') && [...document.querySelectorAll('.bots-msg.bot')].some(n => n.textContent.includes('A partial finding with a conclusion.'))`);

      // Stop keeps the partial text, adds the quiet note, drops the cursor.
      await sendMessage('Stop this turn');
      liveChunk(sid, 'Saved so far');
      await waitFor(`document.querySelector('${body}')?.textContent.includes('Saved so far')`);
      await js("document.querySelector('.bots-composer-primary').click()");
      await waitFor(`!document.querySelector('${live}') && !!document.querySelector('.bots-quiet-row')`);
      assert.ok(await js("[...document.querySelectorAll('.bots-msg.bot')].some(n => n.textContent.includes('Saved so far'))"), say('Stop keeps the partial text'));
      assert.equal(await js("!!document.querySelector('.msg-cursor')"), false, say('no cursor after Stop'));
      assert.equal(liveRuns[sid].status, 'stopped', say('the server turn ended'));
    }
    if (await aliasWorks()) { await waitFor("!!document.querySelector('.bots-composer-input')"); console.log('The agents alias lands in Bots mode.'); }
    else console.log('NOTE: the agents alias is not routed to Bots yet (U4); that step is not asserted here.');
  } finally { chatBackend.hooks.live = null; await restore(); }

  // Ordinary Chats are unchanged: each chunk paints at once.
  restore = await isolateBotsCheck({ js, demoState }, { botsLive: false, sessionFields: { ...(demoState.sessionFields || {}), s1: { agent_id: null } }, liveHoldIds: ['s1'] });
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await navigate('chat');
    await js("import('/static/js/views/chat.js').then(m => m.openSessionById('s1'))");
    await waitFor("!!document.querySelector('#chat-input')");
    await fill('#chat-input', 'Ordinary stream check');
    const previousTurn = liveRuns.s1?.turnId;
    await js("document.querySelector('#chat-send').click()");
    for (let tries = 0; liveRuns.s1?.status !== 'processing' || liveRuns.s1.turnId === previousTurn; tries++) {
      if (tries > 100) throw new Error('The ordinary chat turn never reached the test server');
      await delay(50);
    }
    await waitFor("!![...document.querySelectorAll('#chat-messages .msg.user')].find(n => n.textContent.includes('Ordinary stream check'))");
    liveChunk('s1', 'Visible before completion');
    await waitFor("[...document.querySelectorAll('#chat-messages .msg.assistant')].at(-1)?.textContent.includes('Visible before completion')");
    liveFinish('s1');
    await waitFor("[...document.querySelectorAll('#chat-messages .msg.assistant')].at(-1)?.getAttribute('aria-busy') === 'false'");
  } finally { await restore(); }
  console.log('PASS: bot replies stream in Bots mode (cursor, working line, Stop, return); Chats unchanged.');
};
