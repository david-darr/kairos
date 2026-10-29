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

  // -- the retained feed (Bots Phase 1, U5) ---------------------------------------
  N.savePrefs({ enabled: true, needs_you: true });
  const note = (id, extra = {}) => ({ id, kind: 'question', agent_id: 'a1', title: `Alert ${id}`, read: false, backlog: false,
    target: { tab: 'botsShell', agentId: 'a1', sessionId: 's' + id, messageId: 'm' + id }, ...extra });
  const feed = (...rows) => ({ rows });
  const names2 = async () => ({ a1: 'Scout', a2: 'Archivist' });
  let focusSession = null;
  shown = []; focused = null;
  const feedWatch = N.createFeedWatcher({ show: n => shown.push(n), names: names2, focusedAgentId: () => focused, focusedSessionId: () => focusSession });

  assert.deepEqual(await feedWatch(feed(note('1'), note('2'))), [], 'first load: the backlog is learned, never announced');
  assert.deepEqual(shown, []);

  await feedWatch(feed(note('1'), note('2'), note('3')));
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].target, { tab: 'botsShell', agentId: 'a1', sessionId: 's3', messageId: 'm3' }, 'the alert keeps the exact conversation and message');
  assert.equal(shown[0].title, 'Scout needs you');

  shown = [];
  await feedWatch(feed(note('1'), note('2'), note('3'), note('4', { backlog: true }), note('5', { read: true })));
  assert.deepEqual(shown, [], 'backlog rows and rows already read never notify');

  shown = []; focusSession = 's6';
  await feedWatch(feed(note('6'), note('7', { agent_id: 'a2', target: { tab: 'botsShell', agentId: 'a2', sessionId: 's7' } })));
  assert.deepEqual(shown.map(n => n.agentId), ['a2'], 'no alert for the conversation on screen');
  focusSession = null;

  shown = [];
  await feedWatch(feed(note('8', { kind: 'turn-failed', title: 'Reply could not finish' }), note('9', { kind: 'done', title: 'Reply ready' }), note('10')));
  assert.equal(shown.length, 1, 'one alert per bot per poll');
  assert.equal(shown[0].kind, 'needs_you', 'needs you outranks a failure and a finished reply');
  assert.equal(shown[0].body, 'Alert 10 (and 2 more)');

  shown = [];
  await feedWatch(feed(note('11', { kind: 'turn-failed', title: 'Reply could not finish' }), note('12', { kind: 'done', title: 'Reply ready' })));
  assert.deepEqual(shown.map(n => [n.kind, n.title]), [['failures', 'Scout hit a problem']], 'a failure outranks a finished reply');

  shown = [];
  N.savePrefs({ failures: false });
  await feedWatch(feed(note('13', { kind: 'turn-failed' }), note('14', { kind: 'done', title: 'Reply ready' })));
  assert.deepEqual(shown.map(n => n.kind), ['completions'], 'a turned-off kind is skipped, the rest still notify');
  N.savePrefs({ completions: false });
  shown = [];
  await feedWatch(feed(note('15', { kind: 'done' }), note('16', { kind: 'turn-failed' })));
  assert.deepEqual(shown, [], 'both new switches silence their kinds');
  N.savePrefs({ completions: true, failures: true });

  assert.deepEqual(Object.keys(JSON.parse(storage.get('kairos:bot-notifications'))).sort(), ['completions', 'enabled', 'failures', 'needs_you', 'results']);
  storage.clear();
  assert.deepEqual(N.prefs(), { enabled: true, needs_you: true, results: true }, 'the stored defaults keep their three original keys');
  assert.equal(N.plan([{ key: 'x', agentId: 'a1', kind: 'completions', title: 'Done' }], { names: {} }).length, 1, 'the newer switches default on');

  // The older inbox watcher also keeps a target and respects the focused conversation.
  shown = [];
  const legacy = N.createWatcher({ show: n => shown.push(n), names, focusedAgentId: () => null, focusedSessionId: () => 'sx' });
  await legacy(inbox([]));
  await legacy(inbox([{ id: 'z1', agent_id: 'a1', kind: 'question', title: 'Hello' }]));
  assert.equal(shown.length, 1, 'the older watcher still announces new questions');
  assert.equal(shown[0].target, undefined, 'and carries no target it was not given');

  console.log('Bot notifications coalesce and respect focus and settings.');
})().catch(error => { console.error(error); process.exit(1); });
