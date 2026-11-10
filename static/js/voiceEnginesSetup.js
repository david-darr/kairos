// Settings > Speech > Voice engines (routes/voice_engine_routes.py): ElevenLabs on your own key, or a VoiceStudio you run
// yourself, as the voice that reads replies in calls, Open Mic, bots and phone calls. Keys are checked first, then kept
// sealed in your account; they never come back to the page. Kokoro and the device voice stay the fallback.
import { api, el } from './api.js';

export const ELEVENLABS_COST = 'Cost: ElevenLabs bills your account by characters spoken. At its API rates Flash costs about $0.04 per '
  + '1,000 characters, roughly 4 cents a minute of speech, and Multilingual v2 about twice that; credits in your plan are used first. '
  + 'Kairos also renders a few short acknowledgements once per voice and keeps them.';
export const ELEVENLABS_PRIVACY = 'Privacy: every sentence Kairos speaks is sent to ElevenLabs, which keeps it in your history under '
  + 'its own terms. Listening stays on this computer. For private calls use Kokoro, VoiceStudio or the device voice.';
export const VOICESTUDIO_NOTE = 'VoiceStudio is a free, open source voice studio that runs entirely on your computer (desktop app or '
  + 'Docker). Install and start it yourself; Kairos only connects to it at its address and never installs it. Nothing leaves '
  + 'this computer, and there is no cost beyond your own hardware. Docker needs the OMNIVOICE_API_KEY it was started with.';

function keyInput(label, placeholder, hook) {
  return el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': label, placeholder, 'data-voice-engine': hook });
}

function status() {
  const node = el('p', { class: 'free-voice-status', role: 'status' });
  node.say = (text, tone = '') => { node.textContent = text; if (tone) node.dataset.tone = tone; else delete node.dataset.tone; };
  return node;
}

// The ElevenLabs block. onChanged(state) runs after a save, removal or switch.
export function elevenLabsSetup(state, { onChanged = () => {}, request = api } = {}) {
  const own = state.elevenlabs || {};
  const active = state.active === 'elevenlabs';
  const input = keyInput('ElevenLabs API key', own.has_key ? 'Saved. Paste a new key to replace it.' : 'Paste your ElevenLabs API key', 'elevenlabs-key');
  const said = status();
  const check = el('button', { type: 'button', class: 'btn quiet', text: 'Check', 'data-voice-engine': 'elevenlabs-check' });
  const save = el('button', { type: 'button', class: 'btn primary', text: own.has_key ? 'Save and use' : 'Check and use', 'data-voice-engine': 'elevenlabs-save' });
  const actions = [check, save];
  const busy = value => { for (const button of actions) button.disabled = value; };
  check.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key && !own.has_key) { said.say('Paste the key first.', 'error'); input.focus(); return; }
    busy(true); said.say('Asking ElevenLabs whether the key works...');
    try {
      const result = await request('/api/voice-engines/elevenlabs/check', { method: 'POST', toast: false, body: JSON.stringify(key ? { api_key: key } : {}) });
      const left = result.characters_left == null ? '' : ` About ${Number(result.characters_left).toLocaleString()} characters are left this month.`;
      said.say(`The key works.${result.voices == null ? '' : ` ${result.voices} voices on the account.`}${left} Nothing was spoken, so no credits were used.`, 'ok');
    } catch (error) { said.say(error?.message || 'The key could not be checked.', 'error'); }
    finally { busy(false); }
  });
  save.addEventListener('click', async () => {
    const key = input.value.trim();
    busy(true);
    try {
      let next;
      if (key) { said.say('Checking the key, then saving it...'); next = await request('/api/voice-engines/elevenlabs', { method: 'PUT', toast: false, body: JSON.stringify({ api_key: key }) }); }
      else if (own.has_key) next = await request('/api/voice-engines/use', { method: 'POST', toast: false, body: JSON.stringify({ engine: 'elevenlabs' }) });
      else { said.say('Paste the key first.', 'error'); input.focus(); return; }
      input.value = '';
      said.say('ElevenLabs now reads replies aloud. Pick a voice from your account under Voice engine above, in a call, or in a bot\'s Voice settings.', 'ok');
      onChanged(next);
    } catch (error) { said.say(error?.message || 'The key could not be saved.', 'error'); }
    finally { busy(false); }
  });
  if (own.has_key) {
    const forget = el('button', { type: 'button', class: 'btn quiet', text: 'Remove key', 'data-voice-engine': 'elevenlabs-forget' });
    forget.addEventListener('click', async () => {
      busy(true);
      try { const next = await request('/api/voice-engines/elevenlabs', { method: 'DELETE', toast: false }); said.say('Key removed. Kokoro or the device voice reads replies now.', 'ok'); onChanged(next); }
      catch (error) { said.say(error?.message || 'The key could not be removed.', 'error'); }
      finally { busy(false); }
    });
    actions.push(forget);
  }
  return el('div', { class: 'free-voice-setup voice-engine-setup', 'data-voice-engine': 'elevenlabs' }, [
    ...(active || own.has_key ? [el('p', { class: 'meta', text: active ? 'In use: ElevenLabs reads replies aloud.' : 'Key saved. Not in use right now.' })] : []),
    el('ol', { class: 'free-voice-steps' }, [
      el('li', {}, ['Sign in at ElevenLabs and open API keys. ', el('a', { href: own.key_page || 'https://elevenlabs.io/app/settings/api-keys', target: '_blank', rel: 'noopener', class: 'set-link', text: 'Open ElevenLabs API keys' })]),
      el('li', { text: 'Create a key with Text to Speech and Voices access, copy it and paste it here.' }),
      el('li', { text: 'Choose Check to test it for free, then Check and use.' }),
    ]),
    el('div', { class: 'free-voice-key' }, [input, ...actions]),
    said,
    el('p', { class: 'free-voice-limits', text: ELEVENLABS_COST }),
    el('p', { class: 'free-voice-limits', text: ELEVENLABS_PRIVACY }),
    el('p', { class: 'free-voice-limits', text: 'Not checked against the live service yet: built from ElevenLabs\' published API.' }),
  ]);
}

