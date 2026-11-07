// Browse mode's screen (vault: "Kairos Browser - Phase 1", U3), run by
// scripts/ui-smoke.cjs (--browse-only alone, and in the full run).
//
// ui-smoke's own window is the web client: no desktop bridge, so Browse must
// not appear there, and that is checked first. The rest runs in a window of
// its own whose preload is a stand-in bridge (fixtures/browse-bridge-stub.cjs)
// recording every call, so the screen's wiring is checked without native tabs.
// The native half is scripts/browser-smoke.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserWindow } = require('electron');

module.exports = async function browseChecks({ js, base, output, fs }) {
  // The web client: no Browse.
  assert.equal(await js("[...document.querySelectorAll('#forge-mode-switch [data-mode]')].some(b => b.dataset.mode === 'browse')"), false,
    'The web client offers no Browse mode');

  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true,
    // Its own in-memory session: as the desktop app, this window saves device preferences
    // (localStorage), which must not leak into the checks that run after it in ui-smoke.
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'browse-ui-check',
      preload: path.join(__dirname, 'fixtures', 'browse-bridge-stub.cjs') } });
  const errors = [];
  win.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message); });
  const run = async (code) => {
    const value = await win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    return value;
  };
  const until = async (condition, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await run(`return !!(${condition});`)) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('Timed out waiting for ' + condition);
  };
  const shot = async (name) => fs.writeFileSync(path.join(output, `browse-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const calls = (name) => run(`return window.__browseStub.calls().filter(c => c.name === ${JSON.stringify(name)});`);
  try {
    await win.loadURL(base);
    // The desktop app: modes in the title bar, Browse set apart; no sidebar switch.
    await until("document.querySelector('#titlebar-modes [data-mode=browse]')");
    assert.deepEqual(await run("return [...document.querySelectorAll('#titlebar-modes [data-mode]')].map(b => b.dataset.mode);"), ['kairos', 'forge', 'bots', 'browse']);
    assert.ok(await run("return !!document.querySelector('#titlebar-modes .titlebar-modes-divider + .titlebar-browse');"), 'Browse sits after a divider');
    assert.equal(await run("return !!document.querySelector('#forge-mode-switch');"), false, 'no mode switch in the sidebar');
    assert.equal(await run("return document.querySelectorAll('#titlebar-modes small').length;"), 0, 'no Preview badges in the title bar');
    assert.equal(await run("return getComputedStyle(document.querySelector('#titlebar-tab')).display;"), 'none', 'no page name after the modes');
    assert.equal(await run("return getComputedStyle(document.querySelector('#titlebar-modes')).webkitAppRegion;"), 'no-drag', 'the tabs are clickable, not a drag area');
    await shot('titlebar');

    await run("document.querySelector('#titlebar-modes [data-mode=browse]').click();");
    await until("document.querySelector('.browse-side') && document.querySelector('.browse-tab')");

    // Layout: Browse's sidebar replaces the app's; one blank tab shows the new tab page.
    assert.equal(await run("return document.documentElement.dataset.appMode;"), 'browse');
    assert.equal(await run("return document.querySelector('#titlebar-modes [data-mode=browse]').getAttribute('aria-pressed');"), 'true', 'the title bar stays and shows Browse');
    assert.equal(await run("return getComputedStyle(document.querySelector('#sidebar')).display;"), 'none', 'the app sidebar steps aside');
    assert.equal((await calls('open'))[0].args[0], null, 'an empty Browse opens one blank tab');
    assert.equal(await run("return document.querySelectorAll('.browse-pin').length;"), 2, 'pinned sites grid');

    // The home screen (Speed Dial, 2026-11-03): search, tiles, "+", Suggestions, customize.
    await until("document.querySelector('.browse-home .browse-dial-open')");
    assert.equal(await run("return document.querySelectorAll('.browse-dials:not(.browse-suggestions) .browse-dial').length;"), 3, 'two tiles and the + tile');
    assert.equal(await run("return document.querySelector('.browse-suggestions .browse-dial-name span')?.textContent;"), 'News', 'suggestions from history');
    assert.equal(await run("return document.querySelector('.browse-home-search-input').placeholder;"), 'Search Google or type an address');
    await new Promise(r => setTimeout(r, 700)); // let the view's entrance fade finish
    await shot('home');
    // Right-click a tile: rename it.
    await run("document.querySelector('.browse-dial[data-pin=\"2\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 300 }));");
    await until("document.querySelector('.browse-home-menu')");
    await run("[...document.querySelectorAll('.browse-home-menu button')].find(b => b.textContent === 'Rename').click();");
    await until("document.querySelector('.browse-home-form')");
    await run("const f = document.querySelector('.browse-home-form'); f.querySelector('input').value = 'Inbox'; f.requestSubmit();");
    await until("[...document.querySelectorAll('.browse-dial-name')].some(n => n.textContent === 'Inbox')");
    assert.deepEqual((await calls('editPin')).at(-1).args, [2, 'https://mail.example.com/', 'Inbox']);
    // The + tile adds a site.
    await run("document.querySelector('.browse-dial-add').click();");
    await until("document.querySelector('.browse-home-form')");
    await run("const f = document.querySelector('.browse-home-form'); const [name, address] = f.querySelectorAll('input'); name.value = 'Docs'; address.value = 'docs.example.com'; f.requestSubmit();");
    await until("[...document.querySelectorAll('.browse-dial-name')].some(n => n.textContent === 'Docs')");
    assert.deepEqual((await calls('pinSite')).at(-1).args, ['https://docs.example.com', 'Docs']);
    // Customize: a colour background and large tiles are saved.
    await run("document.querySelector('.browse-home-gear').click();");
    await until("!document.querySelector('.browse-home-customize').hidden");
    await run("document.querySelector('input[name=browse-home-bg][value=color]').click();");
    await until("document.querySelector('.browse-home').dataset.background === 'color'");
    await run("[...document.querySelectorAll('.browse-home-customize .segmented-tab')].find(b => b.textContent === 'Large').click();");
    await until("document.querySelector('.browse-home').dataset.tiles === 'large'");
    assert.equal((await calls('setHome')).at(-1).args[0].tileSize, 'large');
    await shot('home-customize');
    await run("[...document.querySelectorAll('.browse-home-customize .btn')].find(b => b.textContent === 'Done').click();");
    // Searching from the home screen uses the blank tab.
    await run("const s = document.querySelector('.browse-home-search-input'); s.value = 'kairos browser'; s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));");
    await until("window.__browseStub.calls().some(c => c.name === 'navigate')");
    assert.deepEqual((await calls('navigate')).at(-1).args.slice(1), ['kairos browser']);
    // Google is the default search: the tab now holds a Google search address.
    await until("(document.querySelector('.browse-tab.active .browse-tab-main')?.title || '').startsWith('https://www.google.com/search?q=')");

    // Right-click a tab: its actions and site info, inside the sidebar.
    await run("document.querySelector('.browse-tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));");
    await until("document.querySelector('.browse-tab-menu .browse-site')");
    assert.ok(await run("return document.querySelector('.browse-side').contains(document.querySelector('.browse-tab-menu'));"));
    assert.deepEqual(await run("return [...document.querySelectorAll('.browse-tab-menu-actions .btn')].map(b => b.textContent);"), ['Pin tab', 'Mute', 'Duplicate', 'Close']);
    await shot('tab-menu');
    await run("[...document.querySelectorAll('.browse-tab-menu-actions .btn')].find(b => b.textContent === 'Duplicate').click();");
    await until("document.querySelectorAll('.browse-tab').length === 2");
    assert.equal(await run("return !!document.querySelector('.browse-tab-menu');"), false, 'the menu closes after an action');
    await run("document.querySelectorAll('.browse-tab-close')[1].click();");
    await until("document.querySelectorAll('.browse-tab').length === 1");

    // Typing an address navigates the active tab; the native view is shown and placed.
    await run("const a = document.querySelector('.browse-address'); a.focus(); a.value = 'example.com'; a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));");
    await until("document.querySelector('.browse-tab.active .browse-tab-title')?.textContent === 'example.com page'");
    assert.deepEqual((await calls('navigate')).at(-1).args.slice(1), ['example.com']);
    assert.ok(await run("return document.querySelector('.browse-viewport').hidden === false;"));
    await until("window.__browseStub.calls().filter(c => c.name === 'setVisible').at(-1)?.args[0] === true");
    const rect = (await calls('setBounds')).at(-1).args[0];
    assert.ok(rect.width > 800 && rect.height > 700 && rect.x > 240, `the page box sits beside the sidebar: ${JSON.stringify(rect)}`);
    assert.equal(await run("return document.querySelector('.browse-address').value;"), 'example.com', 'the address shows the bare host');
    assert.equal(await run("return document.querySelector('.browse-blocked')?.textContent;"), '3', 'blocked count');

    // Suggestions open inside the sidebar, never over the page.
    await run("const a = document.querySelector('.browse-address'); a.focus(); a.value = 'git'; a.dispatchEvent(new Event('input'));");
    await until("document.querySelector('.browse-suggest li')");
    assert.ok(await run("return document.querySelector('.browse-side').contains(document.querySelector('.browse-suggest'));"));
    await run("document.querySelector('.browse-address').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.browse-address').blur();");

    // Site info: permissions and the ad-blocking switch write through the bridge.
    await run("document.querySelector('.browse-site-btn').click();");
    await until("document.querySelector('.browse-site')");
    await run("[...document.querySelectorAll('.browse-site .btn')].find(b => b.textContent === 'Turn off here').click();");
    await until("window.__browseStub.calls().some(c => c.name === 'setSite')");
    assert.deepEqual((await calls('setSite')).at(-1).args.slice(1), ['adblock', 'off']);
    // Pages fire tab updates all the time; the panel stays open through them.
    await run("window.__browseStub.emit('state', { activeId: 1, tabs: [{ id: 1, url: 'https://example.com/', title: 'example.com page', blocked: 4, loading: true, active: true }] });");
    await new Promise(r => setTimeout(r, 150));
    assert.ok(await run("return !!document.querySelector('.browse-site');"), 'site info survives a tab update');
    await shot('site-info');
    await run("document.querySelector('.browse-site-btn').click();");

    // A site's permission request is a strip above the page that names the site.
    await run("window.__browseStub.emit('permission', { requestId: 5, tabId: 1, origin: 'https://example.com', setting: 'camera' });");
    await until("document.querySelector('.browse-prompt')");
    assert.match(await run("return document.querySelector('.browse-prompt').textContent;"), /example\.com wants to use: Camera\. This is the site asking, not Kairos\./);
    assert.ok(await run("return document.querySelector('.browse-page').contains(document.querySelector('.browse-prompt'));"));
    await run("[...document.querySelectorAll('.browse-prompt .btn')].find(b => b.textContent === 'Allow').click();");
    assert.deepEqual((await calls('answerPermission')).at(-1).args, [5, 'allow', true]);
    assert.equal(await run("return !!document.querySelector('.browse-prompt');"), false);

    // A blocked pop-up is reported with a way to open it.
    await run("window.__browseStub.emit('event', { event: 'popup-blocked', tabId: 1, url: 'https://popup.example/' });");
    await until("document.querySelector('.browse-notice.popup')");

    // Find in page.
    await run("document.querySelector('.browse-address').blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));");
    await until("!document.querySelector('.browse-find').hidden");
    await run("const f = document.querySelector('.browse-find-input'); f.value = 'domain'; f.dispatchEvent(new Event('input'));");
    assert.equal((await calls('find')).at(-1).args[1], 'domain');

    // History, Downloads and settings replace the page, and the native view hides.
    await run("document.querySelector('[aria-label=History]').click();");
    await until("document.querySelector('.browse-internal h2')?.textContent === 'History'");
    assert.equal(await run("return document.querySelector('.browse-viewport').hidden;"), true);
    await until("window.__browseStub.calls().filter(c => c.name === 'setVisible').at(-1)?.args[0] === false");
    assert.match(await run("return document.querySelector('.browse-list').textContent;"), /A visited page/);
    await shot('history');
    await run("document.querySelector('[aria-label=Downloads]').click();");
    await until("document.querySelector('.browse-internal h2')?.textContent === 'Downloads'");
    assert.match(await run("return document.querySelector('.browse-list').textContent;"), /report\.pdf/);
    await run("document.querySelector('[aria-label=\"Close downloads\"]').click();");

    // Ask Kairos opens a strip; sharing the page is off until ticked.
    await run("document.querySelector('.browse-ask-btn').click();");
    await until("!document.querySelector('.browse-ask').hidden");
    assert.equal(await run("return document.querySelector('.browse-ask input[type=checkbox]').checked;"), false, 'the page is not shared unless the person ticks it');
    await shot('ask');
    await run("document.querySelector('[aria-label=\"Close Ask Kairos\"]').click();");

    // Tabs: a new tab and closing one.
    await run("document.querySelector('.browse-new-tab').click();");
    await until("document.querySelectorAll('.browse-tab').length === 2");
    await run("document.querySelectorAll('.browse-tab-close')[1].click();");
    await until("document.querySelectorAll('.browse-tab').length === 1");

    // A page's title reaches the screen as text, never markup.
    await run("window.__browseStub.emit('state', { activeId: 1, tabs: [{ id: 1, url: 'https://example.com/', title: '<img src=x onerror=window.__xss=1>Hi', blocked: 0, active: true }] });");
    await until("document.querySelector('.browse-tab-title')?.textContent.includes('<img')");
    assert.equal(await run("return !!document.querySelector('.browse-tab-title img') || !!window.__xss;"), false);

    // Phone width: Browse still lays out without spilling sideways.
    win.setContentSize(390, 844);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await run("return document.documentElement.scrollWidth <= innerWidth + 1;"), true, 'no sideways scroll at phone width');
    win.setContentSize(1440, 900);

    // Icons, not text characters, on the sidebar's buttons (2026-11-04).
    assert.ok(await run("return ['Collapse sidebar', 'Home', 'Back', 'Forward'].every(l => document.querySelector(`.browse-top [aria-label=\"${l}\"] svg`));"), 'line icons on the top buttons');
    // Collapsed: a rail with every open tab's icon, which switches tabs.
    await run("document.querySelector('.browse-top [aria-label=\"Collapse sidebar\"]').click();");
    await until("!document.querySelector('.browse-rail').hidden");
    const railTabs = await run("return (await window.jarvis.browse.list()).tabs.length;");
    assert.equal(await run("return document.querySelectorAll('.browse-rail-tab').length;"), railTabs, 'one icon per open tab');
    assert.ok(await run("return document.querySelector('.browse-side').getBoundingClientRect().width <= 60;"), 'the rail is narrow');
    await shot('rail');
    await run("document.querySelector('.browse-rail [aria-label=\"Show sidebar\"]').click();");
    await until("document.querySelector('.browse-rail').hidden && !document.querySelector('.browse-top').parentElement.hidden");

    // Browse's own look: a colour laid over Kairos's appearance only while Browse shows.
    const kairosSidebar = await run("return getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim();");
    await run("document.querySelector('.browse-look-btn').click();");
    await until("document.querySelector('.browse-look')");
    await run("document.querySelector('input[name=browse-look][value=color]').click();");
    await until("document.querySelector('.browse-look-swatch')");
    await run("document.querySelector('.browse-look-swatch[aria-label=Plum]').click();");
    await until("document.documentElement.dataset.appearance === 'color'");
    const plumSidebar = await run("return getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim();");
    assert.notEqual(plumSidebar, kairosSidebar, 'the look changes the sidebar');
    await shot('look-plum');
    // Chameleon: the open site's colour wins over the look.
    await run("document.querySelector('.browse-look input[type=checkbox]').click();");
    await run("window.__browseStub.emit('state', { activeId: 1, tabs: [{ id: 1, url: 'https://red.example/', title: 'Red site', color: '#8a1c1c', blocked: 0, active: true }] });");
    await until("getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim() !== " + JSON.stringify(plumSidebar));
    assert.ok(await run("return document.documentElement.hasAttribute('data-browse-chameleon');"));
    await shot('chameleon');
    // Leaving Browse gives Kairos its own appearance back; the look is kept for next time.
    await until("document.querySelector('#titlebar-modes [data-mode=kairos]')");
    await run("document.querySelector('#titlebar-modes [data-mode=kairos]').click();");
    await until("document.documentElement.dataset.appMode === 'kairos'");
    await until("getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim() === " + JSON.stringify(kairosSidebar));
    assert.equal(await run("return document.documentElement.hasAttribute('data-browse-chameleon');"), false);
    assert.equal(await run("return JSON.parse(localStorage.getItem('kairos:browse-look:v1')).color;"), '#3c2943', 'the look is saved');
    await until("document.querySelector('#titlebar-modes [data-mode=browse]')");
    await run("document.querySelector('#titlebar-modes [data-mode=browse]').click();");
    await until("document.querySelector('.browse-look-btn')");
    await run("document.querySelector('.browse-look-btn').click();");
    await until("document.querySelector('.browse-look')");
    await run("document.querySelector('.browse-look input[type=checkbox]').click(); document.querySelector('input[name=browse-look][value=kairos]').click();");
    await until("getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim() === " + JSON.stringify(kairosSidebar));

    // Links (David, 2026-11-03): outside a Kairos chat a link opens a Browse tab and switches to Browse.
    await until("document.querySelector('#titlebar-modes [data-mode=kairos]')");
    await run("document.querySelector('#titlebar-modes [data-mode=kairos]').click();");
    await until("document.documentElement.dataset.appMode === 'kairos'");
    await run("window.__browseStub.emit('openRequest', 'https://docs.example.com/guide');");
    await until("document.documentElement.dataset.appMode === 'browse'");
    assert.deepEqual((await calls('open')).at(-1).args[0], 'https://docs.example.com/guide');
    await until("document.querySelector('#titlebar-modes [data-mode=kairos]')");
    await run("document.querySelector('#titlebar-modes [data-mode=kairos]').click();");
    await until("document.documentElement.dataset.appMode === 'kairos'");
    // In a Kairos chat it still opens the chat's side pane, not Browse.
    const opensBefore = (await calls('open')).length;
    await run("import('/static/js/app.js').then(m => m.switchTab('chat'));");
    await until("document.getElementById('view-content')?.dataset.view === 'chat' && document.querySelector('.chat-layout')");
    await run("window.__browseStub.emit('openRequest', 'https://news.example/story');");
    await until("window.__browseStub.calls().some(c => c.name === 'pane.open' && c.args[0] === 'https://news.example/story')");
    assert.equal((await calls('open')).length, opensBefore, 'no Browse tab from a chat link');
    assert.equal(await run("return document.documentElement.dataset.appMode;"), 'kairos');
    // Sign-in pages leave Kairos through the system browser.
    await run("import('/static/js/browserPane.js').then(m => m.openOutside('https://auth.example.com/authorize'));");
    await until("window.__browseStub.calls().some(c => c.name === 'pane.openExternal' && c.args[0] === 'https://auth.example.com/authorize')");
    // Back into Browse for the last step.
    await until("document.querySelector('#titlebar-modes [data-mode=browse]')");
    await run("document.querySelector('#titlebar-modes [data-mode=browse]').click();");
    await until("document.querySelector('.browse-side') && document.querySelector('[aria-label=\"Back to Kairos\"]')");
    // Back to Kairos.
    await run("document.querySelector('[aria-label=\"Back to Kairos\"]').click();");
    await until("document.documentElement.dataset.appMode === 'kairos'");
    await until("window.__browseStub.calls().filter(c => c.name === 'setVisible').at(-1)?.args[0] === false");

    assert.deepEqual(errors, [], 'Browse renderer errors');
    return 73;
  } finally {
    win.destroy();
  }
};
