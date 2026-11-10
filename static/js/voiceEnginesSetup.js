// Settings > Speech > Voice (routes/voice_engine_routes.py): one Voice choice that every speaker follows: calls, Open
// Mic, replies read aloud, voice notes, phone calls and Discord voice (Locked shape, David 2026-11-10). Kairos Voice is the
// default. GPT-Live and ElevenLabs set up inline with the person's own key; keys are checked first, then kept sealed in
// the account and never come back to the page. Voicebox and another voice server on this computer are under More options.
import { api, el } from './api.js';

export const CHOICE_COPY = {
  kairos: { title: 'Kairos Voice', line: 'Free and private. Listening, turn-taking and speaking all run on this computer, with your own model.' },
  gpt_live: { title: 'GPT-Live', line: 'About 5 cents a minute on your OpenAI key. During calls and Open Mic your voice goes to OpenAI.' },
  elevenlabs: { title: 'ElevenLabs', line: 'About 4 cents a minute of speech on your ElevenLabs key. Every spoken sentence goes to ElevenLabs.' },
  voicebox: { title: 'Voicebox', line: 'Free and private, on a Voicebox you run on this computer. Change it under More options.' },
  compatible: { title: 'Voice server on this computer', line: 'Free and private, on a voice server you run. Change it under More options.' },
};
export const APPLIES = 'Calls, Open Mic, replies read aloud, voice notes, phone calls and Discord voice all use this. A bot can still have its own voice or call mode: open the bot, then Voice.';
export const ELEVENLABS_COST = 'Cost: ElevenLabs bills your account by characters spoken. At its API rates Flash costs about $0.04 per '
  + '1,000 characters, roughly 4 cents a minute of speech, and Multilingual v2 about twice that; credits in your plan are used first. '
  + 'Kairos also renders a few short acknowledgements once per voice and keeps them.';
export const ELEVENLABS_PRIVACY = 'Privacy: every sentence Kairos speaks is sent to ElevenLabs, which keeps it in your history under '
  + 'its own terms. Listening stays on this computer. For private calls use Kairos Voice.';
export const GPT_LIVE_NOTE = 'GPT-Live hears you and answers in its own voice, and hands real work to your bot. OpenAI bills about $0.05 a '
  + 'minute, per second; the work your bot does is billed by its own model. Replies read aloud outside a call use Kairos Voice.';
export const VOICEBOX_NOTE = 'Voicebox is a free, open source voice studio (MIT) with cloned and designed voices. Install and open it '
  + 'yourself; Kairos only connects to it on this computer and never installs it. Nothing leaves this computer. Voicebox makes each '
  + 'sentence whole before it plays, so replies start a little later than with Kairos Voice.';

function keyInput(label, placeholder, hook) {
  return el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': label, placeholder, 'data-voice-engine': hook });
}

function status() {
  const node = el('p', { class: 'free-voice-status', role: 'status' });
  node.say = (text, tone = '') => { node.textContent = text; if (tone) node.dataset.tone = tone; else delete node.dataset.tone; };
  return node;
}

// The Voice choice: one radio per option, a short cost and privacy line each, and the inline setup the picked one needs.
// `kokoroReady` comes from GET /api/speech/status (the Kokoro readiness row). onChanged(state) runs after any change.
export function voiceChoice(state, { kokoroReady = false, onChanged = () => {}, request = api } = {}) {
  const said = status();
  const pending = { value: state.choice };
  const setups = el('div', { class: 'speech-voice-setup' });
  const options = ['kairos', 'gpt_live', 'elevenlabs', ...(['voicebox', 'compatible'].includes(state.choice) ? [state.choice] : [])];
  const radios = options.map(id => {
    const input = el('input', { type: 'radio', name: 'speech-voice-choice', value: id, 'data-voice-choice': id });
    input.checked = id === state.choice;
    const hint = id === 'kairos' ? (kokoroReady ? 'Speaking with Kokoro on this computer.' : 'Speaking with this device\'s voice until the Kokoro voice is downloaded under More options.')
      : id === 'gpt_live' && !state.gpt_live?.available ? 'Add your OpenAI key to use it.'
      : id === 'elevenlabs' && !state.elevenlabs?.has_key ? 'Add your ElevenLabs key to use it.' : '';
    input.addEventListener('change', () => pick(id));
    return el('label', { class: 'speech-voice-option', 'data-voice-option': id }, [input,
      el('span', { class: 'speech-voice-option-text' }, [el('span', { class: 'speech-voice-option-title', text: CHOICE_COPY[id].title }),
        el('span', { class: 'speech-voice-option-line', text: CHOICE_COPY[id].line }),
        ...(hint ? [el('span', { class: 'speech-voice-option-status meta', text: hint })] : [])])]);
  });
  const ready = id => id === 'kairos' || (id === 'gpt_live' && state.gpt_live?.available) || (id === 'elevenlabs' && state.elevenlabs?.has_key) || id === state.choice;
  async function pick(id) {
    pending.value = id;
    drawSetup();
    if (!ready(id) || id === state.choice) return;
    said.say('Saving...');
    try { const next = await request('/api/voice-engines/choice', { method: 'PUT', toast: false, body: JSON.stringify({ choice: id }) }); said.say(`${CHOICE_COPY[id].title} is your voice now.`, 'ok'); onChanged(next); }
    catch (error) { said.say(error?.message || 'The voice could not be changed.', 'error'); }
  }
  function drawSetup() {
    const id = pending.value;
    setups.replaceChildren(...(id === 'gpt_live' ? [openAiKeySetup(state, { onChanged, request })] : id === 'elevenlabs' ? [elevenLabsSetup(state, { onChanged, request })] : []));
  }
  drawSetup();
  const notice = state.notice ? el('div', { class: 'speech-voice-notice', role: 'status' }, [el('span', { text: state.notice }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Dismiss', 'data-voice-engine': 'notice-dismiss', onclick: async () => {
      try { onChanged(await request('/api/voice-engines/notice/dismiss', { method: 'POST', toast: false })); } catch { notice.remove(); }
    } })]) : null;
  return el('div', { class: 'speech-voice-choice-body', role: 'radiogroup', 'aria-label': 'Voice' }, [...(notice ? [notice] : []), ...radios, setups, said]);
}

