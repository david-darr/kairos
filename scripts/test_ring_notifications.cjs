// The call-style ring notification (static/sw.js, 2026-11-10), run in a fake service worker. Run: node scripts/test_ring_notifications.cjs
//   - a ringing push shows "<Bot> is calling", the bot's picture (else its saved Kip, else the app icon), a ring
//     vibration, requireInteraction, and Answer / Decline, with a deep link carrying the ring id and when it stops
//   - a push for a ring that already stopped shows a missed call, never a live ring
//   - the stop push takes the ringing notification down: a missed call stays as a quiet note, answered or declined goes
//   - Decline posts the decline (the server tells the bot); Answer or a tap opens Kairos on the deep link, once
//   - the deep link answers once (ringHost.js), never after it expired, and a used link opens the bot instead
//   - text typed during a live call is routed into it (callTyped.js)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const passed = [];
const plain = value => JSON.parse(JSON.stringify(value));
const check = async (name, fn) => { await fn(); passed.push(name); };
const RING = 'c'.repeat(32);
const ORIGIN = 'https://kairos.test';

function worker({ picture = null, face = '' } = {}) {
  const listeners = {}, shown = [], closed = [], fetched = [], posted = [], opened = [], focused = [];
  const windows = [];
  const registration = {
    async showNotification(title, options = {}) { shown.push({ title, ...options, close() { closed.push(options.tag); } }); },
    async getNotifications({ tag } = {}) { return shown.filter(n => !tag || n.tag === tag).filter(n => !closed.includes(n)).map(n => ({ ...n, close: () => closed.push(n.tag) })); },
  };
  const fakeIdb = {
    open() {
      const request = {};
      setTimeout(() => {
        request.result = { close() {}, transaction: () => ({ objectStore: () => ({ get() { const read = {}; setTimeout(() => { read.result = face ? { png: face } : undefined; read.onsuccess?.(); }); return read; } }) }) };
        request.onsuccess?.();
      });
      return request;
    },
  };
  const self = {
    location: { origin: ORIGIN }, registration, indexedDB: fakeIdb,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {}, clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async url => { opened.push(url); },
    },
  };
  const fetch = async (url, options = {}) => {
    fetched.push({ url, method: options.method || 'GET', credentials: options.credentials });
    if (url.includes('/avatar-image/') && picture) return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => picture };
    return { ok: false, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const context = vm.createContext({ self, fetch, URL, btoa: text => Buffer.from(text, 'binary').toString('base64'), Uint8Array, String, Number, Date, Promise, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'sw.js'), 'utf8'), context);
  const fire = async (type, event) => { let wait = Promise.resolve(); listeners[type]({ ...event, waitUntil: p => { wait = p; } }); await wait; };
  const push = data => fire('push', { data: { json: () => data } });
  const click = (notification, action = '') => fire('notificationclick', { action, notification: { ...notification, close() {} } });
  const addWindow = url => { const client = { url, postMessage: message => posted.push(message), focus: async () => focused.push(url) }; windows.push(client); return client; };
  return { push, click, shown, closed, fetched, posted, opened, focused, addWindow };
}

const ringPush = (extra = {}) => ({ kind: 'bot_call', title: 'Kip is calling', body: 'Tap to answer.', ring_id: RING, agent_id: 'bot-kip', bot_name: 'Kip',
  tag: `kairos-ring-${RING}`, url: `/?agent=bot-kip&ring=${RING}&exp=${Math.floor(Date.now() / 1000) + 50}`, expires_at: Date.now() / 1000 + 50, ...extra });

