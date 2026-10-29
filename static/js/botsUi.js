// Bots mode UI kit (Agents 3.0 Phase 0, unit U2): the row kit, the menu recipe,
// the Simple/Advanced switch and the CSS loader every other Bots module uses.
// Styled by static/css/bots.css (tokens and primitives, scoped to
// [data-app-mode="bots"]). Icons come from botsIcons.js, never icons.js.
//
// No imports besides botsIcons.js, on purpose: the kit loads in plain Node for
// scripts/test_bots_look.cjs, and a Bots module never waits on the rest of the
// app to draw a row. Builders return DOM nodes; none keeps state outside its
// node, so a view can rebuild a card on every poll.
import { icon } from './botsIcons.js';

const hasDom = typeof document !== 'undefined';

// el() in miniature (api.js's el pulls in the whole shell).
function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

const reducedMotion = () => hasDom && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// -- CSS loader ----------------------------------------------------------------
// U3 and U4 load their own stylesheets at module import; one <link> per href.
// Resolves true when the sheet is in, false when it failed (the caller keeps a
// visible fallback; a missing sheet never throws into the shell).
const sheets = new Map();
export function loadBotsCss(url) {
  if (!hasDom) return Promise.resolve(false);
  if (sheets.has(url)) return sheets.get(url);
  const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].find(link => link.getAttribute('href') === url);
  const ready = new Promise(resolve => {
    if (existing && existing.sheet) return resolve(true);
    const link = existing || h('link', { rel: 'stylesheet', href: url });
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener('error', () => { sheets.delete(url); resolve(false); }, { once: true });
    if (!existing) document.head.append(link);
  });
  sheets.set(url, ready);
  return ready;
}

// -- Simple / Advanced -----------------------------------------------------------
// One preference for every Bots surface (rail, panel, create dialog). Stored per
// device; a storage failure falls back to memory and never breaks the toggle.
export const INTERFACE_KEY = 'kairos:bots-interface';
let interfaceMode = null;
function readInterface() {
  if (interfaceMode) return interfaceMode;
  let stored = '';
  try { stored = localStorage.getItem(INTERFACE_KEY) || ''; } catch { /* memory only */ }
  interfaceMode = stored === 'advanced' ? 'advanced' : 'simple';
  return interfaceMode;
}
export function isAdvanced() { return readInterface() === 'advanced'; }
export function setAdvanced(on) {
  const next = on ? 'advanced' : 'simple';
  const changed = next !== readInterface();
  interfaceMode = next;
  try { localStorage.setItem(INTERFACE_KEY, next); } catch { /* memory only */ }
  if (hasDom) {
    document.documentElement.dataset.botsInterface = next;
    if (changed) document.dispatchEvent(new CustomEvent('kairos:bots-interface', { detail: { advanced: on === true || on === 'advanced' } }));
  }
  return changed;
}
// Paint the saved choice on <html> (call once when Bots mode opens).
export function applyBotsInterface() { if (hasDom) document.documentElement.dataset.botsInterface = readInterface(); return isAdvanced(); }
// Subscribe; returns the unsubscribe function.
export function onBotsInterface(fn) {
  if (!hasDom) return () => {};
  const handler = event => fn(event.detail.advanced);
  document.addEventListener('kairos:bots-interface', handler);
  return () => document.removeEventListener('kairos:bots-interface', handler);
}
// Tests only: forget the cached choice.
export function resetBotsInterfaceForTest() { interfaceMode = null; }

