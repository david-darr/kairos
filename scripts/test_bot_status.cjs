// The bot status precedence, tested where it now lives (static/js/botStatus.js).
// It used to be asserted through the sidebar rail's DOM; David removed the rail's
// sections on 2026-10-14, and the rule outlived them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const code = fs.readFileSync(path.join(__dirname, '../static/js/botStatus.js'), 'utf8');
  const { botStatus, compareStatus, readablePreview, STATUS_ORDER } =
    await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

  const handoff = status => ({ type: 'handoff', handoff_status: status });

  // Precedence: needs you › working › teammate › queued › idle.
  assert.equal(botStatus({ status: 'idle' }), 'idle');
  assert.equal(botStatus({ status: 'idle' }, [handoff('queued')]), 'queued');
  assert.equal(botStatus({ status: 'idle' }, [handoff('queued'), handoff('working')]), 'teammate');
  assert.equal(botStatus({ status: 'working' }, [handoff('working')]), 'working');
  assert.equal(botStatus({ status: 'idle' }, [], true), 'working', 'a live turn counts as working');

  // Aggregation: needing the person anywhere wins, even while working elsewhere.
  assert.equal(botStatus({ status: 'working', needs_you: 1 }), 'needs_you', 'summary count wins over working');
  assert.equal(botStatus({ status: 'working' }, [handoff('needs_you')]), 'needs_you', 'a handoff question wins');
  assert.equal(botStatus({ status: 'working' }, [{ inbox_item_id: 'i1', question_status: 'open' }], true),
    'needs_you', 'an open question in another thread wins over a live turn');
  assert.equal(botStatus({ status: 'idle' }, [{ inbox_item_id: 'i1', question_status: 'answered' }]), 'idle');
  assert.equal(botStatus(undefined), 'idle', 'a missing summary does not throw');

  assert.deepEqual(['queued', 'needs_you', 'idle', 'teammate', 'working'].sort(compareStatus), STATUS_ORDER);

  // The preview is the last readable line, without Markdown or handoff cards.
  assert.equal(readablePreview([
    { role: 'assistant', content: '**Found** two [roles](https://x.test).\n\n```js\nx()\n```' },
    { role: 'assistant', type: 'handoff', content: 'Handed to Scout' },
    { role: 'assistant', status: 'failed', content: 'boom' },
  ]), 'Found two roles. code');
  assert.equal(readablePreview([]), '');

  console.log('Bot status precedence, aggregation and preview hold.');
})().catch(error => { console.error(error); process.exit(1); });
