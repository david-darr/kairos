// A01 app shell (Part 2, 2026-10-27): command palette, nested Escape, dialogs on
// short screens, Profile's counts, role and links, and launch links. Runs in the
// default ui-smoke run and alone with --app-shell-only. Reloads the page at the
// end (launch links), then returns to Home at 1440x900.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, capture, base, demoState, fixtures }) => {
  const press = async (key, code, vk, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers });
    }
    await delay(120);
  };
  const escape = () => press('Escape', 'Escape', 27);
  // Known defects found 2026-10-27 are collected and reported together at the end,
  // so one of them does not hide the rest of the run.
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  const ctrlK = () => press('k', 'KeyK', 75, 2);
  // Phone sheets spring in after their content loads; measure once the panel holds still.
  const settled = async selector => {
    let last = '';
    for (let i = 0; i < 40; i++) {
      const now = await js(`JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect())`);
      if (now && now === last) return;
      last = now; await delay(100);
    }
    throw new Error(`${selector} never settled`);
  };
  const paletteOpen = "!!document.querySelector('.palette-backdrop:not(.hidden)')";
  const dialogs = "document.querySelectorAll('.modal-backdrop .panel-dialog').length";
  win.setContentSize(1440, 900); await delay(350);
  await navigate('home');

  // -- command palette ----------------------------------------------------
  await js("document.querySelector('#sidebar .nav-item[data-tab=notes]').focus()");
  await ctrlK();
  await waitFor(paletteOpen);
  assert.equal(await js("document.activeElement === document.querySelector('.palette-input')"), true, 'Ctrl+K opens the palette with the search focused');
  const labels = await js("[...document.querySelectorAll('.palette-item-label')].map(n => n.textContent)");
  // Desktop redesign: Home and the pinned tabs show in the sidebar; every tab is in All tabs.
  const nav = await js("[...document.querySelectorAll('#sidebar .nav-item[data-tab]')].filter(n => n.getClientRects().length).map(n => n.dataset.tab)");
  for (const tab of ['home', 'notes', 'library', 'calendar', 'tasks']) {
    assert.ok(nav.includes(tab), `${tab} is in the sidebar`);
  }
  const allTabs = await js("[...document.querySelectorAll('#rd-all-tabs .nav-item[data-tab]')].map(n => n.dataset.tab)");
  for (const tab of ['home', 'chat', 'notes', 'library', 'calendar', 'tasks']) {
    assert.ok(allTabs.includes(tab), `${tab} is in All tabs`);
  }
  for (const label of ['Go to Home', 'Go to Chats', 'Go to Notes', 'Go to Library', 'Go to Calendar', 'Go to Tasks', 'Open Settings']) {
    assert.ok(labels.includes(label), `palette lists "${label}"`);
  }
  await js("(() => { const i = document.querySelector('.palette-input'); i.value = 'calen'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  assert.deepEqual(await js("[...document.querySelectorAll('.palette-item-label')].map(n => n.textContent)"), ['Go to Calendar'], 'typing filters the commands');
  await js("(() => { const i = document.querySelector('.palette-input'); i.value = 'zzzz-nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  assert.equal(await js("document.querySelector('.palette-list').textContent.trim()"), 'No matching commands', 'no match says so');
  await js("(() => { const i = document.querySelector('.palette-input'); i.value = 'go to'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  const second = await js("[...document.querySelectorAll('.palette-item-label')][1].textContent");
  await press('ArrowDown', 'ArrowDown', 40);
  assert.equal(await js("document.querySelector('.palette-item.active .palette-item-label').textContent"), second, 'ArrowDown moves the selection');
  await js("(() => { const i = document.querySelector('.palette-input'); i.value = 'calendar'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await press('Enter', 'Enter', 13);
  await waitFor("document.querySelector('#sidebar .nav-item[data-tab=calendar]')?.classList.contains('active')");
  assert.equal(await js(paletteOpen), false, 'running a command closes the palette');
  await navigate('home');
  await js("document.querySelector('#sidebar .nav-item[data-tab=notes]').focus()");
  await ctrlK(); await waitFor(paletteOpen);
  await escape();
  assert.equal(await js(paletteOpen), false, 'Escape closes the palette');
  const focusAfter = await js("document.activeElement?.dataset?.tab || document.activeElement?.className || document.activeElement?.tagName");
  expect(focusAfter === 'notes', `closing the palette returns focus to where it was (focus went to ${focusAfter})`);
  console.log('PASS: command palette open, filter, arrows, Enter, Escape and focus return');

  // -- nested Escape --------------------------------------------------------
  await js("import('/static/js/workspaceProfile.js').then(m => { m.openWorkspaceProfile(document.querySelector('#sidebar .nav-item[data-tab=home]')); })");
  await waitFor(`${dialogs} === 1 && !!document.querySelector('.workspace-profile-card')`);
  await js("window.__confirm = null; import('/static/js/api.js').then(m => { window.__confirm = m.confirmDialog({ title: 'Nested', message: 'Inner dialog', confirmLabel: 'OK', danger: false }); })");
  await waitFor(`${dialogs} === 2`);
  await escape();
  assert.equal(await js(dialogs), 1, 'Escape closes only the top dialog');
  assert.equal(await js("window.__confirm.then(v => v)"), false, 'the closed confirmation resolves as cancelled');
  await ctrlK(); await waitFor(paletteOpen);
  await escape();
  assert.equal(await js(paletteOpen), false, 'Escape closes the palette opened over a dialog');
  const underneath = await js(dialogs);
  expect(underneath === 1, `one Escape on the palette leaves the dialog underneath open (dialogs left: ${underneath})`);
  if (underneath) await escape();
  assert.equal(await js(dialogs), 0, 'the dialog closes on Escape');
  console.log('PASS: nested Escape closes one layer at a time');

  // -- dialogs on short screens ------------------------------------------------
  for (const [label, w, h] of [['short desktop', 1280, 600], ['short phone', 390, 600], ['small phone', 320, 568]]) {
    win.setContentSize(w, h); await delay(400);
    await js("window.__confirm = null; import('/static/js/api.js').then(m => { window.__confirm = m.confirmDialog({ title: 'Delete this chat?', message: 'A long confirmation message that wraps onto several lines on a narrow screen, so the buttons must still be reachable.', confirmLabel: 'Delete chat' }); })");
    await waitFor(`${dialogs} === 1`);
    await settled('.confirm-panel');
    const fit = await js(`(() => {
      const panel = document.querySelector('.confirm-panel'), r = panel.getBoundingClientRect();
      const buttons = [...panel.querySelectorAll('.modal-footer button')].map(b => b.getBoundingClientRect());
      return { inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
        buttons: buttons.length === 2 && buttons.every(b => b.top >= 0 && b.bottom <= innerHeight + 0.5 && b.height >= (innerWidth <= 768 ? 44 : 28)),
        rect: [r.left, r.top, r.right, r.bottom], viewport: [innerWidth, innerHeight] };
    })()`);
    assert.ok(fit.inside, `${label}: confirmation stays on screen ${JSON.stringify(fit)}`);
    assert.ok(fit.buttons, `${label}: both buttons are visible and large enough ${JSON.stringify(fit)}`);
    await capture(`app-shell-${label.replace(' ', '-')}-confirm`);
    await escape();
    assert.equal(await js(dialogs), 0, `${label}: Escape dismisses the confirmation`);
    await js("import('/static/js/workspaceProfile.js').then(m => m.openWorkspaceProfile(document.body))");
    await waitFor("!!document.querySelector('.workspace-profile-settings button')");
    // Phone sheets spring in; measure where the sheet rests.
    await settled('.workspace-profile-panel');
    const profile = await js(`(() => {
      const panel = document.querySelector('.workspace-profile-panel'), r = panel.getBoundingClientRect();
      const scroller = [panel, ...panel.querySelectorAll('*')].find(n => n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY));
      return { inside: r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5,
        reachable: panel.scrollHeight <= panel.clientHeight + 1 || !!scroller, rect: [r.left, r.top, r.right, r.bottom] };
    })()`);
    assert.ok(profile.inside && profile.reachable, `${label}: Profile fits or scrolls ${JSON.stringify(profile)}`);
    await escape();
  }
  win.setContentSize(1440, 900); await delay(400);
  console.log('PASS: confirmation and Profile on short and narrow screens');

  // -- Profile: identity, counts, role, links ------------------------------
  const truth = await js(`Promise.all(['/api/auth/status', '/api/sessions', '/api/agents', '/api/notes'].map(p => fetch(p).then(r => r.json())))
    .then(([auth, sessions, agents, notes]) => ({ auth, chats: sessions.filter(s => !s.forge).length, agents: agents.length, notes: notes.length }))`);
  const openProfile = async () => {
    await js("import('/static/js/workspaceProfile.js').then(m => m.openWorkspaceProfile(document.querySelector('#sidebar .nav-item[data-tab=home]')))");
    await waitFor("document.querySelectorAll('.workspace-stat').length > 0");
  };
  await openProfile();
  const shown = await js(`(() => ({
    name: document.querySelector('.workspace-profile-identity strong').textContent,
    role: document.querySelector('.workspace-profile-identity .meta').textContent,
    stats: Object.fromEntries([...document.querySelectorAll('.workspace-stat')].map(s => [s.querySelector('span').textContent, Number(s.querySelector('strong').textContent)])),
    links: [...document.querySelectorAll('.workspace-profile-setting span:nth-child(2)')].map(n => n.textContent),
  }))()`);
  const expectedName = truth.auth.username === 'local' || !truth.auth.username ? 'Local User' : truth.auth.username;
  assert.equal(shown.name, expectedName, 'Profile shows the signed-in account');
  assert.equal(shown.role, truth.auth.auth_enabled ? (truth.auth.is_admin ? 'Admin' : 'Member') : 'This computer', 'Profile shows the right role');
  assert.deepEqual(shown.stats, { Chats: truth.chats, Agents: truth.agents, Notes: truth.notes }, 'Profile counts match the saved chats, agents and notes');
  assert.deepEqual(shown.links, ['Models', 'Appearance', 'Notifications', ...(truth.auth.is_admin ? ['Permissions'] : []), 'Calendar sync'], 'Profile lists its settings links');
  const destinations = { Models: 'added-models', Appearance: 'appearance', Notifications: 'notifications', Permissions: 'permissions' };
  for (const link of shown.links) {
    await js(`[...document.querySelectorAll('.workspace-profile-setting')].find(b => b.textContent.includes(${JSON.stringify(link)})).click()`);
    if (link === 'Calendar sync') {
      await waitFor("document.querySelector('#sidebar .nav-item[data-tab=calendar]')?.classList.contains('active')");
    } else {
      await waitFor(`document.querySelector('.settings-window:not(.hidden) .settings-nav-item.active')?.dataset.section === ${JSON.stringify(destinations[link])}`);
      await js("document.querySelector('.settings-window button[title=Close]').click()");
      await waitFor("!document.querySelector('.modal-backdrop:not(.hidden) .settings-window')");
    }
    assert.equal(await js(dialogs), 0, `${link} closes Profile on the way`);
    await openProfile();
  }
  await js("[...document.querySelectorAll('.workspace-profile-identity button')].find(b => b.textContent === 'Edit').click()");
  await waitFor("document.querySelector('.settings-window:not(.hidden) .settings-nav-item.active')?.dataset.section === 'account'");
  await js("document.querySelector('.settings-window button[title=Close]').click()");
  console.log('PASS: Profile identity, role, counts and every settings link');

  await require('./app-shell-gap-checks.cjs')({ js, win, waitFor, delay, navigate, capture, demoState, fixtures, press });
  // A view keeps mounting after its first element shows (an agent opens its chat pane a beat later).
  // Navigating away mid-mount lets the old page build avatars while it unloads, and Chromium reports
  // those data: SVG loads as blocked connects (CSP). Let the page go quiet before each launch link.
  const pageQuiet = async () => {
    await waitFor("[...document.images].every(image => image.complete || image.loading === 'lazy')", 10000);
    await js("new Promise(resolve => { let timer; const done = () => { observer.disconnect(); resolve(true); }; const quiet = () => { clearTimeout(timer); timer = setTimeout(done, 500); }; const observer = new MutationObserver(quiet); observer.observe(document.documentElement, { childList: true, subtree: true }); quiet(); setTimeout(done, 5000); })");
  };
  for (const [query, check] of [
    ['?view=calendar', "document.querySelector('#sidebar .nav-item[data-tab=calendar]')?.classList.contains('active')"],
    ['?view=notes', "document.querySelector('#sidebar .nav-item[data-tab=notes]')?.classList.contains('active')"],
    ['?newchat=1', "document.querySelector('#rd-all-tabs .nav-item[data-tab=chat]')?.classList.contains('active')"],
    ['?view=not-a-tab', "document.querySelector('#sidebar .nav-item[data-tab=home]')?.classList.contains('active')"],
    // Notification links: a bot opens that bot, a chat opens that chat, anything malformed falls back to Home.
    ['?agent=a1', "document.documentElement.dataset.appMode === 'bots' && document.documentElement.dataset.botsAgent === 'a1' && !!document.querySelector('.bots-shell[data-agent-id=\"a1\"]')"],
    ['?chat=abcdef123456', "!!document.querySelector('#chat-messages[data-session-id=\"abcdef123456\"]')"],
    ['?chat=not-a-chat-id', "document.querySelector('#sidebar .nav-item[data-tab=home]')?.classList.contains('active')"],
  ]) {
    await pageQuiet();
    await win.loadURL(base + '/' + query);
    await waitFor(check, 15000);
    // The view opens first; the address is cleaned once it has.
    await waitFor("location.pathname + location.search === '/'", 5000).catch(() => {});
    assert.equal(await js("location.pathname + location.search"), '/', `${query} is removed from the address after opening`);
  }
  await pageQuiet();
  await win.loadURL(base);
  await waitFor("!!document.querySelector('#sidebar .nav-item[data-tab=home].active')", 15000);
  console.log('PASS: launch links open the intended view and unknown views fall back to Home');
  assert.deepEqual(problems, [], 'app shell defects');
};
