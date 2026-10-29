// Profile diffs and history rows for a bot's panel (Phase 1, unit U2): the pure part (a line diff, the
// words for each field, what a history row says) and one builder that draws a diff. Text from a bot,
// a file or an old version is data: it goes in with textContent only, never as markup.
//
// No imports, on purpose: scripts/test_bots_panel_sections.cjs loads it in plain Node.

export const MAX_DIFF_LINES = 400;

export const FIELD_LABELS = Object.freeze({
  name: 'name', role: 'job', blurb: 'introduction', soul: 'standing instructions', section: 'group', color: 'colour',
  avatar: 'Kip look', avatar_image: 'picture', mascot_expression: 'expression', reply_style: 'reply style',
  notifications: 'notifications', speak_replies: 'spoken replies', voice_id: 'voice', call_mode: 'call mode',
  skill_selection: 'skills', endpoint_id: 'model connection', model_override: 'model version', model_effort: 'reasoning effort',
  enabled: 'on or off', daily_run_cap: 'runs per day', deliver_to_channel: 'where it reports', integration_ids: 'tool servers',
  keep_signed_in: 'stay signed in', memory_upkeep: 'tidy notes', peers: 'peers', thread_limit: 'running conversations',
  fallback: 'fallback models', cache_keep_warm: 'keep warm', place: 'where it works', approval_mode: 'approval',
  outbound: 'outside messages', tool_scope: 'tool limits', connector_scopes: 'app limits', always_allow: 'always allowed',
  hidden: 'archived',
});
export const ACTOR_LABELS = Object.freeze({ user: 'You', bot: 'The bot', file: 'A file edit', import: 'An import', system: 'Kairos' });

export const fieldLabel = key => FIELD_LABELS[key] || String(key || '').replace(/_/g, ' ');
export const actorLabel = actor => ACTOR_LABELS[actor] || 'Someone';

// Standing instructions are limited in UTF-8 bytes, not characters.
export function byteLength(text) {
  const value = String(text ?? '');
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  return Buffer.byteLength(value, 'utf8');
}
// Cut text to a byte limit without splitting a character.
export function clipToBytes(text, limit) {
  let value = String(text ?? '');
  if (byteLength(value) <= limit) return value;
  const chars = [...value];
  let used = 0, end = 0;
  for (const ch of chars) {
    const n = byteLength(ch);
    if (used + n > limit) break;
    used += n; end += 1;
  }
  return chars.slice(0, end).join('');
}

// A line diff by longest common subsequence: [{type: 'same'|'add'|'del', text}]. Long inputs are
// compared by their first and last MAX_DIFF_LINES lines so the work stays bounded.
export function diffLines(before, after) {
  const a = String(before ?? '') === '' ? [] : String(before).split('\n');
  const b = String(after ?? '') === '' ? [] : String(after).split('\n');
  if (a.length > MAX_DIFF_LINES * 2 || b.length > MAX_DIFF_LINES * 2) {
    return [{ type: 'del', text: `(${a.length} lines before)` }, { type: 'add', text: `(${b.length} lines after)` }];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out;
}

export const diffSummary = lines => ({ added: lines.filter(l => l.type === 'add').length, removed: lines.filter(l => l.type === 'del').length });

// A value as one short line for a history or proposal row.
export function shortValue(value, max = 80) {
  if (value === null || value === undefined || value === '') return 'empty';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// "Changed job" / "You changed the job: A to B", from one history row.
export function describeRow(row) {
  const what = fieldLabel(row.field);
  if (row.field === 'soul') return `${actorLabel(row.actor)} changed the ${what}`;
  if (row.before === undefined && row.after === undefined) return `${actorLabel(row.actor)} changed the ${what}`;
  return `${actorLabel(row.actor)} changed the ${what}: ${shortValue(row.before, 40)} to ${shortValue(row.after, 40)}`;
}

// Only standing-instruction rows can be restored (the server refuses the rest too).
export const canRestore = row => row?.field === 'soul';

// What the server's current stored soul and the file on disk say about each other.
// -> 'same' | 'file-missing' | 'file-differs'
export function driftState(soulFile) {
  if (!soulFile) return 'same';
  if (soulFile.in_sync) return 'same';
  if (soulFile.file_text === null || soulFile.file_text === undefined) return 'file-missing';
  return 'file-differs';
}

// -- drawing -----------------------------------------------------------------------------------
// A diff as <pre> lines with a sign; textContent only. `document` is the page's.
export function profileDiff(before, after, { empty = 'No changes.' } = {}) {
  const lines = diffLines(before, after);
  const box = document.createElement('div');
  box.className = 'bots-diff';
  box.setAttribute('role', 'group');
  const { added, removed } = diffSummary(lines);
  box.setAttribute('aria-label', `${added} lines added, ${removed} removed`);
  if (!added && !removed) {
    const none = document.createElement('p'); none.className = 'bots-hint'; none.textContent = empty; box.append(none);
    return box;
  }
  const pre = document.createElement('pre');
  pre.className = 'bots-diff-lines';
  for (const line of lines) {
    const row = document.createElement('span');
    row.className = `bots-diff-line ${line.type}`;
    const sign = document.createElement('span'); sign.className = 'bots-diff-sign'; sign.setAttribute('aria-hidden', 'true');
    sign.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    const text = document.createElement('span'); text.className = 'bots-diff-text'; text.textContent = line.text || ' ';
    const word = document.createElement('span'); word.className = 'bots-sr-only';
    word.textContent = line.type === 'add' ? 'Added: ' : line.type === 'del' ? 'Removed: ' : '';
    row.append(sign, word, text); pre.append(row);
  }
  box.append(pre);
  return box;
}
