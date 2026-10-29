// Pure Tasks presentation rules. No store or DOM authority lives here.
export const GROUPS = [
  ['ready_for_review', 'Ready for review'], ['needs_input', 'Needs input'],
  ['failed', 'Failed'], ['working', 'Working'], ['resolved', 'Resolved'],
];
export const STATUS = Object.fromEntries(GROUPS);
export const STARTERS = {
  task: 'Help me with ...', design: 'Make a design for ...', slides: 'Make a deck about ...',
  website: 'Make a web page for ...', files: 'Make a file with ...',
};
export const sendId = () => globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export function nextStep(text) {
  return String(text || '').trim().split(/(?<=[.!?])\s+|\n+/).filter(Boolean).at(-1)?.slice(0, 240) || 'Just started';
}
export function rowText(task) { return `${STATUS[task.state] || 'Working'} · ${task.next_step || 'Just started'}`; }
export function updatedLabel(stamp, now = Date.now() / 1000) {
  const seconds = Math.max(0, now - Number(stamp || now));
  if (seconds < 60) return 'Updated just now';
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `Updated ${Math.floor(seconds / 3600)} h ago`;
  return `Updated ${Math.floor(seconds / 86400)} d ago`;
}
export function matches(row, query) {
  const title = String(row.title || '').toLocaleLowerCase();
  return String(query || '').toLocaleLowerCase().trim().split(/\s+/).every(word => title.includes(word));
}
export function groupsFor(data, { query = '', oldest = false, resolvedOpen = false, now = Date.now() / 1000 } = {}) {
  return GROUPS.map(([id, label]) => ({ id, label,
    rows: (data?.groups?.[id] || []).filter(row => matches(row, query) &&
      (id !== 'resolved' || now - Number(row.resolved_at || 0) <= 7 * 86400))
      .sort((a, b) => (oldest ? 1 : -1) * (Number(a.updated_at || a.created_at) - Number(b.updated_at || b.created_at)) || String(a.id).localeCompare(String(b.id))),
    folded: id === 'resolved' && !resolvedOpen,
  })).filter(group => group.rows.length);
}
export function starterSelection(kind) {
  const text = STARTERS[kind] || STARTERS.task;
  return { text, start: text.indexOf('...'), end: text.length };
}
export function validAsk(text) {
  const clean = String(text || '').trim();
  return !!clean && clean.length <= 4000 && !Object.values(STARTERS).includes(clean);
}
export function checkOutcome({ hasSuggestions, finished, failed, elapsed = 0 }) {
  if (hasSuggestions) return 'found';
  if (failed) return 'Could not check just now. Try again.';
  if (finished) return 'Nothing new right now. I will keep checking.';
  if (elapsed >= 180000) return 'This is taking a while. New tasks show up here.';
  return 'Looking...';
}
