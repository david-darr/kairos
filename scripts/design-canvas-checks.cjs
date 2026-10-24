// The Design canvas in the app (vault: Design Canvas (Build Spec)): pan, zoom,
// fit, focus, live redraw on design_changed, select to edit, and the phone
// board list and pager at 390x844 and 430x932. Run from scripts/ui-smoke.cjs,
// whose synthetic server hands /api/designs* and /api/design-fonts/* to
// serve() below. Boards render with the real viewer script and the real board
// reset, both read from core/design_render.py, behind the same hash-pinned
// policy as the backend.
//
// Round 7 (David, 2026-10-22): designs live in Library (no Design tab); a
// chat's design pane opens as soon as the design exists, mid-turn; boards are
// made in named formats and sit in rows by format, so a drag or resize pushes
// the neighbours instead of overlapping them; Select, Comment and Text work on
// every frame type at any zoom; the design view has the chat's model picker.
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
const RESET = source.match(/\nRESET = """([\s\S]*?)"""/)[1];
const reset = (w, h, min) => RESET.replace(/%\((w|h|min)\)s/g, (_, k) => ({ w, h, min })[k]).replace(/%%/g, '%');
const ID = 'd5e5e5e5e5e5', MID = 'e6e6e6e6e6e6', PID = 'f7f7f7f7f7f7';
// A board's own palette lives inside its frame; these are the Kairos system's values.
const TOKENS = ':root{--ds-bg:#F3EADB;--ds-surface:#FBF6EE;--ds-text:#3A2A20;--ds-text-dim:#6B5646;--ds-accent:#B8893B;--ds-accent-text:#83601F;--ds-hairline:rgba(184,137,59,.55);--ds-hairline-soft:rgba(184,137,59,.25);--ds-success:#5E7A4A;--ds-font-sans:Jost,system-ui,sans-serif;--ds-font-serif:"Cormorant Garamond",Georgia,serif;--ds-size-1:12px;--ds-size-2:14px;--ds-size-3:16px;--ds-size-4:20px;--ds-size-5:28px;--ds-size-6:36px;--ds-size-7:56px;--ds-space-2:8px;--ds-space-3:12px;--ds-space-4:16px;--ds-space-5:24px;--ds-space-6:32px;--ds-space-7:48px;--ds-space-8:72px;--ds-radius-m:12px;--ds-radius-l:20px;--ds-radius-pill:999px}';

// core/design_formats.py, mirrored for the synthetic server.
const CHROME = { phone: [36, 12, 22], tablet: [22, 18, 22], browser: [40, 0, 0] };
const LABELS = { 'app:phone': 'App · Phone', 'app:tablet': 'App · Tablet', 'website:desktop': 'Website · Desktop', 'website:mobile': 'Website · Mobile', slides: 'Slides', poster: 'Poster', social: 'Social' };
function layout(boards) {
  const order = Object.keys(boards).sort((a, b) => boards[a].order - boards[b].order);
  const rows = new Map();
  for (const slug of order) { if (!rows.has(boards[slug].section)) rows.set(boards[slug].section, []); rows.get(boards[slug].section).push(slug); }
  let y = 0;
  for (const slugs of rows.values()) {
    y += Math.max(...slugs.map(s => (CHROME[boards[s].frame] || [0])[0])) + 34;
    let x = 0, bottom = 0;
    for (const slug of slugs) {
      const b = boards[slug], [, side, below] = CHROME[b.frame] || [0, 0, 0];
      x += side; b.x = x; b.y = y; x += b.w + side + 120; bottom = Math.max(bottom, b.h + below);
    }
    y += bottom + 320;
  }
  return order;
}
const board = (title, order, format, size, orientation, frame, w, h, more = {}) => {
  const grows = format === 'website';
  return { title, order, format, size, orientation, frame, w, h, x: 0, y: 0, grows, ratio: grows || !format ? null : w / h,
    min_h: grows ? Math.min(h, size === 'mobile' ? 844 : 900) : undefined, section: format === 'website' || format === 'app' ? `${format}:${size}` : format,
    format_label: more.label || LABELS[format === 'website' || format === 'app' ? `${format}:${size}` : format], ...more };
};
const page = (heading, body, extra = '') => `<main style="min-height:100%;padding:var(--ds-space-7);background:var(--ds-bg);color:var(--ds-text);font-family:var(--ds-font-sans)">${extra}<h1 style="margin:0 0 var(--ds-space-4);font-size:var(--ds-size-6);font-weight:500">${heading}</h1><p style="margin:0;color:var(--ds-text-dim);font-size:var(--ds-size-4)">${body}</p></main>`;
const SITE = (mobile) => `<header style="display:flex;justify-content:space-between;align-items:center;padding:var(--ds-space-5) var(--ds-space-${mobile ? 5 : 8});border-bottom:1px solid var(--ds-hairline-soft)"><strong style="font-size:var(--ds-size-4);letter-spacing:.2em">KAIROS</strong><span style="color:var(--ds-accent-text)">Download</span></header>
<section style="padding:var(--ds-space-8) var(--ds-space-${mobile ? 5 : 8});display:grid;gap:var(--ds-space-5)${mobile ? '' : ';grid-template-columns:1.2fr 1fr;align-items:center'}"><div><h1 style="margin:0 0 var(--ds-space-4);font-family:var(--ds-font-serif);font-style:italic;font-weight:400;font-size:${mobile ? 44 : 84}px;line-height:1">Not more time. The right time.</h1><p style="margin:0 0 var(--ds-space-6);color:var(--ds-text-dim);font-size:var(--ds-size-4)">Kairos is a calm assistant that works beside you, on your own computer.</p><button style="min-height:52px;padding:0 var(--ds-space-6);border:0;border-radius:var(--ds-radius-pill);background:var(--ds-text);color:var(--ds-bg);font-size:var(--ds-size-3)">Get Kairos</button></div><div style="aspect-ratio:4/3;border:1px solid var(--ds-hairline);border-radius:var(--ds-radius-l);background:var(--ds-surface)"></div></section>
<section style="padding:var(--ds-space-8) var(--ds-space-${mobile ? 5 : 8});display:grid;gap:var(--ds-space-5);grid-template-columns:${mobile ? '1fr' : 'repeat(3,1fr)'}">${['Chats', 'Agents', 'Design'].map(t => `<div style="padding:var(--ds-space-5);border:1px solid var(--ds-hairline-soft);border-radius:var(--ds-radius-m);background:var(--ds-surface)"><h3 style="margin:0 0 var(--ds-space-2);font-size:var(--ds-size-4);font-weight:500">${t}</h3><p style="margin:0;color:var(--ds-text-dim)">One place for the work that matters.</p></div>`).join('')}</section>
<footer style="padding:var(--ds-space-7) var(--ds-space-${mobile ? 5 : 8});color:var(--ds-text-dim);border-top:1px solid var(--ds-hairline-soft)">Made for focus.</footer>`;
const POSTER = (wide) => `<section style="display:flex;flex-direction:column;justify-content:space-between;height:100%;min-height:${wide ? 1200 : 1800}px;padding:var(--ds-space-8);background:var(--ds-text);color:var(--ds-bg)"><p style="margin:0;letter-spacing:.3em;font-size:var(--ds-size-4)">KAIROS · 2026</p><h1 style="margin:0;font-family:var(--ds-font-serif);font-style:italic;font-weight:400;font-size:${wide ? 150 : 170}px;line-height:.95">The right time.</h1><p style="margin:0;font-size:var(--ds-size-5);color:var(--ds-accent)">A calm assistant for focused work</p></section>`;
const SLIDE = (n, title) => `<section style="display:flex;flex-direction:column;justify-content:center;height:1080px;padding:0 160px;background:var(--ds-bg);color:var(--ds-text)"><p style="margin:0 0 var(--ds-space-4);color:var(--ds-accent-text);font-size:28px">${n} of 3</p><h1 style="margin:0;font-size:96px;font-weight:500;line-height:1.05">${title}</h1></section>`;

