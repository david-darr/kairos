// The Bots connections API in memory, for the Electron checks (Phase 2, unit U5).
// Answers /api/bots/connections*, /mcp*, /keys*, /logins*, /setup-import, /resource-settings and /highlevel/activity while
// demoState.botsLive is set, and returns undefined for everything else (the g4Backend pattern; see
// scripts/fixtures/bots-core-backend.cjs). State lives under state.botsConnections so a check can seed or change it.
// It mirrors routes/bot_connections_routes.py: names only for secrets (a saved value is held here and never sent back),
// 400 for bad input, 404 for a missing record, 409 for a clash, and the same sentences. It never assumes which bots exist.
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CATEGORIES = ['Productivity', 'Communication', 'Developer', 'Data', 'Finance', 'Design', 'Search', 'Other'];
const CATALOG = [
  { id: 'linear', label: 'Linear', category: 'Productivity', description: 'Issues and projects.', auth: 'oauth' },
  { id: 'notion', label: 'Notion', category: 'Productivity', description: 'Pages and databases.', auth: 'oauth' },
  { id: 'stripe', label: 'Stripe', category: 'Finance', description: 'Payments and customers.', auth: 'oauth' },
  { id: 'alltrails', label: 'AllTrails', category: 'Search', description: 'Hikes and trails.', auth: 'none' },
];
const NATIVE = [
  { id: 'google', label: 'Google Workspace', category: 'Productivity', kind: 'native', multi_account: true, description: 'Gmail, Calendar and Drive on your Google accounts.' },
  { id: 'email', label: 'Email (IMAP and SMTP)', category: 'Communication', kind: 'native', multi_account: true, description: 'Mailboxes set up in the Email tab.' },
  { id: 'highlevel', label: 'HighLevel', category: 'Productivity', kind: 'card', multi_account: false, description: 'Contacts, notes, tasks, appointments and opportunities.' },
  { id: 'x', label: 'X research', category: 'Search', kind: 'card', multi_account: false, description: 'Search recent posts. Read-only.' },
  { id: 'whop', label: 'Whop', category: 'Finance', kind: 'card', multi_account: false, description: 'Your Whop store through its MCP server.' },
];
const KEYS = [
  { id: 'github', group: 'Servers', label: 'GitHub token', hint: 'Starts with ghp_, github_pat_ or similar.', secret: true, testable: true },
  { id: 'exa', group: 'Servers', label: 'Exa key', hint: 'From the Exa dashboard.', secret: true, testable: true },
  { id: 'elevenlabs', group: 'Voice', label: 'ElevenLabs key', hint: 'From your ElevenLabs profile.', secret: true, testable: true },
  { id: 'browserbase', group: 'Computers', label: 'Browserbase key', hint: 'From the Browserbase dashboard.', secret: true, testable: true },
  { id: 'x', group: 'Apps', label: 'X bearer token', hint: 'The app-only bearer token.', secret: true, testable: true },
  { id: 'highlevel-location', group: 'Apps', label: 'HighLevel location id', hint: 'The sub-account location id.', secret: false, testable: false },
];
class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const bad = detail => new Refusal(400, detail);

