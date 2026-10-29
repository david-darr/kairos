// Widgets and apps without a DOM (Phase 6 unit U2): plain-Node checks of static/js/botsWidgetModel.js,
// botsAppBridge.js, botsAppFrame.js (pool and cache), botsPoint.js and botsRichRows.js.
// Run: node scripts/test_bots_widget_schema.cjs
//   - every card below is judged by the browser's checker AND by services/bot_widgets.py (run through the
//     project's Python), and the two must agree on accept or refuse, so a card is never half-valid
//   - compact layout under 400 px, a press body from a form, the folded line, plain refusal text
//   - bridge rate limits, message size, head injection (the policy goes first), theme values, link checks
//   - the frame pool (3 live, least recently used folds), the 60 s page cache, frame height rules
//   - Point chips (5 at most, labels cut to 40) and the rich-row door
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'static', 'js');
const load = file => import(pathToFileURL(path.join(dir, file)).href);
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

const text = n => 'x'.repeat(n);
const card = (children, extra = {}) => ({ type: 'card', title: 'T', children, ...extra });
const field = (type, over = {}) => ({ type, id: 'f', label: 'Field', ...over });
const nest = depth => { let node = { type: 'Text', text: 'leaf' }; for (let i = 0; i < depth; i++) node = { type: 'Box', children: [node] }; return card([node]); };
const flat = (n, make = () => ({ type: 'Divider' })) => card(Array.from({ length: n }, make));

