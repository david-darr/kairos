// The Design canvas (vault: Design Canvas (Build Spec), 3c-3f, 3i).
// A design is boards on an infinite canvas. Each board renders in its own
// <iframe sandbox="allow-scripts"> (no allow-same-origin: an opaque origin
// with no reach into the app) from /api/designs/<id>/boards/<slug>/render,
// whose header CSP lets only Kairos's own viewer script run. The canvas and
// the viewer talk only by postMessage; messages are accepted only from a
// frame this canvas created, and are treated as data.
//
// Boards are made in named formats (core/design_formats.py) and sit in rows,
// one row per format. Dragging a board by its title moves it along its row and
// its neighbours make room; resizing it from its corner keeps its format (a
// fixed ratio, or height only for a website) and pushes the row along and the
// rows below down. A website or email board grows with its content: the
// viewer reports the page's height and the board follows it.
//
// Modes: Pan (drag the canvas, drag a board by its title, resize it from its
// corner), Select (picked elements become chips in the chat composer),
// Comment (pin a comment to an element or a point), Text (double-click text
// to edit it in place). Focus opens one board at real size, live and
// clickable, for click-through prototypes. On a phone the design opens as a
// board list with a one-board pager; Canvas switches to the pan canvas.
import { api, el, toast } from './api.js';
import { mobileOn } from './mobileShared.js';
import { openMobileSheet } from './mobileSheet.js';

