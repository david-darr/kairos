// Part 2, group g8: A21 admin panels, control -> request -> result. Run alone:
//   node scripts/run-electron-test.cjs ui-smoke --g8-only
// Not part of the default ui-smoke run. Covers Settings > Logs filters, Runs filter,
// System wipe (two confirmations, cancel sends nothing), Sandbox changes apply/discard,
// and File checkpoints (restore states, skipped files, confirm, request body). The file
// checkpoint answers come from a page-side fetch wrapper because demo/fixtures.js is
// snapshotted into docs/demo (test_site_demo) and must not change.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, capture, writes, reads }) => {
  const failures = [];
  const section = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); console.log(`  ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
  };
  const clickText = (selector, text) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const openSettings = async name => {
    win.setContentSize(1440, 900); await delay(300);
    await navigate('home');
    await js("document.querySelector('.sidebar-settings-btn').click()");
    await waitFor(`!!document.querySelector('[data-section=${name}]')`);
    await js(`document.querySelector('[data-section=${name}]').click()`);
  };
  const setSelect = (selector, value) => js(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
  const logReads = from => reads.slice(from).filter(r => r.path === '/api/system/logs');
  const waitRead = async (pred, what) => { for (let i = 0; i < 80; i++) { if (pred()) return; await delay(50); } throw new Error('never saw ' + what); };
  const dialogButton = text => js(`[...document.querySelectorAll('.confirm-panel button')].find(b => b.textContent === ${JSON.stringify(text)})?.click()`);

  await section('Logs: each filter becomes a query on the next read', async () => {
    await openSettings('logs');
    await waitFor("document.querySelectorAll('.log-entry').length === 3");
    const start = reads.length;
    await setSelect('.logs-level', 'ERROR');
    await waitRead(() => logReads(start).some(r => r.query.level === 'ERROR'), 'level=ERROR');
    await setSelect('.logs-component', 'chat');
    await waitRead(() => logReads(start).some(r => r.query.component === 'chat' && r.query.level === 'ERROR'), 'component=chat kept with level');
    await setSelect('.logs-since', '1h');
    await waitRead(() => logReads(start).some(r => r.query.since === '1h'), 'since=1h');
    await setSelect('.logs-chat', 's1');
    await waitRead(() => logReads(start).some(r => r.query.tag === 's1'), 'tag=s1');
    await js("(() => { const i = document.querySelector('.logs-search'); i.value = 'turn failed'; i.dispatchEvent(new Event('input')); })()");
    await waitRead(() => logReads(start).some(r => r.query.text === 'turn failed'), 'text=turn failed');
    const last = logReads(start).at(-1).query;
    assert.deepEqual({ level: last.level, component: last.component, since: last.since, tag: last.tag, text: last.text, limit: last.limit },
      { level: 'ERROR', component: 'chat', since: '1h', tag: 's1', text: 'turn failed', limit: '300' }, 'the final request carries every filter at once');
    assert.equal(await js("document.querySelectorAll('.log-entry .log-tag')[0]?.textContent"), 'A clearer direction for the workspace', 'a chat is named, not an id');
    // Follow polls with the byte cursor the last read returned, then stops when the page is left.
    const before = reads.length;
    await js("document.querySelector('.logs-follow').click()");
    await waitRead(() => logReads(before).some(r => r.query.limit === '300'), 'follow reload');
    await waitRead(() => logReads(before).some(r => r.query.cursor === '900'), 'follow poll with cursor=900');
    await js("document.querySelector('[data-section=runs]').click()");
    await waitFor("!!document.querySelector('.runs-outcome')");
    await delay(300);
    const after = reads.length; await delay(2600);
    assert.equal(logReads(after).length, 0, 'leaving the Logs page stops following (no polling in the background)');
  });

  await section('Runs: the outcome filter asks the server and Steps opens a run', async () => {
    await openSettings('runs');
    await waitFor("document.querySelectorAll('.run-item').length === 2");
    const start = reads.length;
    await setSelect('.runs-outcome', 'failed');
    await waitRead(() => reads.slice(start).some(r => r.path === '/api/runs' && r.query.outcome === 'failed' && r.query.limit === '100'), 'outcome=failed');
    const detail = reads.length;
    await js("document.querySelector('[data-run=r2] .run-item-head .btn').click()");
    await waitFor("document.querySelectorAll('[data-run=r2] .run-step').length === 5");
    assert.equal(reads.slice(detail).filter(r => r.path === '/api/runs/r2').length, 1, 'opening one run reads it once');
  });

  await section('System: wipe needs two confirmations and Cancel sends nothing', async () => {
    await openSettings('system');
    await waitFor("!!document.querySelector('.backup-full')");
    const start = writes.length;
    await clickText('.set-danger button', 'Wipe notes');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await dialogButton('Cancel');
    await delay(300);
    assert.equal(writes.slice(start).filter(w => w.path === '/api/system/wipe').length, 0, 'cancelling the first prompt wipes nothing');
    await clickText('.set-danger button', 'Wipe notes');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await dialogButton('Wipe all notes');
    await waitFor("!!document.querySelector('.confirm-panel') && document.querySelector('.confirm-panel').textContent.includes('absolutely sure')");
    await dialogButton('Cancel');
    await delay(300);
    assert.equal(writes.slice(start).filter(w => w.path === '/api/system/wipe').length, 0, 'cancelling the second prompt wipes nothing');
    await clickText('.set-danger button', 'Wipe notes');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await dialogButton('Wipe all notes');
    await waitFor("document.querySelector('.confirm-panel')?.textContent.includes('absolutely sure')");
    await dialogButton('Yes, wipe notes');
    await waitRead(() => writes.slice(start).some(w => w.path === '/api/system/wipe'), 'POST /api/system/wipe');
    const sent = writes.slice(start).filter(w => w.path === '/api/system/wipe');
    assert.equal(sent.length, 1, 'exactly one wipe request');
    assert.deepEqual(JSON.parse(sent[0].body), { kind: 'notes' });
    assert.equal(sent[0].method, 'POST');
    // The four kinds are the four rows, no other destructive control.
    assert.deepEqual(await js("[...document.querySelectorAll('.set-danger .btn.danger')].map(b => b.textContent)"),
      ['Wipe chats', 'Wipe notes', 'Wipe tasks', 'Wipe skills']);
    // The last restore names its safety copy, and the full-backup control keeps keys off by default.
    assert.ok(await js("document.querySelector('.backup-last').textContent.includes('before-restore-')"));
    assert.equal(await js("document.querySelector('.backup-full input[type=checkbox]')?.checked ?? false"), false, 'keys are off by default');
  });

  await section('Sandbox changes: Apply asks first and sends the id; Discard sends DELETE; oversized is read only', async () => {
    await openSettings('sandbox-changes');
    await waitFor("document.querySelectorAll('.sandbox-change').length === 2");
    const start = writes.length;
    await clickText('[data-change=c0ffee000001] button', 'Apply');
    await waitFor("!!document.querySelector('.confirm-panel')");
    assert.ok(await js("document.querySelector('.confirm-panel').textContent.includes('2 file(s) will be written') && document.querySelector('.confirm-panel').textContent.includes('Nothing is committed')"));
    await dialogButton('Cancel');
    await delay(300);
    assert.equal(writes.slice(start).length, 0, 'cancelled Apply sends nothing');
    await clickText('[data-change=c0ffee000001] button', 'Apply');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await dialogButton('Apply changes');
    await waitRead(() => writes.slice(start).some(w => w.path === '/api/sandbox/changes/c0ffee000001/apply'), 'apply request');
    assert.equal(writes.slice(start).find(w => w.path.endsWith('/apply')).method, 'POST');
    await waitFor("document.querySelectorAll('.sandbox-change').length === 2");
    assert.equal(await js("[...document.querySelectorAll('[data-change=c0ffee000002] button')].find(b => b.textContent === 'Apply').disabled"), true, 'oversized: read only');
    assert.ok(await js("document.querySelector('[data-change=c0ffee000002]').textContent.includes('Too large to keep for applying')"));
    const mark = writes.length;
    await clickText('[data-change=c0ffee000002] button', 'Discard');
    await waitRead(() => writes.slice(mark).some(w => w.method === 'DELETE' && w.path === '/api/sandbox/changes/c0ffee000002'), 'discard request');
  });

  await section('File checkpoints: restore states, skipped files, one confirmed restore of only the available file', async () => {
    const now = Math.floor(Date.now() / 1000);
    await js(`(() => {
      const root = 'C:/work';
      const full = { id: 'g8-cp1', source: 'chat:s1', status: 'changed', created: ${now} - 60, overlap: false, roots: [{ path: root,
        before_skipped: ['big.iso (over 50 MB)'], after_skipped: [], changes: [
          { path: 'a.txt', status: 'modified', restore_state: 'available', diff: '@@ -1 +1 @@\\n-one\\n+two\\n' },
          { path: 'b.txt', status: 'modified', restore_state: 'changed_since', diff: '@@ -1 +1 @@\\n-x\\n+y\\n' },
          { path: 'c.txt', status: 'added', restore_state: 'restored', diff: '' }] }] };
      const list = { ...full, roots: full.roots.map(r => ({ ...r, changes: r.changes.map(({ diff, ...c }) => c) })) };
      window.__g8 = { calls: [], full };
      const original = window.fetch;
      window.__g8.original = original;
      window.fetch = async function (input, init) {
        const url = new URL(String(input?.url || input), location.origin);
        const method = (init?.method || input?.method || 'GET').toUpperCase();
        if (url.pathname.startsWith('/api/file-checkpoints')) {
          window.__g8.calls.push({ path: url.pathname, method, body: init?.body || null });
          const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          if (url.pathname === '/api/file-checkpoints') return json([list]);
          if (url.pathname === '/api/file-checkpoints/g8-cp1' && method === 'GET') return json(window.__g8.full);
          if (url.pathname === '/api/file-checkpoints/g8-cp1/restore') {
            for (const f of JSON.parse(init.body).files) window.__g8.full.roots[0].changes.find(c => c.path === f.path).restore_state = 'restored';
            return json({ restored: JSON.parse(init.body).files });
          }
        }
        return original.apply(this, arguments);
      };
      return true;
    })()`);
    try {
      await openSettings('file-checkpoints');
      await waitFor("document.querySelector('.file-checkpoint')?.textContent.includes('3 file(s)')");
      await delay(1500);
      await js("document.querySelector('.file-checkpoint .btn').click()");
      await waitFor("document.querySelectorAll('.file-checkpoint input[type=checkbox]').length === 3");
      assert.deepEqual(await js("[...document.querySelectorAll('.file-checkpoint input[type=checkbox]')].map(c => c.disabled)"), [false, true, true],
        'only the untouched file can be selected');
      const labels = await js("[...document.querySelectorAll('.file-checkpoint label')].map(l => l.textContent)");
      assert.ok(labels[1].includes('Changed again; restore unavailable'), 'a stale file says why it cannot be restored');
      assert.ok(labels[2].includes('Restored'));
      assert.ok(await js("document.querySelector('.file-checkpoint').textContent.includes('Skipped: big.iso (over 50 MB)')"), 'skipped files are named');
      assert.ok(await js("document.querySelector('.file-checkpoint .sandbox-diff').textContent.includes('+two')"), 'a diff is shown');
      const restoreButton = "[...document.querySelectorAll('.file-checkpoint .btn.danger')].find(b => b.textContent === 'Restore selected files')";
      await js(`${restoreButton}.click()`);
      await waitFor("!!document.querySelector('.confirm-panel')");
      assert.ok(await js("document.querySelector('.confirm-panel').textContent.includes('1 file(s) will return')"));
      await dialogButton('Cancel');
      await delay(300);
      assert.equal(await js("window.__g8.calls.filter(c => c.method === 'POST').length"), 0, 'cancel restores nothing');
      await js(`${restoreButton}.click()`);
      await waitFor("!!document.querySelector('.confirm-panel')");
      await dialogButton('Restore files');
      await waitFor("window.__g8.calls.some(c => c.method === 'POST')");
      const post = await js("window.__g8.calls.find(c => c.method === 'POST')");
      assert.equal(post.path, '/api/file-checkpoints/g8-cp1/restore');
      assert.deepEqual(JSON.parse(post.body), { files: [{ root: 'C:/work', path: 'a.txt' }] }, 'only the available file is sent');
      // the panel re-reads the list and redraws; wait for the redrawn (collapsed) row
      await waitFor("!!document.querySelector('.file-checkpoint .btn') && !document.querySelector('.confirm-panel') && document.querySelectorAll('.file-checkpoint input[type=checkbox]').length === 0");
      await js("document.querySelector('.file-checkpoint .btn').click()");
      await waitFor("document.querySelectorAll('.file-checkpoint input[type=checkbox]').length === 3");
      assert.ok(await js("document.querySelector('.file-checkpoint').textContent.includes('1 restored') || [...document.querySelectorAll('.file-checkpoint label')][0].textContent.includes('Restored')"), 'the restored state is shown after reload');
      assert.equal(await js("[...document.querySelectorAll('.file-checkpoint .btn.danger')].find(b => b.disabled)?.textContent"), 'Nothing left to restore');
    } catch (e) {
      const dump = await js("JSON.stringify({ html: (document.querySelector('#settings-content')?.innerText || '').slice(0, 600), calls: window.__g8?.calls })").catch(() => '');
      throw new Error(e.message + ' | ' + dump);
    } finally {
      await js("if (window.__g8?.original) window.fetch = window.__g8.original; true");
    }
  });

  // EFFICIENCY (g8, 2026-10-27): opening an admin panel should read its data once.
  await section('Efficiency: each admin panel reads its main route once on open', async () => {
    const counts = {};
    await openSettings('system'); await delay(1500);
    for (const [name, route] of [['logs', '/api/system/logs'], ['runs', '/api/runs'], ['sandbox-changes', '/api/sandbox/changes'], ['system', '/api/system/diagnostics']]) {
      const before = reads.length;
      await js(`document.querySelector('[data-section=${name}]').click()`);
      await delay(1800);
      counts[name] = reads.slice(before).filter(r => r.path === route).length;
    }
    await js(`(() => { window.__g8c = { calls: [] }; const original = window.fetch; window.__g8c.original = original;
      window.fetch = async function (input, init) { const u = new URL(String(input?.url || input), location.origin); if (u.pathname === '/api/file-checkpoints') window.__g8c.calls.push(1); return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }); }; return true; })()`);
    await js("document.querySelector('[data-section=sandbox-changes]').click()");
    await delay(300);
    await js("document.querySelector('[data-section=file-checkpoints]').click()");
    await delay(1800);
    counts['file-checkpoints'] = await js('window.__g8c.calls.length');
    await js('window.fetch = window.__g8c.original; true');
    console.log('    panel reads on open: ' + JSON.stringify(counts));
    assert.deepEqual(counts, { logs: 1, runs: 1, system: 1, 'sandbox-changes': 1, 'file-checkpoints': 1 }, 'each panel reads once');
  });

  // EFFICIENCY finding (g8): the first section opened right after Settings opens reads its route twice
  // (found 2026-10-27: /api/runs 2 reads vs 1 when switching sections inside an open Settings).
  await section('Efficiency: the first Settings section opened reads its route once', async () => {
    win.setContentSize(1440, 900); await delay(300);
    await navigate('home');
    await js("document.querySelector('.sidebar-settings-btn').click()");
    await waitFor("!!document.querySelector('[data-section=runs]')");
    const before = reads.length;
    await js("document.querySelector('[data-section=runs]').click()");
    await delay(1800);
    const n = reads.slice(before).filter(r => r.path === '/api/runs').length;
    assert.equal(n, 1, '/api/runs was read ' + n + ' times for one click');
  });

  if (failures.length) throw new Error('g8 failures:\n - ' + failures.join('\n - '));
};
