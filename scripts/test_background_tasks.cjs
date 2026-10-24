// Exercise the background UI with literal model output and repeated notes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.scrollHeight = 200; this.scrollTop = 0; this.clientHeight = 20; this.isConnected = true; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return (this.value || '') + this.children.map(c => c.textContent).join(''); }
  append(...nodes) { for (const n of nodes) { n.parent?.remove(n); n.parent = this; this.children.push(n); } }
  prepend(n) { this.append(n); this.remove(n); this.children.unshift(n); }
  insertAdjacentHTML() {}
  remove(n) { this.children = this.children.filter(c => c !== n); }
  replaceChildren(...nodes) { this.children = []; this.value = ''; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, v) { this.listeners[k] = v; }
  removeEventListener() {}
  click() { this.listeners.click?.(); }
  focus() {}
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  get parentElement() { return this.parent; }
  matches(s) {
    if (s.startsWith('.')) return (this.className || '').split(' ').includes(s.slice(1));
    if (s.startsWith('[data-bg-note=')) return this.dataset.bgNote === s.slice(15, -2);
    return s === this.tagName;
  }
  closest(s) { return this.matches(s) ? this : this.parent?.closest(s); }
  querySelectorAll(s) { return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  insertBefore(n, after) { this.append(n); if (after) { this.remove(n); this.children.splice(this.children.indexOf(after), 0, n); } }
}
(async () => {
  global.document = new Element('document'); document.createElement = tag => new Element(tag);
  global.CSS = { escape: s => s }; global.matchMedia = () => ({ matches: phone });
  const interval = global.setInterval; global.setInterval = () => 1; global.clearInterval = () => {};
  let phone = false, sheet;
  global.openMobileSheet = ({ content }) => { sheet = new Element('dialog'); sheet.className = 'ms-sheet'; sheet.classList = { add() {} }; sheet.append(content); return { dialog: sheet, close() {} }; };
  const item = { id: 'card:one', kind: 'agent', status: 'done', label: '<img src=x onerror=alert(1)>', endedAt: 20 };
  const details = { item, prompt: 'A prose prompt', steps: [{ name: 'Read', text: 'core/brain.py', kind: 'tool' }],
    summary: 'A prose result', command: 'echo test', output: 'test output', outputTruncated: false,
    timeline: [{ name: 'Grep', detail: 'TODO' }], lines: ['log entry'], usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 12000 } };
  const notes = [20, 10].map(at => ({ ...item, at }));
  global.api = async url => url.endsWith('/card%3Aone') ? details : { items: [item], notes };
  let code = fs.readFileSync(path.join(__dirname, '../static/js/backgroundTasks.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const { mountBackgroundTasks } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const host = new Element('div'), messages = new Element('div');
  const card = at => { const n = new Element('article'); n.dataset.ts = String(at); return n; };
  messages.append(card(5), card(25));
  const ui = mountBackgroundTasks({ host, messages, getSessionId: () => 'sid' });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  ui.setSession('sid'); await flush();
  assert.equal(messages.children.length, 3, 'Historical run sits between two cards');
  assert.deepEqual(messages.children[1].children.map(n => n.dataset.ts), ['10', '20'], 'Out-of-order historical notes stay chronological');
  assert.equal(messages.children[1].attrs.role, 'note');
  assert(messages.children[1].children.every(n => n.tagName === 'button' && n.dataset.bgNote), 'Available notes remain keyboard reachable buttons with identifiers');
  await document.listeners['kairos:live-snapshot'](); await flush();
  assert.equal(messages.querySelectorAll('.bg-task-note').length, 2, 'Refetch does not duplicate notes');
  const packet = notes => document.listeners['kairos:bg-tasks']({ detail: { sessionId: 'sid', items: [item], notes } });
  packet([{ ...item, at: 30 }]);
  assert.equal(messages.children.length, 4, 'Live note after a card starts a new run');
  packet([{ ...item, at: 40 }]);
  assert.deepEqual(messages.children[3].children.map(n => n.dataset.ts), ['30', '40'], 'Live append joins the last run');
  messages.append(card(50), card(70));
  notes.push({ ...item, id: 'missing', at: 60 });
  await document.listeners['kairos:live-snapshot'](); await flush();
  assert.equal(messages.children[5].className, 'bg-task-notes', 'A historical note between cards forms its own run');
  assert.equal(messages.children[5].children[0].attrs.role, 'note', 'Unavailable note retains note semantics');
  assert.equal(messages.children[5].children[0].dataset.ts, '60');
  host.querySelector('.bg-tasks-pill').click();
  assert.equal(host.querySelectorAll('.bg-tasks-heading').length, 1);
  host.querySelector('.bg-task-row').click(); await flush();
  assert.deepEqual(host.querySelectorAll('h4').map(n => n.textContent), ['Prompt', 'Steps', 'Result', 'Command', 'Output', 'Timeline', 'Log']);
  assert.equal(host.querySelector('.bg-task-prompt').tagName, 'div');
  assert.equal(host.querySelector('.bg-task-prose').tagName, 'div');
  assert.equal(host.querySelector('.bg-task-usage').textContent, '1,234 tokens · 3 tool uses · 12s');
  assert.equal(host.querySelector('.bg-task-output-note'), null, 'Small output has no truncation warning');
  assert(host.querySelectorAll('pre').every(n => n.scrollTop === n.scrollHeight), 'Code boxes start at the bottom');
  assert.equal(host.querySelectorAll('img').length, 0);
  details.outputTruncated = true;
  const back = host.querySelector('.bg-task-back'); back.click();
  document.listeners.click({ target: back, composedPath: () => [back, host] });
  assert.equal(host.querySelector('.bg-tasks-panel').hidden, false, 'Back remains inside the panel after replacing its DOM');
  host.querySelector('.bg-task-row').click(); await flush();
  assert.equal(host.querySelector('.bg-task-output-note').textContent, 'Showing the last 16 KB');
  ui.dispose(); phone = true;
  const mobile = mountBackgroundTasks({ host, messages: new Element('div'), getSessionId: () => 'sid' });
  // open() checks the shell's appearance class via document.querySelector.
  const shell = new Element('html'); shell.className = 'kairos-redesign'; document.append(shell);
  mobile.setSession('sid'); await flush(); host.querySelector('.bg-tasks-pill').click();
  assert(sheet.querySelector('.bg-tasks-list'), 'Phone sheet has the list');
  assert.equal(sheet.querySelector('.bg-tasks-heading'), null, 'Phone list has no duplicate title');
  mobile.dispose(); global.setInterval = interval;
  const el = (tag, attrs = {}, children = []) => {
    const n = new Element(tag); n.className = attrs.class || '';
    if (attrs.text) n.textContent = attrs.text;
    n.append(...children); return n;
  };
  const context = { el, activeSessionId: 'sid', id: 'sid', states: new Map(), backdrop: null, options: {}, renderAgentHandoff: () => null,
    renderMessageBody: (n, text) => { n.textContent = text; }, ICON_COPY: '', KAIROS_MARK: '',
    // Reply cards now carry Kip in the author row (phone Chats fidelity).
    createMascot: () => new Element('kairos-mascot') };
  const chat = fs.readFileSync(path.join(__dirname, '../static/js/views/chat.js'), 'utf8');
  const chatCard = vm.runInNewContext(chat.match(/function messageCard\([\s\S]*?\n\}/)[0] + '; messageCard', context);
  const forge = fs.readFileSync(path.join(__dirname, '../static/js/forgeTranscript.js'), 'utf8');
  const forgeCard = vm.runInNewContext(forge.slice(forge.indexOf('  function card('), forge.indexOf('  function setBusy(')) + '; card', context);
  for (const card of [msg => chatCard('assistant', 'Reply', 1, 'complete', [], msg), msg => forgeCard('assistant', 'Reply', msg)]) {
    assert.equal(card({ background_followup: true }).querySelector('.bg-followup-caption').textContent, 'After background work');
    assert.equal(card({}).querySelector('.bg-followup-caption'), null, 'Ordinary replies have no follow-up caption');
  }
  console.log('PASS: detail headings, prose, usage, truncation, scroll, literal output, repeated notes and phone title');
})().catch(error => { console.error(error); process.exitCode = 1; });
