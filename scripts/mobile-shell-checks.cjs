// Run through ui-smoke.cjs --mobile-shell-only (and in the full run). Real Chromium layout against the synthetic
// API: the phone launch surface, New/Chats pager, history gestures, tab sheet, running-work player, finished deck,
// morphing composer, dictation row, conversation chrome, reduced motion and breakpoints. Desktop stays untouched.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, capture, delay, navigate, writes, overflow, demoState }) => {
  const resize = async (w, h) => { win.setContentSize(w, h); await delay(350); };
  const press = async (key, code = key, vk = 0) => {
    const send = type => win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
    await send('keyDown'); await send('keyUp'); await delay(120);
  };
  const rect = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`);
  // Synthetic touches: the pager, history rows, drawers and sheets all listen to touch events.
  const swipe = (selector, x, y, dx, dy = 0, { commit = true } = {}) => js(`(async () => {
    document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges();
    const target = document.querySelector(${JSON.stringify(selector)});
    const mk = (cx, cy) => new Touch({ identifier: 5, target, clientX: cx, clientY: cy });
    const fire = (type, cx, cy, end) => target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: end ? [] : [mk(cx, cy)], changedTouches: [mk(cx, cy)] }));
    fire('touchstart', ${x}, ${y});
    for (let i = 1; i <= 6; i++) { fire('touchmove', ${x} + ${dx} * i / 6, ${y} + ${dy} * i / 6); await new Promise(r => setTimeout(r, 16)); }
    fire(${commit ? "'touchend'" : "'touchcancel'"}, ${x} + ${dx}, ${y} + ${dy}, true);
    return true;
  })()`);
  const page = () => js("Number(document.querySelector('.ms-shell').style.getPropertyValue('--ms-page'))");
  const small = () => js(`[...document.querySelectorAll('.ms-shell button, .ms-shell input, .ms-shell select, .ms-shell textarea, .ms-activity button, .ms-tab-sheet button')].filter(n => { const s = getComputedStyle(n); if (s.visibility === 'hidden' || n.closest('[hidden], [inert]')) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && (r.width < 43.5 || r.height < 43.5); }).map(n => (n.className || n.tagName) + ' ' + Math.round(n.getBoundingClientRect().width) + 'x' + Math.round(n.getBoundingClientRect().height))`);
  const live = id => js(`fetch('/api/chat/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: ${JSON.stringify(id)}, message: 'Check ' + ${JSON.stringify(id)} }) })`);
  const home = async (pageIndex = 0) => {
    await navigate('home', { mobilePage: pageIndex });
    await waitFor("!!document.querySelector('.ms-shell') && !document.querySelector('.ms-shell').hidden");
    await delay(500);
  };

  // ---- A1: the launch surface
  await resize(390, 844);
  await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'default', redesign: true }))");
  await home();
  assert.deepEqual(await overflow(), [], 'Launch surface has no overflow');
  assert.equal(await js("document.querySelector('.ms-shell h1').textContent"), 'What should we work on?');
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-header-row > *')].map(n => n.className.split(' ')[0])"), ['ms-avatar', 'ms-switch', 'ms-settings'], 'Header is avatar, New/Chats switch and Settings');
  assert.equal(Math.round((await rect('.ms-mark')).w), 84, 'Centered mark is 84px');
  assert.ok(await js("document.querySelector('.ms-background')?.getClientRects().length > 0"), 'The backdrop runs full bleed behind the launch surface');
  assert.equal(await js("getComputedStyle(document.getElementById('mobile-menu-btn')).visibility"), 'hidden', 'The avatar replaces the hamburger');
  assert.equal(await js("document.getElementById('chat-input').placeholder"), 'Plan, ask, build…');
  const rest = await rect('.ms-composer');
  assert.ok(rest.h >= 48 && rest.h <= 56, `Composer rests as a pill (${rest.h}px)`);
  assert.ok(rest.b <= 844 - 12 + 1, 'Composer clears the bottom edge');
  assert.deepEqual(await small(), [], 'Launch controls are at least 44px');
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-header .ms-blur-top i')).backdropFilter.includes('blur')"), true, 'The header has a gradual edge blur');
  assert.equal(await js("document.querySelectorAll('.ms-header .ms-blur-top i').length"), 6, 'Edge blur is built from six layers');
  await capture('shell-new-idle');

  // ---- A1/A2: New / Chats pager
  assert.equal(await js("document.getElementById('ms-tab-0').getAttribute('aria-selected')"), 'true');
  await js("document.getElementById('ms-tab-1').click()"); await delay(450);
  assert.equal(await page(), 1, 'Tapping Chats moves the pager');
  assert.equal(await js("document.getElementById('ms-page-0').inert && !document.getElementById('ms-page-1').inert"), true, 'The hidden page is inert');
  await js("document.getElementById('ms-tab-1').focus()");
  await press('ArrowLeft', 'ArrowLeft', 37); assert.equal(await page(), 0, 'ArrowLeft selects New');
  assert.equal(await js("document.activeElement.id"), 'ms-tab-0', 'Focus follows the selected tab');
  await press('End', 'End', 35); assert.equal(await page(), 1, 'End selects Chats');
  await press('Home', 'Home', 36); assert.equal(await page(), 0, 'Home selects New');
  await swipe('.ms-intro', 300, 300, -140); await delay(450);
  assert.equal(await page(), 1, 'A left swipe moves New to Chats');
  await swipe('.ms-history-list', 300, 600, 20, 0, { commit: false }); await delay(300);
  assert.equal(await page(), 1, 'A cancelled short drag leaves the page alone');
  await swipe('.ms-history-list', 300, 700, 140); await delay(450);
  assert.equal(await page(), 0, 'A right swipe outside the drawer zone returns to New');
  await js("document.getElementById('ms-tab-1').click()"); await delay(450);
  await swipe('.ms-history-list', 40, 700, 140); await delay(500);
  assert.equal(await page(), 1, 'A right swipe in the drawer zone does not move the pager');
  assert.equal(await js("document.getElementById('sidebar').classList.contains('open')"), true, 'It opens the main drawer instead');
  await js("document.getElementById('mobile-backdrop').click()"); await delay(300);

  // ---- A2: history
  const ids = await js("[...document.querySelectorAll('.ms-history-row')].map(n => n.dataset.sessionId)");
  assert.deepEqual(ids, ['fs1', 's1', 's2', 's3'], 'History is newest first, Forge sessions included');
  assert.equal(await js("document.querySelector('.ms-history-row[data-session-id=fs1] small').textContent.startsWith('Forge')"), true, 'Forge rows are labelled');
  assert.equal(await js("document.querySelectorAll('.ms-history-main strong').length"), 4);
  assert.ok(await js("[...document.querySelectorAll('.ms-history-age')].every(n => /^(Now|\\d+[mhd]|Working)$/.test(n.textContent))"), 'Rows show an age or Working');
  assert.deepEqual(await small(), [], 'History controls are at least 44px');
  await js("(() => { const s = document.querySelector('.ms-history-dock input'); s.focus(); s.value = 'week'; s.dispatchEvent(new Event('input')); })()");
  await delay(120); assert.equal(await js("document.querySelectorAll('.ms-history-row').length"), 4, 'Search is debounced');
  await waitFor("document.querySelectorAll('.ms-history-row').length === 1");
  assert.equal(await js("document.querySelector('.ms-history-main strong').textContent"), 'Planning the week ahead');
  await js("(() => { const s = document.querySelector('.ms-history-dock input'); s.value = 'zzzz'; s.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelector('.ms-history-list [role=status]')?.textContent === 'No matching chats.'");
  await capture('shell-chats-no-match');
  await js("(() => { const s = document.querySelector('.ms-history-dock input'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === 4");
  // Filter popup
  await js("document.querySelector('.ms-history-dock > button').click()"); await delay(250);
  assert.equal(await js("!document.querySelector('.ms-history-filters').hidden && document.querySelector('.ms-history-dock > button').getAttribute('aria-expanded')"), 'true');
  await js("(() => { const f = document.querySelector('.ms-history-filters select'); f.value = 'working'; f.dispatchEvent(new Event('change')); })()");
  await waitFor("document.querySelector('.ms-history-list [role=status]')?.textContent === 'No matching chats.'");
  await js("(() => { const f = document.querySelector('.ms-history-filters select'); f.value = 'all'; f.dispatchEvent(new Event('change')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === 4");
  await press('Escape', 'Escape', 27); await delay(150);
  assert.equal(await js("document.querySelector('.ms-history-filters').hidden"), true, 'Escape closes the filter popup');
  // Row actions
  const row1 = await rect('.ms-history-row[data-session-id=s1] .ms-history-main');
  await swipe('.ms-history-row[data-session-id=s1] .ms-history-main', row1.x + 300, row1.y + 20, -130); await delay(400);
  assert.equal(await js("document.querySelector('.ms-history-row[data-session-id=s1]').classList.contains('ms-actions-open')"), true, 'A left swipe reveals Rename and Delete');
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-history-row[data-session-id=s1] .ms-row-actions button')].map(n => n.textContent)"), ['Rename', 'Delete']);
  const row2 = await rect('.ms-history-row[data-session-id=s2] .ms-history-main');
  await swipe('.ms-history-row[data-session-id=s2] .ms-history-main', row2.x + 300, row2.y + 20, -130); await delay(400);
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-actions-open')].map(n => n.dataset.sessionId)"), ['s2'], 'Only one row stays open');
  await capture('shell-chats-row-actions');
  // Rename in place
  await js("document.querySelector('.ms-history-row[data-session-id=s2] .ms-row-actions button').click()");
  await waitFor("!!document.querySelector('.ms-history-list .session-rename-input')");
  await js("document.querySelector('.ms-history-list .session-rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await delay(250);
  assert.equal(await js("!document.querySelector('.ms-history-list .session-rename-input')"), true, 'Escape cancels a rename');
  // Delete asks first
  const before = writes.length;
  await js("(() => { const r = document.querySelector('.ms-history-row[data-session-id=s3]'); r.querySelector('.ms-row-more').click(); r.querySelectorAll('.ms-row-actions button')[1].click(); })()");
  await waitFor("!!document.querySelector('.modal-panel[role=dialog][aria-modal=true]')");
  assert.ok(await js("document.querySelector('.modal-panel[role=dialog][aria-modal=true]').textContent.includes('permanently deleted')"), 'Delete asks for confirmation first');
  await js("[...document.querySelectorAll('.modal-panel[role=dialog][aria-modal=true] button')].find(b => b.textContent.trim() === 'Cancel').click()");
  await waitFor("!document.querySelector('.modal-panel[role=dialog][aria-modal=true]')");
  await delay(300);
  assert.equal(writes.slice(before).some(w => w.method === 'DELETE'), false, 'Cancelling a delete writes nothing');
  assert.equal(await js("document.querySelectorAll('.ms-history-row').length"), 4);
  // Long press
  await js("document.querySelector('.ms-history-list').dispatchEvent(new Event('scroll'))");
  await js(`(() => { const n = document.querySelector('.ms-history-row[data-session-id=s3] .ms-history-main'); n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100, pointerId: 3 })); })()`);
  await delay(650);
  assert.equal(await js("document.querySelector('.ms-history-row[data-session-id=s3]').classList.contains('ms-actions-open')"), true, 'A long press reveals the same actions');
  await js("document.querySelector('.ms-history-list').dispatchEvent(new Event('scroll'))");

  // ---- A2: a conversation pushes in and back keeps the list
  await js("(() => { const s = document.querySelector('.ms-history-dock input'); s.value = 'clearer'; s.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === 1");
  await js("document.querySelector('.ms-history-row[data-session-id=s1] .ms-history-main').click()");
  await waitFor("!!document.querySelector('.ms-conversation .msg')");
  await delay(450);
  assert.deepEqual(await overflow(), [], 'Conversation has no overflow');
  assert.equal(await js("document.querySelector('.ms-chat-heading strong').textContent"), 'A clearer direction for the workspace');
  assert.equal(await js("document.querySelector('.ms-chat-heading small').textContent"), 'Workspace design', 'The heading names the real project');
  const head = await rect('.chat-mobile-header');
  assert.ok(head.h <= 76 && head.y === 0, `Header is one compact row (${head.h}px)`);
  assert.ok(await js("document.querySelector('.ms-chat-capsule').contains(document.querySelector('.chat-phone-tools > button')) && document.querySelector('.ms-chat-capsule').contains(document.querySelector('.chat-files-toggle'))"), 'Files and the menu share the actions capsule');
  assert.deepEqual(await small(), [], 'Conversation chrome has no small targets');
  await js("document.querySelector('.chat-phone-tools > button').click()");
  const menu = await js("[...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].map(n => n.textContent.trim())");
  for (const item of ['Rename', 'Delete', 'Copy', 'Settings', 'Find in chat', 'Fork', 'Model and reasoning', 'Files in this chat']) assert.ok(menu.includes(item), `Menu has ${item}`);
  await capture('shell-conversation-menu');
  await js("document.getElementById('chat-messages').click()");
  // Composer inside a conversation morphs on focus
  const convoRest = await rect('.chat-input-bar');
  assert.ok(convoRest.h <= 58, `Conversation composer rests as a pill (${convoRest.h}px)`);
  await js("document.getElementById('chat-input').focus()"); await delay(500);
  assert.equal(await js("document.querySelector('.chat-input-bar').classList.contains('ms-composer-expanded')"), true, 'Focus expands the composer');
  assert.ok((await rect('.chat-input-bar')).h > 110, 'The expanded card keeps room for the field, model and Send');
  assert.equal(await js("getComputedStyle(document.getElementById('chat-send')).display !== 'none' && document.getElementById('chat-send').getBoundingClientRect().height >= 44"), true, 'Send appears when drafting');
  await capture('shell-conversation-drafting');
  await js("document.activeElement.blur()");
  // Back keeps the retained search
  await js("document.querySelector('.ms-chat-back').click()");
  await waitFor("!!document.querySelector('.ms-shell') && !document.querySelector('.ms-conversation')");
  await delay(500);
  assert.equal(await page(), 1, 'Back returns to Chats');
  assert.equal(await js("document.querySelector('.ms-history-dock input').value"), 'clearer', 'The search survives the round trip');
  assert.equal(await js("document.querySelectorAll('.ms-history-row').length"), 1);
  await js("(() => { const s = document.querySelector('.ms-history-dock input'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === 4");

  // ---- A3: tab sheet
  await js("document.getElementById('ms-tab-0').click()"); await delay(400);
  await js("document.querySelector('.ms-avatar').focus(); document.querySelector('.ms-avatar').click()");
  await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')");
  await delay(400);
  const navTabs = await js("[...document.querySelectorAll('#nav .nav-item')].map(n => n.dataset.tab)");
  const tiles = await js("[...document.querySelectorAll('.ms-tab-sheet .ms-tab-tile')].map(n => n.dataset.tab || n.textContent.trim())");
  assert.deepEqual(tiles.slice(0, navTabs.length), navTabs, 'Tiles follow the sidebar order');
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-tab-grid')).gridTemplateColumns.split(' ').length"), 3, 'Three columns');
  assert.equal(await js("document.querySelector('.ms-tab-sheet').getAttribute('aria-modal')"), 'true');
  assert.ok(await js("!!document.querySelector('.ms-tab-tile[data-tab=agents] .nav-badge') && document.querySelector('.ms-tab-tile[data-tab=agents]').textContent.includes('2')"), 'Agents shows its badge');
  assert.ok(await js("[...document.querySelectorAll('.ms-tab-sheet .ms-account-row')].some(n => n.textContent.trim() === 'Settings')"), 'Settings row is present');
  assert.deepEqual(await small(), [], 'Tab sheet targets are at least 44px');
  assert.deepEqual(await overflow(), []);
  await capture('shell-tab-sheet');
  // Tab traps both ways
  await js("(() => { const c = [...document.querySelectorAll('.ms-tab-sheet button')].filter(n => n.getClientRects().length); c.at(-1).focus(); })()");
  await press('Tab', 'Tab', 9);
  assert.equal(await js("document.activeElement === [...document.querySelectorAll('.ms-tab-sheet button')].filter(n => n.getClientRects().length)[0]"), true, 'Tab wraps to the first control');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); true");
  await press('Escape', 'Escape', 27); await delay(350);
  assert.equal(await js("!document.querySelector('.ms-tab-sheet[open]')"), true, 'Escape closes the sheet');
  assert.equal(await js("document.activeElement.classList.contains('ms-avatar')"), true, 'Focus returns to the avatar');
  // Backdrop and downward swipe
  await js("document.querySelector('.ms-avatar').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')");
  await js("document.querySelector('.ms-tab-sheet').click()"); await delay(350);
  assert.equal(await js("!document.querySelector('.ms-tab-sheet[open]')"), true, 'Backdrop taps close the sheet');
  await js("document.querySelector('.ms-avatar').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')"); await delay(350);
  await swipe('.ms-sheet-heading', 200, 300, 0, 110); await delay(350);
  assert.equal(await js("!document.querySelector('.ms-tab-sheet[open]')"), true, 'A downward swipe closes the sheet');
  // Tiles navigate
  await js("document.querySelector('.ms-avatar').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')"); await delay(350);
  await js("document.querySelector('.ms-tab-tile[data-tab=notes]').click()");
  await waitFor("document.documentElement.dataset.view === 'notes'");
  assert.equal(await js("!document.querySelector('.ms-tab-sheet[open]')"), true);
  assert.equal(await js("getComputedStyle(document.getElementById('mobile-menu-btn')).visibility"), 'visible', 'Other tabs keep the hamburger drawer');
  await home();

  // ---- Status never floats: badges on the entry controls and rows in the tab sheet
  demoState.liveHoldIds = ['s1'];
  await live('s1'); await delay(800);
  await navigate('notes'); await delay(600);
  assert.equal(await js("[...document.querySelectorAll('.ms-activity')].some(n => !n.hidden && n.getClientRects().length)"), false, 'No floating updates pill on other tabs');
  assert.equal(await js("!!document.querySelector('#mobile-menu-btn > .ms-avatar-badge:not([hidden])')"), true, 'The hamburger carries the status badge');
  await navigate('chat', { mobileConversation: true, sessionId: 's2' });
  await waitFor("!!document.querySelector('.ms-conversation .ms-chat-back')"); await delay(500);
  assert.equal(await js("[...document.querySelectorAll('.ms-activity')].some(n => !n.hidden && n.getClientRects().length)"), false, 'No floating pill in a conversation');
  assert.equal(await js("!!document.querySelector('.ms-chat-back > .ms-avatar-badge:not([hidden])')"), true, 'Back carries the status badge');
  await js("document.querySelector('.ms-chat-back').click()"); await delay(600);
  await js("document.querySelector('.ms-avatar').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')"); await delay(350);
  assert.ok(await js("document.querySelectorAll('.ms-sheet-activity-row').length >= 1"), 'The tab sheet lists working and waiting items');
  const icons = await js("Object.fromEntries([...document.querySelectorAll('.ms-tab-tile')].map(n => [n.dataset.tab || n.textContent.trim(), n.querySelector('svg')?.innerHTML]))");
  const vals = Object.values(icons);
  assert.equal(new Set(vals).size, vals.length, 'Every tab tile has its own icon');
  await press('Escape', 'Escape', 27); await delay(350);
  await js("fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 's1' }) })"); await delay(500);
  demoState.liveHoldIds = [];
  await home();

  // ---- A1: running-work player and finished deck
  demoState.liveHoldIds = ['s1', 's2'];
  await live('s1'); await live('s2');
  await waitFor("!!document.querySelector('.ms-player')");
  await delay(300);
  assert.equal(await js("document.querySelectorAll('.ms-player').length"), 1, 'One player pill');
  assert.ok(await js("document.querySelector('.ms-player .ms-spinner') && /^\\d of \\d/.test([...document.querySelectorAll('.ms-player button')].find(b => b.dataset.focus === 'skip').textContent)"), 'Player shows a spinner and n of N with Skip');
  const above = (await rect('.ms-player')).b <= (await rect('.ms-composer')).y + 1;
  assert.ok(above, 'The player sits above the composer');
  assert.deepEqual(await small(), [], 'Player controls are at least 44px');
  const first = await js("document.querySelector('.ms-player-main').textContent");
  await js("document.querySelector('[data-focus=skip]').click()"); await delay(250);
  assert.notEqual(await js("document.querySelector('.ms-player-main').textContent"), first, 'Skip moves to the next item');
  await js("document.querySelector('.ms-player-main').click()"); await delay(300);
  assert.ok(await js("document.querySelectorAll('.ms-mini-row').length >= 2"), 'Tapping the player fans out mini-pills');
  await capture('shell-player-fan');
  await js("document.querySelector('.ms-player-main').click()"); await delay(200);
  // Needs-you items (agent questions, approvals) lead the player and cannot be stopped; walk on to a running chat.
  const total = Number(await js("document.querySelector('[data-focus=skip]').textContent.match(/of (\\d+)/)[1]"));
  for (let i = 0; i < total && !await js("[...document.querySelectorAll('.ms-player button')].some(b => b.textContent === 'Stop')"); i++) {
    await js("document.querySelector('[data-focus=skip]').click()"); await delay(200);
  }
  assert.ok(await js("[...document.querySelectorAll('.ms-player button')].some(b => b.textContent === 'Stop')"), 'A running chat offers Stop');
  const stops = writes.length;
  await js("[...document.querySelectorAll('.ms-player button')].find(b => b.textContent === 'Stop').click()");
  await delay(600);
  assert.ok(writes.slice(stops).some(w => w.path === '/api/chat/live/stop'), 'Stop uses the existing stop endpoint');
  await waitFor("!!document.querySelector('.ms-finished-card')");
  assert.ok(await js("document.querySelector('.ms-finished-card').textContent.includes('Stopped')"), 'A stopped turn lands in the finished deck');
  await capture('shell-finished-deck');
  const cards = await js("document.querySelectorAll('.ms-finished-card').length");
  await js("document.querySelector('.ms-finished-card').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))"); await delay(250);
  assert.equal(await js("document.querySelectorAll('.ms-finished-card').length"), cards - 1, 'Long press puts a finished card away');
  // Stop the second run so later checks start clean.
  await js("fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 's2' }) })"); await delay(500);
  await js("[...document.querySelectorAll('.ms-finished-deck button')].find(b => b.textContent === 'Clear all')?.click()"); await delay(250);
  demoState.liveHoldIds = [];

  // ---- A5: the same input morphs, dictation replaces the bottom row
  await home();
  await js("window.__composerNode = document.getElementById('chat-input')");
  await js("document.getElementById('chat-input').focus()"); await delay(500);
  assert.equal(await js("document.querySelector('.ms-composer').classList.contains('ms-composer-expanded') && document.getElementById('chat-input') === window.__composerNode"), true, 'The identical textarea survives the morph');
  assert.ok(await js("document.querySelector('.ms-composer-context').getBoundingClientRect().height > 20"), 'The context row appears while drafting');
  const field = await rect('#chat-input');
  assert.ok(field.h >= 63.5 && field.h <= 160.5, `Draft field is 64-160px (${field.h})`);
  await js("(() => { const t = document.getElementById('chat-input'); t.value = 'Draft stays'; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()"); await delay(450);
  assert.equal(await js("document.querySelector('.ms-composer').classList.contains('ms-composer-expanded')"), true, 'A draft keeps the card open after blur');
  await js("document.getElementById('chat-mic').classList.add('recording')"); await delay(500);
  assert.ok(await js("!document.querySelector('.ms-voice-row').hidden && [...document.querySelectorAll('.ms-voice-row button')].map(b => b.textContent).join() === 'Cancel,Done' && /^\\d:\\d\\d$/.test(document.querySelector('.ms-voice-timer').textContent) && document.querySelectorAll('.ms-voice-wave i').length > 4"), 'Dictation shows Cancel, a waveform with timer and Done');
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-composer .chat-input-bottom')).display"), 'none', 'The usual bottom row steps aside');
  assert.deepEqual(await small(), [], 'Dictation controls are at least 44px');
  await capture('shell-composer-dictation');
  await js("document.getElementById('chat-mic').classList.remove('recording')"); await delay(400);
  assert.equal(await js("document.querySelector('.ms-voice-row').hidden"), true);
  await js("(() => { const t = document.getElementById('chat-input'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()"); await delay(450);
  assert.equal(await js("document.querySelector('.ms-composer').classList.contains('ms-composer-expanded')"), false, 'Clearing the draft returns to the pill');
  assert.equal(await js("document.getElementById('chat-input') === window.__composerNode"), true);

  // ---- A8: reduced motion
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await delay(250);
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-page-track')).transitionDuration"), '0s', 'Pager does not animate');
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-switch-thumb')).transitionDuration"), '0s');
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-composer')).transitionDuration.split(',').every(d => d.trim() === '0s')"), true, 'The composer morph is instant');
  await js("document.getElementById('ms-tab-1').click()");
  assert.equal(await page(), 1, 'Reduced motion still switches pages');
  await swipe('.ms-history-list', 300, 700, 140); await delay(500);
  assert.equal(await page(), 0, 'A swipe switches without continuous dragging');
  await js("document.querySelector('.ms-avatar').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')");
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-tab-sheet')).animationName"), 'none', 'The sheet appears without sliding');
  await press('Escape', 'Escape', 27); await delay(250);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });

  // ---- A8: sizes and orientation
  for (const [w, h, name] of [[430, 932, 'large'], [320, 568, 'small'], [667, 375, 'landscape']]) {
    await resize(w, h);
    await home();
    assert.deepEqual(await overflow(), [], `${name} launch fits`);
    assert.deepEqual(await small(), [], `${name} launch targets are 44px`);
    const bar = await rect('.ms-composer');
    assert.ok(bar.b <= h && bar.x >= 0 && bar.r <= w, `${name} composer stays on screen`);
    assert.ok((await rect('.ms-avatar')).y >= 0 && (await rect('.ms-settings')).r <= w, `${name} header stays on screen`);
    await js("document.getElementById('ms-tab-1').click()"); await delay(400);
    assert.deepEqual(await overflow(), [], `${name} chats fit`);
    await capture(`shell-${name}-chats`);
    await js("document.getElementById('ms-tab-0').click()"); await delay(300);
    await capture(`shell-${name}-new`);
  }

  // ---- Desktop and the 768/769 breakpoint keep the old layout
  for (const [w, h, phone] of [[768, 1024, true], [769, 1024, false], [1440, 900, false]]) {
    await resize(w, h);
    await navigate('home'); await delay(500);
    assert.equal(await js("(() => { const s = document.querySelector('.ms-shell'); return !!s && !s.hidden && s.getClientRects().length > 0; })()"), phone, `${w}px ${phone ? 'shows' : 'does not show'} the launch surface`);
    assert.equal(await js("document.querySelector('.dashboard-header').getClientRects().length > 0"), !phone, `${w}px ${phone ? 'hides' : 'shows'} the overview`);
    if (!phone) assert.equal(await js("[...document.querySelectorAll('.ms-activity, .ms-tab-sheet[open]')].every(n => n.hidden || !n.getClientRects().length)"), true, 'No phone chrome on desktop');
  }
  await resize(1440, 900);
};
