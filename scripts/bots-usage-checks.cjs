// Bots redesign, Phase 6 unit U3 (2026-10-29): Settings' Bot usage and Bot housekeeping pages, mounted in a scratch
// container under data-app-mode="bots". Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-usage-only
// The usage lane (scripts/fixtures/bots-usage-backend.cjs) answers /api/bot-usage/* from demoState.botsUsage.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, win, capture, demoState, base }) => {
  const at = Date.now() / 1000;
  const usage = {
    runs: [
      { run_id: 'u-run-1', bot_id: 'usage-bot-a', model: 'Model One', at, duration_s: 12.5, cost_usd: 0.02, tokens: 1200, steps: 3, tools: 2, errors: 0 },
      { run_id: 'u-run-2', bot_id: 'usage-bot-a', model: 'Model One', at, duration_s: 4, cost_usd: 0.01, tokens: 300, steps: 1, tools: 0, errors: 1 },
      { run_id: 'u-run-3', bot_id: 'usage-bot-b', model: 'Model Two', at, duration_s: 60, cost_usd: null, tokens: 500, steps: 2, tools: 1, errors: 0 },
    ],
    budget: { monthly_usd: 0.025, warn_percent: 80 }, prices_override: {},
    housekeeping: { event_retention_days: 30, event_size_cap_mb: 64 },
    plan: { providers: [{ provider: 'Claude', windows: [{ name: '5-hour limit', used_percent: 72, resets_at: at + 3600 }] }] }, writes: [],
  };
  const restore = await isolateBotsCheck({ js, demoState }, { botsUsage: usage });
  const text = () => js("document.getElementById('bots-usage-scratch').textContent");
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { const box = document.createElement('div'); box.id = 'bots-usage-scratch'; box.dataset.appMode = 'bots';
      box.style.cssText = 'position:fixed;inset:0 auto auto 0;width:360px;height:100vh;overflow:auto;z-index:9999;background:var(--bots-app, #fff)';
      box.innerHTML = '<div id="usage-host"></div><div id="housekeeping-host"></div>'; document.body.append(box);
      window.__usageAbort = new AbortController(); })()`);
    await js(`import('/static/js/botsSettingsUsage.js').then(m => Promise.all([
      m.mount(document.getElementById('usage-host'), { signal: window.__usageAbort.signal }),
      m.mountHousekeeping(document.getElementById('housekeeping-host'), { signal: window.__usageAbort.signal })]))`);

    // Totals for the month, the cap reached, the price note, where it went and the runs.
    await waitFor("document.getElementById('bots-usage-scratch').textContent.includes('Where it went')");
    const shown = await text();
    assert.match(shown, /Cost\$0\.030/, 'known costs add up; the unknown one is left out');
    assert.match(shown, /1 runs have unknown cost/);
    assert.match(shown, /Monthly spend cap reached/, 'spent is over the cap');
    assert.match(shown, /Prices as of 2026-10-01/);
    assert.equal(await js("document.querySelectorAll('#usage-host .bots-usage-bar-row').length"), 2, 'one bar per bot');
    assert.equal(await js("document.querySelectorAll('#usage-host [data-run-id]').length"), 3, 'every run listed');
    assert.match(shown, /Model Two · 1m 0s · Unknown/, 'a run with no price says so');
    assert.match(shown, /Claude/, 'the plan meter names its provider');
    assert.equal(await js("document.querySelector('#usage-host progress.bots-plan-meter').value"), 72);
    assert.equal(await js("document.querySelector('#usage-host progress.bots-plan-meter').classList.contains('warn')"), true, '72% is a warning');
    await capture?.('phone-bots-usage');

    // Grouping by model regroups the bars.
    await js("(() => { const s = document.querySelector('#usage-host select[aria-label=\"Group usage by\"]'); s.value = 'model'; s.dispatchEvent(new Event('change')); })()");
    await waitFor("[...document.querySelectorAll('#usage-host .bots-usage-bar-row')].map(n => n.firstChild.textContent).join() === 'Model One,Model Two'");

    // Raising the cap saves it and the warning clears.
    await js("(() => { const i = document.querySelector('#usage-host input[aria-label=\"Monthly cap in USD\"]'); i.value = '5'; })()");
    await js("[...document.querySelectorAll('#usage-host button')].find(b => b.textContent === 'Save cap').click()");
    await waitFor("document.getElementById('usage-host').textContent.includes('$0.030 this month')");
    assert.deepEqual(usage.writes.at(-1), { route: '/api/bot-usage/budget', body: { monthly_usd: 5, warn_percent: 80 } });
    assert.equal(usage.budget.monthly_usd, 5);

    // Housekeeping saves its two numbers; an out-of-range value never leaves the page.
    await waitFor("!!document.querySelector('#housekeeping-host input[aria-label=\"Trace retention days\"]')");
    assert.equal(await js("document.querySelector('#housekeeping-host input[aria-label=\"Trace retention days\"]').value"), '30');
    const writes = usage.writes.length;
    await js("(() => { document.querySelector('#housekeeping-host input[aria-label=\"Trace retention days\"]').value = '0'; [...document.querySelectorAll('#housekeeping-host button')].find(b => b.textContent === 'Save housekeeping').click(); })()");
    assert.equal(usage.writes.length, writes, 'an invalid number is not sent');
    await js("(() => { document.querySelector('#housekeeping-host input[aria-label=\"Trace retention days\"]').value = '14'; [...document.querySelectorAll('#housekeeping-host button')].find(b => b.textContent === 'Save housekeeping').click(); })()");
    await waitFor("document.getElementById('housekeeping-host').textContent.includes('Applies on the next daily cleanup')");
    assert.deepEqual(usage.housekeeping, { event_retention_days: 14, event_size_cap_mb: 64 });

    // Phone width: nothing wider than the column, every control at least 44 px tall.
    assert.deepEqual(await js("[...document.querySelectorAll('#bots-usage-scratch *')].filter(n => n.getBoundingClientRect().right > 361).map(n => n.tagName + '.' + n.className)"), [], 'no sideways overflow');
    assert.deepEqual(await js("[...document.querySelectorAll('#bots-usage-scratch button, #bots-usage-scratch input, #bots-usage-scratch select, #bots-usage-scratch summary, #bots-usage-scratch a[href]')].filter(n => n.getClientRects().length && n.getBoundingClientRect().height < 43.5).map(n => (n.getAttribute('aria-label') || n.textContent).slice(0, 30))"), [], '44 px targets');
  } finally {
    try { await js("(() => { window.__usageAbort?.abort(); delete window.__usageAbort; document.getElementById('bots-usage-scratch')?.remove(); })()"); }
    finally { await restore(); }
  }
};
