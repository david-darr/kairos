// The ready-made bot gallery (Agents 3.0 Phase 0, unit U4; OMB feature F3, re-written for Kairos).
// Category chips, a one to three column grid of cards (Kip face, name, job, a line to try
// asking), and "+ Add", which opens the new-bot dialog filled in with the persona so the
// person reviews it before anything is created. A persona changes only identity, notes and
// routines; model, approval and apps stay the person's own. The personas are
// static/data/bots-ready.json, written for Kairos.
import { el, openPanelDialog } from './api.js';
import { agentAvatar } from './agentAvatar.js';
import { Button, loadBotsCss } from './botsUi.js';
import { look } from './botsCreateModel.js';

const CSS = '/static/css/bots-create.css';
const DATA = '/static/data/bots-ready.json';
let cache = null;

export async function loadReadyBots() {
  if (cache) return cache;
  const res = await fetch(DATA);
  if (!res.ok) throw new Error(`The ready-made bots could not be loaded (${res.status}).`);
  const data = await res.json();
  cache = { categories: data.categories || [], bots: data.bots || [] };
  return cache;
}

// onAdd(persona) runs after the gallery closes.
export async function openReadyGallery({ onAdd } = {}) {
  await loadBotsCss(CSS);
  const grid = el('div', { class: 'bots-gallery-grid' });
  const chips = el('div', { class: 'bots-gallery-chips', role: 'tablist', 'aria-label': 'Categories' });
  const body = el('div', { class: 'bots-gallery' }, [chips, grid]);
  const dialog = openPanelDialog({ title: 'Ready-made bots', body, className: 'bots-dialog bots-gallery-dialog',
    footer: el('div', { class: 'bots-dialog-footer' }, [Button({ label: 'Close', onClick: () => dialog.close() })]) });
  let data;
  try { data = await loadReadyBots(); }
  catch (error) { grid.replaceChildren(el('p', { class: 'bots-hint', role: 'alert', text: error.message })); return dialog; }

  let active = 'all';
  const cards = data.bots.map(persona => {
    const face = agentAvatar({ id: persona.id, avatar: look(persona.look?.color, persona.look?.shape, persona.look?.acc) }, 44);
    const add = Button({ label: 'Add', iconName: 'plus', onClick: () => { dialog.close(); onAdd?.(persona); } });
    add.setAttribute('aria-label', `Add ${persona.name}`);
    const routines = (persona.routines || []).length;
    const card = el('article', { class: 'bots-ready-card', 'data-ready': persona.id, 'data-category': persona.category }, [
      el('div', { class: 'bots-ready-top' }, [face, el('div', { class: 'bots-ready-id' }, [el('h3', { text: persona.name }), el('p', { class: 'bots-ready-role', text: persona.role })])]),
      el('p', { class: 'bots-ready-blurb', text: persona.blurb }),
      el('p', { class: 'bots-ready-try' }, [el('span', { class: 'bots-caps', text: 'Try asking' }), el('span', { text: `“${persona.try_asking}”` })]),
      el('div', { class: 'bots-ready-foot' }, [
        el('span', { class: 'bots-ready-note', text: routines ? `Suggests ${routines === 1 ? 'a routine' : `${routines} routines`}, off until you turn them on` : '' }), add]),
    ]);
    return card;
  });
  grid.replaceChildren(...cards);
  const chipButtons = [{ id: 'all', label: 'All' }, ...data.categories].map(c => {
    const b = el('button', { type: 'button', role: 'tab', class: 'bots-chip', 'data-category': c.id, text: c.label, 'aria-selected': String(c.id === active),
      onclick: () => { active = c.id; paint(); } });
    return b;
  });
  chips.append(...chipButtons);
  function paint() {
    chipButtons.forEach(b => b.setAttribute('aria-selected', String(b.dataset.category === active)));
    cards.forEach(card => { card.hidden = active !== 'all' && card.dataset.category !== active; });
  }
  paint();
  return dialog;
}
