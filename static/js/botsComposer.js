// The composer of a Bots conversation (Phase 1, U3): three forms (Simple desktop pill,
// Advanced card, phone pill), one key policy, one send controller.
//
// The top half is pure and runs in plain Node (scripts/test_bots_composer.cjs): the key policy,
// the round button's job, placeholders, slash and mention menus, the queue labels and the
// redaction behind the support draft. mountBotsComposer draws it and only imports the Bots kit.
import { h } from './botsMessageActions.js';
import { icon } from './botsIcons.js';
import { openMenu } from './botsUi.js';
import { isComposingKey } from './composerKeyboard.js';
import { stagedStrip } from './botsChatAttachments.js';

export const STEER_WINDOW_MS = 1500;
export const SEND_KEYS = ['enter', 'shift-enter', 'mod-enter'];

// -- Pure: keys ------------------------------------------------------------------
// The person's send key. IME composition never sends. On a phone Enter is a newline unless the person chose otherwise.
export function sendKey(event, { phone = false, preference = 'enter' } = {}) {
  if (event.key !== 'Enter' || event.defaultPrevented || isComposingKey(event) || event.altKey) return false;
  if (preference === 'mod-enter') return !!(event.metaKey || event.ctrlKey) && !event.shiftKey;
  if (preference === 'shift-enter') return !!event.shiftKey && !event.metaKey && !event.ctrlKey;
  return !phone && !event.shiftKey && !event.metaKey && !event.ctrlKey;
}
// A second Enter on an empty field, soon after the first, while the bot works: steer.
export const isSteerChord = ({ empty, busy, lastEnter, now }) => !!empty && !!busy && lastEnter > 0 && now - lastEnter <= STEER_WINDOW_MS;
// Escape does one thing, in this order: close a menu, stop dictation, cancel a reply, nothing.
export function escapeAction({ menuOpen = false, dictating = false, replying = false } = {}) {
  return menuOpen ? 'menu' : dictating ? 'dictation' : replying ? 'reply' : null;
}

// -- Pure: the round button, the placeholder ------------------------------------------
// Call when empty and idle, Send with content, Stop when empty and busy. With content while busy it queues.
export function primarySlot({ content = false, busy = false, uploading = false, locked = false, canCall = false } = {}) {
  if (content) return { kind: busy ? 'queue' : 'send', label: busy ? 'Queue' : 'Send', disabled: locked || uploading };
  if (busy) return { kind: 'stop', label: 'Stop', disabled: false };
  return { kind: 'call', label: 'Call', disabled: locked || !canCall };
}
export function placeholderFor({ name, locked = false, lockedReason = '', uploading = false, replying = false, goal = false, busy = false } = {}) {
  if (locked) return lockedReason || 'Answer the question above to continue';
  if (uploading) return 'Uploading files';
  if (replying) return 'Write your reply';
  if (goal) return `Tell ${name} the goal`;
  if (busy) return `Message ${name}. It joins the queue.`;
  return `Message ${name}`;
}
// What the hint under the field says while a turn runs. Steering interrupts: no provider can take it mid-turn.
export function busyHint({ queued = 0 } = {}) {
  return queued ? 'Messages wait their turn. Steer interrupts the reply and sends now.' : 'New messages wait their turn. Press Enter twice to interrupt and send now.';
}
export const steerLabel = (count, index) => (index === 0 ? (count > 1 ? 'Steer all' : 'Steer') : 'Steer next');

