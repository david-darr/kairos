// Desktop bot notifications (static/js/botNotifications.js), tested without a
// browser: the watcher is pure. (The floating bot window was retired for the
// desktop notch on 2026-10-25; scripts/test_notch_panels.cjs checks it is gone.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  // -- notifications ------------------------------------------------------
  const storage = new Map();
  global.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  const code = fs.readFileSync(path.join(__dirname, '../static/js/botNotifications.js'), 'utf8');
  const N = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const inbox = (items = [], reviews = []) => ({ items, reviews });
  const q = (id, agent, title = 'A question') => ({ id, agent_id: agent, kind: 'question', title });
  const r = (id, agent, title = 'A report') => ({ id, agent_id: agent, kind: 'report', title });
  const names = async () => ({ a1: 'Scout', a2: 'Archivist' });

  let shown = [];
  let focused = null;
  const watch = N.createWatcher({ show: n => shown.push(n), names, focusedAgentId: () => focused });
  assert.deepEqual(await watch(inbox([q('i1', 'a1')])), [], 'the first poll only learns the backlog');
  assert.deepEqual(shown, []);

  await watch(inbox([q('i1', 'a1'), q('i2', 'a1', 'Pick a slot'), r('i3', 'a1'), r('i4', 'a1')]));
  assert.equal(shown.length, 1, 'three new items from one bot are one notification');
  assert.equal(shown[0].title, 'Scout needs you', 'needs-you outranks results');
  assert.equal(shown[0].body, 'Pick a slot (and 2 more)');

  shown = [];
  await watch(inbox([q('i1', 'a1'), q('i2', 'a1'), r('i3', 'a1'), r('i4', 'a1')], [{ id: 'c1', agent_id: 'a2', name: 'Shortlist' }]));
  assert.deepEqual(shown.map(n => [n.title, n.body]), [['Archivist has results', 'Shortlist']], 'a review is a result');

  shown = [];
  await watch(inbox([q('i1', 'a1')]));
  assert.deepEqual(shown, [], 'items going away notify nothing');

  shown = []; focused = 'a1';
  await watch(inbox([q('i1', 'a1'), q('i9', 'a1'), q('i10', 'a2')]));
  assert.deepEqual(shown.map(n => n.agentId), ['a2'], 'no notification for the bot on screen');

  shown = []; focused = null;
  N.savePrefs({ needs_you: false });
  await watch(inbox([q('i1', 'a1'), q('i9', 'a1'), q('i10', 'a2'), q('i11', 'a2'), r('i12', 'a2')]));
  assert.deepEqual(shown.map(n => n.title), ['Archivist has results'], 'a turned-off kind is skipped');
  N.savePrefs({ needs_you: true, enabled: false });
  shown = [];
  await watch(inbox([q('i1', 'a1'), q('i13', 'a1')]));
  assert.deepEqual(shown, [], 'the master switch turns them all off');

  console.log('Bot notifications coalesce and respect focus and settings.');
})().catch(error => { console.error(error); process.exit(1); });
