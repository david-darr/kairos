// The new-bot draft, as plain data (Agents 3.0 Phase 0, unit U4).
// Everything here is pure: no DOM, no imports, no fetch. botsCreate.js draws the
// dialog over a draft and sends buildPayload()'s answer to POST /api/agents/configured;
// scripts/test_bots_create_model.cjs loads this file straight from disk.
//
// A draft never carries model access, approval, the computer or app grants for a
// preset or a ready-made bot (design 2.4: "never grants, ids or execution state");
// the person's own choices for those stay the person's.

export const LIMITS = Object.freeze({
  name: 100, role: 200, blurb: 4000, soulBytes: 24000, section: 60,
  routines: 10, routineName: 200, routinePrompt: 8000, seedChars: 8000,
});
export const SEED_SECTIONS = Object.freeze(['About this work', 'Preferences', 'Corrections', 'Notes']);
// The six Kip body pastels (keys without the hash, as botsUi.BOT_COLOR_KEYS).
export const COLOR_KEYS = Object.freeze(['d9b260', 'b9d2e3', 'e8c39e', 'd99a92', 'b5c7a5', 'cdbfd9']);
export const SHAPES = Object.freeze(['round', 'squircle', 'tall']);
export const ACCESSORIES = Object.freeze(['none', 'laurel', 'spectacles', 'quill', 'rays', 'scarf']);

// The fields saved defaults may carry (services/bot_record.py DEFAULT_FIELDS, minus the
// ones the dialog has no control for).
export const DEFAULT_KEYS = Object.freeze(['role', 'blurb', 'soul', 'color', 'section', 'memory_upkeep', 'keep_signed_in', 'memory_seed', 'routines']);

