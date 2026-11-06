// A bot rings you inside Kairos (services/rings.py). Every open window polls for rings addressed to this user and shows an
// incoming-call sheet with Answer and Decline, a ring tone, and, when the window is not in front, a desktop notification.
// Answer opens that bot's call screen with the reason it rang as the call's opening (agentCall.js takes the pending ring).
// The phone push (static/sw.js) opens the app at /?agent=...&ring=..., which comes here through answerRingFromLink.
import { api, toast } from './api.js';

export const POLL_MS = 3000;
let pending = null;   // the ring just answered, waiting for its call screen: {id, agentId, reason, name}

export function setPendingRing(ring) { pending = ring && { ...ring, at: Date.now() }; }
export function takePendingRing(agentId) {
  if (pending && Date.now() - pending.at > 120000) pending = null;   // an answer that never reached its call screen
  if (!pending || pending.agentId !== agentId) return null;
  const ring = pending; pending = null; return ring;
}

export const copyFor = ring => ({ title: `${ring.bot_name} is calling`, body: ring.reason });

// Answer: tell the server, remember the ring for the call screen, and go to the bot.
export async function answerRing(id, doc = document) {
  const answered = await api(`/api/rings/${id}/answer`, { method: 'POST', toast: false });
  const ring = { id: answered.ring_id, agentId: answered.agent_id, reason: answered.reason, name: answered.bot_name };
  setPendingRing(ring);
  doc.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: answered.target }));
  doc.dispatchEvent(new CustomEvent('kairos:ring-answered', { detail: { agentId: ring.agentId } }));
  return answered;
}

export const declineRing = id => api(`/api/rings/${id}/decline`, { method: 'POST', toast: false }).catch(() => {});

// A push notification or link: /?agent=..&ring=<id>. Returns true when the link was a ring (answered or not).
export async function answerRingFromLink(id, notify = message => toast(message)) {
  try { await answerRing(id); } catch { notify('That call has ended. Check your inbox for the missed call.'); }
  try { history.replaceState(null, '', '/'); } catch { /* optional */ }
  return true;
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
  answer = id => answerRing(id, doc), decline = declineRing, hasFocus = () => doc.hasFocus?.() } = {}) {
  const shown = new Map();   // ring id -> {sheet, note}
  const tone = createTone(Audio);
  let timer = null, busy = false, stopped = false;

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
    busy = true;
    try {
      const { rings = [] } = await request('/api/rings/pending', { toast: false });
      const ids = new Set(rings.map(ring => ring.id));
      for (const id of [...shown.keys()]) if (!ids.has(id)) close(id);
      for (const ring of rings) if (!shown.has(ring.id)) open(ring);
    } catch { /* offline or signed out: the next poll tries again */ }
    finally { busy = false; }
  }

  return {
    start() { if (timer) return; stopped = false; poll(); timer = setInterval(poll, POLL_MS); },
    stop() { stopped = true; clearInterval(timer); timer = null; for (const id of [...shown.keys()]) close(id); },
    poll, shown,
  };
}

let host = null;
export function mountRingHost() { if (!host) { host = createRingHost(); host.start(); } return host; }
