const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const source = fs.readFileSync('static/js/botsPackageModel.js', 'utf8');
  const M = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const p = { bots: [{ key: 'a', routines: [{}, {}] }, { key: 'b', routines: [] }], skills: [{ name: 'write' }], connections: [], presets: [], sections: ['rooms'] };
  assert.deepEqual(M.counts(p), { bots: 2, routines: 2, skills: 1, connections: 0, presets: 0 });
  const selected = M.selection(p); selected.bots = ['b']; assert.equal(M.counts(p, selected).routines, 0);
  // Counts read in the right number: "1 bot", never "1 bots".
  assert.equal(M.summaryText({ bots: 1, routines: 0, skills: 0, connections: 0 }), '1 bot, 0 paused routines, 0 skills, 0 connections');
  assert.equal(M.summaryText({ bots: 7, routines: 1, skills: 1, connections: 1 }), '7 bots, 1 paused routine, 1 skill, 1 connection');
  assert.equal(M.plural(1, 'chat'), '1 chat'); assert.equal(M.plural(2, 'chat'), '2 chats');
  for (const file of ['static/js/botsPackagePreview.js', 'static/js/botsTemplates.js', 'static/js/botsBackup.js']) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\$\{[^}]+\} (bots|routines|skills|connections|chats|triggers)\b/, file + ' uses plural()');
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
