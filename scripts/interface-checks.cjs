// Integration checks against the app's synthetic API, using actual Chromium
// layout. Only CSS/DOM/actions are exercised; no live account is contacted.
const assert = require('node:assert/strict');
module.exports = async ({ js, win, waitFor, capture, delay, navigate, overflow }) => {
  const resize = async (w, h) => { win.setContentSize(w, h); await delay(400); };
  const click = async selector => {
    const point = await js(`(() => {
      const n=document.querySelector(${JSON.stringify(selector)}), r=n.getBoundingClientRect();
      const x=r.left+r.width/2, y=r.top+r.height/2;
      if (!n.contains(document.elementFromPoint(x,y))) throw new Error('Control is obscured: '+${JSON.stringify(selector)});
      return {x:Math.round(x), y:Math.round(y)};
    })()`);
    win.webContents.sendInputEvent({type:'mouseDown', button:'left', ...point, clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp', button:'left', ...point, clickCount:1});
    await delay(100);
  };
  for (const [label, width, height] of [['phone', 390, 844], ['desktop', 1440, 900], ['small-phone', 320, 568]]) {
    await resize(width, height);
    for (const tab of ['home', 'chat', 'notes', 'library', 'calendar', 'email', 'tasks', 'agents', 'tool-store', 'cookbook']) {
      await navigate(tab, tab === 'chat' ? { sessionId: 's1' } : {});
      await delay(450);
      assert.deepEqual(await overflow(), [], `${label} ${tab}: content has no horizontal overflow`);
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${label} ${tab}: page fits`);
      assert.equal(await js("!document.getElementById('mobile-view-context')"), true, 'No redundant workspace pill');
      if (width <= 768 && tab !== 'chat' && tab !== 'home') {
        assert.equal(await js(`(() => {
          const h=document.querySelector('.view-header h2'), b=document.getElementById('mobile-menu-btn').getBoundingClientRect();
          if (!h) return true;
          const range=document.createRange(); range.selectNodeContents(h); const r=range.getBoundingClientRect();
          return r.left>=b.right || r.top>=b.bottom;
        })()`), true, `${tab} title clears Menu`);
      }
      if (width <= 768 && tab === 'home') {
        assert.equal(await js("document.querySelector('.dashboard-header').getBoundingClientRect().top >= document.getElementById('mobile-menu-btn').getBoundingClientRect().bottom + 12"), true, 'Home overview clears the fixed menu');
      }
      if (tab === 'calendar') {
        assert.equal(await js("document.querySelector('.cal-calendar-list').getClientRects().length===0"), true, 'Calendar choices take no page space');
        await click('.cal-calendars-trigger');
        await waitFor("!!document.querySelector('.cal-calendars-dialog .cal-calendar-choice')");
        await capture(`interface-${label}-calendar-selection`);
        await click('.cal-calendars-dialog .modal-close-btn');
        assert.equal(await js("document.activeElement.classList.contains('cal-calendars-trigger') && document.querySelector('.cal-calendar-list').getClientRects().length===0"), true, 'Calendar popup restores its button and hides its choices');
      }
      if (width <= 768 && tab === 'library') {
        await js("document.getElementById('mobile-menu-btn').click()");
        assert.equal(await js("document.getElementById('sidebar').contains(document.activeElement) && document.getElementById('mobile-menu-btn').getAttribute('aria-expanded')==='true'"), true, 'Menu opens the shared drawer');
        await js("document.getElementById('mobile-backdrop').click()");
        assert.equal(await js("document.activeElement.id"), 'mobile-menu-btn', 'Menu button regains focus');
        await js('document.activeElement.blur()');
      }
      await capture(`interface-${label}-${tab}`);
    }
    await navigate('chat', { sessionId: 's1' });
    await waitFor("!!document.querySelector('#model-picker-label') && !!document.querySelector('.msg')");
    await delay(300); // Let the view/composer entrance finish before measuring.
    assert.equal(await js("!!document.querySelector('.chat-mobile-header #context-pill') && !document.querySelector('.chat-composer-dock #context-pill') && document.querySelector('.composer-hint').getClientRects().length===0"), true, 'Capacity at top, help hidden in menu');
    assert.equal(await js(`(() => {
      const targets=['#overflow-plus-btn','#chat-send','.chat-phone-tools > button'];
      return targets.every(selector=>{const b=document.querySelector(selector), i=b.querySelector('svg');
        const r=b.getBoundingClientRect(), s=i.getBoundingClientRect();
        return Math.abs((r.left+r.right-s.left-s.right)/2)<1 && Math.abs((r.top+r.bottom-s.top-s.bottom)/2)<1;});
    })()`), true, 'Action glyphs centered within controls');
    if (width <= 768) {
      assert.equal(await js("document.querySelector('.chat-header-new').getClientRects().length===0 && document.querySelector('.chat-mobile-header').getBoundingClientRect().height<=74"), true, 'Phone header is a single compact row');
      const bottomGap = await js("innerHeight-document.querySelector('.chat-input-bar').getBoundingClientRect().bottom");
      assert.ok(bottomGap>=15.9 && bottomGap<=52, `Composer keeps a comfortable bottom gap (${bottomGap}px)`);
      await js("document.getElementById('mobile-menu-btn').click()"); await delay(300);
      assert.equal(await js("Math.abs(document.getElementById('sidebar').getBoundingClientRect().right-document.getElementById('mobile-menu-btn').getBoundingClientRect().right-12)<1"), true, 'Menu travels to drawer trailing edge');
      assert.equal(await js("document.querySelector('#brand .brand-wordmark').getBoundingClientRect().left<=18"), true, 'Sidebar wordmark sits near the left edge');
      await capture(`interface-${label}-animated-menu`);
      await js("document.getElementById('mobile-menu-btn').click()"); await delay(300);
    }
    assert.equal(await js("!!document.querySelector('.chat-mobile-header #model-picker-btn') && !document.querySelector('.chat-input-bar #model-picker-btn')"), true, 'Model lives beside conversation, outside composer');
    await js("document.getElementById('chat-input').value='A draft that must survive opening menus'; document.getElementById('chat-input').dispatchEvent(new Event('input', {bubbles:true}))");
    await click('#model-picker-btn');
    assert.equal(await js("(() => { const m=document.getElementById('model-picker-menu'), r=m.getBoundingClientRect(), h=document.querySelector('.chat-header-model').getBoundingClientRect(); return !m.classList.contains('hidden') && r.height>44 && r.top >= h.bottom && r.left >= 0 && r.right <= innerWidth && r.bottom<=innerHeight; })()"), true, 'Model picker opens below header and fits');
    await click('.model-connection-item.active');
    await waitFor("document.getElementById('model-picker-menu').classList.contains('hidden')");
    await click('#model-picker-btn');
    await capture(`interface-${label}-model-picker`);
    await js("document.getElementById('chat-messages').click(); document.querySelector('.chat-phone-tools > button').click()");
    assert.equal(await js("[...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].some(n => n.textContent.includes('New chat'))"), true, 'New chat is available in tools');
    await capture(`interface-${label}-chat-tools`);
    if (width <= 768) {
      await js("[...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].find(n => n.textContent.includes('Model and reasoning')).click()");
      await waitFor("!document.getElementById('model-version-menu').classList.contains('hidden')");
      assert.equal(await js("(() => { const r=document.getElementById('model-version-menu').getBoundingClientRect(); return r.width > 0 && r.height>44 && r.top>=document.getElementById('model-picker-btn').getBoundingClientRect().bottom && r.bottom<=innerHeight && r.left >= 0 && r.right <= innerWidth; })()"), true, 'Phone model and reasoning remain operable');
      await click('.model-version-search input');
      assert.equal(await js("!document.getElementById('model-version-menu').classList.contains('hidden')"), true, 'Model search clicks keep the editor open');
      assert.equal(await js("!document.getElementById('chat-sessions').classList.contains('open') && !document.getElementById('sidebar').classList.contains('open')"), true, 'Model editor is not covered by a drawer');
      await capture(`interface-${label}-model-reasoning`);
    }
    await js("document.getElementById('chat-messages').click(); document.getElementById('overflow-plus-btn').click()");
    assert.equal(await js("document.getElementById('chat-permission-mode').getClientRects().length > 0"), true, 'Permission mode stays visible in More');
    assert.equal(await js("(() => {const m=document.getElementById('overflow-menu').getBoundingClientRect(), b=document.getElementById('chat-openmic'), r=b.getBoundingClientRect();return m.width<=230 && m.height<=320 && (b.hidden || r.height<=44.1);})()"), true, 'More is compact and Open Mic stays one row');
    await click('.chat-permission-control');
    assert.equal(await js("!document.getElementById('overflow-menu').classList.contains('hidden')"), true, 'Mode row clicks do not dismiss More');
    if (width <= 768) {
      await js("window.__cameraOpened=0; document.getElementById('chat-camera-input').click=()=>window.__cameraOpened++; true");
      await click('.chat-camera-action');
      assert.equal(await js("window.__cameraOpened===1 && document.getElementById('chat-camera-input').accept==='image/*' && document.getElementById('chat-camera-input').getAttribute('capture')==='environment'"), true, 'Phone camera action opens the photo capture input');
      await click('#overflow-plus-btn');
    }
    assert.equal(await js("document.getElementById('chat-input').value"), 'A draft that must survive opening menus');
    await capture(`interface-${label}-composer-options`);
    await js("document.getElementById('chat-messages').click(); document.getElementById('chat-history-toggle').click()");
    if (width <= 768) {
      assert.equal(await js("getComputedStyle(document.getElementById('mobile-menu-btn')).visibility==='hidden' && document.getElementById('chat-sessions').contains(document.querySelector('.chat-history-close svg'))"), true, 'Conversations owns its own close control');
    }
    await capture(`interface-${label}-history`);
    if (width <= 768) await js("document.querySelector('.chat-history-close').click()");
    await js("document.querySelector('.sidebar-settings-btn').click()");
    await waitFor(width <= 768 ? "!!document.querySelector('.settings-mobile-page')" : "!!document.querySelector('.settings-window:not(.hidden)')");
    await capture(`interface-${label}-settings`);
    assert.deepEqual(await overflow(), [], `${label} Settings fits`);
    if (width <= 768) {
      assert.equal(await js("(() => {const r=document.querySelector('.settings-titlebar').getBoundingClientRect();return r.top<=1 && r.height<=72;})()"), true, 'Settings owns one compact header without inherited page padding');
      assert.equal(await js(`(() => {const s=document.querySelector('.settings-search').getBoundingClientRect();return [...document.querySelectorAll('.settings-nav-item')].filter(n=>!n.hidden).every(n=>{const r=n.getBoundingClientRect(), p=getComputedStyle(n.parentElement);return Math.abs(r.left-s.left)<1 && Math.abs(r.right-s.right)<1 && p.borderTopWidth==='0px' && r.height>=54;});})()`), true, 'Settings rows align with search without enclosing boxes');
      await js("document.querySelector('.settings-nav-item[data-section=notifications]').click()");
      await waitFor("document.querySelector('#view-content.settings-mobile-page')?.dataset.mobileView === 'page'");
      await capture(`interface-${label}-notifications`);
      assert.deepEqual(await overflow(), [], `${label} notification settings fits`);
    }
    // Escape closes the desktop window; phone navigation disposes its page.
    await js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
    await navigate('home');
  }
};
