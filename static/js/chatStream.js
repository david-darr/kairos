// One live feed for Chats, Forge, and the progress overlay. The backend owns
// each turn; this module only watches it. Closing this page never stops work.
// api.js drops its shared GET results on this event (a turn starting or ending changes saved state).
const dropSharedReads = () => { if (typeof document !== 'undefined' && document?.dispatchEvent) document.dispatchEvent(new Event('kairos:turn-state')); };
const _inflight = new Map();
const _listeners = new Map();
const _globalListeners = new Set();
const FINISHED_RETENTION_MS = 4000;
let source = null;
let syncing = null;
let connecting = null;
// When the server last spoke on the live feed (any packet, heartbeats included).
// It only stamps a time: a heartbeat never notifies, re-renders or refetches.
let lastPacketAt = 0;

function _notify(sessionId) {
  const entry = _inflight.get(sessionId) || null;
  if (entry) for (const callback of _listeners.get(sessionId) || []) callback(entry);
  for (const callback of _globalListeners) callback(sessionId, entry);
}

function _finish(sessionId, entry, status, error = null) {
  if (entry.status !== 'processing') return;
  dropSharedReads();  // a finished turn changed saved state: later reads must reach the server
  entry.status = status;
  entry.stopping = false;
  entry.permission = null;
  entry.error = error;
  entry.endedAt = Date.now() / 1000;
  _notify(sessionId);
  setTimeout(() => {
    if (_inflight.get(sessionId) === entry) {
      _inflight.delete(sessionId);
      _notify(sessionId);
    }
  }, FINISHED_RETENTION_MS);
}

function _mergeRun(sessionId, run) {
  const old = _inflight.get(sessionId);
  // A fresh browser reads completed replies from saved session history. The
  // recent terminal state is only for a viewer that was watching this turn.
  if (!old && run.status !== 'processing') return;
  const same = !old?.turnId || old.turnId === run.turnId;
  if (old && same && (old.revision || 0) > (run.revision || 0)) return;
  const entry = same ? old || {} : {};
  const wasProcessing = entry.status === 'processing';
  const wasLocal = entry.local && same;
  Object.assign(entry, run, { connected: true, local: !!wasLocal });
  if (run.permission && !entry.permissionStartedAt) entry.permissionStartedAt = Date.now() / 1000;
  if (!run.permission) entry.permissionStartedAt = null;
  _inflight.set(sessionId, entry);
  if (run.status !== 'processing' && (wasProcessing || !old || !same)) {
    entry.status = 'processing';
    _finish(sessionId, entry, run.status, run.error);
  } else {
    _notify(sessionId);
  }
}

async function _recoverMissing(sessionId, entry) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    if (!res.ok || _inflight.get(sessionId) !== entry || entry.status !== 'processing') return;
    const session = await res.json();
    const saved = [...(session.messages || [])].reverse().find(message => message.role === 'assistant' &&
      (entry.runId ? message.run_id === entry.runId : message.ts >= entry.startedAt - 1));
    if (saved) entry.text = saved.content || entry.text;
    _finish(sessionId, entry, saved?.status === 'interrupted' ? 'stopped' :
      saved?.status === 'failed' ? 'failed' : saved ? 'done' : 'failed',
      saved ? null : 'The server restarted before this reply completed.');
  } catch { /* The next reconnect will retry with a fresh snapshot. */ }
}

// Terminal pairing prompts (Kairos CLI) ride this feed to the app window
// only; static/js/cliPair.js shows them.
function _cliPair(type, detail) {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(type, { detail }));
}

function _snapshot(packet) {
  for (const request of packet.cliPairs || []) _cliPair('kairos:cli-pair', request);
  const incoming = packet.runs || {};
  for (const [sessionId, run] of Object.entries(incoming)) _mergeRun(sessionId, run);
  for (const [sessionId, entry] of _inflight) {
    if (!(sessionId in incoming) && entry.status === 'processing' && entry.turnId) _recoverMissing(sessionId, entry);
  }
  if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent('kairos:live-snapshot', { detail: packet }));
}

