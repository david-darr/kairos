// The Bots fixture backend (scripts/fixtures/bots-core-backend.cjs) honours the contract in
// phase-0-design.md section 2.4: the same keys and the same status codes as routes/agent_routes.py.
// Run: node scripts/test_bots_fixtures.cjs
const assert = require('node:assert/strict');
const backendFactory = require('./fixtures/bots-core-backend.cjs');

const seedAgents = () => [
  { id: 'a1', name: 'Scout', role: 'Watches job postings and applications', instructions: 'Be brief.', color: '#d9b260', blurb: '', soul: '', revision: 1,
    endpoint_id: null, enabled: true, daily_run_cap: 12, deliver_to_channel: null, status: 'needs_you', status_detail: '', needs_you: 2, runs_today: 3, keep_signed_in: true },
  { id: 'a2', name: 'Archivist', role: 'Files and tidies notes', instructions: '', color: '#b9d2e3', blurb: '', soul: '', revision: 1, endpoint_id: 'm3',
    enabled: true, daily_run_cap: 12, deliver_to_channel: null, status: 'working', status_detail: 'Sort inbox notes', needs_you: 0, runs_today: 1, keep_signed_in: false },
];
const fresh = () => {
  const state = { botsLive: true };
  const backend = backendFactory({ state, data: { agentsFixture: seedAgents() }, now: 1_800_000_000 });
  const get = (route, query) => backend.read(route, query);
  const send = (route, method, body) => backend.mutate(route, method, body);
  return { state, backend, get, send };
};
const status = (answer) => answer?._status ?? 200;

(() => {
  // A long smoke run contributes extra agents and can reorder/edit the seeds.
  const agents = [...seedAgents().reverse(), ...Array.from({ length: 7 }, (_, i) => ({
    id: `a${101 + i}`, name: `Earlier ${i}`, created_at: 100 + i,
  }))];
  const original = structuredClone(agents);
  const state = { botsLive: true };
  const backend = backendFactory({ state, data: { agentsFixture: agents }, now: 1_800_000_000 });
  assert.equal(backend.read('/api/agents').length, agents.length, 'every inherited bot survives seeding');
  assert.equal(backend.read('/api/agents/a107').agent.created_at, 106);
  assert.equal(backend.read('/api/agents/a107').agent.avatar.color, '#E8C39E', 'avatar fallback wraps past six seeds');
  assert.deepEqual(backend.read('/api/agents/a1/threads').threads.map(t => t.id), ['bots-t1', 'bots-t2']);
  assert.deepEqual(backend.read('/api/agents/a2/threads').threads.map(t => t.id), ['bots-t3']);
  const made = backend.mutate('/api/agents', 'POST', { name: 'New after the long run' });
  assert.equal(made.id, 'a108', 'new IDs cannot collide with inherited IDs');
  backend.mutate('/api/agents/a1', 'PATCH', { role: 'Private edit' });
  assert.deepEqual(agents, original, 'fixture mutations never change the main demo');
})();

(() => {
  // Off unless a check turns it on, so the demo is untouched.
  const { state, get, send } = fresh();
  state.botsLive = false;
  assert.equal(get('/api/agents'), undefined);
  assert.equal(send('/api/agents', 'POST', { name: 'x' }), undefined);
  state.botsLive = true;
  assert.equal(get('/api/agents/inbox'), undefined, 'routes it does not own fall through to the demo');
  assert.equal(send('/api/agents/a1/goals', 'POST', {}), undefined);
})();

(() => {
  // Records carry the new fields with their defaults, and `instructions` reads as the soul.
  const { get } = fresh();
  const [scout, archivist] = get('/api/agents');
  for (const [key, value] of Object.entries(backendFactory.DEFAULTS())) assert.deepEqual(scout[key], value, key);
  assert.equal(scout.instructions, 'Be brief.');
  assert.equal(scout.soul, 'Be brief.', 'an instructions-only bot has them as its soul');
  assert.equal(archivist.id, 'a2');
  assert.equal(get('/api/agents/a1').agent.id, 'a1');
  assert.equal(status(get('/api/agents/nobody')), 404);
})();

