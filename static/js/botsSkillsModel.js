// Skills model for Bots mode (Phase 2, unit U3): review state, request-card lifecycle and library filters.
// Pure functions, no DOM and no imports, so scripts/test_bots_skills.cjs runs them in plain Node and every
// Skills surface (section, library page, learned-skill card, composer menu) reads one set of rules.
// The server is the authority (services/bot_skills.py); this only decides what to show and what to send.

// -- errors -------------------------------------------------------------------------------------------
export const statusOf = error => Number(/^(\d{3}):/.exec(String(error?.message || ''))?.[1]) || 0;
export const messageOf = error => String(error?.message || error || 'Something went wrong.').replace(/^\d{3}:\s*/, '');
// A 409 means the text moved under the person: offer Reload. A 422 is a held card.
export const isStale = error => statusOf(error) === 409;
export const isHeld = error => statusOf(error) === 422;

// -- one skill ----------------------------------------------------------------------------------------
// 'retired' | 'changed' (bytes differ from what was reviewed) | 'on' | 'review' (never reviewed) | 'off'
export function reviewState(skill) {
  if (!skill) return 'off';
  if (skill.retired) return 'retired';
  if (skill.changed_after_review) return 'changed';
  if (skill.effective_enabled) return 'on';
  if (skill.enabled) return 'changed';
  return skill.reviewed_sha256 ? 'off' : 'review';
}

export const STATE_LABEL = { on: 'On', off: 'Off', review: 'Needs review', changed: 'Changed since review', retired: 'Removed' };

// Where a skill came from, in plain words.
export function originLabel(skill) {
  const source = String(skill?.source || '');
  if (skill?.origin === 'library' || skill?.assigned_via) return 'Library';
  if (skill?.origin === 'shared') return 'Shared';
  if (skill?.origin === 'global') return 'Tool Store';
  if (source.startsWith('written:')) return 'Written by you';
  if (source.startsWith('learned:')) return 'Learned';
  if (source.startsWith('setup:')) return 'From your tools';
  if (source.startsWith('github:')) return 'Imported';
  if (source === 'pasted') return 'Pasted';
  return skill?.origin === 'private' ? 'Private' : 'Imported';
}

export function sourceLine(skill) {
  const source = String(skill?.source || '');
  if (source.startsWith('github:')) return source.slice(7);
  if (source.startsWith('setup:')) return source.slice(6);
  if (source.startsWith('learned:')) return source.slice(8);
  if (source.startsWith('shared:')) return 'Shared by a bot';
  if (source.startsWith('global:')) return 'Tool Store skill ' + source.slice(7);
  return source.startsWith('written:') ? '' : source;
}

// What a switch press does. Turning a skill on always goes through the full-text review first.
export function switchIntent(skill) {
  const state = reviewState(skill);
  if (state === 'on') return 'disable';
  return 'review';
}

// The body for the reviewed enable: only the hash of the text that was on screen is trusted.
export function enableBody(skill, reviewedText) {
  if (!skill || !reviewedText || reviewedText.sha256 !== skill.sha256) throw new Error('Review the full text first.');
  return { expected_revision: skill.storage_revision, enabled: true, reviewed_sha256: reviewedText.sha256 };
}
export const disableBody = skill => ({ expected_revision: skill.storage_revision, enabled: false });

export function sortSkills(list) {
  const rank = { on: 0, review: 1, changed: 2, off: 3, retired: 4 };
  return [...list].sort((a, b) => (rank[reviewState(a)] - rank[reviewState(b)]) || a.name.localeCompare(b.name));
}

export function counts(skills = [], library = []) {
  const on = [...skills, ...library].filter(s => s.effective_enabled).length;
  return { total: skills.length + library.length, on, review: skills.filter(s => reviewState(s) === 'review').length };
}

// -- the written command ------------------------------------------------------------------------------
export const RESERVED = ['goal', 'learn', 'setup'];
export function validateWritten({ name = '', description = '', instructions = '' } = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) return 'Use lowercase words joined by hyphens for the name.';
  if (RESERVED.includes(name)) return 'That name is a built-in command. Choose another.';
  if (!description.trim() || description.length > 1024 || /[\r\n]/.test(description)) return 'Add a one-line description.';
  if (!instructions.trim()) return 'Add the instructions.';
  if (instructions.length > 16000) return 'Instructions can be up to 16,000 characters.';
  return '';
}
export const slugify = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

