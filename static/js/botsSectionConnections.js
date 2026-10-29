// Connected apps and MCP servers (Phase 2, unit U5). Phase 1 and Settings mount it as the "Connected apps" page.
// mount(host, ctx) -> {destroy, refresh, flush}; safe to destroy while requests are pending. ctx: agentId (optional),
// state.agent, advanced, flush(), refresh(), go(section).
//
// What it shows: the apps a bot can be given (MCP servers and their sign-ins, Google accounts, mailboxes, HighLevel, X
// research, Whop) with search, categories, account aliases, reconnect and disconnect and which bots use each; the
// MCP servers themselves (on/off, test, edit, remove, sign in and out, a probe strip); the editor that reads a pasted
// link, setup command or config block (botsMcpPaste.js); and the import from this computer's other AI tools.
// Secrets are write-only everywhere: a saved header or variable shows as "saved" and is never read back.
import { api, el, confirmDialog, toast } from './api.js';
import { Card, Segmented, SwitchRow, Button, PageHeader, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { readMcpPaste } from './botsMcpPaste.js';
import {
  STATE_LABEL, accountLabel, aliasNeeded, appAction, appSections, diagnostic, draftFromPaste, draftFromServer, draftToBody, emptyDraft,
  filterApps, importKey, importSummary, limitedLabel, messageOf, probeAction, probeText, probeTone, selectable, serverBadges,
  serverHealth, stateTone, usedByLabel, validateDraft,
} from './botsConnectionsModel.js';

export const CONNECTIONS_CSS = '/static/css/bots-connections.css';

// -- small shared pieces (the Keys and Logins pages use them too) ---------------------------------------------------
export function statusBox(text, kind = '') {
  return el('div', { class: `bots-conn-status ${kind}`.trim(), role: kind === 'error' ? 'alert' : 'status', text });
}
export function chip(text, tone = '') { return el('span', { class: `bots-conn-chip ${tone}`.trim(), text }); }
let fieldId = 0;
export function field(label, input, hint = '') {
  const id = `bots-conn-f${++fieldId}`;
  input.id = id;
  return el('div', { class: 'bots-conn-field' }, [el('label', { for: id, text: label }), input, hint ? el('div', { class: 'bots-row-hint', text: hint }) : null]);
}
export function textInput(value = '', attrs = {}) {
  const node = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs });
  node.value = value;
  return node;
}
// A write-only box: autocomplete off, never filled from a saved value, shown as dots.
export function secretInput(attrs = {}) {
  return el('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', 'data-secret': 'true', ...attrs });
}
export function openLink(url) { window.open(url, '_blank', 'noopener'); }

