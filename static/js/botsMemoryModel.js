// The Memory section's logic, with no DOM (Bots Phase 2, unit U1), so plain Node tests it
// (scripts/test_bots_memory.cjs): the editor's conflict state, polling that never clobbers a draft,
// capacity wording, journal rows and diffs drawn as inert text, and the gate that makes a section safe
// to destroy while its requests are still out.

export const INDEX_PATH = 'MEMORY.md';
export const ARCHIVE_PATH = 'memory/archive.md';
export const ABSENT = 'absent';
export const TOPIC_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_TOPICS = ['archive', 'log'];
const WINDOWS_NAMES = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

// "409: This note changed ..." as api.js throws it.
export function parseFailure(error) {
  const text = String(error?.message ?? error ?? '');
  const match = /^(\d{3}):\s*([\s\S]*)$/.exec(text);
  return match ? { status: Number(match[1]), message: match[2] || 'That did not work.' } : { status: 0, message: text.replace(/^\d+:\s*/, '') || 'That did not work.' };
}

export const formatBytes = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// How much of the index a turn loads: the lower of 200 lines and 24 KB.
export function capacityReport(index) {
  const i = index || {};
  const lineLimit = i.line_limit || 200, byteLimit = i.byte_limit || 24576;
  const lines = i.stored_lines || 0, bytes = i.stored_bytes || 0;
  const percent = Math.min(100, Math.round(Math.max(lines / lineLimit, bytes / byteLimit) * 100));
  const clipped = !!i.clipped;
  const level = clipped ? 'over' : percent >= 80 ? 'near' : 'ok';
  const label = `${plural(lines, 'line', 'lines')} of ${lineLimit}, ${formatBytes(bytes)} of ${formatBytes(byteLimit)}`;
  const warning = clipped
    ? `Only the first ${plural(i.loaded_lines || 0, 'line', 'lines')} (${formatBytes(i.loaded_bytes || 0)}) are read each turn. The rest is kept but not used until you make room.`
    : level === 'near' ? 'Getting full. Older notes will be moved to the archive to make room.' : '';
  return { level, percent, label, warning, loaded: { lines: i.loaded_lines || 0, bytes: i.loaded_bytes || 0 }, stored: { lines, bytes }, clipped };
}

export function topicNameError(name, existing = []) {
  const value = String(name || '').trim();
  if (!value) return 'Give the topic a name.';
  if (!TOPIC_NAME.test(value)) return 'Use letters, numbers, dashes or underscores, up to 64 characters.';
  if (RESERVED_TOPICS.includes(value.toLowerCase()) || WINDOWS_NAMES.has(value.toLowerCase())) return 'That name is reserved. Pick another.';
  if (existing.some(n => String(n).toLowerCase() === value.toLowerCase())) return 'A topic with that name already exists.';
  return '';
}

