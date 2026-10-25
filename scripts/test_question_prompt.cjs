const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag; this.attrs = attrs; this.children = []; this.handlers = {}; this.disabled = !!attrs.disabled;
    this.value = ''; this.checked = false; this.isConnected = true; this.hidden = !!attrs.hidden;
    this.textContent = attrs.text || ''; this.append(...children);
  }
  append(...nodes) { for (const node of nodes.filter(Boolean)) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  contains(node) { return node === this || this.children.some(n => n.contains(node)); }
  matches() { return this.tagName === 'input'; }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(selector.split(', ').includes(n.tagName) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  fire(name, extra = {}) { return this.handlers[name]?.({ preventDefault() {}, ...extra }); }
}
const document = { activeElement: null, body: new Node('body'), handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
const posts = [];
const context = vm.createContext({ document, matchMedia: () => ({ matches: false }), Date, Set, Object, encodeURIComponent, setTimeout, clearTimeout,
  el: (tag, attrs, children) => new Node(tag, attrs, children), ICONS: { close: '' }, api: async (path, options) => posts.push([path, JSON.parse(options.body)]) });
let code = fs.readFileSync('static/js/questionPrompt.js', 'utf8').replace(/^import .*$/gm, '').replaceAll('export function ', 'function ');
vm.runInContext(code + '\nglobalThis.show = showQuestionPrompt; globalThis.dismiss = dismissQuestionPrompt;', context);
const request = { id: 'q', questions: [
  { question: '<img>Q', header: '<b>Title</b>', options: [{ label: '<script>Yes</script>' }], multiSelect: false },
  { question: 'Widgets?', options: [{ label: 'Tasks' }], multiSelect: true },
] };
(async () => {
  const dock = new Node('div');
  const typing = new Node('input'); document.activeElement = typing;
  const card = context.show(request, null, { dock });
  assert.equal(document.activeElement, typing, 'typing keeps focus');
  assert.equal(dock.hidden, false);
  const [skip, submit] = card.querySelectorAll('button');
  assert.equal(submit.disabled, true);
  const inputs = card.querySelectorAll('input');
  assert.deepEqual(inputs.filter(n => n.attrs.type !== 'text').map(n => n.attrs['aria-label']),
    ['<script>Yes</script>', 'Other', 'Tasks', 'Other']);
  inputs[0].checked = true; inputs[0].fire('change');
  inputs[5].value = 'Calendar'; inputs[5].fire('input');
  assert.equal(submit.disabled, false);
  await submit.fire('click'); await new Promise(setImmediate);
  assert.deepEqual(posts.pop(), ['/api/permissions/q/respond', { answers: { '<img>Q': '<script>Yes</script>', 'Widgets?': ['Calendar'] } }]);
  assert.equal(dock.hidden, true);
  const again = context.show(request, null, { dock });
  await again.querySelectorAll('button')[0].fire('click'); await new Promise(setImmediate);
  assert.deepEqual(posts.pop(), ['/api/permissions/q/respond', { skip: true }]);
  context.show(request, null, { dock });
  document.handlers['kairos:permission-closed']({detail:{id:'q'}});
  assert.equal(dock.hidden, true);
  assert.equal(card.querySelectorAll('img, script, b').length, 0);
  const free = context.show({id:'free',questions:[{question:'Tell me',options:[],multiSelect:false}]}, null, {dock});
  const input = free.querySelector('input'); input.value = 'My answer'; input.fire('input');
  await input.fire('keydown', {key:'Enter'}); await new Promise(setImmediate);
  assert.deepEqual(posts.pop(), ['/api/permissions/free/respond', {answers:{'Tell me':'My answer'}}]);
  context.show(request);
  const dialog = document.body.children.at(-1);
  dialog.fire('cancel'); await new Promise(setImmediate);
  assert.deepEqual(posts.pop(), ['/api/permissions/q/respond', {skip:true}]);
  const expired = context.show({...request,expires_at:Date.now()/1000-.1}, null, {dock});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(expired.querySelectorAll('input, button').every(n => n.disabled));
  assert.equal(expired.querySelectorAll('p')[0].textContent, 'This question has expired.');
  context.dismiss();
  console.log('question prompt checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
