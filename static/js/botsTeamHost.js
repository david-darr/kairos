// The lazy boundary shared by the team, room and panel surfaces.
import { h, Button, IconButton, loadBotsCss } from './botsUi.js';
import { normalizeBotsTarget, targetId } from './botsNavigation.js';
import { registerLeaveGuard } from './leaveGuard.js';

const loaders = {
  newRoom: () => import('./botsNewRoom.js'), roomPanel: () => import('./botsRoomPanel.js'),
  room: () => import('./views/botsRoom.js'), reach: () => import('./botsSectionReach.js'),
  team: () => import('./botsTeamDialogs.js'), instructions: () => import('./botsTeamInstructions.js'),
  memory: () => import('./botsTeamMemory.js'), settings: () => import('./botsTeamSettings.js'),
};
const stubs = new Map();
export function stubBotsTeamModule(name, value) {
  const had = stubs.has(name), before = stubs.get(name);
  if (value === undefined) stubs.delete(name); else stubs.set(name, value);
  return () => { if (had) stubs.set(name, before); else stubs.delete(name); };
}
export async function loadBotsTeamModule(name) {
  if (stubs.has(name)) { const value = stubs.get(name); return typeof value === 'function' ? value() : value; }
  if (!Object.hasOwn(loaders, name)) throw new Error('Unknown team view');
  return loaders[name]();
}
export const teamRequest = async (path, { body, ...init } = {}) => (await import('./api.js')).api(path,
  { ...init, ...(body === undefined ? {} : { body: JSON.stringify(body) }), toast: false });
export const teamChanged = () => document.dispatchEvent(new CustomEvent('jarvis:agents-changed', { detail: { source: 'teams' } }));
export const teamNavigate = (tab, options) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: normalizeBotsTarget(tab, options) }));
export const departmentPath = id => { if (!targetId(id)) throw new Error('Choose a team first.'); return `/api/bot-departments/${encodeURIComponent(id)}`; };
export const teamError = error => String(error?.message || error || 'This could not load.').replace(/^\d+:\s*/, '');

export function mountTeamModule(host, name, ctx = {}) {
  let disposed = false, handle = null, generation = 0;
  async function refresh() {
    const at = ++generation;
    host.replaceChildren(h('p', { role: 'status', text: 'Loading...' }));
    try {
      const mod = await loadBotsTeamModule(name);
      if (disposed || at !== generation) return;
      if (typeof mod.mount !== 'function') throw new Error('The view has no mount.');
      (handle?.destroy || handle?.dispose)?.call(handle); host.replaceChildren();
      const next = await mod.mount(host, ctx);
      if (disposed || at !== generation) { (next?.destroy || next?.dispose)?.call(next); return; }
      handle = next;
    } catch (error) {
      if (!disposed && at === generation) host.replaceChildren(h('p', { role: 'alert', text: `This view could not load. ${teamError(error)}` }), Button({ label: 'Try again', onClick: refresh }));
    }
  }
  refresh();
  return { refresh, flush: () => handle?.flush?.(), destroy() { disposed = true; ++generation; (handle?.destroy || handle?.dispose)?.call(handle); host.replaceChildren(); } };
}

async function openModule(name, options = {}) {
  try {
    const mod = await loadBotsTeamModule(name);
    const run = mod.open || mod[`open${name === 'newRoom' ? 'NewRoom' : 'RoomPanel'}`];
    if (typeof run !== 'function') throw new Error('The view has no open function.');
    return await run(options);
  } catch (error) {
    const dialog = openTeamSurface({ title: 'Could not load', width: 440 });
    dialog.body.append(h('p', { role: 'alert', text: `This view could not load. ${teamError(error)}` }), Button({ label: 'Try again', onClick: () => { dialog.destroy(); openModule(name, options); } }));
    return dialog;
  }
}
export const openNewRoom = options => openModule('newRoom', options);
export const openRoomPanel = options => openModule('roomPanel', options);
export const openTeamDialog = options => openModule('team', options);
export const openTeamInstructions = options => openModule('instructions', options);
export const openTeamMemory = options => openModule('memory', options);
export const openTeamSettings = options => openModule('settings', options);

// Native dialog keeps keyboard focus in the surface. All exit paths run the dirty guard.
export function openTeamSurface({ title, width = 680, beforeClose, onClose } = {}) {
  loadBotsCss('/static/css/bots-teams.css');
  const opener = document.activeElement;
  const body = h('div', { class: 'bots-team-dialog-body' });
  const footer = h('div', { class: 'bots-team-actions' });
  const dialog = h('dialog', { class: 'bots-team-dialog', 'aria-label': title });
  dialog.style.width = `${width}px`;
  let disposed = false, asking = false;
  let unguard = () => {};
  const destroy = () => { if (disposed) return; disposed = true; unguard(); dialog.close(); dialog.remove(); onClose?.(); if (opener?.isConnected) opener.focus(); };
  const close = async () => {
    if (asking || disposed) return false;
    asking = true;
    try { if (beforeClose && !await beforeClose()) return false; destroy(); return true; }
    finally { asking = false; }
  };
  dialog.append(h('header', { class: 'bots-team-dialog-head' }, [h('h2', { text: title }), IconButton({ label: 'Close', iconName: 'x', onClick: close })]), body, footer);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const b = dialog.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close(); } });
  document.body.append(dialog); dialog.showModal();
  unguard = registerLeaveGuard(close);
  return { dialog, body, footer, close, destroy, get disposed() { return disposed; } };
}

// An inline guard remains in the dialog's top layer, so no global confirm is needed.
export function confirmTeamAction(host, { title, confirmLabel = 'Continue' } = {}) {
  return new Promise(resolve => {
    const finish = value => { box.remove(); resolve(value); };
    const box = h('div', { class: 'bots-team-confirm', role: 'alertdialog', 'aria-label': title }, [
      h('p', { text: title }), Button({ label: 'Cancel', onClick: () => finish(false) }),
      Button({ label: confirmLabel, variant: 'primary', onClick: () => finish(true) }),
    ]);
    host.append(box); box.querySelector('button')?.focus();
  });
}
