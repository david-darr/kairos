// The grants lane of the Bots fixture backend (Phase 2 unit U4): GET and PUT /api/bots/:id/access for the Access section.
// It judges tools the way services/bot_grants.py does (legacy and explicit readings, off/read/write scopes, deny wins,
// unavailable apps, a revision that rises with any change) over the records in state.botsCore, so a bot a check made
// through /api/agents is the one whose grants are read and saved here. State lives under state.botsGrants:
//   apps       the connected apps ({id, name, kind, available, reason, tools:[{name, effect}]}); seeded on first use
//   native     built-in tools ({name, description, effect}); seeded on first use
//   failNext   'refuse' | 'stale' makes the next save fail that way, once
//   bump       out-of-band changes to the revision (what "changed somewhere else" does)
// Handlers return undefined for routes they do not own.
const core = require('./bots-core-backend.cjs');

class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }

const SEED = () => ({
  apps: [
    { id: 'gh1', name: 'github', kind: 'mcp', available: true, reason: null,
      tools: [{ name: 'list_issues', effect: 'read' }, { name: 'create_issue', effect: 'write' }, { name: 'frobnicate', effect: 'unknown' }] },
    { id: 'down1', name: 'Offline notes', kind: 'mcp', available: false, reason: 'It is switched off in Settings.',
      tools: [{ name: 'read_note', effect: 'read' }] },
    { id: 'google', name: 'Google', kind: 'native', available: true, reason: null,
      tools: [{ name: 'google_calendar', effect: 'write' }] },
  ],
  native: [
    { name: 'Bash', description: 'Run shell commands.', effect: 'write', available: true },
    { name: 'Read', description: 'Read a file.', effect: 'read', available: true },
    { name: 'search_sessions', description: 'Search past chats.', effect: 'read', available: true },
    { name: 'send_email', description: 'Send an email.', effect: 'write', available: false, reason: 'Its add-on is not installed or not switched on in Tool Store.' },
  ],
  revisions: {}, hashes: {}, failNext: null, bump: {},
});

