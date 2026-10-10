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
  await js("localStorage.removeItem('kairos:chat-pane-width')");
  // Pause the real opening animation halfway: geometry must interpolate,
  // rather than only asserting that a transition is declared in CSS.
  const checkOpening = async trigger => {
    await js(trigger);
    const result = await js("(() => { const main = document.querySelector('#chat-main'), panel = document.querySelector('.chat-layout .artifact-panel'); const a = main.getAnimations().find(a => a.effect.getKeyframes().some(k => /^\\d/.test(k.width))); const entrance = panel.getAnimations().find(a => a.effect.getKeyframes().some(k => 'transform' in k)); if (!a || !entrance) return {animations:main.getAnimations().map(a => a.effect.getKeyframes())}; a.pause(); entrance.pause(); a.currentTime = 55; entrance.currentTime = 55; const frames = a.effect.getKeyframes(); return {from: parseFloat(frames[0].width), to:parseFloat(frames.at(-1).width), mid:main.getBoundingClientRect().width}; })()");
    assert.ok(result && result.from > result.mid && result.mid > result.to, 'Document opening narrows the chat through intermediate widths: ' + JSON.stringify(result));
    await js("for (const node of document.querySelectorAll('#chat-main, .chat-layout > .artifact-panel')) for (const a of node.getAnimations()) a.finish()");
    await delay(230);
  };
  await checkOpening("document.querySelector('.chat-documents-toggle').click()");
  await closeMenus();
  await js("import('/static/js/chatContent.js').then(m => m.hideArtifact())");
  await checkOpening("document.querySelector('.artifact-card').click()");
  await waitFor("!!document.querySelector('.chat-layout .artifact-document')");
  await js("window.patchRetainedDocument = document.querySelector('.chat-layout .artifact-document'); import('/static/js/chatContent.js').then(m => m.hideArtifact())");
  await checkOpening("document.querySelector('.chat-documents-toggle').click()");
  assert.ok(await js("document.querySelector('.chat-layout .artifact-document') === window.patchRetainedDocument"), 'Reopening keeps document DOM');
  await checkOpening("document.querySelector('.chat-files-toggle').click()");
  await waitFor("!!document.querySelector('.chat-file-row')");
  await js("document.querySelector('.chat-file-row').click()");
  assert.ok(await js("document.querySelector('.chat-layout .artifact-viewer').getAnimations().some(a => a.effect.getKeyframes().some(k => 'transform' in k))"), 'Individual session file replays pane entrance');
  await delay(250); await capture('patch-documents-open');
  // Rapid reopen cancels the old registration without replacing saved DOM.
  await js("import('/static/js/chatContent.js').then(m => { m.hideArtifact(); m.showArtifactPane(); m.hideArtifact(); m.showArtifactPane(); })");
  assert.equal(await js("document.querySelectorAll('.chat-layout > .artifact-panel').length"), 1);
  assert.equal(await js("document.querySelectorAll('.chat-pane-resizer').length"), 1);
  await delay(250);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await js("import('/static/js/chatContent.js').then(m => { m.hideArtifact(); m.showArtifactPane(); })");
  assert.ok(await js("[document.querySelector('#chat-main'), document.querySelector('.chat-layout .artifact-panel')].every(n => n.getAnimations().every(a => !a.effect.getKeyframes().some(k => 'width' in k || 'transform' in k)))"), 'Reduced motion skips pane movement');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
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