(() => {
  // Create: cap 409, approval 409, name 400, duplicates 400, new fields validated.
  const { state, get, send } = fresh();
  const made = send('/api/agents', 'POST', { name: 'Fresh', section: 'Work', thread_limit: 16 });
  assert.equal(made.name, 'Fresh'); assert.equal(made.section, 'Work'); assert.equal(made.hidden, false);
  assert.equal(status(send('/api/agents', 'POST', { name: 'fresh' })), 400);
  assert.equal(status(send('/api/agents', 'POST', { name: '' })), 400);
  assert.equal(status(send('/api/agents', 'POST', { name: 'Careful', approval_mode: 'ask' })), 409);
  assert.equal(status(send('/api/agents', 'POST', { name: 'Hidden', hidden: true })), 400);
  assert.equal(status(send('/api/agents', 'POST', { name: 'Many', thread_limit: 17 })), 400);
  state.botsCore.maxBots = 4;
  const capped = send('/api/agents', 'POST', { name: 'Third' });
  assert.equal(capped.name, 'Third');
  assert.equal(status(send('/api/agents', 'POST', { name: 'Fourth' })), 409);
  assert.match(send('/api/agents', 'POST', { name: 'Fourth' }).detail, /up to 4 bots/);
  assert.equal(backendFactory.MAX_BOTS, 100);
  assert.equal(get('/api/agents').length, 4, 'the list now holds the seeds and the new bots');
})();

(() => {
  // PATCH: validators, the instructions synonym, revision rules, archive guard, approval 409.
  const { get, send } = fresh();
  const patch = (id, body) => send('/api/agents/' + id, 'PATCH', body);
  assert.equal(patch('a1', { place: 'browser' }).place, 'browser');
  assert.equal(patch('a1', { instructions: 'Now this.' }).soul, 'Now this.');
  assert.equal(patch('a1', { instructions: 'Ignored', soul: 'Soul wins' }).soul, 'Soul wins');
  const revision = get('/api/agents/a1').agent.revision;
  patch('a1', { section: 'Work' });
  assert.equal(get('/api/agents/a1').agent.revision, revision + 1);
  const bad = [{ section: 'x'.repeat(61) }, { thread_limit: 0 }, { thread_limit: 17 }, { place: 'cloud' }, { cache_keep_warm: 'maybe' },
    { outbound: { daily_cap: 0 } }, { outbound: { daily_cap: 1001 } }, { outbound: { policy: 'never' } }, { tool_scope: { allow: ['shell'] } },
    { connector_scopes: { mail: 'admin' } }, { always_allow: Array.from({ length: 201 }, (_, i) => String(i)) }, { fallback: Array(6).fill({ endpoint_id: 'e' }) }, { place: null }, { bogus: 1 }];
  for (const body of bad) assert.equal(status(patch('a1', body)), 400, JSON.stringify(body).slice(0, 60));
  assert.deepEqual(patch('a1', { outbound: { daily_cap: 1000, policy: 'allow' } }).outbound, { policy: 'allow', daily_cap: 1000 });
  assert.deepEqual(patch('a1', { outbound: { daily_cap: 1 } }).outbound, { policy: 'allow', daily_cap: 1 }, 'a partial outbound merges');
  assert.equal(patch('a1', { section: null }).section, null);
  for (const mode of ['ask', 'auto', 'custom']) assert.equal(status(patch('a1', { approval_mode: mode })), 409, mode);
  assert.equal(status(patch('a1', { approval_mode: 'nope' })), 400);
  assert.equal(patch('a1', { approval_mode: 'full' }).approval_mode, 'full');
  const before = get('/api/agents/a2').agent.revision;
  assert.equal(patch('a2', { hidden: true }).hidden, true);
  assert.equal(get('/api/agents/a2').agent.revision, before, 'archiving is not a profile change');
  assert.equal(typeof get('/api/agents/a2').agent.hidden_at, 'number');
  assert.equal(status(patch('a1', { hidden: true })), 409, 'the last visible bot stays');
  assert.match(patch('a1', { hidden: true }).detail, /at least one bot visible/);
  assert.equal(patch('a2', { hidden: false }).hidden_at, null);
  assert.equal(status(patch('nobody', { place: 'off' })), 404);
})();

