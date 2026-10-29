// Per-message controls for a Bots conversation (Phase 1, U3): the action tray,
// reactions, version switcher, reply quote, citations and the inline editor.
//
// Plain DOM builders over data. No imports besides the Bots kit, so the
// decisions (which actions a message offers) run in plain Node.
import { icon } from './botsIcons.js';
import { openMenu } from './botsUi.js';

export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) if (child) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

// One of six per person per message (the server keeps the same set).
export const REACTIONS = Object.freeze([
  { emoji: '\u{1F44D}', label: 'Thumbs up' }, { emoji: '\u{1F44E}', label: 'Thumbs down' }, { emoji: '❤️', label: 'Heart' },
  { emoji: '\u{1F602}', label: 'Laugh' }, { emoji: '\u{1F389}', label: 'Celebrate' }, { emoji: '\u{1F440}', label: 'Eyes' },
]);

// One reaction per person per message: choosing another moves it. Returns the new [{emoji, count, mine}].
export function applyReaction(reactions = [], emoji, on) {
  let list = reactions.map(r => ({ ...r }));
  if (on) {
    list = list.map(r => (r.mine && r.emoji !== emoji ? { ...r, mine: false, count: r.count - 1 } : r));
    const at = list.findIndex(r => r.emoji === emoji);
    if (at < 0) list.push({ emoji, count: 1, mine: true });
    else if (!list[at].mine) list[at] = { ...list[at], mine: true, count: list[at].count + 1 };
  } else list = list.map(r => (r.emoji === emoji && r.mine ? { ...r, mine: false, count: r.count - 1 } : r));
  return list.filter(r => r.count > 0);
}

// Which actions a message offers. ctx: { busy, lastAssistantId, pinnedId, canSpeak, raw }.
// Edit and Regenerate are refused by the server while a turn runs, so they are disabled, not hidden.
export function actionList(message, ctx = {}) {
  const user = message.role === 'user', bot = message.role === 'assistant';
  const pinned = ctx.pinnedId === message.id;
  const list = [
    { id: 'reply', label: 'Reply', iconName: 'undo-2', primary: true },
    { id: 'react', label: 'React', text: '☺', primary: true },
    { id: 'copy', label: 'Copy', iconName: 'copy', primary: true },
    { id: 'pin', label: pinned ? 'Unpin' : 'Pin', iconName: 'pin' },
  ];
  if (user) list.push({ id: 'edit', label: 'Edit', iconName: 'pencil', disabled: !!ctx.busy, hint: ctx.busy ? 'Wait for the reply to finish' : '' });
  if (bot && ctx.lastAssistantId === message.id) list.push({ id: 'regenerate', label: 'Regenerate', iconName: 'refresh-cw', disabled: !!ctx.busy, hint: ctx.busy ? 'Wait for the reply to finish' : '' });
  if (bot && ctx.canSpeak) list.push({ id: 'speak', label: 'Speak', iconName: 'mic' });
  list.push({ id: 'raw', label: ctx.raw ? 'Show formatted' : 'Show raw Markdown', iconName: 'eye' });
  list.push({ id: 'copy-id', label: 'Copy message ID', iconName: 'copy' });
  // Phase 6: a redacted problem report about this reply, drafted and kept on this computer (botsReport.js).
  if (bot) list.push({ id: 'report', label: 'Report a problem', iconName: 'triangle-alert' });
  return list;
}

// handlers: { reply, react(emoji), copy, pin, edit, regenerate, speak, raw, 'copy-id' } (each gets the message).
export function messageTray(message, ctx, handlers) {
  const actions = actionList(message, ctx);
  const tray = h('div', { class: 'bots-msg-tray', role: 'toolbar', 'aria-label': 'Message actions' });
  const run = action => { if (!action.disabled) handlers[action.id]?.(message); };
  for (const action of actions.filter(a => a.primary)) {
    const label = action.label;
    const button = h('button', { type: 'button', class: 'bots-msg-act', 'data-act': action.id, 'aria-label': label, title: label },
      [action.iconName ? icon(action.iconName, { size: 15 }) : h('span', { text: action.text, 'aria-hidden': 'true' })]);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (action.id === 'react') openReactionMenu(button, message, handlers.react);
      else run(action);
    });
    tray.append(button);
  }
  const more = h('button', { type: 'button', class: 'bots-msg-act', 'data-act': 'more', 'aria-label': 'More actions', title: 'More actions', 'aria-haspopup': 'menu' }, [icon('ellipsis', { size: 15 })]);
  more.addEventListener('click', event => {
    event.stopPropagation();
    openMenu(more, actions.filter(a => !a.primary).map(a => ({ label: a.label, iconName: a.iconName, meta: a.hint, disabled: a.disabled, onSelect: () => run(a) })), { align: 'end' });
  });
  tray.append(more);
  return tray;
}

