// A bot rings you inside Kairos (services/rings.py). Every open window polls for rings addressed to this user and shows an
// incoming-call sheet with Answer and Decline, a ring tone, and, when the window is not in front, a desktop notification.
// Answer opens that bot's call screen with the reason it rang as the call's opening (agentCall.js takes the pending ring).
// The phone push (static/sw.js) opens the app at /?agent=...&ring=..., which comes here through answerRingFromLink.
import { api, toast } from './api.js';

// Every 6 s while the window shows; every 18 s (every third tick) while it is hidden (minimised), so a ring still
// reaches the desktop notification well inside its 60 s. The same reply says whether a call to someone else is going,
// so the outbound call panel (outboundCallHost.js) needs no poll of its own while nothing is (2026-11-09: an idle chat
// made 22 reads per 30 s with this at 3 s and the outbound panel's own 5 s poll; the shell's budget is 14).
export const POLL_MS = 6000;
export const HIDDEN_POLL_MS = 18000;
let pending = null;   // the ring just answered, waiting for its call screen: {id, agentId, reason, name}

export function setPendingRing(ring) { pending = ring && { ...ring, at: Date.now() }; }
export function takePendingRing(agentId) {
  if (pending && Date.now() - pending.at > 120000) pending = null;   // an answer that never reached its call screen
  if (!pending || pending.agentId !== agentId) return null;
  const ring = pending; pending = null; return ring;
}

export const copyFor = ring => ({ title: `${ring.bot_name} is calling`, body: ring.reason });

// Answer: tell the server, remember the ring for the call screen, and go to the bot. `via` 'link' (a push notification's
// Answer or its deep link) answers only a ring that is still ringing; it never turns into a call back.
export async function answerRing(id, doc = document, via = '') {
  const answered = await api(`/api/rings/${id}/answer${via === 'link' ? '?via=link' : ''}`, { method: 'POST', toast: false });
  const ring = { id: answered.ring_id, agentId: answered.agent_id, reason: answered.reason, name: answered.bot_name };
  setPendingRing(ring);
  doc.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: answered.target }));
  doc.dispatchEvent(new CustomEvent('kairos:ring-answered', { detail: { agentId: ring.agentId } }));
  return answered;
}

export const declineRing = id => api(`/api/rings/${id}/decline`, { method: 'POST', toast: false }).catch(() => {});