const designs = {
  [ID]: { title: 'Habit onboarding', chat: 'dz1', render: false, version: 1, comments: [], boards: {
    welcome: board('Welcome', 1, 'app', 'phone', 'portrait', 'phone', 390, 844),
    'pick-a-habit': board('Pick a habit', 2, 'app', 'phone', 'portrait', 'phone', 390, 844),
    landing: board('Landing', 3, 'website', 'desktop', null, 'browser', 1440, 900) },
  html: {
    welcome: '<main data-kd="main1" style="padding:48px 24px;min-height:844px;background:var(--ds-bg);color:var(--ds-text)"><h1 data-kd="h1">Build a habit</h1><p data-kd="p1">One small step a day.</p><button data-kd="btn1" data-kd-goto="pick-a-habit" style="width:60%;min-height:52px">Continue</button></main>',
    'pick-a-habit': '<main data-kd="main1" style="padding:48px 24px"><h1 data-kd="h1">Pick a habit</h1><button data-kd="btn1" style="min-height:52px">Continue</button></main>',
    landing: '<section data-kd="sec1" style="padding:64px"><h1 data-kd="h1">Habits, kept</h1><button data-kd="btn1" data-kd-toggle="p1">More</button><p data-kd="p1" hidden>Hidden detail</p></section>' } },
  // Every frame type, with a desktop render window (thumbnails below 35%), as David's app has.
  [MID]: { title: 'Frame matrix', chat: 'dz1', render: true, version: 1, comments: [], boards: {
    'm-desktop': board('Home', 1, 'website', 'desktop', null, 'browser', 1440, 2300),
    'm-mobile': board('Home (mobile)', 2, 'website', 'mobile', null, 'phone', 390, 3000),
    'm-phone': board('Phone 1', 3, 'app', 'phone', 'portrait', 'phone', 390, 844),
    'm-phone-2': board('Phone 2', 4, 'app', 'phone', 'portrait', 'phone', 390, 844),
    'm-phone-3': board('Phone 3', 5, 'app', 'phone', 'portrait', 'phone', 390, 844),
    'm-tablet': board('Tablet', 6, 'app', 'tablet', 'portrait', 'tablet', 820, 1180),
    'm-slide': board('Slide 1', 7, 'slides', '16:9', 'landscape', 'slide', 1920, 1080),
    'm-slide-2': board('Slide 2', 8, 'slides', '16:9', 'landscape', 'slide', 1920, 1080),
    'm-slide-3': board('Slide 3', 9, 'slides', '16:9', 'landscape', 'slide', 1920, 1080),
    'm-poster': board('Poster', 10, 'poster', '2:3', 'portrait', 'none', 1200, 1800, { label: 'Poster · 2:3 portrait' }),
    'm-poster-wide': board('Poster (landscape)', 11, 'poster', '2:3', 'landscape', 'none', 1800, 1200, { label: 'Poster · 2:3 landscape' }),
    'm-social': board('Square post', 12, 'social', 'post', 'square', 'none', 1080, 1080, { label: 'Social · Post square' }),
    // A board from before formats: frame none, an odd size, nearest format offered.
    'm-custom': board('Old page', 13, null, null, null, 'none', 1468, 5200, { section: 'website:desktop', format_label: 'Custom', grows: false,
      format_guess: { format: 'website', size: 'desktop', orientation: null, w: 1440, h: 900, label: 'Website · Desktop' } }) },
  html: {
    'm-desktop': SITE(false), 'm-mobile': SITE(true),
    'm-phone': page('Phone one', 'A phone screen.'), 'm-phone-2': page('Phone two', 'A phone screen.'), 'm-phone-3': page('Phone three', 'A phone screen.'),
    'm-tablet': page('Tablet', 'A tablet screen.'), 'm-slide': SLIDE(1, 'One idea per slide'), 'm-slide-2': SLIDE(2, 'Calm by design'), 'm-slide-3': SLIDE(3, 'Ready when you are'),
    'm-poster': POSTER(false), 'm-poster-wide': POSTER(true), 'm-social': page('Square post', 'Made for a feed.'), 'm-custom': page('Old page', 'Made before formats.') } },
  // The design a chat makes mid-turn (the pane opens on its first event).
  [PID]: { title: 'Launch site', chat: 's1', render: false, version: 1, comments: [], hidden: true, boards: {
    home: board('Home', 1, 'website', 'desktop', null, 'browser', 1440, 1700) },
  html: { home: SITE(false), 'home-mobile': SITE(true) } },
};
for (const d of Object.values(designs)) layout(d.boards);
const FORMATS = [
  { id: 'website', label: 'Website', options: [{ format: 'website', size: 'desktop', orientation: null, label: 'Website · Desktop', w: 1440, h: 900, grows: true }, { format: 'website', size: 'mobile', orientation: null, label: 'Website · Mobile', w: 390, h: 844, grows: true }] },
  { id: 'app', label: 'App', options: [{ format: 'app', size: 'phone', orientation: 'portrait', label: 'App · Phone portrait', w: 390, h: 844 }, { format: 'app', size: 'tablet', orientation: 'portrait', label: 'App · Tablet portrait', w: 820, h: 1180 }] },
  { id: 'poster', label: 'Poster', options: [{ format: 'poster', size: '2:3', orientation: 'portrait', label: 'Poster · 2:3 portrait', w: 1200, h: 1800 }, { format: 'poster', size: '2:3', orientation: 'landscape', label: 'Poster · 2:3 landscape', w: 1800, h: 1200 }] },
  { id: 'slides', label: 'Slides', options: [{ format: 'slides', size: '16:9', orientation: 'landscape', label: 'Slides · 16:9', w: 1920, h: 1080 }] },
];
const state = { posts: [], designMode: [], model: { endpoint: 'm1', model: null, effort: null } };

const view = id => {
  const d = designs[id], order = layout(d.boards);
  const sections = [];
  for (const slug of order) {
    const b = d.boards[slug], [top, side] = CHROME[b.frame] || [0, 0];
    const at = sections.find(s => s.key === b.section);
    if (at) { at.x = Math.min(at.x, b.x - side); at.y = Math.min(at.y, b.y - top); }
    else sections.push({ key: b.section, label: LABELS[b.section] || 'Custom', x: b.x - side, y: b.y - top });
  }
  const chats = { dz1: 'Design chat', s1: 'Workspace planning' };
  return { id, title: d.title, owner: 'demo', boards: d.boards, notes: [], version: d.version, updated: Date.now() / 1000, created: Date.now() / 1000,
    chat_ids: [d.chat], chats: [{ id: d.chat, title: chats[d.chat] }], design_system: 'kairos', first_board: order[0], order, token_overrides: {},
    comments: d.comments, render_available: d.render, layout: 'auto', sections, formats: FORMATS,
    system: { id: 'kairos', name: 'Kairos', variables: { '--ds-bg': '#F3EADB', '--ds-text': '#3A2A20', '--ds-space-4': '16px' }, defaults: {} } };
};
// The same rules as design_formats.resize and design_tools "move" (row layout).
function act(d, body) {
  const b = d.boards[body.board];
  if (body.action === 'move') {
    const order = Object.keys(d.boards).sort((x, y) => d.boards[x].order - d.boards[y].order);
    const row = order.filter(s => s !== body.board && d.boards[s].section === b.section);
    const centre = body.x + b.w / 2, before = row.find(s => centre < d.boards[s].x + d.boards[s].w / 2);
    const rest = order.filter(s => s !== body.board);
    rest.splice(before ? rest.indexOf(before) : rest.indexOf(row.at(-1)) + 1, 0, body.board);
    rest.forEach((s, n) => { d.boards[s].order = n + 1; });
  } else if (body.action === 'resize') {
    if (b.grows) b.h = Math.max(600, body.h);
    else if (b.ratio) { b.w = Math.round(body.w); b.h = Math.round(body.w / b.ratio); }
    else { b.w = body.w; b.h = body.h; }
  }
  d.version++;
  return `Version ${d.version}: ${body.action} ${body.board}.`;
}