const initials = label => String(label || '?').trim().slice(0, 1).toUpperCase();

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots.css');
  loadBotsCss(CONNECTIONS_CSS);
  const root = el('div', { class: 'bots-conn', 'data-section': 'connections' });
  host.append(root);

  let destroyed = false, loading = true, loadError = '', generation = 0, busy = '', notice = '', formError = '';
  let inventory = { apps: [], categories: [], bots_without_apps: [] };
  let servers = [], limit = 20;
  const view = { query: '', category: '', mode: 'all' };
  const openApps = new Set(), probes = new Map(), pendingAlias = new Map();
  let editor = null;            // { draft, found, error, pasted, saving }
  let imported = { scan: null, scanning: false, error: '', picks: new Set(), outcome: null };
  let waiting = null, pollTimer = 0;

  const stop = () => { clearTimeout(pollTimer); pollTimer = 0; waiting = null; };

  // -- data -----------------------------------------------------------------------------------------------------------
  async function load(quiet = false) {
    const mine = ++generation;
    loading = !inventory.apps.length && !quiet; loadError = '';
    if (loading) draw();
    try {
      const [apps, mcp] = await Promise.all([api('/api/bots/connections', { toast: false }), api('/api/bots/mcp', { toast: false })]);
      if (destroyed || mine !== generation) return;
      inventory = apps; servers = mcp.servers || []; limit = mcp.limit || 20;
    } catch (error) {
      if (destroyed || mine !== generation) return;
      loadError = messageOf(error);
    }
    loading = false;
    draw();
  }

  async function run(label, call, { done = '' } = {}) {
    if (busy || destroyed) return false;
    busy = label; formError = ''; notice = '';
    draw();
    try {
      await ctx.flush?.();
      await call();
      if (!destroyed && done) notice = done;
      return true;
    } catch (error) {
      if (!destroyed) formError = messageOf(error);
      return false;
    } finally {
      busy = '';
      if (!destroyed) draw();
    }
  }

  // After a sign-in link opens, look for the account for up to five minutes.
  function watchFor(service) {
    stop();
    waiting = { service, until: Date.now() + 5 * 60 * 1000 };
    const tick = async () => {
      if (destroyed || !waiting || Date.now() > waiting.until) { stop(); if (!destroyed) draw(); return; }
      await load(true);
      const found = inventory.apps.find(a => a.id === service || a.integration_id === service);
      if (found && ['connected', 'added'].includes(found.state)) { stop(); notice = `${found.label} is connected.`; draw(); return; }
      pollTimer = setTimeout(tick, 3000);
    };
    pollTimer = setTimeout(tick, 3000);
  }

  // -- app actions ----------------------------------------------------------------------------------------------------
  async function authorize(app, account = null) {
    const alias = pendingAlias.get(app.id) || '';
    return run('authorize', async () => {
      const body = {}; if (alias) body.alias = alias; if (account) body.account = account;
      const result = await api(`/api/bots/connections/${encodeURIComponent(app.id)}/authorize`, { method: 'POST', toast: false, body: JSON.stringify(body) });
      pendingAlias.delete(app.id);
      if (result.url) {
        openLink(result.url);
        notice = `Finish signing in to ${app.label} in the window that opened.`;
        watchFor(result.integration_id || app.id);
      } else if (result.signed_in) notice = `Already signed in to ${app.label}.`;
      else notice = result.note || `${app.label} was added.`;
      await load(true);
    });
  }
  async function addWhop() {
    const spec = { name: 'whop', transport: 'http', url: 'https://mcp.whop.com/mcp', enabled: false };
    return run('whop', async () => {
      await api('/api/bots/mcp', { method: 'POST', toast: false, body: JSON.stringify(spec) });
      await load(true);
    }, { done: 'Whop was added switched off. Review it under MCP servers, then turn it on.' });
  }
  function primary(app) {
    const action = appAction(app);
    if (action.kind === 'authorize' || action.kind === 'reconnect' || action.kind === 'sign-in') {
      if (action.kind === 'sign-in' || (app.kind === 'mcp' && !app.id.startsWith('catalog:'))) return signIn(app);
      return authorize(app);
    }
    if (action.kind === 'test') return testServer(app.id);
    if (action.kind === 'add-whop') return addWhop();
    if (action.kind === 'keys') return ctx.go ? ctx.go('keys') : toast('Open Keys to add it.', 'info');
    if (action.kind === 'setup') return document.querySelector('.nav-item[data-tab="email"]')?.click();
    return undefined;
  }
  async function disconnect(app, account) {
    if (!await confirmDialog({ title: `Disconnect ${accountLabel(account)}?`, message: app.id === 'google' ? 'Bots lose access to this account. You can connect it again later.' : 'You will need to sign in again to use it.', confirmLabel: 'Disconnect' })) return;
    await run('disconnect', async () => {
      await api(`/api/bots/connections/${encodeURIComponent(app.id)}/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE', toast: false });
      await load(true);
    }, { done: 'Disconnected.' });
  }
  const saveAlias = (app, account, value) => run('alias', async () => {
    await api(`/api/bots/connections/${encodeURIComponent(app.id)}/accounts/${encodeURIComponent(account.id)}/alias`, { method: 'PUT', toast: false, body: JSON.stringify({ alias: value }) });
    await load(true);
  }, { done: 'Alias saved.' });

  // -- server actions -------------------------------------------------------------------------------------------------
  async function testServer(id) {
    probes.set(id, { state: 'testing' });
    draw();
    await run('test', async () => {
      const result = await api(`/api/bots/mcp/${encodeURIComponent(id)}/test`, { method: 'POST', toast: false });
      probes.set(id, result);
      await load(true);
    });
    if (probes.get(id)?.state === 'testing') probes.delete(id);
    draw();
  }
  async function signIn(app) {
    const id = app.id;
    return run('sign-in', async () => {
      const result = await api(`/api/bots/mcp/${encodeURIComponent(id)}/sign-in`, { method: 'POST', toast: false });
      if (result.url) { openLink(result.url); notice = `Finish signing in to ${app.label || 'the server'} in the window that opened.`; watchFor(id); }
      else notice = 'Already signed in.';
      await load(true);
    });
  }
  const signOut = server => run('sign-out', async () => { await api(`/api/bots/mcp/${encodeURIComponent(server.id)}/sign-out`, { method: 'POST', toast: false }); await load(true); }, { done: 'Signed out.' });
  const toggle = (server, on) => run('toggle', async () => {
    await api(`/api/bots/mcp/${encodeURIComponent(server.id)}`, { method: 'PATCH', toast: false, body: JSON.stringify({ enabled: on }) });
    await load(true);
  });
  async function removeServer(server) {
    if (!await confirmDialog({ title: `Remove ${server.name}?`, message: 'Bots lose its tools. Its saved keys are deleted.', confirmLabel: 'Remove' })) return;
    await run('remove', async () => {
      await api(`/api/bots/mcp/${encodeURIComponent(server.id)}`, { method: 'DELETE', toast: false });
      probes.delete(server.id);
      if (editor?.draft.id === server.id) editor = null;
      await load(true);
    }, { done: `${server.name} was removed.` });
  }
  async function saveEditor() {
    const draft = editor.draft, editing = !!draft.id;
    const problem = validateDraft(draft, { editing });
    if (problem) { editor.error = problem; draw(); return; }
    editor.error = '';
    const body = draftToBody(draft);
    const ok = await run('save-server', async () => {
      const saved = editing
        ? await api(`/api/bots/mcp/${encodeURIComponent(draft.id)}`, { method: 'PATCH', toast: false, body: JSON.stringify(body) })
        : await api('/api/bots/mcp', { method: 'POST', toast: false, body: JSON.stringify(body) });
      editor = null;
      await load(true);
      // A new server is tested at once, so the person sees whether it works.
      if (saved?.id && saved.enabled) { probes.set(saved.id, { state: 'testing' }); draw(); probes.set(saved.id, await api(`/api/bots/mcp/${encodeURIComponent(saved.id)}/test`, { method: 'POST', toast: false })); await load(true); }
    }, { done: editing ? `${draft.name} was saved.` : `${draft.name} was added.` });
    if (!ok && editor) { editor.error = formError; formError = ''; draw(); }
  }

  // -- setup import -----------------------------------------------------------------------------------------------------
  async function scan() {
    imported = { scan: null, scanning: true, error: '', picks: new Set(), outcome: null };
    draw();
    try { imported.scan = await api('/api/bots/setup-import', { toast: false }); } catch (error) { imported.error = messageOf(error); }
    imported.scanning = false;
    if (!destroyed) draw();
  }
  async function applyImport() {
    const scanned = imported.scan; if (!scanned) return;
    const mcp = selectable(scanned.mcp).filter(r => imported.picks.has(importKey(r))).map(r => ({ tool: r.tool, name: r.name }));
    const skills = selectable(scanned.skills).filter(r => imported.picks.has(importKey({ tool: r.tool, name: r.folder }))).map(r => ({ tool: r.tool, folder: r.folder }));
    if (!mcp.length && !skills.length) { formError = 'Choose something to import first.'; draw(); return; }
    await run('import', async () => {
      imported.outcome = await api('/api/bots/setup-import', { method: 'POST', toast: false, body: JSON.stringify({ mcp, skills }) });
      imported.picks = new Set();
      await load(true);
    });
  }

  // -- drawing: apps ----------------------------------------------------------------------------------------------------
  function appRow(app) {
    const isOpen = openApps.has(app.id);
    const action = appAction(app);
    const row = el('div', { class: 'bots-conn-item', 'data-app': app.id, 'data-state': app.state }, [
      el('div', { class: 'bots-row bots-conn-row' }, [
        el('span', { class: 'bots-conn-mark', 'aria-hidden': 'true', text: initials(app.label) }),
        el('button', { type: 'button', class: 'bots-conn-main', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { isOpen ? openApps.delete(app.id) : openApps.add(app.id); draw(); } }, [
          el('span', { class: 'bots-row-title', text: app.label }),
          el('span', { class: 'bots-row-hint', text: app.reason && ['unavailable', 'failed', 'expired'].includes(app.state) ? app.reason : app.description }),
        ]),
        chip(STATE_LABEL[app.state] || app.state, stateTone(app.state)),
        action.kind !== 'none' ? Button({ label: action.label, variant: app.state === 'available' ? '' : 'primary', disabled: !!busy, onClick: () => primary(app) }) : null,
      ]),
    ]);
    row.querySelector('.bots-conn-row button.bots-btn')?.setAttribute('data-act', 'primary');
    if (isOpen) row.append(appDetail(app));
    return row;
  }

  function appDetail(app) {
    const box = el('div', { class: 'bots-conn-detail' });
    box.append(el('div', { class: 'bots-row-hint', text: usedByLabel(app) }));
    const limited = limitedLabel(app); if (limited) box.append(el('div', { class: 'bots-row-hint', text: limited }));
    if (app.docs) box.append(el('a', { class: 'bots-row-hint', href: app.docs, target: '_blank', rel: 'noopener', text: 'About this app' }));
    if (aliasNeeded(app)) box.append(statusBox('Give each account an alias so a bot can tell them apart.', 'warn'));
    for (const account of app.accounts || []) {
      const alias = textInputFor(account.alias || '', 'Alias');
      const line = el('div', { class: 'bots-conn-account', 'data-account': account.id }, [
        el('span', { class: 'bots-conn-name', text: account.label }),
        chip(account.status === 'connected' ? 'Connected' : account.status === 'needs_reconnect' ? 'Reconnect' : account.status === 'error' ? 'Problem' : 'Waiting', account.status === 'connected' ? 'good' : 'warn'),
        app.multi_account || app.accounts.length > 1 ? alias : null,
        app.multi_account || app.accounts.length > 1 ? Button({ label: 'Save alias', disabled: !!busy, onClick: () => alias.value.trim() ? saveAlias(app, account, alias.value.trim()) : (formError = 'Type an alias first.', draw()) }) : null,
        account.status !== 'connected' && app.id === 'google' ? Button({ label: 'Reconnect', disabled: !!busy, onClick: () => authorize(app, account.id) }) : null,
        app.id !== 'email' && !['highlevel', 'x'].includes(app.id) ? Button({ label: 'Disconnect', variant: 'danger', disabled: !!busy, onClick: () => disconnect(app, account) }) : null,
      ]);
      line.querySelectorAll('.bots-btn')[0]?.setAttribute('data-act', 'alias');
      line.querySelectorAll('.bots-btn').forEach(b => { const t = b.textContent; if (t === 'Reconnect') b.setAttribute('data-act', 'reconnect'); if (t === 'Disconnect') b.setAttribute('data-act', 'disconnect'); });
      box.append(line);
    }
    if (app.multi_account && app.id === 'google' && app.accounts?.length && app.state !== 'unavailable') {
      const next = textInputFor(pendingAlias.get(app.id) || '', 'Alias for the next account');
      next.addEventListener('input', () => pendingAlias.set(app.id, next.value));
      box.append(el('div', { class: 'bots-conn-account' }, [next, Button({ label: 'Add another account', disabled: !!busy, onClick: () => authorize(app) })]));
    }
    return box;
  }
  function textInputFor(value, label) { const input = textInput(value, { 'aria-label': label, placeholder: label, maxlength: '64' }); return input; }

  // -- drawing: servers -------------------------------------------------------------------------------------------------
  function serverRow(server) {
    const health = serverHealth(server), probe = probes.get(server.id);
    const item = el('div', { class: 'bots-conn-item', 'data-server': server.name }, [
      el('div', { class: 'bots-row bots-conn-row' }, [
        el('span', { class: 'bots-conn-mark', 'aria-hidden': 'true', text: initials(server.name) }),
        el('span', { class: 'bots-conn-main static' }, [
          el('span', { class: 'bots-row-title', text: server.name }),
          el('span', { class: 'bots-row-hint', text: (server.mcp_type === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.url) }),
        ]),
        ...serverBadges(server).map(b => chip(b.text, b.tone)),
        chip(health.text, health.tone),
        el('button', { type: 'button', role: 'switch', class: 'bots-switch', 'aria-checked': server.enabled ? 'true' : 'false', 'aria-label': `${server.enabled ? 'Turn off' : 'Turn on'} ${server.name}`, disabled: !!busy, onclick: () => toggle(server, !server.enabled) }),
      ]),
      el('div', { class: 'bots-row bots-conn-row' }, [el('div', { class: 'bots-conn-actions' }, [
        Button({ label: 'Test', iconName: 'refresh-cw', disabled: !!busy, onClick: () => testServer(server.id) }),
        server.auth === 'oauth' ? (server.signed_in ? Button({ label: 'Sign out', disabled: !!busy, onClick: () => signOut(server) }) : Button({ label: 'Sign in', disabled: !!busy, onClick: () => signIn({ id: server.id, label: server.name }) })) : null,
        Button({ label: 'Edit', iconName: 'pencil', disabled: !!busy, onClick: () => { editor = { draft: draftFromServer(server), found: '', error: '', pasted: '' }; draw(); scrollEditor(); } }),
        Button({ label: 'Remove', variant: 'danger', iconName: 'trash-2', disabled: !!busy, onClick: () => removeServer(server) }),
      ])]),
    ]);
    const labels = ['test', server.auth === 'oauth' ? (server.signed_in ? 'sign-out' : 'sign-in') : null, 'edit', 'remove'].filter(Boolean);
    item.querySelectorAll('.bots-conn-actions .bots-btn').forEach((b, i) => b.setAttribute('data-act', labels[i]));
    if (probe) item.append(probeStrip(server, probe));
    return item;
  }

  function probeStrip(server, probe) {
    if (probe.state === 'testing') return el('div', { class: 'bots-conn-probe', 'data-server': server.name, role: 'status', text: 'Testing...' });
    const text = probeText(probe), next = probeAction(probe);
    const strip = el('div', { class: `bots-conn-probe ${probeTone(probe)}`, 'data-server': server.name, role: 'status' }, [el('span', { text })]);
    if (next) strip.append(Button({ label: next, disabled: !!busy, onClick: () => next === 'Sign in' ? signIn({ id: server.id, label: server.name }) : next === 'Fix keys' ? (editor = { draft: draftFromServer(server), found: '', error: '', pasted: '' }, draw(), scrollEditor()) : testServer(server.id) }));
    strip.append(Button({ label: 'Copy details', iconName: 'copy', onClick: async () => { try { await navigator.clipboard.writeText(diagnostic(server, probe)); toast('Copied. It holds no keys.', 'success'); } catch { toast('Could not copy.', 'error'); } } }));
    return strip;
  }

  // -- drawing: the editor ----------------------------------------------------------------------------------------------
  function scrollEditor() { setTimeout(() => root.querySelector('.bots-conn-editor')?.scrollIntoView?.({ block: 'nearest' }), 0); }

  function pairRows(kind, rows, label) {
    const group = el('div', { class: 'bots-conn-group', 'data-kind': kind });
    rows.forEach((row, index) => {
      const name = textInput(row.name, { 'aria-label': `${label} name`, placeholder: kind === 'header' ? 'Header name' : 'Variable name', readonly: !!row.saved });
      name.addEventListener('input', () => { row.name = name.value; });
      const value = secretInput({ 'aria-label': `${row.name || label} value`, placeholder: row.saved ? 'Saved. Type to replace.' : 'Value' });
      value.addEventListener('input', () => { row.value = value.value; });
      group.append(el('div', { class: 'bots-conn-pair', 'data-kind': kind }, [name, value, Button({ label: 'Remove', iconName: 'x', onClick: () => { rows.splice(index, 1); draw(); } })]));
    });
    group.append(Button({ label: kind === 'header' ? 'Add a header' : 'Add a variable', iconName: 'plus', onClick: () => { rows.push({ name: '', value: '', saved: false }); draw(); } }));
    return group;
  }

  function editorCard() {
    const draft = editor.draft, editing = !!draft.id;
    const sync = (key, input, parse = v => v) => { input.addEventListener('input', () => { draft[key] = parse(input.value); }); return input; };
    const parts = [];
    if (!editing) {
      const paste = el('textarea', { 'data-field': 'paste', rows: '3', placeholder: 'Paste a link, a setup command or a config block', 'aria-label': 'Paste a link, setup command or config block', spellcheck: 'false' });
      paste.value = editor.pasted || '';
      paste.addEventListener('input', () => { editor.pasted = paste.value; });
      const read = () => {
        const result = readMcpPaste(editor.pasted);
        if (!result.ok) { editor.error = result.error; editor.found = ''; draw(); return; }
        editor.draft = draftFromPaste(result.servers[0]);
        editor.found = result.servers[0].found + (result.servers.length > 1 ? `. ${result.servers.length - 1} more in that text; add them one at a time.` : '') + (result.ignored ? ' Only the first command was read.' : '');
        editor.error = '';
        editor.pasted = '';
        draw();
      };
      parts.push(field('Paste to fill in the form', paste, 'Read as text only. Nothing is run.'), el('div', { class: 'bots-conn-buttons' }, [Button({ label: 'Read it', iconName: 'search', onClick: read })]));
      parts[parts.length - 1].querySelector('.bots-btn').setAttribute('data-act', 'read');
      if (editor.found) parts.push(el('div', { class: 'bots-conn-found', role: 'status', 'data-found': 'true', text: editor.found }));
    }
    const name = sync('name', textInput(draft.name, { 'data-field': 'name', maxlength: '32', readonly: !!editing }));
    parts.push(field('Name', name, editing ? 'The name cannot change once added.' : 'Lowercase letters, digits, - or _.'));
    const transport = Segmented({ label: 'Where it runs', value: draft.transport === 'stdio' ? 'stdio' : 'remote', options: [{ value: 'remote', label: 'Remote link' }, { value: 'stdio', label: 'Local command' }],
      onChange: v => { draft.transport = v === 'stdio' ? 'stdio' : (draft.transport === 'sse' ? 'sse' : 'http'); draw(); } });
    parts.push(el('div', { class: 'bots-conn-field' }, [el('span', { class: 'bots-conn-label', text: 'Where it runs' }), transport]));
    if (draft.transport === 'stdio') {
      parts.push(field('Command', sync('command', textInput(draft.command, { 'data-field': 'command', class: 'bots-conn-mono' }))));
      const args = el('textarea', { 'data-field': 'args', rows: '3', class: 'bots-conn-mono', spellcheck: 'false' }); args.value = draft.argsText;
      sync('argsText', args);
      parts.push(field('Arguments', args, 'One per line.'));
      parts.push(el('div', { class: 'bots-conn-field' }, [el('span', { class: 'bots-conn-label', text: 'Variables' }), el('div', { class: 'bots-row-hint', text: 'Values are saved encrypted and are never shown again.' }), pairRows('env', draft.env, 'Variable')]));
    } else {
      parts.push(field('Address', sync('url', textInput(draft.url, { 'data-field': 'url', class: 'bots-conn-mono', placeholder: 'https://' }))));
      parts.push(el('div', { class: 'bots-conn-field' }, [el('span', { class: 'bots-conn-label', text: 'Connection type' }), Segmented({ label: 'Connection type', value: draft.transport === 'sse' ? 'sse' : 'http', options: [{ value: 'http', label: 'HTTP' }, { value: 'sse', label: 'Stream (SSE)' }], onChange: v => { draft.transport = v; } })]));
      parts.push(el('div', { class: 'bots-conn-field' }, [el('span', { class: 'bots-conn-label', text: 'Headers' }), el('div', { class: 'bots-row-hint', text: 'Values are saved encrypted and are never shown again.' }), pairRows('header', draft.headers, 'Header')]));
      const oauth = draft.oauth;
      parts.push(SwitchRow({ title: 'Sign in with your own client', hint: 'For servers that need a client id you registered yourself.', checked: oauth.on, onChange: on => { oauth.on = on; draw(); } }));
      if (oauth.on) {
        const idInput = textInput(oauth.client_id, { 'data-field': 'client_id' });
        idInput.addEventListener('input', () => { oauth.client_id = idInput.value; });
        parts.push(field('Client id', idInput));
        const secret = secretInput({ 'data-field': 'client_secret', placeholder: oauth.hasSecret ? 'Saved. Type to replace.' : 'Client secret (optional)' });
        secret.addEventListener('input', () => { oauth.client_secret = secret.value; });
        parts.push(field('Client secret', secret));
        const scopes = textInput(oauth.scopes, { 'data-field': 'scopes' }); scopes.addEventListener('input', () => { oauth.scopes = scopes.value; });
        parts.push(field('Scopes', scopes, 'Optional, separated by spaces.'));
      }
    }
    const timeout = textInput(String(draft.call_timeout_minutes), { inputmode: 'numeric', 'data-field': 'timeout' }); timeout.addEventListener('input', () => { draft.call_timeout_minutes = timeout.value === '' ? '' : Number(timeout.value); });
    const budget = textInput(String(draft.result_budget), { inputmode: 'numeric', 'data-field': 'budget' }); budget.addEventListener('input', () => { draft.result_budget = budget.value === '' ? '' : Number(budget.value); });
    parts.push(el('details', { class: 'bots-conn-details' }, [el('summary', { text: 'Limits' }), el('div', { class: 'bots-conn-editor' }, [
      field('Longest call (minutes)', timeout, 'From 1 to 60. The default is 10.'),
      field('Result size (characters)', budget, 'How much of a result a bot reads at once, from 0 to 2,000,000. The rest is kept for 24 hours and read with a query.')])]));
    if (editor.error) parts.push(statusBox(editor.error, 'error'));
    parts.push(el('div', { class: 'bots-conn-buttons' }, [
      Button({ label: editing ? 'Save changes' : 'Add server', variant: 'primary', disabled: !!busy, onClick: saveEditor }),
      Button({ label: 'Cancel', disabled: !!busy, onClick: () => { editor = null; draw(); } })]));
    const buttons = parts[parts.length - 1].querySelectorAll('.bots-btn'); buttons[0].setAttribute('data-act', 'save-server'); buttons[1].setAttribute('data-act', 'cancel-server');
    return Card({ label: editing ? `Edit ${draft.name}` : 'Add an MCP server', className: 'bots-conn-editor-card', children: [el('div', { class: 'bots-conn-editor' }, parts)] });
  }

  // -- drawing: the import ----------------------------------------------------------------------------------------------
  function importCard() {
    const children = [el('div', { class: 'bots-conn-editor' }, [
      el('div', { class: 'bots-row-hint', text: 'Kairos looks in the usual places for MCP servers and skills that Claude Code, Cursor, Codex and Claude Desktop saved. It only reads. Everything comes in switched off, with no keys.' }),
      el('div', { class: 'bots-conn-buttons' }, [Button({ label: imported.scanning ? 'Looking...' : 'Look on this computer', iconName: 'search', disabled: imported.scanning || !!busy, onClick: scan })]),
    ])];
    children[0].querySelector('.bots-btn').setAttribute('data-act', 'scan');
    if (imported.error) children[0].append(statusBox(imported.error, 'error'));
    const scanned = imported.scan;
    if (scanned) {
      const rows = [...(scanned.mcp || []).map(r => ({ ...r, kindLabel: 'MCP server', key: importKey(r), title: r.name })),
        ...(scanned.skills || []).map(r => ({ ...r, kindLabel: 'Skill', key: importKey({ tool: r.tool, name: r.folder }), title: r.name || r.folder }))];
      const box = el('div', { class: 'bots-conn-checks' });
      for (const row of rows) {
        const ready = row.status === 'ready';
        const input = el('input', { type: 'checkbox', disabled: !ready, 'aria-label': `Import ${row.title}` });
        input.checked = imported.picks.has(row.key);
        input.addEventListener('change', () => { input.checked ? imported.picks.add(row.key) : imported.picks.delete(row.key); });
        const note = ready ? (row.warnings || []).join(' ') : (row.reason || (row.status === 'exists' ? 'Already added.' : row.status));
        box.append(el('label', { class: 'bots-conn-check', 'data-import': row.key }, [input, el('span', {}, [`${row.title} `, chip(`${row.kindLabel} from ${row.tool}`), row.summary ? el('span', { class: 'bots-row-hint', text: row.summary }) : null, note ? el('span', { class: 'bots-row-hint', text: note }) : null])]));
      }
      const empty = !rows.length;
      children[0].append(empty ? el('div', { class: 'bots-row-hint', text: 'Nothing found to import.' }) : box);
      if (scanned.skills_note) children[0].append(el('div', { class: 'bots-row-hint', text: scanned.skills_note }));
      if (scanned.limited) children[0].append(el('div', { class: 'bots-row-hint', text: 'The search stopped early. Run it again for more.' }));
      if (!empty) { children[0].append(el('div', { class: 'bots-conn-buttons' }, [Button({ label: 'Import chosen', variant: 'primary', iconName: 'upload', disabled: !!busy, onClick: applyImport })])); children[0].querySelector('.bots-conn-buttons:last-child .bots-btn')?.setAttribute('data-act', 'apply-import'); }
    }
    if (imported.outcome) children[0].append(statusBox(importSummary(imported.outcome), 'good'));
    return Card({ label: 'Bring in from your other tools', children });
  }

  // -- the page ------------------------------------------------------------------------------------------------------------
  function draw() {
    if (destroyed) return;
    if (loading) { root.replaceChildren(statusBox('Loading your apps...')); return; }
    if (loadError) { root.replaceChildren(statusBox(loadError, 'error'), Button({ label: 'Retry', iconName: 'refresh-cw', onClick: () => load() })); return; }
    const parts = ctx.embedded ? [] : [PageHeader({ title: 'Connected apps', intro: 'The apps and tool servers your bots can use. Each bot is given only the ones you choose in its Access settings.' })];
    if (notice) parts.push(statusBox(notice, 'good'));
    if (formError && !editor) parts.push(statusBox(formError, 'error'));
    if (waiting) parts.push(statusBox('Waiting for you to finish signing in...'));
    if (inventory.bots_without_apps?.length) {
      const note = statusBox(`${inventory.bots_without_apps.length} bot${inventory.bots_without_apps.length === 1 ? ' has' : 's have'} no apps. Allow them in their Access settings.`, 'warn');
      if (ctx.go) note.append(Button({ label: 'Open Access', onClick: () => ctx.go('access') }));
      parts.push(note);
    }
    const search = el('input', { type: 'search', class: 'bots-conn-search', placeholder: 'Search apps', 'aria-label': 'Search apps' });
    search.value = view.query;
    const sectionsHost = el('div', { class: 'bots-conn-sections' });
    const drawSections = () => {
      const shown = filterApps(inventory.apps, { query: view.query, category: view.category, view: view.mode });
      const sections = appSections(shown, inventory.categories);
      sectionsHost.replaceChildren(...(sections.length ? sections.map(s => Card({ label: s.label, children: s.apps.map(appRow) })) : [Card({ children: [el('div', { class: 'bots-conn-empty' }, [icon('plug', { size: 18 }), el('div', {}, [
        el('div', { class: 'bots-row-title', text: inventory.apps.length ? 'No apps match' : 'No apps yet' }), el('div', { class: 'bots-row-hint', text: 'Try another search or category.' })])])] })]));
    };
    search.addEventListener('input', () => { view.query = search.value; drawSections(); });
    const modeBar = Segmented({ label: 'Show', value: view.mode, options: [{ value: 'all', label: 'All' }, { value: 'connected', label: 'Connected' }, { value: 'mcp', label: 'MCP' }], onChange: v => { view.mode = v; drawSections(); } });
    const chips = el('div', { class: 'bots-conn-chips', role: 'group', 'aria-label': 'Filter by category' }, [...new Set(inventory.apps.map(a => a.category))].map(category => el('button', {
      type: 'button', class: 'bots-conn-chip', 'aria-pressed': view.category === category ? 'true' : 'false', text: category,
      onclick: () => { view.category = view.category === category ? '' : category; draw(); } })));
    parts.push(el('div', { class: 'bots-conn-toolbar' }, [search, modeBar, chips]));
    drawSections();
    parts.push(sectionsHost);
    parts.push(Card({ label: `MCP servers (${servers.length} of ${limit})`, children: servers.length ? servers.map(serverRow) : [el('div', { class: 'bots-conn-empty' }, [icon('wrench', { size: 18 }), el('div', {}, [
      el('div', { class: 'bots-row-title', text: 'No MCP servers yet' }), el('div', { class: 'bots-row-hint', text: 'Add one below, or connect an app above.' })])])] }));
    if (editor) parts.push(editorCard());
    else parts.push(el('div', { class: 'bots-conn-buttons' }, [Button({ label: 'Add an MCP server', iconName: 'plus', disabled: !!busy || servers.length >= limit, onClick: () => { editor = { draft: emptyDraft(), found: '', error: '', pasted: '' }; draw(); scrollEditor(); } })]));
    if (!editor) parts[parts.length - 1].querySelector('.bots-btn').setAttribute('data-act', 'add-server');
    parts.push(importCard());
    root.replaceChildren(...parts);
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
  }

  load();
  return {
    destroy() { destroyed = true; generation++; stop(); root.remove(); },
    refresh: () => load(true),
    flush: () => Promise.resolve(true),
  };
}