function _packet(packet) {
  lastPacketAt = Date.now();
  if (packet.type === 'heartbeat') return;
  if (['bg_tasks', 'bg_followup'].includes(packet.type)) { if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent(packet.type === 'bg_tasks' ? 'kairos:bg-tasks' : 'kairos:bg-followup', { detail: packet })); return; }
  if (packet.type === 'snapshot') { _snapshot(packet); return; }
  if (packet.type === 'cli_pair') { _cliPair('kairos:cli-pair', packet.request); return; }
  if (packet.type === 'cli_pair_closed') { _cliPair('kairos:cli-pair-closed', { id: packet.id }); return; }
  // The Design canvas redraws the boards a change touched (designCanvas.js).
  if (packet.type === 'design_changed') {
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('kairos:design-changed', { detail: packet }));
    return;
  }
  // Bots runtime frames (queue changes, turn lifecycle: U1's `bot.*` types) belong to the Bots conversation
  // that is open on that session. They never touch a live turn's text, so they are only handed on.
  if (['bot_card', 'bot_automation_change'].includes(packet.type)) {
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(packet.type === 'bot_card' ? 'kairos:bot-card' : 'kairos:bot-automation-change', { detail: packet }));
    return;
  }
  if (typeof packet.type === 'string' && (packet.type.startsWith('bot.') || ['bot_queue', 'bot_goal', 'bot_branch'].includes(packet.type))) {
    if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent('kairos:bot-runtime', { detail: packet }));
    return;
  }
  const sessionId = packet.sessionId;
  if (packet.type === 'started') { _mergeRun(sessionId, packet.run); return; }
  const entry = _inflight.get(sessionId);
  if (!entry || entry.turnId !== packet.turnId) { sync().catch(() => {}); return; }
  if (packet.revision && packet.revision <= (entry.revision || 0)) return;
  if (packet.revision) entry.revision = packet.revision;
  if (packet.type === 'chunk') entry.text += packet.chunk;
  else if (packet.type === 'tool_event') { (entry.toolEvents ||= []).push(packet.value); entry.waitingSince = null; }
  else if (packet.type === 'tool_step') {
    // Mirrors chat_live._stepped: a running tool is not a slow model; once it finishes the wait clock restarts.
    (entry.toolSteps ||= []).push(packet.value);
    entry.waitingSince = packet.value?.phase === 'finished' ? packet.value.at || Date.now() / 1000 : null;
    entry.providerDetail = null;
  }
  else if (packet.type === 'update') {
    const changes = packet.changes;
    if (changes.permission && !entry.permissionStartedAt) entry.permissionStartedAt = Date.now() / 1000;
    if ('permission' in changes && !changes.permission) {
      if (entry.permission && typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('kairos:permission-closed', { detail: { id: entry.permission.id } }));
      if (entry.permissionStartedAt) entry.pausedSeconds = (entry.pausedSeconds || 0) + Date.now() / 1000 - entry.permissionStartedAt;
      entry.permissionStartedAt = null;
    }
    if (changes.status && changes.status !== 'processing') {
      Object.assign(entry, { ...changes, status: 'processing' });
      _finish(sessionId, entry, changes.status, changes.error);
      return;
    }
    Object.assign(entry, changes);
  }
  _notify(sessionId);
}

export function sync() {
  if (syncing) return syncing;
  syncing = fetch('/api/chat/live/snapshot', { cache: 'no-store' }).then(async res => {
    if (!res.ok) throw new Error(`Live chat unavailable (${res.status})`);
    lastPacketAt = Date.now();
    _snapshot(await res.json());
  }).finally(() => { syncing = null; });
  return syncing;
}

export function connect() {
  if (source) return Promise.resolve();
  if (connecting) return connecting;
  connecting = (async () => {
    await sync().catch(() => {});
    source = new EventSource('/api/chat/live/events');
    source.onmessage = event => {
      try { _packet(JSON.parse(event.data)); }
      catch (error) { console.error('Live chat event failed', error); sync().catch(() => {}); }
    };
    source.onerror = () => {
      for (const [sessionId, entry] of _inflight) {
        if (entry.status === 'processing') { entry.connected = false; _notify(sessionId); }
      }
    };
  })().finally(() => { connecting = null; });
  return connecting;
}

// True while the live feed is open (EventSource readyState 1); it is 0 while the browser retries.
export function live() { return !!source && source.readyState === 1; }
// Milliseconds timestamp of the last packet from the server; 0 before the first.
export function lastContact() { return lastPacketAt; }

export function getInFlight(sessionId) { return _inflight.get(sessionId) || null; }
export function listInFlight() {
  return [..._inflight.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry }));
}
export function subscribe(sessionId, callback) {
  let listeners = _listeners.get(sessionId);
  if (!listeners) { listeners = new Set(); _listeners.set(sessionId, listeners); }
  listeners.add(callback);
  return () => { listeners.delete(callback); if (!listeners.size) _listeners.delete(sessionId); };
}
export function subscribeAll(callback) {
  _globalListeners.add(callback);
  return () => _globalListeners.delete(callback);
}

