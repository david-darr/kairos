// PowerShell can detach GUI executables and report success before they exit.
// Node waits for Electron and propagates the actual suite result.
const { spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const SUITES = ['bg-tasks-smoke', 'browser-smoke', 'preview-smoke', 'video-render-smoke', 'studio-checks', 'studio-content-checks', 'motion-engine-checks', 'chat-smoke', 'ui-smoke', 'usage-overlay-smoke', 'crm-smoke', 'roblox-smoke', 'mobile-tabs-checks', 'ask-user-checks', 'chat-scroll-checks', 'chat-speed-checks', 'account-switcher-checks', 'browse-media-checks', 'chat-bot-maker-checks'];
// 2026-10-13: accept the documented script path as well as its short name.
const requestedSuite = path.basename(process.argv[2] || '').replace(/\.cjs$/, '');
// The phone sidebar checks share the mobile-tabs synthetic backend and layout helpers.
const suite = requestedSuite === 'mobile-sidebar-checks' ? 'mobile-tabs-checks' : requestedSuite;
if (!SUITES.includes(suite)) {
  throw new Error('Choose ' + SUITES.slice(0, -1).join(', ') + ', or ' + SUITES.at(-1));
}

// One Electron test run at a time machine-wide (AGENTS.md): the folder lock
// data/electron.lock in the main checkout, shared by every worktree. Wait while
// another run holds it; remove it only if this process made it (2026-11-05).
const fs = require('node:fs');
function lockPath() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: __dirname, encoding: 'utf8' }).trim();
    return path.join(path.dirname(common), 'data', 'electron.lock');
  } catch { return path.join(__dirname, '..', 'data', 'electron.lock'); }
}
let heldLock = null;
// The owner's process id is in owner.json. A lock without one (made by an older copy of
// this runner in another worktree, or a crash between the two steps) counts as stale only
// after 35 minutes, longer than the longest run's 30-minute timeout.
function lockIsStale(lock) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  } catch {
    try { return Date.now() - fs.statSync(lock).mtimeMs > 35 * 60000; } catch { return false; }
  }
}
function takeLock() {
  if (heldLock || process.env.JARVIS_ELECTRON_LOCK_HELD) return;
  const lock = lockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let told = false;
  for (;;) {
    try { fs.mkdirSync(lock); heldLock = lock; fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // 2026-11-10: a runner that is force-killed never runs its exit handler, so its lock
      // stayed forever (three times on 2026-11-09). Clear a lock whose owner is gone.
      if (lockIsStale(lock)) { console.log('Clearing a stale Electron lock (its run is no longer going).'); try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} continue; }
      if (!told) { console.log('Waiting for another Electron test run to finish (' + lock + ' exists; remove it only if no run is going).'); told = true; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
  }
  const release = () => { if (heldLock) { try { fs.rmSync(heldLock, { recursive: true, force: true }); } catch {} heldLock = null; } };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => { release(); process.exit(130); });
}

function runSuite(name, args) {
  takeLock();
  if (name === 'crm-smoke') {
    require('node:fs').accessSync(path.join(__dirname, '..', 'tabs', 'crm', 'view.js'));
    require('node:fs').accessSync(path.join(__dirname, '..', 'tabs', 'crm', 'view.css'));
  }
  const electronBinary = process.env.JARVIS_ELECTRON_BINARY || require('../electron/node_modules/electron');
  const result = spawnSync(electronBinary,
    [path.join(__dirname, name + '.cjs'), ...args],
    // 2026-10-14: UI-3 adds appearance captures and real control checks to an
    // already seven-minute suite. Give it time to finish the phone audit too.
    // 2026-10-21: the phone checks now walk every tab, popup and two device classes; ui-smoke runs them too.
    // 2026-11-03: the full suite now takes about 20 minutes (1,216 s measured on
    // Electron 43.8.3, and it outgrew 15 on stock 43.7.0 as well). David: raise it to 30.
    // 2026-11-10: video-render-smoke --long-form renders a 3 to 5 minute video twice over (a stop and a resume): up to an hour.
    { stdio: 'inherit', windowsHide: true, timeout: name === 'ui-smoke' ? 1800000 : name === 'video-render-smoke' && args.includes('--long-form') ? 3600000 : 420000 });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

// 2026-11-05 (David: "Yes, make it"): `ui-smoke --changed` runs only the checks for
// the files this branch changed (scripts/ui-smoke-areas.cjs); `ui-smoke --list` lists them.
const args = process.argv.slice(3);
if (suite === 'ui-smoke' && (args.includes('--changed') || args.includes('--list'))) {
  const { AREAS, plan } = require('./ui-smoke-areas.cjs');
  if (args.includes('--list')) {
    for (const area of AREAS) console.log(area.name.padEnd(42) + area.runs.map(run => run.join(' ')).join(' | '));
    process.exit(0);
  }
  const root = path.join(__dirname, '..');
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  // Compared with where this branch left --base (default dev, else main), plus uncommitted and new files.
  const baseArg = args.find(a => a.startsWith('--base='))?.slice(7);
  const baseRef = baseArg || ['dev', 'main'].find(ref => { try { git('rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; } });
  if (!baseRef) throw new Error('No dev or main branch to compare with; pass --base=<branch>');
  const base = git('merge-base', 'HEAD', baseRef)[0];
  const changed = [...new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])].map(f => f.replace(/\\/g, '/'));
  const result = plan(changed);
  console.log(`ui-smoke --changed: ${changed.length} changed file(s) since ${baseRef} (${base.slice(0, 8)}).`);
  if (args.includes('--dry')) {  // print the plan only
    console.log(result.full.length ? 'Would run the full suite, because of: ' + result.full.join(', ') : result.runs.length ? 'Would run: ' + result.runs.map(r => r.join(' ')).join(' | ') : 'Would run nothing: no screen files changed.');
    process.exit(0);
  }
  if (result.full.length) {
    console.log('Full run, because these are shared or not mapped to an area yet: ' + result.full.join(', '));
    process.exit(runSuite('ui-smoke', args.filter(a => a !== '--changed' && a !== '--dry' && !a.startsWith('--base='))));
  }
  if (!result.runs.length) {
    console.log('No screen files changed, so no UI checks to run.' + (result.skipped.length ? ' (Covered by other tests: ' + result.skipped.length + ' file(s).)' : ''));
    process.exit(0);
  }
  console.log('Areas: ' + result.areas.join(', ') + '.');
  const failed = [];
  for (const [name, ...options] of result.runs) {
    console.log(`\n== ${name} ${options.join(' ')}`);
    if (runSuite(name, options) !== 0) failed.push([name, ...options].join(' '));
  }
  console.log(failed.length ? `\nFAILED: ${failed.join('; ')}` : `\nPASS: ${result.runs.length} check run(s) for ${result.areas.join(', ')}.`);
  process.exit(failed.length ? 1 : 0);
}
process.exit(runSuite(suite, args));
