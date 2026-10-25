// Called by ui-smoke (or --desktop-layout-only). Uses the shared synthetic backend.
const assert = require('node:assert/strict');

module.exports = async function desktopLayoutChecks({ js, win, waitFor, capture, delay, navigate }) {
  await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ redesign: true }))");
  // Long notes next to short ones: several paragraphs, and one unbroken URL.
  const paragraph = 'Plan the quarter review with the whole team, collect every open question from the last three meetings, and decide who owns each follow-up before Friday. ';
  const notes = [
    { id: 'n1', text: 'Review the workspace design and collect feedback', completed: false, due_date: new Date(Date.now() + 864e5).toISOString() },
    { id: 'n-long', text: (paragraph.repeat(4) + '\n\n').repeat(3).trim(), completed: false },
    { id: 'n2', text: 'Call the dentist', completed: false },
    { id: 'n-url', text: 'See https://example.com/' + 'a-very-long-path-segment-without-any-break'.repeat(6) + '?utm=1', completed: false },
    { id: 'n3', text: 'Organize this week\'s reference material', completed: true },
    { id: 'n-mid', text: paragraph.repeat(2), completed: false, due_date: new Date(Date.now() + 2 * 864e5).toISOString() },
    { id: 'n4', text: 'Buy milk', completed: false },
  ];
  await js(`window.__fetch = window.fetch; window.fetch = (input, init) => String(input).startsWith('/api/notes?') || input === '/api/notes'
    ? Promise.resolve(new Response(JSON.stringify(${JSON.stringify(notes)}), { headers: { 'Content-Type': 'application/json' } })) : window.__fetch(input, init); true`);
  win.setContentSize(1440, 900); await delay(300);
  await navigate('notes');
  await waitFor("document.querySelectorAll('#notes-list > .card').length === 7");
  await delay(900);
