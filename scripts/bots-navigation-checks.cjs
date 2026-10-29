// Bots navigation and sidebar, in the renderer (Phase 1, unit U4). Run behind --bots-navigation-only:
//   python run_electron_target.py <worktree> --bots-navigation-only <log> 600
// Covers: every old Agents link on desktop and phone (alias, bot, conversation, panel, team, archived and
// deleted bots), push/chat URLs and the service-worker message, the retired nav entries, the palette,
// the Advanced tree (folders, move, pin, rename, snooze, link, select, show all), Simple pinned circles,
// search, section and resize keyboard use, density, and the Preview badge matching appModes.
// It creates its own bot, threads and folder through the fixture API and removes them in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const key = (selector, k, extra = {}) => js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}))`);
  const docKey = (k, extra = {}) => js(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}))`);
  const view = () => js('document.getElementById("view-content").dataset.view');
  const mode = () => js('document.documentElement.dataset.appMode');
  const q = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";
  const sidebarWidth = async () => { await js("new Promise(resolve => { const sidebar = document.getElementById('sidebar'); let last = -1, same = 0; const tick = () => { const w = sidebar.getBoundingClientRect().width; same = w === last ? same + 1 : 0; last = w; same >= 4 ? resolve(true) : setTimeout(tick, 50); }; tick(); })"); return js("Math.round(document.getElementById('sidebar').getBoundingClientRect().width)"); };
  // Leaving a page mid-mount lets it build avatars while it unloads, and Chromium reports those data: SVG loads
  // as blocked connects (CSP). Let the page go quiet before each reload, as app-shell-checks.cjs does.
  const quiet = async () => {
    await waitFor("[...document.images].every(image => image.complete || image.loading === 'lazy')", 10000);
    await js("new Promise(resolve => { let timer; const done = () => { observer.disconnect(); resolve(true); }; const settle = () => { clearTimeout(timer); timer = setTimeout(done, 500); }; const observer = new MutationObserver(settle); observer.observe(document.documentElement, { childList: true, subtree: true }); settle(); setTimeout(done, 5000); })");
  };
  const reset = size => { win.setContentSize(size[0], size[1]); return delay(450); };
  const prefKeys = () => js("Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-sidebar:'))");
  const menuRow = label => `[...document.querySelectorAll('.bots-menu:not([data-closing]) .bots-menu-row')].find(n => n.textContent === ${JSON.stringify(label)})`;
  const pickMenu = async (opener, label) => {
    // A menu fades out for 200 ms after a pick; open the next one only when it is gone.
    await waitFor("!document.querySelector('.bots-menu')");
    await js(`document.querySelector(${JSON.stringify(opener)}).click()`);
    await waitFor(`!!${menuRow(label)}`);
    await js(`${menuRow(label)}.click()`);
  };

  const restore = await isolateBotsCheck({ js, demoState }, { botsNavigation: { sessions: {} } });
  const savedPrefs = await js("Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-sidebar:')).map(k => [k, localStorage.getItem(k)]))");
  let botId = null;
  try {
    demoState.botsLive = true;
    await js("Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-sidebar:')).forEach(k => localStorage.removeItem(k)); true");
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Our own bot, three conversations (the first is the main one) and a folder; nothing seeded is touched.
    const name = `Nav Probe ${Date.now() % 100000}`;
    const made = await call('/api/agents', 'POST', { name });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    botId = made.body.id;
    const folder = (await call(`/api/agents/${botId}/folders`, 'POST', { name: 'Nav Work' })).body;
    const thread = async (title, extra = {}) => (await call(`/api/agents/${botId}/threads`, 'POST', { title, ...extra })).body.id;
    const alpha = await thread('Nav alpha'), beta = await thread('Nav beta'), gamma = await thread('Nav gamma', { folder_id: folder.id });
    const threadsNow = async () => (await call(`/api/agents/${botId}/threads?include_archived=1`, 'GET')).body.threads;
    const threadById = async id => (await threadsNow()).find(t => t.id === id);
    const link = id => `[data-thread-id="${id}"]`;

    // -- Kairos: the Agents entry is gone everywhere --------------------------------------------------------
    assert.equal(await mode(), 'kairos');
    assert.equal(await q('#nav .nav-item[data-tab=agents], #rd-all-tabs .nav-item[data-tab=agents], #sidebar .nav-item[data-tab=agents]'), false, 'no Agents item in the Kairos sidebar');
    await docKey('k', { ctrlKey: true });
    await waitFor("!!document.querySelector('.palette-backdrop:not(.hidden)')");
    await waitFor(`[...document.querySelectorAll('.palette-item-label')].some(n => n.textContent === ${JSON.stringify('Open ' + name)})`);
    const labels = await js("[...document.querySelectorAll('.palette-item-label')].map(n => n.textContent)");
    assert.ok(labels.includes('Go to Bots'), 'the palette goes to Bots');
    assert.ok(!labels.includes('Go to Agents'), 'and has no Agents entry');
    assert.ok(labels.includes(`${name} settings`));
    await docKey('Escape');
    await waitFor("!!document.querySelector('.palette-backdrop.hidden')");

    // -- Preview badge follows appModes (it leaves with the phase's final pass) -----------------------------------------
    const badge = await js("import('/static/js/appModes.js').then(m => m.MODE_BADGES.bots || '')");
    assert.equal(await js("document.querySelector('#forge-mode-switch [data-mode=bots] small')?.textContent || ''"), badge, 'the switch shows exactly what appModes says');

    // -- Legacy links, desktop ----------------------------------------------------------------------------------------------------
    await navigate('agents');
    await waitFor("document.getElementById('view-content').dataset.view === 'botsHome' && document.documentElement.dataset.appMode === 'bots'");
    await navigate('agents', { agentId: botId, sessionId: beta });
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)} && !!document.querySelector('.bots-shell')`);
    assert.equal(await view(), 'botsShell');
    assert.equal(await mode(), 'bots', 'an old agent link switches to Bots mode');
    await navigate('agents', { agentId: botId, profile: true });
    await waitFor("!!document.querySelector('#bots-panel')");
    await js("import('/static/js/botsPanelHost.js').then(h => h.closeBotSettings())");
    await waitFor("!document.querySelector('#bots-panel')");
    await navigate('agents', { agentId: 'no-such-bot' });
    await waitFor("!!document.querySelector('.bots-home-message-page')");
    assert.match(await text('.bots-home-message-page'), /could not be found/, 'a deleted bot shows a recoverable message');
    assert.ok(await q('.bots-home-message-page .bots-btn'), 'with a way back');
    // An archived bot opens without being restored.
    assert.equal((await call(`/api/agents/${botId}`, 'PATCH', { hidden: true })).status, 200);
    await navigate('agents', { agentId: botId });
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)}`);
    assert.equal((await call(`/api/agents/${botId}`, 'GET')).body.agent.hidden, true, 'opening an archived bot does not restore it');
    assert.equal((await call(`/api/agents/${botId}`, 'PATCH', { hidden: false })).status, 200);
    // A team goes to the existing Swarm view, outside Bots.
    await navigate('agents', { team: 's1' });
    await waitFor("document.getElementById('view-content').dataset.view === 'swarm' && !!document.querySelector('.swarm-view')");
    assert.equal(await mode(), 'kairos', 'Swarm stays a Kairos view');
    await navigate('agents', { agentId: botId });
    await waitFor("document.documentElement.dataset.appMode === 'bots'");

    // -- Advanced: the tree -------------------------------------------------------------------------------------------------------
    await js("document.querySelector('.bots-rail .bots-segmented button[data-value=advanced]').click()");
    await waitFor("!!document.querySelector('.bots-rail-section[data-section=bots]')");
    assert.ok((await js("[...document.querySelectorAll('.bots-rail-section')].map(n => n.dataset.section)")).includes('bots'), 'the Bots section draws');
    const toggle = `[...document.querySelectorAll('.bots-rail-toggle')].find(n => n.getAttribute('aria-label').includes(${JSON.stringify(name)}))`;
    await waitFor(`!!${toggle}`);
    await js(`${toggle}.click()`);
    await waitFor(`!!document.querySelector('${link(alpha)}') && !!document.querySelector('${link(gamma)}')`);
    assert.equal(await js(`${toggle}.getAttribute('aria-expanded')`), 'true');
    assert.ok(await q(`.bots-folder[data-folder-id="${folder.id}"] ${link(gamma)}`), 'a conversation sits inside its folder');
    assert.ok(await q(`.bots-folder[data-folder-id=""] ${link(alpha)}`), 'and the others in the unfiled group');
    assert.equal(await js(`document.querySelector('${link(alpha)} .bots-thread-row').getAttribute('aria-label')`), 'Nav alpha');
    await capture?.('desktop-bots-sidebar-advanced');

    // Opening a conversation goes to that bot and conversation.
    await js(`document.querySelector('${link(beta)} .bots-thread-row').click()`);
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)}`);

    // Move to a folder from the menu.
    await pickMenu(`${link(beta)} .bots-rail-more`, 'Nav Work');
    await waitFor(`!!document.querySelector('.bots-folder[data-folder-id="${folder.id}"] ${link(beta)}')`);
    assert.equal((await threadById(beta)).thread.folder_id, folder.id, 'the server has the move');
    // Back out with "No folder".
    await pickMenu(`${link(beta)} .bots-rail-more`, 'No folder');
    await waitFor(`!!document.querySelector('.bots-folder[data-folder-id=""] ${link(beta)}')`);
    assert.equal((await threadById(beta)).thread.folder_id, null);

    // Pin, rename, copy link.
    await pickMenu(`${link(beta)} .bots-rail-more`, 'Pin');
    for (let i = 0; i < 100 && !(await threadById(beta)).thread.pinned; i++) await delay(50);
    assert.equal((await threadById(beta)).thread.pinned, true, 'pin is saved on the thread');
    await pickMenu(`${link(beta)} .bots-rail-more`, 'Rename');
    await waitFor("!!document.querySelector('.bots-rail-name-input')");
    assert.equal(await js("document.activeElement === document.querySelector('.bots-rail-name-input')"), true, 'rename takes focus');
    await fill('.bots-rail-name-input', 'Nav beta renamed');
    await key('.bots-rail-name-input', 'Enter');
    await waitFor(`document.querySelector('${link(beta)} .bots-thread-title')?.textContent === 'Nav beta renamed'`);
    assert.equal((await threadById(beta)).title, 'Nav beta renamed');
    await pickMenu(`${link(beta)} .bots-rail-more`, 'Rename');
    await waitFor("!!document.querySelector('.bots-rail-name-input')");
    await fill('.bots-rail-name-input', 'Never saved');
    await key('.bots-rail-name-input', 'Escape');
    await waitFor("!document.querySelector('.bots-rail-name-input')");
    assert.equal((await threadById(beta)).title, 'Nav beta renamed', 'Escape cancels a rename');
    await js("window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); true");
    await pickMenu(`${link(beta)} .bots-rail-more`, 'Copy link');
    await waitFor('window.__copied !== null');
    assert.equal(await js('window.__copied'), `${await js('location.origin')}/?agent=${botId}&chat=${beta}`, 'the link names the bot and conversation only');

    // The right-click and the context-menu key open the same menu; Escape closes it and focus comes back.
    await js(`document.querySelector('${link(alpha)}').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    await waitFor("!!document.querySelector('.bots-menu')");
    assert.ok(!(await js(`!!${menuRow('Archive')}`)) && (await js(`${menuRow('Delete')}.disabled`)), 'the main conversation cannot be archived or deleted');
    await docKey('Escape');
    await waitFor("!document.querySelector('.bots-menu')");

    // Snooze hides a conversation that is not pinned or open.
    await pickMenu(`${link(gamma)} .bots-rail-more`, 'Until something new');
    await waitFor(`!document.querySelector('${link(gamma)}')`);
    assert.equal((await threadById(gamma)).thread.snoozed_until, 0);

    // New conversation, six at most, Show all, bulk select.
    const before = (await threadsNow()).length;
    await js("document.querySelector('.bots-rail-children .bots-rail-newthread').click()");
    for (let i = 0; i < 100 && (await threadsNow()).length === before; i++) await delay(50);
    assert.equal((await threadsNow()).length, before + 1, 'New conversation creates one');
    for (let i = 0; i < 9; i++) await thread(`Nav bulk ${i}`);
    await js("document.dispatchEvent(new Event('kairos:bots-threads-changed'))");
    await delay(2200);
    await js("document.dispatchEvent(new Event('jarvis:agents-changed'))");
    await waitFor("!!document.querySelector('.bots-rail-showall')");
    const shown = await js("document.querySelectorAll('.bots-rail-children .bots-thread-line').length");
    await js("document.querySelector('.bots-rail-showall').click()");
    await waitFor(`document.querySelectorAll('.bots-rail-children .bots-thread-line').length > ${shown}`);
    const rows = await threadsNow();
    const bulk = rows.filter(t => /^Nav bulk/.test(t.title)).slice(0, 2).map(t => t.id);
    await pickMenu(`${link(bulk[0])} .bots-rail-more`, 'Select');
    await waitFor("!!document.querySelector('.bots-selection-bar')");
    await js(`document.querySelector('${link(bulk[1])} .bots-thread-check').click()`);
    await waitFor("document.querySelector('.bots-selection-count').textContent === '2 selected'");
    await js("[...document.querySelectorAll('.bots-selection-bar button')].find(n => n.textContent === 'Archive').click()");
    for (let i = 0; i < 100 && !(await threadById(bulk[1])).thread.archived_at; i++) await delay(50);
    assert.ok((await threadById(bulk[0])).thread.archived_at && (await threadById(bulk[1])).thread.archived_at, 'bulk archive reaches the server');
    await waitFor(`!document.querySelector('${link(bulk[0])}') && !document.querySelector('.bots-selection-bar')`);

    // Section order by keyboard, search from two characters.
    await js("document.querySelector('[data-key=\"section:bots\"]').focus()");
    const before2 = await js("[...document.querySelectorAll('.bots-rail-section')].map(n => n.dataset.section)");
    await key('[data-key="section:bots"]', 'ArrowUp', { altKey: true });
    const after2 = await js("[...document.querySelectorAll('.bots-rail-section')].map(n => n.dataset.section)");
    assert.notDeepEqual(after2, before2, 'Alt+Up moves the section');
    assert.equal(await js("document.activeElement?.dataset.key"), 'section:bots', 'focus stays on the moved section');
    await key('[data-key="section:bots"]', 'ArrowDown', { altKey: true });
    await fill('.bots-rail-search', 'N');
    await delay(500);
    assert.equal(await q('.bots-rail-results'), false, 'one character is not a search');
    await fill('.bots-rail-search', 'Nav alpha');
    await waitFor("!!document.querySelector('.bots-search-thread')");
    assert.match(await text('.bots-search-thread'), /Nav alpha/);
    await js(`document.querySelector('.bots-search-thread').click()`);
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)}`);
    await key('.bots-rail-search', 'Escape');
    await waitFor("!document.querySelector('.bots-rail-results')");

    // Saved per person, in this browser.
    const keys = await prefKeys();
    assert.equal(keys.length, 1, 'one preference record');
    const saved = JSON.parse(await js(`localStorage.getItem(${JSON.stringify(keys[0])})`));
    assert.ok(saved.expanded.includes(botId), 'the open bot is remembered');
    // Pinned, attention and bots, plus Channels (rooms) from Phase 4's team surfaces.
    assert.ok(Array.isArray(saved.sections) && saved.sections.length === 4 && saved.sections.includes('channels'));

    // -- Pin the bot: a circle in Simple ------------------------------------------------------------------------------------------
    await js(`window.__navPins = new Set(); window.__navFetch = window.fetch;
      window.fetch = async (u, o) => {
        const path = String(u);
        if (o?.method === 'POST' && path.startsWith('/api/agents/conversations/agent/')) {
          const id = decodeURIComponent(path.split('/').pop()); const act = JSON.parse(o.body).action;
          if (act === 'pin') window.__navPins.add(id); else window.__navPins.delete(id);
        }
        const res = await window.__navFetch(u, o);
        if (path === '/api/agents/conversations') {
          const body = await res.json(); (body.agents || []).forEach(a => { if (window.__navPins.has(a.id)) a.pinned = true; });
          return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return res;
      }; true`);
    const botMore = `[...document.querySelectorAll('.bots-rail-section[data-section=bots] .bots-rail-line')].find(n => n.querySelector('.bots-rail-row')?.dataset.agentId === ${JSON.stringify(botId)}).querySelector('.bots-rail-more')`;
    await js(`${botMore}.click()`);
    await waitFor(`!!${menuRow('Pin')}`);
    await js(`${menuRow('Pin')}.click()`);
    await waitFor(`!!document.querySelector('.bots-rail-section[data-section=pinned] .bots-rail-row[data-agent-id="${botId}"]')`);
    assert.ok(writes.some(w => w.path === `/api/agents/conversations/agent/${botId}` && JSON.parse(w.body).action === 'pin'), 'the pin is sent to the existing route');
    await js("document.querySelector('.bots-rail .bots-segmented button[data-value=simple]').click()");
    await waitFor(`!!document.querySelector('.bots-pins .bots-pin-circle[data-agent-id="${botId}"]')`);
    assert.equal(await js(`document.querySelector('.bots-pin-circle[data-agent-id="${botId}"]').getBoundingClientRect().width >= 44`), true, 'a pinned circle is a 44 px target');
    const roster = (await call('/api/agents', 'GET')).body.filter(a => !a.hidden).map(a => a.id).sort();
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-rail-row')].map(n => n.dataset.agentId).sort()"), roster, 'Simple lists every visible bot once');
    assert.equal(await js("document.querySelectorAll('.bots-rail-toggle, .bots-thread-row').length"), 0, 'Simple has no tree');
    await capture?.('desktop-bots-sidebar-simple');

    // -- Width and density ---------------------------------------------------------------------------------------------------------------
    assert.equal(await sidebarWidth(), 280, 'Simple is 280');
    await js("document.querySelector('.bots-rail .bots-segmented button[data-value=advanced]').click()");
    await waitFor("document.querySelector('.bots-rail-resize') && !document.querySelector('.bots-rail-resize').hidden");
    assert.equal(await sidebarWidth(), 320, 'Advanced is 320');
    assert.deepEqual(await js("(n => [n.getAttribute('role'), n.getAttribute('aria-orientation'), n.getAttribute('aria-valuemin'), n.getAttribute('aria-valuemax'), n.getAttribute('aria-valuenow'), n.tabIndex])(document.querySelector('.bots-rail-resize'))"),
      ['separator', 'vertical', '240', '480', '320', 0]);
    await js("document.querySelector('.bots-rail-resize').focus()");
    await key('.bots-rail-resize', 'ArrowRight');
    assert.equal(await sidebarWidth(), 336, 'an arrow steps 16 px');
    await key('.bots-rail-resize', 'ArrowLeft', { shiftKey: true });
    assert.equal(await sidebarWidth(), 288, 'Shift steps 48 px');
    await key('.bots-rail-resize', 'Home');
    assert.equal(await sidebarWidth(), 240);
    await key('.bots-rail-resize', 'End');
    assert.equal(await sidebarWidth(), 480);
    assert.equal(await js("document.querySelector('.bots-rail-resize').getAttribute('aria-valuenow')"), '480');
    await key('.bots-rail-resize', 'Home'); await key('.bots-rail-resize', 'ArrowRight');
    await js(`(() => { const s = document.querySelector('.bots-rail-resize').getBoundingClientRect(); const fire = (type, x) => document.querySelector('.bots-rail-resize').dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: s.top + 20, button: 0, pointerId: 1 }));
      fire('pointerdown', s.left + 4); fire('pointermove', s.left + 64); fire('pointerup', s.left + 64); })()`);
    assert.equal(await sidebarWidth(), 316, 'dragging 60 px moves the width from 256 to 316');
    // Saved: still that width after a reload.
    const keptWidth = await sidebarWidth();
    await quiet();
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.bots-rail')");
    await waitFor(`Math.round(document.getElementById('sidebar').getBoundingClientRect().width) === ${keptWidth}`);
    // Density: compact 272, icons 80 in Advanced, back to the comfortable width.
    await js("document.querySelector('.bots-rail-density').click()");
    await waitFor("document.querySelector('.bots-rail').dataset.density === 'compact'");
    assert.equal(await sidebarWidth(), 272);
    assert.equal(await js("document.querySelector('.bots-rail-resize').hidden"), true, 'only the comfortable width can be dragged');
    await js("document.querySelector('.bots-rail-density').click()");
    await waitFor("document.querySelector('.bots-rail').dataset.density === 'icons'");
    assert.equal(await sidebarWidth(), 80);
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-rail-name')).display"), 'none', 'icons show faces only');
    await capture?.('desktop-bots-sidebar-icons');
    await js("document.querySelector('.bots-rail-density').click()");
    await waitFor("document.querySelector('.bots-rail').dataset.density === 'comfortable'");
    assert.equal(await sidebarWidth(), keptWidth);
    // Leaving Bots gives the sidebar its own width back.
    await js("document.querySelector('#forge-mode-switch [data-mode=kairos]').click()");
    await waitFor("document.documentElement.dataset.appMode === 'kairos'");
    await waitFor("document.documentElement.style.getPropertyValue('--sidebar-width') === '' && !document.querySelector('.bots-rail')");

    // -- Push and chat links ------------------------------------------------------------------------------------------------------------------
    const goto = async query => { await quiet(); await win.loadURL(base + '/' + query); await waitFor("!!document.querySelector('#sidebar')"); };
    await js("localStorage.setItem('kairos:app-mode', 'kairos'); true");
    await goto(`?agent=${botId}&chat=${alpha}`);
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)} && !!document.querySelector('.bots-shell')`, 15000);
    await waitFor("location.pathname + location.search === '/'", 5000);
    assert.equal(await mode(), 'bots', 'a push link for a bot opens Bots');
    demoState.botsNavigation.sessions.abc123def456 = { agent_id: botId, title: 'Bot chat' };
    await js("localStorage.setItem('kairos:app-mode', 'kairos'); true");
    await goto('?chat=abc123def456');
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)}`, 15000);
    assert.equal(await view(), 'botsShell', 'a chat link whose session belongs to a bot opens inside that bot');
    await js("localStorage.setItem('kairos:app-mode', 'kairos'); true");
    await goto('?chat=fedcba654321');
    await waitFor("!!document.querySelector('#chat-messages[data-session-id=\"fedcba654321\"]')", 15000);
    assert.equal(await view(), 'chat', 'a plain chat link stays in Chats');
    await js("localStorage.setItem('kairos:app-mode', 'kairos'); true");
    await goto('?agent=../x');
    await waitFor("location.pathname + location.search === '/'", 5000);
    assert.notEqual(await view(), 'botsShell', 'a malformed bot link opens nothing of Bots');
    // The service worker's message goes through the same boundary.
    if (await js('!!navigator.serviceWorker')) {
      await js(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'kairos:open-chat', url: '/?agent=${botId}' } })); true`);
      await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)}`, 10000);
      await js(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'kairos:open-chat', url: 'https://evil.example/?agent=x' } })); true`);
      await delay(300);
      assert.equal(await js("document.documentElement.dataset.botsAgent"), botId, 'another origin opens nothing');
    }

    // -- Phone ------------------------------------------------------------------------------------------------------------------------------------------
    await js("localStorage.setItem('kairos:app-mode', 'kairos'); true");
    await quiet();
    await win.loadURL(base);
    await reset([390, 844]);
    await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown'");
    assert.deepEqual(await js("[...document.querySelectorAll('.ms-tabbar-item')].map(n => n.dataset.tabbar)"), ['home', 'chats', 'calendar', 'more'], 'the phone bar has no Agents');
    await navigate('agents', { agentId: botId });
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(botId)} && document.querySelector('.ms-tabbar')?.dataset.mode === 'bots'`);
    assert.equal(await view(), 'botsShell', 'an old agent link opens the bot on a phone');
    await navigate('agents');
    await waitFor("document.getElementById('view-content').dataset.view === 'botsHome'");
    assert.equal(await js("document.querySelector('.ms-tabbar [data-tabbar=botsHome]').getAttribute('aria-current')"), 'page');
    await reset([1440, 900]);

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    try {
      await js("if (window.__navFetch) window.fetch = window.__navFetch; try { localStorage.setItem('kairos:app-mode', 'kairos'); Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-sidebar:')).forEach(k => localStorage.removeItem(k)); } catch {} true");
      await js(`(() => { for (const [k, v] of Object.entries(${JSON.stringify(savedPrefs)})) localStorage.setItem(k, v); return true; })()`);
      if (botId) await js(`fetch('/api/agents/${botId}', { method: 'DELETE' }).then(r => r.status)`);
    } catch { /* the page may be gone; the fixture store is dropped below */ }
    await reset([1440, 900]).catch(() => {});
    await restore();
  }
};
