const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = file => import(pathToFileURL(path.join(__dirname, '../static/js', file)).href);

(async () => {
  const m = await load('botsRoomModel.js');
  const members = [{ bot_id: 'b1', name: 'Scout One' }, { bot_id: 'b2', name: 'Writer' }];
  assert.equal(m.responderLabel({ kind: 'member', bot_id: 'b1' }, members), 'Scout One answers');
  assert.equal(m.responderLabel({ kind: 'auto' }), 'Auto chooses who answers');
  assert.equal(m.responderLabel({ kind: 'everyone' }), 'Everyone answers');
  assert.equal(m.responderLabel({ kind: 'mentions' }), 'Only mentioned bots answer');
  assert.equal(m.memberState({ held: true, working: true }), 'held');
  assert.equal(m.memberState({ working: true }), 'working');
  assert.equal(m.memberState({ waiting: true }), 'queued');
  assert.equal(m.memberState({ busy_elsewhere: true }), 'elsewhere');
  assert.equal(m.memberState({}), 'ready');
  assert.deepEqual(m.roomMentionItems({ query: 'e' }, members).map(i => i.label), ['@everyone']);
  assert.deepEqual(m.roomMentionItems({ query: 's' }, members).map(i => i.label), ['@scout-one']);
  assert.deepEqual(m.mentionPreview('`@Writer`\n> @everyone\nAsk @Scout-One and @you', members).map(i => i.id), ['b1', 'you']);
  assert.deepEqual(m.mentionPreview('mail@Writer.com @Writer-later', members), []);
  assert.deepEqual(m.queuePositions([{ id: '1', text: 'a' }, { id: '2', state: 'consumed' }, { id: '3', text: 'c' }], 'Scout').map(i => i.label), ['1. a (waiting for Scout)', '2. c (waiting for Scout)']);
  assert.equal(m.anchorAfterLoad({ top: 37, height: 100 }, 200), 137);
  assert.deepEqual(m.roomSendPayload({ text: 'hello', mode: 'chat', send_id: 'receipt123', expected_leaf_id: 'no', attachment_ids: [] }, 't'),
    { text: 'hello', mode: 'text', send_id: 'receipt123', thread_id: 't', reply_to_id: null });
  const model = m.createRoomModel('r'), s = model.state;
  const snapshot = () => ({ room: { id: 'r', revision: 2, members: members.map(b => ({ ...b, working: true })) },
    page: { thread_id: 't', messages: [], has_more: true }, queue: { items: [] }, goal: { goal: null } });
  model.hydrate(snapshot());
  const frame = (type, data, room_id = 'r') => model.apply({ type, room_id, data });
  assert.equal(frame('room.chunk', { turn_id: 'run', thread_id: 't', revision: 1, chunk: 'Hi', bot_id: 'b1' }), true);
  assert.equal(frame('room.chunk', { turn_id: 'run', thread_id: 't', revision: 1, chunk: 'Hi', bot_id: 'b1' }), false);
  assert.equal(frame('room.chunk', { turn_id: 'run', thread_id: 't', revision: 0, chunk: 'old' }), false);
  assert.equal(frame('room.chunk', { turn_id: 'run', thread_id: 'other', revision: 2, chunk: 'wrong' }), false);
  assert.equal(frame('room.chunk', { turn_id: 'run', thread_id: 't', revision: 2, chunk: ' there', bot_id: 'b1' }, 'other'), false);
  assert.equal(frame('room.chunk', { turn_id: 'run', thread_id: 't', revision: 2, chunk: ' there', bot_id: 'b1' }), true);
  model.hydrate(snapshot());
  assert.equal(s.live.get('run').text, 'Hi there', 'polling must preserve a partial reply');
  frame('room.hold', { bot_id: 'b1', held: true }); assert.equal(s.room.members[0].held, true);
  frame('room.goal', { thread_id: 'other', goal: { status: 'working' } }); assert.equal(s.goal, null);
  frame('room.goal', { thread_id: 't', goal: { status: 'working', turn: 3 } }); assert.equal(s.goal.turn, 3);
  const message = { id: 'm', seq: 2, turn_id: 'run', thread_id: 't', text: 'Hi there' };
  frame('room.message', { message }); frame('room.message', { message });
  assert.equal(s.messages.length, 1); assert.equal(s.live.size, 0);
  assert.equal(frame('room.chunk', { turn_id: 'run', thread_id: 't', revision: 3, chunk: 'late' }), false);
  frame('room.turn', { thread_id: 't', turn_id: 'second', bot_id: 'b2', status: 'working' });
  frame('room.turn', { thread_id: 't', turn_id: 'second', bot_id: 'b2', status: 'ended' });
  assert.equal(frame('room.chunk', { turn_id: 'second', thread_id: 't', revision: 1, chunk: 'late' }), false);
  frame('room.chunk', { turn_id: 'missing-prefix', thread_id: 't', revision: 8, chunk: 'suffix', bot_id: 'b1' });
  assert.equal(s.live.get('missing-prefix').incomplete, true);
  assert.equal(s.live.get('missing-prefix').text, '', 'a replay gap must never display a suffix as a full reply');
  assert.equal(frame('room', { room: { revision: 1 } }), false);
  frame('room.deleted', {}); assert.equal(s.deleted, true);
  assert.deepEqual(m.mergeMessages([{ id: 'x', seq: 3 }, { id: 'y', seq: 2 }], [{ id: 'y', seq: 2, text: 'patched' }, { id: 'a', seq: 1 }]).map(i => i.id), ['a', 'y', 'x']);
  const { buildRows, registerRowRenderer, renderRegisteredRow } = await load('botsTranscript.js');
  const rows = buildRows([{ id: 'a', bot_id: 'b1', role: 'assistant', ts: 5 }, { id: 'b', bot_id: 'b2', role: 'assistant', ts: 6 }]);
  assert.equal(rows.at(-1).joinPrev, false, 'different room speakers never cluster');
  const off = registerRowRenderer('test-room', () => 'custom'); assert.equal(renderRegisteredRow('test-room', {}, {}), 'custom'); off();
  assert.equal(renderRegisteredRow('test-room', {}, {}), null);
  const firstOff = registerRowRenderer('test-room', () => 'first'), secondOff = registerRowRenderer('test-room', () => 'second');
  assert.equal(renderRegisteredRow('test-room', {}, { rowRenderers: { 'test-room': () => 'fallback' } }), 'second');
  firstOff(); secondOff(); assert.equal(renderRegisteredRow('test-room', {}, {}), null, 'out-of-order cleanup must not revive an unmounted renderer');
  // Exercise the real form mounts with an API boundary and a small DOM. These
  // checks prove submitted payloads and refusals, beyond pure label helpers.
  global.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const panel = await load('botsRoomPanel.js');
  const newRoom = await load('botsNewRoom.js');
  const memberForm = await load('botsRoomMembers.js');
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.hidden = false; this._text = ''; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'disabled') this.disabled = true; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
    async emit(k, event = {}) { await Promise.all((this.listeners[k] || []).map(fn => fn({ key: '', preventDefault() {}, ...event }))); }
    append(...values) { values.forEach(v => { const n = typeof v === 'string' ? Object.assign(new Element('text'), { _text: v }) : v; n.parent = this; this.children.push(n); }); }
    replaceChildren(...values) { this.children = []; this.append(...values); }
    get firstElementChild() { return this.children[0]; }
    replaceWith(next) { const at = this.parent.children.indexOf(this); next.parent = this.parent; this.parent.children[at] = next; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    focus() { global.document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    all(test) { return this.children.flatMap(c => [...(test(c) ? [c] : []), ...c.all(test)]); }
  }
  global.document = { createElement: tag => new Element(tag), activeElement: null, body: new Element('body') };
  const host = new Element('main'), writes = [];
  const wireRoom = { id: 'r', revision: 7, name: 'A room', cwd: '', bulletin: '', turn_timeout_minutes: 5, members, default_responder: { kind: 'mentions' } };
  const api = async (path, method = 'GET', body) => {
    if (method === 'GET') return path === '/api/agents' ? members.map(m => ({ id: m.bot_id, name: m.name })) : structuredClone(wireRoom);
    writes.push({ path, method, body }); return { ...wireRoom, ...body, revision: 8 };
  };
  let created;
  const creation = await newRoom.mount(host, { call: api, onCreated: room => { created = room; } });
  const field = label => host.all(n => n.attrs['aria-label'] === label)[0];
  const button = label => host.all(n => n.tagName === 'BUTTON' && n.textContent === label)[0];
  field('Room name').value = 'Weekly room'; await field('Room name').emit('input');
  assert.equal(button('Create room with 0 bots').disabled, true);
  const picker = host.all(n => n.attrs['data-bot-id'] === 'b1')[0]; picker.checked = true; await picker.emit('change');
  assert.equal(button('Create room with 1 bot').disabled, false);
  await button('Create room with 1 bot').emit('click');
  assert.deepEqual(writes.at(-1).body, { name: 'Weekly room', context: '', bot_ids: ['b1'] }); assert.ok(created);
  await creation.refresh(); assert.equal(button('Create room with 1 bot').disabled, false);
  creation.destroy(); assert.equal(host.children.length, 0);
  const setup = panel.mountSetup(host, { room: wireRoom, call: api, onSaved() {} });
  field('Room instructions').value = 'A shared brief';
  await button('Save').emit('click'); assert.deepEqual(writes.at(-1).body, { action: 'complete', cwd: null, bulletin: 'A shared brief', default_responder: { kind: 'mentions' } });
  await button('Skip').emit('click'); assert.deepEqual(writes.at(-1).body, { action: 'skip' }); setup.destroy();
  let updated;
  const settings = await panel.mount(host, { room: wireRoom, call: api, onChanged: room => { updated = room; } });
  await settings.refresh();
  field('Room instructions').value = 'Edited';
  await field('Room instructions').emit('keydown', { key: 'Enter', ctrlKey: true });
  assert.equal(writes.at(-1).body.expected_revision, 7); assert.equal(writes.at(-1).body.bulletin, 'Edited'); assert.ok(updated);
  settings.destroy();
  const refused = await panel.mount(host, { room: wireRoom, call: async () => { throw Object.assign(new Error('Room changed'), { status: 409 }); } });
  assert.equal((await refused.flush()).ok, false); assert.match(host.textContent, /reopen to reload/); refused.destroy();
  const editMembers = await memberForm.mount(host, { roomId: 'r', call: api });
  for (const checkbox of host.all(n => n.attrs['data-bot-id'])) { checkbox.checked = false; await checkbox.emit('change'); }
  assert.equal(button('Save with 0 bots').disabled, true);
  wireRoom.revision++;
  await editMembers.refresh(); assert.match(host.textContent, /Close and reopen/); editMembers.destroy();
  wireRoom.working = true;
  const blocked = await memberForm.mount(host, { roomId: 'r', call: api });
  assert.equal(host.all(n => n.attrs['data-bot-id']).every(n => n.disabled), true); assert.equal((await blocked.flush()).ok, false); blocked.destroy();
  const backend = require('./fixtures/bots-rooms-backend.cjs')({ state: { botsLive: true, botsRooms: {}, botsCore: { agents: members.map(m => ({ id: m.bot_id, name: m.name })) } }, now: 1000 });
  const roomFixture = async (path, method = 'GET', body) => {
    const out = method === 'GET' ? backend.read(path) : backend.mutate(path, method, body);
    if (out?._status >= 400) throw Object.assign(new Error(out.detail), { status: out._status });
    return out;
  };
  const threaded = await roomFixture('/api/bot-rooms', 'POST', { name: 'Thread test', bot_ids: ['b1'], setup_done: true });
  let pickedThread;
  let threadsDialog = await panel.openRoomThreads({ roomId: threaded.id, threadId: threaded.threads[0].id, call: roomFixture, onPick: id => { pickedThread = id; } });
  const dialogField = label => document.body.all(n => n.attrs['aria-label'] === label)[0];
  const dialogButtons = label => document.body.all(n => n.tagName === 'BUTTON' && n.textContent === label);
  dialogField('New conversation title').value = 'New work'; await dialogButtons('Create conversation')[0].emit('click');
  assert.ok(pickedThread); assert.equal((await roomFixture(`/api/bot-rooms/${threaded.id}/threads`)).threads.length, 2);
  threadsDialog = await panel.openRoomThreads({ roomId: threaded.id, threadId: threaded.threads[0].id, call: roomFixture });
  dialogField('Conversation 1 title').value = 'Renamed'; await dialogButtons('Save title')[0].emit('click');
  assert.equal((await roomFixture(`/api/bot-rooms/${threaded.id}/threads`)).threads[0].title, 'Renamed');
  await dialogButtons('Delete')[1].emit('click'); await dialogButtons('Delete conversation')[0].emit('click');
  assert.equal((await roomFixture(`/api/bot-rooms/${threaded.id}/threads`)).threads.length, 1);
  assert.equal(dialogButtons('Delete')[0].disabled, true, 'keep the last conversation'); threadsDialog.close();
  delete global.document;
  console.log('PASS room model, stream revisions, mentions, queue, speaker clusters, row registration');
  console.log('PASS room creation, setup Save/Skip, panel inline save, stale refusal and member guards');
  console.log('PASS room conversation create, rename, delete and keep-one against U2 fixture');
})().catch(error => { console.error(error); process.exitCode = 1; });
