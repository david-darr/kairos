const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const source = fs.readFileSync('static/js/botsPackageModel.js', 'utf8');
  const M = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const p = { bots: [{ key: 'a', routines: [{}, {}] }, { key: 'b', routines: [] }], skills: [{ name: 'write' }], connections: [], presets: [], sections: ['rooms'] };
  assert.deepEqual(M.counts(p), { bots: 2, routines: 2, skills: 1, connections: 0, presets: 0 });
  const selected = M.selection(p); selected.bots = ['b']; assert.equal(M.counts(p, selected).routines, 0);
  assert.equal(M.fileProblem({ name: 'team.md', size: 10 }), '');
  assert.match(M.fileProblem({ name: 'team.exe', size: 10 }), /JSON/);
  assert.match(M.fileProblem({ name: 'team.json', size: M.MAX_PACKAGE_BYTES + 1 }), /4 MB/);
  assert.match(M.failure({ detail: { message: 'Import failed', cleanup_errors: ['Check the workspace'] } }), /Check the workspace/);
  assert.equal(M.canRestore('a-long-password', 'REPLACE'), true);
  assert.equal(M.canRestore('short', 'REPLACE'), false);
  assert.equal(M.canRestore('a-long-password', 'replace'), false);
  for (const path of ['static/css/bots-lifecycle.css', 'static/js/botsTemplates.js', 'static/js/botsPackagePreview.js']) {
    const text = fs.readFileSync(path, 'utf8'); assert.doesNotMatch(text, /#[a-fA-F0-9]{3,8}\b|rgba?\(/); assert.doesNotMatch(text, /\u2014/);
  }
  console.log('Bots templates: passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
