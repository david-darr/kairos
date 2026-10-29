const assert = require('node:assert/strict');
(async () => {
  const m = await import('../static/js/botsTeamMapModel.js');
  assert.deepEqual(m.CARD, { width: 236, height: 126, gap: 16, padding: 20, header: 64, maxColumns: 6 });
  for (let count = 0; count < 101; count++) { const cols = m.bestColumns(count, 2000); assert.ok(cols >= 1 && cols <= 6); const size = m.teamSize(count, cols); assert.ok(size.width > 0 && size.height > 0); }
  assert.equal(m.bestColumns(100, 300), 1);
  assert.equal(m.clampPosition(Infinity), 0); assert.equal(m.clampPosition(-1e8), -99999);
  assert.equal(m.clampScale(0), .3); assert.equal(m.clampScale(100), 1.5);
  const view = { x: -300, y: 40, scale: .8 }, p = { x: 100, y: 120 }, zoom = m.zoomAt(view, p, 1.3);
  assert.ok(Math.abs((p.x - view.x) / view.scale - (p.x - zoom.x) / zoom.scale) < .000001);
  assert.ok(Math.abs((p.y - view.y) / view.scale - (p.y - zoom.y) / zoom.scale) < .000001);
  const tiles = [{ id: 'a', x: -30, y: 20, width: 300, height: 200 }, { id: 'b', x: 400, y: 30, width: 300, height: 200 }];
  const fit = m.fitToView(tiles, { width: 900, height: 500 }); assert.ok(fit.scale >= .3 && fit.scale <= 1);
  for (const t of tiles) { assert.ok(t.x * fit.scale + fit.x >= 31.9); assert.ok((t.x + t.width) * fit.scale + fit.x <= 868.1); }
  assert.equal(m.gesture({ x: 0, y: 0 }, { x: 3, y: 3 }, 'bot'), 'click'); assert.equal(m.gesture({ x: 0, y: 0 }, { x: 3, y: 4 }, 'team'), 'team');
  assert.equal(m.dropTarget({ x: 410, y: 35 }, tiles, 'a').id, 'b'); assert.equal(m.dropTarget({ x: 410, y: 35 }, tiles, 'b'), null);
  const data = m.mapData({ departments: [{ id: 'team', name: 'Design', chief_bot_id: 'bot', members: [{ id: 'bot', name: 'Bee' }] }], bots: [{ id: 'loose', name: 'Loose' }, { id: 'hidden', hidden: true }] });
  assert.equal(data.departments[0].members[0].chief, true); assert.equal(data.bots.length, 2);
  assert.deepEqual(m.taggedBots('@Design @Bee', [], data).map(b => b.id), ['bot']); assert.equal(m.taggedBots('@everyone', ['bot'], data).length, 2);
  const layout = m.readLayout(JSON.parse('{"x":1e30,"teams":{"__proto__":{"x":9},"a":{"x":-1e30,"y":4}}}'));
  assert.equal(layout.x, 99999); assert.equal(layout.teams.a.x, -99999); assert.equal({}.x, undefined);
  const sidebar = await import('../static/js/botsSidebarModel.js'); const prefs = sidebar.teamSidebarPreferences({ sections: ['bots', 'channels'], closedTeams: ['a'], teamOrder: ['b', 'a'] });
  assert.deepEqual(prefs.sections, ['bots', 'channels', 'pinned', 'attention']); assert.deepEqual(prefs.closedTeams, ['a']);
  assert.equal(sidebar.roomRow({ id: 'r', working: true, unread_count: 2 }).unread, 2);
  console.log('PASS: team map geometry, gestures, tags, normalization and sidebar preferences');
})().catch(e => { console.error(e); process.exitCode = 1; });
