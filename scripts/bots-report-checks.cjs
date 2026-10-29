// Bots redesign, Phase 6 unit U4 (2026-10-29): Report a problem. Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-report-only
// The lifecycle lane (scripts/fixtures/bots-lifecycle-backend.cjs) answers /api/bot-lifecycle/reports like the server:
// one report per message. The check opens the dialog, drafts, sees the report, opens the folder, and drafts again.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, win, capture, writes, demoState, base }) => {
  const lifecycle = { inspect: null, import: null, log: [], reports: {} };
  const restore = await isolateBotsCheck({ js, demoState }, { botsLifecycle: lifecycle });
  const originalSize = win.getContentSize();
  const dialog = "document.querySelector('.bots-report')";
  const open = () => js("import('/static/js/botsReport.js').then(m => { window.__report = m.openReport({ sessionId: 'report-thread', messageId: 'report-msg', botName: 'Helper' }); return true; })");
  const close = () => js("(() => { window.__report?.close?.(); delete window.__report; document.querySelectorAll('.bots-lifecycle-dialog').forEach(n => n.closest('dialog, .panel-dialog, [role=dialog]')?.remove?.()); })()");
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await open();
    await waitFor(`!!${dialog}`);
    assert.match(await js(`${dialog}.textContent`), /About a reply from Helper\..*Nothing is sent\./);
    const draftButton = `[...${dialog}.querySelectorAll('button')].find(b => b.textContent === 'Draft report')`;
    assert.equal(await js(`${draftButton}.disabled`), true, 'nothing to draft until it says what went wrong');
    await js(`(() => { const set = (id, v) => { const t = ${dialog}.querySelector('textarea[data-field=' + id + ']'); t.value = v; t.dispatchEvent(new Event('input')); };
      set('went_wrong', 'It showed a key'); set('you_saw', 'A long code in the reply'); })()`);
    assert.equal(await js(`${dialog}.querySelector('textarea[data-field=went_wrong]').maxLength`), 2000);
    assert.match(await js(`${dialog}.textContent`), /15 of 2,000/, 'the counter follows the text');
    assert.equal(await js(`${draftButton}.disabled`), false);
    await capture?.('desktop-bots-report-form');

    const start = writes.length;
    await js(`${draftButton}.click()`);
    await waitFor(`${dialog}.textContent.includes('Drafted. Read it before you share it')`);
    const sent = writes.slice(start).find(w => w.method === 'POST' && w.path === '/api/bot-lifecycle/reports');
    assert.deepEqual(JSON.parse(sent.body), { session_id: 'report-thread', message_id: 'report-msg', went_wrong: 'It showed a key', you_saw: 'A long code in the reply', steps: '' });
    assert.match(await js(`${dialog}.querySelector('.bots-report-text').textContent`), /# Kairos problem report[\s\S]*It showed a key/);
    assert.match(await js(`${dialog}.querySelector('.bots-report-path').textContent`), /bot_reports/);
    await js(`[...${dialog}.querySelectorAll('button')].find(b => b.textContent === 'Open folder').click()`);
    for (let i = 0; i < 20 && !lifecycle.log.some(e => e.route === '/api/bot-lifecycle/reports/open-folder'); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(lifecycle.log.some(e => e.route === '/api/bot-lifecycle/reports/open-folder'), 'Open folder asks the app to show it');
    await capture?.('desktop-bots-report-done');
    await close();

    // A second report about the same message shows the first.
    await open();
    await waitFor(`!!${dialog}?.querySelector('textarea[data-field=went_wrong]')`);
    await js(`(() => { const t = ${dialog}.querySelector('textarea[data-field=went_wrong]'); t.value = 'Again'; t.dispatchEvent(new Event('input')); })()`);
    await js(`[...${dialog}.querySelectorAll('button')].find(b => b.textContent === 'Draft report').click()`);
    await waitFor(`${dialog}.textContent.includes('Already drafted for this message')`);
    assert.equal(Object.keys(lifecycle.reports).length, 1, 'still one report');

    // Phone width: the dialog fits and its controls keep 44 px targets.
    win.setContentSize(390, 844); await new Promise(r => setTimeout(r, 400));
    assert.ok(await js("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'no sideways scroll');
    assert.deepEqual(await js(`[...${dialog}.querySelectorAll('button')].filter(b => b.getClientRects().length && b.getBoundingClientRect().height < 43.5).map(b => b.textContent)`), [], '44 px targets');
  } finally {
    try { win.setContentSize(originalSize[0], originalSize[1]); await close(); } finally { await restore(); }
  }
};
