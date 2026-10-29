// A bot's panel (Agents 3.0 Phase 0, unit U4; OMB features F5 to F9 and F13, section 3.4 of the
// report, re-written for Kairos). One component, two shapes:
//
//   Simple   a 320 px panel: a hero (Kip, name, job), a Details page (what is left to set up,
//            model, conversations) and a Settings page with drill-down pages (Apps and tools,
//            History, Usage), each with a Back link.
//   Advanced a searchable accordion of sections, one open at a time.
//
//   mountBotPanel(host, {agentId, section, mode, onClose})  -> {destroy, openSection, flush, refresh}
//   registerBotSection({id, label, iconName, keywords, order, render(ctx)})
//       how later phases add their sections (Skills, Memory, Routines ...); nothing is shown for a
//       section nobody has registered, so there are no placeholders.
//   openBotMenu(anchor, agent, {onChanged})   the bot's menu (Duplicate, Save as preset, Archive ...)
//
// Every edit goes through botsPatchQueue.js: a PATCH 400 ms after the last change, merged, with an
// overlay so a poll cannot undo what was just typed; model changes are sent at once; a failed send
// rolls the screen back to what is stored and says why. Edits are flushed when the panel closes
// or the app navigates away.
import { api, el, toast, confirmDialog, customSelect, openPanelDialog } from './api.js';
import { agentAvatar, avatarPicker } from './agentAvatar.js';
import { agentModelPicker } from './agentModelPicker.js';
import { creativeSelectionButton } from './creativeConnections.js';
import { botStatusLine } from './botStatus.js';
import { botKip, stateForBot } from './botsKip.js';
import { Card, NavRow, SwitchRow, TextRow, RadioGroup, Button, IconButton, PageHeader, openMenu, withBotColor, isAdvanced, setAdvanced, onBotsInterface, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { createPatchQueue } from './botsPatchQueue.js';
import { archiveBotWithNotice, deleteBotWithConfirm, duplicateBot } from './botsArchived.js';

const CSS = '/static/css/bots-panel.css';
const LAST_KEY = 'kairos:bots-last-section';
const POLL_MS = 20000;
const SOUL_BYTES = 24000;
const messageOf = error => String(error?.message || error).replace(/^\d+:\s*/, '');
const announce = (name, detail = {}) => document.dispatchEvent(new CustomEvent(name, { detail }));

// -- the shared settings queue -------------------------------------------------------------------
// One per page, so edits made in a panel that is then closed still go out.
const queue = createPatchQueue({
  send: (id, body) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body), toast: false }),
  reread: id => api(`/api/agents/${id}`, { toast: false }).then(r => r.agent),
  onSaved: (id, agent, body) => announce('kairos:bots-saved', { agentId: id, agent, body }),
  onRollback: (id, agent, error) => { toast(messageOf(error), 'error'); announce('kairos:bots-rolledback', { agentId: id, agent }); },
});
export const flushBotEdits = id => queue.flush(id);

const rememberSection = id => { try { localStorage.setItem(LAST_KEY, id); } catch { /* per-device nicety only */ } };
const lastSection = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; } };

function ago(seconds) {
  if (!seconds) return '';
  const gap = Math.max(0, Date.now() / 1000 - seconds);
  if (gap < 90) return 'just now';
  if (gap < 3600) return `${Math.round(gap / 60)} min ago`;
  if (gap < 86400) return `${Math.round(gap / 3600)} h ago`;
  return `${Math.round(gap / 86400)} d ago`;
}

