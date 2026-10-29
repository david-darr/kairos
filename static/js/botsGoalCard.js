import { h, Button } from './botsUi.js';
export function goalLabel(status) {
  return { working: 'Working', running: 'Working', completed: 'Done', 'needs-input': 'Needs you', blocked: 'Blocked', stopped: 'Stopped', failed: 'Failed', 'limit-reached': 'Step limit reached' }[status] || 'Goal';
}
export function goalCard(goal, { onStop } = {}) {
  const active = ['working', 'running'].includes(goal.status);
  return h('section', { class: 'bots-room-goal', 'data-status': goal.status, 'aria-label': 'Room goal' }, [
    h('strong', { text: goal.title || goal.goal || 'Work until done' }), h('span', { text: goalLabel(goal.status) }),
    h('p', { text: String(goal.detail || goal.label || '').slice(0, 500) }),
    h('span', { class: 'bots-hint', text: `Step ${goal.turn || goal.step || 1} of ${goal.max_turns || goal.max_steps || 13}` }),
    active && onStop ? Button({ label: 'Stop goal', onClick: onStop }) : null]);
}
export function mount(host, ctx) {
  let goal = ctx.goal;
  const root = h('div'); host.append(root);
  const refresh = next => { if (next) goal = next; root.replaceChildren(...(goal ? [goalCard(goal, ctx)] : [])); };
  refresh(); return { destroy: () => root.remove(), refresh, flush: async () => ({ ok: true }) };
}
