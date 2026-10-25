// Panels that take over the notch's left card (Kairos Notch build spec, 4a,
// phase 2), drawn to the boards NotchQuestion and NotchError: an approval, a
// question, a terminal pairing (never answered here), an error, recovering
// and done. The notch shell decides which one shows (highest priority
// first); this module only draws one and sends its answer.
//
// Security (spec section 6), all enforced here:
// - Everything a request carries is text (textContent), as permissionPrompt.js.
// - An answer is only ever a deliberate pointer click on a button: a keyboard
//   activation, a synthetic click or a click in the first 400 ms after the
//   panel appears (or the notch opens on it) does nothing. Collapsing, hovering
//   or closing a panel never answers; the server denies on silence.
// - A terminal pairing prompt shows "Open Kairos" only.
// - "Always" states its scope in words and defaults to this chat.
// - A second answer (409) or an expired request says so instead of acting.
import { createMascot, KAIROS_SPEC } from './mascot.js';

export const CLICK_GUARD_MS = 400;
export const CLI_TOOL = 'kairos_cli_pair';

// A click that may answer: real, from a pointer, and not too soon.
export function acceptsClick(event, shownAt, now = performance.now()) {
  return !!event && event.isTrusted !== false && event.detail > 0 && now - shownAt >= CLICK_GUARD_MS;
}

// The choices an approval offers in the notch: once, always in this chat
// (when the request has a scope), reject. "Always allow" for every chat stays
// in the app, so the notch's Always is this conversation by default. A folder
// grant (core/notch_folders.py) is already once, always and reject.
export function notchChoices(request) {
  const choices = Array.isArray(request?.choices) ? request.choices : [];
  if (!choices.some(choice => choice.scope === 'session') || request.tool === 'folder_access') return choices;
  return choices.filter(choice => choice.scope !== 'forever');
}