function openReactionMenu(anchor, message, react) {
  const mine = new Set((message.reactions || []).filter(r => r.mine).map(r => r.emoji));
  openMenu(anchor, REACTIONS.map(r => ({ label: `${r.emoji}  ${r.label}`, checked: mine.has(r.emoji), onSelect: () => react?.(message, r.emoji, !mine.has(r.emoji)) })));
}

// Touch: a tap, or a 450 ms press, opens the tray; another tap on the message closes it.
export function touchTray(card) {
  let timer = null, fired = false;
  const open = on => card.toggleAttribute('data-tray-open', on);
  card.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    fired = false; clearTimeout(timer);
    timer = setTimeout(() => { fired = true; open(true); }, 450);
  });
  const cancel = () => clearTimeout(timer);
  card.addEventListener('pointerup', cancel); card.addEventListener('pointercancel', cancel); card.addEventListener('pointermove', cancel);
  card.addEventListener('click', event => {
    if (event.pointerType !== 'touch' && !matchMedia('(pointer: coarse)').matches) return;
    if (event.target.closest('a, button, summary, textarea, input')) return;
    if (fired) { fired = false; return; }
    open(!card.hasAttribute('data-tray-open'));
  });
}

// Reaction chips: server state is [{emoji, count, mine}]. A chip toggles the person's own.
export function reactionBar(message, react) {
  const list = (message.reactions || []).filter(r => r.count > 0);
  if (!list.length) return null;
  return h('div', { class: 'bots-reactions', role: 'group', 'aria-label': 'Reactions' }, list.map(r => h('button', {
    type: 'button', class: `bots-reaction${r.mine ? ' mine' : ''}`, 'aria-pressed': String(!!r.mine),
    'aria-label': `${REACTIONS.find(x => x.emoji === r.emoji)?.label || r.emoji}, ${r.count}${r.mine ? ', yours' : ''}`,
    onclick: () => react?.(message, r.emoji, !r.mine),
  }, [h('span', { text: r.emoji, 'aria-hidden': 'true' }), h('span', { class: 'bots-reaction-count', text: String(r.count) })])));
}

// A message with other versions shows n/m and steps between them (the server selects the branch).
export function versionSwitcher(message, select) {
  const v = message.version;
  if (!v || !(v.count > 1) || !Array.isArray(v.ids)) return null;
  const step = delta => { const id = v.ids[v.index + delta]; if (id) select?.(id, message); };
  return h('div', { class: 'bots-versions', role: 'group', 'aria-label': 'Versions of this message' }, [
    h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Previous version', disabled: v.index <= 0, onclick: () => step(-1) }, [icon('chevron-left', { size: 14 })]),
    h('span', { class: 'bots-versions-count', text: `${v.index + 1}/${v.count}`, 'aria-live': 'polite' }),
    h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Next version', disabled: v.index >= v.count - 1, onclick: () => step(1) }, [icon('chevron-right', { size: 14 })]),
  ]);
}

