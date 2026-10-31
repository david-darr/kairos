import { el } from './api.js';
import { selection, counts } from './botsPackageModel.js';

export function renderPreview(preview, { onChange = () => {}, selectable = true } = {}) {
  const picked = selection(preview);
  const root = el('section', { class: 'bots-package-preview', 'aria-label': 'Package preview' });
  const summary = el('p', { role: 'status' });
  const paint = () => { const c = counts(preview, picked); summary.textContent = `${c.bots} bots, ${c.routines} paused routines, ${c.skills} skills, ${c.connections} connections`; onChange(picked); };
  root.append(el('h3', { text: preview.name || 'Package' }), summary);
  for (const [group, field] of [['bots', 'key'], ['skills', 'name'], ['connections', 'name'], ['presets', 'name']]) {
    for (const row of preview[group] || []) {
      const check = el('input', { type: 'checkbox', checked: true, disabled: !selectable, 'aria-label': `Include ${row.name}` });
      check.addEventListener('change', () => { picked[group] = check.checked ? [...picked[group], row[field]] : picked[group].filter(k => k !== row[field]); paint(); });
      root.append(el('label', { class: 'bots-lifecycle-row' }, [check, el('span', { text: row.name }), el('small', { text: row.role || row.url || group })]));
    }
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
