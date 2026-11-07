// Part 2 g6 (A12 Tasks, A13 Tool Store/Cookbook) renderer checks. Runs alone with
// --g6-only (not in the default ui-smoke run). Uses the mocked backend.
//
// Proves: the Schedule form's validation and the exact request it sends, that
// an unsent draft survives a poll refresh and a desktop/phone resize, the phone
// routine sheet's controls (moved, not copied) really save, and first-load
// request counts for Tasks, Tool Store and Cookbook (duplicates are waste).
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, capture, reads, writes, demoState }) => {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  const counts = (from) => reads.slice(from).reduce((all, r) => { all[r.path] = (all[r.path] || 0) + 1; return all; }, {});
  const loadReport = async (tab, settle) => {
    win.setContentSize(1440, 900); await delay(300);
    await navigate('home'); await delay(600);
    const start = reads.length;
    await navigate(tab);
    await waitFor(settle); await delay(1500);
    const seen = counts(start);
    console.log(`REQUESTS first load of ${tab}: ${reads.length - start} GETs ${JSON.stringify(seen)}`);
    for (const [path, n] of Object.entries(seen)) expect(n <= 1 || path === '/api/system/status', `EFFICIENCY ${tab} first load read ${path} ${n} times`);
    return seen;
  };
  const setValue = (selector, value) => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const pick = (index, value) => js(`(() => { const w = document.querySelectorAll('.tasks-workspace > details.disclosure-panel .form-grid .custom-select')[${index}]; w.value = ${JSON.stringify(value)}; w.dispatchEvent(new Event('change')); return true; })()`);
  const form = '.tasks-workspace > details.disclosure-panel';
  const taskPosts = (from) => writes.slice(from).filter(w => w.method === 'POST' && w.path === '/api/tasks');

  // ---- Tasks: first load ------------------------------------------------------------
  await loadReport('tasks', "!!document.querySelector('#tasks-list .card') && document.querySelectorAll('.board-card').length > 0");

  // ---- Tasks: form validation and the request it sends --------------------------------
  win.setContentSize(1440, 900); await delay(300);
  await js(`document.querySelector('${form}').open = true`);
  let mark = writes.length;
  await js(`document.querySelector('${form} .form-grid > button.btn').click()`); await delay(300);
  assert.equal(taskPosts(mark).length, 0, 'Schedule with an empty form sends nothing');
  await setValue(`${form} input[placeholder="e.g. Morning summary"]`, 'Nightly digest');
  await js(`document.querySelector('${form} .form-grid > button.btn').click()`); await delay(300);
  assert.equal(taskPosts(mark).length, 0, 'a name without a prompt sends nothing');
  await setValue(`${form} input[placeholder="e.g. Summarize my open notes"]`, 'Summarize today');
  await pick(0, 'interval');
  await setValue(`${form} input[type=number]`, '0');
  await js(`document.querySelector('${form} .form-grid > button.btn').click()`); await delay(300);
  assert.equal(taskPosts(mark).length, 0, 'an interval of 0 minutes sends nothing');
  expect(await js("document.querySelectorAll('#toast-host .toast').length > 0 || !!document.querySelector('.field-error, [aria-invalid=true]')"),
    'A refused Schedule (empty, 0 minutes) says nothing: no toast and no field message; the button just does nothing');
  await js(`document.querySelector('${form}').scrollIntoView({ block: 'start' })`); await capture('g6-tasks-refused');
  await setValue(`${form} input[type=number]`, '15');
  await js(`document.querySelector('${form} .form-grid > button.btn').click()`);
  await delay(700);
  let [post] = taskPosts(mark);
  assert.ok(post, 'a valid interval task is sent');
  assert.deepEqual(JSON.parse(post.body), { name: 'Nightly digest', prompt: 'Summarize today', schedule_kind: 'interval',
    deliver_to_channel: null, endpoint_id: null, interval_seconds: 900 });
  assert.equal(post.status, 200);
  assert.equal(await js(`document.querySelector('${form} input[placeholder="e.g. Morning summary"]').value`), '', 'the form clears after a save');

  mark = writes.length;
  await setValue(`${form} input[placeholder="e.g. Morning summary"]`, 'Morning brief');
  await setValue(`${form} input[placeholder="e.g. Summarize my open notes"]`, 'Brief me');
  await pick(0, 'daily');
  await setValue(`${form} input[type=time]`, '06:30');
  await js(`document.querySelector('${form} .form-grid > button.btn').click()`); await delay(600);
  [post] = taskPosts(mark);
  assert.deepEqual(JSON.parse(post.body), { name: 'Morning brief', prompt: 'Brief me', schedule_kind: 'daily', deliver_to_channel: null,
    endpoint_id: null, run_time: '06:30' }, 'a daily task sends its wall-clock time, not an interval');
  mark = writes.length;
  await setValue(`${form} input[placeholder="e.g. Morning summary"]`, 'One shot');
  await setValue(`${form} input[placeholder="e.g. Summarize my open notes"]`, 'Once');
  await pick(0, 'once');
  await js(`document.querySelector('${form} .form-grid > button.btn').click()`); await delay(300);
  assert.equal(taskPosts(mark).length, 0, 'a one-time task with no time sends nothing');
  await setValue(`${form} input[type=datetime-local]`, '2031-01-02T03:04');
  await js(`document.querySelector('${form} .form-grid > button.btn').click()`); await delay(600);
  [post] = taskPosts(mark);
  assert.equal(JSON.parse(post.body).run_at, new Date('2031-01-02T03:04').toISOString(), 'a one-time task sends its time as an ISO instant');

  // ---- Tasks: an unsent draft survives a poll refresh and breakpoint changes ------------
  await setValue(`${form} input[placeholder="e.g. Morning summary"]`, 'Draft name');
  await setValue(`${form} input[placeholder="e.g. Summarize my open notes"]`, 'Draft prompt text');
  await pick(0, 'daily'); await setValue(`${form} input[type=time]`, '07:45');
  const draft = () => js(`JSON.stringify([document.querySelector('${form}').open, document.querySelector('${form} input[placeholder="e.g. Morning summary"]').value,
    document.querySelector('${form} input[placeholder="e.g. Summarize my open notes"]').value, document.querySelectorAll('.tasks-workspace > details.disclosure-panel .form-grid .custom-select')[0].value,
    document.querySelector('${form} input[type=time]').value])`);
  const before = await draft();
  const pollStart = reads.length;
  await delay(5800);  // the running routine makes the list poll every 5 s
  const poll = counts(pollStart);
  console.log(`REQUESTS one 5 s poll while a routine runs: ${JSON.stringify(poll)}`);
  expect((poll['/api/tasks'] || 0) >= 1, 'the list did not poll while a routine was running');
  const perPoll = Object.values(poll).reduce((a, b) => a + b, 0);
  expect(perPoll <= 6, `EFFICIENCY a 5 s poll while one routine runs sends ${perPoll} GETs (${JSON.stringify(poll)}): the whole list is re-read, plus one runs request per task with history`);
  assert.equal(await draft(), before, 'an unsent draft survives the list polling');
  for (const [w, h] of [[390, 844], [1440, 900], [900, 700], [1440, 900]]) {
    win.setContentSize(w, h); await delay(450);
    assert.equal(await draft(), before, `the unsent draft survives a resize to ${w}px`);
  }
  await navigate('home'); await delay(400); await navigate('tasks'); await waitFor("!!document.querySelector('#tasks-list .card')");
  const afterLeaving = JSON.parse(await draft());
  expect(afterLeaving[1] === 'Draft name', `an unsent Schedule draft is lost when you leave Tasks and come back (name field now ${JSON.stringify(afterLeaving[1])})`);

  // ---- Tasks, phone: the routine sheet moves the real controls and they save --------------
  win.setContentSize(390, 844); await delay(500);
  await waitFor("!!document.querySelector('.task-routine-row')");
  const rowText = await js("document.querySelector('.task-routine-row .task-routine-name').textContent");
  mark = writes.length;
  await js("document.querySelector('.task-routine-row').click()");
  await waitFor("!!document.querySelector('dialog.ms-sheet[open] .task-row-details')");
  let last = '', n = 0;
  for (let i = 0; i < 40 && n < 3; i++) { const r = await js("JSON.stringify(document.querySelector('dialog.ms-sheet[open]').getBoundingClientRect())"); n = r === last ? n + 1 : 0; last = r; await delay(100); }
  const sheetControls = await js("[...document.querySelectorAll('dialog.ms-sheet[open] .task-row-details button, dialog.ms-sheet[open] .task-row-details .custom-select')].map(n => (n.textContent || '').trim()).filter(Boolean)");
  assert.ok(sheetControls.some(t => /Turn off|Turn on/.test(t)) && sheetControls.some(t => /Run now|Stop/.test(t)), `the sheet holds the routine's controls: ${JSON.stringify(sheetControls)}`);
  const small = await js(`[...document.querySelectorAll('dialog.ms-sheet[open] .task-row-details button, dialog.ms-sheet[open] .task-row-details .custom-select-btn')].filter(b => b.getClientRects().length).filter(b => b.getBoundingClientRect().height < 40).map(b => (b.textContent || b.getAttribute('aria-label') || '').trim())`);
  expect(small.length === 0, `phone sheet controls under 40px high: ${JSON.stringify(small)}`);
  await js("[...document.querySelectorAll('dialog.ms-sheet[open] .task-row-details button')].find(b => /Turn off|Turn on/.test(b.textContent)).click()");
  for (let i = 0; i < 40 && !writes.slice(mark).some(w => w.method === 'PATCH' && w.status); i++) await delay(50);
  const patch = writes.slice(mark).find(w => w.method === 'PATCH');
  assert.ok(patch && /\/api\/tasks\/[^/]+$/.test(patch.path) && typeof JSON.parse(patch.body).enabled === 'boolean' && patch.status === 200, "the sheet's Turn off/on sends enabled to the task");
  await delay(500);
  const open = await js("!!document.querySelector('dialog.ms-sheet[open]')");
  if (open) await js("document.querySelector('dialog.ms-sheet[open] .ms-sheet-header button').click()");
  await delay(500);
  assert.equal(await js("!!document.querySelector('dialog.ms-sheet[open]')"), false, 'the sheet closes');
  assert.ok(await js("[...document.querySelectorAll('#tasks-list .task-row-details')].every(n => n.closest('.card'))"), 'every control block is back in its routine card after the sheet closes');
  assert.ok(rowText.length > 0);
  // Phone overflow and 44px targets on the Tasks page itself.
  const wide = await js("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(wide <= 1, `Tasks on a phone scrolls sideways by ${wide}px`);
  await capture('g6-tasks-phone');
  win.setContentSize(1440, 900); await delay(400);

  // ---- Tool Store and Cookbook: first-load requests and basic provenance ---------------------
  await loadReport('tool-store', "document.querySelectorAll('.tool-store-card').length > 0");
  const headings = await js("[...document.querySelectorAll('.tool-store-heading')].map(n => n.textContent.trim())");
  console.log('TOOL STORE headings: ' + JSON.stringify(headings));
  const cards = await js(`[...document.querySelectorAll('.tool-store-card')].map(c => ({ title: (c.querySelector('.title, h3, h4, strong') || {}).textContent || '', badges: [...c.querySelectorAll('.tool-store-badge')].map(b => b.textContent.trim()), actions: [...c.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) }))`);
  assert.ok(cards.length > 0 && cards.every(c => c.title.trim()), 'every Tool Store card has a title');
  const total = cards.length;
  await setValue('.tool-store-search', 'zzzz-no-such-tool');
  await delay(300);
  assert.equal(await js("document.querySelectorAll('.tool-store-card').length"), 0, 'searching for nothing hides every card');
  assert.ok(await js("!!document.querySelector('.tool-store-results .empty-state-title')"), 'and says so');
  await setValue('.tool-store-search', '');
  await delay(300);
  assert.equal(await js("document.querySelectorAll('.tool-store-card').length"), total, 'clearing the search restores every card');
  const mark2 = reads.length;
  await js("document.querySelector('.tool-store-installed input').click()"); await delay(500);
  const filtered = await js("document.querySelectorAll('.tool-store-card').length");
  expect(filtered <= total, 'the Yours filter only narrows');
  expect(reads.length === mark2, `toggling the Yours filter re-read the backend (${reads.length - mark2} GETs); it is a local filter`);
  await js("document.querySelector('.tool-store-installed input').click()"); await delay(300);
  await capture('g6-tool-store');

  await loadReport('cookbook', "!!document.querySelector('#view-content')?.dataset.view && document.querySelectorAll('#view-content .card').length > 0");

  win.setContentSize(1440, 900); await delay(300);
  await navigate('home');
  if (problems.length) throw new Error('g6 findings (' + problems.length + '):\n - ' + problems.join('\n - '));
};
