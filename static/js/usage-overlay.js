/* Kairos desktop usage overlay - the notch's behaviour.

   Ported from CodeNotch's Windows notch (windows/codenotch/ui/notch.html at
   117a38b, https://github.com/vinzdg/codenotch), MIT licensed, (c) 2026 Vinz;
   the full notice is in static/css/usage-overlay.css. The rendering (rings,
   card, tail, fold, handles) follows CodeNotch's code closely. What changed:
   Tauri's invoke/listen became Kairos's own API plus a small Electron bridge
   (window.usageOverlay, electron/usage-overlay-preload.js); CodeNotch's other
   providers, translations and drag-to-another-edge were left out; and the
   hot-rectangle reporting became one signal - is the pointer over the notch -
   which electron/main.js turns into click-through everywhere else.

   Only a subscription that reports a quota gets a ring. The top-centre notch
   also lists every other connected model with the tokens Kairos counted
   through it (David, 2026-10-25). Readings come from core/quota_usage.py.
*/
import { PROVIDERS, SIGN_IN, toSnap, toneOf, pctText, usedCopy, resetCopy, ago, staleOf, modelGroups, compactTokens, shortReading } from './quotaReadings.js';
const bridge = window.usageOverlay || {};

/* Colour ramp: CodeNotch's three steps, in the notch's Kairos tones (usage-overlay.css :root) */
const AMPLE = 'var(--n-ample)', WATCH = 'var(--n-watch)', CRIT = 'var(--n-crit)';
const TRACK = 'var(--n-track)';
const tone = f => ({ crit: CRIT, watch: WATCH, ample: AMPLE })[toneOf(f)];
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

/* ---- Readings --------------------------------------------------------------
   core/quota_usage.py reports {provider, status, windows:[{name, used_percent,
   resets_at (unix s)}], updated_at, note}. CodeNotch's page works in its own
   shape - {status, windows:[{id, label, used 0..1, resets_at ms}], fetched_at
   ms, note} - so readings are converted once (quotaReadings.js, shared with
   Home's "Your models") and everything below is CodeNotch's code reading
   CodeNotch's shape. */
// A mark is drawn as a mask in the current text colour, so it is white on the
// pill like CodeNotch's, and no SVG markup is ever put into the page.
// A model with no known logo (mark null) gets none.
function markHtml(mark) { return /^[a-z0-9-]+$/.test(mark || '') ? `<span class="mark" style="--mark:url('/static/img/model-marks/${mark}.svg')"></span>` : ''; }
let snaps = {};  // provider id -> CodeNotch-shaped snapshot
let groups = [];  // every connected model (quotaReadings.js modelGroups)

function applyReadings(data) {
  const next = {};
  for (const p of (data && data.providers) || []) next[p.provider] = toSnap(p);
  snaps = next;
  groups = modelGroups((data && data.models) || []);
  renderRing();
  if (card.classList.contains('show')) renderCard();
}
function providers() {
  return PROVIDERS.filter(p => snaps[p.id]).map(p => ({ ...p, base: p.id, snap: snaps[p.id] }));
}

// Where the weekly limit's own ring goes: CodeNotch offers off, inside or outside
const weeklyRing = 'outside';
function headlineOf(snap) {
  const ws = snap.windows; if (!ws.length) return null;
  return ws.find(w => w.id === 'session') || ws[0];
}
function weeklyOf(snap) { return snap.windows.find(w => w.id === 'weekly') || null; }
function svgArc(r, frac, color, width, extra = '') {
  if (!(frac > 0)) return '';
  const C = 2 * Math.PI * r;
  return `<circle cx="28" cy="28" r="${r}" fill="none" style="stroke:${color}" stroke-width="${width}"
    stroke-dasharray="${(C * frac).toFixed(2)} ${C.toFixed(2)}" stroke-linecap="round"
    transform="rotate(-90 28 28)" ${extra}/>`;
}

const card = document.getElementById('card'), pill = document.getElementById('pill'), tail = document.getElementById('tail');