// ok: true means both sides accept; false means both refuse. `why` is a word both messages hold when they refuse.
const CASES = [
  ['a plain card', card([{ type: 'Text', text: 'hi' }]), true],
  ['a list', { type: 'list', title: 'L', items: [{ title: 'a', ref: 'a' }, { title: 'b' }] }, true],
  ['no type means card', { title: 'T' }, true],
  ['not an object', 'text', false, 'object'],
  ['unknown widget type', { type: 'banner', title: 'x' }, false, 'card or a list'],
  ['empty card', { type: 'card' }, false, 'title or some content'],
  ['size 120 title ok', { type: 'card', title: text(120) }, true],
  ['title 121', { type: 'card', title: text(121) }, false, '120'],
  ['caption 241', { type: 'card', title: 't', caption: text(241) }, false, '240'],
  ['meta 81', { type: 'card', title: 't', meta: text(81) }, false, '80'],
  ['bad size', card([], { size: 'huge' }), false, 'size'],
  ['byte limit', card(Array.from({ length: 20 }, () => ({ type: 'Text', text: text(1900) }))), false, '32,000'],
  ['250 nodes ok', flat(250), true],
  ['251 nodes', flat(251), false, '250'],
  ['depth 10 ok', nest(9), true],
  ['depth 11', nest(11), false, 'deeply'],
  ['20 fields ok', card(Array.from({ length: 20 }, (_, i) => field('Input', { id: `f${i}` }))), true],
  ['21 fields', card(Array.from({ length: 21 }, (_, i) => field('Input', { id: `f${i}` }))), false, '20 fields'],
  ['40 list items ok', { type: 'list', items: Array.from({ length: 40 }, (_, i) => ({ title: `i${i}` })) }, true],
  ['41 list items', { type: 'list', items: Array.from({ length: 41 }, (_, i) => ({ title: `i${i}` })) }, false, '40'],
  ['empty list', { type: 'list', items: [] }, false, 'items'],
  ['6 images ok', flat(6, () => ({ type: 'Image', url: 'https://example.test/a.png' })), true],
  ['7 images', flat(7, () => ({ type: 'Image', url: 'https://example.test/a.png' })), false, 'images'],
  ['http image', card([{ type: 'Image', url: 'http://example.test/a.png' }]), false, 'https'],
  ['javascript image', card([{ type: 'Image', url: 'javascript:alert(1)' }]), false, 'https'],
  ['data image', card([{ type: 'Image', url: 'data:image/png;base64,AAAA' }]), false, 'https'],
  ['password input type', card([field('Input', { input_type: 'password' })]), false, 'password'],
  ['password kind', card([field('Input', { kind: 'password' })]), false, 'password'],
  ['password label', card([field('Input', { label: 'Your password' })]), false, 'password'],
  ['password id', card([field('Input', { id: 'password' })]), false, 'password'],
  ['secret placeholder', card([field('Textarea', { placeholder: 'paste your API key' })]), false, 'password'],
  ['number input ok', card([field('Input', { input_type: 'number' })]), true],
  ['unknown part', card([{ type: 'Script', text: 'x' }]), false, 'unknown'],
  ['unknown icon', card([{ type: 'Icon', name: 'skull-and-crossbones' }]), false, 'icon'],
  ['known icon', card([{ type: 'Icon', name: 'check' }]), true],
  ['bad badge tone', card([{ type: 'Badge', text: 'x', tone: 'loud' }]), false, 'tone'],
  ['progress 101', card([{ type: 'Progress', value: 101 }]), false, '0 to 100'],
  ['progress ok', card([{ type: 'Progress', value: 40 }]), true],
  ['duplicate field ids', card([field('Input'), field('Input')]), false, 'twice'],
  ['bad field id', card([field('Select', { id: 'A b', options: ['x'] })]), false, 'id'],
  ['select with no options', card([field('Select', { options: [] })]), false, 'options'],
  ['select duplicate options', card([field('Select', { options: ['x', 'x'] })]), false, 'twice'],
  ['select bad start', card([field('Select', { options: ['x'], value: 'y' })]), false, 'options'],
  ['select with other ok', card([field('Select', { options: ['x', 'y'], other: true, value: 'x' })]), true],
  ['bad date', card([field('Date', { value: 'tomorrow' })]), false, 'YYYY'],
  ['bad time', card([field('Time', { value: '25:00' })]), false, 'HH:MM'],
  ['bad weekday', card([field('Weekday', { value: 'funday' })]), false, 'weekday'],
  ['checkbox string', card([field('Checkbox', { value: 'yes' })]), false, 'checkbox'],
  ['chart 100 points ok', card([{ type: 'Chart', kind: 'line', series: [{ name: 'a', points: Array.from({ length: 100 }, (_, i) => ({ x: String(i), y: i })) }] }]), true],
  ['chart 101 points', card([{ type: 'Chart', series: [{ name: 'a', points: Array.from({ length: 101 }, (_, i) => ({ x: String(i), y: i })) }] }]), false, '100'],
  ['chart 5 series', card([{ type: 'Chart', series: Array.from({ length: 5 }, (_, i) => ({ name: String(i), points: [{ x: 'a', y: 1 }] })) }]), false, '4 series'],
  ['chart bad point', card([{ type: 'Chart', series: [{ name: 'a', points: [{ x: 'a', y: 'one' }] }] }]), false, 'point'],
  ['table row too long', card([{ type: 'Table', columns: ['a'], rows: [['1', '2']] }]), false, 'row'],
  ['table ok', card([{ type: 'Table', columns: ['a', 'b'], rows: [['1', 2]] }]), true],
  ['duplicate refs', card([{ type: 'Button', label: 'A', ref: 'x' }, { type: 'Button', label: 'B', ref: 'x' }]), false, 'twice'],
  ['button needs ref', card([{ type: 'Button', label: 'A' }]), false, 'ref'],
  ['open_url button ok', card([{ type: 'Button', label: 'A', action: { type: 'open_url', url: 'https://example.test/x' } }]), true],
  ['open_url http', card([{ type: 'Button', label: 'A', action: { type: 'open_url', url: 'http://example.test/x' } }]), false, 'https'],
  ['confirm and cancel ok', card([{ type: 'Text', text: 'x' }], { confirm: { label: 'Go', ref: 'confirm' }, cancel: { label: 'No', ref: 'cancel' } }), true],
  ['confirm ref clash', card([{ type: 'Button', label: 'A', ref: 'confirm' }], { confirm: { label: 'Go', ref: 'confirm' } }), false, 'twice'],
  ['markdown 8000 ok', card([{ type: 'Markdown', text: text(8000) }]), true],
  ['markdown 8001', card([{ type: 'Markdown', text: text(8001) }]), false, '8000'],
  ['text must be text', card([{ type: 'Text', text: 5 }]), false, 'text'],
];

