// Bots composer (Phase 1, U3): key policy, the round button, menus, the send controller with delayed
// acceptance and a failed settings save, and the mounted composer driven through a minimal DOM.
// Run: node scripts/test_bots_composer.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', file)).href);

// A DOM just big enough for the composer: elements, attributes, listeners, children.
class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.parentNode = null; this._text = ''; this.hidden = false; this.disabled = false; this.value = ''; this.classes = new Set(); this.scrollHeight = 40; }
  get classList() { const s = this.classes; return { add: c => s.add(c), remove: c => s.delete(c), toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); }, contains: c => s.has(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.classes = new Set(String(v).split(/\s+/)); if (k === 'hidden') this.hidden = true; }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  emit(type, event = {}) { event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...event }; for (const fn of this.listeners[type] || []) fn(event); return event; }
  dispatchEvent(event) { return this.emit(event.type); }
  click() { return this.emit('click'); }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? Object.assign(new Node_('#text'), { _text: n }) : n; node.parentNode = this; this.children.push(node); } }
  prepend(...nodes) { this.append(...nodes); this.children.unshift(...this.children.splice(-nodes.length)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { this.children = [new Node_('svg')]; }
  get firstElementChild() { return this.children[0]; }
  querySelector(sel) { const all = this.find(n => (sel.startsWith('.') ? n.classes.has(sel.slice(1)) : n.tag === sel)); return all[0] || null; }
  find(test, out = []) { for (const c of this.children) { if (test(c)) out.push(c); c.find(test, out); } return out; }
  focus() { Node_.active = this; } setRangeText(t, s, e) { this.value = this.value.slice(0, s) + t + this.value.slice(e); } setSelectionRange() {}
  get selectionStart() { return this.value.length; } get selectionEnd() { return this.value.length; }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
}
global.document = { createElement: tag => new Node_(tag), createTextNode: t => Object.assign(new Node_('#text'), { _text: t }), body: new Node_('body'), addEventListener() {}, removeEventListener() {} };
global.window = { listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); } };
global.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

