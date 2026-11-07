// Account usage limits (Claude Code, Codex, Antigravity) and every connected
// model's recorded tokens, read and worded once for the places that show
// them: the desktop usage overlay and notch (usage-overlay.js, notchShell.js)
// and Home's "Model usage" card (kairosParts.js, David 2026-10-07). The
// readings come from core/quota_usage.py through /api/models/quotas as
// {provider, status, windows:[{name, used_percent, resets_at (unix s)}],
// updated_at, note}; toSnap() turns one into the shape both pages use:
// {status, windows:[{id, label, used 0..1, resets_at ms}], fetched_at ms, note}.

// `mark` is the provider's logo in static/img/model-marks/ (LobeHub, MIT; see
// the NOTICE there): Codex shows the OpenAI mark, as CodeNotch's ring does.
export const PROVIDERS = [
  { id: 'claude', name: 'Claude', mark: 'claude' },
  { id: 'codex', name: 'Codex', mark: 'openai' },
  { id: 'antigravity', name: 'Antigravity', mark: 'gemini' },
];
export const SIGN_IN = { antigravity: 'Sign in to Antigravity to see usage.', claude: 'Sign in to Claude Code to see usage.', codex: 'Sign in to Codex to see usage.' };
const WINDOW_IDS = { '5-hour': 'session', 'Weekly': 'weekly' };
const WINDOW_LABELS = { '5-hour': '5-hour limit', 'Weekly': 'Weekly limit' };
const STATUS = { ok: 'ok', stale: 'stale', needs_sign_in: 'needsAuth', rate_limited: 'stale', unavailable: 'stale' };

export function toSnap(p) {
  return {
    status: STATUS[p.status] || (p.stale ? 'stale' : 'ok'),
    windows: (p.windows || []).map(w => ({
      id: WINDOW_IDS[w.name] || w.name,
      label: WINDOW_LABELS[w.name] || w.name,
      used: Math.max(0, Number(w.used_percent) || 0) / 100,
      resets_at: w.resets_at ? w.resets_at * 1000 : 0,
    })),
    fetched_at: p.updated_at ? p.updated_at * 1000 : 0,
    note: p.note || '',
  };
}

// Every connected model, as Home's card and the notch list them (David,
// 2026-10-25): /api/models/quotas `models` is one entry per endpoint, already
// ordered subscriptions, local, API. Endpoints on one subscription share its
// account quota, so they become one group; every other model is its own.
// `snap` is the provider's reading (null for local/API), and `recorded` the
// fresh tokens Kairos itself counted: today, this week (from Monday), all time.
const KIND_WORD = { local: 'Local', api: 'API' };
export function modelGroups(models = []) {
  const groups = [];
  for (const m of models) {
    const provider = PROVIDERS.find(p => p.id === m.provider);
    const id = provider ? provider.id : 'model:' + m.id;
    let group = groups.find(g => g.id === id);
    if (!group) {
      group = { id, provider: provider?.id || null, name: provider?.name || m.name, mark: provider?.mark || m.mark,
        kind: m.kind, detail: KIND_WORD[m.kind] ? [KIND_WORD[m.kind], m.model].filter(Boolean).join(' · ') : '',
        status: m.status, snap: m.quota ? toSnap(m.quota) : null, recorded: { today: 0, week: 0, total: 0 }, stats: null };
      groups.push(group);
    }
    // Measured speed (Session Usage and Model Tracking): a group of several connections shows its busiest one's,
    // since medians cannot be merged.
    if (m.stats?.runs && (!group.stats || m.stats.runs > group.stats.runs)) group.stats = m.stats;
    group.recorded.today += m.recorded?.today_tokens || 0;
    group.recorded.week += m.recorded?.week_tokens || 0;
    group.recorded.total += m.recorded?.total_tokens || 0;
  }
  return groups;
}
export function compactTokens(n) {
  for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (n >= size) return (n / size).toFixed(1).replace(/\.0$/, '') + unit;
  return String(n);
}
// What Kairos counted through a model. Days before daily counting began are
// not guessed: an older total is named as such.
export function tokensCopy({ today, week, total }) {
  if (week) return `${compactTokens(week)} tokens this week · ${compactTokens(today)} today`;
  if (total) return `None this week · ${compactTokens(total)} tokens in all`;
  return 'No usage yet';
}
// A group's reading in a few words, for the notch's status row: the provider's
// headline window, else what Kairos counted.
const WINDOW_WORD = { session: '5h', weekly: 'wk' };
export function shortReading(group) {
  if (group.status === 'needs_sign_in') return 'sign in';
  const windows = group.snap?.windows || [];
  const head = windows.find(w => w.id === 'session') || windows[0];
  if (head) return `${WINDOW_WORD[head.id] ? WINDOW_WORD[head.id] + ' ' : ''}${pctText(head.used)}%`;
  const { today, week } = group.recorded;
  if (today) return `${compactTokens(today)} tokens today`;
  if (week) return `${compactTokens(week)} tokens this week`;
  return group.status === 'unavailable' ? 'unavailable' : 'no usage yet';
}
export const TOKENS_TITLE ='Tokens this Kairos install sent and received through this model: new input, cache writes and output. Not a quota.';

// CodeNotch's three steps: ample below half, watch from half, critical from 80%.
export const toneOf = f => f >= 0.8 ? 'crit' : f >= 0.5 ? 'watch' : 'ample';

// Whole percents, except where rounding would read as nothing used or nothing left
export function smallPct(v) {
  if (v <= 0) return '0';
  const t = Math.round(v * 10) / 10;
  if (t < 0.1) return '<0.1';
  if (t > 99.9) return '>99.9';
  return t.toFixed(1);
}
export function pctText(f) { const v = f * 100; return v > 0 && v < 1 ? smallPct(v) : String(Math.round(v)); }
export function usedCopy(w) {
  const v = w.used * 100;
  let used, left;
  if ((v > 0 && v < 1) || (v > 99 && v < 100)) { used = smallPct(v); left = 100 - v > 99.9 ? '>99.9' : smallPct(Math.max(0, 100 - v)); }
  else { const u = Math.round(v); used = String(u); left = String(Math.max(0, 100 - u)); }
  return `${used}% Used · ${left}% left`;
}

function daysApart(from, to) {
  const day = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  return Math.round((day(to) - day(from)) / 86400000);
}
export function resetCopy(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return 'Resetting…';
  const min = Math.round(diff / 60000);
  if (min < 60) return `Resets in ${Math.max(1, min)} min`;
  const d = new Date(ms);
  // A weekday only names a day in the coming week
  if (daysApart(Date.now(), ms) >= 7) return 'Resets ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diff < 24 * 60 * 60 * 1000) return `Resets at ${t}`;
  return `Resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${t}`;
}
export function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; }
// 15 minutes, CodeNotch's (and its Mac original's) stale threshold
export function staleOf(snap) { if (snap.status === 'stale') return true; return snap.fetched_at > 0 && (Date.now() - snap.fetched_at) > 15 * 60 * 1000; }
