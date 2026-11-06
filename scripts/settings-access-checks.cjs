// A14 Settings window (Part 2 group g7, 2026-10-27). Runs alone with
// `--g7-only` (not in the default ui-smoke run). Real mouse events, the real
// settings.js, the mocked backend (demo/fixtures.js).
//   1. Search reaches every section by its label and by every keyword it declares.
//   2. Member vs admin: the sections each can reach, and a deep link to an admin
//      section lands on a reachable one.
//   3. Desktop window: drag, clamp, resize from a corner, minimum size,
//      minimize/restore, Escape, backdrop click.
//   4. Closing (or Back on a phone) while a page is still loading never reopens it.
//   5. Retired controls stay absent.
//   6. Efficiency: requests and time per panel open (printed as JSON for the report).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function registry() {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/views/settings.js'), 'utf8');
  const start = source.indexOf('const SECTION_GROUPS = [');
  const block = source.slice(start, source.indexOf('\n];', start) + 3);
  const context = {};
  for (const [, name] of source.matchAll(/render: (\w+)/g)) context[name] = () => {};
  vm.createContext(context);
  vm.runInContext(block + '\nthis.registry = SECTION_GROUPS;', context);
  // "This Kairos" pages are for admins only; a page needing this computer needs machine access too.
  const set = name => {
    const at = source.indexOf(`const ${name} = new Set([`);
    return new Set(source.slice(at, source.indexOf(']);', at)).match(/"([^"]+)"/g).map(x => x.slice(1, -1)));
  };
  const kairos = set('THIS_KAIROS'), machine = set('NEEDS_MACHINE');
  const sections = [];
  for (const group of context.registry) for (const section of group.sections) {
    sections.push({ id: section.id, label: section.label, keywords: Array.from(section.keywords || []), admin: !!(group.admin || section.admin || kairos.has(section.id)), machine: machine.has(section.id) });
  }
  return sections;
}

