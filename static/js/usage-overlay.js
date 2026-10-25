/* Kairos desktop usage overlay - the notch page's readings, card and pointer.

   The notch itself is drawn by static/js/notchShell.js, at the top centre or on
   the left or right edge. This page reads usage, keeps the usage card, folds
   the notch when that is chosen, and turns the pointer into one signal - is it
   over the notch - which electron/main.js turns into click-through everywhere
   else. The usage card and the fold began as a port of CodeNotch's Windows
   notch (windows/codenotch/ui/notch.html at 117a38b,
   https://github.com/vinzdg/codenotch), MIT licensed, (c) 2026 Vinz; the full
   notice is in static/css/usage-overlay.css. Its edge pill, rings and handles
   were retired with the round 6 notch (2026-10-25).

   Only a subscription that reports a quota gets a ring. The notch also lists
   every other connected model with the tokens Kairos counted through it
   (David, 2026-10-25). Readings come from core/quota_usage.py.
*/
import { PROVIDERS, SIGN_IN, toSnap, toneOf, usedCopy, resetCopy, ago, staleOf, modelGroups, compactTokens, shortReading } from './quotaReadings.js';
const bridge = window.usageOverlay || {};

/* Colour ramp: CodeNotch's three steps, in the notch's Kairos tones (usage-overlay.css :root) */
const AMPLE = 'var(--n-ample)', WATCH = 'var(--n-watch)', CRIT = 'var(--n-crit)';
const tone = f => ({ crit: CRIT, watch: WATCH, ample: AMPLE })[toneOf(f)];
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

/* ---- Readings --------------------------------------------------------------
   core/quota_usage.py reports {provider, status, windows:[{name, used_percent,
   resets_at (unix s)}], updated_at, note}, converted once (quotaReadings.js,
   shared with Home's "Your models") to {status, windows:[{id, label, used
   0..1, resets_at ms}], fetched_at ms, note}. */
// A mark is drawn as a mask in the current text colour, and no SVG markup is
// ever put into the page. A model with no known logo (mark null) gets none.
function markHtml(mark) { return /^[a-z0-9-]+$/.test(mark || '') ? `<span class="mark" style="--mark:url('/static/img/model-marks/${mark}.svg')"></span>` : ''; }
let snaps = {};  // provider id -> snapshot
let groups = [];  // every connected model (quotaReadings.js modelGroups)
let statuses = [];  // the raw provider readings, for the notch's sign-in and pause panels

function applyReadings(data) {
  const next = {};
  for (const p of (data && data.providers) || []) next[p.provider] = toSnap(p);
  snaps = next;
  groups = modelGroups((data && data.models) || []);
  statuses = (data && data.providers) || [];
  notchShell?.quota(statuses);
  renderReadings();
  if (card.classList.contains('show')) renderCard();
}
function providers() {
  return PROVIDERS.filter(p => snaps[p.id]).map(p => ({ ...p, base: p.id, snap: snaps[p.id] }));
}

const card = document.getElementById('card');

function renderReadings() {
  notchShell?.readings(providers(), groups);
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
  if (hoverId === 'all' || !providers().some(x => x.id === hoverId)) {
    const group = groups.find(g => g.id === hoverId);
    if (hoverId !== 'all' && !group) { hideCard(); return; }
    card.innerHTML = group ? tokensCardHtml(group) : allModelsHtml();
    placeCard(); return;
  }
  const p = providers().find(x => x.id === hoverId);
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
// The card follows the hovered reading: under the top notch, right-aligned with
// it; beside the side panel, level with it.
function placeCard() {
  const shell = document.getElementById('notch-shell').getBoundingClientRect();
  const word = document.querySelector(`#notch-readings [data-p="${hoverId}"]`)?.getBoundingClientRect() || shell;
  if (edgeIsVertical()) {
    const at = notchShell.cardAt(word, { width: card.offsetWidth, height: card.offsetHeight });
    card.style.left = at.left + 'px'; card.style.top = at.top + 'px'; return;
  }
  card.style.left = Math.round(Math.max(8, Math.min(innerWidth - 254, word.right - 246))) + 'px';
  card.style.top = Math.round(shell.bottom + 8) + 'px';
}

/* Hover: stays open while the reading or the card is under the pointer; closes after CodeNotch's 250 ms grace */
let hideTimer = null;
function cancelHide() { clearTimeout(hideTimer); hideTimer = null; }
function showCard() { cancelHide(); card.classList.add('show'); renderCard(); }
function hideCard() { cancelHide(); card.classList.remove('show'); }
function scheduleHide() { if (hideTimer === null) hideTimer = setTimeout(hideCard, 250); }

function inRect(x, y, r, pad) { return x >= r.left - pad && y >= r.top - pad && x < r.right + pad && y < r.bottom + pad; }
function readingAt(x, y) {
  for (const el of document.querySelectorAll('#notch-readings [data-p]')) { const r = el.getBoundingClientRect(); if (r.width && inRect(x, y, r, 6)) return el.dataset.p; }
  return null;
}

/* ---- Click-through ----------------------------------------------------------
   The window ignores the mouse by default but still receives movement, and this
   page says whether the pointer is over something it should take clicks for. */
let interactive = null, lastPointer = null;
function overNotch(x, y) { return x != null && (notchShell?.hot(x, y) || false); }
function updateInteractive() {
  const want = lastPointer ? overNotch(lastPointer.x, lastPointer.y) : false;
  if (want === interactive) return;
  interactive = want;
  bridge.setInteractive && bridge.setInteractive(want);
}

/* ---- Re-read one provider ----------------------------------------------------
   The notch's sign-in panel Retry. Resolves whether the provider is signed in
   afterwards; a provider already being read is not asked twice. */
const refreshing = {};
async function refreshProvider(id) {
  if (refreshing[id]) return false;
  refreshing[id] = true;
  try {
    const response = await fetch('/api/models/quotas/refresh', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id }),
    });
    if (response.ok) applyReadings(await response.json());
    else if (response.status === 429) notice('Refreshed a moment ago. Try again shortly.');
    else notice('Could not refresh usage.');
  } catch { notice('Kairos is not reachable.'); }
  delete refreshing[id];
  return !!snaps[id] && snaps[id].status !== 'needsAuth';
}

