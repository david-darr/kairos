// The fourteen sections of a bot's panel (Phase 1, unit U2; OMB features F5 to F9 and F13 to F15, re-written
// for Kairos). botsPanel.js owns the chrome, the patch queue and the Simple and Advanced layouts; this file
// is the content, drawn from real records and services:
//
//   Overview, Identity, Delivery, Soul, Skills, Memory, Routines, Access, Model, Permissions,
//   Voice and alerts, Who can see it, History, Usage.
//
// A section is {id, label, iconName, keywords, order, render(ctx), keepMounted?}. render(ctx) returns a node.
// ctx (built by botsPanel.js): agentId, state {agent, detail, overview, threads}, advanced, update(patch),
// flush(), refresh(), go(id), ensure(name), adopt(agent), track(handle), ui {api, toast, confirmDialog, ...}.
// Later phases ship section modules (static/js/botsSection<Name>.js exporting mount(host, ctx) ->
// {destroy, refresh, flush}). The server lists which exist (GET /api/agents/section-modules) and a section
// mounts its module when it is there; otherwise, or if the module fails, it draws its own basics with a
// plain note, so the panel is complete either way.
//
// Settings that are stored now but enforced later say so in the row. Nothing here claims a restriction
// that is not in effect. Imports no api.js: the helpers it needs arrive on ctx.ui, so the pure functions
// below load in plain Node (scripts/test_bots_panel_sections.cjs).
import { Card, NavRow, SwitchRow, TextRow, RadioGroup, Segmented, Button, h } from './botsUi.js';
import { icon } from './botsIcons.js';
import { mount as mountTeam } from './botsSectionTeam.js';
import { mountTeamModule } from './botsTeamHost.js';
import { byteLength, clipToBytes, describeRow, canRestore, driftState, profileDiff, actorLabel, fieldLabel, shortValue } from './botsProfileDiff.js';

export const SOUL_BYTES = 24000;
export const MEMORY_CHARS = 24576;
export const MAX_FALLBACKS = 5;
const OUTCOME = { succeeded: 'Done', failed: 'Failed', lost: 'Did not finish', skipped: 'Skipped', stopped: 'Stopped' };

// -- pure helpers (tested in Node) ---------------------------------------------------------------------
export const messageOf = error => String(error?.message || error).replace(/^\d+:\s*/, '');

export function ago(seconds, now = Date.now() / 1000) {
  if (!seconds) return '';
  const gap = Math.max(0, now - seconds);
  if (gap < 90) return 'just now';
  if (gap < 3600) return `${Math.round(gap / 60)} min ago`;
  if (gap < 86400) return `${Math.round(gap / 3600)} h ago`;
  return `${Math.round(gap / 86400)} d ago`;
}

// The byte counter under the standing instructions.
export function soulCounter(text) {
  const used = byteLength(text);
  return { used, limit: SOUL_BYTES, over: used > SOUL_BYTES, text: `${used.toLocaleString('en-US')} / ${SOUL_BYTES.toLocaleString('en-US')} bytes` };
}

// What a skill row shows, from the shared catalog and the bot's saved selection.
export function skillRows(skills, selection) {
  const off = new Set(selection?.disabled || []);
  return (skills || []).map(skill => ({ slug: skill.slug, name: skill.name || skill.slug, description: skill.description || '',
    error: skill.error || '', on: !off.has(skill.slug) }));
}
export function selectionAfterToggle(selection, slug, on) {
  const off = new Set(selection?.disabled || []);
  if (on) off.delete(slug); else off.add(slug);
  return { mode: 'all', disabled: [...off] };
}

// "Every day at 08:00", "Every 6 hours", from a routine (a scheduled task).
export function routineSchedule(task) {
  if (task.schedule_kind === 'daily') {
    const days = Array.isArray(task.weekdays) && task.weekdays.length && task.weekdays.length < 7
      ? ` on ${task.weekdays.map(d => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(', ')}` : ' every day';
    return `At ${task.run_time || '??:??'}${days}${task.time_zone ? `, ${task.time_zone}` : ''}`;
  }
  if (task.schedule_kind === 'interval') {
    const hours = (task.interval_seconds || 0) / 3600;
    return hours >= 1 && Number.isInteger(hours) ? `Every ${hours === 1 ? 'hour' : `${hours} hours`}` : `Every ${Math.max(1, Math.round((task.interval_seconds || 60) / 60))} minutes`;
  }
  return task.schedule_kind || 'Scheduled';
}

export function fallbackAfter(list, change) {
  const next = Array.isArray(list) ? list.map(item => ({ ...item })) : [];
  if (change.add && next.length < MAX_FALLBACKS && !next.some(f => f.endpoint_id === change.add.endpoint_id && (f.model_override || null) === (change.add.model_override || null))) next.push({ ...change.add });
  if (typeof change.remove === 'number') next.splice(change.remove, 1);
  return next;
}

// Permissions follow the bot and conversation's effective policy.
export const APPROVAL_LEVELS = [
  { value: 'full', title: 'Full access', hint: 'It acts without asking. You can stop it at any time.', now: true },
  { value: 'auto', title: 'Auto', hint: 'Reviews eligible actions and asks when unsure.', now: true },
  { value: 'ask', title: 'Ask first', hint: 'Asks before changing anything.', now: true },
  { value: 'edits', title: 'Edits', hint: 'Allows edits within its granted folders and Kairos data.', now: true },
  { value: 'custom', title: 'Custom', hint: 'Asks unless an exact rule allows the action.', now: true },
];
export function permissionFacts(agent) {
  const outbound = agent.outbound || { policy: 'ask', daily_cap: 25 };
  return { effective: agent.approval_mode || 'full', storedApproval: agent.approval_mode || 'full', outboundPolicy: outbound.policy, outboundCap: outbound.daily_cap,
    alwaysAllow: agent.always_allow || [], runCap: agent.daily_run_cap ?? 12 };
}

// Usage: today's runs against the cap, and the results of the runs that are kept.
export function usageFacts(agent, runs) {
  const cap = agent.daily_run_cap || 12, used = agent.runs_today || 0;
  const tally = {};
  for (const run of runs || []) tally[run.outcome] = (tally[run.outcome] || 0) + 1;
  const timed = (runs || []).filter(run => run.duration_seconds);
  return { cap, used, left: Math.max(0, cap - used), percent: Math.min(100, Math.round((used / cap) * 100)), tally,
    average: timed.length ? Math.round(timed.reduce((n, run) => n + run.duration_seconds, 0) / timed.length) : 0, runs: (runs || []).length };
}

// Who can see it: the real signed-in account, and that access is for admins on this device only.
export function visibilityFacts(status) {
  const signedIn = status?.auth_enabled ? (status.username ? `Signed in as ${status.username}` : 'Not signed in') : 'This device, with no accounts turned on';
  return { account: signedIn, admin: !!status?.is_admin, accounts: !!status?.auth_enabled };
}

// Voice and alerts: what can really be chosen on this setup.
export function voiceFacts(agent, catalog, liveChoices) {
  const voices = Array.isArray(catalog?.voices) ? catalog.voices.map(v => ({ id: String(v.id ?? v.name ?? v), name: String(v.name ?? v.id ?? v) })) : [];
  const live = Array.isArray(liveChoices) ? liveChoices.length > 0 : false;
  return { voices, hasVoices: voices.length > 0, liveAvailable: live, callMode: agent.call_mode === 'live' && !live ? 'turns' : agent.call_mode || 'turns' };
}

