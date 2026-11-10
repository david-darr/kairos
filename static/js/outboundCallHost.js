// A bot phoning someone else for you (services/outbound_calls.py, build spec step 9). While a call is being dialled or
// held, every open window shows a small live panel: the transcript as it happens, any question the bot asks you (answer
// it right there; the bot tells the other party), and Hang up. When the call ends the panel says so and shows the summary,
// which also lands in the bot's conversation. A desktop notification marks a new question when the window is not in front.
import { api } from './api.js';

export const LIVE_POLL_MS = 1500;
export const IDLE_POLL_MS = 5000;
// While no call is going and no panel is up, this host makes no reads of its own: the ring poll (ringHost.js) carries
// the count of calls going (`outbound`), and `nudge(count)` starts polling here when it is above zero (2026-11-09).

const STATUS = { dialing: 'Ringing', live: 'On the call', ended: 'Ended' };

export function speakerLabel(line, call) {
  return { bot: call.bot_name || 'Bot', them: call.who || 'Them', you: 'You', question: `${call.bot_name || 'Bot'} asks you`,
           note: 'Note' }[line.who] || line.who;
}

export function createOutboundCallHost({ document: doc = document, api: request = api,
  Notification: Note = typeof Notification === 'undefined' ? null : Notification, hasFocus = () => doc.hasFocus?.(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) } = {}) {
  const panels = new Map();       // call id -> {node, parts, lines, questions}
  const dismissed = new Set();
  const notified = new Set();
  let timer = null, busy = false, stopped = true;

  const make = (tag, props = {}, children = []) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(Boolean));
    return node;
  };

  function questionForm(call, question) {
    const input = make('input', { type: 'text', class: 'outcall-answer-input', maxlength: '500', 'aria-label': `Your answer: ${question.text}`,
      placeholder: 'Your answer' });
    const status = make('span', { class: 'outcall-answer-status', role: 'status' });
    const send = make('button', { type: 'button', class: 'btn primary outcall-answer-send', text: 'Send' });
    const submit = async () => {
      const answer = input.value.trim();
      if (!answer) { input.focus(); return; }
      send.disabled = true; status.textContent = '';
      try {
        const updated = await request(`/api/phone/outbound/${call.id}/answer`, { method: 'POST', toast: false,
          body: JSON.stringify({ question_id: question.id, answer }) });
        draw(updated);
      } catch (error) { status.textContent = (error && error.message) || 'That answer could not be sent.'; send.disabled = false; }
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
    return make('div', { class: 'outcall-question', 'data-question': question.id }, [
      make('strong', { class: 'outcall-question-text', text: question.text }),
      make('div', { class: 'outcall-answer' }, [input, send]), status]);
  }

  function build(call) {
    const title = make('strong', { class: 'outcall-title' });
    const state = make('span', { class: 'outcall-state' });
    const transcript = make('ol', { class: 'outcall-transcript', 'aria-label': 'Live transcript', 'aria-live': 'polite' });
    const questions = make('div', { class: 'outcall-questions' });
    const summary = make('p', { class: 'outcall-summary' });
    const hang = make('button', { type: 'button', class: 'btn danger outcall-hangup', text: 'Hang up' });
    const close = make('button', { type: 'button', class: 'btn quiet outcall-close', text: 'Close' });
    hang.addEventListener('click', async () => {
      hang.disabled = true;
      try { draw(await request(`/api/phone/outbound/${call.id}/hangup`, { method: 'POST', toast: false })); }
      catch { hang.disabled = false; }
    });
    close.addEventListener('click', () => { dismissed.add(call.id); remove(call.id); });
    const node = make('section', { class: 'outcall-panel', role: 'region', 'aria-label': 'Call in progress', 'data-call': call.id }, [
      make('header', { class: 'outcall-head' }, [make('div', { class: 'outcall-heading' }, [title, state]), close]),
      make('p', { class: 'outcall-meta' }), transcript, questions, summary,
      make('div', { class: 'outcall-actions' }, [hang]),
    ]);
    const entry = { node, parts: { title, state, transcript, questions, summary, hang, meta: node.querySelector('.outcall-meta') },
                    lines: 0, asked: '' };
    panels.set(call.id, entry);
    (doc.querySelector('.outcall-stack') || doc.body.appendChild(make('div', { class: 'outcall-stack' }))).append(node);
    return entry;
  }

  function draw(call) {
    if (!call || dismissed.has(call.id)) return;
    const entry = panels.get(call.id) || build(call);
    const { parts } = entry;
    parts.title.textContent = `${call.bot_name || 'Your bot'} is calling ${call.who}`;
    if (call.status === 'ended') parts.title.textContent = `${call.bot_name || 'Your bot'} called ${call.who}`;
    parts.state.textContent = STATUS[call.status] || call.status;
    parts.state.dataset.state = call.status;
    parts.meta.textContent = `${call.to} · ${call.topic}`;
    const lines = call.transcript || [];
    if (lines.length < entry.lines) { parts.transcript.replaceChildren(); entry.lines = 0; }
    for (const line of lines.slice(entry.lines)) {
      parts.transcript.append(make('li', { class: `outcall-line outcall-${line.who}` }, [
        make('span', { class: 'outcall-who', text: speakerLabel(line, call) }), make('span', { class: 'outcall-text', text: line.text })]));
    }
    entry.lines = lines.length;
    if (lines.length) parts.transcript.scrollTop = parts.transcript.scrollHeight;
    const waiting = (call.questions || []).filter(q => q.status === 'waiting' && call.status === 'live');
    const key = waiting.map(q => q.id).join(',');
    if (key !== entry.asked) {
      entry.asked = key;
      parts.questions.replaceChildren(...waiting.map(q => questionForm(call, q)));
      for (const q of waiting) notify(call, q);
    }
    parts.hang.hidden = call.status === 'ended';
    parts.summary.hidden = call.status !== 'ended';
    if (call.status === 'ended') {
      parts.summary.textContent = call.summary_state === 'pending' ? 'Writing the summary...'
        : call.summary || call.end_reason || 'The call ended. The summary is in the bot\'s conversation.';
    }
  }

  function notify(call, question) {
    if (notified.has(question.id)) return;
    notified.add(question.id);
    if (!Note || Note.permission !== 'granted' || hasFocus()) return;
    try { new Note(`${call.bot_name || 'Your bot'} asks you`, { body: question.text, tag: 'kairos-outcall-' + question.id }); }
    catch { /* a notification is a courtesy */ }
  }

  function remove(id) {
    const entry = panels.get(id);
    if (!entry) return;
    panels.delete(id);
    entry.node.remove();
  }

  async function poll() {
    if (busy || stopped) return;
    busy = true;
    let live = false, followUp = false;
    try {
      const { calls = [] } = await request('/api/phone/outbound/active', { toast: false });
      const ids = new Set(calls.map(c => c.id));
      for (const id of [...panels.keys()]) {
        const entry = panels.get(id);
        if (!ids.has(id) && entry.parts.state.dataset.state === 'ended' && !entry.keep) remove(id);
      }
      for (const call of calls) {
        if (call.status !== 'ended' || panels.has(call.id)) draw(call);
        if (call.status !== 'ended') live = true;
      }
      followUp = live || calls.length > 0 || panels.size > 0;
    } catch { followUp = panels.size > 0; /* offline or signed out: the next ring poll's nudge, or a panel's poll, tries again */ }
    finally { busy = false; }
    clearTimer(timer); timer = null;
    if (!stopped && followUp) timer = setTimer(poll, live ? LIVE_POLL_MS : IDLE_POLL_MS);
  }

  return {
    start() { if (!stopped) return; stopped = false; poll(); },
    // The ring poll's word on calls going: above zero, or unknown (an older server), read now unless a read is due.
    nudge(count) { if (stopped || busy || timer) return; if (count === undefined || count > 0) poll(); },
    stop() { stopped = true; clearTimer(timer); timer = null; for (const id of [...panels.keys()]) remove(id); },
    // Settings > Phone opens a past or live call here.
    async show(id) {
      dismissed.delete(id);
      const call = await request(`/api/phone/outbound/${id}`, { toast: false });
      draw(call);
      const entry = panels.get(id);
      if (entry) { entry.keep = true; entry.node.scrollIntoView?.({ block: 'nearest' }); }
      if (!timer && !busy) poll();   // keep the panel current while it is up
      return call;
    },
    poll, panels, draw,
  };
}

let host = null;
export function mountOutboundCallHost() {
  if (!host) {
    host = createOutboundCallHost(); host.start();
    document.addEventListener('kairos:rings-polled', event => host.nudge(event.detail?.outbound));
  }
  return host;
}
export function showOutboundCall(id) { return mountOutboundCallHost().show(id); }
