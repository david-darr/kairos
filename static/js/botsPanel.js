// A bot's panel (Agents 3.0 Phase 0 unit U4, completed in Phase 1 unit U2; OMB features F5 to F9 and F13,
// section 3.4 of the report, re-written for Kairos). One component, two shapes:
//
//   Simple   a 320 px panel: a hero (the bot's face, name, job) with three pages (Details, Library,
//            Computer) and a Settings page whose rows open the other sections, each with a Back link.
//   Advanced a searchable accordion of all fourteen sections, one open at a time.
//
//   mountBotPanel(host, {agentId, section, mode, onClose}) -> {destroy, openSection, flush, refresh}
//   registerBotSection({id, label, iconName, keywords, order, render(ctx), keepMounted})
//       the sections themselves live in botsPanelSections.js; later phases add more through this.
//   flushBotEdits(id) -> Promise<{ok, agent, error?}>  sends the pending settings and says whether they saved
//   openBotMenu(anchor, agent, {onChanged}) the bot's menu (Duplicate, Save as preset, Archive ...)
//
// Every edit goes through botsPatchQueue.js: a PATCH 400 ms after the last change, merged, with an overlay
// so a poll cannot undo what was just typed; model changes are sent at once; a failed send rolls the screen
// back to what is stored and says why. Edits are flushed when the panel closes or the app navigates away.
// A section kept mounted (Memory) is built once and only hidden, so its draft survives polls and tabs.
import { api, el, toast, confirmDialog, customSelect, openPanelDialog } from './api.js';
import { agentAvatar } from './agentAvatar.js';
import { agentModelPicker } from './agentModelPicker.js';
import { creativeSelectionButton } from './creativeConnections.js';
import { botStatusLine } from './botStatus.js';
import { botKip, stateForBot } from './botsKip.js';
import { Card, NavRow, TextRow, Segmented, Button, IconButton, PageHeader, openMenu, withBotColor, isAdvanced, setAdvanced, onBotsInterface, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { createPatchQueue, setSharedQueue, flushBotEdits as flushShared } from './botsPatchQueue.js';
import { archiveBotWithNotice, deleteBotWithConfirm, duplicateBot } from './botsArchived.js';
import { SIMPLE_HOME, sections, setupCard, fact, note, caps, ago, messageOf, loading, mountModule } from './botsPanelSections.js';
import { loadBotsModule } from './botsPanelHost.js';

const CSS = '/static/css/bots-panel.css';
const AVATAR_CSS = '/static/css/bots-avatar.css';
const LAST_KEY = 'kairos:bots-last-section';
const POLL_MS = 20000;
const TABS = [['details', 'Details'], ['library', 'Library'], ['computer', 'Computer']];
const announce = (name, detail = {}) => document.dispatchEvent(new CustomEvent(name, { detail }));

// -- the shared settings queue -------------------------------------------------------------------
// One per page, so edits made in a panel that is then closed still go out.
const queue = createPatchQueue({
  send: (id, body) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body), toast: false }),
  reread: id => api(`/api/agents/${id}`, { toast: false }).then(r => r.agent),
  onSaved: (id, agent, body) => announce('kairos:bots-saved', { agentId: id, agent, body }),
  onRollback: (id, agent, error) => { toast(messageOf(error), 'error'); announce('kairos:bots-rolledback', { agentId: id, agent }); },
});
// Send what is pending and say whether the settings really are saved: {ok, agent, error}. It never
// rejects. A caller that is about to act on the settings (send a message) must check `ok`.
setSharedQueue(queue);
export const flushBotEdits = flushShared;

const rememberSection = id => { try { localStorage.setItem(LAST_KEY, id); } catch { /* per-device nicety only */ } };
const lastSection = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; } };

