// The Kairos CLI starts the app with --background when none is running
// (electron/launch-flags.js). Checks the flag and that main.js honours it:
// the window is created hidden, and a second launch with the flag does not
// raise it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { wantsBackground } = require('../electron/launch-flags');

assert.strictEqual(wantsBackground(['electron', '.', '--background']), true);
assert.strictEqual(wantsBackground(['Kairos.exe', '--instance=dev', '--background']), true);
assert.strictEqual(wantsBackground(['Kairos.exe']), false);
assert.strictEqual(wantsBackground(['Kairos.exe', '--background=no']), false);
assert.strictEqual(wantsBackground(undefined), false);

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
assert.match(main, /const START_IN_BACKGROUND = wantsBackground\(process\.argv\);/);
assert.match(main, /show: !START_IN_BACKGROUND,/);
assert.match(main, /app\.on\("second-instance", \(_event, argv\) => \{ if \(!wantsBackground\(argv\)\) showWindow\(\); \}\);/);
// The pairing prompt brings a hidden window forward.
const pair = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'cliPair.js'), 'utf8');
assert.match(pair, /window\.jarvis\?\.showWindow\?\.\(\)/);
console.log('cli launch flag checks passed');