(async () => {
  await check('a ringing push is a call: who, face, ring pattern, stays up, Answer and Decline', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer;
    const sw = worker({ picture: png });
    await sw.push(ringPush({ avatar: '/api/agents/bot-kip/avatar-image/' + 'a'.repeat(32) }));
    const [note] = sw.shown;
    assert.equal(note.title, 'Kip is calling');
    assert.equal(note.body, 'Tap to answer.');
    assert.ok(note.icon.startsWith('data:image/png;base64,'), 'the bot picture, fetched with the sign-in cookie, as a data URL');
    assert.equal(sw.fetched[0].credentials, 'same-origin');
    assert.equal(note.requireInteraction, true);
    assert.equal(note.renotify, true);
    assert.ok(Array.isArray(note.vibrate) && note.vibrate.length >= 5, 'a ring vibration pattern');
    assert.deepEqual(plain(note.actions.map(a => [a.action, a.title])), [['answer', 'Answer'], ['decline', 'Decline']]);
    assert.equal(note.tag, `kairos-ring-${RING}`);
    assert.equal(note.data.ring, RING);
    assert.match(note.data.url, new RegExp(`/\\?agent=bot-kip&ring=${RING}&exp=\\d+$`));
    assert.doesNotMatch(JSON.stringify(note), /build/, 'never why');
  });

  await check('no picture: the saved Kip, else the app icon; an odd avatar path is never fetched', async () => {
    const withFace = worker({ face: 'data:image/png;base64,AAAA' });
    await withFace.push(ringPush());
    assert.equal(withFace.shown[0].icon, 'data:image/png;base64,AAAA');
    const bare = worker();
    await bare.push(ringPush({ avatar: 'https://evil.example/x.png' }));
    assert.equal(bare.shown[0].icon, '/static/img/app-192.png');
    assert.equal(bare.fetched.length, 0);
  });

  await check('a push for a ring that stopped shows a missed call, not a ring', async () => {
    const sw = worker();
    await sw.push(ringPush({ expires_at: Date.now() / 1000 - 5 }));
    assert.equal(sw.shown[0].body, 'You missed a call. It is in your inbox.');
    assert.equal(sw.shown[0].requireInteraction, undefined);
  });

  await check('the stop push takes the ring down on this device', async () => {
    const sw = worker();
    await sw.push(ringPush());
    await sw.push({ kind: 'bot_call_end', ring_id: RING, outcome: 'missed', bot_name: 'Kip', tag: `kairos-ring-${RING}` });
    assert.ok(sw.closed.includes(`kairos-ring-${RING}`), 'the ringing notification is closed');
    const missed = sw.shown.at(-1);
    assert.equal(missed.title, 'Missed call from Kip');
    assert.equal(missed.silent, true);
    assert.notEqual(missed.requireInteraction, true);
    const other = worker();
    await other.push(ringPush());
    await other.push({ kind: 'bot_call_end', ring_id: RING, outcome: 'answered', bot_name: 'Kip' });
    assert.equal(other.shown.at(-1).body, 'Call answered.');
    assert.ok(other.closed.filter(tag => tag === `kairos-ring-${RING}`).length >= 2, 'answered elsewhere: nothing stays up');
  });

  await check('Decline posts the decline; Answer opens Kairos on the deep link', async () => {
    const sw = worker();
    await sw.push(ringPush());
    const note = sw.shown[0];
    await sw.click(note, 'decline');
    assert.deepEqual(sw.fetched.map(f => [f.url, f.method]), [[`/api/rings/${RING}/decline`, 'POST']]);
    assert.equal(sw.opened.length, 0);
    await sw.click(note, 'answer');
    assert.deepEqual(sw.opened, [note.data.url], 'no window yet: one opens straight on the link');
    const open = worker();
    open.addWindow(`${ORIGIN}/`);
    await open.push(ringPush());
    await open.click(open.shown[0]);
    assert.deepEqual(plain(open.posted), [{ type: 'kairos:open-chat', url: open.shown[0].data.url }], 'a tap on the banner answers too');
    assert.equal(open.focused.length, 1);
  });

  await check('a foreign or malformed link never leaves the app', async () => {
    const sw = worker();
    await sw.push(ringPush({ url: 'https://evil.example/?agent=x' }));
    assert.equal(sw.shown[0].data.url, `${ORIGIN}/`);
  });

  const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
  global.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  global.history = { replaceState() {} };
  const host = await load('js/ringHost.js');
  const storage = () => { const data = {}; return { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); } }; };

  await check('the deep link answers once, with no extra tap, and not after it expired', async () => {
    const store = storage(), answered = [], notes = [];
    const go = (options = {}) => host.answerRingFromLink(RING, message => notes.push(message), { storage: store, answer: async id => answered.push(id), ...options });
    assert.equal(await go({ exp: Math.floor(Date.now() / 1000) + 30 }), true);
    assert.deepEqual(answered, [RING]);
    assert.equal(await go(), false, 'the same link again (a reload, Back, an old notification) does nothing');
    assert.deepEqual(answered, [RING]);
    assert.ok(host.linkUsed(RING, store));
    const late = storage(), lateAnswers = [];
    assert.equal(await host.answerRingFromLink('d'.repeat(32), message => notes.push(message), { storage: late, exp: Math.floor(Date.now() / 1000) - 1, answer: async id => lateAnswers.push(id) }), false);
    assert.deepEqual(lateAnswers, [], 'an expired link never reaches the server');
    assert.match(notes.at(-1), /That call has ended/);
    const failing = await host.answerRingFromLink('e'.repeat(32), message => notes.push(message), { storage: storage(), answer: async () => { throw new Error('409'); } });
    assert.equal(failing, false, 'a ring that ended on the server opens the bot instead');
  });

  await check('text typed during a live call goes into it', async () => {
    const typed = await load('js/callTyped.js');
    assert.equal(await typed.routeTyped('s1', 'hi'), false, 'no call here: the composer sends it as chat');
    const seen = [];
    const undo = typed.registerTyped('s1', async text => { seen.push(text); return true; });
    assert.equal(typed.callTakesTyped('s1'), true);
    assert.equal(await typed.routeTyped('s1', 'ship it'), true);
    assert.equal(await typed.routeTyped('s2', 'other chat'), false);
    assert.equal(await typed.routeTyped('s1', '   '), false);
    undo();
    assert.equal(await typed.routeTyped('s1', 'after'), false);
    assert.deepEqual(seen, ['ship it']);
    typed.registerTyped('s3', async () => { throw new Error('down'); });
    assert.equal(await typed.routeTyped('s3', 'x'), false, 'a failure falls back to an ordinary message');
  });

  console.log(`ring notifications: ${passed.length} passed`);
  for (const name of passed) console.log(`  ok - ${name}`);
})().catch(error => { console.error(error); process.exit(1); });