// -- the section registry ----------------------------------------------------------------------------
const registry = [];
export function registerBotSection(def) {
  if (!def?.id || typeof def.render !== 'function') throw new Error('a section needs an id and a render function');
  const at = registry.findIndex(s => s.id === def.id);
  if (at >= 0) registry[at] = def; else registry.push(def);
  registry.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
export const botSections = () => registry.map(({ id, label, iconName }) => ({ id, label, iconName }));
for (const def of sections()) registerBotSection(def);
// Where a section lives in the Simple panel: a card on Details or Settings, or a page of its own.
const homeOf = id => SIMPLE_HOME[id] || 'page';

// -- the bot's menu ----------------------------------------------------------------------------------------------
export function openBotMenu(anchor, agent, { onChanged, onClose } = {}) {
  return openMenu(anchor, [
    { heading: agent.name },
    { label: 'Duplicate', iconName: 'copy', onSelect: () => duplicateBot(agent) },
    { label: 'Save as preset', iconName: 'download', onSelect: async () => {
      try { await api('/api/agents/presets', { method: 'POST', body: JSON.stringify({ from_agent_id: agent.id }), toast: false }); toast('Saved. Find it under Starting role in a new bot.', 'success'); }
      catch (error) { toast(messageOf(error), 'error'); }
    } },
    { label: 'New-bot defaults', iconName: 'settings', onSelect: async () => { const { openBotDefaults } = await import('./botsCreate.js'); openBotDefaults(); } },
    { label: isAdvanced() ? 'Simple view' : 'Advanced view', iconName: 'sliders-horizontal', onSelect: () => setAdvanced(!isAdvanced()) },
    { separator: true },
    { label: 'Archive', iconName: 'archive', onSelect: () => archiveBotWithNotice(agent, { onDone: onChanged }) },
    { label: 'Delete', iconName: 'trash-2', danger: true, disabled: !!agent.builtin, meta: agent.builtin ? 'built in' : '', onSelect: () => deleteBotWithConfirm(agent, { onDone: () => { onChanged?.(); onClose?.(); } }) },
  ], { align: 'end' });
}

// -- the conversations card (Details) ---------------------------------------------------------------------------------
function conversationsCard(ctx) {
  const holder = el('div', { class: 'bots-card', 'data-panel-card': 'conversations' });
  let all = false, selecting = false, showArchived = false, lastPicked = null;
  const picked = new Set();
  const open = (sid) => announce('jarvis:navigate', { tab: 'botsShell', agentId: ctx.agentId, sessionId: sid });
  const rows = () => (ctx.state.threads?.threads || []).slice().sort((a, b) => (b.thread?.pinned ? 1 : 0) - (a.thread?.pinned ? 1 : 0) || b.updated_at - a.updated_at);
  async function chooseModel(thread) {
    try {
      await ctx.flush();
      const models = await ctx.ensure('models');
      const initial = { endpoint_id: thread.model_endpoint_id, model_override: thread.model_override, model_effort: thread.model_effort };
      const picker = agentModelPicker(models, initial);
      let busy = false;
      const save = async selection => {
        if (busy) return;
        const kind = id => models.find(m => m.id === id)?.kind || 'claude_cli';
        if (kind(initial.endpoint_id) !== kind(selection.endpoint_id) && !(await confirmDialog({ title: 'Switch model families?',
          message: 'This conversation will continue with a different model family using its saved transcript.', confirmLabel: 'Switch model', danger: false }))) return;
        busy = true;
        try {
          await api(`/api/sessions/${thread.id}/model`, { method: 'POST', toast: false, body: JSON.stringify({
            model_endpoint_id: selection.endpoint_id, model_override: selection.model_override, effort: selection.model_effort }) });
          dialog.close(); await ctx.refresh();
        } catch (error) { busy = false; toast(messageOf(error), 'error'); }
      };
      const dialog = openPanelDialog({ title: `Model for ${thread.title || 'this conversation'}`, className: 'bots-dialog', body: picker.root,
        footer: el('div', { class: 'bots-dialog-footer' }, [
          Button({ label: 'Follow bot model', onClick: () => save({ ...ctx.state.agent,
            endpoint_id: ctx.state.agent.endpoint_id || models.find(m => m.kind === 'claude_cli')?.id || null }) }),
          Button({ label: 'Save model', variant: 'primary', onClick: () => save(picker.get()) })]) });
    } catch (error) { toast(messageOf(error), 'error'); }
  }
  async function patchThread(sid, body) {
    try { await api(`/api/agents/${ctx.agentId}/threads/${sid}`, { method: 'PATCH', body: JSON.stringify(body), toast: false }); await ctx.refresh(); }
    catch (error) { toast(messageOf(error), 'error'); }
  }
  async function removeThreads(ids) {
    if (!ids.length) return;
    if (!(await confirmDialog({ title: `Delete ${ids.length} conversation${ids.length === 1 ? '' : 's'}?`, message: 'They are removed for good. A bot always keeps at least one.', confirmLabel: 'Delete' }))) return;
    try {
      const result = { deleted: [], busy: [], missing: [] };
      for (let at = 0; at < ids.length; at += 200) {
        const batch = await api(`/api/agents/${ctx.agentId}/threads/delete`, { method: 'POST', body: JSON.stringify({ thread_ids: ids.slice(at, at + 200) }), toast: false });
        for (const key of Object.keys(result)) result[key].push(...(batch[key] || []));
      }
      toast(`Deleted ${result.deleted.length}${result.busy.length ? `. ${result.busy.length} busy and kept` : ''}. A bot always keeps one conversation.`, 'success');
      picked.clear(); selecting = false; await ctx.refresh();
    } catch (error) { toast(messageOf(error), 'error'); }
  }
  function draw() {
    const data = ctx.state.threads;
    holder.replaceChildren(caps('Conversations'));
    if (!data) { holder.append(Card({ children: [note('Conversations could not be loaded just now.')] })); return; }
    const live = rows().filter(t => !t.thread?.archived_at), archived = rows().filter(t => t.thread?.archived_at);
    // The three most recent, plus the main conversation wherever it falls.
    const recent = all ? live : live.slice(0, 3);
    const main = live.find(t => t.id === data.main_id);
    if (main && !recent.includes(main)) recent.push(main);
    const visible = [...recent, ...(showArchived ? archived : [])];
    const head = el('div', { class: 'bots-conv-head' }, [
      Button({ label: 'New conversation', iconName: 'plus', onClick: async () => {
        try { const s = await api(`/api/agents/${ctx.agentId}/threads`, { method: 'POST', body: JSON.stringify({}), toast: false }); announce('jarvis:agents-changed', { agentId: ctx.agentId, source: 'panel' }); open(s.id); }
        catch (error) { toast(messageOf(error), 'error'); }
      } }),
      live.length + archived.length > 1 ? Button({ label: selecting ? 'Done' : 'Select', onClick: () => { selecting = !selecting; picked.clear(); draw(); } }) : null]);
    const list = el('div', { class: 'bots-card-body bots-conv-list' });
    const select = (thread, checked, range) => {
      const from = visible.findIndex(t => t.id === lastPicked), to = visible.indexOf(thread);
      const targets = range && from >= 0 ? visible.slice(Math.min(from, to), Math.max(from, to) + 1) : [thread];
      targets.forEach(t => checked ? picked.add(t.id) : picked.delete(t.id));
      lastPicked = thread.id; draw();
    };
    for (const t of visible) {
      const check = selecting ? el('input', { type: 'checkbox', 'aria-label': `Select ${t.title}`, checked: picked.has(t.id), onclick: e => select(t, e.target.checked, e.shiftKey) }) : null;
      const meta = [ago(t.updated_at), `${t.message_count} message${t.message_count === 1 ? '' : 's'}`, t.follows_bot_model === false ? 'own model' : '', t.thread?.archived_at ? 'archived' : ''].filter(Boolean).join(' · ');
      const main = el('button', { type: 'button', class: 'bots-row bots-conv-open', onclick: e => selecting ? select(t, !picked.has(t.id), e.shiftKey) : open(t.id) }, [
        el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title' }, [t.title || 'New chat', t.id === data.main_id ? el('span', { class: 'bots-tag', text: 'Main' }) : null, t.thread?.pinned ? icon('pin', { size: 12 }) : null]),
          el('span', { class: 'bots-row-hint', text: meta })]), t.status === 'working' ? el('span', { class: 'bots-dot working', title: 'Working' }) : null]);
      const more = IconButton({ iconName: 'ellipsis', label: `Options for ${t.title}`, onClick: e => openMenu(e.currentTarget, [
        { label: t.follows_bot_model ? 'Model: follows bot' : 'Model: own selection', iconName: 'sliders-horizontal', onSelect: () => chooseModel(t) },
        { label: t.thread?.pinned ? 'Unpin' : 'Pin', iconName: 'pin', onSelect: () => patchThread(t.id, { pinned: !t.thread?.pinned }) },
        { label: t.thread?.archived_at ? 'Unarchive' : 'Archive', iconName: 'archive', disabled: t.id === data.main_id, meta: t.id === data.main_id ? 'main' : '', onSelect: () => patchThread(t.id, { archived: !t.thread?.archived_at }) },
        { separator: true }, { label: 'Delete', iconName: 'trash-2', danger: true, onSelect: () => removeThreads([t.id]) }], { align: 'end' }) });
      list.append(el('div', { class: 'bots-conv-row', 'data-thread': t.id }, [check, main, selecting ? null : more]));
    }
    if (!visible.length) list.append(note('No conversations yet. Start one and it will appear here.'));
    holder.append(head, list);
    const foot = el('div', { class: 'bots-conv-foot' });
    const hiddenCount = live.length - recent.length;
    if (all || hiddenCount) foot.append(Button({ label: all ? 'Show fewer' : `Show ${hiddenCount} more`, onClick: () => { all = !all; draw(); } }));
    if (archived.length) foot.append(Button({ label: showArchived ? 'Hide archived' : `Archived (${archived.length})`, onClick: () => { showArchived = !showArchived; draw(); } }));
    if (foot.children.length) holder.append(foot);
    if (selecting) holder.append(el('div', { class: 'bots-conv-bulk' }, [
      Button({ label: 'Select all', onClick: () => { rows().forEach(t => picked.add(t.id)); draw(); } }),
      Button({ label: 'Older than 30 days', onClick: () => { rows().filter(t => t.updated_at < Date.now() / 1000 - 30 * 86400).forEach(t => picked.add(t.id)); draw(); } }),
      Button({ label: 'Archived', onClick: () => { archived.forEach(t => picked.add(t.id)); draw(); } }),
      Button({ label: `Delete (${picked.size})`, variant: 'danger', iconName: 'trash-2', disabled: !picked.size, onClick: () => removeThreads([...picked]) })]));
  }
  draw();
  return holder;
}