function renderRing() {
  const ps = providers();
  const want = ps.map(p => p.id).join(',');
  if (pill.dataset.cells !== want) {
    pill.innerHTML = ps.map((p, i) => `<div class="cell" data-p="${p.id}" style="--i:${i}">
      <div class="ringwrap"><svg class="ring" viewBox="0 0 56 56"></svg><svg class="reading" viewBox="0 0 56 56"></svg><svg class="activity" viewBox="0 0 56 56"></svg><div class="glyph">${markHtml(p.mark)}</div></div>
      <span class="provider-label">${esc(p.name)}</span><div class="pct">—</div></div>`).join('');
    pill.dataset.cells = want;
  }
  for (const p of ps) {
    const cell = pill.querySelector(`.cell[data-p="${p.id}"]`); if (!cell) continue;
    const svg = cell.querySelector('svg.ring'), reading = cell.querySelector('svg.reading'), pct = cell.querySelector('.pct'), glyph = cell.querySelector('.glyph'), wrap = cell.querySelector('.ringwrap');
    const h = headlineOf(p.snap);
    let inner = `<circle cx="28" cy="28" r="22" style="fill:var(--n-face)"/><circle cx="28" cy="28" r="25" fill="none" style="stroke:${TRACK}" stroke-width="5"/>`;
    wrap.classList.toggle('pressed', !!refreshing[p.id]);
    reading.innerHTML = h ? svgArc(25, Math.min(h.used, 1), tone(h.used), 5) : '';
    if (weeklyRing !== 'off') {  // the week, thinner, at its own radius: a session at 12% beside a week at 91% is why
      const wk = weeklyOf(p.snap);
      if (wk && (!h || wk.id !== h.id)) {
        const r = weeklyRing === 'inside' ? 16 : 31;
        inner += `<circle cx="28" cy="28" r="${r}" fill="none" style="stroke:${TRACK}" stroke-width="2.4" opacity="0.7"/>`
          + svgArc(r, Math.min(wk.used, 1), tone(wk.used), 2.4, 'opacity="0.85"');
      }
    }
    svg.innerHTML = inner;
    if (p.snap.status === 'needsAuth') pct.textContent = '—';
    else if (h) pct.textContent = pctText(h.used) + '%';
    else pct.textContent = '…';
    glyph.classList.toggle('dim', !!(h && h.used >= 1));
    wrap.classList.toggle('stale', staleOf(p.snap));
  }
  notchShell?.readings(ps, groups);
  updateInteractive();
}

// A model without a provider quota: what Kairos counted through it.
function tokensCardHtml(group) {
  const r = group.recorded, snap = group.snap;
  let html = `<div class="c-head">${markHtml(group.mark)}<span class="c-title">${esc(group.name + ' Usage')}</span></div>`;
  if (group.detail) html += `<div class="c-sub">${esc(group.detail)}</div>`;
  if (group.status === 'needs_sign_in') html += `<div class="c-note">${esc(SIGN_IN[group.provider] || '')}</div>`;
  else if (snap?.note) html += `<div class="c-note">${esc(snap.note)}</div>`;
  for (const [label, value] of [['Today', r.today], ['This week', r.week], ['All time', r.total]]) {
    html += `<div class="w-row t-row"><span class="w-label">${label}</span><span class="w-reset">${esc(value ? compactTokens(value) + ' tokens' : 'None')}</span></div>`;
  }
  return html + '<div class="c-note">Counted by Kairos. Not a quota.</div>';
}
// The "+N" word: every connected model, one line each.
function allModelsHtml() {
  return `<div class="c-head"><span class="c-title">Models</span></div>` + groups.map(g => `<div class="w-row t-row">
    <span class="w-label">${markHtml(g.mark)}${esc(g.name)}</span><span class="w-reset">${esc(shortReading(g))}</span></div>`).join('');
}