(() => {
  // Delete, duplicate, order.
  const { get, send } = fresh();
  const copy = send('/api/agents/a1/duplicate', 'POST', {});
  assert.equal(copy.name, 'Scout copy'); assert.deepEqual(copy.origin, { kind: 'duplicate', from_agent_id: 'a1' });
  assert.equal(send('/api/agents/a1/duplicate', 'POST', {}).name, 'Scout copy 2');
  assert.equal(send('/api/agents/a1/duplicate', 'POST', { name: 'Scout B' }).name, 'Scout B');
  assert.equal(status(send('/api/agents/nobody/duplicate', 'POST', {})), 404);
  assert.equal(send('/api/agents/order', 'POST', { ids: [copy.id, 'a1'] }).ok, true);
  const order = get('/api/agents').filter(a => a.order !== null).map(a => a.id);
  assert.deepEqual(order.slice(0, 2), [copy.id, 'a1']);
  assert.equal(status(send('/api/agents/order', 'POST', { ids: ['a1', 'a1'] })), 400);
  assert.equal(status(send('/api/agents/order', 'POST', { ids: ['nobody'] })), 404);
  assert.deepEqual(send('/api/agents/' + copy.id, 'DELETE'), { ok: true, removed_work: 0 });
  assert.equal(status(send('/api/agents/' + copy.id, 'DELETE')), 404);
  const { state, send: sendB } = fresh();
  sendB('/api/agents', 'POST', { name: 'Front desk' }); state.botsCore.agents.at(-1).builtin = 'front_desk';
  assert.equal(status(sendB('/api/agents/' + state.botsCore.agents.at(-1).id, 'DELETE')), 409);
})();

(() => {
  // F1 "configured": the answer shape, rollback, warnings.
  const { state, get, send } = fresh();
  const body = { profile: { name: 'Tidy', role: 'Keeps notes', soul: 'Be calm.' }, memory_seed: [{ section: 'Preferences', text: 'short answers' }],
    routines: [{ name: 'Morning', prompt: 'Look', schedule_kind: 'daily', run_time: '08:00' }] };
  const done = send('/api/agents/configured', 'POST', body);
  assert.deepEqual(Object.keys(done).sort(), ['agent', 'routines', 'warnings']);
  assert.equal(done.agent.name, 'Tidy'); assert.equal(done.agent.approval_mode, 'full'); assert.equal(done.routines.length, 1); assert.deepEqual(done.warnings, []);
  assert.equal(get('/api/agents/' + done.agent.id + '/overview').does.routines[0].name, 'Morning');
  const count = get('/api/agents').length;
  state.botsConfiguredFail = { status: 500, detail: 'Routine service unavailable', cleanup_errors: ['could not remove routine r1'] };
  const failed = send('/api/agents/configured', 'POST', { ...body, profile: { name: 'Other' } });
  assert.equal(failed._status, 500); assert.equal(failed.detail, 'Routine service unavailable'); assert.deepEqual(failed.cleanup_errors, ['could not remove routine r1']);
  assert.equal(get('/api/agents').length, count, 'a failure leaves no bot');
  delete state.botsConfiguredFail;
  state.botsConfiguredWarnings = ['The routine Morning was made but could not be turned on: scheduler down'];
  const warned = send('/api/agents/configured', 'POST', { ...body, profile: { name: 'Warned' } });
  assert.equal(warned.warnings.length, 1); assert.equal(warned.routines.at(-1).enabled, false);
  assert.equal(get('/api/agents').length, count + 1, 'a warning keeps the bot');
  delete state.botsConfiguredWarnings;
  for (const [expected, extra] of [[400, { profile: { name: '' } }], [400, { routines: [{ name: 'x', prompt: 'y', schedule_kind: 'weekly' }] }],
    [400, { memory_seed: [{ section: 'Secrets', text: 'x' }] }], [400, { memory_seed: [{ section: 'Notes', text: 'x'.repeat(8001) }] }],
    [400, { routines: Array(11).fill(body.routines[0]) }], [409, { approval_mode: 'auto' }]])
    assert.equal(status(send('/api/agents/configured', 'POST', { ...body, profile: { name: 'Bad' }, ...extra })), expected, JSON.stringify(extra).slice(0, 50));
  state.botsCore.maxBots = get('/api/agents').length;
  assert.equal(status(send('/api/agents/configured', 'POST', { ...body, profile: { name: 'Capped' } })), 409);
})();

(() => {
  // F2 defaults and presets.
  const { get, send } = fresh();
  const view = get('/api/agents/defaults');
  assert.deepEqual(Object.keys(view).sort(), ['defaults', 'model_selection', 'suggested_name']);
  assert.equal(view.suggested_name, 'Juniper');
  assert.equal(send('/api/agents/defaults', 'PUT', { defaults: { blurb: 'Hi', thread_limit: 5 } }).defaults.thread_limit, 5);
  for (const field of ['endpoint_id', 'approval_mode', 'tool_scope', 'integration_ids', 'peers', 'name', 'avatar'])
    assert.equal(status(send('/api/agents/defaults', 'PUT', { defaults: { [field]: 'x' } })), 400, field);
  const preset = send('/api/agents/presets', 'POST', { preset: { name: 'Starter', role: 'R' } });
  assert.equal(preset.source, 'saved'); assert.equal(get('/api/agents/presets').length, 1);
  for (const field of ['endpoint_id', 'approval_mode', 'place', 'integration_ids']) assert.equal(status(send('/api/agents/presets', 'POST', { preset: { name: 'x', [field]: 'y' } })), 400, field);
  assert.equal(status(send('/api/agents/presets', 'POST', {})), 400);
  assert.equal(send('/api/agents/presets', 'POST', { from_agent_id: 'a1' }).name, 'Scout');
  assert.equal(status(send('/api/agents/presets', 'POST', { from_agent_id: 'nobody' })), 404);
  assert.equal(send('/api/agents/presets/' + preset.id, 'DELETE').ok, true);
  assert.equal(status(send('/api/agents/presets/' + preset.id, 'DELETE')), 404);
})();

