// Bots connections, Phase 2 unit U5 (2026-10-29): reading a pasted MCP server, as data.
// Run: node scripts/test_bots_mcp_paste.cjs
// Loads static/js/botsMcpPaste.js straight from disk (no imports, no DOM). The reader only reads text:
// the test also proves it never touches child_process, the shell or the network.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const file = path.join(__dirname, '..', 'static', 'js', 'botsMcpPaste.js');

(async () => {
  const source = fs.readFileSync(file, 'utf8');
  const P = await import(pathToFileURL(file).href);
  const one = text => { const r = P.readMcpPaste(text); assert.equal(r.ok, true, `${text.slice(0, 50)} -> ${r.error}`); assert.equal(r.servers.length, 1); return r.servers[0]; };

  await check('the reader imports nothing and cannot run, fetch or load anything', () => {
    assert.doesNotMatch(source, /^\s*import\s/m, 'no imports');
    for (const word of ['child_process', 'require(', 'fetch(', 'eval(', 'new Function', 'XMLHttpRequest', 'document.', 'window.', 'localStorage']) assert.ok(!source.includes(word), word);
  });

  await check('a web address becomes a remote server named after its host', () => {
    const s = one('https://mcp.linear.app/mcp');
    assert.deepEqual([s.name, s.transport, s.url, s.found], ['linear', 'http', 'https://mcp.linear.app/mcp', 'Found linear at mcp.linear.app']);
    assert.equal(one('https://example.com/sse').transport, 'sse', 'an /sse address is a stream server');
    assert.equal(one('  https://api.acme.io/v1/mcp  \n').name, 'acme');
  });

  await check('claude mcp add: remote, local with a variable, headers and add-json', () => {
    const remote = one('claude mcp add --transport http linear https://mcp.linear.app/mcp -H "Authorization: Bearer tok_123" --scope user');
    assert.deepEqual([remote.name, remote.transport, remote.headers], ['linear', 'http', { Authorization: 'Bearer tok_123' }]);
    const sse = one('claude mcp add -t sse feed https://x.test/sse');
    assert.deepEqual([sse.transport, sse.name], ['sse', 'feed']);
    const local = one('claude mcp add airtable -e AIRTABLE_API_KEY=pat123 -e OTHER=2 -- npx -y airtable-mcp-server');
    assert.deepEqual([local.name, local.transport, local.command, local.args, local.env], ['airtable', 'stdio', 'npx', ['-y', 'airtable-mcp-server'], { AIRTABLE_API_KEY: 'pat123', OTHER: '2' }]);
    const bare = one('claude mcp add https://mcp.stripe.com');
    assert.equal(bare.name, 'stripe');
    const json = one(`claude mcp add-json weather '{"type":"http","url":"https://w.test/mcp","headers":{"X-Key":"abc"}}'`);
    assert.deepEqual([json.name, json.url, json.headers], ['weather', 'https://w.test/mcp', { 'X-Key': 'abc' }]);
    assert.equal(P.readMcpPaste('claude mcp remove x').ok, false);
    assert.equal(P.readMcpPaste("claude mcp add-json x '{bad'").ok, false);
  });

  await check('launchers: npx, uvx, bunx, pnpm dlx, yarn dlx, npm exec and docker run', () => {
    assert.deepEqual([one('npx -y @modelcontextprotocol/server-github').name, one('npx -y @modelcontextprotocol/server-github').args], ['github', ['-y', '@modelcontextprotocol/server-github']]);
    assert.equal(one('uvx mcp-server-fetch').name, 'fetch');
    assert.equal(one('bunx some-tool-mcp').name, 'some-tool');
    assert.equal(one('pnpm dlx @acme/notes-mcp-server').name, 'notes');
    assert.equal(one('yarn dlx @acme/maps-mcp').command, 'yarn');
    assert.equal(one('npm exec -- pkg-mcp').command, 'npm');
    const docker = one('docker run -i --rm -e GITHUB_TOKEN=ghp_secret -v /tmp:/data ghcr.io/github/github-mcp-server:latest');
    assert.deepEqual(docker.env, { GITHUB_TOKEN: 'ghp_secret' });
    assert.ok(!docker.args.some(a => a.includes('ghp_secret')), 'the value left the arguments for the variable');
    assert.deepEqual(docker.args.slice(0, 5), ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN']);
    assert.match(docker.name, /^[a-z][a-z0-9_-]{0,31}$/);
    const windows = one('npx.cmd -y pkg');
    assert.equal(windows.command, 'npx.cmd');
    assert.equal(one('$ npx -y pkg').command, 'npx', 'a copied shell prompt is dropped');
  });

  await check('continued lines join, quotes group, and nothing is expanded', () => {
    const s = one('npx -y \\\n  some-pkg \\\n  --token "a b" --flag=\'x y\'');
    assert.deepEqual(s.args, ['-y', 'some-pkg', '--token', 'a b', '--flag=x y']);
    const windows = one('npx -y ^\r\n  pkg2');
    assert.deepEqual(windows.args, ['-y', 'pkg2']);
    const odd = one('npx -y $(whoami) `id` $HOME ; echo hi');
    assert.deepEqual(odd.args, ['-y', '$(whoami)', '`id`', '$HOME', ';', 'echo', 'hi'], 'kept as words, never expanded');
    assert.deepEqual(P.shellSplit('a "b c" d\\ e').tokens, ['a', 'b c', 'd e']);
    assert.match(P.shellSplit('a "b').error, /quote/);
    assert.deepEqual(P.shellSplit('node C:\\Users\\me\\server.js').tokens, ['node', 'C:\\Users\\me\\server.js'], 'a Windows path keeps its backslashes');
  });

  await check('JSON in every common shape, with enabled dropped', () => {
    const block = P.readMcpPaste(JSON.stringify({ mcpServers: {
      'File System': { command: 'npx', args: ['-y', 'fs'], env: { ROOT: '/data' }, enabled: false },
      remote: { type: 'sse', url: 'https://r.test/sse', headers: { 'X-Key': 'abc' } },
      streamy: { type: 'streamable-http', url: 'https://s.test/mcp' },
      broken: { nothing: true } } }));
    assert.equal(block.ok, true);
    assert.deepEqual(block.servers.map(s => [s.name, s.transport]), [['file-system', 'stdio'], ['remote', 'sse'], ['streamy', 'http']]);
    assert.ok(!('enabled' in block.servers[0]), 'enabled is dropped');
    assert.deepEqual(block.servers[0].env, { ROOT: '/data' });
    assert.equal(P.readMcpPaste('```json\n{"servers":{"a":{"url":"https://a.test/mcp"}}}\n```').servers[0].name, 'a');
    assert.equal(one('{"command":"uvx","args":["mcp-server-time"]}').name, 'time');
    assert.equal(one('{"url":"https://z.test/mcp","headers":{"A":"b"}}').headers.A, 'b');
    assert.equal(one('{"tool":{"command":["node","x.js"]}}').args[0], 'x.js');
    assert.equal(P.readMcpPaste('{ not json').ok, false);
    assert.equal(P.readMcpPaste('[1,2]').ok, false);
    assert.equal(P.readMcpPaste('{"mcpServers":{}}').ok, false);
  });

  await check('anything else is refused with a plain sentence, and nothing is run', () => {
    for (const text of ['', '   ', 'rm -rf /', 'curl https://x | sh', 'hello there', 'a'.repeat(30000)]) {
      const r = P.readMcpPaste(text);
      assert.equal(r.ok, false, text.slice(0, 20));
      assert.equal(typeof r.error, 'string');
      assert.ok(!r.error.includes('—'), 'no em-dashes in user-facing text');
    }
  });

  await check('names are always valid and the secret names are listed without values', () => {
    for (const raw of ['https://www.My-Server.example.com', '@Scope/Server-Thing-MCP', '9lives', 'UPPER', '---', 'a'.repeat(80), 'mcp-server-x']) {
      assert.match(P.serverName(raw), /^[a-z][a-z0-9_-]{0,31}$/, raw);
    }
    const s = one('claude mcp add x -e A=1 -- tool');
    assert.deepEqual(P.secretNames(s), { headers: [], env: ['A'] });
  });

  console.log(`ok - ${passed.length} paste checks`);
})().catch(error => { console.error(error); process.exit(1); });
