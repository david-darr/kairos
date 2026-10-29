// Making a bot (Agents 3.0 Phase 0, unit U4; OMB features F1 and F2, re-written for Kairos).
//
//   openNewBot({gallery, ready, preset})   the "+ New bot" flow. Simple (the default) is a
//                                           small dialog: a name, a job, a Kip look, Create.
//                                           Advanced is the full dialog with a section nav.
//                                           gallery:true opens the ready-made gallery first.
//   openBotDefaults()                       the same dialog in "new-bot defaults" mode.
//
// One request makes the bot, its starting notes and its routines: POST /api/agents/configured.
// The draft and the request body are botsCreateModel.js. The dialog keeps the whole draft until
// Create succeeds; Escape on a typed draft asks before throwing it away, and on a phone the
// Advanced dialog fills the screen (same rules as the older creation dialog).
import { api, el, toast, confirmDialog, openPanelDialog, customSelect, clearSharedReads } from './api.js';
import { avatarPicker, agentAvatar } from './agentAvatar.js';
import { agentModelPicker } from './agentModelPicker.js';
import { Card, SwitchRow, Segmented, Button, IconButton, loadBotsCss, isAdvanced } from './botsUi.js';
import { icon } from './botsIcons.js';
import * as M from './botsCreateModel.js';

const CSS = '/static/css/bots-create.css';
const SECTIONS = [['identity', 'Identity'], ['soul', 'Soul'], ['model', 'Model'], ['routines', 'Routines'], ['access', 'Access'], ['delivery', 'Delivery']];
const DEFAULTS_SECTIONS = [['identity', 'Identity'], ['soul', 'Soul'], ['routines', 'Routines'], ['access', 'Access']];

const announce = (name, detail = {}) => document.dispatchEvent(new CustomEvent(name, { detail }));
const go = detail => announce('jarvis:navigate', detail);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

async function send(path, method, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  clearSharedReads();
  let data = null;
  try { data = await res.json(); } catch { /* an empty body */ }
  return { ok: res.ok, status: res.status, data };
}

// -- small builders ---------------------------------------------------------------------------

function rowMain(title, hint) {
  return el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title', text: title }), hint ? el('span', { class: 'bots-row-hint', text: hint }) : null]);
}

// A one-line text row bound to a draft key. Returns the row; row.sync() re-reads the draft.
function textField(ctx, { title, hint = '', key, maxLength, placeholder = '', autofocus = false }) {
  const field = el('input', { type: 'text', placeholder, maxlength: maxLength ? String(maxLength) : undefined, 'aria-label': title, autocomplete: 'off' });
  const row = el('label', { class: 'bots-row bots-text-row' }, [rowMain(title, hint), field]);
  field.value = ctx.draft[key] || '';
  field.addEventListener('input', () => { ctx.draft[key] = field.value; if (key === 'name') ctx.draft.nameTouched = true; ctx.touch(); });
  row.sync = () => { field.value = ctx.draft[key] || ''; };
  row.field = field;
  ctx.syncs.push(row.sync);
  if (autofocus) ctx.initialFocus = field;
  return row;
}

// A tall text box with a live counter (characters, or bytes for the soul).
function longField(ctx, { title, hint = '', key, rows = 4, limit, bytes = false, placeholder = '' }) {
  const area = el('textarea', { rows: String(rows), placeholder, 'aria-label': title });
  const count = el('small', { class: 'bots-count' });
  const row = el('label', { class: 'bots-row bots-stack-row' }, [rowMain(title, hint), area, count]);
  const paint = () => {
    const used = bytes ? M.byteLength(area.value) : area.value.length;
    count.textContent = `${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} ${bytes ? 'bytes' : 'characters'}`;
    count.classList.toggle('over', used > limit);
  };
  area.value = ctx.draft[key] || '';
  area.addEventListener('input', () => {
    if (bytes) { const clipped = M.clipBytes(area.value, limit); if (clipped !== area.value) area.value = clipped; }
    else if (area.value.length > limit) area.value = area.value.slice(0, limit);
    ctx.draft[key] = area.value; paint(); ctx.touch();
  });
  row.sync = () => { area.value = ctx.draft[key] || ''; paint(); };
  ctx.syncs.push(row.sync);
  paint();
  return row;
}