(() => {
  // F7 and F8 shapes.
  const { get } = fresh();
  const view = get('/api/agents/a1/overview');
  assert.deepEqual(Object.keys(view).sort(), ['does', 'grants', 'reaches', 'recent', 'setup', 'who', 'wont']);
  assert.deepEqual(view.setup.map(s => s.id), ['identity', 'soul', 'model', 'schedule']);
  const prompt = get('/api/agents/a1/system-prompt');
  assert.deepEqual(Object.keys(prompt).sort(), ['approx_tokens', 'note', 'sections', 'total_bytes']);
  assert.equal(prompt.sections.reduce((n, s) => n + s.bytes, 0), prompt.total_bytes);
  assert.equal(status(get('/api/agents/nobody/overview')), 404);
})();

(() => {
  // Threads, folders, bulk delete, follow-model.
  const { state, get, send } = fresh();
  const list = get('/api/agents/a1/threads');
  assert.equal(list.main_id, 'bots-t1');
  assert.deepEqual(Object.keys(list.threads[0]).sort(), ['created_at', 'follows_bot_model', 'id', 'message_count', 'model_effort', 'model_endpoint_id', 'model_override', 'preview', 'status', 'thread', 'title', 'updated_at']);
  assert.deepEqual(Object.keys(list.threads[0].thread).sort(), Object.keys(backendFactory.THREAD_DEFAULTS()).sort());
  assert.deepEqual(get('/api/sessions', { agent_id: 'a1' }).map(h => h.id).sort(), ['bots-t1', 'bots-t2'], 'the listing header carries the bot\'s threads');
  assert.ok(get('/api/sessions', { agent_id: 'a1' })[0].thread, 'and their thread record');
  assert.equal(get('/api/sessions'), undefined);
  const made = send('/api/agents/a1/threads', 'POST', { title: 'Plan' });
  assert.equal(made.thread.main, false); assert.equal(made.agent_id, 'a1'); assert.equal(made.thread.title_source, 'person');
  assert.equal(status(send('/api/agents/a1/threads', 'POST', { folder_id: 'nope' })), 400);
  assert.equal(status(send('/api/agents/a1/threads', 'POST', { approval_mode: 'ask' })), 409);
  const fresh2 = send('/api/agents', 'POST', { name: 'Newcomer' });
  assert.equal(send('/api/agents/' + fresh2.id + '/threads', 'POST', {}).thread.main, true, 'the first chat is the main thread');
  const patch = (sid, body, agent = 'a1') => send(`/api/agents/${agent}/threads/${sid}`, 'PATCH', body);
  assert.equal(patch('bots-t2', { pinned: true, unread: true, title: '  Renamed  thread ' }).title, 'Renamed thread');
  assert.equal(patch('bots-t2', { title: '' })._status, 400);
  assert.equal(patch('bots-t2', { snooze: 'activity' }).thread.snoozed_until, 0);
  assert.equal(patch('bots-t2', { snooze: 'stop' }).thread.snoozed_until, null);
  assert.equal(patch('bots-t2', { snooze: 'later' })._status, 400);
  assert.equal(patch('bots-t2', { approval_mode: 'edits' })._status, 409);
  assert.equal(patch('bots-t2', { place: 'moon' })._status, 400);
  assert.equal(patch('bots-t1', { archived: true })._status, 409, 'the main thread cannot be archived');
  assert.ok(patch('bots-t2', { archived: true }).thread.archived_at);
  assert.equal(get('/api/agents/a1/threads').threads.length, 2, 'archived threads are hidden');
  assert.equal(get('/api/agents/a1/threads', { include_archived: '1' }).threads.length, 3);
  assert.equal(patch('bots-t3', { pinned: true })._status, 404, 'another bot\'s thread is a 404');
  assert.equal(patch('nope', { pinned: true })._status, 404);
  const folder = send('/api/agents/a1/folders', 'POST', { name: 'Work', emoji: 'W' });
  assert.deepEqual(Object.keys(folder).sort(), ['emoji', 'id', 'name', 'order']);
  assert.equal(patch('bots-t1', { folder_id: folder.id }).thread.folder_id, folder.id);
  assert.equal(send(`/api/agents/a1/folders/${folder.id}`, 'PATCH', { name: 'Home' }).name, 'Home');
  assert.equal(send('/api/agents/a1/folders/order', 'PUT', { ids: ['nope'] })._status, 400);
  assert.deepEqual(send(`/api/agents/a1/folders/${folder.id}`, 'DELETE'), { ok: true, cleared: 1 });
  assert.equal(send(`/api/agents/a1/folders/${folder.id}`, 'DELETE')._status, 404);
  assert.equal(status(send('/api/agents/a1/folders', 'POST', { name: '' })), 400);
  // Bulk delete: the answer shape, busy, missing, keep one.
  state.botsWorking = ['bots-t2'];
  const gone = send('/api/agents/a1/threads/delete', 'POST', { thread_ids: ['bots-t2', 'ghost', made.id] });
  assert.deepEqual(gone, { deleted: [made.id], busy: ['bots-t2'], missing: ['ghost'], kept: [] });
  state.botsWorking = [];
  const all = send('/api/agents/a1/threads/delete', 'POST', { thread_ids: ['bots-t1', 'bots-t2'] });
  assert.deepEqual(all, { deleted: ['bots-t2'], busy: [], missing: [], kept: ['bots-t1'] }, 'the bot keeps one thread, its main');
  assert.equal(send('/api/agents/a1/threads/delete', 'POST', { thread_ids: [] })._status, 422);
  // Follow-model.
  send('/api/agents/a1', 'PATCH', { endpoint_id: 'm9' });
  assert.equal(get('/api/agents/a1/threads').threads[0].follows_bot_model, false);
  assert.deepEqual(send('/api/agents/a1/threads/follow-model', 'POST', {}), { updated: ['bots-t1'], busy: [] });
  assert.equal(get('/api/agents/a1/threads').threads[0].follows_bot_model, true);
})();

