// Bots connections, Phase 2 unit U5 (2026-10-29): the Connected apps, Keys and Signed-in sites pages, in the renderer.
// Run: node scripts/run-electron-test.cjs ui-smoke --bots-connections-only (the full run includes it). Spec: Kairos Projects/Agents
// Redesign/phase-2-design.md, section 7 U5.
//
// Backend: scripts/fixtures/bots-connections-backend.cjs (state under demoState.botsConnections). The check makes its own bot,
// seeds its own accounts, servers and scan rows, mounts the three page modules into a scratch host (the way scripts/bots-skills-checks.cjs
// does), flips <html data-app-mode="bots"> for the length of the run, and puts everything back in finally. It also opens Settings once to
// prove the three pages are reachable there with their own Bots tokens.
// Covers: search and category filters, aliases (required for a second account, unique), reconnect, adding a catalogue app, the paste
// reader (found line, write-only secret rows, keep markers on edit), probe states and their next steps, the copyable details, a switch
// that sends only {enabled}, the setup import, write-only keys with deep-link focus and tests, saved logins (add, change keeping the
// password, bot grants, delete with confirmation), 1Password, the phone layout, and that no secret value is ever in the page, a
// response or the copied text.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

const SECRET_HEADER = 'SECRETHEADER-91827364';
const SECRET_KEY = 'sk-test-KEYVALUE-0123456789abcdef';
const SECRET_PASSWORD = 'Hunter2-PASSWORD-correct-horse';
const SECRET_SEED = 'JBSWY3DPEHPK3PXP';
const ALL_SECRETS = [SECRET_HEADER, SECRET_KEY, SECRET_PASSWORD, SECRET_SEED];

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base }) => {
  const call = (path, method = 'GET', body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, text: await r.text() }))`);
  const json = async (path, method, body) => { const r = await call(path, method, body); return { status: r.status, body: r.text ? JSON.parse(r.text) : null, text: r.text }; };
  const has = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
  const count = selector => js(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('missing ' + ${JSON.stringify(selector)}); n.click(); return true; })()`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('missing ' + ${JSON.stringify(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const attr = (selector, name) => js(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
  const pageText = () => js('document.body.innerText + "\\n" + [...document.querySelectorAll("input,textarea")].map(n => n.type === "password" ? "" : n.value).join("\\n")');
  const pageHtml = () => js('document.body.innerHTML');
  const lastWrite = (method, pattern) => [...writes].reverse().find(w => w.method === method && pattern.test(w.path));
  const noSecrets = async label => {
    const dom = (await pageText()) + (await pageHtml());
    for (const secret of ALL_SECRETS) assert.ok(!dom.includes(secret), `${label}: the page holds no secret value (${secret.slice(0, 8)}...)`);
  };
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";

  const restore = await isolateBotsCheck({ js, demoState }, { botsConnections: undefined });
  let mounted = false;
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Its own bot (the fixture roster belongs to bots-core-backend).
    const created = await json('/api/agents', 'POST', { name: 'Connections Check Bot' });
    assert.equal(created.status, 200, 'the check creates its own bot');
    const botId = created.body.id || created.body.agent?.id;
    assert.ok(botId, 'the new bot has an id');

    // Seed this check's own data. The first request makes the fixture's store.
    await call('/api/bots/connections');
    const store = demoState.botsConnections;
    store.google.accounts = [{ id: 'work', email: 'work@mail.test' }, { id: 'home', email: 'home@mail.test', error: 'expired' }];
    store.email = [{ id: 'm1', email: 'me@mail.test' }];
    store.users = { google: [{ id: botId, name: 'Connections Check Bot', scope: 'write' }] };
    store.scan = { mcp: [
      { tool: 'Cursor', name: 'notes-server', status: 'ready', reason: '', gaps: ['TOKEN'], warnings: ['Needs a value before it can work: TOKEN.'], summary: 'npx' },
      { tool: 'Cursor', name: 'already', status: 'exists', reason: 'A server with this name is already added.', gaps: [], warnings: [], summary: 'host.test' }],
      skills: [], limited: false, skills_available: false, skills_note: 'Skill import is not available in this build.', skills_limited: false };
    store.models = [{ id: 'm-api', name: 'Check API model' }];

    // The scratch host: Bots tokens and styles apply under <html data-app-mode="bots">. window.open and the clipboard are recorded, not used.
    await js(`(async () => {
      window.__connPrevMode = document.documentElement.dataset.appMode || '';
      document.documentElement.dataset.appMode = 'bots';
      const ui = await import('/static/js/botsUi.js');
      await ui.loadBotsCss('/static/css/bots.css');
      document.getElementById('conn-scratch')?.remove();
      const host = document.createElement('div');
      host.id = 'conn-scratch';
      host.style.cssText = 'position:fixed;left:24px;top:24px;width:560px;max-height:92vh;overflow:auto;z-index:30;background:var(--bots-app);padding:12px';
      document.body.append(host);
      window.__cn = { host, handle: null, opened: [], copied: [], openRef: window.open, clipRef: Object.getOwnPropertyDescriptor(navigator, 'clipboard') };
      window.open = url => { window.__cn.opened.push(String(url)); return null; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__cn.copied.push(String(value)); } } });
      return true;
    })()`);
    mounted = true;
    const mount = (file, ctx = {}) => js(`(async () => {
      const s = window.__cn;
      s.handle?.destroy(); s.host.replaceChildren();
      const module = await import('/static/js/${file}');
      s.handle = module.mount(s.host, { agentId: ${JSON.stringify(botId)}, state: { agent: { id: ${JSON.stringify(botId)} } }, advanced: () => true, flush: async () => true, refresh() {}, go() {}, ...${JSON.stringify(ctx)} });
      return typeof s.handle.destroy === 'function' && typeof s.handle.refresh === 'function' && typeof s.handle.flush === 'function';
    })()`);
    const opened = () => js('window.__cn.opened');
    const copied = () => js('window.__cn.copied');

    // -- Connected apps: filters, accounts, aliases ---------------------------------------------------------
    assert.equal(await mount('botsSectionConnections.js'), true, 'mount returns {destroy, refresh, flush}');
    await waitFor("!!document.querySelector('#conn-scratch .bots-conn[data-section=connections] [data-app=google]')");
    assert.equal(await attr('[data-app=google]', 'data-state'), 'connected', 'Google shows connected with its accounts');
    assert.ok(await has('[data-app="catalog:linear"][data-state=available]'), 'a catalogue app is offered');
    assert.match(await text('[data-app=google]'), /Connected/);
    await capture?.('desktop-bots-connections-apps');

    await fill('.bots-conn-search', 'linear');
    await waitFor("document.querySelectorAll('#conn-scratch [data-app]').length === 1");
    assert.ok(await has('[data-app="catalog:linear"]'), 'search narrows to the app');
    await fill('.bots-conn-search', 'zzzz-nothing');
    await waitFor("/No apps match/.test(document.querySelector('#conn-scratch .bots-conn-empty')?.textContent || '')");
    await fill('.bots-conn-search', '');
    await js("[...document.querySelectorAll('#conn-scratch .bots-conn-chip[aria-pressed]')].find(n => n.textContent === 'Finance').click()");
    await waitFor("document.querySelectorAll('#conn-scratch [data-app]').length >= 1 && [...document.querySelectorAll('#conn-scratch [data-app]')].every(n => ['whop', 'catalog:stripe'].includes(n.dataset.app))");
    await js("[...document.querySelectorAll('#conn-scratch .bots-conn-chip[aria-pressed]')].find(n => n.textContent === 'Finance').click()");
    await js("[...document.querySelectorAll('#conn-scratch .bots-segmented [role=radio]')].find(n => n.textContent === 'Connected').click()");
    await waitFor("[...document.querySelectorAll('#conn-scratch [data-app]')].every(n => n.dataset.state !== 'available')");
    await js("[...document.querySelectorAll('#conn-scratch .bots-segmented [role=radio]')].find(n => n.textContent === 'All').click()");

    // Two accounts and no aliases: the page asks for them; an alias is unique; a clash is explained.
    await click('[data-app=google] .bots-conn-main');
    await waitFor("!!document.querySelector('[data-app=google] .bots-conn-detail')");
    assert.match(await text('[data-app=google] .bots-conn-detail'), /Used by Connections Check Bot/);
    assert.match(await text('[data-app=google] .bots-conn-detail'), /alias so a bot can tell them apart/);
    await fill('[data-app=google] [data-account=work] input', 'Work Gmail');
    await click('[data-app=google] [data-account=work] [data-act=alias]');
    await waitFor("document.querySelector('[data-app=google] [data-account=work] input')?.value === 'Work Gmail'");
    assert.deepEqual(JSON.parse(lastWrite('PUT', /\/accounts\/work\/alias$/).body), { alias: 'Work Gmail' });
    await fill('[data-app=google] [data-account=home] input', 'work gmail');
    await click('[data-app=google] [data-account=home] [data-act=alias]');
    await waitFor("/already has that alias/.test(document.querySelector('#conn-scratch .bots-conn-status.error')?.textContent || '')");
    await fill('[data-app=google] [data-account=home] input', 'Home Gmail');
    await click('[data-app=google] [data-account=home] [data-act=alias]');
    await waitFor("document.querySelector('[data-app=google] [data-account=home] input')?.value === 'Home Gmail'");
    assert.ok(!await has('#conn-scratch .bots-conn-status.error'), 'the clash message clears');

    // Reconnect the account that expired: the same account is sent, and the sign-in link opens.
    await click('[data-app=google] [data-account=home] [data-act=reconnect]');
    await waitFor("window.__cn.opened.length === 1");
    assert.deepEqual(JSON.parse(lastWrite('POST', /\/connections\/google\/authorize$/).body), { account: 'home' });
    assert.match((await opened())[0], /^https:\/\/accounts\.google\.test\//);
    assert.match(await text('#conn-scratch .bots-conn-status.good'), /Finish signing in to Google Workspace/);
    store.google.accounts[1].error = null;
    await js('window.__cn.handle.refresh()');
    await waitFor("document.querySelector('[data-app=google] .bots-conn-detail') && !document.querySelector('[data-app=google] [data-act=reconnect]')");

    // Disconnect needs the confirmation dialog.
    await click('[data-app=google] [data-account=home] [data-act=disconnect]');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await js("[...document.querySelectorAll('.confirm-panel .btn')].find(b => b.textContent === 'Cancel').click()");
    await waitFor("!document.querySelector('.confirm-panel')");
    assert.equal(store.google.accounts.length, 2, 'cancelling disconnects nothing');
    await click('[data-app=google] [data-account=home] [data-act=disconnect]');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await js("document.querySelector('.confirm-panel .btn.danger').click()");
    await waitFor("document.querySelectorAll('[data-app=google] [data-account]').length === 1");
    assert.equal(lastWrite('DELETE', /\/accounts\/home$/).status, 200);

    // Add a catalogue app: it is added, its sign-in link opens, and it waits for the sign-in.
    await js("document.querySelector('[data-app=\"catalog:linear\"] [data-act=primary]').click()");
    await waitFor("window.__cn.opened.length === 2");
    assert.match((await opened())[1], /^https:\/\/auth\.linear\.test\/authorize/);
    await waitFor("!!document.querySelector('[data-server=linear]')");
    assert.equal(await attr('[data-server=linear] [role=switch]', 'aria-checked'), 'true');
    store.servers.find(v => v.name === 'linear').signedIn = true;
    await js('window.__cn.handle.refresh()');
    await waitFor("document.querySelector('[data-server=linear] .bots-conn-chip')?.textContent === 'On'");

    // -- MCP editor: paste, write-only rows, probes ---------------------------------------------------------------
    await click('[data-act=add-server]');
    await waitFor("!!document.querySelector('.bots-conn-editor [data-field=paste]')");
    await fill('[data-field=paste]', 'rm -rf /');
    await click('[data-act=read]');
    await waitFor("/does not recognise/.test(document.querySelector('.bots-conn-editor .bots-conn-status.error')?.textContent || '')");
    await fill('[data-field=paste]', `claude mcp add --transport http acme https://mcp.acme.test/mcp -H "X-Api-Key: ${SECRET_HEADER}"`);
    await click('[data-act=read]');
    await waitFor("!!document.querySelector('[data-found]')");
    assert.equal(await text('[data-found]'), 'Found acme at mcp.acme.test');
    assert.equal(await js("document.querySelector('[data-field=name]').value"), 'acme');
    assert.equal(await js("document.querySelector('[data-field=url]').value"), 'https://mcp.acme.test/mcp');
    assert.equal(await js("document.querySelector('.bots-conn-pair[data-kind=header] input').value"), 'X-Api-Key');
    assert.equal(await js("document.querySelector('.bots-conn-pair[data-kind=header] input[type=password]').getAttribute('data-secret')"), 'true', 'the secret goes in a write-only field');
    assert.ok(!(await pageText()).includes(SECRET_HEADER), 'the pasted secret is not shown as text');
    await click('[data-act=save-server]');
    await waitFor("!!document.querySelector('[data-server=acme]')");
    await waitFor("/Connected, 3 tools/.test(document.querySelector('.bots-conn-probe[data-server=acme]')?.textContent || '')");
    const add = JSON.parse(lastWrite('POST', /\/api\/bots\/mcp$/).body);
    assert.equal(add.headers['X-Api-Key'], SECRET_HEADER, 'the secret is sent once, to the server');
    assert.equal(lastWrite('POST', /\/api\/bots\/mcp$/).status, 200);
    await noSecrets('after saving a server');
    const listed = await json('/api/bots/mcp');
    assert.ok(!listed.text.includes(SECRET_HEADER), 'the server list returns names only');
    assert.deepEqual(listed.body.servers.find(s => s.name === 'acme').header_names, ['X-Api-Key']);
    await capture?.('desktop-bots-connections-servers');

    // A refused key: the strip says so and offers Fix keys, which opens the editor with the row marked saved.
    store.probes.acme = { state: 'failed', reason: 'keys', tools: 0, tool_names: [] };
    await click('[data-server=acme] [data-act=test]');
    await waitFor("/refused the keys/.test(document.querySelector('.bots-conn-probe[data-server=acme]')?.textContent || '')");
    await js("[...document.querySelectorAll('.bots-conn-probe[data-server=acme] .bots-btn')].find(b => b.textContent === 'Copy details').click()");
    await waitFor("window.__cn.copied.length === 1");
    const details = (await copied())[0];
    assert.match(details, /Header names: X-Api-Key/);
    for (const secret of ALL_SECRETS) assert.ok(!details.includes(secret), 'the copied details hold no secret');
    await js("[...document.querySelectorAll('.bots-conn-probe[data-server=acme] .bots-btn')].find(b => b.textContent === 'Fix keys').click()");
    await waitFor("!!document.querySelector('.bots-conn-editor-card') && document.querySelector('[data-field=name]')?.readOnly === true");
    assert.equal(await js("document.querySelector('[data-field=name]').value"), 'acme', 'the name is locked on edit');
    assert.equal(await js("document.querySelector('.bots-conn-pair[data-kind=header] input[type=password]').value"), '', 'a saved secret is never filled back in');
    assert.match(await js("document.querySelector('.bots-conn-pair[data-kind=header] input[type=password]').placeholder"), /Saved\. Type to replace\./);
    await fill('[data-field=timeout]', '99');
    await click('[data-act=save-server]');
    await waitFor("/1 to 60/.test(document.querySelector('.bots-conn-editor .bots-conn-status.error')?.textContent || '')");
    await fill('[data-field=timeout]', '5');
    await fill('[data-field=budget]', '4000');
    await click('[data-act=save-server]');
    await waitFor("!document.querySelector('.bots-conn-editor-card')");
    const edit = JSON.parse(lastWrite('PATCH', /\/api\/bots\/mcp\/[^/]+$/).body);
    assert.deepEqual(edit.headers, { 'X-Api-Key': true }, 'saving without retyping sends the keep marker, never a value');
    assert.deepEqual([edit.call_timeout_minutes, edit.result_budget], [5, 4000]);
    await noSecrets('after editing a server');

    // Other probe states and their next steps.
    store.probes.acme = { state: 'failed', reason: 'timeout', tools: 0, tool_names: [] };
    await click('[data-server=acme] [data-act=test]');
    await waitFor("/No answer in time/.test(document.querySelector('.bots-conn-probe[data-server=acme]')?.textContent || '')");
    assert.ok(await js("[...document.querySelectorAll('.bots-conn-probe[data-server=acme] .bots-btn')].some(b => b.textContent === 'Try again')"));
    store.probes.acme = { state: 'connected', tools: 150, tool_names: [], truncated: true };
    await click('[data-server=acme] [data-act=test]');
    await waitFor("/150 tools \\(first 100 listed\\)/.test(document.querySelector('.bots-conn-probe[data-server=acme]')?.textContent || '')");

    // The switch sends only {enabled}.
    await click('[data-server=acme] [role=switch]');
    await waitFor("document.querySelector('[data-server=acme] [role=switch]')?.getAttribute('aria-checked') === 'false'");
    assert.deepEqual(JSON.parse(lastWrite('PATCH', /\/api\/bots\/mcp\/[^/]+$/).body), { enabled: false });
    await click('[data-server=acme] [role=switch]');
    await waitFor("document.querySelector('[data-server=acme] [role=switch]')?.getAttribute('aria-checked') === 'true'");

    // A local command from a setup line: read as text, saved with a variable value that is write-only.
    await click('[data-act=add-server]');
    await waitFor("!!document.querySelector('[data-field=paste]')");
    await fill('[data-field=paste]', 'claude mcp add notes -e NOTES_TOKEN=' + SECRET_KEY + ' -- npx -y notes-mcp');
    await click('[data-act=read]');
    await waitFor("!!document.querySelector('[data-found]')");
    assert.equal(await js("document.querySelector('[data-field=command]').value"), 'npx');
    assert.equal(await js("document.querySelector('[data-field=args]').value"), '-y\nnotes-mcp');
    assert.ok(!(await pageText()).includes(SECRET_KEY));
    await click('[data-act=save-server]');
    await waitFor("!!document.querySelector('[data-server=notes]')");
    assert.deepEqual(JSON.parse(lastWrite('POST', /\/api\/bots\/mcp$/).body).env, { NOTES_TOKEN: SECRET_KEY });
    await noSecrets('after saving a local server');

    // Remove, with the confirmation.
    await click('[data-server=notes] [data-act=remove]');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await js("document.querySelector('.confirm-panel .btn.danger').click()");
    await waitFor("!document.querySelector('[data-server=notes]')");

    // -- Setup import ------------------------------------------------------------------------------------------------
    await click('[data-act=scan]');
    await waitFor("document.querySelectorAll('[data-import]').length === 2");
    assert.equal(await js("document.querySelector('[data-import=\"Cursor::already\"] input').disabled"), true, 'an existing server cannot be picked');
    assert.match(await text('[data-import="Cursor::notes-server"]'), /Needs a value before it can work: TOKEN/);
    assert.match(await text('#conn-scratch'), /Skill import is not available in this build/);
    await click('[data-act=apply-import]');
    await waitFor("/Choose something to import first/.test(document.querySelector('#conn-scratch .bots-conn-status.error')?.textContent || '')");
    // The skill unit is there on the next look: skills appear beside the servers and are applied with them.
    store.scan.skills = [{ tool: 'Codex', folder: 'notes', name: 'notes', status: 'ready', reason: '', warnings: [], skipped_files: [], summary: '' }];
    store.scan.skills_available = true; store.scan.skills_note = '';
    await click('[data-act=scan]');
    await waitFor("document.querySelectorAll('[data-import]').length === 3");
    assert.ok(!/Skill import is not available/.test(await text('#conn-scratch')), 'the note goes when skill import is available');
    await js("document.querySelector('[data-import=\"Cursor::notes-server\"] input').click()");
    await js("document.querySelector('[data-import=\"Codex::notes\"] input').click()");
    await click('[data-act=apply-import]');
    await waitFor("!!document.querySelector('[data-server=\"notes-server\"]')");
    assert.deepEqual(JSON.parse(lastWrite('POST', /\/setup-import$/).body), { mcp: [{ tool: 'Cursor', name: 'notes-server' }], skills: [{ tool: 'Codex', folder: 'notes' }] });
    assert.equal(await attr('[data-server="notes-server"] [role=switch]', 'aria-checked'), 'false', 'imported servers come in off');
    assert.match(await text('[data-server="notes-server"]'), /Imported/);
    assert.match(await text('#conn-scratch'), /Imported 2 \(all switched off for review\)/);

    // -- Keys ---------------------------------------------------------------------------------------------------------
    await mount('botsSectionKeys.js', { focusKey: 'exa' });
    await waitFor("!!document.querySelector('#conn-scratch .bots-conn[data-section=keys] [data-key=exa]')");
    assert.ok(await has('[data-key=exa].focused'), 'a deep link scrolls to and highlights its row');
    assert.equal(await js("document.activeElement?.closest('[data-key]')?.dataset.key"), 'exa', 'and puts the focus in its box');
    assert.equal(await js("[...document.querySelectorAll('#conn-scratch .bots-card-label')].map(n => n.textContent).slice(0, 5).join(',')"), 'AI,Servers,Voice,Computers,Apps', 'six groups in order');
    assert.match(await text('[data-key="model:m-api"]'), /Set in Models/, 'model connections are listed, not edited');
    await fill('[data-key=github] input', 'abc');
    await click('[data-key=github] [data-act=save]');
    await waitFor("/does not look like a github token/.test(document.querySelector('[data-key=github] [data-result]')?.textContent || '')");
    assert.equal(await attr('[data-key=exa] input', 'type'), 'password');
    await fill('[data-key=exa] input', SECRET_KEY);
    await click('[data-key=exa] [data-act=save]');
    await waitFor("/Saved, ends cdef/.test(document.querySelector('[data-key=exa]')?.textContent || '')");
    assert.deepEqual(JSON.parse(lastWrite('PUT', /\/keys\/exa$/).body), { value: SECRET_KEY });
    assert.equal(await js("document.querySelector('[data-key=exa] input').value"), '', 'the box is empty again: the key is write-only');
    await noSecrets('after saving a key');
    assert.ok(!(await json('/api/bots/keys')).text.includes(SECRET_KEY), 'the key list never returns a key');
    await click('[data-key=exa] [data-act=test]');
    await waitFor("document.querySelector('[data-key=exa] [data-result]')?.textContent === 'The key works.'");
    store.keyVerdicts = { exa: 'refused' };
    await click('[data-key=exa] [data-act=test]');
    await waitFor("/provider refused this key/.test(document.querySelector('[data-key=exa] [data-result]')?.textContent || '')");
    assert.ok(await has('[data-key=exa] .bots-conn-key-result.bad'));
    await noSecrets('after testing a key');
    await click('[data-key="model:m-api"] [data-act=test]');
    await waitFor("document.querySelector('[data-key=\"model:m-api\"] [data-result]')?.textContent === 'The key works.'");
    await click('[data-key=exa] [data-act=clear]');
    await waitFor("/Not set/.test(document.querySelector('[data-key=exa]')?.textContent || '')");
    // Helper and quiet-time settings are checked by the server and kept by revision.
    await fill('[data-field=tidy-time]', '25:99');
    await click('[data-act=save-settings]');
    await waitFor("/time of day such as 03:00/.test(document.querySelector('#conn-scratch .bots-conn-status.error')?.textContent || '')");
    await fill('[data-field=tidy-time]', '04:15');
    await fill('[data-field=quiet]', '12');
    await click('[data-act=save-settings]');
    await waitFor("document.querySelector('#conn-scratch .bots-conn-status.good')?.textContent === 'Saved.'");
    const settingsWrite = JSON.parse(lastWrite('PATCH', /\/resource-settings$/).body);
    assert.deepEqual([settingsWrite.tidy_time, settingsWrite.capture_quiet_minutes, settingsWrite.expected_revision], ['04:15', 12, 0]);
    assert.equal((await json('/api/bots/resource-settings')).body.revision, 1);

    // -- Saved logins ---------------------------------------------------------------------------------------------------
    await mount('botsSectionLogins.js');
    await waitFor("!!document.querySelector('#conn-scratch .bots-conn[data-section=logins] [data-act=add]')");
    assert.match(await text('#conn-scratch'), /No saved logins/);
    assert.match(await text('#conn-scratch'), /1Password command line \(op\) is not installed/);
    await click('[data-act=add]');
    await waitFor("!!document.querySelector('[data-field=password]')");
    await click('[data-act=save]');
    await waitFor("/Enter the site/.test(document.querySelector('.bots-conn-editor .bots-conn-status.error')?.textContent || '')");
    await fill('[data-field=site]', 'https://Example.com/login');
    await fill('[data-field=username]', 'dana');
    await fill('[data-field=password]', SECRET_PASSWORD);
    await fill('[data-field=totp]', SECRET_SEED);
    await js("[...document.querySelectorAll('.bots-conn-editor .bots-segmented [role=radio]')].find(n => n.textContent === 'Only these').click()");
    await click('[data-act=save]');
    await waitFor("/at least one bot/.test(document.querySelector('.bots-conn-editor .bots-conn-status.error')?.textContent || '')");
    await js(`document.querySelector('[data-bot="${botId}"] input').click()`);
    await click('[data-act=save]');
    await waitFor("!!document.querySelector('[data-login]')");
    const post = JSON.parse(lastWrite('POST', /\/api\/bots\/logins$/).body);
    assert.deepEqual([post.site, post.username, post.password, post.totp, post.bots], ['https://Example.com/login', 'dana', SECRET_PASSWORD, SECRET_SEED, [botId]]);
    assert.match(await text('[data-login]'), /example\.com/);
    assert.match(await text('[data-login]'), /dana · Added here · 2FA · Connections Check Bot · Never used/);
    await noSecrets('after saving a login');
    assert.ok(!(await json('/api/bots/logins')).text.includes(SECRET_PASSWORD), 'the list never returns a password');
    await capture?.('desktop-bots-connections-logins');

    // Change: a blank password and seed keep the saved ones; the bot grant is changed to all bots.
    await click('[data-login] [data-act=change]');
    await waitFor("!!document.querySelector('[data-field=password]') && document.querySelector('[data-field=password]').placeholder.includes('Leave blank to keep it')");
    assert.equal(await js("document.querySelector('[data-field=password]').value"), '', 'a saved password is never filled back in');
    await js("[...document.querySelectorAll('.bots-conn-editor .bots-segmented [role=radio]')].find(n => n.textContent === 'All bots').click()");
    await click('[data-act=save]');
    await waitFor("!document.querySelector('.bots-conn-editor-card')");
    const patch = JSON.parse(lastWrite('PATCH', /\/api\/bots\/logins\/[^/]+$/).body);
    assert.ok(!('password' in patch) && !('totp' in patch), 'nothing typed means nothing sent');
    assert.equal(patch.bots, 'all');
    assert.match(await text('[data-login]'), /All bots/);

    // Delete asks first.
    await click('[data-login] [data-act=delete]');
    await waitFor("!!document.querySelector('.confirm-panel')");
    assert.match(await text('.confirm-panel'), /dana/);
    await js("[...document.querySelectorAll('.confirm-panel .btn')].find(b => b.textContent === 'Cancel').click()");
    await waitFor("!document.querySelector('.confirm-panel')");
    assert.ok(await has('[data-login]'), 'cancelling deletes nothing');
    await click('[data-login] [data-act=delete]');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await js("document.querySelector('.confirm-panel .btn.danger').click()");
    await waitFor("!document.querySelector('[data-login]')");
    assert.equal(lastWrite('DELETE', /\/api\/bots\/logins\/[^/]+$/).status, 200);

    // 1Password: unavailable until the command line is there; a wrong token is refused; vaults start with no bots.
    store.onepassword.available = true; store.onepassword.reason = '';
    await js('window.__cn.handle.refresh()');
    await waitFor("!!document.querySelector('[data-act=op-connect]')");
    await fill('[data-field=op-token]', 'ops_wrong');
    await click('[data-act=op-connect]');
    await waitFor("/1Password refused the request/.test(document.querySelector('#conn-scratch .bots-conn-status.error')?.textContent || '')");
    await fill('[data-field=op-token]', 'ops_fixture_token');
    await click('[data-act=op-connect]');
    await waitFor("!!document.querySelector('[data-vault=v1]')");
    assert.match(await text('[data-vault=v1]'), /No bots/);
    assert.equal(await js("document.querySelector('[data-field=op-token]')?.value ?? 'gone'"), 'gone', 'the token box is gone once connected');
    await js(`document.querySelector('[data-vault=v1] [data-bot="${botId}"] input').click()`);
    await waitFor("document.querySelector('[data-vault=v1] .bots-conn-row .bots-row-hint')?.textContent === 'Connections Check Bot'");
    assert.deepEqual(JSON.parse(lastWrite('PUT', /\/onepassword\/vaults\/v1$/).body), { bots: [botId] });

    // -- Phone: rows stack, forms are full width, and Enter saves a key -------------------------------------------------
    win.setContentSize(390, 800);
    await delay(450);
    await mount('botsSectionKeys.js');
    await waitFor("!!document.querySelector('[data-key=github]')");
    assert.equal(await js("getComputedStyle(document.querySelector('[data-key=github]')).gridTemplateColumns.split(' ').length"), 1, 'a key row stacks on a phone');
    const overflow = await js("document.querySelector('#conn-scratch').scrollWidth - document.querySelector('#conn-scratch').clientWidth");
    assert.ok(overflow <= 1, `no sideways scroll on a phone (${overflow}px)`);
    await fill('[data-key=elevenlabs] input', 'phone-key-0123456789');
    await js("document.querySelector('[data-key=elevenlabs] input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await waitFor("/Saved, ends 6789/.test(document.querySelector('[data-key=elevenlabs]')?.textContent || '')");
    await mount('botsSectionConnections.js');
    await waitFor("!!document.querySelector('[data-app=google]')");
    await click('[data-act=add-server]');
    await waitFor("!!document.querySelector('[data-field=paste]')");
    assert.ok(await js("document.querySelector('[data-field=paste]').getBoundingClientRect().width > 250"), 'the editor fills the phone width');
    assert.ok(await js("(() => { const h = document.querySelector('#conn-scratch'); return h.scrollWidth - h.clientWidth <= 1; })()"), 'the editor does not overflow');
    await capture?.('mobile-bots-connections-editor');
    win.setContentSize(1440, 900);
    await delay(450);

    // -- Settings reaches the same pages, in Bots tokens of their own ---------------------------------------------------
    await js(`(() => { const s = window.__cn; s.handle?.destroy(); s.host.remove(); window.open = s.openRef; if (s.clipRef) Object.defineProperty(navigator, 'clipboard', s.clipRef); else delete navigator.clipboard;
      document.documentElement.dataset.appMode = window.__connPrevMode || ''; window.__cn = null; return true; })()`);
    mounted = false;
    for (const [section, root] of [['bot-apps', 'connections'], ['bot-keys', 'keys'], ['bot-logins', 'logins']]) {
      await js(`import('/static/js/views/settings.js').then(m => m.openSettingsWindow(${JSON.stringify(section)}))`);
      await waitFor(`!!document.querySelector('.settings-nav-item[data-section="${section}"].active') && !!document.querySelector('.set-page[data-page="${section}"] .bots-settings-host[data-app-mode=bots] .bots-conn[data-section=${root}]')`);
      assert.ok(await js(`getComputedStyle(document.querySelector('.set-page[data-page="${section}"] .bots-settings-host')).getPropertyValue('--bots-ink').trim().length > 0`), `${section} has its own Bots tokens`);
      assert.ok(!await has(`.set-page[data-page="${section}"] .bots-page-title`), 'the Settings page frame supplies the title, so the page does not repeat it');
      assert.notEqual(await js('document.documentElement.dataset.appMode'), 'bots', 'Settings does not change the selected mode');
    }
    await capture?.('desktop-bots-connections-settings');

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
    await noSecrets('at the end');
  } catch (error) {
    // Say what the page showed when a step timed out, without any secret value that might be in a field.
    const shown = await js(`(() => { const t = (document.querySelector('#conn-scratch')?.innerText || document.body.innerText); return t.slice(0, 700) + String.fromCharCode(10) + '...' + String.fromCharCode(10) + t.slice(-900); })()`).catch(() => '');
    console.log('Page at the failure:\n' + ALL_SECRETS.reduce((t, secret) => t.split(secret).join('[hidden]'), String(shown)));
    throw error;
  } finally {
    if (mounted) {
      await js(`(() => { const s = window.__cn; if (!s) return true; s.handle?.destroy(); s.host.remove(); window.open = s.openRef; if (s.clipRef) Object.defineProperty(navigator, 'clipboard', s.clipRef); else delete navigator.clipboard; document.documentElement.dataset.appMode = window.__connPrevMode || ''; return true; })()`).catch(() => {});
    }
    // Escape closes Settings if the check left it open.
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) || true").catch(() => {});
    win.setContentSize(1440, 900);
    await restore();
  }
};
