// The shared avatar editor (Phase 1, unit U2; OMB F16 and F17, re-written for Kairos). One component for
// a bot's Identity section, the Simple hero popover and the new-bot dialog:
//   - the Kip look (body colour, shape, accessory) through the existing picker, and an expression,
//   - an optional picture: upload, choose its shape, zoom and focus point, or generate one from a
//     short description through a saved image connection,
//   - Reset, which clears the picture and expression and brings the bot's own Kip back.
//
//   mountAvatarEditor(host, {agent, draft, ctx}) -> {destroy, getDraft, refresh}
//     agent  the bot (or {id: null} in draft mode, the new-bot dialog)
//     draft  true: pictures go to the signed-in person's draft folder and are returned by getDraft()
//     ctx    {update(patch), flush(), api, toast}; ctx.update saves the Kip look and expression
//
// A picture is applied only by its button, against the avatar snapshot taken when it was staged, so a
// late generated picture cannot replace a newer edit (the server answers 409 and the message is shown).
// The pure helpers at the top load in plain Node (scripts/test_bots_avatar_editor.cjs).
import { IMAGE_SHAPES, avatarImageUrl, cleanFraming, framingStyle } from './agentAvatar.js';
import { EXPRESSIONS } from './botsKip.js';

export { IMAGE_SHAPES, cleanFraming, framingStyle };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DIRECTION = 400;
export const ACCEPTED_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const SHAPE_LABELS = Object.freeze({ circle: 'Circle', rounded: 'Rounded', square: 'Square', kip: 'Kip shape' });
export const EXPRESSION_LABELS = Object.freeze({
  sleeping: 'Asleep', idle: 'Calm', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking',
  success: 'Pleased', needs: 'Needs you', error: 'Worried', carry: 'Carrying',
});
export const PROVIDER_KINDS = Object.freeze([
  { value: 'openai', label: 'OpenAI' }, { value: 'xai', label: 'xAI' }, { value: 'compatible', label: 'Another server' }]);
// Keyboard steps for the focus point and zoom: arrows move the picture, shift moves it further.
export const FOCUS_STEP = 0.02, FOCUS_STEP_BIG = 0.1, ZOOM_STEP = 0.1;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Quick refusals before anything is sent; the server decodes the picture and decides for real.
export function checkFile(file) {
  if (!file) return 'Choose a picture to upload.';
  if (!ACCEPTED_TYPES.includes(file.type)) return 'Use a PNG, JPEG, GIF or WebP picture.';
  if (!(file.size > 0)) return 'That file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return 'That picture is larger than 10 MB.';
  return '';
}

// A framing changed by a key: returns the new framing, or null when the key is not one it uses.
export function framingForKey(framing, key, { shift = false } = {}) {
  const f = cleanFraming(framing);
  if (!f) return null;
  const step = shift ? FOCUS_STEP_BIG : FOCUS_STEP;
  const next = { ...f };
  if (key === 'ArrowLeft') next.focus_x = clamp(f.focus_x - step, 0, 1);
  else if (key === 'ArrowRight') next.focus_x = clamp(f.focus_x + step, 0, 1);
  else if (key === 'ArrowUp') next.focus_y = clamp(f.focus_y - step, 0, 1);
  else if (key === 'ArrowDown') next.focus_y = clamp(f.focus_y + step, 0, 1);
  else if (key === '+' || key === '=') next.zoom = clamp(f.zoom + ZOOM_STEP, 1, 3);
  else if (key === '-' || key === '_') next.zoom = clamp(f.zoom - ZOOM_STEP, 1, 3);
  else return null;
  next.focus_x = Math.round(next.focus_x * 1000) / 1000; next.focus_y = Math.round(next.focus_y * 1000) / 1000;
  next.zoom = Math.round(next.zoom * 100) / 100;
  return next;
}

// Dragging the preview moves the focus the other way: the picture follows the pointer. dx and dy are
// pixels, box the preview's size in pixels.
export function framingForDrag(framing, dx, dy, box) {
  const f = cleanFraming(framing);
  if (!f || !(box > 0)) return f;
  const range = box * f.zoom;
  return { ...f, focus_x: Math.round(clamp(f.focus_x - dx / range, 0, 1) * 1000) / 1000, focus_y: Math.round(clamp(f.focus_y - dy / range, 0, 1) * 1000) / 1000 };
}