export function clearPermission(sessionId, requestId) {
  const entry = _inflight.get(sessionId);
  if (entry?.permission?.id !== requestId) return;
  if (entry.permissionStartedAt) entry.pausedSeconds = (entry.pausedSeconds || 0) + Date.now() / 1000 - entry.permissionStartedAt;
  entry.permissionStartedAt = null;
  entry.permission = null;
  _notify(sessionId);
}

export function startTurn(sessionId, sessionTitle, text, attachmentIds, references = []) {
  if (!source) connect().catch(() => {});
  if (_inflight.get(sessionId)?.status === 'processing') throw new Error('This chat already has a response in progress');
  const entry = { text: '', prompt: text, startedAt: Date.now() / 1000, status: 'processing',
    connected: false, sessionTitle, error: null, stopping: false, local: true,
    toolEvents: [], toolSteps: [] };
  dropSharedReads();  // sending is a write that does not go through api()
  lastPacketAt = Date.now();  // a new turn starts the silence clock, not whatever idle gap came before
  _inflight.set(sessionId, entry);
  _notify(sessionId);
  const requestId = crypto.randomUUID();
  const start = () => fetch('/api/chat/live', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, message: text, attachment_ids: attachmentIds, references, request_id: requestId }) });
  // A phone can lose the acceptance response. Retry the same request once;
  // the live backend deduplicates it without repeating work.
  const startPromise = start().catch(() => start())
    .then(async res => {
      if (!res.ok) {
        let detail = `Couldn't start reply (${res.status})`;
        try { detail = (await res.json()).detail || detail; } catch { /* Keep status text. */ }
        throw new Error(detail);
      }
      const result = await res.json();
      if (_inflight.get(sessionId) === entry) entry.turnId = result.turn_id;
      await sync();
    }).catch(async error => {
      if (_inflight.get(sessionId) !== entry) return;
      if (entry.turnId) {
        try { await sync(); return; } catch { /* Keep the start error. */ }
      }
      _finish(sessionId, entry, 'failed', error.message);
    });
  Object.defineProperty(entry, 'startPromise', { value: startPromise, configurable: true });
  return entry;
}

// Stop names the turn it means. A Stop that arrives late then cannot end the turn that started after it:
// the server answers a stale one with "already-stopped" and changes nothing. Bots conversations stop through
// their own guarded route (U1's POST /api/bot-chat/{sid}/interrupt); ordinary chats keep /api/chat/live/stop
// and send the turn ID along for a server that checks it.
export function stopTurn(sessionId, { bot = false } = {}) {
  const entry = _inflight.get(sessionId);
  if (!entry || entry.status !== 'processing' || entry.stopping) return false;
  entry.stopping = true;
  _notify(sessionId);
  Promise.resolve(entry.startPromise).then(() => {
    if (entry.status !== 'processing') return null;
    const turnId = entry.turnId || null;
    if (bot) {
      // Without a turn ID there is nothing safe to name: read the server's state instead of guessing.
      if (!turnId) return sync().then(() => null);
      return fetch(`/api/bot-chat/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn_id: turnId }),
      });
    }
    return fetch('/api/chat/live/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, turn_id: turnId }),
    });
  }).then(async res => {
    if (!res) return;
    if (!res.ok) throw new Error(`Couldn't stop reply (${res.status})`);
    const result = await res.json();
    const stopping = bot ? (result.outcome || result.status) === 'stopping' || result.stopping === true : result.stopping;
    if (!stopping) {
      await sync();
      // A stale Stop changed nothing: if this reply is somehow still the live one, it is not stopping.
      if (_inflight.get(sessionId) === entry && entry.status === 'processing') { entry.stopping = false; _notify(sessionId); }
    }
  }).catch(error => {
    if (entry.status === 'processing') { entry.stopping = false; entry.error = error.message; _notify(sessionId); }
  });
  return true;
}

// Mobile resume. Guarded because this module is also imported outside a
// browser: scripts/test_chat_stream_stop.cjs loads it in bare Node to check
// that one viewer leaving never stops a server-owned turn, and touching
// document at module scope made the module unimportable there. Resuming on
// focus is browser-only, so outside a browser it simply does not apply.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync().catch(() => {});
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => sync().catch(() => {}));
}
