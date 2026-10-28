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
          const h=document.querySelector('.view-header h2'), b=document.querySelector('.ms-tabbar').getBoundingClientRect();
          if (!h) return true;
          const range=document.createRange(); range.selectNodeContents(h); const r=range.getBoundingClientRect();
          return r.bottom<=b.top;
        })()`), true, `${tab} title clears the tab bar`);
      }
      if (width <= 768 && tab === 'home') {
        assert.equal(await js("!document.getElementById('mobile-menu-btn') && !!document.querySelector('.ms-tabbar [data-tabbar=home][aria-current=page]') && !document.querySelector('.ms-shell')"), true, 'Home has the tab bar, Home current, and the dashboard');
        assert.equal(await js("document.querySelector('.hm-heading, .dashboard-header').getClientRects().length > 0 && !document.querySelector('.ms-your-day')"), true, 'Dashboard is directly visible');
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
        await js("document.querySelector('.ms-tabbar [data-tabbar=more]').click()");
        assert.equal(await js("document.querySelector('.ms-tab-sheet[open]').contains(document.activeElement)"), true, 'More opens its sheet');
        await js("document.querySelector('.ms-tab-sheet').click()");
        assert.equal(await js("document.activeElement.dataset.tabbar"), 'more', 'More regains focus');
        await js('document.activeElement.blur()');
      }
      await capture(`interface-${label}-${tab}`);
    }
    await navigate('chat', { sessionId: 's1' });
    await waitFor("!!document.querySelector('#model-picker-label') && !!document.querySelector('.msg')");
    await delay(300); // Let the view/composer entrance finish before measuring.
    assert.equal(await js(`!!document.querySelector('.chat-mobile-header #context-pill') && !document.querySelector('.chat-composer-dock #context-pill') && (${width <= 768} ? document.querySelector('.composer-hint').getClientRects().length===0 : true)`), true, 'Capacity at top, help hidden in the phone menu');
    assert.equal(await js(`(() => {
      const targets=['#overflow-plus-btn','#chat-send','.chat-phone-tools > button'];
      return targets.every(selector=>{const b=document.querySelector(selector), i=b.querySelector('svg');
        const r=b.getBoundingClientRect(), s=i.getBoundingClientRect();
        return Math.abs((r.left+r.right-s.left-s.right)/2)<1 && Math.abs((r.top+r.bottom-s.top-s.bottom)/2)<1;});
    })()`), true, 'Action glyphs centered within controls');
    if (width <= 768) {
      assert.equal(await js("!document.querySelector('.chat-header-new') && document.querySelector('.chat-mobile-header').getBoundingClientRect().height<=74"), true, 'Phone header is a single compact row');
      const bottomGap = await js("document.querySelector('.ms-tabbar').getBoundingClientRect().top-document.querySelector('.chat-input-bar').getBoundingClientRect().bottom");
      assert.ok(bottomGap>=9 && bottomGap<=11, `Composer keeps a comfortable bottom gap (${bottomGap}px)`);
      await js("document.querySelector('.chat-phone-tools > button').click()");
      assert.equal(await js("![...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].some(n => n.textContent === 'Your workspace') && document.querySelector('.ms-tabbar').dataset.state === 'shown' && !!document.querySelector('.ms-chat-back')?.getClientRects().length"), true, 'A conversation keeps the tab bar and Back leads out');
      await capture(`interface-${label}-workspace`);
      await js("document.querySelector('.chat-phone-tools > button').click()");

    }
    await js("document.getElementById('chat-input').value='A draft that must survive opening menus'; document.getElementById('chat-input').dispatchEvent(new Event('input', {bubbles:true}))");
    if (width <= 768) {
      // The phone composer owns the pill; its compact sheet folds search and account into details.
      await waitFor("document.querySelector('.chat-input-bar').classList.contains('ms-composer-expanded')");
      assert.equal(await js("!!document.querySelector('.chat-input-bar #model-picker-btn') && !document.querySelector('.chat-mobile-header #model-picker-btn')"), true, 'Phone model pill lives in the composer');
      await click('#model-picker-btn');
      await waitFor("!!document.querySelector('.ms-sheet[open] #model-picker-menu') && !!document.querySelector('.ms-account-card')");
      await delay(350);
      assert.equal(await js("(() => { const d=document.querySelector('.ms-sheet[open]'), r=d.getBoundingClientRect(), m=document.getElementById('model-picker-menu').getBoundingClientRect(), safe=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-safe-top')) || 0; return !d.classList.contains('ms-sheet-full') && r.left === 0 && r.width === innerWidth && Math.abs(r.bottom - innerHeight) <= 1 && r.top >= safe && r.height > 44 && r.height <= innerHeight * .9 + 1 && m.width > 0 && m.left >= 0 && m.right <= innerWidth && !!d.querySelector('.ms-model-extras:not([open]) input[type=search]') && !!d.querySelector('.ms-provider-tabs[role=tablist] [role=tab][aria-selected=true]'); })()"), true, 'Compact phone model sheet fits below the status area with providers and folded search');
      // Choosing a connection keeps the picker open on that connection's versions, then Close returns to the chat.
      await click('.ms-sheet .ms-provider-tabs [role=tab][aria-selected=true]');
      await waitFor("!!document.querySelector('.ms-sheet[open] #model-picker-menu') && !document.getElementById('model-picker-menu').classList.contains('hidden')");
      await capture(`interface-${label}-model-picker`);
      await js("document.querySelector('.ms-sheet[open] .ms-sheet-header button').click()");
      await waitFor("!document.querySelector('.ms-sheet[open]')");
    } else {
      // The redesigned desktop composer owns the pill and the menu opens above it.
      assert.equal(await js("!document.querySelector('.chat-mobile-header #model-picker-btn') && !!document.querySelector('.chat-input-bar #model-picker-btn')"), true, 'Model pill lives in the composer');
      await click('#model-picker-btn');
      assert.equal(await js("(() => { const m=document.getElementById('model-picker-menu'), r=m.getBoundingClientRect(), h=document.querySelector('.chat-header-model').getBoundingClientRect(); return !m.classList.contains('hidden') && r.height>44 && r.bottom <= h.top + 1 && r.top >= 0 && r.left >= 0 && r.right <= innerWidth; })()"), true, 'Model picker opens above the pill and fits');
      // The desktop card shows the chat's own connection; search reaches every other connection's models.
      await waitFor("!!document.querySelector('.model-other-catalog-item')");
      const pickedModel = await js("document.querySelector('.model-other-catalog-item .model-catalog-name').textContent");
      await js("{ const s = document.querySelector('#model-picker-menu .rd-model-search'); s.value = document.querySelector('.model-other-catalog-item').dataset.modelSearch.split(' ')[0]; s.dispatchEvent(new Event('input')); }");
      await waitFor("!!document.querySelector('.model-other-catalog-item')?.offsetParent");
      await js("document.querySelector('.model-other-catalog-item').scrollIntoView({block:'nearest'})");
      await click('.model-other-catalog-item');
      await waitFor("document.getElementById('model-picker-menu').classList.contains('hidden')");
      await click('#model-picker-btn');
      await waitFor("!!document.querySelector('.model-catalog-item.active')");
      assert.equal(await js("document.querySelector('.model-catalog-item.active .model-catalog-name').textContent"), pickedModel, 'Choosing a model from another connection persists on the reopened board');
      await capture(`interface-${label}-model-picker`);
      await js("document.getElementById('model-picker-menu').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
      await waitFor("document.getElementById('model-picker-menu').classList.contains('hidden')");
    }
    await js("document.getElementById('chat-messages').click(); document.querySelector('.chat-phone-tools > button').click()");
    assert.equal(await js("[...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].some(n => n.textContent.includes('New chat'))"), true, 'New chat is available in tools');
    await capture(`interface-${label}-chat-tools`);
    if (width <= 768) {
      await js("[...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].find(n => n.textContent.includes('Model and reasoning')).click()");
      await waitFor("!!document.querySelector('.ms-sheet[open] #model-picker-menu')");
      // The tools action opens an animated sheet; [open] precedes its arrival onscreen.
      await js("Promise.all(document.querySelector('.ms-sheet[open]').getAnimations().map(a => a.finished))");
      assert.equal(await js("(() => { const r=document.getElementById('model-picker-menu').getBoundingClientRect(); return r.width > 0 && r.height>44 && r.left >= 0 && r.right <= innerWidth; })()"), true, 'Phone model and reasoning remain operable');
      await js("document.querySelector('.ms-sheet[open] .ms-model-extras > summary').scrollIntoView({block:'nearest'})");
      await click('.ms-sheet[open] .ms-model-extras > summary');
      await js("document.querySelector('.ms-sheet[open] .ms-model-extras input[type=search]').scrollIntoView({block:'nearest'})");
      await click('.ms-sheet[open] .ms-model-extras input[type=search]');
      assert.equal(await js("document.activeElement.matches('.ms-model-extras input[type=search]')"), true, 'Expanded model search takes focus');
      assert.equal(await js("!!document.querySelector('.ms-sheet[open]') && !document.getElementById('model-picker-menu').classList.contains('hidden')"), true, 'Tapping search inside the sheet keeps it open');
      assert.equal(await js("!document.getElementById('chat-sessions').classList.contains('open') && !document.getElementById('sidebar').classList.contains('open')"), true, 'Model editor is not covered by a drawer');
      await capture(`interface-${label}-model-reasoning`);
      await js("document.querySelector('.ms-sheet[open] .ms-sheet-header button').click()");
      await waitFor("!document.querySelector('.ms-sheet[open]')");
    }
    await js("document.getElementById('chat-messages').click(); document.getElementById('overflow-plus-btn').click()");
    // Phones keep Mode in More; the desktop prompt shows it as the permission pill (desktop redesign).
    if (width <= 768) assert.equal(await js("document.getElementById('chat-permission-mode').getClientRects().length > 0"), true, 'Permission mode stays visible in More');
    else assert.equal(await js("document.getElementById('chat-permission-pill').getClientRects().length > 0 && document.getElementById('overflow-menu').contains(document.getElementById('chat-openmic'))"), true, 'Desktop shows the permission pill, with Open Mic in the + menu');
    assert.equal(await js("(() => {const m=document.getElementById('overflow-menu').getBoundingClientRect(), b=document.getElementById('chat-openmic'), r=b.getBoundingClientRect();return m.width<=230 && m.height<=320 && (b.hidden || r.height<=44.1);})()"), true, 'More is compact and Open Mic stays one row');
    await click(width <= 768 ? '.chat-permission-control' : '#overflow-menu .overflow-menu-heading');
    assert.equal(await js("!document.getElementById('overflow-menu').classList.contains('hidden')"), true, 'Clicks inside More do not dismiss it');
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
      // Opening the drawer schedules tab-bar visibility through MutationObserver + rAF.
      await waitFor("document.querySelector('.ms-tabbar').dataset.state === 'hidden'");
      assert.equal(await js("document.querySelector('.ms-tabbar').dataset.state === 'hidden' && document.getElementById('chat-sessions').contains(document.querySelector('.chat-history-close svg'))"), true, 'Conversations owns its own close control');
    }
    if (width > 768) await waitFor("!!document.querySelector('#rd-history')");
    await capture(`interface-${label}-history`);
    if (width <= 768) await js("document.querySelector('.chat-history-close').click()");
    else { await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))"); await waitFor("!document.querySelector('#rd-history')"); }
    await js("document.querySelector('.sidebar-settings-btn').click()");
    await waitFor(width <= 768 ? "!!document.querySelector('.settings-mobile-page')" : "!!document.querySelector('.settings-window:not(.hidden)')");
    await capture(`interface-${label}-settings`);
    assert.deepEqual(await overflow(), [], `${label} Settings fits`);
    if (width <= 768) {
      assert.equal(await js("(() => {const r=document.querySelector('.settings-titlebar').getBoundingClientRect(), a=document.querySelector('.settings-titlebar .title').getBoundingClientRect();return r.top<=1 && r.height<=a.bottom + 72 && r.top <= a.top;})()"), true, 'Settings owns one compact header without inherited page padding');
      // The final phone board rules use 24px bordered groups and rows of at least 56px.
      assert.equal(await js(`(() => {const s=document.querySelector('.settings-search').getBoundingClientRect();return [...document.querySelectorAll('.settings-nav-item')].filter(n=>!n.hidden).every(n=>{const r=n.getBoundingClientRect(), p=getComputedStyle(n.parentElement);return r.left>=s.left-1 && r.right<=s.right+1 && p.borderTopWidth==='1px' && parseFloat(p.borderTopLeftRadius)===24 && r.height>=56;});})()`), true, 'Settings rows sit in inset groups within the search width');
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
