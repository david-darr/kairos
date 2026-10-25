// The notch's logos, its quiet view's figures, the side notch's placement and the
// actions it sends the app. Plain Node, no Electron, no screen:
// node scripts/test_notch_quiet.cjs
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const strip = file => fs.readFileSync(require.resolve('../static/js/' + file), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
function load(file, globals, names) {
  const scope = vm.createContext({ Date, Math, Set, Map, Promise, encodeURIComponent, ...globals });
  vm.runInContext(strip(file) + `\nthis.api = { ${names} };`, scope);
  return scope.api;
}
// Values built inside the vm scopes have those scopes' prototypes; compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
// Just enough DOM: a node remembers its tag, attributes, text and children, and what its click does.
const node = tag => {
  const n = { tag, children: [], attrs: {}, cls: '', style: { setProperty() {} }, events: {},
    classList: { add: name => { n.cls += ' ' + name; } },
    append(...more) { n.children.push(...more); }, setAttribute(k, v) { n.attrs[k] = v; },
    addEventListener(name, fn) { n.events[name] = fn; } };
  Object.defineProperty(n, 'className', { get: () => n.cls, set: value => { n.cls = value; } });
  return n;
};
const document = { createElement: node, createElementNS: (ns, tag) => node(tag) };
const icons = load('notchIcons.js', {}, 'ICONS');
const marks = load('notchModelMarks.js', { document }, 'logoKeyOf, initialOf, modelLogo');
const quiet = load('notchQuiet.js', { document, ...icons, ...marks }, 'layoutFor, workingAgents, greetingFor, chatsToday, notesDue, nextEvent, sourceOf, untilCopy, rangeCopy, prepDraft, recentChat, ageCopy, snippetFrom, filledDots, usageRows, statusLine, createQuietData, quickActions, upNextTile, DOTS');
const side = load('notchSide.js', { document, ...icons, ...quiet }, 'isSideEdge, sideTop, sideCardAt');
const { navigation, TARGETS } = require('../electron/usage-overlay-navigation');
const { notchNavigation } = load('notchNavigate.js', {}, 'notchNavigation');

// ---- Logos, not names ------------------------------------------------------------------------------------------
const { logoKeyOf, initialOf, modelLogo } = marks;
// What /api/models/quotas gives a model group: provider ids for the subscriptions, the server's mark for the rest.
assert.equal(logoKeyOf({ id: 'claude', provider: 'claude', name: 'Claude', mark: 'claude' }), 'claude');
assert.equal(logoKeyOf({ id: 'codex', provider: 'codex', name: 'Codex', mark: 'openai' }), 'openai', 'Codex wears the OpenAI mark');
assert.equal(logoKeyOf({ id: 'antigravity', provider: 'antigravity', name: 'Antigravity', mark: 'gemini' }), 'gemini', 'Antigravity wears the Gemini mark');
assert.equal(logoKeyOf({ provider: 'claude' }), 'claude');
assert.equal(logoKeyOf({ provider: 'codex' }), 'openai');
assert.equal(logoKeyOf({ provider: 'antigravity' }), 'gemini');
// Anthropic and Claude, OpenAI and Codex, Google, Gemini and Antigravity are one logo each; the name decides when nothing else does.
assert.equal(logoKeyOf({ name: 'Anthropic API' }), 'claude');
assert.equal(logoKeyOf({ name: 'Claude Opus' }), 'claude');
assert.equal(logoKeyOf({ name: 'OpenAI' }), 'openai');
assert.equal(logoKeyOf({ name: 'GPT-5' }), 'openai');
assert.equal(logoKeyOf({ name: 'Codex CLI' }), 'openai');
assert.equal(logoKeyOf({ name: 'Google AI' }), 'gemini');
assert.equal(logoKeyOf({ name: 'Gemini 2.5' }), 'gemini');
// Other known marks use their file; unknown or absent ones have no logo and wear an initial.
assert.equal(logoKeyOf({ id: 'model:l1', name: 'qwen3', mark: 'qwen' }), 'qwen');
assert.equal(logoKeyOf({ id: 'model:l2', name: 'Mine', mark: 'unheard-of' }), null);
assert.equal(logoKeyOf({ id: 'model:l2', name: 'Mine', mark: null }), null);
assert.equal(logoKeyOf({ id: 'model:x', name: 'Atlas' }), null);
assert.equal(logoKeyOf(null), null);
assert.equal(initialOf({ name: ' ollama local' }), 'O');
assert.equal(initialOf({}), '?');
const asLogo = modelLogo({ provider: 'claude', name: 'Claude' }, 12);
assert.equal(asLogo.tag, 'svg');
assert.equal(asLogo.attrs.fill, 'currentColor', 'inlined marks follow the theme');
assert.equal(asLogo.attrs['aria-hidden'], 'true');
assert.equal(asLogo.attrs.width, '12');
assert.ok(asLogo.children[0].attrs.d.length > 100, 'the real path is inlined');
assert.match(modelLogo({ mark: 'qwen', name: 'qwen3' }).cls, /nm-file/);
const fallback = modelLogo({ name: 'Mine' });
assert.match(fallback.cls, /nm-initial/);
assert.equal(fallback.textContent, 'M');
console.log('PASS: provider to logo mapping, file marks and the initial fallback');

// ---- Quiet or agents -------------------------------------------------------------------------------------------
assert.equal(quiet.layoutFor(0), 'quiet');
assert.equal(quiet.layoutFor(1), 'quiet');
assert.equal(quiet.layoutFor(2), 'agents');
assert.equal(quiet.layoutFor(4), 'agents');
assert.equal(quiet.workingAgents([{ agent: { id: 'a' } }, { agent: { id: 'a' } }, { agent: { id: 'b' } }, {}]), 2, 'distinct agents, not chats or items');
console.log('PASS: the quiet/agents switch counts distinct working agents');

// ---- Today's figures, from the shapes the endpoints return -------------------------------------------------------
const at = (h, m = 0, day = 0) => new Date(2026, 9, 25 + day, h, m).getTime();
const secs = ms => ms / 1000;
const now = at(14, 35);
assert.equal(quiet.greetingFor(9, 'David'), 'Good morning, David');
assert.equal(quiet.greetingFor(14, 'David'), 'Good afternoon, David');
assert.equal(quiet.greetingFor(20, 'local'), 'Good evening', 'the local account has no name to greet');
assert.equal(quiet.greetingFor(7, ''), 'Good morning');
const sessions = [{ id: 'a1', title: 'Q4 planning', updated_at: secs(at(14, 23)) }, { id: 'b2', title: 'Old', updated_at: secs(at(9, 0, -2)) },
  { id: 'c3', title: 'Today early', updated_at: secs(at(8, 0)) }, { id: 'd4', title: 'Worktree', is_forge: true, updated_at: secs(at(14, 30)) }];
assert.equal(quiet.chatsToday(sessions, now), 2, 'chats touched today, worktrees apart');
assert.equal(quiet.recentChat(sessions).id, 'a1', 'the newest chat that Continue can open');
assert.equal(quiet.recentChat([]), null);
assert.equal(quiet.ageCopy(secs(at(14, 23)), now), '12 min ago');
assert.equal(quiet.ageCopy(secs(at(11, 35)), now), '3 h ago');
assert.equal(quiet.ageCopy(secs(now), now), 'just now');
assert.equal(quiet.snippetFrom([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Here are three  roadmap\nthemes' }, { role: 'assistant', content: '' }]), 'Here are three roadmap themes');
assert.equal(quiet.snippetFrom([{ content: 'x'.repeat(90) }]).length, 70);
assert.equal(quiet.snippetFrom(null), '');
const notes = [{ completed: false, due_date: '2026-10-25T09:00:00' }, { completed: false, due_date: '2026-10-20T09:00:00' },
  { completed: false, due_date: '2026-10-26T09:00:00' }, { completed: true, due_date: '2026-10-25T08:00:00' }, { completed: false }];
assert.equal(quiet.notesDue(notes, now), 2, 'due today or already past, open notes only');
const events = [
  { title: 'Done', start: new Date(at(14, 50)).toISOString(), end: new Date(at(15, 0)).toISOString(), completed: true, source: 'calendar' },
  { title: 'Over', start: new Date(at(13, 0)).toISOString(), end: new Date(at(14, 0)).toISOString(), source: 'google' },
  { title: 'All day', start: '2026-10-25', end: '2026-10-26', all_day: true, source: 'calendar' },
  { title: 'Note', start: new Date(at(14, 40)).toISOString(), source: 'note' },
  { title: 'Design review', start: new Date(at(15, 15)).toISOString(), end: new Date(at(16, 0)).toISOString(), source: 'google', calendar_name: 'Work' },
  { title: 'Later', start: new Date(at(18, 0)).toISOString(), end: new Date(at(19, 0)).toISOString(), source: 'calendar' }];
const next = quiet.nextEvent(events, now);
assert.equal(next.title, 'Design review', 'the next timed, unfinished event; not notes, all-day items or what is over');
assert.equal(quiet.nextEvent([], now), null);
assert.equal(quiet.untilCopy(next, now), 'in 40 min');
assert.equal(quiet.untilCopy(events[5], now), 'in 3 h');
assert.equal(quiet.untilCopy({ start: new Date(at(9, 0, 1)).toISOString() }, now), 'tomorrow');
assert.equal(quiet.untilCopy(next, at(15, 20)), 'now');
assert.equal(quiet.sourceOf(next), 'Work');
assert.equal(quiet.sourceOf({ source: 'google' }), 'Google');
assert.equal(quiet.sourceOf({ source: 'calendar' }), 'Kairos');
assert.equal(quiet.rangeCopy(next).replace(/ /g, ' '), '3:15 – 4:00 PM', 'the meridiem is said once');
assert.match(quiet.prepDraft(next), /^Help me prepare for "Design review" at 3:15/, 'Prep seeds a chat about this event');
assert.ok(quiet.prepDraft({ title: 'x'.repeat(500), start: next.start }).length < 260, 'a long title is cut');
assert.equal(quiet.filledDots(.34), 8);
assert.equal(quiet.filledDots(.61), 15);
assert.equal(quiet.filledDots(2), quiet.DOTS);
assert.equal(quiet.filledDots(-1), 0);
const rows = quiet.usageRows([{ id: 'claude', snap: { status: 'ok', windows: [{ id: 'weekly', used: .6 }, { id: 'session', used: .34 }] } },
  { id: 'codex', snap: { status: 'needsAuth', windows: [] } }, { id: 'antigravity', snap: { status: 'ok', windows: [] } }]);
assert.deepEqual(plain(rows.map(r => [r.model.id, r.used])), [['claude', .34]], 'one row per quota, on the 5-hour window; none for signed-out or quota-less models');
const agent = { id: 's', name: 'Scout', color: '#B9D2E3' };
assert.deepEqual(plain(quiet.statusLine({ focus: null, agents: [agent], doing: new Map() })), { text: 'Scout is resting', detail: '', color: '#B9D2E3' });
assert.equal(quiet.statusLine({ focus: null, agents: [agent], doing: new Map([['s', 'asking research']]) }).detail, 'asking research');
assert.equal(quiet.statusLine({ focus: null, agents: [agent, { id: 'q', name: 'Quill' }], doing: new Map() }), null, 'several resting agents have no single line');
assert.equal(quiet.statusLine({ focus: { title: 'Drafting', detail: 'Chat · receiving response' }, agents: [], doing: new Map() }).text, 'Drafting');
console.log('PASS: greeting, counts, up next, pick-up, snippet, usage rows and the single agent line');

// ---- The side edge ------------------------------------------------------------------------------------------------
assert.ok(side.isSideEdge('left') && side.isSideEdge('right'));
assert.ok(!side.isSideEdge('top-centre') && !side.isSideEdge('top') && !side.isSideEdge(undefined));
assert.equal(side.sideTop(0, 800, 250), 0, 'offset 0 is flush with the top of the window');
assert.equal(side.sideTop(1, 800, 250), 550, 'offset 1 ends flush with the bottom');
assert.equal(side.sideTop(.5, 800, 250), 275, 'and the middle is the middle');
assert.equal(side.sideTop(.5, 800, 560), 120, 'an expanded panel is placed by its own height');
for (const size of [44, 250, 560, 780]) for (const offset of [-5, 0, .3, 1, 7, NaN, undefined]) {
  const top = side.sideTop(offset, 800, size);
  assert.ok(top >= 0 && top + size <= 800, `${size} @${offset} stays inside the window (${top})`);
}
assert.equal(side.sideTop(1, 838, 621.3333) + 621.3333, 838, 'a fractional height still ends flush at offset 1');
assert.equal(side.sideTop(1, 400, 900), 0, 'a notch taller than the window sticks to the top');
assert.equal(side.sideTop(NaN, 800, 250), 275, 'no offset means the middle');
const viewport = { width: 656, height: 800 }, card = { width: 246, height: 180 };
const shellLeft = { left: 0, right: 380 }, shellRight = { left: 276, right: 656 }, word = { top: 300, bottom: 320 };
assert.deepEqual(plain(side.sideCardAt('left', shellLeft, word, card, viewport)), { left: 388, top: 220 }, 'the card opens inward of the left panel, level with the reading');
assert.deepEqual(plain(side.sideCardAt('right', shellRight, word, card, viewport)), { left: 22, top: 220 }, 'and inward of the right panel');
assert.equal(side.sideCardAt('left', shellLeft, { top: 0, bottom: 10 }, card, viewport).top, 8, 'kept inside the top of the window');
assert.equal(side.sideCardAt('left', shellLeft, { top: 790, bottom: 800 }, card, viewport).top, 800 - 180 - 8, 'and the bottom');
console.log('PASS: side notch placement stays inside the window; the usage card opens inward');

// ---- What the notch asks the app to do -----------------------------------------------------------------------------
assert.deepEqual(TARGETS, ['home', 'chat', 'settings', 'notes', 'talk', 'attach']);
assert.equal(navigation('rm -rf', {}), null);
assert.equal(navigation('browser', {}), null);
assert.deepEqual(navigation('chat', { sessionId: 'a1b2c3d4e5f6' }), { target: 'chat', detail: { sessionId: 'a1b2c3d4e5f6' } });
assert.deepEqual(navigation('chat', { sessionId: '../../x' }), { target: 'chat', detail: {} }, 'a session id is checked');
assert.deepEqual(navigation('chat', { draft: 'Help me prepare' }), { target: 'chat', detail: { draft: 'Help me prepare' } });
assert.equal(navigation('chat', { draft: 'x'.repeat(5000) }).detail.draft.length, 600, 'a draft is bounded');
assert.deepEqual(navigation('notes', { draft: 'ignored' }), { target: 'notes', detail: {} }, 'only chat takes details');
assert.deepEqual(navigation('home', undefined), { target: 'home', detail: {} });
assert.deepEqual(plain(notchNavigation('chat', {})), { tab: 'chat', options: {} }, 'New chat is the chat tab, as the sidebar opens it');
assert.deepEqual(plain(notchNavigation('chat', { sessionId: 'a1' })), { tab: 'chat', options: { sessionId: 'a1' } }, 'Continue opens that chat');
assert.deepEqual(plain(notchNavigation('chat', { draft: 'Help' })), { tab: 'chat', options: { mobileDraft: 'Help' } }, 'Prep opens a chat with the draft in the composer, unsent');
assert.deepEqual(plain(notchNavigation('settings', {})), { tab: 'settings', options: { section: 'appearance' } }, 'Settings still lands on Appearance');
assert.equal(notchNavigation('notes').then.selector, 'input[aria-label="New note"]');
assert.deepEqual(plain(notchNavigation('talk').then), { selector: '#chat-openmic', click: true });
assert.deepEqual(plain(notchNavigation('attach').then), { selector: '#overflow-plus-btn', click: true });
assert.deepEqual(plain(notchNavigation('home', {})), { tab: 'home', options: {} });
// The four quick actions, Prep and Continue are wired to those targets.
const sent = [];
const actions = quiet.quickActions({ openApp: (...args) => sent.push(args) }, ['New chat', 'Note', 'Talk', 'Drop files']);
assert.deepEqual(plain(actions.map(a => a.attrs['aria-label'])), ['New chat', 'Note', 'Talk', 'Drop files']);
for (const a of actions) a.events.click({ stopPropagation() {} });
assert.deepEqual(plain(sent), [['chat'], ['notes'], ['talk'], ['attach']]);
const tileSent = [];
const tile = quiet.upNextTile({ openApp: (...args) => tileSent.push(args) }, next, { now });
const prep = tile.children.find(c => c.attrs['aria-label']?.startsWith('Prep with Kairos'));
prep.events.click({ stopPropagation() {} });
assert.equal(tileSent[0][0], 'chat');
assert.match(tileSent[0][1].draft, /Design review/);
assert.ok(!quiet.upNextTile({}, next, { prep: false, now }).children.some(c => c.attrs['aria-label']?.startsWith('Prep')), 'the side notch lists the event without Prep');
console.log('PASS: quick actions, Prep and Continue reach the app through checked targets');

// ---- Real endpoints, no more than the app already reads --------------------------------------------------------------
(async () => {
  const asked = [], answers = { '/api/auth/status': { username: 'David' }, '/api/sessions': sessions, '/api/notes?include_completed=false': notes };
  const data = quiet.createQuietData(() => {}, async url => {
    asked.push(url);
    if (url.startsWith('/api/calendar/events')) return 'denied';
    if (url.startsWith('/api/sessions/')) return { messages: [{ role: 'assistant', content: 'Here are three roadmap themes' }] };
    return answers[url] ?? null;
  });
  await data.refresh(true);
  assert.equal(data.data.name, 'David');
  assert.equal(data.data.sessions.length, 4);
  assert.equal(data.data.notes.length, 5);
  assert.equal(data.data.events, null, 'a route the user may not read leaves its module out');
  assert.equal(data.data.snippet.text, 'Here are three roadmap themes');
  assert.equal(asked.filter(url => url.startsWith('/api/sessions/')).length, 1, 'only the latest chat is read for its snippet');
  await data.refresh(true);
  assert.equal(asked.filter(url => url.startsWith('/api/calendar')).length, 1, 'a denied route is not asked again');
  assert.equal(asked.filter(url => url.startsWith('/api/sessions/')).length, 1, 'nor is an unchanged chat re-read');
  console.log('PASS: the quiet view reads only existing endpoints and leaves out what it cannot read');
})().catch(error => { console.error(error); process.exitCode = 1; });