// -- the section registry ----------------------------------------------------------------------------
const registry = [];
export function registerBotSection(def) {
  if (!def?.id || typeof def.render !== 'function') throw new Error('a section needs an id and a render function');
  const at = registry.findIndex(s => s.id === def.id);
  if (at >= 0) registry[at] = def; else registry.push(def);
  registry.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
export const botSections = () => registry.map(({ id, label, iconName }) => ({ id, label, iconName }));
// Where a section lives in the Simple panel: a page of its own, or a card on Details or Settings.
const SIMPLE_HOME = { overview: 'details', identity: 'details', model: 'details', soul: 'settings', permissions: 'settings' };

// -- small pieces ----------------------------------------------------------------------------------------
const fact = (title, lines) => el('div', { class: 'bots-row bots-fact' }, [el('span', { class: 'bots-row-main' }, [
  el('span', { class: 'bots-row-title', text: title }), ...[].concat(lines).filter(Boolean).map(text => el('span', { class: 'bots-row-hint', text }))])]);
const note = text => el('div', { class: 'bots-row bots-note-line' }, [icon('info', { size: 16 }), el('span', { class: 'bots-row-hint', text })]);
const lazy = build => {
  const holder = el('div', { class: 'bots-lazy' });
  Promise.resolve().then(build).then(node => holder.replaceChildren(node)).catch(error => holder.replaceChildren(note(messageOf(error))));
  return holder;
};
const caps = (text) => el('div', { class: 'bots-caps bots-card-label', text });

function longText(ctx, { value, limit, bytes = false, rows = 8, label, onChange }) {
  const area = el('textarea', { rows: String(rows), 'aria-label': label });
  const count = el('small', { class: 'bots-count' });
  const paint = () => { const used = bytes ? new TextEncoder().encode(area.value).length : area.value.length;
    count.textContent = `${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} ${bytes ? 'bytes' : 'characters'}`; count.classList.toggle('over', used > limit); };
  area.value = value || '';
  area.addEventListener('input', () => {
    if (bytes) { while (new TextEncoder().encode(area.value).length > limit) area.value = area.value.slice(0, -1); }
    else if (area.value.length > limit) area.value = area.value.slice(0, limit);
    paint(); onChange(area.value);
  });
  paint();
  return el('div', { class: 'bots-row bots-stack-row' }, [area, count]);
}

// -- the sections ------------------------------------------------------------------------------------------

function overviewSection(ctx) {
  const { agent, overview } = ctx.state;
  const body = el('div', {});
  if (overview) {
    const routines = overview.does?.routines || [];
    const on = routines.filter(r => r.enabled).length;
    const does = [routines.length ? `${routines.length} routine${routines.length === 1 ? '' : 's'}, ${on} on` : 'No routines yet',
      overview.does?.triggers?.length ? `${overview.does.triggers.length} trigger${overview.does.triggers.length === 1 ? '' : 's'}` : '',
      overview.does?.open_cards ? `${overview.does.open_cards} open task${overview.does.open_cards === 1 ? '' : 's'}` : ''].filter(Boolean);
    const integrations = overview.reaches?.integrations;
    const reaches = [integrations === 'all' ? 'Every connected tool server' : integrations?.length ? `${integrations.length} tool server${integrations.length === 1 ? '' : 's'}` : 'No tool servers',
      overview.reaches?.keep_signed_in ? 'Stays signed in to sites' : '', overview.reaches?.deliver_to_channel ? `Reports on ${overview.reaches.deliver_to_channel}` : 'Reports in the app'].filter(Boolean);
    body.append(Card({ label: 'At a glance', className: 'bots-glance', children: [
      fact('Who', [agent.role || 'No job set yet', overview.who?.section ? `Group: ${overview.who.section}` : '']),
      fact('What it does', does), fact('What it can reach', reaches),
      fact('What it will not do', overview.wont?.length ? overview.wont : 'Nothing is held back.'),
      ...(overview.recent?.length ? [fact('Recently', overview.recent.map(r => `${r.name || 'A run'}: ${r.outcome || 'ran'} ${ago(r.ran_at)}`.trim()))] : []),
    ] }));
    body.append(setupCard(ctx, overview.setup || []));
  } else body.append(Card({ children: [note('The overview could not be loaded just now.')] }));
  body.append(el('div', { class: 'bots-actions' }, [Button({ label: `Set up with ${agent.name}`, iconName: 'sparkles', onClick: () => ctx.setupWithBot() })]));
  if (ctx.advanced) body.append(conversationsCard(ctx), promptPreview(ctx));
  return body;
}

// What is left to do, each step opening the section that does it.
function setupCard(ctx, steps) {
  if (!steps.length) return el('div');
  const known = new Set(registry.map(s => s.id));
  const rows = steps.map(step => {
    const target = known.has(step.section);
    const mark = icon(step.done ? 'check' : 'circle-alert', { size: 18 });
    const main = el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title', text: step.label })]);
    const row = target
      ? el('button', { type: 'button', class: 'bots-row bots-nav-row bots-setup-step', 'data-done': String(!!step.done), onclick: () => ctx.go(step.section) }, [mark, main, el('span', { class: 'bots-chevron' }, [icon('chevron-right', { size: 16 })])])
      : el('div', { class: 'bots-row bots-setup-step', 'data-done': String(!!step.done) }, [mark, main]);
    return row;
  });
  const left = steps.filter(s => !s.done).length;
  return Card({ label: left ? `Set up (${left} to go)` : 'Set up', className: 'bots-setup', children: rows });
}

// "What the model sees": the sections Kairos adds, with their size. Same builder as a live chat.
function promptPreview(ctx) {
  const holder = el('div', { class: 'bots-prompt-body' });
  const box = el('details', { class: 'bots-prompt' }, [el('summary', {}, [icon('eye', { size: 16 }), el('span', { class: 'bots-prompt-summary', text: 'What the model sees' })]), holder]);
  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true; holder.replaceChildren(note('Reading…'));
    try {
      await ctx.flush();
      const data = await api(`/api/agents/${ctx.agentId}/system-prompt`, { toast: false });
      box.querySelector('.bots-prompt-summary').textContent = `What the model sees: ${data.total_bytes.toLocaleString('en-US')} bytes, about ${data.approx_tokens.toLocaleString('en-US')} tokens`;
      holder.replaceChildren(...data.sections.map(s => el('details', { class: 'bots-prompt-part', 'data-part': s.id }, [
        el('summary', { text: `${s.label} (${s.bytes.toLocaleString('en-US')} bytes)` }), el('pre', { text: s.text })])), el('p', { class: 'bots-hint', text: data.note }));
    } catch (error) { loaded = false; holder.replaceChildren(note(messageOf(error))); }
  });
  return box;
}

