// The Design canvas in the app (vault: Design Canvas (Build Spec)): pan, zoom,
// fit, focus, live redraw on design_changed, select to edit, and the phone
// board list and pager at 390x844 and 430x932. Run from scripts/ui-smoke.cjs,
// whose synthetic server hands /api/designs* and /api/design-fonts/* to
// serve() below. Boards render with the real viewer script, read from
// core/design_render.py, behind the same hash-pinned policy as the backend.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
// Python reads its source with universal newlines, so the backend serves LF;
// a CRLF checkout (core.autocrlf) must hash the same text or the policy blocks it.
const source = fs.readFileSync(path.join(root, 'core', 'design_render.py'), 'utf8').replace(/\r\n/g, '\n');
const VIEWER = source.match(/VIEWER_SCRIPT = r"""([\s\S]*?)"""/)[1];
const HASH = 'sha256-' + crypto.createHash('sha256').update(VIEWER, 'utf8').digest('base64');
const ID = 'd5e5e5e5e5e5';
// A board's own palette lives inside its frame; these are the Kairos system's values.
const TOKENS = ':root{--ds-bg:#F3EADB;--ds-surface:#FBF6EE;--ds-text:#3A2A20;--ds-text-dim:#6B5646;--ds-accent:#B8893B;--ds-accent-text:#83601F;--ds-hairline:rgba(184,137,59,.55);--ds-font-sans:Jost,system-ui,sans-serif}';
const state = { version: 1, stamp: {}, comments: [] };
const boards = {
  welcome: { title: 'Welcome', x: 0, y: 0, w: 390, h: 844, frame: 'phone', order: 1 },
  'pick-a-habit': { title: 'Pick a habit', x: 510, y: 0, w: 390, h: 844, frame: 'phone', order: 2 },
  landing: { title: 'Landing', x: 1020, y: 0, w: 1440, h: 900, frame: 'browser', order: 3 },
};
const html = {
  welcome: '<main data-kd="main1" style="padding:48px 24px;min-height:844px;background:var(--ds-bg);color:var(--ds-text)"><h1 data-kd="h1">Build a habit</h1><p data-kd="p1">One small step a day.</p><button data-kd="btn1" data-kd-goto="pick-a-habit" style="width:60%;min-height:52px">Continue</button></main>',
  'pick-a-habit': '<main data-kd="main1" style="padding:48px 24px"><h1 data-kd="h1">Pick a habit</h1><button data-kd="btn1" style="min-height:52px">Continue</button></main>',
  landing: '<section data-kd="sec1" style="padding:64px"><h1 data-kd="h1">Habits, kept</h1><button data-kd="btn1" data-kd-toggle="p1">More</button><p data-kd="p1" hidden>Hidden detail</p></section>',
};
const design = () => ({ id: ID, title: 'Habit onboarding', owner: 'demo', boards, notes: [{ id: 'n1', text: 'Onboarding flow', x: 0, y: -260, kind: 'label' }],
  version: state.version, updated: Date.now() / 1000, created: Date.now() / 1000, chat_ids: ['s1'], chats: [{ id: 's1', title: 'Workspace planning' }],
  design_system: 'kairos', first_board: 'welcome', order: Object.keys(boards), token_overrides: {}, comments: state.comments, render_available: false,
  system: { id: 'kairos', name: 'Kairos', variables: { '--ds-bg': '#F3EADB', '--ds-text': '#3A2A20', '--ds-space-4': '16px' }, defaults: {} } });