let hoverId = 'claude';
function renderCard() {
  if (inShell() && (hoverId === 'all' || !providers().some(x => x.id === hoverId))) {
    const group = groups.find(g => g.id === hoverId);
    if (hoverId !== 'all' && !group) { hideCard(); return; }
    card.innerHTML = group ? tokensCardHtml(group) : allModelsHtml();
    placeCard(); return;
  }
  const p = providers().find(x => x.id === hoverId) || providers()[0];
  if (!p) { hideCard(); return; }
  const snap = p.snap;
  let html = `<div class="c-head">${markHtml(p.mark)}<span class="c-title">${esc(p.name + ' Usage')}</span></div>`;
  if (staleOf(snap) && snap.fetched_at) html += `<div class="c-sub">Updated ${ago(snap.fetched_at)}</div>`;
  if (snap.status === 'needsAuth') {
    html += `<div class="c-note">${esc(SIGN_IN[p.id] || '')}<br>${esc(snap.note)}</div>`;
  } else if (!snap.windows.length) {
    html += `<div class="c-note">${esc(snap.note || 'Waiting for first reading…')}</div>`;
  } else {
    for (const w of snap.windows) {
      html += `<div class="win">
        <div class="w-row"><span class="w-label">${esc(w.label)}</span><span class="w-reset">${esc(resetCopy(w.resets_at))}</span></div>
        <div class="w-track"><div class="w-fill" style="width:${(Math.min(w.used, 1) * 100).toFixed(0)}%;background:${tone(w.used)}"></div></div>
        <div class="w-used">${esc(usedCopy(w))}</div>
      </div>`;
    }
    if (snap.note) html += `<div class="c-note">${esc(snap.note)}</div>`;
  }
  card.innerHTML = html;
  placeCard();
}
function edgeIsVertical() { return notchEdge === 'left' || notchEdge === 'right'; }
// The card follows the hovered cell (CodeNotch's placeCard): on the upright edges
// it is centred on the cell's height; lying flat, on its width, and pushed clear
// of the pill with the tail spanning the 30 px gap.
function placeCard() {
  if (inShell()) {
    const shell = document.getElementById('notch-shell').getBoundingClientRect();
    const word = document.querySelector(`#notch-readings [data-p="${hoverId}"]`)?.getBoundingClientRect() || shell;
    if (edgeIsVertical()) {
      // Beside the side panel, level with the hovered reading.
      const at = notchShell.cardAt(word, { width: card.offsetWidth, height: card.offsetHeight });
      card.style.left = at.left + 'px'; card.style.top = at.top + 'px'; return;
    }
    // Under the notch, right-aligned with the hovered reading in the status row.
    card.style.left = Math.round(Math.max(8, Math.min(innerWidth - 254, word.right - 246))) + 'px';
    card.style.top = Math.round(shell.bottom + 8) + 'px'; return;
  }
  const cell = pill.querySelector(`.cell[data-p="${hoverId}"]`) || pill;
  const cr = cell.getBoundingClientRect();
  const rr = (cell.querySelector('.ringwrap') || cell).getBoundingClientRect();
  card.style.transform = 'none';
  if (edgeIsVertical()) {
    const cy = cr.top + cr.height / 2;
    const H = innerHeight, ch = card.offsetHeight || 0;
    let top = Math.round(cy - ch / 2); top = Math.max(8, Math.min(top, H - ch - 8));
    card.style.top = top + 'px'; card.style.left = '';
    const ry = rr.top + rr.height / 2;
    const th = tail.offsetHeight || 36, ty = Math.max(top + 16 + th / 2, Math.min(top + ch - 16 - th / 2, ry));
    tail.style.top = Math.round(ty - th / 2) + 'px'; tail.style.left = '';
  } else {
    const pr = pill.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const W = innerWidth, cw = card.offsetWidth || 0, ch = card.offsetHeight || 0;
    let left = Math.round(cx - cw / 2); left = Math.max(8, Math.min(left, W - cw - 8));
    card.style.left = left + 'px';
    const rx = rr.left + rr.width / 2;
    const tw = tail.offsetWidth || 36, tx = Math.max(left + 16 + tw / 2, Math.min(left + cw - 16 - tw / 2, rx));
    tail.style.left = Math.round(tx - tw / 2) + 'px';
    if (notchEdge === 'top') { card.style.top = Math.round(pr.bottom + 30) + 'px'; tail.style.top = Math.round(pr.bottom - 1) + 'px'; }
    else { card.style.top = Math.round(pr.top - 30 - ch) + 'px'; tail.style.top = Math.round(pr.top - 31) + 'px'; }
  }
}

/* Hover: stays open while the pill or the card is under the pointer; closes after CodeNotch's 250 ms grace */
let hideTimer = null;
function cancelHide() { clearTimeout(hideTimer); hideTimer = null; }
function showCard() { cancelHide(); card.classList.add('show'); renderCard(); }
function hideCard() { cancelHide(); card.classList.remove('show'); }
function scheduleHide() { if (hideTimer === null) hideTimer = setTimeout(hideCard, 250); }