// -- notes (Simple Memory) -------------------------------------------------------------------------
const WHO = { owner: 'you', person: 'you', agent: 'the bot', bot: 'the bot', legacy: '', review: 'your review', capture: 'a conversation', dream: 'a daily review', tidy: 'a tidy-up' };
export function noteHint(note) {
  const day = note?.learned ? shortDay(note.learned) : '';
  const who = Object.hasOwn(WHO, note?.source) ? WHO[note.source] : (note?.source || '');
  const parts = [note?.section || '', day ? `added ${day}${who ? ` by ${who}` : ''}` : '', note?.until ? `until ${shortDay(note.until)}` : ''];
  return parts.filter(Boolean).join(' · ');
}
export function liveNotes(notes) { return (notes || []).filter(n => !n.superseded); }
export function shortDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1] || m[2]} ${Number(m[3])}`;
}

// -- the editor's state ---------------------------------------------------------------------------
// base is the last version seen on the server; draft is what the person has typed. A poll that brings a
// newer server version replaces the draft only when the person has typed nothing; otherwise it raises a
// conflict and the draft stays. Overwrite needs the person's explicit check.
export function createEditor(initial = {}) {
  const state = {
    base: { text: initial.text ?? '', hash: initial.hash ?? ABSENT },
    draft: initial.text ?? '',
    conflict: null,
    overwrite: false,
    busy: false,
    notice: '',
  };
  const api = {
    state,
    get dirty() { return state.draft !== state.base.text; },
    get draft() { return state.draft; },
    get conflict() { return state.conflict; },
    get canOverwrite() { return !!state.conflict && state.overwrite; },
    edit(text) { state.draft = text; state.notice = ''; },
    // A newer copy arrived (a poll, or a refused save). Returns what happened.
    incoming(server) {
      if (!server || server.hash === state.base.hash) { if (state.conflict && server && server.hash === state.base.hash) { state.conflict = null; state.overwrite = false; } return 'same'; }
      if (state.conflict && state.conflict.hash === server.hash) return 'conflict';
      if (!api.dirty) { state.base = { text: server.text ?? '', hash: server.hash }; state.draft = state.base.text; state.conflict = null; state.overwrite = false; return 'adopted'; }
      state.conflict = { hash: server.hash, text: server.text ?? '' }; state.overwrite = false;
      return 'conflict';
    },
    setOverwrite(on) { state.overwrite = !!on && !!state.conflict; },
    // Take the newer server copy and drop the draft.
    reload() {
      if (state.conflict) { state.base = { text: state.conflict.text, hash: state.conflict.hash }; state.draft = state.conflict.text; }
      state.conflict = null; state.overwrite = false; state.notice = '';
    },
    discard() { state.draft = state.base.text; state.notice = ''; },
    // What a save sends. An overwrite sends the newer hash, and only once the person has checked the box.
    saveRequest() {
      if (state.conflict) return state.overwrite ? { text: state.draft, expected_hash: state.conflict.hash } : null;
      return api.dirty ? { text: state.draft, expected_hash: state.base.hash } : null;
    },
    // A save went through: the server's copy is the new base; text typed while it was in flight stays.
    saved(server, sentText) {
      state.base = { text: server.text ?? sentText ?? state.draft, hash: server.hash };
      if (state.draft === sentText) state.draft = state.base.text;
      state.conflict = null; state.overwrite = false; state.notice = '';
    },
  };
  return api;
}

// -- the journal -------------------------------------------------------------------------------------
const ACTORS = { person: 'You', bot: 'The bot', upkeep: 'Tidy-up', dream: 'Daily review', capture: 'Capture', organize: 'Organizer', system: 'Kairos' };
export const actorLabel = actor => ACTORS[actor] || 'Kairos';
export function undoState(row) {
  if (!row) return { enabled: false, reason: '' };
  if (row.reverted_by) return { enabled: false, reason: 'Already undone' };
  if (row.operation === 'revert' && row.reverted_by) return { enabled: false, reason: 'Already undone' };
  if (row.revertible === false) return { enabled: false, reason: 'No copy of the old version is kept' };
  return { enabled: true, reason: '' };
}
// A unified diff as rows to draw as plain text. Never HTML: the caller sets textContent.
export function diffRows(diff, max = 400) {
  const rows = [];
  for (const line of String(diff || '').split('\n')) {
    if (rows.length >= max) { rows.push({ kind: 'meta', text: '...' }); break; }
    if (!line) continue;
    const kind = line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('@@') ? 'meta' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    rows.push({ kind, text: line });
  }
  return rows;
}
export function whenLabel(seconds, now = Date.now() / 1000) {
  const diff = Math.max(0, now - seconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  const date = new Date(seconds * 1000);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// -- safe disposal -----------------------------------------------------------------------------------
// next() hands out a token; ok(token) is true only for the newest token while the section lives. A reply
// that arrives after a newer request, or after destroy(), is dropped instead of drawn.
export function createGate() {
  let latest = 0, dead = false;
  return {
    next: () => ++latest,
    ok: token => !dead && token === latest,
    alive: () => !dead,
    destroy: () => { dead = true; },
  };
}