function serve(url, req, res) {
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return true; };
  if (url.pathname.startsWith('/api/design-fonts/')) {
    const file = path.join(root, 'static', 'fonts', path.basename(url.pathname));
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'font/woff2');
    try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404); res.end(); }
    return true;
  }
  if (url.pathname === '/api/design-systems') return json([{ id: 'kairos', name: 'Kairos', builtin: true }]);
  if (!url.pathname.startsWith('/api/designs')) return false;
  if (url.pathname === '/api/designs' && req.method === 'GET') return json([{ ...design(), boards: 3, board_titles: ['Welcome', 'Pick a habit', 'Landing'], chat_title: 'Workspace planning' }]);
  if (url.pathname === '/api/designs/render-status') return json({ available: false, message: 'Needs the Kairos desktop app' });
  const render = url.pathname.match(/^\/api\/designs\/[a-f0-9]{12}\/boards\/([a-z0-9-]+)\/render$/);
  if (render) {
    const info = boards[render[1]];
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src http://${req.headers.host}/api/design-fonts/; script-src '${HASH}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`);
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:Jost;src:url("/api/design-fonts/kairos/Jost-Variable.woff2")}${TOKENS}*{box-sizing:border-box}html{width:${info.w}px;overflow-x:hidden}body{margin:0;min-height:${info.h}px;background:var(--ds-bg);color:var(--ds-text);font-family:var(--ds-font-sans)}[hidden]{display:none!important}[data-kd-mark~="picked"]{outline:2px solid var(--ds-accent)}</style><style id="kd-live-tokens"></style></head><body>${html[render[1]]}<script>${VIEWER}</script></body></html>`);
    return true;
  }
  if (url.pathname === `/api/designs/${ID}` && req.method === 'GET') return json(design());
  if (url.pathname === `/api/designs/${ID}/comments` && req.method === 'GET') return json(state.comments);
  if (url.pathname === `/api/designs/${ID}/versions`) return json([{ n: 1, at: Date.now() / 1000, by: 'Claude', tool: 'design_create', summary: 'Created with 3 boards', boards_changed: Object.keys(boards), changed_ids: {}, user_edit: false }]);
  if (url.pathname === `/api/designs/${ID}/board-action`) return json({ message: 'ok', design: design() });
  return false;
}

async function run({ js, waitFor, delay, navigate, win, capture, liveBroadcast, overflow }) {
  // The newest frame showing that board (Focus opens after the canvas's own).
  const frameJs = async (slug, code) => {
    const frames = win.webContents.mainFrame.framesInSubtree.filter(frame => frame !== win.webContents.mainFrame && frame.url.includes(`/boards/${slug}/render`));
    if (!frames.length) throw new Error('No live frame for ' + slug);
    return frames.at(-1).executeJavaScript(code);
  };
  win.setContentSize(1440, 900); await delay(200);
  // Toasts left by the step before (the Agents routines checks PATCH /api/tasks/g1,
  // a fixture that answers 404) are not the canvas's: clear them, then hold the
  // Design view to no error toast of its own.
  await js("document.querySelectorAll('#toast-host .toast').forEach(t => t.remove())");
  const noErrorToasts = async where => assert.deepEqual(await js("[...document.querySelectorAll('#toast-host .toast.error')].map(t => t.textContent)"), [], 'no error toast: ' + where);
  await navigate('design');
  await waitFor("document.querySelectorAll('.design-card').length === 1");
  assert.match(await js("document.querySelector('.design-card').textContent"), /Habit onboarding.*3 boards/);
  assert.equal(await js("document.querySelector('.nav-item[data-tab=\"design\"]')?.getAttribute('aria-current')"), 'page', 'Design is its own tab');
  await js("document.querySelector('.design-card').click()");
  await waitFor("document.querySelectorAll('.design-board').length === 3 && document.querySelectorAll('.design-board iframe').length === 3");
  await waitFor("location.hash === '#/design/" + ID + "'");
  const transform = () => js("document.querySelector('.design-world').style.transform");
  const zoom = () => js("document.querySelector('.design-zoom').textContent");
  // Fit all, then the keys: 0 is 100%, + zooms in, Shift+1 fits again.
  await waitFor("document.querySelector('.design-zoom').textContent !== '100%'");
  const fitted = await zoom();
  const key = (k, extra = {}) => js(`document.querySelector('.design-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(extra)} }))`);
  await key('0'); assert.equal(await zoom(), '100%');
  await key('+'); assert.equal(await zoom(), '125%');
  await key('!', { shiftKey: true }); await delay(300); assert.equal(await zoom(), fitted, 'Shift+1 fits all boards');
  // Pan with the wheel, zoom at the cursor with Ctrl+wheel.
  const before = await transform();
  await js("document.querySelector('.design-stage').dispatchEvent(new WheelEvent('wheel', { deltaX: 120, deltaY: 80, bubbles: true, cancelable: true }))");
  assert.notEqual(await transform(), before, 'the wheel pans');
  const zoomBefore = await zoom();
  await js("(() => { const r = document.querySelector('.design-stage').getBoundingClientRect(); document.querySelector('.design-stage').dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, clientX: r.left + 200, clientY: r.top + 200, bubbles: true, cancelable: true })); })()");
  assert.notEqual(await zoom(), zoomBefore, 'Ctrl+wheel zooms');
  // Drag the empty canvas to pan.
  const panned = await transform();
  await js("(() => { const s = document.querySelector('.design-stage'); const r = s.getBoundingClientRect(); const at = (t, x) => s.dispatchEvent(new PointerEvent(t, { clientX: r.left + x, clientY: r.bottom - 20, pointerId: 7, button: 0, bubbles: true })); at('pointerdown', 40); at('pointermove', 140); at('pointerup', 140); })()");
  assert.notEqual(await transform(), panned, 'dragging the canvas pans');
  await key('!', { shiftKey: true }); await delay(300);
  await noErrorToasts('design-canvas');
  await capture('design-canvas');
  // Focus: one board at real size; arrows move; Escape closes.
  await key('ArrowRight'); await delay(400);
  await key('Enter');
  await waitFor("!!document.querySelector('.design-focus iframe')");
  assert.match(await js("document.querySelector('.design-focus-bar strong').textContent"), /1 \/ 3 · Welcome/);
  await waitFor("document.querySelector('.design-focus iframe').contentWindow !== null");
  await delay(600);
  // A click-through in Focus opens the board it names.
  await frameJs('welcome', "document.querySelectorAll('[data-kd-goto]').forEach(n => n.closest('html').dataset.kdMode === 'browse' && n.click()); 1");
  await waitFor("/2 \\/ 3/.test(document.querySelector('.design-focus-bar strong').textContent)");
  await noErrorToasts('design-focus');
  await capture('design-focus');
  await key('Escape');
  await waitFor("!document.querySelector('.design-focus')");
  // Live redraw: a design_changed packet on the chat stream reloads only the changed board.
  const srcs = () => js("Object.fromEntries([...document.querySelectorAll('.design-board')].map(b => [b.dataset.slug, b.querySelector('iframe')?.src || '']))");
  const old = await srcs();
  state.version = 2;
  liveBroadcast({ type: 'design_changed', designId: ID, version: 2, boards: ['pick-a-habit'], changed: { 'pick-a-habit': ['btn1'] }, by: 'Claude', tool: 'design_edit', summary: 'Edited', sessionId: 's1', manifestChanged: false });
  await waitFor(`(() => { const b = document.querySelector('.design-board[data-slug="pick-a-habit"] iframe'); return b && b.src !== ${JSON.stringify(old['pick-a-habit'])}; })()`);
  const now = await srcs();
  assert.equal(now.welcome, old.welcome, 'an unchanged board is not reloaded');
  assert.equal(now.landing, old.landing);
  // Select to edit: an element picked on a board becomes a chip for the chat.
  await js("[...document.querySelectorAll('.design-mode')].find(b => b.textContent === 'Select').click()");
  await waitFor("document.querySelector('.design-canvas').dataset.mode === 'select'");
  await delay(300);
  await frameJs('landing', "document.querySelector('h1').click(); 1");
  await waitFor("document.querySelectorAll('.design-composer-chips .chat-reference-chip').length === 1");
  assert.match(await js("document.querySelector('.design-composer-chips').textContent"), /Landing · h1 "Habits, kept"/);
  assert.equal(await frameJs('landing', "document.querySelector('h1').getAttribute('data-kd-mark')"), 'picked');
  // The toggle click-through works on the canvas in Pan mode.
  await js("[...document.querySelectorAll('.design-mode')].find(b => b.textContent === 'Pan').click()");
  await noErrorToasts('design-select');
  await capture('design-select');
  // Phones: the board list and the one-board pager, no sideways scroll, 44px targets.
  for (const [width, height] of [[390, 844], [430, 932]]) {
    win.setContentSize(width, height); await delay(400);
    await navigate('design', { designId: ID });
    await waitFor("document.querySelector('.design-canvas')?.dataset.view === 'list' && document.querySelectorAll('.design-list-card').length === 3");
    assert.deepEqual(await js(`[...document.querySelectorAll('.design-page, .design-canvas, .design-list, .design-composer')].filter(e => e.scrollWidth > e.clientWidth + 2).map(e => e.className)`), [], `no sideways scroll at ${width}`);
    if (overflow) assert.deepEqual(await overflow(), [], `the page fits at ${width}`);
    const small = await js(`[...document.querySelectorAll('.design-toolbar .btn, .design-modes .btn, .design-composer .btn')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).map(b => b.textContent)`);
    assert.deepEqual(small, [], `44px targets at ${width}`);
    // The phone tab bar (mobileTabBar.js): the board list keeps it; the pager hides it.
    await waitFor("document.documentElement.classList.contains('ms-tabbar-up')");
    await noErrorToasts(`phone ${width}`);
    await capture(`design-phone-${width}`);
    await js("document.querySelectorAll('.design-list-card')[0].click()");
    await waitFor("!!document.querySelector('.design-focus iframe')");
    await waitFor("!document.documentElement.classList.contains('ms-tabbar-up')");
    await js("(() => { const s = document.querySelector('.design-focus-stage'); const r = s.getBoundingClientRect(); const at = (t, x) => s.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: r.top + 200, isPrimary: true, bubbles: true })); at('pointerdown', r.right - 30); at('pointerup', r.left + 30); })()");
    await waitFor("/2 \\/ 3/.test(document.querySelector('.design-focus-bar strong').textContent)");
    await capture(`design-phone-pager-${width}`);
    await js("document.querySelector('.design-focus-bar [aria-label=\"Close focus\"]').click()");
    await waitFor("document.documentElement.classList.contains('ms-tabbar-up')");
    // A draft keeps the composer 10px above the bar.
    await js("(() => { const i = document.querySelector('.design-composer-input'); i.value = 'warmer'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor("document.documentElement.classList.contains('ms-tabbar-up')");
    // The draft grows the composer (is-active); its geometry settles a frame or two later.
    await waitFor("Math.abs(document.querySelector('.design-composer').getBoundingClientRect().bottom - (document.querySelector('.ms-tabbar').getBoundingClientRect().top - 10)) <= 1 && document.querySelector('.ms-tabbar').getAnimations().length === 0");
    assert.ok(true, 'Draft composer clears the tab bar by 10px');
    await js("(() => { const i = document.querySelector('.design-composer-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor("document.documentElement.classList.contains('ms-tabbar-up')");
  }
  win.setContentSize(1440, 900); await delay(300);
}

module.exports = { serve, run };
