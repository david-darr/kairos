// Shared, DOM-free labels and reach comparisons.
const STATES = { queued: 'Queued', ready: 'Queued', running: 'Working', working: 'Working', waiting: 'Waiting',
  resume: 'Resuming', needs_input: 'Waiting for you', needs_you: 'Waiting for you', completed: 'Done', done: 'Done',
  failed: 'Failed', cancelled: 'Stopped' };
export function handoffModel(row = {}) {
  const state = row.handoff_status || row.status || 'queued';
  const mode = row.mode || 'work';
  const partner = row.partner || { id: row.agent_id, name: row.agent_name || 'Bot', avatar: row.agent_avatar };
  return { state, label: STATES[state] || 'Queued', verb: ({ work: 'Delegated', consult: 'Asked', notify: 'Notified' })[mode] || 'Delegated',
    partner, failed: ['failed', 'cancelled'].includes(state), preview: String(row.result || row.preview || ''),
    doneWhen: String(row.done_when || ''), question: row.question || '',
    target: row.room_id ? { tab: 'botsRoom', roomId: row.room_id, threadId: row.thread_id } :
      { tab: 'botsShell', agentId: partner.id, sessionId: row.work_session_id } };
}
export function reachValue(mode, peers = []) { return mode === 'all' ? null : mode === 'none' ? [] : [...new Set(peers)]; }
export function widensReach(before, after) {
  if (before === null) return false;
  return after === null || after.some(id => !(before || []).includes(id));
}
export function edgeLabel(edge, names = {}) {
  return `${names[edge.source] || edge.source || 'You'} to ${names[edge.target] || edge.target || 'Bot'}: ${STATES[edge.status] || 'Queued'}${edge.reason ? `, ${edge.reason}` : ''}`;
}
export function repeatLabel(row) { return `Same call repeated ${Number(row.count) || 0} times, it may be stuck`; }
