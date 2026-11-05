// The right-click menu for text in the main window (2026-11-05): spelling fixes,
// editing commands in text boxes, Copy on written text, Copy link on links.
// Rows that set up their own menu (chats, bots, files) call preventDefault on
// the page's contextmenu event, so Electron never raises this for them.
// `menuTemplate` is pure so it can be tested without Electron.

const MAX_SUGGESTIONS = 5;

function menuTemplate(params, actions) {
  const items = [];
  const flags = params.editFlags || {};
  const word = params.misspelledWord;
  if (params.isEditable && word) {
    const fixes = (params.dictionarySuggestions || []).slice(0, MAX_SUGGESTIONS);
    if (fixes.length) {
      for (const fix of fixes) items.push({ label: fix, click: () => actions.replace(fix) });
    } else {
      items.push({ label: 'No spelling suggestions', enabled: false });
    }
    items.push({ label: 'Add to dictionary', click: () => actions.addWord(word) });
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push(
      { role: 'undo', label: 'Undo', enabled: !!flags.canUndo },
      { role: 'redo', label: 'Redo', enabled: !!flags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: 'Cut', enabled: !!flags.canCut },
      { role: 'copy', label: 'Copy', enabled: !!flags.canCopy },
      { role: 'paste', label: 'Paste', enabled: !!flags.canPaste },
      { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: !!flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: 'Select all', enabled: flags.canSelectAll !== false },
    );
  } else if (String(params.selectionText || '').trim()) {
    items.push({ role: 'copy', label: 'Copy' });
  }
  if (/^(https?|mailto):/i.test(params.linkURL || '')) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Copy link', click: () => actions.copyText(params.linkURL) });
  }
  return items;
}

// `show` is for checks only; the app always pops up a real menu.
function attach(win, { show } = {}) {
  const { Menu, clipboard } = require('electron');
  const contents = win.webContents;
  contents.on('context-menu', (_event, params) => {
    const template = menuTemplate(params, {
      replace: text => contents.replaceMisspelling(text),
      addWord: word => contents.session.addWordToSpellCheckerDictionary(word),
      copyText: text => clipboard.writeText(text),
    });
    if (!template.length) return;
    if (show) show(template);
    else Menu.buildFromTemplate(template).popup({ window: win });
  });
}

module.exports = { attach, menuTemplate };
