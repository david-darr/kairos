// Phone sidebar checks (2026-11-02, David: "bring back the sliding sidebar, app
// wide just like the claude mobile app", replacing the bottom tab bar: "the logo
// and name at the top, below that has Home, Chats, Forge, Bots, then More which
// then popup the other Tabs, at the bottom have the pfp that leads to settings
// and a New Chat button"). Run from mobile-tabs-checks.cjs, which passes its
// harness, ok/eq counters and helpers; uses only the smoke harness's synthetic
// backend.
//
// Covers: the menu button beside each top-level page's title and its absence on
// pushed and full-screen pages, the sidebar's contents, names and states, what
// each row opens, More in Kairos and in Bots, the profile and New chat, focus,
// Escape and the Tab loop, the swipe in and out, Kip's menu button, the page
// sliding aside, bottom clearance now that no bar is there, the 393x852 (59/34)
// and 375x667 (20/0) iPhone classes and a non-iPhone, reduced motion and
// desktop. Screenshots: sidebar-*.
module.exports = async function sidebarChecks(c) {
  const { demoState, js, waitFor, delay, navigate, ok, eq, rect, small, noSideways, navCurrent, menuShown, menuGone, noAvatar, MORE, shot, resize, cdp, press } = c;
  const W = 390, H = 844;
  await resize(W, H);
  const MENU = "document.querySelector('.ms-menu-btn')";
  const isOpen = () => js("document.documentElement.classList.contains('ms-drawer-open')");
  const settled = () => js("Promise.all(['#ms-drawer', '#content'].flatMap(s => document.querySelector(s).getAnimations()).map(a => a.finished.catch(() => {}))).then(() => new Promise(r => setTimeout(r, 420)))");
  const openSidebar = async () => { await menuShown(); await js(MENU + ".click()"); await waitFor("document.documentElement.classList.contains('ms-drawer-open')"); await settled(); };
  const closed = () => waitFor("!document.documentElement.classList.contains('ms-drawer-open') && document.getElementById('ms-drawer').inert");
  const row = id => `document.querySelector('.ms-drawer-row[data-drawer=${id}]')`;
  const rows = () => js("[...document.querySelectorAll('.ms-drawer-row')].filter(n => !n.hidden).map(n => n.dataset.drawer)");
  // The button sits beside the page's own title, centred on its first line, never over it or a header control.
  const besideTitle = async label => {
    // The page rises in after it renders; the button follows its title once that motion ends.
    await js("Promise.all(document.getElementById('content').getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))");
    const m = await js(`(() => { const b = ${MENU}.getBoundingClientRect(), title = document.querySelector('.ms-menu-indent'), range = document.createRange();
      if (title) range.selectNodeContents(title);
      const t = title && range.getClientRects()[0];
      const header = [...document.querySelectorAll('#view-content button, #view-content input')].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && n.getBoundingClientRect().top < b.bottom && n.getBoundingClientRect().bottom > b.top);
      return { b: { l: b.left, t: b.top, r: b.right, bt: b.bottom, w: b.width, h: b.height }, t: t && { l: t.left, t: t.top, b: t.bottom }, clash: header.filter(n => { const r = n.getBoundingClientRect(); return r.left < b.right && r.right > b.left; }).map(n => n.getAttribute('aria-label') || n.className) }; })()`);
    ok(m.t && m.b.w >= 44 && m.b.h >= 44 && m.b.r <= m.t.l - 4 && Math.abs((m.b.t + m.b.bt) / 2 - (m.t.t + m.t.b) / 2) <= 2 && !m.clash.length, `${label}: the menu button sits beside the title, clear of header controls: ${JSON.stringify(m)}`);
  };
  // After scrolling every scroller to its end, the last visible content stays above the screen's bottom edge.
  const reachesBottom = () => js(`(() => {
    const v = document.getElementById('view-content');
    for (const n of [v, ...v.querySelectorAll('*')]) if (n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = 1e6;
    const clip = n => { const r = n.getBoundingClientRect(); let t = r.top, b = r.bottom;
      for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const q = a.getBoundingClientRect(); t = Math.max(t, q.top); b = Math.min(b, q.bottom); } }
      return b - t > 0.5 ? b : null; };
    const shown = n => { for (let p = n.parentElement; p && p !== v; p = p.parentElement) if (p.matches('details:not([open])') && !p.querySelector(':scope > summary')?.contains(n)) return false;
      return n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).position !== 'fixed' && !n.closest('.ms-background, .ms-blur, .dither-canvas, [inert], .ms-activity'); };
    const probe = document.createElement('i'); probe.style.cssText = 'position:fixed;height:var(--mobile-safe-bottom, env(safe-area-inset-bottom, 0px))'; document.body.append(probe); const inset = probe.getBoundingClientRect().height; probe.remove();
    const page = document.getElementById('content').getBoundingClientRect().bottom;
    const last = [...v.querySelectorAll('*')].filter(n => shown(n) && (!n.children.length || n.matches('button, input, textarea, select, img, svg, canvas'))).map(n => clip(n)).filter(b => b !== null).sort((a, b) => b - a)[0];
    v.scrollTo?.(0, 0); for (const n of v.querySelectorAll('*')) if (n.scrollTop) n.scrollTop = 0;
    return { last, edge: page - inset };
  })()`);
  const priorBots = { live: demoState.botsLive, attention: demoState.botsAttention };
  demoState.botsLive = true; demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };

  // ---- 1. The menu button on a top-level page; the sidebar closed ------------------------------
  await navigate('home'); await menuShown();
  ok(await noAvatar(), 'No avatar, hamburger or tab bar from earlier designs');
  ok(await js("!document.querySelector('.ms-tabbar, .ms-tabbar-create')"), 'The bottom tab bar and its + are gone');
  eq(await js(`[${MENU}.getAttribute('aria-label'), ${MENU}.getAttribute('aria-haspopup'), ${MENU}.getAttribute('aria-controls'), ${MENU}.getAttribute('aria-expanded')]`), ['Open menu', 'dialog', 'ms-drawer', 'false'], 'The menu button names the sidebar it opens');
  ok(await js(`${MENU}.querySelector('svg')?.getAttribute('aria-hidden') === 'true'`), 'Its glyph is decorative');
  await besideTitle('Home');
  ok(await js("(() => { const d = document.getElementById('ms-drawer'); return d.inert && d.getAttribute('aria-hidden') === 'true' && !d.hasAttribute('aria-modal') && getComputedStyle(d).visibility === 'hidden'; })()"), 'Closed, the sidebar is hidden, inert and not modal');
  ok(await js("getComputedStyle(document.getElementById('content')).transform === 'none'"), 'Closed, the page is not moved');

  // ---- 2. Open: the brand, the rows, the bottom, focus ----------------------------------------
  await openSidebar();
  const open = await js(`(() => { const d = document.getElementById('ms-drawer'), r = d.getBoundingClientRect(), c = document.getElementById('content'), cr = c.getBoundingClientRect(), s = document.querySelector('.ms-drawer-scrim').getBoundingClientRect();
    return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), label: d.getAttribute('aria-label'), focus: document.activeElement === d, expanded: ${MENU}.getAttribute('aria-expanded'),
      brand: d.querySelector('.ms-drawer-brand').textContent.trim(), mark: !!d.querySelector('.ms-drawer-brand svg[aria-hidden=true]'),
      drawer: [r.left, r.width], page: [Math.round(cr.left), parseFloat(getComputedStyle(c).borderTopLeftRadius)], scrim: [Math.round(s.left), Math.round(s.right)], contentInert: c.inert,
      labels: [...d.querySelectorAll('.ms-drawer-row:not([hidden]) .ms-drawer-label')].map(n => n.textContent), icons: [...d.querySelectorAll('.ms-drawer-row:not([hidden]) > svg')].every(n => n.getAttribute('aria-hidden') === 'true'),
      current: [...d.querySelectorAll('.ms-drawer-row[aria-current=page]')].map(n => n.dataset.drawer),
      profile: { name: d.querySelector('.ms-drawer-name').textContent, initial: d.querySelector('.ms-drawer-avatar').textContent, label: d.querySelector('.ms-drawer-profile').getAttribute('aria-label') },
      account: document.querySelector('.sidebar-user-name')?.textContent, avatar: document.querySelector('.sidebar-avatar')?.textContent, create: d.querySelector('.ms-drawer-new').textContent.trim(),
      order: [...d.querySelectorAll('.ms-drawer-brand, .ms-drawer-nav, .ms-drawer-foot')].map(n => Math.round(n.getBoundingClientRect().top)) }; })()`);
  eq([open.role, open.modal, open.label, open.focus, open.expanded], ['dialog', 'true', 'Menu', true, 'true'], 'Open, the sidebar is a modal dialog named Menu with focus on it');
  eq(open.brand, 'Kairos', 'The Kairos mark and name lead the sidebar');
  ok(open.mark, 'The mark is decorative');
  eq(await rows(), ['home', 'chats', 'forge', 'bots', 'more'], 'Home, Chats, Forge, Bots, then More');
  eq(open.labels, ['Home', 'Chats', 'Forge', 'Bots', 'More'], 'Each row carries its name');
  ok(open.icons, 'Each row has a decorative icon');
  eq(open.current, ['home'], 'Home is the current row on the dashboard');
  ok(open.drawer[0] === 0 && open.drawer[1] >= 280 && open.drawer[1] <= 330 && open.page[0] === Math.round(open.drawer[1]) && open.page[1] >= 24 && open.scrim[0] === open.page[0] && open.scrim[1] === W && open.contentInert,
    'The page slides aside by the sidebar width, rounded, dimmed and inert: ' + JSON.stringify(open));
  ok(open.profile.name === open.account && open.profile.initial === open.avatar && open.profile.label === `${open.account}, Settings`, 'The profile shows the account initial and name and says it opens Settings: ' + JSON.stringify(open.profile));
  eq(open.create, 'New chat', 'New chat sits at the bottom');
  ok(open.order[0] < open.order[1] && open.order[1] < open.order[2], 'Brand, rows, then the bottom, top to bottom');
  eq(await small('#ms-drawer button'), [], 'Sidebar controls are 44px targets');
  ok(await js("![...document.querySelectorAll('#ms-drawer *')].some(n => n.childElementCount === 0 && n.textContent.includes(String.fromCharCode(8212)))"), 'Sidebar copy has no em dash');
  await shot('sidebar-open');
  // The Tab loop: from the sidebar to the first row, around the end and back.
  await press('Tab');
  eq(await js("document.activeElement?.dataset?.drawer"), 'home', 'Tab from the sidebar reaches Home');
  await js("document.querySelector('.ms-drawer-new').focus()"); await press('Tab');
  eq(await js("document.activeElement?.dataset?.drawer"), 'home', 'Tab from New chat wraps to Home');
  await press('Escape'); await closed();
  ok(await js(`document.activeElement === ${MENU} && ${MENU}.getAttribute('aria-expanded') === 'false'`), 'Escape closes the sidebar and returns focus to the menu button');
  await settled();
  ok(await js("getComputedStyle(document.getElementById('content')).transform === 'none' && !document.getElementById('content').inert"), 'Closed again, the page is back in place and usable');
  await openSidebar(); await js("document.querySelector('.ms-drawer-scrim').click()"); await closed();
  ok(true, 'A tap on the dimmed page closes the sidebar');

  // ---- 3. What each row opens -------------------------------------------------------------------
  const via = async (id, until) => { await openSidebar(); await js(row(id) + ".click()"); await waitFor(until); await closed(); await delay(300); };
  await via('chats', "document.documentElement.dataset.view === 'mobileLaunch' && !!document.querySelector('.ms-shell:not([hidden])')");
  eq(await navCurrent(), 'chats', 'Chats opens the chat workspace');
  await besideTitle('Chats');
  await js("document.getElementById('ms-tab-0').click()"); await delay(300);
  await via('chats', "document.getElementById('ms-tab-1')?.getAttribute('aria-selected') === 'true'");
  ok(true, 'Chats again, on the workspace, shows the list of chats');
  await via('forge', "document.documentElement.dataset.appMode === 'forge' && !!document.querySelector('.mf-dashboard')");
  eq(await navCurrent(), 'forge', 'Forge opens Forge Home');
  await besideTitle('Forge Home');
  await via('bots', "document.documentElement.dataset.appMode === 'bots' && document.documentElement.dataset.view === 'botsHome'");
  eq(await navCurrent(), 'bots', 'Bots opens the roster');
  await besideTitle('Bots');
  await via('home', "document.documentElement.dataset.appMode === 'kairos' && document.documentElement.dataset.view === 'home' && !!document.querySelector('.dashboard-content')");
  eq(await navCurrent(), 'home', 'Home returns to Kairos and the dashboard');
  ok(await js("!document.querySelector('.ms-drawer-row[data-drawer=agents]') && !document.querySelector('#nav .nav-item[data-tab=agents]')"), 'There is no Agents row');

  // ---- 4. The Home badge -------------------------------------------------------------------------
  await openSidebar();
  const badge = await js(`(async () => { const { badgeCounts } = await import('/static/js/mobileActivity.js'); const counts = badgeCounts(), n = ${row('home')}, b = n.querySelector('.ms-drawer-badge');
    return { counts, badge: b && !b.hidden ? b.textContent : '', label: n.getAttribute('aria-label'), others: document.querySelectorAll('.ms-drawer-row:not([data-drawer=home]):not([data-drawer=bots]) .ms-drawer-badge:not([hidden])').length }; })()`);
  const homeCount = badge.counts.need || badge.counts.live;
  ok(homeCount > 0 && badge.badge === String(homeCount) && badge.label === `Home, ${homeCount} ${badge.counts.need ? 'need you' : 'working'}`, 'Home carries the needs-you badge and says it: ' + JSON.stringify(badge));
  eq(badge.others, 0, 'Rows without news carry no badge');
  await shot('sidebar-badge');

  // ---- 5. More: every other Kairos tab, in any mode ----------------------------------------------
  await js(row('more') + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(350);
  ok(!(await isOpen()), 'More closes the sidebar as its sheet opens');
  const more = await js(`(() => { const s = document.querySelector('.ms-more-sheet[open]');
    return { heading: s.querySelector('.ms-sheet-heading')?.textContent, modal: s.getAttribute('aria-modal'), groups: [...s.querySelectorAll('.ms-tab-group')].map(g => [g.querySelector('.ms-group-label').textContent, [...g.querySelectorAll('.ms-tab-tile')].map(t => t.dataset.tab)]),
      nav: [...document.querySelectorAll('#nav .nav-item')].map(n => n.dataset.tab), modeSwitch: !!s.querySelector('.ms-mode-switch'), profile: !!s.querySelector('.ms-profile-row'), settings: !!s.querySelector('.ms-settings-row') }; })()`);
  eq([more.heading, more.modal], ['More', 'true'], 'More opens its modal sheet');
  eq(more.groups.flatMap(g => g[1]), more.nav.filter(t => !['home', 'chat', 'design', 'designs'].includes(t)), 'More holds every Kairos tab the sidebar does not, in sidebar order: ' + JSON.stringify(more.groups));
  eq(more.groups.map(g => g[0]), ['Workspace', 'Intelligence'], 'Grouped as Settings > Layout groups them');
  ok(!more.modeSwitch && more.profile && more.settings, 'The sidebar replaces the mode switch; the account and Settings stay in More');
  await shot('sidebar-more');
  await js("document.querySelector('.ms-more-sheet .ms-tab-tile[data-tab=cookbook]').click()");
  await waitFor("document.documentElement.dataset.view === 'cookbook' && !document.querySelector('.ms-more-sheet[open]')"); await menuShown();
  eq(await navCurrent(), 'more', 'A tab opened from More marks More');
  await besideTitle('Cookbook');
  // From Bots: the bots' own lists first, then the same Kairos tabs; a Kairos tab switches back to Kairos.
  await navigate('botsHome'); await waitFor("document.documentElement.dataset.appMode === 'bots' && !!document.querySelector('.bots-home')"); await menuShown();
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(350);
  const botsMore = await js("[...document.querySelectorAll('.ms-more-sheet[open] .ms-tab-group')].map(g => [g.dataset.group, [...g.querySelectorAll('.ms-tab-tile')].map(t => t.dataset.tab)])");
  eq(botsMore[0], ['bots', ['botsChats', 'botsInbox']], 'In Bots, More leads with the bots’ Chats and Inbox');
  eq(botsMore.slice(1).flatMap(g => g[1]), more.groups.flatMap(g => g[1]), 'In Bots, More still lists every Kairos tab');
  await shot('sidebar-more-bots');
  await js("document.querySelector('.ms-more-sheet .ms-tab-tile[data-tab=botsChats]').click()");
  await waitFor("!!document.querySelector('.ms-bots-sheet[open] .ms-bots-list-host > *')");
  ok(true, 'Chats opens the bots’ list sheet');
  await js("document.querySelector('.ms-bots-sheet').close()"); await delay(200);
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(300);
  await js("document.querySelector('.ms-more-sheet .ms-tab-tile[data-tab=calendar]').click()");
  await waitFor("document.documentElement.dataset.appMode === 'kairos' && document.documentElement.dataset.view === 'calendar'"); await menuShown();
  ok(true, 'A Kairos tab from Bots’ More switches back to Kairos');

  // ---- 6. The profile opens Settings; New chat opens a new chat -----------------------------------
  await openSidebar(); await js("document.querySelector('.ms-drawer-profile').click()");
  await waitFor("document.querySelector('.settings-mobile-page')?.dataset.mobileView === 'list'"); await closed();
  ok(true, 'The profile opens Settings');
  await menuGone(); ok(true, 'Settings is a pushed page with its own Back: no menu button');
  await js("document.querySelector('.settings-mobile-back').click()"); await waitFor("!document.querySelector('.settings-mobile-page') && document.documentElement.dataset.view === 'calendar'"); await menuShown();
  await openSidebar(); await js("document.querySelector('.ms-drawer-new').click()");
  await waitFor("!!document.querySelector('.ms-conversation:not(.ms-launch-chat) .ms-composer, .ms-live-chat .ms-composer, .ms-conversation .ms-composer')"); await closed();
  eq(await navCurrent(), 'chats', 'New chat opens a conversation under Chats');
  await menuGone(); ok(true, 'A conversation keeps its own Back: no menu button');

  // ---- 7. Pushed and full-screen pages: no menu button; the swipe still opens the sidebar ----------
  const pushed = [
    ['a conversation', () => navigate('chat', { sessionId: 's1' }), "!!document.querySelector('.ms-conversation .ms-composer')"],
    ['a bot page', () => navigate('agents', { agentId: 'a1' }), "!!document.querySelector('.bots-composer-input')"],
    ['a Forge session', async () => { await navigate('forgeHome', { mobilePage: 1 }); await waitFor("document.querySelectorAll('#mf-sessions .ms-history-main').length > 0"); await delay(300); await js("document.querySelector('#mf-sessions .ms-history-main').click()"); }, "!!document.querySelector('.mf-session .forge-transcript-composer')"],
    ['the Library editor', async () => { await navigate('library', { section: 'documents' }); await waitFor("!!document.querySelector('.library-document-card')"); await js("document.querySelector('.library-document-card').click()"); }, "!!document.querySelector('.library-editor')"],
  ];
  for (const [label, go, ready] of pushed) {
    await go(); await waitFor(ready); await delay(300);
    await menuGone(); ok(true, `${label}: no menu button over its own back control`);
  }
  await navigate('notes'); await waitFor("!!document.querySelector('.ms-page-search input')"); await menuShown();
  await js("(() => { window.__realVV = window.visualViewport; Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => ({ height: innerHeight - 300, offsetTop: 0, width: innerWidth, addEventListener() {}, removeEventListener() {} }) }); dispatchEvent(new Event('resize')); })()");
  await menuGone(); ok(true, 'The keyboard hides the menu button');
  await js("(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.__realVV }); dispatchEvent(new Event('resize')); })()"); await menuShown();

  // ---- 8. The swipe: right from the left side opens, left closes --------------------------------------
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  const swipe = async (x, y, dx, dy = 0) => {
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) { await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 8, y: y + dy * i / 8 }] }); await delay(16); }
    const mid = await js("[document.documentElement.classList.contains('ms-drawer-dragging'), document.documentElement.style.getPropertyValue('--ms-drawer-x')]");
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await delay(450);
    return mid;
  };
  try {
    await navigate('tasks'); await menuShown(); await delay(300);
    await swipe(8, 420, 220); ok(!(await isOpen()), 'The outermost 16px stays with the system Back gesture');
    await swipe(60, 420, 20, 200); ok(!(await isOpen()), 'A vertical drag scrolls the page instead');
    const mid = await swipe(60, 420, 220);
    ok(mid[0] && parseFloat(mid[1]) > 100, 'The page follows the finger while dragging: ' + JSON.stringify(mid));
    ok(await isOpen(), 'A swipe right from the left side opens the sidebar');
    await settled(); await shot('sidebar-swiped-open');
    await swipe(360, 420, -220); await closed();
    ok(await js("!document.documentElement.classList.contains('ms-drawer-dragging') && !document.documentElement.style.getPropertyValue('--ms-drawer-x')"), 'A swipe left on the page closes it and leaves nothing behind');
    await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('.ms-conversation .ms-composer')"); await delay(300);
    await swipe(60, 300, 220); ok(await isOpen(), 'A pushed page opens the sidebar by swipe too');
    await js("document.querySelector('.ms-drawer-scrim').click()"); await closed();
  } finally { await cdp('Emulation.setTouchEmulationEnabled', { enabled: false }); }

  // ---- 9. Kip: its own menu button opens the sidebar ------------------------------------------------
  const kip = await js("fetch('/api/agents').then(r => r.json()).then(list => list.find(b => b.builtin === 'front_desk')?.id || null)");
  if (kip) {
    await navigate('botsShell', { agentId: kip }); await waitFor("!!document.querySelector('.bots-frontdesk .fd-menu')"); await delay(400);
    await menuGone();
    eq(await js("[document.querySelector('.fd-menu').getAttribute('aria-label'), document.querySelector('.fd-menu').getAttribute('aria-controls')]"), ['Open menu', 'ms-drawer'], 'Kip’s menu button names the sidebar');
    await js("document.querySelector('.fd-menu').focus(); document.querySelector('.fd-menu').click()"); await waitFor("document.documentElement.classList.contains('ms-drawer-open')"); await settled();
    eq(await navCurrent(), 'bots', 'From Kip, Bots is current');
    await shot('sidebar-from-kip');
    await press('Escape'); await closed();
    ok(await js("document.activeElement === document.querySelector('.fd-menu') && document.querySelector('.fd-menu').getAttribute('aria-expanded') === 'false'"), 'Escape returns focus to Kip’s menu button');
  }
  await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'"); await menuShown();

  // ---- 10. Every top-level tab: the button, the current row, content to the bottom edge -------------
  for (const [tab, want] of [['home', 'home'], ['chat', 'chats'], ['calendar', 'more'], ['notes', 'more'], ['library', 'more'], ['email', 'more'], ['tasks', 'more'], ['cookbook', 'more'], ['tool-store', 'more'], ['school', 'more']]) {
    await navigate(tab); await delay(400); await menuShown();
    eq(await navCurrent(), want, `${tab}: the sidebar marks ${want}`);
    await besideTitle(tab);
    if (tab !== 'chat') {
      const reach = await reachesBottom();
      ok(!reach.last || reach.last <= reach.edge + 0.5, `${tab}: the last content scrolls clear of the bottom edge: ${JSON.stringify(reach)}`);
    }
    ok(await noSideways(), `${tab}: nothing scrolls sideways`);
  }

  // ---- 11. Device classes: iPhone 393x852 (59/34), iPhone 375x667 (20/0), and a non-iPhone ---------
  // As in mobile-tabs-checks: the window is the layout viewport, --ms-page-height the true screen.
  for (const [name, w, layout, screen, top, bottom, nudge] of [['iphone-393x852', 393, 793, 852, 59, 34, 12], ['iphone-375x667', 375, 647, 667, 20, 0, 12], ['other-393x852', 393, 852, 852, 47, 34, 0]]) {
    await resize(w, layout);
    await js(`(() => { const s = document.documentElement.style; s.setProperty('--ms-page-height', '${screen}px'); s.setProperty('--native-safe-top', '${top}px'); s.setProperty('--native-safe-bottom', '${bottom}px'); s.setProperty('--ms-ios-nudge', '${nudge}px'); })()`);
    for (const tab of ['home', 'chat', 'calendar']) {
      await navigate(tab); await delay(500); await menuShown();
      const b = await rect('.ms-menu-btn');
      ok(b.t >= top + nudge - 0.5, `${name} ${tab}: the menu button clears the status bar: ${JSON.stringify(b)}`);
      await besideTitle(`${name} ${tab}`);
    }
    await openSidebar();
    const g = await js(`(() => { const d = document.getElementById('ms-drawer').getBoundingClientRect(), brand = document.querySelector('.ms-drawer-brand').getBoundingClientRect(), foot = document.querySelector('.ms-drawer-foot').getBoundingClientRect();
      return { top: d.top, bottom: Math.round(d.bottom), brand: brand.top, foot: Math.round(foot.bottom) }; })()`);
    ok(g.top === 0 && g.bottom === screen && g.brand >= top - 0.5 && g.foot <= screen - Math.max(16, bottom) + 1, `${name}: the sidebar spans the screen, its brand below the status bar and its bottom above the home indicator: ${JSON.stringify(g)}`);
    await js("document.querySelector('.ms-drawer-scrim').click()"); await closed();
  }
  // Pictures of both iPhone classes: the window is the whole screen here so nothing is cropped.
  for (const [name, w, screen, top, bottom] of [['iphone-393x852', 393, 852, 59, 34], ['iphone-375x667', 375, 667, 20, 0]]) {
    await resize(w, screen);
    await js(`(() => { const s = document.documentElement.style; s.removeProperty('--ms-page-height'); s.setProperty('--native-safe-top', '${top}px'); s.setProperty('--native-safe-bottom', '${bottom}px'); s.setProperty('--ms-ios-nudge', '12px'); })()`);
    for (const tab of ['home', 'chat', 'calendar']) { await navigate(tab); await delay(600); await menuShown(); await shot(`sidebar-${name}-${tab === 'chat' ? 'chats' : tab}`); }
    await openSidebar(); await shot(`sidebar-${name}-open`);
    await js("document.querySelector('.ms-drawer-scrim').click()"); await closed();
    await navigate('forgeHome'); await waitFor("!!document.querySelector('.mf-dashboard')"); await delay(500); await menuShown(); await shot(`sidebar-${name}-forge-home`);
    await navigate('botsHome'); await waitFor("!!document.querySelector('.bots-home')"); await delay(500); await menuShown(); await shot(`sidebar-${name}-bots`);
    await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
  }
  await js("(() => { const s = document.documentElement.style; s.removeProperty('--ms-page-height'); s.removeProperty('--native-safe-top'); s.removeProperty('--ms-ios-nudge'); s.setProperty('--native-safe-bottom', '0px'); })()");
  await resize(W, H);

  // ---- 12. Reduced motion: no slide ---------------------------------------------------------------
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await navigate('home'); await menuShown();
  ok(await js("['#ms-drawer', '.ms-drawer-scrim', '#content'].every(s => /^0s(, 0s)*$/.test(getComputedStyle(document.querySelector(s)).transitionDuration))"), 'Reduced motion: the sidebar and the page do not slide');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // ---- 13. Desktop has neither; leaving the phone width closes the sidebar ----------------------------
  await openSidebar();
  await resize(1440, 900); await delay(300);
  ok(await js("!document.documentElement.classList.contains('ms-drawer-open') && !document.getElementById('ms-drawer').getClientRects().length && !document.querySelector('.ms-menu-btn').getClientRects().length && getComputedStyle(document.getElementById('content')).transform === 'none'"), 'Desktop shows no phone sidebar or menu button, and a wide window closes it');
  await resize(W, H); await menuShown();
  eq(await navCurrent(), 'home', 'Back at phone width the menu button returns');
  for (const [key, value] of [['botsLive', priorBots.live], ['botsAttention', priorBots.attention]]) { if (value === undefined) delete demoState[key]; else demoState[key] = value; }
};
