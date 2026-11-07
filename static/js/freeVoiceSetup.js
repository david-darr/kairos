// Free realtime voice (core/free_voice.py): a guided setup for a free Gemini API key from Google AI Studio, so realtime
// speech-to-speech works without paying. Shown in Settings > Speech and where a person first picks Realtime for a call.
// The person makes the key; Kairos only checks it with Google and saves it sealed in their account.
import { api, el } from './api.js';

export const KEY_PAGE = 'https://aistudio.google.com/apikey';

export const LIMITS_TEXT = 'What free means: Google charges nothing on its free tier, but it limits how much you can use per minute and '
  + 'per day, and it sets and changes those limits. When you reach one, realtime calls stop working until it resets; Local '
  + 'mode keeps working. On the free tier Google may use what you send, call audio included, to improve its products, so use '
  + 'Local mode or a paid key for private calls. It is not offered in every country. If you turn on billing for the key\'s '
  + 'Google project, Google charges for use.';

// The setup itself, as one block. onConnected(status) runs after a key was checked and saved.
export function freeVoiceSetup({ onConnected = () => {}, request = api, configured = false } = {}) {
  const input = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Gemini API key',
    placeholder: configured ? 'Connected. Paste a new key to replace it.' : 'Paste your Gemini API key', 'data-free-voice': 'key' });
  const status = el('p', { class: 'free-voice-status', role: 'status' });
  const connect = el('button', { type: 'button', class: 'btn primary', text: 'Check and connect', 'data-free-voice': 'connect' });
  const say = (text, tone = '') => { status.textContent = text; if (tone) status.dataset.tone = tone; else delete status.dataset.tone; };
  async function submit() {
    const key = input.value.trim();
    if (!key) { say('Paste the key first.', 'error'); input.focus(); return; }
    connect.disabled = true;
    say('Checking the key with Google...');
    try {
      const result = await request('/api/models/free-voice', { method: 'POST', toast: false, body: JSON.stringify({ api_key: key }) });
      input.value = '';
      say(`Connected. Realtime voice can now use Gemini on your free key (${result.model}). Choose Realtime as a bot's call mode, or in a call's setup.`, 'ok');
      onConnected(result);
    } catch (error) {
      say((error && error.message) || 'That key could not be connected.', 'error');
    } finally { connect.disabled = false; }
  }
  connect.addEventListener('click', submit);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
  return el('div', { class: 'free-voice-setup' }, [
    el('ol', { class: 'free-voice-steps' }, [
      el('li', {}, ['Open Google AI Studio and sign in with your Google account. ',
        el('a', { href: KEY_PAGE, target: '_blank', rel: 'noopener', class: 'set-link', text: 'Open Google AI Studio' })]),
      el('li', { text: 'Choose Create API key. If it asks for a project, let it make one. No card is needed.' }),
      el('li', { text: 'Copy the key, paste it here, and choose Check and connect. Kairos asks Google whether the key works and offers a Live voice model, then keeps it sealed in your account.' }),
    ]),
    el('div', { class: 'free-voice-key' }, [input, connect]),
    status,
    el('p', { class: 'free-voice-limits', text: LIMITS_TEXT }),
  ]);
}

// The same setup in a dialog, for the call screen and a bot's call mode.
export function openFreeVoiceSetup({ onConnected = () => {}, doc = document } = {}) {
  const dialog = el('dialog', { class: 'free-voice-dialog', 'aria-label': 'Free realtime voice' });
  const close = el('button', { type: 'button', class: 'btn quiet', text: 'Close', onclick: () => dialog.close() });
  dialog.append(
    el('h2', { text: 'Free realtime voice with Gemini' }),
    el('p', { class: 'meta', text: 'Realtime voice is the quickest, most natural back-and-forth. With a free Gemini key from Google it costs nothing.' }),
    freeVoiceSetup({ onConnected: result => { onConnected(result); } }),
    el('div', { class: 'set-row-actions' }, [close]));
  dialog.addEventListener('close', () => dialog.remove());
  doc.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  return dialog;
}
