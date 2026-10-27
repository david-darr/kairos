// g2 (A05): the stacked side panes in the real renderer. The real Background tasks pane (opened from its
// pill) and the real shared pane stack with a stand-in Design pane (the Design canvas itself belongs to A09 and
// design-canvas-checks.cjs): coexistence, vertical and horizontal resize with real mouse and keys, persistence,
// expand/close/reopen, narrow and short windows. Run with `ui-smoke.cjs --g2-only`.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, capture }) => {
  const mouse = (type, x, y, buttons = 1) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  const key = (selector, name) => js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`);
  const rect = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, hidden: n.hidden }; })()`);
  const now = Date.now() / 1000;
  const packet = items => `document.dispatchEvent(new CustomEvent('kairos:bg-tasks', { detail: { sessionId: 's1', items: ${JSON.stringify(items)}, notes: [] } })), true`;
  const items = [{ id: 't1', kind: 'command', label: 'npm test', status: 'running', startedAt: now - 30, activity: 'Running 40 tests' },
    { id: 't2', kind: 'agent', label: 'Research helper', status: 'waiting', startedAt: now - 90 }];

  win.setContentSize(1440, 900); await delay(350);
  await navigate('chat', { sessionId: 's1' });
  await waitFor("!!document.querySelector('#chat-messages[data-session-id=\"s1\"]') && !!document.querySelector('.chat-layout')");
  await js("localStorage.removeItem('kairos:chat-pane-split'); localStorage.removeItem('kairos:chat-pane-width'); true");
  await js(packet(items));
  await waitFor("!!document.querySelector('.bg-tasks-pill')?.getClientRects().length");
  const chatBefore = await rect('#chat-main');

  // 1. Background tasks opens its live pane beside the chat and lists the work.
  await js("document.querySelector('.bg-tasks-pill').click()");
  await waitFor("!!document.querySelector('.chat-pane-stack .chat-background-pane')");
  assert.equal(await js("document.querySelector('.bg-tasks-pill').getAttribute('aria-expanded')"), 'true');
  assert.deepEqual(await js("[...document.querySelectorAll('.chat-background-pane .bg-task-row')].map(r => r.dataset.itemId + ':' + r.dataset.status)"), ['t1:running', 't2:waiting'], 'the pane lists the live work');
  assert.match(await js("document.querySelector('.chat-background-count').textContent"), /2 running/, 'the header counts the live (running and waiting) work');
  const chatWithOne = await rect('#chat-main');
  assert.ok(chatWithOne.w < chatBefore.w - 150, 'the chat column gives room to the pane');
  // New work arriving while open updates in place.
  await js(packet([...items, { id: 't3', kind: 'command', label: 'build', status: 'running', startedAt: now - 5 }]));
  await waitFor("document.querySelectorAll('.chat-background-pane .bg-task-row').length === 3");
  assert.match(await js("document.querySelector('.chat-background-count').textContent"), /3 running/);

  // 2. A Design pane joins it; both stay visible in one stack.
  await js(`(async () => {
    const { mountChatPane } = await import('/static/js/chatPaneLayout.js');
    const root = document.createElement('section'); root.className = 'chat-design-pane'; root.setAttribute('aria-label', 'Design');
    const header = document.createElement('header'); header.className = 'chat-side-pane-header';
    const expand = document.createElement('button'); expand.type = 'button'; expand.textContent = '\\u26F6'; expand.setAttribute('aria-label', 'Expand design');
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '\\u00D7'; dismiss.setAttribute('aria-label', 'Close design');
    header.append('Design', expand, dismiss); root.append(header);
    const body = document.createElement('div'); body.style.cssText = 'min-height:120px;flex:1'; root.append(body);
    const host = document.querySelector('.chat-layout');
    window.__design = mountChatPane(host, root, () => { window.__design.dispose(); root.remove(); }, { kind: 'design' });
    expand.onclick = () => window.__design.setMaximized(!window.__design.isMaximized());
    dismiss.onclick = () => { window.__design.dispose(); root.remove(); };
    return true; })()`);
  await waitFor("document.querySelectorAll('.chat-pane-stack > .chat-stacked-pane').length === 2");
  assert.deepEqual(await js("[...document.querySelectorAll('.chat-pane-stack > .chat-stacked-pane')].map(p => p.dataset.paneKind)"), ['background', 'design'], 'both panes are in one stack');
  await delay(700);   // the shared root's slide-in settles
  const [bgBox, designBox] = [await rect('.chat-background-pane'), await rect('.chat-design-pane')];
  assert.ok(bgBox.h > 100 && designBox.h > 100, 'both panes have usable height');
  assert.ok(Math.abs(bgBox.l - designBox.l) < 2 && Math.abs(bgBox.w - designBox.w) < 2, 'the panes are stacked in one column ' + JSON.stringify([bgBox, designBox]));
  assert.equal(await js("!!document.querySelector('.chat-pane-stack-resizer')"), true, 'a divider sits between them');
  assert.equal(await js("document.querySelector('.chat-pane-stack-resizer').getAttribute('aria-valuenow')"), '62', 'default split');
  // The pane that was open keeps its live content while the second opens.
  assert.equal(await js("document.querySelectorAll('.chat-background-pane .bg-task-row').length"), 3);
  await capture('g2-panes-stacked');

  // 3. Resize between the stacked panes with a real drag, then with the keyboard; both persist.
  const handleBox = await rect('.chat-pane-stack-resizer');
  const total = bgBox.h + designBox.h;
  const x = handleBox.l + handleBox.w / 2, y = handleBox.t + handleBox.h / 2;
  await mouse('mouseMoved', x, y, 0); await mouse('mousePressed', x, y);
  await mouse('mouseMoved', x, y - 120); await mouse('mouseMoved', x, y - 150); await mouse('mouseReleased', x, y - 150, 0);
  await delay(150);
  const [bg2, design2] = [await rect('.chat-background-pane'), await rect('.chat-design-pane')];
  assert.ok(bg2.h < bgBox.h - 100 && design2.h > designBox.h + 100, `dragging up shrinks the upper pane and grows the lower (${Math.round(bgBox.h)} -> ${Math.round(bg2.h)})`);
  assert.ok(Math.abs((bg2.h + design2.h) - total) < 6, 'the two panes always share the same total height');
  const dragged = Number(await js("document.querySelector('.chat-pane-stack-resizer').getAttribute('aria-valuenow')"));
  assert.ok(dragged < 62 && dragged >= 20, 'the divider reports the new split: ' + dragged);
  const splitKey = await js("Object.keys(localStorage).find(k => k.startsWith('kairos:chat-pane-split'))");
  assert.equal(Math.round(Number(await js(`localStorage.getItem(${JSON.stringify(splitKey)})`))), dragged, 'the split is saved');
  await js("document.querySelector('.chat-pane-stack-resizer').focus()");
  await key('.chat-pane-stack-resizer', 'End');
  assert.equal(await js("document.querySelector('.chat-pane-stack-resizer').getAttribute('aria-valuenow')"), '80', 'End clamps at 80');
  await key('.chat-pane-stack-resizer', 'Home');
  assert.equal(await js("document.querySelector('.chat-pane-stack-resizer').getAttribute('aria-valuenow')"), '20', 'Home clamps at 20');
  const tiny = await rect('.chat-background-pane');
  assert.ok(tiny.h > 60, 'even at the minimum split the upper pane keeps its header reachable');
  await key('.chat-pane-stack-resizer', 'ArrowDown');
  assert.ok(Number(await js("document.querySelector('.chat-pane-stack-resizer').getAttribute('aria-valuenow')")) > 20, 'ArrowDown moves the divider');
  // Horizontal: the chat/pane divider moves with the mouse, is clamped, and is saved.
  const vbox = await rect('.chat-pane-resizer');
  const vx = vbox.l + vbox.w / 2, vy = vbox.t + vbox.h / 2;
  const chatW0 = (await rect('#chat-main')).w;
  await mouse('mouseMoved', vx, vy, 0); await mouse('mousePressed', vx, vy);
  await mouse('mouseMoved', vx + 120, vy); await mouse('mouseMoved', vx + 160, vy); await mouse('mouseReleased', vx + 160, vy, 0);
  await delay(150);
  const chatW1 = (await rect('#chat-main')).w;
  assert.ok(chatW1 > chatW0 + 100, `dragging right widens the chat column (${Math.round(chatW0)} -> ${Math.round(chatW1)})`);
  assert.ok(Number(await js("localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('kairos:chat-pane-width')))")) >= 380, 'the width is saved');
  await mouse('mouseMoved', vx + 160, vy, 0); const vb2 = await rect('.chat-pane-resizer');
  await mouse('mousePressed', vb2.l + vb2.w / 2, vy); await mouse('mouseMoved', vb2.l + 2000, vy); await mouse('mouseReleased', vb2.l + 2000, vy, 0);
  await delay(150);
  const narrowest = (await rect('.chat-background-pane')).w, chatMax = (await rect('#chat-main')).w;
  const hostW = await js("document.querySelector('.chat-layout').clientWidth");
  assert.ok(narrowest >= 320 && chatMax <= hostW * 0.7 + 2, `dragging far right stops at 70% of the chat area and leaves the pane at least ~330px (pane ${Math.round(narrowest)}, chat ${Math.round(chatMax)}, area ${hostW})`);
  // Restore a comfortable width for the rest.
  await js("localStorage.removeItem('kairos:chat-pane-width'); true");

  // 4. Expand one pane (the other hides and goes inert); Escape restores; close and reopen.
  await js("document.querySelector('[aria-label=\"Expand background tasks\"]').click()");
  assert.equal(await js("document.querySelector('.chat-design-pane').hidden && document.querySelector('.chat-design-pane').inert"), true, 'the other pane is hidden and inert while one is expanded');
  assert.equal(await js("document.querySelector('[aria-label=\"Restore background tasks\"], [aria-label=\"Expand background tasks\"]').title"), 'Restore background tasks');
  assert.ok((await rect('.chat-background-pane')).h > total - 20, 'the expanded pane fills the column');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await waitFor("!document.querySelector('.chat-design-pane').hidden");
  assert.equal(await js("document.querySelector('.chat-design-pane').inert"), false, 'Escape restores both panes');
  await js("document.querySelector('[aria-label=\"Close design\"]').click()");
  await waitFor("document.querySelectorAll('.chat-pane-stack > .chat-stacked-pane').length === 1");
  assert.equal(await js("!!document.querySelector('.chat-pane-stack-resizer')"), false, 'one pane needs no divider');
  assert.equal(await js("document.querySelectorAll('.chat-background-pane .bg-task-row').length"), 3, 'closing Design leaves the background list intact');
  await js("document.querySelector('[aria-label=\"Close background tasks\"]').click()");
  await waitFor("!document.querySelector('.chat-pane-stack')");
  assert.equal(await js("document.activeElement.classList.contains('bg-tasks-pill')"), true, 'closing returns focus to the pill');
  assert.equal(await js("document.querySelector('.bg-tasks-pill').getAttribute('aria-expanded')"), 'false');
  assert.ok(Math.abs((await rect('#chat-main')).w - chatBefore.w) < 4, 'the chat column returns to full width');
  await js("document.querySelector('.bg-tasks-pill').click()");
  await waitFor("!!document.querySelector('.chat-pane-stack .chat-background-pane')");
  assert.equal(await js("document.querySelectorAll('.chat-background-pane .bg-task-row').length"), 3, 'reopening shows the same work');

  // 5. Narrow window: Design and Background tasks close (they use the phone UI), controls stay reachable.
  await js(`(async () => { const { mountChatPane } = await import('/static/js/chatPaneLayout.js');
    const root = document.createElement('section'); root.className = 'chat-design-pane'; root.append('Design');
    window.__design = mountChatPane(document.querySelector('.chat-layout'), root, () => { window.__design.dispose(); root.remove(); }, { kind: 'design' }); return true; })()`);
  await waitFor("document.querySelectorAll('.chat-pane-stack > .chat-stacked-pane').length === 2");
  win.setContentSize(1000, 800); await delay(500);
  assert.equal(await js("!!document.querySelector('.chat-pane-stack')"), false, 'below 1100px the stacked Design/Background panes close');
  const pill = await rect('.bg-tasks-pill');
  assert.ok(pill && pill.l >= 0 && pill.r <= 1000 && pill.b <= 800, 'the pill stays reachable in a narrow window');
  assert.equal(await js("document.documentElement.scrollWidth <= innerWidth + 1"), true, 'no horizontal overflow when narrow');
  // 6. Short screen: the header controls of both panes stay inside the window.
  win.setContentSize(1440, 520); await delay(500);
  await js("document.querySelector('.bg-tasks-pill').click()");
  await waitFor("!!document.querySelector('.chat-pane-stack .chat-background-pane')");
  const closeBtn = await rect('[aria-label="Close background tasks"]'), expandBtn = await rect('[aria-label="Expand background tasks"]');
  for (const b of [closeBtn, expandBtn]) assert.ok(b && b.t >= 0 && b.b <= 520 && b.r <= 1440, 'pane controls are on screen on a short window');
  await js("document.querySelector('[aria-label=\"Close background tasks\"]').click()");
  await waitFor("!document.querySelector('.chat-pane-stack')");
  await js(packet([]));
  win.setContentSize(1440, 900); await delay(350);
};
