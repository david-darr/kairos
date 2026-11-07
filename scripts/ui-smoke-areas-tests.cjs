// node scripts/ui-smoke-areas-tests.cjs: checks scripts/ui-smoke-areas.cjs (2026-11-05).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AREAS, plan } = require('./ui-smoke-areas.cjs');

// Every option an area runs exists in ui-smoke.cjs, and every suite in the runner.
const smoke = fs.readFileSync(path.join(__dirname, 'ui-smoke.cjs'), 'utf8');
const runner = fs.readFileSync(path.join(__dirname, 'run-electron-test.cjs'), 'utf8');
for (const area of AREAS) for (const [suite, ...options] of area.runs) {
  assert.ok(runner.includes(`'${suite}'`), `${area.name}: the runner has no suite ${suite}`);
  for (const option of options) assert.ok(smoke.includes(`'${option}'`), `${area.name}: ui-smoke.cjs has no ${option}`);
}

const runsFor = files => plan(files).runs.map(r => r.join(' '));
assert.deepEqual(runsFor(['static/js/views/browse.js', 'static/css/browse.css']), ['ui-smoke --browse-only']);
assert.deepEqual(runsFor(['static/js/botsChat.js', 'scripts/bots-chat-checks.cjs']), ['ui-smoke --bots-only']);
assert.deepEqual(runsFor(['static/js/vaultGraph.js']), ['ui-smoke --g5-only']);
assert.ok(runsFor(['static/js/mobileShell.js']).includes('mobile-tabs-checks'));
// Shared files and unmapped screen files mean the full run, naming the file.
assert.deepEqual(plan(['static/js/app.js', 'static/js/views/browse.js']).full, ['static/js/app.js']);
assert.deepEqual(plan(['static/js/someNewThing.js']).full, ['static/js/someNewThing.js']);
// Files ui-smoke doesn't draw need no UI run.
const backend = plan(['app.py', 'electron/main.js', 'README.md', 'scripts/test_browse_routes.py']);
assert.deepEqual([backend.full, backend.runs, backend.skipped.length], [[], [], 4]);
// The same run is listed once even when two areas share it.
assert.equal(new Set(runsFor(['static/js/views/forgeHome.js', 'static/js/forgeEditor.js'])).size, runsFor(['static/js/views/forgeHome.js']).length);
console.log(`PASS: ui-smoke areas (${AREAS.length} areas, every option exists).`);