// -- the Simple Library and Computer pages ----------------------------------------------------------------------
function libraryPage(ctx) {
  const { agent, detail, threads } = ctx.state;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const folders = agent.folders || [];
  const live = (threads?.threads || []).filter(t => !t.thread?.archived_at);
  const skills = el('span', { class: 'bots-row-value', text: '' });
  const skillRow = NavRow({ title: 'Skills', hint: 'What it can use', iconName: 'sparkles', onClick: () => ctx.go('skills') });
  ctx.ensure('skills').then(list => {
    const total = Array.isArray(list) ? list.length : 0, off = (agent.skill_selection?.disabled || []).length;
    skillRow.querySelector('.bots-row-hint').textContent = total ? `${count(total - off, 'skill', 'skills')} on of ${total}` : 'No skills yet';
  });
  const topics = el('span', { class: 'bots-row-hint', text: '' });
  const memoryChars = (detail?.memory || '').length;
  const memoryRow = NavRow({ title: 'Memory', hint: memoryChars ? `${memoryChars.toLocaleString('en-US')} characters of notes` : 'No notes yet', iconName: 'book-open', onClick: () => ctx.go('memory') });
  return el('div', { class: 'bots-page-section', 'data-panel-card': 'library' }, [
    Card({ label: 'Its library', children: [memoryRow, skillRow,
      NavRow({ title: 'Routines', hint: count((detail?.goals || []).length, 'routine', 'routines'), iconName: 'repeat', onClick: () => ctx.go('routines') })] }),
    Card({ label: 'Conversations', children: [fact('Open', count(live.length, 'conversation', 'conversations')), fact('Folders', folders.length ? folders.map(f => `${f.emoji ? `${f.emoji} ` : ''}${f.name}`) : 'No folders yet')] }),
    el('div', { class: 'bots-skill-library', 'data-panel-card': 'skill-library' }, [mountModule(ctx, 'SkillLibrary')]),
    Card({ label: 'Saved files', children: [note('Files it saves are kept with the conversation that made them. A shared place for them comes with a later update.')] }),
    skills, topics,
  ].filter(Boolean));
}

