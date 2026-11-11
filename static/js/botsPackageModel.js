// Pure lifecycle rules shared by the views and Node checks.
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
export function fileProblem(file) {
  if (!file || !/\.(json|md)$/i.test(file.name || '')) return 'Choose a JSON or Markdown package.';
  if (file.size > MAX_PACKAGE_BYTES) return 'Packages can be up to 4 MB.';
  return '';
}
export function selection(preview) {
  return { bots: (preview.bots || []).map(b => b.key), skills: (preview.skills || []).map(s => s.name),
    connections: (preview.connections || []).map(c => c.name), presets: (preview.presets || []).map(p => p.name), sections: preview.sections || [] };
}
export function counts(preview, picked = selection(preview)) {
  return { bots: picked.bots.length, routines: (preview.bots || []).filter(b => picked.bots.includes(b.key)).reduce((n, b) => n + (b.routines || []).length, 0),
    skills: picked.skills.length, connections: picked.connections.length, presets: picked.presets.length };
}
// "1 bot", "2 bots", "0 paused routines": a count with its noun in the right number.
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export function summaryText(c) {
  return [plural(c.bots, 'bot'), plural(c.routines, 'paused routine'), plural(c.skills, 'skill'), plural(c.connections, 'connection')].join(', ');
}
export function failure(error) {
  const detail = error?.detail || error?.message || error;
  return typeof detail === 'object' ? [detail.message, ...(detail.cleanup_errors || [])].filter(Boolean).join('. ') : String(detail || 'Could not finish. Try again.');
}
export const canRestore = (password, confirm) => password.length >= 12 && confirm === 'REPLACE';
