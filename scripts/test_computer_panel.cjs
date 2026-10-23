// Plain-node regression for frames arriving during control requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    const classes = new Set();
    this.classList = {
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    };
  }
  replaceChildren(...children) { this.children = children; }
  addEventListener() {}
  focus() { this.focused = true; }
  remove() {}
}

async function check(initialControl) {
  const nodes = [], writes = [];
  let resolveRequest, stream;
  const context = vm.createContext({
    api(url, options) {
      writes.push({ url, method: options.method });
      return new Promise(resolve => { resolveRequest = resolve; });
    },
    el(tag, attrs = {}, children = []) {
      const node = new Element(tag);
      Object.assign(node, attrs);
      node.textContent = attrs.text || '';
      node.children = children;
      nodes.push(node);
      return node;
    },
    EventSource: class {
      constructor() { this.listeners = {}; stream = this; }
      addEventListener(type, handler) { this.listeners[type] = handler; }
      close() { this.closed = true; }
    },
    clearTimeout() {},
    toast() { assert.fail('Unexpected toast'); },
    openRecordingReview() { assert.fail('Unexpected recording review'); },
    openOwnerSteps() { assert.fail('Unexpected steps'); },
  });
  const source = fs.readFileSync(path.join(__dirname, '../static/js/computerPanel.js'), 'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  const panel = context.mountComputerPanel(new Element('host'), 'agent:a1', { taken_over: initialControl });
  const toggle = nodes.find(n => n.textContent === (initialControl ? 'Hand back' : 'Take over'));
  const state = nodes.find(n => n.class === 'computer-state');
  const stage = nodes.find(n => n.class === 'computer-stage');
  const next = !initialControl;
  const pending = toggle.onclick();
  assert.equal(toggle.disabled, true, 'request is pending');
  assert.deepEqual(writes, [{ url: `/api/computer/agent%3Aa1/${next ? 'takeover' : 'handback'}`, method: 'POST' }]);
  stream.listeners.frame({ data: JSON.stringify({ taken_over: next }) });
  resolveRequest({});
  await pending;
  assert.equal(panel.root.classList.contains('is-taken-over'), next, 'frame during request preserves control intent');
  assert.equal(state.textContent, next ? 'You have control.' : 'The model has control.');
  assert.equal(toggle.textContent, next ? 'Hand back' : 'Take over');
  assert.equal(toggle.disabled, false);
  assert.equal(!!stage.focused, next, 'taking over focuses the stage');
  panel.dispose();
  assert.equal(stream.closed, true);
}

(async () => {
  await check(false);
  await check(true);
  console.log('PASS: Take over and Hand back preserve intent when frames arrive during the request.');
})().catch(error => { console.error(error); process.exitCode = 1; });
