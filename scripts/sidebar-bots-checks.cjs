const assert = require('node:assert/strict');

module.exports = async ({ js, waitFor, delay, navigate, writes, demoState, agents, sessions, win, errors }) => {
  // Agents 2.0, 2026-10-14: exercise the real rail against the same synthetic
  // API as ui-smoke. Keep mutations local to this last case in the full run.
  await navigate('home');
  const timestamp = Date.now() / 1000;
  demoState.sidebarBotSessions = {
    a1: [
      { id: 'bot-scout-new', title: 'Fresh search', agent_id: 'a1', updated_at: timestamp, created_at: timestamp, starred: false },
      { id: 'bot-scout-old', title: 'Earlier search', agent_id: 'a1', updated_at: timestamp - 20, created_at: timestamp - 20, starred: true },
    ],
    a2: [{ id: 'bot-archive', title: 'Sort notes', agent_id: 'a2', updated_at: timestamp - 5, created_at: timestamp - 5, starred: false }],
  };
  demoState.sidebarBotMessages = {
    'bot-scout-new': [{ role: 'user', content: 'Find jobs', ts: timestamp - 2 },
      { role: 'assistant', content: '**Found** [two roles](https://example.com).', ts: timestamp }],
    'bot-scout-old': [{ role: 'assistant', content: 'Older answer', ts: timestamp - 20 }],
    'bot-archive': [{ role: 'assistant', content: 'Notes filed.', ts: timestamp - 5 }],
  };
  sessions[0].starred = true;
  await js("document.dispatchEvent(new Event('jarvis:agents-changed'))");
  await waitFor("document.querySelector('[data-agent-id=a1] .sidebar-bot-preview')?.textContent === 'Found two roles.'");

  // 1. Every bot uses the portrait helper and the latest saved readable reply.
  assert.deepEqual(await js("[...document.querySelectorAll('#nav .sidebar-bot')].map(n => [n.dataset.agentId, !!n.querySelector('.agent-portrait canvas'), !!n.querySelector('.sidebar-bot-name')])"),
    [['a1', true, true], ['a2', true, true]]);
  assert.equal(await js("document.querySelector('[data-agent-id=a1] .sidebar-bot-preview').textContent"), 'Found two roles.');

  // 2. The aggregate needs-you count wins even when another run is working.
  agents[0].status = 'working';
  await js("document.dispatchEvent(new Event('jarvis:agents-changed'))");
  await waitFor("document.querySelector('[data-agent-id=a1]')?.dataset.status === 'needs_you'");
  assert.equal(await js("document.querySelector('[data-agent-id=a1]').dataset.status"), 'needs_you');

  // 3. Work swaps the preview for dots and marks the portrait; reduced motion
  // keeps the indicator while removing the animation.
  assert.ok(await js("document.querySelector('[data-agent-id=a2]').classList.contains('is-working')"));
  assert.equal(await js("getComputedStyle(document.querySelector('[data-agent-id=a2] .sidebar-bot-preview')).display"), 'none');
  assert.equal(await js("getComputedStyle(document.querySelector('[data-agent-id=a2] .sidebar-bot-face'),'::after').backgroundColor"),
    await js("(() => { const n=document.createElement('span'); n.style.color='var(--success)'; document.body.append(n); const c=getComputedStyle(n).color; n.remove(); return c; })()"));
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await js("getComputedStyle(document.querySelector('[data-agent-id=a2] .sidebar-bot-dots i')).animationName"), 'none');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // 4. Expansion sorts by update time, and + uses the existing agent chat
  // route then opens exactly the created session.
  await js("document.querySelector('[data-agent-id=a1] .sidebar-bot-expand').click()");
  assert.deepEqual(await js("[...document.querySelectorAll('[data-agent-id=a1] .sidebar-thread')].map(n => n.dataset.sessionId)"),
    ['bot-scout-new', 'bot-scout-old']);
  const writeStart = writes.length;
  await js("document.querySelector('[data-agent-id=a1] .sidebar-bot-add').click()");
  await waitFor("document.querySelector('.agent-chat-item.active')?.dataset.session?.startsWith('bot-new-')");
  assert.ok(writes.slice(writeStart).some(w => w.path === '/api/agents/a1/chat' && w.method === 'POST'));

  // 5. The bot row opens the 4-i profile sheet.
  await js("document.querySelector('[data-agent-id=a1] .sidebar-bot-main').click()");
  await waitFor("!!document.querySelector('.agent-profile-sheet:not([hidden])')");
  assert.equal(await js("document.querySelector('.agent-profile-sheet').getAttribute('aria-label')"), 'Bot profile');

  // 6. A 52px rail keeps the portrait and its status border, with the name
  // provided by sidebar.js's existing tooltip on focus.
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await js("document.querySelector('#sidebar-toggle').click()");
  await waitFor("Math.round(document.querySelector('#sidebar').getBoundingClientRect().width) === 52");
  assert.ok(await js("(() => { const n=document.querySelector('[data-agent-id=a1]'); const sample=document.createElement('span'); sample.style.color='var(--accent)'; document.body.append(sample); const accent=getComputedStyle(sample).color; sample.remove(); return n.querySelector('.agent-portrait').getClientRects().length > 0 && getComputedStyle(n.querySelector('.sidebar-bot-copy')).display === 'none' && getComputedStyle(n.querySelector('.sidebar-bot-face')).borderColor === accent; })()"));
  assert.ok(await js("[...document.querySelectorAll('#nav .sidebar-bot-face')].every(face => face.getBoundingClientRect().bottom < document.querySelector('#sidebar-footer').getBoundingClientRect().top)"),
    'both portraits fit above the footer');
  await js("document.querySelector('[data-agent-id=a1] .sidebar-bot-main').focus()");
  assert.equal(await js("document.querySelector('.sidebar-tooltip').textContent"), 'Scout');

  // 7. Section preference is independent of the sidebar width and survives
  // a real renderer reload.
  await js("document.querySelector('#sidebar-toggle').click()");
  await waitFor("Math.round(document.querySelector('#sidebar').getBoundingClientRect().width) === 204");
  await js("document.querySelector('[data-section=teams] .sidebar-section-toggle').click()");
  await win.loadURL(win.webContents.getURL());
  await waitFor("!!document.querySelector('[data-agent-id=a1]')");
  assert.equal(await js("document.querySelector('[data-section=teams]').dataset.open"), 'false');
  assert.ok(await js("!!document.querySelector('[data-section=pinned] .sidebar-pinned-row') && !!document.querySelector('[data-section=teams] .sidebar-team-row')"));

  // 8. A status change updates the existing row node, including its colour.
  await js("window.__botRow = document.querySelector('[data-agent-id=a2]')");
  agents[1].status = 'idle';
  await js("document.dispatchEvent(new Event('jarvis:agents-changed'))");
  await waitFor("document.querySelector('[data-agent-id=a2]')?.dataset.status === 'idle'");
  assert.ok(await js("window.__botRow === document.querySelector('[data-agent-id=a2]')"));
  assert.ok(await js("!window.__botRow.classList.contains('is-working')"));

  // 9. Console errors include ResizeObserver warnings in ui-smoke's shared
  // collector, so this guards the complete case rather than a single frame.
  await delay(100);
  assert.deepEqual(errors, [], 'No renderer errors, including ResizeObserver warnings');
  agents[0].status = 'needs_you'; agents[1].status = 'working';
  sessions[0].starred = false;
  delete demoState.sidebarBotSessions; delete demoState.sidebarBotMessages;
  await js("localStorage.removeItem('kairos:sidebar-section:teams')");
};
