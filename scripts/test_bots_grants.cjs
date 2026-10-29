// Bots grants (Phase 2, U4): selector generation, effective-state explanations and immediate save with rollback.
// Run: node scripts/test_bots_grants.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const tool = (name, effect, state = 'on', reason = '') => ({ name, effect, state, reason, available: true });
const access = (over = {}) => ({
  revision: 4, mode: 'legacy', explanation: ['This is the most the bot can do.'],
  grants: { tool_scope: { allow: [], deny: [] }, connector_scopes: {}, integration_ids: null, connector_tools: null },
  native: [],
  apps: [
    { id: 'gh', name: 'github', kind: 'mcp', available: true, scope: null, grant: null, accounts: [],
      tools: [tool('list_issues', 'read'), tool('create_issue', 'write')] },
    { id: 'google', name: 'Google', kind: 'native', available: true, scope: null, grant: null, accounts: [],
      tools: [tool('google_calendar', 'write')] },
    { id: 'down', name: 'Offline', kind: 'mcp', available: false, unavailable: 'It is switched off in Settings.', scope: null, tools: [tool('t', 'read', 'off')] },
  ],
  ...over,
});

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsGrantsModel.js')).href);

  // Selectors
  assert.equal(M.denySelector('native', null, 'Bash'), 'native:Bash');
  assert.equal(M.denySelector('mcp', 'gh', 'create_issue'), 'mcp:gh:create_issue');

  // The legacy reading starts with every available app on, so a first save changes nothing a person had.
  let form = M.formFrom(access());
  assert.equal(form.apps.gh.on, true);
  assert.equal(form.apps.gh.all, true);
  assert.equal(form.apps.down.on, false, 'an unavailable app cannot start on');
  let payload = M.buildPayload(access(), form);
  assert.deepEqual(payload.connector_tools, { gh: { tools: '*' }, google: { tools: '*' } });
  assert.deepEqual(payload.connector_scopes, { gh: 'write', google: 'write', down: 'off' });

  // An existing off scope stays off and keeps the app off.
  form = M.formFrom(access({ grants: { tool_scope: { allow: [], deny: [] }, connector_scopes: { gh: 'off' }, connector_tools: null },
  apps: access().apps.map(a => (a.id === 'gh' ? { ...a, scope: 'off' } : a)) }));
  assert.equal(form.apps.gh.on, false);

  // Explicit reading: only what the grant names.
  const explicit = access({ mode: 'explicit', grants: { tool_scope: { allow: ['native:Read'], deny: ['mcp:gh:delete', 'native:Bash'] },
    connector_scopes: { gh: 'read', stray: 'read' }, connector_tools: { gh: { tools: ['list_issues'], accounts: ['a1'] } } },
    apps: access().apps.map(a => (a.id === 'gh' ? { ...a, scope: 'read' } : a)) });
  form = M.formFrom(explicit);
  assert.deepEqual([form.apps.gh.on, form.apps.gh.scope, form.apps.gh.all, form.apps.gh.tools, form.apps.gh.accounts], [true, 'read', false, ['list_issues'], ['a1']]);
  assert.equal(form.apps.google.on, false);
  assert.deepEqual(form.denied, ['Bash']);
  payload = M.buildPayload(explicit, form);
  assert.deepEqual(payload.connector_tools, { gh: { tools: ['list_issues'], accounts: ['a1'] } });
  assert.deepEqual(payload.connector_scopes, { stray: 'read', gh: 'read', google: 'off', down: 'off' }, 'a scope the form does not show is carried over');
  assert.deepEqual(payload.tool_scope, { allow: ['native:Read'], deny: ['mcp:gh:delete', 'native:Bash'] }, 'selectors that are not the form\'s are kept');

  // Edits are pure.
  const base = M.formFrom(access());
  const names = ['list_issues', 'create_issue'];
  const off = M.withTool(base, 'gh', 'create_issue', false, names);
  assert.deepEqual([off.apps.gh.all, off.apps.gh.tools], [false, ['list_issues']]);
  assert.equal(base.apps.gh.all, true, 'the old form is untouched');
  const back = M.withTool(off, 'gh', 'create_issue', true, names);
  assert.deepEqual([back.apps.gh.all, back.apps.gh.tools], [true, []], 'all tools picked is the whole app again');
  assert.equal(M.withApp(base, 'gh', { scope: 'read' }).apps.gh.scope, 'read');
  assert.deepEqual(M.withNative(base, 'Bash', false).denied, ['Bash']);
  assert.deepEqual(M.withNative(M.withNative(base, 'Bash', false), 'Bash', true).denied, []);
  payload = M.buildPayload(access(), M.withNative(base, 'Bash', false));
  assert.deepEqual(payload.tool_scope.deny, ['native:Bash']);

  // Switch state: an unavailable tool cannot be switched on; a blocked one says why.
  assert.deepEqual(M.switchState({ available: false, reason: 'Gone.' }), { disabled: true, reason: 'Gone.' });
  assert.deepEqual(M.switchState(tool('t', 'read', 'off', 'Blocked.')), { disabled: false, reason: 'Blocked.' });
  assert.equal(M.switchState(tool('t', 'read'), false).disabled, true);

  // Explanations
  const lines = M.ceilingLines(access());
  assert.ok(lines[0].includes('most the bot can do'));
  assert.ok(lines.some(l => /cannot be used right now/.test(l)));
  assert.equal(M.appSummary(access().apps[0]), '2 of 2 tools allowed');
  assert.equal(M.appSummary(access().apps[2]), 'It is switched off in Settings.');
  assert.equal(M.effectLabel({ effect: 'unknown' }), 'Effect unknown');
  assert.ok(!/—|–/.test(JSON.stringify([lines, M.SCOPE_LABEL])), 'no dashes in copy');

  // Saving: immediate, serialised, rolled back on refusal, stale revision reloads.
  const calls = [];
  let outcome = 'ok';
  const fresh = access({ revision: 9, mode: 'explicit' });
  const fakeApi = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (options.method === 'PUT') {
      if (outcome === 'ok') return access({ revision: calls.filter(c => c.method === 'PUT').length + 4 });
      if (outcome === 'stale') throw new Error('409: The access settings changed. Reload them before saving.');
      throw new Error('422: gh is not available, so it cannot be switched on.');
    }
    return fresh;
  };
  const seen = { changed: [], stale: [], error: [] };
  const saver = M.createGrantSaver({ api: fakeApi, path: '/api/bots/a1/access', access: access(), onChange: (a, f) => seen.changed.push(a.revision),
    onStale: (a, f, m) => seen.stale.push([a?.revision, m]), onError: (m, before) => seen.error.push([m, before]) });
  const first = M.withApp(base, 'gh', { scope: 'read' });
  const second = M.withApp(first, 'google', { on: false });
  await Promise.all([saver.save(first, base), saver.save(second, first)]);
  const puts = calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.expected_revision, 4);
  assert.equal(puts[1].body.expected_revision, 5, 'each save is judged against the revision the last answer carried');
  assert.deepEqual(puts[0].body.connector_scopes.gh, 'read');
  assert.deepEqual(seen.changed, [5, 6]);

  outcome = 'refuse';
  const refused = await saver.save(M.withApp(second, 'gh', { on: true }), second);
  assert.equal(refused.ok, false);
  assert.equal(seen.error.length, 1);
  assert.equal(seen.error[0][0], 'gh is not available, so it cannot be switched on.');
  assert.equal(seen.error[0][1], second, 'the form to put back is the one before the change');

  outcome = 'stale';
  const stale = await saver.save(second, base);
  assert.equal(stale.stale, true);
  assert.deepEqual(seen.stale[0], [9, 'The access settings changed. Reload them before saving.']);
  assert.equal(saver.access.revision, 9, 'the saver now judges against the current state');

  console.log('test_bots_grants.cjs: ok');
})().catch(error => { console.error(error); process.exit(1); });
