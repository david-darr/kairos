// Every Bots surface on a phone (migrated from the Agents surfaces, Phase 1): no
// sideways page scroll, and every visible control at least 44px square, at
// 390x844 and 360x740. Run from scripts/ui-smoke.cjs; `report` mode returns the
// problems instead of failing, which is how the audit found what to fix.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

const MEASURE = `(scopeSelector => {
  const problems = [];
  const root = document.documentElement;
  if (root.scrollWidth > innerWidth + 1) problems.push('page scrolls sideways: ' + root.scrollWidth + ' > ' + innerWidth);
  const scopes = [...document.querySelectorAll(scopeSelector)].filter(node => node.getClientRects().length);
  const seen = new Set();
  for (const scope of scopes) {
    for (const node of scope.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab]')) {
      if (seen.has(node) || node.disabled || !node.getClientRects().length) continue;
      seen.add(node);
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1 || r.left < -1) problems.push('off-screen: ' + describe(node) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      // A checkbox or radio is judged by its label, which is the real target.
      const target = (node.matches('input[type=checkbox], input[type=radio]') && node.closest('label')) || node;
      const t = target.getBoundingClientRect();
      if (t.width < 43.5 || t.height < 43.5) problems.push('small: ' + describe(node) + ' ' + Math.round(t.width) + 'x' + Math.round(t.height));
    }
  }
  return problems;
  function describe(node) {
    const label = (node.getAttribute('aria-label') || node.textContent || node.placeholder || node.name || '').trim().replace(/\\s+/g, ' ').slice(0, 28);
    return node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\\s+/)[0] : '') + ' "' + label + '"';
  }
})`;

module.exports = async ({ js, waitFor, delay, navigate, win, demoState, base, report = false }) => {
  const found = [];
  const q = JSON.stringify;
  const restore = await isolateBotsCheck({ js, demoState });
  const check = async (where, scope) => {
    await delay(300);
    const problems = await js(`${MEASURE}(${q(scope)})`);
    for (const problem of problems) found.push(`${where}: ${problem}`);
  };
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");
    const call = (path, method, body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' }, body: ${q(JSON.stringify(body))} }).then(r => r.json())`);
    const bot = await call('/api/agents', 'POST', { name: `Phone Probe ${Date.now() % 100000}`, role: 'Checks phones' });
    await call(`/api/agents/${bot.id}/threads`, 'POST', { title: 'Main' });
    const escape = () => js("(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
    for (const interfaceMode of [false, true]) {
      await js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${interfaceMode}); return true; })`);
      for (const [width, height] of [[390, 844], [360, 740]]) {
        win.setContentSize(width, height);
        await delay(400);
        const at = `${width}x${height}${interfaceMode ? ' advanced' : ''}`;
        await navigate('botsHome');
        await waitFor("!!document.querySelector('.bots-home .bots-grid')");
        await check(`${at} Bots home`, '#content');
        // The floating updates control is measured too and must not cover any control in the view.
        await check(`${at} updates`, '.ms-activity');
        const covered = await js(`(() => { const f = document.querySelector('.ms-activity-floating'); if (!f || f.hidden || !f.getClientRects().length) return []; const a = f.getBoundingClientRect(); return [...document.querySelectorAll('#content button, #content input, #content a[href]')].filter(n => n.getClientRects().length).filter(n => { const r = n.getBoundingClientRect(); return r.left < a.right && r.right > a.left && r.top < a.bottom && r.bottom > a.top; }).map(n => (n.getAttribute('aria-label') || n.textContent || n.className).trim().slice(0, 28)); })()`);
        for (const name of covered) found.push(`${at} Bots home: updates control covers ${name}`);
        await navigate('botsShell', { agentId: bot.id });
        await waitFor(`document.documentElement.dataset.botsAgent === ${q(bot.id)} && !!document.querySelector('.bots-composer-input')`);
        await check(`${at} conversation`, '#content');
        await js("document.querySelector('.bots-head-convos').click()");
        await waitFor("!document.querySelector('#bots-convos').hidden");
        await check(`${at} conversations list`, '#bots-convos');
        await escape();
        await js("document.querySelector('.bots-head-pill').click()");
        await waitFor("!!document.querySelector('#bots-panel .bots-panel-body *')");
        await delay(400);
        await check(`${at} panel`, '#bots-panel');
        await js("document.querySelector('#bots-panel .bots-panel-close').click()");
        await waitFor("!document.querySelector('#bots-panel')");
        await navigate('botsHome');
        await waitFor("!!document.querySelector('.bots-home-actions .bots-btn.primary')");
        await js("document.querySelector('.bots-home-actions .bots-btn.primary').click()");
        await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog')");
        await check(`${at} new bot`, '.bots-create-dialog');
        await js("document.querySelector('.bots-create-dialog .modal-close-btn')?.click()");
        await escape();
        await js("document.querySelector('.confirm-panel .modal-footer .btn:last-child')?.click()");
        await delay(200);
      }
    }
  } finally {
    win.setContentSize(1440, 900);
    await delay(300);
    await restore();
  }
  if (report) return found;
  assert.deepEqual(found, [], 'Bots surfaces fit a phone with 44px targets');
  return found;
};
