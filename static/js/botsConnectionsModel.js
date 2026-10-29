// Connections model for Bots mode (Phase 2, unit U5): connected apps, MCP servers, keys, saved logins and the
// setup import. Pure functions, no DOM and no imports, so scripts/test_bots_connections.cjs runs them in plain Node.
// The server is the authority (services/bot_connections.py, bot_mcp_config.py, bot_keys.py, bot_logins.py); this only
// decides what to show and what to send. Nothing here ever holds a saved secret: servers arrive with header and
// variable names only, keys with "saved" and the last four characters, logins with the site and username.

// -- errors ---------------------------------------------------------------------------------------------------
export const statusOf = error => Number(/^(\d{3}):/.exec(String(error?.message || ''))?.[1]) || 0;
export const messageOf = error => String(error?.message || error || 'Something went wrong.').replace(/^\d{3}:\s*/, '');
export const isStale = error => statusOf(error) === 409;

// -- apps -----------------------------------------------------------------------------------------------------
export const STATE_LABEL = {
  connected: 'Connected', pending: 'Finish setup', failed: 'Not working', expired: 'Reconnect', off: 'Off',
  available: 'Not added', unavailable: 'Unavailable', added: 'Added',
};
export const stateTone = state => ({ connected: 'good', added: 'quiet', off: 'quiet', available: 'quiet', pending: 'warn', failed: 'bad', expired: 'bad', unavailable: 'quiet' }[state] || 'quiet');
const IN_USE = new Set(['connected', 'pending', 'failed', 'expired', 'off', 'added']);

export function filterApps(apps = [], { query = '', category = '', view = 'all' } = {}) {
  const needle = String(query).trim().toLowerCase();
  return apps.filter(app => {
    if (view === 'connected' && !IN_USE.has(app.state)) return false;
    if (view === 'mcp' && app.kind !== 'mcp') return false;
    if (category && app.category !== category) return false;
    return !needle || [app.label, app.description, app.category].join(' ').toLowerCase().includes(needle);
  });
}

// Sections for the page: what is connected first, then one section per category for what is left to add.
export function appSections(apps = [], categories = []) {
  const connected = apps.filter(a => IN_USE.has(a.state));
  const rest = apps.filter(a => !IN_USE.has(a.state));
  const sections = connected.length ? [{ id: 'connected', label: `Connected (${connected.length})`, apps: connected }] : [];
  const order = [...categories, ...new Set(rest.map(a => a.category))].filter((c, i, all) => all.indexOf(c) === i);
  for (const category of order) {
    const inCategory = rest.filter(a => a.category === category);
    if (inCategory.length) sections.push({ id: 'cat-' + category, label: category, apps: inCategory });
  }
  return sections;
}

// What the main button of an app does.
export function appAction(app) {
  if (app.state === 'unavailable') return { kind: 'none', label: '' };
  if (app.state === 'expired') return { kind: 'reconnect', label: 'Reconnect' };
  if (app.state === 'pending' && app.auth === 'oauth') return { kind: 'sign-in', label: 'Sign in' };
  if (app.state === 'pending') return { kind: 'test', label: 'Test' };
  if (app.id === 'google') return { kind: 'authorize', label: app.accounts?.length ? 'Add account' : 'Connect' };
  if (app.id === 'email') return { kind: 'setup', label: 'Open Email' };
  if (['highlevel', 'x'].includes(app.id)) return { kind: 'keys', label: app.state === 'connected' ? 'Change key' : 'Add key' };
  if (app.id === 'whop' && app.state !== 'added') return { kind: 'add-whop', label: 'Add' };
  if (app.state === 'available') return { kind: 'authorize', label: app.auth === 'oauth' || app.id.startsWith('catalog:') ? 'Add' : 'Connect' };
  return { kind: 'none', label: '' };
}

