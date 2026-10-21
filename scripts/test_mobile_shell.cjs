// Pure gesture/routing checks. No browser, network, account or Electron needed.
// node --experimental-vm-modules scripts/test_mobile_shell.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
if (!vm.SourceTextModule) {
  const r = require('node:child_process').spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

class Surface {
  constructor() {
    this.handlers = new Map(); this.attrs = {}; this.clientWidth = 390;
    this.values = {}; this.style = { setProperty: (k, v) => { this.values[k] = v; } };
    const classes = new Set();
    this.classList = { add: (...vs) => vs.forEach(v => classes.add(v)), remove: (...vs) => vs.forEach(v => classes.delete(v)),
      contains: v => classes.has(v), toggle: (v, force) => { const on = force ?? !classes.has(v); on ? classes.add(v) : classes.delete(v); return on; } };
    this.style.removeProperty = k => { delete this.values[k]; };
    this.style.getPropertyValue = k => this.values[k] || '';
    this.contains = () => false;
  }
  addEventListener(type, action) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(action); }
  removeEventListener(type, action) { this.handlers.get(type)?.delete(action); }
  setAttribute(key, value) { this.attrs[key] = value; }
  focus() {}
  emit(type, event = {}) { for (const action of this.handlers.get(type) || []) action(event); }
}

