// A bot's small app in the conversation (Phase 6 unit U2, 2026-10-29). Spec: phase-6-design.md section 5.3.
//
// The page runs in an iframe with sandbox="allow-scripts allow-forms" and no same-origin right, under the policy the
// server names (services/bot_apps.csp): it cannot see Kairos's cookies, storage or API, and cannot connect anywhere.
// Its only door is the host bridge (botsAppBridge.js). Three frames are live at once (the least recently used one
// folds to "open again"), only the newest 20 app rows open by themselves, and a fetched page is cached for 60 seconds.
// The card: title, an origin line, Info, Reload, a version stepper (10 kept), Point, Save as file and Full screen.
import { h, IconButton, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { SANDBOX, frameUrl, resolveTheme, createBridge, httpLink } from './botsAppBridge.js';
import { addPointed } from './botsPoint.js';

const CSS = '/static/css/bots-widgets.css';
export const FRAME = { maxLive: 3, autoMount: 20, cacheSize: 8, cacheMs: 60_000, heightBase: 520, heightMax: 560, phoneShare: 0.7, phoneMax: 720, spinnerMs: 400, nearPx: 300, updatedMs: 2500 };

// Which frames are live: the newest touched stay, the oldest is asked to fold.
export class FramePool {
  constructor(max = FRAME.maxLive) { this.max = max; this.order = []; }
  touch(id) {
    this.order = this.order.filter(x => x !== id);
    this.order.push(id);
    return this.order.length > this.max ? this.order.shift() : null;
  }
  release(id) { this.order = this.order.filter(x => x !== id); }
  has(id) { return this.order.includes(id); }
}
// A few fetched pages, each good for a minute.
export class DocCache {
  constructor(size = FRAME.cacheSize, ttl = FRAME.cacheMs, clock = () => Date.now()) { this.size = size; this.ttl = ttl; this.clock = clock; this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.clock() - hit.at > this.ttl) { this.map.delete(key); return null; }
    this.map.delete(key); this.map.set(key, hit);
    return hit.value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { at: this.clock(), value });
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
}
// The height of the frame: 520, growing to 560 with the page, then the page scrolls; a phone gets 70% of the screen, at most 720.
export function frameHeight(contentHeight, { phone = false, viewport = 800 } = {}) {
  if (phone) return Math.round(Math.min(FRAME.phoneMax, viewport * FRAME.phoneShare));
  const wanted = Number.isFinite(contentHeight) ? contentHeight : FRAME.heightBase;
  return Math.round(Math.min(FRAME.heightMax, Math.max(FRAME.heightBase, wanted)));
}

export const pool = new FramePool();
export const cache = new DocCache();
const rows = new Map();   // message id -> {at}: which app rows exist, so only the newest 20 open themselves
export function autoMounts(id) {
  const sorted = [...rows.entries()].sort((a, b) => b[1].at - a[1].at).map(([key]) => key);
  return sorted.indexOf(id) >= 0 && sorted.indexOf(id) < FRAME.autoMount;
}
export function resetFramesForTest() { pool.order = []; cache.clear(); rows.clear(); }

const INFO = ['This page runs in a sandbox. It cannot read your chats, files or accounts, and it cannot connect to other sites.',
  'It can load scripts, styles and fonts from cdnjs, jsDelivr, unpkg and Google Fonts.',
  'A message it sends shows in the chat with the page\'s name. A link it offers opens only when you click it.'];