const FRAME_LABEL = { phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop', browser: 'Browser', slide: 'Slide', none: 'Custom' };
// Chrome drawn around each board, outside its w x h (canvas pixels).
const CHROME = { phone: [36, 12, 22], tablet: [22, 18, 22], desktop: [0, 0, 0], browser: [40, 0, 0], slide: [0, 0, 0], none: [0, 0, 0] };
const TITLE_GAP = 34;
const GAP = 120, ROW_GAP = 320;  // core/design_formats.py: between boards in a row, and between rows.
const LIVE_ZOOM = 0.35;
const MAX_LIVE = 16;
const MIN_ZOOM = 0.04, MAX_ZOOM = 4;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const MODES = [['pan', 'Pan', 'Move around the canvas and arrange boards (H)'], ['select', 'Select', 'Select elements to change in chat (S)'],
  ['comment', 'Comment', 'Pin a comment to an element (C)'], ['text', 'Text', 'Double-click text to edit it (T)']];

export function designUrl(id) { return `/designs/${id}`; }

// "Website · Desktop · 1440 wide", "Poster · 2:3 portrait · 1200x1800", or an
// older board's size with its nearest format.
export function sizeText(info) {
  if (!info) return '';
  if (info.format) return `${info.format_label || info.format} · ${info.grows ? `${info.w} wide` : `${info.w}x${info.h}`}`;
  return `${FRAME_LABEL[info.frame] || 'Custom'} · ${info.w}x${info.h}${info.format_guess ? ` · nearest ${info.format_guess.label}` : ''}`;
}

// Rows by format, in board order: the same layout as design_formats.layout,
// so a drag or resize shows where everything lands before it is saved.
export function layoutRows(boards, order) {
  const rows = new Map();
  for (const slug of order) {
    const key = boards[slug].section || 'custom';
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(slug);
  }
  const out = {};
  let y = 0;
  for (const slugs of rows.values()) {
    y += Math.max(...slugs.map(slug => (CHROME[boards[slug].frame] || CHROME.none)[0])) + TITLE_GAP;
    let x = 0, bottom = 0;
    for (const slug of slugs) {
      const b = boards[slug], [, side, below] = CHROME[b.frame] || CHROME.none;
      x += side; out[slug] = { x, y }; x += b.w + side + GAP;
      bottom = Math.max(bottom, b.h + below);
    }
    y += bottom + ROW_GAP;
  }
  return out;
}

// Where a board dropped at x lands in its row (design_tools.board_action "move").
export function orderAfterDrop(boards, order, slug, x) {
  const key = boards[slug].section;
  const row = order.filter(s => s !== slug && boards[s].section === key);
  const centre = x + boards[slug].w / 2;
  const before = row.find(s => centre < boards[s].x + boards[s].w / 2);
  const rest = order.filter(s => s !== slug);
  const at = before ? rest.indexOf(before) : row.length ? rest.indexOf(row.at(-1)) + 1 : rest.length;
  rest.splice(at, 0, slug);
  return rest;
}

// The size a corner drag lands on, true to the board's format (design_formats.resize).
export function sizeFor(info, w, h) {
  if (info.grows) return { w: info.w, h: Math.max(600, Math.min(8000, Math.round(h)), info.content_h || 0) };
  if (info.ratio) {
    let nw = w, nh = h;
    if (Math.abs(w - info.w) / info.w >= Math.abs(h - info.h) / info.h) nh = w / info.ratio; else nw = h * info.ratio;
    let scale = Math.min(1, 4000 / nw, 8000 / nh); scale = Math.max(scale, 60 / Math.min(nw, nh));
    return { w: Math.round(nw * scale), h: Math.round(nh * scale) };
  }
  return { w: Math.max(120, Math.min(4000, Math.round(w))), h: Math.max(120, Math.min(8000, Math.round(h))) };
}
const boardUrl = (id, slug, extra = '') => `/api/designs/${encodeURIComponent(id)}/boards/${encodeURIComponent(slug)}/render${extra}`;

export function mountDesignCanvas(host, { designId, compact = false, onSelection = null, onComments = null, onOpenChat = null, onLoaded = null } = {}) {
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  let design = null, comments = [], versions = [], renderAvailable = false;
  let mode = 'pan', zoom = 1, tx = 40, ty = 80, preview = null, autoFit = true; // autoFit: refit on resize until the person moves the view // preview: {n, manifest} while viewing an old version
  let selected = null, picked = { board: null, ids: [], labels: [], point: null };
  let focus = null, flash = new Map(), view = mobileOn() ? 'list' : 'canvas';
  const frames = new Map();      // contentWindow -> slug
  const boardNodes = new Map();  // slug -> {wrap, body, iframe, img, title}
  const stamp = new Map();       // slug -> cache key, bumped when the board changes
  let paintFrame = 0, liveFrame = 0;

  const root = el('section', { class: `design-canvas${compact ? ' design-canvas-compact' : ''}`, tabindex: '0', 'aria-label': 'Design canvas', 'data-mode': mode });
  const titleNode = el('h2', { class: 'design-title', text: 'Loading design' });
  const modeGroup = el('div', { class: 'design-modes', role: 'group', 'aria-label': 'Canvas mode' });
  const modeButtons = new Map();
  for (const [id, label, tip] of MODES) {
    const b = el('button', { type: 'button', class: 'btn quiet design-mode', text: label, title: tip, 'aria-pressed': String(id === mode), onclick: () => setMode(id) });
    modeButtons.set(id, b); modeGroup.append(b);
  }
  const zoomLabel = el('button', { type: 'button', class: 'btn quiet design-zoom', text: '100%', title: 'Reset zoom to 100% (0)', onclick: () => zoomTo(1) });
  const fitBtn = el('button', { type: 'button', class: 'btn quiet', text: 'Fit', title: 'Fit all boards (Shift+1)', onclick: () => fitAll() });
  const focusBtn = el('button', { type: 'button', class: 'btn quiet', text: 'Focus', title: 'Open the selected board at real size (F)', onclick: () => openFocus(selected || order()[0]) });
  const panelBtns = {};
  for (const [id, label] of [['tokens', 'Tokens'], ['versions', 'Versions'], ['comments', 'Comments']]) {
    panelBtns[id] = el('button', { type: 'button', class: 'btn quiet', text: label, 'aria-pressed': 'false', 'aria-controls': `design-panel-${designId}`, onclick: () => togglePanel(id) });
  }
  const exportBtn = el('button', { type: 'button', class: 'btn quiet', text: 'Export', 'aria-haspopup': 'menu', onclick: () => openExport(exportBtn) });
  const addBtn = el('button', { type: 'button', class: 'btn quiet', text: 'Add board', 'aria-haspopup': 'menu', onclick: () => addBoard(addBtn) });
  // Designs made before formats keep their sizes until the person fits them (core/design_formats.py infer).
  const fitFormatBtn = el('button', { type: 'button', class: 'btn quiet design-fit-format', text: 'Fit to format', hidden: true, 'aria-haspopup': 'menu',
    title: 'Put boards made before formats into their nearest natural size', onclick: () => fitFormatMenu(fitFormatBtn) });
  const systemNode = el('span', { class: 'design-system-name meta', text: '' });
  const viewBtn = el('button', { type: 'button', class: 'btn quiet design-view-toggle', text: 'Canvas', onclick: () => { chosenView = true; setView(view === 'list' ? 'canvas' : 'list'); } });
  const toolbar = el('div', { class: 'design-toolbar', role: 'toolbar', 'aria-label': 'Design tools' }, [
    el('div', { class: 'design-toolbar-start' }, [titleNode, systemNode]),
    modeGroup,
    el('div', { class: 'design-toolbar-end' }, [addBtn, fitFormatBtn, fitBtn, zoomLabel, focusBtn, panelBtns.tokens, panelBtns.versions, panelBtns.comments, exportBtn, viewBtn]),
  ]);
  const banner = el('div', { class: 'design-banner', role: 'status', hidden: true });
  const world = el('div', { class: 'design-world' });
  const stage = el('div', { class: 'design-stage', 'aria-label': 'Boards', role: 'application' }, [world]);
  const list = el('div', { class: 'design-list', role: 'list', 'aria-label': 'Boards', hidden: true });
  const panel = el('aside', { class: 'design-panel', id: `design-panel-${designId}`, hidden: true, 'aria-label': 'Design panel' });
  const popover = el('div', { class: 'design-popover', role: 'dialog', 'aria-label': 'Comment', hidden: true });
  const status = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  root.append(toolbar, banner, el('div', { class: 'design-body' }, [stage, list, panel]), popover, status);
  host.append(root);

  // -- data ---------------------------------------------------------------------
  const manifest = () => preview?.manifest || design;
  const order = () => Object.entries(manifest()?.boards || {}).sort((a, b) => (a[1].order || 0) - (b[1].order || 0)).map(([slug]) => slug);
  const src = (slug, extra = '') => boardUrl(designId, slug, `?k=${stamp.get(slug) || 0}${preview ? `&v=${preview.n}` : ''}${extra}`);

  async function load(first = false) {
    const data = await api(`/api/designs/${encodeURIComponent(designId)}`, { signal });
    if (signal.aborted) return;
    design = data; comments = data.comments || []; renderAvailable = !!data.render_available;
    titleNode.textContent = data.title; systemNode.textContent = data.system?.name ? `System: ${data.system.name}` : '';
    panelBtns.comments.textContent = openComments().length ? `Comments (${openComments().length})` : 'Comments';
    for (const slug of order()) if (!stamp.has(slug)) stamp.set(slug, data.version);
    build();
    if (first) { view === 'list' ? paintList() : requestAnimationFrame(() => fitAll(false)); onLoaded?.(data); }
    if (panel.dataset.kind) renderPanel(panel.dataset.kind);
    return data;
  }
  const openComments = () => comments.filter(c => c.status !== 'resolved');

  // -- layout -------------------------------------------------------------------
  function build() {
    const data = manifest();
    const keep = new Set(Object.keys(data.boards));
    for (const [slug, node] of boardNodes) if (!keep.has(slug)) { node.wrap.remove(); boardNodes.delete(slug); }
    for (const [slug, info] of Object.entries(data.boards)) {
      let node = boardNodes.get(slug);
      if (!node) node = makeBoard(slug);
      const [top, side, bottom] = CHROME[info.frame] || CHROME.none;
      Object.assign(node.wrap.style, { left: `${info.x}px`, top: `${info.y}px`, width: `${info.w}px`, height: `${info.h}px` });
      node.wrap.dataset.frame = info.frame;
      node.chrome.style.inset = `-${top}px -${side}px -${bottom}px -${side}px`;
      node.title.style.bottom = `calc(100% + ${top}px + min(6px / var(--design-zoom, 1), 20px))`;
      node.name.textContent = info.title;
      node.meta.textContent = sizeText(info);
      node.address.textContent = info.title;
      node.wrap.dataset.format = info.format || 'none';
      node.wrap.setAttribute('aria-label', `${info.title}, ${sizeText(info)}`);
      node.wrap.classList.toggle('selected', slug === selected);
      node.wrap.classList.remove('design-lifted');
    }
    delete root.dataset.dropOrder;
    world.querySelectorAll('.design-note').forEach(n => n.remove());
    for (const note of data.notes || []) {
      world.append(el('div', { class: `design-note design-note-${note.kind || 'label'}`, text: note.text, style: `left:${note.x}px;top:${note.y}px` }));
    }
    paintSections();
    paintPins();
    fitFormatBtn.hidden = preview || !Object.values(data.boards).some(b => !b.format);
    schedule();
    if (view === 'list') paintList();
  }

  // Each format's row gets a label at its left ("Website · Desktop").
  function paintSections(boards = manifest().boards, positions = null) {
    world.querySelectorAll('.design-section-label').forEach(n => n.remove());
    const data = manifest();
    if (data.layout !== 'auto' && !positions) return;
    const labels = Object.fromEntries((data.sections || []).map(section => [section.key, section.label]));
    const rows = new Map();
    for (const slug of order()) {
      const b = boards[slug]; if (!b) continue;
      const at = positions?.[slug] || b, [top, side] = CHROME[b.frame] || CHROME.none;
      const row = rows.get(b.section) || { x: Infinity, y: Infinity, label: labels[b.section] || b.format_label || 'Custom' };
      row.x = Math.min(row.x, at.x - side); row.y = Math.min(row.y, at.y - top); rows.set(b.section, row);
    }
    // Left of the row, on its board titles' line: no height to find between rows at any zoom.
    for (const row of rows.values()) world.append(el('div', { class: 'design-section-label', text: row.label, style: `left:${row.x}px;top:${row.y}px` }));
  }

  function makeBoard(slug) {
    const name = el('strong', { class: 'design-board-name' });
    const meta = el('span', { class: 'design-board-meta' });
    const title = el('div', { class: 'design-board-title', title: 'Drag to move. Double-click to zoom to this board.' }, [name, meta]);
    const address = el('span', { class: 'design-address' });
    const chrome = el('div', { class: 'design-chrome', 'aria-hidden': 'true' }, [
      el('span', { class: 'design-status-bar' }, [el('span', { text: '9:41' }), el('span', { class: 'design-status-icons' })]),
      el('span', { class: 'design-browser-bar' }, [el('span', { class: 'design-dots' }), address]),
      el('span', { class: 'design-home-indicator' }),
    ]);
    const body = el('div', { class: 'design-board-body' });
    const shield = el('div', { class: 'design-shield' });
    // A board showing its thumbnail in Select, Comment or Text: bring it close, live.
    body.addEventListener('click', () => { if (mode !== 'pan' && !boardNodes.get(slug)?.iframe) zoomToBoard(slug); });
    const handle = el('div', { class: 'design-resize', title: 'Drag to resize this board', 'aria-hidden': 'true' });
    const wrap = el('div', { class: 'design-board', 'data-slug': slug, role: 'group' }, [chrome, title, body, shield, handle]);
    const node = { wrap, body, title, name, meta, chrome, address, iframe: null, img: null, live: false };
    title.addEventListener('pointerdown', event => startBoardDrag(event, slug, 'move'));
    handle.addEventListener('pointerdown', event => startBoardDrag(event, slug, 'resize'));
    title.addEventListener('dblclick', () => zoomToBoard(slug));
    shield.addEventListener('dblclick', () => openFocus(slug));
    shield.addEventListener('click', () => selectBoard(slug));
    boardNodes.set(slug, node); world.append(wrap);
    return node;
  }

  function applyTransform() {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    root.style.setProperty('--design-zoom', zoom);
    // Below these zooms a label would be under 8px (row labels) or 7px (titles) on screen.
    root.dataset.zoomTier = zoom < 0.06 ? 'tiny' : zoom < 0.08 ? 'small' : 'normal';
    schedule();
  }
  function schedule() { cancelAnimationFrame(liveFrame); liveFrame = requestAnimationFrame(updateLive); }

  // Only boards in view (plus a ring) are live frames, and none below 35%:
  // the rest show a cached thumbnail, so a 40-board design stays responsive.
  function updateLive() {
    if (!design || view !== 'canvas') return;
    const rect = stage.getBoundingClientRect();
    const ringX = rect.width / zoom * 0.5, ringY = rect.height / zoom * 0.5;
    const view0 = { x1: -tx / zoom - ringX, y1: -ty / zoom - ringY, x2: (rect.width - tx) / zoom + ringX, y2: (rect.height - ty) / zoom + ringY };
    const cx = (view0.x1 + view0.x2) / 2, cy = (view0.y1 + view0.y2) / 2;
    const data = manifest();
    // With no thumbnails (no desktop render window), a small design stays live at any zoom.
    // Select, Comment and Text work on live boards only, so in those modes every
    // board in view (nearest first, up to 16) is live whatever the zoom: a tall
    // website board never fits at 35%, and used to stay a picture.
    const thumbsOnly = mode === 'pan' && zoom < LIVE_ZOOM && (renderAvailable || Object.keys(data.boards).length > MAX_LIVE);
    const candidates = thumbsOnly ? [] : Object.entries(data.boards)
      .filter(([, b]) => b.x < view0.x2 && b.x + b.w > view0.x1 && b.y < view0.y2 && b.y + b.h > view0.y1)
      .sort((a, b) => Math.hypot(a[1].x + a[1].w / 2 - cx, a[1].y + a[1].h / 2 - cy) - Math.hypot(b[1].x + b[1].w / 2 - cx, b[1].y + b[1].h / 2 - cy))
      .slice(0, MAX_LIVE).map(([slug]) => slug);
    const live = new Set(candidates);
    for (const [slug, node] of boardNodes) setLive(slug, node, live.has(slug));
    root.dataset.live = String(live.size);
  }

  function setLive(slug, node, on) {
    const wanted = on ? src(slug) : null;
    if (on) {
      node.img?.remove(); node.img = null; node.placeholder?.remove(); node.placeholder = null;
      if (!node.iframe) {
        node.iframe = el('iframe', { sandbox: 'allow-scripts', title: `Board ${manifest().boards[slug]?.title || slug}`, referrerpolicy: 'no-referrer', loading: 'eager', tabindex: '-1' });
        node.iframe.addEventListener('load', () => { frames.set(node.iframe.contentWindow, slug); });
        node.body.append(node.iframe);
      }
      if (node.iframe.dataset.src !== wanted) { node.iframe.dataset.src = wanted; node.iframe.src = wanted; }
      return;
    }
    if (node.iframe) { frames.delete(node.iframe.contentWindow); node.iframe.remove(); node.iframe = null; }
    const key = `${stamp.get(slug) || 0}`;
    if (renderAvailable && !preview) {
      if (!node.img || node.img.dataset.key !== key) {
        node.placeholder?.remove(); node.placeholder = null;
        node.img?.remove();
        node.img = el('img', { class: 'design-thumb', alt: '', loading: 'lazy', src: `/api/designs/${designId}/boards/${slug}/thumb?k=${key}` });
        node.img.dataset.key = key;
        node.img.addEventListener('error', () => { node.img?.remove(); node.img = null; placeholder(slug, node); });
        node.body.append(node.img);
      }
    } else placeholder(slug, node);
  }
  function placeholder(slug, node) {
    if (node.placeholder) return;
    const info = manifest().boards[slug];
    node.placeholder = el('div', { class: 'design-placeholder' }, [el('strong', { text: info?.title || slug }), el('span', { text: 'Zoom in to see this board' })]);
    node.body.append(node.placeholder);
  }

  // -- pan and zoom ----------------------------------------------------------------
  function zoomAt(next, cx, cy) {
    autoFit = false;
    next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    const wx = (cx - tx) / zoom, wy = (cy - ty) / zoom;
    zoom = next; tx = cx - wx * zoom; ty = cy - wy * zoom; applyTransform();
  }
  function zoomTo(next) { const r = stage.getBoundingClientRect(); zoomAt(next, r.width / 2, r.height / 2); }
  function bounds(slugs = order()) {
    const data = manifest();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const slug of slugs) {
      const b = data.boards[slug]; if (!b) continue;
      const [top, side, bottom] = CHROME[b.frame] || CHROME.none;
      x1 = Math.min(x1, b.x - side); y1 = Math.min(y1, b.y - top - TITLE_GAP); x2 = Math.max(x2, b.x + b.w + side); y2 = Math.max(y2, b.y + b.h + bottom);
    }
    for (const note of slugs.length === order().length ? data.notes || [] : []) { x1 = Math.min(x1, note.x); y1 = Math.min(y1, note.y); }
    return Number.isFinite(x1) ? { x1, y1, x2, y2 } : { x1: 0, y1: 0, x2: 800, y2: 600 };
  }
  function fitRect(b, pad = 48, animate = true) {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // The row labels sit left of each row (paintSections): keep room for them.
    const left = manifest()?.layout === 'auto' && !compact ? Math.min(180, r.width * 0.2) : pad;
    const next = Math.max(MIN_ZOOM, Math.min(1, (r.width - pad - left) / (b.x2 - b.x1), (r.height - pad * 2) / (b.y2 - b.y1)));
    zoom = next; tx = left + (r.width - pad - left - (b.x2 - b.x1) * zoom) / 2 - b.x1 * zoom; ty = (r.height - (b.y2 - b.y1) * zoom) / 2 - b.y1 * zoom;
    world.classList.toggle('design-animate', animate && !reduced.matches);
    applyTransform();
    setTimeout(() => world.classList.remove('design-animate'), 260);
  }
  function fitAll(animate = true) { fitRect(bounds(), 48, animate); autoFit = true; }
  function zoomToBoard(slug) { selectBoard(slug); fitRect(bounds([slug]), 32); autoFit = false; }

  stage.addEventListener('wheel', event => {
    event.preventDefault();
    wheel(event.deltaX, event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey, event.clientX, event.clientY);
  }, { passive: false, signal });
  function wheel(dx, dy, unit, ctrl, clientX, clientY) {
    const r = stage.getBoundingClientRect();
    const scale = unit === 1 ? 16 : unit === 2 ? r.height : 1;
    if (ctrl) zoomAt(zoom * Math.exp(-dy * scale * 0.0025), clientX - r.left, clientY - r.top);
    else { autoFit = false; tx -= dx * scale; ty -= dy * scale; applyTransform(); }
  }

  // Drag the empty canvas (any mode), Space+drag or middle-drag anywhere: pan.
  // Two fingers: pinch to zoom.
  let space = false, panning = null;
  const pointers = new Map();
  stage.addEventListener('pointerdown', event => {
    const onBoard = event.target.closest('.design-board');
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) { panning = { pinch: pinchState() }; return; }
    if (event.button === 1 || space || !onBoard || (mode === 'pan' && event.target.classList.contains('design-shield') && event.pointerType !== 'mouse')) {
      event.preventDefault();
      panning = { x: event.clientX, y: event.clientY, tx, ty, moved: false };
      try { stage.setPointerCapture(event.pointerId); } catch { /* A synthetic or ended pointer. */ }
      root.classList.add('design-panning');
    } else if (mode === 'pan' && event.target.classList.contains('design-shield') && event.button === 0) {
      panning = { x: event.clientX, y: event.clientY, tx, ty, moved: false, board: onBoard.dataset.slug };
      try { stage.setPointerCapture(event.pointerId); } catch { /* A synthetic or ended pointer. */ }
    }
  }, { signal });
  stage.addEventListener('pointermove', event => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!panning) return;
    if (panning.pinch && pointers.size === 2) {
      const now = pinchState(), r = stage.getBoundingClientRect();
      zoomAt(panning.pinch.zoom * now.dist / panning.pinch.dist, now.cx - r.left, now.cy - r.top);
      tx += now.cx - panning.pinch.cx; ty += now.cy - panning.pinch.cy; panning.pinch.cx = now.cx; panning.pinch.cy = now.cy; applyTransform();
      return;
    }
    if (panning.x === undefined) return;
    const dx = event.clientX - panning.x, dy = event.clientY - panning.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) panning.moved = true;
    if (panning.moved) { autoFit = false; tx = panning.tx + dx; ty = panning.ty + dy; applyTransform(); }
  }, { signal });
  const endPan = event => {
    pointers.delete(event.pointerId);
    if (panning && !panning.moved && panning.board) selectBoard(panning.board);
    else if (panning && !panning.moved && !panning.pinch && !event.target.closest?.('.design-board')) selectBoard(null);
    panning = null; root.classList.remove('design-panning');
  };
  stage.addEventListener('pointerup', endPan, { signal });
  stage.addEventListener('pointercancel', endPan, { signal });
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom };
  }

  // Whole boards move (title bar) and resize (corner), on the row layout: the
  // board follows the pointer while its neighbours make room; a resize stays
  // true to the format and pushes the row along and the rows below down.
  // Each drop is a version; a design from before formats joins the row layout.
  function startBoardDrag(event, slug, kind) {
    if (event.button !== 0 || preview) return;
    event.preventDefault(); event.stopPropagation();
    const info = manifest().boards[slug], node = boardNodes.get(slug);
    const start = { x: event.clientX, y: event.clientY, bx: info.x, by: info.y, bw: info.w, bh: info.h };
    const target = event.currentTarget; try { target.setPointerCapture(event.pointerId); } catch { /* A synthetic or ended pointer. */ }
    root.classList.add('design-dragging'); selectBoard(slug);
    world.classList.toggle('design-reflowing', !reduced.matches);
    let current = { x: info.x, y: info.y, w: info.w, h: info.h }, moved = false;
    const move = e => {
      const dx = (e.clientX - start.x) / zoom, dy = (e.clientY - start.y) / zoom;
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 2) moved = true;
      if (!moved) return;
      if (kind === 'move') current = { ...current, x: Math.round(start.bx + dx), y: Math.round(start.by + dy) };
      else current = { ...current, ...sizeFor(info, start.bw + dx, start.bh + dy) };
      previewLayout(slug, kind, current, node);
    };
    const up = async () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
      root.classList.remove('design-dragging');
      if (!moved) { world.classList.remove('design-reflowing'); return; }
      const body = kind === 'move' ? { action: 'move', board: slug, x: current.x, y: current.y, reflow: true }
        : { action: 'resize', board: slug, w: current.w, h: current.h, reflow: true };
      try {
        const result = await api(`/api/designs/${designId}/board-action`, { method: 'POST', body: JSON.stringify(body) });
        design = { ...design, ...result.design };
        if (kind === 'resize') stamp.set(slug, (stamp.get(slug) || 0) + 1);
        status.textContent = result.message || '';
      } catch { /* api shows the error; the layout goes back. */ }
      build();
      setTimeout(() => world.classList.remove('design-reflowing'), 260);
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }
  // Where every board would sit with this drag or resize, drawn live.
  function previewLayout(slug, kind, current, node) {
    const boards = Object.fromEntries(Object.entries(manifest().boards).map(([name, b]) => [name, { ...b }]));
    boards[slug].w = current.w; boards[slug].h = current.h;
    const ord = kind === 'move' ? orderAfterDrop(boards, order(), slug, current.x) : order();
    const positions = layoutRows(boards, ord);
    for (const [name, at] of Object.entries(positions)) {
      const wrap = boardNodes.get(name)?.wrap; if (!wrap || name === slug) continue;
      wrap.style.left = `${at.x}px`; wrap.style.top = `${at.y}px`;
    }
    if (kind === 'move') { node.wrap.style.left = `${current.x}px`; node.wrap.style.top = `${current.y}px`; }
    else Object.assign(node.wrap.style, { left: `${positions[slug].x}px`, top: `${positions[slug].y}px`, width: `${current.w}px`, height: `${current.h}px` });
    node.wrap.classList.add('design-lifted');
    paintSections(boards, positions);
    world.querySelectorAll('.design-pin').forEach(n => n.remove());
    root.dataset.dropOrder = ord.join(',');
  }

  function selectBoard(slug) {
    selected = slug;
    for (const [name, node] of boardNodes) node.wrap.classList.toggle('selected', name === slug);
    focusBtn.disabled = !order().length;
    if (slug) status.textContent = `${manifest().boards[slug]?.title} selected`;
  }

  // -- keyboard ----------------------------------------------------------------
  root.addEventListener('keydown', event => {
    if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
    keyCommand(event.key, event.ctrlKey || event.metaKey, event.shiftKey, event);
  }, { signal });
  function keyCommand(key, ctrl, shift, event = null) {
    const stop = () => event?.preventDefault();
    if (key === ' ' && !ctrl) { space = true; root.classList.add('design-space'); stop(); return; }
    if (ctrl && key.toLowerCase() === 'z') { stop(); undo(); return; }
    if (ctrl) return;
    if (shift && (key === '!' || key === '1')) { stop(); fitAll(); }
    else if (key === '+' || key === '=') { stop(); zoomTo(zoom * 1.25); }
    else if (key === '-' || key === '_') { stop(); zoomTo(zoom / 1.25); }
    else if (key === '0') { stop(); zoomTo(1); }
    else if (key === 'Escape') { if (focus) { stop(); closeFocus(); } else if (!popover.hidden) { stop(); popover.hidden = true; } else if (mode !== 'pan') { stop(); setMode('pan'); } }
    else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(key)) {
      stop();
      const all = order(); if (!all.length) return;
      const at = all.indexOf(selected);
      const next = all[(at < 0 ? 0 : at + (key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
      if (focus) openFocus(next); else zoomToBoard(next);
    }
    else if (key === 'Enter' && selected && !focus) { stop(); openFocus(selected); }
    else if (key.toLowerCase() === 'f' && !focus) { stop(); openFocus(selected || order()[0]); }
    else if ('hsct'.includes(key.toLowerCase()) && key.length === 1) { stop(); setMode({ h: 'pan', s: 'select', c: 'comment', t: 'text' }[key.toLowerCase()]); }
  }
  document.addEventListener('keyup', event => { if (event.key === ' ') { space = false; root.classList.remove('design-space'); } }, { signal });

  // -- modes and the viewer --------------------------------------------------------
  function setMode(next) {
    if (preview && next !== 'pan') { toast('Return to the current version to edit.'); return; }
    mode = next; root.dataset.mode = mode;
    for (const [id, b] of modeButtons) b.setAttribute('aria-pressed', String(id === mode));
    if (mode !== 'select') clearPicked(false);
    popover.hidden = true;
    broadcast();
    schedule();
  }
  const viewerMode = () => ({ pan: 'browse', select: 'select', comment: 'comment', text: 'text' })[mode];
  function post(win, message) { try { win.postMessage(message, '*'); } catch { /* A frame that is gone. */ } }
  function marksFor(slug) {
    return { type: 'kd-marks', picked: picked.board === slug ? picked.ids : [],
      commented: openComments().filter(c => c.board === slug && c.status === 'open').flatMap(c => c.element_ids || []),
      changed: flash.get(slug) || [] };
  }
  function broadcast() {
    for (const [win, slug] of frames) { post(win, { type: 'kd-mode', mode: viewerMode() }); post(win, marksFor(slug)); }
    if (focus?.frame?.contentWindow && !focus.compare) { post(focus.frame.contentWindow, { type: 'kd-mode', mode: 'browse', scroll: true }); post(focus.frame.contentWindow, marksFor(focus.slug)); }
  }
  function frameFor(win) {
    if (focus?.frame?.contentWindow === win) return { slug: focus.slug, frame: focus.frame, focus: true };
    if (focus?.overlayFrame?.contentWindow === win) return { slug: focus.overlaySlug, frame: focus.overlayFrame, focus: true };
    if (focus?.compare?.contentWindow === win) return null;
    const slug = frames.get(win);
    if (!slug) {
      // A frame's load event can trail its first message: match it directly.
      for (const [name, node] of boardNodes) if (node.iframe?.contentWindow === win) { frames.set(win, name); return { slug: name, frame: node.iframe }; }
      return null;
    }
    return { slug, frame: boardNodes.get(slug)?.iframe };
  }
  window.addEventListener('message', event => {
    const source = frameFor(event.source);
    if (!source || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    // Focus is for click-through: its boards are always in browse mode.
    if (data.type === 'kd-ready') { post(event.source, { type: 'kd-mode', mode: source.focus ? 'browse' : viewerMode(), scroll: !!source.focus }); post(event.source, marksFor(source.slug)); if (tokenDraft.size) post(event.source, { type: 'kd-tokens', css: draftCss() }); }
    else if (data.type === 'kd-wheel' && !source.focus) {
      const r = source.frame.getBoundingClientRect(), s = r.width / source.frame.offsetWidth || zoom;
      wheel(Number(data.dx) || 0, Number(data.dy) || 0, Number(data.unit) || 0, !!data.ctrl, r.left + (Number(data.x) || 0) * s, r.top + (Number(data.y) || 0) * s);
    }
    else if (data.type === 'kd-size' && !source.focus) measured(source.slug, Number(data.height));
    else if (data.type === 'kd-pick') pick(source.slug, data, source);
    else if (data.type === 'kd-text') saveText(source.slug, String(data.id || ''), String(data.text ?? ''));
    else if (data.type === 'kd-goto') gotoBoard(String(data.board || ''), !!data.overlay, source);
    else if (data.type === 'kd-key') keyCommand(String(data.key || ''), !!data.ctrl, !!data.shift);
  }, { signal });

  // A website or email board as tall as its page: no version, the rows below move.
  const sizing = new Map();
  function measured(slug, height) {
    const info = design?.boards?.[slug];
    if (!info?.grows || preview || !Number.isFinite(height) || height < 60) return;
    const want = Math.max(info.min_h || 0, Math.min(8000, Math.round(height)));
    if (Math.abs(want - info.h) <= 2) return;
    clearTimeout(sizing.get(slug));
    sizing.set(slug, setTimeout(async () => {
      try {
        const result = await api(`/api/designs/${designId}/boards/${encodeURIComponent(slug)}/fit-height`, { method: 'POST', body: JSON.stringify({ h: Math.round(height) }), toast: false });
        design = { ...design, ...result.design }; build();
      } catch { /* The next measure tries again. */ }
    }, 250));
  }

  function pick(slug, data, source) {
    const element = data.element && /^[a-z][a-z0-9-]{0,31}$/.test(data.element.id || '') ? data.element : null;
    const point = data.point && Number.isFinite(+data.point.x) && Number.isFinite(+data.point.y) ? { x: +(+data.point.x).toFixed(4), y: +(+data.point.y).toFixed(4) } : null;
    if (mode === 'select') {
      if (!element) return;
      if (picked.board !== slug || !data.additive) picked = { board: slug, ids: [], labels: [], point };
      const at = picked.ids.indexOf(element.id);
      if (at >= 0 && data.additive) { picked.ids.splice(at, 1); picked.labels.splice(at, 1); }
      else if (at < 0) { picked.ids.push(element.id); picked.labels.push(element.text ? `${element.id} "${element.text.slice(0, 24)}"` : `${element.id} <${element.tag}>`); }
      picked.ids = picked.ids.slice(0, 20);
      broadcast();
      announceSelection();
    } else if (mode === 'comment') {
      // Shift-click adds elements to the comment being written.
      if (data.additive && commentDraft && commentDraft.slug === slug && element) {
        if (!commentDraft.ids.includes(element.id)) commentDraft.ids.push(element.id);
        commentDraft.where.textContent = `${manifest().boards[slug]?.title}: ${commentDraft.ids.join(', ')}`;
        picked = { board: slug, ids: [...commentDraft.ids], labels: [], point }; broadcast();
        return;
      }
      openCommentBox(slug, element, point, source);
    }
  }
  let lastChip = null;
  function announceSelection() {
    const info = manifest().boards[picked.board];
    const item = picked.ids.length ? { kind: 'design_comment', design_id: designId, board: picked.board, element_ids: [...picked.ids], point: null, comment: '',
      label: `${info?.title || picked.board} · ${picked.ids.length === 1 ? picked.labels[0] : `${picked.ids.length} elements`}` } : null;
    const previous = lastChip; lastChip = item;
    status.textContent = item ? `${item.label} selected. Type what to change.` : 'Selection cleared';
    onSelection?.(item, previous);
  }
  function clearPicked(notify = true) {
    if (!picked.ids.length) return;
    picked = { board: null, ids: [], labels: [], point: null }; broadcast();
    if (notify) announceSelection(); else lastChip = null;
  }

  async function saveText(slug, id, text) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return;
    try { await api(`/api/designs/${designId}/boards/${slug}/text`, { method: 'POST', body: JSON.stringify({ id, text }) }); toast('Text saved', 'success'); }
    catch { reloadBoards([slug]); }
  }

  // Click-through: on the canvas, go to the board; in Focus, open it there.
  function gotoBoard(target, overlay, source) {
    const all = order();
    if (target === 'back') { if (focus?.history.length) openFocus(focus.history.pop(), { back: true }); return; }
    const slug = all.includes(target) ? target : all.find(s => manifest().boards[s].title.toLowerCase() === target.toLowerCase());
    if (!slug) { toast(`No board "${target}" in this design`); return; }
    if (source?.focus) { overlay ? openOverlay(slug) : openFocus(slug); return; }
    zoomToBoard(slug);
  }

  // -- comments (pins) ----------------------------------------------------------------
  let commentDraft = null;
  function openCommentBox(slug, element, point, source) {
    const input = el('textarea', { rows: '3', maxlength: '4000', placeholder: 'Comment', 'aria-label': 'Comment' });
    const save = el('button', { type: 'button', class: 'btn primary', text: 'Pin comment' });
    const cancel = el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => { popover.hidden = true; sheet?.close?.(); } });
    const where = element ? `${element.id} <${element.tag}>${element.text ? ` "${element.text.slice(0, 30)}"` : ''}` : 'This spot on the board';
    const whereNode = el('p', { class: 'meta', text: `${manifest().boards[slug]?.title}: ${where}` });
    const form = el('div', { class: 'design-comment-form' }, [whereNode, el('p', { class: 'meta', text: 'Shift-click to add more elements.' }), input,
      el('div', { class: 'design-row' }, [cancel, save])]);
    commentDraft = { slug, ids: element ? [element.id] : [], where: whereNode };
    let sheet = null;
    save.onclick = async () => {
      if (!input.value.trim()) { input.focus(); return; }
      save.disabled = true;
      try {
        const comment = await api(`/api/designs/${designId}/comments`, { method: 'POST', body: JSON.stringify({ board: slug, element_ids: commentDraft?.slug === slug ? commentDraft.ids : element ? [element.id] : [], point, text: input.value.trim() }) });
        commentDraft = null; picked = { board: null, ids: [], labels: [], point: null };
        comments.push(comment); popover.hidden = true; sheet?.close?.(); paintPins(); broadcast();
        panelBtns.comments.textContent = `Comments (${openComments().length})`;
        if (panel.dataset.kind === 'comments') renderPanel('comments');
        toast('Comment pinned', 'success');
      } catch { save.disabled = false; }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click(); });
    if (mobileOn()) { sheet = openMobileSheet({ title: 'Comment', content: form }); sheet && setTimeout(() => input.focus(), 50); if (sheet) return; }
    popover.replaceChildren(form); popover.hidden = false;
    const frame = source.frame?.getBoundingClientRect(), r = root.getBoundingClientRect();
    if (frame && point) {
      popover.style.left = `${Math.max(8, Math.min(r.width - 300, frame.left - r.left + point.x * frame.width + 12))}px`;
      popover.style.top = `${Math.max(48, Math.min(r.height - 200, frame.top - r.top + point.y * frame.height + 12))}px`;
    }
    input.focus();
  }
  function paintPins() {
    world.querySelectorAll('.design-pin').forEach(n => n.remove());
    if (preview) return;
    openComments().forEach((comment, index) => {
      const board = design?.boards[comment.board]; if (!board || !comment.point) return;
      const pin = el('button', { type: 'button', class: `design-pin design-pin-${comment.status}`, text: String(index + 1),
        title: `${comment.text}${comment.status === 'addressed' ? ` (addressed in v${comment.addressed_in})` : ''}`,
        'aria-label': `Comment ${index + 1}: ${comment.text}`, style: `left:${board.x + comment.point.x * board.w}px;top:${board.y + comment.point.y * board.h}px`,
        onclick: () => { togglePanel('comments', true); panel.querySelector(`[data-comment="${comment.id}"]`)?.scrollIntoView({ block: 'nearest' }); } });
      world.append(pin);
    });
  }

  // -- focus mode (real size, clickable) ---------------------------------------------
  const WIDTHS = [['Desktop', 1280], ['Tablet', 820], ['Phone', 390]];
  function openFocus(slug, { back = false } = {}) {
    if (!slug || !manifest().boards[slug]) return;
    const info = manifest().boards[slug];
    const history = focus?.history || [];
    if (focus && !back && focus.slug !== slug) history.push(focus.slug);
    closeFocus(true);
    selectBoard(slug);
    const all = order(), at = all.indexOf(slug);
    const frame = el('iframe', { sandbox: 'allow-scripts', title: `Board ${info.title}`, referrerpolicy: 'no-referrer', src: src(slug) });
    const device = el('div', { class: 'design-focus-device', 'data-frame': info.frame }, [frame]);
    const widths = el('span', { class: 'design-focus-widths', role: 'group', 'aria-label': 'Width', hidden: !['browser', 'none'].includes(info.frame) });
    let width = info.w;
    for (const [label, value] of WIDTHS) {
      const b = el('button', { type: 'button', class: 'btn quiet', text: label, 'aria-pressed': 'false', onclick: () => { width = value; [...widths.children].forEach(n => n.setAttribute('aria-pressed', String(n === b))); frame.src = src(slug, `&w=${value}`); fit(); } });
      widths.append(b);
    }
    const prev = el('button', { type: 'button', class: 'btn quiet', text: 'Previous', disabled: all.length < 2, onclick: () => openFocus(all[(at - 1 + all.length) % all.length]) });
    const next = el('button', { type: 'button', class: 'btn quiet', text: 'Next', disabled: all.length < 2, onclick: () => openFocus(all[(at + 1) % all.length]) });
    const close = el('button', { type: 'button', class: 'btn quiet', text: 'Close', 'aria-label': 'Close focus', onclick: () => closeFocus() });
    const stageFocus = el('div', { class: 'design-focus-stage' }, [device]);
    const overlay = el('div', { class: 'design-focus', role: 'dialog', 'aria-label': `${info.title}, focus` }, [
      el('header', { class: 'design-focus-bar' }, [el('strong', { text: `${at + 1} / ${all.length} · ${info.title}` }), widths, el('span', { class: 'design-spacer' }), prev, next, close]),
      stageFocus]);
    root.append(overlay);
    const fit = () => {
      const r = stageFocus.getBoundingClientRect();
      const pad = info.frame === 'phone' ? 64 : 32;
      const w = width, h = info.h, scale = Math.min(1, (r.width - pad) / w, mobileOn() ? 10 : (r.height - pad) / h);
      Object.assign(frame.style, { width: `${w}px`, height: `${h}px`, transform: `scale(${scale})` });
      Object.assign(device.style, { width: `${w * scale}px`, height: `${h * scale}px` });
    };
    const observer = new ResizeObserver(fit); observer.observe(stageFocus);
    focus = { slug, frame, overlay, observer, history, pager: mobileOn() ? swipe(stageFocus, d => openFocus(all[(at + d + all.length) % all.length])) : null };
    requestAnimationFrame(fit);
    close.focus({ preventScroll: true });
  }
  function openOverlay(slug) {
    if (!focus) return;
    focus.overlayNode?.remove();
    const info = manifest().boards[slug];
    const frame = el('iframe', { sandbox: 'allow-scripts', title: `Overlay ${info.title}`, src: src(slug), style: `width:${info.w}px;height:${info.h}px` });
    const node = el('div', { class: 'design-focus-overlay', role: 'dialog', 'aria-label': `${info.title} overlay` }, [frame,
      el('button', { type: 'button', class: 'btn', text: 'Close overlay', onclick: () => { node.remove(); focus.overlayFrame = null; } })]);
    node.addEventListener('click', e => { if (e.target === node) { node.remove(); focus.overlayFrame = null; } });
    frame.addEventListener('load', () => post(frame.contentWindow, { type: 'kd-mode', mode: 'browse', scroll: true }));
    focus.overlaySlug = slug; focus.overlayFrame = frame; focus.overlayNode = node;
    focus.overlay.append(node);
  }
  function closeFocus(silent = false) {
    if (!focus) return;
    focus.observer.disconnect(); focus.pager?.(); focus.overlayNode?.remove(); focus.overlay?.remove();
    const was = focus.slug; focus = null;
    if (!silent) { root.focus({ preventScroll: true }); status.textContent = `Closed ${manifest().boards[was]?.title || 'board'}`; }
  }
  function swipe(target, go) {
    let start = null;
    const down = e => { if (e.isPrimary) start = { x: e.clientX, y: e.clientY }; };
    const up = e => { if (!start) return; const dx = e.clientX - start.x, dy = e.clientY - start.y; start = null; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1); };
    target.addEventListener('pointerdown', down); target.addEventListener('pointerup', up);
    return () => { target.removeEventListener('pointerdown', down); target.removeEventListener('pointerup', up); };
  }

  // -- phone: board list ----------------------------------------------------------
  function setView(next) {
    view = next; root.dataset.view = view;
    list.hidden = view !== 'list'; stage.hidden = view === 'list';
    viewBtn.textContent = view === 'list' ? 'Canvas' : 'Boards';
    viewBtn.setAttribute('aria-label', view === 'list' ? 'Show the pan and zoom canvas' : 'Show the board list');
    if (view === 'list') paintList(); else requestAnimationFrame(() => { fitAll(false); });
  }
  function paintList() {
    if (!design) return;
    const data = manifest();
    list.replaceChildren(...order().map((slug, n) => {
      const info = data.boards[slug];
      const preview_ = el('div', { class: 'design-list-preview', 'data-frame': info.frame, style: `aspect-ratio:${info.w} / ${Math.min(info.h, info.w * 2.2)}` });
      if (renderAvailable && !preview) {
        const img = el('img', { alt: '', loading: 'lazy', src: `/api/designs/${designId}/boards/${slug}/thumb?k=${stamp.get(slug) || 0}` });
        img.addEventListener('error', () => img.replaceWith(liveThumb(slug, info, preview_)));
        preview_.append(img);
      } else preview_.append(liveThumb(slug, info, preview_));
      return el('button', { type: 'button', class: 'design-list-card', role: 'listitem', 'aria-label': `Open ${info.title}`, onclick: () => openFocus(slug) }, [
        preview_, el('span', { class: 'design-list-label' }, [el('strong', { text: `${n + 1}. ${info.title}` }), el('span', { class: 'meta', text: sizeText(info) })])]);
    }));
  }
  function liveThumb(slug, info, holder) {
    const frame = el('iframe', { sandbox: 'allow-scripts', title: `Preview ${info.title}`, tabindex: '-1', loading: 'lazy', src: src(slug), style: `width:${info.w}px;height:${info.h}px` });
    const scale = () => { const w = holder.getBoundingClientRect().width; if (w) frame.style.transform = `scale(${w / info.w})`; };
    new ResizeObserver(scale).observe(holder); requestAnimationFrame(scale);
    frame.addEventListener('load', () => frames.set(frame.contentWindow, slug));
    return frame;
  }

  // -- panels: tokens, versions, comments -----------------------------------------------
  let sheet = null, sheetContent = null;
  function togglePanel(kind, force = false) {
    if (mobileOn()) {
      sheet?.close?.();
      sheetContent = el('div', { class: 'design-panel design-panel-sheet' }); panel.dataset.kind = kind; renderPanel(kind, sheetContent);
      sheet = openMobileSheet({ title: { tokens: 'Tokens', versions: 'Versions', comments: 'Comments' }[kind], content: sheetContent, fullHeight: kind !== 'tokens',
        onClose: () => { delete panel.dataset.kind; sheet = null; sheetContent = null; } });
      return;
    }
    const open = !force && panel.dataset.kind === kind ? null : kind;
    for (const [id, b] of Object.entries(panelBtns)) b.setAttribute('aria-pressed', String(id === open));
    panel.hidden = !open;
    if (open) { panel.dataset.kind = open; renderPanel(open); } else delete panel.dataset.kind;
    root.classList.toggle('design-panel-open', !!open);
    schedule();
  }
  function renderPanel(kind, target = sheetContent || panel) {
    if (kind === 'tokens') tokensPanel(target);
    else if (kind === 'versions') versionsPanel(target);
    else commentsPanel(target);
  }

  // Token knobs: live in every board with no model call; a version on save.
  const tokenDraft = new Map();
  const draftCss = () => [...tokenDraft].map(([k, v]) => `${k}: ${v};`).join('\n');
  function previewTokens() { const css = draftCss(); for (const win of frames.keys()) post(win, { type: 'kd-tokens', css }); if (focus?.frame?.contentWindow) post(focus.frame.contentWindow, { type: 'kd-tokens', css }); }
  async function tokensPanel(target) {
    const vars = design.system?.variables || {};
    const systems = await api('/api/design-systems').catch(() => []);
    const select = el('select', { 'aria-label': 'Design system' }, systems.map(s => el('option', { value: s.id, text: s.name, selected: s.id === design.design_system })));
    select.onchange = async () => { await saveTokens({ system: select.value }); };
    const rows = Object.entries(vars).filter(([k]) => !/^--ds-(font|shadow)/.test(k)).map(([name, value]) => {
      value = tokenDraft.get(name) ?? value;
      const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : null;
      const text = el('input', { type: 'text', value, 'aria-label': `${name} value`, spellcheck: 'false' });
      const set = v => { tokenDraft.set(name, v); text.value = v; previewTokens(); saveRow.hidden = false; };
      const inputs = [text];
      if (hex) { const color = el('input', { type: 'color', value: hex.toLowerCase(), 'aria-label': `${name} colour` }); color.oninput = () => set(color.value); inputs.unshift(color); }
      const px = /^(\d+)px$/.exec(value);
      if (px && !hex) { const range = el('input', { type: 'range', min: '0', max: name.includes('radius') ? '64' : '128', value: px[1], 'aria-label': `${name} size` }); range.oninput = () => set(`${range.value}px`); inputs.unshift(range); }
      text.onchange = () => set(text.value.trim());
      return el('label', { class: 'design-token-row' }, [el('span', { class: 'design-token-name', text: name.replace('--ds-', '') }), ...inputs]);
    });
    const only = el('button', { type: 'button', class: 'btn primary', text: 'This design only', onclick: () => saveTokens({ set: Object.fromEntries(tokenDraft) }) });
    const system = el('button', { type: 'button', class: 'btn quiet', text: 'Save to system', title: 'Admins: change the saved design system for every design that uses it', onclick: () => saveTokens({ set: Object.fromEntries(tokenDraft), save_to_system: true }) });
    const reset = el('button', { type: 'button', class: 'btn quiet', text: 'Discard', onclick: () => { tokenDraft.clear(); previewTokens(); tokensPanel(target); } });
    const clear = el('button', { type: 'button', class: 'btn quiet', text: 'Use system values', onclick: () => saveTokens({ clear: true }) });
    const saveRow = el('div', { class: 'design-row', hidden: !tokenDraft.size }, [reset, system, only]);
    target.replaceChildren(el('h3', { text: 'Tokens' }), el('label', { class: 'design-field' }, [el('span', { text: 'Design system' }), select]),
      el('p', { class: 'meta', text: 'Changes show in every board at once. Save to keep them as a version.' }), ...rows, saveRow,
      Object.keys(design.token_overrides || {}).length ? clear : el('span'));
  }
  async function saveTokens(body) {
    try { await api(`/api/designs/${designId}/tokens`, { method: 'POST', body: JSON.stringify(body) }); tokenDraft.clear(); toast('Tokens saved as a new version', 'success'); await reloadAll(); }
    catch { /* api shows the error. */ }
  }

  async function versionsPanel(target) {
    versions = await api(`/api/designs/${designId}/versions`).catch(() => []);
    const groups = [];
    for (const v of versions) {
      const last = groups.at(-1);
      if (last && last.by === v.by && last.session === (v.session_id || null)) last.items.push(v);
      else groups.push({ by: v.by, session: v.session_id || null, items: [v] });
    }
    const when = t => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const rows = groups.map(g => {
      const boards = [...new Set(g.items.flatMap(v => v.boards_changed || []))].map(s => design.boards[s]?.title || s);
      return el('section', { class: 'design-version-group' }, [
        el('h4', { text: `${g.by}: ${g.items.length} edit${g.items.length === 1 ? '' : 's'}${boards.length ? ` on ${boards.slice(0, 3).join(', ')}` : ''}` }),
        ...g.items.map(v => el('div', { class: `design-version${preview?.n === v.n ? ' active' : ''}`, 'data-version': String(v.n) }, [
          el('div', {}, [el('strong', { text: `v${v.n}${v.name ? ` · ${v.name}` : ''}` }), el('span', { class: 'meta', text: ` ${when(v.at)}` }),
            el('p', { class: 'meta', text: v.summary })]),
          el('div', { class: 'design-row' }, [
            el('button', { type: 'button', class: 'btn quiet', text: 'Preview', onclick: () => previewVersion(v.n) }),
            el('button', { type: 'button', class: 'btn quiet', text: 'Compare', onclick: () => compareVersion(v.n) }),
            el('button', { type: 'button', class: 'btn quiet', text: 'Restore', disabled: v.n === design.version, onclick: () => restore(v.n) }),
            el('button', { type: 'button', class: 'btn quiet', text: v.name ? 'Rename' : 'Name', onclick: event => nameVersion(v, event.currentTarget, target) }),
            el('button', { type: 'button', class: 'btn quiet', text: 'Duplicate as new design', onclick: () => duplicateAt(v.n) }),
          ])]))]);
    });
    target.replaceChildren(el('h3', { text: 'Versions' }), el('p', { class: 'meta', text: 'Every change is a version. Restoring adds a new one, so nothing is lost. Naming a version keeps it.' }), ...rows);
  }
  async function previewVersion(n) {
    const entry = await api(`/api/designs/${designId}/versions/${n}`);
    preview = { n, manifest: { ...design, ...entry.manifest } };
    banner.hidden = false;
    banner.replaceChildren(el('span', { text: `Previewing version ${n}, read only.` }),
      el('button', { type: 'button', class: 'btn quiet', text: 'Restore this version', onclick: () => restore(n) }),
      el('button', { type: 'button', class: 'btn primary', text: 'Back to current', onclick: endPreview }));
    setMode('pan'); build(); updateLive();
    if (panel.dataset.kind === 'versions') versionsPanel(sheetContent || panel);
  }
  function endPreview() { preview = null; banner.hidden = true; build(); if (panel.dataset.kind === 'versions') versionsPanel(sheetContent || panel); }
  async function restore(n) {
    try { await api(`/api/designs/${designId}/versions/${n}/restore`, { method: 'POST' }); toast(`Restored version ${n} as a new version`, 'success'); preview = null; banner.hidden = true; await reloadAll(); }
    catch { /* api shows it. */ }
  }
  // Naming a version pins it: pruning never removes it.
  function nameVersion(v, anchor, target) {
    const input = el('input', { type: 'text', maxlength: '60', value: v.name || '', placeholder: 'Approved v1', 'aria-label': `Name for version ${v.n}` });
    const save = async () => { await api(`/api/designs/${designId}/versions/${v.n}/name`, { method: 'POST', body: JSON.stringify({ name: input.value }) }).catch(() => null); versionsPanel(target); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') versionsPanel(target); });
    anchor.closest('.design-row').replaceChildren(input, el('button', { type: 'button', class: 'btn primary', text: 'Save name', onclick: save }));
    input.focus();
  }
  async function duplicateAt(n) {
    const copy = await api(`/api/designs/${designId}/duplicate`, { method: 'POST', body: JSON.stringify({ version: n }) }).catch(() => null);
    if (copy) { toast(`Created "${copy.title}"`, 'success'); document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'design', designId: copy.id } })); }
  }
  // Phase 4: a version beside the current design, one board at a time.
  async function compareVersion(n) {
    const entry = await api(`/api/designs/${designId}/versions/${n}`);
    const slugs = order().filter(s => entry.manifest.boards?.[s]);
    let slug = slugs.includes(selected) ? selected : slugs[0];
    if (!slug) { toast('That version shares no boards with the current design'); return; }
    closeFocus(true);
    const pickBoard = el('select', { 'aria-label': 'Board to compare' }, slugs.map(s => el('option', { value: s, text: design.boards[s].title, selected: s === slug })));
    const left = el('iframe', { sandbox: 'allow-scripts', title: `Version ${n}` }), right = el('iframe', { sandbox: 'allow-scripts', title: 'Current version' });
    const paneL = el('figure', { class: 'design-compare-pane' }, [el('figcaption', { text: `Version ${n}` }), left]);
    const paneR = el('figure', { class: 'design-compare-pane' }, [el('figcaption', { text: `Current (v${design.version})` }), right]);
    const show = () => {
      left.src = boardUrl(designId, slug, `?v=${n}`); right.src = boardUrl(designId, slug, `?k=${stamp.get(slug) || 0}`);
      const info = design.boards[slug], old = entry.manifest.boards[slug];
      Object.assign(left.style, { width: `${old.w}px`, height: `${old.h}px` }); Object.assign(right.style, { width: `${info.w}px`, height: `${info.h}px` });
      requestAnimationFrame(() => { for (const [frame, b, pane] of [[left, old, paneL], [right, info, paneR]]) { const s = Math.min(1, (pane.clientWidth - 16) / b.w, (pane.clientHeight - 40) / b.h); frame.style.transform = `scale(${s})`; } });
    };
    pickBoard.onchange = () => { slug = pickBoard.value; show(); };
    const close = el('button', { type: 'button', class: 'btn quiet', text: 'Close', onclick: () => closeFocus() });
    const overlay = el('div', { class: 'design-focus design-compare', role: 'dialog', 'aria-label': `Compare version ${n}` }, [
      el('header', { class: 'design-focus-bar' }, [el('strong', { text: `Compare v${n} with current` }), pickBoard, el('span', { class: 'design-spacer' }), close]),
      el('div', { class: 'design-compare-stage' }, [paneL, paneR])]);
    root.append(overlay);
    focus = { slug, frame: right, compare: left, overlay, observer: new ResizeObserver(show), history: [] };
    focus.observer.observe(overlay); show(); close.focus();
  }

  function commentsPanel(target) {
    const chosen = new Set(openComments().filter(c => c.status === 'open').map(c => c.id));
    const send = el('button', { type: 'button', class: 'btn primary', text: '', onclick: () => {
      const items = comments.filter(c => chosen.has(c.id));
      if (items.length) onComments?.(items.map(c => ({ kind: 'design_comment', design_id: designId, board: c.board, element_ids: c.element_ids || [], point: c.element_ids?.length ? null : c.point,
        comment: c.text, comment_id: c.id, label: `${design.boards[c.board]?.title || c.board} · ${c.text.slice(0, 40)}` })));
    } });
    const updateSend = () => { send.textContent = `Send ${chosen.size} comment${chosen.size === 1 ? '' : 's'}`; send.disabled = !chosen.size || !onComments; };
    const rows = comments.slice().reverse().map(c => {
      const check = el('input', { type: 'checkbox', checked: chosen.has(c.id), disabled: c.status !== 'open', 'aria-label': `Include comment: ${c.text}` });
      check.onchange = () => { check.checked ? chosen.add(c.id) : chosen.delete(c.id); updateSend(); };
      const state = c.status === 'addressed' ? `Addressed in v${c.addressed_in}` : c.status === 'resolved' ? 'Resolved' : 'Open';
      const older = c.made_on_version && c.made_on_version < design.version && c.status === 'open' ? ` · made on v${c.made_on_version}` : '';
      const act = (text, status) => el('button', { type: 'button', class: 'btn quiet', text, onclick: async () => { await api(`/api/designs/${designId}/comments/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }).catch(() => null); await reloadComments(); } });
      return el('div', { class: `design-comment design-comment-${c.status}`, 'data-comment': c.id }, [
        el('label', { class: 'design-comment-head' }, [check, el('strong', { text: design.boards[c.board]?.title || c.board }), el('span', { class: 'meta', text: `${state}${older}` })]),
        el('p', { text: c.text }), c.note ? el('p', { class: 'meta', text: `Model note: ${c.note}` }) : el('span'),
        el('div', { class: 'design-row' }, [
          c.status === 'open' ? act('Resolve', 'resolved') : act('Reopen', 'open'),
          c.status === 'addressed' ? act('Resolve', 'resolved') : el('span'),
          el('button', { type: 'button', class: 'btn quiet', text: 'Delete', onclick: async () => { await api(`/api/designs/${designId}/comments/${c.id}`, { method: 'DELETE' }).catch(() => null); await reloadComments(); } }),
        ])]);
    });
    updateSend();
    target.replaceChildren(el('h3', { text: 'Comments' }),
      el('p', { class: 'meta', text: onComments ? 'Pin comments in Comment mode, then send them to the design\'s chat as one message.' : 'Link this design to a chat to send comments to a model.' }),
      ...(rows.length ? rows : [el('p', { class: 'meta', text: 'No comments yet.' })]), el('div', { class: 'design-row design-sticky' }, [send]));
  }
  async function reloadComments() {
    comments = await api(`/api/designs/${designId}/comments`).catch(() => comments);
    paintPins(); broadcast();
    panelBtns.comments.textContent = openComments().length ? `Comments (${openComments().length})` : 'Comments';
    if (panel.dataset.kind === 'comments') renderPanel('comments');
  }

  // -- export and add ---------------------------------------------------------------
  function openExport(anchor) {
    const items = [['html', 'HTML zip (opens offline)'], ['png', 'PNG images'], ['pdf', 'PDF'], ['pptx', 'PowerPoint (picture slides)']];
    const menu = el('div', { class: 'design-menu', role: 'menu', 'aria-label': 'Export' }, items.map(([format, label]) =>
      el('button', { type: 'button', role: 'menuitem', class: 'design-menu-item', text: label, disabled: format !== 'html' && !renderAvailable,
        title: format !== 'html' && !renderAvailable ? 'Needs the Kairos desktop app' : '', onclick: () => { menu.remove(); exportAs(format); } })));
    if (!renderAvailable) menu.append(el('p', { class: 'meta', text: 'PNG, PDF and PowerPoint need the Kairos desktop app.' }));
    showMenu(menu, anchor);
  }
  async function exportAs(format) {
    toast('Exporting...');
    try {
      const result = await api(`/api/designs/${designId}/export`, { method: 'POST', body: JSON.stringify({ format }) });
      const link = el('a', { href: result.url, download: result.filename }); document.body.append(link); link.click(); link.remove();
      toast(`Exported ${result.filename}`, 'success');
    } catch { /* api shows the error. */ }
  }
  // Add a board in a named format (core/design_formats.py); a website adds its pair.
  function formatItems(onPick, { pair = true } = {}) {
    const items = [];
    for (const group of design?.formats || []) {
      items.push(el('div', { class: 'design-menu-heading', role: 'presentation', text: group.label }));
      if (pair && group.id === 'website') items.push(el('button', { type: 'button', role: 'menuitem', class: 'design-menu-item', text: 'Desktop and mobile pair',
        onclick: () => onPick({ format: 'website', size: 'pair', orientation: null }, 'Website') }));
      for (const option of group.options) {
        const label = option.label.replace(`${group.label} · `, '').replace(group.label, '') || group.label;
        items.push(el('button', { type: 'button', role: 'menuitem', class: 'design-menu-item', 'data-format': `${option.format}:${option.size}:${option.orientation || ''}`,
          text: `${label} · ${option.grows ? `${option.w} wide` : `${option.w}x${option.h}`}`, onclick: () => onPick(option, group.label) }));
      }
    }
    return items;
  }
  function addBoard(anchor) {
    const menu = el('div', { class: 'design-menu design-format-menu', role: 'menu', 'aria-label': 'Add board' }, formatItems(async (option, name) => {
      menu.remove();
      const body = { title: `${name} ${order().length + 1}`, format: option.format, size: option.size, orientation: option.orientation };
      const result = await api(`/api/designs/${designId}/boards`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
      if (result) { design = { ...design, ...result.design }; build(); zoomToBoard(result.slug); }
    }));
    showMenu(menu, anchor);
  }
  // Older boards: fit every one to its nearest format, or the selected one to a format.
  function fitFormatMenu(anchor) {
    const data = manifest();
    const loose = order().filter(slug => !data.boards[slug].format);
    const one = selected && !data.boards[selected]?.format ? selected : null;
    const items = [el('button', { type: 'button', role: 'menuitem', class: 'design-menu-item', text: `Fit ${loose.length === 1 ? 'the board' : `all ${loose.length} boards`} to the nearest format`,
      onclick: () => { menu.remove(); fitFormat({}); } })];
    if (one) {
      const guess = data.boards[one].format_guess;
      items.push(el('div', { class: 'design-menu-heading', role: 'presentation', text: `${data.boards[one].title}${guess ? `: nearest ${guess.label}` : ''}` }),
        ...formatItems(option => { menu.remove(); fitFormat({ board: one, format: option.format, size: option.size, orientation: option.orientation }); }, { pair: false }));
    } else items.push(el('p', { class: 'meta', text: 'Select a board first to choose its format.' }));
    const menu = el('div', { class: 'design-menu design-format-menu', role: 'menu', 'aria-label': 'Fit to format' }, items);
    showMenu(menu, anchor);
  }
  async function fitFormat(body) {
    try {
      const result = await api(`/api/designs/${designId}/board-action`, { method: 'POST', body: JSON.stringify({ action: 'fit_format', ...body }) });
      design = { ...design, ...result.design };
      for (const slug of order()) stamp.set(slug, (stamp.get(slug) || 0) + 1);
      build(); reloadBoards(order()); requestAnimationFrame(() => fitAll());
      toast(result.message?.replace(/^Version \d+: /, '') || 'Fitted to format', 'success');
    } catch { /* api shows the error. */ }
  }
  function showMenu(menu, anchor) {
    root.querySelectorAll('.design-menu').forEach(m => m.remove());
    const r = anchor.getBoundingClientRect(), base = root.getBoundingClientRect();
    menu.style.top = `${r.bottom - base.top + 4}px`; menu.style.left = `${Math.max(8, Math.min(r.left - base.left, base.width - 260))}px`;
    root.append(menu); menu.querySelector('button:not([disabled])')?.focus();
    const off = e => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
    menu.addEventListener('keydown', e => { if (e.key === 'Escape') { menu.remove(); anchor.focus(); } });
  }

  async function undo() {
    try { await api(`/api/designs/${designId}/undo`, { method: 'POST', toast: false }); toast('Undone', 'success'); }
    catch (error) { toast(error.message.replace(/^\d+: /, ''), 'error'); }
  }

  // -- live updates: design_changed on the chat stream ----------------------------------
  async function reloadBoards(slugs) {
    for (const slug of slugs) stamp.set(slug, (stamp.get(slug) || 0) + 1);
    for (const slug of slugs) { const node = boardNodes.get(slug); if (node) setLive(slug, node, !!node.iframe); }
    if (focus && slugs.includes(focus.slug) && focus.frame && !focus.compare) focus.frame.src = src(focus.slug);
    if (view === 'list') paintList();
  }
  async function reloadAll() { await load(); reloadBoards(order()); }
  document.addEventListener('kairos:design-changed', async event => {
    const packet = event.detail || {};
    if (packet.designId !== designId || signal.aborted) return;
    // A measured height (fit-height): positions only, nothing to announce or reload.
    if (packet.quiet) { await load(); return; }
    await load();
    const boards = packet.boards || [];
    for (const [slug, ids] of Object.entries(packet.changed || {})) if (ids.length) flash.set(slug, ids);
    reloadBoards(boards);
    if (packet.manifestChanged && !boards.length) build();
    status.textContent = `${packet.by} changed ${boards.map(s => design.boards[s]?.title || s).join(', ') || 'the design'} (version ${packet.version})`;
    root.classList.add('design-updated'); setTimeout(() => root.classList.remove('design-updated'), 900);
    // The changed elements stay outlined briefly, so you watch the model work.
    setTimeout(() => { for (const slug of Object.keys(packet.changed || {})) flash.delete(slug); broadcast(); }, 2200);
    setTimeout(broadcast, 400);
  }, { signal });

  const resize = new ResizeObserver(() => { if (autoFit && design && view === 'canvas') fitAll(false); else schedule(); }); resize.observe(stage);
  // A phone opens the board list; a wider window the canvas, unless chosen.
  let chosenView = false;
  const widthChanged = () => { if (!chosenView && !focus) setView(mobileOn() ? 'list' : 'canvas'); };
  matchMedia('(max-width: 768px)').addEventListener('change', widthChanged, { signal });
  document.addEventListener('kairos:appearance', widthChanged, { signal });
  root.dataset.view = view; list.hidden = view !== 'list'; stage.hidden = view === 'list'; viewBtn.textContent = view === 'list' ? 'Canvas' : 'Boards';
  applyTransform();
  const ready = load(true).catch(error => { titleNode.textContent = 'This design could not be opened'; toast(error.message.replace(/^\d+: /, ''), 'error'); });

  const controller = {
    root, ready,
    get design() { return design; },
    reload: reloadAll,
    fit: fitAll, zoomTo, zoomToBoard, openFocus, closeFocus, setMode, setView, togglePanel, addBoard: () => addBoard(addBtn), fitFormat,
    fitBoards: slugs => { fitRect(bounds(slugs), 48, false); autoFit = false; },
    state: () => ({ zoom, tx, ty, mode, view, selected, focus: focus?.slug || null, live: Number(root.dataset.live || 0), preview: preview?.n || null }),
    clearSelection: () => clearPicked(false),
    dispose() { lifetime.abort(); resize.disconnect(); closeFocus(true); sheet?.close?.(); cancelAnimationFrame(liveFrame); cancelAnimationFrame(paintFrame); root.remove(); },
  };
  root.designCanvas = controller;  // For the UI checks (scripts/ui-smoke.cjs) and devtools.
  return controller;
}