function identitySection(ctx) {
  const { agent } = ctx.state;
  const nameRow = TextRow({ title: 'Name', value: agent.name, maxLength: 100, onCommit: v => {
    const name = v.trim();
    if (!name) { toast('A bot needs a name.', 'error'); nameRow.set(ctx.state.agent.name); return; }
    ctx.update({ name });
  } });
  const jobRow = TextRow({ title: 'Job', hint: 'What is this bot for?', value: agent.role || '', maxLength: 200, onCommit: v => ctx.update({ role: v.trim() }) });
  const blurbRow = TextRow({ title: 'Introduction', value: agent.blurb || '', maxLength: 4000, multiline: true, onCommit: v => ctx.update({ blurb: v }) });
  const groupRow = TextRow({ title: 'Group', hint: 'Optional. Bots in a group sit together.', value: agent.section || '', maxLength: 60, onCommit: v => ctx.update({ section: v.trim() }) });
  const picker = avatarPicker(agent.avatar || { id: agent.id, color: agent.color }, spec => ctx.update({ avatar: spec }));
  const wrap = el('div', {}, [Card({ className: 'bots-identity', children: [nameRow, jobRow, blurbRow, groupRow] }), Card({ label: 'Look', children: [picker.root] })]);
  wrap.nameField = nameRow.field;
  return wrap;
}

function soulSection(ctx) {
  const { agent } = ctx.state;
  const row = longText(ctx, { value: agent.soul || agent.instructions || '', limit: SOUL_BYTES, bytes: true, rows: 10, label: 'Standing instructions', onChange: v => ctx.update({ soul: v }) });
  return el('div', { 'data-panel-card': 'soul' }, [Card({ label: 'Standing instructions', children: [row] }),
    el('p', { class: 'bots-hint', text: 'How this bot works, every time. It reads this at the start of each chat.' })]);
}

function modelSection(ctx) {
  return el('div', { 'data-panel-card': 'model' }, [caps('Model'), lazy(async () => {
    const models = await ctx.ensure('models');
    const picker = agentModelPicker(models, ctx.state.agent, () => ctx.update(picker.get()));
    const parts = [el('div', { class: 'bots-model' }, [picker.root])];
    const stray = (ctx.state.threads?.threads || []).filter(t => t.follows_bot_model === false && !t.thread?.archived_at);
    if (stray.length) {
      const hint = el('span', { class: 'bots-row-hint', text: `${stray.length} conversation${stray.length === 1 ? ' uses' : 's use'} a different model.` });
      const button = Button({ label: 'Switch them too', iconName: 'refresh-cw', onClick: async () => {
        button.disabled = true;
        try {
          await ctx.flush();
          const result = await api(`/api/agents/${ctx.agentId}/threads/follow-model`, { method: 'POST', body: JSON.stringify({}), toast: false });
          toast(`${result.updated.length} switched${result.busy.length ? `, ${result.busy.length} busy and left alone` : ''}`, 'success');
          await ctx.refresh();
        } catch (error) { toast(messageOf(error), 'error'); button.disabled = false; }
      } });
      parts.push(el('div', { class: 'bots-row bots-follow' }, [hint, button]));
    }
    return el('div', {}, parts);
  })]);
}