export function countdown(expiresAt, now = Date.now()) {
  const left = Math.max(0, Math.round(expiresAt * 1000 - now) / 1000);
  return `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
}

const RETRY = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>';

function build(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// One panel's frame: Kip, the words, the buttons, and a status line.
function frame({ key, kind, kip, glow, label, role = 'dialog' }) {
  const node = build('section', 'n-panel');
  node.dataset.kind = kind;
  node.setAttribute('role', role);
  node.setAttribute('aria-label', label);
  const face = createMascot({ state: kip, size: 64, spec: KAIROS_SPEC });
  face.classList.add('n-panel-kip');
  const copy = build('div', 'n-panel-copy'), actions = build('div', 'n-panel-actions');
  const note = build('div', 'n-panel-note'); note.setAttribute('role', 'status');
  node.append(face, copy, actions);
  copy.append(note);
  const panel = { key, kind, kip, glow, node, copy, actions, note, face, shownAt: performance.now(), closed: false, timers: [],
    line(className, text) { if (text) copy.insertBefore(build('div', className, text), note); },
    setKip(state) { panel.kip = state; face.setAttribute('state', state); },
    dispose() { for (const timer of panel.timers) clearInterval(timer); panel.onDispose?.(); },
    button(text, { tone = '', aria, icon, guard = true } = {}, onClick) {
      const button = build('button', `n-act${tone ? ' n-act-' + tone : ''}`, icon ? undefined : text);
      button.type = 'button';
      if (icon) button.innerHTML = icon;
      if (aria) button.setAttribute('aria-label', aria);
      else button.title = text;  // a long scope reads in full on hover
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (guard && !acceptsClick(event, panel.shownAt)) return;
        onClick(event);
      });
      return button;
    },
    lock(on) { for (const button of node.querySelectorAll('.n-act')) button.disabled = on; },
    say(text, tone = '') { note.textContent = text; note.dataset.tone = tone; },
  };
  return panel;
}

async function send(deps, url, body) {
  try { return await deps.post(url, body); } catch { return { ok: false, status: 0 }; }
}

// A terminal pairing (core/cli_access.py): only the app window approves it.
export function cliPanel(request, deps) {
  const panel = frame({ key: `cli:${request.id}`, kind: 'cli', kip: 'needs', glow: 'gold', label: 'A terminal wants to use Kairos' });
  panel.line('n-eyebrow', 'Terminal · waiting in Kairos');
  panel.line('n-panel-title', 'A terminal wants to use Kairos');
  panel.line('n-panel-detail', 'Approve terminals only in the Kairos window, where you can compare the words it shows.');
  panel.actions.append(panel.button('Open Kairos', { tone: 'gold', guard: false }, () => deps.openApp()));
  return panel;
}

export function approvalPanel(request, { title, sessionId }, deps) {
  if (request.tool === CLI_TOOL) return cliPanel(request, deps);
  const folder = request.tool === 'folder_access';
  const panel = frame({ key: `approval:${request.id}`, kind: 'approval', kip: 'needs', glow: 'gold',
    label: folder ? 'Allow Kairos to read a folder?' : `${title || 'A chat'} needs your approval` });
  panel.line('n-eyebrow', folder ? 'Dropped folder · needs your answer' : `${title || 'Chat'} · needs your approval`);
  panel.line('n-panel-title', request.title || request.tool);
  if (!folder && request.target) panel.line('n-panel-target', request.target);
  panel.line('n-panel-detail', folder ? request.description : `Tool: ${request.tool}`);
  const expired = () => request.expires_at && request.expires_at * 1000 <= Date.now();
  const tick = () => {
    if (panel.closed) return;
    if (expired()) { panel.closed = true; panel.lock(true); panel.setKip('idle'); panel.say('This request has expired.', 'muted'); return; }
    if (request.expires_at) panel.say(`Answer within ${countdown(request.expires_at)}`);
  };
  async function answer(choice) {
    if (panel.closed || panel.busy) return;
    if (expired()) { tick(); return; }
    panel.busy = true; panel.lock(true); panel.say('Sending…');
    const response = await send(deps, `/api/permissions/${encodeURIComponent(request.id)}/answer`, { choice: choice.id });
    panel.busy = false;
    if (response.ok) {
      panel.closed = true;
      panel.say(choice.behavior === 'deny' ? 'Rejected.' : 'Allowed.', choice.behavior === 'deny' ? 'muted' : 'good');
      deps.answered?.(request.id, choice);
    } else if (response.status === 409) {
      panel.closed = true;
      panel.say(expired() ? 'This request has expired.' : 'This was already answered.', 'muted');
    } else if (response.status === 404 || response.status === 403) {
      panel.closed = true;
      panel.say('Open Kairos to answer this request.', 'muted');
    } else {
      panel.lock(false); panel.say('The answer did not reach Kairos. Try again.', 'bad');
    }
  }
  for (const choice of notchChoices(request)) {
    const tone = choice.behavior === 'deny' ? 'quiet' : choice.scope === 'once' || choice.id === 'once' ? 'gold' : '';
    const button = panel.button(choice.label, { tone }, () => answer(choice));
    button.dataset.choice = choice.id;
    panel.actions.append(button);
  }
  if (!folder && sessionId) panel.actions.append(panel.button('Open chat', { tone: 'link', guard: false }, () => deps.openChat(sessionId)));
  tick();
  panel.timers.push(setInterval(tick, 1000));
  return panel;
}

// ask_user: one question with options, or one line of text. More than that
// (several questions, or several picks) is answered in the chat.
export function questionPanel(request, { title, sessionId }, deps) {
  const panel = frame({ key: `question:${request.id}`, kind: 'question', kip: 'needs', glow: 'gold', label: `${title || 'A chat'} needs your answer` });
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const question = questions[0] || { question: 'A question is waiting.', options: [] };
  panel.line('n-eyebrow', `${title || 'Chat'} · waiting for your response`);
  panel.line('n-panel-title', question.question);
  const simple = questions.length === 1 && !question.multiSelect;
  const expired = () => request.expires_at && request.expires_at * 1000 <= Date.now();
  if (!simple) {
    panel.line('n-panel-detail', questions.length > 1 ? `${questions.length} questions. Answer them in the chat.` : 'Answer this one in the chat.');
    if (sessionId) panel.actions.append(panel.button('Open chat', { tone: 'gold', guard: false }, () => deps.openChat(sessionId)));
    return panel;
  }
  let picked = null;
  const options = build('div', 'n-options');
  const other = build('input', 'n-other');
  other.type = 'text'; other.maxLength = 4000; other.hidden = true;
  other.setAttribute('aria-label', 'Your answer');
  const select = (button, label) => {
    picked = label;
    for (const node of options.querySelectorAll('.n-opt')) node.setAttribute('aria-pressed', String(node === button));
    other.hidden = label !== null;
  };
  for (const option of question.options || []) {
    const button = panel.button(option.label, {}, () => select(button, option.label));
    button.classList.add('n-opt'); button.setAttribute('aria-pressed', 'false');
    if (option.description) button.title = option.description;
    options.append(button);
  }
  const otherButton = panel.button('Other…', {}, () => {
    select(otherButton, null); other.hidden = false;
    // Typing needs the window's keyboard, only while this line is open.
    deps.focus(true); other.focus();
  });
  otherButton.classList.add('n-opt', 'n-opt-other'); otherButton.setAttribute('aria-pressed', 'false');
  options.append(otherButton);
  panel.copy.insertBefore(options, panel.note);
  panel.copy.insertBefore(other, panel.note);
  panel.onDispose = () => { if (!other.hidden) deps.focus(false); };
  panel.sticky = () => !other.hidden;
  async function respond(body) {
    if (panel.closed || panel.busy) return;
    if (expired()) { panel.closed = true; panel.lock(true); panel.say('This question has expired.', 'muted'); return; }
    panel.busy = true; panel.lock(true); panel.say('Sending…');
    const response = await send(deps, `/api/permissions/${encodeURIComponent(request.id)}/respond`, body);
    panel.busy = false;
    if (response.ok) { panel.closed = true; panel.say(body.skip ? 'Skipped.' : 'Answered.', 'good'); if (!other.hidden) deps.focus(false); }
    else if (response.status === 409) { panel.closed = true; panel.say(expired() ? 'This question has expired.' : 'This was already answered.', 'muted'); }
    else if (response.status === 404) { panel.closed = true; panel.say('Open Kairos to answer this question.', 'muted'); }
    else { panel.lock(false); panel.say('The answer did not reach Kairos. Try again.', 'bad'); }
  }
  const sendButton = panel.button('Send', { tone: 'gold' }, () => {
    const value = picked ?? other.value.trim();
    if (!value) { panel.say('Pick an answer or write one first.', 'muted'); return; }
    respond({ answers: { [question.question]: value } });
  });
  panel.actions.append(sendButton, panel.button('Skip', { tone: 'quiet' }, () => respond({ skip: true })));
  other.addEventListener('keydown', event => { if (event.key === 'Escape') { other.hidden = true; deps.focus(false); } });
  if (request.expires_at) panel.say(`Answer within ${Math.max(1, Math.round((request.expires_at * 1000 - Date.now()) / 60000))} min`);
  return panel;
}

// Fixed copy only; a raw exception never reaches the notch. Retry exists only
// where it is safe (re-reading usage, reconnecting); a failed chat turn opens
// the chat, where "Retry with another model" lives.
export function errorPanel({ key, title, reason, note, retry, sessionId }, deps) {
  const panel = frame({ key, kind: 'error', kip: 'error', glow: 'ember', label: title, role: 'alert' });
  panel.line('n-panel-title', title);
  panel.line('n-panel-reason', reason);
  panel.line('n-panel-detail', note);
  if (retry) {
    panel.actions.append(panel.button('Retry', { tone: 'round', aria: 'Retry', icon: RETRY }, async () => {
      panel.lock(true); panel.say('Trying again…');
      const ok = await retry().catch(() => false);
      panel.lock(false); panel.say(ok ? 'Done.' : 'Still not working. Try again shortly.', ok ? 'good' : 'muted');
    }));
  } else if (sessionId) {
    panel.actions.append(panel.button('Open chat', { tone: 'gold', guard: false }, () => { deps.openChat(sessionId); deps.dismiss(key); }));
  }
  panel.actions.append(panel.button('Dismiss', { tone: 'link', guard: false }, () => deps.dismiss(key)));
  return panel;
}

export function recoveringPanel({ key, line, sessionId }, deps) {
  const panel = frame({ key, kind: 'recovering', kip: 'sleeping', glow: 'recover', label: 'Kairos is recovering' });
  const typed = build('div', 'n-panel-title');
  panel.copy.insertBefore(typed, panel.note);
  // Typed in at 30 ms a character, at most 900 ms; still under reduced motion.
  const still = deps.reducedMotion();
  const step = Math.min(30, 900 / Math.max(1, line.length));
  let shown = still ? line.length : 0;
  typed.textContent = line.slice(0, shown);
  if (!still) {
    const timer = setInterval(() => { shown += 1; typed.textContent = line.slice(0, shown); if (shown >= line.length) clearInterval(timer); }, step);
    panel.timers.push(timer);
  }
  typed.setAttribute('aria-label', line);
  panel.actions.append(panel.button('Open', { tone: 'gold', guard: false }, () => (sessionId ? deps.openChat(sessionId) : deps.openApp())),
    panel.button('Dismiss', { tone: 'link', guard: false }, () => deps.dismiss(key)));
  return panel;
}

export function donePanel({ key, title, sessionId }, deps) {
  const panel = frame({ key, kind: 'done', kip: 'success', glow: 'sage', label: 'Reply ready', role: 'status' });
  panel.line('n-panel-title', 'Reply ready');
  panel.line('n-panel-detail', title);
  panel.actions.append(panel.button('Open', { tone: 'gold', guard: false }, () => { deps.openChat(sessionId); deps.dismiss(key); }));
  // Kip plays its success once, then rests (mascot.js); the panel keeps the pose.
  panel.face.addEventListener('mascot-settled', event => event.preventDefault());
  return panel;
}

// Where the current panel lives: one at a time, kept while its key holds, so
// a re-render never restarts its 400 ms guard or its countdown. `want` is
// { key, make } or null; a panel is built only when the key changes. `frame`
// is what shows and hides with it (the card around the slot).
export function createTakeover(slot, frame = slot) {
  let current = null;
  return {
    get panel() { return current; },
    show(want) {
      if ((want?.key ?? null) === (current?.key ?? null)) return current;
      current?.dispose();
      current = want ? want.make() : null;
      slot.replaceChildren(...(current ? [current.node] : []));
      frame.hidden = !current;
      if (current) current.shownAt = performance.now();
      return current;
    },
    // The notch opened onto this panel: it appears now, so the guard restarts.
    revealed() { if (current) current.shownAt = performance.now(); },
  };
}