(async () => {
  const W = await load('botsWidgetModel.js');
  const B = await load('botsAppBridge.js');
  const F = await load('botsAppFrame.js');
  const P = await load('botsPoint.js');
  const R = await load('botsRichRows.js');

  await check('the limits are the design\'s', () => {
    assert.deepEqual([W.LIMITS.bytes, W.LIMITS.nodes, W.LIMITS.depth, W.LIMITS.fields, W.LIMITS.listItems], [32000, 250, 10, 20, 40]);
    assert.equal(W.COMPACT_BELOW, 400);
    assert.ok(W.ICONS.length >= 55);
    const icons = fs.readFileSync(path.join(dir, 'botsIcons.js'), 'utf8');
    for (const name of W.ICONS) assert.ok(icons.includes(`'${name}':`), `${name} is a drawn icon`);
  });

  await check('the browser accepts and refuses each card as the design says', () => {
    for (const [name, doc, ok, why] of CASES) {
      const result = W.checkWidget(doc);
      assert.equal(result.ok, ok, `${name}: ${result.error || 'accepted'}`);
      if (!ok) assert.ok(result.error.toLowerCase().includes(why.toLowerCase()), `${name}: "${result.error}" should mention ${why}`);
    }
  });

  await check('the server\'s checker (services/bot_widgets.py) gives the same answer for every card', () => {
    const venv = path.join(root, '.venv', 'Scripts', 'python.exe');
    const python = process.env.KAIROS_PYTHON || (fs.existsSync(venv) ? venv : (fs.existsSync(path.join(root, '.venv', 'bin', 'python')) ? path.join(root, '.venv', 'bin', 'python') : 'python'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-widget-parity-'));
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
from services import bot_widgets as w, bot_apps
out = []
for doc in json.loads(sys.stdin.read()):
    try:
        w.validate(doc); out.append({"ok": True})
    except w.WidgetError as error:
        out.append({"ok": False, "error": str(error)})
print(json.dumps({"results": out, "icons": list(w.ICONS), "shim": bot_apps.shim("abc123")}))
`;
    let reply;
    try {
      reply = JSON.parse(execFileSync(python, ['-B', '-X', 'utf8', '-I', '-c', script], { input: JSON.stringify(CASES.map(c => c[1])), env: { ...process.env, JARVIS_DATA_DIR: data, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim().split('\n').pop());
    } finally { fs.rmSync(data, { recursive: true, force: true }); }
    CASES.forEach(([name, doc, ok, why], i) => {
      const server = reply.results[i];
      assert.equal(server.ok, ok, `server: ${name}: ${server.error || 'accepted'}`);
      if (!ok) assert.ok(server.error.toLowerCase().includes(why.toLowerCase()), `server: ${name}: "${server.error}" should mention ${why}`);
      assert.equal(W.checkWidget(doc).ok, server.ok, `parity: ${name}`);
    });
    assert.deepEqual([...reply.icons].sort(), [...W.ICONS].sort(), 'the same icons are allowed on both sides');
    assert.equal(reply.shim, B.pageShim('abc123'), 'the server builds the page script from the same text the browser tests');
  });

  await check('the browser keeps unknown keys out and never turns text into markup', () => {
    const clean = W.validateWidget({ type: 'card', title: '<img src=x onerror=1>', onclick: 'x', children: [{ type: 'Text', text: 'hi', style: 'x', html: '<b>' }] });
    assert.equal(clean.onclick, undefined);
    assert.deepEqual(clean.children[0], { type: 'Text', text: 'hi' });
    assert.equal(clean.title, '<img src=x onerror=1>');
    assert.deepEqual(clean._refs, []);
  });

  await check('a card under 400 px uses the compact layout', () => {
    assert.equal(W.compactLayout(399), true);
    assert.equal(W.compactLayout(400), false);
    assert.equal(W.compactLayout(0), false, 'an unmeasured card is not compact');
    assert.equal(W.compactLayout(320), true);
    assert.equal(W.compactLayout(900), false);
  });

  await check('a press carries the card\'s revision and only real answers', () => {
    const doc = W.validateWidget(card([field('Select', { id: 'day', label: 'Day', options: ['Mon', 'Tue'], other: true }), field('Checkbox', { id: 'ok', label: 'Ok' }), field('Input', { id: 'name', label: 'Name', required: true })], { confirm: { label: 'Book', ref: 'confirm' } }));
    const widget = { rev: 3, doc, settled: null };
    assert.deepEqual(W.initialValues(doc), { day: '', ok: false, name: '' });
    assert.match(W.buildPress(widget, 'm1', 'confirm', { day: 'Mon', ok: true, name: '' }, {}, 's1').error, /Name is needed/);
    const good = W.buildPress(widget, 'm1', 'confirm', { day: 'Mon', ok: true, name: 'Ann' }, {}, 'send-1');
    assert.deepEqual(good.body, { message_id: 'm1', ref: 'confirm', rev: 3, values: { day: 'Mon', ok: true, name: 'Ann' }, send_id: 'send-1' });
    const other = W.buildPress(widget, 'm1', 'confirm', { day: W.OTHER, ok: false, name: 'Ann' }, { day: '  Saturday  ' }, 'send-2');
    assert.deepEqual(other.body.other, { day: 'Saturday' });
    assert.match(W.buildPress(widget, 'm1', 'confirm', { day: W.OTHER, ok: false, name: 'Ann' }, {}, 's').error, /Write your answer/);
    const skipped = W.buildPress(widget, 'm1', 'confirm', { name: 'Ann' }, {}, 's3');
    assert.deepEqual(skipped.body.values, { ok: false, name: 'Ann' }, 'an empty choice is left out');
  });

  await check('an answered card folds to one line and refusals read plainly', () => {
    const doc = { title: 'Pick a day' };
    assert.equal(W.foldedLine({ doc, settled: { label: 'Book it' } }), 'Pick a day: Book it');
    assert.equal(W.foldedLine({ doc: {}, settled: { label: 'Yes' } }), 'Yes');
    assert.equal(W.foldedLine({ doc, settled: {} }), 'Pick a day');
    assert.equal(W.foldedLine({ doc, settled: null }), '');
    assert.equal(W.pressMessage(409, 'This card changed. Look at the new one.'), 'This card changed. Look at the new one.');
    assert.equal(W.pressMessage(409, 'This card was already answered.'), 'This card was already answered.');
    assert.equal(W.pressMessage(404, ''), 'That card is gone.');
    assert.equal(W.pressMessage(500, ''), 'That did not go through. Try again.');
    for (const s of [W.pressMessage(409, ''), W.pressMessage(404, ''), W.pressMessage(500, '')]) assert.ok(!s.includes('—'));
  });

  await check('bridge limits: a message once per 3 s and 10 per 10 min, links once per 2 s, calls 10 per 10 s and 120 per 10 min', () => {
    let now = 0;
    const clock = () => now;
    const msg = B.makeLimiter(B.BRIDGE_LIMITS.message, clock);
    assert.equal(msg.allow(), true);
    assert.equal(msg.allow(), false, 'a second one inside 3 s');
    now = 3000; assert.equal(msg.allow(), true);
    let allowed = 2;
    for (let i = 0; i < 20; i++) { now += 3000; if (msg.allow()) allowed++; }
    assert.equal(allowed, 10, 'ten in ten minutes');
    now += 600_000; assert.equal(msg.allow(), true, 'the window slides');
    const link = B.makeLimiter(B.BRIDGE_LIMITS.openLink, clock);
    assert.deepEqual([link.allow(), link.allow()], [true, false]);
    now += 2000; assert.equal(link.allow(), true);
    now = 0;
    const rpc = B.makeLimiter(B.BRIDGE_LIMITS.rpc, clock);
    assert.equal(Array.from({ length: 12 }, () => rpc.allow()).filter(Boolean).length, 10);
    now = 10_000; assert.equal(rpc.allow(), true);
    let total = 0;
    for (let i = 0; i < 200; i++) { now += 10_000; if (rpc.allow()) total++; if (now > 599_000) break; }
    assert.ok(total <= 120);
    assert.equal(B.BRIDGE_LIMITS.maxBytes, 1_000_000);
  });

  await check('the bridge hears only the frame it made, within size, and answers only known calls', async () => {
    const sent = [];
    const win = { postMessage: (m) => sent.push(m) };
    const seen = [];
    const bridge = B.createBridge({ getWindow: () => win, channel: 'c1', onMessage: async t => { seen.push(['message', t]); return { ok: true, n: 1 }; }, onOpen: u => seen.push(['open', u]), onContext: async t => seen.push(['context', t]),
      onSize: h => seen.push(['size', h]), onReady: () => seen.push(['ready']), isPointing: () => false });
    const say = (method, params, extra = {}) => bridge.handle({ source: win, data: { jsonrpc: '2.0', id: 1, method, params, channel: 'c1', ...extra } });
    assert.equal(await bridge.handle({ source: {}, data: { jsonrpc: '2.0', method: 'ui/ready', channel: 'c1' } }), false, 'another window is ignored');
    assert.equal(await bridge.handle({ source: win, data: { jsonrpc: '2.0', method: 'ui/ready', channel: 'nope' } }), false, 'the wrong channel is ignored');
    assert.equal(await bridge.handle({ source: win, data: { method: 'ui/ready', channel: 'c1' } }), false, 'not JSON-RPC');
    await say('ui/ready', {});
    assert.deepEqual(seen.at(-1), ['ready']);
    await say('ui/message', { text: 'hello' });
    assert.deepEqual(seen.at(-1), ['message', 'hello']);
    assert.equal(sent.at(-1).result.ok, true);
    await say('ui/message', { text: 'again soon' });
    assert.match(sent.at(-1).error.message, /too fast/);
    await say('ui/message', { text: '   ' });
    assert.match(sent.at(-1).error.message, /nothing to send/);
    await say('ui/open-link', { url: 'javascript:alert(1)' });
    assert.match(sent.at(-1).error.message, /http and https/);
    await say('ui/open-link', { url: 'https://example.test/a' });
    assert.deepEqual(seen.at(-1), ['open', 'https://example.test/a']);
    await say('ui/open-link', { url: 'https://example.test/b' });
    assert.match(sent.at(-1).error.message, /too fast/);
    await say('ui/update-model-context', { text: 'state' });
    assert.deepEqual(seen.at(-1), ['context', 'state']);
    await say('fs/read', { path: 'x' });
    assert.equal(sent.at(-1).error.code, -32601);
    await say('ui/size-changed', { height: 480 }, { id: undefined });
    assert.deepEqual(seen.at(-1), ['size', 480]);
    await say('ui/point', { tag: 'button', label: 'x' }, { id: undefined });
    assert.notDeepEqual(seen.at(-1)[0], 'point', 'a pick while Point is off is dropped');
    await say('ui/message', { text: 'x'.repeat(1_000_001) }, { id: 9 });
    assert.match(sent.at(-1).error.message, /too large/);
    bridge.destroy();
    assert.equal(await say('ui/ready', {}), false, 'a destroyed bridge hears nothing');
  });

  await check('Point picks are accepted only while Point is on', async () => {
    const win = { postMessage() {} };
    const picks = [];
    let pointing = false;
    const bridge = B.createBridge({ getWindow: () => win, channel: 'p', isPointing: () => pointing, onPoint: p => picks.push(p), onPointEnd: () => picks.push('end') });
    const send = (method, params) => bridge.handle({ source: win, data: { jsonrpc: '2.0', method, params, channel: 'p' } });
    await send('ui/point', { tag: 'BUTTON', label: 'Save' });
    assert.deepEqual(picks, []);
    pointing = true;
    await send('ui/point', { tag: 'BUTTON<script>', label: 'L'.repeat(80) });
    assert.equal(picks[0].tag, 'BUTTONscript');
    assert.equal(picks[0].label.length, 40);
    await send('ui/point-end', {});
    assert.equal(picks[1], 'end');
  });

  await check('the policy goes in first, before anything the bot wrote, in every page shape', () => {
    const head = B.buildHead({ csp: "default-src 'none'; img-src \"x\"", theme: { '--k-bg': '#fff', '--k-evil': 'red; background:url(x)' }, channel: 'ch1' });
    assert.ok(head.indexOf('Content-Security-Policy') < head.indexOf('<script>'), 'the policy comes before the bridge script');
    assert.ok(!head.includes('"x"'), 'quotes in the policy are escaped');
    assert.ok(head.includes('&quot;'));
    assert.ok(!head.includes('url(x)'), 'a theme value cannot carry CSS of its own');
    const full = '<!doctype html><html><head><title>t</title></head><body>b</body></html>';
    const a = B.injectHead(full, head);
    assert.ok(a.indexOf('Content-Security-Policy') < a.indexOf('<title>'));
    assert.ok(B.injectHead('<html><body>b</body></html>', head).includes('<head>'));
    const fragment = B.injectHead('<p>hi</p>', head);
    assert.ok(fragment.startsWith('<!doctype html><html><head>') && fragment.includes('<body><p>hi</p></body>'));
    const header = B.injectHead('<header>x</header><head><meta></head>', head);
    assert.ok(header.indexOf('Content-Security-Policy') > header.indexOf('<header>'), 'a <header> tag is not a <head> tag');
    assert.ok(B.injectHead('<HEAD class=x><title>t', head).indexOf('Content-Security-Policy') < 100, 'any letter case');
    assert.equal((B.buildHead({ csp: 'x', theme: {}, channel: '"><script>' }).match(/<script>/g) || []).length, 1, 'the channel cannot add a script tag');
  });

  await check('the page shim exposes window.kairos with send, open, setContext and theme only', () => {
    const shim = B.pageShim('abc');
    assert.ok(shim.includes('window.kairos=api'));
    for (const method of ['ui/message', 'ui/open-link', 'ui/update-model-context', 'ui/ready', 'ui/point']) assert.ok(shim.includes(method), method);
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|localStorage|document\.cookie|top\./.test(shim), 'the shim reaches nothing else');
    assert.ok(new Function(shim.replace('window.kairos', 'var kairos_').replace(/parent\.postMessage/g, 'void')) , 'the shim is valid JavaScript');
    assert.equal(B.SANDBOX, 'allow-scripts allow-forms');
    assert.ok(!B.SANDBOX.includes('allow-same-origin'));
    assert.deepEqual(B.SCRIPT_HOSTS, ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com']);
  });

  await check('theme values are plain and links are http or https only', () => {
    assert.equal(B.safeCssValue('#d9b260'), '#d9b260');
    assert.equal(B.safeCssValue('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
    assert.equal(B.safeCssValue('red; background: url(x)'), '');
    assert.equal(B.safeCssValue('x}</style><script>'), '');
    assert.ok(B.themeCss({ '--k-bg': '#fff', 'evil': 'x', '--k-x': '};' }).startsWith(':root{--k-bg:#fff}'));
    assert.equal(B.httpLink('https://example.test/a?b=1'), 'https://example.test/a?b=1');
    assert.equal(B.httpLink('javascript:alert(1)'), '');
    assert.equal(B.httpLink('file:///etc/passwd'), '');
    assert.equal(B.httpLink('https://x.test/' + 'a'.repeat(2100)), '');
    assert.equal(B.httpLink('not a url'), '');
  });

  await check('three frames live at once: the least recently used folds; a page is cached for 60 seconds', () => {
    const pool = new F.FramePool(3);
    assert.deepEqual(['a', 'b', 'c'].map(id => pool.touch(id)), [null, null, null]);
    assert.equal(pool.touch('d'), 'a');
    assert.equal(pool.touch('b'), null, 'touching a live frame refreshes it');
    assert.equal(pool.touch('e'), 'c');
    assert.ok(pool.has('b') && pool.has('d') && pool.has('e') && !pool.has('a'));
    pool.release('b');
    assert.equal(pool.touch('f'), null);
    assert.equal(F.FRAME.maxLive, 3);
    let now = 0;
    const cache = new F.DocCache(2, 60_000, () => now);
    cache.set('a', 1); cache.set('b', 2);
    assert.equal(cache.get('a'), 1);
    cache.set('c', 3);
    assert.equal(cache.get('b'), null, 'the least recently used page goes first');
    now = 60_001;
    assert.equal(cache.get('a'), null, 'a minute is the limit');
    assert.equal(new F.DocCache().size, 8);
  });

  await check('the frame is 520 tall, grows to 560, then scrolls; a phone gets 70 percent, at most 720', () => {
    assert.equal(F.frameHeight(100), 520);
    assert.equal(F.frameHeight(540), 540);
    assert.equal(F.frameHeight(2000), 560);
    assert.equal(F.frameHeight(NaN), 520);
    assert.equal(F.frameHeight(0, { phone: true, viewport: 800 }), 560);
    assert.equal(F.frameHeight(0, { phone: true, viewport: 2000 }), 720);
  });

  await check('only the newest 20 app rows open by themselves', () => {
    F.resetFramesForTest();
    assert.equal(F.autoMounts('nobody'), false);
  });

  await check('Point keeps up to five chips, with a tag and a label cut to 40 characters', () => {
    P.clearPointed();
    assert.equal(P.addPointed({ tag: 'BUTTON', label: '  Save   the\nthing ' + 'z'.repeat(60) }), true);
    const [chip] = P.list();
    assert.equal(chip.tag, 'button');
    assert.equal(chip.label.length, 40);
    assert.ok(!chip.label.includes('\n'));
    for (let i = 0; i < 4; i++) assert.equal(P.addPointed({ tag: 'a', label: String(i) }), true);
    assert.equal(P.addPointed({ tag: 'a', label: 'sixth' }), false, 'five at most');
    let heard = 0;
    const off = P.onPointed(() => heard++);
    P.removePointed(chip.id);
    assert.equal(P.list().length, 4);
    assert.equal(heard, 1);
    const taken = P.takePointed();
    assert.equal(taken.length, 4);
    assert.deepEqual(Object.keys(taken[0]).sort(), ['label', 'tag'], 'only the tag and the label travel');
    assert.equal(P.list().length, 0);
    off();
    assert.equal(P.cleanTag('<script>'), 'script');
    assert.equal(P.cleanTag(''), 'element');
  });

  await check('the rich-row door knows widgets, apps and data results and leaves ordinary messages alone', () => {
    assert.equal(R.richKind({ role: 'assistant', content: 'hi' }), '');
    assert.equal(R.richKind(null), '');
    assert.equal(R.richKind({ kind: 'widget', widget: {} }), 'widget');
    assert.equal(R.richKind({ widget: { rev: 1 } }), 'widget');
    assert.equal(R.richKind({ app: { rev: 1 } }), 'app');
    assert.equal(R.richKind({ data_result: { card_id: 'c' } }), 'data_result');
    assert.equal(R.richKind({ kind: 'voice_note' }), 'voice_note');
    assert.equal(R.richKind({ kind: 'help' }), 'help');
    assert.equal(R.richKind({ kind: 'quota_switch' }), 'quota_switch');
    assert.equal(R.richKind({ kind: 'goal_digest' }), '');
    assert.equal(R.renderRichRow({ role: 'user', content: 'x' }, {}), null);
    assert.deepEqual(R.RICH_KINDS, ['widget', 'app', 'data_result', 'voice_note', 'help', 'quota_switch']);
  });

  await check('every unit file is free of raw colours, em-dashes and innerHTML', () => {
    const files = ['botsWidgetModel.js', 'botsWidget.js', 'botsAppBridge.js', 'botsAppFrame.js', 'botsPoint.js', 'botsRichRows.js'];
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const code = source.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
      assert.ok(!code.includes('innerHTML') && !code.includes('outerHTML') && !code.includes('insertAdjacentHTML'), `${file} builds DOM, not markup strings`);
      assert.ok(!source.includes('—'), `${file} has no em-dash`);
      if (file !== 'botsAppBridge.js') assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code) && !/\brgba?\(\s*\d/.test(code), `${file} has no raw colour`);
    }
    const css = fs.readFileSync(path.join(root, 'static', 'css', 'bots-widgets.css'), 'utf8');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css) && !/rgba?\(\s*\d/.test(css), 'bots-widgets.css has no raw colour');
    const frame = fs.readFileSync(path.join(dir, 'botsAppFrame.js'), 'utf8');
    assert.ok(frame.includes('sandbox: SANDBOX') && !frame.includes('allow-same-origin'), 'the frame is sandboxed without same-origin');
  });

  console.log(`PASS: ${passed.length} widget and app checks over ${CASES.length} cards (${passed.join('; ')})`);
})().catch(error => { console.error(error); process.exit(1); });