// Delivery: the connected channels, the chosen one and whether it still exists.
export function deliveryFacts(agent, channels) {
  const list = (channels || []).map(c => ({ id: c.id, label: c.label, configured: c.configured !== false }));
  const chosen = agent.deliver_to_channel || '';
  const found = list.find(c => c.id === chosen);
  return { channels: list, chosen, chosenLabel: chosen ? (found?.label || chosen) : 'In the app only', missing: !!chosen && !found,
    connected: list.filter(c => c.configured).length };
}

export const SECTION_DEFS = [
  { id: 'overview', label: 'Overview', iconName: 'info', keywords: 'summary setup checklist prompt recent', order: 10, simple: 'details' },
  { id: 'identity', label: 'Identity', iconName: 'pencil', keywords: 'name job role look avatar picture kip group introduction expression', order: 20, simple: 'details' },
  { id: 'delivery', label: 'Delivery', iconName: 'send', keywords: 'channel discord reports destination notify', order: 30, simple: 'settings' },
  { id: 'soul', label: 'Soul', iconName: 'brain', keywords: 'instructions standing how it works reply style drift', order: 40, simple: 'settings' },
  { id: 'skills', label: 'Skills', iconName: 'sparkles', keywords: 'skills catalog learn', order: 50, simple: 'page' },
  { id: 'memory', label: 'Memory', iconName: 'book-open', keywords: 'notes topics remember upkeep journal', order: 60, simple: 'page', keepMounted: true },
  { id: 'routines', label: 'Routines', iconName: 'repeat', keywords: 'goals schedule daily every check now pause', order: 70, simple: 'page' },
  { id: 'access', label: 'Access', iconName: 'plug', keywords: 'apps tools mcp servers peers signed in logins creative', order: 80, simple: 'page' },
  { id: 'model', label: 'Model', iconName: 'sliders-horizontal', keywords: 'connection reasoning effort version fallback keep warm', order: 90, simple: 'details' },
  { id: 'permissions', label: 'Permissions', iconName: 'shield', keywords: 'approval full limits runs per day on off outbound allowlist', order: 100, simple: 'settings' },
  { id: 'voice', label: 'Voice and alerts', iconName: 'bell', keywords: 'notifications speak voice call mode alerts', order: 110, simple: 'page' },
  { id: 'who', label: 'Who can see it', iconName: 'users', keywords: 'visibility account access admin sharing', order: 120, simple: 'page' },
  { id: 'history', label: 'History', iconName: 'history', keywords: 'changes rollback undo version setup receipts', order: 130, simple: 'page' },
  { id: 'usage', label: 'Usage', iconName: 'gauge', keywords: 'daily runs cap results cost', order: 140, simple: 'page' },
];
export const SIMPLE_HOME = Object.freeze(Object.fromEntries(SECTION_DEFS.map(s => [s.id, s.simple])));

// -- small pieces ------------------------------------------------------------------------------------------
export const fact = (title, lines) => h('div', { class: 'bots-row bots-fact' }, [h('span', { class: 'bots-row-main' }, [
  h('span', { class: 'bots-row-title', text: title }), ...[].concat(lines).filter(Boolean).map(text => h('span', { class: 'bots-row-hint', text }))])]);
export const note = text => h('div', { class: 'bots-row bots-note-line' }, [icon('info', { size: 16 }), h('span', { class: 'bots-row-hint', text })]);
export const caps = text => h('div', { class: 'bots-caps bots-card-label', text });
const retry = (label, onClick) => Button({ label, iconName: 'refresh-cw', onClick });

// A block that fills when its data arrives, says so while it waits, and offers Try again when it fails.
export function loading(build, what = 'This') {
  const holder = h('div', { class: 'bots-lazy', 'aria-busy': 'true' });
  const run = () => {
    holder.replaceChildren(note('Loading…'));
    Promise.resolve().then(build).then(node => { holder.removeAttribute('aria-busy'); holder.replaceChildren(node); })
      .catch(error => { holder.removeAttribute('aria-busy'); holder.replaceChildren(note(`${what} could not load. ${messageOf(error)}`), h('div', { class: 'bots-actions' }, [retry('Try again', run)])); });
  };
  run();
  return holder;
}

function longText({ value, limit, bytes = false, rows = 8, label, onChange, disabled = false, id }) {
  const area = h('textarea', { rows: String(rows), 'aria-label': label, disabled: disabled || undefined, 'data-field': id });
  const count = h('small', { class: 'bots-count', role: 'status' });
  const paint = () => {
    const state = bytes ? soulCounter(area.value) : { text: `${area.value.length.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} characters`, over: area.value.length > limit };
    count.textContent = state.text; count.classList.toggle('over', state.over);
  };
  area.value = value || '';
  area.addEventListener('input', () => {
    if (bytes) { const clipped = clipToBytes(area.value, limit); if (clipped !== area.value) area.value = clipped; }
    else if (area.value.length > limit) area.value = area.value.slice(0, limit);
    paint(); onChange(area.value);
  });
  paint();
  return { node: h('div', { class: 'bots-row bots-stack-row' }, [area, count]), area, paint };
}

// Mount a later phase's module in a new block, or nothing at all when it is not installed (an
// extra page such as the skill library has no basics of its own). A module that fails says so.
export function mountModule(ctx, name) {
  const host = h('div', { class: 'bots-module', 'data-module': name });
  const track = ctx.bindTrack ? ctx.bindTrack() : ctx.track;
  ctx.sectionModules().then(async installed => {
    if (!installed.has(name)) return;
    try {
      const mod = await ctx.loadModule(name);
      if (typeof mod?.mount !== 'function') throw new Error('it has no mount');
      const handle = await mod.mount(host, ctx);
      if (handle) track(handle);
    } catch (error) { host.replaceChildren(note('This part could not load. Try again in a moment.')); }
  });
  return host;
}

// Mount a later phase's section module in `host`; draws `basics` and a note when it is not there.
function modular(ctx, name, basics, { what }) {
  const host = h('div', { class: 'bots-module', 'data-module': name });
  const basic = (why) => { host.replaceChildren(...(why ? [note(why)] : []), basics()); };
  // Bind now: the mount resolves later, after the panel has moved its tracking bucket back,
  // and a kept section's handle must stay with the kept ones or each redraw destroys it.
  const track = ctx.bindTrack ? ctx.bindTrack() : ctx.track;
  ctx.sectionModules().then(async installed => {
    if (!installed.has(name)) return basic('');
    try {
      const mod = await ctx.loadModule(name);
      if (typeof mod?.mount !== 'function') throw new Error('it has no mount');
      host.replaceChildren();
      const handle = await mod.mount(host, ctx);
      if (handle) track(handle);
    } catch (error) { basic(`${what} could not load its full view. Showing the basics.`); }
  });
  return host;
}

