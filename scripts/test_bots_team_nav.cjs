const assert = require('node:assert/strict');
(async () => {
  const n = await import('../static/js/botsNavigation.js'), modes = await import('../static/js/appModes.js');
  for (const tab of ['botsRoom', 'botsTeamMap']) assert.equal(modes.modeForTab(tab), 'bots');
  assert.deepEqual(n.normalizeBotsTarget('botsRoom', { room_id: 'r', thread_id: 't', message_id: 'm', agentId: 'ignore' }), { tab: 'botsRoom', roomId: 'r', threadId: 't', messageId: 'm' });
  assert.deepEqual(n.normalizeBotsTarget('botsTeamMap', { department_id: 'd' }), { tab: 'botsTeamMap', departmentId: 'd' });
  for (const id of ['../x', '<x>', 'x/y', '', 1, {}, 'a'.repeat(129)]) {
    assert.deepEqual(n.normalizeBotsTarget('botsRoom', { roomId: id }), { tab: 'botsHome' });
    assert.deepEqual(n.normalizeBotsTarget('botsTeamMap', { departmentId: id }), { tab: 'botsTeamMap' });
  }
  assert.deepEqual(n.normalizeBotsTarget('agents', { team: 'legacy', roomId: 'r' }), { tab: 'swarm', systemId: 'legacy' });
  assert.deepEqual(n.notificationTarget('/?room=r&thread=t&message=m', 'https://app.test'), { tab: 'botsRoom', roomId: 'r', threadId: 't', messageId: 'm' });
  assert.equal(n.notificationTarget('/?room=../bad', 'https://app.test'), null);
  assert.equal(n.notificationTarget('https://evil.test/?room=r', 'https://app.test'), null);
  const host = await import('../static/js/botsTeamHost.js'); const undo = host.stubBotsTeamModule('room', { mount() {} });
  assert.equal(typeof (await host.loadBotsTeamModule('room')).mount, 'function'); undo();
  await assert.rejects(host.loadBotsTeamModule('__proto__'), /Unknown/);
  console.log('PASS: canonical room and team navigation and lazy module seam');
})().catch(e => { console.error(e); process.exitCode = 1; });
