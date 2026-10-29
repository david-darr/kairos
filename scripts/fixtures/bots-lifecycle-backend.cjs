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
      // Problem reports: one per message, like services/bot_report.py; Open folder is only logged.
      if (state.botsLive && method === 'POST' && route === '/api/bot-lifecycle/reports/open-folder') { lane().log.push({ route }); return { ok: true }; }
      if (state.botsLive && method === 'POST' && route === '/api/bot-lifecycle/reports') {
        const s = lane(); s.reports ||= {}; s.log.push({ route, body });
        if (!String(body.went_wrong || '').trim()) return { _status: 400, detail: 'Say what went wrong, in up to 2,000 characters.' };
        const key = `${body.session_id}\n${body.message_id}`;
        if (s.reports[key]) return { ...s.reports[key], already: true };
        const id = String(Object.keys(s.reports).length + 1).padStart(32, '0');
        s.reports[key] = { id, path: `C:\\data\\bot_reports\\${id}.md`, folder: 'C:\\data\\bot_reports', created_at: Date.now() / 1000,
          markdown: `# Kairos problem report\n\n## What went wrong\n\n${body.went_wrong}\n\n## What you saw\n\n${body.you_saw || 'Not given.'}\n` };
        return { ...s.reports[key], already: false };
      }
      if (!state.botsLive || method !== 'POST' || !route.startsWith('/api/bot-lifecycle/packages/')) return undefined;
      const s = lane(); s.log.push({ route, body });
      if (route.endsWith('/inspect')) return s.inspect || { _status: 400, detail: 'This is not a Kairos package' };
      if (route.endsWith('/import')) return s.import || { _status: 409, detail: 'Inspect the package again' };
      return undefined;
    },
  };
};
