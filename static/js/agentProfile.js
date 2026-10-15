import { api, el, toast, confirmDialog } from './api.js';
import { agentAvatar, avatarPicker, avatarSpec } from './agentAvatar.js';
import { routinesPanel } from './routinesPanel.js';
import { agentModelPicker } from './agentModelPicker.js';
import { pageHeader, group, row, toggle, note } from './settingsKit.js';

const SECTIONS = ['Overview', 'Identity', 'Soul', 'Skills', 'Memory', 'Routines', 'Access', 'Model', 'Permissions', 'Voice & alerts', 'History', 'Usage'];
const bytes = (value) => new TextEncoder().encode(value).length;

export function mountAgentProfile(root, initial, models, channels, onSaved) {
  let detail = initial, open = false, mode = 'simple', tab = 'details';
  const backdrop = el('div', { class: 'agent-profile-backdrop', hidden: true });
  const sheet = el('aside', { class: 'agent-profile-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bot profile', hidden: true });
  const body = el('div', { class: 'agent-profile-body' });
  const heading = el('h2', { text: detail.agent.name });
  let photo = agentAvatar(detail.agent);
  const closeButton = el('button', { class: 'btn quiet', type: 'button', 'aria-label': 'Close profile', text: '×' });
  const titlebar = el('div', { class: 'agent-profile-titlebar' }, [photo, heading, closeButton]);
  const simpleButton = el('button', { class: 'btn quiet', type: 'button', text: 'Simple view' });
  const allButton = el('button', { class: 'btn quiet', type: 'button', text: 'All settings' });
  const detailsButton = el('button', { class: 'segmented-tab agent-profile-tab', type: 'button', role: 'tab', text: 'Details' });
  const libraryButton = el('button', { class: 'segmented-tab agent-profile-tab', type: 'button', role: 'tab', text: 'Library' });
  const simpleTabs = el('div', { class: 'segmented-tabs agent-profile-tabs', role: 'tablist', 'aria-label': 'Profile views' }, [detailsButton, libraryButton]);
  const details = el('div', { class: 'agent-profile-details', role: 'tabpanel' });
  const library = el('div', { class: 'agent-profile-library', role: 'tabpanel' });
  const search = el('input', { type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings' });
  const accordion = el('div', { class: 'agent-profile-accordion' });
  const all = el('div', { class: 'agent-profile-all' }, [pageHeader('All settings', 'Every part of this bot, in one place.'), search, accordion]);
  const sections = new Map();
  for (const name of SECTIONS) {
    const content = el('div', { class: 'set-group agent-profile-section-body' });
    const summary = el('summary', {}, [el('span', { class: 'set-section-title', text: name }), el('span', { class: 'agent-profile-chevron', 'aria-hidden': 'true', text: '›' })]);
    const item = el('details', { class: 'set-section agent-profile-section', 'data-section': name.toLowerCase() }, [summary, content]);
    // 2026-10-14: keep disclosure content mounted for drafts; animate its
    // measured height while native summary keeps Enter and Space behaviour.
    summary.addEventListener('click', event => {
      event.preventDefault();
      const opening = !item.open;
      content.getAnimations().forEach(animation => animation.cancel());
      if (opening) item.open = true;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { item.open = opening; return; }
      const height = content.scrollHeight;
      const animation = content.animate(opening
        ? [{ height: '0px', opacity: 0 }, { height: `${height}px`, opacity: 1 }]
        : [{ height: `${height}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
      animation.onfinish = () => { if (!opening) item.open = false; };
    });
    sections.set(name, { item, content }); accordion.append(item);
  }
  const empty = (name) => note(`${name} settings are not available yet.`);
  for (const name of ['Skills', 'Routines', 'Permissions', 'Voice & alerts', 'Usage']) sections.get(name).content.append(empty(name));
  const fields = new Map();
  const field = (key, label, limit, multiline = false, countAfter = 0) => {
    const input = el(multiline ? 'textarea' : 'input', { 'aria-label': label, ...(multiline ? { rows: key === 'soul' ? '12' : '4' } : {}) });
    const counter = el('span', { class: 'meta agent-profile-counter' });
    const conflict = el('div', { class: 'agent-profile-conflict', hidden: true });
    const useServer = el('button', { class: 'btn quiet', type: 'button', text: 'Use server version' });
    const serverText = el('pre', { class: 'agent-profile-file-text' });
    conflict.append(el('span', { text: 'Changed on the server while you were editing. Your draft is kept; choose which version to use.' }), serverText, useServer);
    const wrap = row({ title: label, description: ({ name: 'Shown in the roster and conversations.', role: 'The job people see at a glance.',
      blurb: 'A short introduction.', soul: 'The bot’s persistent character and boundaries.',
      instructions: 'How this bot approaches its work.' })[key],
      control: input, below: [counter, conflict], stack: multiline, cls: 'agent-profile-field' });
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
  const identity = el('div', { class: 'set-group agent-profile-identity' }, [field('name', 'Name', 100), field('role', 'Job', 200)]);
  const picker = avatarPicker(avatarSpec(detail.agent));
  const instruction = field('instructions', 'Standing instructions', 24000, true);
  const blurb = field('blurb', 'Blurb', 4000, true, 3000);
  const soul = field('soul', 'Soul', 24000, true);
  const model = agentModelPicker(models, detail.agent, () => { modelConflict.hidden = !model.serverChanged() || !model.isDirty(); });
  const modelConflict = el('div', { class: 'agent-profile-conflict', hidden: true,
    text: 'Model changed on the server. Your selection is kept; saving will use it. ' });
  modelConflict.append(el('button', { class: 'btn quiet', type: 'button', text: 'Use server version', onclick: () => {
    model.markSaved(detail.agent); modelConflict.hidden = true;
  } }));
  const modelField = el('div', {}, [model.root, modelConflict]);
  const extraFields = new Map();
  const extra = (key, label, input) => {
    const notice = el('div', { class: 'agent-profile-conflict', hidden: true,
      text: 'Changed on the server. Your draft is kept; saving will use your value. ' });
    const boolean = input.type === 'checkbox' || input.getAttribute('role') === 'switch';
    const wrap = row({ title: label, description: ({ enabled: 'Allow this bot to run.', daily_run_cap: 'Maximum runs each day.', keep_signed_in: 'Keep browser sessions between runs.',
      memory_upkeep: 'Let the bot maintain its memory.', deliver_to_channel: 'Where updates should arrive.' })[key],
      control: input, below: notice, cls: 'agent-profile-field' });
    const value = () => boolean ? input.checked : input.value;
    const assign = (next) => { if (boolean) input.checked = !!next; else input.value = next ?? ''; };
    const state = { key, input, notice, boolean, baseline: undefined, server: undefined, value, sync(next) {
      next = boolean ? !!next : String(next ?? '');
      this.server = next;
      if (value() === next) this.baseline = next;
      if (this.baseline === undefined || (value() === this.baseline && document.activeElement !== input)) {
        assign(next); this.baseline = value();
      }
      notice.hidden = value() === this.baseline || this.server === this.baseline;
    } };
    input.addEventListener('input', () => { notice.hidden = value() === state.baseline || state.server === state.baseline; });
    input.addEventListener('change', () => { notice.hidden = value() === state.baseline || state.server === state.baseline; });
    if (boolean) input.addEventListener('click', () => { notice.hidden = value() === state.baseline || state.server === state.baseline; });
    notice.append(el('button', { class: 'btn quiet', type: 'button', text: 'Use server version', onclick: (event) => {
      event.preventDefault(); assign(state.server); state.baseline = state.server; notice.hidden = true;
    } }));
    extraFields.set(key, state); return wrap;
  };
  const enabled = extra('enabled', 'On', toggle({ label: 'Bot on' }));
  const cap = extra('daily_run_cap', 'Runs per day', el('input', { type: 'number', min: '1', max: '200' }));
  const keep = extra('keep_signed_in', 'Keep browser sign in', toggle({ label: 'Keep browser sign in' }));
  const upkeep = extra('memory_upkeep', 'Memory upkeep', toggle({ label: 'Memory upkeep' }));
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
  const peersField = el('fieldset', { class: 'agent-profile-peers' });
  const peersChoices = el('div', { class: 'agent-profile-peer-choices' });
  peersField.append(el('legend', { text: 'Peers' }),
    el('p', { class: 'meta', text: 'This bot may assign work only to selected bots.' }), peersChoices);
  let peersBaseline = '[]', peersServer = '[]', peersDraft = null;
  const peerIds = () => [...peersChoices.querySelectorAll('input:checked')].map(input => input.value).sort();
  const loadPeers = async () => {
    const bots = await api('/api/agents');
    peersChoices.replaceChildren(...bots.filter(bot => bot.id !== detail.agent.id).map(bot => {
      const input = el('input', { type: 'checkbox', value: bot.id, 'aria-label': `Peer ${bot.name}` });
      input.checked = (peersDraft || JSON.parse(peersBaseline)).includes(bot.id);
      input.addEventListener('change', () => { peersDraft = peerIds(); });
      return el('label', { class: 'agent-profile-peer' }, [input, el('span', { text: bot.name })]);
    }));
  };
  const history = el('div', { class: 'agent-profile-history' });
  // The real routines, shared with the bot page (2026-10-14). Redrawn only
  // when they change, and never under someone editing or adding one.
  const routines = el('div', { class: 'agent-profile-routines' });
  let routinesKey = null;
  const drawRoutines = goals => {
    const key = JSON.stringify((goals || []).map(g => [g.id, g.name, g.prompt, g.enabled, g.schedule_kind, g.run_time, g.interval_seconds, g.report_when]));
    if (key === routinesKey) return;
    if (routines.contains(document.activeElement) || routines.querySelector('details[open], .routine-editor:not([hidden])')) return;
    routinesKey = key;
    routines.replaceChildren(routinesPanel(detail.agent.id, goals || [], () => onSaved?.(), detail.agent));
  };
  drawRoutines(detail.goals);
  const usage = el('p', { class: 'meta' });
  const forget = el('button', { class: 'btn quiet', type: 'button', text: 'Forget browser logins', onclick: async () => {
    try { await api(`/api/agents/${detail.agent.id}/forget-logins`, { method: 'POST' }); toast('Logins forgotten', 'success'); }
    catch (error) { toast(error.message, 'error'); }
  } });
  const remove = el('button', { class: 'btn danger', type: 'button', text: 'Delete bot', onclick: async () => {
    if (!await confirmDialog({ title: `Delete ${detail.agent.name}?`, message: 'Its memory, routines, unfinished work and inbox go. Its chats move to Chats; finished results and run history stay.', confirmLabel: 'Delete agent' })) return;
    try { await api(`/api/agents/${detail.agent.id}`, { method: 'DELETE' }); close();
      document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'agents' } })); }
    catch (error) { toast(error.message, 'error'); }
  } });
  // A field has one DOM node. Switching modes moves it, preserving its value.
  // Separate save buttons avoid moving the same button between sections.
  const sectionSave = () => el('button', { class: 'btn primary', type: 'button', text: 'Save profile', onclick: () => save.click() });
  const characterGroup = group({ title: 'Character', description: 'Give this bot a face of its own.' }, [picker.root]);
  const identityGroup = group({ title: 'Identity', description: 'How this bot introduces itself and works.' }, [identity, instruction]);
  const modelGroup = group({ title: 'Model', description: 'Connection, version and effort.' }, [modelField]);
  details.append(pageHeader('Details', 'The essentials for this bot.'), characterGroup, identityGroup, modelGroup, save);
  sections.get('Overview').content.append(blurb, enabled, sectionSave());
  sections.get('Soul').content.append(soulDrift, soul, sectionSave());
  sections.get('Memory').content.append(memory, upkeep, sectionSave());
  sections.get('Routines').content.replaceChildren(routines, cap, sectionSave());
  sections.get('Access').content.append(access, peersField, keep, sectionSave(), forget, remove);
  sections.get('Voice & alerts').content.replaceChildren(channel, sectionSave());
  sections.get('Usage').content.replaceChildren(row({ title: 'Daily runs', description: 'Used today against this bot’s cap.', control: usage }));
  // Changes the bot made to itself through /setup, each with its Undo
  // (Agents 2.0, 2026-10-14). The server refuses a stale undo with a reason.
  const setupChanges = el('div', { class: 'agent-profile-setup-changes' });
  let setupKey = null;
  const FIELD_NAMES = { role: 'job', blurb: 'blurb', soul: 'standing instructions', deliver_to_channel: 'delivery channel' };
  const drawSetup = receipts => {
    const key = JSON.stringify((receipts || []).map(r => [r.id, r.undone]));
    if (key === setupKey) return;
    setupKey = key;
    const live = (receipts || []).slice().reverse();
    setupChanges.replaceChildren(...(live.length ? [el('h4', { class: 'agent-profile-subhead', text: 'Setup changes' })] : []),
      ...live.map(receipt => {
        const what = [...Object.keys(receipt.after || {}).map(k => FIELD_NAMES[k] || k), ...(receipt.routine_id ? ['a routine'] : [])].join(', ');
        const when = new Date(receipt.ts * 1000).toLocaleString();
        const undo = el('button', { type: 'button', class: 'btn quiet', text: receipt.undone ? 'Undone' : 'Undo', disabled: receipt.undone,
          onclick: async () => {
            undo.disabled = true;
            try { await api(`/api/agents/${detail.agent.id}/setup/${receipt.id}/undo`, { method: 'POST' }); toast('Setup change undone', 'success'); onSaved?.(); }
            catch (error) { toast(error.message.replace(/^\d+: /, ''), 'error'); undo.disabled = false; }
          } });
        return el('div', { class: 'agent-profile-setup-change' }, [el('div', {}, [el('div', { text: `Set ${what || 'nothing'}` }), el('div', { class: 'meta', text: when })]), undo]);
      }));
  };
  drawSetup(detail.setup_receipts);
  sections.get('History').content.append(history, setupChanges);
  const identitySlot = sections.get('Identity').content;
  const modelSlot = sections.get('Model').content;
  identitySlot.append(sectionSave());
  modelSlot.append(sectionSave());
  const setMode = (next) => {
    mode = next;
    if (mode === 'all') { identitySlot.prepend(picker.root, identity, instruction); modelSlot.prepend(modelField); }
    else { characterGroup.body.append(picker.root); identityGroup.body.append(identity, instruction); modelGroup.body.append(modelField); }
    simpleTabs.hidden = mode !== 'simple'; details.hidden = mode !== 'simple' || tab !== 'details';
    library.hidden = mode !== 'simple' || tab !== 'library'; all.hidden = mode !== 'all';
    simpleButton.hidden = mode !== 'all'; allButton.hidden = mode !== 'simple';
  };
  const setTab = (next) => { tab = next; detailsButton.classList.toggle('active', tab === 'details');
    libraryButton.classList.toggle('active', tab === 'library'); simpleTabs.dataset.active = tab;
    detailsButton.setAttribute('aria-selected', String(tab === 'details'));
    libraryButton.setAttribute('aria-selected', String(tab === 'library'));
    detailsButton.tabIndex = tab === 'details' ? 0 : -1; libraryButton.tabIndex = tab === 'library' ? 0 : -1;
    setMode(mode); if (next === 'library') loadLibrary(); };
  const update = (next) => {
    detail = next;
    heading.textContent = next.agent.name;
    if (photo.dataset.avatarSpec !== JSON.stringify(avatarSpec(next.agent))) {
      const replacement = agentAvatar(next.agent); photo.replaceWith(replacement); photo = replacement;
    }
    picker.setSpec(avatarSpec(next.agent));
    for (const [key, state] of fields) state.sync(key === 'soul' ? next.soul_file?.soul : next.agent[key]);
    for (const [key, state] of extraFields) state.sync(next.agent[key]);
    model.sync(next.agent);
    modelConflict.hidden = !model.serverChanged() || !model.isDirty();
    const sf = next.soul_file || { soul: next.agent.soul, file_text: next.agent.soul, in_sync: true, revision: next.agent.revision };
    soulDrift.hidden = sf.in_sync;
    fileText.textContent = sf.file_text === null ? '(file is missing)' : sf.file_text;
    memory.textContent = next.memory ? `${next.memory.slice(0, 700)}${next.memory.length > 700 ? '…' : ''}` : 'No memory yet.';
    access.textContent = next.agent.keep_signed_in ? 'Browser sign in is kept between runs.' : 'Browser sign in is cleared between runs.';
    peersServer = JSON.stringify([...(next.agent.peers || [])].sort());
    if (peersDraft === null || JSON.stringify(peersDraft) === peersBaseline) {
      peersBaseline = peersServer;
      peersDraft = null;
      for (const input of peersChoices.querySelectorAll('input')) input.checked = JSON.parse(peersBaseline).includes(input.value);
    }
    history.textContent = `${(next.runs || []).length} recent runs.`;
    drawSetup(next.setup_receipts);
    drawRoutines(next.goals);
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
    if (model.isDirty()) Object.assign(changes, model.get());
    if (peersDraft !== null && JSON.stringify(peersDraft) !== peersBaseline) changes.peers = peersDraft;
    if (picker.isDirty()) {
      const spec = picker.getSpec(), saved = avatarSpec(detail.agent);
      if (Object.keys(spec).some(key => spec[key] !== saved[key])) changes.avatar = spec;
    }
    if (!Object.keys(changes).length) return;
    // 2026-10-13: read once before writing so a change between polls is
    // shown before the person's first Save. A second Save chooses the draft.
    let fresh;
    try { fresh = await api(`/api/agents/${detail.agent.id}`); }
    catch (error) { toast(error.message, 'error'); return; }
    const unseen = [...fields.values()].some(state => changes[state.key] !== undefined
      && (state.key === 'soul' ? fresh.soul_file?.soul : fresh.agent[state.key]) !== state.baseline && state.conflict.hidden)
      || [...extraFields.values()].some(state => changes[state.key] !== undefined
        && (state.boolean ? !!fresh.agent[state.key] : String(fresh.agent[state.key] ?? '')) !== state.baseline && state.notice.hidden)
      || (changes.endpoint_id !== undefined && JSON.stringify(model.baseline()) !== JSON.stringify({
        endpoint_id: fresh.agent.endpoint_id || null, model_override: fresh.agent.model_override ?? null,
        model_effort: fresh.agent.model_effort ?? null }) && modelConflict.hidden);
    if (changes.peers !== undefined && JSON.stringify([...(fresh.agent.peers || [])].sort()) !== peersBaseline) {
      peersBaseline = JSON.stringify([...(fresh.agent.peers || [])].sort());
      update(fresh); toast('Peers changed on the server. Review your selection, then save again.', 'info'); return;
    }
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
      // 2026-10-14: a version or effort edit can save without changing the
      // connection; advance its baseline so the next poll cannot flag it.
      if (['endpoint_id', 'model_override', 'model_effort'].some(key => key in changes)) model.markSaved(agent);
      if (changes.peers !== undefined) { peersBaseline = JSON.stringify(changes.peers); peersDraft = null; }
      if (changes.avatar !== undefined) picker.markSaved();
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
  let closeTimer = null;
  const close = () => { if (!open) return; open = false;
    sheet.classList.add('is-closing'); backdrop.classList.add('is-closing');
    const finish = () => { sheet.hidden = backdrop.hidden = true; sheet.classList.remove('is-closing'); backdrop.classList.remove('is-closing'); closeTimer = null; };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish(); else closeTimer = setTimeout(finish, 220);
    opener?.focus(); };
  let opener = null;
  const openSheet = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    opener = document.activeElement; open = true; sheet.hidden = backdrop.hidden = false;
    sheet.classList.remove('is-closing'); backdrop.classList.remove('is-closing');
    setTab('details'); setMode('simple'); closeButton.focus(); loadPeers().catch(error => { peersChoices.textContent = `Peers could not be loaded: ${error.message}`; }); };
  closeButton.onclick = close; backdrop.onclick = close; allButton.onclick = () => setMode('all'); simpleButton.onclick = () => setMode('simple');
  detailsButton.onclick = () => setTab('details'); libraryButton.onclick = () => setTab('library');
  simpleTabs.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' || event.key === 'ArrowLeft' ? 'details' : 'library';
    setTab(next); (next === 'details' ? detailsButton : libraryButton).focus(); });
  const keydown = (event) => { if (open && event.key === 'Escape') { event.preventDefault(); close(); } };
  document.addEventListener('keydown', keydown);
  sheet.append(el('div', { class: 'agent-profile-top' }, [titlebar, allButton, simpleButton]), simpleTabs, body);
  body.append(details, library, all); root.append(backdrop, sheet);
  update(detail); setTab('details');
  return { open: openSheet, update, close, dispose: () => { if (closeTimer) clearTimeout(closeTimer);
    document.removeEventListener('keydown', keydown); sheet.remove(); backdrop.remove(); } };
}
