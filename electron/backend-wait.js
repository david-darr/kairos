// Waiting for the backend to answer (2026-11-10, the 2.3.0 upgrade rehearsal: the first start on David's
// 8 GB profile moved his data for 33 minutes, and this window gave up after 2 and said "couldn't start").
//
// Before the backend can answer, core/startup_progress.py answers /api/health with 503 and
// {"status": "updating", "phase", "detail", "done", "total"} while it restores a backup or moves data into
// account folders. So the wait has two limits:
// - nothing answering at all: timeoutMs from the start, as before;
// - an update under way: it waits as long as the progress keeps changing, and gives up only when it has
//   not changed for stallMs (a real stall). The few seconds after the update, while the app itself starts,
//   count against the same limit from the last change.
// Pure, so scripts/test_backend_wait.cjs drives it with a fake clock and fake answers.

const UPDATE_HEADLINE = "Updating your data for this version. This can take a few minutes. Don't close Kairos.";

function describe(state) {
  if (!state) return "";
  const counted = state.total > 0 ? ` (${Math.min(state.done, state.total)} of ${state.total})` : "";
  return `${state.detail || "Working"}${counted}`;
}

async function waitForBackend({ fetchImpl, baseUrl, timeoutMs, stallMs, onWaiting, onUpdating, sleep, now }) {
  const started = now();
  let lastChange = started;
  let lastKey = null;
  let updating = false;
  let lastState = null;
  for (;;) {
    let state = null;
    try {
      const res = await fetchImpl(`${baseUrl}/api/health`);
      if (res.ok) return { ok: true, updated: updating };
      if (res.status === 503) {
        const body = await res.json().catch(() => null);
        if (body && body.status === "updating") state = body;
      }
    } catch (_) { /* not up yet */ }
    const at = now();
    if (state) {
      updating = true;
      lastState = state;
      const key = JSON.stringify([state.phase, state.detail, state.done, state.total]);
      if (key !== lastKey) { lastKey = key; lastChange = at; }
      if (onUpdating) onUpdating(state);
    } else if (onWaiting) {
      onWaiting(at - started, updating);
    }
    if (at - lastChange >= (updating ? Math.max(stallMs, timeoutMs) : timeoutMs)) {
      return { ok: false, updated: updating, stalled: updating, last: lastState };
    }
    await sleep(500);
  }
}

module.exports = { waitForBackend, describe, UPDATE_HEADLINE };
