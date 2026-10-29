// Approval, question and change cards (Agents 3.0 Phase 3, unit U5): the plain-Node checks.
// Run: node scripts/test_bots_cards.cjs
// Loads static/js/botsApprovalCards.js and botsAutomationChangeCard.js straight from disk (no DOM needed for the model).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', file)).href);

const options = n => Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}`, description: '' }));
const question = (i, extra = {}) => ({ id: `q${i}`, question: `Question ${i}?`, header: `Q${i}`, multi_select: false, allow_custom: true, options: options(3), ...extra });
const six = () => Array.from({ length: 6 }, (_, i) => question(i + 1));
const approval = (extra = {}) => ({ id: 'c1', kind: 'approval', status: 'pending', revision: 2, title: 'Run a command', created_at: 1,
  details: { target: 'git status', summary: '', lines: [] }, outcome: null,
  choices: [{ id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' }, { id: 'session', label: 'Always in this chat (git status)', behavior: 'allow', scope: 'session' },
    { id: 'forever', label: 'Always allow git status', behavior: 'allow', scope: 'forever' }, { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' }], ...extra });

(async () => {
  const C = await load('botsApprovalCards.js');
  const M = await load('botsAutomationChangeCard.js');
  const { ICONS } = await load('botsIcons.js');

  await check('six questions: tabs move, Next jumps to the next unanswered one, Back returns', () => {
    const qs = six(), state = C.newQuestionState(qs);
    assert.equal(state.index, 0);
    C.pickOption(state, qs, 'q1', 'Option 2');
    assert.equal(C.advanceTarget(state, qs), 1);
    C.pickOption(state, qs, 'q2', 'Option 1');
    assert.equal(C.advanceTarget(state, qs), 2, 'Next skips what is already answered');
    C.goTo(state, qs, 5);
    assert.equal(C.isLast(state, qs), true);
    assert.equal(C.nextQuestion(state, qs).index, 5, 'there is no seventh question');
    C.previousQuestion(state, qs);
    assert.equal(state.index, 4);
    assert.equal(C.goTo(state, qs, -3).index, 0);
    assert.equal(C.canSubmit(state, qs), false, 'two of six answered');
    for (const q of qs) C.pickOption(state, qs, q.id, 'Option 3');
    assert.equal(C.canSubmit(state, qs), true);
    const body = C.questionBody({ questions: qs, revision: 4 }, state);
    assert.deepEqual(Object.keys(body.answers), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'], 'answers go by stable question id');
    assert.equal(body.action, 'answer');
    assert.equal(body.reviewed_revision, 4);
  });

  await check('single choice: an option and typed text replace each other', () => {
    const qs = [question(1)], state = C.newQuestionState(qs);
    C.pickOption(state, qs, 'q1', 'Option 1');
    assert.equal(C.questionAnswer(state, qs, 'q1'), 'Option 1');
    C.typeCustom(state, qs, 'q1', '  Something else  ');
    assert.equal(C.questionAnswer(state, qs, 'q1'), 'Something else', 'typed text wins and is trimmed');
    assert.deepEqual(state.picked.q1, []);
    C.pickOption(state, qs, 'q1', 'Option 2');
    assert.equal(state.custom.q1, '');
    assert.equal(C.questionAnswer(state, qs, 'q1'), 'Option 2');
    assert.equal(C.pickOption(state, qs, 'q1', 'No such option').picked.q1[0], 'Option 2', 'an option that was not shown is ignored');
  });

  await check('multi-select: toggling, free text as one more answer, and a question that takes no typing', () => {
    const qs = [question(1, { multi_select: true }), question(2, { allow_custom: false })], state = C.newQuestionState(qs);
    C.pickOption(state, qs, 'q1', 'Option 1'); C.pickOption(state, qs, 'q1', 'Option 3');
    assert.deepEqual(C.questionAnswer(state, qs, 'q1'), ['Option 1', 'Option 3']);
    C.pickOption(state, qs, 'q1', 'Option 1');
    assert.deepEqual(C.questionAnswer(state, qs, 'q1'), ['Option 3']);
    C.typeCustom(state, qs, 'q1', 'and my own');
    assert.deepEqual(C.questionAnswer(state, qs, 'q1'), ['Option 3', 'and my own']);
    C.pickOption(state, qs, 'q1', 'Option 3'); state.custom.q1 = '';
    assert.equal(C.isAnswered(state, qs, 'q1'), false, 'an empty multi-select is not an answer');
    const result = C.typeCustom(state, qs, 'q2', 'typed anyway');
    assert.equal(result.clipped, false);
    assert.equal(state.custom.q2, '', 'a closed question never takes typing');
  });

  await check('typed answers stop at 2,000 characters and say they were clipped', () => {
    const qs = [question(1)], state = C.newQuestionState(qs);
    assert.equal(C.typeCustom(state, qs, 'q1', 'x'.repeat(2000)).clipped, false);
    assert.equal(state.custom.q1.length, 2000);
    const over = C.typeCustom(state, qs, 'q1', 'y'.repeat(2500));
    assert.equal(over.clipped, true);
    assert.equal(state.custom.q1.length, 2000);
    assert.deepEqual(C.LIMITS, { questions: 6, options: 12, label: 120, description: 400, custom: 2000 });
  });

  await check('settled rows say what happened, and an action that did not run says so', () => {
    assert.equal(C.settledText(approval({ status: 'allowed', outcome: { scope: 'once' } })), 'Allowed once');
    assert.equal(C.settledText(approval({ status: 'allowed', outcome: { scope: 'session' } })), 'Allowed for this chat');
    assert.equal(C.settledText(approval({ status: 'allowed', outcome: { scope: 'forever' } })), 'Always allowed: git status');
    assert.match(C.settledText(approval({ status: 'denied' })), /did not run/);
    assert.match(C.settledText(approval({ status: 'unavailable', outcome: { reason: 'Kairos restarted before this was answered, so the action did not run.' } })), /did not run/);
    assert.match(C.settledText(approval({ status: 'unavailable', outcome: null })), /did not run/);
    assert.match(C.settledText(approval({ status: 'expired', outcome: { reason: '' } })), /in time/);
    assert.match(C.settledText(approval({ status: 'cancelled', outcome: null })), /did not run/);
    assert.equal(C.settledText({ kind: 'question', status: 'skipped' }), 'Skipped');
    assert.equal(C.settledText({ kind: 'connector', status: 'skipped' }), 'Not now');
    assert.match(C.settledText({ kind: 'question', status: 'answered', outcome: { as_new_turn: true } }), /new turn/);
    const answered = { kind: 'question', status: 'answered', questions: [question(1), question(2, { multi_select: true })], outcome: { answers: { q1: 'Option 2', q2: ['A', 'B'] } } };
    assert.deepEqual(C.answerLines(answered), [{ question: 'Question 1?', answer: 'Option 2' }, { question: 'Question 2?', answer: 'A, B' }]);
    assert.deepEqual(C.answerLines(approval()), []);
  });

  await check('cards split into waiting and settled, oldest first', () => {
    const cards = [approval({ id: 'b', created_at: 5, status: 'allowed' }), approval({ id: 'a', created_at: 2 }), approval({ id: 'c', created_at: 9, status: 'settling' })];
    const split = C.splitCards(cards);
    assert.deepEqual(split.pending.map(c => c.id), ['a', 'c']);
    assert.deepEqual(split.settled.map(c => c.id), ['b']);
    assert.deepEqual(split.all.map(c => c.id), ['a', 'b', 'c']);
    assert.deepEqual(C.splitCards(undefined).all, []);
  });

  await check('an answer only offers the Always allow choices the card showed', () => {
    const card = approval();
    assert.deepEqual(C.rememberChoices(card).map(c => c.remember), ['session', 'always']);
    assert.deepEqual(C.rememberChoices(approval({ choices: [card.choices[0], card.choices[3]] })), [], 'no target, only Allow once and Reject');
    assert.deepEqual(C.rememberChoices({ kind: 'question' }), []);
    assert.deepEqual(C.approvalBody(card, 'allow', 'always'), { action: 'allow', remember: 'always', reviewed_revision: 2 });
    assert.deepEqual(C.approvalBody(card, 'deny'), { action: 'deny', reviewed_revision: 2 });
    assert.deepEqual(C.approvalBody({ ...card, revision: 0 }, 'allow'), { action: 'allow', remember: 'once' });
  });

  await check('the change card shows the line, the before and after, and the right buttons', () => {
    const receipt = { id: 'r1', kind: 'routine', action: 'update', state: 'applied', undoable: true, undo_expired: false, target_id: 't1', tainted: false,
      summary: 'Changed routine "Brief".', details: [{ label: 'name', before: 'Brief', after: 'Evening brief' }, { label: 'run time', before: '08:00', after: '18:30' }] };
    const model = M.changeModel(receipt);
    assert.deepEqual([model.line, model.state, model.status, model.canUndo, model.canPause, model.canEdit, model.pauseLabel],
      ['Changed routine "Brief".', 'applied', 'Applied', true, true, true, 'Pause']);
    assert.deepEqual(model.rows[0], { label: 'name', before: 'Brief', after: 'Evening brief' });
    assert.equal(M.changeModel({ ...receipt, action: 'pause' }).pauseLabel, 'Resume', 'a paused routine offers Resume');
    assert.equal(M.changeModel(receipt, { paused: true }).pauseLabel, 'Resume');
    assert.equal(M.changeModel({ ...receipt, tainted: true }).flag, 'This turn read outside content.');
    assert.equal(M.changeModel({ ...receipt, kind: 'trigger' }).noun, 'webhook trigger');
  });

  await check('undone, expired, failed and deleted changes offer no wrong button', () => {
    const base = { id: 'r1', kind: 'routine', action: 'create', state: 'applied', undoable: true, undo_expired: false, target_id: 't1', summary: 'Added routine "A".', details: [] };
    const undone = M.changeModel({ ...base, state: 'undone', undoable: false });
    assert.deepEqual([undone.state, undone.status, undone.canUndo, undone.canPause, undone.canEdit], ['undone', 'Undone', false, false, false]);
    const expired = M.changeModel({ ...base, undoable: false, undo_expired: true });
    assert.deepEqual([expired.state, expired.status, expired.canUndo], ['expired', 'Undo has expired', false]);
    const failed = M.changeModel({ ...base, state: 'failed', undoable: false, error: 'Kairos stopped before this was applied. Nothing changed.' });
    assert.deepEqual([failed.state, failed.line, failed.canUndo], ['failed', 'Kairos stopped before this was applied. Nothing changed.', false]);
    const deleted = M.changeModel({ ...base, action: 'delete' });
    assert.deepEqual([deleted.canPause, deleted.canEdit, deleted.canUndo], [false, false, true], 'a deleted routine can only be undone');
    assert.equal(M.changeModel(base, { undoing: true }).canUndo, false, 'one Undo at a time');
    assert.equal(M.changeModel(base, { error: 'x' }).undoError, 'x');
  });

  await check('Pause goes to the routine or trigger route, and a stale Undo is explained', () => {
    assert.deepEqual(M.pauseRequest({ kind: 'routine', target_id: 't9' }, false), { path: '/api/bot-routines/t9', method: 'PATCH', body: { enabled: false } });
    assert.deepEqual(M.pauseRequest({ kind: 'trigger', target_id: 'g2' }, true), { path: '/api/triggers/g2', method: 'PATCH', body: { enabled: true } });
    assert.match(M.undoRefusalText({ code: 'stale', detail: 'It was changed after this, so Undo left it alone.' }), /left it alone/);
    assert.match(M.undoRefusalText({ code: 'stale' }), /changed after this/);
    assert.match(M.undoRefusalText({ code: 'expired' }), /window/);
    assert.equal(M.undoRefusalText({ detail: 'Nope' }), 'Nope');
    assert.match(M.undoRefusalText(null), /Try again/);
  });

  await check('the card files hold to the house rules', () => {
    const root = path.join(__dirname, '..', 'static');
    for (const file of ['js/botsApprovalCards.js', 'js/botsAutomationChangeCard.js', 'css/bots-cards.css']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(!text.includes('—'), `${file} has no em-dash`);
      assert.ok(!/MausBot|OpenMaus|OpenDuet|Duet/i.test(text), `${file} uses no outside product names`);
      assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/.test(text), `${file} holds no raw colour`);
      if (file.endsWith('.js')) {
        for (const [, name] of text.matchAll(/icon\('([a-z0-9-]+)'/g)) assert.ok(name in ICONS, `${file} uses the Bots icon ${name}`);
      }
    }
    const css = fs.readFileSync(path.join(root, 'css/bots-cards.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map(m => m[2].trim()).filter(Boolean);
    assert.ok(selectors.length > 20);
    assert.deepEqual(selectors.filter(s => !s.startsWith('[data-app-mode="bots"]')), [], 'every rule is scoped under [data-app-mode="bots"]');
  });

  console.log(`PASS: ${passed.length} Node checks (bots cards)`);
})().catch(error => { console.error(error); process.exit(1); });