function inRect(x, y, r, pad) { return x >= r.left - pad && y >= r.top - pad && x < r.right + pad && y < r.bottom + pad; }
function cellAt(x, y) {
  const cells = inShell() ? document.querySelectorAll('#notch-readings [data-p]') : pill.querySelectorAll('.cell');
  for (const el of cells) { const r = el.getBoundingClientRect(); if (r.width && inRect(x, y, r, 6)) return el.dataset.p; }
  return null;
}
function pointerInHot(x, y) {
  if (inShell()) return notchShell?.hot(x, y) || false;
  const p = pill.getBoundingClientRect();
  if (inRect(x, y, p, 4)) return true;
  if (!card.classList.contains('show')) return false;
  const c = card.getBoundingClientRect();
  if (inRect(x, y, c, 4)) return true;
  const u = { left: Math.min(p.left, c.left), top: Math.min(p.top, c.top), right: Math.max(p.right, c.right), bottom: Math.max(p.bottom, c.bottom) };
  return inRect(x, y, u, 0);
}

/* ---- Click-through ----------------------------------------------------------
   CodeNotch reports hot rectangles to Rust, which gates clicks on them. Here the
   window ignores the mouse by default but still receives movement, and this page
   says whether the pointer is over something it should take clicks for. */
let interactive = null, lastPointer = null;
const WAKE_BAND = 34;  // CodeNotch's pillHotZone: the folded pill is small, the place that opens it should not be
function wakeHit(x, y) {
  const r = document.getElementById('rest').getBoundingClientRect();
  // Deepened into the screen from whichever edge the notch is on
  const band = notchEdge === 'left' ? { left: r.left, top: r.top, right: r.right + WAKE_BAND, bottom: r.bottom }
    : (notchEdge === 'top' || notchEdge === 'top-centre') ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom + WAKE_BAND }
    : notchEdge === 'bottom' ? { left: r.left, top: r.top - WAKE_BAND, right: r.right, bottom: r.bottom }
    : { left: r.left - WAKE_BAND, top: r.top, right: r.right, bottom: r.bottom };
  return inRect(x, y, band, 0);
}
function overNotch(x, y) {
  if (x == null) return false;
  if (inShell()) return notchShell?.hot(x, y) || false;
  if (folded) return wakeHit(x, y);
  return pointerInHot(x, y) || !!onHandle(x, y);
}
function updateInteractive() {
  const want = carrying || (lastPointer ? overNotch(lastPointer.x, lastPointer.y) : false);
  if (want === interactive) return;
  interactive = want;
  bridge.setInteractive && bridge.setInteractive(want);
}

/* ---- Refresh a ring ---------------------------------------------------------
   As in CodeNotch, a clicked ring presses in and its reading turns once while a
   fresh reading is fetched. PRESS_MIN keeps the press visible on a fast answer. */
const PRESS_MIN = 380;
const refreshing = {};
async function refreshRing(id) {
  if (refreshing[id]) return;
  refreshing[id] = Date.now();
  renderRing();
  turnReading(id);
  try {
    const response = await fetch('/api/models/quotas/refresh', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id }),
    });
    if (response.ok) applyReadings(await response.json());
    else if (response.status === 429) notice('Refreshed a moment ago. Try again shortly.');
    else notice('Could not refresh usage.');
  } catch { notice('Kairos is not reachable.'); }
  const wait = refreshing[id] + PRESS_MIN - Date.now();
  setTimeout(() => { delete refreshing[id]; renderRing(); }, Math.max(0, wait));
}
function turnReading(id) {
  const el = pill.querySelector(`.cell[data-p="${id}"] svg.reading`);
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (el.getAnimations().some(a => a.playState === 'running')) return;
  el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 950, easing: 'cubic-bezier(.32,0,.14,1)' });
}

function notice(msg) {
  const n = document.getElementById('notice');
  n.textContent = msg; n.classList.add('show');
  clearTimeout(n._h); n._h = setTimeout(() => n.classList.remove('show'), 6000);
}

/* ---- The handles --------------------------------------------------------------
   Settings past the far end of the pill opens Kairos; the move handle past the
   near end slides the notch along its edge. */