function accessSection(ctx) {
  const { agent } = ctx.state;
  const wrap = el('div', {});
  wrap.append(lazy(async () => {
    const [integrations, channels] = await Promise.all([ctx.ensure('integrations'), ctx.ensure('channels')]);
    const servers = integrations.filter(i => i.kind === 'mcp_server');
    const body = el('div', { class: 'bots-card-body' });
    const draw = () => {
      body.replaceChildren();
      const all = ctx.state.agent.integration_ids === null || ctx.state.agent.integration_ids === undefined;
      body.append(SwitchRow({ title: 'Every connected tool server', hint: servers.length ? 'Turn off to pick which ones this bot may use.' : 'None are connected yet. Add one in Settings, under Integrations.',
        checked: all, onChange: v => { ctx.update({ integration_ids: v ? null : servers.map(s => s.id) }); draw(); } }));
      if (!all) for (const s of servers) body.append(SwitchRow({ title: s.name, checked: ctx.state.agent.integration_ids.includes(s.id),
        onChange: v => { const set = new Set(ctx.state.agent.integration_ids); if (v) set.add(s.id); else set.delete(s.id); ctx.update({ integration_ids: [...set] }); } }));
    };
    draw();
    const select = customSelect({}, [el('option', { value: '', text: 'In the app only' }), ...channels.map(c => el('option', { value: c.id, text: c.label }))]);
    select.value = agent.deliver_to_channel || '';
    select.addEventListener('change', () => ctx.update({ deliver_to_channel: select.value || null }));
    return el('div', {}, [
      el('div', { class: 'bots-card' }, [caps('Tool servers'), body]),
      Card({ label: 'Habits', children: [
        SwitchRow({ title: 'Stay signed in', hint: 'Keep the sites it logs into between runs.', checked: !!agent.keep_signed_in, onChange: v => ctx.update({ keep_signed_in: v }) }),
        SwitchRow({ title: 'Keep its own notes tidy', hint: 'It reviews and cleans up what it remembers.', checked: !!agent.memory_upkeep, onChange: v => ctx.update({ memory_upkeep: v }) }),
      ] }),
      Card({ label: 'Reports', children: [el('div', { class: 'bots-row' }, [el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title', text: 'Tell me on' }),
        el('span', { class: 'bots-row-hint', text: 'Where its reports and questions reach you.' })]), select])] }),
    ]);
  }));
  wrap.append(el('div', { class: 'bots-actions' }, [creativeSelectionButton(() => ({ agentId: ctx.agentId }), wrap)]));
  return wrap;
}

function permissionsSection(ctx) {
  const { agent } = ctx.state;
  const capRow = TextRow({ title: 'Runs per day', hint: 'It stops for the day after this many (1 to 200).', value: String(agent.daily_run_cap ?? 12), onCommit: v => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 200) { toast('Runs per day is a whole number from 1 to 200.', 'error'); capRow.set(String(ctx.state.agent.daily_run_cap ?? 12)); return; }
    ctx.update({ daily_run_cap: n });
  } });
  return el('div', { 'data-panel-card': 'permissions' }, [
    caps('Before it acts'),
    RadioGroup({ label: 'Approval', value: 'full', options: [{ value: 'full', title: 'Full access', hint: 'It acts without asking. You can stop it at any time.' }], onChange: v => ctx.update({ approval_mode: v }) }),
    Card({ label: 'Limits', children: [SwitchRow({ title: 'This bot is on', hint: 'Off, it takes no new work and its routines do not run.', checked: agent.enabled !== false, onChange: v => ctx.update({ enabled: v }) }), capRow] }),
  ]);
}