// -- Overview ----------------------------------------------------------------------------------------------
function overviewSection(ctx) {
  const { agent, overview, detail } = ctx.state;
  const body = h('div', {});
  if (overview) {
    const routines = overview.does?.routines || [];
    const on = routines.filter(r => r.enabled).length;
    const does = [routines.length ? `${routines.length} routine${routines.length === 1 ? '' : 's'}, ${on} on` : 'No routines yet',
      overview.does?.triggers?.length ? `${overview.does.triggers.length} trigger${overview.does.triggers.length === 1 ? '' : 's'}` : '',
      overview.does?.open_cards ? `${overview.does.open_cards} open task${overview.does.open_cards === 1 ? '' : 's'}` : ''].filter(Boolean);
    const integrations = overview.reaches?.integrations;
    const reaches = [integrations === 'all' ? 'Every connected tool server' : integrations?.length ? `${integrations.length} tool server${integrations.length === 1 ? '' : 's'}` : 'No tool servers',
      overview.reaches?.keep_signed_in ? 'Stays signed in to sites' : '', overview.reaches?.deliver_to_channel ? `Reports on ${overview.reaches.deliver_to_channel}` : 'Reports in the app'].filter(Boolean);
    const runs = (detail?.runs || []).slice(0, 3);
    const names = new Map((detail?.goals || []).map(g => [g.id, g.name]));
    body.append(Card({ label: 'At a glance', className: 'bots-glance', children: [
      fact('Who', [agent.role || 'No job set yet', overview.who?.section ? `Group: ${overview.who.section}` : '']),
      fact('What it does', does), fact('What it can reach', reaches),
      fact('What it will not do', overview.wont?.length ? overview.wont : 'Nothing is held back.'),
      ...(runs.length ? [fact('Recent runs', runs.map(r => `${names.get(r.task_id) || 'A routine'}: ${OUTCOME[r.outcome] || r.outcome || 'ran'} ${ago(r.ran_at)}`.trim()))]
        : overview.recent?.length ? [fact('Recently', overview.recent.map(r => `${r.name || 'A run'}: ${r.outcome || 'ran'} ${ago(r.ran_at)}`.trim()))] : []),
    ] }));
    body.append(setupCard(ctx, overview.setup || []));
  } else body.append(Card({ children: [note('The overview could not be loaded just now.'), h('div', { class: 'bots-actions' }, [retry('Try again', () => ctx.refresh())])] }));
  body.append(h('div', { class: 'bots-actions' }, [Button({ label: `Set up with ${agent.name}`, iconName: 'sparkles', onClick: () => ctx.setupWithBot() })]));
  if (ctx.advanced) body.append(ctx.conversationsCard(), promptPreview(ctx));
  return body;
}

export function setupCard(ctx, steps) {
  if (!steps.length) return h('div');
  const known = new Set(SECTION_DEFS.map(s => s.id));
  const rows = steps.map(step => {
    const mark = icon(step.done ? 'check' : 'circle-alert', { size: 18 });
    const main = h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: step.label })]);
    return known.has(step.section)
      ? h('button', { type: 'button', class: 'bots-row bots-nav-row bots-setup-step', 'data-done': String(!!step.done), onclick: () => ctx.go(step.section) }, [mark, main, h('span', { class: 'bots-chevron' }, [icon('chevron-right', { size: 16 })])])
      : h('div', { class: 'bots-row bots-setup-step', 'data-done': String(!!step.done) }, [mark, main]);
  });
  const left = steps.filter(s => !s.done).length;
  return Card({ label: left ? `Set up (${left} to go)` : 'Set up', className: 'bots-setup', children: rows });
}

// "What the model sees": the parts Kairos adds, with their size. The same builder as a live chat.
function promptPreview(ctx) {
  const holder = h('div', { class: 'bots-prompt-body' });
  const box = h('details', { class: 'bots-prompt' }, [h('summary', {}, [icon('eye', { size: 16 }), h('span', { class: 'bots-prompt-summary', text: 'What the model sees' })]), holder]);
  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true; holder.replaceChildren(note('Reading…'));
    try {
      const saved = await ctx.flushResult();
      if (!saved.ok) throw saved.error;
      const data = await ctx.ui.api(`/api/agents/${ctx.agentId}/system-prompt`, { toast: false });
      box.querySelector('.bots-prompt-summary').textContent = `What the model sees: ${data.total_bytes.toLocaleString('en-US')} bytes, about ${data.approx_tokens.toLocaleString('en-US')} tokens`;
      holder.replaceChildren(...data.sections.map(s => h('details', { class: 'bots-prompt-part', 'data-part': s.id }, [
        h('summary', { text: `${s.label} (${s.bytes.toLocaleString('en-US')} bytes)` }), h('pre', { text: s.text })])), h('p', { class: 'bots-hint', text: data.note }));
    } catch (error) { loaded = false; holder.replaceChildren(note(messageOf(error))); }
  });
  return box;
}

// -- Identity ----------------------------------------------------------------------------------------------
function identitySection(ctx) {
  const { agent } = ctx.state;
  const nameRow = TextRow({ title: 'Name', value: agent.name, maxLength: 100, onCommit: v => {
    const name = v.trim();
    if (!name) { ctx.ui.toast('A bot needs a name.', 'error'); nameRow.set(ctx.state.agent.name); return; }
    ctx.update({ name });
  } });
  const jobRow = TextRow({ title: 'Job', hint: 'What is this bot for?', value: agent.role || '', maxLength: 200, onCommit: v => ctx.update({ role: v.trim() }) });
  const blurbRow = TextRow({ title: 'Introduction', value: agent.blurb || '', maxLength: 4000, multiline: true, onCommit: v => ctx.update({ blurb: v }) });
  const groupRow = teamRow(ctx);
  const look = h('div', { class: 'bots-avatar-host' });
  const wrap = h('div', { 'data-panel-card': 'identity' }, [Card({ className: 'bots-identity', children: [nameRow, jobRow, blurbRow, groupRow] }), caps('Look'), look]);
  ctx.mountAvatar(look);
  wrap.nameField = nameRow.field;
  return wrap;
}

export function teamRow(ctx) {
  const host = h('div', { class: 'bots-section-team', 'data-module': 'Team' });
  const track = ctx.bindTrack ? ctx.bindTrack() : ctx.track;
  track?.(mountTeam(host, ctx));
  return host;
}

// -- Delivery ----------------------------------------------------------------------------------------------
function deliverySection(ctx) {
  return h('div', { 'data-panel-card': 'delivery' }, [caps('Where it reports'), loading(async () => {
    const channels = await ctx.ensure('channels');
    const facts = deliveryFacts(ctx.state.agent, channels);
    const select = ctx.ui.customSelect({ 'aria-label': 'Report to' }, [h('option', { value: '', text: 'In the app only' }), ...facts.channels.map(c => h('option', { value: c.id, text: c.label }))]);
    select.value = facts.chosen;
    select.addEventListener('change', () => ctx.update({ deliver_to_channel: select.value || null }));
    const rows = facts.channels.length ? facts.channels.map(c => fact(c.label, c.configured ? 'Connected' : 'Not connected yet')) : [note('No channels are connected. Reports stay in the app. Connect one in Settings, under Channels.')];
    return h('div', {}, [
      Card({ children: [h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: 'Tell me on' }),
        h('span', { class: 'bots-row-hint', text: 'Where its reports and questions reach you.' })]), select])] }),
      facts.missing ? note(`${facts.chosenLabel} is not connected any more, so reports stay in the app.`) : fact('Now', facts.chosenLabel),
      Card({ label: `Channels (${facts.connected} connected)`, children: rows })]);
  }, 'Delivery')]);
}

