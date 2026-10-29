// Fixture lane for the delegation check (Bots Phase 4, unit U1). While demoState.botsLive is set it answers
// /api/bot-peers/<id>/reach and /roster for the bots a check seeds in state.botsDelegation.reach, and
// /api/bot-assignments from state.botsDelegation.assignments. Anything else returns undefined so the other
// lanes keep their routes. The reach PUT follows the server: widening needs acknowledge_scope, a stale
// revision is 409.
module.exports = ({ state }) => {
  class Refusal extends Error { constructor(status, message) { super(message); this.status = status; } }
  const lane = () => state.botsDelegation;
  const reachOf = id => lane()?.reach?.[id];
  const peersOf = r => r.mode === 'all' ? null : r.mode === 'none' ? [] : [...r.peers];
  const widens = (before, after) => before !== null && (after === null || after.some(id => !before.includes(id)));

  function read(route, query = {}) {
    let m;
    if ((m = route.match(/^\/api\/bot-peers\/([^/]+)\/reach$/))) {
      const r = reachOf(m[1]);
      return r ? { bot_id: m[1], mode: r.mode, peers: [...r.peers], revision: r.revision, approve_peer_comms: r.approve_peer_comms !== false } : undefined;
    }
    if ((m = route.match(/^\/api\/bot-peers\/([^/]+)\/roster$/))) return reachOf(m[1]) ? (lane().roster || []) : undefined;
    if (route === '/api/bot-assignments' && lane()?.assignments) {
      return lane().assignments.filter(a => (!query.bot_id || a.assignee_bot_id === query.bot_id || a.requester?.bot_id === query.bot_id)
        && (!query.status || a.status === query.status));
    }
    return undefined;
  }

  function mutate(route, method, body = {}) {
    const m = route.match(/^\/api\/bot-peers\/([^/]+)\/reach$/);
    const r = m && reachOf(m[1]);
    if (!r || method !== 'PUT') return undefined;
    if (body.expected_revision !== undefined && body.expected_revision !== r.revision) throw new Refusal(409, 'This bot changed. Reload and try again.');
    if (!['all', 'listed', 'none'].includes(body.mode)) throw new Refusal(400, 'Choose all, listed or none.');
    const proposed = body.mode === 'all' ? null : body.mode === 'none' ? [] : [...(body.peers || [])];
    if (widens(peersOf(r), proposed) && !body.acknowledge_scope) throw new Refusal(400, 'Confirm the wider reach before saving.');
    Object.assign(r, { mode: body.mode, peers: proposed || [], revision: r.revision + 1 });
    if (typeof body.approve_peer_comms === 'boolean') r.approve_peer_comms = body.approve_peer_comms;
    (lane().writes ||= []).push({ bot_id: m[1], ...body });
    return read(route);
  }

  return {
    read(route, query = {}) {
      if (!state.botsLive || !lane()) return undefined;
      try { return read(route, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
    mutate(route, method, body = {}) {
      if (!state.botsLive || !lane()) return undefined;
      try { return mutate(route, method, body || {}); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
  };
};
