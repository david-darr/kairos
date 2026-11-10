// One-tap calls (2026-11-10, David: "users just want to click call and immediately be put into a call with their agent").
// What a call starts with when nobody opens Call settings. Pure functions, no DOM and no imports, so
// scripts/test_call_defaults.cjs checks every rule in plain node.

const CLI = new Set(['claude_cli', 'codex_cli', 'antigravity_cli']);
// When Kairos has measured nothing, the order it tries kinds in: a hosted API, Claude Code (on Haiku its first sentence
// came in about 0.6 s, see core/cli_dialogue.py), then a local model (fast once loaded, slow to load the first time).
const KIND_ORDER = { api: 0, claude_cli: 1, local: 2, codex_cli: 3, antigravity_cli: 4 };

// A model version the call can send for this connection. A sign-in may send none: Claude Code then talks on Haiku,
// Codex and Antigravity on their own default. An API or local connection needs one.
function usableModel(choice, wanted) {
  if (!choice) return null;
  const model = (wanted ?? '').trim();
  if (choice.kind === 'claude_cli') return model;
  if (CLI.has(choice.kind)) return model || (choice.model || '').trim();
  return model || (choice.model || '').trim() || null;
}

// Conversation model: what this bot's calls last used if it still exists, else the bot's own connection, else the
// quickest connection Kairos knows about (measured time to first output, then KIND_ORDER). A connection marked slower is
// skipped while any other one can be used. Returns { endpoint, model, source } or null when there is no connection.
export function pickConversation(choices, saved = {}, agent = {}) {
  const list = Array.isArray(choices) ? choices : [];
  const byId = id => list.find(choice => choice.id === id);
  const fast = list.filter(choice => !choice.slower && usableModel(choice, '') !== null);
  const last = byId(saved?.endpoint);
  if (last && usableModel(last, saved.model) !== null) return { endpoint: last.id, model: usableModel(last, saved.model), source: 'last' };
  const own = byId(agent?.endpoint_id);
  if (own && (!own.slower || !fast.length)) {
    const model = usableModel(own, own.kind === 'claude_cli' ? '' : agent.model_override || '');
    if (model !== null) return { endpoint: own.id, model, source: 'bot' };
  }
  const pool = fast.length ? fast : list.filter(choice => usableModel(choice, '') !== null);
  if (!pool.length) return null;
  const measured = choice => Number.isFinite(choice.first_output_s) ? choice.first_output_s : Infinity;
  const best = pool.map((choice, at) => ({ choice, at })).sort((a, b) => measured(a.choice) - measured(b.choice)
    || (KIND_ORDER[a.choice.kind] ?? 9) - (KIND_ORDER[b.choice.kind] ?? 9) || a.at - b.at)[0].choice;
  return { endpoint: best.id, model: usableModel(best, ''), source: 'fastest' };
}

// The label a connection gets in Call settings.
export function conversationLabel(choice) {
  return choice.slower ? `${choice.name} (slower)` : choice.name;
}

export const isCliKind = kind => CLI.has(kind);

// Speech recognition: an already downloaded model (the saved one, then the call default, then any), else the call
// default to download once. Returns { name, download } or null when recognition is not in this build.
export function pickSpeechModel(speech, savedModel = '') {
  if (!speech?.engine_available) return null;
  const models = Array.isArray(speech.models) ? speech.models : [];
  const ready = models.filter(item => item.downloaded);
  const preferred = speech.call_model || 'small.en';
  const found = ready.find(item => item.name === savedModel) || ready.find(item => item.name === preferred) || ready[0];
  if (found) return { name: found.name, download: false };
  const fallback = models.find(item => item.name === preferred) || models[0];
  return fallback ? { name: fallback.name, download: true } : null;
}

// Call mode: the bot's own setting from its panel ("live" is the older GPT-Live mode, now a realtime choice). Realtime
// with no realtime connection, or in a group call, falls back to Local and says so.
export function pickCallMode(agent = {}, realtimeChoices = [], room = false) {
  const wanted = agent.call_mode === 'realtime' || agent.call_mode === 'live' ? 'realtime' : 'local';
  if (wanted === 'realtime' && (room || !(Array.isArray(realtimeChoices) && realtimeChoices.length))) return { mode: 'local', fellBack: true };
  return { mode: wanted, fellBack: false };
}

// The voice: the bot's saved voice (its panel's voice, then the call screen's last choice), else Kokoro when it is the
// ready engine, else the device voice. `catalog` is GET /api/agent-calls/voices. Returns { provider, model, voice }.
export function pickVoice(agent = {}, saved = {}, catalog = null) {
  const voices = Array.isArray(catalog?.voices) ? catalog.voices : [];
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const ready = !catalog?.error && voices.length > 0 && models.length > 0;
  const has = id => voices.some(voice => voice.id === id);
  if (ready && agent.voice_id && has(agent.voice_id)) return { provider: 'neural', model: models.includes(saved?.model) ? saved.model : models[0], voice: agent.voice_id };
  if (saved?.provider === 'device') return { provider: 'device', model: '', voice: '' };
  if (saved?.provider === 'neural' && ready && models.includes(saved.model) && has(saved.voice)) return { provider: 'neural', model: saved.model, voice: saved.voice };
  if (ready && catalog.protocol === 'kokoro') return { provider: 'neural', model: models[0], voice: (voices.find(voice => voice.id === 'default') || voices[0]).id };
  return { provider: 'device', model: '', voice: '' };
}

// Paid realtime voice is agreed once per bot and connection, then remembered on this device.
export const consentKey = (agentId, endpointId) => `kairos:call-consent:${agentId}:${endpointId}`;
