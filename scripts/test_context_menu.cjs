// The main window's right-click text menu (electron/contextMenu.js). No Electron.
// Run: node scripts/test_context_menu.cjs
const assert = require('node:assert/strict');
const { menuTemplate } = require('../electron/contextMenu.js');

const calls = [];
const actions = {
  replace: text => calls.push(['replace', text]),
  addWord: word => calls.push(['addWord', word]),
  copyText: text => calls.push(['copy', text]),
};
const labels = items => items.map(item => item.type === 'separator' ? '-' : item.label);
const flags = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

// A misspelled word in the composer: fixes first, then editing.
let items = menuTemplate({ isEditable: true, misspelledWord: 'speling', dictionarySuggestions: ['spelling', 'spieling', 'a', 'b', 'c', 'd'], editFlags: flags }, actions);
assert.deepEqual(labels(items), ['spelling', 'spieling', 'a', 'b', 'c', 'Add to dictionary', '-',
  'Undo', 'Redo', '-', 'Cut', 'Copy', 'Paste', 'Paste as plain text', '-', 'Select all']);
items[0].click();
items.find(item => item.label === 'Add to dictionary').click();
assert.deepEqual(calls, [['replace', 'spelling'], ['addWord', 'speling']]);
assert.equal(items.find(item => item.label === 'Undo').enabled, false);
assert.equal(items.find(item => item.label === 'Cut').enabled, true);

// A misspelled word with no suggestions says so.
items = menuTemplate({ isEditable: true, misspelledWord: 'qzxv', dictionarySuggestions: [], editFlags: flags }, actions);
assert.equal(items[0].label, 'No spelling suggestions');
assert.equal(items[0].enabled, false);

// An empty text box: editing only, Cut and Copy greyed out with nothing selected.
items = menuTemplate({ isEditable: true, misspelledWord: '', editFlags: { canPaste: true, canSelectAll: true } }, actions);
assert.equal(labels(items)[0], 'Undo');
assert.equal(items.find(item => item.label === 'Cut').enabled, false);
assert.equal(items.find(item => item.label === 'Copy').enabled, false);
assert.equal(items.find(item => item.label === 'Paste').enabled, true);

// Selected text in a reply: Copy only.
items = menuTemplate({ isEditable: false, selectionText: 'Some reply text', editFlags: {} }, actions);
assert.deepEqual(labels(items), ['Copy']);
assert.equal(items[0].role, 'copy');

// A link in a reply, with and without a selection.
calls.length = 0;
items = menuTemplate({ isEditable: false, selectionText: '', linkURL: 'https://example.com/a', editFlags: {} }, actions);
assert.deepEqual(labels(items), ['Copy link']);
items[0].click();
assert.deepEqual(calls, [['copy', 'https://example.com/a']]);
items = menuTemplate({ isEditable: false, selectionText: 'example', linkURL: 'https://example.com/a', editFlags: {} }, actions);
assert.deepEqual(labels(items), ['Copy', '-', 'Copy link']);

// Plain page with nothing selected, or a non-web link: no menu at all.
assert.deepEqual(menuTemplate({ isEditable: false, selectionText: '  ', editFlags: {} }, actions), []);
assert.deepEqual(menuTemplate({ isEditable: false, linkURL: 'javascript:alert(1)', editFlags: {} }, actions), []);

console.log('context menu: ok');