function computerPage(ctx) {
  const wrap = el('div', { class: 'bots-page-section', 'data-panel-card': 'computer' });
  wrap.append(loading(async () => {
    // Viewing only reads status. Nothing here starts a computer.
    const status = await ctx.ensure('computer', { fresh: true });
    const mine = (status.profiles || []).find(p => p.id === ctx.agentId);
    const place = Segmented({ label: 'Where it works', value: ctx.state.agent.place || 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: 'computer', label: 'Computer' }, { value: 'browser', label: 'Browser' }, { value: 'off', label: 'Off' }],
      onChange: v => ctx.update({ place: v }) });
    const parts = [Card({ label: 'Contained computer', children: [
      fact('Runtime', status.docker_available ? 'Available on this device' : `Not available. ${status.docker_reason || ''}`.trim()),
      fact('Image', status.image_ready ? 'Ready' : 'Not downloaded yet'),
      fact('This bot', mine ? (mine.running ? 'Its computer is running' : 'It has saved logins. Its computer is closed.') : 'Nothing saved and nothing running')] }),
    Card({ label: 'Where it works', children: [el('div', { class: 'bots-row bots-stack-row' }, [place, el('span', { class: 'bots-row-hint', text: 'Saved. It decides for itself on Auto.' })])] })];
    if (mine?.running) parts.push(el('div', { class: 'bots-actions' }, [Button({ label: 'Stop its computer', iconName: 'square', onClick: async () => {
      try { await api(`/api/computer/${encodeURIComponent(`agent:${ctx.agentId}`)}/stop`, { method: 'POST', toast: false }); toast('Computer stopped', 'success'); await ctx.refresh(); }
      catch (error) { toast(messageOf(error), 'error'); }
    } })]));
    parts.push(Card({ children: [NavRow({ title: 'Signed-in sites', hint: 'See and forget its saved logins', iconName: 'lock', onClick: () => ctx.go('access') })] }));
    return el('div', {}, parts);
  }, 'The computer status'));
  return wrap;
}

