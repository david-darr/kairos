// Part 2 A13 detail sheets: does the Tool Store detail sheet show the TRUE state
// (availability, provenance, health) and offer only the actions valid for it, and
// does an action's result reach the sheet? Runs alone with --a13-detail-only (not in
// the default ui-smoke run). Mocked backend (demo/fixtures.js, a13* state keys);
// the backend half (the values themselves) is scripts/test_a13_detail.py.
//
// The "detail sheet" is the phone bottom sheet (static/js/redesignToolStoreMobile.js) that lifts
// the SAME card (handlers and all) out of its row; on a desktop the card is the detail, plus the
// View skill / Manage skills dialogs. So the states are asserted in the sheet at 390px and the
// dialogs at 1440px. Failures are collected, not thrown one by one; the module throws
// "a13 findings" at the end so every wrong state shows in one run.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, capture, reads, writes, demoState }) => {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  const eq = (actual, wanted, message) => { if (JSON.stringify(actual) !== JSON.stringify(wanted)) problems.push(`${message}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`); };
  const now = Date.now() / 1000;
  const q = JSON.stringify;
  const phone = async () => { win.setContentSize(390, 844); await delay(500); };
  const desktop = async () => { win.setContentSize(1440, 900); await delay(500); };
  const load = async () => {
    await navigate('home'); await delay(300);
    await navigate('tool-store');
    await waitFor("document.querySelectorAll('.tool-store-card').length > 0");
    await delay(400);
  };
  // "kind:Name" picks by the row key (needed when a tab and a community item share a name).
  const cardJs = (name) => /^(skill|tool|tab|community|addon):/.test(name)
    ? `[...document.querySelectorAll('.tool-store-card')].find(c => c.dataset.tsKey === ${q(name)})`
    : `[...document.querySelectorAll('.tool-store-card')].find(c => (c.querySelector('h4 .ts-desktop-name') || c.querySelector('h4'))?.textContent === ${q(name)})`;
  const open = async (name) => {
    await js(`${cardJs(name)}.querySelector('.ts-row-hit').click()`);
    await waitFor("!!document.querySelector('.ts-sheet .tool-store-card')");
    eq(await js("document.querySelector('.ts-sheet h4 .ts-desktop-name').textContent"), name.replace(/^[a-z]+:/, ''), `the sheet opened for ${name}`);
  };
  const close = async () => {
    await js("document.querySelector('.ts-sheet-close')?.click()");
    await waitFor("!document.querySelector('.ts-sheet')");
  };
  // What the open sheet shows: badges, row pill, health line, held tools, and the visible buttons.
  const sheet = () => js(`(() => {
    const card = document.querySelector('.ts-sheet .tool-store-card');
    if (!card) return null;
    return { badges: [...card.querySelectorAll(':scope > .tool-store-card-top > :is(.tool-store-badge, .set-pill), :scope > .tool-store-badge')].map(b => b.textContent.trim()),
      pill: card.querySelector('.ts-row-pill')?.textContent || null,
      health: card.querySelector('.tool-store-health > span')?.textContent || null,
      healthCheck: (() => { const b = card.querySelector('.tool-store-health button'); return b ? { text: b.textContent, disabled: b.disabled } : null; })(),
      heldTitle: card.querySelector('.tool-store-held .title')?.textContent || null,
      held: [...card.querySelectorAll('.tool-store-held-tool strong')].map(n => n.textContent),
      meta: [...card.querySelectorAll('.meta, p')].map(n => n.textContent.trim()).filter(Boolean),
      links: [...card.querySelectorAll('a')].map(a => ({ text: a.textContent, href: a.getAttribute('href') })),
      buttons: [...card.querySelectorAll('button')].filter(b => !b.classList.contains('ts-row-hit') && !b.hidden && b.getClientRects().length)
        .map(b => ({ text: b.textContent.trim(), disabled: b.disabled, primary: b.classList.contains('primary') })) };
  })()`);
  const names = (s) => s.buttons.map(b => b.text);
  const click = async (label) => { await js(`[...document.querySelectorAll('.ts-sheet .tool-store-card button')].find(b => b.textContent.trim() === ${q(label)}).click()`); };
  const confirm = async (label) => {
    await waitFor("!!document.querySelector('.panel-dialog.confirm-panel')");
    await js(`[...document.querySelectorAll('.panel-dialog.confirm-panel button')].find(b => b.textContent.trim() === ${q(label)}).click()`);
    await waitFor("!document.querySelector('.panel-dialog.confirm-panel')");
  };
  const stillOneSheet = async (message) => eq(await js("document.querySelectorAll('.ts-sheet').length"), 1, message);
  const wrote = (from, method, path) => writes.slice(from).filter(w => w.method === method && w.path === path);
  const got = (from) => reads.slice(from).map(r => r.path);

  const integration = (id, name, extra = {}) => ({ id, kind: 'mcp_server', name, mcp_type: 'http', url: `https://${id}.example.test/mcp`, has_api_key: false,
    auth: 'none', signed_in: false, enabled: true, status: null, pinned: true, held_tools: [], rea_managed: false, ...extra });
  const working = (tools, when = now - 300) => ({ state: 'working', tools, checked_at: when, error: null });
  const catalog = (id, name, auth, added) => ({ id, name, description: `${name} tools.`, auth, url: `https://${id}.example.test/mcp`, docs: `https://docs.example.test/${id}`, added });

  // ============================================================================================
  // 1. MCP tool entries (catalog + custom): health, availability, actions, and each action's result.
  // ============================================================================================
  await phone();
  demoState.a13Catalog = [catalog('linear', 'Linear', 'oauth', true), catalog('sentry', 'Sentry', 'oauth', true), catalog('deepwiki', 'DeepWiki', 'none', true),
    catalog('context7', 'Context7', 'none', true), catalog('exa', 'Exa', 'none', false), catalog('asana', 'Asana', 'oauth', false)];
  demoState.a13Integrations = [
    integration('linear', 'Linear', { auth: 'oauth', signed_in: true, status: working(12), held_tools: [
      { name: 'delete_issue', kind: 'new', description: 'Delete an issue for good.' }, { name: 'update_issue', kind: 'changed', description: 'Update an issue.' }] }),
    integration('sentry', 'Sentry', { auth: 'oauth', signed_in: false, status: { state: 'signed_out', tools: null, checked_at: now - 300, error: null } }),
    integration('deepwiki', 'DeepWiki', { status: { state: 'down', tools: null, checked_at: now - 60, error: 'ConnectError: connection refused' } }),
    integration('context7', 'Context7', { enabled: false, status: working(5, now - 7200) }),
    integration('custom-http', 'Custom http', { url: 'https://custom.example.test/mcp' }),
    integration('custom-stdio', 'Custom stdio', { mcp_type: 'stdio', url: undefined, command: 'uvx', args: [], status: { state: 'down', tools: null, checked_at: now - 60, error: 'FileNotFoundError: uvx' } }),
    integration('custom-off', 'Custom off', { enabled: false, status: working(3, now - 9000) }),
    integration('custom-oauth', 'Custom oauth', { auth: 'oauth', signed_in: false, status: { state: 'signed_out', tools: null, checked_at: now - 100, error: null } }),
    // As core/integrations.py reports it right after a sign-in finished and before the next check.
    integration('custom-fresh', 'Custom fresh', { auth: 'oauth', signed_in: true, status: { state: 'signed_out', tools: null, checked_at: now - 100, error: null } }),
  ];
  demoState.a13Outcome = {
    deepwiki: { status: working(7, now), },
    linear: { status: { state: 'down', tools: null, checked_at: now, error: 'TimeoutError: no answer' } },
    sentry: { status: { state: 'signed_out', tools: null, checked_at: now, error: null } },
  };
  await load();

  const toolState = async (name) => { await open(name); const s = await sheet(); return s; };

  // Linear: signed in, working, two held tools.
  let s = await toolState('Linear');
  eq(s.badges, ['Connected'], 'Linear badge'); eq(s.pill, 'Connected', 'Linear row pill');
  expect(/^Working · 12 tools · checked /.test(s.health), 'Linear health says Working · 12 tools, got ' + s.health);
  eq(s.held, ['delete_issue', 'update_issue'], 'Linear held tools listed');
  expect(/^2 tools new or changed/.test(s.heldTitle), 'Linear held title ' + s.heldTitle);
  eq(names(s), ['Check', 'Accept', 'Accept', 'Accept all', 'Share to store'], 'Linear offers Check, per-tool Accept, Accept all and Share (and no Sign in/Add)');
  expect(s.links.some(l => l.text === 'Documentation'), 'Linear links its documentation');
  await capture('a13-sheet-tool-working-held');
  // Accept one tool: one POST, count goes up by one, one tool left, no "Accept all", sheet stays open.
  let w = writes.length, r = reads.length;
  await js("document.querySelector('.ts-sheet .tool-store-held-tool button').click()");
  await waitFor("document.querySelector('.ts-sheet .tool-store-held .title')?.textContent.startsWith('1 tool new')");
  const accept1 = wrote(w, 'POST', '/api/integrations/linear/tools/accept');
  eq(accept1.map(x => JSON.parse(x.body)), [{ names: ['delete_issue'] }], 'Accept sends exactly the one tool name');
  eq(accept1.map(x => x.status), [200], 'Accept answered 200');
  eq(got(r), [], 'Accepting a held tool reads nothing again');
  await stillOneSheet('the sheet is still the only one after Accept');
  s = await sheet();
  expect(/^Working · 13 tools/.test(s.health), 'accepting one raises the working count to 13, got ' + s.health);
  eq(s.held, ['update_issue'], 'the accepted tool left the held list');
  eq(names(s), ['Check', 'Accept', 'Share to store'], 'one held tool: no Accept all');
  await js("document.querySelector('.ts-sheet .tool-store-held-tool button').click()");
  await waitFor("!document.querySelector('.ts-sheet .tool-store-held')");
  s = await sheet();
  expect(/^Working · 14 tools/.test(s.health), 'accepting the last tool: 14, got ' + s.health);
  eq(names(s), ['Check', 'Share to store'], 'nothing held: Check (and Share)');
  // Check -> backend says it is down now: badge, row pill and health line all follow, in the same sheet.
  w = writes.length; r = reads.length;
  await click('Check');
  await waitFor("document.querySelector('.ts-sheet .tool-store-health > span')?.textContent.startsWith('Not responding')");
  eq(wrote(w, 'POST', '/api/integrations/linear/check').length, 1, 'Check sends one POST');
  eq(got(r), [], 'Check re-reads nothing');
  s = await sheet();
  eq(s.badges, ['Not responding'], 'a server that stopped answering is no longer Connected'); eq(s.pill, 'Not responding', 'row pill follows the check');
  expect(/^Not responding · TimeoutError: no answer · checked /.test(s.health), 'health shows the reason: ' + s.health);
  await stillOneSheet('Check keeps the one open sheet');
  await close();

  // Sentry (catalog, OAuth, signed out).
  s = await toolState('Sentry');
  eq(s.badges, ['Needs sign-in'], 'Sentry badge'); eq(s.health, 'Not signed in', 'Sentry health');
  expect(names(s).includes('Sign in') && names(s).includes('Check') && !names(s).includes('Add'), 'Sentry offers Sign in and Check only: ' + names(s));
  await close();

  // DeepWiki (catalog, down): Check recovers.
  s = await toolState('DeepWiki');
  eq(s.badges, ['Not responding'], 'DeepWiki badge'); expect(s.health.startsWith('Not responding · ConnectError: connection refused'), 'DeepWiki says why: ' + s.health);
  await click('Check');
  await waitFor("document.querySelector('.ts-sheet .tool-store-health > span')?.textContent.startsWith('Working')");
  s = await sheet();
  eq(s.badges, ['Connected'], 'a recovered server is Connected again'); expect(/^Working · 7 tools/.test(s.health), 'recovered health: ' + s.health);
  await close();

  // Context7 (catalog, turned off): the health line says Turned off, so the badge must not say Connected.
  s = await toolState('Context7');
  expect(s.health === 'Turned off', 'Context7 health says Turned off: ' + s.health);
  eq(s.healthCheck, { text: 'Check', disabled: true }, 'a turned-off server cannot be checked');
  expect(!s.badges.includes('Connected') && !s.badges.includes('Added'),
    'BUG A13-D2 a turned-off catalog server shows badge ' + JSON.stringify(s.badges) + ' (row pill ' + s.pill + ') beside the health line "Turned off" (tool-store.js toolCard reads server.added, not integration.enabled)');
  await capture('a13-sheet-tool-off');
  await close();

  // Not added.
  s = await toolState('Exa');
  eq(s.badges, ['Tool server'], 'Exa badge'); eq(s.health, null, 'a server that is not added has no health line'); eq(names(s), ['Add'], 'Exa offers Add only');
  await close();
  s = await toolState('Asana');
  eq(names(s), ['Add and sign in'], 'Asana (OAuth, not added) offers Add and sign in only');
  await close();

  // Custom entries.
  s = await toolState('Custom http');
  eq(s.health, 'Not checked yet', 'a custom server nobody checked says so'); eq(names(s).slice(0, 2), ['Check', 'Manage'], 'custom http actions start Check, Manage');
  expect(names(s).includes('Share to store') || names(s).some(n => /share/i.test(n)), 'an http custom server can be shared (admin): ' + names(s));
  await close();
  s = await toolState('Custom stdio');
  eq(s.badges, ['Not responding'], 'custom stdio badge'); expect(s.meta.includes('Local command: uvx'), 'custom stdio names its command: ' + s.meta);
  expect(s.health.startsWith('Not responding · FileNotFoundError: uvx'), 'custom stdio health says why: ' + s.health);
  expect(!names(s).some(n => /share/i.test(n)), 'a local command cannot be shared: ' + names(s));
  await close();
  s = await toolState('Custom off');
  eq(s.badges, ['Turned off'], 'custom off badge');
  eq(s.health, 'Turned off', 'custom off health'); eq(s.healthCheck, { text: 'Check', disabled: true }, 'custom off cannot be checked');
  expect(!names(s).includes('Sign in'), 'a turned-off server offers no Sign in');
  await close();
  s = await toolState('Custom oauth');
  eq(s.badges, ['Needs sign-in'], 'custom oauth badge'); eq(s.health, 'Not signed in', 'custom oauth health'); expect(names(s).includes('Sign in'), 'custom oauth offers Sign in');
  // Sign in: result reaches the sheet (badge, button gone) with ONE extra read of /api/integrations.
  w = writes.length; r = reads.length;
  await click('Sign in');
  await waitFor("document.querySelector('.ts-sheet .tool-store-badge')?.textContent === 'Connected'");
  eq(wrote(w, 'POST', '/api/integrations/custom-oauth/oauth/start').length, 1, 'Sign in starts OAuth once');
  eq(got(r), ['/api/integrations'], 'after Sign in the store re-reads only /api/integrations');
  s = await sheet();
  expect(!names(s).includes('Sign in'), 'signed in: no Sign in button left');
  expect(s.health !== 'Not signed in',
    'BUG A13-D1 right after sign-in the sheet says badge ' + JSON.stringify(s.badges) + ' and health "' + s.health + '": /api/integrations keeps the old signed_out status until the next check (core/mcp_oauth.py never records one)');
  await close();
  s = await toolState('Custom fresh');
  expect(!(s.badges.includes('Connected') && s.health === 'Not signed in'),
    'BUG A13-D1 a signed-in server (as the backend reports it after sign-in) shows Connected and "Not signed in" together');
  await close();

  // The whole list: no card may contradict itself.
  const contradictions = await js(`[...document.querySelectorAll('.tool-store-card')].map(c => ({ name: (c.querySelector('h4 .ts-desktop-name') || c.querySelector('h4')).textContent,
    badge: c.querySelector(':scope > .tool-store-card-top > .tool-store-badge')?.textContent, health: c.querySelector('.tool-store-health > span')?.textContent || '' }))
    .filter(c => c.health && ((c.badge === 'Connected' && /^(Not responding|Not signed in|Turned off)/.test(c.health)) || (c.badge === 'Not responding' && !/^Not responding/.test(c.health))
      || (c.badge === 'Needs sign-in' && /^Working/.test(c.health))))`);
  console.log('A13 contradicting tool cards after the actions above: ' + JSON.stringify(contradictions));
  // (each is already reported above with its own message)

  // ============================================================================================
  // 2. Skill entries: provenance, availability, actions; plus the Manage dialog's scan detail.
  // ============================================================================================
  demoState.a13Integrations = null; demoState.a13Catalog = null;
  demoState.a13Addons = [
    { id: 'roblox', name: 'Roblox', description: 'Build Roblox games.', skills: ['roblox-dev-skill'], installed: false, enabled: false },
    { id: 'blender', name: 'Blender', description: 'Make 3D models.', skills: ['blender-creation'], installed: true, enabled: true },
    { id: 'higgsfield', name: 'Higgsfield', description: 'Make video.', skills: ['higgsfield-creation'], installed: true, enabled: false },
  ];
  demoState.recordedSkills = [
    { slug: 'my-notes', description: 'Mine.', version: '2.1', curation: { source: 'user', origin: null, scan: null, blocked_for_models: false, approved: false, lint: [] } },
    { slug: 'from-github', description: 'From a repo.', curation: { source: 'imported', origin: 'https://raw.githubusercontent.com/o/r/main/SKILL.md', scan: { verdict: 'safe', findings: [] }, blocked_for_models: false, approved: false, lint: [] } },
    { slug: 'blender-creation', description: 'Blender helper.', curation: { source: 'bundled', origin: null, scan: null, blocked_for_models: false, approved: false, lint: [] } },
    { slug: 'recorded-one', description: 'Recorded.', curation: { source: 'recorded', origin: 'computer demonstration', scan: { verdict: 'safe', findings: [] }, blocked_for_models: false, approved: false, lint: [] } },
    { slug: 'pulled-one', description: 'Pulled by the store.', curation: { source: 'community', origin: null, scan: { verdict: 'safe', findings: [] }, blocked_for_models: true, disabled: true, approved: false, lint: [] } },
  ];
  await load();
  s = await toolState('weekly-review');
  eq(s.badges, ['Available'], 'bundled skill is Available'); eq(s.pill, 'On', 'its row pill'); expect(s.meta.includes('Built into Kairos') || s.links.length === 0, 'bundled provenance');
  eq(names(s), ['View skill'], 'a bundled skill offers View skill only (no Share)');
  expect(await js("document.querySelector('.ts-sheet .tool-store-card-foot').textContent.includes('Built into Kairos')"), 'bundled provenance says Built into Kairos');
  await close();
  s = await toolState('my-notes');
  eq(names(s).filter(n => n !== 'Share to store' && !/share/i.test(n)), ['View skill'], 'a user skill: View skill'); expect(names(s).length === 2, 'a user skill can be shared: ' + names(s));
  expect(await js("document.querySelector('.ts-sheet .tool-store-card-foot').textContent.includes('Local skill · v2.1')"), 'user skill shows Local skill and its version');
  await close();
  s = await toolState('from-github');
  eq(s.links.map(l => l.text), ['GitHub source'], 'a GitHub import links its source'); eq(s.links[0].href, 'https://raw.githubusercontent.com/o/r/main/SKILL.md', 'the source link is the recorded origin');
  await close();
  s = await toolState('recorded-one');
  expect(await js("document.querySelector('.ts-sheet .tool-store-card-foot').textContent.includes('Recorded skill')"), 'recorded provenance'); await close();
  s = await toolState('blender-creation');
  expect(await js("document.querySelector('.ts-sheet .tool-store-card-foot').textContent.includes('Tool Store add-on')"), 'an add-on skill says it comes from an add-on'); await close();
  s = await toolState('writing-partner');
  eq(s.badges, ['Available'], 'a caution-scan import not yet approved is Available (it is not blocked)');
  // A13-D3 (an observation for David, not a failure): the sheet shows nothing of the scan; it is in Manage skills.
  console.log('A13-D3 note: writing-partner sheet shows its scan: ' + await js("document.querySelector('.ts-sheet').textContent.toLowerCase().includes('caution')"));
  await close();
  s = await toolState('sync-helper');
  eq(s.badges, ['Needs approval'], 'a dangerous-scan skill is Needs approval'); eq(s.pill, 'Needs approval', 'row pill');
  expect(!names(s).includes('Approve for models'), 'the sheet itself offers no Approve (it lives in Manage skills)');
  console.log('A13-D3 note: sync-helper sheet says why it is hidden: ' + await js("/dangerous|hidden from models/i.test(document.querySelector('.ts-sheet').textContent)"));
  await close();
  // A13-D5: a skill the store turned off reads as turned off, never as needing approval.
  s = await toolState('pulled-one');
  eq(s.badges, ['Turned off'], 'a store-pulled skill says Turned off'); eq(s.pill, 'Off', 'and its row pill says Off');
  await close();
  s = await toolState('broken-skill');
  eq(s.badges, ["Can't be read"], 'a broken skill says it cannot be read'); eq(names(s), ['Delete'], 'a broken skill offers Delete only (no View skill, no Share)');
  expect(s.meta.some(m => m.includes('No model is offered it until it is fixed or deleted')), 'and says no model gets it');
  w = writes.length;
  await click('Delete');
  await waitFor("!document.querySelector('.ts-sheet')");
  eq(wrote(w, 'DELETE', '/api/skills/broken-skill').length, 1, 'Delete removes the skill with one DELETE');
  expect(await js(`!${cardJs('broken-skill')}`), 'the deleted skill leaves the list, and the sheet closed with it');

  // Desktop dialogs: View skill -> body from the backend, Manage skills -> scan and provenance detail.
  await desktop();
  await load();
  r = reads.length;
  const viewJs = (slug) => `${cardJs(slug)}.querySelector('.tool-store-card-foot button')`;
  await js(`${viewJs('sync-helper')}.click()`);
  await waitFor("!!document.querySelector('.modal-panel .tool-store-skill-body, .panel-dialog .tool-store-skill-body')");
  eq(got(r), ['/api/skills/sync-helper'], 'View skill reads exactly the skill body');
  expect(await js("document.querySelector('.tool-store-skill-body').textContent.includes('Procedure')"), 'View skill shows the body');
  r = reads.length;
  await js("[...document.querySelectorAll('.panel-dialog button')].find(b => b.textContent === 'Manage skill').click()");
  await waitFor("!!document.querySelector('.tool-store-manager #skills-list [data-skill=sync-helper]')");
  const managed = await js("(() => { const c = (slug) => document.querySelector('.tool-store-manager [data-skill=' + slug + ']')?.textContent || ''; return { sync: c('sync-helper'), writing: c('writing-partner'), weekly: c('weekly-review'), mine: c('my-notes'), pulled: c('pulled-one'), pulledApprove: [...document.querySelectorAll('[data-skill=pulled-one] button')].some(b => b.textContent === 'Approve for models'), approve: !!document.querySelector('[data-skill=sync-helper] button.danger') }; })()");
  expect(managed.pulled.includes('Turned off by the store') && !managed.pulled.includes('dangerous') && !managed.pulledApprove, 'A13-D5 Manage shows a pulled skill as turned off, with no Approve: ' + managed.pulled);
  console.log('REQUESTS Manage skill from View skill: ' + JSON.stringify(got(r)));
  expect(managed.sync.includes('Origin unknown') && managed.sync.includes('Scan: dangerous (1 finding)') && managed.sync.includes('Hidden from models: its content scanned as dangerous.'), 'Manage shows the dangerous skill hidden with its scan: ' + managed.sync);
  expect(managed.approve, 'a hidden skill offers Approve for models in Manage');
  expect(managed.writing.includes('Imported from writing-partner.md · Scan: caution (1 finding)') && managed.writing.includes('2 notes') && !managed.writing.includes('Hidden from models'), 'Manage shows caution import visible with finding and advice: ' + managed.writing);
  expect(managed.weekly.includes('Bundled with Kairos · Not scanned (trusted source)') && !managed.weekly.includes('Hidden'), 'Manage shows bundled: ' + managed.weekly);
  expect(managed.mine.includes('Written in Kairos'), 'Manage shows a user skill as Written in Kairos: ' + managed.mine);
  await capture('a13-manage-skills-detail');
  await js("document.querySelector('.panel-dialog button[aria-label=Close]').click()");
  await waitFor("!document.querySelector('.panel-dialog')");

  // ============================================================================================
  // 3. Community entries.
  // ============================================================================================
  demoState.communityInstalls = {
    example_reference: { installed: true, installed_version: '1.1.0' },
    weekly_review: { installed: true, installed_version: '1.1.0', turned_off: true, revoked_reason: 'Pulled for review' },
  };
  await phone();
  await load();
  s = await toolState('community:Pomodoro');
  eq(s.badges, ['Community'], 'an uninstalled community item is Community'); eq(names(s), ['Install'], 'it offers Install only');
  expect(s.meta.includes('Community · tab · @david-darr · v1.1.0'), 'provenance line: ' + s.meta);
  await close();
  s = await toolState('Meeting summary');
  eq(s.badges, ['Update available'], 'update badge'); eq(s.pill, 'Update', 'row pill'); eq(names(s), ['Update', 'Manage', 'Remove'], 'an installed item with an update offers Update, Manage, Remove');
  await close();
  s = await toolState('Reference server (example)');
  eq(s.badges, ['Installed'], 'installed badge'); eq(names(s), ['Manage', 'Remove'], 'installed: Manage and Remove, no Install'); await close();
  s = await toolState('Weekly review');
  eq(s.badges, ['Turned off'], 'a pulled item is Turned off'); eq(s.pill, 'Off', 'row pill');
  eq(names(s), ['Turn back on', 'Manage', 'Remove'], 'a pulled item offers Turn back on'); expect(s.meta.includes('Pulled for review'), 'and says why'); await capture('a13-sheet-community-off');
  w = writes.length; r = reads.length;
  demoState.communityInstalls.weekly_review = { installed: true, installed_version: '1.1.0', turned_off: false };
  await click('Turn back on'); await confirm('Turn back on');
  await waitFor("document.querySelector('.ts-sheet .tool-store-badge')?.textContent === 'Installed'");
  const reenable = wrote(w, 'POST', '/api/store/revoked/automation/weekly_review/reenable');
  eq(reenable.map(x => JSON.parse(x.body)), [{ confirmed: true, expected_revocation: 'Pulled for review' }], 'Turn back on sends the reason it confirmed');
  s = await sheet(); eq(names(s), ['Manage', 'Remove'], 'back on: Manage, Remove');
  console.log('REQUESTS community action (Turn back on): ' + JSON.stringify(got(r)));
  await close();
  // Install -> review gate -> Installed; Remove -> Community again.
  await open('community:Pomodoro');
  w = writes.length;
  await click('Install');
  await waitFor("!!document.querySelector('.ts-sheet .tool-store-scan')");
  expect(await js("document.querySelector('.ts-sheet .tool-store-scan').textContent.includes('Review this tab') && document.querySelector('.ts-sheet .tool-store-scan').textContent.includes('SHA-256: ' + 'b'.repeat(64))"), 'the install gate shows the review and fingerprint in the sheet');
  await click('Install anyway');
  await waitFor("document.querySelector('.ts-sheet .tool-store-badge')?.textContent === 'Installed'");
  const installs = wrote(w, 'POST', '/api/store/install').map(x => JSON.parse(x.body));
  eq(installs.length, 2, 'install asks twice: once to scan, once confirmed'); eq([installs[1].confirmed, installs[1].expected_fingerprint], [true, 'b'.repeat(64)], 'the confirmed install is bound to the scanned fingerprint');
  s = await sheet(); eq(names(s), ['Manage', 'Remove'], 'installed community tab: Manage, Remove'); await stillOneSheet('install keeps one sheet');
  w = writes.length;
  await click('Remove'); await confirm('Remove');
  await waitFor("document.querySelector('.ts-sheet .tool-store-badge')?.textContent === 'Community'");
  eq(wrote(w, 'DELETE', '/api/store/installed/tab/pomodoro').length, 1, 'Remove sends one DELETE');
  s = await sheet(); eq(names(s), ['Install'], 'removed: Install is back'); await close();
  demoState.communityInstalls.pomodoro = { install_blocked: true, revoked_reason: 'Withdrawn by the maintainer' };
  await load();
  s = await toolState('community:Pomodoro');
  eq(s.badges, ['Revoked'], 'a revoked item that was never installed says Revoked'); eq(s.pill, 'Revoked', 'row pill');
  eq(s.buttons.map(b => [b.text, b.disabled]), [['Install', true]], 'and its Install is disabled'); expect(s.meta.includes('Withdrawn by the maintainer'), 'and says why');
  await close();

  // ============================================================================================
  // 4. Tab entries (Prebuilt / Yours / Turned off) and add-ons.
  // ============================================================================================
  demoState.communityInstalls = {};
  const tabsList = [
    { slug: 'school', name: 'School', description: 'Courses', kind: 'prebuilt', format: 'prebuilt', enabled: true, status: 'on' },
    { slug: 'crm', name: 'CRM', description: 'Contacts', kind: 'prebuilt', format: 'prebuilt', enabled: false, status: 'off' },
    { slug: 'broken_prebuilt', name: 'Broken prebuilt', description: 'x', kind: 'prebuilt', format: 'prebuilt', enabled: false, status: 'invalid', reason: 'tab.json is not valid JSON.' },
    { slug: 'future_tab', name: 'Future tab', description: 'x', kind: 'prebuilt', format: 'prebuilt', enabled: false, status: 'needs_newer_kairos', reason: 'Needs Kairos 9.' },
    { slug: 'project_tracker', name: 'Project tracker', description: 'Notes', kind: 'user', format: 'folder', status: 'needs_approval', fingerprint: 'a'.repeat(64), files: ['tab.json', 'view.js'] },
    { slug: 'daily_log', name: 'Daily log', description: 'Log', kind: 'user', format: 'folder', enabled: true, approved: true, status: 'on', fingerprint: 'd'.repeat(64), files: ['tab.json'] },
    { slug: 'old_tab', name: 'Old tab', description: 'Old', kind: 'user', format: 'folder', enabled: false, approved: true, status: 'off', fingerprint: 'e'.repeat(64), files: ['tab.json'] },
    { slug: 'bad_tab', name: 'Bad tab', description: 'Bad', kind: 'user', format: 'folder', status: 'invalid', reason: 'view.js is missing.', fingerprint: 'f'.repeat(64), files: [] },
  ];
  demoState.tabs = null;
  await load();
  s = await toolState('Project tracker');
  eq(s.badges, ['Needs approval'], 'default fixture: user tab needs approval');
  w = writes.length; r = reads.length;
  await click('Approve'); await confirm('Approve source');
  await waitFor("document.querySelector('.ts-sheet .tool-store-card-top .set-pill')?.textContent === 'On'");
  eq(wrote(w, 'POST', '/api/system/custom-tabs/project_tracker/approve').map(x => JSON.parse(x.body)), [{ fingerprint: 'a'.repeat(64) }], 'Approve is bound to the fingerprint shown');
  console.log('REQUESTS tab Approve (action and result): ' + JSON.stringify(got(r)));
  s = await sheet(); expect(!names(s).includes('Approve') && names(s).includes('Turn off'), 'approved: Approve is gone, Turn off stays: ' + names(s));
  await click('Turn off');
  await waitFor("document.querySelector('.ts-sheet .tool-store-card-top .set-pill')?.textContent === 'Off'");
  s = await sheet(); expect(names(s).includes('Turn on') && !names(s).includes('Turn off') && !names(s).includes('Approve'), 'turned off: Turn on replaces Turn off, no Approve: ' + names(s));
  await stillOneSheet('turning a tab off keeps the one sheet (its card moved to Turned off)');
  await click('Turn on');
  await waitFor("document.querySelector('.ts-sheet .tool-store-card-top .set-pill')?.textContent === 'On'");
  await close();
  demoState.tabs = tabsList;
  await load();
  s = await toolState('School'); eq(s.badges, ['On'], 'prebuilt on'); eq(names(s), ['Remove'], 'a prebuilt tab that is on offers Remove'); await close();
  s = await toolState('CRM'); eq(s.badges, ['Off'], 'prebuilt off'); eq(s.buttons.map(b => [b.text, b.disabled]), [['Add', false]], 'off: Add, enabled'); await close();
  s = await toolState('Broken prebuilt'); eq(s.badges, ['Invalid'], 'invalid prebuilt'); eq(s.pill, 'Invalid', 'row pill'); eq(s.buttons.map(b => [b.text, b.disabled]), [['Add', true]], 'invalid: Add is disabled'); expect(s.meta.includes('tab.json is not valid JSON.'), 'and says why'); await close();
  s = await toolState('Future tab'); eq(s.badges, ['Needs a newer Kairos'], 'needs newer'); eq(s.pill, 'Needs update', 'row pill'); eq(s.buttons.map(b => [b.text, b.disabled]), [['Add', true]], 'Add is disabled'); await close();
  s = await toolState('Project tracker');
  eq(s.badges, ['Needs approval'], 'a user tab waiting for approval'); eq(names(s), ['Review files', 'Approve', 'Turn off', 'Remove', 'Export', 'Share to store'], 'its actions: review, approve, turn off, remove, export, share');
  eq(s.buttons.find(b => b.text === 'Approve').primary, true, 'Approve leads');
  await capture('a13-sheet-tab-needs-approval');
  await close();
  // Row pills: the phone row must carry the tab's state like every other kind's row.
  eq(await js(`${cardJs('School')}.querySelector('.ts-row-pill')?.textContent || null`), 'On', 'BUG A13-D4 the phone row of a tab has no status pill (redesignToolStoreMobile.js reads .pill, tab cards use .set-pill)');
  eq(await js(`${cardJs('Project tracker')}.querySelector('.ts-row-pill')?.textContent || null`), 'Needs approval', 'BUG A13-D4 a tab waiting for approval shows no pill on its phone row');
  s = await (async () => { demoState.tabs = tabsList; await load(); return toolState('Daily log'); })();
  eq(s.badges, ['On'], 'an approved, enabled user tab is On'); expect(!names(s).includes('Approve'), 'no Approve once approved'); expect(names(s).includes('Turn off'), 'it can be turned off'); await close();
  s = await toolState('Old tab'); eq(s.badges, ['Off'], 'a turned-off user tab is Off'); expect(names(s)[0] === 'Review files' && names(s).includes('Turn on') && !names(s).includes('Approve'), 'Turned off offers Turn on, not Approve: ' + names(s));
  eq(s.buttons.find(b => b.text === 'Turn on').primary, true, 'Turn on leads'); await close();
  s = await toolState('Bad tab'); eq(s.badges, ['Invalid'], 'an invalid user tab'); expect(s.meta.includes('view.js is missing.'), 'says why');
  eq(s.buttons.find(b => b.text === 'Approve')?.disabled, true, 'its Approve is disabled'); await close();
  expect(await js("[...document.querySelectorAll('.tool-store-heading')].some(h => h.textContent.startsWith('Prebuilt · 4')) && [...document.querySelectorAll('.tool-store-heading')].some(h => h.textContent.startsWith('Yours · 3')) && [...document.querySelectorAll('.tool-store-heading')].some(h => h.textContent.startsWith('Turned off · 1'))"),
    'sections count tabs by state: Prebuilt 4, Yours 3, Turned off 1');
  demoState.tabs = null;

  // Add-ons.
  s = await toolState('Roblox');
  eq(s.badges, ['Optional add-on'], 'add-on not installed'); eq(s.pill, 'Add-on', 'row pill'); eq(names(s), ['Install add-on'], 'it offers Install add-on only'); await close();
  s = await toolState('Higgsfield');
  eq(s.badges, ['Disabled add-on'], 'installed but disabled'); eq(s.pill, 'Off', 'row pill'); eq(names(s), ['Enable', 'Reinstall', 'Remove add-on'], 'disabled: Enable, Reinstall, Remove (no Manage connection)'); await close();
  s = await toolState('Blender');
  eq(s.badges, ['Enabled add-on'], 'enabled'); eq(s.pill, 'On', 'row pill'); eq(names(s), ['Manage connection', 'Disable', 'Reinstall', 'Remove add-on'], 'enabled add-on actions');
  w = writes.length; r = reads.length;
  await click('Disable');
  await waitFor("document.querySelector('.ts-sheet .tool-store-badge')?.textContent === 'Disabled add-on'");
  eq(wrote(w, 'POST', '/api/addons/blender').map(x => JSON.parse(x.body)), [{ action: 'disable' }], 'Disable sends the one action');
  s = await sheet(); eq(names(s), ['Enable', 'Reinstall', 'Remove add-on'], 'after Disable the sheet drops Manage connection and offers Enable'); eq(s.pill, 'Off', 'pill follows');
  console.log('REQUESTS add-on action (Disable): ' + JSON.stringify(got(r)));
  await stillOneSheet('Disable keeps one sheet');
  await click('Enable');
  await waitFor("document.querySelector('.ts-sheet .tool-store-badge')?.textContent === 'Enabled add-on'");
  s = await sheet(); eq(names(s)[0], 'Manage connection', 'after Enable Manage connection is back');
  await close();

  // Not an admin: the same cards must not offer admin actions.
  demoState.isAdmin = false; demoState.tabs = tabsList;
  await load();
  eq(await js("[...document.querySelectorAll('.tool-store-heading')].some(h => h.textContent.startsWith('Community'))"), false, 'a non-admin sees no Community section');
  s = await toolState('Project tracker'); eq(names(s), [], 'a non-admin sees no tab actions (no Approve, Turn off, Remove, Export, Share, Review): ' + JSON.stringify(names(s))); await close();
  s = await toolState('Blender'); expect(s.buttons.filter(b => ['Disable', 'Reinstall', 'Remove add-on'].includes(b.text)).every(b => b.disabled), 'a non-admin sees the add-on actions disabled'); await close();
  demoState.isAdmin = undefined; demoState.tabs = null;

  // ============================================================================================
  // 5. Efficiency: sheet open latency and requests per open, over every kind of row.
  // ============================================================================================
  await load();
  const rows = await js("[...document.querySelectorAll('.tool-store-card .ts-row-hit')].length");
  const samples = []; const before = { reads: reads.length, writes: writes.length };
  for (let i = 0; i < 40; i++) {
    const t = await js(`(async () => { const hits = [...document.querySelectorAll('.tool-store-card .ts-row-hit')]; const hit = hits[${i} % hits.length];
      const t0 = performance.now(); hit.click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const ms = performance.now() - t0; const ok = !!document.querySelector('.ts-sheet .tool-store-card'); document.querySelector('.ts-sheet-close').click();
      return { ms, ok }; })()`);
    expect(t.ok, 'sheet open #' + i + ' produced a card');
    samples.push(t.ms);
    await waitFor("!document.querySelector('.ts-sheet')");
  }
  samples.sort((a, b) => a - b);
  const p = (f) => samples[Math.min(samples.length - 1, Math.floor(samples.length * f))].toFixed(1);
  console.log(`BENCH detail sheet open (click to second frame, ${rows} rows, n=40): p50 ${p(.5)} ms, p95 ${p(.95)} ms, max ${samples.at(-1).toFixed(1)} ms`);
  const openReads = got(before.reads);
  console.log(`REQUESTS per sheet open: ${openReads.length} GETs ${JSON.stringify(openReads)} and ${writes.length - before.writes} writes over 40 opens`);
  expect(!openReads.some(path => /skills|integrations|store|addons|tabs/.test(path)) && writes.length === before.writes, 'EFFICIENCY opening a detail sheet read or wrote Tool Store data: ' + JSON.stringify(openReads));
  expect(samples[Math.floor(samples.length * .95)] < 100, 'EFFICIENCY sheet open p95 over 100 ms');

  // Cleanup so later modules see a normal fixture.
  for (const key of ['a13Catalog', 'a13Integrations', 'a13Addons', 'a13Outcome', 'recordedSkills', 'communityInstalls', 'tabs', 'isAdmin']) delete demoState[key];
  await desktop();
  assert.ok(true);
  if (problems.length) throw new Error('a13 findings (' + problems.length + '):\n- ' + problems.join('\n- '));
};
