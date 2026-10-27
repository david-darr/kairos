// A07 (Part 2, group g3): run with `ui-smoke.cjs --g3-only`.
// 1. Runs the two Agents modules that otherwise live only in the default run
//    (phone 44px/overflow audit, appearance contrast on every bot surface).
// 2. Benchmarks the village: mount time, frame time while agents walk, and
//    idle request count on the Agents tab. Numbers go to result.json and stdout.
const assert = require('node:assert/strict');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, reads, demoState, inbox }) => {
  const bench = {};
  let t = Date.now();
  await require('./agents-phone-checks.cjs')({ js, waitFor, delay, navigate, win });
  bench.phoneAuditMs = Date.now() - t;
  t = Date.now();
  await require('./agents-appearance-checks.cjs')({ js, waitFor, navigate, capture, win });
  bench.appearanceMs = Date.now() - t;
  win.setContentSize(1440, 900);
  await delay(200);

  // A notification click opens the right agent's thread (app.js botInboxWatcher -> jarvis:navigate).
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
    assert.equal(await js("document.querySelector('.agents-messenger')?.dataset.agentId || null"), null, 'the thread is not open before the click');
    await js("window.g3Notes[0].onclick()");
    await waitFor("document.querySelector('.agents-messenger')?.dataset.agentId === 'a2'");
    assert.equal(await js("window.g3Notes[0].closed"), true, 'the notification closes on click');
    // The same item polled again does not notify twice.
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))"); await delay(400);
    assert.equal(await js("window.g3Notes.length"), 1, 'an already-seen item is not announced again');
  } finally {
    inbox.splice(inbox.indexOf(item), 1);
    await js("window.Notification = window.g3RealNotification; void 0");
  }

  // Village frame time: N agents all on a task (so every one commutes), measured with requestAnimationFrame.
  await navigate('agents');
  await waitFor("!!document.querySelector('#agents-ecosystem-tab')");
  for (const count of [24, 100]) {
    const result = await js(`import('/static/js/agentEcosystem.js').then(async ({mountAgentEcosystem}) => {
      const host = document.createElement('section'); host.className = 'agent-ecosystem';
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff';
      document.body.append(host);
      const map = mountAgentEcosystem(host, () => {}, () => {}); map.reveal();
      const places = ['CS homework quiz', 'Debug Python code', 'Deploy database server', 'Read research papers', 'Design a video', 'Review email inbox'];
      const agents = Array.from({length: ${count}}, (_, i) => ({id: 'bench-' + i, name: 'Agent ' + i, role: 'Software developer',
        status: 'working', enabled: true, status_detail: places[i % places.length]}));
      const frames = async ms => { const d = []; let l = performance.now(); const e = l + ms;
        await new Promise(resolve => { const tick = now => { d.push(now - l); l = now; now < e ? requestAnimationFrame(tick) : resolve(); }; requestAnimationFrame(tick); }); d.shift(); return d; };
      const baseline = await frames(1000);  // the window's own rAF rate with nothing mounted work-wise
      const teams = Array.from({length: Math.ceil(${count} / 8)}, (_, i) => ({id: 'bt-' + i, name: 'Team ' + i, state: 'active'}));
      map.update({agents: agents.map(a => ({...a, status: 'idle'})), teams});
      await new Promise(r => setTimeout(r, 300));
      const started = performance.now();
      map.update({agents, teams});
      const mount = performance.now() - started;
      await new Promise(r => setTimeout(r, 500));
      const deltas = await frames(3000);
      const sorted = [...deltas].sort((a, b) => a - b);
      const walking = host.querySelectorAll('[data-motion=walking]').length;
      const characters = host.querySelectorAll('.ecosystem-character').length;
      map.destroy(); host.remove();
      return {baselineMeanMs: baseline.reduce((a, b) => a + b, 0) / baseline.length, mountMs: mount, frames: deltas.length, meanMs: deltas.reduce((a, b) => a + b, 0) / deltas.length,
        p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted[sorted.length - 1],
        over50: deltas.filter(d => d > 50).length, walking, characters};
    })`);
    assert.equal(result.characters, count, `${count} characters render`);
    assert.ok(result.walking > 0, `${count} agents: some are actually walking (${result.walking})`);
    assert.ok(result.frames > 20, `${count} agents: animation frames are produced (${result.frames})`);
    bench['village' + count] = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  }

  // Idle: nothing working, village open, 6 seconds. Count API reads (a poll that spins burns CPU and tokens downstream).
  await navigate('agents');
  await js("document.querySelector('#agents-ecosystem-tab')?.click()");
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
