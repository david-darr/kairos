// The retired Agents ecosystem (Bots Phase 1, unit U4). The village screen is gone: what stays true is that the old
// entry points still arrive somewhere useful and that Swarm teams remain reachable. Run: --agents-ecosystem-only.
//   - every old Agents link, with or without a bot, lands in Bots (roster or that bot)
//   - a team link opens the existing Swarm view and never writes
//   - the old village tab and its controls no longer exist
//   - opening any of these starts no work and sends nothing
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, capture, writes, demoState }) => {
  const restore = await isolateBotsCheck({ js, demoState });
  const mark = writes.length;
  try {
    demoState.botsLive = true;
    const agents = (await js("fetch('/api/agents').then(r => r.json())")).filter(a => !a.hidden);
    assert.ok(agents.length, 'the demo has a bot to open');
    const bot = agents[0].id;
    await navigate('home');

    await navigate('agents');
    await waitFor("document.getElementById('view-content').dataset.view === 'botsHome' && document.documentElement.dataset.appMode === 'bots'");
    await navigate('agents', { agentId: bot });
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(bot)}`);
    await navigate('agents', { agentTab: 'ecosystem' });
    await waitFor("document.getElementById('view-content').dataset.view === 'botsHome'");
    assert.equal(await js("document.querySelectorAll('.agent-ecosystem, .ecosystem-viewport, #agents-ecosystem-tab').length"), 0, 'no village on the page');
    await capture?.('desktop-agents-ecosystem-retired');

    await navigate('agents', { team: 's1' });
    await waitFor("document.getElementById('view-content').dataset.view === 'swarm' && !!document.querySelector('.swarm-view')");
    assert.equal(await js('document.documentElement.dataset.appMode'), 'kairos', 'Swarm stays a Kairos view');
    await waitFor("!!document.querySelector('.swarm-composer')", 8000);
    await delay(200);
    assert.equal(writes.slice(mark).filter(w => (w.path.includes('/agents/') && !w.path.includes('/agents/conversations/')) || w.path.includes('/swarm/')).length, 0,
      'following the links starts no work and sends nothing');
    await navigate('home');
  } finally {
    await restore();
  }
};
