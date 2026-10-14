const assert = require('node:assert/strict');

module.exports = async ({ js, waitFor, delay, navigate, writes, demoState, agents, win, capture }) => {
  // 2026-10-13: use the real ten-second poll. The old Work redraw replaced
  // this textarea, so a slow draft vanished without any click from the user.
  await navigate('agents', { agentId: 'a2', agentTab: 'memory' });
  await waitFor("!!document.querySelector('.agent-memory')");
  await js(`(() => { const area = document.querySelector('.agent-memory'); area.focus(); area.value = 'Half-typed memory draft'; area.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await delay(10600);
  assert.equal(await js("document.querySelector('.agent-memory').value"), 'Half-typed memory draft', 'memory draft survives a real poll');
  assert.ok(await js("document.activeElement === document.querySelector('.agent-memory')"), 'memory keeps focus');

  // Starting and finishing work both refresh the page while the draft lives.
  agents[1].status = 'idle';
  await js("[...document.querySelectorAll('.agent-header-actions .btn')].find(b => b.textContent.startsWith('Turn')).click()");
  await waitFor("document.querySelector('.agent-status-line').textContent === 'Off'");
  assert.equal(await js("document.querySelector('.agent-memory').value"), 'Half-typed memory draft');
  agents[1].status = 'working';
  await js("[...document.querySelectorAll('.agent-header-actions .btn')].find(b => b.textContent.startsWith('Turn')).click()");
  await waitFor("document.querySelector('.agent-status-line').textContent.startsWith('Working')");
  agents[1].status = 'idle';
  await delay(10600);
  assert.equal(await js("document.querySelector('.agent-memory').value"), 'Half-typed memory draft', 'draft survives finish');
  await js("(() => { const a = document.querySelector('.agent-memory'); a.focus(); a.setSelectionRange(7, 7); })()");
  const caret = await js("document.querySelector('.agent-memory').selectionStart");
  agents[1].status = 'working';
  await js("[...document.querySelectorAll('.agent-header-actions .btn')].find(b => b.textContent.startsWith('Turn')).click()");
  await delay(10600);
  assert.equal(await js("document.querySelector('.agent-memory').selectionStart"), caret, 'poll keeps caret position');
  (demoState.agentMemories ||= {}).a2 = 'Updated by the bot';
  await delay(10600);
  assert.equal(await js("document.querySelector('.agent-memory').value"), 'Half-typed memory draft');
  assert.ok(await js("!document.querySelector('.agent-memory + .agent-profile-conflict').hidden"), 'memory conflict is visible');

  const saveStart = writes.length;
  await js("[...document.querySelectorAll('.agent-memory-host button')].find(b => b.textContent === 'Save memory').click()");
  await waitFor("document.querySelector('.agent-memory').dataset.draftBaseline === 'Half-typed memory draft'");
  assert.ok(writes.slice(saveStart).some(w => w.path === '/api/agents/a2/memory' && JSON.parse(w.body).text === 'Half-typed memory draft'), 'memory saves');

  await js("document.querySelector('.agent-profile-open').click()");
  await waitFor("!!document.querySelector('.agent-profile-sheet:not([hidden])')");
  await capture?.('desktop-agent-profile-settings');
  assert.ok(await js("document.querySelector('.agent-profile-details:not([hidden])') && document.querySelector('.agent-profile-tab.active').textContent === 'Details'"));
  const avatarStart = writes.length;
  await js(`(() => { const f=document.querySelector('.agent-profile-sheet [aria-label="Avatar form"]'); f.value='heart'; f.dispatchEvent(new Event('change')); })()`);
  await js("document.querySelector('.agent-profile-details > .btn.primary').click()");
  await waitFor("document.querySelector('.agent-profile-titlebar .agent-dot-avatar')?.dataset.avatarSpec.includes('heart')");
  assert.ok(writes.slice(avatarStart).some(w => w.path === '/api/agents/a2' && JSON.parse(w.body).avatar?.form === 'heart'), 'profile saves avatar');
  await js("[...document.querySelectorAll('.agent-profile-sheet button')].find(b => b.textContent === 'All settings').click()");
  // Coordination, 2026-10-14: Access persists the peer allow-list by id.
  await js("document.querySelector('.agent-profile-section[data-section=access] summary').click()");
  await waitFor("!!document.querySelector('[aria-label=\"Peer Scout\"]')");
  const peerStart = writes.length;
  await js("document.querySelector('[aria-label=\"Peer Scout\"]').click()");
  await js("document.querySelector('.agent-profile-section[data-section=access] .btn.primary').click()");
  for (let i = 0; i < 80 && !writes.slice(peerStart).some(w => w.path === '/api/agents/a2' &&
    JSON.parse(w.body).peers?.includes('a1')); i++) await delay(50);
  assert.ok(writes.slice(peerStart).some(w => w.path === '/api/agents/a2' && JSON.parse(w.body).peers?.includes('a1')),
    'Access saves the selected peer');
  assert.deepEqual(agents[1].peers, ['a1'], 'peer id persisted in the profile');
  await js("(() => { for (const [label, size] of [['Name', 101], ['Job', 201]]) { const field = document.querySelector(`[aria-label=\"${label}\"]`); field.value = 'x'.repeat(size); field.dispatchEvent(new Event('input')); } })()");
  assert.equal(await js("document.querySelector('[aria-label=Name]').value.length"), 100, 'name limit');
  assert.equal(await js("document.querySelector('[aria-label=Job]').value.length"), 200, 'job limit');
  await js("document.querySelector('.agent-profile-section[data-section=overview] summary').click()");
  await js("(() => { const a = document.querySelector('[aria-label=Blurb]'); a.value = 'Draft biography'; a.dispatchEvent(new Event('input', { bubbles:true })); })()");
  await js("document.querySelector('.agent-profile-section[data-section=soul] summary').click()");
  assert.equal(await js("document.querySelector('[aria-label=Blurb]').value"), 'Draft biography', 'accordion switch preserves draft');
  await js("document.querySelector('.agent-profile-section[data-section=overview] summary').click()");
  assert.equal(await js("document.querySelector('[aria-label=Blurb]').value"), 'Draft biography');

  await js("(() => { const q = document.querySelector('.agent-profile-all [type=search]'); q.value = 'soul'; q.dispatchEvent(new Event('input')); })()");
  assert.deepEqual(await js("[...document.querySelectorAll('.agent-profile-section:not([hidden])')].map(x => x.dataset.section)"), ['soul'], 'search filters sections');
  await js("(() => { const q = document.querySelector('.agent-profile-all [type=search]'); q.value = ''; q.dispatchEvent(new Event('input')); })()");
  await js("(() => { const a = document.querySelector('[aria-label=Blurb]'); a.value = 'x'.repeat(3001); a.dispatchEvent(new Event('input', { bubbles:true })); })()");
  assert.ok(await js("!document.querySelector('[aria-label=Blurb]').closest('label').querySelector('.agent-profile-counter').hidden"), 'blurb counter appears past 3000');
  await js("(() => { const a = document.querySelector('[aria-label=Soul]'); a.value = '🙂'.repeat(7000); a.dispatchEvent(new Event('input', { bubbles:true })); })()");
  assert.equal(await js("new TextEncoder().encode(document.querySelector('[aria-label=Soul]').value).length"), 24000, 'soul enforced in UTF-8 bytes');
  assert.equal(await js("document.querySelector('[aria-label=Soul]').value.length"), 12000, 'multi-byte characters are kept whole');
  agents[1].blurb = 'Server biography';
  await delay(10600);
  assert.equal(await js("document.querySelector('[aria-label=Blurb]').value.length"), 3001, 'poll keeps conflicting profile draft');
  assert.ok(await js("!document.querySelector('[aria-label=Blurb]').closest('label').querySelector('.agent-profile-conflict').hidden"), 'server conflict is visible');

  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }))");
  assert.ok(await js("document.querySelector('.agent-profile-sheet').hidden"), 'Escape closes sheet');
  win.setSize(390, 844);
  await js("document.querySelector('.agent-profile-open').click()");
  await waitFor("innerWidth <= 768 && !document.querySelector('.agent-profile-sheet').hidden");
  assert.ok(await js("(() => { const r = document.querySelector('.agent-profile-sheet').getBoundingClientRect(); return r.width === innerWidth && r.left === 0; })()"), 'sheet covers phone content');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))");
  win.setSize(1440, 900);

  agents[1].color = null;
  delete agents[1].avatar;
  await navigate('agents', { agentId:'a2', agentTab:'work' });
  await waitFor("!!document.querySelector('.agent-header .agent-dot-avatar img')");
  const firstAvatar = await js("document.querySelector('.agent-header .agent-dot-avatar img').src");
  for (let reload = 0; reload < 2; reload++) {
    await win.loadURL(win.webContents.getURL());
    await waitFor("!!document.querySelector('.dashboard-core')");
    await navigate('agents', { agentId:'a2', agentTab:'work' });
    await waitFor("!!document.querySelector('.agent-header .agent-dot-avatar img')");
    assert.equal(await js("document.querySelector('.agent-header .agent-dot-avatar img').src"), firstAvatar,
      'missing-avatar default is stable across reloads');
  }

  await navigate('agents');
  const answerStart = writes.length;
  await js("(() => { const item = document.querySelector('.agent-inbox-question'); [...item.querySelectorAll('button')].find(b => b.textContent === 'Reply').click(); item.querySelector('input').value = 'Go ahead'; [...item.querySelectorAll('button')].find(b => b.textContent === 'Send').click(); })()");
  await waitFor("!document.querySelector('.agent-inbox-question')");
  assert.ok(writes.slice(answerStart).some(w => w.path === '/api/agents/inbox/i1/answer' && JSON.parse(w.body).text === 'Go ahead'), 'inbox answer works');
  demoState.agentReview = true;
  await navigate('agents', { agentId:'a1', agentTab:'work' });
  await waitFor("!![...document.querySelectorAll('.agent-inbox-review button')].find(b => b.textContent === 'Approve')");
  const reviewStart = writes.length;
  await js("[...document.querySelectorAll('.agent-inbox-review button')].find(b => b.textContent === 'Approve').click()");
  await waitFor("!document.querySelector('.agent-inbox-review')");
  assert.ok(writes.slice(reviewStart).some(w => w.path === '/api/tasks/c9/status' && JSON.parse(w.body).status === 'done'), 'review approval works');

  demoState.agentSoulFile = 'External soul edit';
  await navigate('agents', { agentId:'a1', agentTab:'work' });
  await js("document.querySelector('.agent-profile-open').click()");
  await js("[...document.querySelectorAll('.agent-profile-sheet button')].find(b => b.textContent === 'All settings').click()");
  await js("document.querySelector('.agent-profile-section[data-section=soul] summary').click()");
  assert.ok(await js("!document.querySelector('.agent-profile-drift').hidden && document.querySelector('.agent-profile-drift .agent-profile-file-text').textContent === 'External soul edit'"), 'file drift is shown');
  demoState.agentSoulFile = 'Changed once more outside Kairos';
  const applyStart = writes.length;
  await js("document.querySelector('.agent-profile-drift button').click()");
  await waitFor("!document.querySelector('.agent-profile-drift [role=alert]').hidden");
  assert.ok(await js("document.querySelector('.agent-profile-drift [role=alert]').textContent.includes('409')"), 'stale apply reason is visible');
  assert.deepEqual(JSON.parse(writes.slice(applyStart).find(w => w.path === '/api/agents/a1/soul/apply').body),
    { expected_file_text:'External soul edit', expected_revision:agents[0].revision }, 'apply sends exact file text and held revision');
  await navigate('agents', { agentId:'a1', agentTab:'work' });
  await js("document.querySelector('.agent-profile-open').click()");
  await js("[...document.querySelectorAll('.agent-profile-sheet button')].find(b => b.textContent === 'All settings').click()");
  await js("document.querySelector('.agent-profile-section[data-section=soul] summary').click()");
  await js("document.querySelector('.agent-profile-drift button').click()");
  await waitFor("document.querySelector('.agent-profile-drift').hidden");
  assert.equal(agents[0].soul, 'Changed once more outside Kairos', 'external file applied by choice');
};
