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
    await navigate('chat', { mobilePage: pageIndex });
    await waitFor("!!document.querySelector('.ms-shell') && !document.querySelector('.ms-shell').hidden");
    await delay(500);
  };

  // ---- A1: the launch surface
  await resize(390, 844);
  await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'default', redesign: true }))");
  await home();
  assert.deepEqual(await overflow(), [], 'Launch surface has no overflow');
  assert.equal(await js("document.querySelector('.ms-shell h1').textContent"), 'Chats');
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-header-row > *')].map(n => n.tagName === 'H1' ? 'h1' : n.className.split(' ')[0])"), ['h1', 'rd-chat-header-actions'], 'The header row holds the Chats title and chat actions');
  // Both tapping and keyboard activation reach history through the two-action header.
  await js("document.querySelector('.ms-header-row button[aria-label=\"Chat actions\"]').click()");
  await waitFor("!!document.querySelector('dialog[aria-label=\"Chat actions\"]')");
  await js("[...document.querySelectorAll('dialog[aria-label=\"Chat actions\"] button')].find(n => n.textContent === 'Search and filter chats').click()");
  assert.equal(await page(), 1, 'Tapping Search and filter chats opens history');
  assert.ok(await js("document.activeElement.matches('.ms-history-search input[type=search]')"), 'History search receives focus');
  await js("document.getElementById('ms-tab-0').click(); document.querySelector('.ms-header-row button[aria-label=\"Chat actions\"]').focus()");
  await press('Enter', 'Enter', 13);
  await waitFor("!!document.querySelector('dialog[aria-label=\"Chat actions\"]')");
  await js("[...document.querySelectorAll('dialog[aria-label=\"Chat actions\"] button')].find(n => n.textContent === 'Search and filter chats').focus()");
  await press('Enter', 'Enter', 13);
  assert.equal(await page(), 1, 'Keyboard activation opens history');
  assert.ok(await js("document.activeElement.matches('.ms-history-search input[type=search]')"), 'Keyboard history access focuses search');
  await js("document.getElementById('ms-tab-0').click(); document.activeElement?.blur()");
  await delay(450);
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-header-row ~ .ms-switch .ms-segment')].map(n => n.textContent)"), ['New', 'Chats'], 'The original New/Chats switch follows the title row');
  assert.equal(await js("document.querySelector('.ms-intro h2').textContent"), 'What should we work on?', 'The idle prompt remains an h2 below the header');
  assert.equal(Math.round((await rect('.ms-intro kairos-mascot')).w), 120, 'Centered Kip is 120px, as on ChatsIdle');
  const launchButtons = await js(`[...document.querySelectorAll('.ms-shell .ms-header-row button')].filter(n => n.getClientRects().length).map(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, radius: getComputedStyle(n).borderRadius }; })`);
  assert.equal(launchButtons.length, 2, 'The launch header has New chat and Chat actions');
  assert.ok(launchButtons.every(b => Math.round(b.width) === 46 && Math.round(b.height) === 46), 'Both launch header actions are 46px');
  for (const b of launchButtons) assert.ok(b.width >= 44 && b.height >= 44 && b.left >= 0 && b.right <= 390 && b.top >= 0 && b.bottom <= 844 && parseFloat(b.radius) >= b.height / 2, 'Header actions are round, touch sized and on screen: ' + JSON.stringify(b));
  assert.ok(await js("document.querySelector('.ms-background')?.getClientRects().length > 0"), 'The backdrop runs full bleed behind the launch surface');
  assert.equal(await js("!document.getElementById('mobile-menu-btn') && !document.querySelector('.ms-avatar')"), true, 'No avatar and no hamburger: the sliding sidebar navigates');
  await waitFor("!document.querySelector('.ms-menu-btn').hidden");
  assert.equal(await js("document.getElementById('chat-input').placeholder"), 'Ask anything…');
  const rest = await rect('.ms-composer');
  assert.ok(rest.h >= 100 && rest.h <= 140, `Idle composer rests as ChatsIdle's two-row card (${rest.h}px)`);
  assert.ok(rest.b <= 844 - 12 + 1, 'Composer clears the bottom edge ' + JSON.stringify(rest));
  assert.deepEqual(await small(), [], 'Launch controls are at least 44px');
  assert.equal(await js("getComputedStyle(document.querySelector('.ms-header .ms-blur-top i')).backdropFilter.includes('blur')"), true, 'The header has a gradual edge blur');
  assert.equal(await js("document.querySelectorAll('.ms-header .ms-blur-top i').length"), 6, 'Edge blur is built from six layers');
  await capture('shell-new-idle');

  assert.equal((await rect('.ms-global-frost')).y, 0, 'Frost starts at screen y=0');
  assert.equal(await js("!!document.querySelector('.ms-your-day')"), false, 'No Your day button');
  const centered = async () => {
    const m = await js(`(() => {
    const bar = document.querySelector('.ms-composer'), input = bar.querySelector('textarea');
    const r = n => n.getBoundingClientRect(), cy = n => { const b = r(n); return (b.top + b.bottom) / 2; };
    const controls = ['#overflow-plus-btn', '#chat-mic'].map(s => bar.querySelector(s));
    const row = cy(controls[0]);
    return { gaps: controls.map(n => cy(n) - row), inputAbove: r(input).bottom <= r(controls[0]).top + 1, lineHeight: getComputedStyle(input).lineHeight };
  })()`);
    // ChatsIdle: the text line sits on top, and the controls share one centred row beneath it.
    assert.ok(m.gaps.every(g => Math.abs(g) <= 1) && m.inputAbove && m.lineHeight === '24px', 'Resting composer: text line above, controls centered on one row within 1px: ' + JSON.stringify(m));
  };
  await centered();

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
  assert.equal(await page(), 0, 'A right swipe in the former drawer zone returns to New');
  assert.equal(await js("document.getElementById('sidebar').classList.contains('open') || document.documentElement.classList.contains('ms-drawer-open')"), false, 'A swipe back a page opens neither sidebar');
  await js("document.getElementById('ms-tab-1').click()"); await delay(300);

  // ---- A2: history
  const ids = await js("[...document.querySelectorAll('.ms-history-row')].map(n => n.dataset.sessionId)");
  // A full ui-smoke run leaves extra, newer Forge sessions (fs2, fs3...) ahead of the fixtures.
  assert.deepEqual(ids.slice(-4), ['fs1', 's1', 's2', 's3'], 'History is newest first, Forge sessions included');
  assert.ok(ids.slice(0, -4).every(id => id.startsWith("fs")), 'Only newer Forge sessions precede the fixtures: ' + ids);
  assert.equal(await js("document.querySelector('.ms-history-row[data-session-id=fs1] small').textContent.startsWith('Forge')"), true, 'Forge rows are labelled');
  assert.equal(await js("document.querySelectorAll('.ms-history-main strong').length"), ids.length);
  assert.ok(await js("[...document.querySelectorAll('.ms-history-age')].every(n => /^(Now|\\d+[mhd]|Working)$/.test(n.textContent))"), 'Rows show an age or Working');
  assert.deepEqual(await small(), [], 'History controls are at least 44px');
  await js("(() => { const s = document.querySelector('.ms-history-search input'); s.focus(); s.value = 'week'; s.dispatchEvent(new Event('input')); })()");
  await delay(120); assert.equal(await js("document.querySelectorAll('.ms-history-row').length"), ids.length, 'Search is debounced');
  await waitFor("document.querySelectorAll('.ms-history-row').length === 1");
  assert.equal(await js("document.querySelector('.ms-history-main strong').textContent"), 'Planning the week ahead');
  await js("(() => { const s = document.querySelector('.ms-history-search input'); s.value = 'zzzz'; s.dispatchEvent(new Event('input')); })()");
  const noMatchingChats = "document.querySelector('.ms-history-list [role=status] h2')?.textContent === 'No matching chats' && document.querySelector('.ms-history-list [role=status] p')?.textContent === 'Try another search or filter.' && document.querySelectorAll('.ms-history-row').length === 0";
  await waitFor(noMatchingChats);
  await capture('shell-chats-no-match');
  await js("(() => { const s = document.querySelector('.ms-history-search input'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === " + ids.length);
  assert.ok(await js("document.querySelectorAll('.ms-history-search').length === 1 && !document.querySelector('.ms-dock, .ms-history-dock') && getComputedStyle(document.querySelector('.ms-history-search')).position !== 'fixed'"), 'Chats has one in-page search and no bottom dock');
  assert.ok(await js("(() => { const p = document.querySelector('.ms-history-search'), i = getComputedStyle(p.querySelector('input')), r = p.getBoundingClientRect(); return p === p.parentElement.firstElementChild && r.height >= 52 && parseFloat(getComputedStyle(p).borderRadius) >= 26 && !!p.querySelector('svg') && i.backgroundColor === 'rgba(0, 0, 0, 0)' && i.borderTopWidth === '0px'; })()"), 'Chats search is the first page row, a single-surface pill with magnifier');
  // Filter popup
  await js("document.querySelector('.ms-history-search > button').click()"); await delay(250);
  assert.equal(await js("!document.querySelector('.ms-history-filters').hidden && document.querySelector('.ms-history-search > button').getAttribute('aria-expanded')"), 'true');
  await js("(() => { const f = document.querySelector('.ms-history-filters select'); f.value = 'working'; f.dispatchEvent(new Event('change')); })()");
  await waitFor(noMatchingChats);
  await js("(() => { const f = document.querySelector('.ms-history-filters select'); f.value = 'all'; f.dispatchEvent(new Event('change')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === " + ids.length);
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
  assert.equal(await js("document.querySelectorAll('.ms-history-row').length"), ids.length);
  // Long press
  await js("document.querySelector('.ms-history-list').dispatchEvent(new Event('scroll'))");
  await js(`(() => { const n = document.querySelector('.ms-history-row[data-session-id=s3] .ms-history-main'); n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100, pointerId: 3 })); })()`);
  await delay(650);
  assert.equal(await js("document.querySelector('.ms-history-row[data-session-id=s3]').classList.contains('ms-actions-open')"), true, 'A long press reveals the same actions');
  await js("document.querySelector('.ms-history-list').dispatchEvent(new Event('scroll'))");

  // ---- A2: a conversation pushes in and back keeps the list
  await js("(() => { const s = document.querySelector('.ms-history-search input'); s.value = 'clearer'; s.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === 1");
  await js("document.querySelector('.ms-history-row[data-session-id=s1] .ms-history-main').click()");
  await waitFor("!!document.querySelector('.ms-conversation .msg')");
  await delay(450);
  assert.deepEqual(await overflow(), [], 'Conversation has no overflow');
  assert.equal(await js("document.querySelector('.ms-chat-heading strong').textContent"), 'A clearer direction for the workspace');
  // Conversation board: the subtitle reads "<model> · <workspace>".
  assert.match(await js("document.querySelector('.ms-chat-heading small').textContent"), /^.+ · Workspace design$/, 'The heading names the model and the real project');
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
  assert.ok(convoRest.h <= 64, `Conversation composer rests as a pill (${convoRest.h}px)`);
  await js("document.getElementById('chat-input').focus()"); await delay(500);
  assert.equal(await js("document.querySelector('.chat-input-bar').classList.contains('ms-composer-expanded')"), true, 'Focus expands the composer');
  // Conversation board: the one-row pill stays one row while drafting; field, model and Send all stay inside it.
  assert.equal(await js(`(() => { const bar = document.querySelector('.chat-input-bar').getBoundingClientRect(); return ['#chat-input', '.chat-header-model', '#chat-send'].every(s => { const n = document.querySelector('.chat-input-bar ' + s); const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= bar.left - 1 && r.right <= bar.right + 1 && r.top >= bar.top - 1 && r.bottom <= bar.bottom + 1; }); })()`), true, 'The expanded pill keeps the field, model and Send inside it');
  assert.equal(await js("getComputedStyle(document.getElementById('chat-send')).display !== 'none' && document.getElementById('chat-send').getBoundingClientRect().height >= 44"), true, 'Send appears when drafting');
  assert.equal(await js(`(() => { const controls = ['#overflow-plus-btn', '.chat-input-bar .model-picker-btn', '#chat-send'].map(s => document.querySelector(s)); const centers = controls.map(n => { const r = n.getBoundingClientRect(); return (r.top + r.bottom) / 2; }); return Math.max(...centers) - Math.min(...centers) <= 1; })()`), true, 'Expanded chat controls (plus, model, send; dictation lives in the plus menu) centered within 1px');
  await capture('shell-conversation-drafting');
  await js("document.activeElement.blur()");
  // Back keeps the retained search
  await js("document.querySelector('.ms-chat-back').click()");
  // The launch composer's chat host is also an .ms-conversation; only a pushed conversation must be gone.
  await waitFor("!!document.querySelector('.ms-shell') && !document.querySelector('.ms-conversation:not(.ms-launch-chat)')");
  await delay(500);
  assert.equal(await page(), 1, 'Back returns to Chats');
  assert.equal(await js("document.querySelector('.ms-history-search input').value"), 'clearer', 'The search survives the round trip');
  assert.equal(await js("document.querySelectorAll('.ms-history-row').length"), 1);
  await js("(() => { const s = document.querySelector('.ms-history-search input'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelectorAll('.ms-history-row').length === " + ids.length);

  // ---- A3: the More sheet (opened from the sidebar's More)
  await js("document.getElementById('ms-tab-0').click()"); await delay(400);
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').focus(); document.querySelector('.ms-drawer-row[data-drawer=more]').click()");
  await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')");
  await delay(400);
  const inSidebar = ['home', 'chat', 'design', 'designs'];
  const navTabs = (await js("[...document.querySelectorAll('#nav .nav-item')].map(n => n.dataset.tab)")).filter(t => !inSidebar.includes(t));
  const tiles = await js("[...document.querySelectorAll('.ms-tab-sheet .ms-tab-tile')].map(n => n.dataset.tab || n.textContent.trim())");
  assert.deepEqual(tiles, navTabs, 'Tiles follow the sidebar order, less Home and Chats');
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-tab-grid')].map(n => getComputedStyle(n).gridTemplateColumns.split(' ').length)"), [4, 4], 'Workspace and Intelligence each use the MoreSheet board\'s four columns');
  assert.equal(await js("document.querySelector('.ms-tab-sheet').getAttribute('aria-modal')"), 'true');
  // Agents became the Bots mode: neither sidebar carries an Agents item or badge.
  assert.equal(await js("!!document.querySelector('.ms-drawer-row[data-drawer=agents]') || !!document.querySelector('#nav .nav-item[data-tab=agents]')"), false, 'There is no Agents row in either sidebar');
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
  assert.equal(await js("document.activeElement === document.querySelector('.ms-menu-btn')"), true, 'Focus returns to the menu button');
  // Backdrop and downward swipe
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')");
  await js("document.querySelector('.ms-tab-sheet').click()"); await delay(350);
  assert.equal(await js("!document.querySelector('.ms-tab-sheet[open]')"), true, 'Backdrop taps close the sheet');
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')"); await delay(350);
  // The sheet closes when its slide-out ends (320ms, 360ms fallback); a fixed 350ms pause raced that under load.
  await swipe('.ms-sheet-heading', 200, 300, 0, 110);
  await waitFor("!document.querySelector('.ms-tab-sheet[open]')", 1500).catch(() => {});
  assert.equal(await js("!document.querySelector('.ms-tab-sheet[open]')"), true, 'A downward swipe closes the sheet');
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').click()");
  await waitFor("document.querySelector('.ms-tab-sheet[open]')");
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-tab-group .ms-group-label')].map(n => n.textContent)"), ['Workspace', 'Intelligence'], 'Sheet has the saved sidebar groups (the top group is all in the sidebar)');
  await js("document.querySelector('.ms-tab-sheet').click()"); await delay(350);
  await js("document.querySelector('.ms-drawer-row[data-drawer=home]').click()"); await delay(450);
  // Mobile v2 HomeFull/HomeClear puts Customize below the page content.
  assert.equal(await js("!!document.querySelector('.hm-week') && !document.querySelector('.dashboard-hero, .ms-shell') && document.querySelector('.hm-phone-customize').getClientRects().length > 0"), true, 'Home in the sidebar opens dashboard and Customize');
  await js("document.querySelector('.hm-phone-customize').click()");
  await waitFor("!!document.querySelector('.hm-sheet[aria-label=\"Customize Home\"] .hm-sheet-row')");
  await js("document.querySelector('.hm-sheet-top button').click()");
  await waitFor("!document.querySelector('.hm-sheet-root')");
  assert.ok(await js("document.activeElement === document.querySelector('.hm-phone-customize')"), 'Customize returns focus to the phone opener');
  await home();
  // Tiles navigate
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')"); await delay(350);
  await js("document.querySelector('.ms-tab-tile[data-tab=notes]').click()");
  await waitFor("document.documentElement.dataset.view === 'notes'");
  assert.equal(await js("!document.querySelector('.ms-tab-sheet[open]')"), true);
  await waitFor("document.querySelector('.ms-drawer-row[aria-current=page]')?.dataset.drawer === 'more' && !document.querySelector('.ms-menu-btn').hidden");
  assert.ok(true, 'Other tabs keep the menu button, with More current in the sidebar');
  await home();

  // A custom tab follows its saved group/order and hidden tabs stay out.
  await js("import('/static/js/layout.js').then(m => { window.__phoneLayout = m.getLayout(); const next = m.getLayout(); for (const ids of Object.values(next.groups)) { const at = ids.indexOf('school'); if (at >= 0) ids.splice(at, 1); } next.groups.workspace.unshift('school'); next.hiddenTabs.push('cookbook'); m.saveLayout(next); })");
  await waitFor("!!document.querySelector('#nav [data-tab=school]') && !document.querySelector('#nav [data-tab=cookbook]')");
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').click()"); await waitFor("document.querySelector('.ms-tab-sheet[open]')");
  assert.equal(await js("document.querySelector('.ms-tab-group[data-group=workspace] .ms-tab-tile').dataset.tab"), 'school', 'Custom tab is first in its saved group');
  assert.equal(await js("!!document.querySelector('.ms-tab-sheet [data-tab=cookbook]')"), false, 'Hidden tabs stay out');
  await js("document.querySelector('.ms-tab-sheet').click(); import('/static/js/layout.js').then(m => { m.saveLayout(window.__phoneLayout); delete window.__phoneLayout; })");
  await waitFor("!!document.querySelector('#nav [data-tab=cookbook]')");

  // ---- Status never floats: badges on the entry controls and rows in the tab sheet
  demoState.liveHoldIds = ['s1'];
  await live('s1'); await delay(800);
  await navigate('notes'); await delay(600);
  assert.equal(await js("[...document.querySelectorAll('.ms-activity')].some(n => !n.hidden && n.getClientRects().length)"), false, 'No floating updates pill on other tabs');
  await waitFor("!!document.querySelector('.ms-drawer-row[data-drawer=home] > .ms-drawer-badge:not([hidden])')");
  assert.match(await js("document.querySelector('.ms-drawer-row[data-drawer=home]').getAttribute('aria-label')"), /^Home, \d+ (need you|working)$/, 'Home in the sidebar carries the status badge and says it');
  await navigate('chat', { mobileConversation: true, sessionId: 's2' });
  await waitFor("!!document.querySelector('.ms-conversation .ms-chat-back')"); await delay(500);
  assert.equal(await js("[...document.querySelectorAll('.ms-activity')].some(n => !n.hidden && n.getClientRects().length)"), false, 'No floating pill in a conversation');
  assert.equal(await js("!!document.querySelector('.ms-chat-back > .ms-avatar-badge:not([hidden])')"), true, 'Back carries the status badge');
  await js("document.querySelector('.ms-chat-back').click()"); await delay(600);
  await waitFor("!document.querySelector('.ms-menu-btn').hidden");
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')"); await delay(350);
  assert.ok(await js("document.querySelectorAll('.ms-sheet-activity-row').length >= 1"), 'The More sheet lists working and waiting items');
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
  // Any card, not the first: a second run's card can land ahead of the stopped one.
  const stoppedCard = "[...document.querySelectorAll('.ms-finished-card')].some(c => c.textContent.includes('Stopped'))";
  try { await waitFor(stoppedCard, 5000); } catch { /* the assert below names the failure */ }
  assert.ok(await js(stoppedCard), 'A stopped turn lands in the finished deck');
  await capture('shell-finished-deck');
  // Count once the deck has stopped changing (a second run's card can still be landing).
  let cards = -1;
  for (let i = 0; i < 20; i++) { const now = await js("document.querySelectorAll('.ms-finished-card').length"); if (now === cards) break; cards = now; await delay(150); }
  await js("document.querySelector('.ms-finished-card').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))");
  try { await waitFor(`document.querySelectorAll('.ms-finished-card').length === ${cards - 1}`, 3000); } catch { /* the assert below names the count */ }
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
  // ChatsIdle has no context row: the workspace pill in the controls row carries the workspace.
  assert.ok(await js("document.querySelector('.ms-composer-context').getBoundingClientRect().height === 0 && document.getElementById('workspace-pill-slot') !== null"), 'The separate context row stays out of the board card');
  const field = await rect('#chat-input');
  assert.ok(field.h >= 43.5 && field.h <= 160.5, `Draft field is 44-160px (${field.h})`);
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
  await js("document.querySelector('.ms-drawer-row[data-drawer=more]').click()"); await waitFor("document.querySelector('dialog.ms-tab-sheet[open]')");
  const moreMotion = await js(`(() => {
    const node = document.querySelector('.ms-tab-sheet'), style = getComputedStyle(node);
    return { name: style.animationName, duration: style.animationDuration, transform: style.transform, transition: style.transitionDuration,
      frames: node.getAnimations().filter(a => a.effect?.target === node).flatMap(a => a.effect.getKeyframes()).map(f => ({ transform: f.transform || 'none', opacity: f.opacity })) };
  })()`);
  assert.equal(moreMotion.name, 'rd-opacity', 'Reduced motion uses the shared sheet fade');
  assert.equal(moreMotion.duration, '0.12s', 'More fades for 120ms under reduced motion');
  assert.deepEqual(moreMotion.frames.map(f => f.opacity), ['0', '1'], 'More animates opacity only');
  assert.ok(moreMotion.transform === 'none' && /^0s(, 0s)*$/.test(moreMotion.transition) && moreMotion.frames.length >= 2 && moreMotion.frames.every(f => f.transform === 'none'), 'More appears without sliding: ' + JSON.stringify(moreMotion));
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
    assert.ok((await rect('.ms-header .ms-switch')).y >= 0 && (await rect('.ms-header .ms-switch')).r <= w, `${name} header stays on screen`);
    assert.ok(bar.b <= h - 12 + 1, `${name} composer clears the bottom edge: ${JSON.stringify(bar)}`);
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
    assert.equal(await js("(() => { const s = document.querySelector('.ms-shell'); return !!s && !s.hidden && s.getClientRects().length > 0; })()"), false, `${w}px Home keeps the dashboard`);
    assert.equal(await js("document.querySelector('.hm-heading, .dashboard-header').getClientRects().length > 0"), true, `${w}px shows the dashboard overview`);
    if (!phone) assert.equal(await js("[...document.querySelectorAll('.ms-activity, .ms-tab-sheet[open], .ms-drawer, .ms-menu-btn')].every(n => n.hidden || !n.getClientRects().length)"), true, 'No phone chrome (sidebar and menu button included) on desktop');
  }
  await resize(1440, 900);
};
