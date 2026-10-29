import { h, Button, loadBotsCss } from './botsUi.js';
import { registerRowRenderer } from './botsTranscript.js';
import { goalCard } from './botsGoalCard.js';
import { botKip } from './botsKip.js';

export function chipLabel(message) {
  const meta = message.meta || {};
  if (message.kind === 'handoff') return ({ consult: 'Asked', notify: 'Notified', work: 'Delegated' }[meta.mode || message.mode] || 'Handed over') + (meta.partner?.name ? ` to ${meta.partner.name}` : '');
  return { incident: 'Needs attention', posted_in: 'Posted in', held: 'On hold', stopped_here: 'Stopped here', repeat: 'Repeated call', webhook_post: 'From a webhook', card: 'Work report', activity: 'Activity' }[message.kind] || 'Room update';
}
export function teamChip(row, ctx = {}) {
  loadBotsCss('/static/css/bots-rooms.css');
  const message = row.message, meta = message.meta || {}, text = message.text || message.content || '';
  if (message.kind === 'goal') return goalCard({ ...meta, title: meta.goal || text }, { onStop: ctx.onStopGoal });
  const failed = ['failed', 'cancelled', 'interrupted', 'provider_failed', 'timed_out', 'stalled'].includes(meta.outcome) || meta.status === 'failed' || message.kind === 'incident';
  const partner = meta.partner || message.partner;
  const root = h('details', { class: `bots-room-chip${failed ? ' failed' : ''}`, 'data-message-id': message.id }, [
    h('summary', {}, [partner ? botKip({ ...partner, id: partner.bot_id || partner.id }, { size: 16 }) : null,
      h('span', { text: `${chipLabel(message)}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 140)}` : ''}` })]),
    h('div', { class: 'bots-room-chip-detail', text }),
    meta.done_when || message.done_when ? h('p', { text: `Done when: ${meta.done_when || message.done_when}` }) : null]);
  const target = meta.target || message.target || (partner?.room_id ? { tab: 'botsRoom', roomId: partner.room_id, threadId: partner.thread_id } :
    partner?.bot_id ? { tab: 'botsShell', agentId: partner.bot_id, sessionId: partner.thread_id || partner.session_id } : null);
  if (target && ctx.openTarget) root.append(Button({ label: 'Open conversation', onClick: () => ctx.openTarget(target) }));
  if ((meta.retry || failed) && ctx.canRetry?.(message)) root.append(Button({ label: 'Retry', onClick: () => ctx.onRetry?.(message) }));
  return root;
}
export const TEAM_ROW_KINDS = ['chip', 'handoff', 'incident', 'posted_in', 'held', 'stopped_here', 'goal', 'repeat', 'webhook_post', 'card', 'activity'];
export function registerTeamRows() {
  const off = TEAM_ROW_KINDS.map(kind => registerRowRenderer(kind, teamChip));
  return () => off.reverse().forEach(fn => fn());
}
export const teamRowRenderers = Object.fromEntries(TEAM_ROW_KINDS.map(kind => [kind, teamChip]));
