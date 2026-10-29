// The Bots rail's rules (Agents 3.0 Phase 0, unit U3): plain-Node checks of the
// functions in static/js/botsRail.js that need no DOM. Run: node scripts/test_bots_rail.cjs
//   - the order of bots: the person's own order, then name; no order sorts last
//   - archived (hidden) bots are left out of the rail and counted for "Archived (N)"
//   - a row's status comes from botStatus.js, so its precedence is that file's
//     (needs you, working, waiting, queued, idle; off wins for a bot that is off)
// The rail itself (rows, active mark, Archived row, Simple/Advanced) is drawn and
// clicked in scripts/bots-shell-checks.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };
const bot = (id, name, extra = {}) => ({ id, name, enabled: true, status: 'idle', needs_you: 0, ...extra });

(async () => {
  const R = await load('js/botsRail.js');
  const S = await load('js/botStatus.js');

  check('bots are ordered by `order`, then by name', () => {
    const list = [bot('d', 'Dune', { order: 2 }), bot('b', 'Birch', { order: 0 }), bot('c', 'Cedar', { order: 1 }), bot('a', 'Alder', { order: 2 })];
    assert.deepEqual(R.visibleBots(list).map(b => b.id), ['b', 'c', 'a', 'd'], 'order first, a tie by name');
  });

  check('a bot with no order sorts after the ordered ones, by name, case-blind', () => {
    const list = [bot('z', 'zinnia'), bot('o', 'Oak', { order: 5 }), bot('m', 'Maple', { order: null }), bot('a', 'Ash')];
    assert.deepEqual(R.visibleBots(list).map(b => b.id), ['o', 'a', 'm', 'z']);
  });

  check('the same name keeps a stable order (by id)', () => {
    const list = [bot('b2', 'Twin'), bot('b1', 'Twin')];
    assert.deepEqual(R.visibleBots(list).map(b => b.id), ['b1', 'b2']);
  });

  check('hidden bots are filtered out of the rail and counted apart', () => {
    const list = [bot('a', 'Ash'), bot('b', 'Birch', { hidden: true }), bot('c', 'Cedar', { hidden: false }), bot('d', 'Dune', { hidden: true })];
    assert.deepEqual(R.visibleBots(list).map(b => b.id), ['a', 'c']);
    assert.deepEqual(R.archivedBots(list).map(b => b.id), ['b', 'd']);
  });

  check('ordering does not change the list it is given', () => {
    const list = [bot('b', 'Birch'), bot('a', 'Ash')];
    R.visibleBots(list);
    assert.deepEqual(list.map(b => b.id), ['b', 'a']);
  });

  check('anything that is not a list of bots gives an empty rail', () => {
    for (const bad of [null, undefined, {}, 'x', 7]) {
      assert.deepEqual(R.visibleBots(bad), []);
      assert.deepEqual(R.archivedBots(bad), []);
    }
    assert.deepEqual(R.visibleBots([null, undefined, bot('a', 'Ash')]).map(b => b.id), ['a']);
  });

  check('a row says what botStatus.js says, with the precedence of that file', () => {
    const cases = [
      [bot('1', 'One', { status: 'working', needs_you: 2 }), 'needs_you'],
      [bot('2', 'Two', { status: 'working' }), 'working'],
      [bot('3', 'Three', { status: 'needs_you' }), 'needs_you'],
      [bot('4', 'Four'), 'idle'],
      [bot('5', 'Five', { status: 'capped' }), 'idle'],
      [bot('6', 'Six', { status: 'working', enabled: false }), 'off'],
      [bot('7', 'Seven', { status: 'off' }), 'off'],
    ];
    for (const [agent, state] of cases) {
      const row = R.railRow(agent);
      assert.equal(row.state, state, `${agent.name}: ${row.state}`);
      assert.equal(row.state, S.botStatusLine(agent).state, 'the same word botStatusLine gives');
      assert.equal(row.text, S.botStatusLine(agent).text);
    }
  });

  check('a row carries the needs-you count and a spoken label', () => {
    const row = R.railRow(bot('s', 'Scout', { status: 'needs_you', needs_you: 2 }));
    assert.equal(row.needs, 2);
    assert.equal(row.label, 'Scout, Needs you: 2 items');
    assert.equal(R.railRow(bot('s', 'Scout')).needs, 0);
    assert.equal(R.railRow(bot('s', 'Scout', { needs_you: -3 })).needs, 0, 'never negative');
    assert.equal(R.railRow(bot('s', 'Scout')).label, 'Scout, Ready for work');
  });

  check('a bot with no name still has a row', () => {
    assert.equal(R.railRow({ id: 'x', enabled: true }).name, 'Bot');
  });

  console.log(`PASS: ${passed.length} Bots rail checks.`);
})().catch(error => { console.error(error); process.exit(1); });
