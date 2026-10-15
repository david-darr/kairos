import { api, el } from './api.js';

// 2026-10-14: one native, keyboard accessible control for both bot editors.
// Polls call sync(), which leaves a draft and its focused control in place.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const selection = agent => ({ endpoint_id: agent?.endpoint_id || null,
  model_override: agent?.model_override ?? null, model_effort: agent?.model_effort ?? null });

export function agentModelSummary(agent, models, catalog = []) {
  const endpoint = models.find(item => item.id === agent?.endpoint_id);
  const id = agent?.model_override;
  const entry = catalog.find(item => item.id === id || item.alias === id);
  const version = id == null ? endpoint?.model || 'Default model' : (entry?.display_name || id || 'CLI default');
  return `${endpoint?.name || 'Claude (default)'} · ${version}${agent?.model_effort ? ` · ${agent.model_effort}` : ''}`;
}

export function agentModelPicker(models, initial = {}, onChange = () => {}) {
  let baseline = selection(initial), server = baseline, catalog = [], generation = 0;
  const connection = el('select', { 'aria-label': 'Connection' }, [
    el('option', { value: '', text: 'Claude (default)' }),
    ...models.map(item => el('option', { value: item.id, text: item.name })),
  ]);
  const version = el('select', { 'aria-label': 'Model version' });
  const custom = el('input', { type: 'text', maxlength: '160', placeholder: 'Exact model ID',
    'aria-label': 'Custom model ID', autocomplete: 'off', spellcheck: 'false' });
  const effort = el('select', { 'aria-label': 'Reasoning' });
  const summary = el('p', { class: 'meta agent-model-summary' });
  const root = el('div', { class: 'agent-model-picker' }, [
    el('label', { class: 'field agent-profile-field' }, [el('span', { text: 'Connection' }), connection]),
    el('label', { class: 'field agent-profile-field' }, [el('span', { text: 'Model' }), version]),
    el('label', { class: 'field agent-profile-field' }, [el('span', { text: 'Custom model ID' }), custom]),
    el('label', { class: 'field agent-profile-field' }, [el('span', { text: 'Reasoning' }), effort]), summary,
  ]);
  const current = () => ({ endpoint_id: connection.value || null,
    model_override: version.value === '__custom__' ? custom.value.trim() : version.value || null,
    model_effort: effort.value || null });
  const publish = (changed = false) => { summary.textContent = agentModelSummary(current(), models, catalog); if (changed) onChange(); };
  const fillEffort = (wanted = null) => {
    const picked = current().model_override;
    const endpoint = models.find(item => item.id === connection.value);
    const effective = picked === null ? endpoint?.model : picked;
    const known = catalog.find(item => item.id === effective || item.alias === effective);
    const levels = known?.supported_efforts || [];
    effort.replaceChildren(el('option', { value: '', text: known?.default_effort
      ? `Provider default (${known.default_effort})` : 'Provider default' }),
      ...levels.map(item => el('option', { value: item.effort, text: item.effort, title: item.description || '' })));
    effort.value = wanted && levels.some(item => item.effort === wanted) ? wanted : '';
    effort.closest('label').hidden = !levels.length;
    custom.closest('label').hidden = version.value !== '__custom__';
    publish();
  };
  const load = async (wanted = null, wantedEffort = null) => {
    const stamp = ++generation, id = connection.value;
    const endpoint = models.find(item => item.id === id);
    const selectable = endpoint && ['claude_cli', 'codex_cli', 'api'].includes(endpoint.kind);
    version.disabled = true;
    const entries = selectable ? await api(`/api/models/${id}/catalog`).catch(() => []) : [];
    if (stamp !== generation || connection.value !== id) return;
    catalog = entries;
    version.replaceChildren(el('option', { value: '', text: "Use the connection's default" }),
      ...entries.map(item => el('option', { value: item.id, text: item.display_name, title: item.description || '' })),
      ...(selectable ? [el('option', { value: '__custom__', text: 'Custom model ID' })] : []));
    version.value = wanted == null ? '' : entries.some(item => item.id === wanted) ? wanted : '__custom__';
    custom.value = version.value === '__custom__' ? wanted : '';
    version.disabled = !selectable;
    fillEffort(wantedEffort);
  };
  connection.addEventListener('change', () => {
    // 2026-10-14: drop the previous connection's selection immediately;
    // a slow catalog request must not let Save submit its stale version.
    catalog = []; version.replaceChildren(el('option', { value: '', text: "Use the connection's default" }));
    custom.value = ''; effort.value = ''; custom.closest('label').hidden = true;
    effort.closest('label').hidden = true;
    load(); publish(true);
  });
  version.addEventListener('change', () => { fillEffort(); publish(true); if (version.value === '__custom__') custom.focus(); });
  custom.addEventListener('input', () => publish(true));
  effort.addEventListener('change', () => publish(true));
  const assign = value => { connection.value = value.endpoint_id || ''; load(value.model_override, value.model_effort); };
  assign(baseline);
  return { root, get: current, isDirty: () => !same(current(), baseline),
    sync(agent) { const next = selection(agent); server = next;
      if (!this.isDirty() && !root.contains(document.activeElement)) { baseline = next; assign(next); }
    },
    markSaved(agent) { baseline = selection(agent); server = baseline; assign(baseline); },
    serverChanged: () => !same(server, baseline),
    baseline: () => baseline,
  };
}
