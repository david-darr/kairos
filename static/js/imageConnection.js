import { api, el, toast, confirmDialog } from './api.js';
import { group, row, note } from './settingsKit.js';

const PROVIDERS = {
  openai: { label: 'OpenAI', model: 'gpt-image-1' },
  xai: { label: 'xAI', model: 'grok-2-image' },
  compatible: { label: 'Compatible server', model: '' },
};
const messageOf = error => String(error?.message || error).replace(/^\d+:\s*/, '');

export async function renderImageConnection(body) {
  const root = el('div', { class: 'image-connection' });
  const status = el('p', { class: 'set-note', role: 'status', text: 'Checking connection...' });
  const result = el('p', { class: 'set-note', role: 'status' });
  body.append(root);
  root.append(status, result);
  let state;
  try { state = await api('/api/image-provider'); }
  catch (error) { result.textContent = messageOf(error); status.textContent = 'Could not read the image connection.'; return; }

  function draw() {
    const usage = state.daily_limit ? `${state.used_today} of ${state.daily_limit} images today.` : `${state.used_today} images today. No daily limit.`;
    status.textContent = state.configured
      ? `Connected: ${PROVIDERS[state.kind]?.label || state.kind}, ${state.model}. ${usage}`
      : 'Not connected. Designs use openly licensed photos, your own photos and patterns instead.';
    const provider = el('select', { id: 'image-provider-kind' }, Object.entries(PROVIDERS).map(([value, p]) => el('option', { value, text: p.label })));
    provider.value = state.kind || 'openai';
    const key = el('input', { id: 'image-provider-key', type: 'password', autocomplete: 'off', placeholder: state.configured ? 'Saved. Paste a new key to replace it' : 'Paste the key' });
    const address = el('input', { id: 'image-provider-address', type: 'url', value: state.kind === 'compatible' ? state.base_url || '' : '' });
    const model = el('input', { id: 'image-provider-model', value: state.model || PROVIDERS[provider.value].model });
    const limit = el('input', { id: 'image-provider-limit', type: 'number', min: '0', max: '500', step: '1', value: String(state.daily_limit ?? 50) });
    const field = (label, input, description) => row({ title: el('label', { for: input.id, text: label }), description, control: input });
    const addressRow = field('Address', address);
    const showAddress = () => { addressRow.hidden = provider.value !== 'compatible'; address.required = !addressRow.hidden; model.required = !addressRow.hidden; };
    provider.addEventListener('change', () => { model.value = PROVIDERS[provider.value].model; showAddress(); });
    showAddress();
    const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save' });
    const test = state.configured ? el('button', { type: 'button', class: 'btn', text: 'Test connection', onclick: () => run(async () => {
      const answer = await api('/api/image-provider/test', { method: 'POST', toast: false });
      result.textContent = answer.ok ? 'Works' : answer.error || 'Could not test the connection.';
    }) }) : null;
    const remove = state.configured ? el('button', { type: 'button', class: 'btn danger', text: 'Remove', onclick: async () => {
      if (!await confirmDialog({ title: 'Remove image connection?', message: 'Designs will use photos and patterns instead.', confirmLabel: 'Remove' })) return;
      await run(async () => { state = await api('/api/image-provider', { method: 'DELETE', toast: false }); result.textContent = 'Connection removed.'; draw(); });
    } }) : null;
    const form = el('form', {}, [group({ title: 'Image connection' }, [field('Provider', provider), field('Key', key), addressRow,
      field('Model', model), field('Daily limit', limit, '0 turns the limit off'),
      row({ title: 'Connection', control: [save, test, remove] })])]);
    async function run(action) {
      result.textContent = '';
      const controls = [...form.querySelectorAll('input, select, button')];
      controls.forEach(control => { control.disabled = true; });
      try { await action(); }
      catch (error) { result.textContent = messageOf(error); }
      finally { controls.forEach(control => { control.disabled = false; }); }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      const dailyLimit = Number(limit.value);
      if (!limit.value.trim() || !Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 500) { result.textContent = 'Choose a daily limit from 0 to 500.'; return; }
      const unchanged = state.configured && provider.value === state.kind && model.value.trim() === state.model &&
        (provider.value !== 'compatible' || address.value.trim() === state.base_url);
      if ((!state.configured || !unchanged) && !key.value.trim()) { result.textContent = 'Paste the connection key.'; return; }
      const payload = unchanged && !key.value.trim() ? { daily_limit: dailyLimit } : {
        kind: provider.value, key: key.value.trim(), model: model.value.trim(), daily_limit: dailyLimit,
        ...(provider.value === 'compatible' ? { base_url: address.value.trim() } : {}),
      };
      run(async () => {
        state = await api('/api/image-provider', { method: 'PUT', body: JSON.stringify(payload), toast: false });
        key.value = ''; result.textContent = 'Connection saved.'; toast('Image connection saved', 'success'); draw();
      });
    });
    root.replaceChildren(status, form, result, note('Images are made with your own key and billed by the provider. Kairos never shows the key again.'));
  }
  draw();
}
