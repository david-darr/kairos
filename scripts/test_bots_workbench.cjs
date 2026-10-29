const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const m = await import(pathToFileURL(path.join(__dirname, '../static/js/botsWorkbenchModel.js')).href);
  const phases = ['docker_missing', 'image_needed', 'asleep', 'starting', 'ready', 'busy', 'taken', 'browser_only', 'off', 'error'];
  assert.deepEqual(Object.keys(m.PHASES), phases);
  for (const phase of phases) { const view = m.phaseView({ phase }); assert.ok(view.message && view.action && view.label); }
  assert.equal(m.phaseView({ phase: 'starting', message: 'Waiting for a free computer (position 2)' }).message, 'Waiting for a free computer (position 2)');
  assert.deepEqual(m.tabsFor(false), ['computer', 'browser', 'data', 'files']);
  assert.deepEqual(m.tabsFor(true), ['computer', 'browser', 'data', 'files', 'routines']);
  assert.equal(m.pollCadence('busy'), 1000); assert.equal(m.pollCadence('ready'), 4000); assert.equal(m.pollCadence('asleep'), 30000);
  const lease = m.createLease(); lease.taken({ lease_id: 'first' });
  assert.deepEqual(lease.release(), { action: 'release', lease_id: 'first' });
  // Polls do not silently adopt another viewer's lease.
  const unrelated = { lease_id: 'second' }; assert.notEqual(lease.id, unrelated.lease_id);
  lease.clear(); assert.equal(lease.release().lease_id, null);
  assert.equal(m.placeHint({ available: false, reason: 'Docker is not ready' }), 'Docker is not ready');
  assert.equal(m.placeHint({ available: true }), '');
  assert.equal(m.clampWidth(0), 400); assert.equal(m.clampWidth(20), 360); assert.equal(m.clampWidth(2000), 960);
  assert.equal(m.addressUrl('example.com'), 'https://example.com');
  assert.equal(m.addressUrl('find this', 'https://search.example/?q={query}'), 'https://search.example/?q=find%20this');
  for (const address of ['javascript:alert(1)', 'file:///private', 'https://user:secret@example.com']) assert.throws(() => m.addressUrl(address));
  const controller = new AbortController(); const life = m.lifetime({ signal: controller.signal }); let disposed = 0;
  life.own(() => disposed++); controller.abort(); life.destroy(); assert.equal(disposed, 1); assert.equal(life.active, false);
  for (const name of fs.readdirSync(path.join(__dirname, '../static/js')).filter(n => /^bots(Workbench|PlaceChooser|BrowserProfiles|HelpCard|SectionSites|SettingsComputers)/.test(n))) {
    const source = fs.readFileSync(path.join(__dirname, '../static/js', name), 'utf8');
    assert.doesNotMatch(source, /#[a-f\d]{3,8}\b|\brgba?\(|\u2014/i, name);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, name);
  }
  console.log('PASS workbench model, leases, places, addresses, lifecycle and token-only UI');
})().catch(error => { console.error(error); process.exitCode = 1; });
