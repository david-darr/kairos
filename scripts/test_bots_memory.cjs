// The Memory section's logic (Bots Phase 2, unit U1): plain-Node checks of static/js/botsMemoryModel.js.
// Run: node scripts/test_bots_memory.cjs
// Covers the editor's conflict state, polling that never clobbers a draft, capacity wording, the change
// history rows, diffs as inert text and the gate that makes a section safe to destroy with requests out.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', file)).href);

(async () => {
  const M = await load('botsMemoryModel.js');

  await check('a failure from api.js is split into its status and message', () => {
    assert.deepEqual(M.parseFailure(new Error('409: this note changed since you opened it')), { status: 409, message: 'this note changed since you opened it' });
    assert.deepEqual(M.parseFailure(new Error('413: too big')), { status: 413, message: 'too big' });
    assert.deepEqual(M.parseFailure(new Error('Failed to fetch')), { status: 0, message: 'Failed to fetch' });
    assert.equal(M.parseFailure(undefined).status, 0);
    assert.equal(M.parseFailure(new Error('500: ')).message, 'That did not work.');
  });

  await check('capacity says how much is read each turn and warns before and after the limit', () => {
    const ok = M.capacityReport({ stored_lines: 12, stored_bytes: 900, loaded_lines: 12, loaded_bytes: 900, line_limit: 200, byte_limit: 24576, clipped: false });
    assert.equal(ok.level, 'ok');
    assert.equal(ok.warning, '');
    assert.match(ok.label, /12 lines of 200, 900 B of 24 KB/);
    const near = M.capacityReport({ stored_lines: 170, stored_bytes: 5000, loaded_lines: 170, loaded_bytes: 5000, clipped: false });
    assert.equal(near.level, 'near');
    assert.match(near.warning, /Getting full/);
    const bytes = M.capacityReport({ stored_lines: 20, stored_bytes: 22000, loaded_lines: 20, loaded_bytes: 22000, clipped: false });
    assert.equal(bytes.level, 'near', 'the byte limit counts as well as the line limit');
    const over = M.capacityReport({ stored_lines: 250, stored_bytes: 9000, loaded_lines: 200, loaded_bytes: 8000, line_limit: 200, byte_limit: 24576, clipped: true });
    assert.equal(over.level, 'over');
    assert.equal(over.percent, 100);
    assert.match(over.warning, /Only the first 200 lines/);
    assert.deepEqual(over.loaded, { lines: 200, bytes: 8000 });
    assert.equal(M.capacityReport(null).level, 'ok', 'no data yet is not an error');
    assert.equal(M.formatBytes(512 * 1024), '512 KB');
  });

  await check('topic names are checked before anything is sent', () => {
    assert.equal(M.topicNameError('hiring', []), '');
    assert.match(M.topicNameError('', []), /Give the topic a name/);
    assert.match(M.topicNameError('has space', []), /letters, numbers/);
    assert.match(M.topicNameError('../x', []), /letters, numbers/);
    assert.match(M.topicNameError('x'.repeat(65), []), /64 characters/);
    for (const reserved of ['archive', 'LOG', 'con', 'COM1']) assert.match(M.topicNameError(reserved, []), /reserved/);
    assert.match(M.topicNameError('Hiring', ['hiring']), /already exists/, 'a case-only twin would alias on Windows');
  });

  await check('notes read like sentences and superseded ones are hidden', () => {
    assert.equal(M.noteHint({ section: 'Preferences', learned: '2026-10-29', source: 'owner', until: '2026-12-01' }), 'Preferences · added Oct 29 by you · until Dec 1');
    assert.equal(M.noteHint({ section: 'Notes', learned: '2026-01-05', source: 'legacy' }), 'Notes · added Jan 5');
    assert.equal(M.noteHint({ section: '', learned: '2026-01-05', source: 'agent' }), 'added Jan 5 by the bot');
    assert.equal(M.noteHint({ section: 'Notes', learned: '', source: 'x' }), 'Notes');
    assert.deepEqual(M.liveNotes([{ id: 'a' }, { id: 'b', superseded: '2026-10-29' }]).map(n => n.id), ['a']);
    assert.deepEqual(M.liveNotes(undefined), []);
  });

  await check('an untouched editor takes whatever a poll brings, with no conflict', () => {
    const editor = M.createEditor({ text: 'one', hash: 'h1' });
    assert.equal(editor.dirty, false);
    assert.equal(editor.incoming({ text: 'one', hash: 'h1' }), 'same');
    assert.equal(editor.incoming({ text: 'two', hash: 'h2' }), 'adopted');
    assert.equal(editor.draft, 'two');
    assert.equal(editor.state.base.hash, 'h2');
    assert.equal(editor.conflict, null);
  });

  await check('a poll never replaces a draft: it raises a conflict that keeps the draft', () => {
    const editor = M.createEditor({ text: 'one', hash: 'h1' });
    editor.edit('one and my typing');
    assert.equal(editor.dirty, true);
    assert.equal(editor.incoming({ text: 'one and theirs', hash: 'h2' }), 'conflict');
    assert.equal(editor.draft, 'one and my typing', 'the draft survives');
    assert.deepEqual(editor.conflict, { hash: 'h2', text: 'one and theirs' });
    assert.equal(editor.incoming({ text: 'one and theirs', hash: 'h2' }), 'conflict', 'polling the same newer copy again changes nothing');
    assert.equal(editor.draft, 'one and my typing');
    assert.equal(editor.incoming({ text: 'newer still', hash: 'h3' }), 'conflict');
    assert.equal(editor.conflict.hash, 'h3', 'the conflict follows the newest copy');
    assert.equal(editor.draft, 'one and my typing');
  });

  await check('a save is refused while there is a conflict, until the person checks Overwrite', () => {
    const editor = M.createEditor({ text: 'one', hash: 'h1' });
    editor.edit('mine');
    assert.deepEqual(editor.saveRequest(), { text: 'mine', expected_hash: 'h1' });
    editor.incoming({ text: 'theirs', hash: 'h2' });
    assert.equal(editor.saveRequest(), null, 'nothing is sent over a newer copy');
    assert.equal(editor.canOverwrite, false);
    editor.setOverwrite(true);
    assert.equal(editor.canOverwrite, true);
    assert.deepEqual(editor.saveRequest(), { text: 'mine', expected_hash: 'h2' }, 'the overwrite names the newer copy, so it replaces only that');
    editor.setOverwrite(false);
    assert.equal(editor.saveRequest(), null);
    const calm = M.createEditor({ text: 'x', hash: 'h1' });
    calm.setOverwrite(true);
    assert.equal(calm.canOverwrite, false, 'no conflict means nothing to overwrite');
    assert.equal(calm.saveRequest(), null, 'and nothing to save');
  });

  await check('Reload takes the newer copy and drops the draft; Discard goes back to the saved copy', () => {
    const editor = M.createEditor({ text: 'one', hash: 'h1' });
    editor.edit('mine');
    editor.incoming({ text: 'theirs', hash: 'h2' });
    editor.reload();
    assert.deepEqual([editor.draft, editor.state.base.hash, editor.conflict, editor.dirty], ['theirs', 'h2', null, false]);
    editor.edit('again');
    editor.discard();
    assert.deepEqual([editor.draft, editor.dirty], ['theirs', false]);
    editor.reload();
    assert.equal(editor.draft, 'theirs', 'reload with no conflict is harmless');
  });

  await check('after a save, text typed while it was in flight is kept', () => {
    const editor = M.createEditor({ text: 'one', hash: 'h1' });
    editor.edit('two');
    const request = editor.saveRequest();
    editor.edit('two and more');
    editor.saved({ text: 'two', hash: 'h2' }, request.text);
    assert.equal(editor.state.base.hash, 'h2');
    assert.equal(editor.draft, 'two and more');
    assert.equal(editor.dirty, true);
    assert.deepEqual(editor.saveRequest(), { text: 'two and more', expected_hash: 'h2' });
    const plain = M.createEditor({ text: 'a', hash: 'h1' });
    plain.edit('b');
    plain.saved({ text: 'b', hash: 'h2' }, 'b');
    assert.equal(plain.dirty, false);
  });

  await check('a deleted file reads as an absent one, so a draft can recreate it', () => {
    const editor = M.createEditor({ text: 'one', hash: 'h1' });
    editor.edit('keep me');
    assert.equal(editor.incoming({ text: '', hash: M.ABSENT }), 'conflict');
    editor.setOverwrite(true);
    assert.deepEqual(editor.saveRequest(), { text: 'keep me', expected_hash: 'absent' });
  });

  await check('the change history says who, can be undone once, and explains why not', () => {
    assert.equal(M.actorLabel('person'), 'You');
    assert.equal(M.actorLabel('upkeep'), 'Tidy-up');
    assert.equal(M.actorLabel('whoever'), 'Kairos');
    assert.deepEqual(M.undoState({ revertible: true }), { enabled: true, reason: '' });
    assert.deepEqual(M.undoState({ revertible: true, reverted_by: 'x' }), { enabled: false, reason: 'Already undone' });
    assert.match(M.undoState({ revertible: false }).reason, /No copy/);
    assert.equal(M.undoState(null).enabled, false);
    assert.equal(M.whenLabel(1000, 1010), 'just now');
    assert.equal(M.whenLabel(1000, 1000 + 300), '5 min ago');
    assert.equal(M.whenLabel(1000, 1000 + 7300), '2 h ago');
  });

  await check('a diff is classified line by line and carries no markup', () => {
    const rows = M.diffRows('--- before/MEMORY.md\n+++ after/MEMORY.md\n@@ -1,2 +1,2 @@\n context\n-old <b>line</b>\n+new <img src=x onerror=alert(1)>');
    assert.deepEqual(rows.map(r => r.kind), ['meta', 'meta', 'meta', 'ctx', 'del', 'add']);
    assert.equal(rows[5].text, '+new <img src=x onerror=alert(1)>', 'kept as text for textContent, never parsed');
    assert.deepEqual(M.diffRows(''), []);
    const long = M.diffRows(Array.from({ length: 900 }, (_, i) => `+line ${i}`).join('\n'), 400);
    assert.equal(long.length, 401);
    assert.equal(long.at(-1).text, '...');
  });

  await check('a gate drops every reply that is not the newest, and all of them after destroy', async () => {
    const gate = M.createGate();
    const first = gate.next();
    const second = gate.next();
    assert.equal(gate.ok(first), false, 'an older request lost the race');
    assert.equal(gate.ok(second), true);
    gate.destroy();
    assert.equal(gate.ok(second), false, 'a reply that arrives after destroy is dropped');
    assert.equal(gate.alive(), false);
    // The shape the section uses: a request in flight, then destroy, then the reply.
    const live = M.createGate();
    let drawn = 0;
    const token = live.next();
    const reply = new Promise(resolve => setTimeout(() => resolve('late'), 5));
    live.destroy();
    if (live.ok(token)) drawn += await reply; else await reply;
    assert.equal(drawn, 0);
  });

  await check('the section file mounts, returns the whole handle and draws no raw markup', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'botsSectionMemory.js'), 'utf8');
    assert.match(source, /export function mount\(host, ctx\)/);
    assert.match(source, /destroy\(\) \{[\s\S]*gate\.destroy\(\)/, 'a closed section drops pending requests');
    assert.match(source, /refresh: .*reload/);
    assert.match(source, /flush: /);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, 'notes, logs and diffs are never parsed as markup');
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/, 'no raw colours');
    assert.doesNotMatch(source, /—/, 'no em-dashes in the copy');
    const css = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'bots-memory.css'), 'utf8');
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/, 'the stylesheet has no raw colours');
    assert.doesNotMatch(source + css, /OpenMausBot|MausBot|OpenDuet|Duet/);
  });

  console.log(`PASS: ${passed.length} checks\n  ${passed.join('\n  ')}`);
})().catch(error => { console.error(error); process.exit(1); });
