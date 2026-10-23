// Plain Node regression for Settings disappearing during a layout rebuild.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor() { this.children = []; this.className = ''; this.classList = { add() {}, toggle() {} }; this.style = {}; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  set innerHTML(value) { this.replaceChildren(); }
  setAttribute() {}
  addEventListener() {}
}
(async () => {
  const footer = new Element(), existing = new Element();
  footer.append(existing);
  let resolveAuth;
  const context = vm.createContext({
    document: { getElementById: () => footer, createElement: () => new Element(), addEventListener() {} },
    api: () => new Promise(resolve => { resolveAuth = resolve; }),
    navigator: { userAgent: 'Desktop' }, ICONS: {}, openSettings() {},
  });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');
  const start = source.indexOf('async function buildSidebarFooter()');
  const end = source.indexOf('// Shared by the sidebar gear', start);
  vm.runInContext(source.slice(start, end), context);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = footer.children[0];
    const rebuild = context.buildSidebarFooter();
    assert.equal(footer.children[0], before, 'footer stays mounted while auth is pending');
    resolveAuth({ username: 'local', auth_enabled: false });
    await rebuild;
    assert.equal(footer.children.length, 1, 'rebuild replaces the previous row');
    assert.ok(footer.children[0].children.some(node => node.className === 'sidebar-settings-btn'), 'Settings survives each rebuild');
  }
  console.log('PASS: sidebar Settings remains available through deferred auth and repeated footer rebuilds');
})().catch(error => { console.error(error); process.exitCode = 1; });
