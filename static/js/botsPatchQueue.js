// The debounced, optimistic settings queue behind every control in a bot's panel
// (Agents 3.0 Phase 0, unit U4; OMB feature F5, re-written for Kairos).
//
// One lane per bot. A change is merged into the lane's pending patch and sent 400 ms
// after the last change, so a person typing or flipping several switches costs one
// PATCH. The overlay holds what the person has changed but the server has not
// confirmed, so a poll that lands meanwhile cannot put an old value back on screen.
// Model and approval changes skip the wait. A failed send forgets the overlay and
// re-reads the bot, so the screen shows what is really stored, and tells the caller.
//
// Pure logic: the sender, the re-read and the timers are injected, so
// scripts/test_bots_patch_queue.cjs drives it with a fake clock.

// Changes that are sent at once (the person is choosing what the next turn runs on).
export const BYPASS_KEYS = Object.freeze(['approval_mode', 'endpoint_id', 'model_override', 'model_effort']);
export const DEBOUNCE_MS = 400;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// send(agentId, body) -> Promise<agent>      the PATCH
// reread(agentId)     -> Promise<agent>      GET the bot, for a rollback
// onSaved(agentId, agent, body), onRollback(agentId, agent|null, error): both optional
export function createPatchQueue({ send, reread, onSaved, onRollback, setTimer = setTimeout, clearTimer = clearTimeout, debounceMs = DEBOUNCE_MS } = {}) {
  const lanes = new Map();
  const lane = id => {
    if (!lanes.has(id)) lanes.set(id, { pending: {}, timer: null, running: null, overlay: {}, waiters: [] });
    return lanes.get(id);
  };

  async function drain(id) {
    const l = lane(id);
    if (l.running) return l.running;
    if (!Object.keys(l.pending).length) return;
    l.running = (async () => {
      try {
        // Take whatever is pending at the moment; changes made while it is in flight form the next send,
        // after their own 400 ms (a waiting timer sends them) unless a flush cleared that timer.
        while (Object.keys(l.pending).length && !l.timer) {
          const body = l.pending; l.pending = {};
          const waiters = l.waiters.splice(0);
          try {
            const agent = await send(id, body);
            // Keep an overlay value only if the person changed it again since this send.
            for (const key of Object.keys(body)) if (same(l.overlay[key], body[key])) delete l.overlay[key];
            onSaved?.(id, agent, body);
          } catch (error) {
            l.pending = {}; l.overlay = {};
            if (l.timer) clearTimer(l.timer);
            l.timer = null;
            waiters.push(...l.waiters.splice(0));
            let fresh = null;
            try { fresh = await reread?.(id); } catch { /* the caller is told with null */ }
            onRollback?.(id, fresh, error);
          } finally {
            waiters.forEach(resolve => resolve());
          }
        }
      } finally {
        l.running = null;
      }
    })();
    return l.running;
  }

  function flushLane(id) {
    const l = lane(id);
    if (l.timer) { clearTimer(l.timer); l.timer = null; }
    return drain(id);
  }

  return {
    // Queue a change. Returns a promise that settles once it has been sent (never rejects).
    update(id, body, { immediate = false } = {}) {
      const l = lane(id);
      const keys = Object.keys(body || {});
      if (!keys.length) return Promise.resolve();
      Object.assign(l.pending, body);
      Object.assign(l.overlay, body);
      const done = new Promise(resolve => l.waiters.push(resolve));
      if (immediate || keys.some(key => BYPASS_KEYS.includes(key))) { flushLane(id); return done; }
      if (l.timer) clearTimer(l.timer);
      l.timer = setTimer(() => { l.timer = null; drain(id); }, debounceMs);
      return done;
    },
    // The unconfirmed changes for a bot, laid over a record read from the server.
    overlayFor: id => ({ ...(lanes.get(id)?.overlay || {}) }),
    apply: agent => (agent && lanes.get(agent.id) ? { ...agent, ...lanes.get(agent.id).overlay } : agent),
    isPending: id => { const l = lanes.get(id); return !!l && (!!Object.keys(l.pending).length || !!l.running); },
    // Send everything now and wait for it. With no id, every bot's lane.
    async flush(id) {
      const ids = id ? [id] : [...lanes.keys()];
      await Promise.all(ids.map(async one => { await flushLane(one); await lane(one).running; }));
    },
    // Drop a bot's queued changes (it was deleted).
    cancel(id) {
      const l = lanes.get(id);
      if (!l) return;
      if (l.timer) clearTimer(l.timer);
      l.timer = null; l.pending = {}; l.overlay = {};
      l.waiters.splice(0).forEach(resolve => resolve());
    },
  };
}
