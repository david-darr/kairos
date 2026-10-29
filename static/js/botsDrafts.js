// A draft and its send receipt travel together across reloads (Phase 1, U3).
//
// The draft is the editor's content. A send moves that content into `pending`
// at once, with its stable send ID, so the field is free for new typing while
// the request is in flight. `pending` stays until the server accepts the send
// (a retry then carries the same send ID) or refuses it for good. A refusal
// puts the content back only if the person has not typed since; otherwise it
// waits in `failed` so it never overwrites newer typing.
export const DRAFT_DELAY = 500;
const MAX_ATTACHMENTS = 10, MAX_CITATIONS = 20;
const blank = () => ({ text: '', attachment_ids: [], reply_to_id: null, citations: [], mode: 'chat' });
const empty = () => ({ ...blank(), revision: 0, pending: null, failed: null });
export const draftKey = ({ person, bot, thread }) => `kairos:bots-draft:${[person, bot, thread].map(encodeURIComponent).join(':')}`;

const fields = value => {
  const out = { ...blank(), ...Object.fromEntries(Object.keys(blank()).filter(k => value && k in value).map(k => [k, value[k]])) };
  out.text = String(out.text || '');
  // A blob URL never outlives its page, so only server IDs are kept.
  out.attachment_ids = (Array.isArray(out.attachment_ids) ? out.attachment_ids : []).filter(id => typeof id === 'string' && id && !id.startsWith('blob:')).slice(0, MAX_ATTACHMENTS);
  out.citations = (Array.isArray(out.citations) ? out.citations : []).slice(0, MAX_CITATIONS);
  out.reply_to_id = typeof out.reply_to_id === 'string' && out.reply_to_id ? out.reply_to_id : null;
  out.mode = out.mode === 'goal' ? 'goal' : 'chat';
  return out;
};
const payloadOf = value => {
  const p = value && typeof value === 'object' ? value : null;
  if (!p || typeof p.send_id !== 'string' || !p.send_id) return null;
  return { send_id: p.send_id, ...fields(p), expected_leaf_id: p.expected_leaf_id ?? null };
};
const safe = value => {
  const out = { ...empty(), ...fields(value) };
  out.revision = Number.isSafeInteger(value?.revision) ? value.revision : 0;
  const pending = payloadOf(value?.pending?.payload);
  out.pending = pending ? { payload: pending, revision: Number.isSafeInteger(value.pending.revision) ? value.pending.revision : out.revision } : null;
  out.failed = payloadOf(value?.failed);
  return out;
};

export function createBotDraft(scope, { storage = globalThis.localStorage, uuid = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!scope.person || !scope.bot || !scope.thread) throw new Error('A draft needs a person, bot and conversation.');
  const key = draftKey(scope);
  let value = empty(), timer = null, disposed = false;
  try { value = safe(JSON.parse(storage.getItem(key) || '{}')); } catch { /* Storage may be unavailable. */ }
  const read = () => structuredClone(value);
  const flush = () => {
    clearTimer(timer); timer = null;
    const untouched = !value.text && !value.attachment_ids.length && !value.reply_to_id && !value.citations.length && !value.pending && !value.failed && value.mode === 'chat';
    try { if (untouched) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  };
  const schedule = () => { clearTimer(timer); timer = setTimer(flush, DRAFT_DELAY); };
  const restore = payload => { value = { ...value, ...fields(payload), revision: value.revision + 1 }; };
  return {
    read, flush,
    update(patch) { value = { ...value, ...fields({ ...value, ...patch }), revision: value.revision + 1 }; schedule(); return read(); },
    // The exact payload is saved before transport, so a retry can never use
    // newer text, a newer leaf or a different send ID.
    prepare(expectedLeaf) {
      if (value.pending) return structuredClone(value.pending);
      const payload = { send_id: uuid(), ...structuredClone(fields(value)), expected_leaf_id: expectedLeaf ?? null };
      value = { ...value, ...blank(), revision: value.revision + 1, failed: null, pending: { payload, revision: value.revision + 1 } };
      flush();
      return structuredClone(value.pending);
    },
    accepted(ticket) {
      if (value.pending?.payload.send_id !== ticket.payload.send_id) return false;
      value = { ...value, pending: null, failed: null }; flush(); return true;
    },
    // Only an explicit refusal frees the content, and later retries then get a new send ID.
    rejected(ticket) {
      if (value.pending?.payload.send_id !== ticket.payload.send_id) return false;
      const untouched = value.revision === ticket.revision;
      value = { ...value, pending: null };
      if (untouched) restore(ticket.payload); else value.failed = ticket.payload;
      flush(); return true;
    },
    // What the "Not sent" row shows: an uncertain send can be retried as it is.
    outbox() {
      if (value.pending) return { payload: structuredClone(value.pending.payload), retry: true };
      if (value.failed) return { payload: structuredClone(value.failed), retry: false };
      return null;
    },
    // Edit the unsent content again. Typing since then stays below it.
    reopen() {
      const payload = value.pending?.payload || value.failed;
      if (!payload) return false;
      const typed = value.text.trim() ? value.text : '';
      value = { ...value, ...fields(payload), text: typed ? `${payload.text}\n${typed}` : payload.text, pending: null, failed: null, revision: value.revision + 1 };
      flush(); return true;
    },
    discardFailed() { if (!value.failed) return false; value = { ...value, failed: null }; flush(); return true; },
    dispose() { if (disposed) return; disposed = true; flush(); },
  };
}
