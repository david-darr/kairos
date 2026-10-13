// Persistent (module-level, survives tab switches) registry of in-flight
// chat projections. Execution belongs to the host; these are subscribers.
// David's ask 2026-09-12: leaving a chat mid-reply to check
// another tab, then coming back, showed nothing until the turn finished —
// root cause was that the fetch+stream-reading loop lived entirely inside
// views/chat.js's per-render closure, writing into DOM nodes app.js's
// switchTab() had already wiped. The request itself was never actually
// cancelled (fetch doesn't auto-abort just because its caller's DOM is
// gone) — it just had nowhere left to write. Moving the network/streaming
// logic here, one level above any single view, means any view (or the
// floating overlay in floatingProgress.js) can attach to a session's
// ongoing turn and see the same live text, regardless of which view
// actually sent the message.

const _inflight = new Map(); // sessionId -> { text, status, sessionTitle, listeners: Set<fn> }
const _globalListeners = new Set(); // fn(sessionId, entry|null)

// How long a finished entry stays visible/attachable after completing —
// long enough for a floating card (or a chat view reattaching right as it
// finishes) to show the done/failed state before it's gone, short enough
// not to look stuck (David's ask: "~4 seconds then fade").
const FINISHED_RETENTION_MS = 4000;

function _notify(sessionId) {
  const entry = _inflight.get(sessionId) || null;
  if (entry) for (const cb of entry.listeners) cb(entry);
  for (const cb of _globalListeners) cb(sessionId, entry);
}

// Stops a running turn. Safe to call when nothing is running, so callers
// (barge-in especially) never have to check first.
export function stopTurn(sessionId) {
  const entry = _inflight.get(sessionId);
  if (!entry || entry.status !== 'processing') return false;
  entry.stopRequested = true;
  if (entry.managedId) _stopOnHost(sessionId, entry);
  else if (entry.connected) { entry.stopped = true; entry.controller.abort(); }
  return true;
}

export function getInFlight(sessionId) {
  return _inflight.get(sessionId) || null;
}

export function clearPermission(sessionId, requestId) {
  const entry = _inflight.get(sessionId);
  if (entry?.permission?.id !== requestId) return;
  if (entry.permissionStartedAt) entry.pausedSeconds = (entry.pausedSeconds || 0) + Date.now() / 1000 - entry.permissionStartedAt;
  entry.permissionStartedAt = null;
  entry.permissions = (entry.permissions || []).filter(p => p.id !== requestId);
  entry.permission = entry.permissions[0] || null;
  _notify(sessionId);
}

export function listInFlight() {
  return [..._inflight.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry }));
}

// Returns an unsubscribe function. Silently a no-op to subscribe to a
// session with no in-flight entry (nothing to attach to) — callers should
// check getInFlight() first if they need to know whether it's worth it.
export function subscribe(sessionId, callback) {
  const entry = _inflight.get(sessionId);
  if (!entry) return () => {};
  entry.listeners.add(callback);
  return () => entry.listeners.delete(callback);
}

export function subscribeAll(callback) {
  _globalListeners.add(callback);
  return () => _globalListeners.delete(callback);
}

// Synchronous: registers the in-flight entry immediately (so a caller can
// subscribe() right after this returns and not race the first chunk),
// then runs the actual request in the background.
export function startTurn(sessionId, sessionTitle, text, attachmentIds, references = []) {
  if (_inflight.get(sessionId)?.status === 'processing') throw new Error('This chat already has a response in progress');
  // The controller lives on the entry rather than in a closure so stopTurn()
  // can reach it from anywhere - the composer's stop button, a tab switch, or
  // Open Mic barge-in - without the caller having to hold a reference.
  const controller = new AbortController();
  const entry = { text: "", prompt: text, requestId: crypto.randomUUID(), startedAt: Date.now() / 1000, status: "processing", connected: false, sessionTitle, error: null, controller, listeners: new Set() };
  _inflight.set(sessionId, entry);
  _notify(sessionId);
  _runTurn(sessionId, entry, text, attachmentIds, references);
  return entry;
}

async function _runTurn(sessionId, entry, text, attachmentIds, references) {
  let retries = 0;
  while (entry.status === 'processing') {
    try {
      await _readTurn(sessionId, entry, text, attachmentIds, references);
      break;
    } catch (error) {
      if (entry.stopped) { entry.status = 'stopped'; break; }
      if (error.fatal || (!entry.managedId && entry.connected)) {
        entry.status = 'failed'; entry.error = error.message; break;
      }
      // Phone sleep, network loss and reader cancellation detach only the
      // subscriber. Retry the same start ID or attach to the accepted run.
      entry.connected = false;
      _notify(sessionId);
      await new Promise(resolve => setTimeout(resolve, Math.min(30000, 1000 * 2 ** Math.min(retries++, 5))));
      entry.controller = new AbortController();
    }
  }
  entry.endedAt = Date.now() / 1000;
  _notify(sessionId);
  setTimeout(() => {
    if (_inflight.get(sessionId) === entry) { _inflight.delete(sessionId); _notify(sessionId); }
  }, FINISHED_RETENTION_MS);
}

