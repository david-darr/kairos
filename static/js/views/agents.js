// The old Agents tab, retired (Bots Phase 1, unit U4). app.js sends every `agents`
// link to its Bots destination before a view is chosen (botsNavigation.js), so this
// module is only a safety net: if anything still loads it, it forwards the same
// target to Bots and draws nothing of its own. The exports below keep older
// imports working; they forward to Bots too.
import { normalizeBotsTarget } from '../botsNavigation.js';
import { agentAvatar } from '../agentAvatar.js';

const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));

export async function render(container, tabId, options = {}) {
  const { tab, ...rest } = normalizeBotsTarget('agents', options);
  const note = document.createElement('div');
  note.className = 'empty-state'; note.setAttribute('role', 'status'); note.textContent = 'Opening Bots...';
  container.replaceChildren(note);
  queueMicrotask(() => go(tab, rest));
}

export function avatar(agent, size = 28) {
  return agentAvatar(agent, size);
}

export function openProfile(agentId) {
  const { tab, ...rest } = normalizeBotsTarget('agents', { agentId, profile: true });
  go(tab, rest);
}
