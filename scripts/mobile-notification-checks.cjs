// Run: node --experimental-vm-modules scripts/mobile-notification-checks.cjs
// Browser lifecycle/protocol checks, without a live app or push provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async test => { for (let i = 0; i < 100; i++) { if (test()) return; await delay(5); } throw new Error('Browser state timed out'); };
const sid = 'abcdef123456';
const turnId = '123456abcdef';
const snapshot = (status = 'processing', text = 'first ', revision = 1) => ({ type: 'snapshot', runs: {
  [sid]: { turnId, sessionTitle: 'Fixture', text, status, startedAt: Date.now() / 1000,
    revision, permission: null, toolSteps: [], toolEvents: [] },
} });

async function chatModule(fetch) {
  const listeners = {}, sources = [], events = [];
  class EventSource {
    constructor(url) { assert.equal(url, '/api/chat/live/events'); sources.push(this); }
    emit(packet) { this.onmessage({ data: JSON.stringify(packet) }); }
  }
  const context = vm.createContext({ fetch, crypto, EventSource, console, CustomEvent: class { constructor(type, data) { this.type = type; Object.assign(this, data); } },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    document: { visibilityState: 'visible', addEventListener(type, fn) { listeners[type] = fn; }, dispatchEvent(event) { events.push(event); } },
    window: { addEventListener(type, fn) { listeners[type] = fn; } },
  });
  const mod = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'static/js/chatStream.js'), 'utf8'), { context });
  await mod.link(() => { throw new Error('Unexpected dependency'); });
  await mod.evaluate();
  return { api: mod.namespace, listeners, sources, events };
}