function serve(url, req, res) {
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return true; };
  const read = handle => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch { /* Not JSON. */ } state.posts.push({ path: url.pathname, body: parsed }); handle(parsed); }); return true; };
  if (url.pathname.startsWith('/api/design-fonts/')) {
    const file = path.join(root, 'static', 'fonts', path.basename(url.pathname));
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'font/woff2');
    try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404); res.end(); }
    return true;
  }
  if (url.pathname === '/api/design-systems') return json([{ id: 'kairos', name: 'Kairos', builtin: true }]);
  // The design's linked chat and its model (designModelPicker.js).
  if (url.pathname === '/api/sessions/dz1' && req.method === 'GET') return json({ id: 'dz1', title: 'Design chat', messages: [], model_endpoint_id: state.model.endpoint, model_override: state.model.model, model_effort: state.model.effort });
  if (url.pathname === '/api/sessions/dz1/model' && req.method === 'POST') return read(body => {
    state.model = { endpoint: body.model_endpoint_id, model: body.model_override ?? null, effort: body.effort ?? null };
    json({ ok: true, model_endpoint_id: state.model.endpoint, model_override: state.model.model, effort: state.model.effort });
  });
  const mode = url.pathname.match(/^\/api\/designs\/mode\/([^/]+)$/);
  if (mode) return json({ session_id: mode[1], design_mode: state.designMode.includes(mode[1]) });
  if (!url.pathname.startsWith('/api/designs')) return false;
  if (url.pathname === '/api/designs' && req.method === 'GET') {
    const chat = url.searchParams.get('chat');
    return json(Object.keys(designs).filter(id => !designs[id].hidden && (!chat || designs[id].chat === chat)).map(id => {
      const v = view(id);
      return { ...v, boards: v.order.length, board_titles: v.order.map(s => v.boards[s].title).slice(0, 6), chat_title: v.chats[0].title };
    }));
  }
  if (url.pathname === '/api/designs/render-status') return json({ available: false, message: 'Needs the Kairos desktop app' });
  const m = url.pathname.match(/^\/api\/designs\/([a-f0-9]{12})(\/.*)?$/);
  const d = m && designs[m[1]];
  if (!d) return false;
  const rest = m[2] || '';
  const render = rest.match(/^\/boards\/([a-z0-9-]+)\/render$/);
  if (render) {
    const info = d.boards[render[1]];
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src http://${req.headers.host}/api/design-fonts/; script-src '${HASH}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`);
    const min = info.grows ? info.min_h : info.h;
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:Jost;src:url("/api/design-fonts/kairos/Jost-Variable.woff2")}${TOKENS}${reset(info.w, info.h, min)}</style><style id="kd-live-tokens"></style></head><body data-kd-board="${render[1]}">${addIds(d.html[render[1]] || '')}<script>${VIEWER}</script></body></html>`);
    return true;
  }
  if (/^\/boards\/[a-z0-9-]+\/thumb$/.test(rest)) { res.writeHead(404); res.end('{"detail":"No thumbnail"}'); return true; }
  if (rest === '' && req.method === 'GET') return json(view(m[1]));
  if (rest === '/comments' && req.method === 'GET') return json(d.comments);
  if (rest === '/comments' && req.method === 'POST') return read(body => {
    const comment = { id: 'c' + (d.comments.length + 1), board: body.board, element_ids: body.element_ids || [], point: body.point, text: body.text, status: 'open', made_on_version: d.version };
    d.comments.push(comment); json(comment);
  });
  if (rest === '/versions') return json([{ n: 1, at: Date.now() / 1000, by: 'Claude', tool: 'design_create', summary: 'Created', boards_changed: Object.keys(d.boards), changed_ids: {}, user_edit: false }]);
  if (rest === '/board-action') return read(body => { const message = body.board && d.boards[body.board] ? act(d, body) : 'ok'; json({ message, design: view(m[1]) }); });
  const fit = rest.match(/^\/boards\/([a-z0-9-]+)\/fit-height$/);
  if (fit) return read(body => { const b = d.boards[fit[1]]; if (b?.grows) b.h = Math.max(b.min_h, Math.round(body.h)); json({ h: b?.h, design: view(m[1]) }); });
  if (/^\/boards\/[a-z0-9-]+\/text$/.test(rest)) return read(() => { d.version++; json({ version: d.version, changed: {} }); });
  if (rest === '/boards' && req.method === 'POST') return read(body => {
    const option = FORMATS.flatMap(f => f.options).find(o => o.format === body.format && o.size === body.size && (o.orientation || null) === (body.orientation || null));
    const slug = 'added-' + (Object.keys(d.boards).length + 1);
    d.boards[slug] = board(body.title, Object.keys(d.boards).length + 1, option.format, option.size, option.orientation, 'none', option.w, option.h, { label: option.label });
    d.html[slug] = page(body.title, 'Added from the menu.');
    json({ slug, slugs: [slug], design: view(m[1]) });
  });
  return false;
}
// The server gives every element an id; the fixture's own pages get them here.
function addIds(html) {
  let n = 0;
  return html.replace(/<(main|section|header|footer|div|h1|h3|p|button|strong|span)(?![^>]*data-kd=)/g, (all, tag) => `<${tag} data-kd="${tag[0]}${++n}"`);
}

async function run({ js, waitFor, delay, navigate, win, capture, liveBroadcast, overflow, liveRuns, liveFinish, writes }) {
  // The newest frame showing that board (Focus opens after the canvas's own).
  const frameJs = async (slug, code, design = null) => {
    const frames = win.webContents.mainFrame.framesInSubtree.filter(frame => frame !== win.webContents.mainFrame && frame.url.includes(`/boards/${slug}/render`) && (!design || frame.url.includes(design)));
    if (!frames.length) throw new Error('No live frame for ' + slug);
    return frames.at(-1).executeJavaScript(code);
  };
  const C = "document.querySelector('.design-canvas').designCanvas";
  win.setContentSize(1440, 900); await delay(200);
  // Toasts left by the step before (the Agents routines checks PATCH /api/tasks/g1,
  // a fixture that answers 404) are not the canvas's: clear them, then hold the
  // Design view to no error toast of its own.
  await js("document.querySelectorAll('#toast-host .toast').forEach(t => t.remove())");
  const clean = () => js("document.querySelectorAll('#toast-host .toast').forEach(t => t.remove()); 1");
  const noErrorToasts = async where => assert.deepEqual(await js("[...document.querySelectorAll('#toast-host .toast.error')].map(t => t.textContent)"), [], 'no error toast: ' + where);

  // -- Library > Designs is the home for designs; there is no Design tab ---------
  await navigate('library', { section: 'designs' });
  await waitFor("document.querySelectorAll('.design-card').length === 2");
  assert.equal(await js("!!document.querySelector('.nav-item[data-tab=\"design\"]')"), false, 'no Design tab in the sidebar');
  assert.equal(await js("document.querySelector('.nav-item[data-tab=\"library\"]')?.getAttribute('aria-current')"), 'page', 'designs live in Library');
  assert.equal(await js("document.querySelector('[data-library-section=designs][aria-checked=true], [data-library-section=designs][aria-pressed=true]')?.textContent"), 'Designs');
  assert.match(await js("document.querySelector('.design-card').textContent"), /Habit onboarding.*3 boards/);
  await capture('design-library');
  await js("document.querySelector('.design-card').click()");
  await waitFor(`!!document.querySelector('#view-content[data-view="library"] .design-page[data-design-id="${ID}"]')`);
  await waitFor("document.querySelectorAll('.design-board').length === 3 && document.querySelectorAll('.design-board iframe').length === 3");
  await waitFor("location.hash === '#/library/designs/" + ID + "'");
  assert.equal(await js("document.querySelector('.nav-item[data-tab=\"library\"]')?.getAttribute('aria-current')"), 'page', 'a design opens inside Library');
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
  designs[ID].version = 2;
  liveBroadcast({ type: 'design_changed', designId: ID, version: 2, boards: ['pick-a-habit'], changed: { 'pick-a-habit': ['btn1'] }, by: 'Claude', tool: 'design_edit', summary: 'Edited', sessionId: 'dz1', manifestChanged: false });
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
  await js("[...document.querySelectorAll('.design-mode')].find(b => b.textContent === 'Pan').click()");
  await noErrorToasts('design-select');
  await capture('design-select');
  await js("document.querySelectorAll('.design-composer-chips .chat-reference-chip button').forEach(b => b.click())");

  // -- the model picker: the linked chat's connection, version and reasoning -------
  await waitFor("/Claude/.test(document.querySelector('.design-model-btn')?.textContent || '')");
  await js("document.querySelector('.design-model-btn').click()");
  await waitFor("!document.querySelector('.design-model-menu').hidden && document.querySelectorAll('.design-model-menu .model-connection-item').length >= 2");
  // The desktop board lists each connection's models directly; its old
  // connection-only row is hidden when a catalog is available.
  await waitFor("!!document.querySelector('.design-model-menu .model-other-catalog-list[data-endpoint-id=\"m2\"] .model-other-catalog-item')?.offsetParent");
  await js("[...document.querySelectorAll('.design-model-menu .model-other-catalog-list[data-endpoint-id=\"m2\"] .model-other-catalog-item')].find(b => b.textContent.includes('Workspace Fast')).click()");
  await waitFor("/^Codex/.test(document.querySelector('.design-model-btn').textContent) && !!document.querySelector('.design-model-menu .model-catalog-item')");
  assert.deepEqual(state.posts.filter(p => p.path === '/api/sessions/dz1/model').at(-1).body, { model_endpoint_id: 'm2', model_override: 'workspace-fast', effort: null });
  await js("document.querySelector('.design-model-btn').click()");
  await js("[...document.querySelectorAll('.design-model-menu .model-catalog-item')].find(b => b.textContent.includes('Workspace Fast')).click()");
  await waitFor("document.querySelector('.design-model-btn').textContent === 'Codex · Workspace Fast' && document.querySelector('.design-model-menu').hidden");
  await js("document.querySelector('.design-model-btn').click()");
  await waitFor("!!document.querySelector('.design-model-menu .model-effort-btn')");
  await js("[...document.querySelectorAll('.design-model-menu .model-effort-btn')].find(b => b.textContent === 'high').click()");
  await waitFor("document.querySelector('.design-model-btn').textContent === 'Codex · Workspace Fast · high'");
  assert.deepEqual(state.posts.filter(p => p.path === '/api/sessions/dz1/model').at(-1).body, { model_endpoint_id: 'm2', model_override: 'workspace-fast', effort: 'high' });
  await clean(); await capture('design-model-picker');
  // A send from the design's composer goes to that chat, which now runs on that model.
  const sentFrom = writes.length;
  await js("(() => { const i = document.querySelector('.design-composer-input'); i.value = 'Make the header warmer'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.design-composer-send').click(); })()");
  for (let i = 0; i < 60 && !writes.slice(sentFrom).some(w => w.path === '/api/chat/live'); i++) await delay(50);
  assert.equal(JSON.parse(writes.slice(sentFrom).find(w => w.path === '/api/chat/live').body).session_id, 'dz1', 'the design composer sends to the chat whose model was picked');

  // -- leaving: an unsent message stays with the design; a comment being written asks first (leaveGuard.js)
  await js("(() => { const i = document.querySelector('.design-composer-input'); i.value = 'Not sent yet'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await navigate('library', { section: 'documents' });
  await waitFor("!document.querySelector('.design-page')");
  await navigate('library', { section: 'designs', designId: ID });
  await waitFor(`!!document.querySelector('.design-page[data-design-id="${ID}"] .design-composer-input')`);
  assert.equal(await js("document.querySelector('.design-composer-input').value"), 'Not sent yet', 'the unsent message is kept with the design');
  await js("(() => { const i = document.querySelector('.design-composer-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await waitFor("document.querySelectorAll('.design-board iframe').length === 3");
  await js(`${C}.setMode('comment')`); await delay(400);
  await frameJs('landing', "document.querySelector('h1').click(); 1");
  await waitFor("!document.querySelector('.design-popover').hidden");
  await js("document.querySelector('.design-popover textarea').value = 'Half a thought'");
  await js("import('/static/js/app.js').then(m => { m.switchTab('library', { section: 'documents' }); return 1; })");
  await waitFor("!!document.querySelector('.confirm-panel') && /Leave this design/.test(document.querySelector('.confirm-panel').textContent)");
  await js("[...document.querySelectorAll('.confirm-panel .btn')].find(b => b.textContent === 'Cancel').click()");
  await waitFor("!document.querySelector('.confirm-panel')");
  assert.ok(await js(`!!document.querySelector('.design-page[data-design-id="${ID}"]') && document.querySelector('.design-popover textarea').value === 'Half a thought'`), 'Cancel keeps the design and the comment');
  await js("document.querySelector('.design-popover').hidden = true");
  await js(`${C}.setMode('pan')`);

  // -- the older link form still opens the design, in Library ----------------------
  // (Live boards for the pictures; the render window's thumbnails are checked below.)
  designs[MID].render = false;
  await js(`location.hash = '#/design/${MID}'`);
  await waitFor(`!!document.querySelector('#view-content[data-view="library"] .design-page[data-design-id="${MID}"]')`);
  await waitFor(`document.querySelectorAll('.design-board').length === ${Object.keys(designs[MID].boards).length}`);
  await waitFor("location.hash === '#/library/designs/" + MID + "'");

  // -- rows by format, section labels, and an older board offered its format -------
  await delay(600);
  assert.deepEqual(await js("[...document.querySelectorAll('.design-section-label')].map(n => n.textContent)"),
    ['Website · Desktop', 'Website · Mobile', 'App · Phone', 'App · Tablet', 'Slides', 'Poster', 'Social'], 'one labelled row per format');
  assert.equal(await js("document.querySelector('.design-fit-format').hidden"), false, 'an older board offers Fit to format');
  assert.match(await js("document.querySelector('.design-board[data-slug=\"m-custom\"] .design-board-meta').textContent"), /Custom · 1468x5200 · nearest Website · Desktop/);
  assert.match(await js("document.querySelector('.design-board[data-slug=\"m-desktop\"] .design-board-meta').textContent"), /Website · Desktop · 1440 wide/);
  const boxes = () => js(`(() => { const CH = ${JSON.stringify(CHROME)}; return [...document.querySelectorAll('.design-board')].map(b => { const [t, s, d] = CH[b.dataset.frame] || [0, 0, 0]; const x = parseFloat(b.style.left), y = parseFloat(b.style.top), w = parseFloat(b.style.width), h = parseFloat(b.style.height); return { slug: b.dataset.slug, x1: x - s, y1: y - t - 34, x2: x + w + s, y2: y + h + d }; }); })()`);
  const overlaps = list => list.flatMap((a, i) => list.slice(i + 1).filter(b => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2).map(b => `${a.slug}/${b.slug}`));
  assert.deepEqual(overlaps(await boxes()), [], 'no board overlaps another');
  // Natural formats, captured: the website pair, posters both ways, a slide deck.
  await clean();
  await js(`${C}.fitBoards(['m-poster', 'm-poster-wide'])`); await delay(1500);
  await capture('design-posters');
  await js(`${C}.fitBoards(['m-slide', 'm-slide-2', 'm-slide-3'])`); await delay(1500);
  await capture('design-slides');
  // A website board grows with its page: the viewer measures it and the board follows (no version).
  // (Live here in Select mode; at a zoom that fits it, the desktop app's render window measures it.)
  await js(`${C}.setMode('select'); ${C}.zoomToBoard('m-desktop')`);
  for (let i = 0; i < 80 && !state.posts.some(p => p.path.endsWith('/m-desktop/fit-height')); i++) await delay(50);
  const fitPost = state.posts.find(p => p.path.endsWith('/m-desktop/fit-height'));
  assert.ok(fitPost && fitPost.body.h > 900 && fitPost.body.h < 2300, 'the desktop page reports its own height: ' + JSON.stringify(fitPost));
  await waitFor(`parseFloat(document.querySelector('.design-board[data-slug="m-desktop"]').style.height) === ${designs[MID].boards['m-desktop'].h}`);
  assert.deepEqual(overlaps(await boxes()), [], 'the rows below moved up to the page\'s height');
  await js(`${C}.setMode('pan')`);

  // -- Select, Comment and Text on every frame type, at the fitted zoom ------------
  designs[MID].render = true; await js(`${C}.reload()`); await delay(500);
  // The desktop app has a render window, so below 35% boards are thumbnails; in
  // these modes the boards in view are live anyway (they used to stay pictures).
  await js(`${C}.fit(false)`); await delay(600);
  const fitZoom = await js(`${C}.state().zoom`);
  assert.ok(fitZoom < 0.35, 'the whole matrix fits below the live zoom: ' + fitZoom);
  await js(`${C}.setMode('pan')`); await delay(400);
  assert.ok(await js("document.querySelectorAll('.design-board iframe').length === 0"), 'Pan at this zoom shows thumbnails (the desktop app)');
  const slugs = Object.keys(designs[MID].boards);
  const results = [];
  for (const mode of ['select', 'comment', 'text']) {
    for (const slug of slugs) {
      await js(`${C}.setMode('pan'); ${C}.clearSelection(); document.querySelector('.design-popover').hidden = true; document.querySelectorAll('.design-composer-chips .chat-reference-chip button').forEach(b => b.click()); 1`);
      await js(`${C}.fit(false); ${C}.setMode('${mode}'); 1`);
      await waitFor(`!!document.querySelector('.design-board[data-slug="${slug}"] iframe')`);
      // The frame is the board: the viewer's click lands where the page shows it.
      for (let i = 0; i < 40; i++) { if (await frameJs(slug, "document.documentElement.dataset.kdMode", MID).catch(() => null) === mode) break; await delay(50); }
      const posts = state.posts.length;
      const spot = await frameJs(slug, "(() => { const r = document.querySelector('h1').getBoundingClientRect(); return { x: (r.left + 4) / innerWidth, y: (r.top + r.height / 2) / innerHeight }; })()", MID);
      await frameJs(slug, `(() => { const t = document.querySelector('h1'); const r = t.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + r.height / 2, view: window };
        t.dispatchEvent(new MouseEvent('click', o)); ${mode === 'text' ? "t.dispatchEvent(new MouseEvent('dblclick', o));" : ''} return 1; })()`, MID);
      let ok = false;
      if (mode === 'select') {
        ok = await js(`(async () => { for (let i = 0; i < 30; i++) { if ([...document.querySelectorAll('.design-composer-chips .chat-reference-chip')].some(c => c.textContent.includes(${JSON.stringify(designs[MID].boards[slug].title)}))) return true; await new Promise(r => setTimeout(r, 50)); } return false; })()`);
      } else if (mode === 'comment') {
        ok = await js(`(async () => { for (let i = 0; i < 30; i++) { if (!document.querySelector('.design-popover').hidden) return true; await new Promise(r => setTimeout(r, 50)); } return false; })()`);
        if (ok) {
          await js(`(() => { const i = document.querySelector('.design-popover textarea'); i.value = 'Warmer here'; [...document.querySelectorAll('.design-popover .btn')].find(b => b.textContent === 'Pin comment').click(); })()`);
          for (let i = 0; i < 40 && !state.posts.slice(posts).some(p => p.path.endsWith('/comments')); i++) await delay(50);
          const pinned = state.posts.slice(posts).find(p => p.path.endsWith('/comments'))?.body;
          ok = pinned?.board === slug && pinned.element_ids.length === 1 && Math.abs(pinned.point.x - spot.x) < 0.01 && Math.abs(pinned.point.y - spot.y) < 0.01;
          // The pin sits on the board exactly where it was dropped, at any size of board.
          const b = designs[MID].boards[slug];
          const pin = await js("(() => { const p = [...document.querySelectorAll('.design-pin')].at(-1); return p ? { x: parseFloat(p.style.left), y: parseFloat(p.style.top) } : null; })()");
          ok = ok && pin && Math.abs(pin.x - (b.x + spot.x * b.w)) < 3 && Math.abs(pin.y - (b.y + spot.y * b.h)) < 3;
          if (!ok) results.push(`comment ${slug} detail: ${JSON.stringify({ pinned, spot, pin, b: { x: b.x, y: b.y, w: b.w, h: b.h } })}`);
        }
      } else {
        ok = await frameJs(slug, "!!document.querySelector('[contenteditable]')", MID);
        if (ok) {
          await frameJs(slug, `(() => { const n = document.querySelector('[contenteditable]'); n.innerText = 'Edited ${slug}'; n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`, MID);
          for (let i = 0; i < 40 && !state.posts.slice(posts).some(p => p.path.endsWith(`/boards/${slug}/text`)); i++) await delay(50);
          ok = state.posts.slice(posts).find(p => p.path.endsWith(`/boards/${slug}/text`))?.body.text === `Edited ${slug}`;
        }
      }
      results.push(`${mode} ${slug}: ${ok ? 'ok' : 'FAILED'}`);
    }
  }
  assert.deepEqual(results.filter(r => !r.endsWith(': ok')), [], 'Select, Comment and Text on every frame type:\n' + results.join('\n'));
  await js(`${C}.setMode('pan'); ${C}.clearSelection(); document.querySelectorAll('.design-composer-chips .chat-reference-chip button').forEach(b => b.click()); 1`);

  // -- reflow: a drag moves a board along its row; its neighbours make room --------
  designs[MID].render = false; await js(`${C}.reload()`); await clean();
  await js(`${C}.fitBoards(['m-phone', 'm-phone-2', 'm-phone-3', 'm-tablet'])`); await delay(800);
  const start = Object.fromEntries((await boxes()).map(b => [b.slug, b]));
  const drag = (selector, dx, dy, steps = 6) => js(`(async () => { const t = document.querySelector(${JSON.stringify(selector)}); const r = t.getBoundingClientRect(); const x = r.left + Math.min(20, r.width / 2), y = r.top + r.height / 2;
    const at = (type, px, py) => t.dispatchEvent(new PointerEvent(type, { clientX: px, clientY: py, pointerId: 9, button: 0, buttons: 1, bubbles: true }));
    at('pointerdown', x, y); for (let i = 1; i <= ${steps}; i++) { at('pointermove', x + ${dx} * i / ${steps}, y + ${dy} * i / ${steps}); await new Promise(r => setTimeout(r, 30)); }
    window.__dragHold = () => at('pointerup', x + ${dx}, y + ${dy}); return 1; })()`);
  const rowStep = start['m-phone-2'].x1 - start['m-phone'].x1;
  const dxScreen = await js(`${rowStep * 2.6} * ${C}.state().zoom`);
  await drag('.design-board[data-slug="m-phone"] .design-board-title', dxScreen, 20);
  // Mid-drag: Phone 2 and 3 have slid left into the gap; the tablet row is untouched.
  const during = Object.fromEntries((await boxes()).map(b => [b.slug, b]));
  assert.equal(Math.round(during['m-phone-2'].x1), Math.round(start['m-phone'].x1), 'the neighbour slides into the gap while dragging');
  assert.equal(Math.round(during['m-phone-3'].x1), Math.round(start['m-phone-2'].x1));
  assert.equal(await js("document.querySelector('.design-canvas').dataset.dropOrder.split(',').filter(s => /^m-phone/.test(s)).join()"), 'm-phone-2,m-phone-3,m-phone');
  await delay(300); await capture('design-reflow-dragging');
  const moveFrom = state.posts.length;
  await js('window.__dragHold()');
  for (let i = 0; i < 40 && !state.posts.slice(moveFrom).some(p => p.body.action === 'move'); i++) await delay(50);
  assert.equal(state.posts.slice(moveFrom).find(p => p.body.action === 'move').body.reflow, true, 'a drop is saved as the row layout');
  await waitFor(`${C}.design.order.filter(s => /^m-phone/.test(s)).join() === 'm-phone-2,m-phone-3,m-phone'`);
  await delay(400);
  const after = Object.fromEntries((await boxes()).map(b => [b.slug, b]));
  assert.equal(Math.round(after['m-phone'].x1), Math.round(start['m-phone-3'].x1), 'the board lands at the end of its row');
  assert.equal(Math.round(after['m-phone'].y1), Math.round(start['m-phone'].y1), 'and stays in its row');
  assert.deepEqual(overlaps(Object.values(after)), [], 'nothing overlaps after the drop');
  await clean(); await capture('design-reflow');
  // A corner drag on a poster keeps 2:3 and pushes the landscape poster along.
  await js(`${C}.fitBoards(['m-poster', 'm-poster-wide', 'm-social'])`); await delay(800);
  const posters = Object.fromEntries((await boxes()).map(b => [b.slug, b]));
  await js("document.querySelector('.design-board[data-slug=\"m-poster\"]').classList.add('selected')");
  await drag('.design-board[data-slug="m-poster"] .design-resize', 120, 10);
  const growing = await js("(() => { const b = document.querySelector('.design-board[data-slug=\"m-poster\"]'); return parseFloat(b.style.width) / parseFloat(b.style.height); })()");
  assert.ok(Math.abs(growing - 2 / 3) < 0.01, 'a poster resizes at 2:3: ' + growing);
  assert.ok((await boxes()).find(b => b.slug === 'm-poster-wide').x1 > posters['m-poster-wide'].x1 + 50, 'the next poster is pushed along');
  await js('window.__dragHold()');
  for (let i = 0; i < 40 && !state.posts.some(p => p.body.action === 'resize'); i++) await delay(50);
  await delay(500);
  assert.deepEqual(overlaps(await boxes()), [], 'nothing overlaps after a resize');
  // Titles and row labels at very low zoom: they shrink with the canvas, then
  // step aside (row labels first), so no text ever overlaps a board or other text.
  const textClash = () => js(`(() => {
    const visible = n => getComputedStyle(n).visibility !== 'hidden' && n.getClientRects().length;
    const box = n => { const r = n.getBoundingClientRect(); return { n, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom }; };
    const texts = [...document.querySelectorAll('.design-board-title, .design-section-label')].filter(visible).map(box);
    const chrome = [...document.querySelectorAll('.design-board')].map(b => ({ ...box(b.querySelector('.design-chrome')), board: b }));
    const hit = (a, b) => a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
    const name = t => t.n.classList.contains('design-section-label') ? 'label ' + t.n.textContent : 'title ' + t.n.closest('.design-board').dataset.slug;
    const out = [];
    texts.forEach((t, i) => {
      for (const c of chrome) if (c.board !== t.n.closest('.design-board') && hit(t, c)) out.push(name(t) + ' on board ' + c.board.dataset.slug);
      for (const u of texts.slice(i + 1)) if (hit(t, u)) out.push(name(t) + ' on ' + name(u));
    });
    return { out, titles: texts.filter(t => !t.n.classList.contains('design-section-label')).length, labels: texts.filter(t => t.n.classList.contains('design-section-label')).length };
  })()`);
  for (const level of [0.05, 0.1, 0.2]) {
    await js(`${C}.fit(false); ${C}.zoomTo(${level})`); await delay(300);
    const clash = await textClash();
    assert.deepEqual(clash.out, [], `no text overlaps at ${level * 100}% zoom`);
    if (level === 0.05) assert.equal(clash.titles + clash.labels, 0, 'at 5% titles and labels step aside');
    if (level === 0.1) assert.ok(clash.titles > 0 && clash.labels > 0, 'at 10% titles and labels show, scaled to fit');
    await clean(); await capture(`design-zoom-${Math.round(level * 100)}`);
  }
  await js(`${C}.fit(false)`);
  // Add board offers formats, not free frames.
  await js("[...document.querySelectorAll('.design-toolbar .btn')].find(b => b.textContent === 'Add board').click()");
  await waitFor("!!document.querySelector('.design-format-menu')");
  assert.deepEqual(await js("[...document.querySelectorAll('.design-format-menu .design-menu-heading')].map(n => n.textContent)"), ['Website', 'App', 'Poster', 'Slides']);
  assert.ok(await js("[...document.querySelectorAll('.design-format-menu .design-menu-item')].some(b => b.textContent === 'Desktop and mobile pair')"));
  await js("document.querySelector('.design-format-menu').remove()");
  await noErrorToasts('design-matrix');

  // -- the design pane opens at the start of a chat's turn, and updates live -------
  await navigate('chat', { sessionId: 's1' });
  await waitFor("!!document.querySelector('.chat-layout')");
  await js("import('/static/js/chatContent.js').then(m => { m.closeArtifact(); return 1; })");
  // The reader keeps their place when the design takes half the window (chatScrollAnchor.js):
  // a long conversation, read from the middle, then the design opens beside it.
  await js(`(() => { const m = document.querySelector('#chat-messages'); for (let i = 0; i < 40; i++) { const d = document.createElement('div'); d.className = 'msg assistant design-reading-filler'; d.dataset.n = i; d.innerHTML = '<p>Reading line ' + i + ': a paragraph long enough to wrap when the chat column narrows beside the design pane.</p>'; m.append(d); } m.scrollTop = m.querySelector('[data-n="20"]').offsetTop - 120; return 1; })()`);
  await delay(300);
  // The line at the middle of the chat is the reader's place (what chatScrollAnchor.js keeps).
  await js("(() => { const m = document.querySelector('#chat-messages'), r = m.getBoundingClientRect(); const c = document.caretRangeFromPoint(r.left + m.clientWidth / 2, r.top + m.clientHeight / 2); window.__readingAt = { node: c.startContainer, offset: c.startOffset }; return 1; })()");
  const readingTop = () => js("(() => { const m = document.querySelector('#chat-messages'), a = window.__readingAt; const range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(a.node, Math.min(a.offset + 1, a.node.length)); return range.getClientRects()[0].top - m.getBoundingClientRect().top; })()");
  const readingBefore = await readingTop();
  state.designMode = ['s1'];
  liveRuns.s1 = { turnId: 'design-turn', sessionTitle: 'Workspace planning', prompt: 'Design our launch site', text: '', startedAt: Date.now() / 1000,
    status: 'processing', stopping: false, permission: null, toolEvents: [], toolSteps: [], handoffs: null, runId: null, error: null, revision: 1 };
  liveBroadcast({ type: 'started', sessionId: 's1', run: structuredClone(liveRuns.s1) });
  await waitFor("document.querySelector('.artifact-empty')?.dataset.designPending === 's1' && document.querySelector('.artifact-empty').offsetParent !== null");
  assert.match(await js("document.querySelector('.artifact-empty').textContent"), /Starting the design/);
  await delay(600); const readingPlaceholder = await readingTop();
  await capture('design-pane-placeholder');
  // design_create's first event: the pane shows the design while the reply is still running.
  designs[PID].hidden = false;
  liveBroadcast({ type: 'design_changed', designId: PID, version: 1, boards: ['home'], changed: {}, by: 'Claude', tool: 'design_create', summary: 'Created', sessionId: 's1', manifestChanged: true });
  await waitFor("document.querySelector('.chat-design-pane')?.textContent.includes('Launch site') && document.querySelectorAll('.artifact-panel .design-board').length === 1");
  assert.equal(await js("import('/static/js/chatStream.js').then(m => m.getInFlight('s1')?.status)"), 'processing', 'the pane opened mid-turn');
  assert.equal(await js("document.querySelector('.artifact-panel').contains(document.activeElement)"), false, 'opening it took no focus from the chat');
  await delay(600);
  const readingAfter = await readingTop();
  assert.ok(Math.abs(readingAfter - readingBefore) <= 4, `the chat keeps its reading place when the design pane opens: ${readingBefore} -> ${readingPlaceholder} -> ${readingAfter}`);
  // The next board arrives with design_add_board: the pane redraws without waiting for the reply.
  const home = designs[PID].boards.home;
  designs[PID].boards['home-mobile'] = board('Home (mobile)', 2, 'website', 'mobile', null, 'phone', 390, 2600);
  layout(designs[PID].boards); designs[PID].version = 2; void home;
  liveBroadcast({ type: 'design_changed', designId: PID, version: 2, boards: ['home-mobile'], changed: {}, by: 'Claude', tool: 'design_add_board', summary: 'Added board', sessionId: 's1', manifestChanged: true });
  await waitFor("document.querySelectorAll('.artifact-panel .design-board').length === 2");
  await delay(600); await clean();
  await capture('design-pane-mid-turn');
  // The same interactive canvas, at roughly the mockup's 560px pane width.
  await js("(() => { const host = document.querySelector('.chat-layout'), handle = host.querySelector('.chat-pane-resizer'); const target = host.clientWidth - 588; const delta = target - Number(handle.getAttribute('aria-valuenow')); for (let i = 0; i < Math.round(Math.abs(delta) / 24); i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key: delta > 0 ? 'ArrowRight' : 'ArrowLeft', bubbles: true })); })()");
  await delay(300);
  assert.ok(await js("Math.abs(document.querySelector('.chat-design-pane').getBoundingClientRect().width - 560) < 28"), 'canvas pane is about 560px wide');
  assert.ok(await js("!!document.querySelector('.chat-design-pane .design-model-btn')?.offsetParent"), 'the chat design pane keeps its model picker');
  await js(`window.__paneCanvas = ${C}; ${C}.zoomToBoard('home'); document.querySelector('.chat-design-pane [aria-label="Zoom in"]').click()`);
  const paneZoom = await js(`${C}.state().zoom`);
  await js("document.querySelector('.chat-design-pane [aria-label=\"Zoom out\"]').click()");
  assert.ok(await js(`${C}.state().zoom < ${paneZoom}`), 'pane zoom buttons work');
  await js(`${C}.root.focus(); ${C}.root.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }))`);
  assert.ok(Math.abs(await js(`${C}.state().zoom`) - paneZoom) < 0.001, 'focused pane keyboard zoom works');
  await js(`${C}.setMode('pan'); document.querySelector('#chat-input').focus(); document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }))`);
  assert.equal(await js(`${C}.state().mode`), 'pan', 'composer typing cannot switch canvas tools');
  for (const mode of ['select', 'comment', 'text']) {
    await js(`${C}.setMode('${mode}'); ${C}.zoomToBoard('home')`);
    await waitFor("!!document.querySelector('.chat-design-pane .design-board[data-slug=\"home\"] iframe')");
    for (let i = 0; i < 40; i++) { if (await frameJs('home', 'document.documentElement.dataset.kdMode', PID).catch(() => null) === mode) break; await delay(50); }
    const posts = state.posts.length;
    await frameJs('home', `(() => { const t = document.querySelector('h1'), r = t.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + r.height / 2, view: window }; t.dispatchEvent(new MouseEvent('click', o)); ${mode === 'text' ? "t.dispatchEvent(new MouseEvent('dblclick', o));" : ''} return 1; })()`, PID);
    if (mode === 'select') await waitFor("!!document.querySelector('.chat-reference-chip')");
    else if (mode === 'comment') {
      await waitFor("!document.querySelector('.chat-design-pane .design-popover').hidden");
      await js("(() => { const p = document.querySelector('.chat-design-pane .design-popover'); p.querySelector('textarea').value = 'Pane comment'; [...p.querySelectorAll('button')].find(b => b.textContent === 'Pin comment').click(); })()");
      for (let i = 0; i < 40 && !state.posts.slice(posts).some(p => p.path.endsWith('/comments')); i++) await delay(50);
      assert.equal(state.posts.slice(posts).find(p => p.path.endsWith('/comments'))?.body.text, 'Pane comment');
    } else {
      assert.ok(await frameJs('home', "!!document.querySelector('[contenteditable]')", PID), 'pane text tool edits live elements');
      await frameJs('home', "(() => { const t = document.querySelector('[contenteditable]'); t.innerText = 'Edited from pane'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()", PID);
      for (let i = 0; i < 40 && !state.posts.slice(posts).some(p => p.path.endsWith('/text')); i++) await delay(50);
      assert.equal(state.posts.slice(posts).find(p => p.path.endsWith('/text'))?.body.text, 'Edited from pane');
    }
  }
  await js(`${C}.setMode('select'); document.querySelector('.chat-design-pane [aria-label="Expand design"]').click()`);
  assert.ok(await js(`${C} === window.__paneCanvas && document.querySelector('#chat-main').inert`), 'expand retains the live instance');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  assert.ok(await js("!document.querySelector('#chat-main').inert && !!document.querySelector('.chat-design-pane')"), 'Escape restores the pane');
  await capture('design-pane-editable-560');
  liveFinish('s1');
  state.designMode = [];
  await js("document.querySelectorAll('.design-reading-filler').forEach(n => n.remove()); 1");
  await js("import('/static/js/chatContent.js').then(m => { m.closeArtifact(); return 1; })");
  await noErrorToasts('design-pane');
  // The site it made, full page in Library: a desktop and mobile pair in their own rows.
  await navigate('library', { section: 'designs', designId: PID });
  assert.ok(await js(`${C} === window.__paneCanvas && ${C}.state().mode === 'select'`), 'Library reuses the live canvas and tool state');
  assert.ok(await js("!!document.querySelector('.design-page .design-model-btn')?.offsetParent"), 'Library keeps its desktop model picker after moving the shared canvas');
  await waitFor(`document.querySelectorAll('.design-page[data-design-id="${PID}"] .design-board iframe').length === 2`);
  assert.deepEqual(await js("[...document.querySelectorAll('.design-section-label')].map(n => n.textContent)"), ['Website · Desktop', 'Website · Mobile']);
  await delay(1500); await clean();
  await capture('design-website-pair');

  // -- Phones: Library's board list and the one-board pager, no sideways scroll, 44px targets.
  for (const [width, height] of [[390, 844], [430, 932]]) {
    win.setContentSize(width, height); await delay(400);
    await navigate('design', { designId: ID });
    await waitFor("document.querySelector('.design-canvas')?.dataset.view === 'list' && document.querySelectorAll('.design-list-card').length === 3");
    assert.equal(await js("document.querySelector('#view-content').dataset.view"), 'library', 'the old Design route lands in Library on a phone too');
    assert.deepEqual(await js(`[...document.querySelectorAll('.design-page, .design-canvas, .design-list, .design-composer')].filter(e => e.scrollWidth > e.clientWidth + 2).map(e => e.className)`), [], `no sideways scroll at ${width}`);
    if (overflow) assert.deepEqual(await overflow(), [], `the page fits at ${width}`);
    // Rounded: a box at a fractional position can measure 43.99999px.
    const small = await js(`[...document.querySelectorAll('.design-toolbar .btn, .design-modes .btn, .design-composer .btn, .design-page-header .btn')].filter(b => b.offsetParent && Math.round(b.getBoundingClientRect().height) < 44).map(b => b.textContent)`);
    assert.deepEqual(small, [], `44px targets at ${width}`);
    assert.ok(await js("!!document.querySelector('.design-model-btn') && document.querySelector('.design-model-btn').offsetParent !== null"), 'the model picker is on the phone too');
    assert.ok(await js(`(() => {
      const title = document.querySelector('.design-page-identity h2').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.design-page-header > button')].filter(n => n.getClientRects().length);
      const model = document.querySelector('.design-page .design-model-btn').getBoundingClientRect();
      const name = document.querySelector('.design-page-identity strong').getBoundingClientRect();
      return buttons.length === 2 && buttons.every(n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n);
        return Math.abs(r.top - title.top) <= 1 && r.left >= title.right && Math.round(r.width) === 46 && Math.round(r.height) === 46 && parseFloat(s.borderRadius) >= 23;
      }) && name.top >= title.bottom && model.top >= title.bottom;
    })()`), `Library has a title and two round actions above its content at ${width}`);
    // The phone tab bar (mobileTabBar.js): the board list keeps it; the pager hides it.
    await waitFor("document.documentElement.classList.contains('ms-tabbar-up')");
    await noErrorToasts(`phone ${width}`);
    await capture(`design-phone-${width}`);
    // More lists every tab but the bar's own; Design is not one of them any more.
    await js("import('/static/js/mobileTabSheet.js').then(m => { m.openMoreSheet(document.body); return 1; })");
    await waitFor("document.querySelectorAll('.ms-tab-tile').length > 0");
    const tiles = await js("[...document.querySelectorAll('.ms-tab-tile')].map(t => t.textContent.trim())");
    assert.ok(tiles.includes('Library') && !tiles.includes('Design'), 'More has Library and no Design: ' + tiles.join(', '));
    await js("import('/static/js/mobileTabSheet.js').then(m => { m.closeMoreSheet(); return 1; })");
    await delay(300);
    await js("document.querySelectorAll('.design-list-card')[0].click()");
    await waitFor("!!document.querySelector('.design-focus iframe')");
    await waitFor("!document.documentElement.classList.contains('ms-tabbar-up')");
    const pagerBelowHeader = () => js(`(() => {
      const header = document.querySelector('.design-page-header').getBoundingClientRect();
      const model = document.querySelector('.design-page .design-model-btn');
      const r = model.getBoundingClientRect();
      return model.offsetParent !== null && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.design-model-btn') === model
        && [...document.querySelectorAll('.design-focus-bar button')].filter(n => n.getClientRects().length).every(n => n.getBoundingClientRect().top >= header.bottom - 0.5);
    })()`);
    assert.ok(await pagerBelowHeader(), `the model stays exposed and pager controls start below the phone header at ${width}`);
    assert.ok(await js(`(() => {
      const title = document.querySelector('.design-focus-bar strong').getBoundingClientRect();
      const close = document.querySelector('.design-focus-bar [aria-label="Close focus"]').getBoundingClientRect();
      return Math.abs(close.top - title.top) <= 1 && Math.round(close.width) === 46 && Math.round(close.height) === 46
        && [...document.querySelectorAll('.design-focus-controls button')].filter(n => n.getClientRects().length).every(n => n.getBoundingClientRect().top >= title.bottom);
    })()`), `Previous/Next and width controls sit below the pager title at ${width}`);
    // Parking keeps the open board; returning must also keep it below the header.
    await navigate('library', { section: 'documents' });
    await navigate('library', { section: 'designs', designId: ID });
    await waitFor("!!document.querySelector('.design-focus iframe')");
    assert.ok(await pagerBelowHeader(), `the retained shared pager stays below the header at ${width}`);
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
    await navigate('chat', { sessionId: 's1', mobileConversation: true });
    await js(`import('/static/js/chatContent.js').then(m => m.openDesignTab('s1', '${PID}'))`);
    await waitFor("!!document.querySelector('.chat-design-pane .design-model-btn')?.offsetParent && !document.querySelector('.chat-design-pane .design-model-btn').disabled");
    assert.ok(await js(`${C} === window.__paneCanvas`), `phone chat reuses Library's live canvas at ${width}`);
    assert.ok(await js(`(() => {
      const pane = document.querySelector('.chat-design-pane'), r = pane.getBoundingClientRect();
      const title = pane.querySelector('.chat-pane-heading strong').getBoundingClientRect();
      const buttons = [...pane.querySelectorAll('.chat-side-pane-header button')].filter(n => n.getClientRects().length);
      const model = pane.querySelector('.design-model-btn'), m = model.getBoundingClientRect();
      return r.width <= innerWidth && buttons.length === 2 && buttons.every(n => { const b = n.getBoundingClientRect();
        return Math.abs(b.top - title.top) <= 1 && b.left >= title.right && Math.round(b.width) === 46 && Math.round(b.height) === 46 && parseFloat(getComputedStyle(n).borderRadius) >= 23;
      }) && m.top >= title.bottom && document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2)?.closest('.design-model-btn') === model;
    })()`), `chat Design keeps its phone header and accessible model picker at ${width}`);
    await js("document.querySelector('.chat-design-pane .design-model-btn').click()");
    // Phone menus move into the board's modal sheet, outside the chat pane.
    // Follow the trigger's ownership link and check the visible provider tabs
    // as well as the original connection choices and model radio rows.
    await waitFor(`(() => {
      const trigger = document.querySelector('.chat-design-pane .design-model-btn');
      const sheet = document.getElementById(trigger.getAttribute('aria-controls'));
      return trigger.getAttribute('aria-expanded') === 'true' && sheet?.matches('.ms-model-sheet[open]')
        && sheet.querySelectorAll('.model-connection-item').length >= 2
        && [...sheet.querySelectorAll('.ms-provider-tabs [role="tab"]')].filter(n => n.getClientRects().length).length >= 2
        && !!sheet.querySelector('.ms-provider-tabs [aria-selected="true"]')
        && !!sheet.querySelector('.model-catalog-item[role="radio"]')?.offsetParent;
    })()`);
    await capture(`design-chat-phone-${width}`);
    await js("document.querySelector('.ms-model-sheet .ms-sheet-header [aria-label=\"Close\"]').click()");
    await waitFor("!document.querySelector('.ms-model-sheet') && document.querySelector('.chat-design-pane .design-model-btn').getAttribute('aria-expanded') === 'false' && document.querySelectorAll('.chat-design-pane .model-connection-item').length >= 2 && document.activeElement === document.querySelector('.chat-design-pane .design-model-btn')");
    await js("document.querySelector('.chat-design-pane [aria-label=\"Close design\"]').click()");
    await waitFor("!document.querySelector('.chat-design-pane')");
  }
  win.setContentSize(1440, 900); await delay(300);
  await navigate('library', { section: 'documents' });
}

module.exports = { serve, run };
