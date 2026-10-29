// The old agent profile sheet, retired (Bots Phase 1, unit U4). A bot's profile is
// the Bots panel (botsPanel.js); these exports stay so an older import keeps
// working, and send the person to that panel.
import { normalizeBotsTarget } from './botsNavigation.js';

// Opens a bot's panel on a section (Overview when none is named).
export function openAgentProfile(agentId, section = true) {
  const { tab, ...options } = normalizeBotsTarget('agents', { agentId, profile: section });
  document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
}

// The old mount took a root element and drew the sheet into it. It now opens the
// panel and leaves the root alone.
export function mountAgentProfile(root, initial) {
  const id = initial?.agent?.id || initial?.id;
  if (id) openAgentProfile(id);
  return { open: () => id && openAgentProfile(id), close() {}, dispose() {} };
}
