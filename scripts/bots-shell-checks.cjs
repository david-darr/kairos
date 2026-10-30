// Bots mode shell, Bots home and the bot panel's host, in the renderer (Agents 3.0
// Phase 0, unit U3). Run by ui-smoke behind --bots-shell-only (U1's generic loader):
//   node scripts/run-electron-test.cjs ui-smoke --bots-shell-only
//
// The Bots fixture backend answers /api/agents* while demoState.botsLive is set.
// U4's modules (botsCreate, botsGallery, botsArchived, botsPanel) are stubbed here
// through botsPanelHost.js, so this check does not depend on them and never asks
// the server for a file that may not exist.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, demoState, liveChunk, liveFinish, liveRuns, base, overflow }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const mode = () => js('document.documentElement.dataset.appMode');
  const view = () => js('document.getElementById("view-content").dataset.view');
  const tell = () => js('window.__botsCalls.splice(0)');
  const changed = () => js("document.dispatchEvent(new Event('jarvis:agents-changed'))");
  const pressKey = (key, extra = {}) => js(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, cancelable: true, ...extra })}))`);
  const reset = size => { win.setContentSize(size[0], size[1]); return delay(450); };
  const stubs = () => js(`import('/static/js/botsPanelHost.js').then(host => {
    window.__botsCalls = []; window.__botsHost = host;
    const log = (...a) => window.__botsCalls.push(a);
    host.stubBotsModule('create', { openNewBot: (o) => log('new', JSON.stringify(o || {})) });
    host.stubBotsModule('archived', { openArchivedBots: () => log('archived') });
    host.stubBotsModule('gallery', { default: () => log('gallery') });
    host.stubBotsModule('panel', { mountBotPanel: (el, o) => {
      el.innerHTML = '<div class="stub-panel"></div>';
      const node = el.firstChild; node.dataset.agent = o.agentId; node.dataset.section = o.section || ''; node.dataset.mode = o.mode; node.dataset.page = o.page || '';
      node.textContent = 'Stub panel for ' + o.agentId;
      log('panel', o.agentId, o.section || '', o.mode);
      return () => log('panel-dispose', o.agentId);
    } });
    return true; })`);
  const open = (id, options = {}) => navigate('botsShell', { agentId: id, ...options });
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";
  const restore = await isolateBotsCheck({ js, demoState }, {
    sessionFields: { ...(demoState.sessionFields || {}), as1: { agent_id: 'a1' } },
    sidebarBotSessions: undefined, sidebarBotMessages: undefined, liveHoldIds: undefined,
  });
  // botsRail.js orders finite numeric `order` values first, then names
  // (case-insensitive) and IDs. The API's creation-time order is different.
  const visibleRoster = () => js(`fetch('/api/agents').then(r => r.json()).then(agents => agents.filter(a => a && !a.hidden).sort((a, b) => {
    const ao = typeof a.order === 'number' && Number.isFinite(a.order) ? a.order : null;
    const bo = typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : null;
    if (ao !== bo) { if (ao === null) return 1; if (bo === null) return -1; return ao - bo; }
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
      || String(a.id || '').localeCompare(String(b.id || ''));
  }).map(a => ({ id: a.id, name: a.name || 'Bot' })))`);
  const railRows = "[...document.querySelectorAll('.bots-rail-row')].map(n => ({ id: n.dataset.agentId, name: n.querySelector('.bots-rail-name').textContent }))";
  const cardIds = "[...document.querySelectorAll('.bots-grid .bots-bot-card')].map(n => n.dataset.agentId || 'new')";
  const expectRoster = async expected => {
    await waitFor(`JSON.stringify(${railRows}) === ${JSON.stringify(JSON.stringify(expected))}`);
    assert.deepEqual(await js(railRows), expected, 'the rail lists every visible bot in rail order, by name');
  };

  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    // Own the status examples without resetting extra bots from earlier checks.
    assert.equal((await call('/api/agents/a1', 'PATCH', { name: 'Scout', role: 'Watches job postings and applications', hidden: false, enabled: true })).status, 200);
    assert.equal((await call('/api/agents/a2', 'PATCH', { name: 'Archivist', hidden: false, enabled: true })).status, 200);
    Object.assign(demoState.botsCore.agents.find(a => a.id === 'a1'), { status: 'needs_you', needs_you: 2, status_detail: '' });
    Object.assign(demoState.botsCore.agents.find(a => a.id === 'a2'), { status: 'working', needs_you: 0, status_detail: 'Sort inbox notes' });
    const roster = await visibleRoster();
    const archivedCount = (await call('/api/agents', 'GET')).body.filter(a => a.hidden).length;
    await js("localStorage.removeItem('kairos:app-mode'); localStorage.removeItem('kairos:bots-interface'); localStorage.removeItem('kairos:bots-last-bot'); true");
    await stubs();

    // -- The switch ---------------------------------------------------------------------
    assert.deepEqual(await js("[...document.querySelectorAll('#forge-mode-switch [data-mode]')].map(n => n.dataset.mode)"), ['kairos', 'forge', 'bots'], 'the switch has three modes, in order');
    assert.equal(await js("document.querySelector('#forge-mode-switch [data-mode=bots] small').textContent"), 'Preview', 'Bots carries the Preview badge');
    assert.equal(await js("!!document.querySelector('#forge-mode-switch [data-mode=kairos] small')"), false, 'Kairos carries no badge');
    assert.equal(await mode(), 'kairos');
    await js("document.querySelector('#forge-mode-switch [data-mode=bots]').click()");
    await waitFor("document.documentElement.dataset.appMode === 'bots' && !!document.querySelector('.bots-home .bots-grid')");
    assert.equal(await view(), 'botsHome', 'Bots opens on its roster');
    assert.equal(await js("document.getElementById('titlebar-tab')?.textContent || 'Bots'"), 'Bots');
    assert.equal(await js("document.querySelector('#forge-mode-switch [data-mode=bots]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await js("document.querySelector('#forge-mode-switch [data-mode=kairos]').getAttribute('aria-pressed')"), 'false');
    assert.equal(await js("localStorage.getItem('kairos:app-mode')"), 'bots', 'the mode is remembered');
    assert.deepEqual(await js("[...document.querySelectorAll('#nav > .nav-item[data-tab]')].map(n => n.dataset.tab)"), ['botsHome'], 'Bots mode has its own nav item');
    assert.equal(await js("getComputedStyle(document.documentElement).getPropertyValue('--bots-ink').trim() !== '' && getComputedStyle(document.documentElement).fontFamily.includes('Geist')"), true, 'the Bots tokens and font are on');
    // The Bots look does not leak into Kairos or Forge.
    assert.equal(await js("(() => { const t = document.documentElement.dataset.appMode; document.documentElement.dataset.appMode = 'kairos'; const v = getComputedStyle(document.documentElement).getPropertyValue('--bots-ink').trim(); document.documentElement.dataset.appMode = t; return v; })()"), '');

    // -- The rail ------------------------------------------------------------------------
    await expectRoster(roster);
    assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=a1] .bots-rail-count').textContent"), '2', 'the Needs-you count shows on the row');
    assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=a1]').dataset.state"), 'needs_you');
    assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=a2]').dataset.state"), 'working');
    assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=a1]').getAttribute('aria-label')"), 'Scout, Needs you: 2 items');
    assert.equal(await js("document.querySelectorAll('.bots-rail-row img').length"), roster.length, 'every row uses the static face');
    assert.equal(await js("document.querySelectorAll('.bots-rail-row kairos-mascot').length"), 0, 'no live mascot per row');
    assert.equal(await js("document.querySelector('.bots-rail-archived').hidden"), !archivedCount, 'Archived is shown exactly when bots are archived');
    assert.equal(await js("[...document.querySelectorAll('.bots-rail .bots-segmented button')].map(n => n.textContent).join()"), 'Simple,Advanced');
    assert.equal(await js("document.querySelector('.bots-rail .bots-segmented button[aria-checked=true]').textContent"), 'Simple', 'Simple is the default');
    assert.equal(await js("!!document.getElementById('rd-search-row') && !!document.getElementById('rd-search')"), true, 'the Search row sits above the footer, as in Forge');
    assert.equal(await js("!!document.querySelector('#sidebar-footer .sidebar-user-card') && !!document.querySelector('#sidebar-footer .sidebar-settings-btn')"), true, 'the footer is unchanged');
    // An archived bot leaves the rail and the home grid, and the Archived row counts it.
    assert.equal((await call('/api/agents/a2', 'PATCH', { hidden: true })).status, 200);
    await changed();
    const archivedRoster = await visibleRoster();
    assert.deepEqual(archivedRoster, roster.filter(a => a.id !== 'a2'));
    await expectRoster(archivedRoster);
    assert.equal(await js("document.querySelector('.bots-rail-archived-label').textContent"), `Archived (${archivedCount + 1})`);
    await waitFor(`JSON.stringify(${cardIds}) === ${JSON.stringify(JSON.stringify([...archivedRoster.map(a => a.id), 'new']))}`);
    assert.equal(await js("document.querySelector('.bots-home-actions .bots-btn[hidden]')"), null, 'Home shows its Archived button');
    await js("document.querySelector('.bots-rail-archived').click()");
    await waitFor("window.__botsCalls.length > 0");
    assert.deepEqual(await tell(), [['archived']], 'the Archived row goes to botsArchived.js');
    assert.equal((await call('/api/agents/a2', 'PATCH', { hidden: false })).status, 200);
    await changed();
    await expectRoster(roster);
    assert.equal(await js("document.querySelector('.bots-rail-archived').hidden"), !archivedCount);

    // -- Bots home -----------------------------------------------------------------------
    assert.equal(await js("document.querySelector('.bots-home-title').textContent"), 'Your bots');
    const expectedCards = [...roster.map(a => a.id), 'new'];
    await waitFor(`JSON.stringify(${cardIds}) === ${JSON.stringify(JSON.stringify(expectedCards))}`);
    assert.deepEqual(await js(cardIds), expectedCards, 'every visible bot in rail order, then New bot last');
    assert.equal(await js("document.querySelector('.bots-bot-card[data-agent-id=a1] .bots-bot-card-name').textContent"), 'Scout');
    assert.equal(await js("document.querySelector('.bots-bot-card[data-agent-id=a1] .bots-bot-card-job').textContent"), 'Watches job postings and applications');
    assert.equal(await js("document.querySelector('.bots-bot-card[data-agent-id=a1] .bots-bot-card-status').textContent"), 'Needs you: 2 items');
    assert.equal(await js("document.querySelector('.bots-bot-card[data-agent-id=a2] .bots-bot-card-status').textContent"), 'Working on Sort inbox notes');
    assert.equal(await js("document.querySelectorAll('.bots-bot-card img').length"), roster.length, 'every bot card uses the static face');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-home-actions .bots-btn')].filter(n => !n.hidden).map(n => n.textContent)"), ['Ready-made bots', ...(archivedCount ? [`Archived (${archivedCount})`] : []), 'New bot'], 'Home actions include Archived exactly when bots are archived');
    await capture('desktop-bots-home');
    await js("document.querySelector('.bots-home-actions .bots-btn.primary').click()");
    await js("[...document.querySelectorAll('.bots-home-actions .bots-btn')].find(n => n.textContent === 'Ready-made bots').click()");
    await js("document.querySelector('.bots-new-card').click()");
    await js("document.querySelector('.bots-rail-new').click()");
    await waitFor("window.__botsCalls.length === 4");
    assert.deepEqual(await tell(), [['new', '{}'], ['new', '{"gallery":true}'], ['new', '{}'], ['new', '{}']], 'New bot and Ready-made bots go to botsCreate.js');
    // Mod+N is Bots mode only.
    await pressKey('n', { ctrlKey: true });
    await waitFor("window.__botsCalls.length === 1");
    assert.deepEqual(await tell(), [['new', '{}']], 'Ctrl+N starts a new bot in Bots mode');

    // -- The rail opens a bot -------------------------------------------------------------
    await js("document.querySelector('.bots-rail-row[data-agent-id=a1]').click()");
    await waitFor("document.documentElement.dataset.view === 'botsShell' && !!document.querySelector('.bots-shell[data-agent-id=a1] .bots-composer-input')");
    assert.equal(await mode(), 'bots');
    assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=a1]').classList.contains('active') && document.querySelector('.bots-rail-row[data-agent-id=a1]').getAttribute('aria-current') === 'page'"), true, 'the open bot is marked in the rail');
    assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=a2]').classList.contains('active')"), false, 'and only that one');
    assert.equal(await js("document.documentElement.dataset.botsAgent"), 'a1');
    assert.equal(await js("document.querySelector('.bots-head-name').textContent"), 'Scout');
    assert.equal(await js("document.querySelectorAll('.bots-head-pill kairos-mascot').length"), 1, 'the header has one live Kip');
    assert.equal(await js("document.querySelector('.bots-head-pill .bots-kip').offsetWidth"), 24, 'the Kip is 24 px');
    assert.equal(await js("document.querySelector('.bots-head-pill').getAttribute('aria-expanded')"), 'false');
    assert.equal(await js("!!document.querySelector('.bots-shell .bots-log') && !!document.querySelector('.bots-shell .bots-composer-input')"), true, 'the chat is the real conversation');
    assert.equal(await js("document.querySelectorAll('.bots-convos .bots-convo-list').length"), 1, 'its conversation list is in the popover');
    assert.equal(await js("document.querySelector('.bots-convos').hidden"), true);
    await capture('desktop-bots-shell');

    // The conversations popover opens, closes on Escape and returns focus.
    await js("document.querySelector('.bots-head-convos').click()");
    assert.equal(await js("!document.querySelector('.bots-convos').hidden && document.querySelector('.bots-head-convos').getAttribute('aria-expanded')"), 'true');
    assert.equal(await js("document.querySelectorAll('.bots-convos .bots-convo-item').length > 0 || !!document.querySelector('.bots-convos .bots-convo-new')"), true, 'it holds the conversation list');
    await capture('desktop-bots-conversations');
    await pressKey('Escape');
    assert.equal(await js("document.querySelector('.bots-convos').hidden"), true);
    assert.equal(await js("document.activeElement === document.querySelector('.bots-head-convos')"), true, 'focus returns to the opener');

    // Away from the main conversation the header says which one is open; on the main one it says nothing.
    await open('a1', { sessionId: 'bots-t2' });
    await waitFor("document.querySelector('.bots-convos .bots-convo-item.active')?.dataset.session === 'bots-t2' && !document.querySelector('.bots-head-thread').hidden");
    assert.equal(await js("document.querySelector('.bots-head-thread').textContent"), '> Weekly postings');
    assert.match(await js("document.querySelector('.bots-head-pill').getAttribute('aria-label')"), /^Scout, Weekly postings, /);
    await capture('desktop-bots-away-from-main');
    await open('a1', { sessionId: 'bots-t1' });
    await waitFor("document.querySelector('.bots-convos .bots-convo-item.active')?.dataset.session === 'bots-t1'");
    assert.equal(await js("document.querySelector('.bots-head-thread').hidden"), true, 'the main conversation shows no thread title');

    // Streaming, Stop and returning to a running reply belong to bots-stream-checks.cjs (the conversation is unit U3's).
    await open('a1');
    await waitFor("!!document.querySelector('.bots-shell[data-agent-id=a1] .bots-composer-input')");

    // -- The panel host (botsPanel.js stubbed) -----------------------------------------------
    await js("document.querySelector('.bots-head-pill').click()");
    await waitFor("!!document.querySelector('#bots-panel .stub-panel')");
    assert.deepEqual(await tell(), [['panel', 'a1', '', 'simple']], 'the pill opens the panel in Simple');
    assert.equal(await js("document.querySelector('#bots-panel').getAttribute('role')"), 'dialog');
    assert.equal(await js("document.querySelector('#bots-panel').tagName"), 'ASIDE');
    assert.equal(await js("Math.round(document.querySelector('#bots-panel').getBoundingClientRect().width)"), 320, 'Simple is 320 px');
    assert.equal(await js("document.querySelector('.bots-head-pill').getAttribute('aria-expanded')"), 'true');
    assert.equal(await js("document.querySelector('#bots-panel').contains(document.activeElement)"), true, 'focus moves into the panel');
    await capture('desktop-bots-panel-simple');
    await pressKey('Escape');
    await waitFor("!document.querySelector('#bots-panel')");
    assert.equal(await js("document.activeElement === document.querySelector('.bots-head-pill')"), true, 'Escape closes the panel and focus returns to the pill');
    assert.deepEqual(await tell(), [['panel-dispose', 'a1']], 'closing disposes what the panel mounted');
    assert.equal(await js("document.querySelector('.bots-head-pill').getAttribute('aria-expanded')"), 'false');
    // Advanced is wider and redraws the sections.
    await js("document.querySelector('.bots-rail .bots-segmented button[data-value=advanced]').click()");
    assert.equal(await js("document.documentElement.dataset.botsInterface"), 'advanced');
    await js("document.querySelector('.bots-head-pill').click()");
    await waitFor("!!document.querySelector('#bots-panel .stub-panel')");
    assert.equal(await js("Math.round(document.querySelector('#bots-panel').getBoundingClientRect().width)"), 420, 'Advanced is min(420px, 42vw)');
    assert.deepEqual(await tell(), [['panel', 'a1', '', 'advanced']]);
    await js("document.querySelector('.bots-rail .bots-segmented button[data-value=simple]').click()");
    await waitFor("document.querySelector('#bots-panel .stub-panel')?.dataset.mode === 'simple'");
    assert.deepEqual(await tell(), [['panel-dispose', 'a1'], ['panel', 'a1', '', 'simple']], 'switching Simple and Advanced redraws the panel');
    await js("document.querySelector('#bots-panel .bots-panel-close').click()");
    await waitFor("!document.querySelector('#bots-panel')");
    await tell();
    // The deep link: a section, from here or from another page.
    await js("window.__botsHost.openBotSettings('a1', { section: 'memory', page: 'notes' })");
    await waitFor("document.querySelector('#bots-panel .stub-panel')?.dataset.section === 'memory'");
    assert.equal(await js("document.querySelector('#bots-panel .stub-panel').dataset.page"), 'notes');
    await js("window.__botsHost.openBotSettings('a1', { section: 'model' })");
    await waitFor("document.querySelector('#bots-panel .stub-panel')?.dataset.section === 'model'");
    assert.equal(await js("document.querySelectorAll('#bots-panel').length"), 1, 'a second deep link moves the one panel');
    await tell();
    await navigate('botsHome');
    await waitFor("!document.querySelector('#bots-panel') && !!document.querySelector('.bots-grid')");
    assert.equal(await js("document.querySelector('.bots-shell')"), null);
    await tell();
    await js("window.__botsHost.openBotSettings('a2', { section: 'identity' })");
    await waitFor("document.documentElement.dataset.view === 'botsShell' && document.querySelector('#bots-panel .stub-panel')?.dataset.agent === 'a2'");
    assert.equal(await js("document.querySelector('#bots-panel .stub-panel').dataset.section"), 'identity', 'a deep link from another page opens that bot, panel open');
    assert.equal(await js("document.querySelector('.bots-head-name').textContent"), 'Archivist');
    // The panel closes when the page is left.
    await tell();
    await navigate('botsHome');
    await waitFor("!document.querySelector('#bots-panel')");
    assert.equal((await tell()).some(c => c[0] === 'panel-dispose'), true, 'leaving the page disposes the panel');

    // -- A module that cannot load shows a message, not a broken page ----------------------------
    await js(`window.__botsHost.stubBotsModule('panel', () => Promise.reject(new Error('stubbed failure')))`);
    await open('a1', { panel: true });
    await waitFor("!!document.querySelector('#bots-panel .bots-panel-fallback')");
    assert.match(await js("document.querySelector('#bots-panel .bots-panel-fallback').textContent"), /could not load/);
    assert.equal(await js("document.querySelector('#bots-panel .bots-panel-fallback').getAttribute('role')"), 'alert');
    assert.equal(await js("!!document.querySelector('.bots-shell .bots-composer-input')"), true, 'the chat still works');
    await js(`window.__botsHost.stubBotsModule('panel', { mountBotPanel: (el) => { el.textContent = 'Back again'; } })`);
    await js("document.querySelector('#bots-panel .bots-panel-fallback button').click()");
    await waitFor("document.querySelector('#bots-panel .bots-panel-body')?.textContent === 'Back again'");
    await js("window.__botsHost.closeBotSettings()");
    await js(`window.__botsHost.stubBotsModule('create', () => Promise.reject(new Error('stubbed failure')))`);
    await navigate('botsHome');
    await waitFor("!!document.querySelector('.bots-home-actions')");
    await js("document.querySelector('.bots-home-actions .bots-btn.primary').click()");
    await waitFor(`${errorToasts}.some(t => /new-bot dialog could not load/.test(t))`);
    await js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
    await stubs();

    // -- The retired Agents tab: its links land in Bots --------------------------------------------------
    await js("document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'agents', agentId: 'a1' } }))");
    await waitFor("document.documentElement.dataset.view === 'botsShell' && !!document.querySelector('.bots-shell[data-agent-id=a1]')");
    assert.equal(await mode(), 'bots', 'a notification-style link opens the bot in Bots');
    assert.equal(await js("document.querySelector('#forge-mode-switch [data-mode=bots]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await js("document.querySelector('#nav .nav-item[data-tab=agents], #rd-all-tabs .nav-item[data-tab=agents]') === null"), true, 'there is no Agents tab in any nav');

    // -- Mode survives a reload -----------------------------------------------------------------------
    await js("document.querySelector('#forge-mode-switch [data-mode=bots]').click()");
    await waitFor("document.documentElement.dataset.view === 'botsHome'");
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.bots-home .bots-grid')");
    assert.equal(await mode(), 'bots', 'Bots survives a reload');
    assert.equal(await js("localStorage.getItem('kairos:app-mode')"), 'bots');
    assert.equal(await view(), 'botsHome');
    await stubs();

    // The collapsed rail steps Kairos, Bots, Forge.
    await js("document.querySelector('#sidebar-toggle').click()");
    await delay(350);
    assert.equal(await js("document.querySelector('.forge-mode-rail').getAttribute('aria-label')"), 'Switch to Forge Preview', 'in Bots the rail goes to Forge next');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-rail-name')).display"), 'none', 'the collapsed rail shows faces only');
    await capture('desktop-bots-collapsed');
    await js("document.querySelector('.forge-mode-rail').click()");
    await waitFor("document.documentElement.dataset.appMode === 'forge' && !!document.querySelector('.forge-home')");
    assert.equal(await js("document.querySelector('.forge-mode-rail').getAttribute('aria-label')"), 'Switch to Kairos');
    await js("document.querySelector('.forge-mode-rail').click()");
    await waitFor("document.documentElement.dataset.appMode === 'kairos' && !!document.querySelector('.dashboard-content.is-filled')");
    assert.equal(await js("document.querySelector('.forge-mode-rail').getAttribute('aria-label')"), 'Switch to Bots Preview', 'in Kairos the rail goes to Bots next');
    await js("document.querySelector('.forge-mode-rail').click()");
    await waitFor("document.documentElement.dataset.appMode === 'bots' && !!document.querySelector('.bots-home')");
    await js("document.querySelector('#sidebar-toggle').click()");
    await delay(350);

    // -- A non-admin has no switch and cannot reach Bots ---------------------------------------------------------
    demoState.isAdmin = false;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    assert.equal(await js("!!document.querySelector('#forge-mode-switch, .bots-rail, #nav [data-tab=botsHome]')"), false, 'a non-admin sees no mode switch and no Bots');
    assert.equal(await mode(), 'kairos', 'a stored Bots mode does not apply to a non-admin');
    await navigate('botsHome');
    assert.equal(await view(), 'home', 'a non-admin cannot route to Bots');
    await navigate('botsShell', { agentId: 'a1' });
    assert.equal(await view(), 'home');
    demoState.isAdmin = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('#forge-mode-switch')");
    await stubs();

    // -- Phone -------------------------------------------------------------------------------------------------------
    await js("localStorage.setItem('kairos:app-mode', 'kairos'); true");
    await win.loadURL(base);
    await reset([390, 844]);
    await waitFor("!!document.querySelector('.dashboard-core') || !!document.querySelector('.hm-home')");
    await stubs();
    await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown'");
    await js("document.querySelector('.ms-tabbar [data-tabbar=more]').click()");
    await waitFor("!!document.querySelector('.ms-tab-sheet[open] .ms-mode-switch')");
    await delay(350);
    assert.equal(await js("[...document.querySelectorAll('.ms-mode-row button')].map(n => n.textContent).join(',')"), 'Kairos,Forge Preview,Bots Preview', 'the More sheet has three modes');
    assert.deepEqual(await js("[...document.querySelectorAll('.ms-mode-switch [role=radio]')].map(n => [n.dataset.mode, n.getAttribute('aria-checked'), n.tabIndex])"),
      [['kairos', 'true', 0], ['forge', 'false', -1], ['bots', 'false', -1]], 'a radio group with a roving tab stop');
    assert.equal(await js("document.querySelector('#ms-mode-about-bots').textContent"), 'Your bots, their chats and settings');
    assert.equal(await js("document.querySelector('.ms-mode-switch').getBoundingClientRect().width > 300 && [...document.querySelectorAll('.ms-mode-option')].every(n => n.getBoundingClientRect().width >= 44 && n.getBoundingClientRect().height >= 44)"), true, 'three 44 px options');
    await capture('mobile-bots-more-sheet');
    await js("document.querySelector('.ms-mode-switch [data-mode=bots]').click()");
    await waitFor("document.documentElement.dataset.appMode === 'bots' && !document.querySelector('.ms-tab-sheet[open]') && !!document.querySelector('.bots-home .bots-grid')");
    await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown'");
    assert.equal(await js("document.querySelector('.ms-tabbar').dataset.mode"), 'bots');
    assert.deepEqual(await js("[...document.querySelectorAll('.ms-tabbar-item')].map(n => n.dataset.tabbar)"), ['botsHome', 'botsChats', 'botsInbox', 'more'], 'the tab bar shows Bots, Chats and Inbox');
    assert.equal(await js("document.querySelector('.ms-tabbar [data-tabbar=botsHome]').getAttribute('aria-current')"), 'page');
    assert.equal(await js("document.querySelector('.ms-tabbar [data-tabbar=botsHome] .ms-tabbar-label').textContent"), 'Bots');
    assert.deepEqual(await overflow(), [], 'Bots home has no sideways scroll on a phone');
    await waitFor(`document.querySelectorAll('.bots-bot-card').length === ${roster.length + 1}`);
    assert.deepEqual(await js(cardIds), expectedCards, 'cards on a phone: every visible bot, then New bot');
    await capture('mobile-bots-home');
    // A bot's page: the header is a pill with a back button, the chat is in place, the Bots tab stays selected.
    await js("document.querySelector('.bots-bot-card[data-agent-id=a1]').click()");
    await waitFor("!!document.querySelector('.bots-shell[data-agent-id=a1] .bots-composer-input')");
    assert.equal(await js("document.querySelector('.ms-tabbar [data-tabbar=botsHome]').getAttribute('aria-current')"), 'page', 'the Bots tab stays current on a bot page');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-head-back')).display !== 'none'"), true, 'a phone gets a back button');
    assert.deepEqual(await overflow(), [], 'a bot page has no sideways scroll on a phone: ' + await js("[...document.querySelectorAll('#view-content *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1 && n.getClientRects().length).slice(0, 8).map(n => n.tagName + '.' + n.className + ' ' + Math.round(n.getBoundingClientRect().right)).join(' | ') + ' CHAIN ' + (() => { const out = []; for (let n = document.querySelector('.side-chat-composer'); n && n.id !== 'app'; n = n.parentElement) { const r = n.getBoundingClientRect(); out.push(n.className.toString().slice(0, 30) + ':' + Math.round(r.left) + '-' + Math.round(r.right) + ' m' + getComputedStyle(n).marginLeft + '/' + getComputedStyle(n).marginRight); } return out.join(' > '); })()"));
    assert.equal(await js("document.querySelector('.bots-head-pill').getBoundingClientRect().height >= 44 && document.querySelector('.bots-head-convos').getBoundingClientRect().height >= 44"), true, '44 px targets');
    await capture('mobile-bots-shell');
    // The panel covers the page and the bar steps aside; closing brings it back.
    await js("document.querySelector('.bots-head-pill').click()");
    await waitFor("!!document.querySelector('#bots-panel .stub-panel')");
    await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'hidden'");
    await waitFor("(() => { const r = document.querySelector('#bots-panel').getBoundingClientRect(); return Math.abs(r.left) < 1 && Math.abs(r.top) < 1 && Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1; })()", 4000);
    await capture('mobile-bots-panel');
    await pressKey('Escape');
    await waitFor("!document.querySelector('#bots-panel') && document.querySelector('.ms-tabbar')?.dataset.state === 'shown'");
    // The Bots tab on a bot page goes back to the roster.
    await js("document.querySelector('.ms-tabbar [data-tabbar=botsHome]').click()");
    await waitFor("document.documentElement.dataset.view === 'botsHome'");
    // More in Bots mode holds only the switch (and the account), and goes back to Kairos.
    await js("document.querySelector('.ms-tabbar [data-tabbar=more]').click()");
    await waitFor("!!document.querySelector('.ms-tab-sheet[open] .ms-mode-switch')");
    await delay(350);
    assert.equal(await js("document.querySelectorAll('.ms-more-sheet .ms-tab-tile').length"), 0, 'no tab tile that the bar already has');
    assert.equal(await js("document.querySelector('.ms-mode-switch').dataset.active"), 'bots');
    assert.equal(await js("document.querySelector('.ms-mode-switch [data-mode=bots]').getAttribute('aria-checked')"), 'true');
    await js("document.querySelector('.ms-mode-switch [data-mode=kairos]').click()");
    await waitFor("document.documentElement.dataset.appMode === 'kairos' && document.getElementById('view-content').dataset.view === 'home'");
    await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown'");
    assert.deepEqual(await js("[...document.querySelectorAll('.ms-tabbar-item')].map(n => n.dataset.tabbar)"), ['home', 'chats', 'calendar', 'more'], 'back in Kairos the bar is the Kairos bar');
    // The old Agents link opens the Bots roster on a phone.
    await js("document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'agents' } }))");
    await waitFor("document.documentElement.dataset.view === 'botsHome' && document.documentElement.dataset.appMode === 'bots'");

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    await reset([1440, 900]);
    await js(`(() => { try { localStorage.setItem('kairos:app-mode', 'kairos'); localStorage.removeItem('kairos:bots-interface'); localStorage.removeItem('kairos:bots-last-bot'); } catch {}
      window.__botsHost?.clearBotsStubs?.(); window.__botsHost?.closeBotSettings?.(); delete window.__botsHost; delete window.__botsCalls;
      delete document.documentElement.dataset.botsInterface; return true; })()`).catch(() => {});
    await restore();
  }
};
