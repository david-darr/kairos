// U1 owns only these three routes. Agent/thread behavior stays in the core lane.
const coreFactory = require('./bots-core-backend.cjs');
const clone = value => JSON.parse(JSON.stringify(value));

// Shared wire schema for U4's card fixture and render tests. Text is plain data.
const str = { type: 'string' };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const arr = (items, maxItems) => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
const action = obj({ kind: { enum: ['open_url', 'open_thread', 'dismiss', 'draft', 'start'] }, label: str, arg: str });
const CARD_DATA_SCHEMA = {
  brief: obj({ date_label: str, greeting: str, sections: arr(obj({ id: { enum: ['needs', 'day', 'mail', 'routines', 'ideas'] },
    label: str, rows: arr(obj({ id: str, text: str, note: str, actions: arr(action) }, ['id', 'text']), 6), more: { type: 'number' } }, ['id', 'label', 'rows']), 5), morning_line: str }, ['date_label', 'greeting', 'sections']),
  prep: obj({ title: str, when_label: str, location: str, lines: arr(str, 60), join_url: str }, ['title', 'when_label', 'lines']),
  reminder: obj({ title: str, when_label: str, location: str, lines: arr(str, 60), join_url: str }, ['title', 'when_label', 'lines']),
  task_link: obj({ task_id: str }),
  suggestion: obj({ suggestion_id: str, title: str, detail: str, source_label: str }),
  route: obj({ bot_id: str, bot_name: str, card_id: str }),
  forge: obj({ project_id: str, project_name: str, task: str }),
  make: obj({ task_id: str, kind: str }),
  chips: obj({ options: { ...arr(str, 4), minItems: 1 } }),
  checkin: obj({ at: { type: 'number' }, summary: str }),
  welcome: obj({ title: str, text: str, lines: arr(str, 3) }, ['title']),
  reach: obj({ title: str, connected: obj({ mail: { type: 'boolean' }, calendar: { type: 'boolean' }, forge_projects: { type: 'number' } }) }),
  watching: obj({ routine_id: str, title: str, lines: arr(str, 4) }, ['routine_id']),
};

// Python's store tests consume this exact JSON too. Keep it valid JSON.
const CARD_SAMPLES = JSON.parse(String.raw`{
  "brief": {"date_label":"Today","greeting":"Hi","sections":[{"id":"needs","label":"Needs you","rows":[{"id":"r","text":"Read mail","note":"One reply","actions":[{"kind":"draft","label":"Draft","arg":"r"}]}],"more":0}]},
  "prep": {"title":"Meet","when_label":"Today","lines":["Read notes"],"join_url":"https://meet.example"},
  "reminder": {"title":"Meet","when_label":"Soon","lines":[]},
  "task_link": {"task_id":"t"},
  "suggestion": {"suggestion_id":"s","title":"Read","detail":"Notes","source_label":"Mail"},
  "route": {"bot_id":"b","bot_name":"Writer","card_id":"c"},
  "forge": {"project_id":"p","project_name":"Project","task":"Fix"},
  "make": {"task_id":"t","kind":"slides"},
  "chips": {"options":["Yes","Later"]},
  "checkin": {"at":1,"summary":"One idea"},
  "welcome": {"title":"Hi","lines":["Ask","Plan","Make"]},
  "reach": {"title":"What I can reach","connected":{"mail":false,"calendar":true,"forge_projects":2}},
  "watching": {"routine_id":"w1","title":"I'm keeping an eye on your day","lines":["Every 15 minutes I check your mail and calendar."]}
}`);

module.exports = context => {
  const { state } = context;
  const core = coreFactory(context);
  const clock = () => typeof context.now === 'number' ? context.now : Date.now() / 1000;
  const lane = () => state.botsFdBot ||= {};
  const connected = () => ({ mail: false, calendar: false, forge_projects: 0, ...(lane().connected || {}) });
  const bot = () => core.store().agents.find(a => a.id === lane().bot_id && a.builtin === 'front_desk');
  const main = () => core.store().threads.find(t => t.agent_id === bot()?.id && t.thread.main)?.id || '';
  const view = () => ({ bot_id: bot()?.id || null, main_thread_id: main(), connected: connected(), needs_input_count: 0 });
  return {
    read(route) {
      if (!state.botsLive) return undefined;
      if (route === '/api/front-desk/state') return clone(view());
      if (route === '/api/front-desk/roster') return core.store().agents.filter(a => !a.hidden).map(a => ({
        id: a.id, name: a.name, role: a.role || '', blurb: a.blurb || '', status: a.status || 'idle' }));
      return undefined;
    },
    mutate(route, method, body = {}) {
      if (!state.botsLive || route !== '/api/front-desk/ensure' || method !== 'POST') return undefined;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        return { _status: 422, detail: 'Use the declared fields' };
      if (!bot()) {
        const names = core.store().agents.map(a => a.name.toLowerCase());
        let name = names.includes('kip') ? 'Kip, front desk' : 'Kip';
        for (let i = 2; names.includes(name.toLowerCase()); i++) name = `Kip, front desk ${i}`;
        const made = core.mutate('/api/agents', 'POST', { name, role: 'Front desk', soul: 'Help with quick answers, tasks and routing.', daily_run_cap: 100 });
        if (made?._status) return made;
        const record = core.store().agents.find(a => a.id === made.id);
        Object.assign(record, { builtin: 'front_desk', order: -1, reply_style: 'conversational' });
        Object.assign(lane(), { seeded_at: lane().seeded_at || clock(), bot_id: record.id });
      }
      if (!main()) {
        const thread = core.mutate(`/api/agents/${bot().id}/threads`, 'POST', { title: bot().name });
        lane().main_thread_id = thread.id;
      }
      return clone({ agent: bot(), bot_id: bot().id, main_thread_id: main() });
    },
  };
};
module.exports.CARD_DATA_SCHEMA = CARD_DATA_SCHEMA;
module.exports.CARD_SAMPLES = CARD_SAMPLES;
