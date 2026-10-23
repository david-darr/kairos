// One leave guard for the whole app (2026-10-22): before any navigation tears
// the current view down, the view's own unsaved-changes guard is asked first.
const guards = new Set();
let pending = null;
export function registerLeaveGuard(fn) { guards.add(fn); return () => guards.delete(fn); }
export const hasLeaveGuard = () => guards.size > 0;
// Resolves true when every guard allows leaving. A second navigation while a
// prompt is open shares that prompt instead of stacking another.
export function canLeaveView() {
  if (!guards.size) return Promise.resolve(true);
  if (pending) return pending;
  pending = (async () => { for (const fn of [...guards].reverse()) if (!await fn()) return false; return true; })()
    .catch(() => false).finally(() => { pending = null; });
  return pending;
}
