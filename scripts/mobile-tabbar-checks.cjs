// Phone tab bar checks (2026-10-22, David: "a bottom of the screen ios-liquid
// glass card showcasing Home, Chats, Agents, Calendar, and More, with more
// producing a popup with the rest of the other tabs"). Run from
// mobile-tabs-checks.cjs, which passes its harness, ok/eq counters and helpers;
// uses only the smoke harness's synthetic backend.
//
// Covers: the bar on every tab and its selected state, the sliding glass pill,
// the glass itself, icons, labels and badges, what each item opens, More's
// contents and the mode switch, Forge mode's items, the bar stepping aside in
// conversations, sessions and pushed pages and sliding back, docks above it,
// the 393x852 (59/34) and 375x667 (20/0) iPhone classes and a non-iPhone,
// reduced motion, desktop, and that the avatar is gone. Screenshots: tabbar-*.
module.exports = async function tabBarChecks(c) {
  const { js, waitFor, delay, navigate, ok, eq, rect, hit, small, noSideways, barState, barCurrent, barShown, barGone, noAvatar, MORE, shot, resize, cdp, overflow } = c;
  const W = 390, H = 844;
  await resize(W, H);
  const items = () => js("[...document.querySelectorAll('.ms-tabbar-item')].map(n => n.dataset.tabbar)");
  const labels = () => js("[...document.querySelectorAll('.ms-tabbar-item')].map(n => n.querySelector('.ms-tabbar-label').textContent)");
  const tap = id => js(`document.querySelector('.ms-tabbar [data-tabbar=${id}]').click()`);
  // The selected pill has finished sliding and sits on the current item.
  const pillOn = async () => {
    await waitFor("document.querySelector('.ms-tabbar-pill').getAnimations().length === 0");
    return js(`(() => { const p = document.querySelector('.ms-tabbar-pill').getBoundingClientRect(), c = document.querySelector('.ms-tabbar [aria-current=page]')?.getBoundingClientRect(); return !!c && Math.abs(p.left - c.left) <= 1.5 && Math.abs(p.right - c.right) <= 1.5 && p.top >= c.top - 1 && p.bottom <= c.bottom + 1; })()`);
  };
  // After scrolling every scroller to its end, no visible content runs under the bar.
  const clearsBar = () => js(`(() => {
    const v = document.getElementById('view-content'), barTop = document.querySelector('.ms-tabbar').getBoundingClientRect().top;
    for (const n of [v, ...v.querySelectorAll('*')]) if (n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = 1e6;
    const clip = n => { const r = n.getBoundingClientRect(); let t = r.top, b = r.bottom;
      for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const q = a.getBoundingClientRect(); t = Math.max(t, q.top); b = Math.min(b, q.bottom); } }
      return b - t > 0.5 ? b : null; };
    const shown = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).position !== 'fixed' && !n.closest('.ms-background, .ms-blur, [inert], .ms-activity');
    const nodes = [...v.querySelectorAll('*')].filter(n => shown(n) && (!n.children.length || n.matches('button, input, textarea, select, img, svg, canvas, .agents-messenger, .forge-panel, .ms-history-dock, .ms-launch-composer, .chat-composer-dock')));
    const bottoms = nodes.map(n => ({ b: clip(n), n: String(n.className || n.tagName).slice(0, 40) })).filter(x => x.b !== null).sort((a, b) => b.b - a.b);
    v.scrollTo?.(0, 0); for (const n of v.querySelectorAll('*')) if (n.scrollTop) n.scrollTop = 0;
    return { last: bottoms[0], barTop };
  })()`);
  const geometry = async (label, screen, gap, width) => {
    const bar = await rect('.ms-tabbar');
    ok(bar && Math.abs(bar.b - (screen - gap)) <= 1 && bar.h === 62 && Math.abs(bar.l - 16) <= 1 && Math.abs(bar.r - (width - 16)) <= 1,
      `${label}: the bar floats ${gap}px above the true bottom, 62px tall, 16px from each side: ${JSON.stringify(bar)}`);
    return bar;
  };

  // ---- 1. The bar itself: items, icons, labels, glass ------------------------------------------
  await navigate('home'); await barShown();
  ok(await noAvatar(), 'The top-left avatar and the hamburger are gone');
  eq(await items(), ['home', 'chats', 'agents', 'calendar', 'more'], 'Kairos bar items');
  eq(await labels(), ['Home', 'Chats', 'Agents', 'Calendar', 'More'], 'Each item carries its label');
  ok(await js("[...document.querySelectorAll('.ms-tabbar-item')].every(n => n.querySelector(':scope > svg')?.getAttribute('aria-hidden') === 'true')"), 'Each item has a decorative SVG icon');
  ok(await js("['home', 'chat', 'agents', 'calendar'].every((tab, i) => document.querySelector(`#nav .nav-item[data-tab=${tab}] svg`).innerHTML === document.querySelectorAll('.ms-tabbar-item > svg')[i].innerHTML)"), 'The icons are the app\'s own nav icons');
  eq(await js("[document.querySelector('.ms-tabbar').tagName, document.querySelector('.ms-tabbar').getAttribute('aria-label')]"), ['NAV', 'Tabs'], 'The bar is a navigation landmark');
  eq(await js("[...document.querySelectorAll('.ms-tabbar-item')].filter(n => n.getAttribute('aria-current') === 'page').map(n => n.dataset.tabbar)"), ['home'], 'Exactly one item is current');
  eq(await small('.ms-tabbar-item'), [], 'Bar items are 44px targets');
  eq(await js("[document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-haspopup'), document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-controls')]"), ['dialog', 'ms-more-sheet'], 'More announces its sheet');
  const glass = await js(`(() => { const g = document.querySelector('.ms-tabbar-glass'), s = getComputedStyle(g), a = getComputedStyle(g, '::after'), b = getComputedStyle(g, '::before'), p = getComputedStyle(document.querySelector('.ms-tabbar-pill'));
    return { filter: s.backdropFilter || s.webkitBackdropFilter, radius: s.borderTopLeftRadius, shadow: s.boxShadow, bg: s.backgroundColor,
      specular: a.content !== 'none' && a.backgroundImage.includes('gradient') && a.height === '1px' && a.top === '0px', sheen: b.backgroundImage.includes('gradient'),
      pill: { radius: p.borderTopLeftRadius, shadow: p.boxShadow, transition: p.transitionProperty + ' ' + p.transitionDuration } }; })()`);
  ok(/blur\(22px\)/.test(glass.filter) && /saturate\(1\.9\)/.test(glass.filter), 'Liquid glass: backdrop blur and saturation: ' + glass.filter);
  ok(/(rgba\(.*, 0?\.\d+\)|\/ 0?\.\d+\))$/.test(glass.bg), 'The glass is translucent: ' + glass.bg);
  ok(glass.specular && glass.sheen && glass.shadow.includes('inset'), 'A bright specular top edge and a soft sheen: ' + JSON.stringify(glass));
  ok(parseFloat(glass.radius) >= 31 && parseFloat(glass.pill.radius) >= 20 && glass.pill.shadow.includes('inset'), 'A capsule with a glass pill inside: ' + JSON.stringify(glass));
  ok(/transform/.test(glass.pill.transition) && !/^0s$/.test(glass.pill.transition.split(' ').at(-1)), 'The pill slides between items: ' + glass.pill.transition);
  ok(await pillOn(), 'The pill sits on Home');
  ok(await js("!document.getElementById('mobile-menu-btn') && !document.querySelector('#ms-workspace-sheet')"), 'No avatar button and no workspace sheet in the page');
  ok(await js("![...document.querySelectorAll('.ms-tabbar *')].some(n => n.childElementCount === 0 && n.textContent.includes(String.fromCharCode(8212)))"), 'Bar copy has no em dash');

  // ---- 2. Every tab: the bar shows, marks the right item, and content clears it ------------------
  for (const [tab, options, want] of [['home', {}, 'home'], ['chat', {}, 'chats'], ['agents', {}, 'agents'], ['calendar', {}, 'calendar'], ['notes', {}, 'more'], ['library', {}, 'more'],
    ['email', {}, 'more'], ['tasks', {}, 'more'], ['cookbook', {}, 'more'], ['tool-store', {}, 'more'], ['school', {}, 'more']]) {
    await navigate(tab, options); await delay(400); await barShown();
    eq(await barCurrent(), want, `${tab}: the bar marks ${want}`);
    ok(await noAvatar(), `${tab}: no avatar`);
    await geometry(tab, H, 12, W);
    ok(await pillOn(), `${tab}: the pill sits on ${want}`);
    const clear = await clearsBar();
    ok(!clear.last || clear.last.b <= clear.barTop + 0.5, `${tab}: the last content scrolls clear of the bar: ${JSON.stringify(clear)}`);
    // A dock (search, Calendar's Today / Month) sits above the bar, never under it.
    const dock = await rect('.ms-dock');
    if (dock) ok(!hit(dock, await rect('.ms-tabbar')) && dock.b <= (await rect('.ms-tabbar')).t - 8, `${tab}: the dock sits above the bar: ${JSON.stringify(dock)}`);
    ok(await noSideways(), `${tab}: nothing scrolls sideways`);
  }
  // The Chats list's own search dock sits above the bar too.
  await navigate('chat', { mobilePage: 1 }); await barShown(); await delay(400);
  const historyDock = await rect('.ms-history-dock');
  ok(historyDock && historyDock.b <= (await rect('.ms-tabbar')).t - 8, 'The Chats search dock sits above the bar: ' + JSON.stringify(historyDock));
  eq(await barCurrent(), 'chats', 'The Chats list keeps Chats current');

  // ---- 3. What each item opens --------------------------------------------------------------
  await navigate('home'); await barShown();
  await tap('chats'); await waitFor("document.documentElement.dataset.view === 'mobileLaunch' && !!document.querySelector('.ms-shell:not([hidden])')"); await delay(300);
  eq(await barCurrent(), 'chats', 'Chats opens the chat workspace');
  await js("document.getElementById('ms-tab-0').click()"); await delay(300);
  await tap('chats'); await waitFor("document.getElementById('ms-tab-1').getAttribute('aria-selected') === 'true'");
  ok(true, 'Chats again, on the workspace, shows the list of chats');
  await tap('agents'); await waitFor("document.documentElement.dataset.view === 'agents'"); await barShown();
  eq(await barCurrent(), 'agents', 'Agents opens Agents');
  await tap('calendar'); await waitFor("document.documentElement.dataset.view === 'calendar'"); await barShown();
  eq(await barCurrent(), 'calendar', 'Calendar opens Calendar');
  await tap('chats'); await waitFor("document.documentElement.dataset.view === 'mobileLaunch'"); await delay(300);
  ok(await js("document.getElementById('ms-tab-1').getAttribute('aria-selected') === 'true'"), 'Chats returns to the page it was last on');
  await tap('home'); await waitFor("document.documentElement.dataset.view === 'home' && !!document.querySelector('.dashboard-content')"); await barShown();
  eq(await barCurrent(), 'home', 'Home opens the dashboard');
  await js("document.getElementById('view-content').scrollTop = 400"); await delay(100);
  await tap('home'); await waitFor("document.getElementById('view-content').scrollTop === 0");
  ok(true, 'Home again scrolls the dashboard back to its top');

  // ---- 4. Badges carried over from the avatar ----------------------------------------------
  const badges = await js(`(async () => { const { badgeCounts } = await import('/static/js/mobileActivity.js'); const counts = badgeCounts();
    const read = id => { const n = document.querySelector('.ms-tabbar [data-tabbar=' + id + ']'), b = n.querySelector('.ms-tabbar-badge'); return { badge: b && !b.hidden ? b.textContent : '', label: n.getAttribute('aria-label') }; };
    return { counts, home: read('home'), agents: read('agents'), nav: document.querySelector('#nav .nav-item[data-tab=agents] .nav-badge')?.textContent.trim() || '' }; })()`);
  const homeCount = badges.counts.need || badges.counts.live;
  ok(homeCount > 0 && badges.home.badge === String(homeCount) && badges.home.label === `Home, ${homeCount} ${badges.counts.need ? 'need you' : 'working'}`, 'Home carries the needs-you badge the avatar had, and says it: ' + JSON.stringify(badges));
  ok(badges.nav && badges.agents.badge === badges.nav && badges.agents.label === `Agents, ${badges.nav} waiting on you`, 'Agents carries the sidebar inbox badge, and says it: ' + JSON.stringify(badges));
  eq(await js("[...document.querySelectorAll('.ms-tabbar [data-tabbar=chats] .ms-tabbar-badge:not([hidden]), .ms-tabbar [data-tabbar=calendar] .ms-tabbar-badge:not([hidden])')].length"), 0, 'Items without news carry no badge');
  await shot('tabbar-badges');

  // ---- 5. More: every other tab, the mode switch, Settings and profile ----------------------------
  await js(MORE + ".focus(); " + MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(350);
  const more = await js(`(() => { const s = document.querySelector('.ms-more-sheet[open]'), top = n => n?.getBoundingClientRect().top ?? null;
    return { label: s.getAttribute('aria-label'), heading: s.querySelector('.ms-sheet-heading')?.textContent, modal: s.getAttribute('aria-modal'), expanded: document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-expanded'),
      groups: [...s.querySelectorAll('.ms-tab-group')].map(g => [g.querySelector('.ms-group-label').textContent, [...g.querySelectorAll('.ms-tab-tile')].map(t => t.dataset.tab)]),
      nav: [...document.querySelectorAll('#nav .nav-item')].map(n => n.dataset.tab),
      mode: !!s.querySelector('.ms-mode-row .ms-mode-switch[role=radiogroup]'), modeFirst: top(s.querySelector('.ms-mode-row')) < top(s.querySelector('.ms-tab-group')),
      profile: s.querySelector('.ms-profile-row') && { initial: s.querySelector('.ms-profile-initial').textContent, name: s.querySelector('.ms-profile-name').textContent, expanded: s.querySelector('.ms-profile-row').getAttribute('aria-expanded') },
      account: document.querySelector('.sidebar-user-name')?.textContent, avatar: document.querySelector('.sidebar-avatar')?.textContent,
      settings: !!s.querySelector('.ms-settings-row svg') && s.querySelector('.ms-settings-row').textContent.trim(),
      activity: s.querySelectorAll('.ms-sheet-activity-row').length, focus: s.contains(document.activeElement) }; })()`);
  eq([more.label, more.heading, more.modal, more.expanded, more.focus], ['More', 'More', 'true', 'true', true], 'More opens a modal sheet named More, with focus inside');
  const rest = more.nav.filter(t => !['home', 'chat', 'agents', 'calendar'].includes(t));
  eq(more.groups.flatMap(g => g[1]), rest, 'More holds every other tab, in sidebar order: ' + JSON.stringify(more.groups));
  eq(more.groups.map(g => g[0]), ['Workspace', 'Intelligence'], 'Grouped as the workspace sheet grouped them');
  ok(more.mode && more.modeFirst, 'The Kairos / Forge switch sits at the top of More');
  ok(more.profile && more.profile.name === more.account && more.profile.initial === more.avatar && more.profile.expanded === 'false', 'Profile shows the account initial and name: ' + JSON.stringify(more.profile));
  eq(more.settings, 'Settings', 'Settings has its own row with its icon');
  ok(more.activity >= 1, 'Work in progress is listed in More');
  eq(await small('.ms-more-sheet[open] button'), [], 'More controls are 44px');
  ok(await js("![...document.querySelectorAll('.ms-more-sheet[open] *')].some(n => n.childElementCount === 0 && n.textContent.includes(String.fromCharCode(8212)))"), 'More copy has no em dash');
  ok(await js("(() => { const s = getComputedStyle(document.querySelector('.ms-more-sheet')); return /blur/.test(s.backdropFilter) && /saturate/.test(s.backdropFilter) && /(rgba\\(.*, 0?\\.\\d+\\)|\\/ 0?\\.\\d+\\))$/.test(s.backgroundColor); })()"), 'More is a glass sheet');
  ok(await js("(() => { const r = document.querySelector('.ms-more-sheet').getBoundingClientRect(); return Math.round(r.bottom) === innerHeight && r.left === 0 && r.width === innerWidth; })()"), 'More rises from the bottom edge, full width');
  await js("document.querySelector('.ms-profile-row').click()");
  eq(await js("[document.querySelector('.ms-profile-row').getAttribute('aria-expanded'), [...document.querySelector('.ms-profile-row').nextElementSibling.querySelectorAll('button')].map(b => b.textContent)]"), ['true', ['Switch User', 'Log Out']], 'Profile opens Switch User and Log Out');
  await shot('tabbar-more');
  await js("document.querySelector('.ms-more-sheet .ms-tab-tile[data-tab=cookbook]').click()");
  await waitFor("document.documentElement.dataset.view === 'cookbook' && !document.querySelector('.ms-more-sheet[open]')"); await barShown();
  eq(await barCurrent(), 'more', 'A tab opened from More marks More');
  eq(await js("document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-expanded')"), 'false', 'More announces the sheet closed');
  // Settings from More is a pushed page: the bar steps aside, and Back brings it back on the tab underneath.
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(300);
  await js("document.querySelector('.ms-more-sheet .ms-settings-row').click()");
  await waitFor("document.querySelector('.settings-mobile-page')?.dataset.mobileView === 'list'"); await barGone();
  ok(await barState() === 'hidden', 'Settings, opened from More, owns the screen');
  await js("document.querySelector('.settings-mobile-back').click()");
  await waitFor("!document.querySelector('.settings-mobile-page') && document.documentElement.dataset.view === 'cookbook'"); await barShown();
  eq(await barCurrent(), 'more', 'Back from Settings slides the bar back');

  // ---- 6. The bar steps aside where the composer owns the bottom, and slides back ----------------
  const away = async label => {
    await barGone();
    const s = await js(`(() => { const b = document.querySelector('.ms-tabbar'), r = b.getBoundingClientRect(); return { inert: b.inert, hidden: b.getAttribute('aria-hidden'), up: document.documentElement.classList.contains('ms-tabbar-up'), below: r.top >= innerHeight, space: getComputedStyle(document.documentElement).getPropertyValue('--ms-tabbar-space').trim() }; })()`);
    ok(s.inert && s.hidden === 'true' && !s.up && s.below && s.space === '0px', `${label}: the bar slides below the screen and leaves the tab order: ${JSON.stringify(s)}`);
  };
  await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('.ms-conversation .ms-composer')");
  await away('A conversation');
  const composer = await rect('.ms-conversation .ms-composer');
  ok(composer.b >= H - 13, 'The conversation composer owns the bottom: ' + JSON.stringify(composer));
  await shot('tabbar-conversation-hidden');
  await js("document.querySelector('.ms-chat-back').click()"); await waitFor("document.documentElement.dataset.view === 'mobileLaunch'"); await barShown();
  ok(await js("document.documentElement.classList.contains('ms-tabbar-up')"), 'Back from a conversation slides the bar back');
  eq(await barCurrent(), 'chats', 'and Chats is current again');
  await navigate('agents', { agentId: 'a1' }); await waitFor("!!document.querySelector('.side-chat-input')");
  await away('An agent conversation');
  await navigate('agents'); await barShown();
  eq(await barCurrent(), 'agents', 'Leaving the agent conversation brings the bar back on Agents');

  // ---- 7. Forge mode: Forge Home, New, Sessions, More --------------------------------------
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open] .ms-mode-switch')"); await delay(300);
  await js("document.querySelector('.ms-mode-switch [data-mode=forge]').click()");
  await waitFor("document.documentElement.dataset.appMode === 'forge' && !!document.querySelector('.mf-dashboard')"); await barShown();
  eq(await items(), ['forgeHome', 'new', 'sessions', 'more'], 'Forge mode bar items');
  eq(await labels(), ['Forge Home', 'New', 'Sessions', 'More'], 'Forge mode bar labels');
  eq(await barCurrent(), 'forgeHome', 'Forge Home is current on the overview');
  ok(await pillOn(), 'The pill sits on Forge Home');
  await geometry('Forge Home', H, 12, W);
  const forgeClear = await clearsBar();
  ok(!forgeClear.last || forgeClear.last.b <= forgeClear.barTop + 0.5, 'Forge Home content scrolls clear of the bar: ' + JSON.stringify(forgeClear));
  await tap('new'); await waitFor("!!document.querySelector('.mf-project') && document.getElementById('mf-tab-0').getAttribute('aria-selected') === 'true'"); await barShown();
  eq(await barCurrent(), 'new', 'New opens the project New page');
  ok(await js("document.querySelector('.mf-project .forge-composer').getBoundingClientRect().bottom <= document.querySelector('.ms-tabbar').getBoundingClientRect().top - 8"), 'The Forge composer sits above the bar');
  await tap('sessions'); await waitFor("document.getElementById('mf-tab-1').getAttribute('aria-selected') === 'true'"); await delay(100);
  eq(await barCurrent(), 'sessions', 'Sessions opens the sessions list');
  ok(await pillOn(), 'The pill slid to Sessions');
  const sessionsDock = await rect('#mf-sessions .ms-history-dock');
  ok(sessionsDock && sessionsDock.b <= (await rect('.ms-tabbar')).t - 8, 'The sessions search dock sits above the bar: ' + JSON.stringify(sessionsDock));
  await js("document.getElementById('mf-tab-0').click()"); await delay(200);
  eq(await barCurrent(), 'new', 'Swiping the pager back to New moves the bar with it');
  await js("document.getElementById('mf-tab-1').click()"); await waitFor("document.querySelectorAll('#mf-sessions .ms-history-main').length > 0"); await delay(300);
  await js("document.querySelector('#mf-sessions .ms-history-main').click()"); await waitFor("!!document.querySelector('.mf-session .forge-transcript-composer')");
  await away('A Forge session');
  await js("document.querySelector('.mf-session .mf-changes').click()"); await waitFor("!!document.querySelector('dialog.ms-sheet[open]')"); await delay(300);
  const changesDock = await rect('.mf-git-dock');
  ok(await barState() === 'hidden' && (!changesDock || changesDock.b <= H), 'The Changes dock has the bottom to itself: ' + JSON.stringify(changesDock));
  await js("document.querySelector('dialog.ms-sheet[open] .ms-sheet-header button').click()"); await waitFor("!document.querySelector('dialog.ms-sheet[open]')");
  await js("document.querySelector('.mf-session .mf-back').click()"); await waitFor("!!document.querySelector('.mf-project')"); await barShown();
  eq(await barCurrent(), 'sessions', 'Back from the session slides the bar back on Sessions');
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(300);
  ok(await js("!document.querySelector('.ms-more-sheet .ms-tab-tile') && !!document.querySelector('.ms-more-sheet .ms-sheet-projects') && document.querySelector('.ms-more-sheet .ms-mode-switch').dataset.active === 'forge'"), 'Forge More: the mode switch on Forge and the projects, no duplicate tabs');
  await shot('tabbar-forge-more');
  await js("document.querySelector('.ms-mode-switch [data-mode=kairos]').click()");
  await waitFor("document.documentElement.dataset.appMode === 'kairos' && document.documentElement.dataset.view === 'home'"); await barShown();
  eq(await items(), ['home', 'chats', 'agents', 'calendar', 'more'], 'Back in Kairos the bar returns to the Kairos items');

  // ---- 8. Device classes: iPhone 393x852 (59/34), iPhone 375x667 (20/0), and a non-iPhone ---------
  // As in mobile-tabs-checks: the window is the layout viewport, --ms-page-height the true screen.
  const devices = [
    ['iphone-393x852', 393, 793, 852, 59, 34, 12],
    ['iphone-375x667', 375, 647, 667, 20, 0, 12],
    ['other-393x852', 393, 852, 852, 47, 34, 0],
  ];
  const bottoms = {};
  for (const [name, w, layout, screen, top, bottom, nudge] of devices) {
    await resize(w, layout);
    await js(`(() => { const s = document.documentElement.style; s.setProperty('--ms-page-height', '${screen}px'); s.setProperty('--native-safe-top', '${top}px'); s.setProperty('--native-safe-bottom', '${bottom}px'); s.setProperty('--ms-ios-nudge', '${nudge}px'); })()`);
    const gap = Math.max(12, bottom);
    for (const [tab, options, want] of [['home', {}, 'home'], ['chat', {}, 'chats'], ['agents', {}, 'agents'], ['calendar', {}, 'calendar']]) {
      await navigate(tab, options); await delay(500); await barShown();
      eq(await barCurrent(), want, `${name} ${tab}: ${want} is current`);
      const bar = await geometry(`${name} ${tab}`, screen, gap, w);
      bottoms[name] = bar.b;
      ok(await pillOn(), `${name} ${tab}: the pill sits on ${want}`);
      ok(await noAvatar(), `${name} ${tab}: no avatar`);
      eq(await small('.ms-tabbar-item'), [], `${name} ${tab}: 44px items`);
      if (tab === 'chat') {
        const launch = await rect('.ms-shell .ms-composer') || await rect('.ms-launch-composer');
        ok(launch && Math.abs(launch.b - (bar.t - 10)) <= 1, `${name}: the launch composer sits 10px above the bar: ${JSON.stringify(launch)}`);
        eq(Math.round((await rect('.ms-shell .ms-header .ms-switch')).t), top + nudge + 6, `${name}: the New / Chats switch keeps the top row (nudge ${nudge}px)`);
      }
      if (tab === 'calendar') {
        const dock = await rect('.ms-dock');
        ok(dock && Math.abs(dock.b - (bar.t - 10)) <= 1, `${name}: Calendar's dock sits 10px above the bar: ${JSON.stringify(dock)}`);
      }
      if (tab !== 'chat') {
        const clear = await clearsBar();
        ok(!clear.last || clear.last.b <= clear.barTop + 0.5, `${name} ${tab}: content scrolls clear of the bar: ${JSON.stringify(clear)}`);
      }
    }
    await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(400);
    eq(Math.round((await rect('.ms-more-sheet')).b), screen, `${name}: More reaches the true bottom`);
    ok((await rect('.ms-more-sheet')).t >= top + nudge - 0.5, `${name}: More stays below the status bar`);
    await js("document.querySelector('.ms-more-sheet').close()");
    await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('.ms-conversation .ms-composer')"); await delay(400);
    await barGone();
    ok(Math.abs((await rect('.ms-conversation .ms-composer')).b - (screen - gap)) <= 1, `${name}: in a conversation the bar is away and the composer sits ${gap}px above the true bottom`);
    await navigate('forgeHome'); await waitFor("!!document.querySelector('.mf-dashboard')"); await barShown(); await delay(300);
    eq(await items(), ['forgeHome', 'new', 'sessions', 'more'], `${name}: Forge mode items`);
    await geometry(`${name} Forge Home`, screen, gap, w);
    await tap('new'); await waitFor("!!document.querySelector('.mf-project')"); await barShown(); await delay(400);
    ok(await js("document.querySelector('.mf-project .forge-composer').getBoundingClientRect().bottom <= document.querySelector('.ms-tabbar').getBoundingClientRect().top - 8"), `${name}: the Forge composer sits above the bar`);
    await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
  }
  eq(bottoms['iphone-393x852'], bottoms['other-393x852'], 'The 12px iPhone nudge moves only the top: the bar sits the same on both 393x852 screens');
  // Screenshots of both iPhone classes. The window is the whole screen here (the checks above
  // shorten it to the layout viewport, which would crop the bottom of the picture).
  for (const [name, w, screen, top, bottom] of [['iphone-393x852', 393, 852, 59, 34], ['iphone-375x667', 375, 667, 20, 0]]) {
    await resize(w, screen);
    await js(`(() => { const s = document.documentElement.style; s.removeProperty('--ms-page-height'); s.setProperty('--native-safe-top', '${top}px'); s.setProperty('--native-safe-bottom', '${bottom}px'); s.setProperty('--ms-ios-nudge', '12px'); })()`);
    for (const [tab, options] of [['home', {}], ['chat', {}], ['agents', {}], ['calendar', {}]]) {
      await navigate(tab, options); await delay(600); await barShown(); await pillOn();
      await geometry(`${name} ${tab} (picture)`, screen, Math.max(12, bottom), w);
      await shot(`tabbar-${name}-${tab === 'chat' ? 'chats' : tab}`);
    }
    await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(500);
    await shot(`tabbar-${name}-more`);
    await js("document.querySelector('.ms-more-sheet').close()");
    await navigate('forgeHome'); await waitFor("!!document.querySelector('.mf-dashboard')"); await barShown(); await delay(500); await pillOn();
    await shot(`tabbar-${name}-forge-home`);
    await tap('sessions'); await waitFor("!!document.querySelector('.mf-project') && document.getElementById('mf-tab-1').getAttribute('aria-selected') === 'true'"); await barShown(); await delay(500); await pillOn();
    await shot(`tabbar-${name}-forge-sessions`);
    await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('.ms-conversation .ms-composer')"); await barGone(); await delay(300);
    await shot(`tabbar-${name}-conversation-bar-hidden`);
    await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
  }
  await js("(() => { const s = document.documentElement.style; s.removeProperty('--ms-page-height'); s.removeProperty('--native-safe-top'); s.removeProperty('--ms-ios-nudge'); s.setProperty('--native-safe-bottom', '0px'); })()");
  await resize(W, H);

  // ---- 9. Reduced motion: no slide, no spring -------------------------------------------------
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await navigate('home'); await barShown();
  ok(await js("[document.querySelector('.ms-tabbar'), document.querySelector('.ms-tabbar-pill'), document.querySelector('.ms-tabbar-item'), document.querySelector('.ms-tabbar-item svg')].every(n => /^0s(, 0s)*$/.test(getComputedStyle(n).transitionDuration))"), 'Reduced motion: the bar, pill and icons do not animate');
  await tap('calendar'); await waitFor("document.documentElement.dataset.view === 'calendar'");
  await waitFor("document.querySelector('.ms-tabbar [aria-current=page]')?.dataset.tabbar === 'calendar'");
  ok(await js("document.querySelector('.ms-tabbar-pill').getAnimations().length === 0") && await pillOn(), 'Reduced motion: the pill jumps straight to the new item');
  await navigate('chat', { sessionId: 's1' }); await waitFor("document.querySelector('.ms-tabbar').dataset.state === 'hidden'");
  ok(await js("getComputedStyle(document.querySelector('.ms-tabbar')).visibility === 'hidden'"), 'Reduced motion: the bar leaves at once');
  await navigate('home');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // ---- 10. Desktop has no bar ------------------------------------------------------------------
  await resize(1440, 900); await delay(300);
  ok(await js("(() => { const b = document.querySelector('.ms-tabbar'); return b.hidden && !b.getClientRects().length && !document.documentElement.classList.contains('ms-tabbar-up'); })()"), 'Desktop shows no tab bar');
  await resize(W, H); await barShown();
  eq(await barCurrent(), 'home', 'Back at phone width the bar returns');
  eq(await overflow(), [], 'No overflow with the bar');
};