export function byteLength(text) {
  const value = String(text ?? '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return Buffer.byteLength(value, 'utf8');
}
// Cut text to a UTF-8 byte limit without splitting a character.
export function clipBytes(text, limit) {
  let value = '', used = 0;
  for (const character of String(text ?? '')) {
    const size = byteLength(character);
    if (used + size > limit) break;
    value += character; used += size;
  }
  return value;
}
const squash = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ');

// The four starting roles every install has (the older dialog's four, re-voiced).
export const STARTERS = Object.freeze([
  { id: 'starter-researcher', name: 'Researcher', role: 'Looks into questions and checks the sources',
    blurb: 'Curious and careful. Brings back findings you can trust, with the evidence shown.',
    soul: 'Ask what the answer will be used for before digging in. Compare more than one reliable source, say which claims are well supported and which are guesses, and name the sources you used.' },
  { id: 'starter-triage', name: 'Inbox triage', role: 'Sorts incoming messages by what needs you',
    blurb: 'Keeps a calm eye on the pile and tells you what is worth your attention.',
    soul: 'Group messages by urgency, summarize the decision each one needs, and keep the list short. Never send or reply to anything without asking first.' },
  { id: 'starter-writer', name: 'Writer', role: 'Drafts and tightens writing',
    blurb: 'A careful writing partner that keeps your voice.',
    soul: 'Write plainly and keep the author’s voice. Offer one clean version and note anything that needs a fact check, instead of listing many variations.' },
  { id: 'starter-watcher', name: 'Watcher', role: 'Watches chosen topics and reports real changes',
    blurb: 'Quiet until something actually changes.',
    soul: 'Check only the sources you are given, report changes that matter, and stay silent when nothing is new. Do not repeat an alert you already sent.' },
]);

export function look(color = COLOR_KEYS[0], shape = SHAPES[0], acc = ACCESSORIES[0]) {
  const key = COLOR_KEYS.includes(String(color).replace('#', '').toLowerCase()) ? String(color).replace('#', '').toLowerCase() : COLOR_KEYS[0];
  return { version: 3, character: 'ajar', shape: SHAPES.includes(shape) ? shape : SHAPES[0], color: '#' + key.toUpperCase(), acc: ACCESSORIES.includes(acc) ? acc : ACCESSORIES[0], finish: 'flat' };
}
export const colorOf = avatar => String(avatar?.color || '').toLowerCase();

let counter = 0;
const newRoutine = (extra = {}) => ({ key: `r${++counter}`, name: '', prompt: '', schedule_kind: 'daily', run_time: '08:00', hours: 6, report_when: 'notable', enabled: true, ...extra });
export const blankRoutine = newRoutine;

// A routine template as the API stores it (interval_seconds) back to the draft's hours.
export function routineFromTemplate(template, { enabled = true } = {}) {
  const kind = template?.schedule_kind === 'interval' ? 'interval' : 'daily';
  return newRoutine({
    name: String(template?.name || ''), prompt: String(template?.prompt || ''), schedule_kind: kind,
    run_time: kind === 'daily' ? String(template?.run_time || '08:00') : '08:00',
    hours: kind === 'interval' ? Math.max(1, Math.round((Number(template?.interval_seconds) || 21600) / 3600)) : 6,
    report_when: template?.report_when === 'always' ? 'always' : 'notable', enabled,
    ...(template?.time_zone ? { time_zone: template.time_zone } : {}), ...(Array.isArray(template?.weekdays) ? { weekdays: template.weekdays } : {}),
  });
}
export function routineToTemplate(routine) {
  const out = { name: squash(routine.name), prompt: String(routine.prompt || '').trim(), schedule_kind: routine.schedule_kind === 'interval' ? 'interval' : 'daily' };
  if (out.schedule_kind === 'daily') out.run_time = String(routine.run_time || '08:00').trim();
  else out.interval_seconds = Math.max(60, Math.round((Number(routine.hours) || 1) * 3600));
  out.report_when = routine.report_when === 'always' ? 'always' : 'notable';
  if (routine.time_zone) out.time_zone = routine.time_zone;
  if (routine.schedule_kind !== 'interval' && Array.isArray(routine.weekdays) && routine.weekdays.length) out.weekdays = routine.weekdays;
  return out;
}

export function emptyDraft(overrides = {}) {
  return {
    name: '', nameTouched: false, role: '', blurb: '', soul: '', section: '',
    avatar: look(), model: { endpoint_id: null, model_override: null, model_effort: null }, modelTouched: false,
    deliver_to_channel: '', integration_ids: null, keep_signed_in: false, memory_upkeep: false,
    memory_seed: [], routines: [], origin: { kind: 'blank' }, use_defaults: true,
    ...overrides,
  };
}

// Saved defaults (GET /api/agents/defaults .defaults) laid under a fresh draft.
export function draftFromDefaults(defaults = {}, { suggestedName = '' } = {}) {
  const draft = emptyDraft({ name: suggestedName });
  if (typeof defaults.role === 'string') draft.role = defaults.role;
  if (typeof defaults.blurb === 'string') draft.blurb = defaults.blurb;
  if (typeof defaults.soul === 'string') draft.soul = defaults.soul;
  if (typeof defaults.section === 'string') draft.section = defaults.section;
  if (COLOR_KEYS.includes(String(defaults.color || '').replace('#', '').toLowerCase())) draft.avatar = look(defaults.color);
  if (typeof defaults.memory_upkeep === 'boolean') draft.memory_upkeep = defaults.memory_upkeep;
  if (typeof defaults.keep_signed_in === 'boolean') draft.keep_signed_in = defaults.keep_signed_in;
  if (Array.isArray(defaults.memory_seed)) draft.memory_seed = defaults.memory_seed.map(n => ({ section: n.section, text: n.text }));
  if (Array.isArray(defaults.routines)) draft.routines = defaults.routines.map(r => routineFromTemplate(r));
  return draft;
}

// The saved defaults a draft makes (preferences only; the name is never a default).
export function defaultsFromDraft(draft, base = {}) {
  // Preserve valid saved preferences that this Phase 0 editor does not expose.
  const out = {};
  for (const key of ['daily_run_cap', 'cache_keep_warm', 'place', 'thread_limit']) {
    if (Object.hasOwn(base, key)) out[key] = base[key];
  }
  if (squash(draft.role)) out.role = String(draft.role).trim();
  if (String(draft.blurb || '').trim()) out.blurb = draft.blurb;
  if (String(draft.soul || '').trim()) out.soul = draft.soul;
  if (squash(draft.section)) out.section = squash(draft.section);
  const color = colorOf(draft.avatar);
  if (COLOR_KEYS.includes(color.replace('#', ''))) out.color = color;
  if (draft.memory_upkeep) out.memory_upkeep = true;
  if (draft.keep_signed_in) out.keep_signed_in = true;
  const seed = cleanSeed(draft.memory_seed);
  if (seed.length) out.memory_seed = seed;
  const routines = (draft.routines || []).filter(r => r.enabled !== false && (squash(r.name) || String(r.prompt || '').trim())).map(routineToTemplate);
  if (routines.length) out.routines = routines;
  return out;
}

export function cleanSeed(list) {
  return (list || []).map(n => ({ section: SEED_SECTIONS.find(s => s.toLowerCase() === String(n?.section || '').trim().toLowerCase()) || '', text: squash(n?.text) }))
    .filter(n => n.section && n.text);
}

// A starting role (saved preset, built-in starter) laid over a draft. Only identity,
// notes and routines move; model, approval, apps and the computer never do. The name
// moves only while the person has not typed their own.
export function applyStart(draft, start, { kind = 'preset' } = {}) {
  const next = { ...draft };
  if (start.name && !draft.nameTouched) next.name = start.name;
  next.role = start.role || '';
  next.blurb = start.blurb || '';
  next.soul = start.soul || '';
  if (start.avatar && typeof start.avatar === 'object' && start.avatar.version === 3) next.avatar = { ...start.avatar };
  else if (start.look) next.avatar = look(start.look.color, start.look.shape, start.look.acc);
  next.memory_seed = (start.memory_seed || []).map(n => ({ section: n.section, text: n.text }));
  // A ready-made bot's routines are offered switched off, so the person turns on what they want.
  next.routines = (start.routines || []).map(r => routineFromTemplate(r, { enabled: kind !== 'ready' }));
  next.origin = start.id ? { kind, id: String(start.id).slice(0, 80) } : { kind: 'blank' };
  return next;
}
export function applyReady(draft, persona) {
  const next = applyStart(draft, persona, { kind: 'ready' });
  next.memory_seed = [...(draft.memory_seed || []).map(n => ({ ...n })), ...next.memory_seed];
  next.routines = [...(draft.routines || []).map(r => ({ ...r })), ...next.routines];
  return next;
}

// The first free name: "Name", then "Name 2", "Name 3" (OMB's freeName).
export function freeName(wanted, taken = []) {
  const used = new Set(taken.map(n => String(n).toLowerCase()));
  const base = squash(wanted) || 'Bot';
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  return base;
}

// What stops the draft being created, as [{field, message}] (empty means it can be).
export function validateDraft(draft, { taken = [], mode = 'create' } = {}) {
  const problems = [];
  const add = (field, message) => problems.push({ field, message });
  const name = squash(draft.name);
  if (mode === 'create') {
    if (!name) add('name', 'Give the bot a name to create it.');
    else if (name.length > LIMITS.name) add('name', `A name is ${LIMITS.name} characters at most.`);
    else if (taken.some(n => String(n).toLowerCase() === name.toLowerCase())) add('name', `A bot called ${name} already exists.`);
  }
  if (String(draft.role || '').length > LIMITS.role) add('role', `A job is ${LIMITS.role} characters at most.`);
  if (String(draft.blurb || '').length > LIMITS.blurb) add('blurb', `The introduction is ${LIMITS.blurb} characters at most.`);
  if (byteLength(draft.soul) > LIMITS.soulBytes) add('soul', `The standing instructions are ${LIMITS.soulBytes.toLocaleString('en-US')} bytes at most.`);
  if (squash(draft.section).length > LIMITS.section) add('section', `A group name is ${LIMITS.section} characters at most.`);
  const seed = cleanSeed(draft.memory_seed);
  const seedChars = seed.reduce((n, note) => n + note.text.length, 0);
  if (seedChars > LIMITS.seedChars) add('memory_seed', `The starting notes are ${LIMITS.seedChars.toLocaleString('en-US')} characters at most; these are ${seedChars.toLocaleString('en-US')}.`);
  if ((draft.memory_seed || []).some(n => (squash(n?.text) && !SEED_SECTIONS.includes(n?.section)))) add('memory_seed', 'Each starting note needs a heading.');
  const active = (draft.routines || []).filter(r => r.enabled !== false);
  if (active.length > LIMITS.routines) add('routines', `A bot can start with ${LIMITS.routines} routines at most.`);
  for (const [index, r] of active.entries()) {
    const label = `Routine ${index + 1}`;
    if (!squash(r.name) || !String(r.prompt || '').trim()) add(`routine:${r.key}`, `${label} needs a name and what to do.`);
    else if (squash(r.name).length > LIMITS.routineName) add(`routine:${r.key}`, `${label}: the name is ${LIMITS.routineName} characters at most.`);
    else if (String(r.prompt).trim().length > LIMITS.routinePrompt) add(`routine:${r.key}`, `${label}: the instructions are ${LIMITS.routinePrompt.toLocaleString('en-US')} characters at most.`);
    else if (r.schedule_kind === 'interval' ? !(Number(r.hours) > 0 && Number(r.hours) * 3600 >= 60) : !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(r.run_time || '').trim()))
      add(`routine:${r.key}`, `${label} needs a valid time.`);
  }
  return problems;
}

