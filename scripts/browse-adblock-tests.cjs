// Tests for electron/browser-adblock.js, Kairos's own blocker (vault:
// "Kairos Browser - Phase 1"). Hermetic: a fixture list here, plus a
// synthetic list the size of EasyList for the speed check. Plain Node.
const assert = require('node:assert/strict');
const { createAdblock, _siteOf } = require('../electron/browser-adblock.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${e.stack}`); }
}

const LIST = `
[Adblock Plus 2.0]
! comment line
||ads.example.com^
||tracker.test^$third-party
/banner/*$image
|https://exact.test/start
end-anchor.js|
@@||ads.example.com/allowed/*
||cdn.test/lib.js$script,domain=news.test|~safe.news.test
||strict.test^$important
@@||strict.test^
||nosub.test^$~third-party
*$websocket,domain=chat.test
##.ad-banner
###sponsor-box
news.test##.news-ad
~safe.news.test,news.test##.stub
news.test#@#.ad-banner
example.com##+js(nobab)
example.com#?#.x:-abp-has(.y)
site.test##.promo:has-text(Sponsored)
||redirect.test^$redirect=noop.js
/regex[0-9]+/
||ok.test^$match-case
`;

const ab = createAdblock();
const stats = ab.load([LIST]);
const page = 'https://news.test/article';

test('host-anchored rules block the host and its subdomains', () => {
  assert.equal(ab.match('https://ads.example.com/x.js', { type: 'script', sourceUrl: page }).block, true);
  assert.equal(ab.match('https://a.b.ads.example.com/x.gif', { type: 'image', sourceUrl: page }).block, true);
  assert.equal(ab.match('https://notads.example.com/x.js', { type: 'script', sourceUrl: page }).block, false, 'not a suffix match');
  assert.equal(ab.match('https://example.com/ads.example.com', { type: 'script', sourceUrl: page }).block, false, 'host must be the host');
});

test('exceptions win unless the block is important', () => {
  assert.equal(ab.match('https://ads.example.com/allowed/one.js', { type: 'script', sourceUrl: page }).block, false);
  assert.equal(ab.match('https://strict.test/a.js', { type: 'script', sourceUrl: page }).block, true, '$important beats @@');
});

test('third-party and first-party options', () => {
  assert.equal(ab.match('https://tracker.test/p.gif', { type: 'image', sourceUrl: page }).block, true);
  assert.equal(ab.match('https://tracker.test/p.gif', { type: 'image', sourceUrl: 'https://www.tracker.test/' }).block, false, 'same site is first party');
  assert.equal(ab.match('https://nosub.test/x', { type: 'xhr', sourceUrl: 'https://nosub.test/' }).block, true);
  assert.equal(ab.match('https://nosub.test/x', { type: 'xhr', sourceUrl: page }).block, false);
});

test('type and domain options', () => {
  assert.equal(ab.match('https://img.test/banner/1.png', { type: 'image', sourceUrl: page }).block, true);
  assert.equal(ab.match('https://img.test/banner/1.js', { type: 'script', sourceUrl: page }).block, false, '$image only');
  assert.equal(ab.match('https://cdn.test/lib.js', { type: 'script', sourceUrl: page }).block, true);
  assert.equal(ab.match('https://cdn.test/lib.js', { type: 'script', sourceUrl: 'https://safe.news.test/' }).block, false, '~domain excluded');
  assert.equal(ab.match('https://cdn.test/lib.js', { type: 'script', sourceUrl: 'https://other.test/' }).block, false, 'domain= limits it');
  assert.equal(ab.match('wss://socket.any/x', { type: 'webSocket', sourceUrl: 'https://chat.test/' }).block, true);
  assert.equal(ab.match('wss://socket.any/x', { type: 'webSocket', sourceUrl: page }).block, false);
});

test('start and end anchors', () => {
  assert.equal(ab.match('https://exact.test/start/more', { type: 'script', sourceUrl: page }).block, true);
  assert.equal(ab.match('https://x.test/?u=https://exact.test/start', { type: 'script', sourceUrl: page }).block, false);
  assert.equal(ab.match('https://x.test/end-anchor.js', { type: 'script', sourceUrl: page }).block, true);
  assert.equal(ab.match('https://x.test/end-anchor.js?v=1', { type: 'script', sourceUrl: page }).block, false);
});

test('pages themselves are never blocked', () => {
  assert.equal(ab.match('https://ads.example.com/', { type: 'mainFrame', sourceUrl: '' }).block, false);
});

test('unsupported rules are skipped and counted, not applied', () => {
  assert.equal(ab.match('https://redirect.test/a.js', { type: 'script', sourceUrl: page }).block, false);
  assert.equal(ab.match('https://x.test/regex123', { type: 'script', sourceUrl: page }).block, false);
  assert.equal(stats.skipped, 5);
  assert.deepEqual(Object.keys(stats.skippedBy).sort(), ['extended css', 'procedural', 'redirect', 'regex', 'scriptlet']);
  assert.equal(ab.match('https://ok.test/x', { type: 'script', sourceUrl: page }).block, true, '$match-case is ignored, rule kept');
});

test('element hiding: generic, per site, exceptions', () => {
  const css = ab.cosmeticCss('news.test');
  assert.ok(css.includes('#sponsor-box'));
  assert.ok(css.includes('.news-ad'));
  assert.ok(css.includes('.stub'));
  assert.ok(!css.includes('.ad-banner'), '#@# removes it on news.test');
  assert.ok(css.includes('display: none !important'));
  const other = ab.cosmeticCss('other.test');
  assert.ok(other.includes('.ad-banner'));
  assert.ok(!other.includes('.news-ad'));
  assert.ok(!ab.cosmeticCss('safe.news.test').includes('.stub'), '~domain on element hiding');
  assert.ok(!css.includes('has-text') && !css.includes('nobab'));
});

test('third-party sites group two-label suffixes', () => {
  assert.equal(_siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(_siteOf('a.b.example.com'), 'example.com');
});

test('speed on an EasyList-sized list', () => {
  const lines = [];
  for (let i = 0; i < 40000; i++) lines.push(`||ad${i}.host${i % 977}.test^`);
  for (let i = 0; i < 20000; i++) lines.push(`/path${i}/segment*$script`);
  for (let i = 0; i < 15000; i++) lines.push(`##.ad-slot-${i}`);
  const big = createAdblock();
  const t0 = process.hrtime.bigint();
  big.load([lines.join('\n')]);
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const urls = [];
  for (let i = 0; i < 5000; i++) urls.push(`https://cdn${i}.site.test/assets/app${i}.js?v=${i}`, `https://ad${i}.host${i % 977}.test/x.gif`);
  const t1 = process.hrtime.bigint();
  let blocked = 0;
  for (const url of urls) if (big.match(url, { type: 'script', sourceUrl: 'https://site.test/' }).block) blocked++;
  const perMs = Number(process.hrtime.bigint() - t1) / 1e6 / urls.length;
  console.log(`  load ${loadMs.toFixed(0)} ms for 75,000 rules; ${(perMs * 1000).toFixed(1)} µs per request; ${blocked} blocked`);
  assert.equal(blocked, 5000);
  assert.ok(perMs < 1, `a request check must stay under 1 ms, was ${perMs} ms`);
  assert.ok(loadMs < 5000, `loading must stay under 5 s, was ${loadMs} ms`);
});

console.log(failures ? `FAIL: ${failures} browse-adblock test(s) failed` : 'PASS: browse-adblock');
process.exit(failures ? 1 : 0);
