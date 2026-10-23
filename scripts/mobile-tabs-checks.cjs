// Phone checks for the tabs, the shared dock and sheet, and Settings
// navigation. Two ways to run it:
//   node scripts/run-electron-test.cjs scripts/mobile-tabs-checks.cjs   (standalone)
//   require('./mobile-tabs-checks.cjs').run(context)                    (from ui-smoke)
// Standalone mode reuses ui-smoke's synthetic backend: it takes the harness
// head of ui-smoke.cjs (everything before the test body) and appends this
// module as the body, so no request can reach a real backend.
// Set MT_OUT to choose the screenshot folder and MT_EXPLORE to run a scratch
// script (a module taking the same context) instead of the checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run(ctx) {
  const { js, win, waitFor, delay, navigate, capture, writes, overflow } = ctx;
  const resize = async (w, h) => { win.setContentSize(w, h); await delay(350); };
  const shot = async name => { await capture('mt-' + name); };
  if (process.env.MT_EXPLORE) { await require(path.resolve(process.env.MT_EXPLORE))({ ...ctx, resize, shot }); return; }
  let assertions = 0;
  const ok = (value, message) => { assertions++; assert.ok(value, message); };
  const eq = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
  const rect = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n || !n.getClientRects().length) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
  const hit = (a, b) => !!a && !!b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const type = (selector, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const rowState = () => js(`[...document.querySelectorAll('[data-mobile-row]')].filter(r => r.getClientRects().length || r.classList.contains('ms-filtered-out')).map(r => r.classList.contains('ms-filtered-out') ? 0 : 1)`);
  const shown = async () => (await rowState()).reduce((a, b) => a + b, 0);
  const small = scope => js(`[...document.querySelectorAll(${JSON.stringify(scope)})].filter(n => !n.disabled && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').map(n => (n.matches('input[type=checkbox], input[type=radio]') && n.closest('label')) || n).filter(n => { const r = n.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map(n => (n.getAttribute('aria-label') || n.textContent || n.placeholder || n.className).trim().slice(0, 24) + ' ' + Math.round(n.getBoundingClientRect().width) + 'x' + Math.round(n.getBoundingClientRect().height))`);
  const noSideways = () => js('document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1');
  const setTheme = color => js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: ${JSON.stringify(color)} }))`);
  const PARCHMENT = '#f3eadb', FOREST = '#23302e';
  const docks = () => js("document.querySelectorAll('.ms-dock').length");
  const dockInfo = () => js(`(() => { const d = document.querySelector('.ms-dock'); if (!d) return null; return { input: d.querySelector('input')?.placeholder || null, inputInDock: !!d.querySelector('input'), buttons: [...d.querySelectorAll('button')].map(b => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), disabled: b.disabled })) }; })()`);
  const view = '#view-content';

  await setTheme(PARCHMENT);
  await resize(390, 844);
  await js("document.documentElement.style.setProperty('--native-safe-bottom', '0px')");

  // 2026-10-22 (David): a liquid-glass tab bar at the bottom replaces the top-left avatar and its workspace sheet.
  const MORE = "document.querySelector('.ms-tabbar [data-tabbar=more]')";
  const barState = () => js("document.querySelector('.ms-tabbar')?.dataset.state || null");
  const barCurrent = () => js("document.querySelector('.ms-tabbar')?.dataset.state === 'shown' ? document.querySelector('.ms-tabbar [aria-current=page]')?.dataset.tabbar || null : 'hidden'");
  // The bar follows the page on the next frame (mobileTabBar.js); two frames later it has settled.
  const frames = () => js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const barShown = async () => { await frames(); await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown' && getComputedStyle(document.querySelector('.ms-tabbar')).transform === 'none'"); };
  const barGone = () => waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'hidden' && getComputedStyle(document.querySelector('.ms-tabbar')).visibility === 'hidden'");
  const noAvatar = () => js("!document.getElementById('mobile-menu-btn') && !document.querySelector('.ms-avatar, .menu-stroke')");
  const checkChrome = async (tab, current = 'more') => {
    ok(await noAvatar(), tab + ' has no avatar or hamburger');
    if (current === 'hidden') { await barGone(); ok(await barCurrent() === 'hidden', tab + ' hides the tab bar'); }
    else { await barShown(); eq(await barCurrent(), current, tab + ' marks ' + current + ' on the tab bar'); }
    ok(await js("document.getElementById('view-content').getBoundingClientRect().left === 0"), tab + ' page keeps the full width');
    const frost = await js("(() => { const n = document.querySelector('.ms-global-frost'); const i = n.querySelector('i'); const s = getComputedStyle(i); return { top: n.getBoundingClientRect().top, bg: s.backgroundColor, blur: parseFloat((s.backdropFilter.match(/blur[(]([0-9.]+)px/) || [])[1]), mask: s.maskImage.includes('linear-gradient'), shown: getComputedStyle(n).visibility !== 'hidden' }; })()");
    ok(frost.top === 0 && frost.shown && frost.mask && frost.blur <= 8 && /rgba\(0, 0, 0, 0\)|transparent/.test(frost.bg), tab + ' frost starts at y=0 as a light, masked, untinted blur: ' + JSON.stringify(frost));
    // 2026-10-21 (David, on device): the frost covers only the status bar area (safe area + a short fade), and the older tinted strip is gone.
    const band = await js("(() => { const n = document.querySelector('.ms-global-frost'); const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;top:0;height:var(--mobile-safe-top, env(safe-area-inset-top, 0px))'; document.body.append(probe); const safe = probe.getBoundingClientRect().height; probe.remove(); return { height: n.getBoundingClientRect().height, safe, blur: parseFloat((getComputedStyle(n.querySelector('i')).backdropFilter.match(/blur[(]([0-9.]+)px/) || [])[1]), strip: getComputedStyle(document.documentElement, '::after').display }; })()");
    ok(band.height <= band.safe + 0.5 && band.blur <= 1 && band.strip === 'none', tab + ' frost ends at the bottom of the status bar area, light, with no tinted strip: ' + JSON.stringify(band));
    // With the avatar gone, nothing in a page header is drawn under the tab bar either.
    if (current !== 'hidden') ok(await js("(() => { const a = document.querySelector('.ms-tabbar').getBoundingClientRect(); return [...document.querySelectorAll('#view-content > header, #view-content .view-header, #view-content .settings-titlebar')].flatMap(h => [...h.querySelectorAll('h1, h2, h3, button, input')]).filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').every(n => n.getBoundingClientRect().bottom <= a.top + 0.5); })()"), tab + ' header controls sit clear of the tab bar');
  };
  for (const [tab, current] of [['home', 'home'], ['agents', 'agents'], ['tool-store', 'more'], ['school', 'more']]) {
    await navigate(tab); await delay(500); await checkChrome(tab, current);
  }
  const centeredComposer = async (selector, expanded = false) => {
    await delay(450); // the composer morph settles before its geometry is read
    await waitFor(`document.querySelector('${selector}').classList.contains('ms-composer-expanded') === ${expanded}`);
    const measured = await js(`(() => {
      const bar = document.querySelector('${selector}');
      const nodes = ${expanded} ? [...bar.querySelectorAll('.ms-forge-add, .ms-forge-mic, .ms-embedded-model-trigger')].filter(n => n.getClientRects().length)
        : [bar.querySelector('textarea'), bar.querySelector('.ms-forge-add'), bar.querySelector('.ms-forge-mic')];
      const centers = nodes.map(n => { const r = n.getBoundingClientRect(); return (r.top + r.bottom) / 2; });
      return { centers, spread: Math.max(...centers) - Math.min(...centers) };
    })()`);
    ok(measured.centers.length >= 3 && measured.spread <= 1, selector + (expanded ? ' bottom row' : ' resting controls and text') + ' centered within 1px: ' + JSON.stringify(measured));
  };

  // ---- A. Every dock tab: geometry, controls, content clearance -------------------------
  const TABS = [
    ['notes', { input: 'Search notes', plus: 'Add note' }],
    ['library', { input: /Search documents/, plus: 'New document' }],
    ['tasks', { input: 'Search tasks and cards', plus: 'Schedule a task' }],
    ['cookbook', { input: 'Search models', plus: 'Add a local model' }],
    ['email', { input: 'Search mail and accounts', plus: 'Connect an email account' }],
    ['calendar', { input: null, plus: 'New event' }],
  ];
  for (const [tab, want] of TABS) {
    await navigate(tab);
    await waitFor("document.querySelectorAll('.ms-dock').length === 1");
    await delay(250);
    ok(await noAvatar(), tab + ' has the tab bar instead of an avatar or hamburger');
    eq(await barCurrent(), tab === 'calendar' ? 'calendar' : 'more', tab + ' marks its item on the tab bar');
    const tabbar = await rect('.ms-tabbar');
    ok(tabbar && Math.abs(tabbar.b - (844 - 12)) <= 1 && tabbar.l >= 15.5 && tabbar.r <= 390 - 15.5 && tabbar.h === 62, tab + ' tab bar floats 12px above the bottom with 16px sides: ' + JSON.stringify(tabbar));
    const label = tab + ' dock';
    eq(await docks(), 1, label + ' mounts exactly once');
    ok(await js("document.querySelector('.ms-dock').parentElement === document.body"), label + ' lives outside the animating view');
    const early = await rect('.ms-dock'); ok(early && Math.abs(early.b - (tabbar.t - 10)) <= 1, label + ' is already in place on arrival, 10px above the tab bar: ' + JSON.stringify(early));
    const info = await dockInfo();
    if (want.input instanceof RegExp) ok(want.input.test(info.input), label + ' search is the page search: ' + info.input);
    else if (want.input) eq(info.input, want.input, label + ' search placeholder');
    else ok(!info.inputInDock, label + ' has no search field');
    ok(info.buttons.some(b => b.label === want.plus && b.text === '+'), label + ' has a "+" named ' + want.plus + ': ' + JSON.stringify(info.buttons));
    const d = await rect('.ms-dock');
    ok(d && d.l >= 11 && d.r <= 379 && d.h >= 50 && Math.abs(d.b - (tabbar.t - 10)) <= 1 && !hit(d, tabbar), label + ' sits in the thumb zone, above the tab bar, with margins ' + JSON.stringify(d));
    eq(await small('.ms-dock button, .ms-dock input'), [], label + ' controls are 44px');
    ok(await noSideways(), label + ' does not scroll sideways');
    eq(await overflow(), [], label + ' no overflow');
    // The last content must scroll clear of the dock.
    const clear = await js(`(() => { const v = document.querySelector('${view}'); v.scrollTo(0, 1e6); window.scrollTo(0, 1e6); const dock = document.querySelector('.ms-dock').getBoundingClientRect(); const items = [...v.querySelectorAll('.view-constrained > *, .view-constrained .cal-day-panel')].filter(n => n.getClientRects().length); const last = Math.max(...items.map(n => n.getBoundingClientRect().bottom)); return { last, top: dock.top }; })()`);
    ok(clear.last <= clear.top + 1, label + ' last content clears the dock ' + JSON.stringify(clear));
    const pill = await rect('.ms-activity-floating');
    if (pill) ok(!hit(pill, d), label + ' activity pill clears the dock');
    await js(`document.querySelector('${view}').scrollTo(0, 0)`);
    await shot('dock-' + tab);
  }

  // ---- B. Search fields: filter, no-match note, persistence across re-render -------------
  await navigate('notes');
  await waitFor("document.querySelectorAll('[data-mobile-row]').length === 3");
  eq(await rowState(), [1, 1, 1], 'Notes start unfiltered');
  await type('.ms-dock input', 'workspa');
  eq(await shown(), 1, 'Notes search "workspa" keeps one row');
  await type('.ms-dock input', 'zzz-nothing');
  ok(await js("!!document.querySelector('.ms-dock-note') && document.querySelector('.ms-dock-note').textContent.includes('zzz-nothing')"), 'Notes shows a no-match note');
  eq(await shown(), 0, 'Notes search with no match hides every row');
  const note = await rect('.ms-dock-note'), dock = await rect('.ms-dock'), pill = await rect('.ms-activity-floating');
  ok(note.b <= dock.t && note.l >= 11 && (!pill || !hit(note, pill)), 'The no-match note sits above the dock and clear of the pill');
  await shot('notes-no-match');
  await type('.ms-dock input', 'Review');
  await js("document.querySelector('[data-mobile-row]:not(.ms-filtered-out) input[type=checkbox]').click()");
  await delay(900);
  await waitFor("document.querySelectorAll('[data-mobile-row]').length === 3");
  eq(await js("document.querySelector('.ms-dock input').value"), 'Review', 'The dock keeps the typed query through a re-render');
  eq(await shown(), 1, 'Notes re-render keeps the filter applied');
  await type('.ms-dock input', '');
  eq(await rowState(), [1, 1, 1], 'Clearing the search restores every note');
  ok(await js("!document.querySelector('.ms-dock-note')"), 'No stale note after clearing');
  await js("document.querySelector('.ms-dock button').click()");
  ok(await js("document.activeElement === document.querySelector('.view-constrained .form-grid input')"), 'Notes + focuses the new note field');

  for (const [tab, q] of [['tasks', 'Write'], ['cookbook', 'local'], ['email', 'Project']]) {
    await navigate(tab);
    await waitFor("document.querySelectorAll('.ms-dock').length === 1 && document.querySelectorAll('[data-mobile-row]').length > 0");
    const total = (await rowState()).length;
    await type('.ms-dock input', q);
    ok(await shown() >= 1, `${tab} search "${q}" keeps a matching row`);
    await type('.ms-dock input', 'qqqq-none');
    eq(await shown(), 0, tab + ' search with no match hides rows');
    ok(await js("!!document.querySelector('.ms-dock-note')"), tab + ' shows the no-match note');
    await type('.ms-dock input', '');
    eq(await shown(), total, tab + ' clearing restores rows');
  }
  await navigate('tasks'); await waitFor("document.querySelectorAll('.ms-dock').length === 1");
  await js("document.querySelector('.ms-dock button').click()");
  ok(await js("!!document.activeElement.closest('details')?.open"), 'Tasks + opens the schedule form and focuses a field');
  await navigate('email'); await waitFor("document.querySelectorAll('.ms-dock').length === 1");
  await js("document.querySelector('.ms-dock button').click()");
  ok(await js("!!document.activeElement.closest('details')?.open"), 'Email + opens Connect an account and focuses a field');
  await navigate('cookbook'); await waitFor("document.querySelectorAll('.ms-dock').length === 1 && !!document.querySelector('[data-mobile-catalog]')");
  const downloads = writes.length;
  await js("document.querySelector('.ms-dock button').click()");
  ok(await js("!!document.activeElement.closest('[data-mobile-catalog]')"), 'Cookbook + reveals the catalog and focuses a control');
  eq(writes.slice(downloads).filter(w => /pull|download/.test(w.path)).length, 0, 'Cookbook + never starts a download');

  // ---- C. Calendar: Today / Month-Week / "+", and the event sheet -------------------------
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const press = async name => {
    const code = { Escape: 27, Tab: 9, Enter: 13, ArrowLeft: 37, ArrowRight: 39, End: 35, Home: 36 }[name];
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await delay(120);
  };
  const pressShiftTab = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await delay(120);
  };
  const drag = async (from, to) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6, button: 'left', buttons: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    await delay(300);
  };
  const dockButton = label => js(`(() => { const b = [...document.querySelectorAll('.ms-dock button')].find(n => n.getAttribute('aria-label') === ${JSON.stringify(label)} || n.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('no dock button ' + ${JSON.stringify(label)}); b.focus(); b.click(); })()`);
  const pressed = () => js("Object.fromEntries([...document.querySelectorAll('.ms-dock button')].map(b => [b.textContent.trim(), b.getAttribute('aria-pressed')]))");
  const monthLabel = () => js("document.querySelector('.cal-month-label').textContent");
  const inDock = () => js("!!document.activeElement.closest('.ms-dock')");

  await navigate('calendar');
  await waitFor("document.querySelectorAll('.ms-dock').length === 1 && !!document.querySelector('.cal-month-label').textContent");
  eq((await dockInfo()).buttons.map(b => b.text), ['+', 'Today', 'Month', 'Week'], 'Calendar dock offers + Today Month Week');
  eq(await pressed(), { '+': null, Today: null, Month: 'true', Week: 'false' }, 'Calendar dock shows Month selected');
  ok(await js("[...document.querySelectorAll('.cal-nav button')].filter(b => b.getClientRects().length).every(b => !['Today', 'Month', 'Week'].includes(b.textContent.trim()))"), 'The page does not repeat what the dock offers');
  eq(await small('.cal-nav button'), [], 'Calendar page controls stay 44px');
  const monthNow = await monthLabel();
  await js("[...document.querySelectorAll('.cal-nav button')].find(b => b.textContent.includes('Next')).click()");
  await delay(250);
  ok((await monthLabel()) !== monthNow, 'Next moves the month');
  await dockButton('Today');
  await delay(300);
  eq(await monthLabel(), monthNow, 'Dock Today returns to the current month');
  ok(await js("!!document.querySelector('.cal-day-panel') && document.querySelector('.cal-day-panel').textContent.length > 0"), 'Dock Today selects the day and shows its panel');
  await dockButton('Week');
  await waitFor("document.querySelector('.cal-view-switch button:nth-child(2)').getAttribute('aria-pressed') === 'true'");
  eq((await pressed()).Week, 'true', 'Dock Week follows the original control');
  eq((await pressed()).Month, 'false', 'Dock Month clears');
  eq(await docks(), 1, 'Switching to Week keeps one dock');
  await shot('calendar-week');
  await dockButton('Month');
  await waitFor("document.querySelector('.cal-view-switch button:first-child').getAttribute('aria-pressed') === 'true'");
  eq((await pressed()).Month, 'true', 'Dock Month returns');
  // The event sheet and its four ways out.
  const sheetUp = "!!document.querySelector('.cal-event-dialog.ms-sheet-surface')";
  const eventDismiss = async how => {
    await dockButton('New event');
    await waitFor(sheetUp);
    await delay(260);
    const panel = await rect('.cal-event-dialog'), grab = await rect('.ms-sheet-grabber');
    ok(panel.l === 0 && panel.w === 390 && panel.b <= 844 + 1, 'Event sheet fills the phone width: ' + JSON.stringify(panel));
    ok(grab && grab.h >= 43.5 && grab.w >= 43.5, 'Event sheet has a 44px grabber');
    ok(await js("document.querySelector('.cal-event-dialog').contains(document.activeElement)"), 'Focus moves into the sheet');
    ok(await js("getComputedStyle(document.querySelector('.cal-event-dialog')).borderTopLeftRadius !== '0px'"), 'The sheet is rounded');
    if (how === 'escape') await press('Escape');
    else if (how === 'cancel') await js("[...document.querySelectorAll('.cal-event-dialog button')].find(b => b.textContent.trim() === 'Cancel').click()");
    else if (how === 'grabber click') await js("document.querySelector('.ms-sheet-grabber').click()");
    else if (how === 'swipe down') await drag({ x: grab.l + grab.w / 2, y: grab.t + grab.h / 2 }, { x: grab.l + grab.w / 2, y: grab.t + grab.h / 2 + 140 });
    await waitFor("!document.querySelector('.cal-event-dialog')");
    ok(await inDock(), `Focus returns to the dock after ${how}`);
    ok(await js("!document.documentElement.classList.contains('panel-dialog-open')"), `Scrolling unlocks after ${how}`);
  };
  for (const how of ['escape', 'cancel', 'grabber click', 'swipe down']) await eventDismiss(how);
  await dockButton('New event'); await waitFor(sheetUp); await delay(260);
  await shot('calendar-event-sheet');
  eq(await small('.cal-event-dialog button, .cal-event-dialog input, .cal-event-dialog select'), [], 'Event sheet controls are 44px');
  const reach = await js(`(() => { const form = document.querySelector('.cal-event-dialog'); const scroller = [form, ...form.querySelectorAll('*')].find(n => n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) || form; scroller.scrollTop = 1e6; const b = [...form.querySelectorAll('button')].find(n => /^Create event$/.test(n.textContent.trim())).getBoundingClientRect(); return { b: b.bottom, h: b.height, vh: innerHeight }; })()`);
  ok(reach.b <= reach.vh - 8 && reach.h >= 43.5, 'The sheet scrolls so its last action clears the screen edge: ' + JSON.stringify(reach));
  // Create a real event through the sheet; the write goes to the existing route.
  const eventWrites = writes.length;
  await js("(() => { const i = document.querySelector('.cal-event-dialog input'); i.focus(); i.value = 'Dock event'; i.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('.cal-event-dialog button')].find(b => /^Create event$/.test(b.textContent.trim())).click(); })()");
  await waitFor("!document.querySelector('.cal-event-dialog')");
  ok(writes.slice(eventWrites).some(w => w.method === 'POST' && /\/api\/(google\/)?calendar\//.test(w.path) && String(w.body).includes('Dock event')), 'The sheet creates the event through the existing route');

  // ---- D. Library: documents, vault, drive, editor -----------------------------------------
  const libTab = text => js(`[...document.querySelectorAll('.segmented-tab')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  await navigate('library');
  await waitFor("document.querySelectorAll('.ms-dock').length === 1 && document.querySelectorAll('.library-document-card').length === 3");
  const docSearch = await js("document.querySelector('.ms-dock input').placeholder");
  ok(/Search documents/.test(docSearch), 'Library Documents dock holds the page search');
  await type('.ms-dock input', 'Design');
  await waitFor("document.querySelectorAll('.library-document-card').length === 1");
  ok(await js("document.querySelector('.library-document-card').textContent.includes('Design principles')"), 'Dock search filters documents after the existing debounce');
  await type('.ms-dock input', '');
  await waitFor("document.querySelectorAll('.library-document-card').length === 3");
  const viewWritesBefore = writes.length;
  await dockButton('New document');
  await waitFor("!!document.querySelector('.library-editor textarea')");
  await delay(250);
  eq(await docks(), 0, 'The dock leaves while the editor is open');
  await barShown(); eq(await barCurrent(), 'more', 'The editor keeps the tab bar');
  ok(await js("[...document.querySelectorAll('.library-editor button')].some(b => b.textContent.includes('Back to Library') && b.getClientRects().length)"), 'The editor keeps Back to Library');
  ok(writes.slice(viewWritesBefore).some(w => w.method === 'POST' && w.path === '/api/documents'), 'Dock + creates through the existing route');
  eq(await small('.library-editor button, .library-editor input'), [], 'Editor controls are 44px');
  await shot('library-editor');
  await js("document.querySelector('.library-editor textarea').focus(); document.querySelector('.library-editor textarea').value = 'changed'; document.querySelector('.library-editor textarea').dispatchEvent(new Event('input', { bubbles: true }))");
  await js("document.querySelector('.ms-tabbar [data-tabbar=home]').click()");
  await waitFor("!!document.querySelector('.confirm-panel')");
  ok(await js("document.querySelector('.confirm-panel').textContent.includes('Discard unsaved changes?')"), 'Tab navigation asks before discarding document edits');
  await js("[...document.querySelectorAll('.confirm-panel .btn')].find(b => b.textContent.trim() === 'Cancel').click()");
  await waitFor("!document.querySelector('.confirm-panel')");
  eq(await js("document.querySelector('.library-editor textarea').value"), 'changed', 'Cancel preserves the document edit');
  eq(await js("document.documentElement.dataset.view"), 'library', 'Cancel keeps the document editor in Library');
  await js("[...document.querySelectorAll('.library-editor button')].find(b => b.textContent.includes('Back to Library')).click()");
  await waitFor("!!document.querySelector('.confirm-panel, .panel-dialog')");
  await press('Escape');
  await waitFor("!document.querySelector('.confirm-panel, .panel-dialog')");
  ok(await js("!!document.querySelector('.library-editor textarea')"), 'Cancelling the dirty guard stays in the editor');
  await js("[...document.querySelectorAll('.library-editor button')].find(b => b.textContent.includes('Back to Library')).click()");
  await waitFor("!!document.querySelector('.confirm-panel .btn, .panel-dialog .btn')");
  await js("[...document.querySelectorAll('.confirm-panel .btn, .panel-dialog .btn')].find(b => /Discard/.test(b.textContent)).click()");
  await waitFor("document.querySelectorAll('.ms-dock').length === 1 && document.querySelectorAll('.library-document-card').length >= 3");
  eq(await docks(), 1, 'The dock returns once after Back');
  await barShown(); eq(await barCurrent(), 'more', 'The tab bar slides back after the editor');
  await libTab('Vault');
  await waitFor("!!document.querySelector('.library-vault-browser') && document.querySelectorAll('.ms-dock').length === 1 && !!document.querySelector('.ms-dock input')");
  await waitFor("document.querySelectorAll('.library-vault-tree button, .library-vault-tree summary').length > 0");
  await delay(400);
  // Library Vault Polish (2026-10-22): the dock's "+" is Today's note, the only create.
  eq((await dockInfo()).buttons.map(b => b.label), ["Today's note"], "Vault dock offers Today's note and nothing else");
  eq(await js("document.querySelector('.ms-dock input').placeholder"), 'Search vault', 'Vault Browse search lives in the dock');
  await type('.ms-dock input', 'Daily');
  await delay(300);
  ok(await js("[...document.querySelectorAll('.vault-group-names .library-vault-note')].length > 0 && [...document.querySelectorAll('.vault-group-names .library-vault-note')].every(b => /daily/i.test(b.textContent))"), 'Vault dock search narrows the list to matching names');
  await shot('library-vault');
  await type('.ms-dock input', '');
  await js("[...document.querySelectorAll('.vault-mode-pill')].find(b => b.textContent.trim() === 'Map')?.click()");
  await delay(600);
  ok(await docks() <= 1, 'Vault Map keeps one dock at most');
  await libTab('Google Drive');
  await waitFor("document.querySelectorAll('.ms-dock').length === 1 && /Search in Drive/.test(document.querySelector('.ms-dock input')?.placeholder || '')");
  ok((await dockInfo()).buttons.some(b => b.label === 'New' || b.text === '+'), 'Drive dock has a "+" for the New menu');
  await js("document.querySelector('.ms-dock button').click()");
  ok(await js("!!document.querySelector('details[open] > summary[data-mobile-dock=create], details.drive-new[open]') || [...document.querySelectorAll('details')].some(d => d.open && /New/.test(d.querySelector('summary')?.textContent || ''))"), 'Drive + opens the New menu');
  await shot('library-drive');
  for (const name of ['Documents & files', 'Vault', 'Google Drive', 'Documents & files', 'Vault']) {
    await libTab(name); await delay(500);
    ok(await docks() <= 1 && (await js("document.querySelectorAll('.ms-dock input').length")) <= 1, 'No duplicate dock or search after switching to ' + name);
  }
  await navigate('notes');
  await waitFor("document.querySelectorAll('.ms-dock').length === 1");
  ok(await js("document.querySelector('.ms-dock input').placeholder === 'Search notes' && !document.querySelector('.library-view')"), 'Leaving Library leaves no Library search behind');

  // ---- E. Tool Store keeps its own header search, "+" menu and sheet ------------------------
  await navigate('tool-store');
  await waitFor("document.querySelectorAll('.tool-store-card').length > 0");
  eq(await docks(), 0, 'Tool Store mounts no dock');
  eq(await js("document.querySelectorAll('.tool-store-search').length"), 1, 'Tool Store has one search');
  ok(await js("getComputedStyle(document.querySelector('.tool-store-search')).display !== 'none'"), 'Its header search is visible');
  eq(await js("[...document.querySelectorAll('button')].filter(b => b.getClientRects().length && /Add or manage|Manage skills/.test(b.getAttribute('aria-label') || b.textContent)).length"), 1, 'One add/manage control, not a header plus a dock');
  eq(await small('.ts-plus, .tool-store-search, .ts-row-hit'), [], 'Tool Store phone controls are 44px');
  await js("document.querySelector('.ts-plus').click()");
  ok(await js("document.querySelector('.ts-plus').getAttribute('aria-expanded') === 'true'"), 'Tool Store + opens its menu');
  await press('Escape');
  await js("document.querySelector('.ts-row-hit').click()");
  await waitFor("!!document.querySelector('.ts-sheet')");
  ok(await js("document.querySelector('.ts-sheet').contains(document.activeElement)"), 'Tool Store row sheet takes focus');
  await shot('toolstore-sheet');
  await press('Escape');
  await waitFor("!document.querySelector('.ts-sheet')");
  eq(await docks(), 0, 'Still no dock after the sheet closes');

  // ---- F. Agents keep their messenger; no dock collides with it -----------------------------
  await navigate('agents', { agentId: 'a1' });
  await waitFor("!!document.querySelector('.side-chat-input')");
  eq(await docks(), 0, 'Agents mount no dock');
  const composer = await rect('.side-chat-input'), apill = await rect('.ms-activity-floating');
  ok(composer && composer.b <= 844 && composer.h >= 40, 'The messenger composer is on screen');
  ok(!apill || !hit(apill, composer), 'The activity pill does not cover the messenger composer');
  await js("document.querySelector('.agents-chats-open')?.click()");
  await delay(400);
  ok(await js("!!document.querySelector('.agents-chat-rail input[type=search], .agents-chat-rail input')"), 'The rail keeps its own search');
  eq(await docks(), 0, 'No dock over the rail');

  // ---- G. Forge project pager, pushed tools, Changes and commit sheet ---------------------
  const forgeResult = await require('./mobile-forge-checks.cjs')(ctx);
  assertions += forgeResult.assertions;

  // ---- G2. Workspace sheet: the Kairos / Forge mode switch ----------------------------------
  const modeState = () => js(`(() => { const g = document.querySelector('.ms-tab-sheet[open] .ms-mode-switch'); if (!g) return null; const radios = [...g.querySelectorAll('[role=radio]')];
    const caption = [...g.parentElement.querySelectorAll('.ms-mode-caption')].filter(n => n.getClientRects().length).map(n => n.textContent);
    const tile = document.querySelector('.ms-tab-sheet[open] .ms-tab-group')?.getBoundingClientRect();
    return { role: g.getAttribute('role'), label: g.getAttribute('aria-label'), names: radios.map(n => n.textContent.trim()), checked: radios.map(n => n.getAttribute('aria-checked')),
      tabs: radios.map(n => n.tabIndex), described: radios.map(n => document.getElementById(n.getAttribute('aria-describedby'))?.textContent || ''), caption,
      sizes: radios.map(n => { const r = n.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }), aboveTabs: !!tile && g.getBoundingClientRect().bottom <= tile.top,
      thumb: (() => { const t = g.querySelector('.ms-mode-thumb').getBoundingClientRect(), on = radios.find(n => n.getAttribute('aria-checked') === 'true').getBoundingClientRect(); return Math.abs(t.left - on.left) <= 6 && Math.abs(t.right - on.right) <= 6; })(),
      readout: !!document.querySelector('.ms-sheet-readout'), mode: document.documentElement.dataset.appMode }; })()`);
  const openSheet = async () => { await barShown(); await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-tab-sheet[open] .ms-mode-switch')"); await delay(350); };
  await navigate('home'); await delay(400); await openSheet();
  let modes = await modeState();
  eq([modes.role, modes.label, modes.names, modes.checked, modes.tabs], ['radiogroup', 'App mode', ['Kairos', 'Forge Preview'], ['true', 'false'], [0, -1]], 'Mode switch is a radio group with Kairos checked and a roving tab stop: ' + JSON.stringify(modes));
  ok(modes.described.every(text => text.length > 10) && modes.caption.length === 1 && modes.caption[0] === modes.described[0], 'Each mode has a one-line description; the checked one is shown: ' + JSON.stringify(modes));
  ok(modes.sizes.every(Boolean) && modes.aboveTabs && modes.thumb, 'Mode options are 44px, sit at the top of the sheet, and the thumb marks Kairos: ' + JSON.stringify(modes));
  ok(!modes.readout, 'The temporary Safari readout is gone from the sheet');
  eq(await small('.ms-tab-sheet[open] .ms-mode-switch button'), [], 'Mode switch has no control under 44px');
  ok(await js("![...document.querySelectorAll('.ms-tab-sheet[open] .ms-mode-row *')].some(n => n.childElementCount === 0 && n.textContent.includes(String.fromCharCode(8212)))"), 'Mode switch copy has no em dash');
  await shot('sheet-mode-kairos');
  // Arrow keys move focus only; nothing switches until Space or Enter.
  await js("document.querySelector('.ms-mode-switch [data-mode=kairos]').focus()");
  await press('ArrowRight');
  ok(await js("document.activeElement.dataset.mode === 'forge' && document.activeElement.tabIndex === 0 && document.querySelector('.ms-mode-switch [data-mode=kairos]').tabIndex === -1 && document.documentElement.dataset.appMode === 'kairos' && !!document.querySelector('.ms-tab-sheet[open]')"), 'ArrowRight moves focus to Forge without switching');
  await press('ArrowLeft');
  ok(await js("document.activeElement.dataset.mode === 'kairos'"), 'ArrowLeft returns focus to Kairos');
  await press('End');
  // Space activates the focused option (with its text, so the browser treats it as a real key press).
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await waitFor("document.documentElement.dataset.appMode === 'forge' && !document.querySelector('.ms-tab-sheet[open]') && !!document.querySelector('.mf-dashboard')");
  ok(await js("document.getElementById('view-content').dataset.view === 'forgeHome' && !document.querySelector('.mf-project')"), 'End then Space on Forge switches modes and lands on the Forge Home overview');
  await waitFor("document.querySelectorAll('.mf-dashboard .forge-widget-grid > section').length === 5");
  await openSheet();
  modes = await modeState();
  eq([modes.checked, modes.tabs, modes.mode], [['false', 'true'], [-1, 0], 'forge'], 'In Forge mode the switch marks Forge Preview: ' + JSON.stringify(modes));
  ok(modes.caption.length === 1 && modes.caption[0] === modes.described[1] && modes.thumb && modes.sizes.every(Boolean), 'Forge description shows and the thumb sits on Forge: ' + JSON.stringify(modes));
  await shot('sheet-mode-forge');
  await js("document.querySelector('.ms-mode-switch [data-mode=kairos]').click()");
  ok(await js("document.querySelector('.ms-mode-switch[data-active=kairos] [data-mode=kairos][aria-checked=true]') !== null"), 'Tapping Kairos moves the thumb before the switch');
  await waitFor("document.documentElement.dataset.appMode === 'kairos' && !document.querySelector('.ms-tab-sheet[open]') && document.getElementById('view-content').dataset.view === 'home'");
  await waitFor("!!document.querySelector('.dashboard-content')");
  ok(true, 'Tapping Kairos switches back and lands on the dashboard');
  // Reduced motion: the thumb does not slide and the switch happens at once.
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await openSheet();
  ok(await js("/^0s(, 0s)*$/.test(getComputedStyle(document.querySelector('.ms-mode-thumb')).transitionDuration) && /^0s(, 0s)*$/.test(getComputedStyle(document.querySelector('.ms-mode-option')).transitionDuration)"), 'Reduced motion removes the mode thumb slide');
  ok(await js("new Promise(r => { document.querySelector('.ms-mode-switch [data-mode=forge]').click(); setTimeout(() => r(!document.querySelector('.ms-tab-sheet[open]')), 60); })"), 'Reduced motion switches without waiting for the slide');
  await waitFor("document.documentElement.dataset.appMode === 'forge' && !!document.querySelector('.mf-dashboard')");
  await openSheet(); await js("document.querySelector('.ms-mode-switch [data-mode=kairos]').click()");
  await waitFor("document.documentElement.dataset.appMode === 'kairos' && document.getElementById('view-content').dataset.view === 'home'");
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // ---- H. Keyboard lift, safe areas, reduced motion, resize cycles -------------------------
  await navigate('notes'); await waitFor("document.querySelectorAll('.ms-dock').length === 1"); await delay(600);
  // A 300px keyboard (visualViewport shortened): the tab bar steps aside and the dock lands on the keyboard.
  await js("(() => { window.__realVV = window.visualViewport; Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => ({ height: innerHeight - 300, offsetTop: 0, width: innerWidth, addEventListener() {}, removeEventListener() {} }) }); dispatchEvent(new Event('resize')); })()");
  await barGone();
  const lifted = await rect('.ms-dock');
  ok(Math.abs(lifted.b - (844 - 300 - 12)) <= 1 && !(await js("document.documentElement.classList.contains('ms-tabbar-up')")), 'With the keyboard up the tab bar steps aside and the dock rides the keyboard: ' + JSON.stringify(lifted));
  await js("(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.__realVV }); dispatchEvent(new Event('resize')); })()");
  await barShown();
  ok(Math.abs((await rect('.ms-dock')).b - ((await rect('.ms-tabbar')).t - 10)) <= 1, 'Keyboard down: the bar slides back and the dock returns above it');
  await js("document.documentElement.style.setProperty('--native-safe-bottom', '34px')");
  const safe = await rect('.ms-dock'), safeBar = await rect('.ms-tabbar');
  ok(Math.abs(safeBar.b - (844 - 34)) <= 1 && Math.abs(safe.b - (safeBar.t - 10)) <= 1, 'The tab bar clears a 34px bottom safe area and the dock sits above it: ' + JSON.stringify([safe, safeBar]));
  await js("document.documentElement.style.setProperty('--native-safe-bottom', '0px')");
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await delay(150);
  ok(await js("[document.querySelector('.ms-dock'), document.querySelector('.ms-dock button')].every(n => getComputedStyle(n).animationName === 'none' && /^0s(, 0s)*$/.test(getComputedStyle(n).transitionDuration))"), 'Reduced motion removes dock motion');
  await navigate('calendar'); await waitFor("document.querySelectorAll('.ms-dock').length === 1");
  await js("document.querySelector('.ms-dock button').focus(); document.querySelector('.ms-dock button').click()");
  await waitFor("!!document.querySelector('.cal-event-dialog.ms-sheet-surface')");
  ok(await js("getComputedStyle(document.querySelector('.cal-event-dialog')).animationName === 'none'"), 'Reduced motion removes the sheet rise');
  await press('Escape'); await waitFor("!document.querySelector('.cal-event-dialog')");
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // Resize cycle: the live search node moves to the dock and back, never cloned, never duplicated.
  await navigate('library'); await libTab('Documents & files');
  await waitFor("document.querySelectorAll('.ms-dock').length === 1 && !!document.querySelector('.library-view .card-row input')");
  await js("window.__search = document.querySelector('.ms-dock input'); window.__search.value = 'keep me'");
  for (let i = 0; i < 3; i++) {
    await resize(1440, 900);
    ok(await js("document.querySelectorAll('.ms-dock').length === 0 && document.querySelector('.library-view .card-row').contains(window.__search)"), 'Desktop puts the search back in its toolbar (cycle ' + i + ')');
    await resize(390, 844);
    ok(await js("document.querySelectorAll('.ms-dock').length === 1 && document.querySelector('.ms-dock').contains(window.__search) && window.__search.value === 'keep me'"), 'Phone moves the same search node into the dock with its text (cycle ' + i + ')');
  }
  await navigate('notes'); await waitFor("document.querySelectorAll('.ms-dock').length === 1");
  await type('.ms-dock input', 'workspa');
  await resize(1440, 900);
  ok(await js("document.querySelectorAll('.ms-dock, .ms-dock-note').length === 0 && document.querySelectorAll('.ms-filtered-out').length === 0"), 'Desktop shows every note again and leaves no dock behind');
  await resize(390, 844);

  // ---- I. Dark base and small phones ------------------------------------------------------
  const contrast = () => js(`(() => {
    const parse = text => { let m = text.match(/rgba?\\(([^)]+)\\)/); if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
      m = text.match(/color\\(srgb ([^)]+)\\)/); if (m) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 }; } return null; };
    const over = (top, base) => ({ r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const dock = document.querySelector('.ms-dock'); const page = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    const surface = over(parse(getComputedStyle(dock).backgroundColor), over(parse(getComputedStyle(document.body).backgroundColor) || page, { r: 128, g: 128, b: 128, a: 1 }));
    const input = dock.querySelector('input'); const out = {};
    out.typed = ratio(parse(getComputedStyle(input).color), surface);
    out.placeholder = ratio(over(parse(getComputedStyle(input, '::placeholder').color), surface), surface);
    out.plus = ratio(parse(getComputedStyle(dock.querySelector('button')).color), surface);
    return out; })()`);
  for (const [name, color] of [['parchment', PARCHMENT], ['forest', FOREST]]) {
    await setTheme(color);
    await navigate('notes'); await waitFor("document.querySelectorAll('.ms-dock').length === 1");
    await delay(300);
    const c = await contrast();
    ok(c.typed >= 4.5 && c.plus >= 4.5, `${name}: dock text and + are AA readable ` + JSON.stringify(c));
    ok(c.placeholder >= 3, `${name}: dock placeholder is readable ` + JSON.stringify(c));
    await shot('dock-notes-' + name);
    await navigate('calendar'); await waitFor("document.querySelectorAll('.ms-dock').length === 1");
    await shot('dock-calendar-' + name);
  }
  await setTheme(PARCHMENT);
  for (const [w, h, name] of [[320, 640, 'small'], [430, 932, 'large'], [667, 375, 'landscape']]) {
    await resize(w, h);
    for (const [tab] of TABS) {
      await navigate(tab); await waitFor("document.querySelectorAll('.ms-dock').length === 1");
      await delay(500);
      const r = await rect('.ms-dock');
      ok(r.l >= 0 && r.r <= w && r.b <= h && r.h >= 50 && (name !== 'landscape' || r.h <= 60), `${tab} dock fits at ${name}: ` + JSON.stringify(r));
      ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), `${tab} does not scroll sideways at ${name}`);
      eq(await small('.ms-dock button, .ms-dock input'), [], `${tab} dock controls are 44px at ${name}`);
      const reach = await js(`(() => { const v = document.querySelector('${view}'); v.scrollTo(0, 1e6); const d = document.querySelector('.ms-dock').getBoundingClientRect(); const items = [...v.querySelectorAll('.view-constrained > *')].filter(n => n.getClientRects().length); return { last: Math.max(...items.map(n => n.getBoundingClientRect().bottom)), top: d.top, kb: getComputedStyle(document.querySelector('.ms-dock')).getPropertyValue('--ms-keyboard'), vv: [visualViewport.height, innerHeight], scroll: v.scrollTop, sh: v.scrollHeight, ch: v.clientHeight }; })()`);
      ok(reach.last <= reach.top + 1, `${tab} last content clears the dock at ${name}: ` + JSON.stringify(reach));
    }
    await shot('dock-library-' + name);
  }
  await resize(390, 844);

  // ---- K. Settings on a phone: inset-grouped list, push and back, search ---------------------
  const openSettings = async from => {
    await navigate(from); await delay(300);
    await js("document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings' } }))");
    await waitFor("document.querySelector('.settings-mobile-page')?.dataset.mobileView === 'list' && document.querySelectorAll('.settings-nav-item').length > 3");
    await delay(300);
  };
  const mview = () => js("document.querySelector('.settings-mobile-page').dataset.mobileView");
  const sectionIds = () => js("[...document.querySelectorAll('.settings-nav-item')].map(n => n.dataset.section)");
  const backBtn = () => js("document.querySelector('.settings-mobile-back').click()");
  const visibleItems = () => js("[...document.querySelectorAll('.settings-nav-item')].filter(n => n.getClientRects().length).map(n => n.dataset.section)");
  await openSettings('notes');
  await checkChrome('settings', 'more');
  eq(await mview(), 'list', 'Settings opens on its list');
  const nav = await rect('#settings-nav');
  ok(nav && nav.t < 130 && nav.h >= 844 - 130, 'The section list fills the screen instead of taking half: ' + JSON.stringify(nav));
  eq(await js("document.getElementById('settings-content').getClientRects().length === 0 || document.getElementById('settings-content').getBoundingClientRect().height === 0"), true, 'No page content shares the screen with the list');
  const ids = await sectionIds();
  ok(ids.length >= 10, 'The list holds every section: ' + ids.length);
  eq(await js("[...document.querySelectorAll('.settings-nav-item')].filter(n => n.getClientRects().length && n.getBoundingClientRect().height < 51.5).length"), 0, 'Rows are at least 52px');
  eq(await js("[...new Set([...document.querySelectorAll('.settings-nav-block')].map(n => getComputedStyle(n).borderTopLeftRadius))]"), ['22px'], 'Groups are inset with a 22px radius');
  eq(await js("document.activeElement?.classList?.contains('settings-nav-item') || false"), false, 'A fresh list does not draw a focus ring on its first row');
  ok(await noSideways(), 'The list does not scroll sideways');
  await shot('settings-list');
  // Search: zero matches hides rows and headings; a match keeps only its row.
  await type('.settings-search', 'zzzzzz');
  eq(await visibleItems(), [], 'Search with no match hides every row');
  eq(await js("[...document.querySelectorAll('.settings-nav-group')].filter(n => n.getClientRects().length).length"), 0, 'Search leaves no stray group labels');
  await type('.settings-search', 'forge');
  ok((await visibleItems()).includes('forge') && (await visibleItems()).length < ids.length, 'Search narrows to Forge');
  await shot('settings-search');
  // Push a page, then back: the query, scroll and row focus come back.
  await type('.settings-search', '');
  await js("document.getElementById('settings-nav').scrollTop = 400");
  const scrollAt = await js("document.getElementById('settings-nav').scrollTop");
  await js("document.querySelector('.settings-nav-item[data-section=\"notifications\"]').click()");
  await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'");
  await delay(400);
  eq(await js("document.querySelector('.settings-mobile-title').textContent"), 'Notifications', 'The top bar names the page');
  ok(await js("getComputedStyle(document.getElementById('settings-nav')).display === 'none' && document.getElementById('settings-content').getBoundingClientRect().height > 600"), 'The page replaces the list');
  eq(await small('.settings-mobile-back'), [], 'The back button is 44px');
  ok(await js("document.activeElement === document.querySelector('.settings-mobile-back')"), 'Focus lands on Back when a page opens');
  await shot('settings-page');
  await backBtn();
  await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'list'");
  await delay(200);
  ok(Math.abs((await js("document.getElementById('settings-nav').scrollTop")) - scrollAt) <= 2, 'Back restores the list scroll');
  eq(await js("document.activeElement?.dataset?.section"), 'notifications', 'Back returns focus to the row that was opened');
  // A search query survives a push and back.
  await type('.settings-search', 'appear');
  await js("document.querySelector('.settings-nav-item[data-section=\"appearance\"]').click()");
  await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'");
  await backBtn(); await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'list'");
  eq(await js("document.querySelector('.settings-search').value"), 'appear', 'Back keeps the search query');
  eq(await visibleItems(), ['appearance'], 'Back keeps the filtered list');
  await type('.settings-search', '');
  // Every section opens, fits, and backs out, with 44px controls (switches extend theirs).
  const smallSettings = () => js(`[...document.querySelectorAll('#settings-content button, #settings-content a[href], #settings-content input:not([type=hidden]):not([type=checkbox]):not([type=radio]), #settings-content select, #settings-content textarea, #settings-content summary')].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').filter(n => { const r = n.getBoundingClientRect(); if (r.width >= 43.5 && r.height >= 43.5) return false; { const b = getComputedStyle(n, '::before'); if (b.position !== 'absolute' || b.content === 'none') return true; return !(r.height + Math.abs(parseFloat(b.top)) * 2 >= 43.5 && r.width + Math.abs(parseFloat(b.left)) * 2 >= 43.5); } }).map(n => (n.getAttribute('aria-label') || n.textContent || n.className).trim().slice(0, 26) + ' ' + Math.round(n.getBoundingClientRect().width) + 'x' + Math.round(n.getBoundingClientRect().height))`);
  for (const id of ids) {
    await js(`document.querySelector('.settings-nav-item[data-section="${id}"]').click()`);
    await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'");
    await delay(450);
    eq(await js("document.getElementById('settings-content').scrollWidth <= document.getElementById('settings-content').clientWidth + 2 && document.documentElement.scrollWidth <= innerWidth + 1"), true, `Settings ${id} does not overflow sideways`);
    ok(await js("document.getElementById('settings-content').textContent.trim().length > 20"), `Settings ${id} renders content`);
    eq(await smallSettings(), [], `Settings ${id} controls are 44px`);
    await backBtn();
    await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'list'");
  }
  // A page's own sub-page backs out one level at a time.
  await js("document.querySelector('.settings-nav-item[data-section=\"add-models\"]').click()");
  await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'");
  await delay(400);
  const sub = await js("(() => { const b = document.querySelector('.set-back'); return !!b; })()");
  if (sub) { await backBtn(); }
  // Back from the list returns to the tab Settings was opened over.
  await backBtn();
  await waitFor("document.querySelector('.settings-mobile-page')?.dataset.mobileView === 'list'");
  await backBtn();
  await waitFor("!document.querySelector('.settings-mobile-page') && document.documentElement.dataset.view === 'notes'");
  await waitFor("document.querySelectorAll('.ms-dock').length === 1");
  ok(await js("document.querySelector('.ms-dock input').placeholder === 'Search notes'"), 'Back from the list returns to the tab underneath, dock included');
  // Small phone and landscape: the list still scrolls and nothing spills.
  for (const [w, h, name] of [[320, 640, 'small'], [667, 375, 'landscape']]) {
    await resize(w, h);
    await openSettings('notes');
    ok(await noSideways(), `Settings list does not spill at ${name}`);
    ok(await js("(() => { const n = document.getElementById('settings-nav'); return n.scrollHeight > n.clientHeight ? getComputedStyle(n).overflowY !== 'hidden' : true; })()"), `Settings list scrolls at ${name}`);
    await js("document.querySelector('.settings-nav-item[data-section=\"remote\"]').click()");
    await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'");
    await delay(400);
    ok(await noSideways(), `A Settings page does not spill at ${name}`);
    await js("document.querySelector('.settings-mobile-back').click(); document.querySelector('.settings-mobile-back').click()");
    await waitFor("!document.querySelector('.settings-mobile-page')");
  }
  // Desktop keeps its floating Settings window.
  await resize(1440, 900);
  await js("document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings' } }))");
  await waitFor("!!document.querySelector('.settings-window') && !document.querySelector('.settings-mobile-page')");
  ok(await js("!!document.querySelector('.settings-window .settings-nav-item') && !document.querySelector('.settings-window').closest('.settings-mobile-page')"), 'Desktop still shows the Settings window');
  await js("document.querySelector('.settings-window .settings-titlebar-btn[title=Close]')?.click()");
  await resize(390, 844);

  // ---- T. The tab bar: every tab, selection, More, hiding, glass, badges, reduced motion -----
  // (scripts/mobile-tabbar-checks.cjs; its assertions count here through ok and eq.)
  await require('./mobile-tabbar-checks.cjs')({ ...ctx, ok, eq, rect, hit, small, noSideways, barState, barCurrent, barShown, barGone, noAvatar, MORE, shot, resize, cdp, press });

  // 2026-10-21 (David, iPhone home-screen app, 393x852): iOS gives a home-screen app a layout viewport
  // short by the status bar (100dvh = innerHeight = fixed inset:0 = 793) while 100lvh is the screen (852).
  // Electron cannot shorten its own viewport, so each case sets the window to the layout viewport and
  // --ms-page-height to what style.css computes there (max(100dvh, 100lvh)), plus the device's safe areas.
  // The page must fill the screen, bottom surfaces sit safe-bottom + gap above the true bottom, and the
  // status-bar frost stays inside the safe area.
  const devices = [
    // The last field is the iPhone nudge (style.css --ms-ios-nudge): 12px on an iPhone, 0 elsewhere.
    ['iPhone home-screen app, Dynamic Island', 393, 793, 852, 59, 34, 12],
    ['iPhone home-screen app, no notch', 375, 647, 667, 20, 0, 12],
    ['browser or Android (no fold)', 393, 852, 852, 47, 34, 0],
  ];
  // 2026-10-21 (David): popups sit cleanly above the page, titles sit on the top row on the right,
  // and no tab's first content starts above the bottom of that row.
  const popupClear = async (selector, label, top) => {
    const r = await js(`(() => {
      const pop = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.getClientRects().length); if (!pop) return { open: false };
      const pr = pop.getBoundingClientRect(), bad = [];
      for (const n of document.querySelectorAll('.ms-tabbar-item, .ms-chat-back, .chat-mobile-header button, .ms-header button, .mf-session-header button, #view-content .view-header h2, .ms-chat-heading')) {
        if (pop.contains(n) || !n.getClientRects().length || getComputedStyle(n).visibility === 'hidden') continue;
        const b = n.getBoundingClientRect(), x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
        if (x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) continue;
        if (!pop.contains(document.elementFromPoint(x, y))) bad.push(String(n.className || n.tagName));
      }
      const own = [...pop.querySelectorAll('button, input, h2, h3')].find(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
      const ob = own && own.getBoundingClientRect();
      return { open: true, bad, ownTop: ob && Math.round(ob.top), ownHit: !!own && pop.contains(document.elementFromPoint((ob.left + ob.right) / 2, (ob.top + ob.bottom) / 2)) };
    })()`);
    ok(r.open && !r.bad.length && r.ownHit && r.ownTop >= top, `${label}: sits above the page, its own header clear of the status bar and of the page header: ${JSON.stringify(r)}`);
  };
  // The top row: 44px tall, 6px under the status bar (plus the nudge). With the avatar gone it holds the title alone.
  const titleRow = async (label, rowTop) => {
    const r = await js(`(() => {
      const box = n => { const b = n.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const row = { l: 0, r: 16, t: ${rowTop}, b: ${rowTop} + 44 };
      const title = [...document.querySelectorAll('#view-content .view-header h2, #view-content .agents-workspace-bar > h2, .settings-mobile-page .settings-titlebar .title, .mf-dashboard-title')].find(n => n.getClientRects().length);
      const v = document.getElementById('view-content');
      const tops = [...v.querySelectorAll('*')].filter(n => n.getClientRects().length && !title?.contains(n) && !n.closest('.settings-titlebar, .ms-header, .ms-background') && !n.closest('.ms-dock') && getComputedStyle(n).position !== 'fixed' && getComputedStyle(n).visibility !== 'hidden' && n.getBoundingClientRect().height > 0 && (!n.children.length || n.matches('button, input, textarea, select, img, canvas, .tool-store-top, .dashboard-hero')))
        .map(n => ({ t: n.getBoundingClientRect().top, n: (n.className || n.tagName) + ' ' + n.textContent.trim().slice(0, 16) }));
      const first = tops.sort((a, b) => a.t - b.t)[0];
      return { row, title: title && box(title), text: title && title.textContent.trim(), first, width: innerWidth };
    })()`);
    if (r.title) {
      ok(Math.abs((r.title.t + r.title.b) / 2 - (r.row.t + r.row.b) / 2) <= 1 && Math.abs(r.title.r - (r.width - 16)) <= 1 && r.title.l >= r.row.r - 0.5,
        `${label}: the title sits on the top row, on the right: ${JSON.stringify(r)}`);
    }
    ok(!r.first || r.first.t >= r.row.b - 0.5, `${label}: the first content starts below the top row: ${JSON.stringify(r.first)} row ${JSON.stringify(r.row)}`);
  };
  for (const [name, w, layout, screen, top, bottom, nudge] of devices) {
    await resize(w, layout);
    await js(`(() => { const s = document.documentElement.style; s.setProperty('--ms-page-height', '${screen}px'); s.setProperty('--native-safe-top', '${top}px'); s.setProperty('--native-safe-bottom', '${bottom}px'); s.setProperty('--ms-ios-nudge', '${nudge}px'); })()`);
    const gap = Math.max(12, bottom);
    await navigate('chat'); await waitFor("!!document.querySelector('.ms-shell:not([hidden]) .ms-composer, .ms-shell:not([hidden]) .ms-launch-composer:not([hidden])')"); await delay(300);
    const page = await js(`['html', 'body', '#app', '#content', '#view-content', '.ms-shell', '.ms-background'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return s + ' ' + Math.round(r.top) + '-' + Math.round(r.bottom); })`);
    eq(page, ['html', 'body', '#app', '#content', '#view-content', '.ms-shell', '.ms-background'].map(s => `${s} 0-${screen}`), `${name}: the launch page fills the screen`);
    const switchTop = (await rect('.ms-shell .ms-header .ms-switch')).t;
    eq(Math.round(switchTop), top + nudge + 6, `${name}: the launch switch clears the status bar by 6px plus the ${nudge}px nudge`);
    ok(await noAvatar(), `${name}: no avatar on the launch page`);
    await barShown();
    const bar = await rect('.ms-tabbar');
    ok(Math.abs(bar.b - (screen - gap)) <= 1 && bar.h === 62 && Math.abs(bar.l - 16) <= 1 && Math.abs(bar.r - (w - 16)) <= 1, `${name}: the tab bar sits ${gap}px above the true screen bottom, 16px from each side: ${JSON.stringify(bar)}`);
    const composer = await rect('.ms-shell .ms-composer') || await rect('.ms-launch-composer');
    ok(composer && Math.abs(composer.b - (bar.t - 10)) <= 1, `${name}: launch composer sits 10px above the tab bar: ${JSON.stringify(composer)}`);
    const frost = await js("[...document.querySelectorAll('.ms-shell .ms-header .ms-blur-top i')].filter(n => n.getClientRects().length).map(n => n.getBoundingClientRect().bottom)");
    ok(frost.every(b => b <= top + 0.5), `${name}: launch frost stays within the ${top}px status bar: ${frost}`);
    await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'launch');
    // The More sheet reaches the true bottom.
    await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-tab-sheet[open]')"); await delay(350);
    eq(Math.round((await rect('.ms-tab-sheet')).b), screen, `${name}: the More sheet reaches the screen bottom`);
    await js("document.querySelector('.ms-tab-sheet').close()");
    // A conversation's composer.
    await navigate('chat', { mobileConversation: true }); await waitFor("!!document.querySelector('.ms-conversation .ms-composer')"); await delay(400);
    await barShown();
    const chatBar = await rect('.ms-tabbar');
    const chat = await rect('.ms-conversation .ms-composer');
    ok(Math.abs(chatBar.b - (screen - gap)) <= 1 && Math.abs(chat.b - (chatBar.t - 10)) <= 1, `${name}: the bar clears the screen bottom and the conversation composer sits 10px above it: ${JSON.stringify(chat)}`);
    ok(Math.round((await rect('#view-content')).b) === screen, `${name}: conversation fills the screen`);
    // A docked tab: the fixed dock and a bottom sheet.
    await navigate('notes'); await waitFor("document.querySelectorAll('.ms-dock').length === 1"); await delay(300);
    await barShown();
    const dock = await rect('.ms-dock'), dockBar = await rect('.ms-tabbar');
    ok(Math.abs(dockBar.b - (screen - gap)) <= 1 && Math.abs(dock.b - (dockBar.t - 10)) <= 1, `${name}: the fixed dock sits 10px above the tab bar, which sits ${gap}px above the screen bottom: ${JSON.stringify([dock, dockBar])}`);
    const globalFrost = await rect('.ms-global-frost');
    ok(!globalFrost || globalFrost.b <= top + 0.5, `${name}: page frost stays within the status bar`);
    await js("import('/static/js/mobileSheet.js').then(m => { const p = document.createElement('p'); p.textContent = 'Fold check'; window.__foldSheet = m.openMobileSheet({ title: 'Fold check', content: p, fullHeight: true }); })");
    await waitFor("!!document.querySelector('.ms-sheet[open]')"); await delay(350);
    const sheet = await rect('.ms-sheet[open]');
    ok(Math.round(sheet.b) === screen && Math.abs(sheet.t - top - nudge) <= 1, `${name}: a full bottom sheet spans from the status bar (plus the nudge) to the screen bottom: ${JSON.stringify(sheet)}`);
    await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'sheet');
    await js("document.querySelector('.ms-sheet[open] .ms-sheet-header button').click()"); await waitFor("!document.querySelector('.ms-sheet[open]')");
    // Forge: the project New page, a session's composer and the Changes dock follow the same system.
    await navigate('forgeHome', { mobilePage: 0 }); await waitFor("!!document.querySelector('.mf-project')"); await js("document.getElementById('mf-tab-0').click()"); await delay(500);
    eq(Math.round((await rect('.mf-project')).b), screen, `${name}: Forge project page fills the screen`);
    const forgeBottom = await js("(() => { const b = document.querySelector('.mf-project #mf-new .ms-launch-bottom'); const kids = [...b.children].filter(n => n.getClientRects().length && n.getBoundingClientRect().height); return { box: Math.round(b.getBoundingClientRect().bottom), last: Math.round(Math.max(...kids.map(n => n.getBoundingClientRect().bottom))), composer: Math.round(document.querySelector('.mf-project .forge-composer').getBoundingClientRect().bottom) }; })()");
    await barShown();
    const forgeBar = await rect('.ms-tabbar');
    ok(forgeBottom.box === screen && Math.abs(forgeBottom.last - (forgeBar.t - 10)) <= 1 && forgeBottom.composer <= forgeBar.t - 10, `${name}: Forge New composer sits above the tab bar: ${JSON.stringify([forgeBottom, forgeBar])}`);
    await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'forge-new');
    await js("document.getElementById('mf-tab-1').click()"); await waitFor("document.querySelectorAll('#mf-sessions .ms-history-main').length > 0"); await delay(400);
    await js("document.querySelector('#mf-sessions .ms-history-main').click()");
    await waitFor("!!document.querySelector('.mf-session .forge-transcript-composer')"); await delay(500);
    await barShown();
    const sessionBar = await rect('.ms-tabbar');
    const forgeChat = await rect('.mf-session .forge-transcript-composer');
    ok(forgeChat && Math.abs(sessionBar.b - (screen - gap)) <= 1 && Math.abs(forgeChat.b - (sessionBar.t - 10)) <= 1, `${name}: the bar clears the screen bottom and the Forge session composer sits 10px above it: ${JSON.stringify(forgeChat)}`);
    await js("document.querySelector('.mf-changes').click()"); await waitFor("!!document.querySelector('dialog.ms-sheet[open] .mf-git-dock')"); await delay(400);
    const changes = { sheet: await rect('dialog.ms-sheet[open]'), dock: await rect('.mf-git-dock'), actions: await js("document.querySelectorAll('.mf-git-dock button').length") }, dockGap = Math.max(8, bottom);
    ok(Math.round(changes.sheet.b) === screen, `${name}: Changes sheet reaches the screen bottom: ${JSON.stringify(changes)}`);
    // A dock with actions sits above the home indicator; with nothing to do there is no dock at all, never an empty pill.
    ok(changes.actions ? Math.abs(changes.dock.b - (screen - dockGap)) <= 1 : changes.dock === null, `${name}: Changes dock ${changes.actions ? 'sits ' + dockGap + 'px above the screen bottom' : 'is hidden with no actions'}: ${JSON.stringify(changes)}`);
    ok(await js("(() => { const b = document.querySelector('.ms-tabbar').getBoundingClientRect(); return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('dialog.ms-sheet[open]'); })()"), `${name}: the modal Changes sheet covers the bar`);
    await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'forge-changes');
    await js("document.querySelector('dialog.ms-sheet[open] .ms-sheet-header button').click()"); await waitFor("!document.querySelector('dialog.ms-sheet[open]')");
    if (!nudge) continue;
    // Titles and first content on every tab, Settings and one of its pages included.
    for (const tab of ['home', 'notes', 'library', 'calendar', 'email', 'tasks', 'cookbook', 'school', 'tool-store', 'agents', 'forgeHome']) {
      await navigate(tab); await delay(500); await titleRow(`${name}: ${tab}`, top + nudge + 6);
      ok(await noAvatar(), `${name}: ${tab} has no avatar`);
      if (tab === 'forgeHome') {
        ok(await js("!!document.querySelector('.mf-dashboard .forge-toolbar .mf-dashboard-new') && !document.querySelector('.mf-dashboard .ms-header .mf-dashboard-new')"), `${name}: Forge Home's New session sits on the toolbar beside Customize`);
        await shot(`fold-${w}x${screen}-${nudge ? 'iphone' : 'other'}-forge-home`);
      }
      if (tab === 'tool-store') await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'tool-store');
      if (tab === 'notes') await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'notes-title');
    }
    await openSettings('notes'); await titleRow(`${name}: Settings`, top + nudge + 6);
    await js("document.querySelector('.settings-nav-item[data-section=\"remote\"]').click()"); await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'"); await delay(400);
    await titleRow(`${name}: a Settings page`, top + nudge + 6);
    // A Settings sub-sheet: the model setup guide.
    await js("document.querySelector('.settings-mobile-back').click()"); await delay(300);
    await js("document.querySelector('.settings-nav-item[data-section=\"add-models\"]').click()"); await waitFor("document.querySelector('.settings-mobile-page').dataset.mobileView === 'page'"); await delay(400);
    await js("[...document.querySelectorAll('#settings-content button')].find(b => b.textContent.trim() === 'Help me set up a model').click()");
    await waitFor("!!document.querySelector('.modal-panel[role=dialog][aria-modal=true]')"); await delay(300);
    await popupClear('.modal-panel[role=dialog][aria-modal=true]', `${name}: Settings sub-sheet`, top);
    await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'settings-sheet');
    await js("document.querySelector('.modal-panel[role=dialog][aria-modal=true] button[aria-label=Close]')?.click()"); await waitFor("!document.querySelector('.modal-panel[role=dialog][aria-modal=true]')");
    await js("document.querySelector('.settings-mobile-back').click(); document.querySelector('.settings-mobile-back')?.click()"); await waitFor("!document.querySelector('.settings-mobile-page')");
    // Chat's documents, its files and the model sheet.
    for (const [item, selector] of [['Generated documents', '.artifact-panel'], ['Files in this chat', '.artifact-panel'], ['Model and reasoning', 'dialog.ms-sheet[open]']]) {
      await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('.chat-phone-tools > button')"); await delay(500);
      await js("document.querySelector('.chat-phone-tools > button').click()"); await delay(200);
      await js(`[...document.querySelectorAll('.chat-phone-tools .overflow-menu button')].find(b => b.textContent.trim() === ${JSON.stringify(item)}).click()`); await delay(700);
      await popupClear(selector, `${name}: ${item}`, top);
      await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + '' + item.split(' ')[0].toLowerCase());
      await js("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
    }
    await navigate('notes'); await delay(300);
    // The More sheet, Home's customize sheet, Tool Store details and Forge's Projects sheet.
    await barShown(); await js(MORE + ".click()"); await waitFor("!!document.querySelector('.ms-tab-sheet[open]')"); await delay(300);
    await popupClear('.ms-tab-sheet[open]', `${name}: More sheet`, top);
    await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'more-sheet'); await js("document.querySelector('.ms-tab-sheet').close()");
    await navigate('home'); await delay(500); await js("document.querySelector('.hm-customize').click()"); await waitFor("!!document.querySelector('.hm-sheet')"); await delay(300);
    await popupClear('.hm-sheet-root', `${name}: Home customize sheet`, top); await shot('fold-' + w + 'x' + screen + (nudge ? '-iphone-' : '-other-') + 'home-customize');
    await js("[...document.querySelectorAll('.hm-sheet button')].find(b => b.textContent.trim() === 'Done')?.click()"); await delay(300);
    await navigate('tool-store'); await delay(600); await js("document.querySelector('.ts-row-hit').click()"); await delay(500);
    await popupClear('.ts-sheet-backdrop', `${name}: Tool Store details`, top);
    await js("document.querySelector('.ts-sheet-close')?.click()"); await delay(300);
    await navigate('forgeHome', { mobilePage: 0 }); await waitFor("!!document.querySelector('.mf-project-trigger')"); await delay(400);
    await js("document.querySelector('.mf-project-trigger').click()"); await waitFor("!!document.querySelector('dialog.ms-sheet[open]')"); await delay(300);
    await popupClear('dialog.ms-sheet[open]', `${name}: Forge Projects sheet`, top);
    await js("document.querySelectorAll('dialog[open]').forEach(d => d.close())"); await delay(200);
  }
  // Outside an iOS home-screen app (navigator.standalone), theme-color still tints the browser and Android toolbars.
  eq(await js("document.querySelector('meta[name=theme-color]')?.content"), '#F3EADB', 'Browser keeps theme-color');
  await js("(() => { const s = document.documentElement.style; s.removeProperty('--ms-page-height'); s.removeProperty('--native-safe-top'); s.removeProperty('--ms-ios-nudge'); s.setProperty('--native-safe-bottom', '0px'); })()");

  await resize(390, 844);

  return { assertions };
}

