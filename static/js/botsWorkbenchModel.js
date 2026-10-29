// Pure workbench state shared by the tabs and the Node checks.
export const PHASES = Object.freeze({
  docker_missing: { message: 'Docker is not ready', action: 'settings', label: 'Open Settings' },
  image_needed: { message: 'Prepare the computer', action: 'prepare', label: 'Prepare' },
  asleep: { message: 'Computer is asleep', action: 'start', label: 'Start' },
  starting: { message: 'Starting the computer', action: 'refresh', label: 'Check again' },
  ready: { message: 'Computer is ready', action: 'take', label: 'Take control' },
  busy: { message: 'The bot is using the computer', action: 'take', label: 'Take control' },
  taken: { message: 'You have the wheel', action: 'release', label: 'Hand back' },
  browser_only: { message: 'Working in the browser', action: 'take', label: 'Take control' },
  off: { message: 'Computer use is off', action: 'place', label: 'Choose a place' },
  error: { message: 'The computer could not start', action: 'start', label: 'Retry' },
});
export const WIDTH_KEY = 'kairos:bots-workbench-width';
export const clampWidth = width => Math.max(360, Math.min(960, Number(width) || 400));
export const tabsFor = advanced => advanced ? ['computer', 'browser', 'data', 'files', 'routines'] : ['computer', 'browser', 'data', 'files'];
export const pollCadence = phase => ['starting', 'taken', 'busy'].includes(phase) ? 1000 : ['ready', 'browser_only'].includes(phase) ? 4000 : 30000;
export function phaseView(status) {
  const phase = PHASES[status?.phase] || PHASES.error;
  return { ...phase, message: status?.message || phase.message };
}
export const placeHint = place => place.available ? '' : place.reason || 'Unavailable';
export function createLease() {
  let lease = null;
  return { taken: result => { lease = result.lease_id; }, release: () => ({ action: 'release', lease_id: lease }),
    clear: () => { lease = null; }, get id() { return lease; } };
}
export function addressUrl(text, search = 'https://www.google.com/search?q={query}') {
  const value = text.trim();
  if (!value) throw new Error('Enter an address or search');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a web address');
    return url.href;
  }
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(value)) return `https://${value}`;
  return search.replace('{query}', encodeURIComponent(value));
}

// Local lifecycle for every mount: late reads cannot paint a replacement view.
export function lifetime(ctx = {}) {
  const controller = new AbortController();
  const cleanups = [];
  const destroy = () => { if (!controller.signal.aborted) { controller.abort(); for (const fn of cleanups.splice(0)) fn(); } };
  if (ctx.signal?.aborted) destroy();
  else if (ctx.signal) { ctx.signal.addEventListener('abort', destroy, { once: true }); cleanups.push(() => ctx.signal.removeEventListener('abort', destroy)); }
  return { signal: controller.signal, get active() { return !controller.signal.aborted; }, destroy,
    own: fn => { if (controller.signal.aborted) fn(); else cleanups.push(fn); }, handle: refresh => ({ destroy, dispose: destroy, refresh, flush: async () => true }) };
}
