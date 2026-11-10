// One-tap calls (static/js/callDefaults.js): what a call starts with when nobody opens Call settings. Plain node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const load = file => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(file, 'utf8')).toString('base64'));

(async () => {
  const d = await load('static/js/callDefaults.js');

  // ---- conversation model -----------------------------------------------------------------------------------------
  const api = { id: 'api', name: 'OpenAI', kind: 'api', model: 'gpt-mini' };
  const local = { id: 'local', name: 'Ollama', kind: 'local', model: 'llama3.2' };
  const claude = { id: 'claude', name: 'Claude', kind: 'claude_cli', model: 'opus' };
  const codex = { id: 'codex', name: 'Codex', kind: 'codex_cli', model: '', slower: true };
  const all = [local, codex, claude, api];
  assert.deepEqual(d.pickConversation(all, { endpoint: 'local', model: 'qwen3' }, { endpoint_id: 'api' }), { endpoint: 'local', model: 'qwen3', source: 'last' }, 'what this bot last used wins');
  assert.equal(d.pickConversation(all, { endpoint: 'gone', model: 'x' }, { endpoint_id: 'api' }).endpoint, 'api', 'a vanished last choice falls through to the bot');
  assert.deepEqual(d.pickConversation(all, {}, { endpoint_id: 'local', model_override: 'phi3' }), { endpoint: 'local', model: 'phi3', source: 'bot' }, "the bot's own connection, with its version");
  assert.deepEqual(d.pickConversation(all, {}, { endpoint_id: 'claude', model_override: 'opus' }), { endpoint: 'claude', model: '', source: 'bot' }, 'Claude Code talks on its fast default, not the work model');
  assert.equal(d.pickConversation(all, {}, { endpoint_id: 'codex' }).source, 'fastest', 'a slower bot connection gives way while a quicker one exists');
  assert.deepEqual(d.pickConversation([codex], {}, { endpoint_id: 'codex' }), { endpoint: 'codex', model: '', source: 'bot' }, 'but is used when it is all there is');
  assert.equal(d.pickConversation(all, {}, {}).endpoint, 'api', 'nothing measured: an API model first');
  assert.equal(d.pickConversation([local, claude], {}, {}).endpoint, 'claude', 'then Claude Code, then local');
  assert.equal(d.pickConversation([{ ...api, first_output_s: 1.9 }, { ...local, first_output_s: 0.3 }], {}, {}).endpoint, 'local', 'the measured quickest wins');
  assert.equal(d.pickConversation([{ ...api, model: '' }, local], {}, {}).endpoint, 'local', 'an API connection with no version cannot be sent');
  assert.equal(d.pickConversation([codex, { ...codex, id: 'agy', kind: 'antigravity_cli' }], {}, {}).endpoint, 'codex', 'only slower ones: still a call');
  assert.equal(d.pickConversation([], {}, {}), null, 'no connection at all: nothing to call with');
  assert.equal(d.conversationLabel(codex), 'Codex (slower)'); assert.equal(d.conversationLabel(api), 'OpenAI');

  // ---- speech recognition ------------------------------------------------------------------------------------------
  const speech = (models, extra = {}) => ({ engine_available: true, call_model: 'small.en', models, ...extra });
  assert.deepEqual(d.pickSpeechModel(speech([{ name: 'base.en', downloaded: true }, { name: 'small.en', downloaded: true }]), 'base.en'), { name: 'base.en', download: false }, 'the saved model when it is here');
  assert.deepEqual(d.pickSpeechModel(speech([{ name: 'base.en', downloaded: true }, { name: 'small.en', downloaded: false }]), 'small.en'), { name: 'base.en', download: false }, 'any downloaded model beats a download');
  assert.deepEqual(d.pickSpeechModel(speech([{ name: 'base.en', downloaded: false }, { name: 'small.en', downloaded: false }])), { name: 'small.en', download: true }, 'none here: download the call default once');
  assert.equal(d.pickSpeechModel({ engine_available: false, models: [] }), null);

  // ---- call mode ---------------------------------------------------------------------------------------------------
  const L = (extra = {}) => ({ mode: 'local', fellBack: false, source: 'voice', endpoint: null, ...extra });
  const liveChoice = { id: 'live:k', provider: 'openai_live' };
  assert.deepEqual(d.pickCallMode({}), L(), 'Local when unset and the Voice is Kairos Voice');
  assert.deepEqual(d.pickCallMode({ call_mode: 'turns' }, [{}], false, 'kairos'), L());
  assert.deepEqual(d.pickCallMode({ call_mode: 'turns' }, [liveChoice], false, 'elevenlabs'), L(), 'ElevenLabs is a local call with that voice');
  assert.deepEqual(d.pickCallMode({ call_mode: 'turns' }, [{ id: 'k' }, liveChoice], false, 'gpt_live'), { mode: 'realtime', fellBack: false, source: 'voice', endpoint: 'live:k' }, 'the Voice comes before Local if unset: GPT-Live');
  assert.deepEqual(d.pickCallMode({}, [{ id: 'k', provider: 'openai' }], false, 'gpt_live'), L({ fellBack: true }), 'GPT-Live with no OpenAI key: Local, and the call says so');
  assert.deepEqual(d.pickCallMode({ call_mode: 'local' }, [liveChoice], false, 'gpt_live'), { mode: 'local', fellBack: false, source: 'bot', endpoint: null }, "a bot set to Local overrides the Voice");
  assert.deepEqual(d.pickCallMode({ call_mode: 'realtime' }, [{ id: 'k' }]), { mode: 'realtime', fellBack: false, source: 'bot', endpoint: null }, "a bot set to Realtime uses its own realtime choice");
  assert.deepEqual(d.pickCallMode({ call_mode: 'live' }, [{ id: 'k' }]), { mode: 'realtime', fellBack: false, source: 'bot', endpoint: null }, 'the older GPT-Live mode is realtime');
  assert.equal(d.pickCallMode({ call_mode: 'live' }, [{ id: 'k' }, liveChoice]).endpoint, 'live:k', 'and picks GPT-Live when it is offered');
  assert.deepEqual(d.pickCallMode({ call_mode: 'realtime' }, []), { mode: 'local', fellBack: true, source: 'bot', endpoint: null }, 'no key: Local, and the call says so');
  assert.deepEqual(d.pickCallMode({ call_mode: 'realtime' }, [{ id: 'k' }], true), { mode: 'local', fellBack: true, source: 'bot', endpoint: null }, 'group calls are local');
  assert.equal(d.pickCallMode({}, [liveChoice], true, 'gpt_live').mode, 'local', 'group calls are local even on GPT-Live');

  // ---- voice -------------------------------------------------------------------------------------------------------
  const kokoro = { protocol: 'kokoro', models: ['kokoro'], voices: [{ id: 'af', name: 'A' }, { id: 'default', name: 'Default' }] };
  assert.deepEqual(d.pickVoice({ voice_id: 'af' }, {}, kokoro), { provider: 'neural', model: 'kokoro', voice: 'af' }, "the bot's saved voice");
  assert.deepEqual(d.pickVoice({}, {}, kokoro), { provider: 'neural', model: 'kokoro', voice: 'default' }, 'else Kairos Voice speaks with Kokoro when it is ready');
  assert.deepEqual(d.pickVoice({}, {}, { ...kokoro, error: 'Kokoro is not installed', models: [], voices: [] }), { provider: 'device', model: '', voice: '' }, 'else the device voice');
  assert.deepEqual(d.pickVoice({}, { provider: 'device' }, kokoro).provider, 'device', 'a device voice chosen in Call settings stays');
  const box = { protocol: 'voicebox', models: ['profile'], voices: [{ id: 'p1' }, { id: 'p2' }] };
  assert.deepEqual(d.pickVoice({}, { provider: 'neural', model: 'profile', voice: 'p2' }, box), { provider: 'neural', model: 'profile', voice: 'p2' }, 'a saved engine voice stays while it is offered');
  assert.deepEqual(d.pickVoice({}, {}, box), { provider: 'neural', model: 'profile', voice: 'p1' }, 'the Voice chosen in Settings (Voicebox here) is used with its first voice');
  assert.deepEqual(d.pickVoice({}, {}, { protocol: 'elevenlabs', models: ['eleven_flash_v2_5'], voices: [{ id: 'r' }] }).provider, 'neural', 'ElevenLabs as the Voice speaks in calls');

  assert.equal(d.consentKey('bot', 'k'), 'kairos:call-consent:bot:k');
  console.log('PASS call defaults: conversation, speech model, call mode, voice and consent key');
})().catch(error => { console.error(error); process.exit(1); });