// The body of PUT /api/agents/{id}/avatar-image for a staged or applied picture.
export function applyBody(framing, snapshot) {
  const f = cleanFraming(framing);
  if (!f) return null;
  return { asset_id: f.asset_id, shape: f.shape, zoom: f.zoom, focus_x: f.focus_x, focus_y: f.focus_y, ...(snapshot ? { expected_snapshot: snapshot } : {}) };
}

// What the generate form may send, or the sentence to show instead.
export function checkDirection(text) {
  const value = String(text ?? '').trim();
  if (!value) return { error: 'Describe the picture you want.' };
  if (value.length > MAX_DIRECTION) return { error: `Keep the description under ${MAX_DIRECTION} characters.` };
  return { direction: value };
}

export function checkProvider({ kind, key, base_url: baseUrl }) {
  if (!PROVIDER_KINDS.some(p => p.value === kind)) return 'Choose OpenAI, xAI or another server.';
  if (String(key || '').trim().length < 8) return 'Paste the connection key.';
  if (kind === 'compatible' && !String(baseUrl || '').trim()) return 'Another server needs its address.';
  return '';
}

// -- the component -----------------------------------------------------------------------------------

const messageOf = error => String(error?.message || error).replace(/^\d+:\s*/, '');

export function mountAvatarEditor(host, { agent, draft = false, ctx } = {}) {
  const { api, toast } = ctx;
  const state = { agent: { ...agent }, staged: null, snapshot: agent?.avatar_snapshot || '', busy: '', provider: null,
    draftImage: draft ? cleanFraming(agent?.avatar_image) : null, error: '' };
  let destroyed = false, pickerModule = null;
  const root = document.createElement('div');
  root.className = 'bots-avatar-editor';
  host.replaceChildren(root);

  const base = () => (draft ? '/api/agents/avatar-drafts' : `/api/agents/${encodeURIComponent(state.agent.id)}/avatar-image`);
  const current = () => state.staged?.framing || cleanFraming(draft ? state.draftImage : state.agent.avatar_image);
  const asAgent = framing => ({ ...state.agent, avatar_image: framing ? { ...framing, ...(draft ? { draft: true } : {}) } : null });
  // Any change to the picture's shape, zoom or focus is staged until the person saves it.
  const setFraming = next => {
    if (state.staged) state.staged.framing = next; else state.staged = { framing: next, snapshot: state.snapshot, fresh: false };
  };
  const say = (text, kind = 'error') => { state.error = text; if (text) toast(text, kind); };
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  };
  const button = (label, onClick, { variant = '', disabled = false, name = '' } = {}) => el('button', {
    type: 'button', class: `bots-btn ${variant}`.trim(), disabled: disabled || undefined, 'data-action': name || undefined, onclick: onClick, text: label });

  async function mod() {
    if (!pickerModule) pickerModule = await import('./agentAvatar.js');
    return pickerModule;
  }

  // -- the picture ----------------------------------------------------------------------------
  async function upload(file) {
    const refusal = checkFile(file);
    if (refusal) { say(refusal); draw(); return; }
    state.busy = 'upload'; state.error = ''; draw();
    try {
      if (!draft) await ctx.flush?.();
      const staged = await api(base(), { method: 'POST', headers: { 'Content-Type': file.type }, body: file, toast: false });
      stage(staged);
    } catch (error) { say(messageOf(error)); }
    state.busy = ''; draw();
  }
  function stage(staged) {
    const framing = cleanFraming({ asset_id: staged.asset_id, shape: current()?.shape || 'circle', zoom: 1, focus_x: 0.5, focus_y: 0.5 });
    state.staged = { framing, snapshot: staged.snapshot || state.snapshot, fresh: true };
  }
  async function generate(direction) {
    const checked = checkDirection(direction);
    if (checked.error) { say(checked.error); draw(); return; }
    state.busy = 'generate'; state.error = ''; draw();
    try {
      if (!draft) await ctx.flush?.();
      const staged = await api(`${base()}/generate`, { method: 'POST', body: JSON.stringify({ direction: checked.direction, ...(draft ? {} : { snapshot: state.snapshot }) }), toast: false });
      stage(staged);
    } catch (error) { say(messageOf(error)); }
    state.busy = ''; draw();
  }
  async function apply() {
    const framing = current();
    if (!framing) return;
    if (draft) {
      state.draftImage = framing; state.staged = null; state.agent.avatar_image = { ...framing, draft: true };
      host.dispatchEvent(new CustomEvent('bots-avatar-draft', { bubbles: true, detail: { avatar_image: { ...framing } } }));
      draw(); return;
    }
    state.busy = 'apply'; draw();
    try {
      await ctx.flush?.();
      const saved = await api(base(), { method: 'PUT', body: JSON.stringify(applyBody(framing, state.staged?.snapshot)), toast: false });
      state.agent = { ...state.agent, ...saved }; state.staged = null; state.snapshot = saved.avatar_snapshot || state.snapshot;
      ctx.adopt?.(saved);
      toast('Picture saved', 'success');
    } catch (error) { say(messageOf(error)); state.staged = null; await refreshSnapshot(); }
    state.busy = ''; draw();
  }
  async function reset() {
    state.busy = 'reset'; draw();
    try {
      if (draft) {
        state.draftImage = null; state.staged = null; state.agent.avatar_image = null; state.agent.mascot_expression = null;
        host.dispatchEvent(new CustomEvent('bots-avatar-draft', { bubbles: true, detail: { avatar_image: null } }));
      } else {
        await ctx.flush?.();
        const saved = await api(base(), { method: 'PUT', body: JSON.stringify({ asset_id: null }), toast: false });
        state.agent = { ...state.agent, ...saved }; state.staged = null; ctx.adopt?.(saved);
        await refreshSnapshot();
      }
      toast('Back to the Kip look', 'success');
    } catch (error) { say(messageOf(error)); }
    state.busy = ''; draw();
  }
  async function refreshSnapshot() {
    if (draft) return;
    try { state.snapshot = (await api(`/api/agents/${encodeURIComponent(state.agent.id)}`, { toast: false })).avatar_snapshot || ''; } catch { /* keeps the old one */ }
  }

  // -- the image connection --------------------------------------------------------------------
  async function loadProvider() {
    try { state.provider = await api('/api/agents/avatar-provider', { toast: false }); } catch { state.provider = { configured: false, unreadable: true }; }
    if (!destroyed) draw();
  }
  async function saveProvider(form) {
    const body = { kind: form.kind.value, key: form.key.value, ...(form.base.value.trim() ? { base_url: form.base.value.trim() } : {}), ...(form.model.value.trim() ? { model: form.model.value.trim() } : {}) };
    const refusal = checkProvider({ ...body });
    if (refusal) { say(refusal); return; }
    state.busy = 'provider'; draw();
    try { state.provider = await api('/api/agents/avatar-provider', { method: 'PUT', body: JSON.stringify(body), toast: false }); toast('Image connection saved', 'success'); }
    catch (error) { say(messageOf(error)); }
    form.key.value = '';
    state.busy = ''; draw();
  }
  async function clearProvider() {
    try { state.provider = await api('/api/agents/avatar-provider', { method: 'DELETE', toast: false }); } catch (error) { say(messageOf(error)); }
    draw();
  }

  // -- drawing ----------------------------------------------------------------------------------
  function preview(framing) {
    const box = el('div', { class: 'bots-avatar-preview', 'data-shape': framing?.shape || 'kip-look', tabindex: framing ? '0' : undefined,
      role: framing ? 'group' : undefined, 'aria-label': framing ? 'Picture position. Arrow keys move it, plus and minus zoom.' : undefined });
    mod().then(({ agentAvatar }) => {
      if (destroyed) return;
      box.replaceChildren(agentAvatar(asAgent(framing), 132));
    });
    if (framing) {
      let drag = null;
      const frame = () => { const holder = box.querySelector('.agent-avatar-picture'); if (holder && current()) { Object.assign(holder.querySelector('img').style, framingStyle(current())); holder.dataset.shape = current().shape; } };
      const move = next => { if (!next) return; setFraming(next); frame(); syncControls(); };
      box.addEventListener('pointerdown', event => { drag = { x: event.clientX, y: event.clientY, framing: current() }; box.setPointerCapture?.(event.pointerId); });
      box.addEventListener('pointermove', event => { if (drag) move(framingForDrag(drag.framing, event.clientX - drag.x, event.clientY - drag.y, box.clientWidth || 132)); });
      const end = () => { drag = null; };
      box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
      box.addEventListener('keydown', event => { const next = framingForKey(current(), event.key, { shift: event.shiftKey }); if (next) { event.preventDefault(); move(next); } });
    }
    return box;
  }
  function syncControls() {
    const f = current();
    for (const [name, value] of [['zoom', f?.zoom], ['focus_x', f?.focus_x], ['focus_y', f?.focus_y]]) {
      const input = root.querySelector(`[data-control="${name}"]`);
      if (input && f) input.value = String(value);
    }
    const apply = root.querySelector('[data-action="apply"]');
    if (apply) apply.disabled = !state.staged;
  }
  function slider(name, label, min, max, step, value) {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label, 'data-control': name });
    input.value = String(value);
    input.addEventListener('input', () => {
      const f = current(); if (!f) return;
      const next = { ...f, [name]: Number(input.value) };
      setFraming(next);
      const holder = root.querySelector('.bots-avatar-preview .agent-avatar-picture');
      if (holder) { Object.assign(holder.querySelector('img').style, framingStyle(next)); }
      const apply = root.querySelector('[data-action="apply"]'); if (apply) apply.disabled = false;
    });
    return el('label', { class: 'bots-avatar-slider' }, [el('span', { text: label }), input]);
  }
  function shapes(framing) {
    const group = el('div', { class: 'bots-segmented', role: 'radiogroup', 'aria-label': 'Picture shape' });
    for (const shape of IMAGE_SHAPES) {
      const on = framing.shape === shape;
      const item = el('button', { type: 'button', role: 'radio', 'data-value': shape, 'aria-checked': String(on), tabindex: on ? '0' : '-1', text: SHAPE_LABELS[shape] });
      item.addEventListener('click', () => {
        setFraming({ ...current(), shape });
        draw();
      });
      group.append(item);
    }
    group.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]; if (!step) return;
      event.preventDefault();
      const items = [...group.children], at = items.findIndex(b => b.getAttribute('aria-checked') === 'true');
      const target = items[(at + step + items.length) % items.length]; target.focus(); target.click();
    });
    return group;
  }
  function generateForm() {
    const input = el('input', { type: 'text', class: 'bots-avatar-direction', maxlength: String(MAX_DIRECTION), 'aria-label': 'Describe the picture', placeholder: 'A friendly fox in a scarf' });
    const count = el('small', { class: 'bots-count', text: `0 / ${MAX_DIRECTION}` });
    input.addEventListener('input', () => { count.textContent = `${input.value.length} / ${MAX_DIRECTION}`; });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); generate(input.value); } });
    return el('div', { class: 'bots-avatar-generate' }, [input, count,
      button(state.busy === 'generate' ? 'Making it…' : 'Generate', () => generate(input.value), { disabled: !!state.busy, name: 'generate' })]);
  }
  function providerForm() {
    const form = {
      kind: el('select', { 'aria-label': 'Image service' }, PROVIDER_KINDS.map(p => el('option', { value: p.value, text: p.label }))),
      key: el('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Connection key', placeholder: 'Paste the key' }),
      base: el('input', { type: 'text', 'aria-label': 'Server address', placeholder: 'https://… (another server only)' }),
      model: el('input', { type: 'text', 'aria-label': 'Image model', placeholder: 'Model name (optional)' }),
    };
    const own = () => { form.base.hidden = form.kind.value !== 'compatible'; };
    form.kind.addEventListener('change', own); own();
    return el('div', { class: 'bots-avatar-provider' }, [
      el('p', { class: 'bots-hint', text: 'To make pictures, save a connection to an image service. The key is stored encrypted and is never shown again.' }),
      form.kind, form.base, form.key, form.model,
      button('Save connection', () => saveProvider(form), { disabled: !!state.busy, name: 'save-provider' })]);
  }

  // The Kip look picker is built once and moved into each redraw, so its focus and choices persist.
  let kipHolder = null;
  function kipDetails() {
    if (!kipHolder) {
      kipHolder = el('details', { class: 'bots-avatar-kip' }, [el('summary', { text: 'Kip look' })]);
      mod().then(({ avatarPicker }) => {
        if (destroyed) return;
        const picker = avatarPicker(state.agent.avatar || { id: state.agent.id, color: state.agent.color }, spec => {
          state.agent.avatar = spec;
          if (draft) host.dispatchEvent(new CustomEvent('bots-avatar-draft', { bubbles: true, detail: { avatar: spec } }));
          else ctx.update({ avatar: spec });
        });
        kipHolder.append(picker.root);
      });
    }
    return kipHolder;
  }

  function draw() {
    if (destroyed) return;
    const focused = root.contains(document.activeElement) ? document.activeElement.getAttribute('data-action') || document.activeElement.getAttribute('data-control') : '';
    const framing = current();
    const stagedNote = state.staged ? el('p', { class: 'bots-hint', role: 'status', text: state.staged.fresh ? 'New picture. Move it, then use it.' : 'Changes are not saved yet.' }) : null;
    const parts = [el('div', { class: 'bots-avatar-top' }, [preview(framing)]), kipDetails()];
    // Expression: automatic, or one the bot always shows.
    const expression = el('select', { 'aria-label': 'Expression', 'data-control': 'expression' }, [el('option', { value: '', text: 'Automatic' }),
      ...EXPRESSIONS.map(name => el('option', { value: name, text: EXPRESSION_LABELS[name] }))]);
    expression.value = state.agent.mascot_expression || '';
    expression.addEventListener('change', () => {
      state.agent.mascot_expression = expression.value || null;
      if (draft) host.dispatchEvent(new CustomEvent('bots-avatar-draft', { bubbles: true, detail: { mascot_expression: state.agent.mascot_expression } }));
      else ctx.update({ mascot_expression: state.agent.mascot_expression });
    });
    const picture = el('div', { class: 'bots-avatar-picture-tools' }, [
      el('div', { class: 'bots-avatar-actions' }, [
        button(state.busy === 'upload' ? 'Uploading…' : framing ? 'Replace picture' : 'Upload picture', () => fileInput.click(), { disabled: !!state.busy, name: 'upload' }),
        button('Reset to Kip', reset, { disabled: !!state.busy || (!framing && !state.agent.mascot_expression), name: 'reset' })]),
      stagedNote]);
    const fileInput = el('input', { type: 'file', accept: ACCEPTED_TYPES.join(','), class: 'bots-avatar-file', 'aria-label': 'Choose a picture', tabindex: '-1', hidden: true, 'data-control': 'file' });
    fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; fileInput.value = ''; if (file) upload(file); });
    picture.append(fileInput);
    if (framing) {
      picture.append(shapes(framing), slider('zoom', 'Zoom', 1, 3, 0.05, framing.zoom), slider('focus_x', 'Left to right', 0, 1, 0.01, framing.focus_x), slider('focus_y', 'Top to bottom', 0, 1, 0.01, framing.focus_y));
      picture.append(el('div', { class: 'bots-avatar-actions' }, [button(draft ? 'Use this picture' : 'Save picture', apply, { variant: 'primary', disabled: !!state.busy || !state.staged, name: 'apply' }),
        state.staged ? button('Cancel', () => { state.staged = null; draw(); }, { name: 'cancel' }) : null]));
    }
    const make = el('details', { class: 'bots-avatar-make' }, [el('summary', { text: 'Make a picture' }),
      state.provider === null ? el('p', { class: 'bots-hint', text: 'Checking…' })
        : state.provider.configured ? el('div', {}, [generateForm(), el('p', { class: 'bots-hint', text: `Using ${PROVIDER_KINDS.find(p => p.value === state.provider.kind)?.label || 'your image service'}, ${state.provider.model}.` }),
          button('Remove connection', clearProvider, { name: 'clear-provider' })])
          : providerForm()]);
    if (state.makeOpen) make.open = true;
    make.addEventListener('toggle', () => { state.makeOpen = make.open; });
    const error = state.error ? el('p', { class: 'bots-error', role: 'alert', text: state.error }) : null;
    root.replaceChildren(...parts, el('label', { class: 'bots-avatar-expression' }, [el('span', { text: 'Expression' }), expression]), picture, make, error);
    if (focused) root.querySelector(`[data-action="${focused}"], [data-control="${focused}"]`)?.focus();
  }
  draw();
  if (state.provider === null) loadProvider();

  return {
    destroy() { destroyed = true; root.remove(); },
    getDraft: () => ({ avatar_image: state.draftImage ? { ...state.draftImage } : null, mascot_expression: state.agent.mascot_expression || null }),
    // A newer record arrived (a poll or a save): keep a staged picture, take the stored one.
    refresh(next) {
      if (!next || destroyed) return;
      state.agent = { ...state.agent, ...next };
      if (next.avatar_snapshot) state.snapshot = next.avatar_snapshot;
      if (!root.contains(document.activeElement)) draw();
    },
    avatarImageUrl,
  };
}