function _applySnapshot(sessionId, entry, snapshot) {
  for (const old of entry.permissions || []) if (!(snapshot.permissions || []).some(p => p.id === old.id))
    document.dispatchEvent(new CustomEvent('kairos:permission-closed', { detail: { id: old.id } }));
  entry.managedId = snapshot.id;
  entry.runId = snapshot.id;
  entry.text = snapshot.text;
  entry.startedAt = snapshot.started_at;
  entry.sessionTitle = snapshot.title;
  entry.toolSteps = snapshot.tool_steps || [];
  entry.toolEvents = snapshot.tool_events || [];
  entry.permissions = snapshot.permissions || [];
  entry.permission = entry.permissions[0] || null;
  entry.error = snapshot.error || null;
  entry.handoffs = snapshot.handoffs;
  entry.status = ({ completed: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'failed' })[snapshot.state] || 'processing';
  _notify(sessionId);
  if (entry.stopRequested && entry.status === 'processing') _stopOnHost(sessionId, entry);
}

async function _stopOnHost(sessionId, entry) {
  if (entry.stopping) return;
  entry.stopping = true;
  try {
    const res = await fetch(`/api/chat/runs/${entry.managedId}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error('Stop could not reach Kairos. Reconnect and try again.');
    _applySnapshot(sessionId, entry, await res.json());
    entry.stopped = entry.status === 'stopped';
    entry.controller.abort();
  } catch (error) { entry.error = error.message; entry.stopRequested = false; _notify(sessionId); }
  finally { entry.stopping = false; }
}

async function _readTurn(sessionId, entry, text, attachmentIds, references) {
  try {
    const res = await fetch(entry.managedId ? `/api/chat/runs/${entry.managedId}/events` : "/api/chat/stream", entry.managedId ? {
      signal: entry.controller.signal,
    } : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text, attachment_ids: attachmentIds, references, request_id: entry.requestId }),
      signal: entry.controller.signal,
    });
    if (!res.ok || !res.body) {
      let detail = `Stream failed (${res.status})`;
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      const error = new Error(detail);
      error.fatal = res.status >= 400 && res.status < 500;
      throw error;
    }

    entry.connected = true;
    _notify(sessionId);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const data = line.split(/\r?\n/).filter(row => row.startsWith('data:')).map(row => row.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch (_) { throw new Error('Invalid response stream'); }
        if (payload.snapshot) {
          _applySnapshot(sessionId, entry, payload.snapshot);
          completed = entry.status !== 'processing';
        }
        if (payload.error) {
          entry.error = payload.error;
          if (!entry.managedId) { const error = new Error(payload.error); error.fatal = true; throw error; }
        }
        if (payload.done === true) {
          completed = true;
          entry.status = ({ completed: 'done', stopped: 'stopped', failed: 'failed', interrupted: 'failed' })[payload.state] || 'done';
          for (const request of entry.permissions || []) document.dispatchEvent(new CustomEvent('kairos:permission-closed', { detail: { id: request.id } }));
          entry.permissions = []; entry.permission = null;
        }
        if (payload.chunk) {
          entry.text += payload.chunk;
          _notify(sessionId);
        }
        if (payload.permission) {
          // Held on the entry rather than shown from here: this module is
          // transport only, and a request must survive the user switching
          // tabs and coming back mid-turn.
          entry.permissions ||= [];
          if (!entry.permissions.some(p => p.id === payload.permission.id)) entry.permissions.push(payload.permission);
          entry.permission = entry.permissions[0];
          entry.permissionStartedAt = Date.now() / 1000;
          _notify(sessionId);
        }
        if (payload.permission_closed) {
          document.dispatchEvent(new CustomEvent('kairos:permission-closed', { detail: { id: payload.permission_closed } }));
          entry.permissions = (entry.permissions || []).filter(p => p.id !== payload.permission_closed);
          entry.permission = entry.permissions[0] || null;
          _notify(sessionId);
        }
        if (payload.handoffs) {
          entry.handoffs = payload.handoffs;
          _notify(sessionId);
        }
        if (payload.tool_event) {
          entry.runId = payload.run_id;
          entry.toolEvents ||= [];
          entry.toolEvents.push(payload.tool_event);
          _notify(sessionId);
        }
        if (payload.tool_step) {
          entry.runId = payload.run_id;
          entry.toolSteps ||= [];
          entry.toolSteps.push(payload.tool_step);
          _notify(sessionId);
        }
      }
      if (done) break;
    }
    if (!completed) throw new Error('Connection ended before the response finished. Reopen this chat to recover any saved reply.');
    if (entry.status === 'processing') entry.status = "done";
  } catch (e) {
    throw e;
  }
}

export async function restoreInFlight() {
  try {
    const res = await fetch('/api/chat/runs');
    if (!res.ok) return;
    const snapshots = await res.json();
    if (!Array.isArray(snapshots)) return;
    for (const snapshot of snapshots) {
      const sessionId = snapshot.session_id;
      if (_inflight.get(sessionId)?.status === 'processing') continue;
      const entry = { text: '', status: 'processing', connected: false, controller: new AbortController(), listeners: new Set() };
      _inflight.set(sessionId, entry);
      _applySnapshot(sessionId, entry, snapshot);
      _runTurn(sessionId, entry);
    }
  } catch (_) { /* Offline boot can still show saved UI; retry on return. */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  for (const entry of _inflight.values()) if (entry.status === 'processing' && entry.managedId) entry.controller.abort();
  restoreInFlight();
});
window.addEventListener('online', restoreInFlight);