// -- A bot's colour -------------------------------------------------------------
export const BOT_COLOR_KEYS = ['d9b260', 'b9d2e3', 'e8c39e', 'd99a92', 'b5c7a5', 'cdbfd9'];
// "#D9B260" -> "d9b260" when it is one of the six Kip pastels, else ''.
export function botColorKey(color) {
  const key = String(color || '').replace(/^#/, '').toLowerCase();
  return BOT_COLOR_KEYS.includes(key) ? key : '';
}
// Put a bot's colour on a node, so everything inside re-themes (bubble, BotSwitch).
export function withBotColor(node, color) {
  const key = botColorKey(color);
  if (key) node.dataset.botColor = key; else delete node.dataset.botColor;
  return node;
}

// -- Row kit (OMB rows.tsx: Card, NavRow, SwitchRow, RadioRow, TextRow, Segmented, PageHeader, BotSwitch) --

let uid = 0;
const nextId = prefix => `${prefix}-${++uid}`;

function rowMain(title, hint, titleId) {
  return h('span', { class: 'bots-row-main' }, [
    h('span', { class: 'bots-row-title', id: titleId, text: title }),
    hint ? h('span', { class: 'bots-row-hint', text: hint }) : null,
  ]);
}

// A labelled surface holding rows; rows are separated by hairlines.
export function Card({ label = '', children = [], className = '' } = {}) {
  const labelId = label ? nextId('bots-card') : '';
  return h('section', { class: `bots-card ${className}`.trim(), 'aria-labelledby': labelId || undefined }, [
    label ? h('div', { class: 'bots-caps bots-card-label', id: labelId, text: label }) : null,
    h('div', { class: 'bots-card-body' }, children),
  ]);
}

// A row that goes somewhere: title, hint, a value on the right and a chevron.
export function NavRow({ title, hint = '', value = '', iconName = '', onClick, disabled = false } = {}) {
  const node = h('button', { type: 'button', class: 'bots-row bots-nav-row', disabled: disabled || undefined, onclick: onClick }, [
    iconName ? icon(iconName, { size: 18 }) : null,
    rowMain(title, hint),
    value ? h('span', { class: 'bots-row-value', text: value }) : null,
    h('span', { class: 'bots-chevron' }, [icon('chevron-right', { size: 16 })]),
  ]);
  return node;
}

// The switch itself, shared by SwitchRow and BotSwitch. aria-checked is the state.
function switchButton({ checked, onChange, disabled, label, bot, labelledBy }) {
  const node = h('button', {
    type: 'button', role: 'switch', class: `bots-switch${bot ? ' bot' : ''}`,
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label || undefined, 'aria-labelledby': label ? undefined : labelledBy,
    disabled: disabled || undefined,
  });
  node.addEventListener('click', event => {
    event.stopPropagation();
    if (node.disabled) return;
    const next = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange?.(next);
  });
  node.setChecked = value => node.setAttribute('aria-checked', value ? 'true' : 'false');
  return node;
}

// A bot-coloured switch: set `color` to the bot's colour, or put data-bot-color
// on an ancestor (withBotColor).
export function BotSwitch({ checked = false, onChange, color = '', label = '', disabled = false } = {}) {
  const node = switchButton({ checked, onChange, disabled, label, bot: true });
  return color ? withBotColor(node, color) : node;
}

// A row with an on/off switch. The whole row toggles, so the target is large.
export function SwitchRow({ title, hint = '', checked = false, onChange, disabled = false, bot = false, color = '' } = {}) {
  const titleId = nextId('bots-row-title');
  const control = switchButton({ checked, onChange, disabled, bot, labelledBy: titleId });
  if (bot && color) withBotColor(control, color);
  const node = h('div', { class: 'bots-row bots-switch-row', onclick: () => control.click() }, [rowMain(title, hint, titleId), control]);
  node.setChecked = value => control.setChecked(value);
  node.control = control;
  return node;
}

// One option of a radio list. Group them with RadioGroup (arrow keys move the choice).
export function RadioRow({ title, hint = '', value, checked = false, onSelect } = {}) {
  const node = h('button', {
    type: 'button', role: 'radio', class: 'bots-row bots-radio-row',
    'aria-checked': checked ? 'true' : 'false', tabindex: checked ? '0' : '-1', 'data-value': String(value ?? ''),
  }, [h('span', { class: 'bots-radio-mark' }), rowMain(title, hint)]);
  node.addEventListener('click', () => onSelect?.(value));
  return node;
}

// A group of RadioRows in a Card-like list with roving focus.
export function RadioGroup({ label = '', options = [], value, onChange } = {}) {
  const rows = options.map(option => RadioRow({ ...option, checked: option.value === value, onSelect: pick }));
  const group = Card({ children: rows });
  group.setAttribute('role', 'radiogroup');
  if (label) group.setAttribute('aria-label', label);
  function pick(next) {
    rows.forEach(row => {
      const on = row.dataset.value === String(next);
      row.setAttribute('aria-checked', on ? 'true' : 'false'); row.tabIndex = on ? 0 : -1;
    });
    onChange?.(next);
  }
  group.addEventListener('keydown', event => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step || !rows.length) return;
    event.preventDefault();
    const at = Math.max(0, rows.findIndex(row => row.getAttribute('aria-checked') === 'true'));
    const target = rows[(at + step + rows.length) % rows.length];
    target.focus(); target.click();
  });
  return group;
}