(async () => {
  // Exercise the same check boundary with dirty defaults/presets/threads and
  // stored preferences, without launching Electron.
  const { isolateBotsCheck } = require('./bots-check-support.cjs');
  const values = new Map([
    ['kairos:app-mode', 'bots'], ['kairos:bots-interface', 'advanced'],
    ['jarvis:sidebar-collapsed', 'true'], ['jarvis:agent-chat:a1', 'earlier-thread'],
  ]);
  const originalStorage = new Map(values);
  const localStorage = {
    getItem: k => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k),
  };
  const js = async source => require('node:vm').runInNewContext(source, { localStorage });
  const demoState = { botsLive: false, botsCore: { defaults: { role: 'Earlier default' }, presets: [{ id: 'old' }], threads: [{ id: 'old' }] },
    botsWorking: ['bots-t1'], botsConfiguredFail: { status: 500 }, isAdmin: false };
  const originalState = { ...demoState };
  const backend = backendFactory({ state: demoState, data: { agentsFixture: seedAgents() }, now: 1_800_000_000 });
  for (let run = 0; run < 2; run++) {
    const restore = await isolateBotsCheck({ js, demoState });
    assert.equal(values.get('kairos:app-mode'), 'kairos');
    assert.equal(values.get('jarvis:sidebar-collapsed'), 'false');
    assert.equal(values.has('jarvis:agent-chat:a1'), false);
    assert.deepEqual(backend.read('/api/agents/defaults').defaults, {});
    assert.deepEqual(backend.read('/api/agents/presets'), []);
    assert.equal(backend.read('/api/agents/a1/threads').threads.length, 2);
    assert.deepEqual(demoState.botsWorking, []);
    assert.equal(demoState.botsConfiguredFail, undefined);
    assert.equal(demoState.isAdmin, true);
    assert.equal(backend.mutate('/api/agents/configured', 'POST', { profile: { name: 'Made in this check' } }).agent.name, 'Made in this check');
    await restore();
    assert.deepEqual(demoState, originalState, 'restore the prior store, switches and absent keys');
    assert.equal(demoState.botsCore, originalState.botsCore, 'the prior store is untouched');
    assert.deepEqual(values, originalStorage, 'restore the prior preferences');
  }
  console.log('PASS: the Bots fixture backend keeps to the data and API contract; check state is isolated.');
})().catch(error => { console.error(error); process.exitCode = 1; });
