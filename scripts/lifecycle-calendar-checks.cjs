// Shared desktop/phone checks against ui-smoke's isolated synthetic backend.
module.exports = async ({ js, waitFor, capture, navigate, overflow, reads, writes, label }) => {
  const assert = require('node:assert/strict');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const requestAfter = async (records, before, predicate) => {
    for (let i = 0; i < 80; i++) {
      const found = records.slice(before).find(predicate);
      if (found) return found;
      await delay(50);
    }
    throw new Error('Lifecycle/calendar request missing: ' + JSON.stringify(records.slice(before).slice(-6)));
  };
  const writeStart = writes.length;
  const shot = async name => {
    // Rapid synthetic actions must not fill later screenshots with stale toasts.
    await js("document.querySelector('#toast-host')?.replaceChildren()");
    await capture(name);
  };
  const change = (selector, value) => js(`{ const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('change',{bubbles:true})); }`);
  const getItems = () => js("import('/static/js/api.js').then(m=>m.api('/api/calendar/events?start=2020-01-01T00:00:00Z&end=2035-01-01T00:00:00Z'))");
  const show = async (item = null, google = false) => {
    await js(`import('/static/js/googleCalendar.js').then(async m=>m.eventDialog(${google ? "await (await import('/static/js/api.js')).api('/api/google/calendar/calendars')" : '[]'},async()=>{},${JSON.stringify(item)}))`);
    await waitFor("!!document.querySelector('.cal-event-dialog')");
  };
  const visible = selector => js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const setTitle = title => js(`document.querySelector('.cal-event-dialog input[aria-label="Event title"]').value=${JSON.stringify(title)}`);
  const submit = async predicate => {
    assert.ok(await js("document.querySelector('.cal-event-dialog').checkValidity()"), label + ' repeat form has no hidden invalid controls');
    const before = writes.length;
    await js("document.querySelector('.cal-event-dialog').requestSubmit()");
    const record = await requestAfter(writes, before, predicate);
    await waitFor("!document.querySelector('.cal-event-dialog')");
    return JSON.parse(record.body);
  };

  await navigate('tool-store');
  await waitFor("!!document.querySelector('[data-tab-slug=project_tracker]')");
  await js("[...document.querySelectorAll('.tool-store-filters button')].find(b=>b.textContent==='Tabs').click()");
  let before = writes.length;
  await js("[...document.querySelectorAll('[data-tab-slug=project_tracker] button')].find(b=>b.textContent==='Turn off').click()");
  await requestAfter(writes, before, w => w.path === '/api/system/custom-tabs/project_tracker/enabled' && JSON.parse(w.body).enabled === false);
  await waitFor("!!document.querySelector('[data-disabled-tabs]') && [...document.querySelectorAll('[data-tab-slug=project_tracker] button')].some(b=>b.textContent==='Turn on')");
  assert.ok(await js("document.querySelector('[data-disabled-tabs]').nextElementSibling.contains(document.querySelector('[data-tab-slug=project_tracker]'))"), label + ' off tabs are retained at the bottom');
  await js("document.querySelector('[data-disabled-tabs]').scrollIntoView({block:'center'})");
  await shot(label + '-tabs-turned-off');
  before = writes.length;
  await js("[...document.querySelectorAll('[data-tab-slug=project_tracker] button')].find(b=>b.textContent==='Turn on').click()");
  await requestAfter(writes, before, w => w.path === '/api/system/custom-tabs/project_tracker/enabled' && JSON.parse(w.body).enabled === true);
  await waitFor("[...document.querySelectorAll('[data-tab-slug=project_tracker] button')].some(b=>b.textContent==='Turn off')");

  await navigate('tasks');
  await waitFor("!!document.querySelector('[data-task=t1]')");
  const original = await js("import('/static/js/api.js').then(async m=>(await m.api('/api/tasks')).find(t=>t.id==='t1'))");
  before = writes.length;
  await js("[...document.querySelectorAll('[data-task=t1] button')].find(b=>b.textContent==='Turn off').click()");
  await requestAfter(writes, before, w => w.path === '/api/tasks/t1' && JSON.parse(w.body).enabled === false);
  await waitFor("!!document.querySelector('[data-task=t1][data-enabled=false]') && !!document.querySelector('[data-disabled-tasks]')");
  assert.ok(await js("!!(document.querySelector('[data-disabled-tasks]').compareDocumentPosition(document.querySelector('[data-task=t1]')) & Node.DOCUMENT_POSITION_FOLLOWING) && document.querySelector('#tasks-list [data-task]:last-child')?.dataset.task==='t1'"), label + ' disabled automations follow enabled ones');
  await js("document.querySelector('[data-task=t1]').scrollIntoView({block:'center'})");
  await shot(label + '-automations-turned-off');
  before = writes.length;
  // Restore through the library to exercise builtin reuse as well as the generic toggle.
  await js("[...[...document.querySelectorAll('.automation-card')].find(c=>c.textContent.includes('Daily briefing')).querySelectorAll('button')].find(b=>b.textContent==='Enable').click()");
  await requestAfter(writes, before, w => w.path === '/api/tasks/builtin/routine0/enable');
  await waitFor("!!document.querySelector('[data-task=t1][data-enabled=true]')");
  const restored = await js("import('/static/js/api.js').then(async m=>(await m.api('/api/tasks')).find(t=>t.id==='t1'))");
  assert.equal(restored.last_run_at, original.last_run_at, label + ' reenable keeps history');
  assert.equal(restored.deliver_to_channel, original.deliver_to_channel, label + ' reenable keeps delivery');

  await navigate('calendar');
  for (const google of [false, true]) {
    const name = `${label} ${google ? 'Google' : 'Kairos'} repeated event`;
    await show(null, google);
    assert.equal(await visible('[aria-label="Edit recurring event"]'), false, label + ' one-offs hide scope');
    assert.equal(await visible('[aria-label="Repeat interval"]'), false, label + ' no-repeat hides interval');
    await change('[aria-label="Repeat"]', 'monthly');
    assert.equal(await visible('[aria-label="Repeat interval"]'), true);
    await change('[aria-label="Repeat ends"]', 'until');
    assert.equal(await visible('[aria-label="Repeat end date"]'), true);
    assert.equal(await visible('[aria-label="Repeat count"]'), false);
    await change('[aria-label="Repeat"]', 'weekly');
    await change('[aria-label="Repeat interval"]', '2');
    await change('[aria-label="Repeat ends"]', 'count');
    await change('[aria-label="Repeat count"]', '3');
    assert.equal(await visible('[aria-label="Repeat end date"]'), false);
    assert.equal(await visible('[aria-label="Repeat count"]'), true);
    await setTitle(name);
    await shot(label + (google ? '-google' : '-local') + '-repeat-create');
    if (await js("window.innerWidth < 680")) {
      await js("document.querySelector('[data-repeat-controls]').scrollIntoView({block:'center'})");
      await shot(label + (google ? '-google' : '-local') + '-repeat-options');
    }
    const created = await submit(w => google ? w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'create' : w.path === '/api/calendar/events' && w.method === 'POST');
    assert.deepEqual(google ? created.event.repeat : created.recurrence, { frequency: 'weekly', interval: 2, count: 3 });
    let instances = (await getItems()).filter(e => e.title === name);
    assert.equal(instances.length, 3, label + ' synthetic calendar expands the created series');
    const first = instances[0];
    await show(first, google);
    assert.equal(await visible('[data-repeat-controls]'), false, label + ' occurrence hides repeat editing');
    assert.ok(await js("[...document.querySelectorAll('[data-repeat-controls] input,[data-repeat-controls] select')].every(n=>n.disabled)"));
    await setTitle(name + ' changed once');
    const once = await submit(w => google ? w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'update' : w.path.startsWith('/api/calendar/events/') && w.method === 'PATCH');
    assert.equal(Object.hasOwn(google ? once.event : once, google ? 'repeat' : 'recurrence'), false, label + ' occurrence save preserves rule');
    assert.equal(google ? once.event_id : once.scope, google ? first.id : 'occurrence');
    instances = (await getItems()).filter(e => e.series_id === first.series_id);
    const second = instances.find(e => e.id !== first.id);
    await show(second, google);
    const readBefore = reads.length;
    await change('[aria-label="Edit recurring event"]', 'series');
    await requestAfter(reads, readBefore, r => google ? r.path === '/api/google/calendar/events/' + first.series_id : r.path === '/api/calendar/events/' + second.id && r.query.scope === 'series');
    await waitFor("!document.querySelector('.cal-event-dialog button[type=submit]').disabled && !document.querySelector('[data-repeat-controls]').hidden");
    assert.equal(await js("document.querySelector('[aria-label=\"Repeat count\"]').value"), '3');
    assert.equal(await js("document.querySelector('[aria-label=\"Time zone\"]').value"), second.time_zone);
    await setTitle(name + ' whole series');
    const all = await submit(w => google ? w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'update' : w.path === '/api/calendar/events/' + first.series_id && w.method === 'PATCH');
    assert.equal(google ? all.event_id : all.scope, google ? first.series_id : 'series');
    assert.deepEqual(google ? all.event.repeat : all.recurrence, { frequency: 'weekly', interval: 2, count: 3 });
    await js(`import('/static/js/googleCalendar.js').then(m=>m.deleteCalendarEvent(${JSON.stringify(second)},async()=>{}))`);
    await waitFor("!!document.querySelector('[aria-label=\"Delete recurring event\"]')");
    before = writes.length;
    await js("document.querySelector('.panel-dialog .btn.danger').click()");
    const deletion = await requestAfter(writes, before, w => google ? w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'delete' : w.path === '/api/calendar/events/' + second.id && w.method === 'DELETE');
    assert.equal(google ? JSON.parse(deletion.body).event_id : deletion.query.scope, google ? second.id : 'occurrence');
    await waitFor("!document.querySelector('.panel-dialog')");
    instances = (await getItems()).filter(e => e.series_id === first.series_id);
    assert.equal(instances.length, 2, label + ' this-event deletion keeps the other dates');
    await js(`import('/static/js/googleCalendar.js').then(m=>m.deleteCalendarEvent(${JSON.stringify(instances[0])},async()=>{}))`);
    await waitFor("!!document.querySelector('[aria-label=\"Delete recurring event\"]')");
    await change('[aria-label="Delete recurring event"]', 'series');
    await shot(label + (google ? '-google' : '-local') + '-repeat-delete-scope');
    before = writes.length;
    await js("document.querySelector('.panel-dialog .btn.danger').click()");
    const seriesDeletion = await requestAfter(writes, before, w => google ? w.path === '/api/google/calendar/action' && JSON.parse(w.body).action === 'delete' : w.path.startsWith('/api/calendar/events/') && w.method === 'DELETE');
    assert.equal(google ? JSON.parse(seriesDeletion.body).event_id : seriesDeletion.query.scope, google ? first.series_id : 'series');
    await waitFor("!document.querySelector('.panel-dialog')");
    assert.equal((await getItems()).filter(e => e.series_id === first.series_id).length, 0);
  }
  assert.deepEqual(await overflow(), [], label + ' lifecycle/calendar fits');
  writes.splice(writeStart);
};