// A row with a text field. Enter or blur commits, Escape puts the old value back
// (OMB's inline-edit rule). onCommit runs only when the text changed.
export function TextRow({ title, hint = '', value = '', placeholder = '', maxLength, multiline = false, onCommit } = {}) {
  const titleId = nextId('bots-row-title');
  const field = h(multiline ? 'textarea' : 'input', {
    ...(multiline ? { rows: '3' } : { type: 'text' }),
    value: undefined, placeholder, maxlength: maxLength ? String(maxLength) : undefined, 'aria-labelledby': titleId,
  });
  field.value = value;
  let committed = value;
  const commit = () => { if (field.value !== committed) { committed = field.value; onCommit?.(committed); } };
  field.addEventListener('blur', commit);
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      // A multi-line field takes Enter as a new line; Ctrl or Cmd+Enter commits.
      if (!multiline || event.metaKey || event.ctrlKey) { event.preventDefault(); commit(); field.blur?.(); }
    } else if (event.key === 'Escape') {
      event.stopPropagation(); field.value = committed; field.blur?.();
    }
  });
  const node = h('label', { class: 'bots-row bots-text-row' }, [rowMain(title, hint, titleId), field]);
  node.field = field;
  node.set = next => { committed = next; field.value = next; };
  return node;
}

// A pill group choosing one of a few values (Ask / Just do it, Live / Turns).
export function Segmented({ options = [], value, onChange, label = '' } = {}) {
  const buttons = options.map(option => h('button', {
    type: 'button', role: 'radio', 'data-value': String(option.value),
    'aria-checked': option.value === value ? 'true' : 'false', tabindex: option.value === value ? '0' : '-1',
    text: option.label,
  }));
  const node = h('div', { class: 'bots-segmented', role: 'radiogroup', 'aria-label': label || undefined }, buttons);
  const pick = button => {
    buttons.forEach(b => { const on = b === button; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    const option = options[buttons.indexOf(button)];
    onChange?.(option.value);
  };
  buttons.forEach(button => button.addEventListener('click', () => { if (button.getAttribute('aria-checked') !== 'true') pick(button); }));
  node.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const at = Math.max(0, buttons.findIndex(b => b.getAttribute('aria-checked') === 'true'));
    const target = buttons[(at + step + buttons.length) % buttons.length];
    target.focus(); pick(target);
  });
  return node;
}

// The top of a drill-down page: an optional "Back to <previous>" link, the title
// and one line of intro. `actions` are nodes placed beside the title.
export function PageHeader({ title, intro = '', backLabel = '', onBack, actions = [] } = {}) {
  return h('header', { class: 'bots-page-header' }, [
    backLabel ? h('button', { type: 'button', class: 'bots-back', onclick: onBack }, [icon('arrow-left', { size: 14 }), backLabel]) : null,
    h('div', { class: 'bots-page-header-top' }, [h('h2', { class: 'bots-page-title', text: title }), ...[].concat(actions)]),
    intro ? h('p', { class: 'bots-page-intro', text: intro }) : null,
  ]);
}

