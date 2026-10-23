// Plain-node leave guard behavior and navigation wiring checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { registerLeaveGuard, hasLeaveGuard, canLeaveView } = await import(pathToFileURL(path.join(root, 'static/js/leaveGuard.js')).href);
  assert.equal(hasLeaveGuard(), false);
  assert.equal(await canLeaveView(), true, 'No guards allow leaving');

  const unblock = registerLeaveGuard(() => false);
  assert.equal(hasLeaveGuard(), true);
  assert.equal(await canLeaveView(), false, 'A guard can block leaving');
  unblock();
  assert.equal(hasLeaveGuard(), false);
  assert.equal(await canLeaveView(), true, 'Unregister restores navigation');

  for (const result of [false, true]) {
    let calls = 0, release;
    const unguard = registerLeaveGuard(async () => {
      calls++;
      return new Promise(resolve => { release = resolve; });
    });
    const first = canLeaveView(), second = canLeaveView();
    assert.equal(first, second, 'Concurrent requests share the pending promise');
    assert.equal(calls, 1, 'Concurrent requests ask the guard once');
    release(result);
    assert.deepEqual(await Promise.all([first, second]), [result, result]);
    const next = canLeaveView();
    assert.equal(calls, 2, 'Settling clears the pending prompt');
    release(true);
    assert.equal(await next, true);
    unguard();
  }

  const unthrow = registerLeaveGuard(() => { throw new Error('guard failed'); });
  assert.equal(await canLeaveView(), false, 'A throwing guard blocks safely');
  unthrow();
  const unreject = registerLeaveGuard(async () => { throw new Error('async guard failed'); });
  assert.equal(await canLeaveView(), false, 'A rejected guard blocks safely');
  unreject();

  const order = [];
  const older = registerLeaveGuard(() => { order.push('older'); return true; });
  const newer = registerLeaveGuard(() => { order.push('newer'); return false; });
  assert.equal(await canLeaveView(), false);
  assert.deepEqual(order, ['newer'], 'Guards run newest first and stop on refusal');
  newer();
  assert.equal(await canLeaveView(), true);
  assert.deepEqual(order, ['newer', 'older']);
  older();

  const app = fs.readFileSync(path.join(root, 'static/js/app.js'), 'utf8');
  assert.match(app, /import \{ hasLeaveGuard, canLeaveView \} from ['"]\.\/leaveGuard\.js['"]/);
  const wrapper = app.match(/export function switchTab\(tabId, options = \{\}\) \{([\s\S]*?)\n\}/)?.[0];
  assert.ok(wrapper, 'switchTab remains a synchronous function');
  assert.match(wrapper, /if \(hasLeaveGuard\(\)\) return canLeaveView\(\)\.then\(ok => ok \? switchTabNow\(tabId, options\) : undefined\)/);
  assert.match(app, /async function openSettings\(options = \{\}\) \{\s*if \(hasLeaveGuard\(\) && !await canLeaveView\(\)\) return;/);

  // Execute the real wrapper with a navigation spy to verify timing and Cancel.
  let guarded = false, navigations = 0, release;
  const options = { section: 'vault' };
  const context = vm.createContext({
    hasLeaveGuard: () => guarded,
    canLeaveView: () => new Promise(resolve => { release = resolve; }),
    switchTabNow: (tab, received) => { navigations++; assert.equal(tab, 'library'); assert.equal(received, options); return 'landed'; },
  });
  vm.runInContext(wrapper.replace('export ', ''), context);
  assert.equal(context.switchTab('library', options), 'landed', 'No-guard navigation stays synchronous');
  guarded = true;
  const cancelled = context.switchTab('library', options);
  assert.equal(navigations, 1, 'Guarded navigation waits before switching');
  release(false);
  assert.equal(await cancelled, undefined);
  assert.equal(navigations, 1, 'Cancel does not navigate');
  const allowed = context.switchTab('library', options);
  release(true);
  assert.equal(await allowed, 'landed');
  assert.equal(navigations, 2, 'Discard proceeds with the original destination and options');

  const library = fs.readFileSync(path.join(root, 'static/js/views/library.js'), 'utf8');
  assert.match(library, /import \{ registerLeaveGuard \} from ['"]\.\.\/leaveGuard\.js['"]/);
  assert.match(library, /export async function render\([^\n]+\) \{\s*const unguard = registerLeaveGuard\(async \(\) => \{/);
  assert.match(library, /if \(activeVaultView\?\.canLeave && !await activeVaultView\.canLeave\(\)\) return false;/);
  assert.match(library, /if \(docGuard && !await docGuard\(\)\) return false;/);
  assert.match(library, /return \(\) => \{ unguard\(\); docGuard = null; [^\n]*\};/, 'Library cleanup unregisters its guard first');
  assert.match(library, /docGuard = \(\) => \(contentArea\.isConnected \? confirmLeave\(\) : true\);/);
  assert.match(app, /if \(activeUnmount\) \{ activeUnmount\(\); activeUnmount = null; \}[\s\S]*?const result = await mod\.render\(/, 'Previous cleanup runs before Library can render again');
  assert.equal(hasLeaveGuard(), false, 'Tests leave no registered guards');
  console.log('PASS: leave guard behavior, synchronous navigation, Settings and Library cleanup wiring');
})().catch(error => { console.error(error); process.exitCode = 1; });