// A deep link is used once (2026-11-10): the rings it answered are remembered on this device, so a reload, Back or a
// second tap on an old notification never answers again; and it carries when the ring stops (`exp`), after which it
// does nothing but say the call ended.
const USED_KEY = 'kairos:answered-rings';
function usedRings(storage) { try { const list = JSON.parse(storage?.getItem(USED_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } }
export function linkUsed(id, storage = globalThis.localStorage) { return usedRings(storage).some(item => item?.id === id); }
function markUsed(id, storage, now) {
  try { storage?.setItem(USED_KEY, JSON.stringify([...usedRings(storage).filter(item => item?.id !== id && now - (item?.at || 0) < 86400000), { id, at: now }].slice(-20))); } catch { /* lasts this page */ }
}

// A push notification or link: /?agent=..&ring=<id>&exp=<unix seconds>. Answers once, with no extra tap: the call screen
// opens and picks up (agentCall.js takes the pending ring). Returns true when it answered; false sends the caller on to
// open the bot as an ordinary link.
export async function answerRingFromLink(id, notify = message => toast(message), { exp = null, storage = globalThis.localStorage, now = Date.now(), answer = ringId => answerRing(ringId, document, 'link') } = {}) {
  try { history.replaceState(null, '', '/'); } catch { /* optional */ }
  if (linkUsed(id, storage)) return false;
  markUsed(id, storage, now);
  if (exp != null && Number.isFinite(Number(exp)) && Number(exp) * 1000 < now) { notify('That call has ended. Check your inbox for the missed call.'); return false; }
  try { await answer(id); return true; }
  catch { notify('That call has ended. Check your inbox for the missed call.'); return false; }
}

// A short two-pulse ring, repeated while the sheet is up. Browsers may refuse audio before the person has touched the page.
function createTone(AudioContext) {
  let context = null, timer = null;
  const pulse = (at, frequency) => {
    const osc = context.createOscillator(), gain = context.createGain();
    osc.type = 'sine'; osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.18, at + 0.03); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    osc.connect(gain); gain.connect(context.destination); osc.start(at); osc.stop(at + 0.4);
  };
  const ring = () => { try { context.resume?.(); pulse(context.currentTime, 880); pulse(context.currentTime + 0.45, 660); } catch { /* sound is a courtesy */ } };
  return {
    start() { if (timer || !AudioContext) return; try { context = new AudioContext(); } catch { return; } ring(); timer = setInterval(ring, 2400); },
    stop() { clearInterval(timer); timer = null; try { context?.close?.(); } catch { /* already closed */ } context = null; },
  };
}

export function createRingHost({ document: doc = document, api: request = api, Notification: Note = typeof Notification === 'undefined' ? null : Notification,
  AudioContext: Audio = typeof window === 'undefined' ? null : (window.AudioContext || window.webkitAudioContext), focus = () => { window.jarvis?.showWindow?.(); window.focus?.(); },
  answer = id => answerRing(id, doc), decline = declineRing, hasFocus = () => doc.hasFocus?.(), isHidden = () => !!doc.hidden,
  now = () => Date.now(), onResult = () => {} } = {}) {
  const shown = new Map();   // ring id -> {sheet, note}
  const tone = createTone(Audio);
  let timer = null, busy = false, stopped = false, lastAt = 0;

  const make = (tag, props = {}, children = []) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) { if (key === 'text') node.textContent = value; else if (key === 'class') node.className = value; else node.setAttribute(key, value); }
    node.append(...children);
    return node;
  };

  function sheetFor(ring) {
    const { title, body } = copyFor(ring);
    const accept = make('button', { type: 'button', class: 'btn primary ring-answer', text: 'Answer' });
    const reject = make('button', { type: 'button', class: 'btn ring-decline', text: 'Decline' });
    const sheet = make('div', { class: 'ring-sheet', role: 'alertdialog', 'aria-live': 'assertive', 'aria-label': title, 'data-ring': ring.id }, [
      make('div', { class: 'ring-text' }, [make('strong', { class: 'ring-title', text: title }), make('span', { class: 'ring-reason', text: body })]),
      make('div', { class: 'ring-actions' }, [reject, accept]),
    ]);
    accept.addEventListener('click', () => { close(ring.id); answer(ring.id).catch(() => {}); });
    reject.addEventListener('click', () => { close(ring.id); decline(ring.id); });
    return sheet;
  }

  function open(ring) {
    const sheet = sheetFor(ring);
    let note = null;
    if (Note && Note.permission === 'granted' && !hasFocus()) {
      try {
        const { title, body } = copyFor(ring);
        note = new Note(title, { body, tag: 'kairos-ring-' + ring.id, silent: false, requireInteraction: true });
        note.onclick = () => { focus(); close(ring.id); answer(ring.id).catch(() => {}); note.close?.(); };
      } catch { note = null; }
    } else if (Note && Note.permission === 'default') { try { Note.requestPermission(); } catch { /* optional */ } }
    shown.set(ring.id, { sheet, note });
    doc.body.append(sheet);
    tone.start();
  }

  function close(id) {
    const entry = shown.get(id);
    if (!entry) return;
    shown.delete(id);
    entry.sheet.remove?.();
    try { entry.note?.close?.(); } catch { /* already gone */ }
    if (!shown.size) tone.stop();
  }

  async function poll() {
    if (busy || stopped) return;
    busy = true; lastAt = now();
    try {
      const reply = await request('/api/rings/pending', { toast: false });
      const rings = reply?.rings || [];
      const ids = new Set(rings.map(ring => ring.id));
      for (const id of [...shown.keys()]) if (!ids.has(id)) close(id);
      for (const ring of rings) if (!shown.has(ring.id)) open(ring);
      try { onResult(reply); } catch { /* a listener's problem is not the ring's */ }
    } catch { /* offline or signed out: the next poll tries again */ }
    finally { busy = false; }
  }
  // The timer's tick: hidden, it reads only every HIDDEN_POLL_MS.
  const tick = () => { if (!isHidden() || now() - lastAt >= HIDDEN_POLL_MS - 500) poll(); };   // 500 ms for timer drift
  // Shown again after a while hidden: read now rather than wait for the next tick.
  const onVisible = () => { if (!isHidden() && now() - lastAt >= POLL_MS) poll(); };

  return {
    start() { if (timer) return; stopped = false; poll(); timer = setInterval(tick, POLL_MS); doc.addEventListener?.('visibilitychange', onVisible); },
    stop() { stopped = true; clearInterval(timer); timer = null; doc.removeEventListener?.('visibilitychange', onVisible); for (const id of [...shown.keys()]) close(id); },
    poll, tick, shown,
  };
}

let host = null;
// Each reply is announced as 'kairos:rings-polled' with `outbound` (calls to other people going now, or undefined
// from an older server), which the outbound call panel listens for.
export function mountRingHost() {
  if (!host) {
    host = createRingHost({ onResult: reply => document.dispatchEvent(new CustomEvent('kairos:rings-polled', { detail: { outbound: reply?.outbound } })) });
    host.start();
  }
  return host;
}
