// A bot conversation's /state read (static/js/botsChat.js readState), evaluated as plain text like
// test_notch_shell.cjs does. Run: node scripts/test_bots_chat_state.cjs
// 2026-11-03: the server keeps a session's newest turn for minutes after it ends, and a finished
// turn was read as running, so reopening Kip's chat showed "Thinking" for a reply already saved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../static/js/botsChat.js'), 'utf8').replace(/\r\n/g, '\n');
const part = source.slice(source.indexOf('const asQueue = raw =>'), source.indexOf('\n}\n', source.indexOf('function readState(')) + 3);
const context = {}; vm.createContext(context); vm.runInContext(part + '\nthis.readState = readState;', context);
const turn = status => context.readState({ turn: { id: 't1', turn_id: 't1', status } }).turnId;
assert.equal(turn('processing'), 't1', 'a turn still processing is running');
for (const status of ['done', 'failed', 'stopped']) assert.equal(turn(status), null, `a ${status} turn is not running`);
assert.equal(context.readState({ turn: { id: 't2' } }).turnId, 't2', 'a turn without a status (older servers, fixtures) still counts');
assert.equal(context.readState({ turn: null }).turnId, null);
assert.equal(context.readState({ running_turn_id: 't3' }).turnId, 't3');
console.log('PASS: only a processing turn reads as running, so a finished reply never shows "Thinking"');
