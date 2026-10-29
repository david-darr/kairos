// The app's modes (Agents 3.0 Phase 0, unit U3): Kairos, Forge and Bots. The
// pure parts of app.js live here, with no DOM and no imports, so Node can test
// them (scripts/test_bots_mode.cjs). app.js owns the state; this file owns the
// rules: which mode a stored value or a tab id means, the nav lists, the labels.
//
// Forge and Bots are admin-only (David's D2: one person). A non-admin is always
// in Kairos, whatever was stored on the device.

export const MODES = ['kairos', 'forge', 'bots'];

export const FORGE_NAV = [
  { id: 'forgeHome', label: 'Home', icon: 'home' },
];

// `botsHome` is the roster; `botsShell` is one bot's page (options agentId,
// sessionId, panel). Only the roster is a nav item, like Forge Home.
export const BOTS_NAV = [
  { id: 'botsHome', label: 'Bots', icon: 'agents' },
];

export const MODE_LABELS = { kairos: 'Kairos', forge: 'Forge', bots: 'Bots' };
// Forge and Bots carry a "Preview" badge on the switch until their phases finish
// (Phase 0 design, Q4).
export const MODE_BADGES = { forge: 'Preview', bots: 'Preview' };
// The switch's segments, in order: [mode, label].
export const MODE_SWITCH = MODES.map(mode => [mode, MODE_LABELS[mode]]);

// Title-bar text for tabs that are not in the Kairos nav.
export const TAB_LABELS = { forgeShell: 'Forge', botsHome: 'Bots', botsShell: 'Bots', botsAutomations: 'Automations' };

const HOME_TABS = { kairos: 'home', forge: 'forgeHome', bots: 'botsHome' };

// The tab each mode opens on.
export function homeTabFor(mode) { return HOME_TABS[mode] || HOME_TABS.kairos; }

// What a stored mode (localStorage 'kairos:app-mode') means. Only an admin gets
// Forge or Bots back; anything unknown is Kairos.
export function restoreMode(stored, isAdmin) {
  return isAdmin && (stored === 'forge' || stored === 'bots') ? stored : 'kairos';
}

// The mode a tab id belongs to.
export function modeForTab(tabId) {
  if (tabId === 'forgeShell' || FORGE_NAV.some(item => item.id === tabId)) return 'forge';
  if (tabId === 'botsShell' || tabId === 'botsAutomations' || BOTS_NAV.some(item => item.id === tabId)) return 'bots';
  return 'kairos';
}

// The collapsed sidebar shows one button, the Kairos mark. It steps through the
// modes: Kairos, Bots, Forge, back to Kairos.
const RAIL_ORDER = ['kairos', 'bots', 'forge'];
export function nextRailMode(mode) {
  const at = RAIL_ORDER.indexOf(mode);
  return RAIL_ORDER[(at + 1) % RAIL_ORDER.length];
}

// The collapsed button's spoken name: where it goes next.
export function railLabel(mode) {
  const next = nextRailMode(mode);
  return next === 'kairos' ? 'Switch to Kairos' : `Switch to ${MODE_LABELS[next]} Preview`;
}
