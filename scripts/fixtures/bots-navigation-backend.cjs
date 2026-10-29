// Fixture lane for the navigation check (Bots Phase 1, unit U4). It answers, while
// demoState.botsLive is set, the one route the core lane does not: a conversation read by
// id (GET /api/sessions/<id>), for the sessions a check registers in
// state.botsNavigation.sessions. Anything else returns undefined, so the core lane and the
// demo keep every other route. State lives in state.botsNavigation so ui-smoke's
// fixture-change detection sees it and a check can seed and clear it.
module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  return {
    read(route) {
      if (!state.botsLive) return undefined;
      const match = route.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
      const session = match && state.botsNavigation?.sessions?.[match[1]];
      if (!session) return undefined;
      return { id: match[1], title: session.title || 'Conversation', agent_id: session.agent_id || null, forge: !!session.forge,
        model_endpoint_id: 'm1', created_at: clock() - 100, updated_at: clock() - 10,
        messages: [{ role: 'user', content: 'Hello', ts: clock() - 100 }, { role: 'assistant', content: 'Hi there.', ts: clock() - 90 }] };
    },
    mutate() { return undefined; },
  };
};