export const aliasNeeded = app => (app.accounts || []).length >= 2 && app.accounts.some(a => !a.alias);
export const accountLabel = account => account.alias ? `${account.alias} (${account.label})` : account.label;
export function usedByLabel(app) {
  const names = (app.used_by || []).map(u => u.name);
  if (!names.length) return 'No bots use it yet';
  return names.length <= 3 ? `Used by ${names.join(', ')}` : `Used by ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
export const limitedLabel = app => (app.limited_for || []).length ? `${app.limited_for.length} bot${app.limited_for.length === 1 ? '' : 's'} can use only some of its tools` : '';

// -- probes -----------------------------------------------------------------------------------------------------
export function probeText(result) {
  if (!result) return '';
  if (result.state === 'connected') return `Connected, ${result.tools} tool${result.tools === 1 ? '' : 's'}${result.truncated ? ' (first 100 listed)' : ''}`;
  if (result.state === 'auth_required') return 'Sign-in needed';
  return { keys: 'The server refused the keys', timeout: 'No answer in time', unreachable: 'Could not reach it', off: 'It is switched off', auth: 'Sign-in needed' }[result.reason] || 'It did not connect';
}
export function probeAction(result) {
  if (!result || result.state === 'connected') return '';
  if (result.state === 'auth_required') return 'Sign in';
  return result.reason === 'keys' ? 'Fix keys' : result.reason === 'off' ? '' : 'Try again';
}
export const probeTone = result => !result ? 'quiet' : result.state === 'connected' ? 'good' : result.state === 'auth_required' ? 'warn' : 'bad';

// -- MCP servers -------------------------------------------------------------------------------------------------
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
export const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const DEFAULT_TIMEOUT = 10, DEFAULT_BUDGET = 8000, MAX_BUDGET = 2_000_000;

export function serverBadges(server) {
  const badges = [{ text: server.enabled ? 'On' : 'Off', tone: server.enabled ? 'good' : 'quiet' }];
  if (server.auth === 'oauth') badges.push({ text: server.signed_in ? 'Signed in' : 'Signed out', tone: server.signed_in ? 'good' : 'warn' });
  if (server.mcp_type === 'stdio') badges.push({ text: 'Runs on this computer', tone: 'quiet' });
  if (server.origin === 'proposed') badges.push({ text: 'Proposed by a bot', tone: 'warn' });
  if (String(server.origin || '').startsWith('setup:')) badges.push({ text: 'Imported', tone: 'quiet' });
  if (server.held_tools?.length) badges.push({ text: `${server.held_tools.length} tool${server.held_tools.length === 1 ? '' : 's'} to review`, tone: 'warn' });
  return badges;
}
export function serverHealth(server) {
  const status = server.status;
  if (!server.enabled) return { text: 'Off', tone: 'quiet' };
  if (!status) return { text: 'Not tested yet', tone: 'quiet' };
  if (status.state === 'working') return { text: `Connected, ${status.tools ?? 0} tool${status.tools === 1 ? '' : 's'}`, tone: 'good' };
  if (status.state === 'signed_out') return { text: 'Sign-in needed', tone: 'warn' };
  return { text: 'Not working', tone: 'bad' };
}

export function emptyDraft() {
  return { id: null, name: '', transport: 'http', url: '', command: '', argsText: '', headers: [], env: [],
    oauth: { on: false, client_id: '', client_secret: '', scopes: '', hasSecret: false },
    call_timeout_minutes: DEFAULT_TIMEOUT, result_budget: DEFAULT_BUDGET, enabled: true };
}
// A pasted server (botsMcpPaste.js) becomes an editor draft. Values go into write-only fields.
export function draftFromPaste(server) {
  return { ...emptyDraft(), name: server.name, transport: server.transport, url: server.url || '', command: server.command || '',
    argsText: (server.args || []).join('\n'),
    headers: Object.entries(server.headers || {}).map(([name, value]) => ({ name, value, saved: false })),
    env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value, saved: false })) };
}
// A saved server (names only) becomes an editor draft whose secret rows say "saved" and hold no value.
export function draftFromServer(server) {
  return { ...emptyDraft(), id: server.id, name: server.name, transport: server.mcp_type === 'stdio' ? 'stdio' : (server.http_kind === 'sse' ? 'sse' : 'http'),
    url: server.url || '', command: server.command || '', argsText: (server.args || []).join('\n'),
    headers: (server.header_names || []).map(name => ({ name, value: '', saved: true })),
    env: (server.env_names || []).map(name => ({ name, value: '', saved: true })),
    oauth: server.oauth_client ? { on: true, client_id: server.oauth_client.client_id, client_secret: '', scopes: server.oauth_client.scopes || '', hasSecret: !!server.oauth_client.has_secret }
      : { ...emptyDraft().oauth },
    call_timeout_minutes: server.call_timeout_minutes ?? DEFAULT_TIMEOUT, result_budget: server.result_budget ?? DEFAULT_BUDGET, enabled: server.enabled !== false };
}

function secretMap(rows) {
  const out = {};
  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    out[name] = row.value ? row.value : true; // a blank saved row keeps its saved value
  }
  return out;
}

export function validateDraft(draft, { editing = false } = {}) {
  if (!NAME_RE.test(draft.name || '')) return 'A name starts with a lowercase letter and uses lowercase letters, digits, - or _ (32 characters at most).';
  if (draft.transport === 'stdio') {
    if (!String(draft.command || '').trim()) return 'Enter the command that starts the server.';
    for (const row of draft.env) {
      if (!row.name.trim()) continue;
      if (!ENV_RE.test(row.name.trim())) return `${row.name} is not a valid variable name.`;
      if (!row.value && !row.saved) return `Give ${row.name} a value, or remove it.`;
    }
  } else {
    const url = String(draft.url || '').trim();
    if (!/^https:\/\/[^\s/]+/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url)) return 'A remote address starts with https:// (or http:// for a server on this computer).';
    if (/^https?:\/\/[^/]*@/.test(url)) return 'Leave sign-in details out of the address. Use a header instead.';
    for (const row of draft.headers) {
      if (!row.name.trim()) continue;
      if (!HEADER_RE.test(row.name.trim())) return `${row.name} is not a valid header name.`;
      if (!row.value && !row.saved) return `Give ${row.name} a value, or remove it.`;
    }
    if (draft.oauth?.on && !String(draft.oauth.client_id || '').trim()) return 'Enter the client id for sign-in, or turn the sign-in block off.';
  }
  const timeout = Number(draft.call_timeout_minutes);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) return 'The call timeout is a whole number of minutes from 1 to 60.';
  const budget = Number(draft.result_budget);
  if (!Number.isInteger(budget) || budget < 0 || budget > MAX_BUDGET) return 'The result size is a whole number of characters from 0 to 2,000,000.';
  return '';
}

// The request body. On an edit the name is sent too (it is locked), and a saved secret row with no new value sends the keep marker.
export function draftToBody(draft) {
  const body = { name: draft.name, transport: draft.transport, call_timeout_minutes: Number(draft.call_timeout_minutes), result_budget: Number(draft.result_budget), enabled: !!draft.enabled };
  if (draft.transport === 'stdio') {
    body.command = String(draft.command).trim();
    body.args = String(draft.argsText || '').split('\n').map(a => a.trim()).filter(Boolean);
    body.env = secretMap(draft.env);
  } else {
    body.url = String(draft.url).trim();
    body.headers = secretMap(draft.headers);
    if (draft.oauth?.on) {
      body.oauth = { client_id: draft.oauth.client_id.trim(), scopes: String(draft.oauth.scopes || '').trim() };
      if (draft.oauth.client_secret) body.oauth.client_secret = draft.oauth.client_secret;
    }
  }
  return body;
}

// -- keys ---------------------------------------------------------------------------------------------------------
export function groupKeys(keys = [], groups = []) {
  const known = groups.length ? groups : [...new Set(keys.map(k => k.group))];
  return known.map(group => ({ group, rows: keys.filter(k => k.group === group) })).filter(g => g.rows.length);
}
export function keyState(row) {
  if (row.managed_in === 'models') return row.has_value ? 'Set in Models' : 'Not set';
  if (!row.has_value) return 'Not set';
  if (row.secret === false) return row.value || 'Saved';
  return row.last4 ? `Saved, ends ${row.last4}` : 'Saved';
}
export const testTone = result => result?.ok ? 'good' : 'bad';
export const testText = result => result?.message || '';
export function matchKey(rows = [], id = '') { return rows.find(r => r.id === id) || null; }

// -- saved logins -------------------------------------------------------------------------------------------------
export function validateLogin(form, { editing = false } = {}) {
  if (!String(form.site || '').trim()) return 'Enter the site, for example example.com.';
  if (!String(form.username || '').trim()) return 'Enter the username.';
  if (!editing && !form.password) return 'Enter the password.';
  if (form.totp && !/^[A-Za-z2-7 -]{8,200}$/.test(form.totp.trim()) && !/^otpauth:\/\/totp\//i.test(form.totp.trim())) return 'The one-time-code seed is letters and the digits 2 to 7, or an otpauth:// address.';
  if (form.access === 'some' && !(form.bots || []).length) return 'Choose at least one bot, or choose all bots.';
  return '';
}
// A blank password on an edit keeps the saved one; a blank code seed keeps the saved seed unless it is removed.
export function loginBody(form, { editing = false, removeTotp = false } = {}) {
  const body = { site: form.site.trim(), username: form.username.trim(), exact_host: !!form.exact_host, bots: form.access === 'some' ? [...form.bots] : 'all' };
  if (form.password) body.password = form.password;
  if (removeTotp) body.totp = null;
  else if (form.totp && form.totp.trim()) body.totp = form.totp.trim();
  else if (!editing) delete body.totp;
  return body;
}
export function emptyLogin() { return { id: null, site: '', username: '', password: '', totp: '', exact_host: false, access: 'all', bots: [], has_totp: false }; }
export function loginToForm(login) {
  return { id: login.id, site: login.site, username: login.username, password: '', totp: '', exact_host: !!login.exact_host,
    access: login.bots === 'all' ? 'all' : 'some', bots: login.bots === 'all' ? [] : [...login.bots], has_totp: !!login.has_totp };
}
export function accessLabel(bots, names = {}) {
  if (bots === 'all') return 'All bots';
  if (!bots.length) return 'No bots';
  return bots.length <= 2 ? bots.map(id => names[id] || 'A deleted bot').join(', ') : `${bots.length} bots`;
}
export const SOURCE_LABEL = { settings: 'Added here', card: 'From a card', '1password': '1Password' };
export function loginMeta(login, names = {}) {
  return [login.username, SOURCE_LABEL[login.source] || '', login.has_totp ? '2FA' : '', login.exact_host ? 'Exact site only' : '',
    accessLabel(login.bots, names), login.last_used ? 'Used ' + new Date(login.last_used * 1000).toLocaleDateString() : 'Never used'].filter(Boolean).join(' · ');
}

// -- setup import ---------------------------------------------------------------------------------------------------
export function importSummary(result) {
  const all = [...(result?.mcp || []), ...(result?.skills || [])];
  const done = all.filter(r => r.status === 'imported').length;
  if (!all.length) return 'Nothing was imported.';
  const rest = all.length - done;
  return `Imported ${done} (all switched off for review)${rest ? `, ${rest} not imported` : ''}.`;
}
export const importKey = row => `${row.tool}::${row.name || row.folder}`;
export function selectable(rows = []) { return rows.filter(r => r.status === 'ready'); }

// -- diagnostics ----------------------------------------------------------------------------------------------------
// Copyable text is built only from fields that never hold a secret, and then scrubbed of any value still on screen.
export function redactText(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of [...secrets].filter(s => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(secret).join('[hidden]');
  return out;
}
export function diagnostic(server, probe, secrets = []) {
  const lines = [`Server: ${server.name}`, `Kind: ${server.mcp_type === 'stdio' ? 'local command' : 'remote'}`, `State: ${probeText(probe) || serverHealth(server).text}`];
  if (server.mcp_type === 'stdio') lines.push(`Command: ${server.command}`); else lines.push(`Address: ${server.url}`);
  if (server.header_names?.length) lines.push(`Header names: ${server.header_names.join(', ')}`);
  if (server.env_names?.length) lines.push(`Variable names: ${server.env_names.join(', ')}`);
  if (server.status?.error) lines.push(`Last error: ${server.status.error}`);
  return redactText(lines.join('\n'), secrets);
}