const headerActions = (header, label) => js(`(() => { const h = document.querySelector(${JSON.stringify(header)}), edge = h.parentElement.getBoundingClientRect().right;
    const nodes = ${label}.map(q => document.querySelector(q)).filter(n => n && n.getClientRects().length).map(n => n.getBoundingClientRect());
    const mid = nodes.map(r => (r.top + r.bottom) / 2), h0 = nodes.map(r => r.height);
    return nodes.length === ${label}.length && Math.max(...mid) - Math.min(...mid) <= 2 && Math.max(...h0) - Math.min(...h0) <= 2 && nodes.every((r, i) => !i || r.left >= nodes[i - 1].right + 8 && r.left - nodes[i - 1].right <= 16) && Math.abs(nodes.at(-1).right - edge) <= 2; })()`);
  const overlap = () => js(`(() => {
    const cards = [...document.querySelectorAll('#notes-list > .card')].map(c => c.getBoundingClientRect());
    const hits = [];
    cards.forEach((a, i) => cards.slice(i + 1).forEach((b, j) => {
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits.push([i, i + j + 1]);
    }));
    return hits;
  })()`);
  const contained = () => js(`[...document.querySelectorAll('#notes-list > .card')].every(c => { const r = c.getBoundingClientRect(); return c.scrollHeight <= c.clientHeight + 2 && [...c.querySelectorAll('.note-title, .meta, .note-more:not([hidden])')].every(n => { const q = n.getBoundingClientRect(); return q.bottom <= r.bottom + 1 && q.right <= r.right + 1; }); })`);
  for (const w of [1440, 1280, 900]) {
    win.setContentSize(w, 900); await delay(400);
    assert.deepEqual(await overlap(), [], `Notes cards never overlap at ${w}px`);
    assert.ok(await contained(), `Every note's text stays inside its own card at ${w}px`);
    assert.ok(await headerActions('#view-content .view-header', `['.notes-finished-bar .btn', '.notes-sort']`), `Notes header actions share one row at the right edge at ${w}px`);
    if (w === 1440) await capture('layout-notes-1440');
  }
  win.setContentSize(1440, 900); await delay(300);
  assert.ok(await js("[...document.querySelectorAll('#notes-list .note-more:not([hidden])')].length === 3"), 'Long notes (and only they) offer Show more');
  await js("document.querySelector('#notes-list .note-more:not([hidden])').click()");
  await delay(200);
  assert.ok(await js("(() => { const c = document.querySelector('#notes-list > .card.is-expanded'); const t = c.querySelector('.note-title'); return t.scrollHeight <= t.clientHeight + 1 && c.querySelector('.note-more').textContent === 'Show less'; })()"), 'Show more reveals the full text');
  assert.deepEqual(await overlap(), [], 'Expanded notes do not overlap');
  assert.ok(await contained(), 'An expanded note still holds all its text');

  // Vault home: Browse by property leads, full width, above the other cards.
  await js("window.fetch = window.__fetch; true");
  await navigate('library', { section: 'vault' });
  await waitFor("!!document.querySelector('.vault-home-grid .vault-home-card')");
  await delay(500);
  assert.ok(await js(`(() => { const grid = document.querySelector('.vault-home-grid'), f = document.querySelector('.vault-home-filters'); const g = grid.getBoundingClientRect(), r = f.getBoundingClientRect();
    return grid.firstElementChild === f && Math.abs(r.left - g.left) < 2 && Math.abs(r.right - g.right) < 2 &&
      [...grid.querySelectorAll('.vault-home-card:not(.vault-home-filters)')].every(c => c.getBoundingClientRect().top >= r.bottom - 1); })()`), 'Browse by property is the first card, full width, above the rest');
  await capture('layout-vault-1440');

  // Tasks: a 12-column grid like Home; every row fills the width and shares edges.
  const congruent = (selector) => js(`(() => {
    const grid = document.querySelector(${JSON.stringify(selector)}), bounds = grid.getBoundingClientRect(), rows = [];
    for (const node of grid.children) {
      if (!node.getClientRects().length || getComputedStyle(node).position === 'absolute') continue;
      const r = node.getBoundingClientRect();
      let row = rows.find(row => Math.abs(row[0].top - r.top) <= 2);
      if (!row) rows.push(row = []);
      row.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    return rows.length > 1 && rows.every(row => Math.abs(Math.min(...row.map(r => r.left)) - bounds.left) <= 2 &&
      Math.abs(Math.max(...row.map(r => r.right)) - bounds.right) <= 2 &&
      row.every(r => Math.abs(r.top - row[0].top) <= 2 && Math.abs(r.bottom - row[0].bottom) <= 2));
  })()`);
  for (const w of [1440, 1280, 900]) {
    win.setContentSize(w, 900); await delay(300);
    await navigate('tasks'); await waitFor("!!document.querySelector('#tasks-list .card')"); await delay(900);
    assert.ok(await headerActions('#view-content .view-header', `['.tasks-build-button', '#view-content .view-constrained > details.disclosure-panel > summary']`), `Tasks header actions share one row at the right edge at ${w}px`);
    assert.ok(await congruent('#view-content .view-constrained'), `Tasks rows fill the width and share top/bottom edges at ${w}px`);
    assert.ok(await congruent('#tasks-list'), `Scheduled routine rows fill the width at ${w}px`);
    assert.ok(await js(`(() => {
      const order = ['.view-header', '.task-activity', '#tasks-list', '.task-board-card', '.triggers-card', '.automation-library']
        .map(q => document.querySelector('#view-content .view-constrained > ' + q)).filter(Boolean).map(n => n.getBoundingClientRect());
      return order.every((r, i) => !i || r.top > order[i - 1].top + 2 || (Math.abs(r.top - order[i - 1].top) <= 2 && r.left >= order[i - 1].right - 2));
    })()`), `Tasks read in order: title row, runs chart, routines, board, triggers, library at ${w}px`);
    await capture('layout-tasks-' + w);
  }
  win.setContentSize(1440, 900);
};
