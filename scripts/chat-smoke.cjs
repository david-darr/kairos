// Real Chromium, synthetic sessions and loopback-only traffic. No live backend.
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'chat-review', 'run-' + Date.now());
const errors = [], requests = [];
function samplePDF() {
  const stream = 'BT /F1 24 Tf 50 740 Td (JARVIS preview test) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(out.length); out += `${i+1} 0 obj\n${obj}\nendobj\n`; });
  const xref = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10,'0') + ' 00000 n \n').join('');
  return out + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}
const files = {
  '/chat-files/aaaaaaaaaaaaaaaaaaaaaaaa': { filename: 'draft.txt', extension: 'txt', kind: 'text', text: 'Sent draft' },
  '/chat-files/bbbbbbbbbbbbbbbbbbbbbbbb': { filename: 'notes.md', extension: 'md', kind: 'markdown', text: '# Model notes' },
  '/generated-files/012345abcdef_Project%20brief.md': { filename: 'Project brief.md', extension: 'md', kind: 'markdown', text: '# Project brief\n\nA **focused** workspace.\n\n- Clear next steps\n- Room to think' },
  '/generated-files/012345abcdef_preview.html': { filename: 'preview.html', extension: 'html', kind: 'html', text: '<html><style>h1{color:teal}</style><h1>A focused workspace</h1><script>parent.__xss=1</script><img src="https://example.test/tracker"><a href="https://example.test">Escape</a></html>' },
  // 'office' rather than 'download' as of the Office preview work
  // (2026-09-15) — see core/chat_artifacts.py. A macro-enabled sibling is
  // kept below so the download-only fallback still has a real subject.
  '/generated-files/012345abcdef_report.docx': { filename: 'report.docx', extension: 'docx', kind: 'office', text: 'synthetic office file' },
  '/generated-files/012345abcdef_budget.xlsx': { filename: 'budget.xlsx', extension: 'xlsx', kind: 'office', text: 'synthetic workbook' },
  '/generated-files/012345abcdef_deck.pptx': { filename: 'deck.pptx', extension: 'pptx', kind: 'office', text: 'synthetic deck' },
  '/generated-files/012345abcdef_rows.csv': { filename: 'rows.csv', extension: 'csv', kind: 'office', text: 'name,note\r\n"Smith, John",two\r\n' },
  '/generated-files/012345abcdef_macros.docm': { filename: 'macros.docm', extension: 'docm', kind: 'download', text: 'macro-enabled file' },
  '/generated-files/012345abcdef_snippet.py': { filename: 'snippet.py', extension: 'py', kind: 'text', text: 'print("Hello")' },
  '/generated-files/012345abcdef_preview.pdf': { filename: 'preview.pdf', extension: 'pdf', kind: 'pdf', text: samplePDF() },
  '/generated-files/012345abcdef_image.png': { filename: 'image.png', extension: 'png', kind: 'image', text: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64') },
};
const rich = '# A clearer direction\n\nHere is a **focused plan**, with `useful details` and [a reference](https://example.test).\n\n## Next steps\n\n1. Keep the important work visible.\n2. Make room for deeper thinking.\n\n> Good tools stay out of your way.\n\n| Area | Direction |\n| --- | --- |\n| Chat | Clear, readable responses |\n| Files | Preview without leaving |\n\n```python\ndef greet(name):\n    return f"Hello, {name}"\n```\n\n[Project brief](/generated-files/012345abcdef_Project%20brief.md)\n\n[Static preview](/generated-files/012345abcdef_preview.html)\n\n[Word document](/generated-files/012345abcdef_report.docx)\n\n[Python source](/generated-files/012345abcdef_snippet.py)\n\n[Workbook](/generated-files/012345abcdef_budget.xlsx)\n\n[Slide deck](/generated-files/012345abcdef_deck.pptx)\n\n[Rows](/generated-files/012345abcdef_rows.csv)\n\n[Macro document](/generated-files/012345abcdef_macros.docm)';
// Engine available, no model downloaded: what a fresh install looks like.
let speechStatus = { engine_available: true, active_model: null, models: [
  { name: 'tiny.en', label: 'Tiny', size_mb: 75, downloaded: false },
  { name: 'base.en', label: 'Base', size_mb: 142, downloaded: false },
] };
const models = [{ id: 'claude', name: 'Claude Code', kind: 'claude_cli', model: 'configured-model' }, { id: 'codex', name: 'Codex CLI', kind: 'codex_cli', model: '' }, { id: 'local', name: 'Local', kind: 'local', model: 'local-model' }, { id: 'openai', name: 'OpenAI API', kind: 'api', model: 'gpt-5.5' }];
// Stands in for core/model_catalog.py's response. "ultra" belongs to one
// codex model and not the other on purpose — same asymmetry the backend
// suite relies on, so the effort row is proven to be per-model here too.
const effortList = names => names.map(effort => ({ effort, description: effort + ' reasoning' }));
const catalog = {
  codex_cli: [
    { id: 'catalog-astra', display_name: 'Catalog Astra', description: 'Most capable catalog model.', alias: null, default_effort: 'low', supported_efforts: effortList(['low', 'medium', 'high', 'ultra']), context_window: 100000, effective_context_percent: 90, source: 'cli_cache', estimated: false },
    { id: 'catalog-lite', display_name: 'Catalog Lite', description: 'Smaller and faster.', alias: null, default_effort: 'medium', supported_efforts: effortList(['low', 'medium']), context_window: 50000, effective_context_percent: null, source: 'cli_cache', estimated: false },
  ],
  claude_cli: [
    { id: 'configured-model', display_name: 'Configured Model', description: 'Curated entry.', alias: null, default_effort: null, supported_efforts: effortList(['low', 'high']), context_window: 200000, effective_context_percent: null, source: 'curated', estimated: true },
  ],
};
// 2026-10-14: ten entries, so the model menu's search box (shown only on a long
// list) is exercised here; the two-entry CLI catalog checks that it stays hidden.
const apiCatalog = [{ id: 'gpt-6-astra', display_name: 'GPT-6 Astra', description: '', alias: null, default_effort: null, supported_efforts: [], context_window: null, effective_context_percent: null, source: 'openai_api', estimated: false },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `gpt-6-mini-${i + 1}`, display_name: `GPT-6 Mini ${i + 1}`, description: '', alias: null, default_effort: null, supported_efforts: [], context_window: null, effective_context_percent: null, source: 'openai_api', estimated: false }))];
const chats = {
  s1: { id: 's1', title: 'A focused workspace', model_endpoint_id: 'claude', messages: [{ role: 'user', content: 'Help me shape this into a clear plan.' }, { role: 'assistant', content: rich }] },
  s2: { id: 's2', title: 'Another conversation', model_endpoint_id: 'codex', messages: [] },
};
const chatFileRows = [
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'draft.txt', origin: 'attachment', url: '/chat-files/aaaaaaaaaaaaaaaaaaaaaaaa', size: 10, exists: true },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'notes.md', origin: 'created', url: '/chat-files/bbbbbbbbbbbbbbbbbbbbbbbb', size: 13, exists: true },
  { id: 'cccccccccccccccccccccccc', name: 'Project brief.md', origin: 'generated', url: '/generated-files/012345abcdef_Project%20brief.md', size: 20, exists: true },
];
let pending = null;
const answers = [];
let deferFirstChunk = false;
const liveRuns = {};
const liveClients = new Set();
const liveSnapshot = () => ({ type: 'snapshot', runs: structuredClone(liveRuns) });
const liveBroadcast = packet => { for (const client of liveClients) client.write(`data: ${JSON.stringify(packet)}\n\n`); };
function liveStream(sid, text) {
  const run = liveRuns[sid] = { turnId: 'turn-' + Date.now(), sessionTitle: chats[sid].title, prompt: text,
    text: '', startedAt: Date.now() / 1000, status: 'processing', stopping: false, permission: null,
    toolEvents: [], toolSteps: [], handoffs: null, runId: null, error: null, revision: 1 };
  liveBroadcast({ type: 'started', sessionId: sid, run: structuredClone(run) });
  let ended = false;
  const finish = (status, error = null) => {
    if (ended) return;
    ended = true; run.status = status; run.error = error; run.revision++;
    liveBroadcast({ type: 'update', sessionId: sid, turnId: run.turnId, revision: run.revision,
      changes: { status, stopping: false, permission: null, error } });
  };
  const write = raw => {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const packet = JSON.parse(line.slice(5));
      if (packet.chunk) { run.text += packet.chunk; run.revision++; liveBroadcast({ type: 'chunk', sessionId: sid,
        turnId: run.turnId, revision: run.revision, chunk: packet.chunk }); }
      if (packet.permission) { run.permission = packet.permission; run.revision++; liveBroadcast({ type: 'update',
        sessionId: sid, turnId: run.turnId, revision: run.revision, changes: { permission: packet.permission } }); }
      if (packet.done) finish('done');
    }
  };
  return { write, end(raw = '') { if (raw) write(raw); if (!ended) finish('failed', 'Connection ended early.'); }, stop() { finish('stopped'); } };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    // Mirrors core/middleware.py's real header, frame-src included — the
    // whole point of reproducing it here is that a CSP difference between
    // fixture and product hides exactly this class of bug.
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' https:");
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/css/style.css"><link rel="stylesheet" href="/static/css/chat.css"><link rel="stylesheet" href="/static/css/mascot.css"><link rel="stylesheet" href="/static/css/redesign-chat.css"><link rel="stylesheet" href="/static/css/redesign-sidebar.css"></head><body><div id="view-content" class="view active" style="height:100vh"></div></body></html>'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = body && req.headers['content-type']?.includes('application/json') ? JSON.parse(body) : {};
    requests.push({ path: url.pathname, method: req.method, data });
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/home/week') return json(require('../demo/fixtures.js')({ now: Date.now() / 1000 }).fixture(url));
    if (url.pathname === '/api/chat/live/snapshot') return json(liveSnapshot());
    if (url.pathname === '/api/chat/live/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      liveClients.add(res); res.write(`data: ${JSON.stringify(liveSnapshot())}\n\n`);
      res.on('close', () => liveClients.delete(res)); return;
    }
    if (url.pathname === '/api/chat/live/stop') {
      pending?.res.stop();
      return json({ stopping: true });
    }
    if (url.pathname === '/api/speech/status') return json(speechStatus);
    if (url.pathname === '/api/speech/transcribe') return json({ text: 'what is the weather' });
    if (url.pathname === '/api/models/catalog') return json(catalog);
    if (url.pathname.startsWith('/api/models/') && url.pathname.endsWith('/catalog')) {
      const id = url.pathname.split('/')[3];
      return json(id === 'openai' ? apiCatalog : catalog[models.find(m => m.id === id)?.kind] || []);
    }
    if (url.pathname === '/api/models') return json(models);
    if (url.pathname.endsWith('/permission-mode')) return json({ mode: data.mode });
    if (url.pathname === '/api/auth/status') return json({ auth_enabled: false, setup_required: false, username: 'Alex', is_admin: true });
    if (url.pathname === '/api/models/choices') return json(models.map(m => ({ ...m, supports_images: m.kind !== 'local' })));
    if (url.pathname === '/api/projects') return json([]);
    if (url.pathname === '/api/designs') return json([]);
    if (url.pathname === '/api/computer') return json([]);
    if (/^\/api\/computer\/[^/]+\/last$/.test(url.pathname)) return json(null);
    if (url.pathname === '/api/chat/files/library') return json([{ session_id: 's1', title: chats.s1.title, files: chatFileRows }]);
    if (url.pathname === '/api/chat/files') return json(url.searchParams.get('session_id') === 's1' ? chatFileRows : []);
    if (url.pathname === '/api/chat/references') return json([
      { kind: 'file', id: 'aaaaaaaaaaaaaaaaaaaaaaaa', session_id: 's1', label: 'draft.txt', detail: 'A focused workspace' },
      { kind: 'note', id: 'Active Priorities.md', label: 'Active Priorities', detail: 'Active Priorities.md' },
      { kind: 'chat', id: 's2', label: 'Another conversation', detail: 'Conversation' },
    ]);
    if (url.pathname === '/api/documents') return json([]);
    if (url.pathname === '/api/documents/search') return json([]);
    if (url.pathname === '/api/chat/attachments') return json({ id: 'staged-test', filename: 'draft.txt' });
    if (url.pathname === '/api/chat/validate-attachments') return json({ ok: true });
    if (url.pathname === '/api/sessions') {
      if (req.method === 'POST') {
        const id = 'new-' + Object.keys(chats).length;
        chats[id] = { id, title: 'New chat', messages: [], model_endpoint_id: 'claude' };
        return json(chats[id]);
      }
      return json(Object.values(chats));
    }
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/model|\/context|\/usage|\/open-mic|\/rewind)?$/);
    if (match) {
      const chat = chats[match[1]];
      if (match[2] === '/rewind') {
        // Mirrors core/session_manager.py's rewind: keep the first N messages.
        if (!(data.keep >= 0 && data.keep < chat.messages.length)) { res.writeHead(400); return json({ detail: 'out of range' }); }
        chat.messages = chat.messages.slice(0, data.keep);
        return json(chat);
      }
      if (match[2] === '/model') {
        Object.assign(chat, { model_override: data.model_override ?? null, model_effort: data.effort ?? null, ...data });
        // Mirrors core/session_manager.py: a model change invalidates the
        // stored occupancy, because the capacity it was measured against
        // no longer applies.
        if ('model_override' in data) chat.context_state = null;
        return json({ ok: true, ...data });
      }
      if (match[2] === '/open-mic') {
        chat.open_mic = !!data.active;
        return json(data.active ? { open_mic: true } : { open_mic: false, summarised: false, reason: 'too short to summarise' });
      }
      if (match[2] === '/context') return json(chat.context_state ? { available: true, ...chat.context_state } : { available: false });
      // The usage meter (Session Usage and Model Tracking, unit 1): sums from the chat's runs.
      if (match[2] === '/usage') {
        if (!chat.usage) { res.statusCode = 404; return json({ detail: 'session not found' }); }
        return json({ ...chat.usage, context: chat.context_state || null });
      }
      return json(chat);
    }
    // Structured Office contents, shaped exactly like core/office_preview.py's
    // output so the renderers are exercised against the real payload.
    if (url.pathname === '/api/chat/artifacts/office') {
      const file = files[url.searchParams.get('url')];
      if (!file || file.kind !== 'office') { res.writeHead(400); return json({ detail: 'This file has no structured preview' }); }
      if (file.extension === 'xlsx') return json({ kind: 'xlsx', truncated_sheets: false, sheets: [
        { name: 'Budget', rows: [['Item', 'Qty'], ['Widget', '3']], total_rows: 900, total_cols: 2, truncated_rows: true, truncated_cols: false },
        { name: 'Notes', rows: [['second sheet']], total_rows: 1, total_cols: 1, truncated_rows: false, truncated_cols: false },
      ] });
      if (file.extension === 'docx') return json({ kind: 'docx', truncated: false, blocks: [
        { type: 'heading', level: 1, text: 'Project brief' },
        { type: 'paragraph', level: 0, text: 'An opening paragraph.' },
        { type: 'table', rows: [['Area', 'Direction'], ['Chat', 'Clear']] },
        { type: 'paragraph', level: 0, text: 'Closing paragraph after the table.' },
      ] });
      // The shape contract core/office_preview.py has returned since the
      // artifact viewer upgrade (2026-10-08); title/body/tables stay too.
      const text = (id, name, value, y) => ({ id, name, kind: 'text', x: 600000, y, w: 9000000, h: 800000, rotation: 0, z: id,
        fill: null, line: null, rows: [], image: null, paragraphs: [{ align: 'left', level: 0, runs: [{ text: value, size_pt: 28, bold: false, italic: false, underline: false, color: null }] }] });
      if (file.extension === 'pptx') return json({ kind: 'pptx', truncated: false, layout_fidelity: false, slide_width: 12192000, slide_height: 6858000, slides: [
        { index: 1, title: 'Quarterly review', body: ['First point', 'Second point'], tables: [], notes: 'Speaker notes here.', groups: [],
          shapes: [text(2, 'Title 1', 'Quarterly review', 400000), text(3, 'Body', 'First point', 1600000), text(4, 'Body 2', 'Second point', 2600000)] },
        { index: 2, title: 'Second slide', body: [], tables: [[['a', 'b']]], notes: '', groups: [],
          shapes: [text(2, 'Title 1', 'Second slide', 400000), { id: 5, name: 'Table', kind: 'table', x: 600000, y: 1800000, w: 6000000, h: 900000, rotation: 0, z: 5, fill: null, line: null, paragraphs: [], image: null, rows: [['a', 'b']] }] },
      ] });
      return json({ kind: 'csv', truncated: false, rows: [['name', 'note'], ['Smith, John', 'two']] });
    }
    if (url.pathname.startsWith('/api/chat/artifacts')) {
      const file = files[url.searchParams.get('url')];
      if (!file) { res.writeHead(404); return json({ detail: 'The generated file is no longer available' }); }
      if (url.pathname.endsWith('/content')) {
        res.setHeader('Content-Type', file.kind === 'pdf' ? 'application/pdf' : file.kind === 'image' ? 'image/png' : 'text/plain');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; sandbox");
        res.end(file.text); return;
      }
      return json({ ...file, size: file.text.length });
    }
    if (url.pathname === '/api/chat/live') {
      chats[data.session_id].messages.push({ role: 'user', content: data.message });
      const text = '## Working on your request\n\n' + 'A paragraph with enough detail to exercise the reading position.\n\n'.repeat(25);
      pending = { res: liveStream(data.session_id, data.message), sid: data.session_id, text };
      if (!deferFirstChunk) pending.res.write('data: ' + JSON.stringify({ chunk: text }) + '\r\n\r\n');
      return json({ turn_id: liveRuns[data.session_id].turnId });
    }
    if (url.pathname.startsWith('/api/permissions')) {
      if (url.pathname.endsWith('/answer')) {
        answers.push({ path: url.pathname, choice: data.choice });
        const run = pending && liveRuns[pending.sid];
        if (run) { run.permission = null; run.revision++; liveBroadcast({ type: 'update', sessionId: pending.sid,
          turnId: run.turnId, revision: run.revision, changes: { permission: null } }); }
        return json({ status: 'answered' });
      }
      return json({ rules: [], audit: [] });
    }
    if (/^\/api\/chat\/background\/[^/]+$/.test(url.pathname)) return json({ items: [], notes: [] });
    console.warn('chat-smoke: missing fixture ' + url.pathname);
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: 'Missing fixture: ' + url.pathname })); return;
  }
  const target = path.resolve(root, '.' + url.pathname);
  if (!target.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(target)] || 'application/octet-stream');
    res.end(fs.readFileSync(target));
  } catch { res.writeHead(404); res.end(); }
});
const delay = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'data', 'chat-smoke-profile'));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(base + '/') && !details.url.startsWith('about:') && !details.url.startsWith('data:') }));
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message); });
  const js = async code => {
    let timer;
    try { return await Promise.race([win.webContents.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Renderer timeout: ' + code)), 10000); })]); }
    catch (error) { throw new Error(error.message + '\nRenderer expression: ' + code); }
    finally { clearTimeout(timer); }
  };
  const waitFor = async condition => { for (let i = 0; i < 100; i++) { if (await js(condition)) return; await delay(40); } throw Error('Timed out: ' + condition); };
  const capture = async name => { await delay(300); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const open = async sid => { await js(`import('/static/js/views/chat.js').then(m => m.openSessionById('${sid}'))`); };
  // --mascot-off: the root attribute Settings > Appearance > Show the mascot sets (appearance.js).
  const mascotOff = process.argv.includes('--mascot-off');
  const mount = async () => {
    if (mascotOff) await js("document.documentElement.dataset.mascot = 'off'");
    await js(`import('/static/js/views/chat.js').then(async m => { window.cleanup?.(); window.cleanup = await m.render(document.querySelector('#view-content'), 'chat', {sessionId: 's1'}); })`);
  };
  try {
    await win.loadURL(base); await mount();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await js("import('/static/js/api.js').then(m => m.useAppMenusForSelects())");
    // 2026-10-15: use real press/release events: a list covering Mode used
    // to steal mouseup, target the click at BODY and dismiss both menus.
    const click = async selector => {
      const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
      await delay(200);
    };
    await delay(300);
    await waitFor("document.querySelector('.chat-composer-dock').getAnimations().every(a => a.playState !== 'running')");
    // Desktop redesign: the prompt's permission pill and its menu (Base is Supervised, Auto is Full access).
    await click('#chat-permission-pill');
    assert.deepEqual(await js("[...document.querySelectorAll('#chat-permission-menu .chat-permission-choice strong')].map(b => b.textContent)"), ['Supervised', 'Full access']);
    assert.equal(await js("document.querySelector('#chat-permission-pill').getAttribute('aria-expanded')"), 'true', 'The pill opens its menu');
    await click('#chat-permission-menu [data-mode=auto]');
    await waitFor("document.querySelector('#chat-permission-mode').value==='auto' && !document.querySelector('#chat-permission-mode').disabled");
    assert.equal(await js("document.querySelector('#chat-permission-mode').value"), 'auto');
    assert.equal(requests.filter(r => r.path.endsWith('/permission-mode')).at(-1)?.data.mode, 'auto');
    assert.equal(await js("document.querySelector('#chat-permission-pill .chat-permission-pill-name').textContent"), 'Full access', 'The pill names the saved mode');
    assert.equal(await js("document.querySelector('#chat-permission-menu').classList.contains('hidden') && document.activeElement === document.querySelector('#chat-permission-pill')"), true, 'Choosing closes the menu and returns focus to the pill');
    assert.equal(await js("document.querySelectorAll('.chat-prose h1').length"), 1);
    assert.equal(await js("document.querySelectorAll('.chat-prose table').length"), 1);
    assert.equal(await js("document.querySelectorAll('.chat-code-header button').length"), 1);
    assert.ok(await js("!!document.querySelector('code .hljs-keyword')"));
    assert.equal(await js("document.querySelectorAll('.artifact-card').length"), 8);
    // Chat files share the preview pane, and Library groups the same files
    // under their source chat even when document search has no results.
    await js("document.querySelector('.chat-files-toggle').click()");
    await waitFor("document.querySelectorAll('.chat-file-row').length===3");
    assert.deepEqual(await js("[...document.querySelectorAll('.chat-files-heading')].map(n=>n.textContent)"),
      ['Sent to this chat', 'Created by a model', 'Generated files']);
    await capture('desktop-chat-files');
    await js("document.querySelector('.chat-file-row').click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-source, .artifact-document')");
    assert.equal(await js("document.querySelectorAll('.chat-files-panel').length"), 0);
    await js("document.querySelector('.chat-files-toggle').click()");
    await waitFor("document.querySelectorAll('.chat-file-row').length===3");
    assert.equal(await js("document.querySelectorAll('.artifact-panel:not(.chat-files-panel)').length"), 0);
    await js("document.querySelector('[aria-label=\"Close chat files\"]').click()");
    await js("(async () => { const host=document.createElement('div'); host.id='library-smoke'; host.hidden=true; document.body.append(host); await import('/static/js/views/library.js').then(m=>m.render(host)); })()");
    await waitFor("document.querySelectorAll('#library-smoke .library-chat-files .document-card').length===3");
    assert.equal(await js("document.querySelector('#library-smoke .library-chat-heading').textContent"), 'A focused workspace');
    await js("{ const input=document.querySelector('#library-smoke input[placeholder^=\"Search documents\"]'); input.value='notes.md'; input.dispatchEvent(new Event('input')); }");
    await waitFor("document.querySelectorAll('#library-smoke .library-chat-files .document-card').length===1");
    assert.ok(await js("document.querySelector('#library-smoke #library-grid').textContent.includes('No documents match')"));
    await js("document.querySelector('#library-smoke').remove()");
    await js("document.querySelector('#chat-messages').scrollTop=0");
    await capture('desktop-chat');
    // Chat history (desktop redesign: the popout): right-click a chat row -> menu with "Open in new
    // window" (stubbed IPC, no real window). Open it the way a user does.
    await click('#chat-history-toggle');
    await waitFor("!!document.querySelector('#rd-history .rd-history-open') && document.querySelector('#rd-history').getAnimations().length === 0");
    await js("window.jarvis = { ...(window.jarvis || {}), openChatWindow: id => { (window.__newWindowIds ||= []).push(id); return Promise.resolve({ ok: true }); } }; true");
    const rowPoint = await js("(() => { const row = document.querySelector('#rd-history .rd-history-open'); const r = row.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: row.dataset.sessionId }; })()");
    const rightClick = async () => { for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: rowPoint.x, y: rowPoint.y, button: 'right', clickCount: 1 }); };
    await rightClick();
    await waitFor("!!document.querySelector('.rd-conversation-menu')");
    assert.ok((await js("[...document.querySelectorAll('.rd-conversation-menu [role=menuitem]')].map(b => b.textContent)")).some(t => t.includes('Open in new window')));
    assert.equal(await js("(() => { const r = document.querySelector('.rd-conversation-menu').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()"), true, 'menu sits inside the window');
    await capture('desktop-conversation-menu');
    await js("[...document.querySelectorAll('.rd-conversation-menu [role=menuitem]')].find(b => b.textContent.includes('Open in new window')).click()");
    assert.deepEqual(await js('window.__newWindowIds'), [rowPoint.id], 'Open in new window passes the row session id');
    assert.equal(await js("!!document.querySelector('.rd-conversation-menu')"), false, 'choosing an item closes the menu');
    await rightClick();
    await waitFor("!!document.querySelector('.rd-conversation-menu')");
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor("!document.querySelector('.rd-conversation-menu')");
    assert.equal(await js("document.activeElement?.classList.contains('rd-history-open')"), true, 'Escape returns focus to the row');
    // The popout opens over the header button, so it closes from its own × (or Escape, or outside).
    await click('#rd-history [aria-label="Close chat history"]');
    await waitFor("!document.querySelector('#rd-history') && document.querySelector('#chat-sessions').inert && document.querySelector('#chat-history-toggle').getAttribute('aria-expanded') === 'false'");
    // Header pane toggles (desktop redesign): Documents and Browser always, Design, Background tasks
    // and Computer only when there is something to open; each reflects its pane being open.
    const paneButtons = () => js("[...document.querySelectorAll('.chat-pane-toolbar .chat-pane-icon')].filter(b => !b.hidden).map(b => b.getAttribute('aria-label') + ':' + b.getAttribute('aria-pressed'))");
    assert.ok((await paneButtons()).includes('Documents:false') && (await paneButtons()).includes('Browser:false'), 'Documents and Browser toggles show in the header');
    await js("document.querySelector('.chat-pane-icon[aria-label=Browser]').click()");
    await waitFor("document.querySelector('.chat-pane-icon[aria-label=Browser]').getAttribute('aria-pressed') === 'true'");
    await js("document.querySelector('.chat-pane-icon[aria-label=Browser]').click()");
    await waitFor("document.querySelector('.chat-pane-icon[aria-label=Browser]').getAttribute('aria-pressed') === 'false'");
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); }");
    await waitFor("!!document.querySelector('#chat-model-id')");
    await js("document.querySelector('#chat-model-id').value='exact-test-model'; document.querySelector('.model-version-form').requestSubmit()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='exact-test-model'");
    assert.equal(chats.s1.model_override, 'exact-test-model');
    assert.equal(models[0].model, 'configured-model');
    await win.loadURL(base); await mount();
    assert.equal(await js("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))"), 'exact-test-model');
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); } [...document.querySelectorAll('#model-picker-menu button')].find(b=>b.textContent.startsWith('Local')).click()");
    await waitFor("!document.querySelector('#model-picker-label').textContent.includes(' · ')");
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); } [...document.querySelectorAll('#model-picker-menu button')].find(b=>b.textContent.startsWith('Codex')).click()");
    await waitFor("document.querySelector('#model-picker-label').textContent.includes(' · ')");

    // -- model catalog + reasoning level (David's ask 2026-09-15) --------
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); }");
    await waitFor("document.querySelectorAll('.model-catalog-item').length===2");
    assert.ok(await js("[...document.querySelectorAll('.model-catalog-name')].map(n=>n.textContent).includes('Catalog Astra')"));
    // The redesigned board searches all connections, including short catalogs.
    assert.equal(await js("document.querySelector('#model-picker-menu .rd-model-search')?.getAttribute('aria-label')"), 'Search models', 'The board has an accessible model search');
    await js("[...document.querySelectorAll('.model-catalog-item')].find(b=>b.textContent.includes('Catalog Astra')).click()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='Catalog Astra'");
    assert.equal(chats.s1.model_override, 'catalog-astra');
    // Picking a model must not carry an effort over with it.
    assert.equal(chats.s1.model_effort, null);
    // Astra advertises four levels; the row adds a "Default" option.
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); }");
    await waitFor("document.querySelectorAll('.model-effort-btn').length===5");
    assert.deepEqual(await js("[...document.querySelectorAll('.model-effort-btn')].map(b=>b.textContent)"), ['Default', 'low', 'medium', 'high', 'ultra']);
    await capture('desktop-model-catalog');
    await js("[...document.querySelectorAll('.model-effort-btn')].find(b=>b.textContent==='ultra').click()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='Catalog Astra · ultra'");
    assert.equal(chats.s1.model_effort, 'ultra');
    assert.equal(requests.filter(r => r.path === '/api/sessions/s1/model' && r.data.effort === 'ultra').length, 1);
    // The smaller model genuinely advertises fewer levels — proving the row
    // is driven per-model, not by one shared provider-wide list.
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); }");
    await waitFor("[...document.querySelectorAll('.model-catalog-item')].some(b=>b.textContent.includes('Catalog Lite'))");
    await js("[...document.querySelectorAll('.model-catalog-item')].find(b=>b.textContent.includes('Catalog Lite')).click()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='Catalog Lite'");
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); }");
    await waitFor("document.querySelectorAll('.model-effort-btn').length===3");

    // API connections share the version picker and persist a chat-local ID.
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); } [...document.querySelectorAll('#model-picker-menu button')].find(b=>b.textContent.startsWith('OpenAI')).click()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='gpt-5.5'");
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); }");
    await waitFor("[...document.querySelectorAll('.model-catalog-name')].some(n=>n.textContent==='GPT-6 Astra')");
    // Search filters the list rather than re-querying the server.
    // Braces, not a bare `const`: each js() call is evaluated in the same
    // global scope, so a repeated top-level declaration is a redeclaration
    // error that surfaces only as "script failed to execute".
    await waitFor("document.querySelectorAll('.model-catalog-item').length===10");
    await js("{ const s=document.querySelector('#model-picker-menu .rd-model-search'); s.value='astra'; s.dispatchEvent(new Event('input')); }");
    await waitFor("document.querySelectorAll('.model-catalog-item:not([hidden])').length===1");
    assert.equal(await js("document.querySelector('.model-catalog-item:not([hidden]) .model-catalog-name').textContent"), 'GPT-6 Astra');
    await js("{ const s=document.querySelector('#model-picker-menu .rd-model-search'); s.value=''; s.dispatchEvent(new Event('input')); }");
    await waitFor("document.querySelectorAll('.model-catalog-item:not([hidden])').length===10");
    await js("[...document.querySelectorAll('.model-catalog-item')].find(b=>b.textContent.includes('GPT-6 Astra')).click()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='GPT-6 Astra'");
    assert.equal(chats.s1.model_override, 'gpt-6-astra');
    assert.equal(models.find(m=>m.id==='openai').model, 'gpt-5.5');
    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); } [...document.querySelectorAll('#model-picker-menu button')].find(b=>b.textContent.startsWith('Codex')).click()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='CLI default'");

    // -- context meter --------------------------------------------------
    // Hidden entirely until the server reports a real measurement.
    assert.ok(await js("document.querySelector('#context-pill').hidden"));
    chats.s1.context_state = { used_tokens: 45000, capacity_tokens: 90000, percent: 50, estimated_capacity: false, capacity_source: 'cli_cache', model: 'catalog-astra' };
    await win.loadURL(base); await mount();
    await waitFor("!document.querySelector('#context-pill').hidden");
    assert.equal(await js("document.querySelector('.context-text').textContent"), '50%');
    assert.equal(await js("document.querySelector('#context-pill').dataset.level"), 'ok');
    assert.equal(await js("document.querySelector('.context-ring-fill').getAttribute('stroke-dasharray')"), '50 100');
    assert.ok(await js("document.querySelector('#context-pill').title.includes('reported by the provider')"));
    // A real reading with no published capacity shows the token count and
    // deliberately no percentage.
    chats.s1.context_state = { used_tokens: 4200, capacity_tokens: null, percent: null, estimated_capacity: false, capacity_source: null, model: 'unlisted' };
    await win.loadURL(base); await mount();
    await waitFor("document.querySelector('.context-text').textContent==='4.2k ctx'");
    assert.equal(await js("document.querySelector('.context-ring')"), null);
    assert.ok(await js("document.querySelector('#context-pill').title.includes('No context capacity is published')"));
    // A high reading is flagged visually without changing the number.
    chats.s1.context_state = { used_tokens: 87000, capacity_tokens: 90000, percent: 96.7, estimated_capacity: true, capacity_source: 'curated', model: 'catalog-astra' };
    await win.loadURL(base); await mount();
    await waitFor("document.querySelector('#context-pill').dataset.level==='high'");
    assert.equal(await js("document.querySelector('.context-text').textContent"), '96.7%');
    assert.ok(await js("document.querySelector('#context-pill').title.includes('estimated capacity')"));
    // The pill opens the usage meter: the chat's recorded figures, n/a where a provider reported nothing.
    chats.s1.context_state = { used_tokens: 45000, capacity_tokens: 90000, percent: 50, estimated_capacity: false, capacity_source: 'cli_cache', model: 'catalog-astra' };
    chats.s1.usage = { session_id: 's1', source: 'runs', turns: 4, runs: 5, reported_runs: 4, input_tokens: 120000, output_tokens: 3400,
      cache_read_tokens: 96000, cache_write_tokens: null, total_tokens: 123400, cache_hit_percent: 80, tool_calls: 6, compactions: 1,
      helper_runs: 1, failed: 0, stopped: 0, last_reply: { run_id: 'r9', ttft_seconds: 0.84, tokens_per_second: null, output_tokens: 900 },
      model: { model: 'catalog-astra', provider: 'Claude', kind: 'claude_cli', context_window: 90000, context_window_estimated: false } };
    await win.loadURL(base); await mount();
    await waitFor("!document.querySelector('#context-pill').hidden");
    await js("document.querySelector('#context-pill').click()");
    await waitFor("!!document.querySelector('#usage-meter .usage-meter-rows')");
    const meter = await js("Object.fromEntries([...document.querySelectorAll('#usage-meter .usage-meter-row')].map(r => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]))");
    assert.equal(meter['Input'], '120,000');
    assert.equal(meter['Cache write'], 'n/a', 'unreported is n/a, never 0');
    assert.equal(meter['Cache hit'], '80%');
    assert.equal(meter['Speed'], 'n/a', 'a whole-piece reply has no rate');
    assert.equal(meter['First output'], '0.84 s');
    assert.equal(meter['Model'], 'catalog-astra');
    assert.equal(meter['Context window'], '90K');
    assert.ok(await js("document.querySelector('#usage-meter .usage-meter-note').textContent.includes('4 of 5')"));
    assert.equal(await js("document.querySelector('#usage-meter .usage-context-used').textContent"), '45K');
    assert.equal(await js("document.querySelector('#usage-meter .usage-context-percent').textContent"), '50%');
    assert.equal(await js("document.querySelectorAll('#usage-meter .usage-context-segment').length"), 1);
    assert.ok(await js("!!document.querySelector('#usage-meter .usage-meter-compact')"), 'Compact is offered in the meter');
    assert.equal(await js("document.querySelector('#context-pill').getAttribute('aria-expanded')"), 'true');
    assert.ok(await js("(() => { const r=document.querySelector('#usage-meter').getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.right <= innerWidth+1 && r.bottom <= innerHeight+1; })()"), 'meter stays on screen');
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    await waitFor("!document.querySelector('#usage-meter')");
    // A local/API chat's window split by part (unit 5): one bar, a row per part, estimates marked.
    chats.s1.context_state = { ...chats.s1.context_state, parts: [
      { key: 'system', label: 'System prompt', tokens: 2100, estimated: true }, { key: 'tools', label: 'Tool definitions', tokens: 3600, estimated: true },
      { key: 'memory', label: 'Memory and skills', tokens: 900, estimated: true }, { key: 'conversation', label: 'Conversation', tokens: 38400, estimated: true }] };
    await js("document.querySelector('#context-pill').click()");
    await waitFor("document.querySelectorAll('#usage-meter .usage-context-segment').length===4");
    assert.deepEqual(await js("[...document.querySelectorAll('#usage-meter .usage-context-part')].map(p => p.querySelector('.usage-context-label').textContent + ' ' + p.querySelector('.usage-context-tokens').textContent)"),
      ['System prompt ~2.1K', 'Tool definitions ~3.6K', 'Memory and skills ~900', 'Conversation ~38K']);
    await capture('chat-details-breakdown');
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    await waitFor("!document.querySelector('#usage-meter')");
    // No context reading, but recorded runs: a reopened chat still shows its stored usage.
    chats.s1.context_state = null;
    await win.loadURL(base); await mount();
    await waitFor("!document.querySelector('#context-pill').hidden && document.querySelector('.context-text').textContent==='Usage'");
    await js("document.querySelector('#context-pill').click()");
    await waitFor("!!document.querySelector('#usage-meter .usage-meter-rows')");
    assert.ok(await js("[...document.querySelectorAll('#usage-meter .usage-card')][0].textContent.includes('No context reading')"));
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    delete chats.s1.usage;
    chats.s1.context_state = null;
    await win.loadURL(base); await mount();
    await waitFor("document.querySelector('#context-pill').hidden");

    // Seamless compaction (David, 2026-11-07): a local chat the server compacted on its own looks exactly as it
    // did. Every message stays on screen (the folded ones included, each still editable), nothing says
    // "compacted", and the next message goes straight out: no Compact call, no wait, no notice, no toast.
    chats.cmp = { id: 'cmp', title: 'Long local chat', model_endpoint_id: 'local',
      compactions: [{ through_index: 4, summary: 'SUMMARY of the earlier part', created_at: Date.now() / 1000 }],
      context_state: { used_tokens: 7200, capacity_tokens: 8192, percent: 87.9, estimated_capacity: false, capacity_source: 'endpoint_num_ctx', model: 'local-model' },
      messages: [{ role: 'user', content: 'Earliest question about the vendor', archived: true }, { role: 'assistant', content: 'Earliest answer', archived: true },
        { role: 'user', content: 'Second question', archived: true }, { role: 'assistant', content: 'Second answer', archived: true },
        { role: 'user', content: 'Latest question' }, { role: 'assistant', content: 'Latest answer' }] };
    await open('cmp');
    await waitFor("document.querySelectorAll('#chat-messages > .msg').length === 6");
    const transcript = () => js("document.querySelector('#chat-messages').innerText");
    assert.ok((await transcript()).includes('Earliest question about the vendor'), 'the folded messages are still on screen');
    assert.ok(!/compact/i.test(await transcript()), 'no compaction notice in the transcript');
    await waitFor("document.querySelectorAll('#chat-messages .msg-edit').length === 3");
    const sentBefore = requests.length;
    await js("document.querySelector('#chat-input').value='Next question'; document.querySelector('#chat-input').dispatchEvent(new Event('input')); document.querySelector('#chat-send').click()");
    await waitFor("document.querySelector('#chat-send').dataset.mode==='stop'");
    while (!pending) await delay(20);
    assert.equal(pending.sid, 'cmp', 'the message went straight out');
    await waitFor("document.querySelector('#chat-messages').innerText.includes('Working on your request')");
    chats.cmp.messages.push({ role: 'assistant', content: pending.text });
    pending.res.end('data: {"done":true}\n\n'); pending = null;
    await waitFor("document.querySelector('#chat-send').dataset.mode!=='stop'");
    const sent = requests.slice(sentBefore).map(r => r.path);
    assert.ok(!sent.includes('/api/chat/compact'), 'the page never asked for a compaction');
    assert.ok((await transcript()).includes('Earliest question about the vendor') && !/compact/i.test(await transcript()), 'still the whole chat, still no notice');
    assert.ok(await js("[...document.querySelectorAll('#toast-host .toast')].every(t => !/compact/i.test(t.textContent))"), 'no toast either');
    delete chats.cmp;
    await open('s1');

    // -- side browser, web fallback (David's ask 2026-09-15). This suite has
    // no preload bridge, so window.jarvis is undefined and browserPane.js
    // takes its iframe path — which is exactly the path a phone or any
    // non-Electron client gets. The native path is covered separately by
    // scripts/browser-smoke.cjs, where the guarantees actually live.
    await js("document.querySelector('#overflow-plus-btn').click(); [...document.querySelectorAll('.overflow-menu-item')].find(b=>b.textContent.includes('Browse the web')).click()");
    await waitFor("!!document.querySelector('.browser-panel')");
    assert.ok(await js("!!document.querySelector('.browser-frame')"), 'web client falls back to an iframe');
    // Always offered, because whether a site refuses framing cannot be
    // detected from JavaScript — the control must not depend on guessing.
    assert.ok(await js("[...document.querySelectorAll('.browser-toolbar .btn')].some(b=>b.textContent==='Open in new tab')"));
    // A bare host becomes https; only http/https are ever accepted.
    await js("{ const f=document.querySelector('.browser-address-form'); f.querySelector('input').value='example.test/docs'; f.requestSubmit(); }");
    await waitFor("document.querySelector('.browser-frame').getAttribute('src')==='https://example.test/docs'");
    assert.equal(await js("document.querySelector('.browser-address').value"), 'https://example.test/docs');
    await js("{ const f=document.querySelector('.browser-address-form'); f.querySelector('input').value='file:///etc/passwd'; f.requestSubmit(); }");
    await waitFor("document.querySelector('.browser-status').textContent.includes('Only web addresses')");
    assert.equal(await js("document.querySelector('.browser-frame').getAttribute('src')"), 'https://example.test/docs', 'a refused address must not navigate the frame');
    // One right-hand pane at a time: in the desktop app the browser's page is
    // a native layer that would paint straight over a file preview.
    await js("document.querySelector('.artifact-card').click()");
    await waitFor("!!document.querySelector('.artifact-panel:not(.browser-panel)')");
    assert.equal(await js("document.querySelectorAll('.browser-panel').length"), 0, 'opening a file preview closes the browser');
    await js("document.querySelector('[aria-label=\"Close file preview\"]').click()");
    await js("document.querySelector('#overflow-plus-btn').click(); [...document.querySelectorAll('.overflow-menu-item')].find(b=>b.textContent.includes('Browse the web')).click()");
    await waitFor("!!document.querySelector('.browser-panel')");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    await waitFor("document.querySelectorAll('.browser-panel').length===0");

    await js("{ const m=document.querySelector('#model-picker-menu'); if (m.classList.contains('hidden')) document.querySelector('#model-picker-btn').click(); }");
    await waitFor("[...document.querySelectorAll('#model-picker-menu button')].some(b=>b.textContent==='Use CLI default')");
    await js("[...document.querySelectorAll('#model-picker-menu button')].find(b=>b.textContent==='Use CLI default').click()");
    await waitFor("(document.querySelector('#model-picker-label').textContent.split(' · ').slice(1).join(' · '))==='CLI default'");
    await waitFor("fetch('/api/sessions/s1').then(r=>r.json()).then(s=>s.model_override==='')");
    assert.equal(chats.s1.model_override, '');
    await js("document.querySelector('.artifact-card').click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-document h1')");
    await capture('desktop-artifact');
    await js("[...document.querySelectorAll('.artifact-tab-panel:not([hidden]) .artifact-toolbar button')].find(b=>b.textContent==='Source').click()");
    // Source view is line-numbered now; read the code text without the numbers.
    assert.ok(await js("[...document.querySelectorAll('.artifact-tab-panel:not([hidden]) .artifact-source .artifact-line')].map(l => l.lastChild.textContent).join('\\n').startsWith('# Project brief')"));
    await js("document.querySelector('[aria-label=\"Close file preview\"]').click(); document.querySelectorAll('.artifact-card')[1].click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-frame')");
    // Same-origin so Select mode can read the static DOM; never scripts.
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-frame').getAttribute('sandbox')"), 'allow-same-origin');
    assert.ok(await js("!document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-frame').srcdoc.includes('<script')"));
    assert.equal(await js("window.__xss || 0"), 0);
    await capture('desktop-html-preview');
    // Card 7 is the macro-enabled .docm — deliberately never previewed, so
    // the download-only fallback still has a real subject now that .docx is
    // a structured preview.
    await js("document.querySelector('[aria-label=\"Close file preview\"]').click(); document.querySelectorAll('.artifact-card')[7].click()");
    await waitFor("!!document.querySelector('.artifact-fallback')");
    assert.ok(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-toolbar a').href.includes('download=true')"));

    // -- Office previews (David's ask 2026-09-15). Every string below comes
    // from the document, so these also confirm content is inserted as text.
    await js("document.querySelector('[aria-label=\"Close file preview\"]').click(); document.querySelectorAll('.artifact-card')[2].click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .office-doc')");
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-doc h1').textContent"), 'Project brief');
    // Reading order: the table sits between the two paragraphs, not after
    // both of them.
    assert.deepEqual(await js("[...document.querySelector('.artifact-tab-panel:not([hidden]) .office-doc').children].map(n=>n.tagName)"), ['H1', 'P', 'DIV', 'P']);
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-grid th').textContent"), 'Area');
    await capture('desktop-office-docx');

    await js("document.querySelector('[aria-label=\"Close file preview\"]').click(); document.querySelectorAll('.artifact-card')[4].click()");
    await waitFor("document.querySelectorAll('.artifact-tab-panel:not([hidden]) .office-tab').length===2");
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-tab.active').textContent"), 'Budget');
    // Sheets carry column letters and row numbers; read cell A1 itself.
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-grid td[data-pick$=\"cell=A1\"]').textContent"), 'Item');
    // A partial view says so rather than implying the file ends here.
    assert.ok(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-note').textContent.includes('900 rows')"));
    await js("[...document.querySelectorAll('.artifact-tab-panel:not([hidden]) .office-tab')].find(t=>t.textContent==='Notes').click()");
    await waitFor("document.querySelector('.artifact-tab-panel:not([hidden]) .office-grid td[data-pick$=\"cell=A1\"]')?.textContent==='second sheet'");
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-tab.active').textContent"), 'Notes');
    await capture('desktop-office-xlsx');

    await js("document.querySelector('[aria-label=\"Close file preview\"]').click(); document.querySelectorAll('.artifact-card')[5].click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .office-slide')");
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-slide [data-pick=\"pptx:slide=1;shape=2\"]').textContent"), 'Quarterly review');
    assert.equal(await js("document.querySelectorAll('.artifact-tab-panel:not([hidden]) .office-slide [data-pick]').length"), 3);
    assert.ok(await js("!!document.querySelector('.artifact-tab-panel:not([hidden]) .office-notes')"), 'speaker notes are available');
    // The fidelity limit is stated in the UI, not left to be discovered.
    assert.ok(await js("[...document.querySelectorAll('.artifact-tab-panel:not([hidden]) .office-note')].some(n=>n.textContent.includes('Approximate layout'))"));
    await js("[...document.querySelectorAll('.artifact-tab-panel:not([hidden]) .artifact-toolbar button')].find(b=>b.getAttribute('aria-label')==='Next slide').click()");
    await waitFor("document.querySelector('.artifact-tab-panel:not([hidden]) .office-slide [data-pick=\"pptx:slide=2;shape=2\"]')?.textContent==='Second slide'");
    assert.ok(await js("!!document.querySelector('.artifact-tab-panel:not([hidden]) .office-slide .office-grid')"), 'slide tables render');
    await capture('desktop-office-pptx');

    await js("document.querySelector('[aria-label=\"Close file preview\"]').click(); document.querySelectorAll('.artifact-card')[6].click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .office-grid')");
    // Parsed server-side precisely so a quoted separator survives (row 1 is the header row, so A2).
    assert.equal(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .office-grid td[data-pick$=\"cell=A2\"]').textContent"), 'Smith, John');
    await js("[...document.querySelectorAll('.artifact-tab-panel:not([hidden]) .artifact-toolbar button')].find(b=>b.textContent==='Source').click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-source')");
    assert.ok(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-source').textContent.includes('\"Smith, John\"')"));
    await js("[...document.querySelectorAll('.artifact-tab-panel:not([hidden]) .artifact-toolbar button')].find(b=>b.textContent==='Table').click()");
    await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .office-grid')");
    await js("import('/static/js/chatContent.js').then(m=>m.openArtifact('s1','/generated-files/012345abcdef_preview.pdf','preview.pdf'))");
    await waitFor("document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-pdf-text')?.textContent.includes('JARVIS preview test')");
    await delay(1000);
    await capture('desktop-pdf-preview');
    await js("import('/static/js/chatContent.js').then(m=>m.openArtifact('s1','/generated-files/012345abcdef_image.png','image.png'))");
    await waitFor("document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-preview .artifact-image-viewport img')?.naturalWidth===1");
    await open('s2');
    assert.equal(await js("document.querySelectorAll('.chat-layout .artifact-viewer').length"), 1, 'Documents persist on a chat switch');
    assert.match(await js("document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-origin').textContent"), /^from /);
    await js("import('/static/js/chatContent.js').then(m => m.closeArtifact())");
    await delay(400);
    assert.ok(await js("document.querySelector('#chat-main').classList.contains('is-empty')"));
    await js("window.originalComposer=document.querySelector('#chat-input')");
    await capture('desktop-new-chat');
    deferFirstChunk = true;
    await js("document.querySelector('#chat-input').value='Build a plan'; document.querySelector('#chat-send').click()");
    await waitFor("document.querySelector('.chat-activity')?.dataset.state==='waiting'");
    await js("document.querySelector('.chat-activity summary').click()");
    assert.equal(await js("document.querySelectorAll('.chat-activity li[data-state=done]').length"), 1);
    // The mascot is the marker while it streams (Kairos Mascot build spec, 2026-10-22).
    // --mascot-off runs the suite with the switch off: the plain marker spins as before.
    assert.equal(await js("document.querySelector('.chat-activity-marker kairos-mascot').getAttribute('state')"), 'thinking');
    if (mascotOff) assert.equal(await js("getComputedStyle(document.querySelector('.chat-activity-marker kairos-mascot')).display + ' ' + getComputedStyle(document.querySelector('.chat-activity-marker')).animationName"), 'none activity-spin');
    else assert.notEqual(await js("getComputedStyle(document.querySelector('.chat-activity-marker kairos-mascot')).display"), 'none');
    await capture('chat-activity-waiting');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
    assert.equal(await js("getComputedStyle(document.querySelector('.chat-activity-marker')).animationName"), 'none');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    pending.res.write('data: ' + JSON.stringify({ chunk: pending.text }) + '\n\n');
    deferFirstChunk = false;
    await waitFor("document.querySelector('.msg-body').textContent==='Build a plan' && document.querySelectorAll('.chat-prose p').length > 20");
    assert.equal(await js("document.querySelector('#model-picker-btn').disabled"), true);
    assert.ok(await js("!document.querySelector('#chat-main').classList.contains('is-empty') && document.querySelector('#chat-input')===window.originalComposer"), 'First turn moves the same composer');
    await delay(400);
    assert.ok(await js("document.querySelector('.chat-input-bar').getBoundingClientRect().bottom > innerHeight-70"), 'Conversation composer docks at bottom');
    await open('s1');
    assert.equal(await js("document.querySelector('#chat-send').dataset.mode!=='stop'"), true);
    await open('s2');
    assert.equal(await js("document.querySelectorAll('.msg.assistant').length"), 1);
    await js("document.querySelector('#chat-messages').scrollTop=0");
    pending.res.write('data: ' + JSON.stringify({ chunk: '\nFinal detail.' }) + '\n\n');
    await delay(150);
    assert.equal(await js("document.querySelector('#chat-messages').scrollTop"), 0);
    assert.equal(await js("document.querySelector('.chat-jump').hidden"), false);
    const finalText = pending.text + '\nFinal detail.';
    chats.s2.messages.push({ role: 'assistant', content: finalText });
    pending.res.end('data: {"done":true}\n\n'); pending = null;
    await waitFor("document.querySelector('#chat-send').dataset.mode!=='stop'");
    assert.equal(await js("document.querySelector('.chat-activity')?.dataset.state"), 'done');
    assert.equal(await js("document.querySelector('.chat-activity-marker kairos-mascot').getAttribute('state')"), 'success', 'success once on completion');
    await js("window.mascotSettled = new Promise(r => document.querySelector('.chat-activity-marker kairos-mascot').addEventListener('mascot-settled', r, { once: true }))");
    await waitFor("document.querySelector('.chat-activity-marker kairos-mascot').getAttribute('state') === 'idle'");
    await open('s2');
    assert.equal(await js("document.querySelectorAll('.msg.assistant').length"), 1, 'Finished retention never duplicates a persisted reply');
    // Truncated SSE must fail, not masquerade as a successful reply.
    await js("document.querySelector('#chat-input').value='Interrupted turn'; document.querySelector('#chat-send').click()");
    await waitFor("document.querySelector('#chat-send').dataset.mode==='stop'");
    while (!pending) await delay(20);
    pending.res.end(); pending = null;
    await waitFor("!!document.querySelector('.msg-interrupted')");
    assert.equal(await js("[...document.querySelectorAll('.chat-activity')].at(-1).dataset.state"), 'failed');
    assert.equal(await js("[...document.querySelectorAll('.chat-activity-marker kairos-mascot')].at(-1).getAttribute('state')"), 'error', 'a failed turn shows the error pose');
    // With the switch off the marker is the glyph again.
    // The switch's contract is the root attribute (appearance.js sets it); set it directly so this page keeps its look.
    await js("document.documentElement.dataset.mascot = 'off'");
    assert.equal(await js("getComputedStyle([...document.querySelectorAll('.chat-activity-marker kairos-mascot')].at(-1)).display"), 'none');
    assert.equal(await js("[...document.querySelectorAll('.chat-activity-glyph')].at(-1).textContent"), '!');
    await capture('chat-activity-mascot-off');
    await js(`document.documentElement.dataset.mascot = '${mascotOff ? 'off' : 'on'}'`);
    assert.equal(await js("document.querySelectorAll('.msg.assistant').length"), 2);

    // -- stopping a running turn (David's ask 2026-09-15, the foundation the
    // voice work needs for barge-in). Before this there was no cancellation
    // at all: chatStream.js notes the request "was never actually cancelled",
    // so a long or wrong reply had to be waited out.
    await js("document.querySelector('#chat-input').value='Stop this one'; document.querySelector('#chat-send').click()");
    await waitFor("document.querySelector('#chat-send').dataset.mode==='stop'");
    while (!pending) await delay(20);
    pending.res.write('data: ' + JSON.stringify({ chunk: 'Partial answer before the stop.' }) + '\n\n');
    await waitFor("document.querySelector('#chat-messages').textContent.includes('Partial answer before the stop')");
    await js("document.querySelector('#chat-send').click()");
    await waitFor("!!document.querySelector('.msg-stopped')");
    // A stop is not a failure: no error styling and no error toast.
    // Scoped to the message that was stopped: an earlier check in this suite
    // deliberately produces a genuinely failed message, so a document-wide
    // count would fail for the wrong reason.
    assert.equal(await js("[...document.querySelectorAll('.msg.assistant')].at(-1).classList.contains('msg-failed')"), false, 'Stopping must not render as a failure');
    assert.equal(await js("[...document.querySelectorAll('.chat-activity')].at(-1).dataset.state"), 'stopped');
    // Whatever had streamed stays on screen, because the backend saved it.
    assert.ok(await js("document.querySelector('#chat-messages').textContent.includes('Partial answer before the stop')"), 'Partial reply survives the stop');
    // The button returns to send, so the chat is immediately usable again.
    await waitFor("document.querySelector('#chat-send').dataset.mode==='send'");
    try { pending.res.end(); } catch (e) {}
    pending = null;

    // -- a slow provider and a quiet feed (A04, 2026-10-28). services/chat_live.py
    // stamps waitingSince and the provider, and heartbeats every 10 s; the chip
    // tells "the model is slow" apart from "the app lost contact", and Stop still works.
    deferFirstChunk = true;  // the notice is only for a reply with no text yet
    await js("document.querySelector('#chat-input').value='Think slowly'; document.querySelector('#chat-send').click()");
    await waitFor("document.querySelector('#chat-send').dataset.mode==='stop'");
    while (!pending) await delay(20);
    deferFirstChunk = false;
    const slow = liveRuns[pending.sid];
    const changes = { provider: 'Ollama local-model', waitingSince: Date.now() / 1000 - 70, providerDetail: 'Loading the model into memory' };
    Object.assign(slow, changes); slow.revision++;
    liveBroadcast({ type: 'update', sessionId: pending.sid, turnId: slow.turnId, revision: slow.revision, changes });
    const chip = "[...document.querySelectorAll('.chat-activity')].at(-1)";
    await waitFor(`${chip}.querySelector('.chat-activity-label').textContent.startsWith('Still waiting on Ollama local-model · 1m 1')`);
    assert.equal(await js(`${chip}.dataset.state`), 'waiting', 'A slow provider is still a wait, not a failure');
    assert.equal(await js(`(n => !n.hidden && n.textContent)(${chip}.querySelector('.chat-activity-detail'))`), 'Loading the model into memory');
    const firstLabel = await js(`${chip}.querySelector('.chat-activity-label').textContent`);
    // An offscreen window may throttle the chip's 1 s timer, so allow a few ticks.
    let ticked = false;
    for (let i = 0; i < 50 && !ticked; i++) { await delay(100); ticked = await js(`${chip}.querySelector('.chat-activity-label').textContent`) !== firstLabel; }
    assert.ok(ticked, 'The wait clock counts up on its own');
    await capture('chat-activity-provider-wait');
    // No packet for over 30 s: shift the renderer clock instead of waiting it out.
    await js('window.__realNow = Date.now; Date.now = () => window.__realNow() + 31000; 0');
    await waitFor(`${chip}.dataset.state === 'disconnected'`);
    assert.equal(await js(`${chip}.querySelector('.chat-activity-label').textContent`), 'Lost contact with Kairos');
    assert.equal(await js(`${chip}.querySelector('.chat-activity-glyph').textContent`), '!');
    assert.equal(await js("document.querySelector('#chat-send').dataset.mode"), 'stop', 'Stop stays available out of contact');
    await capture('chat-activity-lost-contact');
    liveBroadcast({ type: 'heartbeat' });
    await waitFor(`${chip}.dataset.state === 'waiting'`);
    assert.ok(await js(`${chip}.querySelector('.chat-activity-label').textContent.startsWith('Still waiting on Ollama local-model · 1m 4')`), 'A heartbeat restores the wait notice');
    await js('Date.now = window.__realNow; 0');
    await js("document.querySelector('#chat-send').click()");
    await waitFor(`${chip}.dataset.state === 'stopped'`);
    assert.equal(await js(`${chip}.querySelector('.chat-activity-label').textContent`), 'Stopped');
    assert.equal(await js(`${chip}.querySelector('.chat-activity-detail').hidden`), true, 'The provider detail clears once the turn ends');
    await waitFor("document.querySelector('#chat-send').dataset.mode==='send'");
    try { pending.res.end(); } catch (e) {}
    pending = null;


    // -- dictation (David's ask 2026-09-15). The no-model path is checked
    // because it needs no microphone: the button verifies a model exists
    // BEFORE opening the mic, so the failure arrives before recording rather
    // than after a user has already spoken into it.
    assert.ok(await js("!document.querySelector('#chat-mic').hidden"), 'Mic button shows where recording is supported');
    await js("document.querySelector('#chat-mic').click()");
    await waitFor("[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('No speech model'))");
    // Nothing should be recording after that refusal.
    assert.ok(await js("!document.querySelector('#chat-mic').classList.contains('recording')"), 'A refused start leaves the mic idle');
    await js("document.querySelectorAll('.toast').forEach(t=>t.remove())");
    // With the engine missing entirely the message is different, because a
    // broken build and a missing download are not the same problem.
    speechStatus = { engine_available: false, active_model: null, models: [] };
    await js("import('/static/js/voiceInput.js').then(m=>m.refreshSpeechStatus())");
    await js("document.querySelector('#chat-mic').click()");
    await waitFor("[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('not available in this build'))");
    await js("document.querySelectorAll('.toast').forEach(t=>t.remove())");
    speechStatus = { engine_available: true, active_model: null, models: [] };
    await js("import('/static/js/voiceInput.js').then(m=>m.refreshSpeechStatus())");


    // -- Open Mic (David's ask 2026-09-15). Driven through the no-model
    // refusal, which needs no microphone: the toggle checks a model exists
    // before opening the device, same as the dictation button.
    assert.ok(await js("!document.querySelector('#chat-openmic').hidden"), 'Open Mic button shows where recording is supported');
    speechStatus = { engine_available: true, active_model: null, models: [] };
    await js("import('/static/js/voiceInput.js').then(m=>m.refreshSpeechStatus())");
    await js("document.querySelector('#chat-openmic').click()");
    await waitFor("[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('No speech model'))");
    assert.ok(await js("!document.querySelector('#chat-openmic').classList.contains('active')"), 'A refused start does not enter Open Mic');
    // Starting Open Mic on an empty chat creates the session first, which is
    // how a chat begins as an Open Mic session. Asserted by the refusal
    // reaching the model check at all: with no session it would have stopped
    // earlier with a different message.
    assert.ok(await js("!!document.querySelector('#chat-openmic')"), 'Open Mic is reachable from a new chat');
    assert.ok(await js("!document.querySelector('#chat-main').classList.contains('open-mic')"));
    await js("document.querySelectorAll('.toast').forEach(t=>t.remove())");
    // Sentence chunking is the part with real behaviour, and driving it
    // through live speech synthesis would be slow and machine-dependent.
    assert.deepEqual(
      await js("import('/static/js/voiceOutput.js').then(m=>m._chunk('First one. Second one. Third one. Fourth one.'))"),
      ['First one.', 'Second one.', 'Third one.', 'Fourth one.'],
      'Every completed sentence is released at once',
    );
    // A trailing sentence with no terminal punctuation must still be spoken;
    // that is the case voice-line's chunker exists for.
    assert.deepEqual(
      await js("import('/static/js/voiceOutput.js').then(m=>m._chunk('Hello there. And then this trails off'))"),
      ['Hello there.', 'And then this trails off'],
    );
    // Markdown is written to be read, not heard.
    assert.equal(
      await js("import('/static/js/voiceOutput.js').then(m=>m._forSpeech(['## Title','','**bold** and `code` and [a link](http://x.test)','- item'].join(String.fromCharCode(10))))"),
      'Title. bold and code and a link. item.',
    );

    // Open Mic's loop, driven end to end with a fake microphone and a fake
    // voice. This exists because barge-in shipped completely dead: the
    // microphone was closed while the assistant spoke, so no level ever
    // reached the handler and the interrupt branch could not run. Nothing
    // caught it, because openMic.js hard-imported the recorder and no suite
    // could drive the machine without real hardware. It is injectable now, so
    // this test drives the actual state machine rather than a copy of it.
    await js(`(async () => {
      window.__bargeLog = [];
      const m = await import('/static/js/openMic.js');
      // A real, decodable WAV: the transcription path runs WebAudio for real
      // rather than being stubbed out, so a regression there fails here too.
      const wav = (seconds) => {
        const rate = 16000, n = Math.floor(rate * seconds);
        const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        w(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true);
        return new Blob([buf], { type: 'audio/wav' });
      };
      window.__counts = { captured: 0, stopped: 0, closed: 0, cancelledSpeech: 0, speakerResets: 0 };
      const fakeMic = () => ({
        async start() {},
        capture() { window.__counts.captured++; },
        async stop() { window.__counts.stopped++; return wav(0.5); },
        close() { window.__counts.closed++; },
        cancel() { window.__counts.closed++; },
      });
      window.__spoken = [];
      // Mirrors the real speaker's latch: once cancelled it stays silent until
      // reset. That is the behaviour that made the app go quiet after the
      // first interruption, so the fake has to reproduce it or the test would
      // pass against the bug.
      let speakerCancelled = false;
      const fakeSpeaker = () => ({
        feed(text) { if (!speakerCancelled) window.__spoken.push(text); },
        finish() {},
        reset() { speakerCancelled = false; window.__counts.speakerResets++; },
        cancel() { speakerCancelled = true; window.__counts.cancelledSpeech++; },
      });
      window.__mic = m.createOpenMic({
        sessionId: 's1',
        // Never resolves, so the turn is still in flight when the interrupt
        // arrives - which is the only state barge-in is about.
        sendMessage: (text, handlers) => {
          window.__bargeLog.push('sent:' + text);
          // Streams one chunk so the speaker is exercised, then never settles:
          // the turn has to still be in flight when the interruption arrives.
          handlers.onChunk('a reply sentence.');
          return new Promise(() => {});
        },
        stopTurn: () => { window.__bargeLog.push('stopTurn'); },
        onState: (s) => window.__bargeLog.push('state:' + s),
        createMic: fakeMic,
        makeSpeaker: fakeSpeaker,
      });
      await window.__mic.start();
      return true;
    })()`);
    assert.equal(await js("window.__mic.state"), 'listening', 'Open Mic starts listening');
    assert.equal(await js("window.__counts.captured"), 0, 'An open microphone is not recording yet');

    await js("window.__mic._level(0.5)");
    assert.equal(await js("window.__counts.captured"), 1, 'Recording starts when speech does, not when the device opens');
    await delay(420);
    await js("window.__mic._level(0.5)");
    await delay(950);
    await js("window.__mic._level(0.01)");
    await waitFor("window.__mic.state==='thinking'");
    assert.ok(await js("window.__bargeLog.includes('sent:what is the weather')"), 'The transcript is sent as an ordinary turn');
    assert.equal(await js("window.__counts.stopped"), 1, 'The utterance ended without closing the device');
    assert.equal(await js("window.__counts.closed"), 0, 'The microphone stays open through the reply');

    assert.deepEqual(await js("window.__spoken"), ['a reply sentence.'], 'The reply is spoken');

    // An isolated peak must not interrupt: the microphone hears the assistant
    // through the speakers, and one syllable of its own voice coming back
    // would make it talk over itself.
    await js("window.__mic._level(0.5)");
    await js("window.__mic._level(0.01)");
    await js("window.__mic._level(0.01)");
    await js("window.__mic._level(0.01)");
    assert.ok(!(await js("window.__bargeLog.includes('stopTurn')")), 'An isolated peak does not interrupt');

    // Real speech read through a level meter is a BROKEN run of loud readings,
    // not an unbroken one - it dips between syllables. Requiring consecutive
    // frames is what made interrupting do nothing while David talked over it
    // for seconds, so the pattern below is deliberately gappy.
    await js("window.__mic._level(0.5)");
    await js("window.__mic._level(0.05)");
    await js("window.__mic._level(0.5)");
    assert.ok(!(await js("window.__bargeLog.includes('stopTurn')")), 'Two loud readings are still not enough');
    await js("window.__mic._level(0.5)");
    assert.ok(await js("window.__bargeLog.includes('stopTurn')"), 'Speech with normal gaps cuts the assistant off');
    assert.equal(await js("window.__counts.cancelledSpeech"), 1, 'Barge-in silences the voice as well as the turn');
    assert.equal(await js("window.__counts.captured"), 2, 'The interruption is recorded as the next utterance');

    // The turn AFTER an interruption must still be audible. The speaker's
    // cancel latch was never cleared, so the first barge-in silenced the rest
    // of the session: text kept appearing, nothing was ever spoken again.
    await delay(420);
    await js("window.__mic._level(0.5)");
    await delay(950);
    await js("window.__mic._level(0.01)");
    await waitFor("window.__counts.speakerResets>0");
    await waitFor("window.__spoken.length>1");
    assert.deepEqual(await js("window.__spoken"), ['a reply sentence.', 'a reply sentence.'],
      'A reply after an interruption is still spoken aloud');
    await js("window.__mic.stop(); window.__mic=null;");

    // Inject dangerous content through the real renderer, not a stub parser.
    const attack = '<img src="https://example.test/track" onerror="window.__xss=1"><iframe src="/api/settings"></iframe><script>window.__xss=1</script><p class="artifact-panel">safe</p>[bad](javascript:alert(1))';
    await js(`import('/static/js/chatContent.js').then(m => { const node=document.createElement('div'); node.id='security-test'; document.body.append(node); m.renderMessageBody(node, ${JSON.stringify(attack)}, 's1'); })`);
    assert.equal(await js("document.querySelectorAll('#security-test img, #security-test iframe, #security-test script, #security-test .artifact-panel, #security-test a').length"), 0);
    await js("document.querySelector('#security-test').remove()");
    // Set here rather than earlier because the "Use CLI default" step above
    // legitimately clears it (a model change invalidates the reading). The
    // composer-overflow assertion below is only meaningful with the meter
    // actually present in the row.
    chats.s1.context_state = { used_tokens: 45000, capacity_tokens: 90000, percent: 50, estimated_capacity: false, capacity_source: 'cli_cache', model: 'catalog-astra' };
    for (const width of [390, 320]) {
      win.setContentSize(width, 844); await open('s1'); await delay(100);
      await waitFor("!document.querySelector('#context-pill').hidden");
      assert.ok(await js("document.querySelector('.chat-input-bar').scrollWidth <= document.querySelector('.chat-input-bar').clientWidth+2"), 'Composer fits mobile ' + width);
      // On a phone the pill opens chat details as a full sheet, inside the screen.
      chats.s1.usage = { session_id: 's1', source: 'runs', turns: 1, runs: 1, reported_runs: 1, input_tokens: 900, output_tokens: 90,
        cache_read_tokens: null, cache_write_tokens: null, cache_hit_percent: null, tool_calls: 0, compactions: 0, helper_runs: 0,
        last_reply: null, model: { model: 'catalog-astra', provider: 'Claude', context_window: 90000 } };
      await js("document.querySelector('#context-pill').click()");
      await waitFor("!!document.querySelector('#usage-meter.is-sheet .usage-meter-rows')");
      // Anchored to the screen's edges, full width, and no taller than the screen. (This test page itself scrolls
      // sideways at phone width, so its measured bottom sits a few pixels past clientHeight; the CSS anchor is what
      // a phone uses.)
      const sheet = await js("(() => { const m=document.querySelector('#usage-meter'), s=getComputedStyle(m), r=m.getBoundingClientRect(); return { position: s.position, left: s.left, right: s.right, bottom: s.bottom, top: r.top, height: r.height, w: r.width, vw: document.documentElement.clientWidth, vh: innerHeight }; })()");
      assert.ok(sheet.position === 'fixed' && sheet.left === '0px' && sheet.right === '0px' && sheet.bottom === '0px' && sheet.top >= 0
        && sheet.height <= sheet.vh && Math.abs(sheet.w - sheet.vw) <= 1, 'sheet fits mobile ' + width + ': ' + JSON.stringify(sheet));
      await capture('mobile-chat-details-' + width);
      await js("document.querySelector('#usage-meter .usage-meter-close').click()");
      await waitFor("!document.querySelector('#usage-meter')");
      delete chats.s1.usage;
      await js("document.querySelector('#chat-messages').scrollTop=0");
      await capture('mobile-chat-' + width);
      await js("document.querySelector('.artifact-card').click()");
      await waitFor("!!document.querySelector('.artifact-tab-panel:not([hidden]) .artifact-document')");
      await delay(250); // let the deliberate slide-in animation settle
      assert.ok(await js("document.querySelector('.artifact-panel').getBoundingClientRect().right <= innerWidth+1"));
      await capture('mobile-artifact-' + width);
      await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
      assert.equal(await js("document.querySelectorAll('.artifact-panel').length"), 0);
    }
    // A fresh landing retains its draft/files through model selection and
    // first-send creation. No live uploads or providers are contacted.
    win.setContentSize(1440, 900);
    await js("(() => { document.querySelector('.chat-phone-tools > button').click(); [...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].find(b => b.textContent.trim() === 'New chat').click(); })()");
    await waitFor("document.querySelector('#model-picker-label').textContent==='Choose model'");
    const stageDraft = async () => {
      await js("{ document.querySelector('#chat-input').value='Keep this draft'; const transfer=new DataTransfer(); transfer.items.add(new File(['draft content'],'draft.txt',{type:'text/plain'})); const fileInput=document.querySelector('input[type=file]'); fileInput.files=transfer.files; fileInput.dispatchEvent(new Event('change')); }");
      await waitFor("document.querySelector('.attach-chip')?.textContent.includes('draft.txt')");
    };
    await stageDraft();
    await js("document.querySelector('#model-picker-btn').click(); document.querySelector('#model-picker-menu button').click()");
    await waitFor("document.querySelector('#model-picker-label').textContent.startsWith('Claude Code')");
    assert.ok(await js("document.querySelector('.attach-chip')?.textContent.includes('draft.txt') && document.querySelector('#chat-input').value==='Keep this draft'"));
    // This isolated chat harness omits the app shell. Exercise the phone sheet
    // with the production theme and stylesheet order rather than a native dialog.
    const sheetStyles = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8').match(/<link rel="stylesheet"[^>]+>/g).join('');
    await js(`Promise.all([...new DOMParser().parseFromString(${JSON.stringify(sheetStyles)}, 'text/html').querySelectorAll('link')].map(link => new Promise(resolve => { link.dataset.sheetTest = ''; link.onload = resolve; document.head.append(link); }))).then(() => document.documentElement.classList.add('kairos-redesign'))`);
    win.setContentSize(320, 420);
    await delay(400);
    // Choosing a connection leaves the menu open (2026-10-14); close it so this
    // measures a menu opened at the phone size, not one placed for the desktop.
    await js("document.querySelector('#model-picker-menu').classList.add('hidden'); document.querySelector('#model-picker-btn').click()");
    await waitFor("!!document.querySelector('.ms-model-sheet[open] #model-picker-menu')");
    await js("Promise.all(document.querySelector('.ms-model-sheet[open]').getAnimations().map(a => a.finished))");
    // Phone models live in a bottom sheet. The list may exceed its scrolling body,
    // but the sheet must fit and every visible control must be reachable inside it.
    assert.ok(await js(`(() => {
      const sheet=document.querySelector('.ms-model-sheet[open]'), r=sheet.getBoundingClientRect();
      const menu=sheet.querySelector('#model-picker-menu').getBoundingClientRect();
      const safe=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-safe-top')) || 0;
      return r.height>44 && r.height<=innerHeight*.9+1 && r.top>=safe && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight
        && menu.width>0 && menu.left>=0 && menu.right<=innerWidth;
    })()`), 'Model sheet fits short mobile viewport below the status area');
    await capture('short-phone-model-sheet');
    assert.deepEqual(await js(`(() => {
      const sheet=document.querySelector('.ms-model-sheet[open]'), body=sheet.querySelector('.ms-sheet-body');
      const header=sheet.querySelector('.ms-sheet-header'), headerTop=header.getBoundingClientRect().top;
      const failures=[];
      for (const expanded of [false, true]) {
        if (expanded) for (const details of body.querySelectorAll('details')) {
          if (!details.open) details.querySelector(':scope > summary').click();
        }
        const controls=[...body.querySelectorAll('button, summary, input[type=search]')].filter(n=>{
          // Closed details can retain layout boxes in Chromium. Their descendants
          // become targets only after the summary is opened, checked on pass two.
          for (let p=n.parentElement; p && p!==body; p=p.parentElement) {
            if (p.matches('details:not([open])') && n!==p.querySelector(':scope > summary')) return false;
          }
          return n.getClientRects().length && getComputedStyle(n).visibility!=='hidden';
        });
        if (!controls.length) failures.push('No model controls');
        for (const n of controls) {
          n.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
          const r=n.getBoundingClientRect(), b=body.getBoundingClientRect();
          if (r.top<b.top-1 || r.bottom>b.bottom+1 || Math.abs(header.getBoundingClientRect().top-headerTop)>1
            || sheet.scrollTop!==0 || !n.contains(document.elementFromPoint(r.left+r.width/2, r.top+r.height/2)))
            failures.push({control:n.textContent.trim() || n.getAttribute('aria-label'), expanded, rect:r.toJSON(), body:b.toJSON(), hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML});
        }
      }
      return failures;
    })()`), [], 'Every model sheet control can be scrolled into view and hit on a short phone');
    win.setContentSize(1440, 900);
    await js("document.querySelectorAll('link[data-sheet-test]').forEach(n=>n.remove()); document.documentElement.classList.remove('kairos-redesign'); document.body.click()");
    await js("(() => { document.querySelector('.chat-phone-tools > button').click(); [...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].find(b => b.textContent.trim() === 'New chat').click(); })()");
    await waitFor("document.querySelector('#model-picker-label').textContent==='Choose model'");
    await stageDraft();
    await js("document.querySelector('#chat-send').click()");
    await waitFor("document.querySelectorAll('.chat-prose p').length > 20");
    assert.deepEqual(requests.filter(r=>r.path==='/api/chat/live').at(-1).data.attachment_ids, ['staged-test']);
    assert.equal(requests.filter(r=>r.path==='/api/chat/live').at(-1).data.message, 'Keep this draft');
    // A tool asks for something it has not been granted, mid-reply. The prompt
    // must appear in the chat that asked, show the request as text, and refuse
    // by default if it is dismissed.
    pending.res.write('data: ' + JSON.stringify({ permission: {
      id: 'req-1', tool: 'Bash', target: 'npm test',
      title: 'Run a command', description: 'npm test -- --watch',
      arguments: '{"command": "npm test -- --watch <img src=x onerror=alert(1)>"}',
      choices: [
        { id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' },
        { id: 'session', label: 'Always in this chat (npm test)', behavior: 'allow', scope: 'session' },
        { id: 'forever', label: 'Always allow npm test', behavior: 'allow', scope: 'forever' },
        { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' },
      ] } }) + '\r\n\r\n');
    await waitFor("!!document.querySelector('.permission-dialog[open]')");
    assert.equal(await js("document.querySelector('.permission-target').textContent"), 'npm test', 'The prompt states what a grant would cover');
    assert.equal(await js("document.querySelectorAll('.permission-dialog img').length"), 0, 'A request is shown as text, never as markup');
    assert.equal(await js("document.querySelectorAll('.permission-choices button').length"), 4);
    await js("document.querySelector('.permission-choices [data-choice=once]').click()");
    await waitFor("!document.querySelector('.permission-dialog')");
    assert.deepEqual(answers.map(a => a.choice), ['once'], 'The answer reaches the server');

    // Dismissing without choosing refuses rather than hanging.
    pending.res.write('data: ' + JSON.stringify({ permission: {
      id: 'req-2', tool: 'Bash', target: 'rm -rf', title: 'Run a command', description: '',
      arguments: '{"command": "rm -rf /"}',
      choices: [
        { id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' },
        { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' },
      ] } }) + '\r\n\r\n');
    await waitFor("!!document.querySelector('.permission-dialog[open]')");
    await js("document.querySelector('.permission-dialog').close()");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(answers.map(a => a.choice), ['once', 'reject'], 'Closing the prompt refuses');

    pending.res.end('data: {"done":true}\n\n'); pending = null;
    await waitFor("document.querySelector('#chat-send').dataset.mode!=='stop'");

    // -- message queue (2026-09-25): Enter mid-reply queues; a finished reply
    // sends the next; a Stop pauses the queue until it is resumed.
    const streams = () => requests.filter(r => r.path === '/api/chat/live');
    const enter = (text) => js(`(() => { const i = document.querySelector('#chat-input'); i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await enter('First in line');
    await waitFor("document.querySelector('#chat-send').dataset.mode==='stop'");
    while (!pending) await delay(20);
    const sentBefore = streams().length;
    await enter('Queued follow-up');
    await enter('Changed my mind');
    assert.equal(await js("document.querySelectorAll('.chat-queue-item').length"), 2, 'Enter mid-reply queues instead of doing nothing');
    assert.equal(await js("document.querySelector('#chat-input').value"), '', 'A queued message leaves the box');
    await js("document.querySelectorAll('.chat-queue-remove')[1].click()");
    assert.equal(await js("document.querySelectorAll('.chat-queue-item').length"), 1);
    assert.equal(streams().length, sentBefore, 'Nothing is sent while the reply runs');
    await capture('chat-queue');
    pending.res.end('data: {"done":true}\n\n'); pending = null;
    for (let i = 0; i < 100 && streams().length === sentBefore; i++) await delay(40);
    assert.equal(streams().at(-1).data.message, 'Queued follow-up', 'A finished reply sends the next queued message');
    assert.equal(await js("document.querySelector('.chat-queue').hidden"), true);
    while (!pending) await delay(20);
    await enter('Waits after a stop');
    const sentAtStop = streams().length;
    await js("document.querySelector('#chat-send').click()");
    await waitFor("!!document.querySelector('.chat-queue-resume')");
    await delay(200);
    assert.equal(streams().length, sentAtStop, 'A stopped reply pauses the queue');
    pending.res.end(); pending = null;
    await js("document.querySelector('.chat-queue-resume').click()");
    for (let i = 0; i < 100 && streams().length === sentAtStop; i++) await delay(40);
    assert.equal(streams().at(-1).data.message, 'Waits after a stop', 'Resume sends it');
    while (!pending) await delay(20);
    pending.res.end('data: {"done":true}\n\n'); pending = null;
    await waitFor("document.querySelector('#chat-send').dataset.mode!=='stop'");

    // -- edit and regenerate (2026-09-25): both cut the chat back on the
    // server, then Regenerate re-sends and Edit returns the text to the box.
    chats.rw = { id: 'rw', title: 'Rewind', model_endpoint_id: 'claude', messages: [
      { role: 'user', content: 'Question one', ts: 1 }, { role: 'assistant', content: 'Answer one', ts: 2 },
      { role: 'user', content: 'Question two', ts: 3 }, { role: 'assistant', content: 'Answer two', ts: 4 }] };
    await open('rw');
    await waitFor("document.querySelectorAll('#chat-messages > .msg').length === 4");
    assert.equal(await js("document.querySelectorAll('.msg-regenerate').length"), 1, 'Regenerate only on the last reply');
    assert.equal(await js("document.querySelectorAll('.msg-edit').length"), 2, 'Edit on each of my messages');
    assert.ok(await js("[...document.querySelectorAll('#chat-messages > .msg')].at(-1).querySelector('.msg-regenerate') !== null"));
    const sentBeforeRegen = streams().length;
    await js("document.querySelector('.msg-regenerate').click()");
    for (let i = 0; i < 100 && streams().length === sentBeforeRegen; i++) await delay(40);
    assert.deepEqual(requests.filter(r => r.path === '/api/sessions/rw/rewind').at(-1).data, { keep: 2 }, 'the old reply and its question are cut');
    assert.equal(streams().at(-1).data.message, 'Question two', 'the same question goes again');
    while (!pending) await delay(20);
    chats.rw.messages.push({ role: 'assistant', content: 'A better answer two', ts: 5 });
    pending.res.end('data: {"done":true}\n\n'); pending = null;
    await waitFor("document.querySelector('#chat-send').dataset.mode!=='stop'");
    await waitFor("[...document.querySelectorAll('#chat-messages > .msg')].at(-1)?.querySelector('.msg-regenerate') !== null");
    // Editing the first question would drop three later messages: it asks first.
    await js("document.querySelectorAll('.msg-edit')[0].click()");
    await waitFor("!!document.querySelector('.modal-backdrop:not(.hidden) .btn, .confirm-dialog button')");
    await capture('chat-edit-confirm');
    await js("[...document.querySelectorAll('.modal-backdrop:not(.hidden) button, .confirm-dialog button')].find(b => /Edit message/.test(b.textContent)).click()");
    await waitFor("document.querySelector('#chat-input').value === 'Question one'");
    assert.deepEqual(requests.filter(r => r.path === '/api/sessions/rw/rewind').at(-1).data, { keep: 0 });
    assert.equal(await js("document.querySelectorAll('#chat-messages > .msg').length"), 0, 'everything from the edited message on is gone');
    await js("document.querySelector('#chat-input').value = ''");
    // The now-empty chat moves its composer to the centre; let that finish so
    // the reduced-motion check below measures only what it starts itself.
    await waitFor("document.querySelector('.chat-composer-dock').getAnimations().every(a => a.playState !== 'running')");

    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await waitFor("matchMedia('(prefers-reduced-motion: reduce)').matches");
    await js("(() => { document.querySelector('.chat-phone-tools > button').click(); [...document.querySelectorAll('.chat-phone-tools .overflow-menu-item')].find(b => b.textContent.trim() === 'New chat').click(); })()");
    // Chromium can report an inherited scrollbar-color transition here;
    // only a transform animation represents composer movement.
    const runningAnimations = await js("document.querySelector('.chat-composer-dock').getAnimations().filter(a=>a.playState==='running' && a.effect.getKeyframes().some(frame=>'transform' in frame)).map(a=>a.effect.getKeyframes())");
    assert.deepEqual(runningAnimations, [], 'Reduced motion skips composer animation: ' + JSON.stringify(runningAnimations));
    // @ chooses a structured reference before Enter can send, then carries
    // the ID through the same stream request as an ordinary message.
    const beforeReference = streams().length;
    await js("{ const i=document.querySelector('#chat-input'); i.value='Summarize @active'; i.setSelectionRange(i.value.length,i.value.length); i.dispatchEvent(new Event('input')); }");
    await waitFor("document.querySelectorAll('.chat-reference-option').length===3");
    await js("{ const i=document.querySelector('#chat-input'); i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); }");
    assert.equal(streams().length, beforeReference, 'Picker Enter selects a reference without sending');
    assert.ok(await js("document.querySelector('.chat-reference-chip')?.textContent.includes('Active Priorities')"));
    assert.equal(await js("document.querySelector('#chat-input').value"), 'Summarize ');
    await js("document.querySelector('#chat-send').click()");
    for (let i = 0; i < 100 && streams().length === beforeReference; i++) await delay(40);
    assert.deepEqual(streams().at(-1).data.references.map(ref => [ref.kind, ref.id]), [['note', 'Active Priorities.md']]);
    assert.ok(streams().at(-1).data.message.includes('@note: Active Priorities'));
    while (!pending) await delay(20);
    pending.res.end('data: {"done":true}\n\n'); pending = null;
    await waitFor("document.querySelector('#chat-send').dataset.mode!=='stop'");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks: ['Mode dropdown opens and selects Auto with real mouse events', 'centered landing and same-composer transition', 'first-message attachments and model-selection draft retention', 'reduced motion', 'rich Markdown and highlighting', 'model dispatch controls and reload persistence', 'artifact previews and Office fallback', 'isolated HTML and XSS filtering', 'session reattachment without duplicates', 'scroll position preservation', 'explicit stream completion', '320/390px mobile layouts'], requests, errors }, null, 2));
    console.log('PASS ' + output);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack, errors }, null, 2));
    await capture('failure'); console.error(error); process.exitCode = 1;
  } finally { win.destroy(); server.close(); exitAfterFlush(process.exitCode); }
});
