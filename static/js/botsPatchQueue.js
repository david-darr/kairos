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
// The page's one queue: botsPanel.js registers it, and flushBotEdits(id) (used by the conversation
// composer before every send) goes through it. With no panel loaded nothing can be pending.
let shared = null;
export function setSharedQueue(queue) { shared = queue; }
// Send a bot's pending settings edits and say whether they are saved: {ok, agent, error?}. Never rejects.
export async function flushBotEdits(id) {
  if (!shared) return { ok: true, agent: null };
  try { return await shared.flushResult(id); } catch (error) { return { ok: false, agent: null, error }; }
}

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
    if (!lanes.has(id)) lanes.set(id, { pending: {}, timer: null, running: null, overlay: {}, waiters: [], failure: null, saved: null });
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
            l.saved = agent;
            onSaved?.(id, agent, body);
          } catch (error) {
            l.failure = error;
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
    // flush() that says whether the settings really are saved: {ok, agent, error}. It never rejects.
    // A save that failed since the last call (a debounced one the person never waited for) is
    // reported here once, so a caller about to act on the settings, such as sending a message,
    // stops instead of running with values the person did not choose.
    async flushResult(id) {
      try { await this.flush(id); } catch (error) { return { ok: false, agent: null, error }; }
      const l = lane(id);
      const error = l.failure;
      l.failure = null;
      return error ? { ok: false, agent: l.saved, error } : { ok: true, agent: l.saved };
    },
    // Drop a bot's queued changes (it was deleted).
    cancel(id) {
      const l = lanes.get(id);
      if (!l) return;
      if (l.timer) clearTimer(l.timer);
      l.timer = null; l.pending = {}; l.overlay = {}; l.failure = null;
      l.waiters.splice(0).forEach(resolve => resolve());
    },
  };
}
