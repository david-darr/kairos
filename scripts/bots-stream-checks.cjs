const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

// Streaming bot replies (Phase 0 U5, 2026-10-28). Run behind --bots-stream-only,
// which U1's generic `--bots-<name>-only` loader in ui-smoke.cjs dispatches to
// this file with the same context the agents checks get. The Bots-mode half
// navigates to the `botsShell` tab (U3's contract), so a full run waits for
// integration; the Agents-tab half uses the same chat component and selectors
// as agents-birth-checks.cjs.
module.exports = async ({ js, waitFor, delay, navigate, win, base, demoState, liveChunk, liveEvent, liveFinish, liveRuns }) => {
  const body = "[...document.querySelectorAll('.agent-chat-main .msg.assistant .msg-body')].at(-1)";
  const card = "[...document.querySelectorAll('.agent-chat-main .msg.assistant')].at(-1)";
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const send = async text => {
    const previousTurn = liveRuns.as1?.turnId;
    await fill('.agent-chat-main .side-chat-input', text);
    await js("document.querySelector('.agent-chat-main .side-chat-send').click()");
    await waitFor(`${card}?.getAttribute('aria-busy') === 'true'`);
    for (let tries = 0; liveRuns.as1?.status !== 'processing' || liveRuns.as1.turnId === previousTurn; tries++) {
      if (tries > 100) throw new Error('The bot turn never reached the test server');
      await delay(50);
    }
  };
  const opens = {
    'Agents tab': () => navigate('agents', { agentId: 'a1', sessionId: 'as1' }),
    'Bots mode': () => navigate('botsShell', { agentId: 'a1', sessionId: 'as1' }),
  };

  const restore = await isolateBotsCheck({ js, demoState }, {
    botsLive: false,
    sessionFields: { ...(demoState.sessionFields || {}), as1: { agent_id: 'a1' }, s1: { agent_id: null } },
    sidebarBotSessions: undefined, sidebarBotMessages: undefined,
    liveHoldIds: ['as1', 's1'],
  });
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    for (const [surface, open] of Object.entries(opens)) {
      const say = text => `${surface}: ${text}`;
      await open();
      await waitFor("!!document.querySelector('.agent-chat-main .side-chat-input')");

      // Text and a cursor show mid-turn; the working heading still tells what the bot is doing.
      await send('What changed today?');
      liveChunk('as1', 'A partial finding');
      liveEvent('as1', 'tool_step', { id: 'read-1', phase: 'started', name: 'read_file', summary: 'Read notes', ok: true });
      await waitFor(`${body}?.textContent.includes('A partial finding')`);
      assert.ok(await js(`!!${body}?.querySelector('.msg-cursor')`) || await js(`!!${card}?.querySelector('.msg-cursor')`), say('cursor shows while streaming'));
      await waitFor(`${card}?.querySelector('.agent-turn-verb')?.textContent === 'Reading'`);
      assert.ok(await js(`!!${card}?.querySelector('.agent-turn-elapsed')?.textContent`), say('working timer still shows'));

      // Leaving and returning keeps the text, and it keeps growing.
      await navigate('home');
      liveChunk('as1', ' with a conclusion.');
      await open();
      await waitFor(`${body}?.textContent.includes('A partial finding with a conclusion.')`);
      liveFinish('as1');
      await waitFor(`${card}?.getAttribute('aria-busy') === 'false' && !${card}.querySelector('.msg-cursor')`);
      assert.ok(await js(`${body}?.textContent.includes('A partial finding with a conclusion.')`), say('final text kept'));

      // Stop keeps the partial text, adds the Stopped note, drops the cursor.
      await send('Stop this turn');
      liveChunk('as1', 'Saved so far');
      await waitFor(`${body}?.textContent.includes('Saved so far')`);
      await js("document.querySelector('.agent-chat-main .side-chat-send').click()");
      await waitFor(`${card}?.textContent.includes('Stopped')`);
      for (let tries = 0; liveRuns.as1?.status === 'processing'; tries++) {
        if (tries > 100) throw new Error('The stopped bot turn never finished on the test server');
        await delay(50);
      }
      assert.ok(await js(`${body}?.textContent.includes('Saved so far')`), say('Stop keeps the partial text'));
      assert.equal(await js(`!!${card}?.querySelector('.msg-cursor')`), false, say('no cursor after Stop'));
    }

    // Ordinary Chats are unchanged: each chunk paints at once.
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
  } finally {
    await restore();
  }
  console.log('PASS: bot replies stream in the Agents tab and Bots mode (cursor, heading, Stop, return); Chats unchanged.');
};
