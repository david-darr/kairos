const assert = require('node:assert/strict');

module.exports = async function checkAppearance({ js, win, waitFor, capture, base, delay }) {
  const open = async () => {
    await js("document.querySelector('.sidebar-settings-btn').click()");
    await waitFor("!!document.querySelector('.modal-backdrop:not(.hidden) .settings-nav, #view-content.settings-mobile-page .settings-nav')");
    await waitFor("!!document.querySelector('[data-section=appearance]')");
    await js("document.querySelector('[data-section=appearance]').click()");
    await waitFor("!!document.querySelector('.appearance-panel')");
  };
  const state = () => js("import('/static/js/appearance.js').then(m=>m.getAppearance())");
  const set = async value => {
    await js(`import('/static/js/appearance.js').then(m=>m.updateAppearance(${JSON.stringify(value)}))`);
    await js("if(document.querySelector('.appearance-panel')) document.querySelector('[data-section=appearance]').click()");
  };
  const preview = () => js("document.querySelector('.appearance-preview canvas').toDataURL()");
  await open();
  // Keep every visible card row congruent at the reviewed desktop and phone sizes.
  for (const [width, height] of [[900, 800], [1280, 800], [1440, 900], [1920, 1080], [390, 844]]) {
    win.setContentSize(width, height); await delay(250);
    for (const mode of ['default', 'color', 'image', 'shader', 'glass', 'animated']) {
      await set({ mode }); await delay(250);
      const failures = await js(`(() => {
        const failures = [], panel = document.querySelector('.appearance-panel');
        if (panel.scrollWidth > panel.clientWidth + 1) failures.push('panel overflows');
        // Every grid of a kind (Chat messages and Chat style share .appearance-chat-styles).
        for (const selector of ['.appearance-modes', '.appearance-chat-styles', '.appearance-halftone-grid', '.appearance-effects-grid', '.appearance-glass-papers']) for (const grid of panel.querySelectorAll(selector)) {
          if (!grid.getClientRects().length) continue;
          const rows = new Map(), box = grid.getBoundingClientRect();
          for (const card of grid.children) {
            const rect = card.getBoundingClientRect(), top = Math.round(rect.top);
            if (!rows.has(top)) rows.set(top, []);
            rows.get(top).push(rect);
          }
          for (const row of rows.values()) {
            if (Math.abs(row[0].left - box.left) > 2 || Math.abs(row.at(-1).right - box.right) > 2) failures.push(selector + ' does not fill row');
            for (const rect of row) if (Math.abs(rect.width - row[0].width) > 1 || Math.abs(rect.height - row[0].height) > 1) failures.push(selector + ' has unequal cards');
          }
        }
        if (panel.querySelector('#appearance-classic')) failures.push('Classic toggle remains');
        return failures;
      })()`);
      assert.deepEqual(failures, [], `Appearance ${mode} at ${width}x${height}`);
    }
  }
  win.setContentSize(1440, 900); await delay(250); await set({ mode: 'default' });
  assert.deepEqual(await js("[...document.querySelectorAll('.appearance-mode')].map(n => n.dataset.mode)"), ['default', 'color', 'image', 'shader', 'glass', 'animated']);
  // Chat messages (desktop redesign): Plain by default, Cards on request, on the root for the chat CSS.
  assert.equal(await js("document.documentElement.dataset.chatMessages"), 'plain');
  await js("document.querySelector('.appearance-chat-style[data-chat-messages=cards]').click()");
  assert.equal(await js("document.documentElement.dataset.chatMessages + ':' + document.querySelector('.appearance-chat-style[data-chat-messages=cards]').getAttribute('aria-pressed')"), 'cards:true');
  await js("document.querySelector('.appearance-chat-style[data-chat-messages=plain]').click()");
  assert.equal(await js("document.documentElement.dataset.chatMessages"), 'plain');
  // Settings opened with no page asked for starts on Appearance (David, 2026-10-28).
  await js("import('/static/js/views/settings.js').then(m => m.openSettingsWindow('add-models'))");
  await waitFor("document.querySelector('.settings-nav-item.active')?.dataset.section === 'add-models'");
  await js("import('/static/js/views/settings.js').then(m => m.openSettingsWindow())");
  await waitFor("document.querySelector('.settings-nav-item.active')?.dataset.section === 'appearance' && !!document.querySelector('.appearance-panel')");
  // Picking an effect with the mouse leaves the Settings window where it was: its hidden radio
  // once scrolled the whole window and threw its header out of place.
  if (await js("innerWidth > 768")) {
    const box = "JSON.stringify((r => [r.left, r.top, r.width, r.height])(document.querySelector('.settings-window').getBoundingClientRect())) + ':' + document.querySelector('.settings-window').scrollTop";
    const before = await js(box);
    for (const effect of ['dithered', 'halftone', 'ascii', 'binary', 'dithered']) {
      const [x, y] = await js(`(() => { const label = document.querySelector('label[for=appearance-effect-${effect}]'); label.scrollIntoView({ block: 'nearest' }); const r = label.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + 12)]; })()`);
      await delay(150);
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await delay(300);
      assert.equal(await js("document.getElementById('appearance-effect-" + effect + "').checked"), true, `${effect} picked`);
      assert.equal(await js(box), before, `Picking ${effect} leaves the Settings window in place`);
    }
  }
  // Animated (David, 2026-10-28): a background style of its own. The old Animated art effect
  // moves to it; the art fills the window in its own colours and the theme follows them.
  assert.equal(await js("document.querySelectorAll('.appearance-effects-grid input').length"), 5, 'Animated is no longer a background effect');
  await set({ mode: 'default', backgroundEffect: 'animated', animatedPiece: 'scatter' });
  assert.deepEqual(await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); return [a.mode, a.backgroundEffect, a.animatedPiece, a.artLook]; })"), ['animated', 'dithered', 'aurora-cabin-snowfall', 'original'], 'Scatter gives way to the default piece, as made');
  assert.equal(await js("!document.querySelector('.appearance-art-options').hidden && document.querySelector('.appearance-effect-section').hidden && !document.querySelector('.appearance-art-options select#appearance-effect-tint')"), true, 'Its own section, with no tint');
  // Shown unchanged (David, 2026-10-28): ASCII Magic's own player draws the whole piece, centred and
  // as large as the window allows, on their black stage, with nothing over it or around it.
  const unchanged = `(() => {
    const art = document.getElementById('app-art'), canvas = art?.querySelector(':scope > canvas'), r = canvas?.getBoundingClientRect();
    if (!r || !r.width) return 'no canvas';
    const fills = Math.abs(r.width - innerWidth) <= 2 || Math.abs(r.height - innerHeight) <= 2;
    const centred = Math.abs(r.left + r.width / 2 - innerWidth / 2) <= 2 && Math.abs(r.top + r.height / 2 - innerHeight / 2) <= 2;
    const inside = r.width <= innerWidth + 2 && r.height <= innerHeight + 2;
    const only = [...art.children].every(node => node === canvas || node.matches('pre.art-player'));
    return [fills, centred, inside, only, getComputedStyle(art).backgroundColor].join(' ');
  })()`;
  await waitFor(`(${unchanged}) === 'true true true true rgb(0, 0, 0)'`);
  for (const look of ['dots', 'ascii', 'dither', 'blocks', 'original']) {
    await set({ artLook: look });
    await waitFor(`document.querySelector('.appearance-art-look[data-look=${look}]')?.getAttribute('aria-pressed') === 'true' && (${unchanged}) === 'true true true true rgb(0, 0, 0)'`);
  }
  // Every piece, searchable: the three David named are there.
  for (const [query, name] of [['aurora', 'Aurora Cabin Snowfall'], ['fuji', 'Fuji Dawn Lake'], ['balloon valley', 'Balloon Valley Sunrise']]) {
    await js(`{ const s = document.getElementById('appearance-art-search'); s.value = ${JSON.stringify(query)}; s.dispatchEvent(new Event('input')); }`);
    assert.ok(await js(`[...document.getElementById('appearance-art-piece').options].some(o => o.text === ${JSON.stringify(name)})`), `${name} can be found`);
  }
  await js("{ const s = document.getElementById('appearance-art-search'); s.value = ''; s.dispatchEvent(new Event('input')); }");
  assert.ok(await js("document.getElementById('appearance-art-piece').options.length > 700"), 'The whole library is listed');
  // The theme is taken from the art: a deep shade of its background as the base, an accent that reads on it.
  const readable = `(() => {
    const s = getComputedStyle(document.documentElement), probe = document.createElement('span'); document.body.append(probe);
    const rgb = name => { probe.style.color = s.getPropertyValue(name); return getComputedStyle(probe).color.match(/[0-9.]+/g).slice(0, 3).map(Number); };
    const l = c => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [l(rgb(a)), l(rgb(b))]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const out = [rgb('--bg').join(','), ratio('--text', '--bg'), ratio('--accent', '--bg')]; probe.remove(); return out;
  })()`;
  const bases = [];
  for (const piece of ['fuji-dawn-lake', 'balloon-valley-sunrise', 'lava-lamp']) {
    const before = await js("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()");
    await set({ animatedPiece: piece });
    await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() !== ${JSON.stringify(before)}`);
    await waitFor(`(${unchanged}) === 'true true true true rgb(0, 0, 0)'`);
    const [base, text, accent] = await js(readable);
    bases.push(base);
    assert.ok(text >= 4.5 && accent >= 4.5, `${piece}: text ${text.toFixed(2)} and accent ${accent.toFixed(2)} read on its base`);
    if (piece === 'fuji-dawn-lake') await capture('appearance-animated-piece');
  }
  assert.equal(new Set(bases).size, 3, 'Each piece gives its own colours');
  await set({ animatedPiece: 'aurora-cabin-snowfall', artPanels: 1 });
  assert.equal(await js("getComputedStyle(document.documentElement).getPropertyValue('--art-alpha').trim()"), '0.34');
  await set({ artPanels: .6 });
  // Motion off holds a frame; the piece stays whole.
  await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); m.updateAppearance({ effectOptions: { ...a.effectOptions, animated: { ...a.effectOptions.animated, motion: false } } }); })");
  await waitFor(`(${unchanged}) === 'true true true true rgb(0, 0, 0)'`);
  await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); m.updateAppearance({ effectOptions: { ...a.effectOptions, animated: { ...a.effectOptions.animated, motion: true } } }); })");
  await capture('appearance-animated-aurora');
  // Your own animation: a still PNG and a short WebM made here, each kept and played as it is,
  // the theme taken from its colours. Removing it goes back to the default piece.
  await js(`(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), g = c.getContext('2d');
    g.fillStyle = '#0c2a1c'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#ff3d7f'; g.fillRect(20, 20, 24, 24);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const m = await import('/static/js/appearance.js');
    await m.setAppearanceArt(new File([blob], 'mine.png', { type: 'image/png' }));
  })()`);
  await waitFor("!!document.querySelector('#app-art img') && getComputedStyle(document.documentElement).getPropertyValue('--bg').replace(/ /g, '') === 'rgb(12,42,28)'");
  assert.deepEqual(await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); return [a.mode, a.animatedPiece, a.hasArt, parseInt(a.artAccent.slice(1, 3), 16) > 200]; })"), ['animated', 'own', true, true], 'The pink square is the accent');
  await js(`(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), g = c.getContext('2d');
    const recorder = new MediaRecorder(c.captureStream(20), { mimeType: 'video/webm' }), parts = [];
    recorder.ondataavailable = e => parts.push(e.data);
    const done = new Promise(r => { recorder.onstop = r; });
    recorder.start();
    for (let i = 0; i < 16; i++) { g.fillStyle = '#2a1030'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#3df2ff'; g.fillRect(i * 2, 22, 20, 20); await new Promise(r => setTimeout(r, 50)); }
    recorder.stop(); await done;
    const m = await import('/static/js/appearance.js');
    await m.setAppearanceArt(new File(parts, 'mine.webm', { type: 'video/webm' }));
  })()`);
  await waitFor("document.querySelector('#app-art video')?.readyState >= 2");
  await capture('appearance-animated-own');
  await js("import('/static/js/appearance.js').then(m => m.removeAppearanceArt())");
  assert.deepEqual(await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); return [a.animatedPiece, a.hasArt, !!document.querySelector('#app-art video')]; })"), ['aurora-cabin-snowfall', false, false]);
  await set({ mode: 'default' });
  assert.equal(await js("!!document.getElementById('app-art')"), false, 'The art layer goes with the style');
  // See through to the desktop: only where the desktop app offers it, on by default in glass.
  if (await js("typeof window.jarvis?.setSeeThrough === 'function'")) {
    await set({ mode: 'glass' });
    assert.equal(await js("document.documentElement.dataset.glassDesktop + ':' + !document.querySelector('.appearance-glass-desktop').hidden"), 'on:true');
    assert.equal(await js("getComputedStyle(document.documentElement).backgroundColor"), 'rgba(0, 0, 0, 0)', 'The page lets the desktop through');
    await set({ glassDesktop: false });
    assert.equal(await js("document.documentElement.dataset.glassDesktop"), 'off');
    await set({ mode: 'default', glassDesktop: true });
    assert.equal(await js("document.documentElement.dataset.glassDesktop"), 'off', 'Only Liquid glass sees through');
  }
  assert.equal(await js("document.querySelector('[data-mode=default] strong').textContent"), 'Kairos');
  assert.equal(await js("document.querySelector('.appearance-preview-copy strong').textContent"), 'Not more time. The right time.');
  await js("document.querySelector('[data-mode=color]').click()");
  await set({ mode: 'color', color: '#23302e' });
  assert.equal(await js("getComputedStyle(document.querySelector('#sidebar')).backgroundColor"), 'rgb(29, 39, 38)');
  // Light colors switch foregrounds, including the independently darker rail.
  await set({ color: '#e6dfd1' });
  const contrast = await js(`(() => {
    const c = getComputedStyle(document.querySelector('#sidebar'));
    const l = s => s.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
    const a=l(c.backgroundColor), b=l(c.color); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  })()`);
  assert.ok(contrast >= 4.5, 'Light sidebar text stays readable');
  await capture('appearance-light');

  // Custom halftone pictures (Build spec, 2026-10-08): Home, New chat
  // (figure) and Conversation (sky) each take an optional picture, stored
  // and validated the same way as the Image background.
  // A corner-to-corner gradient, not a flat fill: cropping a different region
  // (the focus point) has to change what's sampled on either axis, so a
  // focus change is visible regardless of which way the banner is cropped.
  const halftoneFile = (color, bytes) => bytes
    ? `new File([new Uint8Array(${bytes})], 'big.png', { type: 'image/png' })`
    : `await (async () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 64, 64);
        g.addColorStop(0, '${color}'); g.addColorStop(1, '#111111');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
        return new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'halftone.png', { type: 'image/png' });
      })()`;
  const halftoneCardSel = slot => `document.querySelector('#appearance-halftone-${slot}').closest('.appearance-halftone-card')`;
  const halftoneResetSel = slot => `${halftoneCardSel(slot)}.querySelector('.appearance-halftone-card-actions > button')`;
  const halftoneThumbSrc = (slot) => js(`${halftoneCardSel(slot)}.querySelector('img').src`);
  // Waits on the thumbnail's object URL actually changing, not just "Reset
  // is visible": a slot replaced a second time already has Reset showing,
  // and halftoneRevision moves the instant the call starts (so it can tell
  // a stale load from a current one) rather than once it has landed - either
  // alone would let the assertion run before the new picture is truly saved.
  const setHalftoneSlot = async (slot, color) => {
    const before = await halftoneThumbSrc(slot);
    await js(`(async () => {
      const file = ${halftoneFile(color)};
      const transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.querySelector('#appearance-halftone-${slot}');
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor(`!${halftoneResetSel(slot)}.hidden`);
    await waitFor(`${halftoneCardSel(slot)}.querySelector('img').src !== ${JSON.stringify(before)}`);
  };
  const bannerPixels = () => js("document.querySelector('.dashboard-core canvas:not(.dither-cover)').toDataURL()");
  const waitForBannerChange = async (before) => {
    for (let i = 0; i < 40; i++) { const now = await bannerPixels(); if (now !== before) return now; await delay(50); }
    throw new Error('Home banner did not redraw');
  };
  await setHalftoneSlot('home', '#2f6cc2');
  assert.ok(await js(`${halftoneCardSel('home')}.querySelector('img').src.startsWith('blob:')`), 'Home thumbnail shows the custom picture');
  await waitFor("document.querySelector('.dashboard-core')?.dataset.halftoneSrc?.startsWith('blob:')");
  const customBanner = await waitForBannerChange('');
  // Clicking the thumbnail moves the focus point (default centre) and the banner redraws from it.
  assert.deepEqual(await js("import('/static/js/appearance.js').then(m => m.halftoneFocus('home'))"), { x: .5, y: .5 });
  await js(`{ const btn = ${halftoneCardSel('home')}.querySelector('.appearance-halftone-thumb-btn'), box = btn.getBoundingClientRect();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left + box.width * 0.1, clientY: box.top + box.height * 0.9 })); }`);
  const focusedBanner = await waitForBannerChange(customBanner);
  const movedFocus = await js("import('/static/js/appearance.js').then(m => m.halftoneFocus('home'))");
  assert.ok(movedFocus.x < 0.3 && movedFocus.y > 0.7, 'Focus moves to where the thumbnail was clicked');
  // Reset restores the Kairos default picture.
  await js(`${halftoneResetSel('home')}.click()`);
  await waitFor(`${halftoneResetSel('home')}.hidden`);
  assert.ok(await js("!document.querySelector('.dashboard-core').dataset.halftoneSrc.startsWith('blob:')"), 'Reset restores the default picture');
  await waitForBannerChange(focusedBanner);
  // Wrong type and over-size pictures are refused; the saved picture is untouched.
  await setHalftoneSlot('home', '#2f6cc2');
  assert.match(await js("import('/static/js/appearance.js').then(m=>m.setHalftoneImage('home', new File(['<svg/>'],'bad.svg',{type:'image/svg+xml'}))).then(()=>'',e=>e.message)"), /PNG/);
  assert.match(await js(`import('/static/js/appearance.js').then(m=>m.setHalftoneImage('home', ${halftoneFile(null, 13 * 1024 * 1024)})).then(()=>'',e=>e.message)`), /12 MB/);
  assert.equal(await js("import('/static/js/appearance.js').then(m=>m.getAppearance().halftoneSlots.home.hasImage)"), true, 'A rejected picture leaves the saved one in place');
  await js(`${halftoneResetSel('home')}.click()`);
  await waitFor(`${halftoneResetSel('home')}.hidden`);

  // New chat and Conversation each draw their own custom picture (a direct
  // module check: the full chat UI is exercised elsewhere in ui-smoke.cjs).
  // The same picture in both skips the cross-dissolve between them. (Each
  // slot keeps its own object URL even when the bytes match, so "the same
  // picture" is judged by content - halftoneSharedChatPicture's hash - not
  // by comparing the two URL strings, which would never be equal.)
  const chatBackdropCheck = () => js(`(async () => {
    const mod = await import('/static/js/chatBackdrop.js');
    const host = document.createElement('div'); host.style.width = '300px'; host.style.height = '200px'; document.body.append(host);
    const backdrop = mod.mountChatBackdrop(host);
    await backdrop.show('figure'); await backdrop.ready;
    const figureIsBlob = host.querySelector('.chat-backdrop').dataset.halftoneSrc.startsWith('blob:');
    const landed = backdrop.show('sky', { animate: true });
    await new Promise(r => setTimeout(r, 60));
    const dissolving = host.querySelector('.chat-backdrop').classList.contains('is-dissolving');
    await landed;
    const skyIsBlob = host.querySelector('.chat-backdrop').dataset.halftoneSrc.startsWith('blob:');
    backdrop.dispose(); host.remove();
    return { figureIsBlob, skyIsBlob, dissolving };
  })()`);
  await setHalftoneSlot('figure', '#c2452f');
  await setHalftoneSlot('sky', '#3f9f5f');
  assert.deepEqual(await chatBackdropCheck(), { figureIsBlob: true, skyIsBlob: true, dissolving: true },
    'New chat and Conversation draw their own pictures and dissolve between different ones');
  // The identical picture in both slots: uploaded from the one File object,
  // so the two slots are guaranteed the same bytes (appearance.js hashes the
  // original upload, not its downsampled copy, since re-encoding the same
  // picture twice isn't guaranteed to produce identical bytes).
  await js(`(async () => { window.__halftoneShared = ${halftoneFile('#c2452f')}; })()`);
  const setHalftoneSlotFromWindowFile = async (slot) => {
    const before = await halftoneThumbSrc(slot);
    await js(`(async () => {
      const transfer = new DataTransfer(); transfer.items.add(window.__halftoneShared);
      const input = document.querySelector('#appearance-halftone-${slot}');
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor(`!${halftoneResetSel(slot)}.hidden`);
    await waitFor(`${halftoneCardSel(slot)}.querySelector('img').src !== ${JSON.stringify(before)}`);
  };
  await setHalftoneSlotFromWindowFile('figure');
  await setHalftoneSlotFromWindowFile('sky');
  assert.equal(await js("import('/static/js/appearance.js').then(m=>m.halftoneSharedChatPicture())"), true, 'The same picture in both chat slots is recognised');
  assert.deepEqual(await chatBackdropCheck(), { figureIsBlob: true, skyIsBlob: true, dissolving: false },
    'The same picture in both chat slots skips the dissolve');
  await js(`${halftoneResetSel('figure')}.click(); ${halftoneResetSel('sky')}.click();`);
  await waitFor(`${halftoneResetSel('figure')}.hidden && ${halftoneResetSel('sky')}.hidden`);
  await capture('appearance-halftone-slots');
  // The phone-width capture of these cards happens at the very end of this
  // file instead of here: resizing the real window and back disturbs its
  // coordinates for the CDP mouse drag further down, so every other size
  // change in this file already waits until after that drag is done.

  await set({ mode: 'shader', color: '#f3eadb', motion: false });
  await capture('appearance-flow-parchment');
  await set({ mode: 'shader', color: '#23302e', motion: false });
  await js("document.querySelector('[data-section=appearance]').click()");
  assert.equal((await state()).staticFallback, false, 'Shader compiles and runs');
  for (const key of ['distortion', 'swirl', 'grainMixer', 'grainOverlay']) {
    await set({ [key]: 0 }); const before = await preview();
    await js(`{ const input=document.querySelector('#appearance-${key}'); input.value='100'; input.dispatchEvent(new Event('input')); }`);
    assert.equal((await state())[key], 1);
    assert.notEqual(await preview(), before, key + ' changes rendered pixels');
    await set({ [key]: .25 });
  }
  await js("document.querySelector('#appearance-swirl').focus()");
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  assert.equal((await state()).swirl, .26, 'Dial is keyboard accessible');
  // Real pointer input, not a synthetic dispatch: the dial calls
  // setPointerCapture(event.pointerId), which throws for a made-up id, so a
  // hand-built PointerEvent would test nothing and quietly report success.
  // CDP mouse events give Chromium's own pointer id.
  await set({ distortion: 0 });
  await js("document.querySelector('[data-section=appearance]').click()");
  // Selecting the section resets its scroll; Flow now follows the preview and style cards.
  await js("document.querySelector('#appearance-distortion').scrollIntoView({block:'center', behavior:'instant'})");
  const knobBox = await js(`(() => {
    const input = document.querySelector('#appearance-distortion'), r = input.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (document.elementFromPoint(x, y) !== input) throw new Error('Distortion dial is obscured');
    return { x, y };
  })()`);
  const flat = await preview();
  const drag = (type, x, y) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
  });
  await drag('mousePressed', knobBox.x, knobBox.y);
  await drag('mouseMoved', knobBox.x + 100, knobBox.y);
  await drag('mouseReleased', knobBox.x + 100, knobBox.y);
  const dragged = (await state()).distortion;
  // 100px right at the handler's 0.6/px equals 60 of 100, so ~0.6. Asserted
  // with tolerance because the press lands on a rounded centre pixel.
  assert.ok(Math.abs(dragged - .6) < .08, `Pointer drag moves the dial (got ${dragged})`);
  assert.notEqual(await preview(), flat, 'Pointer drag changes rendered pixels');
  // Releasing must end the drag; without pointer capture teardown the dial
  // would keep tracking the cursor across the whole panel.
  await drag('mouseMoved', knobBox.x + 200, knobBox.y);
  assert.equal((await state()).distortion, dragged, 'Dial stops tracking after release');
  await set({ distortion: .65, swirl: .65, grainMixer: .15, grainOverlay: .18 });
  await js("document.querySelector('[data-section=appearance]').click()");
  await capture('appearance-flow-settings');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await set({ motion: true }); const still = await preview();
  await delay(180); assert.equal(await preview(), still, 'Reduced motion holds the shader still');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  await delay(180); assert.notEqual(await preview(), still, 'Shader motion resumes');
  await set({ motion: false });
  // WebGL contexts are lost for reasons outside the app's control (driver
  // reset, GPU process crash, too many live contexts). The shader must fall
  // back to the static gradient rather than leaving a dead black canvas
  // behind the whole UI, and recover if the context comes back.
  await set({ mode: 'shader' });
  await js("document.querySelector('[data-section=appearance]').click()");
  assert.equal((await state()).staticFallback, false, 'Shader is running before the loss test');
  // The extension handle is grabbed once and kept: getExtension() returns
  // null on an already-lost context, so re-fetching it to restore would fail
  // with "no WEBGL_lose_context" rather than actually restoring anything.
  assert.equal(await js(`(() => {
    const gl = [...document.querySelectorAll('canvas.app-background')].map(c => c.getContext('webgl')).find(Boolean);
    if (!gl) return 'no webgl canvas';
    window.__loseContextExt = gl.getExtension('WEBGL_lose_context');
    return window.__loseContextExt ? 'ok' : 'no WEBGL_lose_context';
  })()`), 'ok', 'WEBGL_lose_context is available to drive the test');
  const loseContext = (method) => js(`(() => { window.__loseContextExt.${method}(); return 'ok'; })()`);
  const shaderFrame = await preview();
  assert.equal(await loseContext('loseContext'), 'ok');
  await waitFor("import('/static/js/appearance.js').then(m=>m.getAppearance().staticFallback===true)");
  assert.equal((await state()).staticFallback, true, 'Lost context falls back to the static gradient');
  // Must actually repaint, not just flip a flag and leave the dead frame up.
  // Comparing against the live shader frame catches a blank canvas too, which
  // a data-URL length check would happily pass.
  const fallbackFrame = await preview();
  assert.notEqual(fallbackFrame, shaderFrame, 'Static fallback repaints instead of leaving the lost frame');
  assert.ok(
    await js("(() => { const c = document.querySelector('.appearance-preview canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) { if (d[i] || d[i+1] || d[i+2]) return true; } return false; })()"),
    'Static fallback paints real pixels rather than an empty canvas',
  );
  await capture('appearance-static-fallback');
  assert.equal(await loseContext('restoreContext'), 'ok');
  await waitFor("import('/static/js/appearance.js').then(m=>m.getAppearance().staticFallback===false)");
  assert.equal((await state()).staticFallback, false, 'Restored context returns to the shader');
  await js("document.querySelector(\".settings-titlebar-btn[title='Close']\").click()");
  await js("import('/static/js/app.js').then(m=>m.switchTab('chat'))");
  assert.ok(!await js("getComputedStyle(document.querySelector('.chat-layout')).backgroundImage.includes('kairos-sky.jpg')"), 'Flow appearance keeps its chosen background');
  await capture('appearance-flow-workspace');
  await open();
  await js("document.querySelector('[data-mode=image]').click()");
  await js(`(async () => {
    const c=document.createElement('canvas'); c.width=640; c.height=360; const x=c.getContext('2d');
    const g=x.createLinearGradient(0,0,640,360); g.addColorStop(0,'#7e9294'); g.addColorStop(1,'#c29e80'); x.fillStyle=g; x.fillRect(0,0,640,360);
    x.fillStyle='#315659'; x.beginPath(); x.ellipse(360,420,450,230,-.25,0,7); x.fill();
    const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
    const transfer=new DataTransfer(); transfer.items.add(new File([blob],'fixture.png',{type:'image/png'}));
    const input=document.querySelector('#appearance-image'); input.files=transfer.files; input.dispatchEvent(new Event('change'));
  })()`);
  await waitFor("document.querySelector('.appearance-image-options .appearance-upload').textContent==='Replace image'");
  assert.equal((await state()).hasImage, true);
  await set({ tint: .25 }); const untinted = await preview();
  await set({ tint: .8 }); assert.notEqual(await preview(), untinted, 'Image tint changes pixels');
  await set({ tint: .35 });
  await capture('appearance-image-settings');
  await win.loadURL(base);
  await waitFor("(!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('.dashboard-content .skeleton') && ![...document.querySelectorAll('.dashboard-stat-value')].some(n => n.textContent === '…'))");
  assert.equal((await state()).mode, 'image'); assert.equal((await state()).hasImage, true, 'Image survives reload');
  // A different signed-in user on this device receives their own preferences.
  await js("import('/static/js/appearance.js').then(m=>m.initAppearance('Other fixture user'))");
  assert.equal((await state()).mode, 'default'); assert.equal((await state()).hasImage, false);
  await js("import('/static/js/appearance.js').then(m=>m.initAppearance('Alex'))");
  assert.equal((await state()).hasImage, true);
  await open();
  // Invalid images are rejected without discarding the saved image.
  assert.match(await js("import('/static/js/appearance.js').then(m=>m.setAppearanceImage(new File(['<svg/>'],'bad.svg',{type:'image/svg+xml'}))).then(()=>'',e=>e.message)"), /PNG/);
  // Image writes are serialised through a promise queue and guarded by
  // revision counters. The invariant that matters is that memory and storage
  // never disagree: a lost race would either leave an orphaned blob that a
  // reload resurrects, or clear storage while memory still shows an image.
  // Both are only visible after a reload, so each case is checked across one.
  const fileExpr = (color) => `(async () => { const c=document.createElement('canvas'); c.width=64; c.height=64; const x=c.getContext('2d'); x.fillStyle='${color}'; x.fillRect(0,0,64,64); return new File([await new Promise(r=>c.toBlob(r,'image/png'))],'race.png',{type:'image/png'}); })()`;
  // Two writes started without awaiting the first: the later must win, and
  // storage must hold exactly what memory reports.
  assert.equal(await js(`(async () => {
    const mod = await import('/static/js/appearance.js');
    const [a, b] = await Promise.all([${fileExpr('#c2452f')}, ${fileExpr('#2f6cc2')}]);
    await Promise.allSettled([mod.setAppearanceImage(a), mod.setAppearanceImage(b)]);
    return 'done';
  })()`), 'done');
  assert.equal((await state()).hasImage, true, 'Concurrent image writes leave an image in memory');
  await win.loadURL(base);
  await waitFor("(!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('.dashboard-content .skeleton') && ![...document.querySelectorAll('.dashboard-stat-value')].some(n => n.textContent === '…'))");
  assert.equal((await state()).hasImage, true, 'Concurrent image writes persist consistently');
  // A reset racing an in-flight write must win outright. If the write landed
  // after the delete, the image would come back on the next launch.
  assert.equal(await js(`(async () => {
    const mod = await import('/static/js/appearance.js');
    const pending = mod.setAppearanceImage(await ${fileExpr('#3f7f5f')});
    await Promise.allSettled([pending, mod.resetAppearance()]);
    return 'done';
  })()`), 'done');
  assert.equal((await state()).hasImage, false, 'Reset wins the race in memory');
  await win.loadURL(base);
  await waitFor("(!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('.dashboard-content .skeleton') && ![...document.querySelectorAll('.dashboard-stat-value')].some(n => n.textContent === '…'))");
  assert.equal((await state()).hasImage, false, 'Reset racing a write does not resurrect the image');
  assert.equal((await state()).mode, 'default');
  await open();
  await set({ mode: 'shader' });
  win.setContentSize(390, 844); await delay(100);
  await js("document.querySelector(\".settings-titlebar-btn[title='Close']\").click()");
  await open();
  assert.ok(await js("document.querySelector('.appearance-panel').scrollWidth<=document.querySelector('.appearance-panel').clientWidth"), 'Appearance fits mobile');
  await capture('appearance-mobile');
  await js("import('/static/js/appearance.js').then(m=>m.resetAppearance())");
  assert.equal((await state()).hasImage, false);
  assert.equal((await state()).mode, 'default');
  await win.loadURL(base);
  await waitFor("(!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('.dashboard-content .skeleton') && ![...document.querySelectorAll('.dashboard-stat-value')].some(n => n.textContent === '…'))");
  assert.equal((await state()).hasImage, false, 'Reset removes persisted image');
  // The halftone slot cards at phone width (mode is back to Kairos default,
  // which shows them): the window is already narrow here, with nothing left
  // that depends on real screen coordinates (the CDP mouse drag is done).
  await open();
  assert.ok(await js("document.querySelector('.appearance-panel').scrollWidth<=document.querySelector('.appearance-panel').clientWidth"), 'Halftone slot cards fit a phone');
  await capture('mobile-appearance-halftone-slots');
  win.setContentSize(1440, 900); await delay(350);
};
