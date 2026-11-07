const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, capture, delay, navigate, writes, overflow }) => {
  const resize = async (width, height) => { win.setContentSize(width, height); await delay(300); };
  const key = (selector, options) => js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${JSON.stringify(options)} });
    input.dispatchEvent(event); return event.defaultPrevented;
  })()`);
  const setDraft = (selector, text) => js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.focus(); i.value = ${JSON.stringify(text)}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await navigate('notes'); await resize(390, 844);
  assert.ok(await js("document.getElementById('sidebar').inert && document.getElementById('sidebar').getAttribute('aria-hidden') === 'true'"), 'Old sidebar stays inaccessible on phone');
  await waitFor("!document.querySelector('.ms-menu-btn').hidden");
  // More lives in the sliding sidebar (mobileSidebar.js); its sheet returns focus to the menu button.
  const MORE = "document.querySelector('.ms-drawer-row[data-drawer=more]')";
  await js("document.querySelector('.ms-menu-btn').focus(); " + MORE + ".click()");
  assert.ok(await js("document.querySelector('.ms-tab-sheet[open]').contains(document.activeElement)"), 'More focuses its sheet');
  assert.equal(await js(MORE + ".getAttribute('aria-haspopup')"), 'dialog');
  assert.ok(await js(`(() => {
    const sheet = document.querySelector('.ms-tab-sheet[open]');
    const controls = [...sheet.querySelectorAll('button, a[href]')].filter(n => !n.disabled && n.getClientRects().length);
    controls.at(-1).focus(); sheet.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true}));
    const forward = document.activeElement === controls[0];
    sheet.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', shiftKey:true, bubbles:true, cancelable:true}));
    return forward && document.activeElement === controls.at(-1);
  })()`), 'Sheet traps Tab in both directions');
  await capture('mobile-workspace-focus');
  await key('.ms-tab-sheet', { key: 'Escape' });
  // The sheet slides away first (mobileSheet.js), then hands focus back.
  await waitFor("document.activeElement === document.querySelector('.ms-menu-btn')");
  await js(MORE + ".click(); document.querySelector('.ms-tab-sheet').click()");
  await waitFor("document.getElementById('sidebar').inert && document.activeElement === document.querySelector('.ms-menu-btn')");  // backdrop dismisses and returns focus
  await navigate('chat', { sessionId: 's1' });
  await waitFor("!!document.querySelector('.ms-conversation .chat-phone-tools')");
  await waitFor("document.querySelector('.ms-menu-btn').hidden");
  assert.ok(await js("!document.querySelector('.ms-avatar') && !!document.querySelector('.ms-chat-back')?.getClientRects().length"), 'Conversation keeps Back in place of the menu button');
  await js("document.querySelector('.chat-phone-tools > button').click()");
  assert.ok(await js("![...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].some(n => n.textContent === 'Your workspace')"), 'The conversation menu no longer opens the old workspace sheet');
  await js("document.querySelector('.chat-phone-tools > button').click()");
  await js("document.querySelector('.chat-phone-tools > button').click(); [...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].find(n => n.textContent.includes('Conversations and projects')).click()");
  assert.ok(await js("document.getElementById('chat-sessions').classList.contains('open') && document.getElementById('chat-sessions').contains(document.activeElement)"), 'History drawer keeps its focus behavior');
  await js("document.querySelector('.chat-history-close').click()");
  assert.ok(await js("document.activeElement === document.querySelector('.chat-phone-tools > button')"), 'Closing history restores tools focus');
  await resize(1440, 900);
  assert.ok(await js("!document.getElementById('sidebar').inert && !document.getElementById('sidebar').hasAttribute('aria-hidden')"), 'Desktop sidebar stays accessible');
  await resize(390, 844);

  const swipe = (selector, x, y, dx, dy = 0, cancel = false) => js(`(() => {
    document.activeElement?.blur(); window.getSelection()?.removeAllRanges();
    const target = document.querySelector(${JSON.stringify(selector)});
    const touch = (cx, cy) => new Touch({ identifier: 7, target, clientX: cx, clientY: cy });
    const dispatch = (type, touches) => { const e = new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: [touch(${x + dx}, ${y + dy})] }); target.dispatchEvent(e); return e.defaultPrevented; };
    dispatch('touchstart', [touch(${x}, ${y})]);
    const prevented = dispatch('touchmove', [touch(${x + dx}, ${y + dy})]);
    dispatch(${JSON.stringify(cancel ? 'touchcancel' : 'touchend')}, []);
    return prevented;
  })()`);
  // Since ae29cc9c a right swipe on a pushed page (this conversation) goes back first; mobile-sidebar-checks.cjs covers it.
  assert.equal(await swipe('#chat-messages', 40, 160, 120), true, 'A right swipe in a conversation goes back');
  await navigate('chat', { sessionId: 's1' });
  await waitFor("!!document.querySelector('.ms-conversation .chat-phone-tools')");
  assert.equal(await swipe('#chat-messages', 40, 160, 15, 90), false, 'Vertical scrolling stays native');
  assert.equal(await swipe('#chat-messages', 10, 160, 120), false, 'System back edge stays free');
  assert.ok(await js("!document.getElementById('sidebar').classList.contains('open') && !!document.querySelector('.ms-conversation')"), 'Swipes do not open sidebar or perform app Back');
  await swipe('#chat-messages', 40, 160, 120, 0, true);
  assert.ok(await js("!document.querySelector('.drawer-dragging') && !document.getElementById('mobile-backdrop').style.display"), 'Cancelled gesture leaves no preview');
  // A right swipe on the header now goes back like the rest of a pushed page (ae29cc9c); history opens from the tools menu.
  await js("document.querySelector('.chat-phone-tools > button').click(); [...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].find(n => n.textContent.includes('Conversations and projects')).click()");
  assert.ok(await js("document.getElementById('chat-sessions').classList.contains('open') && document.getElementById('sidebar').inert"), 'History opens alone');
  await capture('mobile-swipe-history');
  await swipe('.mobile-drawer-heading', 160, 120, -130);
  assert.ok(await js("document.getElementById('chat-sessions').inert && document.activeElement === document.querySelector('.chat-phone-tools > button')"), 'History swipe dismissal restores focus to the tools capsule');
  assert.equal(await swipe('#chat-input', 40, 650, 120), false, 'Editing never starts a drawer');
  await js("document.querySelector('.chat-phone-tools > button').click()");
  assert.ok(await js("document.querySelector('.chat-phone-tools > button').getAttribute('aria-expanded') === 'true' && [...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].some(n => n.textContent.includes('Files'))"), 'Phone chat tools remain accessible');
  await capture('mobile-chat-tools');
  await js("document.getElementById('chat-messages').click()");
  await resize(1440, 900);
  assert.equal(await swipe('#chat-messages', 40, 160, 120), false, 'Desktop ignores touch drawer gestures');

  for (const [width, height, name] of [[320, 568, 'small-phone'], [390, 844, 'phone'], [768, 1024, 'tablet'], [667, 375, 'landscape'], [1440, 900, 'desktop']]) {
    await resize(width, height);
    await navigate('chat', { sessionId: 's1' });
    await waitFor("!!document.querySelector('.msg')");
    // The phone composer rests as a pill with Send tucked away; focusing it expands the card the way a tap does.
    if (width <= 768) { await js("document.getElementById('chat-input').focus()"); await delay(450); }
    assert.deepEqual(await overflow(), [], name + ' no horizontal overflow');
    assert.ok(await js("(() => { const r = document.getElementById('chat-send').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), name + ' Send stays in the viewport');
    if (width <= 768) {
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('#chat-history-toggle, .ms-chat-back, .chat-phone-tools > button, .ms-chat-capsule button, #chat-send, #chat-mic, #chat-openmic, #overflow-plus-btn, .chat-summary-trigger, .chat-header-model #model-picker-btn')).filter(n => !n.hidden && n.getClientRects().length).filter(n => { const r=n.getBoundingClientRect(); return r.width < 43.99 || r.height < 43.99; }).map(n => ({id:n.id, width:n.getBoundingClientRect().width, height:n.getBoundingClientRect().height}))`), [], name + ' touch actions have 44px targets (allowing subpixel rounding)');
      assert.ok(await js("document.querySelector('.composer-hint').textContent.includes('Return for a new line')"));
    } else assert.ok(await js("document.querySelector('.composer-hint').textContent.includes('Enter to send')"));
    await capture('mobile-pass-' + name);
  }

  const initialWrites = writes.length;
  await setDraft('#chat-input', 'An unfinished composition');
  assert.equal(await key('#chat-input', { key: 'Enter', isComposing: true }), false);
  assert.equal(await key('#chat-input', { key: 'Enter', keyCode: 229 }), false);
  assert.equal(await key('#chat-input', { key: 'Enter', shiftKey: true }), false);
  assert.equal(writes.length, initialWrites, 'Desktop composition and Shift+Enter never send');
  // An open suggestion picker must leave composition-confirming Enter alone.
  await setDraft('#chat-input', 'Review @');
  await waitFor("document.querySelectorAll('#chat-main .chat-reference-option').length > 0");
  assert.equal(await key('#chat-input', { key: 'Enter', isComposing: true }), false);
  assert.equal(await key('#chat-input', { key: 'Enter', keyCode: 229 }), false);
  assert.equal(await js("document.getElementById('chat-input').value"), 'Review @');
  await key('#chat-input', { key: 'Escape' });
  await setDraft('#chat-input', '/he');
  assert.equal(await key('#chat-input', { key: 'Enter', keyCode: 229 }), false);
  assert.equal(await js("document.getElementById('chat-input').value"), '/he');
  await setDraft('#chat-input', 'Desktop keyboard send');
  assert.equal(await key('#chat-input', { key: 'Enter' }), true);
  await waitFor("document.getElementById('chat-send').dataset.mode === 'send'");
  assert.ok(writes.some(w => w.path === '/api/chat/live' && JSON.parse(w.body).message === 'Desktop keyboard send'), 'Desktop Enter sends through the existing API');

  await resize(390, 844);
  await setDraft('#chat-input', 'First line');
  const beforePhoneReturn = writes.length;
  // Native Chromium input verifies that leaving Enter unhandled inserts a newline.
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await js("document.getElementById('chat-input').value"), 'First line\n');
  assert.equal(writes.length, beforePhoneReturn, 'Phone Return inserts a line without sending');
  await js("document.getElementById('chat-send').click()");
  await waitFor("document.getElementById('chat-send').dataset.mode === 'send'");
  assert.ok(writes.some(w => w.path === '/api/chat/live' && JSON.parse(w.body).message === 'First line'), 'Phone Send submits');

  // Test the shared policy on the side and embedded chat surfaces as mounted.
  await resize(1440, 900);
  await js("import('/static/js/sideChat.js').then(m => m.openSideChat('s2'))");
  await waitFor("!!document.querySelector('.side-chat .side-chat-input')");
  await setDraft('.side-chat .side-chat-input', 'Side draft');
  assert.equal(await key('.side-chat .side-chat-input', { key: 'Enter', isComposing: true }), false);
  assert.equal(await key('.side-chat .side-chat-input', { key: 'Enter', keyCode: 229 }), false);
  await js("import('/static/js/sideChat.js').then(m => m.closeSideChat())");
  await js("(async () => { const host=document.createElement('div'); host.id='mobile-embedded-check'; document.body.append(host); window.releaseMobileChat=await import('/static/js/sessionChat.js').then(m => m.mountSessionChat(host, {sessionId:'s2'})); })()");
  const embedded = '#mobile-embedded-check .side-chat-input';
  await setDraft(embedded, 'Embedded draft');
  assert.equal(await key(embedded, { key: 'Enter', isComposing: true }), false);
  assert.equal(await key(embedded, { key: 'Enter', keyCode: 229 }), false);
  await resize(390, 844);
  assert.equal(await key(embedded, { key: 'Enter' }), false, 'Embedded phone Return does not send');
  await js("window.releaseMobileChat(); delete window.releaseMobileChat; document.getElementById('mobile-embedded-check').remove()");
};
