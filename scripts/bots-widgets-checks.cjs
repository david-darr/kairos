// Bots widgets, apps and Point mode, in the renderer (Phase 6 unit U2). Run by ui-smoke behind --bots-widgets-only:
//   node scripts/run-electron-test.cjs ui-smoke --bots-widgets-only
//
// Covers: a widget card (fields, Other, a press that carries the card's revision, folding to one line with Details, a stale
// press shown as one plain line, a retry that reuses its send id, a required field, a refused press, a list, compact layout,
// click-to-load images, Markdown and titles drawn as text, a password field refused), and an app in its sandbox (the frame
// attribute, the policy, no reach to the page that holds it, the bridge: a message, a link that waits for a click, a note for
// the model, the version stepper, Save as file, full screen, an unavailable page and its retry, three live frames at most,
// Point mode picking an element into a chip, Escape ending Point before full screen), and the same on a phone.
//
// It creates its own bot through the fixture API and seeds demoState.botsWidgets itself (scripts/fixtures/bots-widgets-backend.cjs),
// never assuming which other bots exist, and puts everything back in `finally`. Rows are drawn here with renderRichRow(), so the
// check does not depend on the transcript another unit wires.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

const APP_HTML = `<!doctype html><html><head><title>Counter</title></head><body>
<button id="b" onclick="kairos.send('hello from app')">Send</button>
<button id="o" onclick="kairos.open('https://example.test/x')">Open</button>
<button id="c" onclick="kairos.setContext('score is 4')">Context</button>
<input id="t" aria-label="Name">
<div id="out">starting</div>
<script>
var results = {};
try { results.parent = String(parent.document.title); } catch (e) { results.parent = 'blocked'; }
try { results.storage = String(localStorage.length); } catch (e) { results.storage = 'blocked'; }
try { results.cookie = document.cookie === '' ? 'empty' : 'LEAK'; } catch (e) { results.cookie = 'blocked'; }
results.origin = window.origin;
setTimeout(function () { document.getElementById('out').textContent = JSON.stringify(results); }, 400);
</script></body></html>`;

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const text = selector => js(`(${q(selector)} || {}).textContent || ''`);
  const click = selector => js(`(() => { const n = ${q(selector)}; if (!n) throw new Error('no ${selector.replace(/'/g, '')}'); n.click(); return true; })()`);
  const clickText = (scope, label) => js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent.trim().includes(${JSON.stringify(label)})); if (!n) throw new Error('no ${label}'); n.click(); return true; })()`);
  const set = (selector, value) => js(`(() => { const n = ${q(selector)}; n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const state = () => demoState.botsWidgets;
  const original = win.getContentSize();
  const resize = size => { win.setContentSize(size[0], size[1]); return delay(450); };
  let framePort = 0;
  const appFrame = () => win.webContents.mainFrame.frames.find(f => f.url.startsWith(`http://127.0.0.1:${framePort}/frame`));
  const inFrame = async code => { const frame = appFrame(); if (!frame) throw new Error('no app frame'); return frame.executeJavaScript(code); };
  const waitLive = async (selector = '.bots-app') => { try { await waitFor(`!!${q(selector + '[data-state=live]')}`); } catch (e) { throw new Error('not live: ' + await js("[...document.querySelectorAll('.bots-app')].map(n => n.dataset.state + ' ' + n.querySelector('.bots-app-stage').textContent.slice(0, 80) + ' frames=' + n.querySelectorAll('iframe').length).join(' | ') + ' sub=' + (window.__frames || '')") + ' fr=' + win.webContents.mainFrame.frames.map(f => f.url).join(',')); } };
  const toastsClear = () => js("[...document.querySelectorAll('#toast-host .toast')].map(n => { const t = n.textContent; n.remove(); return t; })");
  // Draw a row into a holder (widgets) the way the transcript will.
  const draw = (message, ctx = {}, width = 520) => js(`(async () => {
    const m = await import('/static/js/botsRichRows.js');
    let holder = document.getElementById('rich-holder');
    if (!holder) { holder = document.createElement('div'); holder.id = 'rich-holder'; holder.dataset.appMode = 'bots'; document.body.append(holder); }
    holder.style.cssText = 'position:fixed;left:0;top:0;bottom:0;overflow:auto;width:${width}px;z-index:900;background:var(--bg);padding:8px;box-sizing:border-box';
    window.__refreshed = window.__refreshed || 0;
    holder.replaceChildren(m.renderRichRow(${JSON.stringify(message)}, Object.assign({ agentId: ${JSON.stringify(botId)}, sessionId: ${JSON.stringify(sid)}, botName: 'Planner', refresh: () => { window.__refreshed++; } }, ${JSON.stringify(ctx)})));
  })()`);
  const clear = () => js(`(() => { const h = document.getElementById('rich-holder'); if (h) { [...h.querySelectorAll('.bots-rich-row')].forEach(n => n.destroy?.()); h.remove(); } })()`);

  const restore = await isolateBotsCheck({ js, demoState });
  let botId = '', sid = '', frameServer = null;
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const made = await call('/api/agents', 'POST', { name: `Widgets ${Date.now() % 100000}` });
    assert.equal(made.status, 200, 'the fixture makes a bot');
    botId = made.body.id;
    sid = `widgets-${Date.now() % 100000}`;
    demoState.botsWidgets = { widgets: {}, apps: {}, presses: [], rpcs: [], contexts: [], appReads: [], failNext: null, appFail: null };
    // The app's page is served by the backend with its own policy header (the platform's policy would forbid its inline script).
    // The fixture server cannot answer with HTML, so a small local server stands in for that route, built from the same pieces
    // (the bridge script, the policy the fixture names) and the same headers, and the frame request is sent to it.
    const bridge = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsAppBridge.js')).href);
    const backend = require('./fixtures/bots-widgets-backend.cjs')({ state: demoState });
    frameServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const page = backend.read(`/api/bot-widgets/x/apps/${u.searchParams.get('mid')}`, { rev: u.searchParams.get('rev') });
      if (!page || page._status) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `${page.csp}; sandbox allow-scripts allow-forms`, 'Cache-Control': 'no-store' });
      res.end(bridge.injectHead(page.html, bridge.buildHead({ csp: page.csp, theme: {}, channel: u.searchParams.get('channel') })));
    });
    await new Promise(resolve => frameServer.listen(0, '127.0.0.1', resolve));
    framePort = frameServer.address().port;
    const session = win.webContents.session;
    session.webRequest.onBeforeRequest({ urls: ['*://*/api/bot-widgets/*/apps/*/frame*'] }, (details, callback) => {
      const u = new URL(details.url);
      callback({ redirectURL: `http://127.0.0.1:${framePort}/frame?mid=${encodeURIComponent(decodeURIComponent(u.pathname.split('/')[5]))}&rev=${u.searchParams.get('rev')}&channel=${u.searchParams.get('channel')}` });
    });
    await js(`(() => {
      window.__realFetch = window.fetch; window.__downloads = []; window.__windowOpen = []; window.__focusAsked = 0; window.__failFetchOnce = false;
      window.fetch = (url, opts) => { if (window.__failFetchOnce && String(url).includes('/press')) { window.__failFetchOnce = false; return Promise.reject(new TypeError('offline')); } return window.__realFetch(url, opts); };
      window.__blobs = {}; const realCreate = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { const u = realCreate(blob); window.__blobs[u] = blob; return u; };
      window.__realAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (!this.download) return window.__realAnchorClick.call(this); const entry = { name: this.download, href: this.href }; window.__downloads.push(entry); (window.__blobs[this.href] ? window.__blobs[this.href].text() : Promise.resolve('')).then(t => { entry.text = t; }); };
      window.__realOpen = window.open; window.open = (...args) => { window.__windowOpen.push(args); return null; };
      document.addEventListener('kairos:bots-focus-composer', () => { window.__focusAsked++; });
      window.__pwned = undefined;
      Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, set(v) { this.setAttribute('data-intended-src', v); }, get() { return this.getAttribute('data-intended-src') || ''; } });
    })()`);

    // ===== Widgets ==========================================================================================================
    const doc = { type: 'card', size: 'md', title: 'Pick a day', caption: 'Choose when to meet', children: [
      { type: 'Select', id: 'day', label: 'Day', options: ['Mon', 'Tue'], other: true },
      { type: 'Checkbox', id: 'remind', label: 'Remind me' },
      { type: 'Textarea', id: 'note', label: 'Note', placeholder: 'Anything else' },
      { type: 'Input', id: 'name', label: 'Your name', required: true }],
    confirm: { label: 'Book it', ref: 'confirm' }, cancel: { label: 'Never mind', ref: 'cancel' }, _refs: ['cancel', 'confirm'] };
    state().widgets.w1 = { rev: 1, refs: ['confirm', 'cancel'], settled: null };
    await draw({ id: 'w1', kind: 'widget', widget: { rev: 1, doc, settled: null } });
    await waitFor("!!document.querySelector('#rich-holder .bots-widget')");
    assert.equal(await text('.bots-w-title'), 'Pick a day');
    assert.equal(await text('.bots-w-caption'), 'Choose when to meet');
    assert.equal(await js("document.querySelectorAll('.bots-widget select, .bots-widget input, .bots-widget textarea').length >= 4"), true, 'the fields are real controls');
    assert.equal(await js("document.querySelector('.bots-widget label[for]') && [...document.querySelectorAll('.bots-widget label[for]')].every(l => document.getElementById(l.getAttribute('for')))"), true, 'every label points at its field');
    await capture?.('desktop-bots-widget-card');
    // A required field blocks the press with one plain line, and nothing is sent.
    await clickText('.bots-w-actions button', 'Book it');
    await waitFor("!!document.querySelector('.bots-w-line')");
    assert.match(await text('.bots-w-line'), /Your name is needed/);
    assert.equal(state().presses.length, 0, 'nothing was sent');
    // Other: choosing it shows a box.
    assert.equal(await js("document.querySelector('.bots-w-other').hidden"), true);
    await set('.bots-widget select', '__other__');
    await waitFor("document.querySelector('.bots-w-other').hidden === false");
    await set('.bots-w-other', '  Saturday morning ');
    await set('.bots-widget textarea', 'bring snacks');
    await js(`(() => { const c = ${q('.bots-widget input[type=checkbox]')}; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await set('.bots-widget input[type=text]:not(.bots-w-other)', 'Ann');
    await clickText('.bots-w-actions button', 'Book it');
    await waitFor("document.querySelector('.bots-widget.settled')");
    const press = state().presses[0];
    assert.deepEqual([press.message_id, press.ref, press.rev], ['w1', 'confirm', 1], 'a press names the card, the button and the card\'s revision');
    assert.deepEqual(press.values, { day: '__other__', remind: true, note: 'bring snacks', name: 'Ann' });
    assert.deepEqual(press.other, { day: 'Saturday morning' });
    assert.match(press.send_id, /^[0-9a-f-]{8,}$/, 'with a send id');
    assert.ok(await js('window.__refreshed') >= 1, 'the transcript is told to refresh');
    assert.equal(await text('.bots-w-folded-line > span'), 'Pick a day: Book it', 'an answered card folds to one line');
    assert.equal(await js("!document.querySelector('.bots-widget button.primary')"), true, 'and has no buttons left');
    assert.equal(await js("!!document.querySelector('.bots-w-folded-details')"), false);
    await click('.bots-w-details');
    await waitFor("!!document.querySelector('.bots-w-folded-details')");
    assert.match(await text('.bots-w-summary'), /Saturday morning/);
    assert.match(await text('.bots-w-summary'), /Remind me: yes/);
    await capture?.('desktop-bots-widget-folded');

    // A press on a card that changed since: one plain line, the card stays, and the transcript is asked to refresh.
    state().widgets.w2 = { rev: 2, refs: ['go'], settled: null };
    const refreshed = await js('window.__refreshed');
    await draw({ id: 'w2', kind: 'widget', widget: { rev: 1, doc: { type: 'card', title: 'Old card', children: [{ type: 'Button', label: 'Go', ref: 'go' }] , _refs: ['go'] }, settled: null } });
    await clickText('.bots-widget button', 'Go');
    await waitFor("!!document.querySelector('.bots-w-line')");
    assert.equal(await text('.bots-w-line'), 'This card changed. Look at the new one.', 'a stale press says so plainly');
    assert.equal(await js("document.querySelector('.bots-widget').classList.contains('settled')"), false, 'the card is not settled');
    assert.ok(await js('window.__refreshed') > refreshed, 'and the transcript refreshes to show the new one');

    // A network failure keeps the send id, so the retry cannot send twice.
    state().widgets.w3 = { rev: 1, refs: ['go'], settled: null };
    await draw({ id: 'w3', kind: 'widget', widget: { rev: 1, doc: { type: 'card', title: 'Retry me', children: [{ type: 'Button', label: 'Go', ref: 'go' }], _refs: ['go'] }, settled: null } });
    const sent = state().presses.length;
    await js('window.__failFetchOnce = true');
    await clickText('.bots-widget button', 'Go');
    await waitFor("!!document.querySelector('.bots-w-line')");
    assert.match(await text('.bots-w-line'), /did not go through/);
    assert.equal(state().presses.length, sent, 'the failed try never reached the server');
    await clickText('.bots-widget button', 'Go');
    await waitFor("!!document.querySelector('.bots-widget.settled')");
    assert.equal(state().presses.length, sent + 1);
    // A repeat of the same press is answered with the first result and settles nothing twice.
    const body = state().presses.at(-1);
    const again = await call(`/api/bot-widgets/${sid}/press`, 'POST', body);
    assert.deepEqual(again.body, { status: 'started', n: state().presses.length - 1 }, 'a repeat send id returns the first answer');

    // A refused press shows the server's words.
    state().widgets.w4 = { rev: 1, refs: ['go'], settled: null };
    await draw({ id: 'w4', kind: 'widget', widget: { rev: 1, doc: { type: 'card', title: 'Refused', children: [{ type: 'Button', label: 'Go', ref: 'go' }], _refs: ['go'] }, settled: null } });
    state().failNext = { status: 500, detail: 'The thread is busy. Try again in a moment.' };
    await clickText('.bots-widget button', 'Go');
    await waitFor("!!document.querySelector('.bots-w-line')");
    assert.equal(await text('.bots-w-line'), 'The thread is busy. Try again in a moment.');
    await clickText('.bots-widget button', 'Go');
    await waitFor("!!document.querySelector('.bots-widget.settled')");

    // A list: pressing a row answers.
    state().widgets.w5 = { rev: 1, refs: ['a', 'b'], settled: null };
    await draw({ id: 'w5', kind: 'widget', widget: { rev: 1, doc: { type: 'list', title: 'Choose one', items: [{ title: 'Apple', caption: 'red', ref: 'a' }, { title: 'Pear', ref: 'b' }, { title: 'Plain row' }], _refs: ['a', 'b'] }, settled: null } });
    assert.equal(await js("document.querySelectorAll('.bots-w-item').length"), 3);
    assert.equal(await js("document.querySelectorAll('.bots-w-item.pressable').length"), 2, 'only rows with a ref can be pressed');
    await clickText('.bots-w-item.pressable', 'Pear');
    await waitFor("!!document.querySelector('.bots-widget.settled')");
    assert.equal(state().presses.at(-1).ref, 'b');
    assert.equal(await text('.bots-w-folded-line > span'), 'Choose one: Pear');

    // Compact layout under 400 px.
    const wide = { type: 'card', size: 'lg', title: 'Layout', children: [{ type: 'Row', children: [{ type: 'Text', text: 'one' }, { type: 'Text', text: 'two' }] }], confirm: { label: 'OK', ref: 'confirm' }, _refs: ['confirm'] };
    await draw({ id: 'w6', kind: 'widget', widget: { rev: 1, doc: wide, settled: null } }, {}, 520);
    await delay(150);
    assert.equal(await js("document.querySelector('.bots-widget').classList.contains('compact')"), false, 'a wide card is not compact');
    await draw({ id: 'w6', kind: 'widget', widget: { rev: 1, doc: wide, settled: null } }, {}, 380);
    await waitFor("document.querySelector('.bots-widget').classList.contains('compact')");
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-w-row')).flexDirection"), 'column', 'compact stacks a row');

    // Text stays text: markup in a title, Markdown HTML and a script link do nothing.
    const hostile = { type: 'card', title: '<img src=x onerror="window.__pwned=1">', children: [
      { type: 'Markdown', text: '<script>window.__pwned=2</script> **bold** [bad](javascript:window.__pwned=3) [good](https://example.test/ok)' },
      { type: 'Text', text: '<b onmouseover="window.__pwned=4">x</b>' },
      { type: 'Image', url: 'https://example.test/pic.png', alt: 'A picture' },
      { type: 'Icon', name: 'check' },
      { type: 'Chart', kind: 'bar', series: [{ name: 'a', points: [{ x: 'p', y: 3 }, { x: 'q', y: 5 }] }] },
      { type: 'Table', columns: ['a'], rows: [['<i>cell</i>']] },
      { type: 'Button', label: 'Open the site', action: { type: 'open_url', url: 'https://example.test/site' } }] };
    await draw({ id: 'w7', kind: 'widget', widget: { rev: 1, doc: hostile, settled: null } });
    await waitFor("!!document.querySelector('.bots-widget .bots-w-md')");
    assert.equal(await text('.bots-w-title'), '<img src=x onerror="window.__pwned=1">', 'the title is its own text');
    assert.equal(await js("!document.querySelector('.bots-widget img') && !document.querySelector('.bots-widget script')"), true, 'no image or script element was made from text');
    assert.deepEqual(await js("[...document.querySelectorAll('.bots-w-md a')].map(a => a.getAttribute('href'))"), ['https://example.test/ok'], 'only the http link became a link');
    assert.equal(await js("document.querySelector('.bots-w-md a').rel"), 'noopener noreferrer nofollow');
    assert.match(await text('.bots-w-md'), /javascript:window\.__pwned=3/, 'the script link shows as plain text');
    assert.equal(await text('.bots-w-table td'), '<i>cell</i>');
    assert.equal(await js('window.__pwned'), undefined, 'nothing ran');
    assert.ok(await js("document.querySelectorAll('.bots-w-chart svg.bots-chart rect').length >= 2"), 'a chart node draws');
    assert.ok(await js("!!document.querySelector('.bots-w-icon svg')"), 'an allowed icon draws');
    // The image waits for a click, then loads without a referrer.
    assert.equal(await js("!!document.querySelector('.bots-w-image img')"), false, 'an image does not load by itself');
    assert.match(await text('.bots-w-image-load'), /Show image from example\.test/);
    const loaded = await js(`(() => { document.querySelector('.bots-w-image-load').click(); const i = document.querySelector('.bots-w-image img'); return i ? [i.getAttribute('referrerpolicy'), i.getAttribute('data-intended-src'), i.getAttribute('alt')] : null; })()`);
    assert.deepEqual(loaded, ['no-referrer', 'https://example.test/pic.png', 'A picture'], 'a click loads the image, with no referrer');
    // A link button opens in a new window with no opener.
    await clickText('.bots-widget button', 'Open the site');
    assert.deepEqual(await js('window.__windowOpen.at(-1)'), ['https://example.test/site', '_blank', 'noopener,noreferrer']);
    await capture?.('desktop-bots-widget-text-inert');

    // A password field is refused: the card is not drawn.
    await draw({ id: 'w8', kind: 'widget', widget: { rev: 1, doc: { type: 'card', title: 'Login', children: [{ type: 'Input', id: 'pw', label: 'Your password' }] }, settled: null } });
    assert.match(await text('#rich-holder'), /could not be shown/);
    assert.equal(await js("!document.querySelector('#rich-holder input')"), true, 'no password box');
    await clear();

    // ===== Apps ==============================================================================================================
    state().apps.m1 = { latest: 3, title: 'Counter', versions: [1, 2, 3].map(rev => ({ rev, at: 1_800_000_000 + rev, html: rev === 3 ? APP_HTML : APP_HTML.replace('Send</button>', `Send v${rev}</button>`) })) };
    await draw({ id: 'm1', kind: 'app', ts: 1_800_000_003, app: { rev: 3, title: 'Counter' } }, {}, 700);
    await waitFor("!!document.querySelector('.bots-app')");
    await waitLive();
    const sandbox = await js("document.querySelector('.bots-app-frame').getAttribute('sandbox')");
    assert.equal(sandbox, 'allow-scripts allow-forms', 'the frame is sandboxed to scripts and forms only');
    assert.equal(await js("document.querySelector('.bots-app-frame').getAttribute('referrerpolicy')"), 'no-referrer');
    assert.equal(await js("document.querySelector('.bots-app-frame').sandbox.contains('allow-same-origin')"), false);
    assert.equal(await text('.bots-app-title'), 'Counter');
    assert.equal(await text('.bots-app-origin'), 'Made by Planner · version 3');
    assert.equal(await js("Math.round(document.querySelector('.bots-app').getBoundingClientRect().width) <= 760"), true, 'a card is at most 760 px wide');
    assert.equal(await js("Math.round(document.querySelector('.bots-app-frame').getBoundingClientRect().height) >= 520 && Math.round(document.querySelector('.bots-app-frame').getBoundingClientRect().height) <= 560"), true, 'the frame is 520 to 560 tall');
    // What the page can and cannot reach.
    await delay(700);
    const probe = JSON.parse(await inFrame("document.getElementById('out').textContent"));
    assert.equal(probe.parent, 'blocked', 'it cannot read the page that holds it');
    assert.equal(probe.storage, 'blocked', 'it has no storage');
    assert.notEqual(probe.cookie, 'LEAK', 'it sees no cookies');
    assert.equal(probe.origin, 'null', 'its origin is opaque');
    assert.equal(await inFrame(`(() => { const head = [...document.head.children]; const csp = head.findIndex(n => n.httpEquiv === 'Content-Security-Policy'); const own = head.findIndex(n => n.tagName === 'TITLE'); return csp >= 0 && csp < own; })()`), true, 'the policy comes before anything the bot wrote');
    assert.equal(await inFrame("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content.includes(\"connect-src 'none'\") && document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content.includes(\"frame-src 'none'\")"), true);
    assert.equal(await inFrame("typeof window.kairos.send + typeof window.kairos.open + typeof window.kairos.setContext + typeof window.kairos.theme"), 'functionfunctionfunctionobject');
    for (let i = 0; i < 40 && !(await inFrame("getComputedStyle(document.documentElement).getPropertyValue('--k-accent').trim()")); i++) await delay(50);
    assert.ok(await inFrame("getComputedStyle(document.documentElement).getPropertyValue('--k-accent').trim()"), 'the page gets the live theme');
    await capture?.('desktop-bots-app-live');

    // The bridge: a message, once, then rate limited by the host; a link that waits for a click here; a note for the model.
    await inFrame("document.getElementById('b').click()");
    for (let i = 0; i < 60 && !state().rpcs.length; i++) await delay(50);
    assert.deepEqual(state().rpcs.map(r => [r.messageId, r.method, r.params.text]), [['m1', 'ui/message', 'hello from app']], 'a page can send one line to the chat');
    await inFrame("document.getElementById('b').click()");
    await delay(300);
    assert.equal(state().rpcs.length, 1, 'a second message inside three seconds is refused by the host');
    await inFrame("document.getElementById('o').click()");
    await waitFor("!document.querySelector('.bots-app-link').hidden");
    assert.match(await text('.bots-app-link'), /wants to open a link/);
    assert.equal(await js('window.__windowOpen.length'), 1, 'the page itself opened nothing (only the earlier widget link)');
    await clickText('.bots-app-link button', 'Open example.test');
    assert.deepEqual(await js('window.__windowOpen.at(-1)'), ['https://example.test/x', '_blank', 'noopener,noreferrer'], 'a click here opens it with no opener');
    await inFrame("document.getElementById('c').click()");
    for (let i = 0; i < 60 && !state().contexts.length; i++) await delay(50);
    assert.deepEqual(state().contexts.map(c => c.text), ['score is 4'], 'a note for the model goes to the server');

    // Version stepper.
    assert.match(await text('.bots-app-rev'), /v3 latest/);
    await click('.bots-app-stepper [aria-label="Older version"]');
    for (let i = 0; i < 60 && !state().appReads.some(r => r.rev === 2); i++) await delay(50);
    assert.ok(state().appReads.some(r => r.messageId === 'm1' && r.rev === 2), 'stepping back reads that version');
    await waitFor("document.querySelector('.bots-app-rev').textContent.trim() === 'v2'");
    await waitLive();
    assert.equal(await inFrame("document.getElementById('b').textContent"), 'Send v2', 'the older page is showing');
    assert.equal(await js("document.querySelector('.bots-app-stepper [aria-label=\"Newer version\"]').disabled"), false);
    await click('.bots-app-stepper [aria-label="Newer version"]');
    await waitFor("document.querySelector('.bots-app-rev').textContent.includes('v3 latest')");
    await waitLive();
    assert.equal(await js("document.querySelector('.bots-app-stepper [aria-label=\"Newer version\"]').disabled"), true, 'no newer than the latest');

    // Info and Save as file.
    await click('.bots-app-tools [aria-label="About this app"]');
    assert.equal(await js("document.querySelector('.bots-app-info').hidden"), false);
    assert.match(await text('.bots-app-info'), /cannot read your chats, files or accounts/);
    await clickText('.bots-app-tools button', 'Save as file');
    for (let i = 0; i < 60 && !(await js("window.__downloads.some(d => d.name.endsWith('.html') && d.text)")); i++) await delay(50);
    const saved = await js("window.__downloads.find(d => d.name.endsWith('.html'))");
    assert.equal(saved.name, 'Counter.html');
    assert.ok(saved.text.includes('hello from app') && !saved.text.includes('Content-Security-Policy'), 'the saved file is the page as the bot wrote it');

    // Point mode: pick an element into a chip; Escape ends Point before full screen.
    await clickText('.bots-app-tools button', 'Point');
    assert.equal(await js("document.querySelector('.bots-app-point').getAttribute('aria-pressed')"), 'true');
    await delay(150);
    await inFrame("document.getElementById('b').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))");
    for (let i = 0; i < 60 && !(await js("import('/static/js/botsPoint.js').then(m => m.list().length)")); i++) await delay(50);
    const chips = await js("import('/static/js/botsPoint.js').then(m => m.list())");
    assert.equal(chips.length, 1, 'a pick becomes a chip');
    assert.deepEqual([chips[0].tag, chips[0].label, chips[0].messageId], ['button', 'Send', 'm1']);
    assert.equal(state().rpcs.length, 1, 'a click while pointing is a pick, not a button press');
    assert.equal(await js("document.querySelector('.bots-app-point').getAttribute('aria-pressed')"), 'false', 'Point ends after a pick');
    assert.equal(await js('window.__focusAsked'), 1, 'the composer is asked to take focus');
    // The chip row (as the composer draws it): a pill with the label and the tag, and a remove button.
    await js(`(async () => { const m = await import('/static/js/botsPoint.js'); const host = document.createElement('div'); host.id = 'chip-host'; host.dataset.appMode = 'bots'; host.style.cssText = 'position:fixed;right:0;bottom:0;z-index:901;background:var(--bg);padding:8px'; document.body.append(host); window.__chips = m.mountPointChips(host); })()`);
    assert.equal(await text('.bots-pointed-label'), 'Send');
    assert.equal(await text('.bots-pointed-tag'), '<button>');
    await click('.bots-pointed-x');
    await waitFor("document.querySelector('.bots-pointed').hidden === true");
    assert.equal(await js("import('/static/js/botsPoint.js').then(m => m.list().length)"), 0, 'remove clears the chip');
    await js("window.__chips.destroy(); document.getElementById('chip-host').remove()");
    // Escape while pointing ends Point first, and full screen second.
    await clickText('.bots-app-tools button', 'Point');
    await click('.bots-app-tools [aria-label="Full screen"]');
    await waitFor("document.querySelector('.bots-app').classList.contains('is-full')");
    const fullBox = await js("(() => { const r = document.querySelector('.bots-app').getBoundingClientRect(); return [Math.round(r.width) === innerWidth, Math.round(r.height) === innerHeight]; })()");
    assert.deepEqual(fullBox, [true, true], 'full screen fills the window');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
    await waitFor("document.querySelector('.bots-app-point').getAttribute('aria-pressed') === 'false'");
    assert.equal(await js("document.querySelector('.bots-app').classList.contains('is-full')"), true, 'the first Escape ended Point only');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
    await waitFor("!document.querySelector('.bots-app').classList.contains('is-full')");
    await waitLive();
    await clear();

    // Imported or bot-made words stay words.
    state().apps.m2 = { latest: 1, title: '<b>Bold</b> app', versions: [{ rev: 1, at: 1, html: '<p>hi</p>' }] };
    await draw({ id: 'm2', kind: 'app', ts: 1_800_000_010, app: { rev: 1, title: '<b>Bold</b> app' } }, { botName: '<i>Planner</i>' }, 700);
    await waitLive();
    assert.equal(await text('.bots-app-title'), '<b>Bold</b> app');
    assert.match(await text('.bots-app-origin'), /<i>Planner<\/i>/);
    assert.equal(await js("!document.querySelector('.bots-app b') && !document.querySelector('.bots-app i')"), true);
    await clear();

    // An unavailable page and its retry.
    state().apps.m3 = { latest: 1, title: 'Later', versions: [{ rev: 1, at: 1, html: APP_HTML }] };
    state().appFail = { status: 404, detail: 'There is no app with that id.' };
    await draw({ id: 'm3', kind: 'app', ts: 1_800_000_020, app: { rev: 1, title: 'Later' } }, {}, 700);
    await waitFor("!!document.querySelector('.bots-app[data-state=unavailable]')");
    assert.match(await text('.bots-app-stage'), /There is no app with that id/);
    state().appFail = null;
    await clickText('.bots-app-stage button', 'Try again');
    await waitLive();
    await clear();

    // At most three frames live at once: the oldest folds to "open again".
    for (const n of [1, 2, 3, 4]) state().apps[`p${n}`] = { latest: 1, title: `Page ${n}`, versions: [{ rev: 1, at: n, html: `<!doctype html><html><body><p>page ${n}</p></body></html>` }] };
    await js(`(async () => {
      const m = await import('/static/js/botsRichRows.js');
      const f = await import('/static/js/botsAppFrame.js');
      f.resetFramesForTest();
      const holder = document.createElement('div'); holder.id = 'rich-holder'; holder.dataset.appMode = 'bots';
      holder.style.cssText = 'position:fixed;left:0;top:0;bottom:0;overflow:auto;width:700px;z-index:900;background:var(--bg)';
      document.body.append(holder);
      for (const n of [1, 2, 3, 4]) holder.append(m.renderRichRow({ id: 'p' + n, kind: 'app', ts: 1_800_000_100 + n, app: { rev: 1, title: 'Page ' + n } }, { agentId: ${JSON.stringify(botId)}, sessionId: ${JSON.stringify(sid)}, botName: 'Planner' }));
    })()`);
    for (let i = 0; i < 100; i++) {
      const live = await js("document.querySelectorAll('.bots-app[data-state=live]').length");
      const folded = await js("document.querySelectorAll('.bots-app[data-state=collapsed]').length");
      if (live === 3 && folded === 1) break;
      // A row far down the holder opens only when it is near the screen: scroll each into view.
      await js("document.querySelectorAll('.bots-app').forEach(n => n.scrollIntoView())");
      await delay(100);
    }
    assert.equal(await js("document.querySelectorAll('.bots-app-frame').length"), 3, 'three frames at most');
    assert.equal(await js("document.querySelectorAll('.bots-app[data-state=collapsed]').length"), 1, 'the fourth folded the oldest');
    assert.match(await text('.bots-app[data-state=collapsed] .bots-app-stage'), /Open again/);
    await clear();

    // ===== A phone ===========================================================================================================
    await resize([390, 844]);
    state().widgets.ph = { rev: 1, refs: ['confirm'], settled: null };
    await draw({ id: 'ph', kind: 'widget', widget: { rev: 1, doc: { type: 'card', size: 'lg', title: 'On a phone', children: [{ type: 'Row', children: [{ type: 'Text', text: 'one' }, { type: 'Text', text: 'two' }] }, { type: 'Input', id: 'x', label: 'Name' }], confirm: { label: 'OK', ref: 'confirm' }, _refs: ['confirm'] }, settled: null } }, {}, 390);
    await waitFor("document.querySelector('.bots-widget').classList.contains('compact')");
    const phoneBox = await js("(() => { const w = document.querySelector('.bots-widget'); const h = document.getElementById('rich-holder'); return { fits: w.getBoundingClientRect().right <= innerWidth + 1, overflow: h.scrollWidth > h.clientWidth + 1 }; })()");
    assert.deepEqual(phoneBox, { fits: true, overflow: false }, 'a card fits a phone with no sideways scroll');
    await capture?.('phone-bots-widget');
    await clear();
    state().apps.pa = { latest: 1, title: 'Phone app', versions: [{ rev: 1, at: 1, html: APP_HTML }] };
    await draw({ id: 'pa', kind: 'app', ts: 1_800_000_200, app: { rev: 1, title: 'Phone app' } }, {}, 390);
    await waitLive();
    const phoneFrame = await js("(() => { const f = document.querySelector('.bots-app-frame').getBoundingClientRect(); return [Math.round(f.height), innerHeight]; })()");
    assert.ok(Math.abs(phoneFrame[0] - Math.min(720, Math.round(phoneFrame[1] * 0.7))) <= 2, `on a phone the frame is 70 percent of the screen (${phoneFrame})`);
    await capture?.('phone-bots-app');
    await clear();
    await resize(original);

    assert.deepEqual(await toastsClear(), [], 'no error toast');
  } finally {
    try { await clear(); } catch { /* the page may be gone */ }
    try { win.webContents.session.webRequest.onBeforeRequest(null); } catch { /* no filter set */ }
    try { frameServer?.close(); } catch { /* not started */ }
    try {
      await js(`(() => {
        if (window.__realFetch) window.fetch = window.__realFetch;
        if (window.__realAnchorClick) HTMLAnchorElement.prototype.click = window.__realAnchorClick;
        if (window.__realOpen) window.open = window.__realOpen;
        document.getElementById('chip-host')?.remove();
        import('/static/js/botsPoint.js').then(m => m.clearPointed());
      })()`);
    } catch { /* the page may be gone */ }
    try { win.setContentSize(original[0], original[1]); await delay(250); } catch { /* window closed */ }
    if (botId) { try { await call(`/api/agents/${botId}`, 'DELETE'); } catch { /* already removed */ } }
    delete demoState.botsWidgets;
    await restore();
  }
};
