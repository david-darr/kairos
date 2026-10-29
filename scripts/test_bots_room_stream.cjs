const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
(async () => {
  const { createRoomStream, ROOM_EVENTS } = await import(pathToFileURL(path.join(__dirname, '../static/js/botsRoomStream.js')).href);
  const gate = deferred(), applied = [], errors = [];
  let hydrations = 0, closed = false, handlers = {}, url;
  const stream = createRoomStream({ hydrate: async () => { hydrations++; if (hydrations === 1) await gate.promise; },
    apply: frame => applied.push(frame.id), onError: e => errors.push(e.message), sourceFactory: path => {
      url = path; return { addEventListener(type, fn) { handlers[type] = fn; }, close() { closed = true; } };
    } });
  const ready = stream.start();
  assert.equal(url, '/api/bot-rooms/events?last_event_id=0'); assert.ok(ROOM_EVENTS.includes('room.goal'));
  handlers.hello({ data: JSON.stringify({ cursor: 10, reset: false }) });
  handlers['room.chunk']({ data: JSON.stringify({ room_id: 'r', revision: 1 }), lastEventId: '11' });
  assert.deepEqual(applied, [], 'frames must wait for HTTP hydration');
  gate.resolve(); await ready;
  assert.deepEqual(applied, [11]);
  stream.receive({ id: 11 }); stream.receive({ id: 9 }); assert.deepEqual(applied, [11]);
  stream.receive({ id: 15 }); assert.deepEqual(applied, [11, 15], 'owner filtering can leave numeric gaps');
  handlers.hello({ data: JSON.stringify({ cursor: 3, reset: true }) }); await tick();
  assert.equal(hydrations, 2, 'a replay gap or server restart must rehydrate'); assert.equal(stream.cursor(), 3);
  stream.receive({ id: 4 }); assert.equal(applied.at(-1), 4);
  handlers['room.chunk']({ data: '{bad', lastEventId: '5' }); assert.equal(errors.length, 1);
  handlers.error(); assert.match(errors.at(-1), /Reconnecting/);
  stream.destroy(); assert.equal(closed, true); stream.receive({ id: 6 }); assert.equal(applied.at(-1), 4);
  await stream.refresh(); assert.equal(hydrations, 2);
  const pending = deferred(), values = [];
  const inFlight = createRoomStream({ hydrate: () => pending.promise, apply: v => values.push(v), sourceFactory: () => ({ addEventListener() {}, close() {} }) });
  const first = inFlight.start(); inFlight.receive({ id: 1 }); inFlight.destroy(); pending.resolve(); await first; assert.equal(values.length, 0);
  let calls = 0;
  const failed = createRoomStream({ hydrate: async () => { calls++; if (calls === 1) throw new Error('offline'); }, apply() {}, onError() {}, sourceFactory: () => ({ addEventListener() {}, close() {} }) });
  await assert.rejects(failed.start(), /offline/); await failed.refresh(); assert.equal(calls, 2); failed.destroy();
  console.log('PASS room feed hydrate/replay, cursor dedupe, replay reset, error recovery and disposal');
})().catch(error => { console.error(error); process.exitCode = 1; });
