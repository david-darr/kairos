// Desktop notifications for bots (Agents 2.0, 2026-10-14). The app already
// polls the agents inbox for the nav badge; new items from that poll become
// native notifications here, so nothing new streams. One notification per bot
// per poll, however many items arrived, so a burst never becomes a burst of
// notifications. Questions are "needs you"; reports and results waiting for
// review are "results". Phone push goes through the server's own outbox
// (services/bot_push.py); this file is the desktop half only.
const PREFS_KEY = 'kairos:bot-notifications';
const DEFAULTS = { enabled: true, needs_you: true, results: true };
// Added later, on by default, and left out of DEFAULTS so a saved preference file
// keeps its three original keys until the person changes one of these.
export const EXTRA_DEFAULTS = { completions: true, failures: true };

export function prefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function savePrefs(changes) {
  const next = { ...prefs(), ...changes };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage is optional */ }
  return next;
}

// Every item waiting on the person, as {key, agentId, kind, title}.
export function itemsOf(inbox) {
  const items = (inbox?.items || []).filter(item => item.agent_id).map(item => ({
    key: `item:${item.id}`, agentId: item.agent_id,
    kind: item.kind === 'question' ? 'needs_you' : 'results', title: item.title || '',
  }));
  const reviews = (inbox?.reviews || []).filter(card => card.agent_id).map(card => ({
    key: `review:${card.id}`, agentId: card.agent_id, kind: 'results', title: card.name || '',
  }));
  return [...items, ...reviews];
}

// What to show for the items that are new since the last poll: at most one
// notification per bot, needs-you outranking everything, nothing for a kind the
// person turned off, and nothing for the bot or conversation they are looking at
// right now. An item may carry the server's target {agentId, sessionId,
// messageId}; the notification keeps the lead item's, so a click opens exactly
// that conversation.
const RANK = { needs_you: 0, failures: 1, results: 2, completions: 3 };
const TITLES = {
  needs_you: name => `${name} needs you`, failures: name => `${name} hit a problem`,
  results: name => `${name} has results`, completions: name => `${name} finished`,
};
export function plan(newItems, { prefs: saved = prefs(), names = {}, focusedAgentId = null, focusedSessionId = null } = {}) {
  const p = { ...EXTRA_DEFAULTS, ...saved };
  if (!p.enabled) return [];
  const byAgent = new Map();
  for (const item of newItems) {
    if (!p[item.kind] || item.agentId === focusedAgentId) continue;
    if (focusedSessionId && item.target?.sessionId === focusedSessionId) continue;
    (byAgent.get(item.agentId) || byAgent.set(item.agentId, []).get(item.agentId)).push(item);
  }
  return [...byAgent.entries()].map(([agentId, items]) => {
    const ranked = [...items].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9));
    const lead = ranked[0];
    const name = names[agentId] || 'A bot';
    const more = items.length - 1;
    return {
      agentId, kind: lead.kind, title: (TITLES[lead.kind] || TITLES.results)(name),
      body: lead.title + (more > 0 ? ` (and ${more} more)` : ''),
      ...(lead.target ? { target: lead.target } : {}),
    };
  });
}

// Remembers what has been seen. The first poll only learns the backlog: a
// pile of notifications for things already waiting at startup is noise.
export function createWatcher({ show, names, focusedAgentId, focusedSessionId = () => null }) {
  let seen = null;
  return async function onInbox(inbox) {
    const items = itemsOf(inbox);
    if (seen === null) { seen = new Set(items.map(item => item.key)); return []; }
    const fresh = items.filter(item => !seen.has(item.key));
    seen = new Set(items.map(item => item.key));
    if (!fresh.length) return [];
    const planned = plan(fresh, { names: await names(), focusedAgentId: focusedAgentId(), focusedSessionId: focusedSessionId() });
    planned.forEach(show);
    return planned;
  };
}

// The retained feed (/api/bot-attention/notifications) as {key, agentId, kind,
// title, target}. Kinds map to the person's switches: a question or approval is
// "needs you", a failure or incident is "failures", a finished reply is
// "completions", and the rest are "results". Rows the server marks as backlog
// (things already waiting when it rebuilt the feed) and rows already read never
// notify.
const FEED_KINDS = {
  question: 'needs_you', approval: 'needs_you', 'turn-failed': 'failures', 'routine-failed': 'failures', 'routine-deferred': 'failures',
  incident: 'failures', 'sign-in': 'needs_you', spend: 'failures', done: 'completions',
};
export function feedItemsOf(feed) {
  return (feed?.rows || []).filter(row => row.agent_id && row.id).map(row => ({
    key: `feed:${row.id}`, agentId: row.agent_id, kind: FEED_KINDS[row.kind] || 'results', title: row.title || '',
    target: row.target || null, backlog: row.backlog === true, read: row.read === true,
  }));
}

// Like createWatcher, for the feed. The first poll learns what is already there;
// after that a row notifies once, if it is new, unread and not backlog.
export function createFeedWatcher({ show, names, focusedAgentId = () => null, focusedSessionId = () => null }) {
  let seen = null;
  return async function onFeed(feed) {
    const items = feedItemsOf(feed);
    if (seen === null) { seen = new Set(items.map(item => item.key)); return []; }
    const fresh = items.filter(item => !seen.has(item.key) && !item.backlog && !item.read);
    items.forEach(item => seen.add(item.key));
    if (!fresh.length) return [];
    const planned = plan(fresh, { names: await names(), focusedAgentId: focusedAgentId(), focusedSessionId: focusedSessionId() });
    planned.forEach(show);
    return planned;
  };
}
