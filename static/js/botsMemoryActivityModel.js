// Memory activity and About you: the pure parts (Bots Phase 2, unit U2), tested in plain Node by
// scripts/test_bots_memory_activity.cjs. No DOM, no imports: the section modules draw with these.

export const ABOUT_LIMIT = 24000;
export const AUTOSAVE_MS = 600;

export const messageOf = error => String(error?.message || error || '').replace(/^\d+:\s*/, '');
export const statusOf = error => {
  const found = /^(\d{3})\b/.exec(String(error?.message || ''));
  return Number(error?.status || (found && found[1]) || 0);
};

export function ago(seconds, now = Date.now() / 1000) {
  if (!seconds) return '';
  const gap = Math.max(0, now - seconds);
  if (gap < 90) return 'just now';
  if (gap < 3600) return `${Math.round(gap / 60)} min ago`;
  if (gap < 86400) return `${Math.round(gap / 3600)} h ago`;
  return `${Math.round(gap / 86400)} d ago`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Why a bot is not keeping notes, in the words the person needs: nothing is hidden behind a blank card.
export function memoryState(activity) {
  if (!activity) return { kind: 'unknown', text: '' };
  if (activity.memory_enabled === false) {
    return { kind: 'off', text: 'Memory is off for this bot. It does not read or keep notes, and nothing below runs.' };
  }
  if (!activity.upkeep) {
    return { kind: 'manual', text: 'Automatic notes are off. Turn on keeping notes tidy to let the bot learn from chats and tidy up each night.' };
  }
  if (activity.model_available === false) {
    return { kind: 'no-model', text: 'No model can run in the background, so only expired and repeated notes are handled.' };
  }
  return { kind: 'on', text: '' };
}

// A report's facts as rows: only what happened, no zero rows.
export function reportRows(report) {
  if (!report) return [];
  const rows = [];
  const add = (label, value) => { if (value) rows.push({ label, value: String(value) }); };
  if (report.kind === 'capture') {
    add('Saved', report.saved);
    add('About you', report.profile);
    add('Put off', report.deferred);
    add('Topics', (report.topics || []).join(', '));
    const rejected = Object.entries(report.rejected || {}).map(([why, n]) => `${n} ${why}`).join(', ');
    add('Not kept', rejected);
  } else if (report.kind === 'dream') {
    add('Patterns', report.patterns);
    add('Out of date', report.outdated);
    add('Ideas', report.ideas);
  } else {
    add('Expired', report.expired);
    add('Repeated', report.duplicates);
    add('Replaced', report.superseded);
    add('Moved to topics', report.organized);
    add('Put off', report.deferred);
    add('Checked for conflicts', report.contradictionsChecked + report.topicChecks);
  }
  if (report.note) rows.push({ label: 'Note', value: report.note });
  return rows;
}

export function reportTitle(report, now = Date.now() / 1000) {
  if (!report) return '';
  const what = { capture: 'Noticed', dream: 'Looked back', tidy: 'Tidied' }[report.kind || 'tidy'];
  return `${what} ${ago(report.at, now)}`.trim();
}

export function nothingHappened(report) {
  return !!report && reportRows({ ...report, note: '' }).length === 0;
}

// Ideas that are still alive. An expired idea is never shown, even before the server drops it.
export function liveIdeas(ideas, now = Date.now() / 1000) {
  return (ideas || []).filter(i => i && Number(i.expires) > now).sort((a, b) => Number(b.created) - Number(a.created));
}

export function ideaLeft(idea, now = Date.now() / 1000) {
  const left = Number(idea.expires) - now;
  if (!(left > 0)) return 'expired';
  return left >= 3600 ? `${Math.floor(left / 3600)} h left` : `${Math.max(1, Math.ceil(left / 60))} min left`;
}

export function pendingLine(activity) {
  const threads = activity?.pending_threads || 0;
  if (!threads) return '';
  return `${plural(threads, 'chat')} waiting to be noticed (${plural(activity.pending_turns || 0, 'exchange')}).`;
}

// A recalled passage's citation: where it came from, and the stable message reference to open it.
export function citation(result) {
  if (!result) return { label: '', ref: '' };
  const when = result.ts ? new Date(result.ts * 1000).toISOString().slice(0, 10) : '';
  const label = result.kind === 'memory'
    ? `Notes on ${result.title}`
    : `${result.role === 'digest' ? 'Summary' : result.role === 'user' ? 'You' : 'Bot'} in ${result.title}${when ? `, ${when}` : ''}`;
  return { label, ref: result.ref || '' };
}

export function recallQuery(text) {
  const value = String(text || '').trim();
  return value ? `q=${encodeURIComponent(value.slice(0, 600))}` : '';
}

export function forgetTermProblem(text) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (value.replace(/[^\p{L}]/gu, '').length < 3) return 'Use a word of at least three letters.';
  if (value.length > 60) return 'Use 60 characters or fewer.';
  return '';
}

export function aboutCounter(text) {
  const used = String(text || '').length;
  return { used, limit: ABOUT_LIMIT, over: used > ABOUT_LIMIT, text: `${used.toLocaleString('en-US')} / ${ABOUT_LIMIT.toLocaleString('en-US')} characters` };
}

export function learnedRows(learned, now = Date.now() / 1000) {
  return (learned || []).map(r => ({ id: r.id, text: r.text, by: r.learned_by || 'a bot', when: ago(r.at, now) }));
}

// Debounced autosave for About you: dirty text saves after 600 ms of quiet, the state is one of
// idle, dirty, saving, saved or error, and Retry saves the same text again. A newer edit during a save is
// saved next, never lost. `save(text)` resolves to the new hash; a 409 stops autosave until reload.
export function createAutosave({ save, delay = AUTOSAVE_MS, setTimer = setTimeout, clearTimer = clearTimeout, onState = () => {} }) {
  let state = 'idle', timer = null, text = '', saved = '', busy = false, again = false, error = '';
  const set = (next, extra = '') => { state = next; error = extra; onState({ state, error }); };
  async function run() {
    if (busy) { again = true; return; }
    busy = true;
    set('saving');
    const sending = text;
    try {
      await save(sending);
      saved = sending;
      busy = false;
      if (again || text !== sending) { again = false; set('dirty'); return run(); }
      set('saved');
    } catch (failure) {
      busy = false;
      again = false;
      set(statusOf(failure) === 409 ? 'conflict' : 'error', messageOf(failure));
    }
  }
  return {
    get state() { return state; },
    get error() { return error; },
    get dirty() { return text !== saved; },
    start(initial) { text = saved = String(initial || ''); set('idle'); },
    edit(next) {
      text = String(next);
      if (state === 'conflict') return;
      if (text === saved && !busy) { clearTimer(timer); set('idle'); return; }
      clearTimer(timer);
      set('dirty');
      timer = setTimer(run, delay);
    },
    retry() { clearTimer(timer); return run(); },
    async flush() { clearTimer(timer); if (text !== saved && state !== 'conflict') await run(); },
    // The server's text after a reload: a clean editor adopts it, a dirty one keeps the draft.
    adopt(serverText) { if (text === saved) { text = saved = String(serverText || ''); set('idle'); return true; } saved = String(serverText || ''); return false; },
    resolveConflict(serverText) { text = saved = String(serverText || ''); set('idle'); },
    stop() { clearTimer(timer); },
  };
}