// -- Soul --------------------------------------------------------------------------------------------------
function soulSection(ctx) {
  const { agent, detail } = ctx.state;
  const file = detail?.soul_file;
  const drift = driftState(file);
  const parts = [];
  if (drift !== 'same') parts.push(driftCard(ctx, file, drift));
  const editor = longText({ value: agent.soul || agent.instructions || '', limit: SOUL_BYTES, bytes: true, rows: 10, label: 'Standing instructions',
    disabled: drift !== 'same', id: 'soul', onChange: v => ctx.update({ soul: v }) });
  parts.push(Card({ label: 'Standing instructions', children: [editor.node] }),
    h('p', { class: 'bots-hint', text: 'How this bot works, every time. It reads this at the start of each chat.' }));
  const style = Segmented({ label: 'Reply style', value: agent.reply_style || 'default',
    options: [{ value: 'default', label: 'Default' }, { value: 'conversational', label: 'Conversational' }], onChange: v => ctx.update({ reply_style: v }) });
  parts.push(Card({ label: 'Reply style', children: [h('div', { class: 'bots-row bots-stack-row' }, [style,
    h('span', { class: 'bots-row-hint', text: 'Conversational shows a long reply as short paragraphs, one after another. Code stays whole.' })])] }));
  parts.push(h('div', { class: 'bots-actions' }, [Button({ label: 'See how this changed', iconName: 'history', onClick: () => ctx.go('history') })]));
  return h('div', { 'data-panel-card': 'soul' }, parts);
}

function driftCard(ctx, file, drift) {
  const box = h('div', { class: 'bots-card bots-drift', role: 'group', 'aria-label': 'SOUL.md was changed outside Kairos' });
  const busy = (button, work) => async () => {
    button.disabled = true;
    try {
      const saved = await ctx.flushResult();
      if (!saved.ok) throw saved.error;
      await work();
      await ctx.refresh();
    } catch (error) { ctx.ui.toast(messageOf(error), 'error'); button.disabled = false; await ctx.refresh().catch(() => {}); }
  };
  const body = { expected_file_text: file.file_text ?? null, expected_revision: file.revision ?? ctx.state.agent.revision ?? 0 };
  const apply = Button({ label: 'Use the file', variant: 'primary', iconName: 'check', disabled: drift === 'file-missing', onClick: () => {} });
  const discard = Button({ label: 'Keep what Kairos has', iconName: 'undo-2', onClick: () => {} });
  apply.addEventListener('click', busy(apply, () => ctx.ui.api(`/api/agents/${ctx.agentId}/soul/apply`, { method: 'POST', body: JSON.stringify(body), toast: false }).then(() => ctx.ui.toast('Instructions updated from the file', 'success'))));
  discard.addEventListener('click', busy(discard, () => ctx.ui.api(`/api/agents/${ctx.agentId}/soul/discard-file`, { method: 'POST', body: JSON.stringify(body), toast: false }).then(() => ctx.ui.toast('The file was reset', 'success'))));
  box.append(caps('Changed outside Kairos'),
    h('p', { class: 'bots-hint', text: drift === 'file-missing' ? 'SOUL.md was deleted. Keep what Kairos has to write it again.' : 'SOUL.md differs from the instructions Kairos has. Choose one before editing here.' }),
    ...(drift === 'file-differs' ? [h('p', { class: 'bots-caps', text: 'Kairos has, then the file' }), profileDiff(file.soul || '', file.file_text || '')] : []),
    h('div', { class: 'bots-actions' }, [apply, discard]));
  return box;
}

// -- Skills ------------------------------------------------------------------------------------------------
function skillsBasics(ctx) {
  return loading(async () => {
    const skills = await ctx.ui.api('/api/skills', { toast: false });
    const rows = skillRows(Array.isArray(skills) ? skills : [], ctx.state.agent.skill_selection);
    const list = h('div', { class: 'bots-card-body' });
    const draw = () => {
      list.replaceChildren();
      const shown = skillRows(Array.isArray(skills) ? skills : [], ctx.state.agent.skill_selection);
      if (!shown.length) list.append(note('There are no skills yet. Skills you add in Settings appear here.'));
      for (const s of shown) list.append(SwitchRow({ title: s.name, hint: s.error ? `Could not be read: ${s.error}` : s.description, checked: s.on, disabled: !!s.error,
        onChange: on => { ctx.update({ skill_selection: selectionAfterToggle(ctx.state.agent.skill_selection, s.slug, on) }); } }));
    };
    draw();
    const off = rows.filter(r => !r.on).length;
    return h('div', {}, [note('Only reviewed skills switched on for this bot are available.'),
      h('div', { class: 'bots-card' }, [caps(`Skills (${rows.length})`), list])]);
  }, 'Skills');
}
const skillsSection = ctx => h('div', { 'data-panel-card': 'skills' }, [modular(ctx, 'Skills', () => skillsBasics(ctx), { what: 'Skills' })]);

// -- Memory ------------------------------------------------------------------------------------------------
function memoryBasics(ctx) {
  const { agent, detail } = ctx.state;
  const state = { text: detail?.memory || '', saved: detail?.memory || '', busy: false };
  const editor = longText({ value: state.text, limit: MEMORY_CHARS, bytes: true, rows: 12, label: 'Memory', id: 'memory', onChange: v => { state.text = v; sync(); } });
  const save = Button({ label: 'Save memory', variant: 'primary', disabled: true, onClick: async () => {
    state.busy = true; sync();
    try {
      await ctx.flush();
      await ctx.ui.api(`/api/agents/${ctx.agentId}/memory`, { method: 'PUT', body: JSON.stringify({ text: state.text }), toast: false });
      state.saved = state.text; ctx.ui.toast('Memory saved', 'success');
    } catch (error) { ctx.ui.toast(messageOf(error), 'error'); }
    state.busy = false; sync();
  } });
  const sync = () => { save.disabled = state.busy || state.text === state.saved; };
  const topics = h('div', { class: 'bots-card-body' }, [note('Loading topics…')]);
  ctx.ui.api(`/api/agents/${ctx.agentId}/memory/topics`, { toast: false }).then(data => {
    topics.replaceChildren(...(data.topics.length ? data.topics.map(t => fact(t.name, t.description)) : [note('No topics yet. A bot adds one when it has a lot to keep on a subject.')]));
  }).catch(error => topics.replaceChildren(note(`Topics could not load. ${messageOf(error)}`)));
  const journal = h('div', { class: 'bots-card-body' }, [note('Loading…')]);
  const drawJournal = entries => {
    journal.replaceChildren(...(entries.length ? entries.slice(0, 10).map(entry => {
      const undo = Button({ label: entry.status === 'undone' ? 'Undone' : 'Undo', iconName: 'undo-2', disabled: entry.status !== 'committed', onClick: async () => {
        undo.disabled = true;
        try { await ctx.ui.api(`/api/agents/${ctx.agentId}/memory/upkeep/${entry.id}/undo`, { method: 'POST', toast: false }); ctx.ui.toast('Tidy-up undone', 'success'); ctx.resetKept?.('memory'); await ctx.refresh(); }
        catch (error) { ctx.ui.toast(messageOf(error), 'error'); undo.disabled = false; }
      } });
      return h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: entry.summary || 'Tidied its notes' }),
        h('span', { class: 'bots-row-hint', text: entry.ts ? new Date(entry.ts * 1000).toLocaleString() : '' })]), undo]);
    }) : [note('Nothing has been tidied yet.')]));
  };
  drawJournal(detail?.memory_upkeep_journal || []);
  return h('div', {}, [
    Card({ label: 'What it remembers', children: [editor.node] }),
    h('div', { class: 'bots-actions' }, [save]),
    Card({ label: 'Topics', children: [topics] }),
    Card({ label: 'Keeping notes tidy', children: [
      SwitchRow({ title: 'Keep its own notes tidy', hint: 'It reviews and cleans up what it remembers.', checked: !!agent.memory_upkeep, onChange: v => ctx.update({ memory_upkeep: v }) }), journal] }),
  ]);
}
const memorySection = ctx => h('div', { 'data-panel-card': 'memory' }, [modular(ctx, 'Memory', () => memoryBasics(ctx), { what: 'Memory' })]);

