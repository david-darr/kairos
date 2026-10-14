const assert = require('node:assert/strict');

module.exports = async ({ js, waitFor, delay, navigate, writes, demoState, agents, win, liveChunk, liveEvent, liveFinish, capture }) => {
  // Unit 4-iii, 2026-10-14: drive the real modal and stream registry through
  // the isolated renderer. These fixtures never send work to the real app.
  const pressEscape = () => js("document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }))");
  const modal = ".agent-create-dialog";
  const botBody = "[...document.querySelectorAll('.agent-chat-main .msg.assistant .msg-body')].at(-1)";
  const botCard = "[...document.querySelectorAll('.agent-chat-main .msg.assistant')].at(-1)";
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const sendBot = async text => {
    await fill('.agent-chat-main .side-chat-input', text);
    await js("document.querySelector('.agent-chat-main .side-chat-send').click()");
    await waitFor(`${botCard}?.getAttribute('aria-busy') === 'true'`);
  };

  // 1-2. Both entry points use one dialog. An untouched Escape writes nothing;
  // a typed draft asks before Escape can discard it.
  await navigate('agents');
  const before = writes.length;
  await js("document.querySelector('.agents-view .agent-new-card').click()");
  await waitFor(`!!document.querySelector('${modal}')`);
  await capture?.('desktop-agent-create');
  assert.ok(await js("!!document.querySelector('.agent-create-dialog .agent-dot-avatar') && !document.querySelector('.agent-create-dialog .agent-portrait')"), 'creation leads with a dot face');
  assert.ok(await js("document.querySelector('.agent-create-dialog [aria-label=\"Bot name\"]')"));
  await pressEscape();
  await waitFor(`!document.querySelector('${modal}')`);
  assert.equal(writes.slice(before).filter(w => w.path === '/api/agents').length, 0);
  // 2026-10-14: the sidebar's New bot button went with its bot sections;
  // the Agents tab's own button opens the same modal.
  await navigate('agents');
  await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '+ New agent')");
  await js("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '+ New agent').click()");
  await waitFor(`!!document.querySelector('${modal}')`);
  await fill('[aria-label="Bot name"]', 'Temporary');
  await pressEscape();
  await waitFor("!!document.querySelector('.confirm-panel')");
  assert.ok(await js(`!!document.querySelector('${modal}')`));
  await js("document.querySelector('.confirm-panel .modal-footer .btn').click()");
  await waitFor("!document.querySelector('.confirm-panel')");
  assert.ok(await js(`!!document.querySelector('${modal}')`));
  await win.setSize(390, 844);
  await delay(250);
  assert.ok(await js("(() => { const r=document.querySelector('.agent-create-dialog').getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; })()"), 'creation fills phone');
  await win.setSize(1440, 900);
  await js("document.querySelector('.agent-create-footer .btn:not(.primary)').click()");
  assert.equal(writes.slice(before).filter(w => w.path === '/api/agents').length, 0);

  // 3-4. Name gates creation. Presets fill editable, visible fields and a
  // successful create opens the new profile sheet.
  await navigate('agents');
  await js("document.querySelector('.agents-view .agent-new-card').click()");
  await waitFor(`!!document.querySelector('${modal}')`);
  assert.ok(await js("document.querySelector('.agent-create-footer .btn.primary').disabled && document.querySelector('.agent-create-validity').textContent.includes('name')"));
  await js("[...document.querySelectorAll('.agent-create-presets button')].find(n => n.textContent === 'Researcher').click()");
  assert.ok(await js("document.querySelector('[aria-label=Job]').value.includes('Research') && document.querySelector('.agent-create-dialog [aria-label=Soul]').value.includes('sources')"));
  await fill('.agent-create-dialog [aria-label=Soul]', 'Custom standing text');
  await fill('.agent-create-dialog [aria-label="Bot name"]', 'New Researcher');
  assert.equal(await js("document.querySelector('.agent-create-footer .btn.primary').disabled"), false);
  // 2026-10-14: every picker dimension changes the live face; the saved spec
  // is the last previewed combination, including a custom hex color.
  const originalFace = await js("document.querySelector('.agent-create-dialog .agent-avatar-picker img').src");
  for (const [key, value] of [['form', 'cloud'], ['color', '#FA70AB'], ['finish', 'plush'], ['face', 'curious'], ['accessory', 'flower']]) {
    await js(`(() => { const s = document.querySelector('.agent-create-dialog [aria-label="Avatar ${key}"]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
  }
  assert.notEqual(await js("document.querySelector('.agent-create-dialog .agent-avatar-picker img').src"), originalFace, 'picker updates live preview');
  const beforeShuffle = await js("document.querySelector('.agent-create-dialog .agent-avatar-picker img').src");
  await js("document.querySelector('.agent-create-dialog .agent-avatar-shuffle').click()");
  assert.notEqual(await js("document.querySelector('.agent-create-dialog .agent-avatar-picker img').src"), beforeShuffle, 'Shuffle changes the face');
  await js(`(() => { const c = document.querySelector('.agent-create-dialog [aria-label="Avatar custom color"]'); c.value='#123abc'; c.dispatchEvent(new Event('input')); })()`);
  const expectedAvatar = await js("JSON.parse(document.querySelector('.agent-create-dialog .agent-dot-avatar').dataset.avatarSpec)");
  const createStart = writes.length;
  await js("document.querySelector('.agent-create-footer .btn.primary').click()");
  await waitFor("!!document.querySelector('.agent-profile-sheet:not([hidden])')");
  assert.ok(writes.slice(createStart).some(w => w.path === '/api/agents' && JSON.parse(w.body).soul === 'Custom standing text'));
  assert.deepEqual(JSON.parse(writes.slice(createStart).find(w => w.path === '/api/agents').body).avatar, expectedAvatar, 'creation persists the picker spec');
  assert.equal(await js("document.querySelector('.agent-profile-titlebar h2').textContent"), 'New Researcher');
  assert.ok(await js("!!document.querySelector('.agent-profile-sheet .agent-dot-avatar')"), 'profile uses the dot component');
  await capture?.('desktop-agent-profile');

  // 5. Failure of the second write is explicit while the bot remains in the
  // list and its profile opens. The fixture deliberately does not roll back.
  demoState.failFirstRoutine = true;
  await navigate('agents');
  await js("document.querySelector('.agents-view .agent-new-card').click()");
  await waitFor(`!!document.querySelector('${modal}')`);
  await fill('.agent-create-dialog [aria-label="Bot name"]', 'Routine Survivor');
  await fill('.agent-create-dialog [aria-label="Routine name"]', 'Daily watch');
  await fill('.agent-create-dialog [aria-label="What to check"]', 'Check for changes');
  const routineStart = writes.length;
  await js("document.querySelector('.agent-create-footer .btn.primary').click()");
  await waitFor("!!document.querySelector('.agent-create-notice')");
  assert.ok(agents.some(a => a.name === 'Routine Survivor'));
  assert.ok(await js("document.querySelector('.agent-create-notice').textContent.includes('not created')"));
  assert.ok(await js("document.querySelector('.agent-profile-sheet:not([hidden]) .agent-create-notice')"));
  assert.ok(writes.slice(routineStart).some(w => /\/api\/agents\/a\d+\/goals/.test(w.path)));
  assert.equal(await js("document.querySelector('.agent-profile-titlebar h2').textContent"), 'Routine Survivor');
  demoState.failFirstRoutine = false;

  // 6-10. One bot session has agent_id. The registry keeps its run while the
  // pane is absent; text is painted only at a terminal status, even on Stop.
  demoState.sessionFields = { ...(demoState.sessionFields || {}), as1: { agent_id: 'a1' } };
  demoState.liveHoldIds = ['as1', 's1'];
  await navigate('agents', { agentId: 'a1' });
  await waitFor("!!document.querySelector('.agent-chat-main .side-chat-input')");
  await sendBot('What changed today?');
  liveChunk('as1', 'A partial finding');
  liveEvent('as1', 'tool_step', { id: 'read-1', phase: 'started', name: 'read_file', summary: 'Read notes', ok: true });
  await waitFor(`${botCard}?.querySelector('.agent-turn-verb')?.textContent === 'Reading'`);
  assert.ok(await js(`${botCard}?.querySelector('.agent-dot-avatar')`));
  assert.equal(await js(`${botBody}?.textContent.includes('A partial finding')`), false);
  const firstTime = await js(`${botCard}?.querySelector('.agent-turn-elapsed')?.textContent`);
  await delay(1150);
  assert.notEqual(await js(`${botCard}?.querySelector('.agent-turn-elapsed')?.textContent`), firstTime, 'elapsed time ticks');
  liveEvent('as1', 'tool_step', { id: 'read-1', phase: 'finished', name: 'read_file', summary: 'Read notes', ok: true, output: 'Done reading' });
  liveEvent('as1', 'tool_step', { id: 'search-2', phase: 'finished', name: 'search', summary: 'Search failed', ok: false, output: 'Unavailable' });
  await waitFor(`${botCard}?.querySelectorAll('.agent-turn-step').length === 2`);
  assert.deepEqual(await js(`[...${botCard}.querySelectorAll('.agent-turn-step')].map(n => n.open)`), [false, true]);
  await navigate('home');
  liveChunk('as1', ' with a conclusion.');
  await navigate('agents', { agentId: 'a1' });
  await waitFor(`${botCard}?.querySelector('.agent-turn-working:not([hidden])')`);
  assert.equal(await js(`${botBody}?.textContent.includes('A partial finding')`), false);
  liveFinish('as1');
  await waitFor(`${botBody}?.textContent.includes('A partial finding with a conclusion.')`);
  assert.deepEqual(await js(`[...${botCard}.querySelectorAll('.agent-turn-step')].map(n => n.open)`), [false, true]);
  await sendBot('Stop this turn');
  liveChunk('as1', 'Saved so far');
  await js("document.querySelector('.agent-chat-main .side-chat-send').click()");
  await waitFor(`${botCard}?.textContent.includes('Stopped')`);
  await waitFor(`${botBody}?.textContent.includes('Saved so far')`);

  // 7. The main Chats view still paints each chunk immediately.
  await navigate('chat');
  await js("import('/static/js/views/chat.js').then(m => m.openSessionById('s1'))");
  await waitFor("!!document.querySelector('#chat-input')");
  await fill('#chat-input', 'Ordinary stream check');
  await js("document.querySelector('#chat-send').click()");
  await waitFor("!![...document.querySelectorAll('#chat-messages .msg.user')].find(n => n.textContent.includes('Ordinary stream check'))");
  liveChunk('s1', 'Visible before completion');
  await waitFor("[...document.querySelectorAll('#chat-messages .msg.assistant')].at(-1)?.textContent.includes('Visible before completion')");
  liveFinish('s1');

  // 11. Direct conversation remains available with a quiet scheduling line.
  agents[0].enabled = false; agents[0].status = 'off';
  await navigate('agents', { agentId: 'a1' });
  await waitFor("!!document.querySelector('.agent-chat-honesty')");
  assert.ok(await js("document.querySelector('.agent-chat-honesty').textContent.includes('answer here')"));
  agents[0].enabled = true; agents[0].status = 'needs_you';
  await navigate('home'); await navigate('agents', { agentId: 'a1' });
  assert.equal(await js("!!document.querySelector('.agent-chat-honesty')"), false);
  delete demoState.liveHoldIds;
  console.log('PASS: agent birth and turns (12 cases).');
};
