// Every bot surface on a phone (Agents 2.0 unit 6-ii, 2026-10-14): no
// sideways page scroll, and every visible control at least 44px square, at
// 390x844 and 360x740. Run from scripts/ui-smoke.cjs; `report` mode returns the
// problems instead of failing, which is how the audit found what to fix.
const assert = require('node:assert/strict');

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

module.exports = async ({ js, waitFor, delay, navigate, win, report = false }) => {
  const found = [];
  const check = async (where, scope) => {
    await delay(250);
    const problems = await js(`${MEASURE}(${JSON.stringify(scope)})`);
    for (const problem of problems) found.push(`${where}: ${problem}`);
  };
  for (const [width, height] of [[390, 844], [360, 740]]) {
    win.setContentSize(width, height);
    await delay(300);
    const at = `${width}x${height}`;
    await navigate('agents');
    await waitFor("!!document.querySelector('.agents-messenger-welcome')");
    await check(`${at} agents`, '#content');
    // With updates present, the floating updates control is measured too and must not cover any control in the view.
    await check(`${at} agents updates`, '.ms-activity');
    const covered = await js(`(() => { const f = document.querySelector('.ms-activity-floating'); if (!f || f.hidden || !f.getClientRects().length) return []; const a = f.getBoundingClientRect(); return [...document.querySelectorAll('#content button, #content input, #content a[href]')].filter(n => n.getClientRects().length).filter(n => { const r = n.getBoundingClientRect(); return r.left < a.right && r.right > a.left && r.top < a.bottom && r.bottom > a.top; }).map(n => (n.className || n.tagName).toString().slice(0, 30)); })()`);
    for (const name of covered) found.push(`${at} agents: updates control covers ${name}`);
    await js("document.querySelector('.agents-chats-open').click()");
    await check(`${at} chats drawer`, '.agents-chat-rail');
    await js("document.querySelector('.agents-rail-toggle').click()");
    for (const tab of ['chat', 'work', 'routines', 'memory']) {
      await navigate('agents', { agentId: 'a1', agentTab: tab });
      await waitFor("!!document.querySelector('#content .agent-header-blurb, #content h1, #content h2')");
      await check(`${at} bot ${tab}`, '#content');
    }
    await navigate('agents', { agentId: 'a1', profile: true });
    await waitFor("!!document.querySelector('.agent-profile-sheet:not([hidden])')");
    await check(`${at} profile`, '.agent-profile-sheet');
    await js("document.querySelector('.agent-profile-sheet [aria-label=\"Close profile\"], .agent-profile-sheet .agent-profile-close')?.click()");
    await navigate('agents');
    await waitFor("!!document.querySelector('.agents-welcome-actions .primary')");
    await js("document.querySelector('.agents-welcome-actions .primary').click()");
    await waitFor("!!document.querySelector('.agent-create-dialog')");
    await check(`${at} new bot`, '.agent-create-dialog');
    await js("document.querySelector('.agent-create-dialog [aria-label=\"Close\"], .agent-create-dialog .modal-close')?.click()");
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await delay(200);
  }
  win.setContentSize(1440, 900);
  await delay(300);
  if (report) return found;
  assert.deepEqual(found, [], 'Bot surfaces fit a phone with 44px targets');
  return found;
};