// -- Routines ----------------------------------------------------------------------------------------------
function routinesBasics(ctx) {
  const wrap = h('div', {});
  const act = async (work, done) => {
    try { await ctx.flush(); await work(); if (done) ctx.ui.toast(done, 'success'); await ctx.refresh(); } catch (error) { ctx.ui.toast(messageOf(error), 'error'); }
  };
  const goals = ctx.state.detail?.goals || [];
  const runs = ctx.state.detail?.runs || [];
  const list = goals.map(g => {
    const last = runs.find(r => r.task_id === g.id);
    const toggle = Button({ label: g.enabled === false ? 'Resume' : 'Pause', iconName: g.enabled === false ? 'play' : 'pause', onClick: () => act(() => ctx.ui.api(`/api/tasks/${g.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: g.enabled === false }), toast: false })) });
    const check = Button({ label: 'Check now', iconName: 'zap', disabled: g.enabled === false, onClick: () => act(() => ctx.ui.api(`/api/tasks/${g.id}/run`, { method: 'POST', toast: false }), 'Started') });
    const edit = Button({ label: 'Edit', iconName: 'pencil', onClick: () => editRoutine(g) });
    const remove = Button({ label: 'Remove', iconName: 'trash-2', variant: 'danger', onClick: async () => {
      if (await ctx.ui.confirmDialog({ title: `Remove ${g.name}?`, message: 'It stops running. Its past runs stay in History.', confirmLabel: 'Remove' })) act(() => ctx.ui.api(`/api/tasks/${g.id}`, { method: 'DELETE', toast: false }), 'Removed');
    } });
    return h('div', { class: 'bots-row bots-routine', 'data-routine': g.id }, [h('span', { class: 'bots-row-main' }, [
      h('span', { class: 'bots-row-title', text: g.name }),
      h('span', { class: 'bots-row-hint', text: `${routineSchedule(g)}${g.enabled === false ? ', paused' : ''}` }),
      h('span', { class: 'bots-row-hint', text: last ? `Last run: ${OUTCOME[last.outcome] || last.outcome || 'ran'} ${ago(last.ran_at)}` : 'Has not run yet' })]),
      h('span', { class: 'bots-routine-actions' }, [check, toggle, edit, remove])]);
  });
  function editRoutine(g) {
    const name = h('input', { type: 'text', 'aria-label': 'Routine name', maxlength: '200' }); name.value = g?.name || '';
    const prompt = h('textarea', { rows: '4', 'aria-label': 'What to do', maxlength: '8000' }); prompt.value = g?.prompt || '';
    const kind = ctx.ui.customSelect({ 'aria-label': 'How often' }, [h('option', { value: 'daily', text: 'Every day' }), h('option', { value: 'interval', text: 'Every few hours' })]);
    kind.value = g?.schedule_kind === 'interval' ? 'interval' : 'daily';
    const time = h('input', { type: 'time', 'aria-label': 'Time of day' }); time.value = g?.run_time || '08:00';
    const hours = h('input', { type: 'number', min: '1', max: '168', 'aria-label': 'Hours between runs' }); hours.value = String(Math.max(1, Math.round((g?.interval_seconds || 21600) / 3600)));
    const zone = h('input', { type: 'text', 'aria-label': 'Time zone', placeholder: 'For example Europe/Paris' }); zone.value = g?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const days = h('div', { class: 'bots-days', role: 'group', 'aria-label': 'Days' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => {
      const box = h('input', { type: 'checkbox', 'data-day': String(i), 'aria-label': label }); box.checked = !g?.weekdays?.length || g.weekdays.includes(i);
      return h('label', { class: 'bots-day' }, [box, h('span', { text: label })]);
    }));
    const sync = () => { const daily = kind.value === 'daily'; time.hidden = !daily; hours.hidden = daily; days.hidden = !daily; zone.hidden = !daily; };
    kind.addEventListener('change', sync); sync();
    const save = Button({ label: g ? 'Save routine' : 'Add routine', variant: 'primary', onClick: async () => {
      const weekdays = [...days.querySelectorAll('input:checked')].map(n => Number(n.dataset.day));
      const body = { name: name.value.trim(), prompt: prompt.value.trim() };
      if (!body.name || !body.prompt) { ctx.ui.toast('A routine needs a name and what to do.', 'error'); return; }
      try {
        await ctx.flush();
        if (g) await ctx.ui.api(`/api/tasks/${g.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, ...(kind.value === 'daily' ? { time_zone: zone.value.trim() || null, weekdays: weekdays.length === 7 ? null : weekdays } : {}) }), toast: false });
        else await ctx.ui.api(`/api/agents/${ctx.agentId}/goals`, { method: 'POST', toast: false, body: JSON.stringify({ ...body, schedule_kind: kind.value,
          ...(kind.value === 'daily' ? { run_time: time.value, time_zone: zone.value.trim() || undefined, weekdays: weekdays.length === 7 || !weekdays.length ? undefined : weekdays } : { interval_seconds: Math.max(1, Number(hours.value) || 6) * 3600 }) }) });
        dialog.close(); ctx.ui.toast(g ? 'Routine saved' : 'Routine added', 'success'); await ctx.refresh();
      } catch (error) { ctx.ui.toast(messageOf(error), 'error'); }
    } });
    const dialog = ctx.ui.openPanelDialog({ title: g ? `Edit ${g.name}` : 'New routine', className: 'bots-dialog',
      body: h('div', { class: 'bots-form' }, [h('label', {}, [h('span', { text: 'Name' }), name]), h('label', {}, [h('span', { text: 'What to do' }), prompt]),
        h('label', {}, [h('span', { text: 'How often' }), kind]), time, hours, zone, days]),
      footer: h('div', { class: 'bots-dialog-footer' }, [save]) });
  }
  wrap.append(Card({ label: `Routines (${goals.length})`, children: list.length ? list : [note('No routines yet. A routine is something it does on a schedule.')] }),
    h('div', { class: 'bots-actions' }, [Button({ label: 'Add a routine', iconName: 'plus', onClick: () => editRoutine(null) })]),
    note('The time zone and weekdays you set are saved with each routine. Catch-up and overlap rules arrive with scheduling.'));
  return wrap;
}
// Kip's own day watch (botsSectionWatch.js) leads its Routines: pause, check now, morning brief (2026-11-05).
const routinesSection = ctx => h('div', { 'data-panel-card': 'routines' }, [
  ...(ctx.state.agent?.builtin === 'front_desk' ? [mountModule(ctx, 'Watch')] : []),
  modular(ctx, 'Routines', () => routinesBasics(ctx), { what: 'Routines' })]);