const OUTCOME = { succeeded: 'Done', failed: 'Failed', lost: 'Did not finish', skipped: 'Skipped', stopped: 'Stopped' };
function historySection(ctx) {
  const { agent, detail } = ctx.state;
  const names = new Map((detail?.goals || []).map(g => [g.id, g.name]));
  const parts = [Card({ children: [fact('Version', `Settings version ${agent.revision || 0}`), fact('Created', agent.created_at ? new Date(agent.created_at * 1000).toLocaleDateString() : 'Unknown')] })];
  if (agent.instructions_legacy) parts.push(Card({ label: 'Earlier instructions', children: [note('These were replaced by the standing instructions. They are kept here and never sent to the model.'),
    el('div', { class: 'bots-row' }, [el('pre', { class: 'bots-legacy', text: agent.instructions_legacy })])] }));
  const receipts = (detail?.setup_receipts || []).slice().reverse();
  if (receipts.length) {
    const FIELDS = { role: 'job', blurb: 'introduction', soul: 'standing instructions', deliver_to_channel: 'where it reports' };
    parts.push(Card({ label: 'Setup changes', children: receipts.map(r => {
      const what = [...Object.keys(r.after || {}).map(k => FIELDS[k] || k), ...(r.routine_id ? ['a routine'] : [])].join(', ');
      const undo = Button({ label: r.undone ? 'Undone' : 'Undo', iconName: 'undo-2', disabled: !!r.undone, onClick: async () => {
        undo.disabled = true;
        try { await api(`/api/agents/${ctx.agentId}/setup/${r.id}/undo`, { method: 'POST', toast: false }); toast('Setup change undone', 'success'); await ctx.refresh(); }
        catch (error) { toast(messageOf(error), 'error'); undo.disabled = false; }
      } });
      return el('div', { class: 'bots-row' }, [el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title', text: `Set ${what || 'nothing'}` }), el('span', { class: 'bots-row-hint', text: new Date(r.ts * 1000).toLocaleString() })]), undo]);
    }) }));
  }
  const runs = (detail?.runs || []).slice(0, 15);
  parts.push(Card({ label: 'Recent runs', children: runs.length ? runs.map(r => fact(names.get(r.task_id) || 'A routine', `${OUTCOME[r.outcome] || r.outcome || 'Ran'} ${ago(r.ran_at)}${r.duration_seconds ? `, ${Math.round(r.duration_seconds)} s` : ''}`))
    : [note('No routine has run yet.')] }));
  return el('div', { 'data-panel-card': 'history' }, parts);
}

function usageSection(ctx) {
  const { agent, detail } = ctx.state;
  const cap = agent.daily_run_cap || 12, used = agent.runs_today || 0;
  const runs = detail?.runs || [];
  const tally = runs.reduce((m, r) => { m[r.outcome] = (m[r.outcome] || 0) + 1; return m; }, {});
  const timed = runs.filter(r => r.duration_seconds);
  const average = timed.length ? Math.round(timed.reduce((n, r) => n + r.duration_seconds, 0) / timed.length) : 0;
  const meter = el('div', { class: 'bots-meter', role: 'img', 'aria-label': `${used} of ${cap} daily runs used` }, [el('span', { class: 'bots-meter-fill', style: `width:${Math.min(100, Math.round((used / cap) * 100))}%` })]);
  return el('div', { 'data-panel-card': 'usage' }, [
    Card({ label: 'Today', children: [el('div', { class: 'bots-row bots-stack-row' }, [el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title', text: `${used} of ${cap} daily runs used` }),
      el('span', { class: 'bots-row-hint', text: used >= cap ? 'It is done for today.' : `${cap - used} left today.` })]), meter])] }),
    Card({ label: `Last ${runs.length} runs`, children: runs.length ? [fact('Results', Object.entries(tally).map(([k, n]) => `${OUTCOME[k] || k}: ${n}`)), ...(average ? [fact('Average length', `${average} seconds`)] : [])]
      : [note('There are no runs to count yet.')] }),
  ]);
}

registerBotSection({ id: 'overview', label: 'Overview', iconName: 'info', keywords: 'summary setup checklist prompt', order: 10, render: overviewSection });
registerBotSection({ id: 'identity', label: 'Identity', iconName: 'pencil', keywords: 'name job role look avatar kip group introduction', order: 20, render: identitySection });
registerBotSection({ id: 'soul', label: 'Soul', iconName: 'brain', keywords: 'instructions standing how it works', order: 30, render: soulSection });
registerBotSection({ id: 'model', label: 'Model', iconName: 'sliders-horizontal', keywords: 'connection reasoning effort version', order: 40, render: modelSection });
registerBotSection({ id: 'access', label: 'Access', iconName: 'plug', keywords: 'apps tools mcp servers signed in delivery channel', order: 50, render: accessSection });
registerBotSection({ id: 'permissions', label: 'Permissions', iconName: 'shield', keywords: 'approval full limits runs per day on off', order: 60, render: permissionsSection });
registerBotSection({ id: 'history', label: 'History', iconName: 'history', keywords: 'runs setup changes undo version', order: 70, render: historySection });
registerBotSection({ id: 'usage', label: 'Usage', iconName: 'gauge', keywords: 'daily runs cap results', order: 80, render: usageSection });

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

