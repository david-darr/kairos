// New-bot draft and request body (Agents 3.0 Phase 0, unit U4): the plain-Node checks.
// Run: node scripts/test_bots_create_model.cjs
// Loads static/js/botsCreateModel.js straight from disk (it has no imports and no DOM).
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsCreateModel.js')).href);

  await check('a draft starts from the saved defaults and a suggested name', () => {
    const draft = M.draftFromDefaults({ role: 'Reads the news', soul: 'Be brief.', color: '#b9d2e3', section: 'Work', memory_upkeep: true,
      memory_seed: [{ section: 'Preferences', text: 'Short answers.' }],
      routines: [{ name: 'Morning', prompt: 'Summarize.', schedule_kind: 'interval', interval_seconds: 7200, report_when: 'always' }] }, { suggestedName: 'Maple' });
    assert.equal(draft.name, 'Maple');
    assert.deepEqual([draft.role, draft.soul, draft.section, draft.memory_upkeep], ['Reads the news', 'Be brief.', 'Work', true]);
    assert.equal(draft.avatar.color, '#B9D2E3', 'the default colour becomes the Kip body colour');
    assert.equal(draft.routines.length, 1);
    assert.deepEqual([draft.routines[0].schedule_kind, draft.routines[0].hours, draft.routines[0].report_when, draft.routines[0].enabled], ['interval', 2, 'always', true]);
    assert.equal(M.draftFromDefaults({}).avatar.color, '#D9B260', 'no default colour gives the first pastel');
    assert.equal(M.draftFromDefaults({ color: '#123456' }).avatar.color, '#D9B260', 'an unknown colour is ignored');
  });

  await check('validation names the first problem for each rule', () => {
    const ok = M.emptyDraft({ name: 'Wren' });
    assert.deepEqual(M.validateDraft(ok), []);
    assert.equal(M.validateDraft(M.emptyDraft())[0].field, 'name');
    assert.match(M.validateDraft(M.emptyDraft({ name: '   ' }))[0].message, /Give the bot a name/);
    assert.match(M.validateDraft(M.emptyDraft({ name: 'wren' }), { taken: ['Wren'] })[0].message, /already exists/, 'names clash regardless of case');
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'x'.repeat(101) }))[0].field, 'name');
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', role: 'r'.repeat(201) }))[0].field, 'role');
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', blurb: 'b'.repeat(4001) }))[0].field, 'blurb');
    assert.deepEqual(M.validateDraft(M.emptyDraft({ name: 'A', soul: 'x'.repeat(24000) })), [], 'exactly the soul limit is fine');
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', soul: 'x'.repeat(24001) }))[0].field, 'soul');
    // The soul limit counts bytes, not characters.
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', soul: 'é'.repeat(12001) }))[0].field, 'soul');
    assert.deepEqual(M.validateDraft(M.emptyDraft({ name: 'A', soul: 'é'.repeat(12000) })), []);
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', section: 's'.repeat(61) }))[0].field, 'section');
    assert.deepEqual(M.validateDraft(M.emptyDraft({ role: 'x' }), { mode: 'defaults' }), [], 'defaults need no name');
  });

  await check('starting notes are limited to 8,000 characters and need a heading', () => {
    const note = text => ({ section: 'Notes', text });
    assert.deepEqual(M.validateDraft(M.emptyDraft({ name: 'A', memory_seed: [note('a '.repeat(2000))] })).length, 0, 'whitespace is squashed before counting');
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', memory_seed: [note('x'.repeat(8000)), note('y')] }))[0].field, 'memory_seed');
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', memory_seed: [{ section: '', text: 'orphan' }] }))[0].field, 'memory_seed');
    assert.deepEqual(M.cleanSeed([{ section: 'preferences', text: '  hi   there ' }, { section: 'Notes', text: '' }, { section: 'Nope', text: 'x' }]), [{ section: 'Preferences', text: 'hi there' }]);
  });

  await check('routines: only the ones switched on are checked, and each needs a name, text and a time', () => {
    const base = { name: 'Daily', prompt: 'Check.', schedule_kind: 'daily', run_time: '08:00' };
    const r = extra => ({ ...M.blankRoutine(), ...base, ...extra });
    assert.deepEqual(M.validateDraft(M.emptyDraft({ name: 'A', routines: [r()] })), []);
    assert.match(M.validateDraft(M.emptyDraft({ name: 'A', routines: [r({ name: '' })] }))[0].message, /needs a name and what to do/);
    assert.match(M.validateDraft(M.emptyDraft({ name: 'A', routines: [r({ run_time: '25:00' })] }))[0].message, /valid time/);
    assert.match(M.validateDraft(M.emptyDraft({ name: 'A', routines: [r({ schedule_kind: 'interval', hours: 0 })] }))[0].message, /valid time/);
    assert.deepEqual(M.validateDraft(M.emptyDraft({ name: 'A', routines: [r({ name: '', enabled: false })] })), [], 'a routine left off is ignored');
    const eleven = Array.from({ length: 11 }, () => r());
    assert.equal(M.validateDraft(M.emptyDraft({ name: 'A', routines: eleven }))[0].field, 'routines');
  });

  await check('a saved preset fills identity, notes and routines, never the model or approval', () => {
    const draft = M.emptyDraft({ name: 'Maple', model: { endpoint_id: 'm9', model_override: 'x', model_effort: null }, modelTouched: true });
    const preset = { id: 'p1', name: 'Reviewer', role: 'Reviews pull requests', blurb: 'Careful.', soul: 'Read the diff first.',
      avatar: { version: 3, character: 'ajar', shape: 'tall', color: '#CDBFD9', acc: 'laurel', finish: 'flat' },
      memory_seed: [{ section: 'Corrections', text: 'No nitpicks.' }], routines: [{ name: 'Sweep', prompt: 'Look.', schedule_kind: 'daily', run_time: '09:30' }],
      endpoint_id: 'evil', approval_mode: 'auto', place: 'browser' };
    const next = M.applyStart(draft, preset);
    assert.deepEqual([next.role, next.blurb, next.soul], ['Reviews pull requests', 'Careful.', 'Read the diff first.']);
    assert.equal(next.name, 'Reviewer', 'the preset names the bot while the person has not typed a name');
    assert.equal(next.avatar.shape, 'tall');
    assert.deepEqual(next.memory_seed, [{ section: 'Corrections', text: 'No nitpicks.' }]);
    assert.equal(next.routines[0].enabled, true, 'a preset routine is created');
    assert.deepEqual(next.origin, { kind: 'preset', id: 'p1' });
    assert.deepEqual(next.model, draft.model, 'the model stays the person’s');
    for (const key of ['endpoint_id', 'approval_mode', 'place']) assert.ok(!(key in next), `${key} is never copied from a preset`);
    assert.equal(M.applyStart({ ...draft, nameTouched: true }, preset).name, 'Maple', 'a typed name is kept');
  });

  await check('a ready-made bot offers its routines switched off and keeps the person’s settings', () => {
    const persona = { id: 'harbor', name: 'Harbor', role: 'Sorts the inbox', blurb: 'Calm.', soul: 'Never send.', look: { color: 'd99a92', shape: 'squircle', acc: 'none' },
      routines: [{ name: 'Sweep', prompt: 'Look.', schedule_kind: 'interval', interval_seconds: 14400 }] };
    const next = M.applyReady(M.emptyDraft({ name: 'Fresh', keep_signed_in: true, integration_ids: ['i1'] }), persona);
    assert.deepEqual(next.origin, { kind: 'ready', id: 'harbor' });
    assert.equal(next.avatar.color, '#D99A92');
    assert.equal(next.routines[0].enabled, false);
    assert.equal(next.routines[0].hours, 4);
    assert.deepEqual([next.keep_signed_in, next.integration_ids], [true, ['i1']], 'access choices stay');
    const payload = M.buildPayload(next);
    assert.deepEqual(payload.routines, [], 'a routine left off is not sent');
    assert.deepEqual(payload.origin, { kind: 'ready', id: 'harbor' });
    const on = { ...next, routines: next.routines.map(r => ({ ...r, enabled: true })) };
    assert.deepEqual(M.buildPayload(on).routines, [{ name: 'Sweep', prompt: 'Look.', schedule_kind: 'interval', interval_seconds: 14400, report_when: 'notable' }]);
  });

  await check('the Simple payload is a name, a job and a look, with defaults filling the rest', () => {
    const payload = M.buildPayload(M.emptyDraft({ name: '  Wren  ', role: ' Reads things ', blurb: 'ignored', soul: 'ignored too', avatar: M.look('b5c7a5', 'tall', 'scarf') }), { advanced: false });
    assert.deepEqual(payload, {
      profile: { name: 'Wren', role: 'Reads things', avatar: { version: 3, character: 'ajar', shape: 'tall', color: '#B5C7A5', acc: 'scarf', finish: 'flat' }, color: '#b5c7a5' },
      approval_mode: 'full', use_defaults: true, origin: { kind: 'blank' } });
  });

  await check('the Advanced payload carries every field the dialog edits, and approval is always full', () => {
    const draft = M.emptyDraft({ name: 'Scout Two', role: 'Watches', blurb: 'Quiet.', soul: 'Check often.', section: ' Work  group ', deliver_to_channel: 'discord',
      model: { endpoint_id: 'm3', model_override: 'opus', model_effort: 'high' }, modelTouched: true, integration_ids: ['i-notion'], keep_signed_in: true, memory_upkeep: true,
      memory_seed: [{ section: 'About this work', text: 'Job boards only.' }],
      routines: [{ ...M.blankRoutine(), name: 'Postings', prompt: 'Check postings.', schedule_kind: 'daily', run_time: '08:15', report_when: 'always' },
                 { ...M.blankRoutine(), name: 'Hourly', prompt: 'Again.', schedule_kind: 'interval', hours: 3 }] });
    const p = M.buildPayload(draft, { advanced: true });
    assert.equal(p.approval_mode, 'full');
    assert.equal(p.use_defaults, false);
    assert.deepEqual(p.profile, { name: 'Scout Two', role: 'Watches', avatar: draft.avatar, color: '#d9b260', blurb: 'Quiet.', soul: 'Check often.', section: 'Work group', deliver_to_channel: 'discord' });
    assert.deepEqual(p.model, { endpoint_id: 'm3', model_override: 'opus', model_effort: 'high' });
    assert.deepEqual([p.integration_ids, p.keep_signed_in, p.memory_upkeep], [['i-notion'], true, true]);
    assert.deepEqual(p.memory_seed, [{ section: 'About this work', text: 'Job boards only.' }]);
    assert.deepEqual(p.routines, [
      { name: 'Postings', prompt: 'Check postings.', schedule_kind: 'daily', run_time: '08:15', report_when: 'always' },
      { name: 'Hourly', prompt: 'Again.', schedule_kind: 'interval', interval_seconds: 10800, report_when: 'notable' }]);
    // Untouched model and "every tool server" use the server's normal model and access choices.
    const bare = M.buildPayload(M.emptyDraft({ name: 'Bare' }), { advanced: true });
    assert.ok(!('model' in bare) && !('integration_ids' in bare), 'no model or tool-server list unless chosen');
    assert.deepEqual([bare.memory_seed, bare.routines], [[], []], 'empty lists are sent so cleared defaults stay cleared');
    assert.ok(!JSON.stringify(bare).includes('"ask"') && bare.approval_mode === 'full');
  });

  await check('Advanced sends cleared profile fields explicitly without reapplying defaults; Simple still asks for defaults', () => {
    const draft = M.draftFromDefaults({ role: 'Saved job', blurb: 'Saved introduction', soul: 'Saved instructions', section: 'Saved group' }, { suggestedName: 'Wren' });
    assert.deepEqual([draft.role, draft.blurb, draft.soul, draft.section], ['Saved job', 'Saved introduction', 'Saved instructions', 'Saved group']);
    for (const key of ['role', 'blurb', 'soul', 'section']) draft[key] = '';
    const advanced = M.buildPayload(draft, { advanced: true });
    assert.equal(advanced.use_defaults, false, 'the dialog already applied the saved defaults before editing');
    assert.deepEqual(advanced.profile, { name: 'Wren', role: '', blurb: '', soul: '', section: '', deliver_to_channel: '', avatar: draft.avatar, color: '#d9b260' });
    const simple = M.buildPayload(draft, { advanced: false });
    assert.equal(simple.use_defaults, true);
    assert.deepEqual(Object.keys(simple.profile).sort(), ['avatar', 'color', 'name', 'role']);
  });

  await check('saved defaults hold preferences only, never the name, model or switched-off routines', () => {
    const draft = M.emptyDraft({ name: 'Never saved', role: 'Job', soul: 'Text', keep_signed_in: true, model: { endpoint_id: 'm1' }, modelTouched: true, section: 'G',
      memory_seed: [{ section: 'Notes', text: 'n' }],
      routines: [{ ...M.blankRoutine(), name: 'On', prompt: 'p', schedule_kind: 'daily', run_time: '07:00' }, { ...M.blankRoutine(), name: 'Off', prompt: 'p', enabled: false }] });
    const defaults = M.defaultsFromDraft(draft);
    assert.ok(Object.keys(defaults).every(key => M.DEFAULT_KEYS.includes(key)), `only default keys: ${Object.keys(defaults)}`);
    assert.deepEqual([defaults.role, defaults.soul, defaults.section, defaults.keep_signed_in, defaults.color], ['Job', 'Text', 'G', true, '#d9b260']);
    assert.equal(defaults.routines.length, 1);
    assert.ok(!('name' in defaults) && !('model' in defaults) && !('endpoint_id' in defaults));
    assert.deepEqual(M.defaultsFromDraft(M.emptyDraft()), { color: '#d9b260' }, 'a blank draft saves only its colour');
  });

  await check('the first free name counts up like the server list does', () => {
    assert.equal(M.freeName('Maple', []), 'Maple');
    assert.equal(M.freeName('Maple', ['maple']), 'Maple 2');
    assert.equal(M.freeName('Maple', ['Maple', 'Maple 2', 'maple 3']), 'Maple 4');
    assert.equal(M.freeName('', []), 'Bot');
  });

  await check('editing defaults preserves saved preferences without controls and clears removed text', () => {
    const saved = M.defaultsFromDraft(M.emptyDraft(), { role: 'Old role', daily_run_cap: 40, thread_limit: 5,
      cache_keep_warm: 'off', place: 'browser', approval_mode: 'ask', endpoint_id: 'private' });
    assert.deepEqual(saved, { daily_run_cap: 40, thread_limit: 5, cache_keep_warm: 'off', place: 'browser', color: '#d9b260' });
  });

  await check('a failed create is explained, and a partial one says something was left behind', () => {
    assert.deepEqual(M.describeFailure(409, { detail: 'you can have up to 100 bots; delete or archive one first' }), { text: 'you can have up to 100 bots; delete or archive one first', partial: false });
    assert.match(M.describeFailure(409, {}).text, /limit of 100 bots/);
    assert.deepEqual(M.describeFailure(500, { detail: 'The routine could not be made' }), { text: 'The routine could not be made', partial: false });
    const partial = M.describeFailure(500, { detail: 'It broke', cleanup_errors: ['routine r1 was not removed'] });
    assert.equal(partial.partial, true);
    assert.match(partial.text, /left behind: routine r1 was not removed/);
  });

  await check('byte helpers count UTF-8 and never split a character', () => {
    assert.equal(M.byteLength('aé€'), 6);
    assert.equal(M.clipBytes('€€€', 7), '€€');
    assert.equal(M.clipBytes('hello', 10), 'hello');
    assert.equal(M.clipBytes('a😀b', 4), 'a', 'a surrogate pair is never split');
    assert.equal(M.clipBytes('a😀b', 5), 'a😀');
  });

  await check('ready-made notes and paused routines are appended to saved defaults', () => {
    const draft = M.draftFromDefaults({ memory_seed: [{ section: 'Notes', text: 'My preference' }],
      routines: [{ name: 'Existing', prompt: 'Check', schedule_kind: 'daily', run_time: '08:00' }] });
    const next = M.applyReady(draft, { id: 'example', name: 'Example',
      memory_seed: [{ section: 'Notes', text: 'New note' }],
      routines: [{ name: 'Suggested', prompt: 'Check again', schedule_kind: 'daily', run_time: '09:00' }] });
    assert.deepEqual(next.memory_seed.map(n => n.text), ['My preference', 'New note']);
    assert.deepEqual(next.routines.map(r => r.enabled), [true, false]);
    next.memory_seed[0].text = 'Changed';
    assert.equal(draft.memory_seed[0].text, 'My preference', 'the old draft is not mutated');
  });

  await check('the four built-in starting roles are ready to use', () => {
    assert.equal(M.STARTERS.length, 4);
    for (const s of M.STARTERS) {
      assert.ok(s.id.startsWith('starter-') && s.name && s.role && s.soul, s.id);
      assert.ok(!/—/.test(JSON.stringify(s)), 'no em-dashes in copy');
      assert.equal(M.applyStart(M.emptyDraft({ name: 'X' }), s).origin.id, s.id);
    }
  });

  console.log(`PASS: ${passed.length} bots create-model checks`);
  for (const name of passed) console.log('  ok - ' + name);
})().catch(error => { console.error(error); process.exit(1); });
