// Run through ui-smoke.cjs --mobile-chrome-only. Uses the isolated fixture API,
// real layout and native-like insets; no live chat/account is contacted.
const assert = require('node:assert/strict');
module.exports = async ({ js, win, waitFor, capture, delay, navigate, overflow }) => {
  const visibleBelow = async (selector, top, label) => {
    assert.equal(await js(`(() => {const n=document.querySelector(${JSON.stringify(selector)});
      if (!n) return false; const r=n.getBoundingClientRect();
      return r.width>0 && r.height>0 && r.top>=${top}-.5 && r.bottom<=innerHeight;})()`), true, label);
  };
  const forgeControl = async (selector, top, side, label) => {
    await visibleBelow(selector, top, label);
    assert.equal(await js(`(() => {const n=document.querySelector(${JSON.stringify(selector)}), r=n.getBoundingClientRect();
      return !n.closest('[hidden],[inert]') && getComputedStyle(n).visibility==='visible' &&
        r.left>=${side}-.5 && r.right<=innerWidth-${side}+.5;})()`), true, label + ' also clears side insets');
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
    await navigate('library', { section: 'documents' });
    await waitFor("!!document.querySelector('.library-document-card')");
    await js("document.querySelector('.library-document-card').click()");
    await waitFor("!!document.querySelector('.library-editor')");
    await visibleBelow('.library-editor .view-header', top, name + ' document controls clear status area');
    await waitFor("document.querySelector('.ms-tabbar').dataset.state === 'shown'");
    assert.equal(await js("!document.getElementById('mobile-menu-btn') && !document.querySelector('.ms-tabbar').inert && [...document.querySelectorAll('.library-editor button')].some(b => b.getAttribute('aria-label') === 'Back to Library' && b.getClientRects().length)"), true, 'The document editor keeps the tab bar and Back to Library');
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
    await waitFor("(() => {const b=document.querySelector('.mf-dashboard [aria-label=\"New session\"]'); return b && !b.disabled && !b.closest('[hidden],[inert]') && b.getBoundingClientRect().width>0;})()");
    for (const selector of ['.mf-dashboard .ms-header-row', '.mf-dashboard .mf-dashboard-title', '.mf-dashboard .mf-project-trigger', '.mf-dashboard [aria-label="New session"]']) {
      await forgeControl(selector, top, side, name + ' Forge overview controls clear status area');
    }
    assert.deepEqual(await overflow(), [], name + ' Forge overview fits');
    await capture(name + '-forge-overview-safe-area');
    await js("document.querySelector('.mf-dashboard [aria-label=\"New session\"]').click()");
    await waitFor("(() => {const c=document.querySelector('.mf-project[data-forge-page=\"0\"] #mf-new .forge-composer'); return c && !c.closest('[hidden],[inert]') && c.getBoundingClientRect().width>0;})()");
    // Landscape intentionally moves New/Sessions navigation to the tab bar.
    const newNavigation = height <= 480 ? '.ms-tabbar[data-mode="forge"] [data-tabbar="new"]' : '.mf-project .ms-switch';
    assert.equal(await js("getComputedStyle(document.querySelector('.mf-project .ms-switch')).display === 'none'"), height <= 480, name + ' top New/Sessions switch visibility follows the short-screen layout');
    await waitFor(`(() => {const n=document.querySelector(${JSON.stringify(newNavigation)}); return n && !n.closest('[hidden],[inert]') && n.getBoundingClientRect().width>0;})()`);
    for (const selector of ['.mf-project .ms-header-row', newNavigation, '.mf-project [aria-label="Back to Forge Home"]', '#mf-new .forge-composer']) {
      await forgeControl(selector, top, side, name + ' Forge New controls clear status area: ' + selector);
    }
    assert.equal(await js("document.querySelector('#mf-tab-0').getAttribute('aria-selected')"), 'true', name + ' New page is selected');
    assert.equal(await js(`document.querySelector('#mf-new .forge-composer').getBoundingClientRect().bottom <= innerHeight - ${bottom} + 1`), true, name + ' Forge New composer clears home indicator inset');
    await waitFor("(() => {const b=document.querySelector('.ms-tabbar[data-mode=\"forge\"][data-state=\"shown\"] [data-tabbar=\"new\"]'); return b && !b.closest('[hidden],[inert]') && b.getBoundingClientRect().width>0;})()");
    assert.equal(await js(`document.querySelector('.ms-tabbar [data-tabbar="new"]').getBoundingClientRect().bottom <= innerHeight - ${bottom} + 1`), true, name + ' tab-bar New clears home indicator inset');
    assert.equal(await js("document.querySelector('#mf-new .forge-composer').getBoundingClientRect().bottom <= document.querySelector('.ms-tabbar').getBoundingClientRect().top"), true, name + ' Forge New composer does not overlap the visible tab bar');
    assert.deepEqual(await overflow(), [], name + ' Forge New fits');
    await capture(name + '-forge-new-safe-area');
    await navigate('forgeShell', { projectId: 'fp1', sessionId: 'fs1' });
    await waitFor("(() => {const h=document.querySelector('.mf-session-header'); return h && !h.closest('[hidden],[inert]') && h.getBoundingClientRect().height>0 && h.querySelector('.mf-session-heading strong')?.textContent;})()");
    await delay(350);
    for (const selector of ['.mf-session-header .mf-session-heading', '.mf-session-header [aria-label="Back"]', '.mf-session-header .mf-changes', '.mf-session-header [aria-label="Session actions"]']) {
      await forgeControl(selector, top, side, name + ' Forge session controls clear status area');
    }
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
    v.scrollTop=0;const heading=v.querySelector('.hm-heading, .dashboard-header'), before=heading.getBoundingClientRect().top;
    v.scrollTop=180;const after=heading.getBoundingClientRect().top;
    const ok=v.scrollTop>0 && after<before;spacer.remove();v.scrollTop=0;return ok;})()`), true, 'Page still scrolls beneath the fixed scrim');
};