// -- Access ------------------------------------------------------------------------------------------------
function accessBasics(ctx) {
  const { agent } = ctx.state;
  const wrap = h('div', {});
  wrap.append(loading(async () => {
    const [integrations, bots] = await Promise.all([ctx.ensure('integrations'), ctx.ensure('bots')]);
    const servers = integrations.filter(i => i.kind === 'mcp_server');
    const body = h('div', { class: 'bots-card-body' });
    const draw = () => {
      body.replaceChildren();
      const all = ctx.state.agent.integration_ids === null || ctx.state.agent.integration_ids === undefined;
      body.append(SwitchRow({ title: 'Every connected tool server', hint: servers.length ? 'Turn off to pick which ones this bot may use.' : 'None are connected yet. Add one in Settings, under Integrations.',
        checked: all, onChange: v => { ctx.update({ integration_ids: v ? null : servers.map(s => s.id) }); draw(); } }));
      if (!all) for (const s of servers) body.append(SwitchRow({ title: s.name, checked: ctx.state.agent.integration_ids.includes(s.id),
        onChange: v => { const set = new Set(ctx.state.agent.integration_ids); if (v) set.add(s.id); else set.delete(s.id); ctx.update({ integration_ids: [...set] }); } }));
    };
    draw();
    const scope = ctx.state.agent.tool_scope || { allow: [], deny: [] }, apps = Object.entries(ctx.state.agent.connector_scopes || {});
    const stored = [...scope.allow.map(s => `Allowed: ${s}`), ...scope.deny.map(s => `Avoid: ${s}`), ...apps.map(([k, v]) => `${k}: ${v}`)];
    return h('div', {}, [
      h('div', { class: 'bots-card' }, [caps('Tool servers'), body]),
      Card({ label: 'Habits', children: [
        SwitchRow({ title: 'Stay signed in', hint: 'Keep the sites it logs into between runs.', checked: !!agent.keep_signed_in, onChange: v => ctx.update({ keep_signed_in: v }) }),
        h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: 'Signed-in sites' }), h('span', { class: 'bots-row-hint', text: 'Forget every login this bot has kept.' })]),
          Button({ label: 'Forget logins', iconName: 'lock', onClick: async () => {
            if (!(await ctx.ui.confirmDialog({ title: 'Forget all logins?', message: 'This bot will have to sign in again.', confirmLabel: 'Forget' }))) return;
            try { await ctx.ui.api(`/api/agents/${ctx.agentId}/forget-logins`, { method: 'POST', toast: false }); ctx.ui.toast('Logins forgotten', 'success'); } catch (error) { ctx.ui.toast(messageOf(error), 'error'); }
          } })])] }),
      Card({ label: 'Tool limits', children: stored.length ? [note('These limits apply at every approval level.'), ...stored.map(text => fact(text, ''))] : [note('It may use every tool available within its grants.')] }),
    ]);
  }, 'Access'));
  wrap.append(h('div', { class: 'bots-actions' }, [ctx.ui.creativeSelectionButton(() => ({ agentId: ctx.agentId }), wrap)]));
  return wrap;
}
const accessSection = ctx => {
  const reach = h('div', { 'data-module': 'Reach' });
  const track = ctx.bindTrack ? ctx.bindTrack() : ctx.track;
  track?.(mountTeamModule(reach, 'reach', ctx));
  // Signed-in sites and browser profiles (Phase 6, botsSectionSites.js); Access's own Habits card is the fallback.
  const sites = modular(ctx, 'Sites', () => h('div'), { what: 'Signed-in sites' });
  const profiles = h('div', { 'data-module': 'BrowserProfiles' });
  import('./botsBrowserProfiles.js').then(m => m.mount(profiles, ctx)).then(handle => { if (handle) track?.(handle); })
    .catch(() => profiles.replaceChildren(note('Browser profiles could not load.')));
  return h('div', { 'data-panel-card': 'access' }, [modular(ctx, 'Grants', () => accessBasics(ctx), { what: 'Access' }), reach, sites, profiles]);
};

// -- Model -------------------------------------------------------------------------------------------------
function modelSection(ctx) {
  return h('div', { 'data-panel-card': 'model' }, [caps('Model'), loading(async () => {
    const models = await ctx.ensure('models');
    const picker = ctx.ui.agentModelPicker(models, ctx.state.agent, () => ctx.update(picker.get()));
    const parts = [h('div', { class: 'bots-model' }, [picker.root])];
    const stray = (ctx.state.threads?.threads || []).filter(t => t.follows_bot_model === false && !t.thread?.archived_at);
    if (stray.length) {
      const hint = h('span', { class: 'bots-row-hint', text: `${stray.length} conversation${stray.length === 1 ? ' uses' : 's use'} a different model.` });
      const button = Button({ label: 'Switch them too', iconName: 'refresh-cw', onClick: async () => {
        button.disabled = true;
        try {
          const saved = await ctx.flushResult();
          if (!saved.ok) throw saved.error;
          const result = await ctx.ui.api(`/api/agents/${ctx.agentId}/threads/follow-model`, { method: 'POST', body: JSON.stringify({}), toast: false });
          ctx.ui.toast(`${result.updated.length} switched${result.busy.length ? `, ${result.busy.length} busy and left alone` : ''}`, 'success');
          await ctx.refresh();
        } catch (error) { ctx.ui.toast(messageOf(error), 'error'); button.disabled = false; }
      } });
      parts.push(h('div', { class: 'bots-row bots-follow' }, [hint, button]));
    }
    {
      const warm = Segmented({ label: 'Keep warm', value: ctx.state.agent.cache_keep_warm || 'follow',
        options: [{ value: 'follow', label: 'Follow default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], onChange: v => ctx.update({ cache_keep_warm: v }) });
      parts.push(Card({ label: 'Keep warm', children: [h('div', { class: 'bots-row bots-stack-row' }, [warm,
        h('span', { class: 'bots-row-hint', text: 'Saved. Keeping a conversation ready between turns starts to apply with a later update.' })])] }));
      const list = ctx.state.agent.fallback || [];
      const nameOf = f => `${models.find(m => m.id === f.endpoint_id)?.name || f.endpoint_id}${f.model_override ? `, ${f.model_override}` : ''}`;
      const add = ctx.ui.customSelect({ 'aria-label': 'Add a fallback model' }, [h('option', { value: '', text: 'Add a fallback…' }), ...models.map(m => h('option', { value: m.id, text: m.name || m.id }))]);
      add.addEventListener('change', () => { if (add.value) { ctx.update({ fallback: fallbackAfter(ctx.state.agent.fallback, { add: { endpoint_id: add.value } }) }); ctx.rerender(); } });
      parts.push(Card({ label: 'If this model fails', children: [
        ...(list.length ? list.map((f, i) => h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: nameOf(f) }), h('span', { class: 'bots-row-hint', text: `Fallback ${i + 1}` })]),
          Button({ label: 'Remove', iconName: 'x', onClick: () => { ctx.update({ fallback: fallbackAfter(ctx.state.agent.fallback, { remove: i }) }); ctx.rerender(); } })]))
          : [note('No fallbacks are saved.')]),
        ...(list.length < MAX_FALLBACKS && models.length ? [h('div', { class: 'bots-row' }, [add])] : []),
        note('Saved. Switching models automatically when one fails starts with a later update.')] }));
    }
    return h('div', {}, parts);
  }, 'The model list')]);
}

