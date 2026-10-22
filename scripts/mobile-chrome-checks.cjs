// Run through ui-smoke.cjs --mobile-chrome-only. Uses the isolated fixture API,
// real layout and native-like insets; no live chat/account is contacted.
const assert = require('node:assert/strict');
module.exports = async ({ js, win, waitFor, capture, delay, navigate, overflow }) => {
  const visibleBelow = async (selector, top, label) => {
    assert.equal(await js(`(() => {const n=document.querySelector(${JSON.stringify(selector)});
      if (!n) return false; const r=n.getBoundingClientRect();
      return r.width>0 && r.height>0 && r.top>=${top}-.5 && r.bottom<=innerHeight;})()`), true, label);
  };
  for (const [name, width, height, top, bottom, side] of [
    ['island-phone', 390, 844, 59, 34, 0], ['small-phone', 320, 568, 20, 16, 0],
    ['landscape', 667, 375, 0, 21, 44],
  ]) {
    win.setContentSize(width, height);
    await js(`['top','bottom','left','right'].forEach((s,i)=>document.documentElement.style.setProperty('--native-safe-'+s, [${top},${bottom},${side},${side}][i]+'px'))`);
    await delay(350);
    assert.equal(await js("document.querySelector('.ms-global-frost').getBoundingClientRect().top === 0 && getComputedStyle(document.querySelector('.ms-global-frost i')).backgroundColor === 'rgba(0, 0, 0, 0)'"), true, name + ' untinted frost begins at y=0');
    for (const tab of ['home', 'notes', 'library', 'calendar', 'tasks', 'agents']) {
      await navigate(tab); await delay(300);
      await visibleBelow('.ms-tabbar', top + 5, tab + ' tab bar sits on screen, clear of the status area');
      assert.equal(await js("getComputedStyle(document.getElementById('view-content')).scrollbarWidth"), 'none', tab + ' hides scrollbar');
      assert.deepEqual(await overflow(), [], name + ' ' + tab + ' fits');
    }
    await navigate('library');
    await waitFor("!!document.querySelector('.library-document-card')");
    await js("document.querySelector('.library-document-card').click()");
    await waitFor("!!document.querySelector('.library-editor')");
    await visibleBelow('.library-editor .view-header', top, name + ' document controls clear status area');
    await waitFor("document.querySelector('.ms-tabbar').dataset.state === 'shown'");
    assert.equal(await js("!document.getElementById('mobile-menu-btn') && !document.querySelector('.ms-tabbar').inert && [...document.querySelectorAll('.library-editor button')].some(b => b.textContent.includes('Back to Library') && b.getClientRects().length)"), true, 'The document editor keeps the tab bar and Back to Library');
    await capture(name + '-document-safe-area');
    await navigate('chat', { sessionId: 's1' });
    await waitFor("!!document.getElementById('chat-messages')");
    // A conversation's header is back, title and the actions capsule; the model pill moved into the composer.
    await visibleBelow('.ms-chat-back', top + 5, name + ' chat back clears status area');
    await visibleBelow('.ms-chat-heading', top + 5, name + ' chat title clears status area');
    await visibleBelow('.ms-chat-capsule', top + 5, name + ' chat actions clear status area');
    await js("document.getElementById('chat-input').focus()"); await delay(450);
    await visibleBelow('#model-picker-btn', 0, name + ' composer model pill is on screen');
    assert.equal(await js(`document.querySelector('.chat-input-bar').getBoundingClientRect().bottom <= innerHeight - ${bottom} + 1`), true, name + ' composer clears the home indicator inset');
    await js('document.activeElement.blur()');
    assert.equal(await js("getComputedStyle(document.getElementById('chat-messages')).scrollbarWidth"), 'thin', 'Chat retains its scrollbar');
    await capture(name + '-chat-safe-area');
    await js("import('/static/js/chatFilesPane.js').then(m=>m.openChatFiles('s1'))");
    await waitFor("!!document.querySelector('.chat-files-panel .artifact-header')");
    await delay(350);
    await visibleBelow('.chat-files-panel .artifact-header', top, name + ' files panel clears status area');
    await capture(name + '-files-safe-area');
    await js("import('/static/js/chatFilesPane.js').then(m=>m.closeChatFiles())");
    await js("import('/static/js/api.js').then(m=>{window.__closeInsetDialog=m.openPanelDialog({title:'Document details',body:m.el('div',{text:'Content'})});})");
    await delay(250);
    await visibleBelow('.panel-dialog .modal-header', top + 12, name + ' dialog title clears status area');
    await visibleBelow('.panel-dialog .modal-close-btn', top + 12, name + ' dialog close is reachable');
    await js('window.__closeInsetDialog.close()');
    await js("import('/static/js/app.js').then(m=>m.switchMode('forge'))");
    await waitFor("!!document.querySelector('.forge-home')");
    await visibleBelow('.forge-hero', top, name + ' Forge home clears status area');
    await navigate('forgeShell', { projectId: 'fp1', sessionId: 'fs1' });
    await waitFor("!!document.querySelector('.forge-session-header')");
    await delay(350);
    await visibleBelow('.forge-session-header', top + 68, name + ' Forge session clears menu and status area');
    assert.deepEqual(await overflow(), [], name + ' Forge fits');
    await capture(name + '-forge-safe-area');
    await js("import('/static/js/app.js').then(m=>m.switchMode('kairos'))");
  }
  await js("['top','bottom','left','right'].forEach(s=>document.documentElement.style.removeProperty('--native-safe-'+s))");
  // Hiding the scrollbar must not disable scrolling or hold a page below the scrim.
  await navigate('home'); await delay(300);
  assert.equal(await js("!document.querySelector('.ms-your-day')"), true, 'Dashboard has no Your day toggle');
  assert.equal(await js(`(() => {const v=document.getElementById('view-content');
    const spacer=document.createElement('div');spacer.style.cssText='height:1600px;flex:none';v.append(spacer);
    v.scrollTop=0;const heading=v.querySelector('.dashboard-header'), before=heading.getBoundingClientRect().top;
    v.scrollTop=180;const after=heading.getBoundingClientRect().top;
    const ok=v.scrollTop>0 && after<before;spacer.remove();v.scrollTop=0;return ok;})()`), true, 'Page still scrolls beneath the fixed scrim');
};
