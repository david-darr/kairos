// Tests for electron/browser-store.js (vault: "Kairos Browser - Phase 1").
// Runs under Electron's own Node, so node:sqlite is the one Kairos ships:
//   ELECTRON_RUN_AS_NODE=1 electron/node_modules/electron/dist/electron.exe scripts/browse-store-tests.cjs
// Plain Node 22.13+ works as well.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../electron/browser-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-browse-store-'));
const file = path.join(dir, 'browser.db');
let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${e.stack}`); }
}

let store = openStore(file);

test('history keeps web visits only', () => {
  assert.equal(store.addVisit('https://example.com/a', 'A page', 1000), true);
  assert.equal(store.addVisit('https://example.com/b', 'B page', 2000), true);
  for (const bad of ['data:text/html,x', 'file:///C:/x', 'javascript:1', 'about:blank', 'chrome://settings', 'not a url'])
    assert.equal(store.addVisit(bad, 'x'), false, bad);
  const recent = store.recentHistory(10);
  assert.deepEqual(recent.map(r => r.url), ['https://example.com/b', 'https://example.com/a']);
});

test('history search matches url and title, escapes wildcards', () => {
  store.addVisit('https://shop.test/100%_off', 'Sale', 3000);
  assert.equal(store.searchHistory('B page').length, 1);
  assert.equal(store.searchHistory('example.com').length, 2);
  assert.equal(store.searchHistory('100%_').length, 1, '% and _ are literal');
  assert.equal(store.searchHistory('%').length, 1);
});

test('title updates land on the latest visit', () => {
  store.setTitle('https://example.com/a', 'A renamed');
  assert.equal(store.recentHistory(10).find(r => r.url === 'https://example.com/a').title, 'A renamed');
});

test('delete one and delete a range', () => {
  const id = store.recentHistory(10).find(r => r.url.startsWith('https://shop.test/')).id;
  assert.equal(store.deleteHistory(id), 1);
  assert.equal(store.deleteHistoryRange(0, 1500), 1);
  assert.deepEqual(store.recentHistory(10).map(r => r.url), ['https://example.com/b']);
});

test('pinned sites: add, dedupe, order, remove', () => {
  assert.equal(store.pin('https://github.com/', 'GitHub'), true);
  assert.equal(store.pin('https://mail.example.com/', 'Mail'), true);
  assert.equal(store.pin('https://github.com/', 'GitHub again'), true);
  assert.equal(store.pin('file:///etc/passwd', 'x'), false);
  let pins = store.pinned();
  assert.deepEqual(pins.map(p => p.title), ['GitHub again', 'Mail']);
  store.reorderPinned([pins[1].id, pins[0].id]);
  pins = store.pinned();
  assert.deepEqual(pins.map(p => p.title), ['Mail', 'GitHub again']);
  assert.equal(store.unpin(pins[0].id), 1);
  assert.equal(store.pinned().length, 1);
});

test('speed dial: edit a tile, pictures follow the address, top sites skip pinned ones', () => {
  // Its own file, so the shared store the other tests use is untouched.
  const store = openStore(path.join(dir, 'speed-dial.db'));
  store.pin('https://github.com/', 'GitHub');
  const [tile] = store.pinned();
  assert.equal(store.setThumb(tile.id, 'data:image/jpeg;base64,AAAA'), 1);
  assert.equal(store.editPin(tile.id, tile.url, 'Renamed'), true);
  assert.equal(store.pinned()[0].thumb, 'data:image/jpeg;base64,AAAA', 'same address keeps the picture');
  assert.equal(store.editPin(tile.id, 'https://mail.example.com/inbox', 'Mail'), true);
  assert.equal(store.pinned()[0].thumb, null, 'a new address drops the old picture');
  assert.equal(store.editPin(tile.id, 'javascript:alert(1)', 'x'), false);
  assert.equal(store.pinnedFor('https://mail.example.com/other').id, tile.id, 'matched by origin');
  assert.equal(store.pinnedFor('https://other.example.com/'), null);
  store.addVisit('https://news.test/a', 'News', 10); store.addVisit('https://news.test/b', 'News', 11);
  store.addVisit('https://mail.example.com/x', 'Mail', 12);
  const top = store.topSites();
  assert.equal(top[0].url, 'https://news.test/', 'most visited first, one per origin');
  assert.ok(!top.some(t => t.url === 'https://mail.example.com/'), 'pinned sites are not suggested');
  store.close();
});

test('suggestions put pinned sites first, then most visited', () => {
  store.addVisit('https://github.com/pulls', 'Pull requests', 4000);
  store.addVisit('https://github.com/pulls', 'Pull requests', 5000);
  store.addVisit('https://github.com/issues', 'Issues', 6000);
  const s = store.suggest('git');
  assert.equal(s[0].kind, 'pinned');
  assert.equal(s[1].url, 'https://github.com/pulls', 'two visits outrank one');
  assert.deepEqual(store.suggest(''), []);
});

test('site settings are per origin', () => {
  assert.equal(store.setSite('https://github.com/some/page', 'zoom', 1.25), true);
  store.setSite('https://github.com/', 'permission:notifications', 'allow');
  assert.equal(store.getSite('https://github.com/other', 'zoom'), '1.25');
  assert.equal(store.getSite('http://github.com/', 'zoom'), null, 'http is another origin');
  assert.deepEqual(store.siteSettings('https://github.com'), { 'permission:notifications': 'allow', zoom: '1.25' });
  store.setSite('https://github.com/', 'zoom', null);
  assert.equal(store.getSite('https://github.com/', 'zoom'), null);
  assert.equal(store.clearSite('https://github.com/'), 1);
  assert.equal(store.setSite('not a url', 'zoom', 2), false);
});

test('downloads list upserts by id', () => {
  store.putDownload({ id: 'd1', url: 'https://example.com/f.zip', filename: 'f.zip', path: 'C:/x/f.zip', state: 'progressing', received: 10, total: 100, startedAt: 1 });
  store.putDownload({ id: 'd1', url: 'https://example.com/f.zip', filename: 'f.zip', path: 'C:/x/f.zip', state: 'completed', received: 100, total: 100, startedAt: 1, endedAt: 2 });
  const list = store.downloads();
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'completed');
  assert.equal(store.removeDownload('d1'), 1);
});

test('session restore survives reopening the file', () => {
  store.saveSession([{ url: 'https://example.com/', title: 'Example', pinned: false }, { url: 'https://github.com/', title: 'GitHub', pinned: true }]);
  store.setMeta('cookies-resaved', 'yes');
  store.close();
  store = openStore(file);
  assert.equal(store.loadSession().length, 2);
  assert.equal(store.loadSession()[1].pinned, true);
  assert.equal(store.getMeta('cookies-resaved'), 'yes');
  assert.equal(store.recentHistory(10).length, 4, 'history persisted (b, pulls twice, issues)');
});

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `FAIL: ${failures} browse-store test(s) failed` : 'PASS: browse-store');
process.exit(failures ? 1 : 0);
