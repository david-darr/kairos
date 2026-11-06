import { api, el, toast } from '../api.js';
import { group, row, field, note, pill, toggle } from '../settingsKit.js';

// Settings > Personal > Phone (build spec step 8): talk to a bot on the phone, and let a bot call or text you, through
// YOUR OWN Twilio or Telnyx number. Kairos never buys a number or opens a provider account; the person does that with
// the provider, then enters it here. Everything is saved for this account only and the keys are sealed.

const PROVIDERS = [['twilio', 'Twilio'], ['telnyx', 'Telnyx']];
const FIELDS = {
  twilio: [['account_sid', 'Account SID', false, 'AC...'], ['auth_token', 'Auth token', true, '']],
  telnyx: [['api_key', 'API key', true, ''], ['public_key', 'Webhook public key', false, 'From your Telnyx account, under Keys and Credentials.'],
           ['connection_id', 'Call control application ID', false, 'The application your number is assigned to.']],
};

const errorText = (error) => (error && error.message) || 'That could not be saved.';

export async function renderPhonePanel(content) {
  const root = el('section', { class: 'phone-panel' });
  content.append(root);
  const [state, bots, choices] = await Promise.all([
    api('/api/phone').catch(() => ({ connection: { configured: false } })),
    api('/api/agents').catch(() => []),
    api('/api/agent-calls/choices').catch(() => []),
  ]);
  const saved = state.connection || { configured: false };
  const values = { provider: saved.provider || 'twilio' };

  function input(key, type = 'text', placeholder = '') {
    const node = el('input', { type, placeholder, autocomplete: 'off', 'aria-label': key, 'data-phone': key });
    if (type !== 'password' && saved[key]) node.value = saved[key];
    node.addEventListener('input', () => { values[key] = node.value; });
    return node;
  }

  const provider = el('select', { 'aria-label': 'Provider', 'data-phone': 'provider' },
    PROVIDERS.map(([id, label]) => el('option', { value: id, text: label })));
  provider.value = values.provider;
  const status = el('span', { class: 'meta', role: 'status' });
  const keys = el('div', { class: 'phone-keys' });

  function drawKeys() {
    keys.replaceChildren(...FIELDS[values.provider].map(([key, label, secret, help]) => {
      const node = input(key, secret ? 'password' : 'text', secret && saved.secrets_set?.[key] ? 'Saved. Leave empty to keep it.' : help);
      return field(label, node, secret ? 'Sealed with your account key and never shown again.' : '');
    }));
  }
  provider.addEventListener('change', () => { values.provider = provider.value; drawKeys(); });
  drawKeys();

  const botSelect = el('select', { 'aria-label': 'Bot that answers', 'data-phone': 'bot_id' }, [
    el('option', { value: '', text: 'Kip (default)' }),
    ...bots.filter(b => !b.hidden).map(b => el('option', { value: b.id, text: b.name })),
  ]);
  botSelect.value = saved.bot_id || '';
  botSelect.addEventListener('change', () => { values.bot_id = botSelect.value; });

  const modelSelect = el('select', { 'aria-label': 'Conversation model', 'data-phone': 'conversation_endpoint_id' }, [
    el('option', { value: '', text: choices.length ? 'Choose a fast model' : 'Add an API or local model first' }),
    ...choices.map(c => el('option', { value: c.id, text: `${c.name} (${c.model})`, 'data-model': c.model })),
  ]);
  modelSelect.value = saved.conversation_endpoint_id || '';
  modelSelect.addEventListener('change', () => {
    values.conversation_endpoint_id = modelSelect.value;
    values.conversation_model = modelSelect.selectedOptions[0]?.dataset.model || '';
  });

  const pinWarning = note('Warning: with the PIN off, anyone who can fake your caller ID can talk to your bots as you. Caller ID is easy to fake. Keep this on.', 'set-error');
  const requirePin = toggle({ checked: saved.configured ? saved.require_pin !== false : true, label: 'Ask for the PIN on incoming calls',
    onChange: async (on) => { values.require_pin = on; pinWarning.hidden = on; if (saved.configured) await api('/api/phone', { method: 'PUT', body: JSON.stringify({ require_pin: on }) }); } });
  pinWarning.hidden = requirePin.checked;

  async function save() {
    status.textContent = '';
    try {
      const result = await api('/api/phone', { method: 'PUT', toast: false, body: JSON.stringify(values) });
      toast('Phone saved', 'success');
      content.replaceChildren();
      await renderPhonePanel(content);
      return result;
    } catch (error) { status.textContent = errorText(error); }
  }
  const saveButton = el('button', { type: 'button', class: 'btn primary', text: saved.configured ? 'Save changes' : 'Save', onclick: save });
  const remove = el('button', { type: 'button', class: 'btn quiet danger', text: 'Remove', onclick: async () => {
    await api('/api/phone', { method: 'DELETE' });
    content.replaceChildren();
    await renderPhonePanel(content);
  } });

  const enabled = toggle({ checked: saved.configured ? saved.enabled !== false : true, label: 'Phone on',
    onChange: async (on) => { values.enabled = on; if (saved.configured) await api('/api/phone', { method: 'PUT', body: JSON.stringify({ enabled: on }) }); } });

  const paths = saved.webhook_paths;
  root.append(
    group({ title: 'Your phone number', description: 'Call a bot from your own mobile, and let your bots call or text you. It runs through your own Twilio or Telnyx account and number, so you pay them directly. Kairos never buys a number or signs up for anything.' }, [
      row({ title: 'Provider', control: provider }),
      row({ title: 'Phone', description: saved.configured ? (saved.calls_ready ? 'Ready for calls and texts.' : 'Texts only: add your public address to take calls.') : 'Not set up.',
        control: saved.configured ? [pill(saved.enabled === false ? 'Off' : (saved.calls_ready ? 'On' : 'Texts only'), saved.enabled === false ? 'muted' : 'ok'), enabled] : enabled }),
    ]),
    group({ title: 'Provider keys' }, [keys]),
    group({ title: 'Numbers' }, [
      field('Your Kairos number', input('number', 'text', '+15551234567'), 'The number you bought, with its country code. Bots answer here.'),
      field('Your own mobile', input('user_number', 'text', '+15557654321'), 'Only this number can call in, and it is the only number a bot will ever call or text.'),
    ]),
    group({ title: 'Reaching Kairos' }, [
      field('Public address', input('public_url', 'text', 'https://my-pc.tailnet.ts.net:8422'),
        'An https address your provider can reach, such as one from Remote Access or your own tunnel. Kairos does not open one for you. Leave empty for texts only.'),
      paths ? row({ title: 'Paste into your provider', description: paths.voice, stack: true }) : null,
    ]),
    group({ title: 'Incoming call PIN', description: 'Caller ID can be faked, so when you call in, Kairos asks for this PIN on the keypad (then #) before it connects you. Three tries a call, and five wrong tries in an hour lock incoming calls. Calls Kairos places to you never ask.' }, [
      field('PIN (4 to 8 digits)', input('pin', 'password', saved.pin_set ? 'Saved. Leave empty to keep it.' : '4 to 8 digits'), 'Stored hashed and never shown again.'),
      row({ title: 'Ask for the PIN', description: 'Turn this off only if you accept the risk below.', control: requirePin }),
      pinWarning,
    ]),
    group({ title: 'Who answers' }, [
      row({ title: 'Bot', description: 'Which bot picks up when you call.', control: botSelect }),
      row({ title: 'Conversation model', description: 'A fast API or local model, like the one used in app calls.', control: modelSelect }),
    ]),
    note('Calls from a bot always start with "This is <bot>, an AI assistant from Kairos." and go only to your mobile. Calls to anyone else are not available.'),
    el('div', { class: 'set-row-actions' }, [status, saved.configured ? remove : null, saveButton]),
  );
  if (saved.conversation_model) values.conversation_model = saved.conversation_model;
}
