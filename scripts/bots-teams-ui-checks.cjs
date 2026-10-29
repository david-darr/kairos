// Bots redesign, Phase 4 unit U5 (2026-10-29): the team map. Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-teams-ui-only
// The teams lane (scripts/fixtures/bots-chief-backend.cjs) builds /api/bot-team/map from the core lane's bots: a team per
// `section`, handoff edges from the delegation lane. The check makes its own bots and teams and deletes them after.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const delegation = { reach: {}, assignments: [], writes: [] };
  const restore = await isolateBotsCheck({ js, demoState }, { botsDelegation: delegation });
  const stamp = Date.now().toString(36), research = `Research ${stamp}`, ops = `Ops ${stamp}`;
  const made = [];
  const originalSize = win.getContentSize();
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    for (const [name, section] of [[`Reader ${stamp}`, research], [`Writer ${stamp}`, research], [`Runner ${stamp}`, ops]]) {
      assert.equal((await call('/api/agents', 'POST', { name })).status, 200, 'the check makes its own bot');
      const bot = (await call('/api/agents', 'GET')).body.find(a => a.name === name);
      assert.equal((await call(`/api/agents/${bot.id}`, 'PATCH', { section })).status, 200, 'and puts it in a team');
      made.push(bot);
    }
    const [reader, writer, runner] = made;

    // The map draws a tile per team with its bots; bots without a team sit under Other bots.
    await navigate('botsTeamMap');
    const tile = name => `[...document.querySelectorAll('.bots-team-tile')].find(t => t.textContent.includes(${JSON.stringify(name)}))`;
    await waitFor(`!!${tile(research)} && !!${tile(ops)}`);
    assert.equal(await js(`${tile(research)}.querySelectorAll('.bots-team-bot').length`), 2, 'both research bots are in its tile');
    assert.equal(await js(`${tile(ops)}.querySelectorAll('.bots-team-bot').length`), 1);
    assert.ok(await js(`${tile(research)}.textContent.includes(${JSON.stringify(reader.name)}) && ${tile(research)}.textContent.includes(${JSON.stringify(writer.name)})`));
    await capture?.('desktop-bots-team-map');

    // Tagging a team and sending reaches each of its bots once, through the bot's own conversation.
    const teamTag = '@' + research.toLowerCase().replace(/\s+/g, '-');
    await js(`[...document.querySelectorAll('.bots-team-tag')].find(b => b.textContent === ${JSON.stringify(teamTag)}).click()`);
    assert.equal(await js(`[...document.querySelectorAll('.bots-team-tag')].find(b => b.textContent === ${JSON.stringify(teamTag)}).getAttribute('aria-pressed')`), 'true');
    await js("(() => { const t = document.querySelector('.bots-team-composer textarea'); t.value = 'Plan the week'; t.dispatchEvent(new Event('input', { bubbles: true })); })()");
    const start = writes.length;
    await js("document.querySelector('.bots-team-composer').requestSubmit()");
    await waitFor("document.querySelector('.bots-team-receipts').textContent.includes('Sent to')");
    const sends = writes.slice(start).filter(w => w.method === 'POST' && /^\/api\/bot-chat\/[^/]+\/send$/.test(w.path));
    assert.equal(sends.length, 2, 'one send per tagged bot');
    assert.ok(sends.every(w => JSON.parse(w.body).text === 'Plan the week' && typeof JSON.parse(w.body).send_id === 'string'));
    assert.match(await js("document.querySelector('.bots-team-receipts').textContent"), new RegExp(`Sent to ${reader.name}.*Sent to ${writer.name}|Sent to ${writer.name}.*Sent to ${reader.name}`));
    assert.equal(await js("document.querySelector('.bots-team-composer textarea').value"), '', 'the message clears once everyone got it');
    assert.ok(!sends.some(w => w.path.includes(runner.id)), 'a bot outside the team gets nothing');

    // A live handoff between two of the bots shows in the Handoffs list.
    delegation.assignments.push({ id: `edge-${stamp}`, requester: { bot_id: reader.id }, assignee_bot_id: runner.id, reason: 'Check the numbers', status: 'running' });
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
    await waitFor("document.querySelector('.bots-team-edges summary')?.textContent === 'Handoffs 1'");
    assert.equal(await js("document.querySelector('.bots-team-edge').textContent"), `${reader.name} → ${runner.name}: Check the numbers`);

    // Phone width: no sideways scroll.
    win.setContentSize(390, 844); await delay(500);
    assert.ok(await js("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'the map does not scroll sideways on a phone');
    await capture?.('phone-bots-team-map');
  } finally {
    try {
      win.setContentSize(originalSize[0], originalSize[1]);
      for (const bot of made) await call(`/api/agents/${bot.id}`, 'DELETE');
    } finally { await restore(); }
  }
};
