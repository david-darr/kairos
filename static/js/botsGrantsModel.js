// Access grants: the pure logic behind a bot's Access section (Phase 2, unit U4). No DOM and no imports, so it loads in
// plain Node (scripts/test_bots_grants.cjs). The server (services/bot_grants.py) decides everything; this only turns
// what it describes into a form, builds the save, and keeps a failed save from leaving the screen lying.
//
// An "app" is a connected tool server (its integration id) or Kairos's own `google` and `email` tools. A person's choice
// per app is off, read or write plus, for the tools, all of them or a picked few. Built-in tools are blocked one by one.

export const SCOPES = Object.freeze(['off', 'read', 'write']);
export const SCOPE_LABEL = Object.freeze({ off: 'Off', read: 'Read only', write: 'Read and change' });

export const messageOf = error => String(error?.message || error).replace(/^\d+:\s*/, '');

// Selectors as the server stores them (native:<name> and mcp:<integration id>:<name>).
export const denySelector = (kind, appId, name) => (kind === 'mcp' ? `mcp:${appId}:${name}` : `native:${name}`);

// The form's state from what the server sent. In the legacy reading every available app starts on, at the scope it has
// (or read and change), with every tool: saving then changes nothing a person had.
export function formFrom(access) {
  const grants = access.grants || {};
  const explicit = access.mode === 'explicit';
  const apps = {};
  for (const app of access.apps || []) {
    const grant = explicit ? (grants.connector_tools || {})[app.id] : null;
    const scope = app.scope || (explicit ? 'off' : 'write');
    const on = explicit ? !!grant && (scope === 'read' || scope === 'write') : scope !== 'off';
    apps[app.id] = {
      on: on && app.available !== false,
      scope: scope === 'off' ? 'write' : scope,
      all: grant ? grant.tools === '*' : true,
      tools: grant && Array.isArray(grant.tools) ? [...grant.tools] : [],
      accounts: grant?.accounts ? [...grant.accounts] : [],
    };
  }
  const denied = new Set(((grants.tool_scope || {}).deny || []).filter(s => s.startsWith('native:')).map(s => s.slice(7)));
  return { apps, denied: [...denied].sort() };
}

// The save for a form: what the server takes (PUT /api/bots/:id/access). Selectors that are not the form's (an mcp deny,
// the allow list, a scope for an app the form does not show) are carried over untouched.
export function buildPayload(access, form) {
  const grants = access.grants || {};
  const known = new Set((access.apps || []).map(a => a.id));
  const scopes = {};
  const tools = {};
  for (const [id, scope] of Object.entries(grants.connector_scopes || {})) if (!known.has(id)) scopes[id] = scope;
  for (const app of access.apps || []) {
    const state = form.apps[app.id];
    if (!state || !state.on) { scopes[app.id] = 'off'; continue; }
    scopes[app.id] = state.scope;
    tools[app.id] = { tools: state.all ? '*' : [...state.tools] };
    if (state.accounts.length) tools[app.id].accounts = [...state.accounts];
  }
  const scope = grants.tool_scope || { allow: [], deny: [] };
  const deny = [...(scope.deny || []).filter(s => !s.startsWith('native:')), ...form.denied.map(n => `native:${n}`)];
  return { tool_scope: { allow: [...(scope.allow || [])], deny: [...new Set(deny)] }, connector_scopes: scopes, connector_tools: tools };
}

// Switch an app on or off, or move its scope or tool pick, without touching the others. Pure: returns a new form.
export function withApp(form, appId, change) {
  const current = form.apps[appId] || { on: false, scope: 'write', all: true, tools: [], accounts: [] };
  const next = { ...current, ...change };
  return { ...form, apps: { ...form.apps, [appId]: next } };
}

export function withTool(form, appId, toolName, on, allNames) {
  const current = form.apps[appId];
  const chosen = new Set(current.all ? allNames : current.tools);
  if (on) chosen.add(toolName); else chosen.delete(toolName);
  const all = allNames.length > 0 && allNames.every(n => chosen.has(n));
  return withApp(form, appId, { all, tools: all ? [] : [...chosen].sort() });
}

export function withNative(form, name, on) {
  const denied = new Set(form.denied);
  if (on) denied.delete(name); else denied.add(name);
  return { ...form, denied: [...denied].sort() };
}

// What a tool's switch can do. An unavailable tool cannot be switched on; a tool the ceiling blocks says why.
export function switchState(tool, available = true) {
  if (available === false || tool.available === false) return { disabled: true, reason: tool.unavailable || tool.reason || 'Not available here.' };
  return { disabled: false, reason: tool.state === 'off' ? tool.reason || '' : '' };
}

export const effectLabel = tool => (tool.effect === 'read' ? 'Only looks' : tool.effect === 'write' ? 'Can change things' : 'Effect unknown');

// The plain-language ceiling, drawn above the form.
export function ceilingLines(access) {
  const lines = [...(access.explanation || [])];
  const blocked = (access.apps || []).filter(a => a.available !== false && a.tools.length && a.tools.every(t => t.state === 'off')).length;
  const unavailable = (access.apps || []).filter(a => a.available === false).length;
  if (blocked) lines.push(`${blocked} connected app${blocked === 1 ? ' is' : 's are'} fully blocked for this bot.`);
  if (unavailable) lines.push(`${unavailable} app${unavailable === 1 ? ' cannot' : 's cannot'} be used right now, so ${unavailable === 1 ? 'it is' : 'they are'} shown but cannot be switched on.`);
  return lines;
}

export function appSummary(app) {
  if (app.available === false) return app.unavailable || 'Not available.';
  const on = app.tools.filter(t => t.state === 'on').length;
  return `${on} of ${app.tools.length} tool${app.tools.length === 1 ? '' : 's'} allowed`;
}

// Saves, one at a time, each judged against the revision the last answer carried. The screen takes the change at once
// and is put back if the server refuses it; a stale revision hands over the server's current state instead.
export function createGrantSaver({ api, path, access, onChange, onStale, onError }) {
  let current = access;
  let chain = Promise.resolve();
  let version = 0;
  const run = async (form, before) => {
    const mine = ++version;
    try {
      const saved = await api(path, { method: 'PUT', body: JSON.stringify({ expected_revision: current.revision, ...buildPayload(current, form) }), toast: false });
      current = saved;
      if (mine === version) onChange?.(saved, formFrom(saved));
      return { ok: true, access: saved };
    } catch (error) {
      // api() throws "409: <message>". A stale revision means someone else saved: take the server's current state.
      if (/^409/.test(String(error?.message))) {
        try {
          const fresh = await api(path, { toast: false });
          current = fresh;
          onStale?.(fresh, formFrom(fresh), messageOf(error));
          return { ok: false, stale: true, access: fresh };
        } catch (second) { onError?.(messageOf(second), before); return { ok: false, error: messageOf(second) }; }
      }
      onError?.(messageOf(error), before);
      return { ok: false, error: messageOf(error) };
    }
  };
  return {
    save(form, before) { chain = chain.then(() => run(form, before)); return chain; },
    get idle() { return chain; },
    get access() { return current; },
    adopt(next) { current = next; },
  };
}
