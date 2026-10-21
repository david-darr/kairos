import { api, el, toast, customSelect } from '/static/js/api.js';

export function mountRobloxStylePanel(host, pid, isCurrent = () => host.isConnected) {
  const url = `/api/tab-roblox/projects/${pid}/style`;
  let generation = 0;
  const note = text => el('p', { class: 'meta', text });
  const button = (text, run) => {
    const node = el('button', { type: 'button', class: 'btn', text });
    node.onclick = async () => { node.disabled = true;
      try { await run(); } catch (error) { if (isCurrent()) toast(error.message, 'error'); }
      finally { node.disabled = false; }
    }; return node;
  };
  const field = (label, node) => el('label', { class: 'roblox-field' }, [el('span', { text: label }), node]);
  const input = (label, value = '') => el('input', { type: 'text', 'aria-label': label, value });
  async function update(body) {
    const state = await api(url, { method: 'PUT', body: JSON.stringify(body) });
    if (isCurrent()) draw(state);
  }
  function draw(state) {
    generation++;
    const preset = customSelect({ 'aria-label': 'Style preset' }, state.presets.map(name => el('option', { value: name, text: name })));
    preset.value = state.name;
    preset.onchange = () => update({ action: 'preset', preset: preset.value }).catch(error => toast(error.message, 'error'));
    const newName = input('New style preset'); newName.placeholder = 'new-preset';
    const learning = el('input', { type: 'checkbox', 'aria-label': 'Learn style suggestions' }); learning.checked = state.learning;
    learning.onchange = () => update({ action: 'learning', learning: learning.checked }).catch(error => toast(error.message, 'error'));
    host.replaceChildren(el('h3', { text: 'Your growing style skill' }),
      note(`Private to your Kairos user and ${state.account_id === 'local' ? 'local Roblox projects' : 'Roblox account ' + state.account_id}. Revision ${state.revision}.`),
      note('Current prompts and references take precedence. Suggestions need your acceptance. Use “Remember my UI colors: …” or “Remember my model materials: …” to save an explicit preference from chat.'),
      field('Preset', preset), field('New preset name', newName),
      button('Create style preset', () => update({ action: 'preset', preset: newName.value.trim() })),
      el('label', {}, [learning, 'Learn style suggestions']),
      button('Refresh style suggestions', refresh));
    const category = customSelect({ 'aria-label': 'Preference category' }, [el('option', { value: 'ui', text: 'UI' }), el('option', { value: 'model', text: 'Models' })]);
    const key = input('Preference name'), value = el('textarea', { rows: 2, maxlength: 500, 'aria-label': 'Preference value' });
    const local = el('input', { type: 'checkbox' });
    host.append(field('Category', category), field('Preference name', key), field('Preference value', value),
      el('label', {}, [local, 'Only this project']), button('Save preference', () => update({ action: 'add', category: category.value,
        key: key.value, value: value.value, project_only: local.checked })));
    for (const entry of state.entries) {
      const edit = el('textarea', { rows: 2, maxlength: 500, 'aria-label': `Edit ${entry.key}` }); edit.value = entry.value;
      const actions = el('div', { class: 'roblox-row' });
      if (entry.status === 'suggested') actions.append(button('Accept suggestion', () => update({ action: 'confirm', entry_id: entry.id })));
      else actions.append(button(entry.locked ? 'Unlock' : 'Lock', () => update({ action: 'lock', entry_id: entry.id, locked: !entry.locked })));
      if (!entry.locked) actions.append(button('Save edit', () => update({ action: 'edit', entry_id: entry.id, value: edit.value })),
        button('Forget', () => update({ action: 'forget', entry_id: entry.id })));
      host.append(el('details', { class: 'roblox-event' }, [el('summary', { text: `${entry.category} · ${entry.key} · ${entry.status}${entry.locked ? ' · locked' : ''}` }),
        edit, ...(entry.quote ? [note('Evidence: ' + entry.quote)] : []), actions]));
    }
    if (state.project_overrides.length) host.append(el('details', {}, [el('summary', { text: 'Project overrides' }),
      ...state.project_overrides.map(entry => note(`${entry.category} · ${entry.key}: ${entry.value}`)),
      button('Clear project overrides', () => update({ action: 'clear_project' }))]));
    const history = el('details', {}, [el('summary', { text: 'Style history' })]);
    for (const version of [...state.history].reverse()) history.append(button(`Restore revision ${version.revision}`, () => update({ action: 'restore', revision: version.revision })));
    host.append(history, el('details', {}, [el('summary', { text: 'View the style skill used by AI' }), el('pre', { text: state.skill })]));
  }
  async function refresh() {
    const current = ++generation;
    const state = await api(url);
    if (current === generation && isCurrent()) draw(state);
  }
  refresh().catch(error => { if (isCurrent()) host.replaceChildren(note(error.message)); });
  return refresh;
}
