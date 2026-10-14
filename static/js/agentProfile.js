import { api, el, toast, confirmDialog } from './api.js';
import { mountDither } from './dither.js';

const SECTIONS = ['Overview', 'Identity', 'Soul', 'Skills', 'Memory', 'Routines', 'Access', 'Model', 'Permissions', 'Voice & alerts', 'History', 'Usage'];
const bytes = (value) => new TextEncoder().encode(value).length;

// 2026-10-13: a missing color needs the same portrait on every machine and
// reload; the ID hash picks one of the colors already accepted by the API.
const COLORS = ['#d9b260', '#b9d2e3', '#e8c39e', '#d99a92', '#b5c7a5', '#cdbfd9'];
export function profileColor(agent) {
  if (agent.color) return agent.color;
  let hash = 2166136261;
  for (const ch of agent.id || '') hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return COLORS[(hash >>> 0) % COLORS.length];
}

export function portrait(agent, size = 72) {
  const color = profileColor(agent);
  const face = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="${color}"/><circle cx="64" cy="55" r="31" fill="#F3EADB"/><path d="M13 128c4-30 23-44 51-44s47 14 51 44" fill="#F3EADB"/><circle cx="53" cy="55" r="3" fill="#282724"/><circle cx="75" cy="55" r="3" fill="#282724"/><path d="M54 68q10 8 20 0" fill="none" stroke="#282724" stroke-width="3" stroke-linecap="round"/></svg>`;
  const node = el('span', { class: 'agent-portrait', 'aria-hidden': 'true', style: `width:${size}px;height:${size}px;background:${color}` });
  node.dataset.color = color;
  // The Kairos circle remains visible when canvas or image loading fails.
  node.append(el('img', { class: 'agent-portrait-mark', src: '/static/img/kairos-icon.svg', alt: '' }));
  const stop = mountDither(node, `data:image/svg+xml,${encodeURIComponent(face)}`, { cell: 3, fixed: true });
  node.stopPortrait = stop;
  return node;
}

export function mountAgentProfile(root, initial, models, channels, onSaved) {
  let detail = initial, open = false, mode = 'simple', tab = 'details';
  const backdrop = el('div', { class: 'agent-profile-backdrop', hidden: true });
  const sheet = el('aside', { class: 'agent-profile-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bot profile', hidden: true });
  const body = el('div', { class: 'agent-profile-body' });
  const heading = el('h2', { text: detail.agent.name });
  let photo = portrait(detail.agent);
  const closeButton = el('button', { class: 'btn quiet', type: 'button', 'aria-label': 'Close profile', text: '×' });
  const titlebar = el('div', { class: 'agent-profile-titlebar' }, [photo, heading, closeButton]);
  const simpleButton = el('button', { class: 'btn quiet', type: 'button', text: 'Simple view' });
  const allButton = el('button', { class: 'btn quiet', type: 'button', text: 'All settings' });
  const detailsButton = el('button', { class: 'agent-profile-tab', type: 'button', text: 'Details' });
  const libraryButton = el('button', { class: 'agent-profile-tab', type: 'button', text: 'Library' });
  const simpleTabs = el('div', { class: 'agent-profile-tabs' }, [detailsButton, libraryButton]);
  const details = el('div', { class: 'agent-profile-details' });
  const library = el('div', { class: 'agent-profile-library' });
  const search = el('input', { type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings' });
  const accordion = el('div', { class: 'agent-profile-accordion' });
  const all = el('div', { class: 'agent-profile-all' }, [search, accordion]);
  const sections = new Map();
  for (const name of SECTIONS) {
    const content = el('div', { class: 'agent-profile-section-body' });
    const item = el('details', { class: 'agent-profile-section', 'data-section': name.toLowerCase() }, [el('summary', { text: name }), content]);
    sections.set(name, { item, content }); accordion.append(item);
  }
  const empty = (name) => el('p', { class: 'meta', text: `${name} settings are not available yet.` });
  for (const name of ['Skills', 'Routines', 'Permissions', 'Voice & alerts', 'Usage']) sections.get(name).content.append(empty(name));
  const fields = new Map();
  const field = (key, label, limit, multiline = false, countAfter = 0) => {
    const input = el(multiline ? 'textarea' : 'input', { 'aria-label': label, ...(multiline ? { rows: key === 'soul' ? '12' : '4' } : {}) });
    const counter = el('span', { class: 'meta agent-profile-counter' });
    const conflict = el('div', { class: 'agent-profile-conflict', hidden: true });
    const useServer = el('button', { class: 'btn quiet', type: 'button', text: 'Use server version' });
    const serverText = el('pre', { class: 'agent-profile-file-text' });
    conflict.append(el('span', { text: 'Changed on the server while you were editing. Your draft is kept; choose which version to use.' }), serverText, useServer);
    const wrap = el('label', { class: 'field agent-profile-field' }, [el('span', { text: label }), input, counter, conflict]);
    const state = { key, input, counter, conflict, wrap, limit, baseline: '', dirty: false, server: '' };
    const length = (value) => key === 'soul' ? bytes(value) : Array.from(value).length;
    const enforce = () => {
      if (length(input.value) > limit) {
        let value = '', used = 0;
        for (const ch of input.value) {
          const cost = key === 'soul' ? bytes(ch) : 1;
          if (used + cost > limit) break;
          used += cost; value += ch;
        }
        input.value = value;
      }
      const n = length(input.value);
      counter.textContent = `${n.toLocaleString()} / ${limit.toLocaleString()}${key === 'soul' ? ' bytes' : ''}`;
      counter.hidden = !!countAfter && n <= countAfter;
      state.dirty = input.value !== state.baseline;
      conflict.hidden = !state.dirty || state.server === state.baseline;
    };
    input.addEventListener('input', enforce);
    useServer.onclick = () => { state.baseline = state.server; input.value = state.server; enforce(); };
    state.sync = (value) => {
      value ??= '';
      state.server = value;
      serverText.textContent = value;
      if (state.dirty && input.value === value) { state.baseline = value; state.dirty = false; }
      if (!state.dirty && document.activeElement !== input) { state.baseline = value; if (input.value !== value) input.value = value; }
      enforce();
    };
    fields.set(key, state); return wrap;
  };
  const identity = el('div', { class: 'agent-profile-pair' }, [field('name', 'Name', 100), field('role', 'Job', 200)]);
  const instruction = field('instructions', 'Standing instructions', 24000, true);
  const blurb = field('blurb', 'Blurb', 4000, true, 3000);
  const soul = field('soul', 'Soul', 24000, true);
  const model = el('select', { 'aria-label': 'Default model' }, [el('option', { value: '', text: 'Claude (default)' }),
    ...models.map(m => el('option', { value: m.id, text: m.name }))]);
  const modelConflict = el('div', { class: 'agent-profile-conflict', hidden: true,
    text: 'Default model changed on the server. Your selection is kept; saving will use it. ' });
  modelConflict.append(el('button', { class: 'btn quiet', type: 'button', text: 'Use server version', onclick: () => {
    model.value = modelServer; modelBaseline = modelServer; modelConflict.hidden = true;
  } }));
  let modelBaseline = '', modelServer = '';
  const modelField = el('label', { class: 'field agent-profile-field' }, [el('span', { text: 'Default model' }), model, modelConflict]);
  model.addEventListener('change', () => { modelConflict.hidden = model.value === modelBaseline || modelServer === modelBaseline; });
  const extraFields = new Map();
  const extra = (key, label, input) => {
    const notice = el('div', { class: 'agent-profile-conflict', hidden: true,
      text: 'Changed on the server. Your draft is kept; saving will use your value. ' });
    const wrap = el('label', { class: 'field agent-profile-field' }, [el('span', { text: label }), input, notice]);
    const value = () => input.type === 'checkbox' ? input.checked : input.value;
    const assign = (next) => { if (input.type === 'checkbox') input.checked = !!next; else input.value = next ?? ''; };
    const state = { key, input, notice, baseline: undefined, server: undefined, value, sync(next) {
      next = input.type === 'checkbox' ? !!next : String(next ?? '');
      this.server = next;
      if (value() === next) this.baseline = next;
      if (this.baseline === undefined || (value() === this.baseline && document.activeElement !== input)) {
        assign(next); this.baseline = value();
      }
      notice.hidden = value() === this.baseline || this.server === this.baseline;
    } };
    input.addEventListener('input', () => { notice.hidden = value() === state.baseline || state.server === state.baseline; });
    input.addEventListener('change', () => { notice.hidden = value() === state.baseline || state.server === state.baseline; });
    notice.append(el('button', { class: 'btn quiet', type: 'button', text: 'Use server version', onclick: (event) => {
      event.preventDefault(); assign(state.server); state.baseline = state.server; notice.hidden = true;
    } }));
    extraFields.set(key, state); return wrap;
  };
  const enabled = extra('enabled', 'On', el('input', { type: 'checkbox' }));
  const cap = extra('daily_run_cap', 'Runs per day', el('input', { type: 'number', min: '1', max: '200' }));
  const keep = extra('keep_signed_in', 'Keep browser sign in', el('input', { type: 'checkbox' }));
  const upkeep = extra('memory_upkeep', 'Memory upkeep', el('input', { type: 'checkbox' }));
  const channel = extra('deliver_to_channel', 'Tell me on', el('select', {}, [
    el('option', { value: '', text: 'In the app only' }), ...channels.map(c => el('option', { value: c.id, text: c.label }))]));
  const save = el('button', { class: 'btn primary', type: 'button', text: 'Save profile' });
  const soulDrift = el('div', { class: 'agent-profile-drift', hidden: true });
  const fileText = el('pre', { class: 'agent-profile-file-text' });
  const apply = el('button', { class: 'btn', type: 'button', text: 'Apply file to profile' });
  const soulError = el('p', { class: 'is-error', role: 'alert', hidden: true });
  soulDrift.append(el('p', { text: 'SOUL.md was edited outside Kairos. The stored soul and the file differ.' }),
    el('strong', { text: 'File text' }), fileText, apply, soulError);
  const memory = el('div', { class: 'agent-profile-memory' });
  const access = el('div', { class: 'agent-profile-access' });
  const history = el('div', { class: 'agent-profile-history' });
  const routines = el('p', { class: 'meta' });
  const usage = el('p', { class: 'meta' });
  const forget = el('button', { class: 'btn quiet', type: 'button', text: 'Forget browser logins', onclick: async () => {
    try { await api(`/api/agents/${detail.agent.id}/forget-logins`, { method: 'POST' }); toast('Logins forgotten', 'success'); }
    catch (error) { toast(error.message, 'error'); }
  } });
  const remove = el('button', { class: 'btn danger', type: 'button', text: 'Delete bot', onclick: async () => {
    if (!await confirmDialog({ title: `Delete ${detail.agent.name}?`, message: 'Its memory, goals, unfinished work and inbox go. Its chats move to Chats; finished results and run history stay.', confirmLabel: 'Delete agent' })) return;
    try { await api(`/api/agents/${detail.agent.id}`, { method: 'DELETE' }); close();
      document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'agents' } })); }
    catch (error) { toast(error.message, 'error'); }
  } });
  // A field has one DOM node. Switching modes moves it, preserving its value.
  // Separate save buttons avoid moving the same button between sections.
  const sectionSave = () => el('button', { class: 'btn primary', type: 'button', text: 'Save profile', onclick: () => save.click() });
  details.append(identity, instruction, modelField, allButton, save);
  sections.get('Overview').content.append(blurb, enabled, sectionSave());
  sections.get('Soul').content.append(soulDrift, soul, sectionSave());
  sections.get('Memory').content.append(memory, upkeep, sectionSave());
  sections.get('Routines').content.replaceChildren(routines, cap, sectionSave());
  sections.get('Access').content.append(access, keep, sectionSave(), forget, remove);
  sections.get('Voice & alerts').content.replaceChildren(channel, sectionSave());
  sections.get('Usage').content.replaceChildren(usage);
  sections.get('History').content.append(history);
  const identitySlot = sections.get('Identity').content;
  const modelSlot = sections.get('Model').content;
  identitySlot.append(sectionSave());
  modelSlot.append(sectionSave());
  const setMode = (next) => {
    mode = next;
    if (mode === 'all') { identitySlot.prepend(identity, instruction); modelSlot.prepend(modelField); }
    else { details.prepend(identity, instruction, modelField); }
    simpleTabs.hidden = mode !== 'simple'; details.hidden = mode !== 'simple' || tab !== 'details';
    library.hidden = mode !== 'simple' || tab !== 'library'; all.hidden = mode !== 'all'; simpleButton.hidden = mode !== 'all';
  };
  const setTab = (next) => { tab = next; detailsButton.classList.toggle('active', tab === 'details');
    libraryButton.classList.toggle('active', tab === 'library'); setMode(mode); if (next === 'library') loadLibrary(); };
  const update = (next) => {
    detail = next;
    heading.textContent = next.agent.name;
    if (photo.dataset.color !== profileColor(next.agent)) { photo.stopPortrait?.(); const replacement = portrait(next.agent); replacement.dataset.color = profileColor(next.agent); photo.replaceWith(replacement); photo = replacement; }
    for (const [key, state] of fields) state.sync(key === 'soul' ? next.soul_file?.soul : next.agent[key]);
    for (const [key, state] of extraFields) state.sync(next.agent[key]);
    modelServer = next.agent.endpoint_id || '';
    if (model.value === modelServer) modelBaseline = modelServer;
    if (model.value === modelBaseline && document.activeElement !== model) { model.value = modelServer; modelBaseline = modelServer; }
    modelConflict.hidden = model.value === modelBaseline || modelServer === modelBaseline;
    const sf = next.soul_file || { soul: next.agent.soul, file_text: next.agent.soul, in_sync: true, revision: next.agent.revision };
    soulDrift.hidden = sf.in_sync;
    fileText.textContent = sf.file_text === null ? '(file is missing)' : sf.file_text;
    memory.textContent = next.memory ? `${next.memory.slice(0, 700)}${next.memory.length > 700 ? '…' : ''}` : 'No memory yet.';
    access.textContent = next.agent.keep_signed_in ? 'Browser sign in is kept between runs.' : 'Browser sign in is cleared between runs.';
    history.textContent = `${(next.runs || []).length} recent runs.`;
    routines.textContent = `${(next.goals || []).length} standing goals.`;
    usage.textContent = `${next.agent.runs_today || 0} of ${next.agent.daily_run_cap || 0} runs today.`;
    forget.disabled = next.agent.status === 'working';
  };
  const loadLibrary = async () => {
    library.replaceChildren(el('p', { class: 'meta', text: 'Loading files…' }));
    try {
      const sessions = await api(`/api/sessions?agent_id=${encodeURIComponent(detail.agent.id)}`);
      const batches = await Promise.all(sessions.map(async session => ({ session,
        files: await api(`/api/chat/files?session_id=${encodeURIComponent(session.id)}`).catch(() => []) })));
      if (tab !== 'library' || !open) return;
      const files = batches.flatMap(({ session, files }) => files.map(file => ({ ...file, session })));
      files.sort((a, b) => (b.created_at || b.session.updated_at || 0) - (a.created_at || a.session.updated_at || 0));
      library.replaceChildren(...(files.length ? files.map(file => {
        const image = /\.(png|jpe?g|webp|gif)$/i.test(file.name);
        return el('a', { class: 'agent-profile-file', href: file.url, target: '_blank', rel: 'noopener noreferrer' }, [
          image ? el('img', { src: file.url, alt: '' }) : el('span', { class: 'agent-profile-file-icon', text: '▤' }),
          el('span', { text: file.name }),
        ]);
      })
        : [el('p', { class: 'meta', text: 'No images or files from this bot yet.' })]));
    } catch (error) { library.textContent = `Files could not be loaded: ${error.message}`; }
  };
  save.onclick = async () => {
    const changes = {};
    for (const [key, state] of fields) if (state.dirty) changes[key] = state.input.value;
    for (const [key, state] of extraFields) if (state.value() !== state.baseline) {
      changes[key] = key === 'daily_run_cap' ? Number(state.value()) : key === 'deliver_to_channel' ? state.value() || null : state.value();
    }
    if (model.value !== modelBaseline) changes.endpoint_id = model.value || null;
    if (!Object.keys(changes).length) return;
    // 2026-10-13: read once before writing so a change between polls is
    // shown before the person's first Save. A second Save chooses the draft.
    let fresh;
    try { fresh = await api(`/api/agents/${detail.agent.id}`); }
    catch (error) { toast(error.message, 'error'); return; }
    const unseen = [...fields.values()].some(state => changes[state.key] !== undefined
      && (state.key === 'soul' ? fresh.soul_file?.soul : fresh.agent[state.key]) !== state.baseline && state.conflict.hidden)
      || [...extraFields.values()].some(state => changes[state.key] !== undefined
        && (state.input.type === 'checkbox' ? !!fresh.agent[state.key] : String(fresh.agent[state.key] ?? '')) !== state.baseline && state.notice.hidden)
      || (changes.endpoint_id !== undefined && (fresh.agent.endpoint_id || '') !== modelBaseline && modelConflict.hidden);
    update(fresh);
    if (unseen) { toast('Server settings changed. Your draft is kept; review the changes, then save again if you want your version.', 'info'); return; }
    if (changes.soul !== undefined && detail.soul_file && !detail.soul_file.in_sync) {
      soulError.textContent = 'Apply or resolve the external SOUL.md edit before saving soul.'; soulError.hidden = false; return;
    }
    try {
      const agent = await api(`/api/agents/${detail.agent.id}`, { method: 'PATCH', body: JSON.stringify(changes), toast: false });
      for (const state of fields.values()) if (changes[state.key] !== undefined) { state.baseline = state.input.value; state.dirty = false; }
      for (const state of extraFields.values()) if (changes[state.key] !== undefined) state.baseline = state.value();
      detail.agent = agent;
      if (changes.soul !== undefined) detail.soul_file = { soul: agent.soul, file_text: agent.soul, in_sync: true, revision: agent.revision };
      else if (detail.soul_file) detail.soul_file.revision = agent.revision;
      if (changes.endpoint_id !== undefined) modelBaseline = model.value;
      update(detail); toast('Profile saved', 'success'); onSaved();
    } catch (error) { soulError.textContent = error.message; soulError.hidden = false; toast(error.message, 'error'); }
  };
  apply.onclick = async () => {
    const held = detail.soul_file;
    try {
      const result = await api(`/api/agents/${detail.agent.id}/soul/apply`, { method: 'POST', toast: false,
        body: JSON.stringify({ expected_file_text: held.file_text, expected_revision: held.revision }) });
      soulError.hidden = true;
      detail.soul_file = result; detail.agent.soul = result.soul; detail.agent.revision = result.revision;
      update(detail); toast('SOUL.md applied', 'success'); onSaved();
    } catch (error) { soulError.textContent = error.message; soulError.hidden = false; }
  };
  search.addEventListener('input', () => { const q = search.value.trim().toLowerCase();
    for (const [name, section] of sections) section.item.hidden = !!q && !name.toLowerCase().includes(q); });
  const close = () => { if (!open) return; open = false; sheet.hidden = backdrop.hidden = true; opener?.focus(); };
  let opener = null;
  const openSheet = () => { opener = document.activeElement; open = true; sheet.hidden = backdrop.hidden = false; setTab('details'); setMode('simple'); closeButton.focus(); };
  closeButton.onclick = close; backdrop.onclick = close; allButton.onclick = () => setMode('all'); simpleButton.onclick = () => setMode('simple');
  detailsButton.onclick = () => setTab('details'); libraryButton.onclick = () => setTab('library');
  const keydown = (event) => { if (open && event.key === 'Escape') { event.preventDefault(); close(); } };
  document.addEventListener('keydown', keydown);
  sheet.append(el('div', { class: 'agent-profile-top' }, [titlebar, simpleButton]), simpleTabs, body);
  body.append(details, library, all); root.append(backdrop, sheet);
  update(detail); setTab('details');
  return { open: openSheet, update, close, dispose: () => { document.removeEventListener('keydown', keydown); photo.stopPortrait?.(); sheet.remove(); backdrop.remove(); } };
}
