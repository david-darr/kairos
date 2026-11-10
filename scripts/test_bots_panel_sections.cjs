// Bots Phase 1, unit U2: the panel's section model and the profile diff, in plain Node.
// Run: node scripts/test_bots_panel_sections.cjs
// Loads static/js/botsPanelSections.js and botsProfileDiff.js from disk (neither needs the page).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', file)).href);
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

(async () => {
  const S = await load('botsPanelSections.js');
  const D = await load('botsProfileDiff.js');

  await check('the fourteen sections, in the designed order, each with a renderer', () => {
    const list = S.sections();
    assert.deepEqual(list.map(s => s.id), ['overview', 'identity', 'delivery', 'soul', 'skills', 'memory', 'routines', 'access', 'model', 'permissions', 'voice', 'who', 'history', 'usage']);
    assert.ok(list.every(s => typeof s.render === 'function' && s.label && s.iconName && s.keywords));
    assert.deepEqual(list.map(s => s.order), [...list.map(s => s.order)].sort((a, b) => a - b));
    assert.equal(list.find(s => s.id === 'memory').keepMounted, true, 'Memory stays mounted');
    assert.equal(S.SIMPLE_HOME.soul, 'settings');
    assert.equal(S.SIMPLE_HOME.model, 'details');
  });

  await check('the soul counter counts bytes, not characters', () => {
    assert.equal(S.soulCounter('abc').used, 3);
    assert.equal(S.soulCounter('é').used, 2);
    assert.equal(S.soulCounter('a'.repeat(24001)).over, true);
    assert.match(S.soulCounter('a'.repeat(1000)).text, /^1,000 \/ 24,000 bytes$/);
    assert.equal(D.byteLength('é'), 2);
    assert.equal(D.clipToBytes('éé', 3), 'é', 'a character is never split');
    assert.equal(D.clipToBytes('abc', 10), 'abc');
  });

  await check('all five levels are available and Full remains the default', () => {
    assert.deepEqual(S.APPROVAL_LEVELS.filter(l => l.now).map(l => l.value), ['full', 'auto', 'ask', 'edits', 'custom']);
    assert.equal(S.APPROVAL_LEVELS.length, 5);
    assert.equal(S.permissionFacts({}).effective, 'full');
    assert.equal(S.permissionFacts({ approval_mode: 'ask' }).effective, 'ask');
    const f = S.permissionFacts({ approval_mode: 'full', outbound: { policy: 'allow', daily_cap: 7 }, always_allow: ['x'], daily_run_cap: 30 });
    assert.deepEqual([f.effective, f.outboundPolicy, f.outboundCap, f.alwaysAllow, f.runCap], ['full', 'allow', 7, ['x'], 30]);
    assert.equal(S.permissionFacts({}).runCap, 12);
  });

  await check('skills: rows follow the saved selection, toggling keeps mode all', () => {
    const rows = S.skillRows([{ slug: 'a', name: 'A' }, { slug: 'b', description: 'B', error: 'broken' }], { mode: 'all', disabled: ['a'] });
    assert.deepEqual(rows.map(r => [r.slug, r.on, r.error]), [['a', false, ''], ['b', true, 'broken']]);
    assert.deepEqual(S.selectionAfterToggle({ mode: 'all', disabled: [] }, 'a', false), { mode: 'all', disabled: ['a'] });
    assert.deepEqual(S.selectionAfterToggle({ mode: 'all', disabled: ['a'] }, 'a', true), { mode: 'all', disabled: [] });
    assert.deepEqual(S.skillRows(null, null), []);
  });

  await check('routines read as a sentence, stored zone and weekdays included', () => {
    assert.equal(S.routineSchedule({ schedule_kind: 'daily', run_time: '08:00' }), 'At 08:00 every day');
    assert.equal(S.routineSchedule({ schedule_kind: 'daily', run_time: '09:30', weekdays: [0, 2], time_zone: 'Europe/Paris' }), 'At 09:30 on Mon, Wed, Europe/Paris');
    assert.equal(S.routineSchedule({ schedule_kind: 'interval', interval_seconds: 21600 }), 'Every 6 hours');
    assert.equal(S.routineSchedule({ schedule_kind: 'interval', interval_seconds: 3600 }), 'Every hour');
    assert.equal(S.routineSchedule({ schedule_kind: 'interval', interval_seconds: 1800 }), 'Every 30 minutes');
  });

  await check('fallbacks: add, no duplicates, five at most, remove', () => {
    let list = [];
    for (let i = 0; i < 7; i++) list = S.fallbackAfter(list, { add: { endpoint_id: `m${i}` } });
    assert.equal(list.length, S.MAX_FALLBACKS);
    assert.deepEqual(S.fallbackAfter([{ endpoint_id: 'm1' }], { add: { endpoint_id: 'm1' } }), [{ endpoint_id: 'm1' }]);
    assert.deepEqual(S.fallbackAfter([{ endpoint_id: 'a' }, { endpoint_id: 'b' }], { remove: 0 }), [{ endpoint_id: 'b' }]);
  });

  await check('usage, visibility, voice and delivery facts say only what is true', () => {
    const u = S.usageFacts({ daily_run_cap: 10, runs_today: 4 }, [{ outcome: 'succeeded', duration_seconds: 10 }, { outcome: 'failed', duration_seconds: 20 }, { outcome: 'succeeded' }]);
    assert.deepEqual([u.cap, u.used, u.left, u.percent, u.average, u.tally.succeeded], [10, 4, 6, 40, 15, 2]);
    assert.equal(S.usageFacts({ daily_run_cap: 2, runs_today: 5 }, []).percent, 100);
    assert.equal(S.visibilityFacts({ auth_enabled: true, username: 'david', is_admin: true }).account, 'Signed in as david');
    assert.match(S.visibilityFacts({ auth_enabled: false }).account, /no accounts/);
    const v = S.voiceFacts({ call_mode: 'live' }, { voices: [{ id: 'v1', name: 'One' }] }, []);
    assert.deepEqual([v.hasVoices, v.liveAvailable, v.callMode], [true, false, 'turns'], 'live is not offered when it cannot start');
    const gpt = S.voiceFacts({ call_mode: 'live' }, null, [{ id: 'live:x', provider: 'openai_live' }]);
    assert.deepEqual([gpt.callMode, gpt.liveAvailable], ['realtime', true], 'the older Live mode shows as Realtime, with GPT-Live offered');
    assert.equal(S.voiceFacts({ call_mode: 'realtime' }, null, [{ id: 'x', provider: 'openai' }]).liveAvailable, false);
    const d = S.deliveryFacts({ deliver_to_channel: 'gone' }, [{ id: 'discord', label: 'Discord', configured: true }, { id: 'x', label: 'X', configured: false }]);
    assert.deepEqual([d.missing, d.connected, d.chosenLabel], [true, 1, 'gone']);
    assert.equal(S.deliveryFacts({}, []).chosenLabel, 'In the app only');
  });

  await check('a line diff keeps unchanged lines and bounds its work', () => {
    const lines = D.diffLines('a\nb\nc', 'a\nc\nd');
    assert.deepEqual(lines.map(l => `${l.type}:${l.text}`), ['same:a', 'del:b', 'same:c', 'add:d']);
    assert.deepEqual(D.diffSummary(lines), { added: 1, removed: 1 });
    assert.deepEqual(D.diffLines('', ''), []);
    const big = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(D.diffLines(big, big + '\nmore').length, 2, 'a huge input is summarised, not compared line by line');
  });

  await check('drift is read from the file state; history rows describe themselves', () => {
    assert.equal(D.driftState({ in_sync: true }), 'same');
    assert.equal(D.driftState({ in_sync: false, file_text: null }), 'file-missing');
    assert.equal(D.driftState({ in_sync: false, file_text: 'x' }), 'file-differs');
    assert.equal(D.driftState(null), 'same');
    assert.equal(D.canRestore({ field: 'soul' }), true);
    assert.equal(D.canRestore({ field: 'role' }), false);
    assert.equal(D.describeRow({ actor: 'user', field: 'soul' }), 'You changed the standing instructions');
    assert.equal(D.describeRow({ actor: 'bot', field: 'role', before: 'A', after: 'B' }), 'The bot changed the job: A to B');
    assert.equal(D.shortValue(''), 'empty');
    assert.ok(D.shortValue('x'.repeat(200), 20).length <= 20);
    assert.equal(D.fieldLabel('mascot_expression'), 'expression');
  });

  await check('the copy has no em-dashes', () => {
    for (const file of ['botsPanelSections.js', 'botsProfileDiff.js', 'botsAvatarEditor.js', 'botsPanel.js']) {
      assert.equal(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', file), 'utf8').includes('—'), false, file);
    }
  });

  console.log(`PASS: ${passed.length} checks: ${passed.join('; ')}`);
})().catch(error => { console.error(error); process.exit(1); });
