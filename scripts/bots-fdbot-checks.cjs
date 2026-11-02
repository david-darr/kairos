// Phase 5 U1. Electron runs are owned by the orchestrator.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, navigate, win, demoState, base }) => {
  const restore = await isolateBotsCheck({ js, demoState }, { botsFdBot: undefined });
  const call = (route, method = 'GET', body) => js(`fetch(${JSON.stringify(route)}, {method:${JSON.stringify(method)},
    headers:{'Content-Type':'application/json'}, body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}})
    .then(async r => ({status:r.status, body:await r.json()}))`);
  const refresh = () => js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
  let anchorId;
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    // With no front desk, Bots home offers it back, and the button brings it back.
    await navigate('botsHome');
    await waitFor("!!document.querySelector('.bots-home-frontdesk:not([hidden]) button')");
    assert.match(await js("document.querySelector('.bots-home-frontdesk').textContent"), /front desk, is not here.*Bring back the front desk/);
    await js("document.querySelector('.bots-home-frontdesk button').click()");
    await waitFor("document.querySelector('.bots-home-frontdesk').hidden");
    const ensured = await call('/api/front-desk/ensure', 'POST', {});
    assert.equal(ensured.status, 200);
    const bot = ensured.body.agent;
    assert.equal(bot.builtin, 'front_desk');
    assert.equal(bot.order, -1);
    const extra = await call('/api/agents', 'POST', { name: `FD check ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
    assert.equal(extra.status, 200);
    assert.notEqual(extra.body.id, bot.id);

    await navigate('botsHome');
    await refresh();
    await waitFor(`!!document.querySelector('.bots-bot-card[data-agent-id="${bot.id}"]')`);
    assert.equal(await js("document.querySelector('.bots-bot-card[data-agent-id]')?.dataset.agentId"), bot.id, 'seed order places the front desk first on home');
    await waitFor(`!!document.querySelector('.bots-rail-row[data-agent-id="${bot.id}"]')`);
    assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id]')?.dataset.agentId"), bot.id, 'front desk leads the bot rail');
    // 2026-11-02: Kip is its own card above the sections, as Kairos's own Kip, and leaves the bot lists.
    assert.ok(await js(`(() => { const desk = document.querySelector('.bots-rail-desk[data-agent-id="${bot.id}"]'); return !!desk && desk.textContent.includes('Your front desk')
      && document.querySelectorAll('.bots-rail-row[data-agent-id="${bot.id}"]').length === 1 && JSON.parse(desk.querySelector('[data-avatar-spec]').dataset.avatarSpec).color === 'ink'; })()`), 'one Kip card, with the normal Kip');

    // Exercise the real menu without depending on the front-desk shell unit.
    anchorId = `fd-menu-${Date.now()}`;
    await js(`(async () => { const n=document.createElement('button'); n.id=${JSON.stringify(anchorId)}; n.textContent='Bot menu'; document.body.append(n);
      const m=await import('/static/js/botsPanel.js'); m.openBotMenu(n, ${JSON.stringify(bot)}); })()`);
    await waitFor("!!document.querySelector('.bots-menu')");
    assert.equal(await js("[...document.querySelectorAll('.bots-menu-row-label')].some(n => n.textContent.trim() === 'Delete')"), false,
      'a built-in bot has no Delete menu item');
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    const removed = await call(`/api/agents/${bot.id}`, 'DELETE');
    assert.equal(removed.status, 409);
    assert.match(removed.body.detail, /cannot be deleted/i);

    assert.equal((await call(`/api/agents/${bot.id}`, 'PATCH', { hidden: true })).status, 200);
    await refresh();
    await waitFor(`!document.querySelector('.bots-bot-card[data-agent-id="${bot.id}"]')`);
    assert.equal((await call('/api/front-desk/ensure', 'POST', {})).body.agent.hidden, true, 'ensure preserves archive');
    assert.equal((await call(`/api/agents/${bot.id}`, 'PATCH', { hidden: false })).status, 200);
    await refresh();
    await waitFor(`!!document.querySelector('.bots-bot-card[data-agent-id="${bot.id}"]')`);
    await win.loadURL(base);
    await waitFor("!!document.getElementById('view-content')");
    const again = await call('/api/front-desk/ensure', 'POST', {});
    assert.equal(again.body.bot_id, bot.id);
    assert.equal(again.body.main_thread_id, ensured.body.main_thread_id);
    const roster = (await call('/api/agents')).body;
    assert.equal(roster.filter(a => a.id === bot.id).length, 1, 'reload never duplicates the singleton');
    assert.ok(roster.some(a => a.id === extra.body.id), 'the extra bot remains independent');
  } finally {
    try {
      await js(`document.getElementById(${JSON.stringify(anchorId || '')})?.remove()`);
      await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    } finally { await restore(); }
  }
};