module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const store = () => state.botsConnections ||= {
    counter: 1, google: { configured: true, accounts: [] }, email: [], servers: [], aliases: {}, pendingAlias: {}, keys: {}, logins: [],
    onepassword: { available: false, reason: 'The 1Password command line (op) is not installed on this computer.', connected: false, vaults: [] },
    settings: { tidy_time: '03:00', capture_quiet_minutes: 5, room_capture: 'off', timezone: null, skill_review: { enabled: true, steps: 10 }, helper_model: null, revision: 0 },
    probes: {}, scan: { mcp: [], skills: [], limited: false, skills_available: false, skills_note: 'Skill import is not available in this build.', skills_limited: false },
    authorized: [], activity: [],
  };
  const next = () => (store().counter++).toString(16).padStart(6, '0');

  const maskedServer = s => ({ id: s.id, kind: 'mcp_server', name: s.name, enabled: s.enabled, mcp_type: s.transport === 'stdio' ? 'stdio' : 'http', http_kind: s.transport === 'sse' ? 'sse' : 'http',
    ...(s.transport === 'stdio' ? { command: s.command, args: s.args } : { url: s.url }), has_api_key: false,
    header_names: Object.keys(s.headers).sort(), env_names: Object.keys(s.env).sort(), call_timeout_minutes: s.call_timeout_minutes, result_budget: s.result_budget,
    origin: s.origin || 'added', oauth_client: s.oauth ? { client_id: s.oauth.client_id, scopes: s.oauth.scopes || '', has_secret: !!s.oauth.secret } : null,
    auth: s.oauth || s.auth === 'oauth' ? 'oauth' : 'none', signed_in: !!s.signedIn, status: s.status || null, pinned: !!s.status, held_tools: s.held_tools || [] });

  function secrets(given, previous, label, nameRe) {
    const out = {};
    for (const [name, value] of Object.entries(given || {})) {
      if (!nameRe.test(name)) throw bad(`${label} name '${name}' is not valid.`);
      if (value === true) { if (!(name in previous)) throw bad(`${label} ${name} has no saved value to keep`); out[name] = previous[name]; }
      else if (typeof value === 'string' && value && !/[\r\n]/.test(value)) out[name] = value;
      else throw bad(`${name} needs a value of up to 4,096 characters on one line, or the keep marker.`);
    }
    return out;
  }
  function serverFields(body, previous) {
    const unknown = Object.keys(body).filter(k => !['name', 'transport', 'url', 'command', 'args', 'headers', 'env', 'oauth', 'call_timeout_minutes', 'result_budget', 'enabled'].includes(k));
    if (unknown.length) throw bad('Unknown fields: ' + unknown.join(', ') + '.');
    const name = body.name ?? previous?.name;
    if (!NAME.test(name || '')) throw bad('A name starts with a lowercase letter and uses lowercase letters, digits, - or _ (32 characters at most).');
    if (previous && name !== previous.name) throw bad("A server's name cannot change once it is added.");
    const transport = body.transport || previous?.transport;
    if (!['http', 'sse', 'stdio'].includes(transport)) throw bad('Choose a remote link (http or sse) or a local command.');
    const out = { name, transport, url: '', command: '', args: [], headers: {}, env: {}, oauth: null };
    if (transport === 'stdio') {
      out.command = String(body.command ?? previous?.command ?? '').trim();
      if (!out.command) throw bad('The command is required.');
      out.args = (body.args ?? previous?.args ?? []).map(String);
      out.env = secrets(body.env ?? Object.fromEntries(Object.keys(previous?.env || {}).map(k => [k, true])), previous?.env || {}, 'variable', ENV);
    } else {
      out.url = String(body.url ?? previous?.url ?? '').trim();
      if (!/^https:\/\/[^\s/]+/i.test(out.url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(out.url)) throw bad('The address must use https (or be on this computer)');
      out.headers = secrets(body.headers ?? Object.fromEntries(Object.keys(previous?.headers || {}).map(k => [k, true])), previous?.headers || {}, 'header', HEADER);
      if (body.oauth) out.oauth = { client_id: body.oauth.client_id, scopes: body.oauth.scopes || '', secret: body.oauth.client_secret ?? previous?.oauth?.secret ?? null };
      else if (previous?.oauth && !('oauth' in body)) out.oauth = previous.oauth;
    }
    const minutes = body.call_timeout_minutes ?? previous?.call_timeout_minutes ?? 10;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw bad('The call timeout is a whole number of minutes from 1 to 60.');
    const budget = body.result_budget ?? previous?.result_budget ?? 8000;
    if (!Number.isInteger(budget) || budget < 0 || budget > 2_000_000) throw bad('the result budget is a whole number from 0 to 2,000,000');
    return { ...out, call_timeout_minutes: minutes, result_budget: budget, enabled: body.enabled ?? previous?.enabled ?? true };
  }

  function inventory(query) {
    const s = store();
    const apps = [];
    for (const server of s.servers) {
      const state_ = !server.enabled ? 'off' : (server.oauth || server.auth === 'oauth') && !server.signedIn ? 'pending' : server.status?.state === 'down' ? 'failed' : server.status?.state === 'working' ? 'connected' : 'pending';
      apps.push({ id: server.id, kind: 'mcp', label: server.name, category: server.category || 'Other', description: 'An MCP tool server.', state: state_, reason: state_ === 'pending' ? 'Sign in to finish setup.' : '',
        enabled: server.enabled, auth: server.oauth || server.auth === 'oauth' ? 'oauth' : 'none', multi_account: false, accounts: [{ id: 'server', label: server.name, status: state_ === 'connected' ? 'connected' : 'pending', error: null, default: true, alias: s.aliases[`${server.id}/server`] || '' }],
        tools: server.status?.tools ?? null, held_tools: 0, used_by: (s.users?.[server.id] || []), limited_for: [], catalog_id: server.catalog_id || null });
    }
    for (const spec of NATIVE) {
      const app = { ...spec, state: 'available', reason: '', accounts: [], used_by: s.users?.[spec.id] || [], limited_for: [], tools: null };
      if (spec.id === 'google') {
        app.accounts = s.google.accounts.map(a => ({ id: a.id, label: a.email, status: a.error ? 'error' : 'connected', error: a.error || null, default: false, alias: s.aliases[`google/${a.id}`] || '' }));
        if (!s.google.configured) { app.state = 'unavailable'; app.reason = 'Add your Google OAuth client ID in Settings > Integrations first.'; }
      } else if (spec.id === 'email') app.accounts = s.email.map(a => ({ id: a.id, label: a.email, status: 'connected', error: null, default: false, alias: s.aliases[`email/${a.id}`] || '' }));
      else if (spec.id === 'highlevel' || spec.id === 'x') { if (s.keys[spec.id]) { app.state = 'connected'; app.accounts = [{ id: 'key', label: spec.label, status: 'connected', error: null, default: true, alias: '' }]; } }
      else if (spec.id === 'whop' && s.servers.some(v => v.name === 'whop')) { app.state = 'added'; app.integration_id = s.servers.find(v => v.name === 'whop').id; }
      if (app.accounts.length) app.state = app.accounts.every(a => a.status !== 'connected') ? 'expired' : 'connected';
      apps.push(app);
    }
    const urls = new Set(s.servers.map(v => v.catalog_id));
    for (const item of CATALOG) if (!urls.has(item.id)) apps.push({ id: 'catalog:' + item.id, kind: 'mcp', label: item.label, category: item.category, description: item.description, state: 'available', reason: '', auth: item.auth, multi_account: false, accounts: [], used_by: [], limited_for: [], tools: null, catalog_id: item.id });
    const needle = String(query.q || '').toLowerCase();
    const shown = apps.filter(a => (!needle || [a.label, a.description, a.category].join(' ').toLowerCase().includes(needle)) && (!query.category || a.category === query.category)
      && (query.mcp_only !== 'true' || a.kind === 'mcp') && (query.connected_only !== 'true' || ['connected', 'expired', 'failed', 'pending', 'off', 'added'].includes(a.state)));
    return { apps: shown, categories: CATEGORIES, counts: { connected: shown.filter(a => a.state === 'connected').length, total: shown.length }, bots_without_apps: s.botsWithoutApps || [] };
  }

  const maskedKey = (def, value) => ({ id: def.id, group: def.group, label: def.label, hint: def.hint, secret: def.secret, has_value: !!value, updated_at: value ? clock() : null,
    last4: value && def.secret && value.length >= 12 ? value.slice(-4) : null, testable: def.testable, ...(value && !def.secret ? { value } : {}) });
  const maskedLogin = l => ({ id: l.id, site: l.site, username: l.username, hosts: [l.site], has_totp: !!l.totp, exact_host: l.exact_host, bots: l.bots, source: 'settings', last_used: l.last_used || null, created_at: l.created_at, updated_at: l.created_at });
  const loginSite = text => {
    const host = String(text || '').trim().replace(/^https?:\/\//i, '').split(/[/:?#]/)[0].toLowerCase();
    if (!host || /\s/.test(host) || host.startsWith('*')) throw bad('Enter the site, for example example.com.');
    return host;
  };

  function handle(route, method, body, query) {
    const s = store();
    let m;
    if (route === '/api/bots/connections' && method === 'GET') return inventory(query);
    if ((m = route.match(/^\/api\/bots\/connections\/([^/]+)\/authorize$/)) && method === 'POST') {
      const service = decodeURIComponent(m[1]);
      for (const key of Object.keys(body)) if (!['alias', 'account'].includes(key)) throw new Refusal(422, 'Extra inputs are not permitted');
      if (service === 'google') {
        if (!s.google.configured) throw new Refusal(409, 'Add your Google OAuth client ID in Settings > Integrations first.');
        if (s.google.accounts.length && !body.alias && !body.account) throw bad('Give the new Google account an alias so a bot can tell the accounts apart.');
        if (body.alias) s.pendingAlias.google = body.alias;
        s.authorized.push({ service, alias: body.alias || null, account: body.account || null });
        return { url: 'https://accounts.google.test/o/oauth2/v2/auth?state=fixture', expires_in: 300 };
      }
      if (service.startsWith('catalog:')) {
        const item = CATALOG.find(c => c.id === service.slice(8));
        if (!item) throw new Refusal(404, 'That app is not in the catalogue.');
        const server = { id: next(), name: item.id, transport: 'http', url: `https://mcp.${item.id}.test/mcp`, command: '', args: [], headers: {}, env: {}, oauth: null, auth: item.auth, enabled: true, call_timeout_minutes: 10, result_budget: 8000, catalog_id: item.id, category: item.category };
        s.servers.push(server);
        s.authorized.push({ service, alias: body.alias || null });
        return item.auth === 'oauth' ? { url: `https://auth.${item.id}.test/authorize?state=fixture`, expires_in: 300, integration_id: server.id } : { added: server.id, note: 'This app needs no sign-in. Test it to check the connection.' };
      }
      const server = s.servers.find(v => v.id === service);
      if (!server) throw new Refusal(404, 'That app cannot be signed in to from here. Use its setup card.');
      s.authorized.push({ service, alias: null });
      return { url: `https://auth.${server.name}.test/authorize?state=fixture`, expires_in: 300, integration_id: server.id };
    }
    if ((m = route.match(/^\/api\/bots\/connections\/([^/]+)\/accounts\/([^/]+)\/alias$/)) && method === 'PUT') {
      const [service, account] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const alias = String(body.alias || '').split(/\s+/).filter(Boolean).join(' ');
      if (!alias || alias.length > 64) throw bad('An alias is 1 to 64 characters.');
      const pool = service === 'google' ? s.google.accounts : service === 'email' ? s.email : [];
      if (!pool.some(a => a.id === account)) throw new Refusal(404, 'That account was not found.');
      if (Object.entries(s.aliases).some(([k, v]) => k.startsWith(service + '/') && k !== `${service}/${account}` && v.toLowerCase() === alias.toLowerCase())) throw new Refusal(409, 'Another account of this app already has that alias.');
      s.aliases[`${service}/${account}`] = alias;
      return { app: service, account, alias };
    }
    if ((m = route.match(/^\/api\/bots\/connections\/([^/]+)\/accounts\/([^/]+)$/)) && method === 'DELETE') {
      const [service, account] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      if (service === 'email') throw new Refusal(409, 'Remove a mailbox in the Email tab.');
      const at = s.google.accounts.findIndex(a => a.id === account);
      if (service !== 'google' || at < 0) throw new Refusal(404, 'Unknown Google account');
      s.google.accounts.splice(at, 1);
      delete s.aliases[`google/${account}`];
      return { ok: true };
    }

    // MCP servers
    if (route === '/api/bots/mcp' && method === 'GET') return { servers: s.servers.map(maskedServer), limit: 20, defaults: { call_timeout_minutes: 10, result_budget: 8000 } };
    if (route === '/api/bots/mcp' && method === 'POST') {
      for (const key of Object.keys(body)) if (!['name', 'transport', 'url', 'command', 'args', 'headers', 'env', 'oauth', 'call_timeout_minutes', 'result_budget', 'enabled'].includes(key)) throw new Refusal(422, 'Extra inputs are not permitted');
      const fields = serverFields(body, null);
      if (s.servers.length >= 20) throw new Refusal(409, 'Kairos keeps up to 20 MCP servers. Remove one first.');
      if (s.servers.some(v => v.name === fields.name)) throw new Refusal(409, 'another MCP server already uses that name');
      const server = { id: next(), ...fields };
      s.servers.push(server);
      return maskedServer(server);
    }
    if ((m = route.match(/^\/api\/bots\/mcp\/([^/]+)(?:\/(test|sign-in|sign-out))?$/))) {
      const server = s.servers.find(v => v.id === decodeURIComponent(m[1]));
      if (!server) throw new Refusal(404, m[2] ? 'MCP server not found' : 'That MCP server was not found.');
      const action = m[2];
      if (!action && method === 'DELETE') { s.servers.splice(s.servers.indexOf(server), 1); return { ok: true }; }
      if (!action && method === 'PATCH') {
        if (Object.keys(body).length === 1 && typeof body.enabled === 'boolean') { server.enabled = body.enabled; return maskedServer(server); }
        Object.assign(server, serverFields(body, server));
        return maskedServer(server);
      }
      if (action === 'test' && method === 'POST') {
        const planned = s.probes[server.name] || { state: 'connected', tools: 3, tool_names: ['list_items', 'get_item', 'delete_item'] };
        if (!server.enabled) return { state: 'failed', reason: 'off', tools: 0, tool_names: [], server: maskedServer(server) };
        if ((server.oauth || server.auth === 'oauth') && !server.signedIn) return { state: 'auth_required', reason: 'auth', tools: 0, tool_names: [], server: maskedServer(server) };
        server.status = planned.state === 'connected' ? { state: 'working', tools: planned.tools, checked_at: clock(), error: null } : { state: 'down', tools: null, checked_at: clock(), error: `The test failed (${planned.reason}).` };
        return { ...planned, reason: planned.reason || null, server: maskedServer(server) };
      }
      if (action === 'sign-in' && method === 'POST') { s.authorized.push({ service: server.id }); return { url: `https://auth.${server.name}.test/authorize?state=fixture`, expires_in: 300 }; }
      if (action === 'sign-out' && method === 'POST') { server.signedIn = false; return { ok: true }; }
    }

    // keys
    if (route === '/api/bots/keys' && method === 'GET') {
      const rows = KEYS.map(def => maskedKey(def, s.keys[def.id]));
      for (const model of s.models || []) rows.push({ id: `model:${model.id}`, group: 'AI', label: model.name, hint: 'Model keys are set in Settings > Models. They are listed here with their test.', secret: true, has_value: true, last4: null, testable: true, managed_in: 'models' });
      return { groups: ['AI', 'Servers', 'Voice', 'Computers', 'Apps', 'Helpers'], keys: rows };
    }
    if ((m = route.match(/^\/api\/bots\/keys\/([^/]+)(?:\/(test))?$/))) {
      const id = decodeURIComponent(m[1]);
      if (id.startsWith('model:')) {
        if (m[2] === 'test') { s.keyTests = (s.keyTests || 0) + 1; return { ok: true, status: 'ok', message: 'The key works.' }; }
        throw new Refusal(404, 'That key slot does not exist.');
      }
      const def = KEYS.find(k => k.id === id);
      if (!def) throw new Refusal(404, 'That key slot does not exist.');
      if (m[2] === 'test' && method === 'POST') {
        const key = body.value || s.keys[id];
        if (!key) return { ok: false, status: 'missing', message: 'Save a key first.' };
        const verdict = (s.keyVerdicts || {})[id] || 'ok';
        const words = { ok: 'The key works.', refused: 'The provider refused this key. Check it and its plan.', unreachable: 'The provider could not be reached.', timeout: 'The provider did not answer in time.' };
        return { ok: verdict === 'ok', status: verdict, message: words[verdict] };
      }
      if (method === 'GET') return maskedKey(def, s.keys[id]);
      if (method === 'PUT') {
        if (Object.keys(body).some(k => k !== 'value')) throw new Refusal(422, 'Extra inputs are not permitted');
        const value = typeof body.value === 'string' ? body.value.trim() : '';
        if (!value || value.length > 4096 || /[\r\n]/.test(value)) throw bad('That value is not usable. Paste it again without line breaks.');
        s.keys[id] = value;
        const warning = id === 'github' && !/^(gh[pousr]_|github_pat_)/.test(value) ? 'This does not look like a github token. It was saved anyway; run the test to check it.' : null;
        return { ...maskedKey(def, value), ...(warning ? { warning } : {}) };
      }
      if (method === 'DELETE') { delete s.keys[id]; return maskedKey(def, null); }
    }

    // logins
    if (route === '/api/bots/logins' && method === 'GET') return { logins: s.logins.map(maskedLogin), onepassword: { available: s.onepassword.available, reason: s.onepassword.reason, connected: s.onepassword.connected, vaults: s.onepassword.vaults } };
    if (route === '/api/bots/logins' && method === 'POST') {
      for (const key of Object.keys(body)) if (!['site', 'username', 'password', 'totp', 'exact_host', 'bots'].includes(key)) throw new Refusal(422, 'Extra inputs are not permitted');
      const site = loginSite(body.site);
      if (!body.username?.trim()) throw bad('Enter the username, up to 256 characters.');
      if (!body.password || body.password.length > 1024) throw bad('Enter the password, up to 1,024 characters.');
      if (s.logins.some(l => l.site === site && l.username.toLowerCase() === body.username.trim().toLowerCase())) throw new Refusal(409, 'A login for this site and username already exists. Change it instead.');
      const login = { id: next(), site, username: body.username.trim(), password: body.password, totp: body.totp || null, exact_host: !!body.exact_host, bots: body.bots ?? 'all', created_at: clock() };
      s.logins.push(login);
      return maskedLogin(login);
    }
    if (route === '/api/bots/logins/onepassword') {
      if (method === 'GET') return { available: s.onepassword.available, reason: s.onepassword.reason, connected: s.onepassword.connected, vaults: s.onepassword.vaults };
      if (method === 'POST') {
        if (!s.onepassword.available) throw new Refusal(503, s.onepassword.reason);
        if (body.token !== 'ops_fixture_token') throw new Refusal(502, '1Password refused the request. Check the service-account token and its vault access.');
        s.onepassword.connected = true; s.onepassword.vaults = s.onepassword.vaults.length ? s.onepassword.vaults : [{ id: 'v1', name: 'Work', bots: [] }];
        return { available: true, reason: '', connected: true, vaults: s.onepassword.vaults };
      }
      if (method === 'DELETE') { s.onepassword.connected = false; s.onepassword.vaults = []; return { available: s.onepassword.available, reason: s.onepassword.reason, connected: false, vaults: [] }; }
    }
    if (route === '/api/bots/logins/onepassword/refresh' && method === 'POST') return { available: true, reason: '', connected: s.onepassword.connected, vaults: s.onepassword.vaults };
    if ((m = route.match(/^\/api\/bots\/logins\/onepassword\/vaults\/([^/]+)$/)) && method === 'PUT') {
      const vault = s.onepassword.vaults.find(v => v.id === decodeURIComponent(m[1]));
      if (!vault) throw new Refusal(404, 'That vault was not found.');
      vault.bots = body.bots;
      return { available: true, reason: '', connected: true, vaults: s.onepassword.vaults };
    }
    if ((m = route.match(/^\/api\/bots\/logins\/([^/]+)$/))) {
      const login = s.logins.find(l => l.id === decodeURIComponent(m[1]));
      if (!login) throw new Refusal(404, 'That login was not found.');
      if (method === 'DELETE') { s.logins.splice(s.logins.indexOf(login), 1); return { ok: true }; }
      if (method === 'PATCH') {
        if (body.site) login.site = loginSite(body.site);
        if (body.username) login.username = body.username.trim();
        if (body.password) login.password = body.password;
        if ('totp' in body) login.totp = body.totp || null;
        if ('exact_host' in body) login.exact_host = !!body.exact_host;
        if ('bots' in body) login.bots = body.bots;
        return maskedLogin(login);
      }
    }

    // setup import
    if (route === '/api/bots/setup-import') {
      if (method === 'GET') return structuredClone(s.scan);
      if (method === 'POST') {
        const results = { mcp: [], skills: [] };
        for (const pick of body.mcp || []) {
          const row = s.scan.mcp.find(r => r.tool === pick.tool && r.name === pick.name);
          if (!row || row.status !== 'ready') { results.mcp.push({ tool: pick.tool, name: pick.name, status: row ? row.status : 'missing', reason: row?.reason || 'It is no longer in that file.' }); continue; }
          const server = { id: next(), name: row.name, transport: 'http', url: `https://mcp.${row.name}.test/mcp`, command: '', args: [], headers: {}, env: {}, oauth: null, enabled: false, call_timeout_minutes: 10, result_budget: 8000, origin: `setup:${pick.tool}` };
          s.servers.push(server); row.status = 'exists';
          results.mcp.push({ tool: pick.tool, name: pick.name, status: 'imported', id: server.id, gaps: row.gaps || [] });
        }
        for (const pick of body.skills || []) results.skills.push({ name: pick.folder, status: 'imported' });
        s.importApplied = (s.importApplied || 0) + 1;
        return results;
      }
    }

    // resource settings
    if (route === '/api/bots/resource-settings') {
      if (method === 'GET') return structuredClone(s.settings);
      if (method === 'PATCH') {
        const patch = { ...body };
        const expected = patch.expected_revision; delete patch.expected_revision;
        if (expected !== undefined && expected !== s.settings.revision) throw new Refusal(409, 'These settings changed since you opened them. Reload and try again.');
        if ('tidy_time' in patch && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.tidy_time || '')) throw bad('The tidy time is a time of day such as 03:00.');
        if ('capture_quiet_minutes' in patch && !(Number.isInteger(patch.capture_quiet_minutes) && patch.capture_quiet_minutes >= 1 && patch.capture_quiet_minutes <= 60)) throw bad('The quiet time is a whole number of minutes from 1 to 60.');
        if ('room_capture' in patch && !['off', 'ask', 'on'].includes(patch.room_capture)) throw bad('Room capture is off, ask or on.');
        Object.assign(s.settings, patch, { revision: s.settings.revision + 1 });
        return structuredClone(s.settings);
      }
    }
    if (route === '/api/bots/highlevel/activity' && method === 'GET') return { rows: s.activity };
    return undefined;
  }

  const answer = (route, method, body, query) => {
    if (!state.botsLive || !route.startsWith('/api/bots/')) return undefined;
    try { return handle(route, method, body || {}, query || {}); }
    catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
  };
  return {
    read: (route, query = {}) => answer(route, 'GET', {}, query),
    mutate: (route, method, body = {}, query = {}) => answer(route, method, body, query),
  };
};
