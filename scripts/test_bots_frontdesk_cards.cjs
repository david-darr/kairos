const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// A deliberately small DOM: data may become text, never interpreted markup.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.parent = null; this._text = ''; this.props = {}; }
  get dataset() { return new Proxy({}, { get: (_, k) => this.attrs['data-' + k.replace(/[A-Z]/g, x => '-' + x.toLowerCase())], set: (_, k, v) => { this.attrs['data-' + k.replace(/[A-Z]/g, x => '-' + x.toLowerCase())] = String(v); return true; }, deleteProperty: (_, k) => { delete this.attrs['data-' + k]; return true; } }); }
  get style() { return { setProperty: (k, v) => { this.props[k] = v; }, removeProperty: k => delete this.props[k] }; }
  get classList() { return { add: c => this.attrs.class = `${this.attrs.class || ''} ${c}` }; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Untrusted HTML reached the DOM'); }
  append(...nodes) { for (const n of nodes.filter(Boolean)) { this.children.push(n); n.parent = this; } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  all() { return this.children.flatMap(n => [n, ...n.all()]); }
  querySelectorAll(selector) { return this.all().filter(n => selector === 'button' ? n.tagName === 'button' : selector.startsWith('.') ? (n.attrs.class || '').split(' ').includes(selector.slice(1)) : n.tagName === selector); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] || []).filter(f => f !== fn); }
  click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({ target: this }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  closest() { return null; }
  getBoundingClientRect() { return { width: 300 }; }
}
global.document = { createElement: tag => new Element(tag), querySelectorAll: () => [], head: new Element('head'), dispatchEvent() {} };
global.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const { renderFrontDeskCard: render } = await import(pathToFileURL(path.join(__dirname, '../static/js/botsFrontDeskCards.js')));
  const calls = [], nav = [], cards = [];
  let fail = false, pending;
  const api = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null, method: options.method || 'GET' });
    if (fail) throw new Error('Try again later');
    if (pending) await pending;
    if (url === '/api/front-desk/work') return { groups: { ready_for_review: [{ id: 't1', title: 'Report ready' }] } };
    if (url === '/api/forge/sessions') return { id: 'forge1' };
    if (url.endsWith('/state')) return { active_leaf_id: 'leaf', branch_revision: 3 };
    return { thread_id: 'task-thread' };
  };
  const make = (kind, data = {}, extra = {}, context = {}) => { const node = render({ id: kind, type: 'fd_card', fd_kind: kind, fd_data: data, ...extra }, { api, navigate: x => nav.push(x), agent: { id: 'kip', name: 'Kip' }, sessionId: 'main', ...context }); if (node) cards.push(node); return node; };
  const find = (node, label) => node.querySelectorAll('button').find(b => b.textContent === label);
  assert.equal(render({ type: 'fd_card', fd_kind: 'unknown' }), null);
  assert.equal(render({ type: 'message', fd_kind: 'brief' }), null);
  const poison = '<img src=x onerror=alert(1)>';
  const brief = make('brief', { greeting: poison, sections: [{ id: 'day', label: 'Your day', rows: [{ id: 'e', text: poison, actions: [{ kind: 'open_url', label: 'Unsafe', arg: 'javascript:alert(1)' }, { kind: 'open_url', label: 'Join', arg: 'https://example.com' }] }] }, { id: 'needs', label: 'Needs you', rows: [{ id: 'mail/one', text: poison, actions: [{ kind: 'dismiss', label: 'Dismiss' }, { kind: 'draft', label: 'Draft' }] }] }] });
  assert.ok(brief.textContent.includes(poison)); assert.equal(brief.querySelectorAll('img').length, 0);
  assert.deepEqual(brief.querySelectorAll('section').map(s => s.dataset.section), ['needs', 'day']);
  assert.equal(brief.querySelectorAll('a').length, 1); assert.equal(brief.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  find(brief, 'Draft').click(); await tick(); assert.equal(calls.at(-1).url, '/api/front-desk/brief/rows/mail%2Fone/draft');
  const dismiss = make('brief', { sections: [{ id: 'needs', rows: [{ id: 'm', text: 'Mail', actions: [{ kind: 'dismiss', label: 'Dismiss' }] }] }] });
  find(dismiss, 'Dismiss').click(); await tick(); assert.equal(dismiss.querySelectorAll('.fd-brief-row').length, 0);
  for (const kind of ['prep', 'reminder']) {
    const node = make(kind, { title: poison, lines: [poison], join_url: 'https://user:pw@example.com' });
    assert.equal(node.querySelectorAll('a').length, 0); assert.ok(node.textContent.includes(poison));
  }
  const suggestion = make('suggestion', { suggestion_id: 's1', title: poison, detail: 'A detail', source_label: 'Mail' });
  let release; pending = new Promise(resolve => { release = resolve; });
  const before = calls.length; find(suggestion, 'Start').click(); find(suggestion, 'Start').click(); find(suggestion, 'Hide').click();
  assert.equal(calls.length, before + 1); release(); pending = null; await tick(); assert.equal(suggestion.dataset.status, 'started');
  const hidden = make('suggestion', { suggestion_id: 's2' }); find(hidden, 'Hide').click(); await tick(); assert.equal(hidden.dataset.status, 'hidden');
  const failure = make('suggestion', { suggestion_id: 's3' }); fail = true; find(failure, 'Start').click(); await tick();
  assert.equal(failure.dataset.status, 'open'); assert.equal(find(failure, 'Start').disabled, false); assert.equal(failure.querySelector('.fd-card-error').hidden, false);
  fail = false; find(failure, 'Start').click(); await tick(); assert.equal(failure.dataset.status, 'started');
  const task = make('task_link', { task_id: 't1' }); await tick(); assert.ok(task.textContent.includes('Ready for review')); assert.ok(task.textContent.includes('Report ready'));
  find(task, 'Report ready').click(); await tick(); assert.equal(nav.at(-1).sessionId, 'task-thread');
  make('make', { task_id: 't1', kind: 'slides' });
  const route = make('route', { bot_id: 'other', bot_name: 'Sam', card_id: 'c' }); find(route, 'Passed to Sam').click(); await tick(); assert.equal(nav.at(-1).agentId, 'other');
  const forge = make('forge', { project_id: 'p1', task: 'Fix it', project_name: poison }); find(forge, 'Start').click(); await tick();
  assert.deepEqual(calls.find(c => c.url === '/api/forge/sessions').body, { project_id: 'p1', task: 'Fix it' }); assert.equal(nav.at(-1).tab, 'forge');
  const oldChips = make('chips', { options: ['No'] }); assert.equal(find(oldChips, 'No').disabled, true);
  const chips = make('chips', { options: ['Do this'] }, {}, { isLatestTurn: true }); find(chips, 'Do this').click(); await tick();
  const sent = calls.find(c => c.url === '/api/bot-chat/main/send'); assert.equal(sent.body.text, 'Do this'); assert.equal(sent.body.expected_revision, 3);
  const count = calls.length; find(chips, 'Do this').click(); await tick(); assert.equal(calls.length, count);
  assert.equal(make('checkin', { at: 0, summary: 'Checked for you' }).querySelectorAll('button').length, 0);
  for (const kind of ['welcome', 'reach']) assert.ok(make(kind).textContent.length > 0);
  assert.ok(!make('welcome').attrs.class.includes('fd-build'), 'history never animates');
  const held = make('forge', { task: 'Work' }, {}, { streaming: true, history: false }); assert.equal(held.hidden, true); held.release(); assert.equal(held.hidden, false);
  for (const node of cards) node.dispose();
  console.log('PASS: every card kind, safe text and links, live task status, actions, failures, duplicate taps, chips and held cards');
})().catch(e => { console.error(e); process.exitCode = 1; });