// -- the panel ------------------------------------------------------------------------------------------------------------
export function mountBotPanel(host, { agentId, section = null, mode = null, onClose } = {}) {
  loadBotsCss(CSS); loadBotsCss(AVATAR_CSS);
  let advanced = mode ? mode === 'advanced' : isAdvanced();
  const state = { agent: null, detail: null, overview: null, threads: null, open: null, stack: [], tab: 'details', search: '', cache: {}, signature: '', stale: false, gone: false, popover: false, kept: new Map() };
  let destroyed = false, kip = null, pollTimer = 0, pendingFocus = null, initialSection = section, modules = null;
  const tracked = new Set(), keptHandles = new Set();
  let bucket = tracked;
  const root = el('div', { class: 'bots-panel', role: 'region', 'aria-label': 'Bot settings' });
  host.replaceChildren(root);

  const sig = () => JSON.stringify([state.agent, state.overview?.setup, state.threads?.threads?.map(t => [t.id, t.title, t.updated_at, t.message_count, t.follows_bot_model, t.thread, t.status]),
    state.detail?.runs?.length, state.detail?.setup_receipts?.length, state.detail?.soul_file, state.detail?.goals?.map(g => [g.id, g.enabled, g.name, g.run_time]), state.detail?.memory_upkeep_journal?.length]);
  const PATHS = { models: '/api/models', integrations: '/api/integrations', channels: '/api/channels', bots: '/api/agents', skills: '/api/skills', computer: '/api/computer/status' };
  const ensure = async (name, { fresh = false } = {}) => {
    if (!fresh && state.cache[name]) return state.cache[name];
    const value = await api(PATHS[name], { toast: false }).catch(error => { if (name === 'computer') throw error; return []; });
    return (state.cache[name] = value);
  };
  const destroyTracked = () => { for (const handle of tracked) { try { handle.destroy?.(); } catch { /* a section's cleanup never blocks the panel */ } } tracked.clear(); };
  const ctx = {
    get agentId() { return agentId; }, state, get advanced() { return advanced; }, ensure,
    ui: { api, el, toast, confirmDialog, customSelect, openPanelDialog, agentModelPicker, creativeSelectionButton },
    update(patch, options) {
      state.agent = { ...state.agent, ...patch };
      if ('avatar' in patch || 'color' in patch || 'avatar_image' in patch) kip = null;
      if ('name' in patch) root.querySelectorAll('[data-live-name]').forEach(n => { if (n.tagName !== 'INPUT') n.textContent = patch.name; });
      return queue.update(agentId, patch, options);
    },
    // A change the server already accepted (a saved picture): take it without sending it again.
    adopt(saved) { state.agent = { ...state.agent, ...saved }; kip = null; announce('jarvis:agents-changed', { agentId, source: 'panel' }); },
    refresh: () => load(),
    flush: () => queue.flush(agentId),
    flushResult: () => queue.flushResult(agentId),
    rerender: () => render(),
    resetKept: id => { state.kept.delete(id); },
    go: id => openSection(id),
    track: handle => { if (handle) bucket.add(handle); return handle; },
    bindTrack: () => { const into = bucket; return handle => { if (handle) into.add(handle); return handle; }; },
    // The later-phase section modules that exist (listed by the server, so none is requested blind).
    sectionModules() {
      if (!modules) modules = api('/api/agents/section-modules', { toast: false }).then(r => new Set(r.modules || [])).catch(() => new Set());
      return modules;
    },
    loadModule: name => loadBotsModule(`section:${name}`),
    conversationsCard: () => conversationsCard(ctx),
    async mountAvatar(holder, { draft = false } = {}) {
      const { mountAvatarEditor } = await import('./botsAvatarEditor.js');
      if (destroyed) return null;
      const editor = mountAvatarEditor(holder, { agent: { ...state.agent, avatar_snapshot: state.detail?.avatar_snapshot }, draft, ctx: { update: ctx.update, flush: ctx.flush, adopt: ctx.adopt, api, toast } });
      return ctx.track(editor);
    },
    async setupWithBot() {
      try {
        const saved = await queue.flushResult(agentId);
        if (!saved.ok) throw saved.error;
        const thread = await api(`/api/agents/${agentId}/threads`, { method: 'POST', body: JSON.stringify({}), toast: false });
        announce('jarvis:agents-changed', { agentId, source: 'panel' });
        announce('jarvis:navigate', { tab: 'botsShell', agentId, sessionId: thread.id, initialMessage: '/setup' });
      } catch (error) { toast(messageOf(error), 'error'); }
    },
  };

  async function load({ quiet = false } = {}) {
    try {
      const [detail, overview, threads] = await Promise.all([
        api(`/api/agents/${agentId}`, { toast: false }),
        api(`/api/agents/${agentId}/overview`, { toast: false }).catch(() => null),
        api(`/api/agents/${agentId}/threads?include_archived=1`, { toast: false }).catch(() => null)]);
      if (destroyed) return;
      state.detail = detail; state.overview = overview; state.threads = threads;
      state.agent = queue.apply(detail.agent);
    } catch (error) {
      if (destroyed) return;
      if (/^404/.test(String(error.message))) { state.gone = true; state.agent = state.agent || null; render(); return; }
      if (!state.agent) { root.replaceChildren(el('div', { class: 'bots-panel-body' }, [note(messageOf(error)), Button({ label: 'Try again', iconName: 'refresh-cw', onClick: () => load() })])); return; }
      return;
    }
    if (initialSection) { place(initialSection, { focus: false }); initialSection = null; }
    const next = sig();
    if (!quiet || next !== state.signature) {
      if (quiet && editing()) { state.stale = true; return; }
      render();
    }
  }
  // Something the person is using right now: a focused control, or a change not yet sent.
  const editing = () => (root.contains(document.activeElement) && document.activeElement !== root && document.activeElement.matches('input, textarea, select, button, summary, [tabindex]')) || queue.isPending(agentId);

  // -- drawing --------------------------------------------------------------------------------------
  function render() {
    if (destroyed) return;
    const prevScroll = root.querySelector('.bots-panel-scroll')?.scrollTop || 0;
    root.dataset.mode = advanced ? 'advanced' : 'simple';
    destroyTracked();
    root.replaceChildren();
    if (state.gone || !state.agent) { root.append(el('div', { class: 'bots-panel-body' }, [note('This bot no longer exists.'), Button({ label: 'Close', onClick: () => onClose?.() })])); return; }
    withBotColor(root, state.agent.color);
    state.signature = sig(); state.stale = false;
    root.append(advanced ? advancedChrome() : simpleChrome());
    const scroll = el('div', { class: 'bots-panel-scroll' }, [advanced ? accordion() : simplePage()]);
    root.append(scroll);
    scroll.scrollTop = prevScroll;
    if (pendingFocus) { const job = pendingFocus; pendingFocus = null; queueMicrotask(job); }
  }

  // A section's node. Kept sections are built once and re-used, so their drafts are never rebuilt.
  function bodyOf(def) {
    if (!def.keepMounted) return def.render(ctx);
    if (!state.kept.has(def.id)) { bucket = keptHandles; try { state.kept.set(def.id, def.render(ctx)); } finally { bucket = tracked; } }
    return state.kept.get(def.id);
  }

  const status = () => botStatusLine(state.agent);
  function bar(lead, extra = []) {
    const menu = IconButton({ iconName: 'ellipsis', label: 'Bot menu', onClick: e => openBotMenu(e.currentTarget, state.agent, { onChanged: () => announce('jarvis:agents-changed', { source: 'panel' }), onClose: () => onClose?.() }) });
    const close = IconButton({ iconName: 'x', label: 'Close panel', onClick: () => onClose?.() });
    return el('div', { class: 'bots-panel-bar' }, [lead, el('span', { class: 'bots-spacer' }), ...extra, menu, onClose ? close : null]);
  }

  function simpleChrome() {
    const gear = IconButton({ iconName: 'settings', label: 'Settings', onClick: () => { state.stack = state.stack[0] === 'settings' ? [] : ['settings']; render(); } });
    const head = bar(null, [gear]);
    const a = state.agent, live = status();
    let face;
    if (a.avatar_image) face = agentAvatar(a, 80);
    else {
      if (!kip) kip = botKip(a, { size: 80, state: stateForBot(a, { status: live.state }) });
      else kip.setState(stateForBot(a, { status: live.state }));
      face = kip;
    }
    const edit = el('button', { type: 'button', class: 'bots-hero-edit', 'aria-label': 'Edit look', title: 'Edit look', 'aria-expanded': String(state.popover), onclick: () => togglePopover() }, [icon('pencil', { size: 14 })]);
    const faceBox = el('div', { class: 'bots-hero-face' }, [face, edit]);
    const name = el('input', { class: 'bots-hero-name', value: a.name, 'aria-label': 'Name', maxlength: '100', 'data-live-name': '' });
    const job = el('input', { class: 'bots-hero-job', value: a.role || '', 'aria-label': 'Job', placeholder: 'What is this bot for?', maxlength: '200' });
    name.value = a.name; job.value = a.role || '';
    const bind = (input, key, required) => {
      let committed = input.value;
      const commit = () => { const v = input.value.trim(); if (v === committed) return; if (!v && required) { toast('A bot needs a name.', 'error'); input.value = committed; return; } committed = v; ctx.update({ [key]: v }); };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } else if (e.key === 'Escape') { e.stopPropagation(); input.value = committed; input.blur(); } });
    };
    bind(name, 'name', true); bind(job, 'role', false);
    const line = el('div', { class: 'bots-hero-status' }, [el('span', { class: `bots-dot ${live.state}` }), el('span', { text: live.text })]);
    const hero = el('div', { class: 'bots-hero' }, [faceBox, name, job, line]);
    if (state.popover) hero.append(lookPopover());
    return el('div', { class: 'bots-panel-top' }, [head, hero, state.stack.length ? null : tabBar()]);
  }
  function tabBar() {
    const buttons = TABS.map(([id, label]) => el('button', { type: 'button', role: 'tab', id: `bots-tab-${id}`, class: 'bots-tab', 'data-tab': id,
      'aria-selected': String(state.tab === id), 'aria-controls': 'bots-tab-body', tabindex: state.tab === id ? '0' : '-1', text: label,
      onclick: () => { state.tab = id; render(); pendingFocus = () => root.querySelector(`#bots-tab-${id}`)?.focus(); queueMicrotask(() => root.querySelector(`#bots-tab-${id}`)?.focus()); } }));
    const bar = el('div', { class: 'bots-tabs', role: 'tablist', 'aria-label': 'Bot pages' }, buttons);
    bar.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const at = TABS.findIndex(([id]) => id === state.tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (at + step + TABS.length) % TABS.length;
      state.tab = TABS[next][0]; render(); queueMicrotask(() => root.querySelector(`#bots-tab-${state.tab}`)?.focus());
    });
    return bar;
  }
  function lookPopover() {
    const holder = el('div', { class: 'bots-look-editor' });
    const box = el('div', { class: 'bots-popover', role: 'dialog', 'aria-label': 'Edit look' }, [holder, Button({ label: 'Done', onClick: () => togglePopover(false) })]);
    ctx.mountAvatar(holder);
    return box;
  }
  function togglePopover(force) {
    state.popover = typeof force === 'boolean' ? force : !state.popover; render();
    if (!state.popover) queueMicrotask(() => root.querySelector('.bots-hero-edit')?.focus());
  }

  function advancedChrome() {
    const a = state.agent;
    const search = el('input', { type: 'search', class: 'bots-search', placeholder: 'Search settings', 'aria-label': 'Search settings', value: state.search });
    search.addEventListener('input', () => { state.search = search.value; const body = root.querySelector('.bots-panel-scroll'); destroyTracked(); body.replaceChildren(accordion()); });
    const title = el('div', { class: 'bots-adv-title' }, [agentAvatar(a, 30), el('span', { class: 'bots-adv-id' }, [el('strong', { 'data-live-name': '', text: a.name }), el('span', { class: 'bots-row-hint', text: status().text })])]);
    return el('div', { class: 'bots-panel-top' }, [bar(title), el('div', { class: 'bots-search-wrap' }, [icon('search', { size: 16 }), search])]);
  }

  function accordion() {
    const q = state.search.trim().toLowerCase();
    const list = registry.filter(s => !q || `${s.label} ${s.keywords || ''}`.toLowerCase().includes(q));
    // null means "not chosen yet": the section used last, else the overview. '' is closed on purpose.
    if (state.open === null) state.open = registry.some(s => s.id === lastSection()) ? lastSection() : 'overview';
    const wrap = el('div', { class: 'bots-accordion' });
    if (!list.length) wrap.append(note(`Nothing matches "${state.search}".`));
    for (const s of list) {
      const isOpen = q ? list.length === 1 : state.open === s.id;
      const head = el('button', { type: 'button', class: 'bots-acc-head', 'aria-expanded': String(isOpen), 'data-section': s.id, onclick: () => { state.open = isOpen && !q ? '' : s.id; if (state.open) rememberSection(s.id); render(); } },
        [icon(s.iconName || 'settings', { size: 18 }), el('span', { class: 'bots-acc-label', text: s.label }), icon(isOpen ? 'chevron-down' : 'chevron-right', { size: 16 })]);
      const item = el('section', { class: 'bots-acc-item', 'data-open': String(isOpen), 'data-section': s.id }, [head]);
      if (isOpen || (s.keepMounted && state.kept.has(s.id))) {
        const body = el('div', { class: 'bots-acc-body', hidden: !isOpen }, [bodyOf(s)]);
        item.append(body);
      }
      wrap.append(item);
    }
    return wrap;
  }

  // The Simple pages: a stack, the three tabs at the bottom.
  function simplePage() {
    const top = state.stack.at(-1) || 'tabs';
    const previous = state.stack.length > 1 ? PAGE_TITLE(state.stack.at(-2)) : state.stack.length === 1 ? PAGE_TITLE(TABS.find(([id]) => id === state.tab)[0]) : '';
    const pop = () => { state.stack.pop(); render(); };
    const wrap = el('div', { class: 'bots-pages', id: 'bots-tab-body', role: state.stack.length ? undefined : 'tabpanel', 'aria-labelledby': state.stack.length ? undefined : `bots-tab-${state.tab}` });
    if (top === 'tabs') wrap.append(state.tab === 'library' ? libraryPage(ctx) : state.tab === 'computer' ? computerPage(ctx) : detailsPage());
    else {
      const def = registry.find(s => s.id === top);
      const title = top === 'settings' ? 'Settings' : def?.label || top;
      wrap.append(PageHeader({ title, backLabel: previous, onBack: pop }));
      wrap.append(top === 'settings' ? settingsPage() : def ? el('div', { class: 'bots-page-section' }, [bodyOf(def)]) : note('This page is not available.'));
    }
    return wrap;
  }
  const PAGE_TITLE = id => (id === 'settings' ? 'Settings' : id === 'details' ? 'Details' : id === 'library' ? 'Library' : id === 'computer' ? 'Computer' : registry.find(s => s.id === id)?.label || id);
  const sectionNode = id => { const def = registry.find(s => s.id === id); return def ? bodyOf(def) : note('This section is not available.'); };

  function detailsPage() {
    const parts = [];
    const left = (state.overview?.setup || []).filter(s => !s.done);
    if (left.length) parts.push(setupCard(ctx, state.overview.setup));
    parts.push(sectionNode('model'), conversationsCard(ctx));
    parts.push(el('div', { class: 'bots-actions' }, [Button({ label: `Set up with ${state.agent.name}`, iconName: 'sparkles', onClick: () => ctx.setupWithBot() })]));
    return el('div', { class: 'bots-page-section' }, parts);
  }
  function settingsPage() {
    const a = state.agent;
    const intro = TextRow({ title: 'Introduction', value: a.blurb || '', maxLength: 4000, multiline: true, onCommit: v => ctx.update({ blurb: v }) });
    const group = TextRow({ title: 'Group', hint: 'Optional. Bots in a group sit together.', value: a.section || '', maxLength: 60, onCommit: v => ctx.update({ section: v.trim() }) });
    const onPage = registry.filter(s => homeOf(s.id) === 'page');
    const extra = [];
    return el('div', { class: 'bots-page-section' }, [
      sectionNode('soul'), Card({ children: [intro, group] }), sectionNode('delivery'), sectionNode('permissions'),
      Card({ label: 'More', children: [NavRow({ title: 'Overview', iconName: 'info', onClick: () => { state.stack = ['settings', 'overview']; render(); } }),
        ...onPage.map(s => NavRow({ title: s.label, iconName: s.iconName, onClick: () => { state.stack = ['settings', s.id]; render(); } })), ...extra] })]);
  }

  // -- moving around ---------------------------------------------------------------------------------------
  // Put the panel on a section without drawing (the first load) or with a scroll and focus (a link).
  function place(id, { focus = true } = {}) {
    if (id === 'library' || id === 'computer') {
      if (advanced) return false;
      state.tab = id; state.stack = []; rememberSection(id);
      return true;
    }
    if (!registry.some(s => s.id === id)) return false;
    rememberSection(id);
    if (advanced) {
      state.open = id; state.search = '';
      if (focus) pendingFocus = () => root.querySelector(`.bots-acc-item[data-section="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    } else {
      const home = homeOf(id);
      if (home === 'details') { state.stack = []; state.tab = 'details'; }
      else state.stack = home === 'settings' ? ['settings'] : ['settings', id];
      if (focus) pendingFocus = () => {
        if (id === 'identity') root.querySelector('.bots-hero-name')?.focus();
        else root.querySelector(`[data-panel-card="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      };
    }
    return true;
  }
  function openSection(id) { if (!place(id)) return false; render(); return true; }

  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (state.popover) { event.stopPropagation(); event.preventDefault(); togglePopover(false); return; }
    if (!advanced && state.stack.length) { event.stopPropagation(); event.preventDefault(); state.stack.pop(); render(); }
  });
  root.addEventListener('focusout', () => setTimeout(() => { if (state.stale && !destroyed && !editing()) render(); }, 0));

  // -- events ------------------------------------------------------------------------------------------------
  const onSaved = e => {
    if (e.detail.agentId !== agentId || destroyed) return;
    state.agent = { ...e.detail.agent, ...queue.overlayFor(agentId) };
    state.signature = sig();
    announce('jarvis:agents-changed', { agentId, source: 'panel' });
    api(`/api/agents/${agentId}/overview`, { toast: false }).then(o => {
      if (destroyed) return;
      state.overview = o;
      if (sig() === state.signature) return;
      if (editing()) state.stale = true; else render();
    }).catch(() => {});
  };
  const onRolledBack = e => {
    if (e.detail.agentId !== agentId || destroyed) return;
    if (e.detail.agent) state.agent = e.detail.agent;
    render();
  };
  const onChanged = e => {
    if (e.detail?.deleted && e.detail.agentId === agentId) { queue.cancel(agentId); state.gone = true; render(); return; }
    if (e.detail?.source === 'panel' || destroyed) return;
    load({ quiet: true });
  };
  const onNavigate = () => { queue.flush(agentId); };
  document.addEventListener('kairos:bots-saved', onSaved);
  document.addEventListener('kairos:bots-rolledback', onRolledBack);
  document.addEventListener('jarvis:agents-changed', onChanged);
  window.addEventListener('jarvis:navigate', onNavigate, true);
  const offInterface = onBotsInterface(next => { if (mode) return; advanced = next; state.stack = []; kip = null; render(); });
  pollTimer = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, POLL_MS);

  root.append(el('div', { class: 'bots-panel-body' }, [note('Loading…')]));
  load();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true; queue.flush(agentId); clearInterval(pollTimer); offInterface();
      destroyTracked();
      for (const handle of keptHandles) { try { handle.destroy?.(); } catch { /* ignore */ } }
      document.removeEventListener('kairos:bots-saved', onSaved);
      document.removeEventListener('kairos:bots-rolledback', onRolledBack);
      document.removeEventListener('jarvis:agents-changed', onChanged);
      window.removeEventListener('jarvis:navigate', onNavigate, true);
      root.remove();
    },
    openSection, flush: () => queue.flushResult(agentId), refresh: () => load({ quiet: true }),
    get mode() { return advanced ? 'advanced' : 'simple'; },
  };
}
