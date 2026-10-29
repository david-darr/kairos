// Bots navigation (Phase 1, unit U4): plain-Node checks of static/js/botsNavigation.js,
// the one boundary every old Agents link, push URL, notch chip and chat link crosses.
// Run: node scripts/test_bots_navigation.cjs
//   - every legacy intent in the design's table (section 7) lands on its destination
//   - malformed or hostile targets are refused or dropped, never passed on
//   - a session that belongs to a bot opens inside that bot, whatever else is stored
//   - notification URLs: same origin, bare path, clean ids, nothing else
//   - the module imports nothing and touches no page object, so it runs before any view mounts
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const file = path.join(__dirname, '..', 'static', 'js', 'botsNavigation.js');
const load = () => import(pathToFileURL(file).href);
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };
const ORIGIN = 'https://kairos.example';

(async () => {
  const N = await load();

  check('agents with no target opens the Bots roster', () => {
    assert.deepEqual(N.normalizeBotsTarget('agents'), { tab: 'botsHome' });
    assert.deepEqual(N.normalizeBotsTarget('agents', {}), { tab: 'botsHome' });
    assert.deepEqual(N.normalizeBotsTarget('agents', null), { tab: 'botsHome' });
  });

  check('a bot, with or without a conversation, opens that bot and keeps the conversation', () => {
    assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: 'a1' }), { tab: 'botsShell', agentId: 'a1' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: 'a1', sessionId: 's9' }), { tab: 'botsShell', agentId: 'a1', sessionId: 's9' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { agent_id: 'a1', session_id: 's9' }), { tab: 'botsShell', agentId: 'a1', sessionId: 's9' }, 'the server spelling too');
    assert.deepEqual(N.normalizeBotsTarget({ tab: 'agents', agentId: 'a1' }), { tab: 'botsShell', agentId: 'a1' }, 'one object form');
  });

  check('a conversation with no bot does not become a Bots target', () => {
    assert.deepEqual(N.normalizeBotsTarget('agents', { sessionId: 's9' }), { tab: 'botsHome' });
  });

  check('profile and settings intents open the bot panel on the mapped section', () => {
    assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: 'a1', profile: true }), { tab: 'botsShell', agentId: 'a1', panel: 'overview' });
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', profile: true, section: 'memory' }).panel, 'memory');
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', settingsSection: 'Slack' }).panel, 'delivery');
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', panel: 'instructions' }).panel, 'soul');
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', panel: 'Voice & alerts' }).panel, 'voice');
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', panel: 'who can see it' }).panel, 'visibility');
    for (const section of ['overview', 'identity', 'delivery', 'soul', 'skills', 'memory', 'routines', 'access', 'model', 'permissions', 'voice', 'visibility', 'history', 'usage']) {
      assert.equal(N.panelSection(section), section, section);
    }
    assert.equal(N.panelSection('nonsense'), undefined);
    assert.equal(N.panelSection('__proto__'), undefined);
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', panel: 'nonsense' }).panel, undefined, 'an unknown section is dropped, the bot still opens');
    assert.equal(N.normalizeBotsTarget('agents', { profile: true }).panel, undefined, 'a panel needs a bot');
  });

  check('an inbox intent opens the attention panel and keeps the source item', () => {
    assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: 'a1', inbox: true }), { tab: 'botsShell', agentId: 'a1', attention: 'inbox' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: 'a1', agentTab: 'inbox', sourceId: 'q7' }), { tab: 'botsShell', agentId: 'a1', attention: 'inbox', sourceId: 'q7' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { inbox: true }), { tab: 'botsHome', attention: 'inbox' }, 'with no bot it opens from the roster');
    for (const attention of ['inbox', 'notifications', 'activity', 'inspector']) assert.equal(N.normalizeBotsTarget('agents', { attention }).attention, attention);
    assert.equal(N.normalizeBotsTarget('agents', { attention: 'sideways' }).attention, undefined);
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', sourceId: 'q7' }).sourceId, undefined, 'a source needs an attention panel');
  });

  check('a message jump needs a bot', () => {
    assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', sessionId: 's1', messageId: 'm5' }).messageId, 'm5');
    assert.equal(N.normalizeBotsTarget('agents', { messageId: 'm5' }).messageId, undefined);
  });

  check('a team opens the existing Swarm destination, not Bots', () => {
    assert.deepEqual(N.normalizeBotsTarget('agents', { team: 's1' }), { tab: 'swarm', systemId: 's1' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { team: 'new' }), { tab: 'swarm', systemId: 'new' }, 'a new team');
    assert.deepEqual(N.normalizeBotsTarget('agents', { team: { id: 's2' } }), { tab: 'swarm', systemId: 's2' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { systemId: 's3', team: true }), { tab: 'swarm', systemId: 's3' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: 'a1', team: 's1' }), { tab: 'swarm', systemId: 's1' }, 'a team link wins over a stray bot');
    assert.deepEqual(N.normalizeBotsTarget('agents', { team: '../etc' }), { tab: 'botsHome' }, 'a bad team id falls back, it does not open Swarm');
  });

  check('an ecosystem intent opens the roster; the village is retired', () => {
    assert.deepEqual(N.normalizeBotsTarget('agents', { agentTab: 'ecosystem' }), { tab: 'botsHome' });
    assert.deepEqual(N.normalizeBotsTarget('agents', { ecosystem: true }), { tab: 'botsHome' });
  });

  check('the Bots tab ids pass through without the legacy rules', () => {
    assert.deepEqual(N.normalizeBotsTarget('botsHome'), { tab: 'botsHome' });
    assert.deepEqual(N.normalizeBotsTarget('botsShell', { agentId: 'a1' }), { tab: 'botsShell', agentId: 'a1' });
    assert.deepEqual(N.normalizeBotsTarget('botsShell'), { tab: 'botsHome' }, 'a bot page with no bot is the roster');
    assert.deepEqual(N.normalizeBotsTarget('botsShell', { team: 's1' }), { tab: 'botsHome' }, 'only the legacy tab can reach Swarm');
  });

  check('other tabs are not ours: they come back as they were', () => {
    for (const tab of ['home', 'chat', 'notes', 'forgeShell', 'swarm', 'settings', '']) assert.deepEqual(N.normalizeBotsTarget(tab, { agentId: 'a1' }), { tab });
    assert.deepEqual(N.normalizeBotsTarget(undefined), { tab: 'home' });
    assert.deepEqual(N.normalizeBotsTarget(7), { tab: 'home' });
  });

  check('malformed ids are dropped, never passed on', () => {
    const bad = ['', ' ', 'a b', '../x', 'a/b', 'a?b=1', '<script>', 'x'.repeat(129), 7, {}, [], null, true, '\n', 'a\u0000'];
    for (const id of bad) {
      assert.equal(N.targetId(id), undefined, JSON.stringify(id));
      assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: id }), { tab: 'botsHome' }, JSON.stringify(id));
      assert.equal(N.normalizeBotsTarget('agents', { agentId: 'a1', sessionId: id }).sessionId, undefined);
    }
    for (const id of ['a', 'A1', 'a_b-c', '0', 'x'.repeat(128)]) assert.equal(N.targetId(id), id);
  });

  check('archived and deleted bots are routed like any other: the view decides what to show', () => {
    // The normalizer has no bot list. An archived bot opens (notifications may open it without restoring it);
    // a deleted one reaches botsShell, which shows its recoverable message.
    for (const id of ['archived-bot', 'deleted-bot']) assert.deepEqual(N.normalizeBotsTarget('agents', { agentId: id }), { tab: 'botsShell', agentId: id });
  });

  check('a stored preference never decides the bot for an explicit link', () => {
    const target = N.normalizeBotsTarget('agents', { agentId: 'chosen', lastBot: 'stored', botId: 'other' });
    assert.equal(target.agentId, 'chosen');
    assert.equal(N.normalizeBotsTarget('agents', { botId: 'b2' }).agentId, 'b2');
    assert.deepEqual(N.sessionTarget({ id: 's1', agent_id: 'a2' }), { tab: 'botsShell', agentId: 'a2', sessionId: 's1' });
  });

  check('a chat session that belongs to a bot opens inside that bot', () => {
    assert.deepEqual(N.sessionTarget({ id: 's1', agent_id: 'a2' }), { tab: 'botsShell', agentId: 'a2', sessionId: 's1' });
    assert.deepEqual(N.sessionTarget({ id: 's1' }), { tab: 'chat', sessionId: 's1' });
    assert.deepEqual(N.sessionTarget({ id: 's1', forge: true }), { tab: 'forgeShell', sessionId: 's1' });
    assert.deepEqual(N.sessionTarget({ id: 's1', is_forge: true }), { tab: 'forgeShell', sessionId: 's1' });
    assert.deepEqual(N.sessionTarget({ id: 's1', agent_id: 'a2', forge: true }), { tab: 'botsShell', agentId: 'a2', sessionId: 's1' }, 'a bot owns its conversation even if flagged');
    assert.deepEqual(N.sessionTarget({ agent_id: 'a2' }), { tab: 'chat' }, 'no usable id');
    assert.deepEqual(N.sessionTarget({ id: 's1', agent_id: '../x' }), { tab: 'chat', sessionId: 's1' }, 'a bad bot id is not trusted');
    assert.deepEqual(N.sessionTarget(null, 's5'), { tab: 'chat', sessionId: 's5' });
    assert.deepEqual(N.sessionTarget(null, '../x'), { tab: 'chat' });
  });

  check('notification links: a bot link opens the bot and its conversation', () => {
    assert.deepEqual(N.notificationTarget('/?agent=a1', ORIGIN), { tab: 'botsShell', agentId: 'a1' });
    assert.deepEqual(N.notificationTarget('/?agent=a1&chat=s2', ORIGIN), { tab: 'botsShell', agentId: 'a1', sessionId: 's2' });
    assert.deepEqual(N.notificationTarget(`${ORIGIN}/?agent=a1&chat=s2&message=m3`, ORIGIN), { tab: 'botsShell', agentId: 'a1', sessionId: 's2', messageId: 'm3' });
    assert.deepEqual(N.notificationTarget('/?agent=a1&attention=inbox&source=q9', ORIGIN), { tab: 'botsShell', agentId: 'a1', attention: 'inbox', sourceId: 'q9' });
    assert.deepEqual(N.notificationTarget('/?chat=s2', ORIGIN), { tab: 'chat', sessionId: 's2' });
    assert.equal(N.notificationTarget('/', ORIGIN), null);
    assert.equal(N.notificationTarget('/?view=notes', ORIGIN), null);
  });

  check('notification links: another origin, a path, credentials or a bad id are refused', () => {
    for (const url of ['https://evil.example/?agent=a1', 'http://kairos.example/?agent=a1', `${ORIGIN}/other?agent=a1`, `${ORIGIN}/x/../?agent=a1&z=1`.replace('/x/..', '/api'),
      `https://user:pw@kairos.example/?agent=a1`, '/?agent=../x', '/?agent=', '/?agent=a1&chat=../x', '/?chat=a%20b', '//evil.example/?agent=a1', 'javascript:alert(1)', 'not a url \u0000']) {
      assert.equal(N.notificationTarget(url, ORIGIN), null, url);
    }
    assert.equal(N.notificationTarget(undefined, ORIGIN), null);
  });

  check('a copied conversation link names the bot and the conversation only', () => {
    const link = N.threadLink(ORIGIN, 'a1', 's2');
    assert.equal(link, `${ORIGIN}/?agent=a1&chat=s2`);
    assert.deepEqual(N.notificationTarget(link, ORIGIN), { tab: 'botsShell', agentId: 'a1', sessionId: 's2' }, 'the link opens what it names');
    assert.equal(N.threadLink('http://localhost:8000/x?y=1#z', 'a1', 's2'), 'http://localhost:8000/?agent=a1&chat=s2', 'path, query and fragment are dropped');
    assert.throws(() => N.threadLink(ORIGIN, '../x', 's2'), /Invalid conversation link/);
    assert.throws(() => N.threadLink(ORIGIN, 'a1', ''), /Invalid conversation link/);
    assert.throws(() => N.threadLink('file:///etc/passwd', 'a1', 's2'), /Invalid app address/);
  });

  check('the module is pure: no imports, no page objects', () => {
    const source = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /^import /m);
    assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|fetch|navigator)\b/);
    assert.ok(!source.includes('—'), 'no em dash');
  });

  console.log(`PASS: ${passed.length} Bots navigation checks.`);
})().catch(error => { console.error(error); process.exit(1); });