module.exports = ({ state, data, now }) => {
  const base = core({ state, data, now });
  const lane = () => (state.botsGrants ||= SEED());
  const need = id => {
    const bot = base.store().agents.find(a => a.id === id);
    if (!bot) throw new Refusal(404, 'That bot does not exist.');
    return bot;
  };

  const fingerprint = bot => JSON.stringify([bot.tool_scope, bot.connector_scopes, bot.integration_ids, bot.connector_tools,
    lane().apps.map(a => [a.id, a.available]), lane().bump[bot.id] || 0]);
  const revision = bot => {
    const l = lane(), hash = fingerprint(bot);
    if (l.hashes[bot.id] !== hash) { l.revisions[bot.id] = (l.revisions[bot.id] || 0) + 1; l.hashes[bot.id] = hash; }
    return l.revisions[bot.id];
  };
  const explicit = bot => bot.connector_tools && typeof bot.connector_tools === 'object';
  const scopeOf = (bot, appId) => (bot.connector_scopes || {})[appId] || null;

  // One tool: {state, reason, code}
  function judge(bot, app, tool) {
    const off = (reason, code) => ({ state: 'off', reason, code });
    if (!app.available) return off(`${app.name} cannot be used. ${app.reason}`, 'unavailable');
    const scope = (bot.tool_scope || { deny: [] });
    if ((scope.deny || []).some(s => s === `mcp:${app.id}:${tool.name}` || s === `mcp:${app.id}:*` || (app.kind === 'native' && s === `native:${tool.name}`))) {
      return off(`this bot's tool selection excludes ${tool.name}. Check the bot's Access settings.`, 'denied');
    }
    const level = scopeOf(bot, app.id);
    if (level === 'off') return off(`${app.name} is turned off for this bot.`, 'app_off');
    if (explicit(bot)) {
      if (level !== 'read' && level !== 'write') return off(`${app.id} has no scope for this bot. Choose read or write in Access.`, 'no_scope');
      const grant = bot.connector_tools[app.id];
      if (!grant) return off(`this bot has not been given ${app.id}.`, 'not_selected');
      if (grant.tools !== '*' && !grant.tools.includes(tool.name)) return off(`this bot has not been given ${tool.name}.`, 'not_selected');
    }
    if (level === 'read' && tool.effect !== 'read') {
      return off(`${tool.name} is blocked because ${tool.effect === 'unknown' ? 'it is not known to be read-only' : 'this app is read-only for this bot'}.`, 'read_only');
    }
    return { state: 'on', reason: '', code: 'ok' };
  }

  function effective(bot) {
    const l = lane();
    const denied = new Set(((bot.tool_scope || {}).deny || []).filter(s => s.startsWith('native:')).map(s => s.slice(7)));
    const notes = ['This is the most the bot can do. Its approval level (Full by default) cannot add to it.',
      explicit(bot) ? 'Only the apps and tools you chose below are allowed.' : 'Every app is allowed unless you limit it.'];
    if ((bot.tool_scope?.deny || []).length) notes.push(`${bot.tool_scope.deny.length} tool choice(s) are blocked, and a block always wins.`);
    return {
      bot_id: bot.id, revision: revision(bot), mode: explicit(bot) ? 'explicit' : 'legacy', catalogue_revision: 'fixture',
      grants: { tool_scope: bot.tool_scope || { allow: [], deny: [] }, connector_scopes: bot.connector_scopes || {}, integration_ids: bot.integration_ids ?? null,
        connector_tools: bot.connector_tools ?? null, grants_version: bot.grants_version || 0 },
      native: l.native.map(t => ({ ...t, app: null, available: t.available !== false, unavailable: t.reason || null,
        state: denied.has(t.name) || t.available === false ? 'off' : 'on', reason: denied.has(t.name) ? `this bot's tool selection excludes ${t.name}. Check the bot's Access settings.` : (t.reason || ''),
        code: denied.has(t.name) ? 'denied' : 'ok' })),
      apps: l.apps.map(app => ({
        id: app.id, name: app.name, kind: app.kind, available: app.available, unavailable: app.reason, scope: scopeOf(bot, app.id),
        grant: explicit(bot) ? bot.connector_tools[app.id] || null : null, accounts: app.accounts || [],
        tools: app.tools.map(t => ({ ...t, description: '', effect_source: 'name', available: app.available, reason: app.reason, ...judge(bot, app, t) })),
      })),
      explanation: notes,
    };
  }

  function save(bot, body) {
    const l = lane();
    if (l.failNext === 'refuse') { l.failNext = null; throw new Refusal(422, 'github is not available, so it cannot be switched on.'); }
    if (l.failNext === 'stale') { l.failNext = null; l.bump[bot.id] = (l.bump[bot.id] || 0) + 1; throw new Refusal(409, 'The access settings changed. Reload them before saving.'); }
    if (body.expected_revision !== revision(bot)) throw new Refusal(409, 'The access settings changed. Reload them before saving.');
    const allowed = ['expected_revision', 'tool_scope', 'connector_scopes', 'integration_ids', 'connector_tools', 'clear_integration_ids'];
    const extra = Object.keys(body).filter(k => !allowed.includes(k));
    if (extra.length) throw new Refusal(422, `unexpected field ${extra[0]}`);
    const scopes = body.connector_scopes ?? bot.connector_scopes ?? {};
    for (const [id, grant] of Object.entries(body.connector_tools || {})) {
      const app = l.apps.find(a => a.id === id);
      if (!app || !app.available) throw new Refusal(422, `${id} is not available, so it cannot be switched on.`);
      if (!['read', 'write'].includes(scopes[id])) throw new Refusal(400, `choose read or write for ${app.name} before giving it tools`);
      if (grant.tools !== '*') for (const name of grant.tools) if (!app.tools.some(t => t.name === name)) throw new Refusal(422, `${name} is not available, so it cannot be switched on.`);
    }
    if (body.tool_scope) bot.tool_scope = body.tool_scope;
    if (body.connector_scopes) bot.connector_scopes = body.connector_scopes;
    if (body.connector_tools) { bot.connector_tools = body.connector_tools; bot.grants_version = Math.max(1, bot.grants_version || 0); }
    if (body.integration_ids !== undefined) bot.integration_ids = body.integration_ids;
    bot.revision = (bot.revision || 0) + 1;
    return effective(bot);
  }

  const wrap = fn => (route, ...rest) => {
    if (!state.botsLive) return undefined;
    try { return fn(route, ...rest); }
    catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
  };
  return {
    read: wrap((route) => {
      const m = route.match(/^\/api\/bots\/([^/]+)\/access$/);
      return m ? effective(need(m[1])) : undefined;
    }),
    mutate: wrap((route, method, body = {}) => {
      const m = route.match(/^\/api\/bots\/([^/]+)\/access$/);
      if (!m || method !== 'PUT') return undefined;
      return save(need(m[1]), body || {});
    }),
  };
};
