// The Bots Inbox view (static/js/botsInbox.js) and the notification feed view
// (botsNotifications.js), driven in plain Node over a small stand-in DOM and a
// scripted server. Run: node scripts/test_bots_inbox.cjs
//   - Needs you / News / Done with counts; unread first; search
//   - opening an item marks it read (and nothing else)
//   - a reply needs text; an answer carries the revision the person saw
//   - a refused or stale answer keeps the item open and says why
//   - a question card sends complete answers only
//   - Mark done files it without answering
//   - Escape in the reading view goes back; Open in chat hands over the exact target
//   - the feed: unread count, filters, pinning, mark-all-read, open target
// The real drawer is clicked in scripts/bots-attention-checks.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// -- A stand-in DOM, enough for these views ---------------------------------------
class Node {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.listeners = {}; this._text = ''; this.value = ''; this.checked = false; this.disabled = false; this.parent = null; this.tabIndex = 0; }
  get classList() { const node = this; return { add: c => { const set = new Set((node.attrs.class || '').split(/\s+/).filter(Boolean)); set.add(c); node.attrs.class = [...set].join(' '); } }; }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set innerHTML(v) { const svg = new Node('svg'); this.children = [svg]; svg.parent = this; this._html = v; }
  get firstElementChild() { return this.children[0]; }
  append(...kids) { for (const kid of kids) { if (kid === null || kid === undefined) continue; if (typeof kid === 'string') { this.children.push(kid); continue; } kid.parent = this; this.children.push(kid); } }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'disabled') this.disabled = true; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { Node.focused = this; }
  click() { return this.fire('click'); }
  fire(type, extra = {}) { const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra }; for (let n = this; n; n = n.parent) { for (const fn of n.listeners[type] || []) fn(event); } return event; }
  all() { return this.children.flatMap(c => (typeof c === 'string' ? [] : [c, ...c.all()])); }
  has(cls) { return (this.attrs.class || '').split(/\s+/).includes(cls); }
  find(pred) { return this.all().find(pred); }
  filter(pred) { return this.all().filter(pred); }
  querySelector() { return null; }
  get dataset() { return new Proxy({}, { get: (_, k) => this.attrs[`data-${k}`], set: (_, k, v) => { this.attrs[`data-${k}`] = v; return true; } }); }
}
global.document = { createElement: tag => new Node(tag), hidden: false, addEventListener() {}, removeEventListener() {} };
global.matchMedia = () => ({ matches: false });
const timers = [];
const realSet = global.setInterval;
global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
global.clearInterval = () => {};
void realSet;

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const tick = () => new Promise(resolve => setImmediate(resolve));
const passed = [];
const named = async (name, fn) => { await fn(); passed.push(name); };

const row = (id, bucket, extra = {}) => ({
  id, source_id: id, bucket, kind: 'question', status: bucket === 'done' ? 'resolved' : 'open', subject: `Subject ${id}`, snippet: `Snippet ${id}`, body: `Body ${id}`,
  sender: { id: 'a1', name: 'Scout' }, at: Date.now() / 1000 - 120, read: false, done: bucket === 'done', revision: `rev-${id}`, questions: [],
  actions: ['reply', 'close'], target: { tab: 'botsShell', agentId: 'a1', sessionId: 's1', messageId: 'm1' }, ...extra,
});

function makeCtx(rows, args = {}) {
  const calls = [];
  const state = { rows, failNext: null };
  const ctx = {
    args, calls, state, counts: [], opened: [], closed: 0,
    get: async url => {
      calls.push(['GET', url]);
      if (url.endsWith('/inbox')) return { rows: state.rows, count: state.rows.filter(r => r.bucket === 'needs-you').length };
      if (url.endsWith('/notifications')) return { rows: state.feed, unread: state.feed.filter(r => !r.read).length };
      throw new Error('404: unknown');
    },
    post: async (url, body) => {
      calls.push(['POST', url, body]);
      if (state.failNext) { const error = state.failNext; state.failNext = null; throw error; }
      return { ok: true };
    },
    setCounts: counts => ctx.counts.push(counts), openTarget: target => { ctx.opened.push(target); return true; }, open: () => true, close: () => { ctx.closed += 1; },
    errorText: e => String(e.message).replace(/^\d+: /, ''),
  };
  return ctx;
}
const text = node => node.textContent;
const button = (root, label) => root.find(n => n.tag === 'button' && text(n).includes(label));
const posts = ctx => ctx.calls.filter(c => c[0] === 'POST');

