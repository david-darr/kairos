// Point mode (Phase 6 unit U2, 2026-10-29): the person clicks an element inside a bot's page and it becomes a chip
// that rides with their next message, so "make this button bigger" says which button. The page itself runs in
// a sandboxed frame; a pick is accepted only from that frame's own window and only while Point is on (the check is
// in botsAppBridge.createBridge). What the chip carries is a tag name and a label of at most 40 characters taken
// from the page, which is outside text: the composer sends it as `pointed`, and the server fences it
// (services/bot_apps.pointed_note) before the model sees it.
import { h } from './botsUi.js';
import { icon } from './botsIcons.js';

export const MAX_POINTED = 5;
export const LABEL_CHARS = 40;
const chips = [];
const listeners = new Set();
const announce = () => listeners.forEach(fn => { try { fn(list()); } catch { /* a listener failing never blocks a pick */ } });

export const cleanLabel = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, LABEL_CHARS);
export const cleanTag = tag => String(tag ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'element';
export function list() { return chips.map(chip => ({ ...chip })); }
export function onPointed(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// Add a pick. Returns false when five are already waiting (the person removes one first).
export function addPointed({ tag, label, messageId = '' }) {
  if (chips.length >= MAX_POINTED) return false;
  chips.push({ id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, tag: cleanTag(tag), label: cleanLabel(label), messageId });
  announce();
  return true;
}
export function removePointed(id) {
  const at = chips.findIndex(chip => chip.id === id);
  if (at >= 0) { chips.splice(at, 1); announce(); }
}
export function clearPointed() { if (chips.length) { chips.length = 0; announce(); } }
// What the composer sends with the message: [{tag, label}], and the list is emptied.
export function takePointed() {
  const out = chips.map(({ tag, label }) => ({ tag, label }));
  clearPointed();
  return out;
}

// The chip row for the composer: an accent-outlined pill per pick with its tag and a remove button.
// Returns {node, destroy}; the row is hidden while empty.
export function mountPointChips(host) {
  const row = h('div', { class: 'bots-pointed', role: 'list', 'aria-label': 'Things you pointed at' });
  const draw = items => {
    row.hidden = !items.length;
    row.replaceChildren(...items.map(chip => {
      const remove = h('button', { type: 'button', class: 'bots-pointed-x', 'aria-label': `Remove ${chip.label || chip.tag}` }, [icon('x', { size: 12 })]);
      remove.addEventListener('click', () => removePointed(chip.id));
      return h('span', { class: 'bots-pointed-chip', role: 'listitem' }, [
        h('span', { class: 'bots-pointed-label', text: chip.label || chip.tag }), h('span', { class: 'bots-pointed-tag', text: `<${chip.tag}>` }), remove]);
    }));
  };
  draw(list());
  const off = onPointed(draw);
  host.append(row);
  return { node: row, destroy() { off(); row.remove(); } };
}
