// Bots redesign, Phase 4 unit U4 (2026-10-29): a Chief's team setup proposal as it shows in a bot conversation, drawn by
// the conversation's own row renderers (botsRowKinds.js), and the first-run setup card. Run:
// node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-chief-only
// The teams lane (scripts/fixtures/bots-chief-backend.cjs) answers /api/bot-team/changes/* and /api/bot-setup/* from
// demoState.botsChief; actions are logged in its log.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, win, capture, demoState, base }) => {
  const proposal = { id: 'receipt-1', kind: 'team_setup', state: 'proposed', reason: 'Split research from writing.',
    ops: [{ op: 'update', bot_id: 'b-reader', name: 'Reader', before: { section: 'General', role: 'Helper' }, after: { section: 'Research', role: 'Finds sources' } },
      { op: 'create', name: 'Quill', after: { name: 'Quill', section: 'Research', soul: 'Write short briefs.' } }] };
  const chief = { chiefs: {}, incidents: [], changes: [{ ...proposal }], setup: { 'setup-bot': { eligible: true, choices: ['Research a topic', 'Plan errands'] } }, log: [] };
  const restore = await isolateBotsCheck({ js, demoState }, { botsChief: chief });
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { const box = document.createElement('div'); box.id = 'chief-host'; box.dataset.appMode = 'bots';
      box.style.cssText = 'position:fixed;inset:0 auto auto 0;width:420px;height:100vh;overflow:auto;z-index:9999;background:var(--bots-app, #fff)';
      box.innerHTML = '<div id="chief-row"></div><div id="chief-setup"></div>'; document.body.append(box); })()`);

    // The proposal arrives as a "card" message of type team_setup and draws as the setup card, not a work report.
    await js(`import('/static/js/botsRowKinds.js').then(m => {
      const renderers = m.botRowRenderers({ agentId: 'chief-bot', sessionId: 'chief-thread', botName: 'Chief' });
      const message = { id: 'msg-setup', kind: 'card', card_type: 'team_setup', card: ${JSON.stringify(proposal)} };
      document.getElementById('chief-row').append(renderers.card({ message, rich: true }, {})); return true; })`);
    const card = "document.querySelector('#chief-row .bots-team-card[data-card-kind=team_setup]')";
    await waitFor(`!!${card}`);
    const shown = await js(`${card}.textContent`);
    assert.match(shown, /Split research from writing\./, 'the reason');
    assert.match(shown, /update: Reader/);
    assert.match(shown, /Team: General → Research/, 'a team move reads as Team');
    assert.match(shown, /role: Helper → Finds sources/);
    assert.match(shown, /create: Quill/);
    assert.deepEqual(await js(`[...${card}.querySelectorAll('button')].map(b => b.textContent)`), ['Apply setup', 'Cancel']);
    await capture?.('desktop-bots-chief-setup-card');

    // Apply, then Undo; a second Undo after the bots changed is refused and says so.
    await js(`[...${card}.querySelectorAll('button')].find(b => b.textContent === 'Apply setup').click()`);
    await waitFor(`${card}.textContent.includes('applied') && [...${card}.querySelectorAll('button')].map(b => b.textContent).join() === 'Undo'`);
    assert.deepEqual(chief.log.at(-1), { change: 'receipt-1', action: 'apply' });
    chief.changes[0].undoStale = true;
    await js(`[...${card}.querySelectorAll('button')].find(b => b.textContent === 'Undo').click()`);
    await waitFor(`${card}.textContent.includes('This setup changed. Reload it before trying again.')`);
    assert.equal(chief.changes[0].state, 'applied', 'a refused Undo changes nothing');

    // The setup card shows for an eligible new bot, offers its choices, and a pick is sent once.
    await js(`import('/static/js/botsSetupCard.js').then(m => { window.__setupPicks = [];
      window.__setup = m.mountSetupCard(document.getElementById('chief-setup'), { agentId: 'setup-bot', threadId: 'setup-thread',
        onPick: (text, info) => { window.__setupPicks.push([text, !!info?.other]); } }); return true; })`);
    await waitFor("!document.querySelector('#chief-setup .bots-team-card[data-card-kind=setup]')?.hidden && document.getElementById('chief-setup').textContent.includes('Research a topic')");
    await js("[...document.querySelectorAll('#chief-setup button')].find(b => b.textContent.includes('Research a topic')).click()");
    await waitFor("window.__setupPicks.length === 1");
    assert.deepEqual(await js('window.__setupPicks'), [['/setup Research a topic', false]]);
    assert.equal(chief.setup['setup-bot'].state, 'sent');
    assert.equal(await js("document.querySelector('#chief-setup .bots-team-card[data-card-kind=setup]').hidden"), true, 'the card goes away after a pick');
  } finally {
    try { await js("(() => { window.__setup?.destroy?.(); delete window.__setup; delete window.__setupPicks; document.getElementById('chief-host')?.remove(); })()"); }
    finally { await restore(); }
  }
};