// The VoiceStudio block (an admin points Kairos at a local address).
export function voiceStudioSetup(state, { isAdmin = false, onChanged = () => {}, request = api } = {}) {
  const own = state.voicestudio || {};
  const active = state.active === 'voicestudio';
  const url = el('input', { type: 'url', 'aria-label': 'VoiceStudio address', value: own.url || 'http://127.0.0.1:3900', placeholder: 'http://127.0.0.1:3900', 'data-voice-engine': 'voicestudio-url' });
  const input = keyInput('VoiceStudio API key', own.has_key ? 'Key saved. Paste a new one to replace it.' : 'API key, only if you set OMNIVOICE_API_KEY', 'voicestudio-key');
  const said = status();
  const check = el('button', { type: 'button', class: 'btn quiet', text: 'Check', 'data-voice-engine': 'voicestudio-check' });
  const save = el('button', { type: 'button', class: 'btn primary', text: 'Check and use', 'data-voice-engine': 'voicestudio-save' });
  const body = () => JSON.stringify({ url: url.value.trim(), ...(input.value.trim() ? { api_key: input.value.trim() } : {}) });
  const busy = value => { check.disabled = save.disabled = value; };
  check.addEventListener('click', async () => {
    busy(true); said.say('Looking for VoiceStudio...');
    try {
      const result = await request('/api/voice-engines/voicestudio/check', { method: 'POST', toast: false, body: body() });
      said.say(`VoiceStudio is running: ${result.voices} saved voice${result.voices === 1 ? '' : 's'}, engines ${result.engines.join(', ')}. Nothing was spoken.`, 'ok');
    } catch (error) { said.say(error?.message || 'VoiceStudio could not be checked.', 'error'); }
    finally { busy(false); }
  });
  save.addEventListener('click', async () => {
    busy(true); said.say('Checking VoiceStudio, then saving...');
    try {
      const next = await request('/api/voice-engines/voicestudio', { method: 'PUT', toast: false, body: body() });
      input.value = '';
      said.say('VoiceStudio now reads replies aloud. Pick its engine and voice under Voice engine above, in a call, or in a bot\'s Voice settings.', 'ok');
      onChanged(next);
    } catch (error) { said.say(error?.message || 'VoiceStudio could not be saved.', 'error'); }
    finally { busy(false); }
  });
  const controls = isAdmin
    ? [el('div', { class: 'free-voice-key' }, [url, input, check, save]), said]
    : [el('p', { class: 'meta', text: 'An admin can connect VoiceStudio.' })];
  return el('div', { class: 'free-voice-setup voice-engine-setup', 'data-voice-engine': 'voicestudio' }, [
    ...(active ? [el('p', { class: 'meta', text: `In use: VoiceStudio at ${own.url}.` })] : []),
    el('p', { class: 'free-voice-limits' }, [VOICESTUDIO_NOTE, ' ', el('a', { href: own.repo || 'https://github.com/debpalash/VoiceStudio', target: '_blank', rel: 'noopener', class: 'set-link', text: 'VoiceStudio on GitHub' })]),
    ...controls,
    el('p', { class: 'free-voice-limits', text: 'Not checked against a running VoiceStudio yet: built from its published Local API.' }),
  ]);
}