// -- the panel ------------------------------------------------------------------------------------------------------------
export function mountBotPanel(host, { agentId, section = null, mode = null, onClose } = {}) {
  loadBotsCss(CSS);
  let advanced = mode ? mode === 'advanced' : isAdvanced();
  const state = { agent: null, detail: null, overview: null, threads: null, open: null, stack: [], search: '', cache: {}, signature: '', stale: false, gone: false, popover: false };
  let destroyed = false, kip = null, pollTimer = 0, pendingFocus = null, initialSection = section;
  const root = el('div', { class: 'bots-panel', role: 'region', 'aria-label': 'Bot settings' });
  host.replaceChildren(root);

  const sig = () => JSON.stringify([state.agent, state.overview?.setup, state.threads?.threads?.map(t => [t.id, t.title, t.updated_at, t.message_count, t.follows_bot_model, t.thread, t.status]), state.detail?.runs?.length, state.detail?.setup_receipts?.length]);
  const ensure = async name => {
    if (state.cache[name]) return state.cache[name];
    const path = { models: '/api/models', integrations: '/api/integrations', channels: '/api/channels' }[name];
    return (state.cache[name] = await api(path, { toast: false }).catch(() => []));
  };
  const ctx = {
    get agentId() { return agentId; }, state, get advanced() { return advanced; }, ensure,
    update(patch, options) {
      state.agent = { ...state.agent, ...patch };
      if ('avatar' in patch || 'color' in patch) kip = null;
      if ('name' in patch) root.querySelectorAll('[data-live-name]').forEach(n => { if (n.tagName !== 'INPUT') n.textContent = patch.name; });
      return queue.update(agentId, patch, options);
    },
    refresh: () => load(),
    flush: () => queue.flush(agentId),
    go: id => openSection(id),
    async setupWithBot() {
      try {
        await queue.flush(agentId);
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
      if (!state.agent) { root.replaceChildren(el('div', { class: 'bots-panel-body' }, [note(messageOf(error))])); return; }
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
    if (!kip) kip = botKip(a, { size: 80, state: stateForBot(a, { status: live.state }) });
    else kip.setState(stateForBot(a, { status: live.state }));
    const edit = el('button', { type: 'button', class: 'bots-hero-edit', 'aria-label': 'Edit look', title: 'Edit look', onclick: () => togglePopover() }, [icon('pencil', { size: 14 })]);
    const face = el('div', { class: 'bots-hero-face' }, [kip, edit]);
    const name = el('input', { class: 'bots-hero-name', value: a.name, 'aria-label': 'Name', maxlength: '100', 'data-live-name': '' });
    const job = el('input', { class: 'bots-hero-job', value: a.role || '', 'aria-label': 'Job', placeholder: 'What is this bot for?', maxlength: '200' });
    name.value = a.name; job.value = a.role || '';
    const bind = (input, field, key, empty) => {
      let committed = input.value;
      const commit = () => { const v = input.value.trim(); if (v === committed) return; if (!v && empty === false) { toast('A bot needs a name.', 'error'); input.value = committed; return; } committed = v; ctx.update({ [key]: v }); };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } else if (e.key === 'Escape') { e.stopPropagation(); input.value = committed; input.blur(); } });
    };
    bind(name, 'name', 'name', false); bind(job, 'job', 'role', true);
    const line = el('div', { class: 'bots-hero-status' }, [el('span', { class: `bots-dot ${live.state}` }), el('span', { text: live.text })]);
    const hero = el('div', { class: 'bots-hero' }, [face, name, job, line]);
    if (state.popover) hero.append(lookPopover());
    return el('div', { class: 'bots-panel-top' }, [head, hero]);
  }
  function lookPopover() {
    const picker = avatarPicker(state.agent.avatar || { id: agentId, color: state.agent.color }, spec => { kip?.beat?.('customize'); ctx.update({ avatar: spec }); });
    return el('div', { class: 'bots-popover', role: 'dialog', 'aria-label': 'Edit look' }, [picker.root, Button({ label: 'Done', onClick: () => togglePopover(false) })]);
  }
  function togglePopover(force) { state.popover = typeof force === 'boolean' ? force : !state.popover; render(); }

  function advancedChrome() {
    const a = state.agent;
    const search = el('input', { type: 'search', class: 'bots-search', placeholder: 'Search settings', 'aria-label': 'Search settings', value: state.search });
    search.addEventListener('input', () => { state.search = search.value; const body = root.querySelector('.bots-panel-scroll'); body.replaceChildren(accordion()); });
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
      if (isOpen) item.append(el('div', { class: 'bots-acc-body' }, [s.render(ctx)]));
      wrap.append(item);
    }
    return wrap;
  }

  // The Simple pages: a stack, Details at the bottom.
  function simplePage() {
    const top = state.stack.at(-1) || 'details';
    const previous = state.stack.length > 1 ? PAGE_TITLE(state.stack.at(-2)) : state.stack.length === 1 ? 'Details' : '';
    const pop = () => { state.stack.pop(); render(); };
    const wrap = el('div', { class: 'bots-pages' });
    if (top === 'details') wrap.append(detailsPage());
    else {
      const def = registry.find(s => s.id === top);
      const title = top === 'settings' ? 'Settings' : def?.label || top;
      wrap.append(PageHeader({ title, backLabel: previous, onBack: pop }));
      wrap.append(top === 'settings' ? settingsPage() : def ? el('div', { class: 'bots-page-section' }, [def.render(ctx)]) : note('This page is not available.'));
    }
    return wrap;
  }
  const PAGE_TITLE = id => (id === 'settings' ? 'Settings' : id === 'details' ? 'Details' : registry.find(s => s.id === id)?.label || id);

  function detailsPage() {
    const parts = [];
    const left = (state.overview?.setup || []).filter(s => !s.done);
    if (left.length) parts.push(setupCard(ctx, state.overview.setup));
    parts.push(modelSection(ctx), conversationsCard(ctx));
    parts.push(el('div', { class: 'bots-actions' }, [Button({ label: `Set up with ${state.agent.name}`, iconName: 'sparkles', onClick: () => ctx.setupWithBot() })]));
    return el('div', { class: 'bots-page-section' }, parts);
  }
  function settingsPage() {
    const a = state.agent;
    const intro = TextRow({ title: 'Introduction', value: a.blurb || '', maxLength: 4000, multiline: true, onCommit: v => ctx.update({ blurb: v }) });
    const group = TextRow({ title: 'Group', hint: 'Optional. Bots in a group sit together.', value: a.section || '', maxLength: 60, onCommit: v => ctx.update({ section: v.trim() }) });
    const homes = new Set(Object.keys(SIMPLE_HOME));
    const pages = registry.filter(s => !homes.has(s.id));
    return el('div', { class: 'bots-page-section' }, [
      soulSection(ctx), Card({ children: [intro, group] }), permissionsSection(ctx),
      Card({ label: 'More', children: pages.map(s => NavRow({ title: s.label, iconName: s.iconName, onClick: () => { state.stack = ['settings', s.id]; render(); } })) })]);
  }

  // -- moving around ---------------------------------------------------------------------------------------
  // Put the panel on a section without drawing (the first load) or with a scroll and focus (a link).
  function place(id, { focus = true } = {}) {
    if (!registry.some(s => s.id === id)) return false;
    rememberSection(id);
    if (advanced) {
      state.open = id; state.search = '';
      if (focus) pendingFocus = () => root.querySelector(`.bots-acc-item[data-section="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    } else {
      const home = SIMPLE_HOME[id];
      state.stack = home === 'details' ? [] : home === 'settings' ? ['settings'] : ['settings', id];
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
      document.removeEventListener('kairos:bots-saved', onSaved);
      document.removeEventListener('kairos:bots-rolledback', onRolledBack);
      document.removeEventListener('jarvis:agents-changed', onChanged);
      window.removeEventListener('jarvis:navigate', onNavigate, true);
      root.remove();
    },
    openSection, flush: () => queue.flush(agentId), refresh: () => load({ quiet: true }),
    get mode() { return advanced ? 'advanced' : 'simple'; },
  };
}
