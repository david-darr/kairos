const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const m = await import(pathToFileURL(path.resolve(__dirname, '../static/js/botsWorkModel.js')).href);
  assert.deepEqual(m.GROUPS.map(g => g[0]), ['ready_for_review', 'needs_input', 'failed', 'working', 'resolved']);
  const now = 1000000;
  const data = { groups: { working: [
    { id: 'a', title: 'Draft the annual plan', updated_at: 20 }, { id: 'b', title: 'Draft the weekly plan', updated_at: 30 },
  ], resolved: [{ id: 'c', title: 'Done', resolved_at: now - 20 }, { id: 'd', title: 'Old', resolved_at: 1 }] } };
  let groups = m.groupsFor(data, { now });
  assert.equal(groups[0].rows[0].id, 'b');
  assert.equal(groups[1].folded, true);
  assert.equal(groups[1].rows.length, 1);
  groups = m.groupsFor(data, { query: 'annual draft', now, oldest: true, resolvedOpen: true });
  assert.equal(groups.length, 1); assert.equal(groups[0].rows[0].id, 'a');
  assert.equal(m.groupsFor(data, { now, resolvedOpen: true })[1].folded, false);
  assert.equal(m.nextStep('I checked. Which date?'), 'Which date?');
  assert.equal(m.nextStep(''), 'Just started');
  assert.equal(m.rowText({ state: 'needs_input', next_step: 'Which date?' }), 'Needs input · Which date?');
  assert.equal(m.updatedLabel(999999, now), 'Updated just now');
  assert.equal(m.updatedLabel(now - 61, now), 'Updated 1 min ago');
  assert.equal(m.updatedLabel(now - 7200, now), 'Updated 2 h ago');
  assert.equal(m.updatedLabel(now + 60, now), 'Updated just now');
  for (const kind of Object.keys(m.STARTERS)) {
    const starter = m.starterSelection(kind);
    assert.equal(starter.text.slice(starter.start, starter.end), '...');
    assert.equal(m.validAsk(starter.text), false);
    assert.equal(m.validAsk(starter.text.replace('...', 'the quarterly report')), true);
  }
  assert.equal(m.validAsk(' '), false); assert.equal(m.validAsk('x'.repeat(4001)), false);
  assert.equal(m.checkOutcome({}), 'Looking...');
  assert.equal(m.checkOutcome({ finished: true }), 'Nothing new right now. I will keep checking.');
  assert.equal(m.checkOutcome({ failed: true }), 'Could not check just now. Try again.');
  assert.equal(m.checkOutcome({ hasSuggestions: true }), 'found');
  assert.match(m.checkOutcome({ elapsed: 180000 }), /taking a while/);
  console.log('PASS bots work model: groups, text, age, folding, search, starters, polling');
})().catch(error => { console.error(error); process.exitCode = 1; });