// The POST /api/agents/configured body. `advanced` false is the one-step dialog: a
// name, a job and a look; saved defaults (use_defaults) fill the rest on the server.
export function buildPayload(draft, { advanced = true } = {}) {
  const color = colorOf(draft.avatar);
  const profile = { name: squash(draft.name), role: String(draft.role || '').trim(), avatar: { ...draft.avatar } };
  if (COLOR_KEYS.includes(color.replace('#', ''))) profile.color = color;
  const payload = { profile, approval_mode: 'full', use_defaults: !advanced, origin: { ...draft.origin } };
  if (!advanced) return payload;
  // Advanced starts from draftFromDefaults in botsCreate.js. Send the edited profile
  // whole, including deliberate clears, without letting the server fill it again.
  Object.assign(profile, { color, blurb: draft.blurb || '', soul: draft.soul || '',
    section: squash(draft.section), deliver_to_channel: draft.deliver_to_channel || '' });
  if (draft.model && (draft.modelTouched || draft.model.endpoint_id)) {
    payload.model = { endpoint_id: draft.model.endpoint_id || null, model_override: draft.model.model_override ?? null, model_effort: draft.model.model_effort ?? null };
  }
  if (Array.isArray(draft.integration_ids)) payload.integration_ids = [...draft.integration_ids];
  payload.keep_signed_in = !!draft.keep_signed_in;
  payload.memory_upkeep = !!draft.memory_upkeep;
  // The lists are sent whole, even when empty: a person who cleared the saved defaults'
  // notes or routines means none, and an absent key would bring the defaults back.
  payload.memory_seed = cleanSeed(draft.memory_seed);
  payload.routines = (draft.routines || []).filter(r => r.enabled !== false).map(routineToTemplate);
  return payload;
}

// A failed create: the one plain sentence to show, and whether the bot may exist.
export function describeFailure(status, body = {}) {
  const detail = String(body?.detail || '').trim();
  const leftovers = Array.isArray(body?.cleanup_errors) ? body.cleanup_errors.filter(Boolean) : [];
  if (leftovers.length) return { text: `${detail || 'The bot could not be created.'} Something was left behind: ${leftovers.join('; ')}. Check the Bots list before trying again.`, partial: true };
  if (status === 409) return { text: detail || 'You have reached the limit of 100 bots. Archive or delete one first.', partial: false };
  return { text: detail || 'The bot could not be created.', partial: false };
}