// message: {id, ts, app:{rev, title}}. ctx: {agentId, sessionId, botName?, fetcher?}.
export function renderAppRow(message, ctx = {}) {
  loadBotsCss(CSS);
  const id = message.id || `app-${Math.random().toString(36).slice(2)}`;
  rows.set(id, { at: message.ts || Date.now() / 1000 });
  const meta = message.app || {};
  const call = (path, options) => (ctx.fetcher || fetch)(`/api/bot-widgets/${encodeURIComponent(ctx.sessionId)}/apps/${encodeURIComponent(message.id)}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const state = { phase: 'idle', rev: null, latest: meta.rev || 1, versions: [], doc: null, frame: null, bridge: null, listener: null, link: '', pointing: false, full: false, info: false, line: '', timer: 0, theme: null, observer: null, height: FRAME.heightBase, flash: 0 };

  const title = h('h4', { class: 'bots-app-title', text: meta.title || 'App' });
  const origin = h('p', { class: 'bots-app-origin' });
  const stage = h('div', { class: 'bots-app-stage' });
  const tools = h('div', { class: 'bots-app-tools' });
  const infoBox = h('div', { class: 'bots-app-info', hidden: true }, INFO.map(text => h('p', { text })));
  const lineBox = h('p', { class: 'bots-app-line', role: 'status', hidden: true });
  const linkBox = h('div', { class: 'bots-app-link', hidden: true });
  const card = h('div', { class: 'bots-app', 'data-state': 'idle', 'data-message-id': message.id || '' }, [
    h('div', { class: 'bots-app-head' }, [h('div', { class: 'bots-app-heading' }, [title, origin]), tools]), infoBox, lineBox, stage, linkBox]);

  const say = (text) => { state.line = text; lineBox.textContent = text; lineBox.hidden = !text; };
  function setPhase(phase, text = '') {
    state.phase = phase;
    card.dataset.state = phase;
    clearTimeout(state.timer);
    if (phase === 'loading') {
      state.timer = setTimeout(() => { if (state.phase === 'loading') stage.querySelector('.bots-app-spinner')?.removeAttribute('hidden'); }, FRAME.spinnerMs);
      stage.replaceChildren(h('div', { class: 'bots-app-placeholder' }, [h('span', { class: 'bots-spinner bots-app-spinner', hidden: true, 'aria-hidden': 'true' }), h('span', { text: 'Opening' })]));
    } else if (phase === 'idle' || phase === 'collapsed') {
      const open = h('button', { type: 'button', class: 'bots-btn', text: phase === 'idle' ? 'Open app' : 'Open again' });
      open.addEventListener('click', () => mountFrame());
      stage.replaceChildren(h('div', { class: 'bots-app-placeholder' }, [h('span', { text: phase === 'idle' ? 'This app is not running.' : 'Closed to save memory.' }), open]));
    } else if (phase === 'unavailable') {
      const retry = h('button', { type: 'button', class: 'bots-btn', text: 'Try again' });
      retry.addEventListener('click', () => mountFrame());
      stage.replaceChildren(h('div', { class: 'bots-app-placeholder', role: 'alert' }, [h('span', { text: text || 'This app could not be opened.' }), retry]));
    }
    drawTools();
  }

  // -- the toolbar -------------------------------------------------------------------------------------
  function drawTools() {
    const live = state.phase === 'live' || state.phase === 'loading';
    const rev = state.rev || state.latest;
    const prev = IconButton({ iconName: 'chevron-left', label: 'Older version', onClick: () => step(-1), disabled: !state.versions.length || rev <= (state.versions[0]?.rev || 1) });
    const next = IconButton({ iconName: 'chevron-right', label: 'Newer version', onClick: () => step(1), disabled: !state.versions.length || rev >= state.latest });
    const stepper = h('div', { class: 'bots-app-stepper', role: 'group', 'aria-label': 'Version' }, [prev, h('span', { class: 'bots-app-rev', text: `v${rev}${rev === state.latest ? ' latest' : ''}` }), next]);
    if (state.flash) stepper.append(h('span', { class: 'bots-app-updated', role: 'status', text: 'Updated' }));
    const pointButton = h('button', { type: 'button', class: 'bots-btn bots-app-point', 'aria-pressed': state.pointing ? 'true' : 'false', disabled: state.phase !== 'live' || undefined }, ['Point']);
    pointButton.addEventListener('click', () => setPointing(!state.pointing));
    const save = h('button', { type: 'button', class: 'bots-btn', disabled: state.doc ? undefined : true }, [icon('download', { size: 14 }), 'Save as file']);
    save.addEventListener('click', saveFile);
    const full = IconButton({ iconName: 'panel-right', label: state.full ? 'Leave full screen' : 'Full screen', onClick: toggleFull, disabled: !live });
    full.setAttribute('aria-pressed', state.full ? 'true' : 'false');
    const info = IconButton({ iconName: 'info', label: 'About this app', onClick: () => { state.info = !state.info; infoBox.hidden = !state.info; info.setAttribute('aria-expanded', String(state.info)); } });
    info.setAttribute('aria-expanded', String(state.info));
    const reload = IconButton({ iconName: 'refresh-cw', label: 'Reload', onClick: () => mountFrame(state.rev), disabled: state.phase === 'idle' });
    tools.replaceChildren(stepper, pointButton, save, full, reload, info);
    origin.textContent = `Made by ${ctx.botName || 'your bot'} · version ${rev}`;
  }

  // -- the page ----------------------------------------------------------------------------------------------
  async function fetchDoc(rev) {
    const key = `${ctx.sessionId}:${message.id}:${rev ?? 'latest'}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const res = await call(rev ? `?rev=${rev}` : '');
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail; } catch { /* no body */ }
      throw new Error(detail || 'This app could not be opened.');
    }
    const doc = await res.json();
    cache.set(key, doc);
    return doc;
  }
  function teardownFrame() {
    state.bridge?.destroy(); state.bridge = null;
    if (state.listener) { window.removeEventListener('message', state.listener); state.listener = null; }
    state.observer?.disconnect(); state.observer = null;
    state.frame?.remove(); state.frame = null;
    state.pointing = false;
  }
  async function mountFrame(rev) {
    teardownFrame();
    say('');
    setPhase('loading');
    let doc;
    try { doc = await fetchDoc(rev); } catch (error) { if (card.isConnected !== false) { setPhase('unavailable', error.message); } return; }
    state.doc = doc; state.rev = doc.rev; state.latest = doc.latest; state.versions = doc.versions || [];
    title.textContent = doc.title || title.textContent;
    const evicted = pool.touch(id);
    if (evicted && evicted !== id) document.dispatchEvent(new CustomEvent('kairos:bots-app-fold', { detail: { id: evicted } }));
    const channel = `c${Math.random().toString(36).slice(2, 12)}`;
    const frame = h('iframe', { class: 'bots-app-frame', title: doc.title || 'App', sandbox: SANDBOX, referrerpolicy: 'no-referrer', allow: '', loading: 'eager' });
    state.frame = frame;
    state.bridge = createBridge({
      getWindow: () => frame.contentWindow, channel, isPointing: () => state.pointing,
      onReady: () => { if (state.phase === 'loading') { setPhase('live'); stage.querySelector('.bots-app-placeholder')?.remove(); applyHeight(); } state.bridge?.post('ui/theme', resolveTheme()); },
      onMessage: text => rpc('ui/message', { text }),
      onContext: text => fetch(`/api/bot-widgets/${encodeURIComponent(ctx.sessionId)}/apps/${encodeURIComponent(message.id)}/context`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }),
      onOpen: url => offerLink(url),
      onSize: height => { state.height = frameHeight(height, { phone: phone(), viewport: innerHeight }); applyHeight(); },
      onPoint: pick => { addPointed({ ...pick, messageId: message.id }); setPointing(false); document.dispatchEvent(new CustomEvent('kairos:bots-focus-composer')); },
      onPointEnd: () => setPointing(false),
    });
    state.listener = event => state.bridge?.handle(event);
    window.addEventListener('message', state.listener);
    // The frame sits in the stage while it loads (hidden by CSS until the page says it is ready), so the page can run;
    // it is never moved afterwards, because moving a frame reloads it.
    frame.classList.add('is-loading');
    stage.append(frame);
    // The page comes from the server with its own policy header: the platform's policy forbids inline scripts, and a
    // srcdoc frame would inherit it. The frame is sandboxed without same-origin, so its address gives it no rights.
    frame.src = frameUrl(ctx.sessionId, message.id, doc.rev, channel);
    state.observer = new MutationObserver(() => state.bridge?.post('ui/theme', resolveTheme()));
    state.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    setTimeout(() => { if (state.phase === 'loading') { teardownFrame(); setPhase('unavailable', 'This app did not start.'); } }, 15_000);
  }
  const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;
  function applyHeight() {
    if (!state.frame) return;
    state.frame.style.height = `${phone() ? frameHeight(0, { phone: true, viewport: innerHeight }) : state.height}px`;
    state.frame.classList.remove('is-loading');
  }
  async function rpc(method, params) {
    const res = await (ctx.fetcher || fetch)(`/api/bot-widgets/${encodeURIComponent(ctx.sessionId)}/apps/${encodeURIComponent(message.id)}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    if (!res.ok) { let detail = ''; try { detail = (await res.json()).detail; } catch { /* none */ } say(detail || 'That did not go through.'); throw new Error(detail || 'refused'); }
    say('');
    return res.json();
  }
  // A link the page offers opens only after the person clicks it here, in Kairos.
  function offerLink(url) {
    const href = httpLink(url);
    if (!href) return;
    let host = href;
    try { host = new URL(href).hostname; } catch { /* kept as is */ }
    const go = h('button', { type: 'button', class: 'bots-btn' }, [icon('external-link', { size: 14 }), `Open ${host}`]);
    go.addEventListener('click', () => { window.open(href, '_blank', 'noopener,noreferrer'); linkBox.hidden = true; });
    const dismiss = IconButton({ iconName: 'x', label: 'Dismiss', onClick: () => { linkBox.hidden = true; } });
    linkBox.replaceChildren(h('span', { text: 'This app wants to open a link.' }), go, dismiss);
    linkBox.hidden = false;
  }
  function setPointing(on) {
    state.pointing = !!on && state.phase === 'live';
    state.bridge?.post('ui/point', { on: state.pointing });
    card.classList.toggle('is-pointing', state.pointing);
    drawTools();
  }
  async function step(delta) {
    const list = state.versions.map(v => v.rev);
    const at = list.indexOf(state.rev || state.latest);
    const target = list[at + delta];
    if (target) await mountFrame(target);
  }
  function saveFile() {
    if (!state.doc) return;
    const blob = new Blob([state.doc.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${(state.doc.title || 'app').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'app'}.html`, rel: 'noopener' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function toggleFull() {
    state.full = !state.full;
    card.classList.toggle('is-full', state.full);
    document.documentElement.classList.toggle('bots-app-full', state.full);
    drawTools();
  }
  // Escape ends Point first, then full screen.
  const onKey = event => {
    if (event.key !== 'Escape') return;
    if (state.pointing) { event.stopPropagation(); event.preventDefault(); setPointing(false); }
    else if (state.full) { event.stopPropagation(); event.preventDefault(); toggleFull(); }
  };
  document.addEventListener('keydown', onKey, true);
  const onFold = event => { if (event.detail?.id === id && (state.phase === 'live' || state.phase === 'loading')) { teardownFrame(); setPhase('collapsed'); } };
  document.addEventListener('kairos:bots-app-fold', onFold);

  // A new version while this row is open: flash "Updated" and follow it when the person is on the latest one.
  card.refreshMeta = nextMeta => {
    if (!nextMeta || nextMeta.rev <= state.latest) return;
    const followed = (state.rev || state.latest) === state.latest;
    state.latest = nextMeta.rev;
    state.flash = 1; drawTools();
    setTimeout(() => { state.flash = 0; drawTools(); }, FRAME.updatedMs);
    cache.clear();
    if (followed && state.phase === 'live') mountFrame();
  };

  setPhase('idle');
  // Open by itself when it is among the newest 20 rows and near the screen.
  if (typeof IntersectionObserver === 'function') {
    const watcher = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && state.phase === 'idle' && autoMounts(id)) { watcher.disconnect(); mountFrame(); }
    }, { rootMargin: `${FRAME.nearPx}px` });
    watcher.observe(card);
    card.addEventListener('bots-app-gone', () => watcher.disconnect());
  }
  card.destroy = () => {
    teardownFrame(); pool.release(id); rows.delete(id);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('kairos:bots-app-fold', onFold);
    document.documentElement.classList.remove('bots-app-full');
  };
  drawTools();
  return card;
}
