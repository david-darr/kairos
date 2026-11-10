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
  assert.deepEqual(d.pickCallMode({}), { mode: 'local', fellBack: false }, 'Local when unset');
  assert.deepEqual(d.pickCallMode({ call_mode: 'turns' }, [{}]), { mode: 'local', fellBack: false });
  assert.deepEqual(d.pickCallMode({ call_mode: 'realtime' }, [{ id: 'k' }]), { mode: 'realtime', fellBack: false });
  assert.deepEqual(d.pickCallMode({ call_mode: 'live' }, [{ id: 'k' }]), { mode: 'realtime', fellBack: false }, 'the older GPT-Live mode is realtime');
  assert.deepEqual(d.pickCallMode({ call_mode: 'realtime' }, []), { mode: 'local', fellBack: true }, 'no key: Local, and the call says so');
  assert.deepEqual(d.pickCallMode({ call_mode: 'realtime' }, [{ id: 'k' }], true), { mode: 'local', fellBack: true }, 'group calls are local');

  // ---- voice -------------------------------------------------------------------------------------------------------
  const kokoro = { protocol: 'kokoro', models: ['kokoro'], voices: [{ id: 'af', name: 'A' }, { id: 'default', name: 'Default' }] };
  assert.deepEqual(d.pickVoice({ voice_id: 'af' }, {}, kokoro), { provider: 'neural', model: 'kokoro', voice: 'af' }, "the bot's saved voice");
  assert.deepEqual(d.pickVoice({}, {}, kokoro), { provider: 'neural', model: 'kokoro', voice: 'default' }, 'else Kokoro when it is ready');
  assert.deepEqual(d.pickVoice({}, {}, { ...kokoro, error: 'Kokoro is not installed', models: [], voices: [] }), { provider: 'device', model: '', voice: '' }, 'else the device voice');
  assert.deepEqual(d.pickVoice({}, { provider: 'device' }, kokoro).provider, 'device', 'a device voice chosen in Call settings stays');
  assert.deepEqual(d.pickVoice({}, { provider: 'neural', model: 'tts', voice: 'v' }, { protocol: 'voicestudio', models: ['tts'], voices: [{ id: 'v' }] }), { provider: 'neural', model: 'tts', voice: 'v' }, 'a saved engine voice stays while it is offered');
  assert.equal(d.pickVoice({}, {}, { protocol: 'voicestudio', models: ['tts'], voices: [{ id: 'v' }] }).provider, 'device', 'another engine is not switched on by itself');

  assert.equal(d.consentKey('bot', 'k'), 'kairos:call-consent:bot:k');
  console.log('PASS call defaults: conversation, speech model, call mode, voice and consent key');
})().catch(error => { console.error(error); process.exit(1); });