// GPT-Live's one step: paste an OpenAI key; it is checked (nothing spoken or billed), saved as a connection, and used.
export function openAiKeySetup(state, { onChanged = () => {}, request = api } = {}) {
  const live = state.gpt_live || {};
  const said = status();
  if (live.available) {
    return el('div', { class: 'free-voice-setup voice-engine-setup', 'data-voice-engine': 'gpt-live' }, [
      el('p', { class: 'free-voice-limits', text: GPT_LIVE_NOTE }),
      el('p', { class: 'free-voice-limits', text: 'Not checked against the live service yet: built from OpenAI\'s published Live guides.' })]);
  }
  const input = keyInput('OpenAI API key', 'Paste your OpenAI API key', 'openai-key');
  const save = el('button', { type: 'button', class: 'btn primary', text: 'Check and use', 'data-voice-engine': 'openai-save' });
  save.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) { said.say('Paste the key first.', 'error'); input.focus(); return; }
    save.disabled = true; said.say('Asking OpenAI whether the key works...');
    try { const next = await request('/api/voice-engines/openai', { method: 'PUT', toast: false, body: JSON.stringify({ api_key: key }) }); input.value = ''; said.say('GPT-Live is your voice now.', 'ok'); onChanged(next); }
    catch (error) { said.say(error?.message || 'The key could not be saved.', 'error'); }
    finally { save.disabled = false; }
  });
  return el('div', { class: 'free-voice-setup voice-engine-setup', 'data-voice-engine': 'gpt-live' }, [
    el('ol', { class: 'free-voice-steps' }, [
      el('li', {}, ['Sign in at OpenAI and open API keys. ', el('a', { href: live.key_page || 'https://platform.openai.com/api-keys', target: '_blank', rel: 'noopener', class: 'set-link', text: 'Open OpenAI API keys' })]),
      el('li', { text: 'Create a key, copy it and paste it here, then choose Check and use. Checking costs nothing.' }),
    ]),
    el('div', { class: 'free-voice-key' }, [input, save]), said,
    el('p', { class: 'free-voice-limits', text: GPT_LIVE_NOTE }),
  ]);
}

