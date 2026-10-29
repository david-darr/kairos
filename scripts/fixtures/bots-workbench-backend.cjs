// Isolated workbench fixture. Only workbench/computer routes are answered.
const MESSAGES = { asleep: ['Computer is asleep', 'start'], starting: ['Starting the computer', 'refresh'], ready: ['Computer is ready', 'take'],
  busy: ['The bot is using the computer', 'take'], taken: ['You have the wheel', 'release'], off: ['Computer use is off', 'place'],
  browser_only: ['Working in the browser', 'take'], error: ['The computer could not start', 'start'],
  docker_missing: ['Docker is not ready', 'settings'], image_needed: ['Prepare the computer', 'prepare'] };
module.exports = ({ state }) => {
  const root = () => state.botsWorkbench ||= { bots: {}, profiles: [], settings: { max_running: 2, idle_minutes: 10 }, counter: 0, log: [] };
  const fail = (status, detail) => ({ _status: status, detail });
  const get = id => {
    const agent = state.botsCore?.agents?.find(a => a.id === id);
    if (!agent) return null;
    return root().bots[id] ||= { phase: 'asleep', running: false, lease_id: null, taken_over: false, url: 'about:blank',
      help: null, settled: [], browser_enabled: true, browser_profile: 'own', sites: ['example.com'], name: agent.name };
  };
  const status = (id, query) => {
    const bot = get(id); if (!bot) return fail(404, 'Bot not found');
    const agent = state.botsCore.agents.find(a => a.id === id);
    const thread = query.thread_id ? state.botsCore.threads.find(t => t.id === query.thread_id && t.agent_id === id) : null;
    if (query.thread_id && !thread) return fail(404, 'Conversation not found');
    const place = { bot: agent.place || 'auto', thread: thread?.thread.place || null };
    place.effective = !bot.browser_enabled ? 'off' : place.thread || place.bot;
    place.why = place.thread ? 'Pinned for this conversation' : 'Follows the bot';
    const phase = place.effective === 'off' ? 'off' : bot.taken_over ? 'taken' : bot.phase;
    return { phase, message: MESSAGES[phase][0], action: MESSAGES[phase][1], place,
      docker: { available: true, reason: '', image_ready: true, desktop_image_ready: true },
      computer: { running: bot.running, desktop: false, taken_over: bot.taken_over, waiting_model: false,
        lease_id: bot.lease_id, title: 'Workbench page', url: bot.url, last_action_at: 1, badges: ['Browser'] },
      browser: { enabled: bot.browser_enabled, profile: bot.browser_profile, sites: bot.sites }, help: bot.help };
  };
  // Every Bots page may read the workbench (Settings' Bot computers, the panel's Access sites) before a check
  // seeds it; a bot's record is made on demand for any bot the core lane knows. The computer route stays seeded-only.
  const global = route => route.startsWith('/api/bot-workbench/');
  const read = (route, query = {}) => {
    if (!state.botsLive || (!state.botsWorkbench && !global(route))) return undefined;
    const r = root();
    if (route === '/api/bot-workbench/profiles') return r.profiles.map(p => ({ ...p, used_by: Object.entries(r.bots).filter(([, b]) => b.browser_profile === 'shared:' + p.id).map(([id, b]) => ({ id, name: b.name, running: b.running })) }));
    if (route === '/api/bot-workbench/computers') return { settings: r.settings, docker: { available: true, reason: '' },
      computers: Object.entries(r.bots).map(([bot_id, b]) => ({ bot_id, name: b.name, running: b.running, taken_over: b.taken_over, profile: b.browser_profile })) };
    const match = route.match(/^\/api\/bot-workbench\/([^/]+)\/(status|places|files|sites)$/);
    if (match) {
      const [, id, what] = match, b = get(id); if (!b) return fail(404, 'Bot not found');
      if (what === 'status') return status(id, query);
      if (what === 'places') return ['auto', 'computer', 'browser', 'off'].map((id, i) => ({ id, label: ['Let it choose', 'Computer', 'Browser', 'Off'][i], available: true, reason: '' }));
      if (what === 'sites') return b.sites;
      return { folder: { label: 'Private folder', private: true }, recent: [{ name: 'work-notes.txt', url: null, bytes: 12, at: 1, shared: false }] };
    }
    const computer = decodeURIComponent(route).match(/^\/api\/computer\/agent:([^/]+)\/last$/);
    if (computer && get(computer[1])) return null;
    return undefined;
  };
  const mutate = (route, method, body = {}) => {
    if (!state.botsLive || (!state.botsWorkbench && !global(route))) return undefined;
    const r = root();
    if (route === '/api/bot-workbench/computers/settings' && method === 'PUT') {
      if (!Number.isInteger(body.max_running) || body.max_running < 1 || body.max_running > 8 || !Number.isInteger(body.idle_minutes) || body.idle_minutes < 5 || body.idle_minutes > 1440) return fail(422, 'Choose valid limits');
      return r.settings = { ...body };
    }
    if (route === '/api/bot-workbench/profiles' && method === 'POST') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) return fail(422, 'Choose a profile name');
      if (r.profiles.length >= 20) return fail(409, 'You can keep up to 20 profiles');
      const p = { id: (++r.counter).toString(16).padStart(12, '0'), name: body.name, created_at: 1 }; r.profiles.push(p); return p;
    }
    const profile = route.match(/^\/api\/bot-workbench\/profiles\/([^/]+)$/);
    if (profile) {
      const p = r.profiles.find(p => p.id === profile[1]); if (!p) return fail(404, 'Not found');
      if (method === 'PATCH') { p.name = String(body.name).slice(0, 60); return p; }
      if (method === 'DELETE') {
        if (Object.values(r.bots).some(b => b.running && b.browser_profile === 'shared:' + p.id)) return fail(409, 'Sleep every computer using this profile first');
        r.profiles = r.profiles.filter(x => x !== p);
        for (const b of Object.values(r.bots)) if (b.browser_profile === 'shared:' + p.id) b.browser_profile = 'own';
        return { ok: true };
      }
      return undefined;
    }
    const input = decodeURIComponent(route).match(/^\/api\/computer\/agent:([^/]+)\/input$/);
    if (input) {
      const b = get(input[1]); if (!b) return fail(404, 'Bot not found');
      if (!b.taken_over) return fail(409, 'Take over the computer first');
      r.log.push(['input', input[1], body]);
      if (body.kind === 'navigate') { if (!/^https?:\/\//.test(body.url)) return fail(422, 'Use a web address'); b.url = body.url; }
      return { ok: true };
    }
    const match = route.match(/^\/api\/bot-workbench\/([^/]+)\/(computer\/(start|sleep|control)|browser|sites\/sign-out|help\/([^/]+)\/settle)$/);
    if (!match) return undefined;
    const [, id, what, command, helpId] = match, b = get(id); if (!b) return fail(404, 'Bot not found');
    r.log.push([what, id, body]);
    if (command === 'start') { b.running = true; b.phase = 'ready'; return { ok: true }; }
    if (command === 'sleep') { b.running = b.taken_over = false; b.lease_id = null; b.phase = 'asleep'; return { ok: true }; }
    if (command === 'control') {
      if (!b.running) return fail(404, 'Computer is closed');
      if (body.action === 'take') { b.taken_over = true; b.lease_id = `lease-${++r.counter}`; }
      else if (!b.taken_over || body.lease_id !== b.lease_id) return fail(409, 'Control changed. Refresh before handing back');
      else { b.taken_over = false; b.lease_id = null; }
      return { lease_id: b.lease_id };
    }
    if (what === 'browser') { if ('profile' in body) b.browser_profile = body.profile; if ('enabled' in body) b.browser_enabled = body.enabled; return { enabled: b.browser_enabled, profile: b.browser_profile }; }
    if (what === 'sites/sign-out') { b.sites = b.sites.filter(h => h !== body.host); b.running = false; return { ok: true }; }
    if (helpId) {
      if (b.settled.includes(helpId)) return fail(409, 'This help request was already settled');
      if (b.help?.id !== helpId) return fail(404, 'Help not found');
      b.settled.push(helpId); b.help = null; b.taken_over = false; b.lease_id = null;
      return { id: helpId, outcome: body.outcome };
    }
    return undefined;
  };
  return { read, mutate };
};
