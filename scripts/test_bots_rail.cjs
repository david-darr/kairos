// The Bots rail's rules (Agents 3.0 Phase 0, unit U3): plain-Node checks of the
// functions in static/js/botsRail.js that need no DOM. Run: node scripts/test_bots_rail.cjs
//   - the order of bots: the person's own order, then name; no order sorts last
//   - archived (hidden) bots are left out of the rail and counted for "Archived (N)"
//   - a row's status comes from botStatus.js, so its precedence is that file's
//     (needs you, working, waiting, queued, idle; off wins for a bot that is off)
// The rail itself (rows, active mark, Archived row, Simple/Advanced) is drawn and
// clicked in scripts/bots-shell-checks.cjs; the Phase 1 tree, menus, search and resize
// are drawn and used in scripts/bots-navigation-checks.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const passed = [];
const pending = [];
const check = (name, fn) => { const result = fn(); if (result && typeof result.then === 'function') pending.push([name, result]); else passed.push(name); };
const bot = (id, name, extra = {}) => ({ id, name, enabled: true, status: 'idle', needs_you: 0, ...extra });

(async () => {
  const R = await load('js/botsRail.js');
  const S = await load('js/botStatus.js');

  check('the sidebar polls one slim route and asks only for the lists that changed (100-bot scale test)', () => {
    assert.equal(R.pulsePath({}), '/api/bot-pulse', 'nothing held: every list comes back');
    assert.equal(R.pulsePath({ agents: 'a1', team: 't 1', automations: '', junk: 'x' }), '/api/bot-pulse?agents=a1&team=t%201');
    const held = { agents: 'a1', conversations: 'c1', team: 't1', automations: 'm1' };
    // agents changed (its body came back), team unchanged, conversations unreadable, automations new.
    const reply = { versions: { agents: 'a2', conversations: null, team: 't1', automations: 'm2' }, agents: [], automations: { automations: [] } };
    assert.deepEqual(R.heldAfter(held, reply), { agents: 'a2', team: 't1', automations: 'm2' });
    // A version that moved without its body (a lost reply) is not taken: the next poll asks again.
    assert.deepEqual(R.heldAfter({ team: 't1' }, { versions: { team: 't2' } }), {});
    assert.equal(R.pulsePath({ agents: 'a1' }, ['agents', 'nope']), '/api/bot-pulse?agents=a1&only=agents');
  });

  check('the Bots home grid reads the bot list only when it changed, and the whole list without the pulse', async () => {
    const calls = [];
    let version = 'v1';
    const request = async path => {
      calls.push(path);
      if (path.startsWith('/api/bot-pulse')) return path.includes(`agents=${version}`) ? { versions: { agents: version } } : { versions: { agents: version }, agents: [{ id: version }] };
      return [{ id: 'whole' }];
    };
    const read = R.changedAgentsReader(request);
    assert.deepEqual(await read(), [{ id: 'v1' }], 'the first read brings the list');
    assert.equal(await read(), null, 'unchanged: nothing comes back');
    version = 'v2';
    assert.deepEqual(await read(), [{ id: 'v2' }], 'changed: the new list');
    assert.deepEqual(await read(true), [{ id: 'v2' }], 'forced: the list again');
    assert.deepEqual(calls, ['/api/bot-pulse?only=agents', '/api/bot-pulse?agents=v1&only=agents', '/api/bot-pulse?agents=v1&only=agents', '/api/bot-pulse?only=agents']);
    const old = R.changedAgentsReader(async path => { if (path.startsWith('/api/bot-pulse')) throw new Error('404'); return [{ id: 'whole' }]; });
    assert.deepEqual(await old(), [{ id: 'whole' }]);
  });

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

  // -- Phase 1 (unit U4): conversation rows and the menus behind them ---------------------
  const T = await load('js/botsThreadMenu.js');
  const thread = (id, extra = {}, state = {}) => ({ id, title: `Thread ${id}`, updated_at: 5, thread: { main: false, folder_id: null, pinned: false, unread: false, snoozed_until: null, ...state }, ...extra });
  const labels = items => items.filter(item => item.label).map(item => item.label);
  const find = (items, label) => items.find(item => item.label === label);

  check('a conversation row says what is going on, with a spoken label', () => {
    assert.equal(R.threadRowFacts(thread('a', { needs_you: true })).state, 'needs_you');
    assert.equal(R.threadRowFacts(thread('a', { status: 'working' })).state, 'working');
    assert.equal(R.threadRowFacts(thread('a', { queue_count: 2 })).state, 'queued');
    assert.equal(R.threadRowFacts(thread('a')).state, 'idle');
    assert.equal(R.threadRowFacts(thread('a', { title: '   ' })).title, 'New conversation', 'a blank title is never shown blank');
    const full = R.threadRowFacts(thread('a', { status: 'working' }, { unread: true, pinned: true, main: true }));
    assert.equal(full.label, 'Thread a, working, unread, pinned');
    assert.deepEqual([full.unread, full.pinned, full.main], [true, true, true]);
    assert.equal(R.threadRowFacts(thread('a')).label, 'Thread a');
    assert.equal(R.threadRowFacts(thread('a'), 'a').rank, 5, 'the open one ranks as current');
  });

  check('the conversation menu offers every verb, with the right wording for the state', () => {
    const folders = [{ id: 'f1', name: 'Work', emoji: '' }, { id: 'f2', name: 'Home', emoji: '*' }];
    const items = T.threadMenuItems({ row: thread('a'), folders });
    assert.deepEqual(labels(items), ['Open', 'Rename', 'Pin', 'Mark as unread', 'No folder', 'Work', '* Home', 'New folder...', 'Until something new', 'Tonight', 'Tomorrow morning',
      'Copy link', 'Select', 'Make main conversation', 'Archive', 'Delete']);
    const state = T.threadMenuItems({ row: thread('a', {}, { pinned: true, unread: true, snoozed_until: 0, folder_id: 'f2' }), folders });
    assert.ok(find(state, 'Unpin') && find(state, 'Mark as read') && find(state, 'Stop snoozing'));
    assert.equal(find(state, 'No folder').checked, false);
    assert.equal(find(state, '* Home').checked, true, 'the current folder is marked');
    assert.ok(!find(T.threadMenuItems({ row: thread('a'), folders }), 'Stop snoozing'), 'nothing to stop when not snoozed');
  });

  check('the main conversation cannot be archived or deleted from the menu', () => {
    const items = T.threadMenuItems({ row: thread('m', {}, { main: true }), main: true });
    assert.ok(!find(items, 'Archive') && !find(items, 'Make main conversation'));
    assert.equal(find(items, 'Delete').disabled, true);
    assert.ok(items.some(item => item.note && /main conversation/.test(item.note)), 'it says why');
  });

  check('menu choices call the matching handler with the row and the chosen value', () => {
    const seen = [];
    const handlers = Object.fromEntries(['open', 'rename', 'pin', 'unread', 'moveToNewFolder', 'copyLink', 'select', 'makeMain', 'archive', 'remove'].map(name => [name, row => seen.push([name, row.id])]));
    handlers.move = (row, folder) => seen.push(['move', row.id, folder]);
    handlers.snooze = (row, kind) => seen.push(['snooze', row.id, kind]);
    const items = T.threadMenuItems({ row: thread('a'), folders: [{ id: 'f1', name: 'Work' }], handlers });
    for (const label of ['Open', 'Rename', 'Pin', 'Mark as unread', 'No folder', 'Work', 'New folder...', 'Until something new', 'Tonight', 'Tomorrow morning', 'Copy link', 'Select', 'Make main conversation', 'Archive', 'Delete']) {
      find(items, label).onSelect();
    }
    assert.deepEqual(seen, [['open', 'a'], ['rename', 'a'], ['pin', 'a'], ['unread', 'a'], ['move', 'a', null], ['move', 'a', 'f1'], ['moveToNewFolder', 'a'],
      ['snooze', 'a', 'activity'], ['snooze', 'a', 'tonight'], ['snooze', 'a', 'tomorrow'], ['copyLink', 'a'], ['select', 'a'], ['makeMain', 'a'], ['archive', 'a'], ['remove', 'a']]);
    assert.doesNotThrow(() => T.threadMenuItems({ row: thread('a') }).forEach(item => item.onSelect?.()), 'a menu with no handlers does nothing, safely');
  });

  check('the folder menu can only move where there is room, and says what delete does', () => {
    const folder = { id: 'f1', name: 'Work' };
    assert.equal(find(T.folderMenuItems({ folder, index: 0, count: 3 }), 'Move up').disabled, true);
    assert.equal(find(T.folderMenuItems({ folder, index: 0, count: 3 }), 'Move down').disabled, false);
    assert.equal(find(T.folderMenuItems({ folder, index: 2, count: 3 }), 'Move down').disabled, true);
    assert.equal(find(T.folderMenuItems({ folder, index: 0, count: 1 }), 'Move up').disabled && find(T.folderMenuItems({ folder, index: 0, count: 1 }), 'Move down').disabled, true);
    assert.ok(T.folderMenuItems({ folder }).some(item => /stay/.test(item.note || '')), 'deleting a folder keeps its conversations');
    const seen = [];
    find(T.folderMenuItems({ folder, index: 1, count: 3, handlers: { move: (f, o) => seen.push([f.id, o]), remove: f => seen.push(['rm', f.id]), rename: f => seen.push(['rn', f.id]) } }), 'Move up').onSelect();
    find(T.folderMenuItems({ folder, index: 1, count: 3, handlers: { move: (f, o) => seen.push([f.id, o]) } }), 'Move down').onSelect();
    assert.deepEqual(seen, [['f1', -1], ['f1', 1]]);
  });

  check('folder order after a move', () => {
    const folders = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(T.movedFolderIds(folders, 'b', -1), ['b', 'a', 'c']);
    assert.deepEqual(T.movedFolderIds(folders, 'b', 1), ['a', 'c', 'b']);
    assert.deepEqual(T.movedFolderIds(folders, 'a', -1), ['a', 'b', 'c'], 'cannot leave the list');
    assert.deepEqual(T.movedFolderIds(folders, 'zzz', 1), ['a', 'b', 'c']);
    assert.deepEqual(T.movedFolderIds(null, 'a', 1), []);
  });

  check('the bot menu pins, opens, starts a conversation or folder, and opens settings', () => {
    const bot = { id: 'a1', name: 'Scout' };
    assert.deepEqual(labels(T.botMenuItems({ bot })), ['Open', 'Pin', 'New conversation', 'New folder', 'Settings']);
    assert.ok(find(T.botMenuItems({ bot, pinned: true }), 'Unpin'));
    const seen = [];
    for (const item of T.botMenuItems({ bot, handlers: { open: b => seen.push(['o', b.id]), pin: b => seen.push(['p', b.id]), newThread: b => seen.push(['t', b.id]), newFolder: b => seen.push(['f', b.id]), settings: b => seen.push(['s', b.id]) } })) item.onSelect?.();
    assert.deepEqual(seen.map(s => s[0]), ['o', 'p', 't', 'f', 's']);
  });

  check('every call goes to the existing thread, folder and pin routes, with an encoded id and the right body', async () => {
    const sent = [];
    const api = T.botsThreadApi(async (path, init = {}) => { sent.push([init.method || 'GET', path, init.body ? JSON.parse(init.body) : undefined]); return {}; });
    const row = thread('t 1', {}, { pinned: true, unread: false });
    await api.list('a/1'); await api.list('a1', { archived: true }); await api.create('a1', { title: 'Plan', folderId: 'f1' }); await api.create('a1');
    await api.rename('a1', 't1', 'New name'); await api.pin('a1', row); await api.unread('a1', row); await api.move('a1', 't1', 'f1'); await api.move('a1', 't1', '');
    await api.snooze('a1', 't1', 'tomorrow'); await api.archive('a1', 't1'); await api.archive('a1', 't1', false); await api.makeMain('a1', 't1'); await api.remove('a1', ['t1', 't2']); await api.remove('a1', 't3');
    await api.addFolder('a1', 'Work', '*'); await api.addFolder('a1', 'Home'); await api.renameFolder('a1', 'f1', 'Jobs'); await api.removeFolder('a1', 'f1'); await api.orderFolders('a1', ['f2', 'f1']);
    await api.pinBot('a1', true); await api.pinBot('a1', false);
    assert.deepEqual(sent, [
      ['GET', '/api/agents/a%2F1/threads', undefined], ['GET', '/api/agents/a1/threads?include_archived=1', undefined],
      ['POST', '/api/agents/a1/threads', { title: 'Plan', folder_id: 'f1' }], ['POST', '/api/agents/a1/threads', {}],
      ['PATCH', '/api/agents/a1/threads/t1', { title: 'New name' }], ['PATCH', '/api/agents/a1/threads/t%201', { pinned: false }], ['PATCH', '/api/agents/a1/threads/t%201', { unread: true }],
      ['PATCH', '/api/agents/a1/threads/t1', { folder_id: 'f1' }], ['PATCH', '/api/agents/a1/threads/t1', { folder_id: null }],
      ['PATCH', '/api/agents/a1/threads/t1', { snooze: 'tomorrow' }], ['PATCH', '/api/agents/a1/threads/t1', { archived: true }], ['PATCH', '/api/agents/a1/threads/t1', { archived: false }],
      ['PATCH', '/api/agents/a1/threads/t1', { main: true }], ['POST', '/api/agents/a1/threads/delete', { thread_ids: ['t1', 't2'] }], ['POST', '/api/agents/a1/threads/delete', { thread_ids: ['t3'] }],
      ['POST', '/api/agents/a1/folders', { name: 'Work', emoji: '*' }], ['POST', '/api/agents/a1/folders', { name: 'Home' }], ['PATCH', '/api/agents/a1/folders/f1', { name: 'Jobs' }],
      ['DELETE', '/api/agents/a1/folders/f1', undefined], ['PUT', '/api/agents/a1/folders/order', { ids: ['f2', 'f1'] }],
      ['POST', '/api/agents/conversations/agent/a1', { action: 'pin' }], ['POST', '/api/agents/conversations/agent/a1', { action: 'unpin' }]]);
    // A refused call is the caller's to report: the error comes through unchanged.
    const refusing = T.botsThreadApi(async () => { throw new Error('this is the main conversation'); });
    await assert.rejects(() => refusing.archive('a1', 'm'), /main conversation/);
  });

  check('a copied link names the bot and conversation and refuses a bad id', () => {
    assert.equal(T.copyableLink('https://kairos.example', 'a1', 's2'), 'https://kairos.example/?agent=a1&chat=s2');
    assert.throws(() => T.copyableLink('https://kairos.example', '../a', 's2'));
  });

  check('menu and rail copy has no em dash', () => {
    const copy = JSON.stringify([T.SNOOZE_CHOICES, T.threadMenuItems({ row: thread('a') }), T.folderMenuItems({ folder: { id: 'f', name: 'x' } }), T.botMenuItems({ bot: { id: 'a' } })]);
    assert.ok(!copy.includes('—'));
  });

  // Checks above that return a promise are awaited here, so a failure is never silent.
  for (const [name, result] of pending) await result.then(() => passed.push(name), error => { throw Object.assign(error, { message: `${name}: ${error.message}` }); });

  console.log(`PASS: ${passed.length} Bots rail checks.`);
})().catch(error => { console.error(error); process.exit(1); });