// -- Pure: slash and mention menus ------------------------------------------------------
export const RESERVED = ['goal', 'learn', 'setup'];
// `/` at the start of the field. Built-ins shadow skills of the same name.
export function slashItems(text, skills = []) {
  const m = /^\/([a-z0-9-]*)$/i.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  const builtins = [
    { id: 'goal', label: '/goal', hint: 'Work until done', kind: 'command' },
    { id: 'learn', label: '/learn', hint: 'Teach this bot a new skill', kind: 'command' },
    { id: 'setup', label: '/setup', hint: 'Set this bot up', kind: 'command' },
  ];
  const extra = skills.filter(s => s?.name && !RESERVED.includes(s.name)).map(s => ({ id: s.name, label: `/${s.name}`, hint: s.description || 'Skill', kind: 'skill' }));
  return [...builtins, ...extra].filter(item => item.id.startsWith(q));
}
// The @ token under the caret. It starts after whitespace or opening punctuation; `/@bot` is a URL path; code spans are ignored.
export function mentionToken(text, caret = text.length) {
  const head = text.slice(0, caret);
  if ((head.match(/`/g) || []).length % 2 === 1 || /```(?![\s\S]*```)/.test(head)) return null;
  const m = /(^|[\s([{"'])@([\w-]*)$/.exec(head);
  if (!m) return null;
  return { query: m[2], start: head.length - m[2].length - 1, end: caret };
}
// Other bots only: rooms and people appear when those engines exist. The last row is Kairos Support.
export function mentionItems(token, bots = [], selfId = '') {
  if (!token) return [];
  const q = token.query.toLowerCase();
  const key = b => String(b.name || '').toLowerCase();
  const rows = bots.filter(b => b.id !== selfId && !b.hidden && (key(b).startsWith(q) || key(b).replace(/\s+/g, '-').startsWith(q)))
    .map(b => ({ id: b.id, label: `@${String(b.name).replace(/\s+/g, '-')}`, hint: b.role || 'Bot', kind: 'bot', name: b.name }));
  if ('support'.startsWith(q)) rows.push({ id: 'support', label: '@support', hint: 'Draft a note for Kairos Support', kind: 'support' });
  return rows;
}

// -- Pure: the support draft -----------------------------------------------------------------
// A redacted copy the person reads, edits and sends themselves. Nothing here leaves the app.
export function redactForSupport(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:sk|pk|xox[a-z]|ghp|gho|ghs|AKIA)[A-Za-z0-9_-]{8,}\b/g, '[key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [token]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, '$1[user]').replace(/(\/(?:Users|home)\/)[^/\s]+/g, '$1[user]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]');
}

// -- The send controller ------------------------------------------------------------------------
// flushSettings must resolve {ok:true}. request(payload) throws an error with .status for an HTTP refusal.
// A refusal frees the draft; a lost connection leaves the receipt so Retry reuses its send ID.
export const isDefiniteRefusal = error => Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
// extras() adds what rides with a send but is not typed (botsDrafts.js prepare); it is read once, when a send is prepared.
export function createSendController({ draft, flushSettings, request, getLeaf, onAccepted = () => {}, extras = () => ({}) }) {
  let running = null;
  return {
    busy: () => !!running,
    send() {
      if (running) return running;
      running = (async () => {
        // A failed settings save must not let a turn start with unintended settings; the draft is untouched.
        const saved = await flushSettings();
        if (saved?.ok !== true) throw new Error(saved?.error || 'Save the bot settings before sending.');
        const ticket = draft.prepare(getLeaf(), extras());
        let result;
        try { result = await request(ticket.payload); }
        catch (error) { if (isDefiniteRefusal(error)) draft.rejected(ticket); throw error; }
        draft.accepted(ticket);
        await onAccepted(result, ticket);
        return result;
      })().finally(() => { running = null; });
      return running;
    },
  };
}

// -- The composer ---------------------------------------------------------------------------------
// options: draft, name, form() -> 'simple'|'advanced'|'phone', submit(), stop(), openCall (or null), steer(), uploader,
//   queue { edit, remove, steer, resume }, mentions(), skills(), onSupport(), onNotice(text), onEditLast(), onEscape(),
//   onDictate(), capabilities() -> {steer}, modelLabel(), sendPreference, now, onChange(draft)
export function mountBotsComposer(host, o) {
  const { draft, name } = o;
  const now = o.now || (() => Date.now());
  let busy = false, locked = false, lockedReason = '', disposed = false, lastEnter = 0, dictating = false, queue = { items: [], paused: false };
  let menu = null, menuItems = [], menuAt = 0, sending = false;
  const phoneMedia = typeof matchMedia === 'function' ? matchMedia('(max-width: 768px)') : { matches: false, addEventListener() {}, removeEventListener() {} };
  const form = () => o.form?.() || (phoneMedia.matches ? 'phone' : 'simple');

  const input = h('textarea', { class: 'bots-composer-input', rows: '1', dir: 'auto', 'aria-label': `Message ${name}`, 'aria-autocomplete': 'list' });
  const error = h('div', { class: 'bots-send-error', role: 'alert', hidden: true });
  const outbox = h('div', { class: 'bots-outbox', hidden: true });
  const context = h('div', { class: 'bots-composer-context' });
  const queueStrip = h('div', { class: 'bots-queue', role: 'group', 'aria-label': 'Queued messages', 'aria-live': 'polite', hidden: true });
  const staged = h('div', { class: 'bots-staged-row', 'aria-label': 'Attached files', hidden: true });
  const hint = h('div', { class: 'bots-composer-hint', hidden: true });
  const plus = h('button', { type: 'button', class: 'bots-icon-btn bots-composer-plus', 'aria-label': 'Add', 'aria-haspopup': 'menu', title: 'Add' }, [icon('plus', { size: 18 })]);
  const clip = h('button', { type: 'button', class: 'bots-icon-btn bots-composer-clip', 'aria-label': 'Attach files', title: 'Attach files', onclick: () => picker.click() }, [icon('paperclip', { size: 18 })]);
  const picker = h('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Choose files' });
  const goalChip = h('button', { type: 'button', class: 'bots-goal-chip', 'aria-pressed': 'false', text: 'Work until done', onclick: () => toggleGoal() });
  const access = h('span', { class: 'bots-pill bots-composer-access', text: 'Full access', title: 'Bots run with full access for now' });
  const modelLabel = h('span', { class: 'bots-pill bots-composer-model', hidden: true });
  const mic = h('button', { type: 'button', class: 'bots-icon-btn bots-composer-mic', 'aria-label': 'Dictate a message', title: 'Dictate', hidden: !o.onDictate, onclick: () => Promise.resolve(o.onDictate?.(state => { dictating = !!state; })).catch(showError) }, [icon('mic', { size: 18 })]);
  const callSlot = h('span', { class: 'bots-composer-call' });
  const stopButton = h('button', { type: 'button', class: 'bots-btn bots-composer-stop', text: 'Stop', hidden: true, onclick: () => stop() }, []);
  const primary = h('button', { type: 'button', class: 'bots-composer-primary' });
  const listbox = h('div', { class: 'bots-composer-menu', role: 'listbox', 'aria-label': 'Suggestions', hidden: true });
  const row = h('div', { class: 'bots-composer-row' }, [plus, clip, input, mic, callSlot, stopButton, primary]);
  const tools = h('div', { class: 'bots-composer-tools' }, [goalChip, access, modelLabel]);
  const root = h('div', { class: 'bots-composer', 'data-form': form() }, [outbox, context, queueStrip, staged, error, hint, listbox, tools, row, picker]);
  host.append(root);

  const toggleGoal = () => { draft.update({ mode: draft.read().mode === 'goal' ? 'chat' : 'goal' }); paint(); };
  const showError = problem => { error.textContent = problem?.message || String(problem); error.hidden = false; };
  const say = text => (o.onNotice ? o.onNotice(text) : showError(new Error(text)));
  const stop = () => Promise.resolve(o.stop?.()).catch(showError);
  const hasContent = () => { const d = draft.read(); return !!d.text.trim() || d.attachment_ids.length > 0 || !!o.uploader?.ids().length; };
  const uploading = () => !!o.uploader?.busy();

  // -- Menus (slash, mention, the plus) --------------------------------------------
  function closeMenu() { menu = null; menuItems = []; listbox.hidden = true; listbox.replaceChildren(); input.removeAttribute('aria-activedescendant'); }
  function openList(kind, items, apply) {
    if (!items.length) { closeMenu(); return; }
    menu = { kind, apply }; menuItems = items; menuAt = Math.min(menuAt, items.length - 1);
    listbox.hidden = false;
    listbox.replaceChildren(...items.map((item, i) => h('button', { type: 'button', role: 'option', id: `bots-opt-${i}`, class: `bots-composer-option${i === menuAt ? ' active' : ''}`, 'aria-selected': String(i === menuAt),
      onmousedown: event => event.preventDefault(), onclick: () => choose(i) }, [h('strong', { text: item.label }), h('span', { text: item.hint })])));
    input.setAttribute('aria-activedescendant', `bots-opt-${menuAt}`);
  }
  function choose(i) { const item = menuItems[i], apply = menu?.apply; closeMenu(); if (item && apply) apply(item); input.focus(); }
  function suggest() {
    const text = input.value;
    const slash = slashItems(text, o.skills?.() || []).filter(item => !o.room || item.id === 'goal');
    if (slash.length) { menuAt = 0; openList('slash', slash, item => {
      if (item.id === 'goal') { input.value = ''; draft.update({ text: '', mode: 'goal' }); }
      else { input.value = `/${item.id} `; draft.update({ text: input.value }); }
      paint();
    }); return; }
    const token = mentionToken(text, input.selectionStart ?? text.length);
    const mentions = o.mentionSource ? o.mentionSource(token) : mentionItems(token, o.mentions?.() || [], o.selfId || '');
    if (mentions.length) { menuAt = 0; openList('mention', mentions, item => {
      if (item.kind === 'support') { input.value = text.slice(0, token.start) + text.slice(token.end); draft.update({ text: input.value }); o.onSupport?.(); paint(); return; }
      input.value = `${text.slice(0, token.start)}${item.label} ${text.slice(token.end)}`; draft.update({ text: input.value }); paint();
    }); return; }
    closeMenu();
  }
  plus.addEventListener('click', () => openMenu(plus, [
    ...(o.attachments === false ? [] : [{ label: 'Attach files', iconName: 'paperclip', onSelect: () => picker.click() }]),
    { label: draft.read().mode === 'goal' ? 'Stop working until done' : 'Work until done', iconName: 'zap', onSelect: toggleGoal },
    ...(o.room ? [] : [{ label: 'Teach a task', iconName: 'sparkles', onSelect: () => { draft.update({ text: '/learn ' }); paint(); input.focus(); } }]),
  ]));

  // -- Painting ------------------------------------------------------------------------
  function paintQueue() {
    const items = queue.items;
    queueStrip.hidden = !items.length;
    queueStrip.replaceChildren(...items.map((item, index) => h('div', { class: `bots-queue-item ${item.state || 'pending'}`, 'data-queue-id': item.id }, [
      icon('clock', { size: 14 }),
      h('span', { class: 'bots-queue-text', text: item.state === 'interrupted' ? `Interrupted: ${item.text}` : item.text }),
      index === 0 && busy && !queue.paused ? h('button', { type: 'button', class: 'bots-btn', text: steerLabel(items.length, 0), title: 'Interrupts the reply and sends now', onclick: () => Promise.resolve(o.queue?.steer(item, index)).catch(showError) }) : null,
      index > 0 && busy ? h('button', { type: 'button', class: 'bots-btn', text: steerLabel(items.length, index), onclick: () => Promise.resolve(o.queue?.steer(item, index)).catch(showError) }) : null,
      h('button', { type: 'button', class: 'bots-btn', text: 'Edit', 'aria-label': 'Edit queued message', onclick: () => Promise.resolve(o.queue?.edit(item)).catch(showError) }),
      h('button', { type: 'button', class: 'bots-btn', text: 'Delete', 'aria-label': 'Delete queued message', onclick: () => Promise.resolve(o.queue?.remove(item)).catch(showError) }),
    ])), ...(queue.paused && items.length ? [h('button', { type: 'button', class: 'bots-btn primary bots-queue-resume', text: 'Resume', onclick: () => Promise.resolve(o.queue?.resume()).catch(showError) })] : []));
  }
  function paintOutbox() {
    const box = draft.outbox();
    outbox.hidden = !box;
    if (!box) { outbox.replaceChildren(); return; }
    outbox.replaceChildren(...[h('span', { class: 'bots-outbox-text', text: `Not sent: ${String(box.payload.text || 'your attachments').slice(0, 120)}` }),
      box.retry ? h('button', { type: 'button', class: 'bots-btn primary', text: 'Retry', onclick: () => send() }) : null,
      h('button', { type: 'button', class: 'bots-btn', text: 'Edit', onclick: () => { draft.reopen(); input.value = draft.read().text; paint(); input.focus(); } }),
      box.retry ? null : h('button', { type: 'button', class: 'bots-btn', text: 'Dismiss', onclick: () => { draft.discardFailed(); paint(); } })].filter(Boolean));
  }
  function paint() {
    if (disposed) return;
    const d = draft.read(), content = hasContent();
    root.dataset.form = form();
    const slot = primarySlot({ content, busy, uploading: uploading(), locked, canCall: !!o.openCall });
    primary.dataset.kind = slot.kind; primary.disabled = slot.disabled; primary.setAttribute('aria-label', slot.label); primary.title = slot.label;
    primary.replaceChildren(...(form() === 'advanced' ? [h('span', { text: slot.label })] : [slot.kind === 'stop' ? icon('square', { size: 14 }) : slot.kind === 'call' ? icon('mic', { size: 16 }) : icon(slot.kind === 'queue' ? 'clock' : 'send', { size: 16 })]));
    stopButton.hidden = !(busy && form() === 'advanced') ; stopButton.disabled = false;
    input.disabled = locked; // An upload leaves the editor alone: a disabled field would drop focus.
    input.placeholder = placeholderFor({ name, locked, lockedReason, uploading: uploading(), replying: !!d.reply_to_id, goal: d.mode === 'goal', busy });
    goalChip.setAttribute('aria-pressed', String(d.mode === 'goal'));
    goalChip.hidden = form() !== 'advanced' && d.mode !== 'goal';
    modelLabel.textContent = o.modelLabel?.() || ''; modelLabel.hidden = !modelLabel.textContent;
    hint.hidden = !busy || form() === 'phone'; hint.textContent = busy ? (o.room ? 'Messages wait their turn.' : busyHint({ queued: queue.items.length })) : '';
    context.replaceChildren();
    if (d.reply_to_id) context.append(h('div', { class: 'bots-context-chip' }, [h('span', { text: `Replying to ${o.replyLabel?.(d.reply_to_id) || 'a message'}` }), h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Cancel reply', onclick: () => { draft.update({ reply_to_id: null }); paint(); } }, [icon('x', { size: 14 })])]));
    d.citations.forEach((cite, index) => context.append(h('div', { class: 'bots-context-chip' }, [h('span', { text: `Quote: ${String(cite.quote || '').slice(0, 60)}` }), h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Remove quote', onclick: () => { const citations = draft.read().citations; citations.splice(index, 1); draft.update({ citations }); paint(); } }, [icon('x', { size: 14 })])])));
    const items = o.uploader?.items() || [];
    staged.hidden = !items.length; staged.replaceChildren(...stagedStrip(items, { remove: key => { o.uploader.remove(key); sync(); }, disabled: locked }));
    paintQueue(); paintOutbox();
    // CSS grows the box (field-sizing, bots-composer.css); measuring it laid out the chat on every change (Chat Speed 2.3.0).
    if (!globalThis.CSS?.supports?.('field-sizing', 'content')) { input.style.height = 'auto'; input.style.height = `${Math.min(144, Math.max(36, input.scrollHeight || 36))}px`; }
    o.onChange?.(d);
  }
  // The draft keeps only server IDs; the uploader owns the live state.
  const sync = () => { draft.update({ attachment_ids: o.uploader?.ids() || [] }); paint(); };

  async function send() {
    if (locked || sending) return;
    if (uploading()) { showError(new Error('Wait for the files to finish uploading.')); return; }
    const d = draft.read(); if (!d.pending && !d.text.trim() && !d.attachment_ids.length) return;
    error.hidden = true; sending = true;
    const sentIds = o.uploader?.ids() || [];
    input.value = '';  // clear at once; the draft keeps the text, and a failed send puts it back below
    try { await o.submit(); o.uploader?.removeIds(sentIds); if (!disposed) input.value = draft.read().text; }
    catch (problem) { if (!disposed) { showError(problem); input.value = draft.read().text; } }
    finally { sending = false; if (!disposed) paint(); }
  }

  primary.addEventListener('click', () => {
    const kind = primary.dataset.kind;
    if (kind === 'send' || kind === 'queue') send(); else if (kind === 'stop') stop(); else if (kind === 'call') o.openCall?.();
  });
  input.addEventListener('input', () => { draft.update({ text: input.value }); suggest(); paint(); });
  input.addEventListener('blur', () => draft.flush());
  input.addEventListener('click', suggest);
  input.addEventListener('keydown', event => {
    if (isComposingKey(event)) return;
    if (menu) {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) { event.preventDefault(); menuAt = (menuAt + step + menuItems.length) % menuItems.length; openList(menu.kind, menuItems, menu.apply); return; }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); choose(menuAt); return; }
    }
    if (event.key === 'Escape') {
      const action = escapeAction({ menuOpen: !!menu, dictating, replying: !!draft.read().reply_to_id });
      if (!action) { if (o.onEscape?.()) event.preventDefault(); return; }
      event.preventDefault();
      if (action === 'menu') closeMenu(); else if (action === 'dictation') o.onEscape?.(); else { draft.update({ reply_to_id: null }); paint(); }
      return;
    }
    if (event.key === 'ArrowUp' && !input.value && !event.shiftKey && !event.altKey && !event.metaKey) { event.preventDefault(); o.onEditLast?.(); return; }
    let preference = o.sendPreference || 'enter';
    try { preference = localStorage.getItem('kairos:bots-send-key') || preference; } catch {}
    if (sendKey(event, { phone: phoneMedia.matches, preference })) {
      event.preventDefault();
      if (!o.room && isSteerChord({ empty: !input.value && !hasContent(), busy, lastEnter, now: now() })) { lastEnter = 0; Promise.resolve(o.steer?.()).catch(showError); }
      else { if (input.value.trim() || hasContent()) lastEnter = now(); send(); }
    }
  });
  picker.addEventListener('change', () => { const files = [...picker.files]; picker.value = ''; stageFiles(files); });
  async function stageFiles(files) {
    if (!files.length || !o.uploader) return;
    const problems = await o.uploader.add(files);
    if (problems.length) showError(new Error(problems[0]));
    sync();
  }
  input.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); stageFiles(files); return; }
    const text = event.clipboardData?.getData?.('text/plain') || '';
    if (o.pasteAsFile && o.pasteAsFile(text)) { event.preventDefault(); stageFiles([new File([text], 'pasted-text.txt', { type: 'text/plain' })]); }
  });
  const dragover = event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); };
  const drop = event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); stageFiles([...event.dataTransfer.files]); } };
  root.addEventListener('dragover', dragover); root.addEventListener('drop', drop);
  const pagehide = () => draft.flush(); window.addEventListener('pagehide', pagehide);
  const media = () => paint(); phoneMedia.addEventListener?.('change', media);
  input.value = draft.read().text; paint();
  if (o.attachments === false) { clip.hidden = true; picker.disabled = true; }
  if (o.room) access.hidden = true;

  return {
    input, root, paint, showError, closeMenu, send, stageFiles,
    callSlot: node => { callSlot.replaceChildren(node); },
    setState(state) { ({ busy = false, locked = false, lockedReason = '' } = state); paint(); },
    setQueue(next) { queue = { items: next?.items || [], paused: !!next?.paused }; paint(); },
    isDictating: () => dictating,
    notice(text) { showError(new Error(text)); },
    clearError() { error.hidden = true; },
    focus() { input.focus(); },
    insert(text) { input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input')); input.focus(); },
    // Queue Edit and a failed send return text here: it goes above whatever was typed since.
    restore(text) { const typed = input.value.trim(); input.value = typed ? `${text}\n${typed}` : text; draft.update({ text: input.value }); paint(); input.focus(); },
    reload() { input.value = draft.read().text; paint(); },
    dispose() { disposed = true; window.removeEventListener('pagehide', pagehide); phoneMedia.removeEventListener?.('change', media); root.removeEventListener('dragover', dragover); root.removeEventListener('drop', drop); draft.dispose(); root.remove(); },
  };
}