// Buttons: a text button (variant 'primary' | 'danger' | '') and a round icon button.
export function Button({ label, iconName = '', variant = '', onClick, disabled = false } = {}) {
  return h('button', { type: 'button', class: `bots-btn ${variant}`.trim(), disabled: disabled || undefined, onclick: onClick },
    [iconName ? icon(iconName, { size: 16 }) : null, label]);
}
export function IconButton({ iconName, label, onClick, disabled = false } = {}) {
  return h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': label, title: label, disabled: disabled || undefined, onclick: onClick },
    [icon(iconName, { size: 18 })]);
}

// -- Menu recipe (OMB menu-recipe.ts) ---------------------------------------------
// MenuLabel, MenuSeparator, MenuNote, MenuRow and Menu build the sheet; openMenu
// anchors one to a button, closes on Escape, outside click or a pick, returns focus
// to the opener, and keeps the menu mounted for the 200 ms exit unless motion is
// reduced.
export function MenuLabel(text) { return h('div', { class: 'bots-caps bots-menu-label', text }); }
export function MenuSeparator() { return h('div', { class: 'bots-menu-sep', role: 'separator' }); }
export function MenuNote(text) { return h('div', { class: 'bots-menu-note', text }); }
export function MenuRow({ label, iconName = '', meta = '', danger = false, checked, disabled = false, onSelect } = {}) {
  const role = checked === undefined ? 'menuitem' : 'menuitemradio';
  const node = h('button', {
    type: 'button', role, class: `bots-menu-row${danger ? ' danger' : ''}`, disabled: disabled || undefined,
    'aria-checked': checked === undefined ? undefined : (checked ? 'true' : 'false'),
  }, [
    iconName ? icon(iconName, { size: 16 }) : null,
    h('span', { class: 'bots-menu-row-label', text: label }),
    meta ? h('span', { class: 'bots-menu-meta', text: meta }) : null,
  ]);
  node.addEventListener('click', () => onSelect?.());
  return node;
}
// items: [{label, iconName, meta, danger, checked, disabled, onSelect}] plus
// {separator:true}, {heading:'text'}, {note:'text'}. onSelect gets no arguments.
export function Menu(items = []) {
  const menu = h('div', { class: 'bots-menu', role: 'menu' });
  for (const item of items) {
    if (item.separator) menu.append(MenuSeparator());
    else if (item.heading) menu.append(MenuLabel(item.heading));
    else if (item.note) menu.append(MenuNote(item.note));
    else menu.append(MenuRow(item));
  }
  return menu;
}

let openMenuHandle = null;
export function closeMenu({ immediate = false } = {}) { openMenuHandle?.close(immediate); }
export function openMenu(anchor, items, { align = 'start', onClose } = {}) {
  closeMenu({ immediate: true });
  const menu = Menu(items);
  const opener = anchor;
  let closed = false;
  const close = immediate => {
    if (closed) return;
    closed = true; openMenuHandle = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    const finish = () => { menu.remove(); onClose?.(); };
    if (immediate || reducedMotion()) finish();
    else { menu.dataset.closing = ''; menu.setAttribute('aria-hidden', 'true'); menu.inert = true; setTimeout(finish, 200); }
    if (opener?.isConnected) opener.focus?.();
  };
  const outside = event => { if (!menu.contains(event.target) && !opener?.contains?.(event.target)) close(false); };
  const key = event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(false); return; }
    const rows = [...menu.querySelectorAll('.bots-menu-row:not([disabled])')];
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step || !rows.length) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement);
    rows[(at + step + rows.length) % rows.length].focus();
  };
  menu.addEventListener('click', event => { if (event.target.closest('.bots-menu-row:not([disabled])')) close(false); });
  document.body.append(menu);
  // Place under the anchor, kept inside the viewport.
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const left = Math.min(Math.max(8, align === 'end' ? box.right - width : box.left), Math.max(8, innerWidth - width - 8));
  const flip = box.bottom + 6 + height > innerHeight - 8 && box.top - 6 - height >= 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${flip ? box.top - 6 - height : box.bottom + 6}px`;
  menu.style.setProperty('--menu-origin', `${flip ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  menu.querySelector('.bots-menu-row:not([disabled])')?.focus();
  openMenuHandle = { close, menu };
  return { menu, close: () => close(false) };
}
