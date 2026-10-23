// The Design view's own composer (vault: Design Canvas (Build Spec), 3f and
// decision 5). Selected elements and pinned comments become chips here, and
// one message goes to the design's linked chat through the same live path as
// a foreign review (chatStream.startTurn), so it works from the Design tab,
// Library and the phone as well as from the chat. Each chip is sent as a
// design_comment reference that the server resolves and fences.
import { el, toast } from './api.js';
import { getInFlight, startTurn, subscribe } from './chatStream.js';

const keyOf = item => JSON.stringify([item.design_id, item.board, item.element_ids, item.comment || '', item.point || null]);

export function mountDesignComposer(host, { getSession, onStartChat, onOpenChat }) {
  let chips = [];
  let watching = null, unsubscribe = () => {};
  const list = el('div', { class: 'chat-reference-chips design-composer-chips', 'aria-label': 'Selected on the design' });
  const input = el('textarea', { class: 'design-composer-input', rows: '1', maxlength: '16000', placeholder: 'Describe the change',
    'aria-label': 'Message to the design chat' });
  const send = el('button', { type: 'button', class: 'btn primary design-composer-send', text: 'Send', onclick: () => submit() });
  const status = el('span', { class: 'meta design-composer-status', role: 'status' });
  const start = el('button', { type: 'button', class: 'btn quiet', text: 'Start a design chat', onclick: () => onStartChat?.() });
  const open = el('button', { type: 'button', class: 'btn quiet', text: 'Open chat', onclick: () => onOpenChat?.() });
  const root = el('div', { class: 'design-composer', role: 'group', 'aria-label': 'Ask for changes' }, [list,
    el('div', { class: 'design-composer-row' }, [input, send]), el('div', { class: 'design-composer-row design-composer-meta' }, [status, start, open])]);
  host.append(root);
  // In use (focused, or holding a draft or chips): the phone tab bar steps aside (mobileTabBar.js).
  const engaged = () => root.classList.toggle('is-active', root.contains(document.activeElement) || !!input.value.trim() || chips.length > 0);
  root.addEventListener('focusin', engaged); root.addEventListener('focusout', () => setTimeout(engaged, 0));
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; update(); });

  function paint() {
    list.replaceChildren(...chips.map(item => el('span', { class: 'chat-reference-chip design-select-chip' }, [
      el('span', { text: `Design · ${item.label}`, title: item.comment || 'Selected on the design' }),
      el('button', { type: 'button', text: '×', 'aria-label': `Remove ${item.label}`, onclick: () => { chips = chips.filter(c => c !== item); paint(); update(); } }),
    ])));
    list.hidden = !chips.length;
  }
  function update() {
    engaged();
    const session = getSession();
    const entry = session ? getInFlight(session.id) : null;
    const busy = entry?.status === 'processing';
    start.hidden = !!session; open.hidden = !session;
    input.disabled = !session; send.disabled = !session || busy || (!input.value.trim() && !chips.length);
    status.textContent = !session ? 'Link a chat to ask a model for changes.' : busy ? (entry.permission ? 'Needs approval in the chat' : 'Working...')
      : entry?.status === 'done' ? 'Done' : entry?.status === 'failed' ? `Failed: ${entry.error || 'try again'}` : `Sends to ${session.title}`;
    if (session && watching !== session.id) { unsubscribe(); watching = session.id; unsubscribe = subscribe(session.id, update); }
  }
  function submit() {
    const session = getSession();
    if (!session || send.disabled) return;
    const text = input.value.trim() || (chips.some(c => c.comment) ? 'Please apply these design comments.' : '');
    if (!text) { input.focus(); return; }
    try {
      startTurn(session.id, session.title, text, [], chips.map(c => ({ ...c })));
      chips = []; input.value = ''; input.style.height = ''; paint(); update();
    } catch (error) { toast(error.message, 'error'); }
  }
  paint(); update();
  return {
    root, update,
    // An unsent message or chips (the leave guard asks before they are lost).
    hasDraft: () => !!input.value.trim() || chips.length > 0,
    // Replace the previous selection chip (one live selection at a time).
    setSelection(item, previous) {
      if (previous) chips = chips.filter(c => keyOf(c) !== keyOf(previous));
      if (item && !chips.some(c => keyOf(c) === keyOf(item))) chips.push(item);
      if (chips.length > 10) { chips = chips.slice(-10); toast('At most 10 selections or comments per message', 'error'); }
      paint(); update(); if (item) input.focus({ preventScroll: true });
    },
    addComments(items) {
      for (const item of items) if (!chips.some(c => keyOf(c) === keyOf(item))) chips.push(item);
      chips = chips.slice(-10); paint(); update(); input.focus();
    },
    dispose() { unsubscribe(); root.remove(); },
  };
}
