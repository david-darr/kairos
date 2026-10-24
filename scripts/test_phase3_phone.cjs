// Phone presentation regressions without Electron or a backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
if (!vm.SourceTextModule) {
  const run = require('node:child_process').spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
class Node {
  constructor(id = '', classes = '') {
    this.id = id; this.className = classes; this.dataset = {}; this.children = [];
    this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 300;
    const values = new Set(classes.split(' '));
    this.classList = { add: (...names) => names.forEach(n => values.add(n)), remove: (...names) => names.forEach(n => values.delete(n)), contains: n => values.has(n) };
  }
  append(...children) { this.children.push(...children); this.firstElementChild = this.children[0]; }
  prepend(child) { this.children.unshift(child); this.firstElementChild = child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  contains(node) { return node === this || this.children.includes(node); }
  matches(selector) { return selector === '.empty-state' && this.className === 'empty-state'; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    if (selector.startsWith('[id]')) return this.scrollers || [];
    if (selector.startsWith('.ms-conversation')) return this.pushes || [];
    if (selector === '.ms-header-row') return [];
    return [];
  }
  setAttribute() {}
}
(async () => {
  let enabled = true, current, mutation, frame;
  const handlers = {}, posts = [], observerCallbacks = [];
  const context = vm.createContext({
    document: { getElementById: id => id === 'view-content' ? current : new Node('app'), documentElement: { dataset: {} },
      addEventListener: (type, cb) => handlers[type] = cb, createElement: () => new Node() },
    MutationObserver: class { constructor(cb) { mutation = cb; observerCallbacks.push(cb); } observe() {} disconnect() {} },
    requestAnimationFrame: cb => { frame = cb; return 1; }, setTimeout, clearTimeout, console,
  });
  const make = (tag, attrs = {}, children = []) => { const node = new Node(); Object.assign(node, attrs); node.append(...children); return node; };
  let closed = 0, sheetContent;
  const stubs = {
    './mobileShared.js': { mobileOn: () => enabled, phone: { addEventListener() {} }, button: (label, action) => ({ label, action }), go: (tab, options) => posts.push([tab, options]) },
    './mobileActions.js': { openNotifications() {} },
    './api.js': { el: make }, './kairosParts.js': { pill: attrs => Object.assign(new Node(), attrs), emptyState: attrs => attrs },
    './mobileSheet.js': { openMobileSheet: ({ content }) => { sheetContent = content; return { close() { closed++; } }; } },
    './mobileActivity.js': { activityItems: () => ({ live: [], done: [] }) }, './icons.js': { ICONS: {} },
  };
  async function load(file) {
    const mod = new vm.SourceTextModule(fs.readFileSync('static/js/' + file, 'utf8'), { context });
    await mod.link(name => new vm.SyntheticModule(Object.keys(stubs[name]), function () { for (const [key, value] of Object.entries(stubs[name])) this.setExport(key, value); }, { context }));
    await mod.evaluate(); return mod.namespace;
  }
  const tick = () => { const cb = frame; frame = null; cb?.(); };
  const root = tab => { const n = new Node('view-content'); n.dataset.view = tab; n.append(new Node('', 'content')); return n; };
  current = root('calendar');
  (await load('mobilePhoneMotion.js')).mountPhoneMotion(); tick();
  assert.ok(current.classList.contains('rd-enter-rise'));
  current.scrollTop = 240; handlers.scroll({ target: current });
  current = root('agents'); mutation(); tick();
  const page = new Node('', 'agents-messenger'); current.pushes = [page]; mutation(); tick();
  assert.ok(page.classList.contains('rd-push-in'));
  handlers.animationend({ target: page, animationName: 'rd-push' });
  assert.equal(page.classList.contains('rd-push-in'), false, 'entrance releases transform for edge/back gestures');
  mutation(); tick(); assert.equal(page.classList.contains('rd-push-in'), false, 'live updates do not replay the page entrance');
  const conversation = new Node('', 'ms-conversation'); current.pushes = [conversation]; mutation(); tick();
  assert.ok(conversation.classList.contains('rd-push-in'));
  handlers.animationend({ target: conversation, animationName: 'ms-chat-reveal' });
  assert.equal(conversation.classList.contains('rd-push-in'), false, 'conversation clip reveal releases the entrance for back gestures');
  current = root('calendar'); current.scrollHeight = 300; mutation(); tick();
  assert.equal(current.scrollTop, 0, 'does not restore into a loading/short page');
  current.scrollHeight = 1000; mutation(); tick();
  assert.equal(current.scrollTop, 240, 'restores after async content can accommodate the saved scroll');
  enabled = false; current = root('tasks'); mutation(); tick();
  assert.equal(current.classList.contains('rd-enter-rise'), false, 'Classic/desktop stays unchanged');
  enabled = true;
  const actions = await load('mobileActions.js'); actions.openQuickCreate(new Node());
  assert.equal(sheetContent.children.length, 5);
  sheetContent.children[0].onClick();
  assert.equal(closed, 1); assert.equal(posts[0][0], 'chat');
  assert.equal(posts[0][1].mobileConversation, true, 'New chat delegates to the existing conversation route');
  enabled = false; actions.openQuickCreate(new Node()); assert.equal(closed, 1);
  console.log('PASS: phone entrances, deferred scroll restore, Classic gate, Quick create routing and close');
})().catch(error => { console.error(error); process.exitCode = 1; });
