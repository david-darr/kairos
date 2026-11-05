// Real Electron check for the right-click text menu: a real right-click on a
// misspelled word typed into a textarea (and picking a fix), on a selected paragraph, and on a row whose own
// contextmenu handler calls preventDefault. Needs no backend.
// Run: electron/node_modules/.bin/electron scripts/context-menu-checks.cjs
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const textMenu = require('../electron/contextMenu.js');

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:20px sans-serif">
<textarea id="t" spellcheck="true" style="position:absolute;left:10px;top:10px;width:400px;height:60px"></textarea>
<p id="p" style="position:absolute;left:10px;top:120px;margin:0">Written reply text</p>
<div id="row" style="position:absolute;left:10px;top:200px;width:200px;height:40px;background:#ccc">row</div>
<script>document.getElementById('row').addEventListener('contextmenu', e => { e.preventDefault(); window.rowMenu = true; });</script>`;

// Own profile folder, as the other checks do: the default one may be held by another Electron.
app.setPath('userData', require('node:path').join(require('node:os').tmpdir(), 'kairos-context-menu-check'));
const shown = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const labels = template => template.map(item => item.type === 'separator' ? '-' : item.label);

async function rightClick(win, x, y) {
  const before = shown.length;
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
  for (let i = 0; i < 40 && shown.length === before; i++) await wait(50);
  return shown.length > before ? shown[shown.length - 1] : null;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 600, height: 400, x: -3000, y: 0, show: true, skipTaskbar: true, webPreferences: { contextIsolation: true } });
  textMenu.attach(win, { show: template => shown.push(template) });
  const file = require('node:path').join(require('node:os').tmpdir(), 'kairos-context-menu-check.html');
  require('node:fs').writeFileSync(file, PAGE);
  await win.loadFile(file);
  // Focus the textarea, then type a sentence with misspelled words.
  await win.webContents.executeJavaScript("const t=document.getElementById('t'); t.focus(); true");
  // Typed, as a person would: Chromium checks words as they are entered.
  await win.webContents.insertText('Ths is speling ');
  let menu = null;
  for (let i = 0; i < 20 && !(menu && menu[0].label !== 'Undo'); i++) { await wait(250); menu = await rightClick(win, 25, 25); }
  assert.ok(menu, 'a menu opens in the textarea');
  const names = labels(menu);
  console.log('textarea menu:', names.join(' | '));
  assert.ok(names.includes('Paste') && names.includes('Select all'), 'editing commands in a text box');
  assert.ok(names.includes('Add to dictionary'), 'the misspelled word gets spelling items');
  assert.equal(menu[0].label, 'This', 'the first fix for "Ths" is "This"');
  menu[0].click();
  await wait(200);
  assert.match(await win.webContents.executeJavaScript("document.getElementById('t').value"), /^This is /, 'picking a fix replaces the word');

  await win.webContents.executeJavaScript("getSelection().selectAllChildren(document.getElementById('p')); true");
  menu = await rightClick(win, 40, 130);
  console.log('reply menu:', menu && labels(menu).join(' | '));
  assert.deepEqual(labels(menu), ['Copy'], 'selected written text offers Copy');

  menu = await rightClick(win, 50, 220);
  assert.equal(menu, null, 'a row with its own menu gets no text menu');
  assert.equal(await win.webContents.executeJavaScript('window.rowMenu === true'), true, 'the row still opens its own menu');

  console.log('context menu checks: ok');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