// The ElevenLabs key. onChanged(state) runs after a save, removal or switch.
export function elevenLabsSetup(state, { onChanged = () => {}, request = api } = {}) {
  const own = state.elevenlabs || {};
  const active = state.choice === 'elevenlabs';
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
      else if (own.has_key) next = await request('/api/voice-engines/choice', { method: 'PUT', toast: false, body: JSON.stringify({ choice: 'elevenlabs' }) });
      else { said.say('Paste the key first.', 'error'); input.focus(); return; }
      input.value = '';
      said.say('ElevenLabs is your voice now. Pick a voice from your account under More options, or in a bot\'s Voice settings.', 'ok');
      onChanged(next);
    } catch (error) { said.say(error?.message || 'The key could not be saved.', 'error'); }
    finally { busy(false); }
  });
  if (own.has_key) {
    const forget = el('button', { type: 'button', class: 'btn quiet', text: 'Remove key', 'data-voice-engine': 'elevenlabs-forget' });
    forget.addEventListener('click', async () => {
      busy(true);
      try { const next = await request('/api/voice-engines/elevenlabs', { method: 'DELETE', toast: false }); said.say('Key removed. Kairos Voice speaks now.', 'ok'); onChanged(next); }
      catch (error) { said.say(error?.message || 'The key could not be removed.', 'error'); }
      finally { busy(false); }
    });
    actions.push(forget);
  }
  return el('div', { class: 'free-voice-setup voice-engine-setup', 'data-voice-engine': 'elevenlabs' }, [
    ...(active || own.has_key ? [el('p', { class: 'meta', text: active ? 'In use: ElevenLabs speaks for Kairos.' : 'Key saved. Not in use right now.' })] : []),
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

// More options: a Voicebox the person runs (an admin connects it, local addresses only).
export function voiceboxSetup(state, { isAdmin = false, onChanged = () => {}, request = api } = {}) {
  const own = state.voicebox || {};
  const active = state.choice === 'voicebox';
  const url = el('input', { type: 'url', 'aria-label': 'Voicebox address', value: own.url || 'http://127.0.0.1:17493', placeholder: 'http://127.0.0.1:17493', 'data-voice-engine': 'voicebox-url' });
  const said = status();
  const check = el('button', { type: 'button', class: 'btn quiet', text: 'Check', 'data-voice-engine': 'voicebox-check' });
  const save = el('button', { type: 'button', class: 'btn primary', text: 'Check and use', 'data-voice-engine': 'voicebox-save' });
  const body = () => JSON.stringify({ url: url.value.trim() });
  const busy = value => { check.disabled = save.disabled = value; };
  check.addEventListener('click', async () => {
    busy(true); said.say('Looking for Voicebox...');
    try { const result = await request('/api/voice-engines/voicebox/check', { method: 'POST', toast: false, body: body() }); said.say(`Voicebox is running with ${result.voices} voice${result.voices === 1 ? '' : 's'}. Nothing was spoken.`, 'ok'); }
    catch (error) { said.say(error?.message || 'Voicebox could not be checked.', 'error'); }
    finally { busy(false); }
  });
  save.addEventListener('click', async () => {
    busy(true); said.say('Checking Voicebox, then saving...');
    try { const next = await request('/api/voice-engines/voicebox', { method: 'PUT', toast: false, body: body() }); said.say('Voicebox is your voice now. Pick one of its voices in the voice picker below, or in a bot\'s Voice settings.', 'ok'); onChanged(next); }
    catch (error) { said.say(error?.message || 'Voicebox could not be saved.', 'error'); }
    finally { busy(false); }
  });
  return el('div', { class: 'free-voice-setup voice-engine-setup', 'data-voice-engine': 'voicebox' }, [
    ...(active ? [el('p', { class: 'meta', text: `In use: Voicebox at ${own.url}.` })] : []),
    el('p', { class: 'free-voice-limits' }, [VOICEBOX_NOTE, ' ', el('a', { href: own.repo || 'https://github.com/jamiepine/voicebox', target: '_blank', rel: 'noopener', class: 'set-link', text: 'Voicebox on GitHub' })]),
    ...(isAdmin ? [el('div', { class: 'free-voice-key' }, [url, check, save]), said] : [el('p', { class: 'meta', text: 'An admin can connect Voicebox.' })]),
    el('p', { class: 'free-voice-limits', text: 'Not checked against a running Voicebox yet: built from its published source.' }),
  ]);
}

// More options: another OpenAI-compatible voice server on this computer, with voice names for one that does not list them.
export function compatibleSetup(state, { isAdmin = false, onChanged = () => {}, request = api } = {}) {
  const own = state.compatible || {};
  if (!isAdmin) return el('p', { class: 'meta', text: 'An admin can connect another voice server on this computer.' });
  const url = el('input', { type: 'url', 'aria-label': 'Voice server address', value: own.url || '', placeholder: 'http://127.0.0.1:8000', 'data-voice-engine': 'compatible-url' });
  const names = el('input', { type: 'text', 'aria-label': 'Voice names', value: (own.voices || []).join(', '), placeholder: 'Voice names, only if it does not list them', 'data-voice-engine': 'compatible-voices' });
  const said = status();
  const save = el('button', { type: 'button', class: 'btn quiet', text: 'Use this server', 'data-voice-engine': 'compatible-save' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { const next = await request('/api/voice-engines/compatible', { method: 'PUT', toast: false, body: JSON.stringify({ url: url.value.trim(), voices: names.value }) }); said.say('That voice server is your voice now.', 'ok'); onChanged(next); }
    catch (error) { said.say(error?.message || 'The voice server could not be saved.', 'error'); }
    finally { save.disabled = false; }
  });
  return el('div', { class: 'free-voice-setup voice-engine-setup', 'data-voice-engine': 'compatible' }, [
    el('p', { class: 'free-voice-limits', text: 'Any voice server on this computer that speaks the OpenAI speech API. If it cannot list its voices, type their names, separated by commas.' }),
    el('div', { class: 'free-voice-key' }, [url, names, save]), said]);
}
