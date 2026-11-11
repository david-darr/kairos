import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';
import { createMascot } from './mascot.js';
import { callIcon } from './callIcons.js';

// The minimized call (call screen redesign, 2026-11-10): a small pill on top of every screen with the bot's animated
// mascot, its name, the timer, Mute and Hang up. Tapping it returns to the full call. A dot appears when the bot posts
// in its chat; the dot opens that chat. On a desktop it can be dragged to any corner (remembered); on a phone it docks
// at the bottom, above the composer or bottom bar. It never sits over a composer it can see.
const CORNER_KEY = 'kairos:call-pill-corner';
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
// What the pill keeps clear of when it sits at the bottom.
const BOTTOM_THINGS = '.bots-composer, .chat-input-bar, .side-chat-composer, .forge-composer, .bots-call-avoid';
// Modal sheets (2026-11-10): the pill stays visible over them, never on their panel. A page-level sheet (Settings'
// .modal-backdrop) is outranked by z-index; a modal <dialog> sits in the browser's top layer, so the pill moves inside it
// while it is open (anything outside a modal dialog cannot be clicked), and back when it closes.
const MODAL_PANELS = '.modal-backdrop:not(.hidden) > *';
const overlaps = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

export function mountCallBar({ agent, members = null, snapshot, mute, hangup, restore, openChat }) {
  const styled = loadBotsCss('/static/css/bots-voice.css');
  const label = `${members ? 'Group call in' : 'Call with'} ${agent.name}`;
  const root = h('section', { class: 'call-pill', 'data-section': 'call', 'aria-label': label, title: members?.length ? `With ${members.join(', ')}` : label });
  const face = createMascot({ agent: agent.roomId ? undefined : agent, state: 'idle' });
  const name = h('span', { class: 'call-pill-name', text: agent.name });
  const clock = h('span', { class: 'call-pill-clock', 'data-call-clock': '', role: 'timer' });
  let dragged = false, drag = null, lastMuted = null, lastState = '', destroyed = false;
  const back = h('button', { type: 'button', class: 'call-pill-back', 'aria-label': `Return to call with ${agent.name}` },
    [h('span', { class: 'call-pill-face' }, [face]), h('span', { class: 'call-pill-text' }, [name, clock])]);
  back.addEventListener('click', event => { if (dragged) { event.preventDefault(); return; } restore(); });
  const dot = h('button', { type: 'button', class: 'call-pill-unread', hidden: true, 'aria-label': `New message from ${agent.name}. Open the chat`, title: 'New message' });
  dot.addEventListener('click', () => openChat?.());
  const muteButton = h('button', { type: 'button', class: 'call-pill-key', 'data-call': 'mute', 'aria-label': 'Mute' });
  muteButton.addEventListener('click', () => mute());
  const end = h('button', { type: 'button', class: 'call-pill-key is-end', 'data-call': 'hangup', 'aria-label': 'Hang up' }, [callIcon('hangup', 20)]);
  end.addEventListener('click', () => hangup());
  const safe = h('span', { class: 'call-pill-safe', 'aria-hidden': 'true' });
  root.append(back, dot, muteButton, end, safe);
  // Unseen until its stylesheet is in, so it never flashes unplaced at the end of the page.
  root.style.visibility = 'hidden';
  document.body.append(root);
  Promise.resolve(styled).then(() => { root.style.visibility = ''; place(); });
  let corner = (() => { try { const saved = localStorage.getItem(CORNER_KEY); return CORNERS.includes(saved) ? saved : 'bottom-right'; } catch { return 'bottom-right'; } })();
  const phone = () => innerWidth < 768;

  // The topmost open modal <dialog> other than the call screen itself, if any.
  const topDialog = () => [...document.querySelectorAll('dialog[open]')].filter(node => !node.classList.contains('agent-call') && !root.contains(node)
    && (() => { try { return node.matches(':modal'); } catch { return false; } })()).at(-1) || null;
  // Where the pill goes: its corner, lifted above anything at the bottom it would cover; over a modal sheet, the first
  // corner that keeps it off the sheet's panel.
  function spot(at, r, gap, safeBottom) {
    const left = phone() ? gap : at.endsWith('left') ? gap : innerWidth - r.width - gap;
    let top;
    if (!phone() && at.startsWith('top')) top = 72;
    else {
      top = innerHeight - r.height - gap - safeBottom;
      for (const node of document.querySelectorAll(BOTTOM_THINGS)) {
        if (root.contains(node) || !node.getClientRects().length) continue;
        const box = node.getBoundingClientRect();
        if (!box.height || box.bottom < innerHeight - 260 || box.right <= left || box.left >= left + r.width) continue;
        if (box.top < top + r.height + 8) top = Math.min(top, box.top - r.height - 8);
      }
      top = Math.max(8, top);
    }
    return { left: Math.round(Math.max(gap, Math.min(left, innerWidth - r.width - gap))), top: Math.round(top) };
  }
  function place() {
    // Never after destroy(): a frame queued by the page's mutations (or the stylesheet arriving) would put it back.
    if (destroyed || root.hasAttribute('data-dragging')) return;
    const host = topDialog() || document.body;
    if (root.parentNode !== host) host.append(root);
    const panels = [...document.querySelectorAll(MODAL_PANELS)].filter(node => !root.contains(node) && node.getClientRects().length).map(node => node.getBoundingClientRect());
    if (host !== document.body) panels.push(host.getBoundingClientRect());
    root.toggleAttribute('data-over-modal', host !== document.body || panels.length > 0);
    if (root.hidden) return;
    const r = root.getBoundingClientRect(), gap = phone() ? 12 : 16, safeBottom = safe.offsetHeight;
    root.dataset.corner = phone() ? 'bottom' : corner;
    let chosen = spot(corner, r, gap, safeBottom);
    if (panels.length && !phone()) {
      const clear = at => { const p = spot(at, r, gap, safeBottom), box = { left: p.left, top: p.top, right: p.left + r.width, bottom: p.top + r.height }; return panels.some(panel => overlaps(box, panel)) ? null : p; };
      const free = [corner, ...CORNERS.filter(at => at !== corner)].map(clear).find(Boolean);
      if (free) chosen = free;
      else {
        // No free corner (a sheet as wide as the window): sit just above the sheet's top edge, else at the very top.
        const sheetTop = Math.min(...panels.map(panel => panel.top));
        chosen = { left: chosen.left, top: Math.round(Math.max(8, sheetTop - r.height - 8)) };
      }
    }
    root.style.left = `${chosen.left}px`; root.style.top = `${chosen.top}px`;
  }
  // A sheet opening or closing re-places the pill at once (Settings toggles its scrim's class; dialogs their open).
  let queued = false;
  const watched = { attributes: true, attributeFilter: ['open', 'class'] };
  const watch = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes || []) if (node.matches?.('.modal-backdrop, dialog')) watch.observe(node, watched);
    if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; place(); });
  });
  watch.observe(document.body, { childList: true, attributes: true, attributeFilter: ['open', 'class'], subtree: false });
  for (const node of document.querySelectorAll('body > .modal-backdrop, body > dialog')) watch.observe(node, watched);
  function refresh() {
    if (destroyed) return;
    const state = snapshot();
    const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    root.hidden = !state.active || !state.minimized;
    root.dataset.state = state.state || 'idle';
    if (state.state && state.state !== lastState) { face.setAttribute('state', state.state); lastState = state.state; }
    if (state.muted !== lastMuted) {
      lastMuted = state.muted; muteButton.setAttribute('aria-pressed', String(!!state.muted));
      muteButton.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute'); muteButton.replaceChildren(callIcon(state.muted ? 'micOff' : 'mic', 20));
    }
    dot.hidden = !state.unread; root.toggleAttribute('data-unread', !!state.unread);
    place();
  }
  // Drag to a corner (a desktop with a pointer); a short move is still a tap.
  back.addEventListener('pointerdown', event => {
    if (phone() || event.button !== 0) return;
    const r = root.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: event.clientX - r.left, dy: event.clientY - r.top }; dragged = false;
  });
  back.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!dragged && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    if (!dragged) { dragged = true; root.dataset.dragging = ''; try { back.setPointerCapture(event.pointerId); } catch { /* a pointer the page no longer holds */ } }
    root.style.left = `${event.clientX - drag.dx}px`; root.style.top = `${event.clientY - drag.dy}px`;
  });
  const drop = event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null; delete root.dataset.dragging;
    if (!dragged) return;
    const r = root.getBoundingClientRect();
    corner = `${r.top + r.height / 2 < innerHeight / 2 ? 'top' : 'bottom'}-${r.left + r.width / 2 < innerWidth / 2 ? 'left' : 'right'}`;
    try { localStorage.setItem(CORNER_KEY, corner); } catch { /* lasts this call */ }
    place(); setTimeout(() => { dragged = false; }, 0);
  };
  back.addEventListener('pointerup', drop); back.addEventListener('pointercancel', drop);
  const key = event => {
    if (event.repeat || !snapshot().active || !snapshot().minimized || !(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
    if (event.key.toLowerCase() === 'm') { event.preventDefault(); mute(); }
    if (event.key.toLowerCase() === 'h') { event.preventDefault(); hangup(); }
  };
  document.addEventListener('keydown', key);
  addEventListener('resize', place);
  const timer = setInterval(refresh, 1000); refresh();
  return {
    root, refresh, place,
    level(name, value) { root.style.setProperty(name, value); },
    destroy() { destroyed = true; clearInterval(timer); watch.disconnect(); document.removeEventListener('keydown', key); removeEventListener('resize', place); root.remove(); },
  };
}

export async function mountLiveSettings(host, ctx = {}) {
  loadBotsCss('/static/css/bots-voice.css');
  const abort = new AbortController(); let dead = false;
  const root = h('section', { class: 'bots-live-settings', 'data-section': 'bot-voice' }); host.replaceChildren(root);
  async function refresh() {
    root.replaceChildren(h('p', { text: 'Loading call settings...' }));
    try {
      const data = await api('/api/bot-voice/live-settings', { signal: abort.signal, toast: false }); if (dead) return;
      const voice = h('select', { 'aria-label': 'Live voice' }, ['marin', 'cedar', 'coral', 'sage', 'ash'].map(value => h('option', { value, text: value })));
      voice.value = data.voice;
      const typed = h('input', { type: 'checkbox', 'aria-label': 'Read typed replies' }); typed.checked = data.read_typed;
      const idle = h('input', { type: 'number', min: 1, max: 60, value: data.idle_minutes, 'aria-label': 'Idle minutes' });
      const status = h('p', { role: 'status' });
      const save = Button({ label: 'Save', onClick: async () => {
        if (!idle.checkValidity()) { idle.reportValidity(); return; }
        save.disabled = true;
        try { const settings = await api('/api/bot-voice/live-settings', { method: 'PUT', signal: abort.signal, toast: false, body: JSON.stringify({ voice: voice.value, read_typed: typed.checked, idle_minutes: Number(idle.value) }) });
          if (!dead) { status.textContent = 'Saved'; document.dispatchEvent(new CustomEvent('kairos:bots-live-settings', { detail: settings })); }
        } catch { if (!dead) status.textContent = 'Call settings could not save. Try again.'; } finally { save.disabled = false; }
      } });
      root.replaceChildren(h('h2', { text: 'Voice' }), h('p', { text: 'Voice changes apply to your next call.' }), h('label', {}, [h('span', { text: 'Live voice' }), voice]),
        h('label', {}, [h('span', { text: 'Read typed replies' }), typed]), h('label', {}, [h('span', { text: 'End an idle call after minutes' }), idle]), save, status);
    } catch { if (!dead) root.replaceChildren(h('p', { text: 'Call settings could not load.' }), Button({ label: 'Retry', onClick: refresh })); }
  }
  const destroy = () => { dead = true; abort.abort(); root.remove(); };
  ctx.signal?.addEventListener('abort', destroy, { once: true }); refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}
