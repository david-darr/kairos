// Bots attention model (Agents 3.0 Phase 1, unit U5): the plain functions in
// static/js/botsAttentionHost.js that need no DOM. Run: node scripts/test_bots_attention_model.cjs
//   - buckets, counts, the search and the bot filter, unread rows first
//   - the notification filters and the unread count
//   - ages and day labels
//   - navigation targets are rebuilt from known keys only
//   - question answers are complete or refused
//   - activity lines are labelled with their honest source
// The drawer, the panels and their clicks are drawn in scripts/bots-attention-checks.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };

(async () => {
  const M = await load('js/botsAttentionHost.js');
  const row = (id, bucket, extra = {}) => ({ id, bucket, subject: `Subject ${id}`, snippet: '', sender: { id: 'a1', name: 'Scout' }, read: false, actions: [], ...extra });

  check('rows are counted by bucket and filtered by bucket', () => {
    const rows = [row('1', 'needs-you'), row('2', 'news'), row('3', 'needs-you'), row('4', 'done')];
    assert.deepEqual(M.bucketCounts(rows), { 'needs-you': 2, news: 1, done: 1 });
    assert.deepEqual(M.rowsFor(rows, { bucket: 'needs-you' }).map(r => r.id), ['1', '3']);
    assert.deepEqual(M.rowsFor(rows, { bucket: 'done' }).map(r => r.id), ['4']);
  });

  check('unread rows lead, in server order within each group', () => {
    const rows = [row('1', 'news', { read: true }), row('2', 'news'), row('3', 'news', { read: true }), row('4', 'news')];
    assert.deepEqual(M.rowsFor(rows, { bucket: 'news' }).map(r => r.id), ['2', '4', '1', '3']);
  });

  check('search matches subject, snippet and sender, case-blind; a bot filter keeps one sender', () => {
    const rows = [row('1', 'news', { subject: 'Weekly roundup' }), row('2', 'news', { snippet: 'Rent is due' }),
      row('3', 'news', { sender: { id: 'a2', name: 'Archivist' } })];
    assert.deepEqual(M.rowsFor(rows, { bucket: 'news', query: 'ROUNDUP' }).map(r => r.id), ['1']);
    assert.deepEqual(M.rowsFor(rows, { bucket: 'news', query: 'rent' }).map(r => r.id), ['2']);
    assert.deepEqual(M.rowsFor(rows, { bucket: 'news', query: 'archiv' }).map(r => r.id), ['3']);
    assert.deepEqual(M.rowsFor(rows, { bucket: 'news', botId: 'a2' }).map(r => r.id), ['3']);
  });

  check('the notification filters', () => {
    const rows = [
      { id: 'a', kind: 'question', agent_id: 'a1', read: false }, { id: 'b', kind: 'approval', agent_id: 'a1', read: true },
      { id: 'c', kind: 'turn-failed', agent_id: 'a2', read: false }, { id: 'd', kind: 'done', agent_id: 'a2', read: true },
      { id: 'e', kind: 'incident', agent_id: 'a1', read: false },
    ];
    const ids = (filter, bot) => M.filterNotifications(rows, filter, bot).map(r => r.id);
    assert.deepEqual(ids('all'), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(ids('unread'), ['a', 'c', 'e']);
    assert.deepEqual(ids('asks'), ['a', 'b']);
    assert.deepEqual(ids('problems'), ['c', 'e']);
    assert.deepEqual(ids('all', 'a2'), ['c', 'd']);
    assert.equal(M.unreadCount(rows), 3);
  });

  check('ages and day labels', () => {
    const now = new Date(2026, 9, 29, 15, 0, 0).getTime() / 1000;
    assert.equal(M.formatAge(now - 10, now), 'now');
    assert.equal(M.formatAge(now - 300, now), '5m');
    assert.equal(M.formatAge(now - 7200, now), '2h');
    assert.equal(M.formatAge(now - 90000, now), 'Yesterday');
    assert.equal(M.formatAge(0, now), '');
    assert.equal(M.dayLabel(now - 60, now), 'Today');
    assert.equal(M.dayLabel(now - 86400, now), 'Yesterday');
    const groups = M.groupByDay([{ id: 1, at: now - 10 }, { id: 2, at: now - 20 }, { id: 3, at: now - 86400 }, { id: 4, at: now - 86500 }], now);
    assert.deepEqual(groups.map(g => [g.label, g.entries.length]), [['Today', 2], ['Yesterday', 2]]);
  });

  check('a target becomes canonical navigation from known string keys only', () => {
    assert.deepEqual(M.navigationFor({ tab: 'botsShell', agentId: 'a1', sessionId: 's1', messageId: 'm9', extra: 'x', __proto__: { y: 1 } }),
      { tab: 'botsShell', agentId: 'a1', sessionId: 's1', messageId: 'm9' }, 'exact chat and message preserved, nothing else');
    assert.deepEqual(M.navigationFor({ agentId: 'a1' }), { tab: 'botsShell', agentId: 'a1' });
    assert.deepEqual(M.navigationFor({ agentId: 'a1' }, 'inbox'), { tab: 'botsShell', agentId: 'a1', attention: 'inbox' });
    assert.equal(M.navigationFor({ tab: 'botsShell' }), null, 'no bot and no conversation is nowhere to go');
    assert.equal(M.navigationFor({ agentId: 5, sessionId: {} }), null);
    assert.equal(M.navigationFor(null), null);
    assert.equal(M.navigationFor('s1'), null);
  });

  check('question answers are complete or refused', () => {
    const questions = [{ question: 'Which slot?', options: [{ label: 'Tue' }] }, { question: 'Which days?', multiSelect: true, options: [] }];
    assert.deepEqual(M.buildAnswers(questions, { 'Which slot?': 'Tue' }), { error: 'Answer every question first.' });
    assert.deepEqual(M.buildAnswers(questions, { 'Which slot?': '  ', 'Which days?': ['Mon'] }), { error: 'Answer every question first.' });
    assert.deepEqual(M.buildAnswers(questions, { 'Which slot?': ' Tue ', 'Which days?': ['Mon', ' Wed ', ''] }),
      { answers: { 'Which slot?': 'Tue', 'Which days?': ['Mon', 'Wed'] } });
    assert.deepEqual(M.buildAnswers(questions, { 'Which slot?': 'Tue', 'Which days?': [] }), { error: 'Answer every question first.' });
  });

  check('actions come from the row, and nothing else', () => {
    assert.equal(M.hasAction({ actions: ['reply', 'close'] }, 'close'), true);
    assert.equal(M.hasAction({ actions: ['reply'] }, 'approve'), false);
    assert.equal(M.hasAction({}, 'reply'), false);
    assert.equal(M.hasAction(null, 'reply'), false);
  });

  check('activity lines say where they came from, and flag failures', () => {
    const run = M.entryLine({ source: 'kairos-run-timeline', data: { kind: 'tool', name: 'run_command', ok: false, detail: 'exit 1' } });
    assert.deepEqual(run, { title: 'run_command', detail: 'exit 1', tone: 'bad', source: 'Run timeline' });
    const runtime = M.entryLine({ source: 'kairos-runtime', data: { type: 'turn.completed', status: 'done' } });
    assert.deepEqual([runtime.title, runtime.tone, runtime.source], ['turn.completed', 'ok', 'Runtime event']);
    assert.equal(M.entryLine({ source: 'kairos-runtime', data: { type: 'runtime.error' } }).tone, 'bad');
    assert.equal(M.entryLine({}).title, 'Event');
    assert.ok(!Object.values(M.SOURCE_LABELS).some(label => /provider|native|trace/i.test(label)), 'no row is labelled as a provider trace');
  });

  check('every kind has a plain label and none uses an em-dash', () => {
    for (const kind of ['question', 'approval', 'review', 'report', 'done', 'turn-failed', 'routine-failed', 'routine-deferred', 'incident', 'sign-in', 'delegation-settled', 'mention', 'spend', 'brief']) {
      assert.ok(M.KIND_LABELS[kind], kind);
    }
    assert.equal(M.kindLabel('unheard-of'), 'Update');
    for (const label of [...Object.values(M.KIND_LABELS), ...Object.values(M.ACTION_LABELS)]) assert.ok(!/[–—]/.test(label), label);
  });

  console.log(`Bots attention model: ${passed.length} checks passed.`);
})().catch(error => { console.error(error); process.exit(1); });
