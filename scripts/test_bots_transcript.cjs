// Bots transcript logic (Phase 1, U3): rows, windowing, follow, folding, splitting, announcements,
// search landing and attachments. No DOM is needed. Run: node scripts/test_bots_transcript.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', file)).href);

(async () => {
  // The DOM-building halves only touch `document` when called, so the modules import in plain Node.
  const T = await load('botsTranscript.js');
  const A = await load('botsMessageActions.js');
  const S = await load('botsChatSearch.js');
  const F = await load('botsChatAttachments.js');
  const at = (y, mo, d, hh = 12, mm = 0) => new Date(y, mo - 1, d, hh, mm).getTime() / 1000;
  const NOW = at(2026, 10, 29, 15, 0);
  const msg = (id, role, ts, extra = {}) => ({ id, role, ts, content: `${id} text`, ...extra });

  // Day labels.
  assert.equal(T.dayLabel(at(2026, 10, 29, 9), NOW), 'Today');
  assert.equal(T.dayLabel(at(2026, 10, 28, 23, 59), NOW), 'Yesterday');
  assert.equal(T.dayLabel(at(2026, 10, 25, 9), NOW), new Date(2026, 9, 25).toLocaleDateString([], { weekday: 'long' }));
  assert.match(T.dayLabel(at(2026, 9, 1), NOW), /Sep/);
  assert.match(T.dayLabel(at(2025, 9, 1), NOW), /2025/, 'another year names the year');
  assert.equal(T.dayLabel(NaN, NOW), '');

  // Rows: day markers, joined senders, a quiet gap, the unread divider.
  let rows = T.buildRows([msg('a', 'user', at(2026, 10, 28, 9)), msg('b', 'assistant', at(2026, 10, 28, 9, 1)), msg('c', 'assistant', at(2026, 10, 28, 9, 2)),
    msg('d', 'user', at(2026, 10, 29, 9)), msg('e', 'assistant', at(2026, 10, 29, 9, 1)), msg('f', 'assistant', at(2026, 10, 29, 12))], { now: NOW, readId: 'f' });
  assert.deepEqual(rows.map(r => r.type), ['day', 'message', 'message', 'message', 'day', 'message', 'message', 'day', 'message']);
  assert.deepEqual(rows.filter(r => r.type === 'day').map(r => r.label.split(' ')[0]), ['Yesterday', 'Today', 'Today']);
  const [, ra, rb, rc] = rows;
  assert.equal(rb.joinPrev, false, 'a reply after the person starts a new group');
  assert.equal(rc.joinPrev, true); assert.equal(rb.joinNext, true);
  assert.equal(ra.joinNext, false);
  assert.equal(T.buildRows(rows.filter(r => r.message).map(r => r.message), { now: NOW, simple: false }).filter(r => r.type === 'day').length, 2, 'the quiet-gap stamp is Simple only');

  const msgs = [msg('u1', 'user', NOW - 500), msg('a1', 'assistant', NOW - 400), msg('a2', 'assistant', NOW - 300), msg('u2', 'user', NOW - 200), msg('a3', 'assistant', NOW - 100)];
  const types = r => r.map(x => x.type + (x.message ? `:${x.message.id}` : ''));
  assert.deepEqual(types(T.buildRows(msgs, { now: NOW, readId: 'a1' })), ['day', 'message:u1', 'message:a1', 'message:a2', 'message:u2', 'unread', 'message:a3'], 'the person speaking later settles earlier replies');
  assert.deepEqual(types(T.buildRows(msgs.slice(0, 3), { now: NOW, readId: 'a1' })), ['day', 'message:u1', 'message:a1', 'unread', 'message:a2']);
  assert.ok(!types(T.buildRows(msgs.slice(0, 3), { now: NOW, readId: 'a2' })).includes('unread'), 'a read cursor at the end leaves nothing new');
  assert.ok(!types(T.buildRows(msgs.slice(1, 3), { now: NOW })).includes('unread'), 'with no person message and no cursor nothing is "new"');
  assert.equal(T.buildRows([msg('x', 'user', NOW), msg('c', 'assistant', NOW, { kind: 'digest' })], { now: NOW }).at(-1).rich, true);

  // Windowing: 120 shown, appends follow only at the latest, older pages keep their place.
  const many = Array.from({ length: 300 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', NOW - 1000 + i));
  const win = T.createWindow();
  win.set(many);
  assert.equal(win.slice().length, 120);
  assert.equal(win.slice()[0].id, 'm180'); assert.equal(win.hiddenAbove(), 180); assert.equal(win.atLatest(), true);
  assert.equal(win.append(msg('m300', 'user', NOW)), true);
  assert.equal(win.slice().length, 120); assert.equal(win.slice().at(-1).id, 'm300'); assert.equal(win.slice()[0].id, 'm181');
  assert.equal(win.append(msg('m300', 'user', NOW, { content: 'changed' })), false, 'a known message is merged, not added twice');
  assert.equal(win.get('m300').content, 'changed');
  assert.equal(win.revealOlder(40), 40);
  assert.equal(win.slice()[0].id, 'm141'); assert.equal(win.slice().length, 160);
  win.revealOlder(500);
  assert.ok(win.slice().length <= 240, 'the window never grows past twice its size');
  assert.equal(win.atLatest(), false, 'revealing older rows can push the latest out');
  assert.ok(win.hiddenBelow() > 0);
  win.latest();
  assert.equal(win.slice().length, 120); assert.equal(win.atLatest(), true);
  win.around('m10');
  assert.ok(win.slice().some(m => m.id === 'm10')); assert.equal(win.atLatest(), false);
  assert.equal(win.append(msg('m301', 'user', NOW)), false, 'an append while reading old rows does not move the window');
  assert.equal(win.around('missing'), false);
  const before = win.slice().length, first = win.slice()[0].id;
  win.set(many); win.revealOlder(0);
  assert.equal(win.prepend([msg('old1', 'user', 1), msg('old2', 'user', 2), many[0]]), 2, 'a duplicate in an older page is ignored');
  assert.equal(win.slice()[0].id, 'm180', 'the rows on screen did not change when an older page arrived');
  assert.equal(win.hiddenAbove(), 182);
  assert.ok(before > 0 && first);
  assert.equal(win.remove('m200'), true); assert.equal(win.has('m200'), false);

  // The viewport anchor after a prepend.
  assert.equal(T.anchorAfterPrepend({ scrollTop: 40, scrollHeight: 1000 }, 1900), 940);
  assert.equal(T.anchorAfterPrepend({ scrollTop: 0, scrollHeight: 500 }, 500), 0);

  // Bottom-follow: growth never breaks it, an upward gesture does, reaching the bottom resumes.
  const follow = T.createFollow();
  follow.scrolled({ top: 0, height: 2000, client: 600 });
  assert.equal(follow.following(), true, 'content growth alone leaves following on');
  assert.equal(T.upwardGesture({ type: 'wheel', deltaY: 40 }), false);
  assert.equal(T.upwardGesture({ type: 'wheel', deltaY: -3 }), true);
  assert.equal(T.upwardGesture({ type: 'keydown', key: 'PageUp' }, { typing: false }), true);
  assert.equal(T.upwardGesture({ type: 'keydown', key: 'PageUp' }, { typing: true }), false, 'keys in the editor do not count');
  assert.equal(T.upwardGesture({ type: 'keydown', key: 'a' }), false);
  assert.equal(T.upwardGesture({ type: 'touchmove', movedDown: true }), true);
  assert.equal(T.upwardGesture({ type: 'pointerdown', onScrollbar: true }), true);
  follow.gesture(); assert.equal(follow.following(), false);
  follow.scrolled({ top: 100, height: 2000, client: 600 }); assert.equal(follow.following(), false, 'scrolling elsewhere stays released');
  follow.scrolled({ top: 1330, height: 2000, client: 600 }); assert.equal(follow.following(), true, 'within reach of the bottom resumes');

  // Conversational splitting keeps fenced code whole.
  assert.deepEqual(T.splitConversational('One.\n\nTwo.\n\n\nThree.'), ['One.', 'Two.', 'Three.']);
  assert.deepEqual(T.splitConversational('Run this:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.'), ['Run this:', '```js\nconst a = 1;\n\nconst b = 2;\n```', 'Done.']);
  assert.deepEqual(T.splitConversational('A\n\n~~~\nx\n\ny\n~~~\n\nB'), ['A', '~~~\nx\n\ny\n~~~', 'B'], 'tilde fences too');
  assert.deepEqual(T.splitConversational('Open\n\n```\nnever closed\n\nstill code'), ['Open', '```\nnever closed\n\nstill code'], 'an unterminated fence runs to the end');
  assert.deepEqual(T.splitConversational('A\n\n````\n```\n\n```\n````\n\nB'), ['A', '````\n```\n\n```\n````', 'B'], 'a shorter fence inside a longer one does not close it');
  assert.deepEqual(T.splitConversational('   '), ['']);
  assert.equal(T.shouldCollapse('x'.repeat(601)), true); assert.equal(T.shouldCollapse('x'.repeat(600)), false);
  assert.equal(T.shouldCollapse('a\n'.repeat(9)), true); assert.equal(T.shouldCollapse('a\nb\nc'), false);
  assert.equal(T.firstSentence('All done. Then more words follow.'), 'All done.');
  assert.equal(T.firstSentence('x'.repeat(300)).length, 120);

  // Tool steps: starts and finishes pair up; finished runs fold; a running step stays visible.
  const steps = T.normalizeSteps({ toolSteps: [{ id: 'r1', phase: 'started', name: 'read_file', summary: 'Read notes' }, { id: 'r1', phase: 'finished', ok: true },
    { id: 's1', phase: 'started', name: 'search' }, { id: 's1', phase: 'finished', ok: true }, { id: 'c1', phase: 'started', name: 'run_command', summary: 'Run tests' },
    { id: 'w1', phase: 'finished', ok: false, name: 'write_file', summary: 'Save' }], toolEvents: [] });
  assert.deepEqual(steps.map(s => s.state), ['done', 'done', 'running', 'failed']);
  assert.equal(steps[0].summary, 'Read notes', 'a finish keeps the start summary');
  const folded = T.foldSteps(steps);
  assert.deepEqual(folded.map(f => f.type), ['run', 'step', 'step']);
  assert.equal(folded[0].count, 2); assert.equal(T.foldLabel(2), 'Used 2 tools');
  assert.equal(T.foldSteps(steps.slice(0, 1))[0].type, 'step', 'a single finished step is not folded');
  const paired = T.normalizeSteps({ toolEvents: [{ kind: 'tool_started', name: 'computer' }, { kind: 'tool_finished', name: 'computer' }] });
  assert.equal(paired.length, 1, 'events without IDs pair by tool name');
  assert.equal(T.stepVerb({ name: 'web_search' }), 'Searching'); assert.equal(T.stepVerb({ name: 'bash' }), 'Running a command'); assert.equal(T.stepVerb({}), 'Writing');

  // The live line.
  const live = { status: 'processing', startedAt: 1000, text: '', toolSteps: [], toolEvents: [] };
  assert.equal(T.liveStatus(live, 1072).line, 'Thinking · 1m 12s');
  assert.equal(T.liveStatus({ ...live, text: 'hi' }, 1005).verb, 'Writing');
  assert.equal(T.liveStatus({ ...live, toolSteps: [{ id: 'x', phase: 'started', name: 'read_file' }] }, 1005).verb, 'Reading');
  assert.equal(T.liveStatus({ ...live, permission: { id: 'p' } }, 1005).state, 'needs');
  assert.equal(T.liveStatus({ ...live, stopping: true, permission: { id: 'p' } }, 1005).verb, 'Stopping');
  assert.equal(T.liveStatus({ ...live, pausedSeconds: 30 }, 1040).line, 'Thinking · 10s', 'time spent waiting on the person is not counted');
  assert.equal(T.liveStatus(null), null);
  assert.equal(T.digestLabel({ seconds: 12, tools: 5, files: 2 }), 'Worked for 12s · 5 tools, 2 files');
  assert.equal(T.digestLabel({ seconds: 75, tools: 1 }), 'Worked for 1m 15s · 1 tool');
  assert.equal(T.digestLabel({ seconds: 3 }), 'Worked for 3s');
  assert.equal(T.verifySummary([{ status: 'passed' }, { status: 'failed' }, { status: 'passed' }]), '3 steps · 2 verified · 1 failed');

  // Announcements: once per transition, never for the person's own stop.
  const seen = new Set();
  const turn = { turnId: 't1', status: 'processing', text: '' };
  assert.equal(T.announcementFor(turn, 'Scout', seen), null);
  assert.equal(T.announcementFor({ ...turn, permission: { id: 'p1' } }, 'Scout', seen), 'Scout needs your answer.');
  assert.equal(T.announcementFor({ ...turn, permission: { id: 'p1' } }, 'Scout', seen), null, 'the same question is announced once');
  assert.equal(T.announcementFor({ ...turn, permission: { id: 'p2' } }, 'Scout', seen), 'Scout needs your answer.', 'a new question is announced');
  assert.equal(T.announcementFor({ ...turn, status: 'done', text: 'The report is ready. More follows.' }, 'Scout', seen), 'Scout replied: The report is ready.');
  assert.equal(T.announcementFor({ ...turn, status: 'done', text: 'again' }, 'Scout', seen), null);
  assert.equal(T.announcementFor({ turnId: 't2', status: 'stopped', text: 'partial' }, 'Scout', seen), null, 'a stop is quiet');
  assert.match(T.announcementFor({ turnId: 't3', status: 'failed', error: 'No connection.' }, 'Scout', seen), /could not finish. No connection./);

  // Message actions.
  const ids = (m, c) => A.actionList(m, c).map(a => a.id);
  assert.deepEqual(ids(msg('u', 'user', 1), {}), ['reply', 'react', 'copy', 'pin', 'edit', 'raw', 'copy-id']);
  assert.deepEqual(ids(msg('a', 'assistant', 1), { lastAssistantId: 'a', canSpeak: true }), ['reply', 'react', 'copy', 'pin', 'regenerate', 'speak', 'raw', 'copy-id', 'report']);
  assert.ok(!ids(msg('a', 'assistant', 1), { lastAssistantId: 'other' }).includes('regenerate'), 'only the last reply regenerates');
  assert.equal(A.actionList(msg('u', 'user', 1), { busy: true }).find(a => a.id === 'edit').disabled, true, 'edit waits for the turn');
  assert.equal(A.actionList(msg('u', 'user', 1), { pinnedId: 'u' }).find(a => a.id === 'pin').label, 'Unpin');
  assert.equal(A.REACTIONS.length, 6);
  assert.equal(new Set(A.REACTIONS.map(r => r.emoji)).size, 6);

  // Reactions: one per person per message.
  const up = '\u{1F44D}', heart = '❤️';
  assert.deepEqual(A.applyReaction([], up, true), [{ emoji: up, count: 1, mine: true }]);
  assert.deepEqual(A.applyReaction([{ emoji: up, count: 2, mine: false }], up, true), [{ emoji: up, count: 3, mine: true }]);
  assert.deepEqual(A.applyReaction([{ emoji: up, count: 1, mine: true }], heart, true), [{ emoji: heart, count: 1, mine: true }], 'a new choice moves the old one');
  assert.deepEqual(A.applyReaction([{ emoji: up, count: 2, mine: true }], up, false), [{ emoji: up, count: 1, mine: false }]);
  assert.deepEqual(A.applyReaction([{ emoji: up, count: 1, mine: true }], up, false), [], 'a reaction nobody holds disappears');
  assert.deepEqual(A.applyReaction([{ emoji: up, count: 2, mine: false }], up, false), [{ emoji: up, count: 2, mine: false }], 'turning off what is not yours changes nothing');

  // Search: debounce, stale answers, cycling, landing on another branch.
  const timers = []; const setTimer = fn => { timers.push(fn); return timers.length; }; const clearTimer = id => { timers[id - 1] = null; };
  const calls = [];
  const run = S.debounced(v => calls.push(v), 180, { setTimer, clearTimer });
  run('a'); run('ab'); run('abc');
  timers.forEach(fn => fn?.());
  assert.deepEqual(calls, ['abc'], 'only the last keystroke searches');
  assert.equal(S.FIND_DEBOUNCE, 180); assert.equal(S.SIDEBAR_DEBOUNCE, 250); assert.equal(S.PALETTE_DEBOUNCE, 150);
  assert.equal(S.cycle(2, 3, 1), 0); assert.equal(S.cycle(0, 3, -1), 2); assert.equal(S.cycle(0, 0, 1), -1);
  assert.equal(S.searchUrl({ query: 'a b&c', sessionId: 's1' }), '/api/bot-chat/search?q=a+b%26c&limit=100&session_id=s1');
  assert.deepEqual(S.normalizeHits({ hits: [{ message_id: 'm1', snippet: 'x', active: false, leaf_id: 'l2' }, { nope: 1 }] }).map(h => [h.message_id, h.active, h.leaf_id]), [['m1', false, 'l2']]);
  const trail = [];
  let shown = false, token = 0;
  const ctx = { currentSession: () => 's1', token: () => token, openThread: async id => trail.push(`open:${id}`), selectBranch: async id => trail.push(`branch:${id}`),
    loadAround: async id => { trail.push(`load:${id}`); shown = true; }, scrollTo: id => { if (!shown) return false; trail.push(`scroll:${id}`); return true; }, flash: id => trail.push(`flash:${id}`) };
  assert.equal(await S.landOnHit({ message_id: 'm9', session_id: 's2', leaf_id: 'leaf9', active: false }, ctx), true);
  assert.deepEqual(trail, ['open:s2', 'branch:leaf9', 'load:m9', 'scroll:m9', 'flash:m9'], 'thread, then branch, then page in, then scroll');
  trail.length = 0; shown = false;
  assert.equal(await S.landOnHit({ message_id: 'm5', session_id: 's1', active: true }, ctx), true);
  assert.deepEqual(trail, ['load:m5', 'scroll:m5', 'flash:m5'], 'an unloaded hit pages in around itself first');
  trail.length = 0; shown = true;
  const slow = { ...ctx, openThread: async () => { token++; } };
  assert.equal(await S.landOnHit({ message_id: 'm1', session_id: 'other', active: true }, slow), false, 'a newer landing cancels an older one');
  assert.deepEqual(trail, []);

  // Attachments.
  const file = (type, size, name = 'f') => ({ type, size, name });
  assert.equal(F.validateFile(file('image/png', 100)), '');
  assert.match(F.validateFile(file('image/svg+xml', 100)), /PNG, JPEG, GIF or WebP/, 'SVG is refused');
  assert.match(F.validateFile(file('image/png', 11 * 1048576)), /10 MB/);
  assert.match(F.validateFile(file('application/pdf', 26 * 1048576)), /25 MB/);
  assert.equal(F.validateFile(file('application/pdf', 24 * 1048576)), '');
  assert.match(F.validateFile(file('image/png', 0)), /empty/);
  assert.equal(F.shouldChipPaste('x'.repeat(901)), true); assert.equal(F.shouldChipPaste('a\n'.repeat(13)), true); assert.equal(F.shouldChipPaste('short'), false);
  assert.deepEqual(F.galleryItems(new Array(9).fill({}), {}), { shown: new Array(4).fill({}), hidden: 5 });
  assert.equal(F.galleryItems(new Array(9).fill({}), { beneath: true }).shown.length, 6);
  assert.equal(F.galleryItems(new Array(9).fill({}), { expanded: true }).hidden, 0);
  assert.equal(F.clampAspect(10), 2.4); assert.equal(F.clampAspect(0.1), 0.6); assert.equal(F.clampAspect(NaN), 4 / 3);
  assert.equal(F.kindOf({ mime: 'image/webp' }), 'image'); assert.equal(F.kindOf({ mime: 'video/mp4' }), 'video'); assert.equal(F.kindOf({ mime: 'application/zip' }), 'file'); assert.equal(F.kindOf({ name: 'a.PNG' }), 'image');
  assert.equal(F.fileUrl('s 1', { id: 'a/b' }), '/api/chat/images/s%201/a%2Fb');

  // The uploader: ready state, a retry on a transient failure, failures kept visible, submission blocked while uploading.
  const revoked = [];
  let attempts = 0;
  const gates = [];
  const uploader = F.createUploader({
    upload: file => new Promise((resolve, reject) => gates.push({ file, resolve, reject })),
    makePreview: f => `blob:${f.name}`, revoke: url => revoked.push(url),
  });
  const adding = uploader.add([{ name: 'a.png', type: 'image/png', size: 5 }, { name: 'b.txt', type: 'text/plain', size: 5 }, { name: 'bad.svg', type: 'image/svg+xml', size: 5 }]);
  await Promise.resolve();
  assert.equal(uploader.busy(), true); assert.deepEqual(uploader.ids(), []);
  gates[0].resolve({ id: 'att-a', name: 'a.png' });
  gates[1].reject(Object.assign(new Error('Too busy'), { status: 429 }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(gates.length, 3, 'a 429 is retried once');
  gates[2].reject(Object.assign(new Error('Still busy'), { status: 429 }));
  const problems = await adding;
  assert.equal(uploader.busy(), false);
  assert.deepEqual(uploader.ids(), ['att-a']);
  assert.equal(uploader.items().find(i => i.name === 'b.txt').state, 'failed');
  assert.equal(problems.length, 2); assert.ok(problems.some(p => /PNG, JPEG, GIF or WebP/.test(p)));
  uploader.remove(uploader.items()[0].key);
  assert.deepEqual(revoked, ['blob:a.png'], 'removing a file revokes its preview');
  uploader.dispose(); void attempts;
  const kept = F.createUploader({ upload: async () => ({ id: 'x' }), initialIds: ['att-1', 'att-2'] });
  assert.deepEqual(kept.ids(), ['att-1', 'att-2'], 'draft attachment IDs come back ready');
  const full = F.createUploader({ upload: async () => ({ id: 'y' }), initialIds: Array.from({ length: 10 }, (_, i) => `i${i}`) });
  assert.equal((await full.add([{ name: 'z', type: 'text/plain', size: 3 }])).length, 1, 'ten is the cap');
  console.log('PASS: bots transcript rows, windowing, follow, folding, announcements, search landing and attachments.');
})().catch(error => { console.error(error); process.exit(1); });
