// Exercise the real Git panel and el() event binding without a renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.value = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { const list = this.listeners.get(name) || []; list.push(handler); this.listeners.set(name, list); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(value => value !== handler)); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName?.toLowerCase() === tag ? [child] : []), ...(child.querySelectorAll?.(tag) || [])]); }
  querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
  dispatchEvent(event) {
    for (const handler of this.listeners.get(event.type) || []) handler(event);
    this['on' + event.type]?.(event);
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
}

async function harness({ staged = false, failCommit = false } = {}) {
  const writes = [], reads = [], approvals = [], timers = [];
  const panel = new Element('section');
  const document = new Element('document');
  document.createElement = tag => new Element(tag);
  document.createTextNode = text => ({ textContent: text });
  const state = { branch: 'topic', branches: ['topic'], ahead: 0, behind: 0, files: [{ path: 'app.js', staged, unstaged: !staged }] };
  const context = vm.createContext({ document, AbortController, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {},
    forgeRunning: () => false,
    customSelect: () => { const select = new Element('div'); select.appendChild(new Element('button')); return select; },
    permissionAction: async (url, options) => { approvals.push({ url, body: options.body }); },
    api: async (url, options = {}) => {
      if (!options.method) { reads.push(url); return state; }
      const body = JSON.parse(options.body); writes.push({ url, body });
      if (body.action === 'commit') {
        if (failCommit) throw new Error('400: Commit rejected for fixture');
        state.files = [];
      }
      return state;
    },
  });
  const apiSource = fs.readFileSync(path.join(root, 'static/js/api.js'), 'utf8');
  const elSource = apiSource.slice(apiSource.indexOf('export function el('), apiSource.indexOf('// -- confirm dialog'));
  vm.runInContext(elSource.replace('export function', 'function'), context);
  const source = fs.readFileSync(process.argv[2] || path.join(root, 'static/js/forgeGitPanel.js'), 'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  const release = context.mountGitPanel(panel, 'session with spaces');
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await flush();
  return { panel, document, writes, reads, approvals, timers, release, flush,
    button: text => panel.querySelectorAll('button').find(node => node.textContent === text),
    input: (tag, value) => { const node = panel.querySelector(tag); node.value = value; node.dispatchEvent({ type: 'input' }); return node; },
  };
}

(async () => {
  for (const staged of [false, true]) {
    const h = await harness({ staged });
    const label = staged ? 'Commit staged files' : 'Commit all changes';
    assert.equal(h.button(label).disabled, true, 'Empty message cannot commit');
    h.input('textarea', 'Mobile redesign\n\nPreserve iOS sources.');
    h.button(label).click(); h.button(label).click();
    await h.flush();
    assert.equal(h.writes.length, 1, 'One click sends one request; busy clicks do not duplicate it');
    assert.deepEqual(h.writes[0].body, { action: 'commit', message: 'Mobile redesign\n\nPreserve iOS sources.' });
    assert.ok(h.writes[0].url.includes('session%20with%20spaces'));
    assert.equal(h.panel.querySelector('textarea').value, '', 'Successful commit clears the draft');
    h.release();
  }
  {
    const h = await harness({ failCommit: true });
    h.input('textarea', 'Keep this draft'); h.button('Commit all changes').click(); await h.flush();
    assert.equal(h.panel.querySelector('textarea').value, 'Keep this draft', 'Failed commit retains the message');
    assert.equal(h.panel.children[0].textContent, 'Commit rejected for fixture');
    h.release();
  }
  {
    const h = await harness();
    h.input('input', 'feature/mobile'); h.button('Create branch').click(); await h.flush();
    assert.deepEqual(h.writes.map(write => write.body), [{ action: 'create-branch', branch: 'feature/mobile' }]);
    assert.equal(h.panel.querySelector('input').value, '');
    h.release();
  }
  {
    const h = await harness();
    h.input('textarea', 'Draft survives refresh');
    const before = h.reads.length;
    h.button('Refresh').click(); await h.flush();
    assert.equal(h.reads.length, before + 1);
    assert.equal(h.writes.length, 0, 'Refresh never submits a Git mutation');
    assert.equal(h.panel.querySelector('textarea').value, 'Draft survives refresh');
    h.button('Stage all').click(); await h.flush();
    assert.deepEqual(h.writes.map(write => write.body), [{ action: 'stage' }]);
    h.button('Merge back').click(); await h.flush();
    assert.equal(h.approvals.length, 1, 'Merge still uses the approval flow');
    assert.equal(h.approvals[0].body.action, 'merge');
    h.release();
  }
  console.log('Forge Git panel checks pass: commit messages, duplicate clicks, retry drafts, branch names, refresh, staging, and merge approval.');
})().catch(error => { console.error(error); process.exitCode = 1; });
