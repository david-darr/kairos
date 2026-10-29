// Fixture lane for templates and packages (Bots Phase 6, unit U4). While demoState.botsLive is set it answers
// GET /api/bot-lifecycle/templates from the app's own files (static/data/bots-teams.json and bots-ready.json), as
// routes/bot_lifecycle_routes.py does. A check seeds state.botsLifecycle.inspect ({token, preview}) to answer
// POST /api/bot-lifecycle/packages/inspect and .import ({created, warnings}) for the import; uploads are logged.
const fs = require('node:fs');
const path = require('node:path');

module.exports = ({ state }) => {
  const data = path.join(__dirname, '..', '..', 'static', 'data');
  const file = name => JSON.parse(fs.readFileSync(path.join(data, name), 'utf8'));
  const lane = () => (state.botsLifecycle ||= { inspect: null, import: null, log: [] });
  return {
    read(route) {
      if (!state.botsLive || route !== '/api/bot-lifecycle/templates') return undefined;
      return { teams: file('bots-teams.json'), ready: file('bots-ready.json') };
    },
    mutate(route, method, body = {}) {
      if (!state.botsLive || method !== 'POST' || !route.startsWith('/api/bot-lifecycle/packages/')) return undefined;
      const s = lane(); s.log.push({ route, body });
      if (route.endsWith('/inspect')) return s.inspect || { _status: 400, detail: 'This is not a Kairos package' };
      if (route.endsWith('/import')) return s.import || { _status: 409, detail: 'Inspect the package again' };
      return undefined;
    },
  };
};