module.exports = { run };

if (process.argv.slice(1).some(arg => path.resolve(arg) === __filename)) {
  const root = path.resolve(__dirname, '..');
  const lines = fs.readFileSync(path.join(__dirname, 'ui-smoke.cjs'), 'utf8').split('\n');
  const loadAt = lines.findIndex(line => line.includes('await win.loadURL(base);'));
  assert.ok(loadAt > 0, 'ui-smoke harness anchor found');
  let tryAt = loadAt; while (tryAt > 0 && lines[tryAt].trimEnd() !== '  try {') tryAt--;
  let catchAt = lines.length - 1; while (catchAt > 0 && lines[catchAt].trimEnd() !== '  } catch (error) {') catchAt--;
  assert.ok(tryAt > 0 && catchAt > loadAt, 'ui-smoke harness bounds found');
  let head = lines.slice(0, tryAt).join('\n');
  const swap = (a, b) => { assert.ok(head.includes(a), 'missing ' + a); head = head.replace(a, b); };
  swap('path.join(root, "data", "ui-review", "run-" + Date.now())', 'process.env.MT_OUT ? path.resolve(process.env.MT_OUT) : path.join(root, "data", "ui-review", "mobile-tabs-" + Date.now())');
  const body = `
  try {
    await win.loadURL(base);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await waitFor("(!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('.dashboard-content .skeleton'))");
    const result = await require('./mobile-tabs-checks.cjs').run({ js, win, waitFor, delay, navigate, capture, overflow, writes, reads, demoState, calendarFixtures, errors, openPopup, closePopup, liveChange, liveChunk, mutate, fixture });
    assert.deepEqual(errors, [], 'No renderer errors');
    console.log('PASS: phone tabs, dock, sheets and Settings navigation' + (result ? ' (' + result.assertions + ' assertions).' : '.'));
    console.log('Screenshots: ' + output);
`;
  const src = head + '\n' + body + lines.slice(catchAt).join('\n');
  const Module = require('node:module');
  const filename = path.join(__dirname, 'ui-smoke-harness.cjs');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname);
  mod._compile(src, filename);
}
