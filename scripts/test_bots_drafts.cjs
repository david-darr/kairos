// Bots drafts (Phase 1, U3): persistence, scoping, revisions and the send receipt.
// Run: node scripts/test_bots_drafts.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = () => { const map = new Map(); return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }; };
const timers = () => { const jobs = new Map(); let n = 0; return { jobs, setTimer: fn => { jobs.set(++n, fn); return n; }, clearTimer: id => jobs.delete(id), run() { const all = [...jobs.values()]; jobs.clear(); all.forEach(fn => fn()); } }; };

(async () => {
  const { createBotDraft, draftKey, DRAFT_DELAY } = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsDrafts.js')).href);
  const scope = { person: 'dana', bot: 'a1', thread: 't1' };
  let ids = 0;
  const make = (storage, clock = timers(), s = scope) => ({ clock, draft: createBotDraft(s, { storage, uuid: () => `send-${++ids}`, setTimer: clock.setTimer, clearTimer: clock.clearTimer }) });

  // Scope: a draft needs all three parts and each part separates the key.
  assert.throws(() => createBotDraft({ person: 'dana', bot: 'a1' }, { storage: store() }));
  assert.notEqual(draftKey(scope), draftKey({ ...scope, thread: 't2' }));
  assert.notEqual(draftKey(scope), draftKey({ ...scope, person: 'sam' }));
  assert.notEqual(draftKey({ person: 'a:b', bot: 'c', thread: 'd' }), draftKey({ person: 'a', bot: 'b:c', thread: 'd' }), 'colons in an ID cannot merge scopes');
  assert.equal(DRAFT_DELAY, 500);

  // Debounce: nothing is stored until the delay fires; flush stores at once.
  let storage = store(), { draft, clock } = make(storage);
  draft.update({ text: 'hello' });
  assert.equal(storage.map.size, 0);
  assert.equal(clock.jobs.size, 1);
  draft.update({ text: 'hello there' });
  assert.equal(clock.jobs.size, 1, 'one timer, restarted');
  clock.run();
  assert.equal(JSON.parse(storage.getItem(draftKey(scope))).text, 'hello there');
  draft.update({ text: 'typed last' }); draft.flush();
  assert.equal(JSON.parse(storage.getItem(draftKey(scope))).text, 'typed last', 'blur and pagehide flush immediately');

  // Reload: text, attachment IDs, reply, citations, mode survive; blob URLs and junk do not.
  draft.update({ attachment_ids: ['att-1', 'blob:http://x/1', 7, ''], reply_to_id: 'm9', citations: [{ quote: 'q', comment: 'c' }], mode: 'goal' }); draft.flush();
  const again = make(storage).draft.read();
  assert.deepEqual([again.text, again.attachment_ids, again.reply_to_id, again.mode], ['typed last', ['att-1'], 'm9', 'goal']);
  assert.equal(again.citations.length, 1);
  assert.equal(make(storage, timers(), { ...scope, thread: 't2' }).draft.read().text, '', 'another thread starts empty');
  assert.equal(make(storage, timers(), { ...scope, person: 'sam' }).draft.read().text, '', 'another person starts empty');
  storage.setItem(draftKey(scope), '{not json');
  assert.equal(make(storage).draft.read().text, '', 'corrupt storage is ignored');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const loose = make(broken).draft; loose.update({ text: 'x' }); assert.equal(loose.flush(), false); assert.equal(loose.read().text, 'x', 'unavailable storage keeps the draft in memory');

  // Limits.
  ({ draft } = make(store()));
  draft.update({ attachment_ids: Array.from({ length: 30 }, (_, i) => `a${i}`) });
  assert.equal(draft.read().attachment_ids.length, 10);

  // Sending: the field is free at once and the receipt persists before transport.
  storage = store(); ({ draft, clock } = make(storage));
  draft.update({ text: 'first', reply_to_id: 'm1', mode: 'goal' });
  const ticket = draft.prepare('leaf-7');
  assert.deepEqual([ticket.payload.send_id, ticket.payload.text, ticket.payload.expected_leaf_id, ticket.payload.reply_to_id, ticket.payload.mode], [`send-${ids}`, 'first', 'leaf-7', 'm1', 'goal']);
  assert.equal(draft.read().text, '', 'the editor is cleared as the send starts');
  assert.equal(JSON.parse(storage.getItem(draftKey(scope))).pending.payload.text, 'first', 'the receipt is stored before any request');
  assert.equal(draft.prepare('leaf-8').payload.send_id, ticket.payload.send_id, 'a second send returns the same pending receipt');
  assert.equal(draft.prepare('leaf-8').payload.expected_leaf_id, 'leaf-7', 'a retry keeps its first leaf');

  // A lost response: reload keeps the receipt, and Retry uses the same send ID and text.
  const reloaded = make(storage).draft;
  assert.equal(reloaded.outbox().retry, true);
  assert.equal(reloaded.prepare('later').payload.send_id, ticket.payload.send_id);
  assert.equal(reloaded.prepare('later').payload.text, 'first');

  // Delayed acceptance does not touch typing done meanwhile.
  draft.update({ text: 'typed while waiting' });
  assert.equal(draft.accepted(ticket), true);
  assert.equal(draft.read().text, 'typed while waiting');
  assert.equal(draft.read().pending, null);
  assert.equal(draft.outbox(), null);
  assert.equal(draft.accepted(ticket), false, 'a second acceptance is a no-op');

  // Refusal with an untouched editor restores it; the next send gets a new ID.
  ({ draft } = make(store()));
  draft.update({ text: 'refused', attachment_ids: ['att-2'] });
  const refused = draft.prepare(null);
  assert.equal(draft.rejected(refused), true);
  assert.deepEqual([draft.read().text, draft.read().attachment_ids], ['refused', ['att-2']]);
  assert.notEqual(draft.prepare(null).payload.send_id, refused.payload.send_id);

  // Refusal after newer typing cannot overwrite it: the old text waits in the not-sent row.
  ({ draft } = make(store()));
  draft.update({ text: 'old text' });
  const old = draft.prepare(null);
  draft.update({ text: 'new text' });
  draft.rejected(old);
  assert.equal(draft.read().text, 'new text');
  assert.equal(draft.outbox().payload.text, 'old text');
  assert.equal(draft.outbox().retry, false);
  draft.reopen();
  assert.equal(draft.read().text, 'old text\nnew text', 'reopening puts the old text first and keeps the new');
  assert.equal(draft.outbox(), null);
  draft.update({ text: 'again' });
  const third = draft.prepare(null); draft.update({ text: 'typed' }); draft.rejected(third);
  assert.equal(draft.discardFailed(), true);
  assert.equal(draft.outbox(), null);
  assert.equal(draft.read().text, 'typed');

  // A stale ticket cannot settle someone else's send.
  ({ draft } = make(store()));
  draft.update({ text: 'a' });
  const a = draft.prepare(null);
  assert.equal(draft.rejected({ payload: { send_id: 'other' }, revision: 0 }), false);
  assert.equal(draft.accepted({ payload: { send_id: 'other' } }), false);
  assert.equal(draft.outbox().payload.send_id, a.payload.send_id);

  // An empty draft leaves no storage behind.
  storage = store(); ({ draft } = make(storage));
  draft.update({ text: 'x' }); draft.flush(); assert.equal(storage.map.size, 1);
  draft.update({ text: '' }); draft.flush(); assert.equal(storage.map.size, 0);

  // Extras (Phase 6): the open data result and pointed app parts are frozen into the payload, survive a reload,
  // are bounded, and a retry keeps them even if the extras have changed since.
  storage = store(); ({ draft } = make(storage));
  draft.update({ text: 'why is this so high?' });
  const pointed = Array.from({ length: 7 }, (_, i) => ({ tag: 'button-very-long-tag-name-here', label: `Label ${i} `.repeat(10), extra: 'dropped' }));
  const withExtras = draft.prepare('leaf-1', { data_context: { cardId: 'c1', draftSql: 'select 1' }, pointed });
  assert.deepEqual(withExtras.payload.data_context, { cardId: 'c1', draftSql: 'select 1' });
  assert.equal(withExtras.payload.pointed.length, 5, 'at most five pointed parts');
  assert.ok(withExtras.payload.pointed.every(p => Object.keys(p).join() === 'tag,label' && p.tag.length <= 20 && p.label.length <= 40), 'tag and label only, clipped');
  assert.deepEqual(draft.prepare('leaf-2', { data_context: { cardId: 'other' } }).payload.data_context, { cardId: 'c1', draftSql: 'select 1' }, 'a retry sends what was first sent');
  const reopened = make(storage).draft;
  assert.deepEqual(reopened.outbox().payload.pointed, withExtras.payload.pointed, 'extras survive a reload with the pending send');
  storage = store(); ({ draft } = make(storage));
  draft.update({ text: 'plain' });
  const plain = draft.prepare('leaf-1', { data_context: null, pointed: [] });
  assert.ok(!('data_context' in plain.payload) && !('pointed' in plain.payload), 'nothing extra when there is nothing to send');
  console.log('PASS: bots drafts persist by person, bot and thread, keep one send ID, and never overwrite newer typing.');
})().catch(error => { console.error(error); process.exit(1); });