(async () => {
  const Inbox = await load('js/botsInbox.js');
  const Feed = await load('js/botsNotifications.js');

  await named('Needs you, News and Done carry counts; the list shows the first bucket, unread first', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('item:1', 'needs-you', { read: true }), row('item:2', 'needs-you'), row('item:3', 'news', { kind: 'report', actions: ['reply', 'open'] }), row('item:4', 'done')]);
    const view = await Inbox.mount(root, ctx);
    const tabs = root.filter(n => n.attrs.role === 'radio').map(text);
    assert.deepEqual(tabs, ['Needs you 2', 'News 1', 'Done 1']);
    assert.deepEqual(root.filter(n => n.has('bots-attn-row')).map(n => n.attrs['data-id']), ['item:2', 'item:1'], 'unread first');
    assert.deepEqual(ctx.counts.at(-1), { inbox: 2 });
    root.find(n => n.attrs['data-value'] === 'news').click();
    assert.deepEqual(root.filter(n => n.has('bots-attn-row')).map(n => n.attrs['data-id']), ['item:3']);
    view.dispose();
  });

  await named('opening an item reads it and answers nothing', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('item:1', 'needs-you')]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click();
    await tick();
    assert.ok(root.find(n => n.has('bots-attn-read')), 'the reading view is open');
    assert.deepEqual(posts(ctx).map(c => c[1]), ['/api/bot-attention/inbox/item%3A1/read']);
    assert.ok(text(root).includes('Body item:1'));
  });

  await named('a reply needs text, then carries the revision the person saw', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('item:1', 'needs-you')]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    button(root, 'Send reply').click(); await tick();
    assert.equal(posts(ctx).filter(c => c[1].endsWith('/respond')).length, 0, 'an empty reply sends nothing');
    assert.ok(text(root).includes('Write a reply first.'));
    root.find(n => n.tag === 'textarea').value = 'Tuesday works';
    ctx.state.rows = [row('item:1', 'done', { status: 'resolved', answer: 'Tuesday works' })];
    button(root, 'Send reply').click(); await tick(); await tick();
    const sent = posts(ctx).find(c => c[1].endsWith('/respond'));
    assert.deepEqual(sent[2], { action: 'reply', expected_revision: 'rev-item:1', text: 'Tuesday works' });
    assert.ok(!root.find(n => n.has('bots-attn-read')), 'answered: back to the list');
  });

  await named('a refused answer keeps the item open, says why, and rereads the source', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('item:1', 'needs-you')]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    root.find(n => n.tag === 'textarea').value = 'Tuesday';
    ctx.state.failNext = new Error('409: That request is no longer available. Reload and try again.');
    const before = ctx.calls.filter(c => c[0] === 'GET').length;
    button(root, 'Send reply').click(); await tick(); await tick();
    assert.ok(root.find(n => n.has('bots-attn-read')), 'still open');
    assert.ok(text(root).includes('no longer available'));
    assert.equal(button(root, 'Send reply').disabled, false, 'it can be tried again');
    assert.ok(ctx.calls.filter(c => c[0] === 'GET').length > before, 'the inbox was reread');
    assert.equal(root.find(n => n.has('bots-attn-read')).find(n => n.attrs.role === 'alert')?.textContent.includes('no longer available'), true);
  });

  await named('an item that left the inbox is reported, not shown stale', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('item:1', 'needs-you')]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    root.find(n => n.tag === 'textarea').value = 'x';
    ctx.state.rows = [];
    ctx.state.failNext = new Error('409: gone');
    button(root, 'Send reply').click(); await tick(); await tick();
    assert.ok(!root.find(n => n.has('bots-attn-read')));
    assert.ok(text(root).includes('no longer in your inbox'));
  });

  await named('a review offers Approve and Request changes; Approve sends the approve action', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('review:c1', 'needs-you', { kind: 'review', actions: ['approve', 'reply', 'open'] })]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    assert.ok(button(root, 'Request changes'));
    button(root, 'Approve').click(); await tick();
    assert.deepEqual(posts(ctx).find(c => c[1].endsWith('/respond'))[2], { action: 'approve', expected_revision: 'rev-review:c1' });
  });

  await named('a permission request offers Allow once and Deny, never Approve', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('permission:p1', 'needs-you', { kind: 'approval', actions: ['allow', 'deny'] })]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    assert.ok(button(root, 'Allow once') && button(root, 'Deny'));
    assert.ok(!button(root, 'Approve') && !button(root, 'Send reply'));
  });

  await named('a question card sends complete answers only', async () => {
    const root = new Node('div');
    const questions = [{ question: 'Which slot?', header: '', multiSelect: false, options: [{ label: 'Tue', description: '' }, { label: 'Wed', description: '' }] }];
    const ctx = makeCtx([row('permission:q1', 'needs-you', { actions: ['respond', 'skip'], questions })]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    button(root, 'Send answers').click(); await tick();
    assert.equal(posts(ctx).filter(c => c[1].endsWith('/respond')).length, 0);
    assert.ok(text(root).includes('Answer every question first.'));
    const radio = root.find(n => n.tag === 'input' && n.attrs.type === 'radio' && n.attrs.value === 'Wed');
    radio.checked = true; radio.fire('change');
    button(root, 'Send answers').click(); await tick();
    assert.deepEqual(posts(ctx).find(c => c[1].endsWith('/respond'))[2], { action: 'respond', expected_revision: 'rev-permission:q1', answers: { 'Which slot?': 'Wed' } });
  });

  await named('Mark done files it and approves nothing', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('review:c1', 'needs-you', { kind: 'review', actions: ['approve', 'reply', 'open'] })]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    button(root, 'Mark done').click(); await tick(); await tick();
    const urls = posts(ctx).map(c => c[1]);
    assert.ok(urls.some(u => u.endsWith('/done')));
    assert.ok(!urls.some(u => u.endsWith('/respond')), 'Done never answers');
  });

  await named('Escape goes back; Open in chat hands over the exact target', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('item:1', 'needs-you')]);
    await Inbox.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    button(root, 'Open in chat').click();
    assert.deepEqual(ctx.opened, [{ tab: 'botsShell', agentId: 'a1', sessionId: 's1', messageId: 'm1' }]);
    const read = root.find(n => n.has('bots-attn-read'));
    const event = read.fire('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true, 'the reading view handled Escape, so the drawer stays open');
    assert.ok(!root.find(n => n.has('bots-attn-read')));
  });

  await named('the inbox can be narrowed to one bot', async () => {
    const root = new Node('div');
    const ctx = makeCtx([row('item:1', 'needs-you'), row('item:2', 'needs-you', { sender: { id: 'a2', name: 'Archivist' } })], { agentId: 'a2' });
    await Inbox.mount(root, ctx);
    assert.deepEqual(root.filter(n => n.has('bots-attn-row')).map(n => n.attrs['data-id']), ['item:2']);
  });

  // -- the feed ---------------------------------------------------------------------
  const note = (id, extra = {}) => ({ id, kind: 'question', agent_id: 'a1', title: `Alert ${id}`, body: '', at: Date.now() / 1000, read: false, pinned: false,
    target: { tab: 'botsShell', agentId: 'a1', sessionId: 's1', messageId: 'm' + id }, ...extra });

  await named('the feed shows the unread count, filters, and marks all read', async () => {
    const root = new Node('div');
    const ctx = makeCtx([]);
    ctx.state.feed = [note('n1'), note('n2', { read: true }), note('n3', { kind: 'turn-failed' })];
    await Feed.mount(root, ctx);
    assert.ok(text(root).includes('2 unread'));
    root.find(n => n.attrs['data-value'] === 'problems').click();
    assert.deepEqual(root.filter(n => n.has('bots-attn-row')).map(n => n.attrs['data-id']), ['n3']);
    root.find(n => n.attrs['data-value'] === 'all').click();
    button(root, 'Mark all read').click(); await tick();
    assert.ok(text(root).includes('All caught up'));
    assert.deepEqual(posts(ctx).map(c => c[1]), ['/api/bot-attention/notifications/read-all']);
    assert.deepEqual(ctx.counts.at(-1), { notifications: 0 });
  });

  await named('an alert opens its exact conversation and message, and reads itself', async () => {
    const root = new Node('div');
    const ctx = makeCtx([]);
    ctx.state.feed = [note('n7')];
    await Feed.mount(root, ctx);
    root.find(n => n.has('bots-attn-row')).click(); await tick();
    assert.deepEqual(ctx.opened, [{ tab: 'botsShell', agentId: 'a1', sessionId: 's1', messageId: 'mn7' }]);
    assert.deepEqual(posts(ctx).map(c => c[1]), ['/api/bot-attention/notifications/n7/read']);
  });

  await named('pinning moves an alert to the top and a failed pin rolls back', async () => {
    const root = new Node('div');
    const ctx = makeCtx([]);
    ctx.state.feed = [note('n1', { at: 300 }), note('n2', { at: 200 }), note('n3', { at: 100 })];
    await Feed.mount(root, ctx);
    const order = () => root.filter(n => n.has('bots-attn-row')).map(n => n.attrs['data-id']);
    assert.deepEqual(order(), ['n1', 'n2', 'n3']);
    root.filter(n => n.has('bots-attn-pin'))[2].click(); await tick();
    assert.deepEqual(order(), ['n3', 'n1', 'n2']);
    assert.deepEqual(posts(ctx).at(-1).slice(1), ['/api/bot-attention/notifications/n3/pin', { pinned: true }]);
    ctx.state.failNext = new Error('500: broke');
    root.filter(n => n.has('bots-attn-pin'))[2].click(); await tick(); await tick();
    assert.deepEqual(order(), ['n3', 'n1', 'n2'], 'a failed unpin changes nothing');
    assert.ok(text(root).includes('broke'));
  });

  console.log(`Bots inbox and feed views: ${passed.length} checks passed.`);
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
