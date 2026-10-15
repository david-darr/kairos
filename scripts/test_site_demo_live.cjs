// Drive the real chat module through the website shim (2026-10-15): a
// current build alone cannot catch a missing live protocol in the demo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function main() {
  global.window = global;
  global.location = { href: 'file:///demo/index.html' };
  global.document = { addEventListener() {} };
  global.addEventListener = () => {};
  global.kairosFixtures = require('../demo/fixtures.js');
  global.fetch = async () => { throw new Error('The demo must stay offline'); };
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../demo/shim.js'), 'utf8'));
  const chat = await import(pathToFileURL(path.join(__dirname, '../static/js/chatStream.js')));
  const create = async () => (await fetch('/api/sessions', { method: 'POST', body: '{}' })).json();
  const wait = async predicate => {
    const until = Date.now() + 8000;
    while (!predicate()) {
      assert.ok(Date.now() < until, 'Demo live reply timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await chat.connect();
  const session = await create();
  const entry = chat.startTurn(session.id, 'Demo', 'Hello demo', []);
  await entry.startPromise;
  await wait(() => entry.status === 'done');
  assert.match(entry.text, /Demo reply.*Kairos interface/);
  const saved = await (await fetch('/api/sessions/' + session.id)).json();
  assert.equal(saved.messages.at(-1).content, entry.text);
  const snapshot = await (await fetch('/api/chat/live/snapshot')).json();
  assert.equal(snapshot.runs[session.id].text, entry.text);
  const stopped = await create();
  const active = chat.startTurn(stopped.id, 'Stop demo', 'Hello again', []);
  await active.startPromise;
  await wait(() => active.text.length > 0);
  assert.equal(chat.stopTurn(stopped.id), true);
  await wait(() => active.status === 'stopped');
  await new Promise(resolve => setTimeout(resolve, 100));
  const history = await (await fetch('/api/sessions/' + stopped.id)).json();
  assert.equal(history.messages.at(-1).content, active.text);
  assert.equal(history.messages.at(-1).status, 'interrupted');
  const forge = chat.startTurn('fs1', 'Forge demo', 'Check the code', []);
  await forge.startPromise;
  await wait(() => forge.status === 'done');
  assert.ok(forge.toolSteps.length > 0, 'Forge activity reaches the shared feed');
  assert.match(forge.text, /Demo reply/);
  const handoff = await create();
  const handed = chat.startTurn(handoff.id, 'Handoff demo', 'Research this', [], [{ kind: 'agent', id: 'a1' }]);
  await handed.startPromise;
  await wait(() => handed.status === 'done');
  assert.equal(handed.handoffs[0].agent_id, 'a1');
  const computer = await create();
  const browsing = chat.startTurn(computer.id, 'Computer demo', 'Open a website', []);
  await browsing.startPromise;
  await wait(() => browsing.status === 'done');
  assert.ok(browsing.toolEvents.some(event => event.name === 'computer'));
  console.log('Demo live reply, snapshot, saved history, Stop, Forge, handoff and computer passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
