import { emptyState as sharedEmpty, el, confirmDialog } from './api.js';

// Normalize both empty-state caller contracts onto the shared markup.
export function workspaceEmpty(options) {
  const normalized = { ...options, hint: options.hint ?? options.text,
    mascot: options.mascot !== undefined ? options.mascot : options.mascotState,
    actionLabel: options.actionLabel ?? options.action?.text,
    onAction: options.onAction ?? options.action?.onClick };
  const node = sharedEmpty(normalized);

  node.classList.add('rd-empty-state');
  // Keep the shared mascot, fallback icon, poses and appearance-switch behavior.
  node.querySelector('.empty-state-title').replaceWith(el('h2', { class: 'empty-state-title', text: normalized.title }));
  node.querySelector('.empty-state-hint')?.replaceWith(el('p', { class: 'empty-state-hint', text: normalized.hint }));
  const action = node.querySelector('button');
  if (action) { action.className = 'rd-pill rd-pill-primary'; action.style.removeProperty('margin-top'); }
  return node;
}

export function workspaceStats(items) {
  return el('div', { class: 'workspace-stats', 'aria-label': 'Overview' }, items.map(({ label, value }) =>
    el('section', { class: 'workspace-stat' }, [el('span', { text: label }), el('strong', { text: String(value) })])));
}

// Decorate the existing confirmation lifecycle without changing its result.
export function workspaceConfirm(options) {
  const pending = confirmDialog(options);
  const panel = [...document.querySelectorAll('.panel-dialog.confirm-panel')].at(-1);
  if (panel) {
    panel.dataset.view = document.documentElement.dataset.view;
    panel.classList.add('rd-sheet-in');
    panel.parentElement.classList.add('rd-scrim-in');
    panel.addEventListener('animationend', () => panel.classList.remove('rd-sheet-in'), { once: true });
  }
  return pending;
}
