// The app's modes (Agents 3.0 Phase 0, unit U3): Kairos, Forge and Bots. The
// pure parts of app.js live here, with no DOM and no imports, so Node can test
// them (scripts/test_bots_mode.cjs). app.js owns the state; this file owns the
// rules: which mode a stored value or a tab id means, the nav lists, the labels.
//
// Bots is for every account. Forge builds and runs apps on this computer, so it
// needs machine access (admins always have it); an account without it never
// lands in Forge, whatever was stored on the device. Browse (Kairos Browser
// Phase 1, D6) is for every account too, but only in the desktop app, where tabs
// are real native views; the web and phone clients never get it.

export const MODES = ['kairos', 'forge', 'bots', 'browse'];

export const FORGE_NAV = [
  { id: 'forgeHome', label: 'Home', icon: 'home' },
];

// `botsHome` is the roster; `botsShell` is one bot's page (options agentId,
// sessionId, panel). Only the roster is a nav item, like Forge Home.
export const BOTS_NAV = [
  { id: 'botsHome', label: 'Bots', icon: 'agents' },
];

export const MODE_LABELS = { kairos: 'Kairos', forge: 'Forge', bots: 'Bots', browse: 'Browse' };
// Forge and Bots carried a "Preview" badge until their phases finished (Phase 0
// design, Q4). David removed it everywhere on 2026-11-03 ("Remove everywhere").
export const MODE_BADGES = {};
// The switch's segments, in order: [mode, label].
export const MODE_SWITCH = MODES.map(mode => [mode, MODE_LABELS[mode]]);

// Title-bar text for tabs that are not in the Kairos nav.
export const TAB_LABELS = { forgeShell: 'Forge', botsHome: 'Bots', botsShell: 'Bots', botsAutomations: 'Automations', browse: 'Browse' };
export const BOTS_TEAM_TABS = { botsRoom: 'Room', botsTeamMap: 'Team map' };

const HOME_TABS = { kairos: 'home', forge: 'forgeHome', bots: 'botsHome', browse: 'browse' };

// The tab each mode opens on.
export function homeTabFor(mode) { return HOME_TABS[mode] || HOME_TABS.kairos; }

// Whether this account, in this client, may be in a mode.
export function modeAllowed(mode, machineAccess, desktop = false, signedIn = true) {
  if (mode === 'kairos') return true;
  if (mode === 'browse') return !!desktop;
  if (mode === 'bots') return !!signedIn;
  return mode === 'forge' && !!machineAccess;
}

// What a stored mode (localStorage 'kairos:app-mode') means. Bots comes back for
// anyone signed in; Forge only with machine access; Browse only in the desktop
// app; anything unknown is Kairos.
export function restoreMode(stored, machineAccess, signedIn = true, desktop = false) {
  return typeof stored === 'string' && stored !== 'kairos' && MODES.includes(stored) && modeAllowed(stored, machineAccess, desktop, signedIn) ? stored : 'kairos';
}

// The switch's segments this account sees.
export function switchModes(machineAccess, desktop = false) {
  return MODE_SWITCH.filter(([mode]) => modeAllowed(mode, machineAccess, desktop));
}

// The mode a tab id belongs to.
export function modeForTab(tabId) {
  if (tabId === 'browse') return 'browse';
  if (tabId === 'forgeShell' || FORGE_NAV.some(item => item.id === tabId)) return 'forge';
  if (tabId === 'botsShell' || tabId === 'botsAutomations' || Object.hasOwn(BOTS_TEAM_TABS, tabId) || BOTS_NAV.some(item => item.id === tabId)) return 'bots';
  return 'kairos';
}

// The collapsed sidebar shows one button, the Kairos mark. It steps through the
// modes: Kairos, Bots, Forge, back to Kairos.
const RAIL_ORDER = ['kairos', 'bots', 'forge'];
// `allowed` (optional) limits the steps to the modes this account may use.
export function nextRailMode(mode, allowed = RAIL_ORDER) {
  const order = Array.isArray(allowed) ? RAIL_ORDER.filter(item => allowed.includes(item)) : RAIL_ORDER;
  const at = order.indexOf(mode);
  return order[(at + 1) % order.length] || 'kairos';
}

// The collapsed button's spoken name: where it goes next.
export function railLabel(mode, allowed = RAIL_ORDER) {
  const next = nextRailMode(mode, allowed);
  return `Switch to ${MODE_LABELS[next]}`;
}

// Mode entry is observed here so Home, a bot deep link and restored Bots mode
// share the same once-per-person welcome. Pure policy helpers above stay usable in Node.
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  let control = null, mode = '', handle = null;
  const sync = () => {
    const next = document.documentElement.dataset.appMode;
    if (next === mode) return;
    mode = next; control?.abort(); handle?.destroy?.(); handle = null;
    if (next !== 'bots') return;
    control = new AbortController(); const signal = control.signal;
    import('./botsPrefs.js').then(module => { if (!signal.aborted) module.applyBotsPrefs(); }).catch(() => {
      if (signal.aborted) return;
      const note = document.createElement('p'); note.className = 'bots-onboarding-error'; note.textContent = 'Bots preferences could not load. Reopen Bots to try again.';
      document.body.append(note); signal.addEventListener('abort', () => note.remove(), { once: true });
    });
    import('./botsWelcome.js').then(module => module.enterBots({ signal })).then(mounted => {
      if (signal.aborted) mounted?.destroy?.(); else handle = mounted;
    }).catch(error => {
      if (signal.aborted || error.name === 'AbortError') return;
      const note = document.createElement('p'); note.className = 'bots-onboarding-error'; note.setAttribute('role', 'status');
      note.textContent = 'Welcome could not load. Reopen Bots to try again.'; document.body.append(note);
      signal.addEventListener('abort', () => note.remove(), { once: true });
    });
  };
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-mode'] });
  queueMicrotask(sync);
}
