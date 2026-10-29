const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '../static/js/botsFrontDeskModel.js')));
  for (const value of ['', '/', '/channels/a', '/settings']) assert.equal(M.tabForPath(value), 'chat');
  for (const tab of ['tasks', 'make']) { assert.equal(M.tabForPath(`/${tab}/one?from=chat`), tab); assert.equal(M.tabFor(tab), tab); }
  assert.equal(M.badgeCount({ groups: { needs_input: [1, 2] }, loose: { approvals: [1], questions: [1] } }), 4);
  assert.equal(M.badgeCount({ needs_input_count: -4 }), 0);
  assert.deepEqual([0, 1, 9, 10, 99, 100].map(M.badgeDigits), ['', '1', '9', '10', '99', '99+']);
  for (const [now, expected] of [[19999, 'Reading mail'], [20000, 'Still working'], [59999, 'Still working'], [60000, 'This is taking a while']]) {
    assert.equal(M.stepPill({ working: true, changedAt: 100, now: now + 100, step: 'Reading mail' }), expected);
  }
  assert.equal(M.stepPill({ needs: true, working: true }), 'Needs you');
  assert.equal(M.stepPill({ working: false }), '');
  assert.equal(M.swipeThreshold(100), 96); assert.equal(M.swipeThreshold(400), 140);
  assert.equal(M.swipeMove({ dx: 7, dy: 1 }).axis, '');
  assert.equal(M.swipeMove({ dx: 9, dy: 10 }).axis, 'vertical');
  assert.equal(M.swipeMove({ dx: 999, dy: 0, locked: 'vertical' }).action, null);
  assert.equal(M.swipeMove({ dx: 139, dy: 0, width: 400 }).action, null);
  assert.equal(M.swipeMove({ dx: 140, dy: 0, width: 400 }).action, 'start');
  assert.equal(M.swipeMove({ dx: -96, width: 200 }).action, 'hide');
  const card = (id, kind) => ({ id, type: 'fd_card', fd_kind: kind });
  const rows = [card('c1', 'chips'), card('s', 'suggestion'), { id: 'words' }, card('t', 'task_link'), card('c2', 'chips')];
  assert.deepEqual(M.orderTurnCards(rows).map(r => r.id), ['words', 's', 't', 'c2']);
  for (const option of ['pending', 'firstDay', 'streaming']) assert.equal(M.orderTurnCards(rows, { [option]: true }).length, 3);
  assert.equal(M.kipState({ finishedAt: 100, working: true, needs: true, now: 200 }), 'success');
  assert.equal(M.kipState({ needs: true, working: true }), 'needs');
  assert.equal(M.kipState({ working: true, draft: 'hello' }), 'thinking');
  assert.equal(M.kipState({ draft: 'hello', answeredAt: 100, now: 200 }), 'listening');
  assert.equal(M.kipState({ answeredAt: 100, now: 2699 }), 'success');
  assert.equal(M.kipState({ answeredAt: 100, now: 2700 }), 'idle');
  assert.equal(M.kipState({ tab: 'make', draft: 'hello', answeredAt: 100, now: 200 }), 'idle');
  assert.equal(M.entranceDelay(2, 3, { history: true }), null);
  assert.equal(M.entranceDelay(2, 3, { history: false, firstDay: true }), 800);
  for (const bad of ['http://example.com', 'javascript:alert(1)', '//example.com', 'https://u:p@example.com', 'https://example.com\\evil', 'https://example.com/ bad']) assert.equal(M.safeHttps(bad), null);
  assert.equal(M.safeHttps('https://example.com/path'), 'https://example.com/path');
  const Make = await import(pathToFileURL(path.join(__dirname, '../static/js/botsMakeModel.js')));
  assert.deepEqual(Make.MAKE_KINDS.map(k => k.id), ['all', 'design', 'slides', 'website', 'files']);
  assert.equal(Make.makeKind('unknown'), 'all');
  assert.deepEqual(Make.makeItems([{ id: 'old', kind: 'slides', updated_at: 1 }, { id: 'file', kind: 'files', updated_at: 3 }, { id: 'new', kind: 'slides', updated_at: 2 }], 'slides').map(i => i.id), ['new', 'old']);
  for (const item of Make.MAKE_KINDS.filter(k => k.starter)) assert.deepEqual(item.starter.slice(...Make.starterSelection(item.starter)), '...');
  assert.match(Make.makeEmpty('slides'), /No slides yet/);
  assert.equal(Make.safeMakeThumb('https://evil/thumb'), null);
  assert.ok(Make.safeMakeThumb('/api/designs/abcdef123456/boards/one/thumb'));
  assert.deepEqual(Make.makeTarget({ open: { tab: 'design', id: 'abcdef123456' } }), { tab: 'design', designId: 'abcdef123456' });
  for (const url of ['javascript:alert(1)', '/generated-files/../x', '/generated-files/%2e%2e', '//evil/file', '/generated-files/a%2fb']) assert.equal(Make.makeTarget({ open: { tab: 'artifact', id: url, session_id: 's' } }), null);
  console.log('PASS: front-desk tabs, badge, timers, swipe, ordering, motion and Kip priority');
})().catch(e => { console.error(e); process.exitCode = 1; });