function notice(msg) {
  const n = document.getElementById('notice');
  n.textContent = msg; n.classList.add('show');
  clearTimeout(n._h); n._h = setTimeout(() => n.classList.remove('show'), 6000);
}

/* ---- Fold on hover (opt-in) ----------------------------------------------------
   CodeNotch's show-on-hover: folded, the notch rests as a small tab at the edge;
   it opens on contact and folds a moment after the pointer has gone. */
const FOLD_GRACE = 450;
let onHover = true, folded = true, pointerIn = false, foldTimer = null;
function foldAllowed() { return onHover && !pointerIn; }
function setFolded(f) {
  if (f === folded) return;
  folded = f;
  if (f) hideCard();
  document.body.classList.toggle('folded', f);
  requestAnimationFrame(updateInteractive);
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
function pointerMoved(e) {
  lastPointer = { x: e.clientX, y: e.clientY };
  const hot = notchShell?.pointer(e.clientX, e.clientY) || false;
  pointerIn = hot;
  if (hot && folded) unfold();
  if (!hot) scheduleFold(); else cancelFold();
  const id = readingAt(e.clientX, e.clientY);
  if (id && notchShell?.isExpanded()) { hoverId = id; showCard(); } else if (!inRect(e.clientX, e.clientY, card.getBoundingClientRect(), 0)) scheduleHide();
  updateInteractive();
}
document.addEventListener('mousemove', pointerMoved);
bridge.onPointer && bridge.onPointer(point => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
  pointerMoved({ clientX: point.x, clientY: point.y });
});
document.addEventListener('mouseleave', () => {
  lastPointer = null; pointerIn = false; scheduleHide(); scheduleFold(); updateInteractive();
});
document.addEventListener('contextmenu', e => e.preventDefault());

/* ---- Edge and settings, from the main process --------------------------------- */
// The shell notch (notchShell.js) draws the top-centre notch and the left and right side notches.
const EDGES = ['top-centre', 'left', 'right'];
let notchEdge = 'top-centre', notchShell = null, configRevision = 0;
async function applyConfig(config) {
  const revision = ++configRevision;
  cancelFold();
  const edge = EDGES.includes(config?.edge) ? config.edge : 'top-centre';
  if (!notchShell) {
    const { createNotchShell } = await import('./notchShell.js');
    if (revision !== configRevision) return;
    notchShell = createNotchShell({ card, bridge, hideCard, renderReadings, refreshQuota: refreshProvider });
    renderReadings(); // the shell exists only now, so hand it the readings already on hand
    notchShell.quota(statuses);
  }
  notchEdge = edge;
  notchShell.reset();
  notchShell.setEdge(edge, config?.offset);
  document.body.dataset.edge = edge;
  onHover = !(config && config.foldOnHover === false);
  if (!onHover) setFolded(false); else if (!pointerIn) setFolded(true);
  requestAnimationFrame(() => { if (card.classList.contains('show')) placeCard(); updateInteractive(); });
}
bridge.onConfig && bridge.onConfig(applyConfig);
Promise.resolve(bridge.getConfig ? bridge.getConfig() : null).then(applyConfig).catch(() => applyConfig(null));

/* ---- Fetching ------------------------------------------------------------------ */
async function refresh() {
  try {
    const response = await fetch('/api/models/quotas', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) { snaps = {}; groups = []; statuses = []; notchShell?.quota([]); renderReadings(); hideCard(); return; }
    if (!response.ok) throw new Error('unavailable');
    applyReadings(await response.json());
  } catch {
    // Keep the last readings on screen, marked stale, rather than emptying the notch
    for (const id of Object.keys(snaps)) snaps[id] = { ...snaps[id], status: 'stale' };
    renderReadings();
  }
}
refresh();
setInterval(refresh, 60_000);
// A module keeps its functions private; this one is reached from outside the
// page (scripts/usage-overlay-smoke.cjs reads fresh readings on demand).
window.refreshUsageReadings = refresh;
setInterval(() => { renderReadings(); if (card.classList.contains('show')) renderCard(); }, 30_000);  // reset copy moves with time
window.addEventListener('resize', () => {
  if (card.classList.contains('show')) placeCard();
  updateInteractive();
});