// -- Permissions -------------------------------------------------------------------------------------------
function permissionsBasics(ctx) {
  const { agent } = ctx.state;
  const facts = permissionFacts(agent);
  const capRow = TextRow({ title: 'Runs per day', hint: 'It stops for the day after this many (1 to 200). This limit is in effect now.', value: String(facts.runCap), onCommit: v => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 200) { ctx.ui.toast('Runs per day is a whole number from 1 to 200.', 'error'); capRow.set(String(ctx.state.agent.daily_run_cap ?? 12)); return; }
    ctx.update({ daily_run_cap: n });
  } });
  const outbound = Segmented({ label: 'Messages outside the app', value: facts.outboundPolicy, options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }],
    onChange: v => ctx.update({ outbound: { policy: v, daily_cap: ctx.state.agent.outbound?.daily_cap ?? 25 } }) });
  const outCap = TextRow({ title: 'Outside messages per day', value: String(facts.outboundCap), onCommit: v => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1000) { ctx.ui.toast('Outside messages per day is a whole number from 1 to 1000.', 'error'); outCap.set(String(ctx.state.agent.outbound?.daily_cap ?? 25)); return; }
    ctx.update({ outbound: { policy: ctx.state.agent.outbound?.policy || 'ask', daily_cap: n } });
  } });
  const allowed = facts.alwaysAllow.length ? facts.alwaysAllow.map((entry, i) => h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: shortValue(entry, 90) })]),
    Button({ label: 'Remove', iconName: 'x', onClick: () => { ctx.update({ always_allow: facts.alwaysAllow.filter((_, at) => at !== i) }); ctx.rerender(); } })])) : [note('Nothing is always allowed.')];
  return h('div', {}, [
    caps('Before it acts'),
    RadioGroup({ label: 'Approval', value: facts.effective, options: APPROVAL_LEVELS.map(l => ({ value: l.value, title: l.title, hint: l.hint, disabled: !l.now })), onChange: v => ctx.update({ approval_mode: v }) }),
    note('Full acts without asking. Tool and account grants still limit what it can reach.'),
    Card({ label: 'Limits', children: [SwitchRow({ title: 'This bot is on', hint: 'Off, it takes no new work and its routines do not run.', checked: agent.enabled !== false, onChange: v => ctx.update({ enabled: v }) }), capRow] }),
    Card({ label: 'Messages outside the app', children: [h('div', { class: 'bots-row bots-stack-row' }, [outbound, h('span', { class: 'bots-row-hint', text: 'Below Full, sending asks or uses this daily allowance.' })]), outCap] }),
    Card({ label: 'Always allowed', children: [...allowed, note('Exact rules apply within the bot\'s grants.')] }),
  ]);
}

const permissionsSection = ctx => h('div', { 'data-panel-card': 'permissions' }, [modular(ctx, 'Permissions', () => permissionsBasics(ctx), { what: 'Permissions' })]);

// -- Voice and alerts --------------------------------------------------------------------------------------
function voiceSection(ctx) {
  const { agent } = ctx.state;
  return h('div', { 'data-panel-card': 'voice' }, [
    Card({ label: 'Alerts', children: [SwitchRow({ title: 'Tell me when it needs me', hint: 'Phone and desktop alerts for this bot. Off, new alerts stay quiet. Its messages still collect in your inbox.', checked: agent.notifications !== false,
      onChange: v => ctx.update({ notifications: v }) })] }),
    caps('Voice'),
    loading(async () => {
      const [catalog, live] = await Promise.all([ctx.ui.api('/api/agent-calls/voices', { toast: false }).catch(() => null), ctx.ui.api('/api/agent-calls/live-choices', { toast: false }).catch(() => [])]);
      const facts = voiceFacts(ctx.state.agent, catalog, live);
      const voice = ctx.ui.customSelect({ 'aria-label': 'Voice' }, [h('option', { value: '', text: facts.hasVoices ? 'Default voice' : 'No voice connected' }), ...facts.voices.map(v => h('option', { value: v.id, text: v.name }))]);
      voice.value = ctx.state.agent.voice_id || ''; voice.disabled = !facts.hasVoices;
      voice.addEventListener('change', () => ctx.update({ voice_id: voice.value || null }));
      const mode = Segmented({ label: 'Call mode', value: facts.callMode, options: [{ value: 'turns', label: 'Turns' }, { value: 'live', label: 'Live' }],
        onChange: v => { if (v === 'live' && !facts.liveAvailable) { ctx.ui.toast('Live calls need an OpenAI connection with an API key.', 'error'); ctx.rerender(); return; } ctx.update({ call_mode: v }); } });
      return h('div', {}, [
        Card({ children: [
          SwitchRow({ title: 'Speak its replies', hint: facts.hasVoices ? 'It reads each reply aloud in its voice.' : 'Saved. It speaks once a voice is connected.', checked: !!ctx.state.agent.speak_replies, onChange: v => ctx.update({ speak_replies: v }) }),
          h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: 'Voice' }), h('span', { class: 'bots-row-hint', text: facts.hasVoices ? 'Used for spoken replies and calls.' : 'Connect a voice server to choose one.' })]), voice]),
          h('div', { class: 'bots-row bots-stack-row' }, [mode, h('span', { class: 'bots-row-hint', text: facts.liveAvailable ? 'Turns waits for you to finish. Live listens as you talk.' : 'Turns is the call mode available on this setup.' })])] }),
      ]);
    }, 'Voice settings'),
  ]);
}

// -- Who can see it ----------------------------------------------------------------------------------------
function whoSection(ctx) {
  return h('div', { 'data-panel-card': 'who' }, [caps('Access'), loading(async () => {
    const status = await ctx.ui.api('/api/auth/status', { toast: false });
    const facts = visibilityFacts(status);
    return Card({ children: [fact('Account', facts.account),
      fact('Who can open it', facts.admin ? 'Only people signed in as an admin on this device.' : 'Only an admin can open and change bots.'),
      fact('Sharing', 'This bot is not shared with other people or other devices. There is no team or cloud access to manage.')] });
  }, 'Access facts')]);
}

