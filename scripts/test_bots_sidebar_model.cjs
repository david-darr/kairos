// The Bots sidebar's rules (Phase 1, unit U4): plain-Node checks of
// static/js/botsSidebarModel.js, which has no DOM, storage or network.
// Run: node scripts/test_bots_sidebar_model.cjs
//   - attention order: waiting on you, working, waiting on a teammate, queued, unread, current, rest
//   - six ordinary recent threads, plus pinned, current, attention and unread ones; snoozed ones hide
//   - archived and routine-run threads never show; unknown folders fall back to the unfiled group
//   - preferences keep only valid values; widths clamp to 240..480 and to the viewport minus 320
//   - density widths (280/320, compact 272, icons 92/80), separator keys, search from two characters
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const file = path.join(__dirname, '..', 'static', 'js', 'botsSidebarModel.js');
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };
const NOW = 1_000_000;
const row = (id, extra = {}, thread = {}) => ({ id, title: `Thread ${id}`, updated_at: 100, thread: { folder_id: null, ...thread }, ...extra });
const ids = rows => rows.map(r => r.id);

(async () => {
  const M = await import(pathToFileURL(file).href);

  check('attention ranks: waiting on you, working, teammate, queued, unread, current, rest', () => {
    const rank = (r, current = '') => M.threadAttention(r, current);
    assert.equal(rank(row('a', { needs_you: true })), 0);
    assert.equal(rank(row('a', { open_asks: 1 })), 0);
    assert.equal(rank(row('a', { status: 'needs_you' })), 0);
    assert.equal(rank(row('a', { status: 'working' })), 1);
    assert.equal(rank(row('a', { status: 'processing' })), 1);
    assert.equal(rank(row('a', { waiting_on_teammate: true })), 2);
    assert.equal(rank(row('a', { status: 'teammate' })), 2);
    assert.equal(rank(row('a', { queue_count: 2 })), 3);
    assert.equal(rank(row('a', { status: 'queued' })), 3);
    assert.equal(rank(row('a', {}, { unread: true })), 4);
    assert.equal(rank(row('a'), 'a'), 5);
    assert.equal(rank(row('a')), 6);
    assert.equal(rank(row('a', { needs_you: true, status: 'working' }, { unread: true })), 0, 'the strongest reason wins');
  });

  check('visibleThreads orders by attention, then newest, then id', () => {
    const rows = [row('rest', { updated_at: 500 }), row('unread', { updated_at: 10 }, { unread: true }), row('queued', { queue_count: 1, updated_at: 20 }),
      row('teammate', { status: 'teammate', updated_at: 30 }), row('working', { status: 'working', updated_at: 40 }), row('needs', { needs_you: true, updated_at: 5 }),
      row('cur', { updated_at: 1 })];
    assert.deepEqual(ids(M.visibleThreads(rows, { currentId: 'cur', now: NOW })), ['needs', 'working', 'teammate', 'queued', 'unread', 'cur', 'rest']);
    assert.deepEqual(ids(M.visibleThreads([row('b', { updated_at: 7 }), row('a', { updated_at: 7 })], { now: NOW })), ['a', 'b'], 'a tie is by id');
  });

  check('six ordinary recent threads show; older ones wait behind Show all', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`t${i}`, { updated_at: 100 + i }));
    assert.deepEqual(ids(M.visibleThreads(rows, { now: NOW })), ['t9', 't8', 't7', 't6', 't5', 't4']);
    assert.equal(M.visibleThreads(rows, { now: NOW, all: true }).length, 10);
  });

  check('pinned, current, attention and unread threads are exceptions beyond the six', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`t${i}`, { updated_at: 100 + i }));
    rows.push(row('old-pin', { updated_at: 1 }, { pinned: true }), row('old-cur', { updated_at: 2 }), row('old-need', { updated_at: 3, needs_you: true }),
      row('old-unread', { updated_at: 4 }, { unread: true }));
    const shown = ids(M.visibleThreads(rows, { currentId: 'old-cur', now: NOW }));
    for (const id of ['old-pin', 'old-cur', 'old-need', 'old-unread']) assert.ok(shown.includes(id), id);
    assert.equal(shown.length, 6 + 4, 'six ordinary plus the four exceptions');
    assert.ok(!shown.includes('t0') && !shown.includes('t1'), 'the oldest ordinary ones are out');
  });

  check('the current and pinned threads do not use up the six', () => {
    const rows = [...Array.from({ length: 7 }, (_, i) => row(`t${i}`, { updated_at: 100 + i })), row('cur', { updated_at: 500 }), row('pin', { updated_at: 600 }, { pinned: true })];
    const shown = ids(M.visibleThreads(rows, { currentId: 'cur', now: NOW }));
    assert.equal(shown.length, 8, 'two exceptions and six ordinary');
  });

  check('snoozed threads hide, except pinned, current and ones that need you', () => {
    const rows = [row('plain-snooze', {}, { snoozed_until: NOW + 100 }), row('until-new', {}, { snoozed_until: 0 }), row('expired', {}, { snoozed_until: NOW - 1 }),
      row('pin-snooze', {}, { snoozed_until: NOW + 100, pinned: true }), row('cur-snooze', {}, { snoozed_until: 0 }),
      row('need-snooze', { needs_you: true }, { snoozed_until: NOW + 100 }), row('unread-snooze', {}, { snoozed_until: NOW + 100, unread: true })];
    const shown = ids(M.visibleThreads(rows, { currentId: 'cur-snooze', now: NOW }));
    assert.ok(!shown.includes('plain-snooze') && !shown.includes('until-new') && !shown.includes('unread-snooze'));
    for (const id of ['expired', 'pin-snooze', 'cur-snooze', 'need-snooze']) assert.ok(shown.includes(id), id);
    assert.ok(!ids(M.visibleThreads(rows, { now: NOW, all: true })).includes('plain-snooze'), 'Show all does not unsnooze');
  });

  check('archived and routine-run threads never show', () => {
    const rows = [row('a', {}, { archived_at: 5 }), row('r', {}, { routine_run_id: 'run1' }), row('ok')];
    assert.deepEqual(ids(M.visibleThreads(rows, { now: NOW, all: true })), ['ok']);
    assert.deepEqual(ids(M.visibleThreads([row('a', { needs_you: true }, { archived_at: 5 })], { now: NOW })), []);
  });

  check('bad input gives an empty list, not an error', () => {
    for (const bad of [null, undefined, {}, 'x', 7]) assert.deepEqual(M.visibleThreads(bad), []);
    assert.deepEqual(ids(M.visibleThreads([null, undefined, row('ok')], { now: NOW })), ['ok']);
  });

  check('folders: threads go to their folder; a missing folder falls back to the unfiled group', () => {
    const folders = [{ id: 'f1', name: 'Work', order: 1 }, { id: 'f2', name: 'Home', order: 0 }];
    const rows = [row('a', {}, { folder_id: 'f1' }), row('b', {}, { folder_id: 'gone' }), row('c'), row('d', {}, { folder_id: 'f2' })];
    const tree = M.folderTree(rows, folders, { now: NOW });
    assert.deepEqual(tree.map(g => g.id), [null, 'f1', 'f2']);
    assert.deepEqual(ids(tree[0].threads).sort(), ['b', 'c'], 'a deleted folder never hides a thread');
    assert.deepEqual(ids(tree[1].threads), ['a']);
    assert.equal(tree[0].name, 'Conversations');
    assert.deepEqual(M.botTree(rows, folders, { now: NOW }).map(g => g.id), [null, 'f2', 'f1'], "botTree follows the person's folder order");
    assert.deepEqual(M.folderTree(rows, null, { now: NOW }).map(g => g.id), [null]);
  });

  check('moving a conversation: only to a different, existing folder, never when archived', () => {
    const folders = [{ id: 'f1' }];
    assert.equal(M.canMoveThread(row('a'), 'f1', folders), true);
    assert.equal(M.canMoveThread(row('a', {}, { folder_id: 'f1' }), 'f1', folders), false, 'already there');
    assert.equal(M.canMoveThread(row('a', {}, { folder_id: 'f1' }), null, folders), true, 'back out to the unfiled group');
    assert.equal(M.canMoveThread(row('a'), null, folders), false);
    assert.equal(M.canMoveThread(row('a'), 'nope', folders), false);
    assert.equal(M.canMoveThread(row('a', {}, { archived_at: 1 }), 'f1', folders), false);
    assert.equal(M.canMoveThread(null, 'f1', folders), false);
  });

  check('after a bulk delete the rows the server removed are gone, the kept ones stay', () => {
    const rows = [row('a'), row('b'), row('c')];
    assert.deepEqual(ids(M.afterDelete(rows, { deleted: ['a', 'c'], busy: ['b'], kept: [] })), ['b']);
    assert.deepEqual(ids(M.afterDelete(rows, null)), ['a', 'b', 'c']);
  });

  check('preferences keep only valid values and fill every default', () => {
    const empty = M.sidebarPreferences();
    assert.deepEqual(empty, { density: 'comfortable', widths: { simple: 280, advanced: 320 }, sections: ['pinned', 'attention', 'bots'], collapsed: [], expanded: [], closedFolders: [], pinnedOrder: [] });
    const messy = M.sidebarPreferences({ density: 'huge', widths: { simple: 9999, advanced: 10 }, sections: ['bots', 'bots', 'nope', 'pinned'], collapsed: ['bots', 'x'],
      expanded: ['a', 'a', 7, 'b'], closedFolders: ['a:f'], pinnedOrder: ['z', 'y'] });
    assert.equal(messy.density, 'comfortable');
    assert.deepEqual(messy.widths, { simple: 480, advanced: 240 });
    assert.deepEqual(messy.sections, ['bots', 'pinned', 'attention'], 'unknown dropped, duplicates collapsed, missing appended');
    assert.deepEqual(messy.collapsed, ['bots']);
    assert.deepEqual(messy.expanded, ['a', 'b']);
    for (const bad of [null, 'x', 7, []]) assert.deepEqual(M.sidebarPreferences(bad), empty);
    assert.equal(M.sidebarPreferences({ density: 'icons' }).density, 'icons');
    assert.equal(M.sidebarPreferences({ expanded: Array.from({ length: 300 }, (_, i) => `b${i}`) }).expanded.length, 100, 'bounded');
    assert.equal(M.sidebarPreferences({ expanded: ['x'.repeat(200)] }).expanded.length, 0, 'long ids are refused');
  });

  check('preferences are per person', () => {
    assert.equal(M.sidebarPreferenceKey('david'), 'kairos:bots-sidebar:david');
    assert.notEqual(M.sidebarPreferenceKey('a b'), M.sidebarPreferenceKey('a%20b'));
    assert.equal(M.sidebarPreferenceKey(''), 'kairos:bots-sidebar:local');
    assert.equal(M.sidebarPreferenceKey(undefined), 'kairos:bots-sidebar:local');
  });

  check('width clamps to 240..480 and to the viewport minus 320', () => {
    assert.equal(M.clampSidebarWidth(100), 240);
    assert.equal(M.clampSidebarWidth(900), 480);
    assert.equal(M.clampSidebarWidth(300), 300);
    assert.equal(M.clampSidebarWidth(500, 700), 380, 'viewport 700 leaves 380');
    assert.equal(M.clampSidebarWidth(500, 400), 240, 'never below the minimum');
    assert.equal(M.clampSidebarWidth('abc'), 280);
    assert.deepEqual(M.widthBounds(1440), { min: 240, max: 480 });
    assert.deepEqual(M.widthBounds(600), { min: 240, max: 280 });
  });

  check('density sets the width: 280 / 320, compact 272, icons 92 / 80', () => {
    const widths = { simple: 300, advanced: 360 };
    assert.equal(M.railWidth('comfortable', false, {}), 280);
    assert.equal(M.railWidth('comfortable', true, {}), 320);
    assert.equal(M.railWidth('comfortable', false, widths), 300);
    assert.equal(M.railWidth('comfortable', true, widths), 360);
    assert.equal(M.railWidth('compact', false, widths), 272);
    assert.equal(M.railWidth('compact', true, widths), 272);
    assert.equal(M.railWidth('icons', false, widths), 92);
    assert.equal(M.railWidth('icons', true, widths), 80);
    assert.equal(M.railWidth('comfortable', true, { advanced: 470 }, 700), 380, 'a saved width clamps to a small window');
    assert.deepEqual(['comfortable', 'compact', 'icons', 'comfortable'].map((d, i, all) => M.nextDensity(d)), ['compact', 'icons', 'comfortable', 'compact']);
    assert.equal(M.nextDensity('nonsense'), 'comfortable');
  });

  check('the separator keys: arrows step 16, Shift steps 48, Home and End go to the ends, others are ignored', () => {
    assert.equal(M.widthAfterKey(300, 'ArrowRight'), 316);
    assert.equal(M.widthAfterKey(300, 'ArrowLeft'), 284);
    assert.equal(M.widthAfterKey(300, 'ArrowRight', true), 348);
    assert.equal(M.widthAfterKey(300, 'ArrowLeft', true), 252);
    assert.equal(M.widthAfterKey(244, 'ArrowLeft'), 240, 'stops at the minimum');
    assert.equal(M.widthAfterKey(470, 'ArrowRight'), 480, 'stops at the maximum');
    assert.equal(M.widthAfterKey(300, 'Home'), 240);
    assert.equal(M.widthAfterKey(300, 'End'), 480);
    assert.equal(M.widthAfterKey(300, 'End', false, 700), 380, 'End respects a small window');
    assert.equal(M.widthAfterKey(300, 'ArrowUp'), null);
    assert.equal(M.widthAfterKey(300, 'a'), null);
  });

  check('reorder moves one id by an offset and never leaves the list', () => {
    assert.deepEqual(M.reorder(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
    assert.deepEqual(M.reorder(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
    assert.deepEqual(M.reorder(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
    assert.deepEqual(M.reorder(['a', 'b', 'c'], 'c', 5), ['a', 'b', 'c']);
    assert.deepEqual(M.reorder(['a', 'b', 'c'], 'zzz', 1), ['a', 'b', 'c']);
    const original = ['a', 'b']; M.reorder(original, 'a', 1);
    assert.deepEqual(original, ['a', 'b'], 'the input is not changed');
  });

  check('pinned bots keep the person order, then the order given; hidden and unpinned are left out', () => {
    const bots = [{ id: 'a' }, { id: 'b' }, { id: 'c', hidden: true }, { id: 'd' }];
    const pins = [{ id: 'a', pinned: true }, { id: 'b', pinned: true }, { id: 'c', pinned: true }, { id: 'd', pinned: false }];
    assert.deepEqual(ids(M.orderedPins(bots, pins, [])), ['a', 'b']);
    assert.deepEqual(ids(M.orderedPins(bots, pins, ['b', 'a'])), ['b', 'a']);
    assert.deepEqual(ids(M.orderedPins(bots, pins, ['b'])), ['b', 'a'], 'a bot with no saved place goes last');
    assert.deepEqual(M.orderedPins(null, null, null), []);
  });

  check('search starts at two characters and finds bot names, jobs and loaded conversations', () => {
    const bots = [{ id: 'a', name: 'Scout', role: 'Watches job postings' }, { id: 'b', name: 'Archivist', blurb: 'Keeps notes' }];
    const threads = { a: [row('t1', { title: 'Weekly postings', updated_at: 5 }), row('t2', { title: 'Old', preview: 'nothing', updated_at: 1 }), row('t3', { title: 'Gone' }, { archived_at: 9 })],
      b: { threads: [row('t4', { title: 'Inbox', preview: 'Sorted the notes', updated_at: 9 })] } };
    assert.equal(M.searchReady('s'), false);
    assert.equal(M.searchReady(' s '), false);
    assert.equal(M.searchReady('sc'), true);
    assert.deepEqual(M.searchMatches('s', bots, threads), { bots: [], threads: [] });
    assert.deepEqual(ids(M.searchMatches('SCOUT', bots, threads).bots), ['a'], 'case does not matter');
    assert.deepEqual(ids(M.searchMatches('postings', bots, threads).bots), ['a'], 'a job matches');
    assert.deepEqual(M.searchMatches('postings', bots, threads).threads.map(t => [t.agentId, t.row.id]), [['a', 't1']]);
    assert.deepEqual(M.searchMatches('notes', bots, threads).threads.map(t => t.row.id), ['t4'], 'a preview matches, and both list shapes work');
    assert.deepEqual(ids(M.searchMatches('notes', bots, threads).bots), ['b'], 'a blurb matches');
    assert.deepEqual(M.searchMatches('gone', bots, threads).threads, [], 'archived conversations do not show');
    assert.deepEqual(M.searchMatches('  weekly   postings ', bots, threads).threads.map(t => t.row.id), ['t1'], 'spaces are tidied');
    assert.deepEqual(M.searchMatches('zz', null, null), { bots: [], threads: [] });
    const many = { a: Array.from({ length: 80 }, (_, i) => row(`m${i}`, { title: 'match me', updated_at: i })) };
    assert.equal(M.searchMatches('match', bots, many).threads.length, 50, 'bounded');
    assert.equal(M.searchMatches('match', bots, many).threads[0].row.id, 'm79', 'newest first');
  });

  check('attention across bots lists the ones that need you, then the ones at work', () => {
    const bots = [{ id: 'z', name: 'Zed', s: 'working' }, { id: 'a', name: 'Alder', s: 'idle' }, { id: 'n', name: 'Nell', s: 'needs_you' }, { id: 'b', name: 'Birch', s: 'working' }];
    assert.deepEqual(ids(M.attentionBots(bots, bot => bot.s)), ['n', 'b', 'z']);
    assert.deepEqual(M.attentionBots(null, () => 'idle'), []);
  });

  check('the module is pure: no imports, no page objects, no em dash', () => {
    const source = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /^import /m);
    assert.doesNotMatch(source, /\b(document|window|localStorage|fetch|navigator)\b/);
    assert.ok(!source.includes('—'));
  });

  console.log(`PASS: ${passed.length} Bots sidebar model checks.`);
})().catch(error => { console.error(error); process.exit(1); });
