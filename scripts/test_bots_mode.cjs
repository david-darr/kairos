// The app's modes (Agents 3.0 Phase 0, unit U3): the plain-Node checks of
// static/js/appModes.js, the no-DOM half of the Kairos / Forge / Bots switch.
// Run: node scripts/test_bots_mode.cjs
// The rendered half (the switch, the rail, the phone sheet) is scripts/bots-shell-checks.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };

(async () => {
  const M = await load('js/appModes.js');

  check('there are three modes, in the switch order', () => {
    assert.deepEqual(M.MODES, ['kairos', 'forge', 'bots']);
    assert.deepEqual(M.MODE_SWITCH, [['kairos', 'Kairos'], ['forge', 'Forge'], ['bots', 'Bots']]);
  });

  check('Forge and Bots carry the Preview badge, Kairos does not', () => {
    assert.deepEqual(M.MODE_BADGES, { forge: 'Preview', bots: 'Preview' });
    assert.equal(M.MODE_BADGES.kairos, undefined);
  });

  check('restoreMode: an admin gets Forge and Bots back, anything else is Kairos', () => {
    assert.equal(M.restoreMode('forge', true), 'forge');
    assert.equal(M.restoreMode('bots', true), 'bots');
    assert.equal(M.restoreMode('kairos', true), 'kairos');
    for (const stored of [null, undefined, '', 'Bots', 'agents', 'forge ', 7, {}]) assert.equal(M.restoreMode(stored, true), 'kairos', String(stored));
  });

  check('restoreMode: a non-admin is always in Kairos', () => {
    for (const stored of ['forge', 'bots', 'kairos', null]) {
      assert.equal(M.restoreMode(stored, false), 'kairos', String(stored));
      assert.equal(M.restoreMode(stored, undefined), 'kairos', String(stored));
    }
  });

  check('modeForTab: every Bots tab is Bots, every Forge tab is Forge, the rest is Kairos', () => {
    assert.equal(M.modeForTab('botsHome'), 'bots');
    assert.equal(M.modeForTab('botsShell'), 'bots');
    assert.equal(M.modeForTab('forgeHome'), 'forge');
    assert.equal(M.modeForTab('forgeShell'), 'forge');
    for (const tab of ['home', 'chat', 'agents', 'notes', 'library', 'calendar', 'email', 'tasks', 'tool-store', 'cookbook', 'mobileLaunch', 'settings', '', undefined]) {
      assert.equal(M.modeForTab(tab), 'kairos', String(tab));
    }
  });

  check('the legacy agents tab stays a Kairos tab (Phase 0 leaves it alone)', () => {
    assert.equal(M.modeForTab('agents'), 'kairos');
    assert.ok(!M.BOTS_NAV.some(item => item.id === 'agents'));
  });

  check('the nav lists: one item each, Bots on the agents glyph', () => {
    assert.deepEqual(M.BOTS_NAV, [{ id: 'botsHome', label: 'Bots', icon: 'agents' }]);
    assert.deepEqual(M.FORGE_NAV, [{ id: 'forgeHome', label: 'Home', icon: 'home' }]);
    for (const item of [...M.BOTS_NAV, ...M.FORGE_NAV]) assert.equal(M.modeForTab(item.id) === 'kairos', false, item.id);
  });

  check('each mode opens on its own home tab', () => {
    assert.equal(M.homeTabFor('kairos'), 'home');
    assert.equal(M.homeTabFor('forge'), 'forgeHome');
    assert.equal(M.homeTabFor('bots'), 'botsHome');
    assert.equal(M.homeTabFor('nonsense'), 'home');
    for (const mode of M.MODES) assert.equal(M.modeForTab(M.homeTabFor(mode)), mode, mode);
  });

  check('title-bar labels', () => {
    assert.deepEqual(M.TAB_LABELS, { forgeShell: 'Forge', botsHome: 'Bots', botsShell: 'Bots' });
  });

  check('the collapsed rail steps Kairos, Bots, Forge and back, and names where it goes', () => {
    assert.deepEqual(['kairos', 'bots', 'forge'].map(M.nextRailMode), ['bots', 'forge', 'kairos']);
    assert.equal(M.railLabel('kairos'), 'Switch to Bots Preview');
    assert.equal(M.railLabel('bots'), 'Switch to Forge Preview');
    assert.equal(M.railLabel('forge'), 'Switch to Kairos');
    let mode = 'kairos';
    const seen = new Set();
    for (let i = 0; i < 3; i++) { seen.add(mode); mode = M.nextRailMode(mode); }
    assert.equal(seen.size, 3);
    assert.equal(mode, 'kairos', 'three steps come back');
  });

  check('mode copy has no em dash', () => {
    const copy = JSON.stringify([M.MODE_LABELS, M.MODE_BADGES, M.TAB_LABELS, M.BOTS_NAV, M.FORGE_NAV, ...M.MODES.map(M.railLabel)]);
    assert.ok(!copy.includes('—'));
  });

  console.log(`PASS: ${passed.length} app mode checks.`);
})().catch(error => { console.error(error); process.exit(1); });