async function runChecks() {
  let posts = 0;
  const reconnect = await chatModule(async (url, options = {}) => {
    if (options.method === 'POST') {
      posts++;
      assert.equal(url, '/api/chat/live');
      assert.ok(JSON.parse(options.body).request_id);
      return Response.json({ turn_id: turnId });
    }
    assert.equal(url, '/api/chat/live/snapshot');
    return Response.json(posts ? snapshot() : { type: 'snapshot', runs: {} });
  });
  await reconnect.api.connect();
  const entry = reconnect.api.startTurn(sid, 'Fixture', 'work', []);
  await entry.startPromise;
  reconnect.sources[0].onerror();
  assert.equal(entry.connected, false);
  reconnect.sources[0].emit(snapshot('done', 'first finished', 3));
  assert.equal(entry.status, 'done');
  assert.equal(entry.text, 'first finished', 'reconnection replaces text instead of appending duplicate tokens');
  reconnect.sources[0].emit({ type: 'chunk', sessionId: sid, turnId, revision: 2, chunk: 'duplicate' });
  assert.equal(entry.text, 'first finished', 'old revisions cannot append duplicate text');
  assert.equal(posts, 1, 'accepted work is never resubmitted on reconnect');

  const requestIds = [];
  const lostAcceptance = await chatModule(async (url, options = {}) => {
    if (options.method !== 'POST') return Response.json(requestIds.length ? snapshot('done', 'one reply', 2) : { type: 'snapshot', runs: {} });
    requestIds.push(JSON.parse(options.body).request_id);
    if (requestIds.length === 1) throw new Error('Start response lost');
    return Response.json({ turn_id: turnId });
  });
  await lostAcceptance.api.connect();
  const accepted = lostAcceptance.api.startTurn(sid, 'Fixture', 'work', []);
  await accepted.startPromise;
  assert.equal(accepted.status, 'done');
  assert.equal(accepted.text, 'one reply');
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1], 'lost acceptance uses the same idempotency ID');

  const requests = [];
  let started = false;
  const stopped = await chatModule(async (url, options = {}) => {
    requests.push(url);
    if (url.endsWith('/stop')) {
      assert.equal(JSON.parse(options.body).session_id, sid);
      stopped.sources[0].emit({ type: 'update', sessionId: sid, turnId, revision: 2,
        changes: { status: 'stopped', permission: null } });
      return Response.json({ stopping: true });
    }
    if (options.method === 'POST') { started = true; return Response.json({ turn_id: turnId }); }
    return Response.json(started ? snapshot() : { type: 'snapshot', runs: {} });
  });
  await stopped.api.connect();
  const stopping = stopped.api.startTurn(sid, 'Fixture', 'work', []);
  await stopping.startPromise;
  assert.equal(stopped.api.stopTurn(sid), true);
  await until(() => stopping.status === 'stopped');
  assert.ok(requests.includes('/api/chat/live/stop'), 'Stop reaches the host');

  let restored = false;
  const restore = await chatModule(async url => {
    assert.equal(url, '/api/chat/live/snapshot');
    return Response.json(snapshot(restored ? 'done' : 'processing', restored ? 'restored reply' : 'first ', restored ? 2 : 1));
  });
  await restore.api.connect();
  assert.equal(restore.api.getInFlight(sid).status, 'processing', 'boot attaches to existing work');
  restored = true;
  restore.listeners.visibilitychange();
  await until(() => restore.api.getInFlight(sid)?.status === 'done');
  assert.equal(restore.api.getInFlight(sid).text, 'restored reply');

  const revoked = await chatModule(async () => new Response(JSON.stringify({ detail: 'Sign in again' }), { status: 401 }));
  const failed = revoked.api.startTurn(sid, 'Fixture', 'work', []);
  await until(() => failed.status === 'failed');
  assert.equal(failed.error, 'Sign in again');

  const handlers = {}, notifications = [], opened = [], messages = [];
  const worker = vm.createContext({ URL, Date, self: {
    location: { origin: 'https://kairos.example' },
    addEventListener(type, fn) { handlers[type] = fn; },
    registration: { showNotification: async (title, options) => notifications.push({ title, ...options }) },
    clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
  } });
  vm.runInContext(fs.readFileSync(path.join(root, 'static/sw.js'), 'utf8'), worker);
  const push = async data => { let pending; handlers.push({ data: { json: () => data }, waitUntil(work) { pending = work; } }); await pending; };
  const click = async url => { let pending; handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil(work) { pending = work; } }); await pending; };
  await push({ kind: 'permission', expires_at: 1, title: 'secret', body: 'secret', url: '/?chat=abcdef123456' });
  assert.equal(notifications[0].title, 'Kairos');
  assert.ok(notifications[0].body.includes('expired'));
  assert.ok(!JSON.stringify(notifications).includes('secret'), 'lock screen ignores chat previews');
  await click('https://evil.example/?chat=abcdef123456');
  assert.equal(opened[0], 'https://kairos.example/', 'notifications cannot navigate to another origin');
  await click('/?chat=abcdef123456');
  assert.equal(opened[1], 'https://kairos.example/?chat=abcdef123456');
  worker.self.clients.matchAll = async () => [{ url: 'https://kairos.example/', postMessage: data => messages.push(data), focus: async () => {} }];
  await click('/?chat=abcdef123456');
  assert.equal(messages[0].type, 'kairos:open-chat');
  assert.equal(opened.length, 2, 'an existing Kairos window is reused');

  const order = [];
  const context = vm.createContext({ Uint8Array, atob, location: { protocol: 'https:' },
    window: { isSecureContext: true, PushManager: {}, Notification: {}, matchMedia: () => ({ matches: true }) },
    navigator: { userAgent: 'iPhone', standalone: true, serviceWorker: {}, platform: 'iPhone' },
    Notification: { permission: 'default', requestPermission() { order.push('permission'); return Promise.resolve('granted'); } },
    localStorage: { setItem() {} },
  });
  const notificationsModule = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'static/js/mobileNotifications.js'), 'utf8'), { context });
  const api = new vm.SyntheticModule(['api'], function() { this.setExport('api', async () => { order.push('enroll'); return { id: 'device' }; }); }, { context });
  await notificationsModule.link(() => api); await notificationsModule.evaluate();
  assert.equal(notificationsModule.namespace.supportReason(), '');
  const key = 'A'.repeat(87);
  await notificationsModule.namespace.enableNotifications({ public_key: key }, { pushManager: {
    getSubscription: async () => null,
    subscribe: async () => { order.push('subscribe'); return { toJSON: () => ({}), unsubscribe: async () => {} }; },
  } });
  assert.deepEqual(order, ['permission', 'subscribe', 'enroll'], 'iOS permission is invoked before any asynchronous enrollment');
  console.log('Mobile checks passed: reconnect, idempotent start, host Stop, restore, sign-out, private alerts, safe links, iOS enrollment.');
}
runChecks().catch(error => { console.error(error); process.exitCode = 1; });
