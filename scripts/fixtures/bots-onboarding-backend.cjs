// Answers only while the check (or isolateBotsCheck) seeds botsOnboarding.
module.exports = ({ state }) => {
  const lane = () => state.botsLive && state.botsOnboarding;
  const view = s => ({ welcome_seen: !!s.welcome_seen, tour: s.tour || { done: false, step: 0, variant: 'simple' }, hints_seen: s.hints_seen || [], notices: s.notices || {}, setup_checked_at: s.checked_at || null });
  const setup = s => s.setup || { checked_at: Date.now() / 1000, checks: [
    ['model', 'Model', 'ready', 'add-models'], ['computer', 'Computer', 'needs_setup', 'computer-use'], ['gmail', 'Gmail', 'needs_setup', 'integrations'],
    ['calendar', 'Calendar', 'needs_setup', 'integrations'], ['notifications', 'Notifications', 'not_checked', 'notifications'], ['voice', 'Voice engine', 'needs_setup', 'speech'],
  ].map(([id, title, status, fix]) => ({ id, title, status, fix })) };
  return {
    read(route) {
      const s = lane(); if (!s) return undefined;
      if (route === '/api/bot-onboarding') return view(s);
      if (route === '/api/bot-onboarding/setup') return setup(s);
      return undefined;
    },
    mutate(route, method, body = {}) {
      const s = lane(); if (!s) return undefined;
      if (route === '/api/bot-onboarding' && method === 'PATCH') {
        (s.log ||= []).push({ route, method, body });
        if (s.failNext) { s.failNext = false; return { _status: 503, detail: 'Onboarding could not save.' }; }
        if (body.welcome_seen !== undefined) s.welcome_seen = body.welcome_seen;
        if (body.tour) s.tour = { ...view(s).tour, ...body.tour };
        s.hints_seen = [...new Set([...(s.hints_seen || []), ...(body.hints || [])])];
        for (const [id, notice] of Object.entries(body.notices || {})) {
          s.notices ||= {}; const old = s.notices[id];
          s.notices[id] = { shown_at: old?.shown_at || Date.now() / 1000, dismissed: !!(old?.dismissed || notice.dismissed) };
        }
        return view(s);
      }
      if (route === '/api/bot-onboarding/setup/recheck' && method === 'POST') {
        if (Date.now() - (s.rechecked || 0) < 10000) return { _status: 429, detail: 'Wait a moment before checking again.' };
        s.rechecked = Date.now(); (s.log ||= []).push({ route }); return setup(s);
      }
      return undefined;
    },
  };
};
