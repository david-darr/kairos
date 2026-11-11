import { el } from './api.js';
import { selection, counts, summaryText } from './botsPackageModel.js';

export function renderPreview(preview, { onChange = () => {}, selectable = true } = {}) {
  const picked = selection(preview);
  const root = el('section', { class: 'bots-package-preview', 'aria-label': 'Package preview' });
  const summary = el('p', { role: 'status' });
  let paintCost = () => {};
  const paint = () => { const c = counts(preview, picked); summary.textContent = summaryText(c); paintCost(); onChange(picked); };
  root.append(el('h3', { text: preview.name || 'Package' }), summary);
  for (const [group, field] of [['bots', 'key'], ['skills', 'name'], ['connections', 'name'], ['presets', 'name']]) {
    for (const row of preview[group] || []) {
      const check = el('input', { type: 'checkbox', checked: true, disabled: !selectable, 'aria-label': `Include ${row.name}` });
      check.addEventListener('change', () => { picked[group] = check.checked ? [...picked[group], row[field]] : picked[group].filter(k => k !== row[field]); paint(); });
      root.append(el('label', { class: 'bots-lifecycle-row' }, [check, el('span', { text: row.name }), el('small', { text: row.role || row.url || group })]));
    }
  }
  // Model tiers (services/bot_model_tiers.py): each bot's role, tier and the model picked from your own connections,
  // with a dropdown to change any before importing, and a relative cost line.
  if (selectable && preview.models?.rows?.length) {
    const plan = preview.models, byValue = Object.fromEntries((plan.options || []).map(o => [o.value, o]));
    const weight = plan.weights || { light: 1, standard: 4, strong: 15 };
    const tierOf = o => (o && weight[o.tier]) ? o.tier : ({ low: 'light', medium: 'standard', high: 'strong', xhigh: 'strong' }[o?.model_effort] || 'standard');
    picked.models = {};
    const cost = el('p', { class: 'bots-lifecycle-note', role: 'status' });
    const recost = () => {
      const tiers = plan.rows.filter(r => picked.bots.includes(r.key)).map(r => tierOf(byValue[picked.models[r.key] ?? r.value] || r.choice));
      if (!tiers.length) { cost.textContent = ''; return; }
      const percent = Math.max(1, Math.round(100 * tiers.reduce((s, t) => s + (weight[t] || 0), 0) / (tiers.length * weight.strong)));
      cost.textContent = percent >= 100 ? 'Estimated cost: the same as every bot on a strong model.' : `Estimated cost: about ${percent}% of running every bot on a strong model. An estimate, not a quote.`;
    };
    const box = el('section', { class: 'bots-package-models', 'aria-label': 'Models' }, [el('h4', { text: 'Models' }),
      el('p', { class: 'bots-lifecycle-note', text: plan.connected ? 'Each bot gets a model sized to its role, from the models you have connected. Change any before adding.' : 'No model is connected yet. Add one in Settings > Models; the bots use it then.' })]);
    for (const row of plan.rows) {
      const select = el('select', { 'aria-label': `Model for ${row.name}`, disabled: !row.value }, (plan.options || []).map(o => el('option', { value: o.value, text: o.label })));
      if (row.value) select.value = row.value;
      select.addEventListener('change', () => { picked.models[row.key] = select.value; recost(); onChange(picked); });
      box.append(el('div', { class: 'bots-package-model', 'data-key': row.key }, [el('span', {}, [el('strong', { text: row.name }), el('span', { text: ` ${row.tier_label}` })]), select,
        el('small', { text: [row.role, row.note].filter(Boolean).join(' · ') })]));
    }
    box.append(cost);
    root.append(box);
    paintCost = recost;
  }
  // Hands-off posting (services/content_studio/handsoff.py): asked here, off unless the person ticks it.
  if (selectable && (preview.sections || []).includes('content_studio')) {
    picked.hands_off = false;
    const box = el('input', { type: 'checkbox', 'aria-label': 'Hands-off posting' });
    box.addEventListener('change', () => { picked.hands_off = box.checked; onChange(picked); });
    root.append(el('section', { class: 'bots-package-models', 'aria-label': 'Hands-off posting' }, [
      el('label', { class: 'bots-lifecycle-row' }, [box, el('strong', { text: 'Hands-off posting' })]),
      el('p', { class: 'bots-lifecycle-note', text: 'Off: every post waits for your OK. On: the Producer approves the team\'s posts and Kairos posts them to YouTube and Instagram on schedule through your connected apps. TikTok still waits for your tap on each post. You get the weekly report and alerts only for platform warnings, spend near the cap, repeated failures, retirements and TikTok taps. The AI label, the $50 monthly cap and Pause team always apply. You can change this later in Studio > Content.' }),
    ]));
  }
  const SECTION_LABELS = { departments: 'Their teams', rooms: 'Their rooms' };
  for (const name of preview.sections || []) {
    const label = SECTION_LABELS[name] || name;
    const check = el('input', { type: 'checkbox', checked: true, disabled: !selectable, 'aria-label': `Include ${label.toLowerCase()}` });
    check.addEventListener('change', () => { picked.sections = check.checked ? [...picked.sections, name] : picked.sections.filter(s => s !== name); paint(); });
    root.append(el('label', { class: 'bots-lifecycle-row' }, [check, el('span', { text: label })]));
  }
  for (const line of [...(preview.warnings || []), ...(preview.requirements || []), ...(preview.skipped || []).map(s => `Skipped: ${s}`)]) root.append(el('p', { class: 'bots-lifecycle-note', text: line }));
  for (const item of preview.redacted || []) root.append(el('p', { class: 'bots-lifecycle-warning', text: `Remove ${item.kind} at ${item.location} before sharing.` }));
  paint();
  return { node: root, selection: () => structuredClone(picked) };
}
