// Each Bots check owns its fixture store and page preferences. Keep the main
// demo's agents (including bots created by earlier checks), but do not inherit
// another Bots check's defaults, presets, threads or failure switches.
const replace = (object, values) => {
  const saved = Object.keys(values).map(key => [key, Object.hasOwn(object, key), object[key]]);
  Object.assign(object, values);
  return () => {
    for (const [key, present, value] of saved) {
      if (present) object[key] = value; else delete object[key];
    }
  };
};

async function isolateBotsCheck({ js, demoState }, state = {}) {
  const preferences = {
    'kairos:app-mode': 'kairos', 'kairos:bots-interface': null,
    'kairos:bots-last-bot': null, 'kairos:bots-last-section': null,
    'kairos:bots-send-key': null, 'kairos:bots-chat-width': null,
    'kairos:bots-show-tool-calls': null, 'kairos:bots-colour-bubbles': null,
    'kairos:bots-font': null, 'kairos:bots-show-threads': null,
    'kairos:bots-pinned-circles': null, 'kairos:bots-run-card': null,
    'jarvis:sidebar-collapsed': 'false',
    'jarvis:agent-chat:a1': null, 'jarvis:agent-chat:a2': null,
  };
  // Set these before loading the page: clearing a stored Bots mode after load
  // is too late to wait for the Kairos dashboard.
  const saved = await js(`(() => {
    const values = ${JSON.stringify(preferences)};
    const saved = Object.fromEntries(Object.keys(values).map(k => [k, localStorage.getItem(k)]));
    for (const [k, v] of Object.entries(values)) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    return saved;
  })()`);
  const restoreState = replace(demoState, {
    botsLive: true, botsCore: undefined, botsWorking: [],
    botsConfiguredFail: undefined, botsConfiguredWarnings: undefined,
    botsOnboarding: { welcome_seen: true, tour: { done: true, step: 0, variant: 'simple' }, hints_seen: [], notices: {} },
    botsVoice: { catalog: { voices: [], models: [] }, notes: {}, counter: 0 },
    // The attention host polls /api/bot-attention in Bots mode; an empty feed keeps those polls answered.
    botsAttention: { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] },
    isAdmin: true, empty: false, homeClear: false, ...state,
  });
  return async () => {
    try {
      await js(`(() => {
        for (const [k, v] of Object.entries(${JSON.stringify(saved)})) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
      })()`);
    } finally { restoreState(); }
  };
}

module.exports = { isolateBotsCheck };
