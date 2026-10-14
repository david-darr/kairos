// What a bot needs from the person, in one place (Agents 2.0, 2026-10-14).
// This began inside the sidebar rail. David removed the rail's sections, but
// the floating bot window and the Agents tab still need the same answer, so it
// lives here with no DOM and no imports: callers pass in what they know, and
// scripts/test_bot_status.cjs can load it straight from disk.

// Highest first. Waiting on the person outranks everything: a bot working in
// one thread while a question sits in another needs the person, not patience.
export const STATUS_ORDER = ['needs_you', 'working', 'teammate', 'queued', 'idle'];

// agent: the summary from /api/agents (status, needs_you).
// messages: every message across the bot's threads that the caller has loaded.
// live: whether any of those threads has a turn streaming right now.
export function botStatus(agent, messages = [], live = false) {
  const handoffs = messages.filter(message => message.type === 'handoff');
  // The summary's needs_you count aggregates cards and inbox items even while
  // its status says working; thread handoffs and open questions add chat work.
  if ((agent?.needs_you || 0) > 0 || agent?.status === 'needs_you'
      || handoffs.some(m => m.handoff_status === 'needs_you')
      || messages.some(m => m.inbox_item_id && m.question_status === 'open')) return 'needs_you';
  if (agent?.status === 'working' || live) return 'working';
  // Assignments a bot made render as handoff cards in its own thread, so
  // "waiting on a teammate" covers bot-to-bot work as well as chat handoffs.
  if (handoffs.some(m => m.handoff_status === 'working')) return 'teammate';
  if (handoffs.some(m => m.handoff_status === 'queued')) return 'queued';
  return 'idle';
}

export function compareStatus(a, b) {
  return STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b);
}

// 2026-10-14: one readable status sentence is shared by roster and profile.
export function botStatusLine(agent, messages = [], live = false) {
  const state = botStatus(agent, messages, live);
  if (!agent?.enabled || agent?.status === 'off') return { state: 'off', text: 'Off' };
  if (state === 'needs_you') {
    const count = Math.max(1, agent?.needs_you || 0);
    return { state, text: `Needs you: ${count} ${count === 1 ? 'item' : 'items'}` };
  }
  if (state === 'working') return { state, text: agent?.status_detail ? `Working on ${agent.status_detail}` : 'Working' };
  if (state === 'teammate') return { state, text: 'Waiting for a teammate' };
  if (state === 'queued') return { state, text: 'Queued for work' };
  return { state, text: agent?.status === 'capped' ? 'Done for today' : 'Ready for work' };
}

// The last thing a bot or person actually said, as one plain line: no
// Markdown, no code blocks, no handoff cards or failed turns.
export function readablePreview(messages = []) {
  const last = [...messages].reverse().find(message => ['user', 'assistant'].includes(message.role) &&
    message.type !== 'handoff' && message.status !== 'failed' &&
    typeof message.content === 'string' && message.content.trim());
  if (!last) return '';
  return last.content.replace(/```[\s\S]*?```/g, ' code ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/(^|\s)[#>*_~`-]+(?=\S)/g, '$1').replace(/[*_~`]/g, '')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}