const orb = document.getElementById('orb'), moveHandle = document.getElementById('move');
const HANDLE_REACH = 28.5;
let orbAt = null, moveAt = null, hovered = null, orbSpins = 0, moveSpins = 0, carrying = false;
function put(el, x, y) {
  el.style.left = (x - HANDLE_REACH) + 'px'; el.style.top = (y - HANDLE_REACH) + 'px';
  el.classList.add('placed');
  return { x, y, reach: HANDLE_REACH };
}
function placeHandles() {
  // The shell notch has its own Settings button and does not move along its edge (the side notch is placed by the page).
  if (inShell()) { orbAt = moveAt = null; orb.classList.remove('placed'); moveHandle.classList.remove('placed'); return true; }
  const r = pill.getBoundingClientRect();
  if (!r.width) return false;
  const R = parseFloat(getComputedStyle(pill).getPropertyValue('--fillet')) || 38.7;
  // Each fillet's centre: the corner of its square diagonally opposite the one on the screen edge
  const far = notchEdge === 'left' ? [r.left + R, r.bottom + R] : notchEdge === 'top' ? [r.right + R, r.top + R]
    : notchEdge === 'bottom' ? [r.right + R, r.bottom - R] : [r.right - R, r.bottom + R];
  const near = notchEdge === 'left' ? [r.left + R, r.top - R] : notchEdge === 'top' ? [r.left - R, r.top + R]
    : notchEdge === 'bottom' ? [r.left - R, r.bottom - R] : [r.right - R, r.top - R];
  orbAt = put(orb, far[0], far[1]);
  moveAt = put(moveHandle, near[0], near[1]);
  return true;
}
function near(at, x, y) { return !!at && Math.hypot(x - at.x, y - at.y) <= at.reach; }
function onHandle(x, y) { if (folded) return null; return near(orbAt, x, y) ? 'orb' : near(moveAt, x, y) ? 'move' : null; }
function setHovered(which) {
  if (which === hovered) return;
  hovered = which;
  orb.classList.toggle('hover', which === 'orb');
  moveHandle.classList.toggle('hover', which === 'move' || carrying);
}
function pressIn(el) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.animate([{ transform: 'scale(1)', easing: 'ease-out' }, { transform: 'scale(.84)', offset: .21, easing: 'cubic-bezier(.34,1.56,.64,1)' }, { transform: 'scale(1)' }], { duration: 430 });
}

/* ---- Fold on hover ------------------------------------------------------------
   CodeNotch's show-on-hover: folded, the notch rests as a 10 x 79 sliver at the
   edge; it opens on contact and folds a moment after the pointer has gone. It
   never folds while the notch is being carried. */
const FOLD_GRACE = 450;
let onHover = true, folded = true, pointerIn = false, foldTimer = null;
function foldAllowed() { return onHover && !pointerIn && !carrying; }
function setFolded(f) {
  if (f === folded) return;
  folded = f;
  if (f) { hideCard(); setHovered(null); }
  document.body.classList.toggle('folded', f);
  requestAnimationFrame(() => { placeHandles(); updateInteractive(); });
}
function cancelFold() { clearTimeout(foldTimer); foldTimer = null; }
function unfold() { cancelFold(); setFolded(false); }
function scheduleFold() {
  if (!onHover) { cancelFold(); setFolded(false); return; }
  // Native samples arrive every 80 ms, even with a stationary cursor. Start
  // the grace period once; repeated outside samples must not postpone folding.
  if (foldAllowed() && foldTimer === null) foldTimer = setTimeout(() => {
    foldTimer = null;
    if (foldAllowed()) setFolded(true);
  }, FOLD_GRACE);
}

