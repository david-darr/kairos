// Bots approvals (Phase 3, U1): level inheritance, unsupported levels, and the desktop handshake's order and rollback.
// Run: node scripts/test_bots_approvals.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const desktop = require('../electron/bot-approvals.js');

const view = (over = {}) => ({
  bot_id: 'b1', thread_id: null, mode: 'full', stored: 'full', source: 'bot', inherited: true, revision: 3, reason: null,
  bot_mode: 'full', thread_mode: null,
  levels: [
    { mode: 'ask', label: 'Ask', blurb: 'asks', available: true, reason: null },
    { mode: 'edits', label: 'Edits', blurb: 'edits', available: true, reason: null },
    { mode: 'auto', label: 'Auto', blurb: 'auto', available: true, reason: null },
    { mode: 'full', label: 'Full', blurb: 'full', available: true, reason: null },
    { mode: 'custom', label: 'Custom', blurb: 'custom', available: false, reason: 'Custom is for Codex.' },
  ], ...over,
});

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsApprovalModel.js')).href);

  // Raising is the same rule as the server's.
  assert.equal(M.isRaise('ask', 'full'), true);
  assert.equal(M.isRaise('full', 'ask'), false);
  assert.equal(M.isRaise('full', 'full'), false);
  assert.equal(M.isRaise('full', 'custom'), true, 'custom is always a deliberate step');
  assert.equal(M.isRaise('custom', 'ask'), false);
  assert.equal(M.isRaise('edits', 'auto'), true);

  // Inheritance: the chip says what the conversation follows, and a stored value that is not in force is not hidden.
  assert.equal(M.describe(view()).chip, 'Bot level: Full');
  assert.equal(M.describe(view({ thread_id: 't1' })).chip, 'This conversation follows the bot (Full)');
  const own = M.describe(view({ thread_id: 't1', inherited: false, thread_mode: 'ask', mode: 'ask' }));
  assert.equal(own.chip, 'This conversation: Ask');
  const clamped = M.describe(view({ bot_mode: 'ask', mode: 'ask', thread_id: 't1', inherited: false, thread_mode: 'full', reason: 'Set without your confirmation.' }));
  assert.deepEqual(clamped.lines, ['Set without your confirmation.']);
  assert.ok(M.describe(view({ bot_mode: 'edits', mode: 'ask' })).mismatch, 'saved Edits in force as Ask is shown, not hidden');

  // Simple view selects only what it can honestly show.
  assert.equal(M.simpleChoice(view()), 'full');
  assert.equal(M.simpleChoice(view({ bot_mode: 'ask', mode: 'ask' })), 'ask');
  assert.equal(M.simpleChoice(view({ bot_mode: 'auto', mode: 'auto' })), null, 'Auto selects neither simple choice');
  assert.equal(M.simpleChoice(view({ thread_id: 't', inherited: false, thread_mode: 'edits', mode: 'edits' })), null);

  // Unsupported levels are disabled with a reason, unless they are the current one.
  const options = M.levelOptions(view({ bot_mode: 'ask', mode: 'ask' }));
  assert.equal(options.find(o => o.value === 'custom').disabled, true);
  assert.match(options.find(o => o.value === 'custom').hint, /Codex/);
  assert.equal(options.find(o => o.value === 'full').raise, true);
  assert.equal(options.find(o => o.value === 'ask').raise, false);
  const keep = M.levelOptions(view({ bot_mode: 'custom', mode: 'ask', levels: view().levels }));
  assert.equal(keep.find(o => o.value === 'custom').disabled, false, 'a stored level stays visible');

  assert.match(M.allowanceText({ policy: 'allow', cap: 25, used: 3, remaining: 22 }), /3 of 25.*22 left/);
  assert.match(M.allowanceText({ policy: 'ask', cap: 25 }), /asks before each outside message.*25 a day/);

  // Lowering posts straight away with the revision it read, and is never routed through the desktop.
  const calls = [];
  const post = async (tail, body) => { calls.push([tail, body]); return { mode: body.mode }; };
  let result = await M.changeLevel({ post, desktop: null }, { view: view(), target: 'ask' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['/mode', { mode: 'ask', scope: 'bot', thread_id: null, expected_revision: 3 }]]);
  calls.length = 0;
  result = await M.changeLevel({ post, desktop: null }, { view: view({ thread_id: 't1' }), target: null, scope: 'thread', threadId: 't1' });
  assert.equal(calls[0][1].mode, null);
  assert.equal(calls[0][1].thread_id, 't1');

  // A refused change reports the server's words; a 409 is flagged stale.
  const refuse = async () => { throw Object.assign(new Error('Approval changed somewhere else.'), { status: 409 }); };
  result = await M.changeLevel({ post: refuse }, { view: view(), target: 'ask' });
  assert.deepEqual([result.ok, result.stale, result.message], [false, true, 'Approval changed somewhere else.']);

  // Raising: prepare first, then the desktop; no desktop means no request at all.
  const order = [];
  const deps = { post: async (tail, body) => { order.push(`post ${tail}`); return { request_id: 'r1', revision: 3, mode: body.mode }; },
    revoke: async id => order.push(`revoke ${id}`),
    desktop: { elevate: async request => { order.push(`desktop ${request.request_id}`); return { ok: true }; } } };
  result = await M.changeLevel(deps, { view: view({ bot_mode: 'ask', mode: 'ask' }), target: 'full' });
  assert.deepEqual([result.ok, result.raised], [true, true]);
  assert.deepEqual(order, ['post /elevate', 'desktop r1']);
  order.length = 0;
  result = await M.changeLevel({ ...deps, desktop: null }, { view: view({ bot_mode: 'ask', mode: 'ask' }), target: 'full' });
  assert.equal(result.ok, false);
  assert.match(result.message, /desktop app/);
  assert.deepEqual(order, [], 'nothing was prepared');

  // A refused or failed desktop step revokes the request.
  for (const elevate of [async () => ({ ok: false, message: 'Nothing was changed.' }), async () => { throw new Error('boom'); }]) {
    order.length = 0;
    result = await M.changeLevel({ ...deps, desktop: { elevate } }, { view: view({ bot_mode: 'ask', mode: 'ask' }), target: 'full' });
    assert.equal(result.ok, false);
    assert.deepEqual(order, ['post /elevate', 'revoke r1']);
  }
  result = await M.changeLevel({ ...deps, post: async () => { throw new Error('Approval changed somewhere else.'); } },
    { view: view({ bot_mode: 'ask', mode: 'ask' }), target: 'full' });
  assert.equal(result.message, 'Approval changed somewhere else.');

  // ---- the desktop side: validation, the native prompt, step order, and rollback ----
  const request = { request_id: 'r1', bot_id: 'b1', thread_id: null, mode: 'full', revision: 3, bot_name: 'Scout' };
  assert.equal(desktop.valid(request), true);
  for (const bad of [null, {}, { ...request, mode: 'ask' }, { ...request, revision: -1 }, { ...request, request_id: '' }, { ...request, thread_id: 5 }]) {
    assert.equal(desktop.valid(bad), false, JSON.stringify(bad));
  }
  const prompt = desktop.promptFor(request);
  assert.match(prompt.message, /Let Scout work at Full everywhere\?/);
  assert.equal(prompt.defaultId, 0, 'Cancel is the default');
  assert.ok(!/[—–]/.test(JSON.stringify(prompt)), 'no dashes in the prompt');
  assert.match(desktop.promptFor({ ...request, thread_id: 't' }).message, /in this conversation/);

  const make = (answer, failAt) => {
    const log = [];
    const fetch = async (url, init) => {
      const step = url.split('/').pop();
      log.push({ step, secret: init.headers['X-Kairos-Desktop'], body: JSON.parse(init.body) });
      if (step === failAt) return { ok: false, json: async () => ({ detail: 'That step is out of order.' }) };
      return { ok: true, json: async () => ({}) };
    };
    const dialog = { showMessageBox: async () => { log.push({ step: 'prompt' }); return { response: answer }; } };
    return { log, elevate: desktop.createElevation({ dialog, fetch, backendUrl: 'http://x', secret: 'S3', parent: () => undefined }) };
  };
  let run = make(1);
  assert.deepEqual(await run.elevate(request), { ok: true });
  assert.deepEqual(run.log.map(e => e.step), ['prompt', 'confirm', 'activate', 'commit'], 'prompt before any step, then in order');
  assert.ok(run.log.slice(1).every(e => e.secret === 'S3'), 'every step carries the desktop secret');
  assert.equal(run.log[1].body.bot_id, 'b1');

  run = make(0);
  assert.deepEqual(await run.elevate(request), { ok: false, message: 'Nothing was changed.' });
  assert.deepEqual(run.log.map(e => e.step), ['prompt', 'revoke'], 'cancelling changes nothing and revokes');

  run = make(1, 'activate');
  const failed = await run.elevate(request);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /out of order/);
  assert.deepEqual(run.log.map(e => e.step), ['prompt', 'confirm', 'activate', 'revoke'], 'a failed step stops and revokes');

  run = make(1);
  assert.equal((await desktop.createElevation({ dialog: { showMessageBox: async () => ({ response: 1 }) }, fetch: async () => ({ ok: true, json: async () => ({}) }),
    backendUrl: 'http://x', secret: null })(request)).ok, false, 'no secret, no confirmation');
  assert.equal((await run.elevate({ ...request, mode: 'ask' })).ok, false);

  // The IPC handler answers the app window only.
  let handler;
  const ipcMain = { handle: (channel, fn) => { assert.equal(channel, 'bot-approvals:elevate'); handler = fn; } };
  desktop.install({ ipcMain, dialog: { showMessageBox: async () => ({ response: 1 }) }, BrowserWindow: null, backendUrl: 'http://x', secret: 'S',
    fromAppWindow: event => event.app === true, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal((await handler({ app: false }, request)).ok, false, 'another window is refused');
  assert.equal((await handler({ app: true }, request)).ok, true);

  console.log('bots approvals model and desktop checks passed');
})().catch(error => { console.error(error); process.exit(1); });