(async () => {
  const C = await load('botsComposer.js');
  const D = await load('botsDrafts.js');
  const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) }; };
  const draftFor = () => { let n = 0; return D.createBotDraft({ person: 'p', bot: 'b', thread: 't' }, { storage: mem(), uuid: () => `send-${++n}`, setTimer: () => 0, clearTimer: () => {} }); };
  const key = (k, extra = {}) => ({ key: k, ...extra });

  // Send keys: the three preferences, IME safety, phone newline.
  assert.equal(C.sendKey(key('Enter')), true);
  assert.equal(C.sendKey(key('Enter', { shiftKey: true })), false);
  assert.equal(C.sendKey(key('Enter', { isComposing: true })), false, 'IME composition never sends');
  assert.equal(C.sendKey(key('Enter', { keyCode: 229 })), false, 'Safari confirms composition with keyCode 229');
  assert.equal(C.sendKey(key('Enter', { defaultPrevented: true })), false);
  assert.equal(C.sendKey(key('Enter', { altKey: true })), false);
  assert.equal(C.sendKey(key('Enter'), { phone: true }), false, 'Enter is a newline on a phone');
  assert.equal(C.sendKey(key('Enter', { ctrlKey: true }), { preference: 'mod-enter' }), true);
  assert.equal(C.sendKey(key('Enter', { metaKey: true }), { preference: 'mod-enter' }), true);
  assert.equal(C.sendKey(key('Enter'), { preference: 'mod-enter' }), false);
  assert.equal(C.sendKey(key('Enter', { shiftKey: true }), { preference: 'shift-enter' }), true);
  assert.equal(C.sendKey(key('Enter'), { preference: 'shift-enter' }), false);
  assert.equal(C.sendKey(key('a')), false);
  assert.equal(C.sendKey(key('Enter', { ctrlKey: true }), { phone: true, preference: 'mod-enter' }), true, 'a chosen key works on a phone');

  // Double Enter steers inside 1.5 s, only on an empty field while busy.
  assert.equal(C.isSteerChord({ empty: true, busy: true, lastEnter: 1000, now: 2500 }), true);
  assert.equal(C.isSteerChord({ empty: true, busy: true, lastEnter: 1000, now: 2501 }), false);
  assert.equal(C.isSteerChord({ empty: false, busy: true, lastEnter: 1000, now: 1200 }), false);
  assert.equal(C.isSteerChord({ empty: true, busy: false, lastEnter: 1000, now: 1200 }), false);
  assert.equal(C.isSteerChord({ empty: true, busy: true, lastEnter: 0, now: 1200 }), false);
  assert.equal(C.escapeAction({ menuOpen: true, dictating: true, replying: true }), 'menu');
  assert.equal(C.escapeAction({ dictating: true, replying: true }), 'dictation');
  assert.equal(C.escapeAction({ replying: true }), 'reply');
  assert.equal(C.escapeAction({}), null);

  // The round button.
  const slot = o => C.primarySlot(o);
  assert.deepEqual([slot({ canCall: true }).kind, slot({ canCall: true }).disabled], ['call', false]);
  assert.equal(slot({ canCall: false }).disabled, true, 'no call adapter: the slot is inert');
  assert.equal(slot({ content: true }).kind, 'send');
  assert.equal(slot({ content: true, busy: true }).kind, 'queue');
  assert.equal(slot({ content: true, busy: true }).label, 'Queue');
  assert.equal(slot({ busy: true }).kind, 'stop');
  assert.equal(slot({ content: true, uploading: true }).disabled, true, 'sending waits for uploads');
  assert.equal(slot({ busy: true, locked: true }).disabled, false, 'Stop stays available');
  assert.match(C.placeholderFor({ name: 'Scout' }), /^Message Scout$/);
  assert.match(C.placeholderFor({ name: 'Scout', busy: true }), /queue/);
  assert.match(C.placeholderFor({ name: 'Scout', goal: true }), /goal/);
  assert.match(C.placeholderFor({ name: 'Scout', locked: true }), /Answer/);
  assert.equal(C.steerLabel(1, 0), 'Steer'); assert.equal(C.steerLabel(3, 0), 'Steer all'); assert.equal(C.steerLabel(3, 2), 'Steer next');
  assert.match(C.busyHint({}), /interrupt/);

  // Slash and mention menus.
  assert.deepEqual(C.slashItems('/', []).map(i => i.id), ['goal', 'learn', 'setup']);
  assert.deepEqual(C.slashItems('/g', []).map(i => i.id), ['goal']);
  assert.deepEqual(C.slashItems('/go now', []), [], 'a space ends the command');
  assert.deepEqual(C.slashItems('hello /', []), []);
  assert.deepEqual(C.slashItems('/', [{ name: 'goal', description: 'shadow' }, { name: 'brief', description: 'Daily brief' }]).map(i => `${i.id}:${i.kind}`), ['goal:command', 'learn:command', 'setup:command', 'brief:skill'], 'built-ins shadow skills');
  assert.equal(C.mentionToken('hi @sc', 6).query, 'sc');
  assert.equal(C.mentionToken('@a', 2).start, 0);
  assert.equal(C.mentionToken('mail me@x.com', 13), null, 'an address is not a mention');
  assert.equal(C.mentionToken('see /@scout', 11), null, 'a URL path is not a mention');
  assert.equal(C.mentionToken('use `@scout', 11), null, 'inside a code span');
  assert.equal(C.mentionToken('(@sco', 5).query, 'sco');
  assert.equal(C.mentionToken('```\n@sco', 8), null, 'inside a fence');
  const bots = [{ id: 'a1', name: 'Scout' }, { id: 'a2', name: 'Archivist' }, { id: 'a3', name: 'Old', hidden: true }, { id: 'a4', name: 'Sky Writer' }];
  assert.deepEqual(C.mentionItems({ query: 's' }, bots, 'a1').map(i => i.label), ['@Sky-Writer', '@support'], 'not itself, not hidden');
  assert.deepEqual(C.mentionItems({ query: '' }, bots, 'a1').map(i => i.kind), ['bot', 'bot', 'support']);
  assert.deepEqual(C.mentionItems({ query: 'zzz' }, bots, 'a1'), []);
  assert.deepEqual(C.mentionItems(null, bots, 'a1'), []);

  // Support draft redaction.
  const red = C.redactForSupport('Mail dana@example.com with key sk-abcdef123456789 from C:\\Users\\Dana\\notes at 10.0.0.12, Bearer abcdefghijklmnop1234');
  assert.ok(!/dana@|abcdef12345|Dana|10\.0\.0\.12|abcdefghijklmnop/.test(red), red);
  assert.match(red, /\[email\]/); assert.match(red, /Bearer \[token\]/); assert.match(red, /C:\\Users\\\[user\]/);
  assert.equal(C.redactForSupport('plain words stay'), 'plain words stay');

  // The send controller: settings barrier, definite refusal, lost response, delayed acceptance.
  {
    const draft = draftFor();
    let saved = { ok: false, error: 'Name is too long' }, calls = 0, mode = 'ok';
    const ctl = C.createSendController({ draft, flushSettings: async () => saved, getLeaf: () => 'leaf-1', request: async payload => {
      calls++;
      if (mode === 'lost') throw new Error('Failed to fetch');
      if (mode === 'refuse') throw Object.assign(new Error('Conflict'), { status: 409 });
      if (mode === 'slow') await new Promise(r => setTimeout(r, 20));
      return { status: 'accepted', payload };
    } });
    draft.update({ text: 'hello' });
    await assert.rejects(ctl.send(), /Name is too long/);
    assert.equal(calls, 0, 'a failed settings save sends nothing');
    assert.equal(draft.read().text, 'hello', 'and keeps the draft');
    assert.equal(draft.outbox(), null);
    saved = { ok: true };
    mode = 'lost';
    await assert.rejects(ctl.send(), /Failed to fetch/);
    assert.equal(draft.outbox().retry, true, 'a lost response leaves a retryable receipt');
    const firstId = draft.outbox().payload.send_id;
    mode = 'ok';
    const result = await ctl.send();
    assert.equal(result.payload.send_id, firstId, 'Retry carries the same send ID');
    assert.equal(draft.outbox(), null);
    draft.update({ text: 'second' }); mode = 'refuse';
    await assert.rejects(ctl.send(), /Conflict/);
    assert.equal(draft.read().text, 'second', 'a 409 frees the text');
    assert.equal(draft.outbox(), null);
    mode = 'slow'; draft.update({ text: 'third' });
    const sending = ctl.send();
    assert.equal(ctl.send(), sending, 'a second press shares the running send');
    assert.equal(ctl.busy(), true);
    await new Promise(r => setTimeout(r, 5)); // The receipt is saved and the request is in flight.
    draft.update({ text: 'typed during the wait' });
    await sending;
    assert.equal(draft.read().text, 'typed during the wait', 'delayed acceptance keeps newer typing');
    assert.equal(ctl.busy(), false);
    assert.equal(C.isDefiniteRefusal({ status: 413 }), true); assert.equal(C.isDefiniteRefusal({ status: 429 }), false); assert.equal(C.isDefiniteRefusal({ status: 503 }), false); assert.equal(C.isDefiniteRefusal(new Error('x')), false);
  }

  // The mounted composer: typing, Enter, IME, queue and steer, ArrowUp, Escape, uploads, the outbox.
  {
    const draft = draftFor(), host = new Node_('div');
    const log = []; let time = 10_000, form = 'simple', lastEdit = 0;
    const uploads = { busy: false, ids: ['att-1'], items: [], removeIds() {}, clear() {}, remove() {} };
    const comp = C.mountBotsComposer(host, { draft, name: 'Scout', form: () => form, now: () => time, uploader: { busy: () => uploads.busy, ids: () => uploads.ids, items: () => uploads.items, removeIds() {}, remove() {}, add: async () => [] },
      submit: async () => { log.push(`submit:${draft.read().text}`); draft.prepare(null); draft.accepted(draft.outbox() ? { payload: draft.outbox().payload } : {}); },
      stop: async () => { log.push('stop'); }, steer: async () => { log.push('steer'); }, openCall: () => log.push('call'), onEditLast: () => { lastEdit++; },
      queue: { edit: i => log.push(`edit:${i.id}`), remove: i => log.push(`remove:${i.id}`), steer: (i, n) => log.push(`steer:${i.id}:${n}`), resume: () => log.push('resume') },
      mentions: () => [{ id: 'a2', name: 'Archivist' }], skills: () => [], onSupport: () => log.push('support'), sendPreference: 'enter' });
    const root = host.children[0], input = comp.input;
    const primary = root.querySelector('.bots-composer-primary');
    const type = text => { input.value = text; input.emit('input'); };
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    assert.equal(root.dataset.form, 'simple');
    assert.equal(primary.dataset.kind, 'send', 'a staged attachment counts as content');
    uploads.ids = [];
    comp.paint(); assert.equal(primary.dataset.kind, 'call');
    primary.click(); assert.deepEqual(log.splice(0), ['call']);

    type('hello there');
    assert.equal(primary.dataset.kind, 'send');
    assert.equal(draft.read().text, 'hello there');
    const ime = input.emit('keydown', key('Enter', { isComposing: true }));
    await settle(); assert.deepEqual(log, [], 'IME Enter does not send'); assert.equal(ime.defaultPrevented, false);
    const sent = input.emit('keydown', key('Enter')); await settle();
    assert.equal(sent.defaultPrevented, true); assert.deepEqual(log.splice(0), ['submit:hello there']);

    // Busy: the button queues with content and stops without; double Enter steers.
    comp.setState({ busy: true });
    assert.equal(primary.dataset.kind, 'stop');
    primary.click(); assert.deepEqual(log.splice(0), ['stop']);
    type('next thing'); assert.equal(primary.dataset.kind, 'queue');
    time = 20_000; input.emit('keydown', key('Enter')); await settle(); log.splice(0);
    input.value = ''; input.emit('input'); time = 20_900;
    input.emit('keydown', key('Enter')); await settle();
    assert.deepEqual(log.splice(0), ['steer'], 'a second Enter within 1.5 s steers');
    time = 25_000; input.emit('keydown', key('Enter')); await settle();
    assert.deepEqual(log.splice(0), [], 'a slow second Enter does nothing on an empty field');

    // Queue strip.
    comp.setQueue({ items: [{ id: 'q1', text: 'one' }, { id: 'q2', text: 'two' }], paused: false });
    const strip = root.querySelector('.bots-queue');
    assert.equal(strip.hidden, false);
    const labels = strip.find(n => n.tag === 'button').map(b => b.textContent);
    assert.deepEqual(labels, ['Steer all', 'Edit', 'Delete', 'Steer next', 'Edit', 'Delete']);
    strip.find(n => n.tag === 'button' && n.textContent === 'Steer all')[0].click();
    strip.find(n => n.tag === 'button' && n.textContent === 'Edit')[0].click();
    strip.find(n => n.tag === 'button' && n.textContent === 'Delete')[1].click();
    assert.deepEqual(log.splice(0), ['steer:q1:0', 'edit:q1', 'remove:q2']);
    comp.setQueue({ items: [{ id: 'q1', text: 'one', state: 'interrupted' }], paused: true });
    assert.match(strip.textContent, /Interrupted: one/);
    strip.find(n => n.tag === 'button' && n.textContent === 'Resume')[0].click(); assert.deepEqual(log.splice(0), ['resume']);
    assert.ok(!strip.find(n => n.tag === 'button').some(b => b.textContent.startsWith('Steer')), 'a paused queue offers Resume, not Steer');
    comp.setQueue({ items: [] }); assert.equal(strip.hidden, true);
    comp.setState({ busy: false });

    // ArrowUp edits the last message on an empty field only; Escape order; uploads block sending.
    input.value = ''; input.emit('keydown', key('ArrowUp')); assert.equal(lastEdit, 1);
    type('draft'); input.emit('keydown', key('ArrowUp')); assert.equal(lastEdit, 1);
    type(''); draft.update({ reply_to_id: 'm1' }); comp.paint();
    assert.match(root.textContent, /Replying to/);
    input.emit('keydown', key('Escape')); assert.equal(draft.read().reply_to_id, null, 'Escape cancels the reply');
    type('/'); const menu = root.querySelector('.bots-composer-menu');
    assert.equal(menu.hidden, false); assert.equal(menu.children.length, 3);
    input.emit('keydown', key('Escape')); assert.equal(menu.hidden, true, 'Escape closes the menu first');
    type('/'); input.emit('keydown', key('ArrowDown')); input.emit('keydown', key('Enter'));
    assert.equal(input.value, '/learn ', 'Enter chooses the live skill authoring command');
    assert.equal(draft.read().text, '/learn ');
    type('/g'); input.emit('keydown', key('Enter')); assert.equal(draft.read().mode, 'goal', '/goal switches to goal mode'); assert.equal(input.value, '');
    type('@arc'); assert.equal(menu.children.length, 1); input.emit('keydown', key('Tab')); assert.equal(input.value, '@Archivist ');
    type('x'); uploads.busy = true; comp.paint();
    assert.equal(primary.disabled, true, 'the round button waits for uploads');
    assert.equal(input.disabled, false, 'the editor stays enabled and focused during an upload');
    const blocked = input.emit('keydown', key('Enter')); await settle();
    assert.equal(log.filter(l => l.startsWith('submit')).length, 0, 'Enter refuses while uploading');
    assert.match(root.querySelector('.bots-send-error').textContent, /finish uploading/);
    uploads.busy = false; void blocked;

    // The outbox: Not sent with Retry, and Edit restores above newer typing.
    draft.update({ text: 'lost one', mode: 'chat' });
    draft.prepare(null);
    comp.paint();
    const box = root.querySelector('.bots-outbox');
    assert.equal(box.hidden, false); assert.match(box.textContent, /Not sent: lost one/);
    assert.ok(box.find(n => n.textContent === 'Retry').length);
    type(''); comp.restore('queued text'); assert.equal(input.value, 'queued text', 'restore with an empty field');
    type('newer'); comp.restore('older'); assert.equal(input.value, 'older\nnewer', 'restore never overwrites typing');

    form = 'advanced'; comp.paint(); assert.equal(root.dataset.form, 'advanced');
    form = 'phone'; comp.paint(); assert.equal(root.dataset.form, 'phone');
    comp.dispose();
    assert.equal(host.children.length, 0, 'dispose removes the composer');
  }
  console.log('PASS: bots composer keys, round button, menus, send controller and mounted behaviour.');
})().catch(error => { console.error(error); process.exit(1); });
