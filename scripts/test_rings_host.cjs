// The incoming-call sheet (static/js/ringHost.js): a bot ringing you inside Kairos. Run: node scripts/test_rings_host.cjs
//   - a ring from the server shows a sheet with the bot's name, the reason, Answer and Decline, once
//   - Answer tells the server, goes to the bot and leaves the ring for its call screen to take, once and only for that bot
//   - Decline tells the server and closes the sheet; a ring that stopped (answered elsewhere, missed) closes it
//   - a desktop notification is shown only when the window is not in front, and asks nothing it should not
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.removed = false; }
  setAttribute(key, value) { this.attrs[key] = value; }
  append(...kids) { this.children.push(...kids); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  remove() { this.removed = true; }
  click() { return this.listeners.click?.(); }
  find(cls) { for (const kid of this.children) { if ((kid.className || '').split(' ').includes(cls)) return kid; const hit = kid.find?.(cls); if (hit) return hit; } return null; }
  text() { return [this.textContent, ...this.children.map(kid => kid.text())].join(' '); }
}
const fakeDocument = () => {
  const body = new Node_('body'), events = [];
  return { body, events, createElement: tag => new Node_(tag), hasFocus: () => true, dispatchEvent: event => events.push(event) };
};
const ring = (id, extra = {}) => ({ id, agent_id: 'kip', bot_name: 'Kip', reason: 'The build finished.', seconds_left: 55, ...extra });
const sheets = doc => doc.body.children.filter(node => !node.removed);

(async () => {
  global.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  const M = await load('js/ringHost.js');

  await check('a ringing invite shows one sheet with who, why and two buttons', async () => {
    const doc = fakeDocument();
    let pending = [ring('a'.repeat(32))];
    const host = M.createRingHost({ document: doc, api: async () => ({ rings: pending }), Notification: null, AudioContext: null });
    await host.poll(); await host.poll();
    const open = sheets(doc);
    assert.equal(open.length, 1);
    assert.equal(open[0].attrs.role, 'alertdialog');
    assert.match(open[0].text(), /Kip is calling/);
    assert.match(open[0].text(), /The build finished\./);
    assert.equal(open[0].find('ring-answer').textContent, 'Answer');
    assert.equal(open[0].find('ring-decline').textContent, 'Decline');
    pending = [];
    await host.poll();
    assert.equal(sheets(doc).length, 0, 'a ring that stopped ringing takes its sheet down');
  });

  await check('Answer and Decline reach the server once and close the sheet', async () => {
    const doc = fakeDocument(), calls = [];
    const host = M.createRingHost({ document: doc, api: async () => ({ rings: [ring('b'.repeat(32))] }), Notification: null, AudioContext: null,
      answer: async id => { calls.push(['answer', id]); }, decline: async id => { calls.push(['decline', id]); } });
    await host.poll();
    doc.body.children[0].find('ring-answer').click();
    assert.deepEqual(calls, [['answer', 'b'.repeat(32)]]);
    assert.equal(sheets(doc).length, 0);
    await host.poll();
    doc.body.children.at(-1).find('ring-decline').click();
    assert.deepEqual(calls.at(-1), ['decline', 'b'.repeat(32)]);
  });

  await check('answering posts to the server, goes to the bot, and the call screen takes the reason once', async () => {
    const calls = [];
    const doc = fakeDocument();
    global.fetch = async (url, options = {}) => {
      calls.push([options.method || 'GET', url]);
      return { ok: true, status: 200, json: async () => ({ ring_id: 'c'.repeat(32), agent_id: 'kip', bot_name: 'Kip', reason: 'The build finished.', callback: false, target: { tab: 'botsShell', agentId: 'kip' } }),
        text: async () => '', clone() { return this; }, headers: { get: () => 'application/json' } };
    };
    await M.answerRing('c'.repeat(32), doc);
    assert.deepEqual(calls[0], ['POST', `/api/rings/${'c'.repeat(32)}/answer`]);
    assert.deepEqual(doc.events.map(event => event.type), ['jarvis:navigate', 'kairos:ring-answered']);
    assert.deepEqual(doc.events[0].detail, { tab: 'botsShell', agentId: 'kip' });
    assert.equal(M.takePendingRing('someone-else'), null, 'only the bot that rang gets the reason');
    const taken = M.takePendingRing('kip');
    assert.equal(taken.reason, 'The build finished.');
    assert.equal(taken.id, 'c'.repeat(32));
    assert.equal(M.takePendingRing('kip'), null, 'taken once');
  });

  await check('a desktop notification shows only when the window is not in front, and rings until handled', async () => {
    const made = [];
    class Note { constructor(title, options) { this.title = title; this.options = options; this.closed = false; made.push(this); } close() { this.closed = true; } static permission = 'granted'; }
    const behind = fakeDocument(), front = fakeDocument();
    const make = (doc, focused) => M.createRingHost({ document: doc, api: async () => ({ rings: [ring('d'.repeat(32))] }), Notification: Note, AudioContext: null,
      hasFocus: () => focused, answer: async () => {}, decline: async () => {} });
    await make(front, true).poll();
    assert.equal(made.length, 0);
    const host = make(behind, false);
    await host.poll();
    assert.equal(made.length, 1);
    assert.equal(made[0].title, 'Kip is calling');
    assert.equal(made[0].options.body, 'The build finished.');
    assert.equal(made[0].options.silent, false, 'the system plays its sound');
    assert.equal(made[0].options.requireInteraction, true);
    host.stop();
    assert.equal(made[0].closed, true);
    assert.equal(sheets(behind).length, 0);
  });

  await check('hidden, the tick reads only every 18 s; shown again, it reads at once; each reply reaches onResult', async () => {
    const doc = fakeDocument(), replies = [];
    let clock = 0, hidden = false, reads = 0;
    const host = M.createRingHost({ document: doc, api: async () => { reads++; return { rings: [], outbound: 2 }; }, Notification: null, AudioContext: null,
      isHidden: () => hidden, now: () => clock, onResult: reply => replies.push(reply.outbound) });
    assert.equal(M.POLL_MS, 6000);
    assert.equal(M.HIDDEN_POLL_MS, 18000);
    await host.poll(); assert.equal(reads, 1);
    assert.deepEqual(replies, [2], 'the reply, with its count of calls going, reaches the listener');
    hidden = true;
    for (clock = 6000; clock < 18000; clock += 6000) { host.tick(); await Promise.resolve(); }
    assert.equal(reads, 1, 'hidden, ticks inside 18 s read nothing');
    clock = 18000; host.tick(); await Promise.resolve(); await Promise.resolve();
    assert.equal(reads, 2, 'hidden, it still reads every 18 s so a ring reaches the notification');
    hidden = false; clock = 19000; host.tick(); await Promise.resolve();
    assert.equal(reads, 3, 'shown, every tick reads');
  });

  console.log(`ring host: ${passed.length} checks passed`);
  for (const name of passed) console.log(`  ok - ${name}`);
})().catch(error => { console.error(error); process.exit(1); });
