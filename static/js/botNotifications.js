// Desktop notifications for bots (Agents 2.0, 2026-10-14). The app already
// polls the agents inbox for the nav badge; new items from that poll become
// native notifications here, so nothing new streams. One notification per bot
// per poll, however many items arrived, so a burst never becomes a burst of
// notifications. Questions are "needs you"; reports and results waiting for
// review are "results". Phone push goes through the server's own outbox
// (services/bot_push.py); this file is the desktop half only.
const PREFS_KEY = 'kairos:bot-notifications';
const DEFAULTS = { enabled: true, needs_you: true, results: true };

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
// notification per bot, needs-you outranking results, nothing for a kind the
// person turned off, and nothing for the bot they are looking at right now.
export function plan(newItems, { prefs: p = prefs(), names = {}, focusedAgentId = null } = {}) {
  if (!p.enabled) return [];
  const byAgent = new Map();
  for (const item of newItems) {
    if (!p[item.kind] || item.agentId === focusedAgentId) continue;
    (byAgent.get(item.agentId) || byAgent.set(item.agentId, []).get(item.agentId)).push(item);
  }
  return [...byAgent.entries()].map(([agentId, items]) => {
    const needs = items.filter(item => item.kind === 'needs_you');
    const lead = needs[0] || items[0];
    const name = names[agentId] || 'A bot';
    const more = items.length - 1;
    return {
      agentId, kind: needs.length ? 'needs_you' : 'results',
      title: needs.length ? `${name} needs you` : `${name} has results`,
      body: lead.title + (more > 0 ? ` (and ${more} more)` : ''),
    };
  });
}

// Remembers what has been seen. The first poll only learns the backlog: a
// pile of notifications for things already waiting at startup is noise.
export function createWatcher({ show, names, focusedAgentId }) {
  let seen = null;
  return async function onInbox(inbox) {
    const items = itemsOf(inbox);
    if (seen === null) { seen = new Set(items.map(item => item.key)); return []; }
    const fresh = items.filter(item => !seen.has(item.key));
    seen = new Set(items.map(item => item.key));
    if (!fresh.length) return [];
    const planned = plan(fresh, { names: await names(), focusedAgentId: focusedAgentId() });
    planned.forEach(show);
    return planned;
  };
}
