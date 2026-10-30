// Shared desktop/phone checks, invoked by ui-smoke with its synthetic server.
module.exports = async ({ js: rendererJs, waitFor, capture, navigate, overflow, reads, writes, label }) => {
  // These checks assert that each Drive action sends its own request; the app may otherwise reuse an
  // identical read from the last second (api.js). Waits still go through ui-smoke's waitFor.
  const js = async code => { await rendererJs("import('/static/js/api.js').then(m => m.clearSharedReads())"); return rendererJs(code); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const requestAfter = async (records, before, predicate) => {
    for (let i = 0; i < 80; i++) {
      if (records.slice(before).some(predicate)) return;
      await delay(50);
    }
    // Name what arrived instead, so a failure says which step went wrong.
    throw new Error('Google UI action did not send its own expected request ('
      + predicate.toString().slice(0, 160) + '); after it: ' + JSON.stringify(records.slice(before).slice(-6)).slice(0, 600));
  };
  const assert = require('node:assert/strict');
  const writeStart = writes.length;

  const phone = label === 'mobile';
  const driveOptions = async () => {
    if (!phone) return;
    await js("document.querySelector('.library-drive-options').click()");
    await waitFor("!!document.querySelector('dialog.ms-sheet[open] .google-toolbar')");
  };
  const closeDriveOptions = async () => {
    if (phone) await js("document.querySelector('dialog.ms-sheet[open] .ms-sheet-header button').click()");
  };

  // Email tab: every sending address, and where to add more (2026-10-23).
  await navigate('email');
  await waitFor("document.querySelectorAll('.email-sending-row').length === 3");
  assert.deepEqual(await js("[...document.querySelectorAll('.email-sending-row .title')].map(n => n.textContent)"),
    ['demo@example.com', 'coach.demo@example.com', 'office@example.org']);
  assert.deepEqual(await js("[...document.querySelectorAll('.email-sending-row')].map(r => !!r.querySelector('button'))"), [false, true, false],
    label + ' only the Google account without send permission offers Allow sending');
  assert.ok(await js("[...document.querySelectorAll('.email-sending-card button')].some(b => b.textContent === 'Add Google account')"));
  await js("[...document.querySelectorAll('.email-sending-card button')].find(b => b.textContent === 'Add another provider').click()");
  await waitFor("document.querySelector('.email-view details.disclosure-panel')?.open === true");
  assert.deepEqual(await overflow(), [], label + ' Email sending accounts fit');
  // Every Email section spans the view: a stale grid placement squeezes the page without overflowing.
  const narrow = await js("(() => { const view = document.querySelector('.email-view').clientWidth; return ['#email-triage', '#email-sending', '.email-view > details.disclosure-panel'].filter(s => document.querySelector(s).getBoundingClientRect().width < view * (innerWidth > 900 ? 0.25 : 0.9)); })()");
  assert.deepEqual(narrow, [], label + ' Email sections are full width');
  await capture(label + '-email-sending-accounts');
  await js("document.querySelector('.email-view details.disclosure-panel').open = false");

  await navigate('library', { section: 'google' });
  await waitFor("document.querySelectorAll('.google-file-row').length === 8");
  if (phone) {
    assert.ok(await js("!!document.querySelector('.drive-connected-dot') && document.querySelector('.drive-account-copy').textContent.includes('demo@example.com')"));
    assert.ok(await js("[...document.querySelectorAll('.drive-file-extension')].every(n => n.textContent.length > 0)"));
    await driveOptions();
  } else await waitFor("document.querySelector('.google-thumbnail img')?.naturalWidth > 0");
  assert.equal(await js("document.querySelectorAll('.google-rail .google-section').length"), 5);
  // Several Google accounts: pick one for Library, add more, see which can send.
  assert.deepEqual(await js("[...document.querySelectorAll('.google-account-line select option')].map(o => o.textContent)"),
    ['demo@example.com', 'coach.demo@example.com']);
  if (phone) {
    assert.ok(await js("[...document.querySelectorAll('dialog.ms-sheet[open] button')].some(b => b.textContent === 'Disconnect')"), 'Drive options offer Disconnect');
    await closeDriveOptions();
    await js("document.querySelector('.drive-account-copy').click()");
    await waitFor("!!document.querySelector('.drive-account-sheet')");
    assert.ok(await js("[...document.querySelectorAll('.drive-account-sheet button')].some(b=>b.textContent==='Add another Google account')"));
    assert.ok(await js("![...document.querySelectorAll('.drive-account-reconnect')].some(b=>b.textContent==='Allow sending from demo@example.com')"), 'Sending account needs no reconnect');
    assert.ok(await js("[...document.querySelectorAll('.drive-account-reconnect')].some(b=>b.textContent==='Allow sending from coach.demo@example.com')"));
  } else {
    const accountButtons = await js("[...document.querySelectorAll('.google-account-line button')].filter(b => !b.hidden).map(b => b.textContent)");
    assert.ok(accountButtons.includes('Add another Google account') && accountButtons.includes('Disconnect'), label + ' account actions: ' + accountButtons);
    assert.ok(!accountButtons.includes('Reconnect to send email'), label + ' sending account needs no reconnect');
  }
  assert.ok(await js("document.querySelector('.google-account-line').textContent.includes('Can send email')"));
  const chooseAccount = async (id, email) => {
    if (phone) {
      if (!await js("!!document.querySelector('.drive-account-sheet')")) await js("document.querySelector('.drive-account-copy').click()");
      await waitFor("!!document.querySelector('.drive-account-sheet')");
      await js(`[...document.querySelectorAll('.drive-account-choice')].find(b=>b.querySelector('strong').textContent===${JSON.stringify(email)}).click()`);
    } else await js(`(() => { const s = document.querySelector('.google-account-line select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`);
  };
  let before = reads.length;
  await chooseAccount('acct_coach', 'coach.demo@example.com');
  await requestAfter(reads, before, r => r.path === '/api/google/drive/files' && r.query.account === 'acct_coach');
  await waitFor("document.querySelector('.google-account-line select')?.value === 'acct_coach' && document.querySelectorAll('.google-file-row').length === 8");
  if (phone) {
    await js("document.querySelector('.drive-account-copy').click()");
    await waitFor("!!document.querySelector('.drive-account-sheet')");
    assert.ok(await js("[...document.querySelectorAll('.drive-account-reconnect')].some(b=>b.textContent==='Allow sending from coach.demo@example.com')"));
  } else assert.ok(await js("[...document.querySelectorAll('.google-account-line button')].some(b => !b.hidden && b.textContent === 'Reconnect to send email')"));
  assert.deepEqual(await overflow(), [], label + ' account bar fits');
  await capture(label + '-drive-accounts');
  before = reads.length;
  await chooseAccount('acct_demo', 'demo@example.com');
  await requestAfter(reads, before, r => r.path === '/api/google/drive/files' && r.query.account === 'acct_demo');
  await waitFor("document.querySelector('.google-account-line select')?.value === 'acct_demo' && document.querySelectorAll('.google-file-row').length === 8");
  await driveOptions();
  assert.ok(await js("document.querySelector('.google-storage').textContent.includes('2.0 GB')"));
  assert.deepEqual(await overflow(), [], label + ' Drive grid fits');
  await capture(label + '-drive-grid');
  await js("[...document.querySelectorAll('.google-toolbar button')].find(b=>b.textContent==='List').click()");
  await waitFor("!document.querySelector('.google-file-list').classList.contains('google-grid')");
  await capture(label + '-drive-list');
  for (const [section, count] of [['shared', 1], ['starred', 1], ['recent', 9], ['trash', 1], ['my_drive', 8]]) {
    const before = reads.length;
    const index = ['my_drive', 'shared', 'starred', 'recent', 'trash'].indexOf(section);
    await js(`document.querySelectorAll('.google-section')[${index}].click()`);
    await requestAfter(reads, before, r => r.path === '/api/google/drive/files' && r.query.section === section);
    await waitFor(`document.querySelectorAll('.google-file-row').length === ${count}`);
  }
  await js("[...document.querySelectorAll('.google-toolbar button')].find(b=>b.textContent==='Grid').click()");
  await closeDriveOptions();
  const folderRead = reads.length;
  await js("document.querySelector('[data-file-id=drive-folder] .google-file-open').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
  await requestAfter(reads, folderRead, r => r.path === '/api/google/drive/files' && r.query.parent === 'drive-folder');
  await waitFor("!!document.querySelector('[data-file-id=drive-child]')");
  assert.ok(await js("document.querySelector('.google-breadcrumbs').textContent.includes('Project files')"));
  const rootRead = reads.length;
  await js("document.querySelector('.google-breadcrumbs button').click()");
  await requestAfter(reads, rootRead, r => r.path === '/api/google/drive/files' && !r.query.parent);
  await waitFor("document.querySelectorAll('.google-file-row').length === 8");
  await js("document.querySelectorAll('.google-file-row input')[1].click(); document.querySelectorAll('.google-file-row input')[2].click()");
  assert.ok(await js("document.querySelector('.google-selection-toolbar').textContent.includes('2 selected')"));
  await capture(label + '-drive-selection');
  await js("[...document.querySelectorAll('.google-selection-toolbar button')].find(b=>b.textContent==='Clear selection').click()");
  for (const [id, ready, route] of [
    ['doc', "!!document.querySelector('.google-reader')", '/api/google/drive/files/drive-doc/preview'],
    ['slides', "!!document.querySelector('.google-viewer canvas')", '/api/google/drive/files/drive-slides/preview'],
    ['pdf', "!!document.querySelector('.google-viewer canvas')", '/api/google/drive/files/drive-pdf/preview'],
    ['sheet', "document.querySelectorAll('.google-sheet-grid input').length === 240", '/api/google/sheets/drive-sheet'],
    ['form', "document.querySelector('.google-form-items')?.textContent.includes('What would you improve?')", '/api/google/forms/drive-form'],
    ['image', "document.querySelector('.google-viewer img')?.naturalWidth > 0", '/api/google/drive/files/drive-image/preview'],
    ['text', "document.querySelector('.google-text-preview')?.textContent.includes('print(focus)')", '/api/google/drive/files/drive-text/preview'],
  ]) {
    const before = reads.length;
    await js(`document.querySelector('[data-file-id=drive-${id}] .google-file-open').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await requestAfter(reads, before, r => r.path === route).catch(error => { throw new Error(`opening the ${id}: ${error.message}`); });
    await waitFor(ready);
    if (id === 'doc') assert.equal(await js("document.querySelector('.google-reader').getAttribute('sandbox')"), '');
    await js("document.querySelector('.google-detail').scrollIntoView({block:'start'})");
    await capture(label + '-drive-viewer-' + id);
    await js("[...document.querySelectorAll('.google-detail-head button')].find(b=>b.textContent==='Close details').click(); document.querySelector('.google-toolbar').scrollIntoView({block:'start'})");
  }
  await js("document.querySelector('[data-file-id=drive-doc]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}))");
  await waitFor("!!document.querySelector('.google-context-menu')");
  assert.ok(await js("document.querySelector('.google-context-menu').textContent.includes('Share')"));
  await capture(label + '-drive-context-menu');
  await js("[...document.querySelectorAll('.google-context-menu button')].find(b=>b.textContent==='Close menu').click()");
  await navigate('library', { section: 'documents' });
  await navigate('calendar');
  await waitFor("document.querySelectorAll('.cal-calendar-choice.cal-google-event').length === 2");
  const initialMonthRead = reads.length;
  await js("[...document.querySelectorAll('.cal-range-switch button')].find(b=>b.textContent==='Month').click()");
  await requestAfter(reads, initialMonthRead, r => r.path === '/api/calendar/events');
  await waitFor("(() => { const g=document.querySelector('.cal-grid'); return document.querySelectorAll('.cal-day').length === (document.documentElement.classList.contains('kairos-redesign') ? Number(g.style.getPropertyValue('--calendar-weeks')) * 7 : 42); })()");
  // A month cell shows two events and folds the rest into "+N more". On a busy day (the demo's events cluster around
  // today) the Google events can be the folded ones, so then today's day panel, which lists them all, has to show them.
  const googlePill = "!!document.querySelector('.cal-grid .cal-event-pill.cal-google-event')";
  await waitFor(`${googlePill} || !!document.querySelector('.cal-grid .cal-day.today .cal-event-pill.overflow')`);
  if (!await js(googlePill)) {
    await js("document.querySelector('.cal-grid .cal-day.today').click()");
    await waitFor("document.querySelector('.cal-day-panel')?.textContent.includes('Google project review')");
  }
  await capture(label + '-calendar-month-google');

  if (await js("document.documentElement.classList.contains('kairos-redesign') && matchMedia('(min-width: 769px)').matches")) {
    assert.ok(await js(`(() => {
      const prev = document.querySelector('.cal-period-prev'), next = document.querySelector('.cal-period-next');
      const a = getComputedStyle(prev), b = getComputedStyle(next);
      return ['width', 'height', 'borderRadius', 'border', 'backgroundColor', 'padding'].every(key => a[key] === b[key]) &&
        a.width === '36px' && a.width === a.height && a.borderRadius === '50%' && !!prev.querySelector('svg') && !!next.querySelector('svg');
    })()`), label + ' desktop period arrows are identical circles with SVG chevrons');
    assert.ok(await js(`(() => {
      const label = document.querySelector('.cal-month-label'), style = getComputedStyle(label);
      const toolbar = document.querySelector('.cal-grid-toolbar'), grid = document.querySelector('.cal-grid');
      const row = toolbar.getBoundingClientRect(), view = grid.getBoundingClientRect();
      const nav = toolbar.querySelector('.cal-nav'), selector = toolbar.querySelector('.cal-range-switch');
      const period = nav.getBoundingClientRect(), range = selector.getBoundingClientRect();
      return style.borderTopWidth === '0px' && style.boxShadow === 'none' && style.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        label.getAttribute('aria-label') === 'Today' && toolbar.nextElementSibling === grid && row.bottom <= view.top &&
        Math.abs(row.left - view.left) < 1 && Math.abs(row.right - view.right) < 1 &&
        label.parentElement === nav && Math.abs(period.left - view.left) < 1 && Math.abs(range.right - view.right) < 1 &&
        Math.abs((period.top + period.bottom) / 2 - (range.top + range.bottom) / 2) < 1 && period.right <= range.left &&
        !document.querySelector('.view-header .cal-nav') &&
        !document.querySelector('.view-header .cal-range-switch') && !document.querySelector('.cal-day-panel .cal-calendars-card') &&
        !!document.querySelector('.cal-selected-agenda') && !!document.querySelector('.cal-upcoming');
    })()`), label + ' desktop Today period and range selector share a centered row above the grid with an agenda-only sidebar');
  }

  const weekRead = reads.length;
  await js("[...document.querySelectorAll('.cal-range-switch button')].find(b=>b.textContent==='Week').click()");
  await requestAfter(reads, weekRead, r => r.path === '/api/calendar/events');
  await waitFor("document.querySelectorAll('.cal-week-day').length === 7 && !!document.querySelector('.cal-today-line')");
  await capture(label + '-calendar-week-google');
  assert.deepEqual(await overflow(), [], label + ' Week fits within Calendar');
  assert.ok(await js("!document.documentElement.classList.contains('kairos-redesign') || (document.querySelector('.cal-week-header').scrollWidth <= document.querySelector('.cal-grid').clientWidth && !!document.querySelector('.cal-legend'))"), label + ' v2 Week fits all seven columns and has its calendar legend');
  const settingsWrite = writes.length;
  await js("document.querySelector('.cal-calendar-choice input').click()");
  await requestAfter(writes, settingsWrite, w => w.path === '/api/google/calendar/settings' && w.method === 'PATCH');
  const restoreWrite = writes.length;
  await waitFor("!document.querySelector('.cal-calendar-choice input').disabled");
  await js("document.querySelector('.cal-calendar-choice input').click()");
  await requestAfter(writes, restoreWrite, w => w.path === '/api/google/calendar/settings' && w.method === 'PATCH');
  await waitFor("!document.querySelector('.cal-calendar-choice input').disabled");
  await js("document.querySelector('.cal-create-bar button').click()");
  await waitFor("!!document.querySelector('.cal-event-dialog')");
  assert.equal(await js("document.querySelector('.cal-event-dialog select[aria-label=Calendar]').value"), 'demo@example.com');
  assert.equal(await js("document.querySelectorAll('.cal-event-dialog select[aria-label=Calendar] option').length"), 3);
  await capture(label + '-calendar-create-picker');
  const createWrite = writes.length;
  await js(`document.querySelector('.cal-event-dialog input[aria-label="Event title"]').value='Smoke Google event'; document.querySelector('.cal-event-dialog').requestSubmit()`);
  await requestAfter(writes, createWrite, w => w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'create');
  await waitFor("!document.querySelector('.cal-event-dialog')");
  const created = writes.slice(createWrite).find(w => w.path === '/api/google/calendar/action');
  assert.equal(JSON.parse(created.body).calendar_id, 'demo@example.com');
  await waitFor("[...document.querySelectorAll('.cal-day-panel .card')].some(c=>c.textContent.includes('Smoke Google event'))");
  await js("[...document.querySelectorAll('.cal-day-panel .card')].find(c=>c.textContent.includes('Smoke Google event')).querySelector('button').click()");
  await waitFor("!!document.querySelector('.cal-event-dialog')");
  assert.ok(await js("document.querySelector('.cal-event-dialog select[aria-label=Calendar]').disabled"));
  const editWrite = writes.length;
  await js(`document.querySelector('.cal-event-dialog input[aria-label="Event title"]').value='Smoke edited event'; document.querySelector('.cal-event-dialog').requestSubmit()`);
  await requestAfter(writes, editWrite, w => w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'update');
  const edited = JSON.parse(writes.slice(editWrite).find(w => w.path === '/api/google/calendar/action').body);
  await waitFor("!document.querySelector('.cal-event-dialog') && [...document.querySelectorAll('.cal-day-panel .card')].some(c=>c.textContent.includes('Smoke edited event'))");
  await js(`[...document.querySelectorAll('.cal-day-panel .card')].find(c=>c.textContent.includes('Smoke edited event')).querySelector('button[aria-label="Delete event"]').click()`);
  await waitFor("!!document.querySelector('.panel-dialog')");
  const deleteWrite = writes.length;
  await js("document.querySelector('.panel-dialog .btn.danger').click()");
  await requestAfter(writes, deleteWrite, w => w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'delete' && JSON.parse(w.body).event_id === edited.event_id);
  await waitFor("![...document.querySelectorAll('.cal-day-panel .card')].some(c=>c.textContent.includes('Smoke edited event'))");
  const monthRead = reads.length;
  await js("[...document.querySelectorAll('.cal-range-switch button')].find(b=>b.textContent==='Month').click()");
  await requestAfter(reads, monthRead, r => r.path === '/api/calendar/events');
  await waitFor("(() => { const g=document.querySelector('.cal-grid'); return document.querySelectorAll('.cal-day').length === (document.documentElement.classList.contains('kairos-redesign') ? Number(g.style.getPropertyValue('--calendar-weeks')) * 7 : 42); })()");
  writes.splice(writeStart);
};