// -- learned-skill cards ------------------------------------------------------------------------------
// phase: open | held | applied | undone | denied
export const cardPhase = request => request?.status || 'open';
export const cardTitle = request => request?.title || ((request?.kind === 'update' ? 'Update skill ' : 'Enable skill ') + (request?.name || ''));

// The buttons a card offers in each phase. `apply` carries the hash the person reviewed.
export function cardActions(request) {
  const verb = request?.kind === 'update' ? 'Update skill' : 'Enable skill';
  switch (cardPhase(request)) {
    case 'open': return [{ id: 'apply', label: verb, primary: true }, { id: 'deny', label: 'Not now' }];
    case 'held': return [{ id: 'retry', label: 'Review again', primary: true }, { id: 'deny', label: 'Dismiss' }];
    case 'applied': return request?.receipt && !request.receipt.undone
      ? [{ id: 'undo', label: 'Undo' }, { id: 'share', label: 'Share to library' }] : [];
    default: return [];
  }
}
export const applyBody = request => ({ reviewed_sha256: request.bundle_sha256, expected_base_revision: request.base_revision });

export function cardLine(request) {
  switch (cardPhase(request)) {
    case 'open': return request.kind === 'update' ? 'Review the new text before it replaces the current skill.' : 'Review the full text before this skill is switched on.';
    case 'held': return request.held_reason || 'This request could not be applied.';
    case 'applied': return request.receipt?.undone ? 'Undone.' : `Enabled as /${request.name}.`;
    case 'undone': return 'Undone.';
    default: return 'Not now.';
  }
}

// Replace or add one card in a list, keeping order. Closed cards drop out of the pending list.
export function mergeCard(list, card) {
  const next = list.filter(c => c.id !== card.id);
  if (card.status === 'open' || card.status === 'held') next.push(card);
  return next.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}
export const pendingCards = list => (list || []).filter(c => c.status === 'open' || c.status === 'held');

// A line diff for an update card, shown as plain text rows (no HTML): [{kind: 'same'|'add'|'del', text}].
export function lineDiff(before = '', after = '') {
  const a = before.split('\n'), b = after.split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) rows.push({ kind: 'del', text: a[i++] });
    else rows.push({ kind: 'add', text: b[j++] });
  }
  while (i < a.length) rows.push({ kind: 'del', text: a[i++] });
  while (j < b.length) rows.push({ kind: 'add', text: b[j++] });
  return rows;
}

// -- the library --------------------------------------------------------------------------------------
export function libraryTags(skills) {
  return [...new Set(skills.flatMap(s => s.tags || []))].sort();
}
export function filterLibrary(skills, { query = '', tag = '' } = {}) {
  const needle = query.trim().toLowerCase();
  return skills.filter(s => (!tag || (s.tags || []).includes(tag))
    && (!needle || [s.name, s.description, ...(s.tags || [])].join(' ').toLowerCase().includes(needle)));
}
// Chips for the bots a library skill is given to. `bots` maps id to a display name.
export function assignmentChips(skill, bots = {}) {
  const chips = skill.every_bot ? [{ id: '*', label: 'Every bot' }] : [];
  return chips.concat((skill.assigned_bots || []).map(id => ({ id, label: bots[id] || 'A bot' })));
}
export const givenToBot = (skill, botId) => !!skill.every_bot || (skill.assigned_bots || []).includes(botId);

// The new explicit list for one bot after a toggle.
export function nextAssignment(library, botId, name, on) {
  const current = new Set(library.filter(s => (s.assigned_bots || []).includes(botId)).map(s => s.name));
  if (on) current.add(name); else current.delete(name);
  return [...current].sort();
}

export const shaPrefix = sha => String(sha || '').slice(0, 12);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function importSummary(results = []) {
  const by = status => results.filter(r => r.status === status).length;
  const parts = [];
  if (by('imported')) parts.push(`${plural(by('imported'), 'skill', 'skills')} added, switched off until you review them`);
  if (by('exists')) parts.push(`${by('exists')} already here`);
  if (by('refused')) parts.push(`${by('refused')} refused by the safety scan`);
  return parts.join('. ') || 'Nothing was imported.';
}
