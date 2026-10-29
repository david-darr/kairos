// Reading a pasted MCP server (Phase 2, unit U5): a link, a setup command or a config block, as data.
// Pure functions, no DOM and no imports, so scripts/test_bots_mcp_paste.cjs runs them in plain Node.
//
// readMcpPaste(text) -> { ok: true, kind, servers: [draft], ignored } | { ok: false, error }
//   draft = { name, transport: 'http' | 'sse' | 'stdio', url, command, args, headers, env, found }
// It reads text and nothing else: a command is split into words and kept as words. It is never run, never
// passed to a shell and never expanded ($VAR, $(...) and backticks stay as typed). Header and variable values
// stay in the draft so the editor can put them in its write-only fields; the editor shows only their names.
//
// Forms understood: a web address; `claude mcp add` and `claude mcp add-json`; npx, uvx, bunx, pnpm dlx, yarn dlx,
// npm exec, docker run and other launchers; and JSON (`mcpServers`, `servers`, a bare name-to-server map, or one
// server). `enabled` in a pasted config is dropped: a server is added by pressing Add.

const MAX_TEXT = 20_000;
const LAUNCHERS = new Set(['npx', 'uvx', 'bunx', 'pnpm', 'yarn', 'npm', 'pipx', 'docker', 'node', 'python', 'python3', 'deno', 'bun', 'uv']);
const DOCKER_VALUE_FLAGS = new Set(['-e', '--env', '-v', '--volume', '--name', '-p', '--publish', '-w', '--workdir', '--network', '-u', '--user', '--entrypoint', '--platform', '--env-file', '--label', '-l', '--mount']);

// -- words -------------------------------------------------------------------------------------------------
// Shell-like splitting: single and double quotes, backslash escapes outside single quotes. Nothing is expanded.
export function shellSplit(line) {
  const tokens = [];
  let current = '', started = false, quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") { if (c === "'") quote = ''; else current += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) current += line[++i];
      else current += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; }
    // A backslash only escapes a space or a quote; any other stays, so a Windows path such as C:\Users\me survives.
    else if (c === '\\' && i + 1 < line.length && (line[i + 1] === ' ' || line[i + 1] === '"' || line[i + 1] === "'")) { current += line[++i]; started = true; }
    else if (/\s/.test(c)) { if (started || current) { tokens.push(current); current = ''; started = false; } }
    else { current += c; started = true; }
  }
  if (quote) return { tokens, error: 'A quote was never closed.' };
  if (started || current) tokens.push(current);
  return { tokens, error: '' };
}

