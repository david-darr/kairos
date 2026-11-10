// A07 (Part 2, group g3): run with `ui-smoke.cjs --g3-only`.
// 1. Runs the two Agents modules that otherwise live only in the default run
//    (phone 44px/overflow audit, appearance contrast on every bot surface).
// 2. A bot notification click opens that bot, and the idle request count on the
//    Agents entry (the Bots home). Numbers go to result.json and stdout.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, reads, demoState, base, inbox }) => {
  const bench = {};
  let t = Date.now();
  // 2026-11-10: both modules isolate the Bots fixture store and reload the page, so they need demoState and base.
  await require('./agents-phone-checks.cjs')({ js, waitFor, delay, navigate, win, demoState, base });
  bench.phoneAuditMs = Date.now() - t;
  t = Date.now();
  await require('./agents-appearance-checks.cjs')({ js, waitFor, navigate, capture, win, demoState, base, delay });
  bench.appearanceMs = Date.now() - t;
  win.setContentSize(1440, 900);
  await delay(200);

  // A notification click opens the right bot (app.js botInboxWatcher -> jarvis:navigate). The Bots shell it opens
  // reads the live Bots fixtures, so this part runs isolated like every Bots check (bots-check-support.cjs).
  const restoreBots = await isolateBotsCheck({ js, demoState });
  await win.loadURL(base);
  await waitFor("!!document.querySelector('.dashboard-core')");
  await navigate('home');
  await js(`window.g3Notes = []; window.g3RealNotification = window.Notification;
    window.Notification = class { constructor(title, o) { this.title = title; this.o = o; this.closed = false; window.g3Notes.push(this); } close() { this.closed = true; } };
    window.Notification.permission = 'granted'; window.Notification.requestPermission = async () => 'granted'; void 0`);
  const item = { id: 'g3-new', agent_id: 'a2', kind: 'question', status: 'open', created_at: Date.now() / 1000, title: 'Which folder should I use?', body: 'Pick one.' };
  inbox.push(item);
  try {
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
    await waitFor("window.g3Notes.length === 1");
    assert.equal(await js("window.g3Notes[0].title"), 'Archivist needs you');
    assert.equal(await js("window.g3Notes[0].o.tag"), 'kairos-bot-a2');
    // Since the Bots migration a click opens the bot in the Bots shell (app.js: jarvis:navigate to botsShell).
    assert.equal(await js("document.querySelector('.bots-shell')?.dataset.agentId || null"), null, 'the bot is not open before the click');
    await js("window.g3Notes[0].onclick()");
    await waitFor("document.documentElement.dataset.view === 'botsShell' && document.querySelector('.bots-shell')?.dataset.agentId === 'a2'");
    assert.equal(await js("window.g3Notes[0].closed"), true, 'the notification closes on click');
    // The same item polled again does not notify twice.
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))"); await delay(400);
    assert.equal(await js("window.g3Notes.length"), 1, 'an already-seen item is not announced again');
  } finally {
    inbox.splice(inbox.indexOf(item), 1);
    await js("window.Notification = window.g3RealNotification; void 0");
    await restoreBots();
  }

  // The village frame-time benchmark is retired (2026-11-10): Bots Phase 1 (unit U4) removed the village screen.
  // agentEcosystem.js is loaded only by agentsMessenger.js, which nothing imports, and agents-ecosystem-checks.cjs
  // proves no village appears. Benchmarking it measured code no user can reach.

  // Idle: nothing working, the Agents entry open (now the Bots home), 6 seconds. Count API reads (a poll that
  // spins burns CPU and tokens downstream).
  await navigate('agents');
  await waitFor("document.getElementById('view-content').dataset.view === 'botsHome'");
  await delay(1000);
  const before = reads.length;
  await delay(6000);
  const idle = reads.slice(before).filter(r => r.path.startsWith('/api/'));
  bench.idleApiReadsPer6s = idle.length;
  bench.idleReadPaths = [...new Set(idle.map(r => r.path))];
  assert.ok(idle.length <= 12, `Idle Agents tab makes ${idle.length} API reads in 6s: ${bench.idleReadPaths.join(', ')}`);
  console.log('G3 BENCH ' + JSON.stringify(bench));
  return bench;
};
