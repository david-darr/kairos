const assert = require('node:assert/strict');

module.exports = async function checkChatForgePatch({ js, win, waitFor, capture, delay, navigate }) {
  const closeMenus = () => js("import('/static/js/api.js').then(m => m.closeOptionMenu())");
  const closeDocuments = () => js("import('/static/js/chatContent.js').then(m => m.closeArtifact())");
  win.setContentSize(1440, 900);
  await navigate('home');
  await js("document.querySelector('#forge-mode-switch [data-mode=forge]').click()");
  await waitFor("!!document.querySelector('.forge-composer [aria-label=Agent]')");
  await js("{ const p = document.querySelector('.forge-composer [aria-label=Agent]').parentElement; p.value = 'm2'; p.dispatchEvent(new Event('change')); const w = document.querySelector('.forge-composer [aria-label=\"Where it runs\"]').parentElement; w.value = 'existing_branch'; w.dispatchEvent(new Event('change')); }");
  await waitFor("!!document.querySelector('.forge-composer [aria-label=Branch]') && !!document.querySelector('.forge-composer [aria-label=\"Model for new session\"]')");
  for (const [width, height] of [[1440, 900], [1280, 420], [390, 844], [390, 420]]) {
    win.setContentSize(width, height); await delay(100);
    for (const label of ['Project', 'Where it runs', 'Branch', 'Mode', 'Agent', 'Model for new session']) {
      await js(`document.querySelector('.forge-composer [aria-label=${JSON.stringify(label)}]').click()`);
      await delay(140);
      assert.ok(await js("(() => { const m = document.querySelector('.custom-select-menu')?.getBoundingClientRect(), c = document.querySelector('.forge-composer').getBoundingClientRect(); return m && m.top >= c.bottom && m.left >= 0 && m.right <= innerWidth + 1 && m.bottom <= innerHeight - 11; })()"), `${label} opens below Forge composer within ${width}x${height}`);
      assert.ok(await js("parseFloat(document.querySelector('.custom-select-menu').style.maxHeight) >= 100"), `${label} retains useful list space in ${width}x${height}`);
      if (label === 'Agent') await capture(`patch-forge-picker-${width}`);
      await closeMenus();
    }
  }
  win.setContentSize(1440, 900);
  // Exercise real empty and failed rail refreshes without changing fixtures.
  await js("window.patchFetch = window.fetch; window.patchRailState = 'empty'; window.fetch = (url, options) => url === '/api/forge/projects' && window.patchRailState ? Promise.resolve(new Response(JSON.stringify(window.patchRailState === 'empty' ? [] : {detail:'Unavailable'}), {status:window.patchRailState === 'empty' ? 200 : 503, headers:{'Content-Type':'application/json'}})) : window.patchFetch(url, options); document.dispatchEvent(new Event('kairos:forge-projects'))");
  try {
    await waitFor("!!document.querySelector('.forge-rail-message')");
    for (const state of ['empty', 'error']) {
      await js(`window.patchRailState = '${state}'; document.documentElement.classList.remove('sidebar-collapsed'); document.dispatchEvent(new Event('kairos:forge-projects'))`);
      await waitFor(`document.querySelector('.forge-rail-message')?.textContent === '${state === 'empty' ? 'Open a folder to begin.' : 'Projects could not load.'}'`);
      assert.ok(await js("document.querySelector('.forge-rail-message').getBoundingClientRect().height > 0"), 'Expanded rail shows status');
      await js("document.documentElement.classList.add('sidebar-collapsed')");
      assert.equal(await js("getComputedStyle(document.querySelector('.forge-rail-message')).display"), 'none', 'Collapsed rail hides status copy');
      assert.ok(await js("document.querySelector('[aria-label=\"Add project\"]').getBoundingClientRect().width > 0"), 'Collapsed Add project stays available');
      await capture(`patch-forge-rail-${state}`);
    }
  } finally {
    await js("window.fetch = window.patchFetch; delete window.patchFetch; delete window.patchRailState; document.documentElement.classList.remove('sidebar-collapsed'); document.dispatchEvent(new Event('kairos:forge-projects'))");
  }
  await js("document.querySelector('#forge-mode-switch [data-mode=kairos]').click()");
  await waitFor("document.getElementById('view-content').dataset.view === 'home' && !document.documentElement.classList.contains('tab-transition')");
  await navigate('chat', { sessionId: 's1' }); await closeDocuments();
  await waitFor("!!document.querySelector('.chat-documents-toggle') && !!document.querySelector('.artifact-card')");
  const entries = [
    ['documents', "document.querySelector('.chat-documents-toggle').click()"],
    ['session-files', "document.querySelector('.chat-files-toggle').click()"],
    ['session-document', "document.querySelector('.artifact-card').click()"],
  ];
  const hidePanes = () => js("Promise.all([import('/static/js/chatContent.js'), import('/static/js/chatFilesPane.js')]).then(([docs, files]) => { docs.hideArtifact(); files.closeChatFiles(); })");
  const assertSettled = async label => {
    const result = await js(`(() => {
      const host = document.querySelector('.chat-layout'), main = host.querySelector('#chat-main'), panel = host.querySelector('.artifact-panel');
      const saved = Number(localStorage.getItem('kairos:chat-pane-width'));
      const expected = Math.max(380, Math.min(Math.floor(host.clientWidth * .7), saved >= 380 ? saved : Math.round(host.clientWidth * .6)));
      // Count only motion that moves the split or the pane: script/CSS animations
      // and geometry transitions. Focus outlines and the scrollbar fade are not openings.
      const moving = ['width', 'flex-basis', 'transform', 'translate', 'opacity', 'all'];
      const motion = [...main.getAnimations(), ...panel.getAnimations()].filter(a => !(a instanceof CSSTransition) || moving.includes(a.transitionProperty));
      return {width:main.getBoundingClientRect().width, expected, panel:panel.getBoundingClientRect().width,
        opening:host.classList.contains('pane-opening'), animations:motion.length,
        names:motion.map(a => (a.animationName || a.transitionProperty || a.constructor.name) + '@' + a.effect?.target?.className)};
    })()`);
    assert.ok(Math.abs(result.width - result.expected) < 2 && result.panel > 0 && !result.opening && result.animations === 0,
      `${label} settles at the clamped split without a second animation: ${JSON.stringify(result)}`);
  };
  // Sample real geometry at the start, middle and end of all three entrances,
  // using default, saved and over-limit widths. Inspect in the click's task so
  // loading a preview cannot race the animation assertions.
  for (const saved of [null, 580, 99999]) {
    for (const [label, trigger] of entries) {
      await hidePanes(); await closeMenus();
      await js(saved === null ? "localStorage.removeItem('kairos:chat-pane-width')" : `localStorage.setItem('kairos:chat-pane-width', '${saved}')`);
      const result = await js(`(() => {
        const main = document.querySelector('#chat-main'), before = main.getBoundingClientRect().width;
        ${trigger};
        const panel = document.querySelector('.chat-layout > .artifact-panel'), widths = main.getAnimations(), entrances = panel.getAnimations();
        if (widths.length !== 1 || entrances.length !== 1) return {widths:widths.length, entrances:entrances.length};
        const a = widths[0], entrance = entrances[0], frames = a.effect.getKeyframes(), timing = a.effect.getTiming();
        a.pause(); entrance.pause(); a.currentTime = entrance.currentTime = 0;
        const start = main.getBoundingClientRect().width, opacity = getComputedStyle(panel).opacity;
        a.currentTime = entrance.currentTime = timing.duration / 2;
        return {before, start, opacity, from:parseFloat(frames[0].width), to:parseFloat(frames.at(-1).width),
          mid:main.getBoundingClientRect().width, duration:timing.duration, easing:timing.easing, panelTiming:entrance.effect.getTiming()};
      })()`);
      assert.ok(result.from > result.mid && result.mid > result.to && Math.abs(result.start - result.before) < 2 && result.opacity === '0',
        `${label} opens without a jump or flash: ${JSON.stringify(result)}`);
      assert.ok(result.duration >= 250 && result.duration <= 350);
      assert.equal(result.duration, result.panelTiming.duration, 'Pane and chat use the same duration');
      assert.equal(result.easing, result.panelTiming.easing, 'Pane and chat use the same ease-out');
      if (saved === null) await capture(`patch-${label}-opening-mid`);
      await js("for (const node of document.querySelectorAll('#chat-main, .chat-layout > .artifact-panel')) for (const a of node.getAnimations()) a.finish()");
      await delay(40); await assertSettled(label);
      await delay(350); await assertSettled(label);
      if (saved === null) await capture(`patch-${label}-open`);
    }
  }
  await waitFor("!!document.querySelector('.chat-layout .artifact-document')");
  await js("window.patchRetainedDocument = document.querySelector('.chat-layout .artifact-document'); import('/static/js/chatContent.js').then(m => m.hideArtifact())");
  await js("document.querySelector('.chat-documents-toggle').click()"); await delay(350);
  await assertSettled('Natural retained-document reopen');
  assert.ok(await js("document.querySelector('.chat-layout .artifact-document') === window.patchRetainedDocument"), 'Reopening keeps document DOM');
  await js("document.querySelector('.chat-files-toggle').click()");
  await assertSettled('Replace viewer with session files');
  await waitFor("!!document.querySelector('.chat-file-row')");
  await js("window.patchFilesPanel = document.querySelector('.chat-files-panel'); document.querySelector('.chat-files-toggle').click()");
  assert.ok(await js("document.querySelector('.chat-files-panel') === window.patchFilesPanel"), 'Repeated session-files button keeps the open pane');
  await assertSettled('Repeated session-files button');
  const switchResult = await js(`(() => {
    const before = document.querySelector('#chat-main').getBoundingClientRect().width;
    document.querySelector('.chat-file-row').click();
    return {before, after:document.querySelector('#chat-main').getBoundingClientRect().width};
  })()`);
  assert.ok(Math.abs(switchResult.before - switchResult.after) < 2, 'Selecting a session file keeps the open split steady');
  await assertSettled('Session file selection');
  await js("document.querySelector('.artifact-card').click(); document.querySelector('.chat-documents-toggle').click(); document.querySelector('.artifact-tab-label').click()");
  await assertSettled('Switch already-open documents');
  await capture('patch-documents-open');
  // Rapid reopen cancels the old registration without replacing saved DOM.
  await js("import('/static/js/chatContent.js').then(m => { m.hideArtifact(); m.showArtifactPane(); m.hideArtifact(); m.showArtifactPane(); })");
  assert.equal(await js("document.querySelectorAll('.chat-layout > .artifact-panel').length"), 1);
  assert.equal(await js("document.querySelectorAll('.chat-pane-resizer').length"), 1);
  await delay(350); await assertSettled('Rapid reopen');
  // Keyboard input immediately after a rapid reopen must cancel the entrance,
  // then land on the same default + 24px without a second opening transition.
  for (let attempt = 0; attempt < 5; attempt++) {
    await js("localStorage.removeItem('kairos:chat-pane-width'); import('/static/js/chatContent.js').then(m => { m.hideArtifact(); m.showArtifactPane(); document.querySelector('.chat-pane-resizer').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true})); })");
    await delay(350);
    assert.ok(await js("Math.abs(document.querySelector('#chat-main').getBoundingClientRect().width - (Math.round(document.querySelector('.has-pane').clientWidth * .6) + 24)) < 2 && !document.querySelector('.has-pane').classList.contains('pane-opening')"), 'Rapid reopen and keyboard resize lands on exact width');
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    for (const [label, trigger] of entries) {
      await hidePanes(); await closeMenus(); await js(trigger);
      await assertSettled(`Reduced motion ${label}`);
      assert.equal(await js("getComputedStyle(document.querySelector('#chat-main')).transitionDuration"), '0s');
    }
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await hidePanes(); await closeMenus();
    await js("localStorage.removeItem('kairos:chat-pane-width'); delete window.patchRetainedDocument; delete window.patchFilesPanel");
  }
  await closeDocuments();
  // Real progress subscription, held locally: no model or account is used.
  await js("window.patchFetch = window.fetch; window.fetch = (url, options) => url === '/api/chat/stream' ? Promise.resolve(new Response(new ReadableStream({start(c) { window.patchProgressStream = c; }}), {headers:{'Content-Type':'text/event-stream'}})) : window.patchFetch(url, options); import('/static/js/chatStream.js').then(m => m.startTurn('patch-progress', 'Patch progress', 'Test', []))");
  try {
    await waitFor("!!document.querySelector('.chat-progress-card')");
    await js("document.documentElement.classList.add('electron-shell')");
    for (const [width, height] of [[1440, 900], [390, 420]]) {
      win.setContentSize(width, height); await delay(250);
      assert.ok(await js("(() => { const r=document.querySelector('#chat-progress-host').getBoundingClientRect(); return r.top >= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) + 12 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()"), 'Progress card clears titlebar and fits window');
      await capture(`patch-chat-progress-${width}`);
    }
  } finally {
    await js("window.patchProgressStream.enqueue(new TextEncoder().encode('data: {\"done\":true}\\n\\n')); window.patchProgressStream.close(); window.fetch = window.patchFetch; delete window.patchFetch; document.documentElement.classList.remove('electron-shell')");
  }
  win.setContentSize(1440, 900); await navigate('home');
  console.log('PASS: Forge composer picker bounds, collapsed empty/error rail, chat document opening/reopening/retained DOM/reduced motion, progress titlebar clearance.');
};
