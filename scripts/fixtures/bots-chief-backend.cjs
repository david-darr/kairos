// Fixture lane for teams (Bots Phase 4, unit U4): the team map, departments, incidents, Chief changes and the
// first-run setup card, in the real server's shapes (routes/bot_team_routes.py, routes/bot_department_routes.py).
// While demoState.botsLive is set it answers for the bots the core lane knows: a department for each distinct
// `section`, rooms from the rooms lane (state.botsRooms) and live handoff edges from the delegation lane
// (state.botsDelegation). A check seeds state.botsChief to add chiefs, incidents, changes or an eligible setup
// card ({setup: {<bot_id>: {eligible: true, choices: [...]}}}); picks and closes are logged in state.botsChief.log.
module.exports = ({ state }) => {
  const lane = () => (state.botsChief ||= { chiefs: {}, incidents: [], changes: [], setup: {}, log: [] });
  const agents = () => (state.botsCore?.agents || []).filter(a => !a.hidden);
  const slug = name => 'team-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const departments = () => {
    const names = [...new Set(agents().map(a => (a.section || '').trim()).filter(Boolean))];
    return names.map((name, order) => ({ id: slug(name), name, order, chief_bot_id: lane().chiefs[slug(name)] || null,
      also_manages: [], created_at: 1, revision: 1 }));
  };
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  function map() {
    const teams = departments(), byName = Object.fromEntries(teams.map(t => [t.name, t]));
    const bots = agents().map(a => {
      const team = byName[(a.section || '').trim()];
      return { id: a.id, name: a.name, role: a.role || '', section: a.section || '', avatar: a.avatar, endpoint_id: a.endpoint_id,
        model_override: a.model_override, model_effort: a.model_effort, department_id: team ? team.id : null,
        chief: !!team && team.chief_bot_id === a.id, status: 'available' };
    });
    const names = Object.fromEntries(bots.map(b => [b.id, b.name]));
    const handoffs = (state.botsDelegation?.assignments || []).filter(n => !terminal.has(n.status))
      .map(n => ({ assignment_id: n.id, source: n.requester?.bot_id, target: n.assignee_bot_id, reason: n.reason || '', status: n.status,
        room_id: n.requester?.room_id || null }))
      .filter(e => names[e.source] && names[e.target])
      .map(e => ({ ...e, source_bot_id: e.source, target_bot_id: e.target, source_name: names[e.source], target_name: names[e.target] })).slice(0, 12);
    const rooms = Object.values(state.botsRooms?.rooms || {}).filter(r => !r.archived_at);
    return { departments: teams, members: bots, bots, rooms, handoffs };
  }

  function read(route) {
    let m;
    if (route === '/api/bot-team/map') return map();
    if (route === '/api/bot-departments') return { departments: departments() };
    if (route === '/api/bot-team/incidents') return { incidents: lane().incidents };
    if (route === '/api/bot-team/changes') return { changes: lane().changes };
    if ((m = route.match(/^\/api\/bot-setup\/([^/]+)\/request$/))) {
      const row = lane().setup[m[1]];
      return row ? { state: row.state || 'none', ...row, eligible: row.state !== 'sent' && row.state !== 'closed' && !!row.eligible } : { state: 'none', eligible: false };
    }
    if ((m = route.match(/^\/api\/bot-setup\/([^/]+)\/suggestions$/))) {
      const row = lane().setup[m[1]];
      return { eligible: !!row?.eligible, choices: row?.choices || [], pending: false };
    }
    return undefined;
  }

  function mutate(route, method, body = {}) {
    const m = route.match(/^\/api\/bot-setup\/([^/]+)\/request$/);
    if (!m) return undefined;
    const row = (lane().setup[m[1]] ||= { eligible: false });
    if (method === 'POST') {
      if (!row.eligible || row.state === 'sent' || row.state === 'closed') return { _status: 409, detail: 'This bot is already set up' };
      Object.assign(row, { state: body.text ? 'sent' : 'armed', text: body.text ?? null, thread_id: body.thread_id });
    } else if (method === 'DELETE') row.state = 'closed';
    else return undefined;
    lane().log.push({ bot_id: m[1], method, body });
    return method === 'DELETE' ? { ok: true } : { ...row };
  }

  const ours = route => /^\/api\/(bot-team\/|bot-departments$|bot-setup\/)/.test(route);
  return {
    read(route) { return state.botsLive && ours(route) ? read(route) : undefined; },
    mutate(route, method, body = {}) { return state.botsLive && ours(route) ? mutate(route, method, body || {}) : undefined; },
  };
};
