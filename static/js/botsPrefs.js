import { loadBotsCss, applyBotsInterface, setAdvanced, isAdvanced } from './botsUi.js';
import { sidebarPreferenceKey, teamSidebarPreferences, DENSITIES } from './botsSidebarModel.js';

export const PREFS = {
  sendKey: { key: 'kairos:bots-send-key', fallback: 'enter', values: ['enter', 'shift-enter', 'mod-enter'], attr: 'botsSendKey' },
  width: { key: 'kairos:bots-chat-width', fallback: 'default', values: ['default', 'wide', 'full'], attr: 'botsWidth' },
  tools: { key: 'kairos:bots-show-tool-calls', fallback: 'true', values: ['true', 'false'], attr: 'botsTools' },
  bubbles: { key: 'kairos:bots-colour-bubbles', fallback: 'true', values: ['true', 'false'], attr: 'botsBubbles' },
  font: { key: 'kairos:bots-font', fallback: 'inter', values: ['inter', 'system', 'serif'], attr: 'botsChatFont' },
  threads: { key: 'kairos:bots-show-threads', fallback: 'true', values: ['true', 'false'], attr: 'botsThreads' },
  pins: { key: 'kairos:bots-pinned-circles', fallback: 'true', values: ['true', 'false'], attr: 'botsPins' },
  runCard: { key: 'kairos:bots-run-card', fallback: 'true', values: ['true', 'false'], attr: 'botsRunCard' },
  // Advanced: pinned bots leave the list for a panel at the top of the sidebar that stays while the list scrolls.
  universalPins: { key: 'kairos:bots-universal-pins', fallback: 'false', values: ['true', 'false'], attr: 'botsUniversalPins' },
};
const memory = new Map();
export function getPref(name) {
  if (name === 'interface') return isAdvanced() ? 'advanced' : 'simple';
  const spec = PREFS[name]; if (!spec) throw new Error('Unknown Bots preference');
  let value = memory.get(name);
  try { value = localStorage.getItem(spec.key) ?? value; } catch {}
  return spec.values.includes(value) ? value : spec.fallback;
}
export function setPref(name, value) {
  if (name === 'interface') { if (!['simple', 'advanced'].includes(value)) throw new Error('Unknown interface'); setAdvanced(value === 'advanced'); return; }
  const spec = PREFS[name]; if (!spec?.values.includes(String(value))) throw new Error('Invalid Bots preference');
  value = String(value); memory.set(name, value);
  try { localStorage.setItem(spec.key, value); } catch {}
  if (typeof document !== 'undefined') { document.documentElement.dataset[spec.attr] = value;
    document.dispatchEvent(new CustomEvent('kairos:bots-prefs', { detail: { name, value } })); }
}
export function applyBotsPrefs() {
  loadBotsCss('/static/css/bots-prefs.css'); applyBotsInterface();
  for (const [name, spec] of Object.entries(PREFS)) document.documentElement.dataset[spec.attr] = getPref(name);
}
// Sidebar density is part of the sidebar's per-person layout (botsRail.js), so it is read and written there, never
// under a key of its own. An open sidebar hears the change and redraws.
const readSidebar = user => { try { return JSON.parse(localStorage.getItem(sidebarPreferenceKey(user)) || '{}'); } catch { return {}; } };
export function sidebarDensity(user) { return teamSidebarPreferences(readSidebar(user)).density; }
export function setSidebarDensity(user, value) {
  if (!DENSITIES.includes(value)) throw new Error('Unknown sidebar density');
  try { localStorage.setItem(sidebarPreferenceKey(user), JSON.stringify(teamSidebarPreferences({ ...readSidebar(user), density: value }))); } catch {}
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('kairos:bots-prefs', { detail: { name: 'density', value } }));
}
