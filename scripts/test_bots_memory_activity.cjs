// Bots Phase 2, unit U2: Memory activity and About you, the pure parts, in plain Node.
// Run: node scripts/test_bots_memory_activity.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', 'static');
const load = file => import(pathToFileURL(path.join(root, 'js', file)).href);
const passed = [];
let finished = false, running = '';
const check = async (name, fn) => { running = name; await fn(); passed.push(name); };
// A promise that never settles would end Node silently with exit 0; say so instead.
process.on('exit', () => { if (!finished) { console.error(`FAIL: stopped before finishing: ${running}`); process.exitCode = 1; } });

// A timer the test steps by hand.
function clock() {
  let now = 0, next = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: id => timers.delete(id),
    tick: async ms => {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); await t.fn(); }
    },
    pending: () => timers.size,
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const M = await load('botsMemoryActivityModel.js');

  await check('reports list only what happened, in plain words', () => {
    assert.deepEqual(M.reportRows({ kind: 'tidy', expired: 2, duplicates: 0, superseded: 1, deferred: 0, organized: 0, contradictionsChecked: 1, topicChecks: 2, note: '' }),
      [{ label: 'Expired', value: '2' }, { label: 'Replaced', value: '1' }, { label: 'Checked for conflicts', value: '3' }]);
    assert.deepEqual(M.reportRows({ kind: 'capture', saved: 3, profile: 1, deferred: 0, topics: ['work', 'desk'], rejected: { 'no evidence': 2 } }).map(r => r.label),
      ['Saved', 'About you', 'Topics', 'Not kept']);
    assert.deepEqual(M.reportRows({ kind: 'dream', patterns: 1, outdated: 0, ideas: 2 }).map(r => r.label), ['Patterns', 'Ideas']);
    assert.equal(M.nothingHappened({ kind: 'tidy', expired: 0, duplicates: 0, superseded: 0, deferred: 0, organized: 0, contradictionsChecked: 0, topicChecks: 0 }), true);
    assert.equal(M.reportRows({ kind: 'tidy', note: 'No model can run.' }).pop().value, 'No model can run.');
    assert.deepEqual(M.reportRows(null), []);
    assert.equal(M.reportTitle({ kind: 'capture', at: 1000 }, 1030), 'Noticed just now');
    assert.equal(M.reportTitle({ kind: 'tidy', at: 1000 }, 1000 + 7200), 'Tidied 2 h ago');
  });

  await check('expired ideas are never shown, and the rest say how long is left', () => {
    const now = 1_000_000;
    const ideas = [{ id: 'a', title: 'Old', created: now - 90000, expires: now - 3600 }, { id: 'b', title: 'Fresh', created: now - 100, expires: now + 7300 },
      { id: 'c', title: 'Soon', created: now - 50, expires: now + 600 }, { id: 'd', title: 'Edge', created: now, expires: now }];
    assert.deepEqual(M.liveIdeas(ideas, now).map(i => i.id), ['c', 'b'], 'newest first; the one at the edge is expired');
    assert.equal(M.ideaLeft(ideas[1], now), '2 h left');
    assert.equal(M.ideaLeft(ideas[2], now), '10 min left');
    assert.equal(M.ideaLeft(ideas[0], now), 'expired');
    assert.deepEqual(M.liveIdeas(null, now), []);
  });

  await check('a bot that is not keeping notes says why', () => {
    assert.equal(M.memoryState({ memory_enabled: false, upkeep: true }).kind, 'off');
    assert.match(M.memoryState({ memory_enabled: false }).text, /Memory is off/);
    assert.equal(M.memoryState({ memory_enabled: true, upkeep: false }).kind, 'manual');
    assert.equal(M.memoryState({ memory_enabled: true, upkeep: true, model_available: false }).kind, 'no-model');
    assert.equal(M.memoryState({ memory_enabled: true, upkeep: true, model_available: true }).text, '');
    assert.equal(M.memoryState(null).kind, 'unknown');
    assert.equal(M.pendingLine({ pending_threads: 2, pending_turns: 5 }), '2 chats waiting to be noticed (5 exchanges).');
    assert.equal(M.pendingLine({ pending_threads: 1, pending_turns: 1 }), '1 chat waiting to be noticed (1 exchange).');
    assert.equal(M.pendingLine({ pending_threads: 0 }), '');
  });

  await check('recall citations name the source and carry the message reference', () => {
    assert.deepEqual(M.citation({ kind: 'conversation', role: 'user', title: 'Trip', ts: 1761700000, ref: 'm1' }), { label: 'You in Trip, 2025-10-29', ref: 'm1' });
    assert.equal(M.citation({ kind: 'conversation', role: 'digest', title: 'Trip', ref: 'd' }).label, 'Summary in Trip');
    assert.equal(M.citation({ kind: 'memory', title: 'work', ref: 'topic:work:0' }).label, 'Notes on work');
    assert.equal(M.recallQuery('  Henderson & co  '), 'q=Henderson%20%26%20co');
    assert.equal(M.recallQuery('   '), '');
  });

  await check('forget wants a word of three letters', () => {
    assert.match(M.forgetTermProblem('ab'), /three letters/);
    assert.match(M.forgetTermProblem('12 34'), /three letters/);
    assert.equal(M.forgetTermProblem('Henderson'), '');
    assert.equal(M.forgetTermProblem('Élodie'), '');
    assert.match(M.forgetTermProblem('x'.repeat(61)), /60/);
  });

  await check('the About you counter counts characters against 24,000', () => {
    assert.equal(M.aboutCounter('abc').text, '3 / 24,000 characters');
    assert.equal(M.aboutCounter('x'.repeat(24001)).over, true);
    assert.equal(M.aboutCounter('x'.repeat(24000)).over, false);
    assert.deepEqual(M.learnedRows([{ id: 'f', text: 'Likes jazz', learned_by: 'Scout', at: 1000 }], 1000 + 3 * 86400), [{ id: 'f', text: 'Likes jazz', by: 'Scout', when: '3 d ago' }]);
    assert.equal(M.learnedRows([{ id: 'g', text: 'x' }])[0].by, 'a bot');
  });

  await check('autosave waits 600 ms, saves once for a burst, and ends saved', async () => {
    const c = clock(), saves = [], states = [];
    const saver = M.createAutosave({ save: async t => { saves.push(t); }, setTimer: c.setTimer, clearTimer: c.clearTimer, onState: s => states.push(s.state) });
    saver.start('hello');
    saver.edit('hello w'); await c.tick(300); saver.edit('hello wo'); await c.tick(300);
    assert.deepEqual(saves, [], 'a burst of typing has not saved yet');
    await c.tick(300); await settle();
    assert.deepEqual(saves, ['hello wo']);
    assert.equal(saver.state, 'saved');
    assert.deepEqual([...new Set(states)], ['idle', 'dirty', 'saving', 'saved']);
    saver.edit('hello wo'); assert.equal(saver.state, 'idle', 'typing the saved text again is not a change');
    assert.equal(c.pending(), 0);
  });

  await check('a failed save shows the error, keeps the draft and Retry saves the same text', async () => {
    const c = clock(); let fail = true; const saves = [];
    const saver = M.createAutosave({ save: async t => { if (fail) throw new Error('503: busy'); saves.push(t); }, setTimer: c.setTimer, clearTimer: c.clearTimer });
    saver.start('');
    saver.edit('my notes'); await c.tick(600); await settle();
    assert.equal(saver.state, 'error');
    assert.equal(saver.error, 'busy');
    assert.equal(saver.dirty, true, 'the draft is still unsaved');
    fail = false;
    await saver.retry();
    assert.deepEqual(saves, ['my notes']);
    assert.equal(saver.state, 'saved');
  });

  await check('an edit made during a save is saved next, never lost', async () => {
    const c = clock(); const saves = []; let release;
    const saver = M.createAutosave({ save: t => new Promise(resolve => { saves.push(t); release = resolve; }), setTimer: c.setTimer, clearTimer: c.clearTimer });
    saver.start('');
    saver.edit('one'); c.tick(600); await settle();
    assert.equal(saver.state, 'saving');
    saver.edit('one two');
    release(); await settle(); await settle();
    assert.deepEqual(saves, ['one', 'one two']);
    release(); await settle();
    assert.equal(saver.state, 'saved');
  });

  await check('a 409 stops autosave until the person reloads, and a clean editor adopts the server text', async () => {
    const c = clock(); let calls = 0;
    const saver = M.createAutosave({ save: async () => { calls++; const e = new Error('409: About you changed'); e.status = 409; throw e; }, setTimer: c.setTimer, clearTimer: c.clearTimer });
    saver.start('a');
    saver.edit('b'); await c.tick(600); await settle();
    assert.equal(saver.state, 'conflict');
    saver.edit('bc'); await c.tick(600); await settle();
    assert.equal(calls, 1, 'no more saves while in conflict');
    saver.resolveConflict('server text');
    assert.equal(saver.state, 'idle');
    assert.equal(saver.dirty, false);
    const clean = M.createAutosave({ save: async () => {} });
    clean.start('x');
    assert.equal(clean.adopt('y'), true, 'a clean editor takes the newer text');
    clean.edit('typed');
    assert.equal(clean.adopt('z'), false, 'a dirty one keeps the draft');
    clean.stop();
  });

  await check('flush saves a pending edit at once (before another change)', async () => {
    const c = clock(); const saves = [];
    const saver = M.createAutosave({ save: async t => { saves.push(t); }, setTimer: c.setTimer, clearTimer: c.clearTimer });
    saver.start('');
    saver.edit('draft'); await saver.flush();
    assert.deepEqual(saves, ['draft']);
    assert.equal(c.pending(), 0);
    await saver.flush();
    assert.deepEqual(saves, ['draft'], 'nothing pending, nothing saved');
  });

  await check('the sections export mount, load their own CSS, and draw server text inertly', () => {
    for (const file of ['botsSectionMemoryActivity.js', 'botsSectionAboutYou.js']) {
      const source = fs.readFileSync(path.join(root, 'js', file), 'utf8');
      assert.match(source, /export function mount\(host, ctx/, `${file} exports mount`);
      assert.match(source, /loadBotsCss\(MEMORY_ACTIVITY_CSS\)/);
      assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, `${file} never builds markup from text`);
      assert.match(source, /destroyed/, `${file} guards destruction`);
      assert.doesNotMatch(source, /—/, 'no em-dashes in user-facing copy');
    }
    const model = fs.readFileSync(path.join(root, 'js', 'botsMemoryActivityModel.js'), 'utf8');
    assert.doesNotMatch(model.replace(/\/\/.*$/gm, ''), /—/);
  });

  await check('the stylesheet uses tokens only', () => {
    const css = fs.readFileSync(path.join(root, 'css', 'bots-memory-activity.css'), 'utf8');
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no raw colours');
    assert.match(css, /\[data-app-mode="bots"\] \.bots-mact/);
    assert.match(css, /prefers-reduced-motion/);
  });

  finished = true;
  console.log(`${passed.length} checks passed:\n- ${passed.join('\n- ')}`);
})().catch(error => { console.error(error); process.exit(1); });