// -- History -----------------------------------------------------------------------------------------------
function historySection(ctx) {
  const { agent, detail } = ctx.state;
  const parts = [Card({ children: [fact('Version', `Settings version ${agent.revision || 0}`), fact('Created', agent.created_at ? new Date(agent.created_at * 1000).toLocaleDateString() : 'Unknown')] })];
  const changes = h('div', { class: 'bots-card-body bots-history-rows' }, [note('Loading…')]);
  parts.push(h('div', { class: 'bots-card' }, [caps('Changes'), changes]));
  const draw = rows => {
    changes.replaceChildren(...(rows.length ? rows.slice(0, 50).map(row => historyRow(ctx, row)) : [note('Nothing has changed since history started.')]));
  };
  ctx.ui.api(`/api/agents/${ctx.agentId}/history?limit=100`, { toast: false }).then(data => draw(data.rows)).catch(error => {
    changes.replaceChildren(note(`History could not load. ${messageOf(error)}`), h('div', { class: 'bots-actions' }, [retry('Try again', () => ctx.refresh())]));
  });
  const proposals = (agent.profile_proposals || []).slice().reverse();
  if (proposals.length) parts.push(Card({ label: 'Changes it made to itself', children: proposals.map(r => proposalRow(ctx, r)) }));
  if (agent.instructions_legacy) parts.push(Card({ label: 'Earlier instructions', children: [note('These were replaced by the standing instructions. They are kept here and never sent to the model.'),
    h('div', { class: 'bots-row' }, [h('pre', { class: 'bots-legacy', text: agent.instructions_legacy })])] }));
  const receipts = (detail?.setup_receipts || []).slice().reverse();
  if (receipts.length) parts.push(Card({ label: 'Setup changes', children: receipts.map(r => {
    const what = [...Object.keys(r.after || {}).map(fieldLabel), ...(r.routine_id ? ['a routine'] : [])].join(', ');
    const undo = Button({ label: r.undone ? 'Undone' : 'Undo', iconName: 'undo-2', disabled: !!r.undone, onClick: async () => {
      undo.disabled = true;
      try { await ctx.ui.api(`/api/agents/${ctx.agentId}/setup/${r.id}/undo`, { method: 'POST', toast: false }); ctx.ui.toast('Setup change undone', 'success'); await ctx.refresh(); }
      catch (error) { ctx.ui.toast(messageOf(error), 'error'); undo.disabled = false; }
    } });
    return h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: `Set ${what || 'nothing'}` }), h('span', { class: 'bots-row-hint', text: new Date(r.ts * 1000).toLocaleString() })]), undo]);
  }) }));
  return h('div', { 'data-panel-card': 'history' }, parts);
}

function historyRow(ctx, row) {
  const when = row.ts ? new Date(row.ts * 1000).toLocaleString() : '';
  const box = h('div', { class: 'bots-history-row', 'data-history': row.id });
  const head = h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: describeRow(row) }), h('span', { class: 'bots-row-hint', text: `${when}, version ${row.revision}` })])]);
  const detail = h('div', { class: 'bots-history-detail', hidden: true });
  const show = Button({ label: 'Show changes', iconName: 'eye', onClick: async () => {
    if (!detail.hidden) { detail.hidden = true; show.lastChild.textContent = 'Show changes'; return; }
    detail.hidden = false; show.lastChild.textContent = 'Hide changes';
    if (detail.firstChild) return;
    detail.replaceChildren(note('Loading…'));
    try {
      const full = await ctx.ui.api(`/api/agents/${ctx.agentId}/history/${row.id}`, { toast: false });
      detail.replaceChildren(row.field === 'soul' ? profileDiff(full.before || '', full.after || '') : profileDiff(shortValue(full.before, 400), shortValue(full.after, 400)));
    } catch (error) { detail.replaceChildren(note(messageOf(error))); }
  } });
  const actions = [show];
  if (canRestore(row)) actions.push(Button({ label: 'Restore these instructions', iconName: 'rotate-ccw', onClick: async () => {
    if (!(await ctx.ui.confirmDialog({ title: 'Restore these instructions?', message: 'They replace the current standing instructions. The current ones stay in History.', confirmLabel: 'Restore', danger: false }))) return;
    try {
      const saved = await ctx.flushResult();
      if (!saved.ok) throw saved.error;
      await ctx.refresh();
      const live = (await ctx.ui.api(`/api/agents/${ctx.agentId}`, { toast: false }));
      await ctx.ui.api(`/api/agents/${ctx.agentId}/history/${row.id}/rollback`, { method: 'POST', toast: false,
        body: JSON.stringify({ expected_revision: live.agent.revision || 0, expected_file_text: live.soul_file?.file_text ?? null }) });
      ctx.ui.toast('Instructions restored', 'success'); await ctx.refresh();
    } catch (error) { ctx.ui.toast(messageOf(error), 'error'); await ctx.refresh().catch(() => {}); }
  } }));
  box.append(head, h('div', { class: 'bots-actions bots-history-actions' }, actions), detail);
  return box;
}

function proposalRow(ctx, receipt) {
  const diff = Object.keys(receipt.after || {}).map(key => `${fieldLabel(key)}: ${shortValue(receipt.before?.[key], 40)} to ${shortValue(receipt.after?.[key], 40)}`);
  const undo = Button({ label: receipt.state === 'undone' ? 'Undone' : 'Undo', iconName: 'undo-2', disabled: receipt.state !== 'applied', onClick: async () => {
    undo.disabled = true;
    try { await ctx.flush(); await ctx.ui.api(`/api/agents/${ctx.agentId}/proposals/${receipt.id}/undo`, { method: 'POST', body: JSON.stringify({ expected_revision: receipt.revision }), toast: false }); ctx.ui.toast('Change undone', 'success'); await ctx.refresh(); }
    catch (error) { ctx.ui.toast(/409|no longer/.test(String(error.message)) ? 'It was changed again afterwards, so it cannot be undone safely.' : messageOf(error), 'error'); undo.disabled = false; await ctx.refresh().catch(() => {}); }
  } });
  return h('div', { class: 'bots-row bots-proposal', 'data-receipt': receipt.id }, [h('span', { class: 'bots-row-main' }, [
    h('span', { class: 'bots-row-title', text: receipt.kind === 'model' ? 'Changed its model' : 'Changed its identity' }),
    ...diff.map(text => h('span', { class: 'bots-row-hint', text })), h('span', { class: 'bots-row-hint', text: `Why: ${receipt.reason}` }),
    h('span', { class: 'bots-row-hint', text: new Date(receipt.ts * 1000).toLocaleString() })]), undo]);
}

// -- Usage -------------------------------------------------------------------------------------------------
function usageSection(ctx) {
  const { agent, detail } = ctx.state;
  const facts = usageFacts(agent, detail?.runs || []);
  const meter = h('div', { class: 'bots-meter', role: 'img', 'aria-label': `${facts.used} of ${facts.cap} daily runs used` }, [h('span', { class: 'bots-meter-fill', style: `width:${facts.percent}%` })]);
  return h('div', { 'data-panel-card': 'usage' }, [
    Card({ label: 'Today', children: [h('div', { class: 'bots-row bots-stack-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: `${facts.used} of ${facts.cap} daily runs used` }),
      h('span', { class: 'bots-row-hint', text: facts.used >= facts.cap ? 'It is done for today.' : `${facts.left} left today.` })]), meter])] }),
    Card({ label: `Last ${facts.runs} runs`, children: facts.runs ? [fact('Results', Object.entries(facts.tally).map(([k, n]) => `${OUTCOME[k] || k}: ${n}`)), ...(facts.average ? [fact('Average length', `${facts.average} seconds`)] : [])]
      : [note('There are no runs to count yet.')] }),
    Card({ label: 'Cost', children: [note('Cost is not tracked yet, so none is shown. Run counts above are exact.')] }),
  ]);
}

const RENDER = { overview: overviewSection, identity: identitySection, delivery: deliverySection, soul: soulSection, skills: skillsSection, memory: memorySection,
  routines: routinesSection, access: accessSection, model: modelSection, permissions: permissionsSection, voice: voiceSection, who: whoSection, history: historySection, usage: usageSection };

// The registered form: botsPanel.js passes each to registerBotSection.
export const sections = () => SECTION_DEFS.map(def => ({ ...def, render: RENDER[def.id] }));
export { NavRow, actorLabel };
