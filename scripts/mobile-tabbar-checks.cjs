// Phone tab bar checks (2026-10-22, David: "a bottom of the screen ios-liquid
// glass card showcasing Home, Chats, Calendar, and More (Agents became the Bots mode, 2026-10-29), with more
// producing a popup with the rest of the other tabs"). Run from
// mobile-tabs-checks.cjs, which passes its harness, ok/eq counters and helpers;
// uses only the smoke harness's synthetic backend.
//
// Covers: the bar on every tab and its selected state, the sliding glass pill,
// the glass itself, icons, labels and badges, what each item opens, More's
// contents and the mode switch, Forge mode's items, pushed pages keeping the bar, current-item pops, full-screen close controls,
// composer gaps, scroll clearance, and docks above the bar,
// the 393x852 (59/34) and 375x667 (20/0) iPhone classes and a non-iPhone,
// reduced motion, desktop, and that the avatar is gone. Screenshots: tabbar-*.
module.exports = async function tabBarChecks(c) {
  const { demoState, js, waitFor, delay, navigate, ok, eq, rect, hit, small, noSideways, barState, barCurrent, barShown, barGone, noAvatar, MORE, shot, resize, cdp, overflow } = c;
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
  // Composer dock padding reserves the bar space; measure its children, not that empty padding.
  const clearsBar = () => js(`(() => {
    const v = document.getElementById('view-content'), barTop = document.querySelector('.ms-tabbar').getBoundingClientRect().top;
    for (const n of [v, ...v.querySelectorAll('*')]) if (n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = 1e6;
    const clip = n => { const r = n.getBoundingClientRect(); let t = r.top, b = r.bottom;
      for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const q = a.getBoundingClientRect(); t = Math.max(t, q.top); b = Math.min(b, q.bottom); } }
      return b - t > 0.5 ? b : null; };
    const shown = n => {
      // Chromium retains boxes for descendants of closed disclosures. Only
      // their summary is visible; expanded content is checked separately below.
      for (let p = n.parentElement; p && p !== v; p = p.parentElement) {
        if (p.matches('details:not([open])') && !p.querySelector(':scope > summary')?.contains(n)) return false;
      }
      return n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).position !== 'fixed' && !n.closest('.ms-background, .ms-blur, .dither-canvas, [inert], .ms-activity');
    };
    const nodes = [...v.querySelectorAll('*')].filter(n => shown(n) && (!n.children.length || n.matches('button, input, textarea, select, img, svg, canvas, .bots-shell, .forge-panel, .ms-history-search, .ms-launch-composer')));
    const bottoms = nodes.map(n => ({ b: clip(n), n: String(n.className || n.tagName).slice(0, 40) })).filter(x => x.b !== null).sort((a, b) => b.b - a.b);
    v.scrollTo?.(0, 0); for (const n of v.querySelectorAll('*')) if (n.scrollTop) n.scrollTop = 0;
    return { last: bottoms[0], barTop };
  })()`);
  const safeTop = () => js(`(() => { const p = document.createElement('i'); p.style.cssText = 'position:fixed;height:var(--mobile-safe-top, env(safe-area-inset-top, 0px))'; document.body.append(p); const h = p.getBoundingClientRect().height; p.remove(); return h; })()`);
  const backControl = async (label, selector) => {
    eq(await small(selector), [], `${label}: back is a 44px target`);
    const b = await js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden'); if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, w: r.width, h: r.height, hit: n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }; })()`);
    ok(b && b.w >= 43.99 && b.h >= 43.99 && b.top >= (await safeTop()) - 0.5 && b.hit, `${label}: visible back clears the status area and hit-tests: ${JSON.stringify(b)}`);
  };
  // A bot's page is full screen on a phone (2026-11-02 redesign): the bar steps aside, its own back button returns,
  // and its composer reaches the bottom of the screen.
  const fullPage = async (label, { back, composer } = {}) => {
    await delay(100); await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'hidden'"); await delay(400);
    ok(await js("document.querySelector('.ms-tabbar').inert && !document.documentElement.classList.contains('ms-tabbar-up')"), `${label}: bar aside and no space reserved`);
    if (back) await backControl(label, back);
    if (composer) {
      // Measured against the page (an iPhone screen sets its own page height), with no room kept for a bar that is not there.
      const at = await js(`(() => { const r = document.querySelector(${JSON.stringify(composer)}).getBoundingClientRect(), v = document.querySelector('.bots-shell').getBoundingClientRect(); return { bottom: Math.round(r.bottom), page: Math.round(v.bottom), inner: innerHeight }; })()`);
      ok(at.bottom <= at.page + 1 && at.bottom >= at.page - 120 && at.page >= at.inner - 120, `${label}: composer at the bottom of the page ${JSON.stringify(at)}`);
    }
  };
  const pushedPage = async (label, { back, composer, current, composerGap } = {}) => {
    await barShown(); await delay(400);
    eq(await barState(), 'shown', `${label}: bar shown`);
    ok(await js("!document.querySelector('.ms-tabbar').inert && document.documentElement.classList.contains('ms-tabbar-up')"), `${label}: bar accessible and space reserved`);
    // 62px bar + 10px gap, plus the 28px lift the board wants beyond the usual 12px (less whatever the home-indicator inset already provides).
    const inset = await js("(() => { const p = document.createElement('i'); p.style.cssText = 'position:fixed;height:var(--mobile-safe-bottom, env(safe-area-inset-bottom, 0px))'; document.body.append(p); const h = p.getBoundingClientRect().height; p.remove(); return h; })()");
    eq(await js("(() => { const p = document.createElement('i'); p.style.cssText = 'position:fixed;height:var(--ms-tabbar-space)'; document.body.append(p); const h = getComputedStyle(p).height; p.remove(); return h; })()"), `${72 + Math.max(0, 28 - Math.max(12, inset))}px`, `${label}: reserves the bar, the 10px gap and the board lift`);
    eq(await barCurrent(), current, `${label}: current tab`);
    if (back) await backControl(label, back);
    const bar = await rect('.ms-tabbar');
    if (composer) {
      const r = await rect(composer);
      ok(r && (composerGap === 'atMost' ? r.b <= bar.t - 8 : Math.abs(r.b - (bar.t - 10)) <= 1), `${label}: composer clears bar: ${JSON.stringify([r, bar])}`);
    }
    ok(await js("[...document.querySelectorAll('.ms-tabbar-item')].every(n => { const r = n.getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.ms-tabbar'); })"), `${label}: every tab item hit-tests`);
    const clear = await clearsBar();
    ok(!clear.last || clear.last.b <= clear.barTop + 0.5, `${label}: content scrolls clear: ${JSON.stringify(clear)}`);
    ok(await noSideways(), `${label}: no sideways overflow`);
  };
  const openSettings = async () => {
    await barShown(); await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(350);
    await js("document.querySelector('.ms-more-sheet .ms-settings-row').click()");
    await waitFor("document.querySelector('.settings-mobile-page')?.dataset.mobileView === 'list'");
  };
  const openForgeSession = async () => {
    await navigate('forgeHome'); await waitFor("!!document.querySelector('.mf-dashboard')"); await barShown();
    await tap('sessions'); await waitFor("!!document.querySelector('#mf-sessions .ms-history-main')"); await delay(350);
    await js("document.querySelector('#mf-sessions .ms-history-main').click()"); await waitFor("!!document.querySelector('.mf-session .forge-transcript-composer')");
  };
  const openDesign = async () => {
    await navigate('design', { designId: 'd5e5e5e5e5e5' }); await waitFor("!!document.querySelector('.design-list-card')"); await barShown();
  };
  const openLive = async () => {
    await navigate('chat', { mobilePage: 0 }); await waitFor("!!document.querySelector('.ms-launch-chat #chat-input')");
    await js("(() => { const i = document.querySelector('.ms-launch-chat #chat-input'); i.value = 'Tab bar live chat check'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.ms-launch-chat #chat-send').click(); })()");
    await waitFor("!!document.querySelector('.ms-live-chat')");
  };
  const conversationPage = { back: '.ms-chat-back', composer: '.ms-conversation .ms-composer', current: 'chats' };
  const agentPage = { back: '.bots-head-back', composer: '.bots-composer', current: 'botsHome', composerGap: 'atMost' };
  // A bot's page lives in Bots mode; this opens one and waits for its composer.
  // Bots pages are answered by the in-memory Bots backend while botsLive is set (restored at the end).
  const priorBots = { live: demoState.botsLive, attention: demoState.botsAttention };
  demoState.botsLive = true; demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
  const openBotPage = async () => { await navigate('agents', { agentId: 'a1' }); await waitFor("document.documentElement.dataset.appMode === 'bots' && !!document.querySelector('.bots-composer-input')"); };
  const backToKairos = async () => { await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'"); await barShown(); };
  const forgePage = { back: '.mf-session .mf-back', composer: '.mf-session .forge-transcript-composer', current: 'sessions' };
  const geometry = async (label, screen, gap, width) => {
    const bar = await rect('.ms-tabbar');
    ok(bar && Math.abs(bar.b - (screen - gap)) <= 1 && bar.h === 62 && Math.abs(bar.l - 18) <= 1 && Math.abs(bar.r - (width - 18)) <= 1,
      `${label}: the bar floats ${gap}px above the true bottom, 62px tall, 18px from each side (TabBar board): ${JSON.stringify(bar)}`);
    return bar;
  };

  // ---- 1. The bar itself: items, icons, labels, glass ------------------------------------------
  await navigate('home'); await barShown();
  ok(await noAvatar(), 'The top-left avatar and the hamburger are gone');
  eq(await items(), ['home', 'chats', 'calendar', 'more'], 'Kairos bar items (no Agents)');
  eq(await labels(), ['Home', 'Chats', 'Calendar', 'More'], 'Each item carries its label');
  ok(await js("[...document.querySelectorAll('.ms-tabbar-item')].every(n => n.querySelector(':scope > svg')?.getAttribute('aria-hidden') === 'true')"), 'Each item has a decorative SVG icon');
  eq(await js("[...document.querySelectorAll('.ms-tabbar-item > svg')].map(n => n.firstElementChild.tagName + ':' + (n.firstElementChild.getAttribute('d') || n.firstElementChild.getAttribute('cx') || n.firstElementChild.getAttribute('x')))"),
    ['path:M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z', 'path:M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'rect:4', 'rect:4'], 'The icons are the TabBar board glyphs (home, chat, calendar, grid)');
  eq(await js("[document.querySelector('.ms-tabbar').tagName, document.querySelector('.ms-tabbar').getAttribute('aria-label')]"), ['NAV', 'Tabs'], 'The bar is a navigation landmark');
  eq(await js("[...document.querySelectorAll('.ms-tabbar-item')].filter(n => n.getAttribute('aria-current') === 'page').map(n => n.dataset.tabbar)"), ['home'], 'Exactly one item is current');
  eq(await small('.ms-tabbar-item'), [], 'Bar items are 44px targets');
  eq(await js("[document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-haspopup'), document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-controls')]"), ['dialog', 'ms-more-sheet'], 'More announces its sheet');
  const glass = await js(`(() => { const g = document.querySelector('.ms-tabbar-glass'), s = getComputedStyle(g), a = getComputedStyle(g, '::after'), b = getComputedStyle(g, '::before'), p = getComputedStyle(document.querySelector('.ms-tabbar-pill'));
    return { filter: s.backdropFilter || s.webkitBackdropFilter, radius: s.borderTopLeftRadius, shadow: s.boxShadow, bg: s.backgroundColor,
      specular: a.display !== 'none' && a.content !== 'none' && a.backgroundImage.includes('gradient') && a.height === '1px' && a.top === '0px', sheen: b.display !== 'none' && b.backgroundImage.includes('gradient'),
      pill: { radius: p.borderTopLeftRadius, shadow: p.boxShadow, transition: p.transitionProperty + ' ' + p.transitionDuration } }; })()`);
  ok(glass.filter === 'none' || glass.filter === '', 'The TabBar board draws a flat floating pill, not blurred glass: ' + glass.filter);
  ok(/(rgba\(.*, 0?\.\d+\)|\/ 0?\.\d+\))$/.test(glass.bg), 'The glass is translucent: ' + glass.bg);
  ok(!glass.specular && !glass.sheen && glass.shadow.includes('inset'), 'The pill keeps only the board soft drop shadow and inset top highlight, no specular streak or sheen: ' + JSON.stringify(glass));
  ok(parseFloat(glass.radius) >= 31 && parseFloat(glass.pill.radius) >= 20 && glass.pill.shadow.includes('inset'), 'A capsule with a glass pill inside: ' + JSON.stringify(glass));
  ok(/transform/.test(glass.pill.transition) && !/^0s$/.test(glass.pill.transition.split(' ').at(-1)), 'The pill slides between items: ' + glass.pill.transition);
  ok(await pillOn(), 'The pill sits on Home');
  ok(await js("!document.getElementById('mobile-menu-btn') && !document.querySelector('#ms-workspace-sheet')"), 'No avatar button and no workspace sheet in the page');
  ok(await js("![...document.querySelectorAll('.ms-tabbar *')].some(n => n.childElementCount === 0 && n.textContent.includes(String.fromCharCode(8212)))"), 'Bar copy has no em dash');

  // ---- 2. Every tab: the bar shows, marks the right item, and content clears it ------------------
  for (const [tab, options, want] of [['home', {}, 'home'], ['chat', {}, 'chats'], ['calendar', {}, 'calendar'], ['notes', {}, 'more'], ['library', {}, 'more'],
    ['email', {}, 'more'], ['tasks', {}, 'more'], ['cookbook', {}, 'more'], ['tool-store', {}, 'more'], ['school', {}, 'more']]) {
    await navigate(tab, options); await delay(400); await barShown();
    eq(await barCurrent(), want, `${tab}: the bar marks ${want}`);
    ok(await noAvatar(), `${tab}: no avatar`);
    await geometry(tab, H, 28, W);
    ok(await pillOn(), `${tab}: the pill sits on ${want}`);
    const clear = await clearsBar();
    ok(!clear.last || clear.last.b <= clear.barTop + 0.5, `${tab}: the last content scrolls clear of the bar: ${JSON.stringify(clear)}`);
    if (tab === 'email') {
      await js("document.querySelector('.email-view > details.disclosure-panel').open = true");
      const expanded = await clearsBar();
      ok(!expanded.last || expanded.last.b <= expanded.barTop + 0.5, `email: expanded provider controls clear the bar: ${JSON.stringify(expanded)}`);
      await js("document.querySelector('.email-view > details.disclosure-panel').open = false");
    }
    // A dock (search and +) sits above the bar, never under it.
    ok(await js("!document.querySelector('.ms-dock')"), `${tab}: no bottom search dock`);
    const search = await rect('.ms-page-search');
    if (search) ok(search.b < (await rect('.ms-tabbar')).t, `${tab}: search stays in the page above the tab bar`);
    ok(await noSideways(), `${tab}: nothing scrolls sideways`);
  }
  // The Chats list's own search dock sits above the bar too.
  await navigate('chat', { mobilePage: 1 }); await barShown(); await delay(400);
  const historyDock = await rect('.ms-history-search');
  ok(historyDock && historyDock.b <= (await rect('.ms-tabbar')).t - 8 && await js("document.querySelector('.ms-history-search').parentElement.classList.contains('ms-history') && getComputedStyle(document.querySelector('.ms-history-search')).position !== 'fixed'"), 'Chats search stays under the switch in its page: ' + JSON.stringify(historyDock));
  eq(await barCurrent(), 'chats', 'The Chats list keeps Chats current');

  // ---- 3. What each item opens --------------------------------------------------------------
  await navigate('home'); await barShown();
  await tap('chats'); await waitFor("document.documentElement.dataset.view === 'mobileLaunch' && !!document.querySelector('.ms-shell:not([hidden])')"); await delay(300);
  eq(await barCurrent(), 'chats', 'Chats opens the chat workspace');
  await js("document.getElementById('ms-tab-0').click()"); await delay(300);
  await tap('chats'); await waitFor("document.getElementById('ms-tab-1').getAttribute('aria-selected') === 'true'");
  ok(true, 'Chats again, on the workspace, shows the list of chats');
  ok(await js("!document.querySelector('.ms-tabbar [data-tabbar=agents]') && !document.querySelector('#nav .nav-item[data-tab=agents]')"), 'There is no Agents item on the bar or in the sidebar');
  // The old Agents link opens Bots: the bar then shows Bots, Chats and Inbox, current on the roster.
  await navigate('agents'); await waitFor("document.documentElement.dataset.appMode === 'bots' && document.documentElement.dataset.view === 'botsHome'"); await barShown();
  eq(await items(), ['botsHome', 'botsChats', 'botsInbox', 'more'], 'An old Agents link opens Bots, whose bar is Bots, Chats, Inbox and More');
  eq(await barCurrent(), 'botsHome', 'Bots opens the roster');
  await backToKairos();
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
    return { counts, home: read('home') }; })()`);
  const homeCount = badges.counts.need || badges.counts.live;
  ok(homeCount > 0 && badges.home.badge === String(homeCount) && badges.home.label === `Home, ${homeCount} ${badges.counts.need ? 'need you' : 'working'}`, 'Home carries the needs-you badge the avatar had, and says it: ' + JSON.stringify(badges));
  eq(await js("[...document.querySelectorAll('.ms-tabbar [data-tabbar=chats] .ms-tabbar-badge:not([hidden]), .ms-tabbar [data-tabbar=calendar] .ms-tabbar-badge:not([hidden])')].length"), 0, 'Items without news carry no badge');
  await shot('tabbar-badges');

  // ---- 5. More: every other tab, the mode switch, Settings and profile ----------------------------
  await js(MORE + ".focus(); " + MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(350);
  const more = await js(`(() => { const s = document.querySelector('.ms-more-sheet[open]'), top = n => n?.getBoundingClientRect().top ?? null;
    return { label: s.getAttribute('aria-label'), heading: s.querySelector('.ms-sheet-heading')?.textContent, modal: s.getAttribute('aria-modal'), expanded: document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-expanded'),
      groups: [...s.querySelectorAll('.ms-tab-group')].map(g => [g.querySelector('.ms-group-label').textContent, [...g.querySelectorAll('.ms-tab-tile')].map(t => t.dataset.tab)]),
      nav: [...document.querySelectorAll('#nav .nav-item')].map(n => n.dataset.tab),
      mode: !!s.querySelector('.ms-mode-row .ms-mode-switch[role=radiogroup]'), modeFirst: top(s.querySelector('.ms-mode-row')) < top(s.querySelector('.ms-tab-group')),
      profile: s.querySelector('.ms-profile-row') && { initial: s.querySelector('.ms-profile-initial').textContent, name: s.querySelector('.ms-profile-name').textContent, popup: s.querySelector('.ms-profile-row').getAttribute('aria-haspopup') },
      account: document.querySelector('.sidebar-user-name')?.textContent, avatar: document.querySelector('.sidebar-avatar')?.textContent,
      settings: !!s.querySelector('.ms-settings-row svg') && s.querySelector('.ms-settings-row').textContent.trim(),
      activity: s.querySelectorAll('.ms-sheet-activity-row').length, focus: s.contains(document.activeElement) }; })()`);
  eq([more.label, more.heading, more.modal, more.expanded, more.focus], ['More', 'More', 'true', 'true', true], 'More opens a modal sheet named More, with focus inside');
  const rest = more.nav.filter(t => !['home', 'chat', 'calendar'].includes(t));
  eq(more.groups.flatMap(g => g[1]), rest, 'More holds every other tab, in sidebar order: ' + JSON.stringify(more.groups));
  eq(more.groups.map(g => g[0]), ['Workspace', 'Intelligence'], 'Grouped as the workspace sheet grouped them');
  ok(more.mode && more.modeFirst, 'The Kairos / Forge / Bots switch sits at the top of More');
  ok(more.profile && more.profile.name === more.account && more.profile.initial === more.avatar && more.profile.popup === 'dialog', 'Profile shows the account initial and name and announces its dialog: ' + JSON.stringify(more.profile));
  eq(more.settings, 'Settings', 'Settings has its own row with its icon');
  ok(more.activity >= 1, 'Work in progress is listed in More');
  eq(await small('.ms-more-sheet[open] button'), [], 'More controls are 44px');
  ok(await js("![...document.querySelectorAll('.ms-more-sheet[open] *')].some(n => n.childElementCount === 0 && n.textContent.includes(String.fromCharCode(8212)))"), 'More copy has no em dash');
  ok(await js("(() => { const s = getComputedStyle(document.querySelector('.ms-more-sheet')); return s.backdropFilter === 'none' && /^rgb[(]/.test(s.backgroundColor) && parseFloat(s.borderTopLeftRadius) === 32; })()"), 'More is a solid parchment sheet with a 32px top radius (MoreSheet board)');
  ok(await js("(() => { const r = document.querySelector('.ms-more-sheet').getBoundingClientRect(); return Math.round(r.bottom) === innerHeight && r.left === 0 && r.width === innerWidth; })()"), 'More rises from the bottom edge, full width');
  await js("document.querySelector('.ms-profile-row').click()");
  await waitFor("!!document.querySelector('.workspace-profile-actions button')");
  eq(await js("[!!document.querySelector('.workspace-profile-panel[role=dialog][aria-modal=true]'), [...document.querySelectorAll('.workspace-profile-actions button')].map(b => b.textContent)]"), [true, ['Switch User', 'Log Out']], 'Profile screen opens Switch User and Log Out');
  eq(await js("[...document.querySelectorAll('.workspace-profile-actions button')].map(b => b.disabled)"), await js("[...document.querySelectorAll('#sidebar-footer .overflow-menu-item')].map(b => b.disabled)"), 'Profile preserves account action authorization');
  eq(await js("document.querySelector('.workspace-profile-identity strong').textContent"), more.account, 'Profile screen shows the current account');
  await shot('tabbar-profile');
  await js("document.querySelector('.workspace-profile-panel .modal-close-btn').click()");
  await waitFor("!document.querySelector('.workspace-profile-panel')");
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(300);
  await shot('tabbar-more');
  await js("document.querySelector('.ms-more-sheet .ms-tab-tile[data-tab=cookbook]').click()");
  await waitFor("document.documentElement.dataset.view === 'cookbook' && !document.querySelector('.ms-more-sheet[open]')"); await barShown();
  eq(await barCurrent(), 'more', 'A tab opened from More marks More');
  eq(await js("document.querySelector('.ms-tabbar [data-tabbar=more]').getAttribute('aria-expanded')"), 'false', 'More announces the sheet closed');
  // Settings keeps the bar and Back returns to the tab underneath.
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(300);
  await js("document.querySelector('.ms-more-sheet .ms-settings-row').click()");
  await waitFor("document.querySelector('.settings-mobile-page')?.dataset.mobileView === 'list'"); await barShown();
  eq(await barCurrent(), 'more', 'Settings opened from More keeps More current');
  await js("document.querySelector('.settings-mobile-back').click()");
  await waitFor("!document.querySelector('.settings-mobile-page') && document.documentElement.dataset.view === 'cookbook'"); await barShown();
  eq(await barCurrent(), 'more', 'Back from Settings slides the bar back');

  // ---- 6. Pushed pages keep the bar; full-screen views have their own close ----------------
  const away = async label => {
    await barGone();
    ok(await js("document.querySelector('.ms-tabbar').inert && !document.documentElement.classList.contains('ms-tabbar-up') && getComputedStyle(document.documentElement).getPropertyValue('--ms-tabbar-space').trim() === '0px'"), `${label}: full-screen view hides and inerts the bar without reserved space`);
  };
  await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('.ms-conversation .ms-composer')");
  await pushedPage('Conversation', conversationPage);
  await js("document.getElementById('chat-history-toggle').click()"); await waitFor("!!document.querySelector('#chat-sessions.open')");
  await away('Chat history'); await backControl('Chat history', '.chat-history-close');
  await js("document.querySelector('.chat-history-close').click()"); await barShown();
  await tap('chats'); await waitFor("document.documentElement.dataset.view === 'mobileLaunch'");
  ok(true, 'Current Chats pops a conversation to the chat workspace');
  await openLive();
  await pushedPage('Live launch chat', { back: '.ms-chat-back', composer: '.ms-live-chat .ms-composer', current: 'chats' });
  await tap('chats'); await waitFor("!document.querySelector('.ms-live-chat') && document.querySelector('#ms-tab-1[aria-selected=true]')");
  ok(true, 'Current Chats pops live launch chat to the Chats list');
  await openBotPage();
  await fullPage('Bot page', agentPage);
  await js("document.querySelector('.bots-head-back').click()");
  await waitFor("!!document.querySelector('.bots-home .bots-grid') && !document.querySelector('.bots-shell')");
  await barShown();
  ok(true, 'back: returns the bot page to the Bots roster, and the bar comes back');
  await backToKairos();
  // A team opens the Swarm view (a Kairos page, under More); the Bots inbox is a drawer beside the roster.
  const teamId = await js("(async () => { const r = await fetch('/api/swarm/systems'); return (await r.json()).items?.[0]?.id || null; })()");
  if (teamId) {
    await navigate('agents', { team: teamId }); await waitFor("!!document.querySelector('.swarm-composer')"); await barShown();
    eq(await barCurrent(), 'more', 'A team link opens Swarm, which sits under More');
    ok(await js("document.documentElement.dataset.appMode === 'kairos'"), 'Swarm stays a Kairos page');
  }
  await navigate('botsHome'); await waitFor("!!document.querySelector('.bots-home .bots-grid')"); await barShown();
  await js("import('/static/js/botsAttentionHost.js').then(m => { (m.attentionHost() || m.mountAttentionHost({ pollMs: 600000 })); return m.openAttention('inbox', {}); })");
  await waitFor("!!document.querySelector('.bots-attn:not([hidden])')");
  await delay(400);
  ok(await js("(() => { const r = document.querySelector('.bots-attn').getBoundingClientRect(); return r.width >= innerWidth - 2 && r.right <= innerWidth + 1; })()"), 'The Bots inbox covers the phone width');
  await js("(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await waitFor("!document.querySelector('.bots-attn:not([hidden])')");
  await backToKairos();
  await openSettings(); await pushedPage('Settings list', { back: '.settings-mobile-back', current: 'more' });
  await js("document.querySelector('.settings-nav-item').click()"); await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'");
  await pushedPage('Settings page', { back: '.settings-mobile-back', current: 'more' });
  await navigate('library', { section: 'documents' }); await waitFor("!!document.querySelector('.library-document-card')");
  await js("document.querySelector('.library-document-card').click()"); await waitFor("!!document.querySelector('.library-editor')");
  // Mobile v2 puts Back in the title row; the desktop toolbar Back is hidden.
  // Keep the same size, safe-area and hit-test coverage on the visible control.
  const libraryBack = '.library-editor button[aria-label="Back to Library"]';
  await pushedPage('Library editor', { back: libraryBack, current: 'more' });
  await js(`document.querySelector(${JSON.stringify(libraryBack)}).click()`);
  await waitFor("!document.querySelector('.library-editor') && !!document.querySelector('.library-document-card') && document.querySelectorAll('.ms-page-search').length === 1 && !document.querySelector('.ms-dock')");
  ok(true, 'Library editor: visible Back returns to documents and restores in-page search');
  await navigate('library'); await waitFor("!!document.querySelector('[data-library-section=vault]')");
  await js("document.querySelector('[data-library-section=vault]').click()"); await waitFor("!!document.querySelector('.library-vault-note')");
  await js("document.querySelector('.library-vault-note').click()"); await waitFor("!!document.querySelector('.vault-phone-detail')");
  await pushedPage('Vault note', { back: '.vault-phone-back', current: 'more' });
  await openDesign();
  await js("(() => { const i = document.querySelector('.design-composer-input'); i.value = 'warmer'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  const designPage = { back: '.design-back', composer: '.design-composer', current: 'more' };
  await pushedPage('Design draft', designPage);
  await js("document.querySelector('.design-list-card').click()"); await waitFor("!!document.querySelector('.design-focus')");
  await away('Design focus'); await backControl('Design focus', '[aria-label="Close focus"]');
  await js("document.querySelector('[aria-label=\"Close focus\"]').click()"); await barShown();
  await pushedPage('Design draft after focus', designPage);
  eq(await js("document.querySelector('.design-composer-input').value"), 'warmer', 'Design focus preserves the composer draft');
  await openForgeSession(); await pushedPage('Forge session', forgePage);
  await tap('sessions'); await waitFor("!!document.querySelector('#mf-tab-1[aria-selected=true]') && !document.querySelector('.mf-session')");
  ok(true, 'Current Sessions pops the session to the Sessions list');
  await navigate('home'); await barShown();

  // ---- 7. Forge mode: Forge Home, New, Sessions, More --------------------------------------
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open] .ms-mode-switch')"); await delay(300);
  await js("document.querySelector('.ms-mode-switch [data-mode=forge]').click()");
  await waitFor("document.documentElement.dataset.appMode === 'forge' && !!document.querySelector('.mf-dashboard')"); await barShown();
  eq(await items(), ['forgeHome', 'new', 'sessions', 'more'], 'Forge mode bar items');
  eq(await labels(), ['Forge Home', 'New', 'Sessions', 'More'], 'Forge mode bar labels');
  eq(await barCurrent(), 'forgeHome', 'Forge Home is current on the overview');
  ok(await pillOn(), 'The pill sits on Forge Home');
  await geometry('Forge Home', H, 28, W);
  const forgeClear = await clearsBar();
  ok(!forgeClear.last || forgeClear.last.b <= forgeClear.barTop + 0.5, 'Forge Home content scrolls clear of the bar: ' + JSON.stringify(forgeClear));
  // Mobile v2 keeps the original dashboard in a disclosure. Its expanded
  // cards must have the same clearance as the default overview.
  await js("document.querySelector('.mf-dashboard-extra').open = true");
  const expandedForgeClear = await clearsBar();
  ok(!expandedForgeClear.last || expandedForgeClear.last.b <= expandedForgeClear.barTop + 0.5, 'Expanded Forge Home content scrolls clear of the bar: ' + JSON.stringify(expandedForgeClear));
  await js("document.querySelector('.mf-dashboard-extra').open = false");
  await tap('new'); await waitFor("!!document.querySelector('.mf-project') && document.getElementById('mf-tab-0').getAttribute('aria-selected') === 'true'"); await barShown();
  eq(await barCurrent(), 'new', 'New opens the project New page');
  ok(await js("document.querySelector('.mf-project .forge-composer').getBoundingClientRect().bottom <= document.querySelector('.ms-tabbar').getBoundingClientRect().top - 8"), 'The Forge composer sits above the bar');
  await tap('sessions'); await waitFor("document.getElementById('mf-tab-1').getAttribute('aria-selected') === 'true'"); await delay(100);
  eq(await barCurrent(), 'sessions', 'Sessions opens the sessions list');
  ok(await pillOn(), 'The pill slid to Sessions');
  const sessionsDock = await rect('#mf-sessions .ms-history-search');
  ok(sessionsDock && sessionsDock.b <= (await rect('.ms-tabbar')).t - 8, 'Sessions search stays in its page above the bar: ' + JSON.stringify(sessionsDock));
  await js("document.getElementById('mf-tab-0').click()"); await delay(200);
  eq(await barCurrent(), 'new', 'Swiping the pager back to New moves the bar with it');
  await js("document.getElementById('mf-tab-1').click()"); await waitFor("document.querySelectorAll('#mf-sessions .ms-history-main').length > 0"); await delay(300);
  await js("document.querySelector('#mf-sessions .ms-history-main').click()"); await waitFor("!!document.querySelector('.mf-session .forge-transcript-composer')");
  await pushedPage('A Forge session', forgePage);
  await js("document.querySelector('.mf-session .mf-changes').click()"); await waitFor("!!document.querySelector('dialog.ms-sheet[open]')"); await delay(300);
  const changesDock = await rect('.mf-git-dock');
  ok(await js("(() => { const r = document.querySelector('.ms-tabbar').getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('dialog.ms-sheet[open]'); })()") && (!changesDock || changesDock.b <= H), 'The modal Changes sheet covers the bar: ' + JSON.stringify(changesDock));
  await js("document.querySelector('dialog.ms-sheet[open] .ms-sheet-header button').click()"); await waitFor("!document.querySelector('dialog.ms-sheet[open]')");
  await js("document.querySelector('.mf-session .mf-back').click()"); await waitFor("!!document.querySelector('.mf-project')"); await barShown();
  eq(await barCurrent(), 'sessions', 'Back from the session slides the bar back on Sessions');
  await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(300);
  ok(await js("!document.querySelector('.ms-more-sheet .ms-tab-tile') && !!document.querySelector('.ms-more-sheet .ms-sheet-projects') && document.querySelector('.ms-more-sheet .ms-mode-switch').dataset.active === 'forge'"), 'Forge More: the mode switch on Forge and the projects, no duplicate tabs');
  await shot('tabbar-forge-more');
  await js("document.querySelector('.ms-mode-switch [data-mode=kairos]').click()");
  await waitFor("document.documentElement.dataset.appMode === 'kairos' && document.documentElement.dataset.view === 'home'"); await barShown();
  eq(await items(), ['home', 'chats', 'calendar', 'more'], 'Back in Kairos the bar returns to the Kairos items');

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
    const gap = Math.max(28, bottom);
    for (const [tab, options, want] of [['home', {}, 'home'], ['chat', {}, 'chats'], ['calendar', {}, 'calendar']]) {
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
        await require('./chat-header-checks.cjs')(c, name, top + nudge + 6);
      }
      if (tab === 'calendar') {
        // Calendar has no bottom dock (David, 2026-10-24); Add and the range switch live in its header.
        eq(await js("document.querySelectorAll('.ms-dock').length"), 0, `${name}: Calendar has no bottom dock`);
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
    await pushedPage(`${name} conversation`, conversationPage);
    await geometry(`${name} conversation`, screen, gap, w);
    await openBotPage();
    await fullPage(`${name} bot page`, agentPage);
    await backToKairos();
    await openSettings(); await pushedPage(`${name} Settings list`, { back: '.settings-mobile-back', current: 'more' });
    await geometry(`${name} Settings list`, screen, gap, w);
    await openForgeSession(); await pushedPage(`${name} Forge session`, forgePage); await geometry(`${name} Forge session`, screen, gap, w);
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
    for (const [tab, options] of [['home', {}], ['chat', {}], ['calendar', {}]]) {
      await navigate(tab, options); await delay(600); await barShown(); await pillOn();
      await geometry(`${name} ${tab} (picture)`, screen, Math.max(28, bottom), w);
      await shot(`tabbar-${name}-${tab === 'chat' ? 'chats' : tab}`);
    }
    await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-more-sheet[open]')"); await delay(500);
    await shot(`tabbar-${name}-more`);
    await js("document.querySelector('.ms-more-sheet').close()");
    await navigate('forgeHome'); await waitFor("!!document.querySelector('.mf-dashboard')"); await barShown(); await delay(500); await pillOn();
    await shot(`tabbar-${name}-forge-home`);
    await tap('sessions'); await waitFor("!!document.querySelector('.mf-project') && document.getElementById('mf-tab-1').getAttribute('aria-selected') === 'true'"); await barShown(); await delay(500); await pillOn();
    await shot(`tabbar-${name}-forge-sessions`);
    await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('.ms-conversation .ms-composer')"); await barShown(); await delay(300);
    await shot(`tabbar-${name}-conversation`);
    await openBotPage(); await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'hidden'"); await delay(400);
    await shot(`tabbar-${name}-bot-page`);
    await backToKairos();
    await openSettings(); await barShown(); await delay(400); await shot(`tabbar-${name}-settings`);
    await openForgeSession(); await barShown(); await delay(400); await shot(`tabbar-${name}-forge-session`);
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
  await openDesign(); await js("document.querySelector('.design-list-card').click()"); await waitFor("document.querySelector('.ms-tabbar').dataset.state === 'hidden'");
  ok(await js("getComputedStyle(document.querySelector('.ms-tabbar')).visibility === 'hidden'"), 'Reduced motion: the bar leaves at once');
  await navigate('home');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // ---- 10. Desktop has no bar ------------------------------------------------------------------
  await resize(1440, 900); await delay(300);
  ok(await js("(() => { const b = document.querySelector('.ms-tabbar'); return b.hidden && !b.getClientRects().length && !document.documentElement.classList.contains('ms-tabbar-up'); })()"), 'Desktop shows no tab bar');
  await resize(W, H); await barShown();
  eq(await barCurrent(), 'home', 'Back at phone width the bar returns');
  eq(await overflow(), [], 'No overflow with the bar');
  for (const [key, value] of [['botsLive', priorBots.live], ['botsAttention', priorBots.attention]]) { if (value === undefined) delete demoState[key]; else demoState[key] = value; }
};