export function replyQuote(message, lookup, jump) {
  if (!message.reply_to_id && !message.reply_to) return null;
  const known = message.reply_to || lookup?.(message.reply_to_id);
  const author = known?.role === 'user' ? 'You' : known?.author || (known?.role === 'assistant' ? 'Bot' : 'Earlier message');
  const snippet = String(known?.snippet ?? known?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return h('button', { type: 'button', class: 'bots-reply-quote', 'aria-label': `In reply to ${author}`, onclick: () => jump?.(message.reply_to_id || known?.id) },
    [h('span', { class: 'bots-reply-author', text: author }), h('span', { class: 'bots-reply-snippet', text: snippet || 'This message is not loaded' })]);
}

export function citationBadges(message, goTo) {
  const list = Array.isArray(message.citations) ? message.citations : [];
  if (!list.length) return null;
  return h('div', { class: 'bots-citations' }, list.map(c => h('div', { class: 'bots-citation' }, [
    h('blockquote', { text: String(c.quote || '').slice(0, 400) }),
    c.comment ? h('p', { class: 'bots-citation-comment', text: String(c.comment) }) : null,
    c.source_id ? h('button', { type: 'button', class: 'bots-link', text: 'Go to source', onclick: () => goTo?.(c.source_id) }) : null,
  ])));
}

// In-place editor for a user message. sendKey is the composer's key policy.
export function userEditor(message, { onSubmit, onCancel, isSendKey }) {
  const input = h('textarea', { class: 'bots-bubble-editor', rows: '3', 'aria-label': 'Edit your message', dir: 'auto' });
  input.value = message.content || '';
  const save = h('button', { type: 'button', class: 'bots-btn primary', text: 'Send edit', onclick: () => submit() });
  const cancel = h('button', { type: 'button', class: 'bots-btn', text: 'Cancel', onclick: () => onCancel?.() });
  const error = h('div', { class: 'bots-send-error', role: 'alert', hidden: true });
  let busy = false;
  async function submit() {
    const text = input.value.trim();
    if (busy || !text || text === String(message.content || '').trim()) { if (!busy && text === String(message.content || '').trim()) onCancel?.(); return; }
    busy = true; save.disabled = true; error.hidden = true;
    try { await onSubmit?.(text); }
    catch (problem) { error.textContent = problem.message || 'The edit could not be sent.'; error.hidden = false; busy = false; save.disabled = false; }
  }
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel?.(); }
    else if (isSendKey?.(event)) { event.preventDefault(); submit(); }
  });
  const node = h('div', { class: 'bots-editor' }, [input, error, h('div', { class: 'bots-editor-actions' }, [cancel, save])]);
  return { node, focus: () => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } };
}

// Select text inside a message and a small Cite pill appears; it opens a comment box.
// onCite({ message_id, quote, comment }) receives the finished citation.
export function watchCitations(root, onCite) {
  const pill = h('button', { type: 'button', class: 'bots-cite-pill', text: 'Cite', hidden: true });
  const box = h('div', { class: 'bots-cite-box', role: 'dialog', 'aria-label': 'Add a quote', hidden: true });
  document.body.append(pill, box);
  let pending = null;
  const hide = () => { pill.hidden = true; };
  const closeBox = () => { box.hidden = true; box.replaceChildren(); pending = null; };
  const read = () => {
    const sel = document.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const start = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest?.('[data-message-id] .bots-msg-body');
    const end = (range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement)?.closest?.('[data-message-id] .bots-msg-body');
    const quote = sel.toString().trim().slice(0, 12000);
    if (!start || start !== end || !quote || !root.contains(start)) return null;
    return { message_id: start.closest('[data-message-id]').dataset.messageId, quote, box: range.getBoundingClientRect() };
  };
  const onSelect = () => {
    if (!box.hidden) return;
    const found = read();
    if (!found) { hide(); return; }
    pending = found;
    pill.hidden = false;
    pill.style.left = `${Math.max(8, Math.min(innerWidth - 64, found.box.left))}px`;
    pill.style.top = `${Math.max(8, found.box.top - 36)}px`;
  };
  pill.addEventListener('mousedown', event => event.preventDefault());
  pill.addEventListener('click', () => {
    if (!pending) return;
    const found = pending; hide();
    const comment = h('textarea', { rows: '2', maxlength: '4000', 'aria-label': 'Comment on this quote (optional)', placeholder: 'Add a comment (optional)' });
    const add = h('button', { type: 'button', class: 'bots-btn primary', text: 'Add quote', onclick: () => { closeBox(); onCite({ message_id: found.message_id, quote: found.quote, comment: comment.value.trim().slice(0, 4000) }); } });
    box.replaceChildren(h('blockquote', { text: found.quote.slice(0, 200) }), comment, h('div', { class: 'bots-editor-actions' }, [h('button', { type: 'button', class: 'bots-btn', text: 'Cancel', onclick: closeBox }), add]));
    box.style.left = pill.style.left; box.style.top = pill.style.top; box.hidden = false; comment.focus();
  });
  box.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeBox(); } });
  document.addEventListener('selectionchange', onSelect);
  return () => { document.removeEventListener('selectionchange', onSelect); pill.remove(); box.remove(); };
}