module.exports = async ({ js, win, waitFor, delay, navigate, capture, demoState, reads, writes }) => {
  const sections = registry();
  const adminIds = sections.filter(s => s.admin).map(s => s.id);
  const memberIds = sections.filter(s => !s.admin && !s.machine).map(s => s.id);
  const mouse = (type, x, y, extra = {}) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
    { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const press = async (key, code, vk) => {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
    await delay(120);
  };
  const open = section => js(`import('/static/js/views/settings.js').then(m => m.openSettingsWindow(${JSON.stringify(section || 'appearance')}))`);
  const navIds = () => js("[...document.querySelectorAll('.settings-nav-item')].map(n => n.dataset.section)");
  const visibleNav = () => js("[...document.querySelectorAll('.settings-nav-item')].filter(n => !n.hidden).map(n => n.dataset.section)");
  const search = value => js(`(() => { const i = document.querySelector('.settings-search'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const rect = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
  const modalOpen = () => js("!!document.querySelector('.modal-backdrop:not(.hidden) .settings-window')");
  const settled = async selector => {
    let last = '';
    for (let i = 0; i < 30; i++) {
      const now = JSON.stringify(await rect(selector));
      if (now === last) return; last = now; await delay(80);
    }
  };
  const close = async () => { if (await modalOpen()) await js(`document.querySelector('.settings-titlebar-btn[title="Close"]').click()`); await delay(250); };
  const delayFetch = (match, ms) => js(`(() => { window.__realFetch = window.__realFetch || window.fetch;
    window.fetch = (u, o) => String(u).includes(${JSON.stringify(match)}) ? new Promise(r => setTimeout(r, ${ms})).then(() => window.__realFetch(u, o)) : window.__realFetch(u, o); })()`);
  const undelay = () => js("if (window.__realFetch) { window.fetch = window.__realFetch; delete window.__realFetch; }");
  const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };

  win.setContentSize(1440, 900); await delay(350);
  demoState.isAdmin = true;
  await navigate('home');

  // -- 1. search -----------------------------------------------------------------------------
  await open('appearance'); await waitFor("document.querySelectorAll('.settings-nav-item').length > 5");
  const admin = await navIds();
  assert.ok(admin.includes('images'), 'admins can reach Image generation');
  assert.deepEqual(await js("[...document.querySelector('.settings-nav-item[data-section=images]').parentElement.querySelectorAll('.settings-nav-item')].map(n => n.dataset.section)"),
    ['integrations', 'images', 'channels', 'remote'], 'Image generation follows Integrations under Connections');
  assert.deepEqual(admin.slice().sort(), sections.map(s => s.id).sort(), 'an admin reaches every section exactly once');
  assert.deepEqual(await js("[...document.querySelectorAll('.settings-nav-group')].map(n => n.textContent)"),
    ['General', 'Models', 'Connections', 'Agents', 'Bots', 'Your data', 'Access', 'Advanced'], 'final grouping');
  assert.deepEqual(admin.slice(0, 5), ['appearance', 'layout', 'notifications', 'speech', 'shortcuts'], 'General holds the personal settings');
  const misses = [];
  for (const section of sections) {
    const terms = [section.label.toLowerCase(), ...section.keywords];
    for (const term of terms) {
      await search(term);
      if (!(await visibleNav()).includes(section.id)) misses.push(`${term} -> ${section.id}`);
    }
  }
  assert.deepEqual(misses, [], 'every label and keyword finds its section');
  await search('zzzzzz-nothing');
  assert.deepEqual(await visibleNav(), [], 'a nonsense search shows no section');
  assert.equal(await js("[...document.querySelectorAll('.settings-nav-group')].filter(n => !n.hidden).length"), 0, 'and no empty group heading');
  await search('  TAILSCALE  ');
  assert.deepEqual(await visibleNav(), ['remote'], 'search ignores case and surrounding spaces');
  await search('');
  assert.deepEqual((await visibleNav()).sort(), admin.slice().sort(), 'clearing the search brings every section back');
  const clicked = [];
  for (const id of admin) {
    await js(`document.querySelector('.settings-nav-item[data-section="${id}"]').click()`);
    await waitFor(`document.querySelector('.set-page')?.dataset.page === ${JSON.stringify(id)} && document.querySelector('.settings-nav-item.active')?.dataset.section === ${JSON.stringify(id)}`);
    clicked.push(id);
  }
  assert.equal(clicked.length, admin.length, 'every section opens from its nav row');
  await close();

  // -- 2. member and admin ---------------------------------------------------------------------
  demoState.isAdmin = false;
  await open('permissions'); await waitFor("document.querySelectorAll('.settings-nav-item').length > 3");
  const member = await navIds();
  assert.ok(!member.includes('images'), 'members cannot reach Image generation');
  assert.deepEqual(member.slice().sort(), memberIds.slice().sort(), 'a member reaches exactly the My account sections that need no machine access');
  assert.ok(await js("[...document.querySelectorAll('.settings-nav-item')].every(n => n.dataset.section !== 'bot-computers')"), 'Bot computers needs machine access');
  assert.ok(await js("document.querySelector('.set-scope[data-scope=mine]')?.textContent.includes('My account')"), 'a member page says My account');
  for (const id of adminIds) assert.ok(!member.includes(id), `${id} is hidden from a member`);
  assert.ok(memberIds.includes(await js("document.querySelector('.settings-nav-item.active')?.dataset.section")), 'a deep link to an admin section lands on a reachable one');
  await search('permission');
  assert.ok(!(await visibleNav()).includes('permissions'), 'search never surfaces an admin section to a member');
  await close();
  demoState.isAdmin = true;
  await open('users'); await waitFor("!!document.querySelector('.set-scope[data-scope=kairos]')");
  assert.ok(await js("document.querySelector('.set-scope[data-scope=kairos]').textContent.includes('This Kairos')"), 'an admin page says This Kairos');
  await close();

  // -- 3. the desktop window --------------------------------------------------------------------
  await open('add-models'); await waitFor("!!document.querySelector('.settings-window .settings-nav-item')"); await settled('.settings-window');
  const start = await rect('.settings-window');
  const title = await rect('.settings-titlebar .title');
  const grab = { x: Math.round(title.l + 40), y: Math.round(title.t + title.h / 2) };
  await mouse('mousePressed', grab.x, grab.y); await mouse('mouseMoved', grab.x + 60, grab.y + 45); await mouse('mouseReleased', grab.x + 60, grab.y + 45);
  await delay(100);
  const moved = await rect('.settings-window');
  assert.ok(Math.abs(moved.l - start.l - 60) <= 2 && Math.abs(moved.t - start.t - 45) <= 2, `dragging the titlebar moves the window ${JSON.stringify([moved.l - start.l, moved.t - start.t])}`);
  await mouse('mousePressed', grab.x + 60, grab.y + 45); await mouse('mouseMoved', 1439, 899); await mouse('mouseReleased', 1439, 899);
  await delay(100);
  const far = await rect('.settings-window');
  assert.ok(far.l >= 0 && far.t >= 0 && far.r <= 1440 + 1 && far.b <= 900 + 1, 'a drag far past the edge keeps the window on screen');
  await mouse('mousePressed', 5, 5); await mouse('mouseReleased', 5, 5);  // stray click outside is harmless
  await close(); await open('add-models'); await settled('.settings-window');
  const reopened = await rect('.settings-window');
  assert.ok(Math.abs(reopened.w - start.w) <= 1 && Math.abs(reopened.h - start.h) <= 1, 'reopening keeps the window size');
  const handle = async () => { const h = await rect('.settings-window .resize-se'); return { x: Math.round(h.l + 2), y: Math.round(h.t + 2) }; };  // the handle's inner corner: its centre sits under the content, its outer corner outside the window };
  const corner = await handle();
  await mouse('mousePressed', corner.x, corner.y); await mouse('mouseMoved', corner.x - 900, corner.y - 700); await mouse('mouseReleased', corner.x - 900, corner.y - 700);
  await delay(100);
  const small = await rect('.settings-window');
  assert.ok(small.w >= 479 && small.h >= 359 && small.w < reopened.w - 100, `resizing cannot go below the minimum ${Math.round(small.w)}x${Math.round(small.h)}`);
  await settled('.settings-window');
  const smallCorner = await handle();
  await mouse('mousePressed', smallCorner.x, smallCorner.y); await mouse('mouseMoved', smallCorner.x + 120, smallCorner.y + 90); await mouse('mouseReleased', smallCorner.x + 120, smallCorner.y + 90);
  await delay(100);
  const grown = await rect('.settings-window');
  assert.ok(grown.w > small.w + 100 && grown.h > small.h + 70, 'dragging the bottom-right corner outward grows the window ' + JSON.stringify({ small, grown, smallCorner }));
  await js(`document.querySelector('.settings-titlebar-btn[title="Minimize"]').click()`); await delay(250);
  assert.equal(await modalOpen(), false, 'minimize hides the window');
  assert.equal(await js("!!document.querySelector('.settings-minimized-pill')"), true, 'and leaves a pill');
  await js("document.querySelector('.settings-minimized-pill').click()"); await delay(300);
  const restored = await rect('.settings-window');
  assert.ok(await modalOpen() && Math.abs(restored.w - grown.w) <= 1 && Math.abs(restored.h - grown.h) <= 1, 'restore brings back the same size');
  assert.equal(await js("!!document.querySelector('.settings-minimized-pill')"), false, 'the pill is gone once restored');
  await press('Escape', 'Escape', 27);
  assert.equal(await modalOpen(), false, 'Escape closes the window');
  await open('add-models'); await settled('.settings-window');
  await js("document.querySelector('.settings-window').closest('.modal-backdrop').dispatchEvent(new MouseEvent('click', { bubbles: true }))"); await delay(250);
  assert.equal(await modalOpen(), false, 'clicking outside closes it');

  // -- 4. closing while a page loads ------------------------------------------------------------------
  await delayFetch('/api/remote/status', 1200);
  await open('appearance'); await waitFor("!!document.querySelector('.settings-nav-item[data-section=remote]')");
  await js("document.querySelector('.settings-nav-item[data-section=remote]').click()");
  await delay(200);
  await close();
  await delay(1500);
  assert.equal(await modalOpen(), false, 'a page that finishes loading after Close does not reopen Settings');
  await undelay();
  await delayFetch('/api/auth/status', 800);
  const first = open('appearance'); await delay(100);
  const second = open('notifications');
  await Promise.allSettled([first, second]); await delay(300);
  assert.equal(await js("document.querySelectorAll('.settings-window').length"), 1, 'two quick opens make one window');
  assert.equal(await js("document.querySelector('.settings-nav-item.active')?.dataset.section"), 'notifications', 'the later request wins');
  await undelay(); await close();

  // -- 5. retired controls ----------------------------------------------------------------------------
  await open('appearance'); await waitFor("document.querySelector('.set-page')?.dataset.page === 'appearance'"); await delay(300);
  const appearanceText = await js("document.querySelector('.set-page').textContent.toLowerCase()");
  assert.ok(!/classic/.test(appearanceText), 'Appearance has no Classic look');
  await js("document.querySelector('.settings-nav-item[data-section=notifications]').click()"); await delay(400);
  const notifications = await js("document.querySelector('.set-page').textContent.toLowerCase()");
  assert.ok(!/bot window|floating bot/.test(notifications.replace(/the floating bot window they.*$/, '')), 'Notifications has no bot-window controls');
  await close();

  // -- 6. efficiency: requests and time per panel ------------------------------------------------------
  // The Settings bot panels (/api/bots/*, /api/bot-usage/*, /api/agents/defaults, /api/bot-workbench/*) are answered by the
  // in-memory Bots backend (scripts/fixtures/bots-*-backend.cjs) while demoState.botsLive is set; without it each is "No fixture".
  const priorBotsLive = demoState.botsLive; demoState.botsLive = true;
  const costs = {};
  for (const section of sections) {
    const times = [], counts = [], duplicates = [];
    for (let round = 0; round < 3; round++) {
      await close();
      const before = reads.length;
      const startedAt = Date.now();
      await open(section.id);
      await waitFor(`document.querySelector('.set-page')?.dataset.page === ${JSON.stringify(section.id)} && document.querySelector('.set-body')?.children.length > 0`, 15000);
      times.push(Date.now() - startedAt);
      await delay(150);
      const batch = reads.slice(before).map(r => r.path + (r.query && Object.keys(r.query).length ? '?' + new URLSearchParams(r.query) : ''));
      counts.push(batch.length);
      const seen = {}; for (const r of batch) seen[r] = (seen[r] || 0) + 1;
      duplicates.push(Object.entries(seen).filter(([, n]) => n > 1).map(([p, n]) => `${p} x${n}`));
    }
    costs[section.id] = { p50_ms: percentile(times, 0.5), p95_ms: percentile(times, 0.95), requests: counts[counts.length - 1], duplicate_reads: duplicates[duplicates.length - 1] };
    expect(!costs[section.id].duplicate_reads.length, `${section.id} reads one path more than once per open: ${costs[section.id].duplicate_reads.join(', ')}`);
  }
  await close();
  // Switching between panels with Settings already open.
  await open('appearance'); await waitFor("!!document.querySelector('.settings-nav-item')");
  const switchTimes = [], switchRequests = [];
  for (const id of ['add-models', 'integrations', 'channels', 'vault', 'permissions', 'hooks', 'logs', 'appearance']) {
    const before = reads.length, startedAt = Date.now();
    await js(`document.querySelector('.settings-nav-item[data-section="${id}"]').click()`);
    await waitFor(`document.querySelector('.set-page')?.dataset.page === ${JSON.stringify(id)} && document.querySelector('.set-body')?.children.length > 0`, 15000);
    switchTimes.push(Date.now() - startedAt); await delay(120); switchRequests.push(reads.length - before);
  }
  // Idle: nothing may poll while Settings sits open on a quiet panel.
  await js("document.querySelector('.settings-nav-item[data-section=appearance]').click()"); await delay(500);
  // The one poll allowed to run behind Settings is app.js refreshAgentBadge() reading /api/agents/inbox: bot notifications
  // depend on it, so it keeps its 30-second beat. The Home refresh and the sidebar poll pause while Settings is open.
  const idleReadsFrom = reads.length, idleWritesFrom = writes.length; await delay(6000);
  const idle = reads.slice(idleReadsFrom).filter(r => r.path !== '/api/agents/inbox').length + (writes.length - idleWritesFrom);
  await close();
  // Channels redraws its list every 5 seconds while it is on screen; once Settings is closed nothing should keep asking.
  await open('channels'); await waitFor("document.querySelector('.set-page')?.dataset.page === 'channels' && document.querySelector('.channel-list')"); await delay(400);
  // Only the requests settingsChannels.js's own loop makes count (its draw() reads /api/settings/discord-bots, /api/connectors and
  // /api/system/status). /api/system/status is shared with the rest of the app, so it is left out; other panels and app-wide polls
  // are not the Channels loop (batch 2: scoped from "every request after Settings closes").
  const channelsPath = (r) => r.path === '/api/connectors' || r.path.startsWith('/api/connectors/') || r.path === '/api/settings/discord-bots' || r.path.startsWith('/api/settings/discord-bots/');
  const channelsCount = (from) => reads.slice(from).filter(channelsPath).length;
  const livePolls = reads.length; await delay(5600); const whileOpen = channelsCount(livePolls);
  expect(whileOpen > 0, 'the Channels loop was expected to poll while its panel is open (otherwise the check below proves nothing)');
  await close();
  const closedMark = reads.length; await delay(11000);
  const afterClose = channelsCount(closedMark);
  expect(afterClose === 0, `Channels kept polling after Settings was closed: ${afterClose} request(s) in 11 seconds (${whileOpen} while it was open in 5.6 seconds)`);
  console.log('G7_SETTINGS_COST ' + JSON.stringify({ perOpen: costs, switchTimesMs: switchTimes, switchRequests,
    switchP50: percentile(switchTimes, 0.5), switchP95: percentile(switchTimes, 0.95), idleRequestsIn6s: idle,
    channelsRequestsWhileOpen5_6s: whileOpen, channelsRequestsAfterClose11s: afterClose }));
  expect(idle === 0, `Settings open on Appearance made ${idle} request(s) in 6 idle seconds`);

  if (priorBotsLive === undefined) delete demoState.botsLive; else demoState.botsLive = priorBotsLive;

  // -- 7. phone: Back during a load stays on the list ------------------------------------------------------
  win.setContentSize(390, 844); await delay(400);
  await navigate('notes'); await delay(300);
  await js("document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings' } }))");
  await waitFor("document.querySelector('.settings-mobile-page')?.dataset.mobileView === 'list' && document.querySelectorAll('.settings-nav-item').length > 3");
  await delayFetch('/api/remote/status', 900);
  await js("document.querySelector('.settings-nav-item[data-section=remote]').click()"); await delay(150);
  await js("document.querySelector('.settings-mobile-back').click()"); await delay(1300);
  assert.equal(await js("document.querySelector('.settings-mobile-page').dataset.mobileView"), 'list', 'Back while a page loads is not undone when it arrives');
  await undelay();
  await js("document.querySelector('.settings-nav-item[data-section=notifications]').click()");
  await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'");
  await js("document.querySelector('.settings-mobile-back').click()");
  await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'list'");
  await js("document.querySelector('.settings-mobile-back').click()");
  await waitFor("!document.querySelector('.settings-mobile-page')");
  win.setContentSize(1440, 900); await delay(350);

  assert.deepEqual(problems, [], 'Settings efficiency or behaviour problems:\n' + problems.join('\n'));
};
