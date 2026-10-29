// Fixture lane for the front desk's Tasks and Up next (Bots Phase 5, units U2 and U3). It answers only while a check
// has seeded state.botsFdWork, in the real shapes (routes/front_desk_work_routes.py, front_desk_watch_routes.py):
//   tasks: [{id, title, state, next_step, turn_count, updated_at, resolved_at}], up_next: [{id, title, detail, origin,
//   source, created_at}], watch: {state, last_check_at, last_result}, runNowFinds: suggestion to add on "Show me".
// Every action is logged in state.botsFdWork.log.
module.exports = ({ state }) => {
  const lane = () => state.botsFdWork;
  const ID = /^\/api\/front-desk\/(tasks|suggestions)\/([^/]+)\/(resolve|reopen|again|start|hide)$/;
  function work() {
    const s = lane(), groups = { ready_for_review: [], needs_input: [], failed: [], working: [], resolved: [] };
    for (const task of s.tasks) (groups[task.state] || groups.working).push({ ...task });
    return { groups, up_next: s.up_next.map(x => ({ ...x })), coming_up: s.coming_up || [], loose: { questions: [], approvals: [] },
      updated_at: Date.now() / 1000, needs_input_count: groups.needs_input.length };
  }
  return {
    read(route) {
      if (!state.botsLive || !lane()) return undefined;
      if (route === '/api/front-desk/work') return work();
      if (route === '/api/front-desk/watch') return { ...lane().watch };
      return undefined;
    },
    mutate(route, method, body = {}) {
      if (!state.botsLive || !lane() || method !== 'POST') return undefined;
      const s = lane();
      if (route === '/api/front-desk/watch/run-now') {
        s.log.push({ action: 'run-now' });
        s.watch = { ...s.watch, state: 'idle', last_check_at: Date.now() / 1000, last_result: 'ok' };
        if (s.runNowFinds) s.up_next.push(s.runNowFinds);
        return { ok: true };
      }
      const m = route.match(ID);
      if (!m) return undefined;
      const [, kind, id, action] = m;
      s.log.push({ kind, id, action, body });
      if (kind === 'tasks') {
        const task = s.tasks.find(t => t.id === id);
        if (!task) return { _status: 404, detail: 'Task not found' };
        if (action === 'resolve') Object.assign(task, { state: 'resolved', resolved_at: Date.now() / 1000 });
        if (action === 'reopen') Object.assign(task, { state: 'working', resolved_at: null });
        if (action === 'again') {
          if (body.turn_count !== task.turn_count) return { _status: 409, detail: 'This task changed. Try again.' };
          Object.assign(task, { state: 'working', next_step: 'Trying again', turn_count: task.turn_count + 1 });
        }
        return { task };
      }
      const at = s.up_next.findIndex(x => x.id === id);
      if (at < 0) return { _status: 404, detail: 'Suggestion not found' };
      const [item] = s.up_next.splice(at, 1);
      if (action === 'start') s.tasks.push({ id: `task-${id}`, title: item.title, state: 'working', next_step: 'Just started', turn_count: 0, updated_at: Date.now() / 1000 });
      return { ok: true };
    },
  };
};
