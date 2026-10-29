// Bots connections, Phase 2 unit U5 (2026-10-29): the plain-Node checks for the connections model.
// Run: node scripts/test_bots_connections.cjs
// Loads static/js/botsConnectionsModel.js straight from disk (no imports, no DOM). Covers app sections and actions,
// probe wording, the MCP editor's draft and request body (keep markers, no value ever re-sent from a saved row),
// key and login forms, the setup import and the copyable diagnostic, which must never carry a secret.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', file)).href);
const SECRET = 'sk-live-0123456789abcdef';
const app = (id, extra = {}) => ({ id, kind: 'mcp', label: id, description: `The ${id} app`, category: 'Other', state: 'available', accounts: [], used_by: [], limited_for: [], ...extra });

(async () => {
  const M = await load('botsConnectionsModel.js');

  await check('errors read as plain sentences and 409 means stale', () => {
    assert.equal(M.statusOf(new Error('409: changed')), 409);
    assert.equal(M.messageOf(new Error('409: changed since you opened it')), 'changed since you opened it');
    assert.equal(M.messageOf(null), 'Something went wrong.');
    assert.equal(M.isStale(new Error('409: x')), true);
    assert.equal(M.isStale(new Error('400: x')), false);
  });

  await check('apps filter by search, category and view, and group with the connected ones first', () => {
    const apps = [app('linear', { label: 'Linear', category: 'Productivity', state: 'connected' }), app('notion', { label: 'Notion', category: 'Productivity' }),
      app('stripe', { label: 'Stripe', category: 'Finance', description: 'Payments' }), app('google', { kind: 'native', label: 'Google Workspace', category: 'Productivity', state: 'expired' })];
    assert.deepEqual(M.filterApps(apps, { query: 'pay' }).map(a => a.id), ['stripe']);
    assert.deepEqual(M.filterApps(apps, { category: 'Productivity' }).map(a => a.id), ['linear', 'notion', 'google']);
    assert.deepEqual(M.filterApps(apps, { view: 'connected' }).map(a => a.id), ['linear', 'google']);
    assert.deepEqual(M.filterApps(apps, { view: 'mcp' }).map(a => a.id), ['linear', 'notion', 'stripe']);
    const sections = M.appSections(apps, ['Productivity', 'Finance']);
    assert.deepEqual(sections.map(s => s.label), ['Connected (2)', 'Productivity', 'Finance']);
    assert.deepEqual(sections[1].apps.map(a => a.id), ['notion']);
    assert.deepEqual(M.appSections([], []), []);
  });

  await check('the main button says what will happen', () => {
    assert.deepEqual(M.appAction(app('x', { state: 'expired' })), { kind: 'reconnect', label: 'Reconnect' });
    assert.equal(M.appAction(app('x', { state: 'pending', auth: 'oauth' })).kind, 'sign-in');
    assert.equal(M.appAction(app('x', { state: 'pending' })).kind, 'test');
    assert.equal(M.appAction(app('catalog:linear', { auth: 'oauth' })).label, 'Add');
    assert.deepEqual(M.appAction(app('google', { kind: 'native', accounts: [{ id: 'a' }] })), { kind: 'authorize', label: 'Add account' });
    assert.equal(M.appAction(app('google', { kind: 'native' })).label, 'Connect');
    assert.equal(M.appAction(app('email', { kind: 'native' })).kind, 'setup');
    assert.equal(M.appAction(app('highlevel', { kind: 'card', state: 'connected' })).label, 'Change key');
    assert.equal(M.appAction(app('x', { kind: 'card' })).kind, 'keys');
    assert.equal(M.appAction(app('whop', { kind: 'card' })).kind, 'add-whop');
    assert.equal(M.appAction(app('whop', { kind: 'card', state: 'added' })).kind, 'none');
    assert.equal(M.appAction(app('google', { state: 'unavailable' })).kind, 'none', 'an unavailable app has no button, only its reason');
  });

  await check('accounts, aliases and who uses an app', () => {
    const two = app('google', { accounts: [{ id: 'a', label: 'w@x.test', alias: 'Work' }, { id: 'b', label: 'h@x.test', alias: '' }] });
    assert.equal(M.aliasNeeded(two), true);
    assert.equal(M.aliasNeeded(app('g', { accounts: [{ id: 'a', alias: '' }] })), false, 'one account needs no alias');
    assert.equal(M.accountLabel(two.accounts[0]), 'Work (w@x.test)');
    assert.equal(M.accountLabel(two.accounts[1]), 'h@x.test');
    assert.equal(M.usedByLabel(app('x')), 'No bots use it yet');
    assert.equal(M.usedByLabel(app('x', { used_by: [{ name: 'Scout' }, { name: 'Archivist' }] })), 'Used by Scout, Archivist');
    assert.equal(M.usedByLabel(app('x', { used_by: ['A', 'B', 'C', 'D'].map(name => ({ name })) })), 'Used by A, B and 2 more');
    assert.equal(M.limitedLabel(app('x', { limited_for: ['1'] })), '1 bot can use only some of its tools');
    assert.equal(M.limitedLabel(app('x')), '');
  });

  await check('probe results read plainly with the right next step', () => {
    assert.equal(M.probeText({ state: 'connected', tools: 1 }), 'Connected, 1 tool');
    assert.equal(M.probeText({ state: 'connected', tools: 150, truncated: true }), 'Connected, 150 tools (first 100 listed)');
    assert.equal(M.probeText({ state: 'auth_required' }), 'Sign-in needed');
    assert.equal(M.probeText({ state: 'failed', reason: 'keys' }), 'The server refused the keys');
    assert.equal(M.probeAction({ state: 'failed', reason: 'keys' }), 'Fix keys');
    assert.equal(M.probeAction({ state: 'failed', reason: 'timeout' }), 'Try again');
    assert.equal(M.probeAction({ state: 'auth_required' }), 'Sign in');
    assert.equal(M.probeAction({ state: 'connected' }), '');
    assert.equal(M.probeTone({ state: 'failed' }), 'bad');
    assert.equal(M.probeText(null), '');
  });

  await check('server badges and health', () => {
    const texts = server => M.serverBadges(server).map(b => b.text);
    assert.deepEqual(texts({ enabled: true, auth: 'oauth', signed_in: true, mcp_type: 'http' }), ['On', 'Signed in']);
    assert.deepEqual(texts({ enabled: false, auth: 'oauth', signed_in: false, mcp_type: 'stdio', origin: 'proposed', held_tools: [{}] }),
      ['Off', 'Signed out', 'Runs on this computer', 'Proposed by a bot', '1 tool to review']);
    assert.deepEqual(texts({ enabled: false, origin: 'setup:Cursor', mcp_type: 'http' }), ['Off', 'Imported']);
    assert.deepEqual(M.serverHealth({ enabled: true, status: { state: 'working', tools: 4 } }), { text: 'Connected, 4 tools', tone: 'good' });
    assert.equal(M.serverHealth({ enabled: true, status: { state: 'signed_out' } }).text, 'Sign-in needed');
    assert.equal(M.serverHealth({ enabled: true, status: { state: 'down' } }).tone, 'bad');
    assert.equal(M.serverHealth({ enabled: true }).text, 'Not tested yet');
    assert.equal(M.serverHealth({ enabled: false }).text, 'Off');
  });

  await check('a pasted server becomes a draft, and the request carries each secret exactly once', () => {
    const draft = M.draftFromPaste({ name: 'acme', transport: 'http', url: 'https://mcp.acme.test/mcp', headers: { 'X-Api-Key': SECRET }, env: {}, args: [] });
    assert.equal(M.validateDraft(draft), '');
    const body = M.draftToBody(draft);
    assert.deepEqual(body.headers, { 'X-Api-Key': SECRET });
    assert.deepEqual([body.transport, body.url, body.call_timeout_minutes, body.result_budget, body.enabled], ['http', 'https://mcp.acme.test/mcp', 10, 8000, true]);
    assert.ok(!('command' in body) && !('env' in body), 'a remote server sends no command');
    const local = M.draftToBody(M.draftFromPaste({ name: 'tool', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: SECRET } }));
    assert.deepEqual([local.command, local.args, local.env], ['npx', ['-y', 'pkg'], { TOKEN: SECRET }]);
  });

  await check('editing a saved server shows names only and sends keep markers, never a value', () => {
    const saved = { id: 'i1', name: 'acme', mcp_type: 'http', http_kind: 'sse', url: 'https://mcp.acme.test/sse', header_names: ['X-Api-Key', 'X-Team'], env_names: [],
      oauth_client: { client_id: 'cid', scopes: 'read', has_secret: true }, call_timeout_minutes: 5, result_budget: 0, enabled: false };
    const draft = M.draftFromServer(saved);
    assert.deepEqual(draft.headers, [{ name: 'X-Api-Key', value: '', saved: true }, { name: 'X-Team', value: '', saved: true }]);
    assert.equal(draft.transport, 'sse');
    assert.equal(M.validateDraft(draft, { editing: true }), '');
    assert.equal(JSON.stringify(draft).includes(SECRET), false);
    draft.headers[1].value = 'blue';
    draft.headers.push({ name: 'X-New', value: 'n', saved: false });
    const body = M.draftToBody(draft);
    assert.deepEqual(body.headers, { 'X-Api-Key': true, 'X-Team': 'blue', 'X-New': 'n' });
    assert.deepEqual(body.oauth, { client_id: 'cid', scopes: 'read' }, 'a saved client secret is kept by sending none');
    draft.headers = draft.headers.filter(r => r.name !== 'X-Team');
    assert.ok(!('X-Team' in M.draftToBody(draft).headers), 'a removed row is left out so it is removed');
    assert.equal(body.enabled, false);
    assert.equal(body.result_budget, 0);
  });

  await check('the editor refuses what the server would refuse', () => {
    const base = () => M.draftFromPaste({ name: 'acme', transport: 'http', url: 'https://mcp.acme.test/mcp', headers: {}, env: {}, args: [] });
    const refused = [
      [d => { d.name = 'Bad Name'; }, /name starts/], [d => { d.name = ''; }, /name starts/],
      [d => { d.url = 'http://remote.test/mcp'; }, /https/], [d => { d.url = 'https://user:pw@remote.test'; }, /sign-in details/],
      [d => { d.headers = [{ name: 'bad header', value: 'v', saved: false }]; }, /header name/], [d => { d.headers = [{ name: 'X-Key', value: '', saved: false }]; }, /value/],
      [d => { d.call_timeout_minutes = 0; }, /1 to 60/], [d => { d.call_timeout_minutes = 61; }, /1 to 60/], [d => { d.call_timeout_minutes = 2.5; }, /1 to 60/],
      [d => { d.result_budget = -1; }, /0 to 2,000,000/], [d => { d.result_budget = 2_000_001; }, /0 to 2,000,000/],
      [d => { d.oauth = { on: true, client_id: '', client_secret: '', scopes: '' }; }, /client id/],
      [d => { d.transport = 'stdio'; d.command = ''; }, /command/], [d => { d.transport = 'stdio'; d.command = 'x'; d.env = [{ name: '1BAD', value: 'v', saved: false }]; }, /variable name/]];
    for (const [change, pattern] of refused) { const d = base(); change(d); assert.match(M.validateDraft(d), pattern); }
    const ok = base(); ok.url = 'http://127.0.0.1:9000/mcp'; assert.equal(M.validateDraft(ok), '', 'a server on this computer may use http');
    const edge = base(); edge.call_timeout_minutes = 60; edge.result_budget = 2_000_000; assert.equal(M.validateDraft(edge), '');
  });

  await check('keys group in order, state never shows more than the last four', () => {
    const rows = [{ id: 'github', group: 'Servers', has_value: true, last4: 'abcd', secret: true }, { id: 'exa', group: 'Servers', has_value: false },
      { id: 'model:e1', group: 'AI', has_value: true, managed_in: 'models' }, { id: 'highlevel-location', group: 'Apps', has_value: true, secret: false, value: 'loc_1' }];
    assert.deepEqual(M.groupKeys(rows, ['AI', 'Servers', 'Voice', 'Apps']).map(g => [g.group, g.rows.length]), [['AI', 1], ['Servers', 2], ['Apps', 1]], 'empty groups are left out');
    assert.equal(M.keyState(rows[0]), 'Saved, ends abcd');
    assert.equal(M.keyState(rows[1]), 'Not set');
    assert.equal(M.keyState(rows[2]), 'Set in Models');
    assert.equal(M.keyState(rows[3]), 'loc_1');
    assert.equal(M.keyState({ has_value: true, secret: true }), 'Saved');
    assert.equal(M.testText({ ok: false, message: 'The provider refused this key.' }), 'The provider refused this key.');
    assert.equal(M.testTone({ ok: true }), 'good');
    assert.equal(M.matchKey(rows, 'exa').id, 'exa');
  });

  await check('a saved login form: a blank password keeps the saved one and the code seed is only sent when typed', () => {
    const form = { ...M.emptyLogin(), site: ' example.com ', username: ' dana ', password: 'pw-1', totp: ' JBSWY3DPEHPK3PXP ', access: 'some', bots: ['0123456789'], exact_host: true };
    assert.equal(M.validateLogin(form), '');
    assert.deepEqual(M.loginBody(form), { site: 'example.com', username: 'dana', exact_host: true, bots: ['0123456789'], password: 'pw-1', totp: 'JBSWY3DPEHPK3PXP' });
    const saved = M.loginToForm({ id: 'l1', site: 'example.com', username: 'dana', exact_host: false, bots: 'all', has_totp: true });
    assert.deepEqual([saved.password, saved.totp, saved.access], ['', '', 'all']);
    assert.equal(M.validateLogin(saved, { editing: true }), '');
    const edit = M.loginBody(saved, { editing: true });
    assert.ok(!('password' in edit) && !('totp' in edit), 'nothing typed means nothing sent: the saved values stay');
    assert.equal(edit.bots, 'all');
    assert.equal(M.loginBody(saved, { editing: true, removeTotp: true }).totp, null);
    assert.match(M.validateLogin({ ...saved, password: '' }), /password/);
    assert.match(M.validateLogin({ ...form, totp: 'not a seed!' }), /one-time-code/);
    assert.match(M.validateLogin({ ...form, bots: [] }), /at least one bot/);
    assert.equal(M.validateLogin({ ...form, totp: 'otpauth://totp/Acme:dana?secret=JBSWY3DPEHPK3PXP' }), '');
    assert.match(M.validateLogin({ ...form, site: ' ' }), /site/);
    assert.match(M.validateLogin({ ...form, username: '' }), /username/);
  });

  await check('login rows read plainly and never carry a password or seed', () => {
    const login = { id: 'l1', site: 'example.com', username: 'dana', bots: ['a', 'b', 'c'], has_totp: true, exact_host: true, source: 'settings', last_used: null };
    assert.equal(M.loginMeta(login, {}), 'dana · Added here · 2FA · Exact site only · 3 bots · Never used');
    assert.equal(M.accessLabel('all'), 'All bots');
    assert.equal(M.accessLabel([]), 'No bots');
    assert.equal(M.accessLabel(['a', 'b'], { a: 'Scout', b: 'Archivist' }), 'Scout, Archivist');
    assert.equal(M.accessLabel(['gone'], {}), 'A deleted bot');
    assert.equal(M.loginMeta({ ...login, source: '1password', bots: 'all', has_totp: false, exact_host: false, last_used: 1_700_000_000 }, {}).includes('1Password · All bots · Used '), true);
  });

  await check('the setup import summarises what happened and offers only what is ready', () => {
    assert.equal(M.importSummary({ mcp: [{ status: 'imported' }, { status: 'refused' }], skills: [{ status: 'imported' }] }), 'Imported 2 (all switched off for review), 1 not imported.');
    assert.equal(M.importSummary({ mcp: [], skills: [] }), 'Nothing was imported.');
    assert.equal(M.importSummary(null), 'Nothing was imported.');
    assert.deepEqual(M.selectable([{ status: 'ready', name: 'a' }, { status: 'exists' }, { status: 'refused' }]).map(r => r.name), ['a']);
    assert.equal(M.importKey({ tool: 'Cursor', name: 'x' }), 'Cursor::x');
    assert.equal(M.importKey({ tool: 'Codex', folder: 'notes' }), 'Codex::notes');
  });

  await check('the copyable diagnostic holds no secret, even one that slipped into a field', () => {
    const server = { name: 'acme', mcp_type: 'http', url: 'https://mcp.acme.test/mcp', header_names: ['X-Api-Key'], env_names: [], enabled: true,
      status: { state: 'down', tools: null, error: `bad request with header ${SECRET}` } };
    const text = M.diagnostic(server, { state: 'failed', reason: 'keys' }, [SECRET]);
    assert.ok(!text.includes(SECRET));
    assert.ok(text.includes('Header names: X-Api-Key') && text.includes('[hidden]') && text.includes('refused the keys'));
    assert.equal(M.redactText('a SECRETVALUE b', ['SECRETVALUE', 'ab']), 'a [hidden] b', 'short values are not treated as secrets');
    assert.equal(M.diagnostic({ ...server, status: null, mcp_type: 'stdio', command: 'npx', url: '' }, null, []).includes('Command: npx'), true);
  });

  await check('no user-facing text uses an em-dash', async () => {
    const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'static', 'js', 'botsConnectionsModel.js'), 'utf8');
    assert.ok(!/—/.test(source), 'no em-dashes');
  });

  console.log(`ok - ${passed.length} connections checks`);
})().catch(error => { console.error(error); process.exit(1); });