/* ---- Pointer ------------------------------------------------------------------ */
let press = null;
function pointerMoved(e) {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (carrying) { bridge.moveTo && bridge.moveTo(); return; }
  if (inShell()) {
    const hot = notchShell?.pointer(e.clientX, e.clientY) || false;
    pointerIn = hot;
    if (hot && folded) unfold();
    if (!hot) scheduleFold(); else cancelFold();
    setHovered(notchShell?.isExpanded() ? onHandle(e.clientX, e.clientY) : null);
    const id = cellAt(e.clientX, e.clientY);
    if (id && notchShell?.isExpanded()) { hoverId = id; showCard(); } else if (!inRect(e.clientX, e.clientY, card.getBoundingClientRect(), 0)) scheduleHide();
    updateInteractive(); return;
  }
  const over = overNotch(e.clientX, e.clientY);
  if (over && folded) { pointerIn = true; unfold(); }
  pointerIn = over || pointerInHot(e.clientX, e.clientY);
  if (!pointerIn) scheduleFold(); else cancelFold();
  updateInteractive();
  if (folded) return;
  setHovered(onHandle(e.clientX, e.clientY));
  if (hovered) { if (card.classList.contains('show')) hideCard(); return; }
  if (pointerInHot(e.clientX, e.clientY)) {
    cancelHide();
    const id = cellAt(e.clientX, e.clientY);
    if (id && id !== hoverId) { hoverId = id; if (card.classList.contains('show')) renderCard(); }
    if (!card.classList.contains('show') && providers().length) showCard();
  } else if (card.classList.contains('show')) scheduleHide();
}
document.addEventListener('mousemove', pointerMoved);
bridge.onPointer && bridge.onPointer(point => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || carrying) return;
  pointerMoved({ clientX: point.x, clientY: point.y });
});
document.addEventListener('mouseleave', () => {
  if (carrying) return;
  lastPointer = null; pointerIn = false; setHovered(null); scheduleHide(); scheduleFold(); updateInteractive();
});
pill.addEventListener('mousedown', e => { if (e.button !== 0 || folded) return; press = { id: cellAt(e.clientX, e.clientY) }; });
document.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  if (carrying) {
    carrying = false; moveHandle.classList.remove('armed'); setHovered(null);
    bridge.moveEnd && bridge.moveEnd();
    requestAnimationFrame(() => { placeHandles(); updateInteractive(); scheduleFold(); });
  } else if (press && press.id) refreshRing(press.id);
  press = null;
});
orb.addEventListener('click', e => {
  if (!near(orbAt, e.clientX, e.clientY)) return;
  orb.style.setProperty('--spins', ++orbSpins);
  pressIn(orb);
  bridge.openApp && bridge.openApp(notchEdge === 'top-centre' ? 'settings' : 'home');
});
moveHandle.addEventListener('mousedown', e => {
  if (e.button !== 0 || !near(moveAt, e.clientX, e.clientY)) return;
  e.stopPropagation();
  carrying = true;
  moveHandle.classList.add('armed', 'hover');
  moveHandle.style.setProperty('--spins', ++moveSpins);
  hideCard();
  bridge.moveStart && bridge.moveStart();
  updateInteractive();
});
document.addEventListener('contextmenu', e => e.preventDefault());

/* ---- Edge and settings, from the main process --------------------------------- */
let notchEdge = 'top-centre', notchShell = null, configRevision = 0;
// The shell notch (notchShell.js) draws the top-centre notch and the left and right side notches.
const SHELL_EDGES = ['top-centre', 'left', 'right'];
function inShell() { return SHELL_EDGES.includes(notchEdge); }
async function applyConfig(config) {
  const revision = ++configRevision;
  // Changing displays/edges cancels the main process drag as well.
  carrying = false;
  moveHandle.classList.remove('armed');
  setHovered(null);
  cancelFold();
  const edge = SHELL_EDGES.includes(config?.edge) ? config.edge : 'top-centre';
  if (!notchShell) {
    const { createNotchShell } = await import('./notchShell.js');
    if (revision !== configRevision) return;
    notchShell = createNotchShell({ pill, card, bridge, hideCard, renderRing });
    renderRing(); // the shell exists only now, so hand it the readings already on hand
  }
  notchEdge = edge;
  notchShell?.reset();
  notchShell?.setEdge(edge, config?.offset);
  document.body.dataset.edge = edge;
  onHover = !(config && config.foldOnHover === false);
  if (!onHover) setFolded(false); else if (!pointerIn) setFolded(true);
  requestAnimationFrame(() => { placeHandles(); if (card.classList.contains('show')) placeCard(); updateInteractive(); });
}
bridge.onConfig && bridge.onConfig(applyConfig);
Promise.resolve(bridge.getConfig ? bridge.getConfig() : null).then(applyConfig).catch(() => applyConfig(null));

/* ---- Fetching ------------------------------------------------------------------ */
async function refresh() {
  try {
    const response = await fetch('/api/models/quotas', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) { snaps = {}; groups = []; renderRing(); hideCard(); return; }
    if (!response.ok) throw new Error('unavailable');
    applyReadings(await response.json());
  } catch {
    // Keep the last readings on screen, marked stale, rather than emptying the notch
    for (const id of Object.keys(snaps)) snaps[id] = { ...snaps[id], status: 'stale' };
    renderRing();
  }
}
refresh();
setInterval(refresh, 60_000);
// A module keeps its functions private; this one is reached from outside the
// page (scripts/usage-overlay-smoke.cjs reads fresh readings on demand).
window.refreshUsageReadings = refresh;
setInterval(() => { renderRing(); if (card.classList.contains('show')) renderCard(); }, 30_000);  // reset copy moves with time
requestAnimationFrame(placeHandles);
window.addEventListener('resize', () => {
  placeHandles();
  if (card.classList.contains('show')) placeCard();
  updateInteractive();
});
