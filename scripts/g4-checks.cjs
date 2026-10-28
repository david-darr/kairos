// A08 Notes and Email renderer checks (Part 2, group g4), run by `ui-smoke.cjs --g4-only` against the mocked backend.
// Desktop and phone. Checks marked BUG assert the CORRECT behaviour and are collected, not thrown, so one app bug does not hide the rest.
// Not in the default ui-smoke run.
module.exports = async ({ js, win, waitFor, delay, navigate, capture, overflow, reads, writes, demoState, fixtures }) => {
  const assert = require('node:assert/strict');
  const bugs = [];
  const bug = (name, ok, detail) => { if (!ok) { bugs.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log('BUG (kept failing): ' + name + (detail ? ' :: ' + detail : '')); } };
  const bench = (name, value) => console.log(`[bench] ${name}: ${value}`);
  const original = JSON.parse(JSON.stringify(fixtures.notes));
  const requestAfter = async (records, before, predicate, what = 'request') => {
    for (let i = 0; i < 100; i++) { const hit = records.slice(before).find(predicate); if (hit) return hit; await delay(50); }
    throw new Error(`Missing ${what}; after the step: ` + JSON.stringify(records.slice(before).slice(-5)).slice(0, 500));
  };
  const clickByText = (selector, text) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const noteTexts = () => js("[...document.querySelectorAll('#notes-list > .card')].map(c => c.querySelector('.note-desktop-text').textContent)");
  const confirm = async text => { await waitFor("!!document.querySelector('.confirm-panel')"); await js(`[...document.querySelectorAll('.confirm-panel button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`); await waitFor("!document.querySelector('.confirm-panel')"); };
  const dismissToasts = () => js("document.querySelector('#toast-host')?.replaceChildren()");
  const toasts = () => js("[...document.querySelectorAll('#toast-host .toast')].map(t => t.textContent)");

  demoState.g4Live = true;
  try {
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      win.setContentSize(width, height); await delay(150);
      const phone = label === 'mobile';
      fixtures.notes.splice(0, fixtures.notes.length, ...JSON.parse(JSON.stringify(original)));
      demoState.g4FailNotes = []; demoState.g4Accounts = []; demoState.g4Triaged = false; demoState.g4TriageFail = false; demoState.g4Test = null;

      // ---- Notes: first load, same data on desktop and phone, requests and time
      let r0 = reads.length; const t0 = Date.now();
      await navigate('notes');
      await waitFor("document.querySelectorAll('#notes-list > .card').length === 3");
      bench(`${label} notes first usable (navigate to 3 rows)`, `${Date.now() - t0} ms`);
      const loadReads = reads.slice(r0).filter(r => r.path.startsWith('/api/notes'));
      bench(`${label} /api/notes reads on first load`, loadReads.length);
      bug(`${label} notes tab reads /api/notes once per load`, loadReads.length === 1, `${loadReads.length} reads`);
      assert.deepEqual((await noteTexts()).sort(), original.map(n => n.text).sort(), label + ' every note is listed');
      if (phone) assert.deepEqual((await js("[...document.querySelectorAll('#notes-list > .card .note-open')].map(b => b.textContent)")).sort(), original.map(n => n.text).sort(), 'phone rows expose the same notes');
      assert.deepEqual(await overflow(), [], label + ' Notes fits');
      assert.equal(await js("document.querySelector('.notes-finished-count').textContent"), '3 notes · 1 finished');
      await capture(label + '-g4-notes');

      // ---- Add: validation, due time, overdue marking, saved request
      let w = writes.length;
      await js("document.querySelector('.notes-overview').nextElementSibling.querySelector('button.btn.primary').click()");
      await delay(150);
      assert.equal(writes.length, w, label + ' an empty note sends nothing');
      if (phone) { await js("document.querySelector('.notes-due-toggle').click()"); await waitFor("document.querySelector('.notes-due-toggle').getAttribute('aria-expanded') === 'true'"); }
      await js(`(() => { const t = document.querySelector('input[aria-label="New note"]'); t.value = 'Renew passport'; const d = document.querySelector('input[aria-label="Due time"]'); d.value = '2020-01-02T09:30'; })()`);
      await js("document.querySelector('.notes-overview').nextElementSibling.querySelector('button.btn.primary').click()");
      const created = await requestAfter(writes, w, x => x.path === '/api/notes' && x.method === 'POST', 'note create');
      const sent = JSON.parse(created.body);
      assert.equal(sent.text, 'Renew passport');
      assert.equal(sent.due_date, new Date('2020-01-02T09:30').toISOString(), label + ' due time is saved as an instant');
      await waitFor("document.querySelectorAll('#notes-list > .card').length === 4");
      assert.ok(await js("[...document.querySelectorAll('#notes-list > .card')].find(c => c.textContent.includes('Renew passport')).querySelector('.meta.is-overdue')"), label + ' a past due time is marked overdue');
      assert.ok(await js("!document.querySelector('input[aria-label=\"New note\"]').value"), label + ' the form clears after saving');
      // A completed note is never overdue.
      const checkbox = title => `[...document.querySelectorAll('#notes-list > .card')].find(c => c.textContent.includes(${JSON.stringify(title)})).querySelector('input[type=checkbox]')`;

      // ---- Complete / restore, saved result and restored state
      w = writes.length;
      await js(`(${checkbox('Renew passport')}).click()`);
      const patch = await requestAfter(writes, w, x => x.method === 'PATCH' && x.path.startsWith('/api/notes/'), 'note complete');
      assert.deepEqual(JSON.parse(patch.body), { completed: true });
      await waitFor("document.querySelector('.notes-finished-count').textContent === '4 notes · 2 finished'");
      assert.ok(await js("!![...document.querySelectorAll('#notes-list > .card')].find(c => c.textContent.includes('Renew passport')).querySelector('.note-title.is-done') && !document.querySelector('.meta.is-overdue')"), label + ' completed note is struck through and no longer overdue');
      await js(`(${checkbox('Renew passport')}).click()`);
      await waitFor("document.querySelector('.notes-finished-count').textContent === '4 notes · 1 finished'");
      assert.ok(await js("!!document.querySelector('.meta.is-overdue')"), label + ' reopening restores the overdue mark');
      // Reload the view: state comes from the backend, not the DOM.
      await navigate('notes'); await waitFor("document.querySelectorAll('#notes-list > .card').length === 4");
      assert.equal(await js("document.querySelector('.notes-finished-count').textContent"), '4 notes · 1 finished');

      // ---- A save that fails: the checkbox must not keep claiming the note is done
      demoState.g4FailNotes = ['n1']; await dismissToasts(); w = writes.length;
      await js(`(${checkbox('Review the workspace design')}).click()`);
      await requestAfter(writes, w, x => x.method === 'PATCH' && x.path === '/api/notes/n1', 'failing complete');
      await delay(700);
      assert.ok((await toasts()).some(t => t.includes('Note service unavailable')), label + ' the failure is shown');
      bug(`${label} a failed completion save leaves the checkbox unchecked`, await js(`!(${checkbox('Review the workspace design')}).checked`), 'the box stays ticked and the row is not reloaded, so the screen says done while the server says open');
      demoState.g4FailNotes = [];
      await navigate('notes'); await waitFor("document.querySelectorAll('#notes-list > .card').length === 4");

      // ---- Delete one (desktop has the icon; phone opens the row sheet)
      if (!phone) {
        w = writes.length;
        await js("[...document.querySelectorAll('#notes-list > .card')].find(c => c.textContent.includes('Renew passport')).querySelector('button[aria-label=\"Delete note\"]').click()");
        await js("document.querySelector('.confirm-panel .btn:not(.danger)')?.click()");  // cancel keeps it
        await waitFor("!document.querySelector('.confirm-panel')");
        assert.equal(writes.slice(w).filter(x => x.method === 'DELETE').length, 0, 'cancelling a delete sends nothing');
        await js("[...document.querySelectorAll('#notes-list > .card')].find(c => c.textContent.includes('Renew passport')).querySelector('button[aria-label=\"Delete note\"]').click()");
        await confirm('Delete note');
        await requestAfter(writes, w, x => x.method === 'DELETE' && x.path.startsWith('/api/notes/'), 'note delete');
        await waitFor("document.querySelectorAll('#notes-list > .card').length === 3");
      } else {
        await js("[...document.querySelectorAll('#notes-list > .card')].find(c => c.textContent.includes('Renew passport')).querySelector('.note-open').click()");
        await waitFor("!!document.querySelector('dialog[open] button[aria-label=\"Delete note\"]')");
        w = writes.length;
        await js("document.querySelector('dialog[open] button[aria-label=\"Delete note\"]').click()");
        await confirm('Delete note');
        await requestAfter(writes, w, x => x.method === 'DELETE', 'phone note delete');
        await waitFor("document.querySelectorAll('#notes-list > .card').length === 3");
      }

      // ---- Clear finished, partial failure then success
      await js(`(${checkbox('Prepare notes for the project')}).click()`);
      await waitFor("document.querySelector('.notes-finished-count').textContent === '3 notes · 2 finished'");
      demoState.g4FailNotes = ['n3']; await dismissToasts(); w = writes.length;
      await clickByText('.notes-finished-bar button', 'Clear finished');
      await confirm('Clear finished');
      await waitFor("document.querySelectorAll('#notes-list > .card').length === 2");
      const deletes = writes.slice(w).filter(x => x.method === 'DELETE').map(x => x.path).sort();
      assert.deepEqual(deletes, ['/api/notes/n2', '/api/notes/n3'], label + ' Clear finished deletes each finished note once');
      await waitFor("[...document.querySelectorAll('#toast-host .toast')].some(t => t.textContent.includes('Deleted 1 of 2 finished notes. 1 could not be deleted.'))");
      assert.deepEqual((await noteTexts()).sort(), ["Organize this week's reference material", 'Review the workspace design and collect feedback'].sort(), label + ' only the failed note remains');
      demoState.g4FailNotes = []; w = writes.length;
      await clickByText('.notes-finished-bar button', 'Clear finished'); await confirm('Clear finished');
      await waitFor("document.querySelectorAll('#notes-list > .card').length === 1");
      assert.ok(!(await js("[...document.querySelectorAll('.notes-finished-bar button')].some(b => b.textContent.trim() === 'Clear finished')")), label + ' the button goes when nothing is finished');

      // ---- Very long note: Show more reaches the rest (desktop clamps; phone rows truncate)
      const long = 'Write the quarterly plan. '.repeat(40).trim();
      await js(`(() => { const t = document.querySelector('input[aria-label="New note"]'); t.value = ${JSON.stringify(long)}; })()`);
      await js("document.querySelector('.notes-overview').nextElementSibling.querySelector('button.btn.primary').click()");
      await waitFor("document.querySelectorAll('#notes-list > .card').length === 2");
      if (!phone) {
        await waitFor("!document.querySelector('#notes-list > .card:last-child .note-more').hidden");
        await js("document.querySelector('#notes-list > .card:last-child .note-more').click()");
        assert.ok(await js("document.querySelector('#notes-list > .card:last-child').classList.contains('is-expanded') && document.querySelector('#notes-list > .card:last-child .note-more').textContent === 'Show less'"));
        assert.deepEqual(await overflow(), [], 'long note fits');
      }
      await capture(label + '-g4-notes-after');

      // ---- Email: triage, connect, test, remove
      w = writes.length; r0 = reads.length; const e0 = Date.now();
      await navigate('email');
      await waitFor("!!document.querySelector('.email-triage-card') && !!document.querySelector('.email-sending-card') && !!document.querySelector('.empty-state, .email-account')");
      bench(`${label} email first usable`, `${Date.now() - e0} ms`);
      const emailReads = reads.slice(r0).filter(r => r.path.startsWith('/api/email') || r.path.startsWith('/api/google')).map(r => r.path);
      bench(`${label} email-tab requests on first load`, JSON.stringify(emailReads));
      bug(`${label} email tab reads each endpoint once`, new Set(emailReads).size === emailReads.length, JSON.stringify(emailReads));
      assert.ok(await js("document.querySelector('.email-triage-card').textContent.includes('Important today')"));
      assert.deepEqual(await overflow(), [], label + ' Email fits');
      // Triage failure first: the button comes back and says why.
      demoState.g4TriageFail = true; await dismissToasts();
      await clickByText('.email-triage-card button', 'Refresh now');
      await requestAfter(writes, w, x => x.path === '/api/email/triage/run', 'triage run');
      await waitFor("[...document.querySelectorAll('#toast-host .toast')].some(t => t.textContent.includes('Triage failed'))");
      assert.ok(await js("!document.querySelector('.email-triage-card .card-row button').disabled && document.querySelector('.email-triage-card .card-row button').textContent === 'Refresh now'"), label + ' triage button recovers after failure');
      demoState.g4TriageFail = false; w = writes.length; await dismissToasts();
      await clickByText('.email-triage-card button', 'Refresh now');
      await requestAfter(writes, w, x => x.path === '/api/email/triage/run' && x.method === 'POST', 'triage run ok');
      await waitFor("document.querySelector('.email-triage-card').textContent.includes('Invoice due Friday')");
      assert.ok(await js("document.querySelector('.email-triage-card').textContent.includes('A payment deadline.')"));
      assert.equal(writes.slice(w).filter(x => x.path === '/api/email/triage/run').length, 1, label + ' one triage run per click');

      // Connect an IMAP/SMTP account: the form is reachable (phone: Accounts sheet) and validates
      if (phone) { await js("document.querySelector('.email-accounts-trigger').click()"); await waitFor("!!document.querySelector('dialog[open] .disclosure-panel')"); }
      else { await js("document.querySelector('.email-accounts-trigger').click()"); await waitFor("document.querySelector('.email-view details.disclosure-panel').open"); }
      const form = phone ? 'dialog[open] .disclosure-panel' : '.email-view details.disclosure-panel';
      if (phone) await js(`${JSON.stringify(form)} && (document.querySelector(${JSON.stringify(form)}).open = true)`);
      w = writes.length; await dismissToasts();
      await js(`document.querySelector(${JSON.stringify(form)}).querySelector('button.btn').click()`);
      await waitFor("[...document.querySelectorAll('#toast-host .toast')].some(t => t.textContent.includes('Fill in email'))");
      assert.equal(writes.length, w, label + ' incomplete form sends nothing');
      await js(`(() => { const f = document.querySelector(${JSON.stringify(form)}); const i = f.querySelectorAll('input'); i[0].value = 'me@example.test'; i[1].value = 'hunter2-pw'; i[2].value = 'imap.example.test'; i[4].value = 'smtp.example.test'; f.querySelector('button.btn').click(); })()`);
      const add = await requestAfter(writes, w, x => x.path === '/api/email/accounts' && x.method === 'POST', 'account add');
      assert.deepEqual(JSON.parse(add.body), { email: 'me@example.test', password: 'hunter2-pw', imap_host: 'imap.example.test', imap_port: 993, smtp_host: 'smtp.example.test', smtp_port: 465 });
      await waitFor("document.querySelectorAll('.email-account').length === 1");
      assert.ok(await js("!document.body.innerText.includes('hunter2-pw') && ![...document.querySelectorAll('input')].some(i => i.value === 'hunter2-pw')"), label + ' the password is cleared and never listed');
      assert.ok(await js("[...document.querySelectorAll('#email-accounts-list input')].length === 0"));
      // Test connection shows each protocol separately and the provider's own reason
      await dismissToasts(); w = writes.length;
      await clickByText('.email-account button', 'Test connection');
      await requestAfter(writes, w, x => x.path === '/api/email/accounts/mail-1/test', 'connection test');
      await waitFor("document.querySelector('.email-account').textContent.includes('IMAP: OK · SMTP: failed')");
      assert.ok((await toasts()).some(t => t.includes('Authentication failed') && !t.includes('hunter2')), label + ' failure reason shown without a secret');
      assert.ok(await js("!document.querySelector('.email-account button').disabled"), label + ' test button re-enabled');
      // Remove
      w = writes.length;
      await js("document.querySelector('.email-account button[aria-label=\"Remove account\"]').click()");
      await confirm('Remove account');
      await requestAfter(writes, w, x => x.method === 'DELETE' && x.path === '/api/email/accounts/mail-1', 'account remove');
      await waitFor("document.querySelectorAll('.email-account').length === 0");
      assert.deepEqual(await overflow(), [], label + ' Email accounts fit');
      await capture(label + '-g4-email');

      // ---- Sending accounts are listed with who can send; Add Google is a real OS browser step (MANUAL)
      assert.deepEqual(await js("[...document.querySelectorAll('.email-sending-row .title')].map(n => n.textContent)"), ['demo@example.com', 'coach.demo@example.com', 'office@example.org']);
      assert.deepEqual(await js("[...document.querySelectorAll('.email-sending-row .meta')].map(n => n.textContent)"), ['Google · can send', 'Google · needs permission to send', 'Email tab account · can send']);
      if (phone) await js("document.querySelector('dialog[open] .ms-sheet-header button')?.click()");
    }
  } finally {
    demoState.g4Live = false; demoState.g4FailNotes = [];
    fixtures.notes.splice(0, fixtures.notes.length, ...original);
  }
  if (bugs.length) throw new Error('App bugs shown by g4 checks (assertions kept failing on purpose):\n - ' + bugs.join('\n - '));
};