(async () => {
  let enabled = true, modal = false;
  const reduced = Object.assign(new Surface(), { matches: false });
  const context = vm.createContext({
    document: { querySelector: () => modal, activeElement: {} },
    window: { getSelection: () => ({ isCollapsed: true }) },
    innerWidth: 390, performance: { now: () => 1000 }, setTimeout: action => action(),
  });
  const shared = { mobileOn: () => enabled, reduced, haptic() {}, phone: new Surface(), go() {},
    button(label, action, className = 'ms-glass') { const node = context.document.createElement('button'); node.textContent = label; node.className = className; node.addEventListener('click', action); return node; }, edgeBlur() {} };
  const stubs = {
    './mobileShared.js': shared,
    './api.js': { api: async () => ({ providers: [] }), el(tag, attrs = {}, children = []) {
      const node = context.document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') { node.textContent = value; const text = context.document.createElement('#text'); text.textContent = value; node.append(text); }
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'value') node.value = value;
        else node.setAttribute(key, value);
      }
      node.append(...children); return node;
    } }, './brand.js': { ICON: '' }, './icons.js': { ICONS: {} },
    './mobileHistory.js': { mountHistory() {} },
    './mobileTabSheet.js': { openTabSheet() {}, initTabSheet() {} },
    './mobileActivity.js': { initActivity() {}, attachActivity() {}, activityMetadata() {}, refreshActivity() {} },
  };
  const cache = new Map();
  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    let mod;
    if (stubs[name]) {
      const values = stubs[name];
      mod = new vm.SyntheticModule(Object.keys(values), function () { for (const key of Object.keys(values)) this.setExport(key, values[key]); }, { context });
    } else {
      mod = new vm.SourceTextModule(fs.readFileSync(path.join(__dirname, '../static/js', name), 'utf8'), { context });
    }
    cache.set(name, mod); await mod.link(load); await mod.evaluate(); return mod;
  }
  const { mountPager } = (await load('./mobilePager.js')).namespace;
  const { phoneRoute } = (await load('./mobileShell.js')).namespace;
  assert.equal(phoneRoute('chat', {}).tab, 'home');
  assert.equal(phoneRoute('chat', {}).options.mobilePage, 1);
  assert.equal(phoneRoute('chat', { mobileNew: true }).options.mobilePage, 0);
  for (const options of [{ sessionId: 's1' }, { projectId: 'p1' }, { mobileConversation: true }]) assert.equal(phoneRoute('chat', options).tab, 'chat');
  enabled = false;
  assert.equal(phoneRoute('chat', {}).tab, 'chat', 'Desktop and legacy routing stays unchanged');
  enabled = true;

  const host = new Surface(), pages = [new Surface(), new Surface()], tabs = [new Surface(), new Surface()];
  const pager = mountPager(host, pages, tabs);
  const target = { closest: () => null };
  function swipe(x, y, dx, dy, atTarget = target, cancelled = false) {
    const event = (px, py) => ({ target: atTarget, touches: [{ clientX: px, clientY: py }], cancelable: true, preventDefault() { this.prevented = true; } });
    host.emit('touchstart', event(x, y));
    const move = event(x + dx, y + dy); host.emit('touchmove', move);
    const progress = host.values['--ms-page'];
    host.emit(cancelled ? 'touchcancel' : 'touchend', {});
    return { move, progress };
  }
  assert.equal(pages[1].inert, true, 'Off-page controls cannot receive focus');
  let result = swipe(300, 200, -100, 2);
  assert.ok(result.progress > 0 && result.progress < 1, 'Thumb follows drag progress');
  assert.equal(host.values['--ms-page'], 1);
  assert.equal(tabs[1].attrs['aria-selected'], 'true');
  assert.equal(pages[0].inert, true);
  swipe(80, 200, 100, 0);
  assert.equal(host.values['--ms-page'], 1, 'Existing left drawer keeps its rightward zone');
  const row = { closest: selector => selector === 'button' || selector === '.ms-history-main' ? {} : null };
  swipe(300, 200, 100, 0, row);
  assert.equal(host.values['--ms-page'], 0, 'A rightward row swipe outside the drawer zone returns to New');
  swipe(300, 200, -100, 150);
  assert.equal(host.values['--ms-page'], 0, 'Vertical scrolling never switches pages');
  swipe(300, 200, -100, 0, target, true);
  assert.equal(host.values['--ms-page'], 0, 'Touch cancellation restores the selected page');
  modal = true; swipe(300, 200, -100, 0);
  assert.equal(host.values['--ms-page'], 0, 'Sheets and permission dialogs own their gestures'); modal = false;
  reduced.matches = true;
  result = swipe(300, 200, -100, 0);
  assert.equal(result.progress, 0, 'Reduced motion has no interactive slide');
  assert.equal(host.values['--ms-page'], 1, 'Reduced motion still switches instantly at release');
  let prevented = false;
  tabs[1].emit('keydown', { key: 'Home', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(host.values['--ms-page'], 0);
  pager.dispose();
  assert.ok([...host.handlers.values()].every(actions => actions.size === 0), 'View disposal removes gesture handlers');
  // A4-A7 use DOM doubles so listener identity, reparenting and cleanup are
  // exercised without Electron. The visual verifier still checks geometry.
  const mutationObservers = [];
  context.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.active = false; mutationObservers.push(this); }
    observe() { this.active = true; } disconnect() { this.active = false; }
  };
  context.requestAnimationFrame = callback => { callback(); return 1; }; context.cancelAnimationFrame = () => {};
  context.setInterval = () => 1; context.clearInterval = () => {};
  context.Event = class { constructor(type) { this.type = type; } };
  context.innerHeight = 844;
  const doc = new Surface(); doc.activeElement = null;
  class Element extends Surface {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.hidden = false; this.disabled = false; this.tabIndex = 0; this.dataset = {}; this.value = ''; this.scrollHeight = 100; this.placeholder = ''; this.textContent = ''; this.isRoot = false;
      this.contains = node => this === node || this.children.some(child => child.contains(node)); }
    get isConnected() { return this.isRoot || !!this.parentNode?.isConnected; }
    get parentElement() { return this.parentNode; }
    get childElementCount() { return this.children.filter(child => child.tagName !== '#COMMENT').length; }
    get firstChild() { return this.children[0]; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1]; }
    set className(value) { this._className?.split(' ').forEach(c => this.classList.remove(c)); this._className = value; value.split(' ').forEach(c => this.classList.add(c)); }
    get className() { return this._className || ''; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    prepend(...nodes) { [...nodes].reverse().forEach(node => { node.remove(); node.parentNode = this; this.children.unshift(node); }); }
    before(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
    after(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    replaceChildren(...nodes) { [...this.children].forEach(node => node.remove()); this.append(...nodes); }
    matches(selector) { return selector.split(',').some(part => {
      part = part.trim();
      if (part === '[data-model-default="true"]') return this.dataset.modelDefault === 'true';
      if (part === '[data-mobile-dock]') return !!this.dataset.mobileDock;
      if (part === '[hidden]') return this.hidden;
      if (part === '[inert]') return this.inert;
      if (part === '[tabindex]') return this.attrs.tabindex !== undefined;
      if (part.startsWith('.')) return part.slice(1).split('.').every(name => this.classList.contains(name));
      return this.tagName === part.toUpperCase();
    }); }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() { return this.closest('[hidden], [inert]') ? [] : [{}]; }
    hasAttribute(key) { return this.attrs[key] !== undefined; }
    getAttribute(key) { return this.attrs[key]; }
    removeAttribute(key) { delete this.attrs[key]; }
    focus() { doc.activeElement = this; }
    click() { if (!this.disabled) this.emit('click', { target: this, preventDefault() {}, stopImmediatePropagation() {} }); }
    dispatchEvent(event) { this.emit(event.type, event); }
    scrollIntoView() { this.scrolled = true; }
    showModal() { this.open = true; } close() { this.open = false; }
    getBoundingClientRect() { return { left: 0, top: 100, right: 390, bottom: 844 }; }
  }
  doc.body = new Element('body'); doc.body.isRoot = true;
  doc.createDocumentFragment = () => new Element('#fragment');
  doc.createElement = tag => new Element(tag); doc.createComment = () => new Element('#comment');
  context.document = doc;
  const win = new Surface(); win.visualViewport = Object.assign(new Surface(), { height: 500, offsetTop: 20 }); context.window = win;
  const { dockTabs, keyboardLift, mountMobileDock } = (await load('./mobileDock.js')).namespace;
  assert.equal(keyboardLift(844, { height: 500, offsetTop: 20 }), 324);
  assert.equal(keyboardLift(500, { height: 600, offsetTop: 0 }), 0);
  assert.equal(keyboardLift(844, null), 0);
  assert.ok(!dockTabs.includes('agents'), 'Messenger retains its own composer and rail search');
  assert.ok(!dockTabs.includes('forgeSession'), 'Forge retains its session composer');
  const view = new Element('section'), toolbar = new Element('div'), searchInput = new Element('input'), create = new Element('button');
  doc.body.append(view); view.append(toolbar); toolbar.append(searchInput, create);
  searchInput.dataset.mobileDock = 'search'; searchInput.value = 'retained query'; create.dataset.mobileDock = 'create';
  let creates = 0, searches = 0; create.addEventListener('click', () => creates++); searchInput.addEventListener('input', () => searches++);
  const disposeDock = mountMobileDock(view, 'library');
  const dock = doc.body.querySelector('.ms-dock');
  assert.equal(dock.querySelector('input'), searchInput, 'The live search node moves without cloning');
  assert.equal(searchInput.value, 'retained query'); searchInput.emit('input'); assert.equal(searches, 1);
  dock.querySelector('button').click(); assert.equal(creates, 1, 'Dock create delegates exactly once');
  assert.equal(dock.values['--ms-keyboard'], '324px');
  enabled = false; shared.phone.emit('change');
  assert.equal(searchInput.parentNode, toolbar, 'Desktop restores the original search location'); assert.equal(dock.isConnected, false);
  enabled = true; shared.phone.emit('change'); assert.equal(searchInput.parentNode, dock);
  disposeDock(); assert.equal(searchInput.parentNode, toolbar); assert.equal(dock.isConnected, false);
  assert.equal(mountMobileDock(view, 'agents')(), undefined);
  const noSearch = new Element('section'), createOnly = new Element('button'); createOnly.dataset.mobileDock = 'create'; noSearch.append(createOnly); doc.body.append(noSearch);
  const disposeCreateOnly = mountMobileDock(noSearch, 'notes'); assert.equal(doc.body.querySelector('.ms-dock').children.length, 1); disposeCreateOnly();
  const { composerExpanded, mountMobileComposer } = (await load('./mobileComposer.js')).namespace;
  for (const reason of ['focused', 'draft', 'attachments', 'recording', 'busy']) assert.equal(composerExpanded({ [reason]: true }), true);
  assert.equal(composerExpanded({}), false);
  const composer = new Element('div'), input = new Element('textarea'), attachments = new Element('div');
  input.placeholder = 'Original'; toolbar.append(attachments, composer); composer.append(input);
  const disposeComposer = mountMobileComposer({ composer, input, attachmentHost: attachments, context: 'Test project' });
  assert.equal(composer.classList.contains('ms-composer-expanded'), false);
  input.focus(); composer.emit('focusin'); assert.equal(composer.classList.contains('ms-composer-expanded'), true);
  assert.equal(doc.activeElement, input, 'Morph preserves focused input identity'); assert.equal(input.parentNode, composer);
  input.value = 'draft'; doc.activeElement = null; composer.emit('focusout'); assert.equal(composer.classList.contains('ms-composer-expanded'), true);
  input.value = ''; input.emit('input'); assert.equal(composer.classList.contains('ms-composer-expanded'), false);
  enabled = false; shared.phone.emit('change'); assert.equal(attachments.parentNode, toolbar); assert.equal(input.placeholder, 'Original');
  enabled = true; shared.phone.emit('change'); disposeComposer(); assert.equal(attachments.parentNode, toolbar);
  const { openMobileSheet } = (await load('./mobileSheet.js')).namespace;
  const opener = new Element('button'), sheetContent = new Element('section'); doc.body.append(opener);
  const sheet = openMobileSheet({ title: 'Detail', content: sheetContent, opener });
  assert.equal(sheet.dialog.open, true);
  const controls = sheet.dialog.querySelectorAll('button'); controls.at(-1).focus();
  let trapped = false; sheet.dialog.emit('keydown', { key: 'Tab', preventDefault() { trapped = true; } });
  assert.equal(trapped, true); assert.equal(doc.activeElement, controls[0]);
  sheet.dialog.emit('cancel', { preventDefault() {} }); assert.equal(sheet.dialog.isConnected, false); assert.equal(doc.activeElement, opener);
  const swipeSheet = openMobileSheet({ title: 'Swipe', content: new Element('section'), opener });
  const grabber = swipeSheet.dialog.querySelector('.ms-sheet-grabber');
  grabber.emit('pointerdown', { button: 0, clientX: 100, clientY: 20, pointerId: 1 });
  grabber.emit('pointerup', { clientX: 102, clientY: 100, pointerId: 1 }); assert.equal(swipeSheet.dialog.isConnected, false);
  const resizeSheet = openMobileSheet({ title: 'Resize', content: new Element('section'), opener }); enabled = false; shared.phone.emit('change'); assert.equal(resizeSheet.dialog.isConnected, false); enabled = true;
  const { quotaTone, knownQuota, renderMobileCatalogMenu, mountMobileModelSheet } = (await load('./mobileModelSheet.js')).namespace;
  assert.equal(quotaTone(79.99), 'normal'); assert.equal(quotaTone(80), 'warning'); assert.equal(quotaTone(89.99), 'warning'); assert.equal(quotaTone(90), 'danger');
  for (const value of [null, undefined, '', 'unknown', NaN]) assert.equal(knownQuota(value), false);
  for (const value of [0, 80, '90']) assert.equal(knownQuota(value), true);
  const modelTrigger = new Element('button'), modelMenu = new Element('div'), permission = new Element('select');
  toolbar.append(modelTrigger, modelMenu, permission); modelMenu.classList.add('hidden');
  let pickedConnection, pickedModel, pickedEffort;
  renderMobileCatalogMenu(modelMenu, { endpoints: [{ id: 'codex', name: 'Codex', kind: 'codex_cli', model: 'm1' }], endpointId: 'codex', model: 'm1', effort: null,
    catalog: [{ id: 'm1', display_name: 'Model One', supported_efforts: [{ effort: 'low' }, { effort: 'high' }] }, { id: 'custom', display_name: 'Other', supported_efforts: [] }],
    onConnection: id => { pickedConnection = id; }, onModel: id => { pickedModel = id; }, onEffort: effort => { pickedEffort = effort; } });
  const modelPicker = mountMobileModelSheet({ trigger: modelTrigger, menu: modelMenu, permission });
  assert.equal(modelPicker.open(), true); assert.equal(modelMenu.parentNode.classList.contains('ms-model-root'), true);
  modelMenu.querySelector('.model-connection-item').click(); assert.equal(pickedConnection, 'codex');
  modelMenu.querySelectorAll('.model-catalog-item')[1].click(); assert.equal(pickedModel, 'custom', 'Model selection delegates to the existing controller callback');
  const modelDialog = doc.body.querySelector('.ms-sheet');
  const optionsButton = modelDialog.querySelector('.ms-model-root').querySelector('button'); optionsButton.click();
  const optionsPage = modelDialog.querySelector('.ms-model-options');
  assert.equal(permission.parentNode, optionsPage, 'The same permission control moves into Options');
  const slider = optionsPage.querySelector('input'); assert.equal(slider.attrs.max, '2', 'Slider derives its discrete bounds from the real effort buttons plus Default');
  slider.value = '2'; slider.emit('input'); assert.equal(slider.attrs['aria-valuetext'], 'high'); slider.emit('change'); assert.equal(pickedEffort, 'high');
  let sheetClickStopped = false;
  modelDialog.emit('click', { target: modelDialog.querySelector('input'), stopPropagation() { sheetClickStopped = true; } });
  assert.equal(sheetClickStopped, true, 'Sheet search/options clicks cannot reach the chat outside-click handler');
  modelPicker.dispose(); assert.equal(permission.parentNode, toolbar); assert.equal(modelMenu.parentNode, toolbar); assert.equal(modelMenu.classList.contains('hidden'), true);
  await Promise.resolve(); // The account request may settle after dismissal.
  const { mountMobileVoiceRow } = (await load('./mobileVoiceRow.js')).namespace;
  const voiceComposer = new Element('div'), voiceMic = new Element('button'), openMic = new Element('button'); doc.body.append(voiceComposer); voiceComposer.append(voiceMic, openMic);
  let dictationDone = 0, dictationCancel = 0; voiceMic.addEventListener('click', () => dictationDone++); voiceMic.addEventListener('kairos:cancel-dictation', () => dictationCancel++);
  const disposeVoice = mountMobileVoiceRow(voiceComposer, voiceMic, openMic);
  voiceMic.classList.add('recording'); mutationObservers.filter(observer => observer.active).forEach(observer => observer.callback());
  assert.equal(voiceComposer.classList.contains('ms-dictating'), true); const voiceRow = voiceComposer.querySelector('.ms-voice-row');
  voiceRow.querySelectorAll('button').at(-1).click(); assert.equal(dictationDone, 1, 'Done uses the existing dictation action');
  voiceRow.querySelector('button').click(); assert.equal(dictationCancel, 1);
  disposeVoice(); assert.equal(voiceComposer.querySelector('.ms-voice-row'), null);
  const css = fs.readFileSync(path.join(__dirname, '../static/css/redesign-mobile.css'), 'utf8');
  assert.match(css, /settings-nav-item \{ min-height: 52px/); assert.match(css, /border-radius: 22px/);
  assert.match(css, /prefers-reduced-motion: reduce/); assert.match(css, /transition: border-radius 280ms/);
  assert.ok(mutationObservers.every(observer => !observer.active), 'All mounted observers disconnect');
  console.log('PASS: A1-A3 routing/pager; A4 dock delegation, keyboard and restore; A5 input/draft identity; A6 sheet focus/swipe/resize and quota boundaries; A7 grouped geometry and reduced-motion contract');
})().catch(error => { console.error(error); process.exitCode = 1; });
