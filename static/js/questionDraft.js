// Typed answers to a bot's question survive closing the sheet. A draft is keyed by
// the question's id and kept in memory and in localStorage (best effort); it is
// cleared when the answer is sent or the question is settled somewhere else.
const KEY = 'kairos.questionDrafts.v1';
const memory = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    for (const [id, draft] of Object.entries(saved)) if (draft && typeof draft === 'object' && !memory.has(id)) memory.set(id, draft);
  } catch { /* storage unavailable: memory only */ }
}
function persist() {
  try {
    if (memory.size) localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(memory)));
    else localStorage.removeItem(KEY);
  } catch { /* storage may be blocked; the in-memory draft still works */ }
}

export function getDraft(id) {
  load();
  return id ? { ...(memory.get(id) || {}) } : {};
}

// `field` names one typed box inside the question; an empty value drops it.
export function setDraftField(id, field, value) {
  if (!id) return;
  const draft = getDraft(id);
  if (value) draft[field] = String(value); else delete draft[field];
  if (Object.keys(draft).length) memory.set(id, draft); else memory.delete(id);
  persist();
}

export function clearDraft(id) {
  load();
  if (id && memory.delete(id)) persist();
}

// Keep only the drafts whose question is still waiting.
export function pruneDrafts(openIds) {
  load();
  const keep = new Set(openIds);
  let changed = false;
  for (const id of [...memory.keys()]) if (!keep.has(id)) { memory.delete(id); changed = true; }
  if (changed) persist();
}