function colorSwatches(ctx) {
  const group = el('div', { class: 'bots-swatches', role: 'radiogroup', 'aria-label': 'Body colour' });
  const names = { d9b260: 'Gold', b9d2e3: 'Powder', e8c39e: 'Sand', d99a92: 'Rose', b5c7a5: 'Sage', cdbfd9: 'Lilac' };
  const buttons = M.COLOR_KEYS.map(key => {
    const b = el('button', { type: 'button', role: 'radio', class: 'bots-swatch', 'data-color': key, 'aria-label': names[key], title: names[key] });
    b.style.setProperty('--swatch', `var(--m-body-${key})`);
    b.addEventListener('click', () => { ctx.draft.avatar = { ...ctx.draft.avatar, ...M.look(key, ctx.draft.avatar.shape, ctx.draft.avatar.acc) }; ctx.touch(); ctx.syncs.forEach(s => s()); });
    return b;
  });
  group.append(...buttons);
  group.sync = () => buttons.forEach(b => { const on = M.colorOf(ctx.draft.avatar) === '#' + b.dataset.color; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
  ctx.syncs.push(group.sync); group.sync();
  return group;
}

// The compact Kip look for the Simple dialog: a face, six colours and a shuffle.
function simpleLook(ctx) {
  const face = el('span', { class: 'bots-look-face' });
  const paint = () => face.replaceChildren(agentAvatar({ avatar: ctx.draft.avatar }, 88));
  const shuffle = Button({ label: 'Shuffle', iconName: 'refresh-cw', onClick: () => {
    const pick = list => list[Math.floor(Math.random() * list.length)];
    ctx.draft.avatar = M.look(pick(M.COLOR_KEYS), pick(M.SHAPES), pick(M.ACCESSORIES)); ctx.touch(); ctx.syncs.forEach(s => s());
    if (!reduced()) face.animate([{ transform: 'scale(.9)', opacity: .7 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'ease-out' });
  } });
  ctx.syncs.push(paint); paint();
  return el('div', { class: 'bots-look' }, [face, el('div', { class: 'bots-look-side' }, [rowMain('Look', 'Every bot is a Kip. Pick its colour.'), colorSwatches(ctx), shuffle])]);
}

// -- the dialog ---------------------------------------------------------------------------------

// What the dialogs need from the server, read once. Failures fall back to empty, never block.
async function loadBundle({ advanced, defaultsMode }) {
  const read = (path, fallback) => api(path).catch(() => fallback);
  const [defaults, agents, presets, models, channels, integrations] = await Promise.all([
    read('/api/agents/defaults', { defaults: {}, model_selection: null, suggested_name: '' }),
    read('/api/agents', []), defaultsMode ? [] : read('/api/agents/presets', []),
    advanced && !defaultsMode ? read('/api/models', []) : [], advanced && !defaultsMode ? read('/api/channels', []) : [],
    advanced ? read('/api/integrations', []) : [],
  ]);
  return { defaults, taken: agents.map(a => a.name), presets, models, channels, integrations: integrations.filter(i => i.kind === 'mcp_server') };
}

export async function openNewBot({ gallery = false, ready = null, preset = null } = {}) {
  if (gallery) {
    const { openReadyGallery } = await import('./botsGallery.js');
    return openReadyGallery({ onAdd: persona => openNewBot({ ready: persona }) });
  }
  const advanced = isAdvanced() || !!ready || !!preset;
  return openBotDialog({ advanced, ready, preset, mode: 'create' });
}
export const openBotDefaults = () => openBotDialog({ advanced: true, mode: 'defaults' });

async function openBotDialog({ advanced, ready = null, preset = null, mode = 'create', carry = null }) {
  const defaultsMode = mode === 'defaults';
  const [bundle] = await Promise.all([loadBundle({ advanced, defaultsMode }), loadBotsCss(CSS)]);
  const suggested = M.freeName(bundle.defaults.suggested_name || 'Juniper', bundle.taken);
  let draft = M.draftFromDefaults(bundle.defaults.defaults || {}, { suggestedName: defaultsMode ? '' : suggested });
  if (ready) draft = M.applyReady(draft, ready);
  else if (preset) draft = M.applyStart(draft, preset);
  draft.name = M.freeName(draft.name, bundle.taken);
  if (carry) draft = { ...draft, ...carry };
  const ctx = { draft, syncs: [], initialFocus: null, taken: bundle.taken, bundle,
    touch() { dirty = true; validate(); } };
  let dirty = false, busy = false, advancedNow = advanced;
  const message = el('p', { class: 'bots-validity', role: 'status' });
  const submit = el('button', { type: 'button', class: 'bots-btn primary', disabled: true, text: defaultsMode ? 'Save defaults' : 'Create bot' });
  const cancel = Button({ label: 'Cancel', onClick: () => dialog.close() });
  const extra = [];
  const problems = () => M.validateDraft(ctx.draft, { taken: ctx.taken, mode: defaultsMode ? 'defaults' : 'create' });
  function validate() {
    const list = problems();
    if (!busy) message.textContent = list[0]?.message || '';
    submit.disabled = busy || list.length > 0;
    return list;
  }

  const sections = advancedNow ? buildAdvanced(ctx, { defaultsMode, openGallery }) : buildSimple(ctx);
  const body = advancedNow ? advancedBody(sections, defaultsMode) : sections.root;
  if (!advancedNow) {
    extra.push(Button({ label: 'More options', onClick: () => { dialogSwitch(); } }));
  }
  if (defaultsMode) {
    extra.push(Button({ label: 'Clear defaults', variant: 'danger', onClick: async () => {
      if (!(await confirmDialog({ title: 'Clear the defaults?', message: 'New bots will start blank again. Bots you already made are not changed.', confirmLabel: 'Clear defaults' }))) return;
      const result = await send('/api/agents/defaults', 'PUT', { defaults: {} });
      if (!result.ok) { message.textContent = result.data?.detail || 'The defaults could not be cleared.'; return; }
      dirty = false; dialog.close(); toast('New bots start blank again', 'success');
    } }));
  }
  const footer = el('div', { class: 'bots-dialog-footer' }, [message, ...extra, cancel, submit]);
  const title = defaultsMode ? 'New-bot defaults' : 'New bot';
  const dialog = openPanelDialog({ title, body, footer, className: `bots-dialog bots-create-dialog${advancedNow ? ' advanced' : ' simple'}`,
    initialFocus: ctx.initialFocus, onClose: () => { document.removeEventListener('keydown', escapeDraft, true); sections.dispose?.(); } });

  // The shared panel closes on Escape; intercept first so a typed draft is not lost, and so a
  // focused text field (whose own Escape handler stops the event) still lets a clean dialog close.
  function escapeDraft(event) {
    if (event.key !== 'Escape' || !dialog.panel.isConnected || busy || document.querySelector('.confirm-panel')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!dirty) { dialog.close(); return; }
    confirmDialog({ title: 'Discard this draft?', message: defaultsMode ? 'Nothing has been saved yet.' : 'Nothing has been created yet.', confirmLabel: 'Discard draft' })
      .then(yes => { if (yes) dialog.close(); });
  }
  document.addEventListener('keydown', escapeDraft, true);

  // Simple -> Advanced keeps the draft: the new dialog starts from what has been typed.
  function dialogSwitch() {
    const carry = { ...ctx.draft };
    dirty = false; dialog.close();
    openBotDialog({ advanced: true, mode, carry });
  }
  async function openGallery() {
    if (dirty && !(await confirmDialog({ title: 'Leave this draft?', message: 'Nothing has been created yet.', confirmLabel: 'Leave draft' }))) return;
    dirty = false; dialog.close(); openNewBot({ gallery: true });
  }

  if (carry) dirty = true;
  ctx.syncs.forEach(s => s());
  validate();

  submit.addEventListener('click', async () => {
    const list = validate(); if (list.length || busy) return;
    busy = true; submit.disabled = true; message.textContent = defaultsMode ? 'Saving…' : 'Creating…';
    try {
      if (defaultsMode) {
        const result = await send('/api/agents/defaults', 'PUT', { defaults: M.defaultsFromDraft(ctx.draft, bundle.defaults.defaults) });
        if (!result.ok) throw new Error(result.data?.detail || 'The defaults could not be saved.');
        dirty = false; busy = false; dialog.close(); toast('Saved. New bots start with these.', 'success');
        return;
      }
      const result = await send('/api/agents/configured', 'POST', M.buildPayload(ctx.draft, { advanced: advancedNow }));
      if (!result.ok) {
        const failure = M.describeFailure(result.status, result.data || {});
        message.textContent = failure.text; busy = false; submit.disabled = false; toast(failure.text, 'error');
        if (failure.partial) announce('jarvis:agents-changed');
        return;
      }
      const { agent, warnings = [] } = result.data;
      const notes = [...warnings];
      if (agent.approval_mode !== 'full') notes.push(`${agent.name} did not return the requested Full approval setting. Check its settings before using it.`);
      dirty = false; busy = false; dialog.close();
      announce('jarvis:agents-changed', { agentId: agent.id });
      if (notes.length) toast(`${agent.name} was created. ${notes.join(' ')}`, 'error'); else toast(`${agent.name} is ready`, 'success');
      go({ tab: 'botsShell', agentId: agent.id });
    } catch (error) {
      busy = false; message.textContent = error.message; toast(error.message, 'error'); validate();
    }
  });
  return dialog;
}

// -- Simple -----------------------------------------------------------------------------------

function buildSimple(ctx) {
  const root = el('div', { class: 'bots-create-simple' }, [
    Card({ children: [textField(ctx, { title: 'Name', key: 'name', maxLength: M.LIMITS.name, placeholder: 'e.g. Juniper', autofocus: true }),
      textField(ctx, { title: 'Job', hint: 'What is this bot for?', key: 'role', maxLength: M.LIMITS.role })] }),
    Card({ children: [simpleLook(ctx)] }),
    el('p', { class: 'bots-hint', text: 'It starts with your saved defaults, and you can change anything later in its settings.' }),
  ]);
  return { root };
}

// -- Advanced ---------------------------------------------------------------------------------

function advancedBody(built, defaultsMode) {
  const list = defaultsMode ? DEFAULTS_SECTIONS : SECTIONS;
  const nodes = list.map(([id]) => built.sections[id]).filter(Boolean);
  const nav = el('nav', { class: 'bots-create-nav', 'aria-label': 'Creation sections' },
    list.map(([id, label], index) => el('button', { type: 'button', 'data-section': id, text: label,
      onclick: () => nodes[index].scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }) })));
  const wrap = el('div', { class: 'bots-create-sections' }, nodes);
  const root = el('div', { class: 'bots-create-body' }, [nav, wrap]);
  // The section crossing the reading line is the current one; one scroll listener, one frame.
  let frame = 0;
  const scroller = () => root.closest('.modal-body');
  const mark = () => {
    frame = 0; const holder = scroller(); if (!holder) return;
    const line = holder.getBoundingClientRect().top + 80;
    let active = 0; nodes.forEach((n, i) => { if (n.getBoundingClientRect().top <= line) active = i; });
    [...nav.children].forEach((b, i) => { b.classList.toggle('active', i === active); if (i === active) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
  };
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(mark); };
  queueMicrotask(() => { scroller()?.addEventListener('scroll', onScroll, { passive: true }); mark(); });
  built.dispose = () => { scroller()?.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  root.dispose = built.dispose;
  return root;
}

function section(id, heading, intro, children) {
  return el('section', { id: `bots-create-${id}`, class: 'bots-create-section', 'data-section': id }, [
    el('h3', { text: heading }), intro ? el('p', { class: 'bots-hint', text: intro }) : null, ...children]);
}

function buildAdvanced(ctx, { defaultsMode, openGallery }) {
  const { draft, bundle } = ctx;
  const built = { sections: {} };

  // Identity ----------------------------------------------------------------------------------
  const identity = [];
  if (!defaultsMode) identity.push(startingRoles(ctx, openGallery));
  const rows = [];
  if (!defaultsMode) rows.push(textField(ctx, { title: 'Name', key: 'name', maxLength: M.LIMITS.name, autofocus: true }));
  rows.push(textField(ctx, { title: 'Job', hint: 'What is this bot for?', key: 'role', maxLength: M.LIMITS.role }),
    longField(ctx, { title: 'Introduction', hint: 'A short line about who it is.', key: 'blurb', rows: 2, limit: M.LIMITS.blurb }),
    textField(ctx, { title: 'Group', hint: 'Optional. Bots in the same group sit together.', key: 'section', maxLength: M.LIMITS.section }));
  identity.push(Card({ children: rows }));
  if (defaultsMode) identity.push(Card({ label: 'Colour', children: [el('div', { class: 'bots-row' }, [colorSwatches(ctx)])] }));
  else {
    const holder = el('div', { class: 'bots-picker-host' });
    const mount = () => {
      const picker = avatarPicker(draft.avatar, spec => { draft.avatar = M.look(spec.color, spec.shape, spec.acc); ctx.touch(); });
      holder.replaceChildren(picker.root);
    };
    ctx.syncs.push(mount);
    identity.push(Card({ label: 'Look', children: [holder] }));
  }
  built.sections.identity = section('identity', 'Identity', defaultsMode ? 'Every new bot starts with these.' : 'Start with a role, then change every word to make it yours.', identity);

  // Soul and starting notes -------------------------------------------------------------------
  built.sections.soul = section('soul', 'Soul', 'Standing instructions: how this bot works, every time.', [
    Card({ children: [longField(ctx, { title: 'Standing instructions', key: 'soul', rows: 7, limit: M.LIMITS.soulBytes, bytes: true })] }),
    startingNotes(ctx)]);

  // Model -------------------------------------------------------------------------------------
  if (!defaultsMode) {
    const picker = agentModelPicker(bundle.models, draft.model, () => { draft.model = picker.get(); draft.modelTouched = true; ctx.touch(); });
    built.sections.model = section('model', 'Model', 'Left alone, the bot uses your first Claude connection.', [picker.root]);
  }

  // Routines ----------------------------------------------------------------------------------
  built.sections.routines = section('routines', 'Routines', 'Optional. A routine runs on a schedule and tells you what it found.', [routinesEditor(ctx)]);

  // Access ------------------------------------------------------------------------------------
  const access = [];
  if (!defaultsMode) access.push(toolServers(ctx));
  access.push(Card({ label: 'Habits', children: [
    SwitchRow({ title: 'Stay signed in', hint: 'Keep the sites it logs into between runs.', checked: draft.keep_signed_in, onChange: v => { draft.keep_signed_in = v; ctx.touch(); } }),
    SwitchRow({ title: 'Keep its own notes tidy', hint: 'It reviews and cleans up what it remembers.', checked: draft.memory_upkeep, onChange: v => { draft.memory_upkeep = v; ctx.touch(); } }),
  ] }));
  if (!defaultsMode) access.push(Card({ label: 'Approval', children: [
    el('div', { class: 'bots-row' }, [icon('shield', { size: 18 }), rowMain('Full access', 'It acts without asking. You can stop it at any time from its page.')])] }));
  built.sections.access = section('access', 'Access', null, access);

  // Delivery ----------------------------------------------------------------------------------
  if (!defaultsMode) {
    const select = customSelect({}, [el('option', { value: '', text: 'In the app only' }), ...bundle.channels.map(c => el('option', { value: c.id, text: c.label }))]);
    select.value = draft.deliver_to_channel || '';
    select.addEventListener('change', () => { draft.deliver_to_channel = select.value; ctx.touch(); });
    built.sections.delivery = section('delivery', 'Delivery', null, [Card({ children: [
      el('div', { class: 'bots-row' }, [rowMain('Tell me on', 'Where its reports and questions reach you.'), select])] })]);
  }
  return built;
}

// "Starting role": blank, the four starters and the saved presets, one pick fills identity,
// notes and routines (never model, approval or apps).
function startingRoles(ctx, openGallery) {
  const list = el('div', { class: 'bots-card-body bots-start-list', role: 'list' });
  let chosen = ctx.draft.origin?.id || 'blank';
  const paint = () => list.querySelectorAll('[data-start]').forEach(r => r.querySelector('.bots-start-pick').setAttribute('aria-pressed', String(r.dataset.start === chosen)));
  const pick = (start, kind) => {
    chosen = start?.id || 'blank';
    ctx.draft = Object.assign(ctx.draft, start ? M.applyStart(ctx.draft, start, { kind }) : M.applyStart(ctx.draft, { name: '', role: '', blurb: '', soul: '' }, { kind: 'preset' }));
    if (!start) ctx.draft.origin = { kind: 'blank' };
    if (!ctx.draft.nameTouched) ctx.draft.name = M.freeName(ctx.draft.name, ctx.taken);
    ctx.syncs.forEach(s => s()); ctx.touch(); paint();
  };
  const addRow = (start, kind, { hint, deletable = false } = {}) => {
    const row = el('div', { class: 'bots-start-row', role: 'listitem', 'data-start': start?.id || 'blank' });
    row.append(el('button', { type: 'button', class: 'bots-row bots-start-pick', 'aria-pressed': 'false', onclick: () => pick(start, kind) },
      [rowMain(start?.name || 'Blank', hint ?? (start ? start.role : 'Start from nothing'))]));
    if (deletable) row.append(IconButton({ iconName: 'trash-2', label: `Delete the ${start.name} preset`, onClick: async () => {
      if (!(await confirmDialog({ title: `Delete the ${start.name} preset?`, message: 'Bots already made from it are not changed.', confirmLabel: 'Delete preset' }))) return;
      const result = await send(`/api/agents/presets/${start.id}`, 'DELETE');
      if (!result.ok) { toast(result.data?.detail || 'The preset could not be deleted.', 'error'); return; }
      row.remove(); if (chosen === start.id) chosen = 'blank'; paint();
    } }));
    list.append(row);
  };
  addRow(null, 'preset');
  for (const s of M.STARTERS) addRow(s, 'preset');
  for (const p of ctx.bundle.presets) addRow(p, 'preset', { deletable: true, hint: p.role || 'Your saved preset' });
  paint();
  return el('div', { class: 'bots-card' }, [el('div', { class: 'bots-caps bots-card-label', text: 'Starting role' }), list,
    el('div', { class: 'bots-start-more' }, [Button({ label: 'Browse ready-made bots', iconName: 'sparkles', onClick: openGallery })])]);
}

function startingNotes(ctx) {
  const holder = el('div', { class: 'bots-card-body' });
  const total = el('small', { class: 'bots-count' });
  const paintTotal = () => {
    const chars = ctx.draft.memory_seed.reduce((n, note) => n + String(note.text || '').split(/\s+/).filter(Boolean).join(' ').length, 0);
    total.textContent = `${chars.toLocaleString('en-US')} / ${M.LIMITS.seedChars.toLocaleString('en-US')} characters`; total.classList.toggle('over', chars > M.LIMITS.seedChars);
  };
  const draw = () => {
    holder.replaceChildren();
    ctx.draft.memory_seed.forEach((note, index) => {
      const heading = el('select', { 'aria-label': `Note ${index + 1} heading` }, M.SEED_SECTIONS.map(s => el('option', { value: s, text: s })));
      heading.value = M.SEED_SECTIONS.includes(note.section) ? note.section : M.SEED_SECTIONS[0]; note.section = heading.value;
      const text = el('textarea', { rows: '2', 'aria-label': `Note ${index + 1}`, placeholder: 'Something it should already know' }); text.value = note.text || '';
      heading.addEventListener('change', () => { note.section = heading.value; ctx.touch(); });
      text.addEventListener('input', () => { note.text = text.value; paintTotal(); ctx.touch(); });
      holder.append(el('div', { class: 'bots-row bots-note-row' }, [heading, text, IconButton({ iconName: 'x', label: `Remove note ${index + 1}`, onClick: () => { ctx.draft.memory_seed.splice(index, 1); draw(); ctx.touch(); } })]));
    });
    if (!ctx.draft.memory_seed.length) holder.append(el('div', { class: 'bots-row' }, [rowMain('No starting notes', 'Notes it will remember from its very first chat.')]));
    paintTotal();
  };
  ctx.syncs.push(draw); draw();
  const add = Button({ label: 'Add a note', iconName: 'plus', onClick: () => { ctx.draft.memory_seed.push({ section: M.SEED_SECTIONS[0], text: '' }); draw(); ctx.touch(); holder.querySelector('.bots-note-row:last-child textarea')?.focus(); } });
  return el('div', { class: 'bots-card' }, [el('div', { class: 'bots-caps bots-card-label', text: 'Starting notes' }), holder, el('div', { class: 'bots-start-more' }, [add, total])]);
}

function routinesEditor(ctx) {
  const holder = el('div', { class: 'bots-routines' });
  const draw = () => {
    holder.replaceChildren();
    ctx.draft.routines.forEach((r, index) => {
      const name = el('input', { type: 'text', 'aria-label': `Routine ${index + 1} name`, placeholder: 'e.g. New postings', maxlength: String(M.LIMITS.routineName) }); name.value = r.name;
      const prompt = el('textarea', { rows: '3', 'aria-label': `Routine ${index + 1} instructions`, placeholder: 'What to check, and what counts as worth telling you' }); prompt.value = r.prompt;
      const time = el('input', { type: 'time', value: r.run_time || '08:00', 'aria-label': `Routine ${index + 1} time` });
      const hours = el('input', { type: 'number', min: '1', value: String(r.hours || 6), 'aria-label': `Routine ${index + 1} hours` });
      const when = el('div', { class: 'bots-routine-when' });
      const paintWhen = () => { time.hidden = r.schedule_kind !== 'daily'; hours.hidden = r.schedule_kind !== 'interval'; };
      when.append(Segmented({ label: 'Schedule', value: r.schedule_kind, options: [{ value: 'daily', label: 'Every day at' }, { value: 'interval', label: 'Every N hours' }],
        onChange: v => { r.schedule_kind = v; paintWhen(); ctx.touch(); } }), time, hours);
      paintWhen();
      name.addEventListener('input', () => { r.name = name.value; ctx.touch(); });
      prompt.addEventListener('input', () => { r.prompt = prompt.value; ctx.touch(); });
      time.addEventListener('input', () => { r.run_time = time.value; ctx.touch(); });
      hours.addEventListener('input', () => { r.hours = Number(hours.value) || 0; ctx.touch(); });
      const card = el('div', { class: 'bots-routine-card', 'data-routine': r.key }, [
        el('div', { class: 'bots-routine-head' }, [el('strong', { text: `Routine ${index + 1}` }),
          IconButton({ iconName: 'trash-2', label: `Remove routine ${index + 1}`, onClick: () => { ctx.draft.routines.splice(index, 1); draw(); ctx.touch(); } })]),
        Card({ children: [
          el('label', { class: 'bots-row bots-text-row' }, [rowMain('Name'), name]),
          el('label', { class: 'bots-row bots-stack-row' }, [rowMain('What to do'), prompt]),
          el('div', { class: 'bots-row bots-stack-row' }, [rowMain('When'), when]),
          el('div', { class: 'bots-row' }, [rowMain('Report'), Segmented({ label: 'Report', value: r.report_when, options: [{ value: 'notable', label: 'Only when notable' }, { value: 'always', label: 'Every time' }], onChange: v => { r.report_when = v; ctx.touch(); } })]),
          SwitchRow({ title: 'Create this routine', hint: r.enabled ? 'It is made together with the bot.' : 'Left off, it is not made. Turn it on to keep it.', checked: r.enabled !== false, onChange: v => { r.enabled = v; ctx.touch(); } }),
        ] })]);
      holder.append(card);
    });
    if (!ctx.draft.routines.length) holder.append(Card({ children: [el('div', { class: 'bots-row' }, [rowMain('No routines yet', 'Add one if this bot should check something on a schedule.')])] }));
  };
  ctx.syncs.push(draw); draw();
  const add = Button({ label: 'Add a routine', iconName: 'calendar-clock', onClick: () => {
    if (ctx.draft.routines.length >= M.LIMITS.routines) { toast(`A bot can start with ${M.LIMITS.routines} routines at most.`, 'error'); return; }
    ctx.draft.routines.push(M.blankRoutine()); draw(); ctx.touch(); holder.querySelector('.bots-routine-card:last-child input')?.focus();
  } });
  return el('div', {}, [holder, el('div', { class: 'bots-start-more' }, [add])]);
}

// Which MCP tool servers the bot may use: all (null) or a chosen list.
function toolServers(ctx) {
  const servers = ctx.bundle.integrations;
  const body = el('div', { class: 'bots-card-body' });
  const draw = () => {
    body.replaceChildren();
    const all = ctx.draft.integration_ids === null;
    body.append(SwitchRow({ title: 'Every connected tool server', hint: servers.length ? 'Turn off to pick which ones this bot may use.' : 'None are connected yet. Add one in Settings, under Integrations.',
      checked: all, onChange: v => { ctx.draft.integration_ids = v ? null : servers.map(s => s.id); draw(); ctx.touch(); } }));
    if (!all) for (const s of servers) body.append(SwitchRow({ title: s.name, checked: ctx.draft.integration_ids.includes(s.id),
      onChange: v => { const set = new Set(ctx.draft.integration_ids); if (v) set.add(s.id); else set.delete(s.id); ctx.draft.integration_ids = [...set]; ctx.touch(); } }));
  };
  draw();
  return el('div', { class: 'bots-card' }, [el('div', { class: 'bots-caps bots-card-label', text: 'Tool servers' }), body]);
}
