// U4 owns only the Make endpoint. Other Phase 5 lanes remain independent.
const factory = ({ state }) => ({
  read(route, query = {}) {
    if (!state.botsLive || route !== '/api/front-desk/make') return undefined;
    const kind = query.kind || 'all';
    if (!['all', 'design', 'slides', 'website', 'files'].includes(kind)) return { _status: 422, detail: 'Choose a Make kind.' };
    const data = state.botsFdFront || { items: [], making: [] };
    return structuredClone({ items: (data.items || []).filter(item => kind === 'all' || item.kind === kind),
      making: (data.making || []).filter(task => kind === 'all' || task.make_kind === kind) });
  },
  mutate() { return undefined; },
});

// Shared wire examples for U1's fdcards_wire suite and U4's renderer suite.
// These are the Phase 5 section 3 shapes, with no transport or service mocks.
factory.cardSamples = Object.freeze({
  brief: { date_label: 'Thursday', greeting: 'Your brief', sections: [{ id: 'needs', label: 'Needs you', rows: [{ id: 'mail1', text: 'A reply is waiting', note: 'Mail', actions: [{ kind: 'dismiss', label: 'Dismiss', arg: 'mail1' }, { kind: 'draft', label: 'Draft', arg: 'mail1' }] }], more: 0 },
    { id: 'day', label: 'Your day', rows: [{ id: 'meeting1', text: 'A meeting', actions: [{ kind: 'open_url', label: 'Join', arg: 'https://example.com/meeting' }] }], more: 0 }], morning_line: 'Your day is ready.' },
  prep: { title: 'Planning', when_label: 'Today at 2:00 PM', location: 'Office', lines: ['Review the plan.'], join_url: 'https://example.com/meeting' },
  reminder: { title: 'Planning soon', when_label: 'In 10 minutes', location: '', lines: [], join_url: 'https://example.com/meeting' },
  task_link: { task_id: 'own-task' },
  suggestion: { suggestion_id: 'own-suggestion', title: 'Prepare a plan', detail: 'A small next step.', source_label: 'Calendar' },
  route: { bot_id: 'own-peer', bot_name: 'Peer', card_id: 'own-card' },
  forge: { project_id: 'own-project', project_name: 'Project', task: 'Check the tests.' },
  make: { task_id: 'own-task', kind: 'slides' },
  chips: { options: ['Yes', 'Tell me more'] },
  checkin: { at: 1793268000, summary: 'Checked for you' },
  welcome: { title: 'Hi, I am Kip.', text: 'Tell me what you need a hand with.', lines: ['I can help with your day.', 'I can take on a task.', 'I can pass work to another bot.'] },
  reach: { connected: { mail: true, calendar: true, forge_projects: 1 } },
});
module.exports = factory;