// Lines continued with \ ^ or a backtick at the end become one line.
function joinContinued(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\\^`][ \t]*\n[ \t]*/g, ' ');
}

// -- names -------------------------------------------------------------------------------------------------
export function serverName(source) {
  let raw = String(source || '').trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(raw)) {
      const host = new URL(raw).hostname.replace(/^(www|mcp|api|app)\./, '');
      raw = host.split('.').filter(Boolean)[0] || 'server';
    }
  } catch { /* fall through with the text itself */ }
  raw = raw.replace(/^@[^/]+\//, '').replace(/@[^@/]*$/, '').split('/').pop();
  raw = raw.replace(/^(mcp-server-|server-|mcp-)/, '').replace(/(-mcp-server|-mcp|-server)$/, '');
  raw = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32);
  if (!raw) return 'server';
  return /^[a-z]/.test(raw) ? raw : ('mcp-' + raw).slice(0, 32);
}

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function found(draft) {
  const where = draft.transport === 'stdio' ? `${draft.command} ${packageOf(draft.command, draft.args)}`.trim() : hostOf(draft.url);
  return `Found ${draft.name} ${draft.transport === 'stdio' ? 'running' : 'at'} ${where}`.trim();
}

function strings(object) {
  const out = {};
  if (object && typeof object === 'object' && !Array.isArray(object)) {
    for (const [key, value] of Object.entries(object)) if (['string', 'number', 'boolean'].includes(typeof value)) out[String(key)] = String(value);
  }
  return out;
}

function make(fields) {
  const draft = { name: '', transport: 'http', url: '', command: '', args: [], headers: {}, env: {}, ...fields };
  if (!draft.name) draft.name = serverName(draft.transport === 'stdio' ? packageOf(draft.command, draft.args) || draft.command : draft.url);
  draft.found = found(draft);
  return draft;
}

// -- JSON --------------------------------------------------------------------------------------------------
function fromEntry(name, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const kind = String(entry.type || entry.transport || '').toLowerCase();
  const address = entry.url || entry.serverUrl || entry.httpUrl;
  if (typeof address === 'string' && address) {
    return make({ name: name || '', transport: kind === 'sse' ? 'sse' : 'http', url: address, headers: strings(entry.headers || entry.http_headers) });
  }
  let command = entry.command, args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (Array.isArray(command)) { args = [...command.slice(1).map(String), ...args]; command = command[0]; }
  if (typeof command === 'string' && command) return make({ name: name || '', transport: 'stdio', command, args, env: strings(entry.env) });
  return null;
}

function fromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'That looks like JSON, but it is not valid JSON. Check the commas and quotes.' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Paste one server or an mcpServers block.' };
  const map = ['mcpServers', 'servers', 'mcp_servers'].map(k => data[k]).find(v => v && typeof v === 'object' && !Array.isArray(v));
  let servers = [];
  if (map) servers = Object.entries(map).map(([name, entry]) => fromEntry(serverName(name), entry));
  else if (data.command || data.url || data.serverUrl) servers = [fromEntry('', data)];
  else servers = Object.entries(data).map(([name, entry]) => fromEntry(serverName(name), entry));
  servers = servers.filter(Boolean);
  if (!servers.length) return { ok: false, error: 'No server with a link or a command was found in that.' };
  return { ok: true, kind: 'json', servers: servers.slice(0, 20), ignored: Math.max(0, servers.length - 20) };
}

// -- commands ----------------------------------------------------------------------------------------------
function packageOf(command, args = []) {
  const base = String(command || '').split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, '');
  if (base === 'docker') {
    const at = args.indexOf('run');
    for (let i = at + 1; i < args.length; i++) {
      if (args[i].startsWith('-')) { if (DOCKER_VALUE_FLAGS.has(args[i])) i++; continue; }
      return args[i].split(':')[0];
    }
    return '';
  }
  const skip = new Set(['dlx', 'exec', 'run', 'x', 'tool']);
  return args.find(a => !a.startsWith('-') && !skip.has(a)) || '';
}

function fromLauncher(tokens) {
  const command = tokens[0];
  let args = tokens.slice(1);
  const env = {};
  if (command.split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, '') === 'docker') {
    // docker run -e KEY=value: the value is a secret, so the argument becomes -e KEY and the value becomes a variable.
    const next = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === '-e' || a === '--env') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i + 1] || '')) {
        const [key, ...rest] = args[++i].split('=');
        env[key] = rest.join('=');
        next.push(a, key);
      } else if (/^--env=[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        const [key, ...rest] = a.slice(6).split('=');
        env[key] = rest.join('=');
        next.push('--env', key);
      } else next.push(a);
    }
    args = next;
  }
  return make({ transport: 'stdio', command, args, env });
}

function isUrl(text) { return /^https?:\/\/\S+$/i.test(text); }

function fromClaudeAdd(tokens) {
  // claude mcp add [options] <name> <url|command> [args...]   options: --transport/-t, --scope/-s, --env/-e K=V..., --header/-H "K: V"
  let transport = '', i = 0;
  const env = {}, headers = {}, positional = [];
  let command = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') { command = tokens.slice(i + 1); break; }
    if ((t === '--transport' || t === '-t') && tokens[i + 1]) { transport = tokens[i + 1].toLowerCase(); i += 2; continue; }
    if (t.startsWith('--transport=')) { transport = t.slice(12).toLowerCase(); i++; continue; }
    if ((t === '--scope' || t === '-s' || t === '--callback-port' || t === '--client-id') && tokens[i + 1]) { i += 2; continue; }
    if (t === '--client-secret') { i++; continue; }
    if (t === '--env' || t === '-e') {
      i++;
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) { const [k, ...v] = tokens[i].split('='); env[k] = v.join('='); i++; }
      continue;
    }
    if (t === '--header' || t === '-H') {
      i++;
      while (i < tokens.length && /^[A-Za-z0-9-]+:\s?/.test(tokens[i])) { const at = tokens[i].indexOf(':'); headers[tokens[i].slice(0, at).trim()] = tokens[i].slice(at + 1).trim(); i++; }
      continue;
    }
    if (t.startsWith('-') && positional.length === 0) { i++; continue; }
    positional.push(t);
    if (positional.length === 2 && !command && !isUrl(t)) { command = [t, ...tokens.slice(i + 1)]; break; }
    i++;
  }
  const name = positional[0] && !isUrl(positional[0]) ? serverName(positional[0]) : '';
  if (command && command.length) {
    const [cmd, ...args] = command;
    return make({ name, transport: 'stdio', command: cmd, args, env });
  }
  const url = positional.find(p => isUrl(p));
  if (url) return make({ name, transport: transport === 'sse' ? 'sse' : 'http', url, headers });
  return null;
}

function fromCommandLine(line) {
  let { tokens, error } = shellSplit(line);
  if (error) return { ok: false, error };
  while (tokens[0] && /^[$>#]$/.test(tokens[0])) tokens = tokens.slice(1);
  if (!tokens.length) return { ok: false, error: 'Paste a link, a setup command or a config block.' };
  const head = tokens[0].split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (head === 'claude') {
    if (tokens[1] !== 'mcp' || !['add', 'add-json'].includes(tokens[2])) return { ok: false, error: 'Only `claude mcp add` and `claude mcp add-json` can be read.' };
    if (tokens[2] === 'add-json') {
      const name = tokens[3], json = tokens.slice(4).join(' ');
      let entry;
      try { entry = JSON.parse(json); } catch { return { ok: false, error: 'The JSON in that command is not valid.' }; }
      const draft = fromEntry(serverName(name || ''), entry);
      return draft ? { ok: true, kind: 'claude-add-json', servers: [draft] } : { ok: false, error: 'No link or command was found in that JSON.' };
    }
    const draft = fromClaudeAdd(tokens.slice(3));
    return draft ? { ok: true, kind: 'claude-add', servers: [draft] } : { ok: false, error: 'No link or command was found after `claude mcp add`.' };
  }
  if (LAUNCHERS.has(head)) return { ok: true, kind: 'launcher', servers: [fromLauncher(tokens)] };
  return { ok: false, error: `Kairos does not recognise “${tokens[0].slice(0, 40)}” as an MCP setup command. Use a link, npx, uvx, docker run, claude mcp add, or a JSON block.` };
}

// -- entry point -------------------------------------------------------------------------------------------
export function readMcpPaste(input) {
  const raw = String(input ?? '').replace(/^﻿/, '').trim();
  if (!raw) return { ok: false, error: 'Paste a link, a setup command or a config block.' };
  if (raw.length > MAX_TEXT) return { ok: false, error: 'That is too long to be one MCP server. Paste just the server.' };
  const text = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (text.startsWith('{')) return fromJson(text);
  if (isUrl(text)) {
    const draft = make({ transport: /\/sse\/?$/i.test(new URL(text).pathname) ? 'sse' : 'http', url: text });
    return { ok: true, kind: 'url', servers: [draft] };
  }
  const lines = joinContinued(text).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const result = fromCommandLine(lines[0] || '');
  return result.ok && lines.length > 1 ? { ...result, ignored: lines.length - 1 } : result;
}

// The names of the secret slots a draft fills, for "needs a value" gaps (never the values).
export function secretNames(draft) {
  return { headers: Object.keys(draft?.headers || {}), env: Object.keys(draft?.env || {}) };
}
