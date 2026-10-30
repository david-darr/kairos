// The Bots redesign's data and API contract, in memory, for the Electron checks (Phase 0 unit U1, 2026-10-28).
// Spec: Kairos Projects/Agents Redesign/phase-0-design.md, section 2.4. ui-smoke.cjs consults every
// scripts/fixtures/bots-*-backend.cjs before demo/fixtures.js while demoState.botsLive is set (the g4Backend pattern):
// read(path, query) and mutate(path, method, body, query) answer a route or return undefined to let the demo have it.
// State lives in state.botsCore so a check can seed it and so ui-smoke's fixture-change detection sees it.
// The statuses and keys follow routes/agent_routes.py and services/bot_record.py; scripts/test_bots_fixtures.cjs
// holds this file to them. Not part of the site demo: demo/fixtures.js is not edited.
const MAX_BOTS = 100, MAX_PRESETS = 200, MAX_FOLDERS = 100, MAX_ROUTINES = 10, MAX_SEED = 8000;
const APPROVAL = ['ask', 'edits', 'auto', 'full', 'custom'], ENFORCED = APPROVAL;
const THREAD_APPROVAL = ['ask', 'edits', 'auto', 'full', 'custom'];
const PLACES = ['auto', 'computer', 'browser', 'off'], KEEP_WARM = ['follow', 'on', 'off'];
const SECTIONS = ['About this work', 'Preferences', 'Corrections', 'Notes'];
const COLORS = ['#d9b260', '#b9d2e3', '#e8c39e', '#d99a92', '#b5c7a5', '#cdbfd9'];
const NAMES = ['Juniper', 'Maple', 'Pebble', 'Tansy', 'Wren', 'Sorrel', 'Fennel', 'Cricket'];
const BOT_EDITABLE = ['section', 'origin', 'fallback', 'cache_keep_warm', 'place', 'tool_scope', 'connector_scopes',
  'always_allow', 'outbound', 'approval_mode', 'thread_limit', 'hidden', 'reply_style', 'notifications', 'speak_replies', 'voice_id',
  'call_mode', 'skill_selection', 'avatar_image', 'mascot_expression', 'memory_enabled', 'helper_model', 'connector_tools', 'grants_version'];
const EXPRESSIONS = ['sleeping', 'idle', 'listening', 'thinking', 'speaking', 'success', 'needs', 'error', 'carry'];
// Routes other units or lanes own under /api/agents: the generic bot-id matcher must never answer them.
const RESERVED = ['inbox', 'section-modules', 'avatar-provider', 'avatar-drafts'];
const NO_REVISION = ['hidden', 'hidden_at', 'order', 'folders'];
const THREAD_DEFAULTS = () => ({ main: false, folder_id: null, pinned: false, archived_at: null, snoozed_until: null,
  approval_mode: null, place: null, unread: false, last_read_index: null, pinned_message_index: null,
  opened_by: 'person', routine_run_id: null, title_source: 'machine' });
const DEFAULTS = () => ({ section: null, origin: { kind: 'blank' }, hidden: false, hidden_at: null, order: null,
  folders: [], thread_limit: 3, approval_mode: 'full', outbound: { policy: 'ask', daily_cap: 25 }, fallback: [],
  cache_keep_warm: 'follow', place: 'auto', tool_scope: { allow: [], deny: [] }, connector_scopes: {},
  always_allow: [], builtin: null, reply_style: 'default', notifications: true, speak_replies: false, voice_id: null, call_mode: 'turns',
  skill_selection: { mode: 'all', disabled: [] }, avatar_image: null, mascot_expression: null,
  memory_enabled: true, helper_model: true, connector_tools: null, grants_version: 0 });

class Refusal extends Error { constructor(status, detail, extra = {}) { super(detail); this.status = status; this.extra = extra; } }
const bad = (detail) => new Refusal(400, detail);
const whole = (v, lo, hi, label) => { if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${label} must be a whole number from ${lo} to ${hi}`); return v; };
const choice = (v, options, label) => { if (typeof v !== 'string' || !options.includes(v)) throw bad(`${label} must be one of: ${options.join(', ')}`); return v; };
const selector = /^(native:\S+|mcp:[^:\s]+:\S+)$/;
const selectors = (v, label) => {
  if (!Array.isArray(v) || v.length > 256 || v.some(s => typeof s !== 'string' || s.length < 1 || s.length > 1024 || !selector.test(s)))
    throw bad(`${label} selectors look like native:<name|*> or mcp:<server>:<name|*>, 1024 characters at most`);
  return [...new Set(v)];
};
const approval = (v, label = 'approval_mode', allowed = APPROVAL) => {
  const mode = choice(v, allowed, label);
  return mode;
};

let seeded0 = () => ({});
function clean(key, value, current) {
  if (['memory_enabled', 'helper_model'].includes(key)) { if (typeof value !== 'boolean') throw bad(`${key} is true or false`); return value; }
  if (key === 'grants_version') { const next = whole(value, 0, 1000, key); if (next < (current?.grants_version || 0)) throw bad('grants_version can only go up'); return next; }
  if (key === 'connector_tools') {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('connector_tools is an app selection');
    for (const grant of Object.values(value)) {
      if (!grant || typeof grant !== 'object' || Object.keys(grant).some(k => !['tools', 'accounts'].includes(k)) || (grant.tools !== '*' && !Array.isArray(grant.tools)) || (grant.accounts !== undefined && !Array.isArray(grant.accounts))) throw bad('Each app grant needs tools and optional accounts');
    }
    return JSON.parse(JSON.stringify(value));
  }
  if (key === 'section') {
    if (value === null) return null;
    if (typeof value !== 'string') throw bad('section must be text');
    const text = value.split(/\s+/).filter(Boolean).join(' ');
    if (text.length > 60) throw bad('section is limited to 60 characters');
    return text || null;
  }
  if (key === 'notifications' || key === 'speak_replies') { if (typeof value !== 'boolean') throw bad(`${key} is true or false`); return value; }
  if (key === 'reply_style') return choice(value, ['default', 'conversational'], key);
  if (key === 'call_mode') return choice(value, ['turns', 'live'], key);
  if (key === 'voice_id') { if (value === null) return null; if (typeof value !== 'string' || !/^[\w.:-]{1,200}$/.test(value)) throw bad('voice_id is a saved voice identifier'); return value; }
  if (key === 'mascot_expression') return value === null ? null : choice(value, EXPRESSIONS, key);
  if (key === 'skill_selection') {
    if (!value || typeof value !== 'object' || value.mode !== 'all' || Object.keys(value).some(k => !['mode', 'disabled'].includes(k))) throw bad('skill_selection is {mode: all, disabled: []}');
    const disabled = value.disabled || [];
    if (!Array.isArray(disabled) || disabled.length > 256 || disabled.some(v => typeof v !== 'string' || !/^[\w.-]{1,160}$/.test(v))) throw bad('disabled contains up to 256 skill identifiers');
    return { mode: 'all', disabled: [...new Set(disabled)] };
  }
  if (key === 'avatar_image') {
    if (value === null) return null;
    const keys = ['asset_id', 'shape', 'zoom', 'focus_x', 'focus_y'];
    if (typeof value !== 'object' || keys.some(k => !(k in value)) || Object.keys(value).some(k => !keys.includes(k))) throw bad('avatar_image needs asset_id, shape, zoom, focus_x and focus_y');
    if (!/^[0-9a-f]{32}$/.test(String(value.asset_id))) throw bad('invalid avatar asset');
    choice(value.shape, ['circle', 'rounded', 'square', 'kip'], 'avatar shape');
    for (const [k, lo, hi] of [['zoom', 1, 3], ['focus_x', 0, 1], ['focus_y', 0, 1]]) if (typeof value[k] !== 'number' || value[k] < lo || value[k] > hi) throw bad(`avatar ${k} must be from ${lo} to ${hi}`);
    const owned = (current && (seeded0().assets || {})[current.id]) || [];
    if (current && !owned.includes(value.asset_id)) throw bad('That picture does not belong to this bot.');
    return { ...value };
  }
  if (value === null || value === undefined) throw bad(`${key} cannot be empty`);
  if (key === 'origin') {
    if (typeof value !== 'object' || Object.keys(value).some(k => !['kind', 'id', 'from_agent_id'].includes(k))) throw bad('origin is {kind, id?, from_agent_id?}');
    choice(value.kind, ['blank', 'preset', 'ready', 'duplicate'], 'origin kind'); return { ...value };
  }
  if (key === 'hidden') { if (typeof value !== 'boolean') throw bad('hidden is true or false'); return value; }
  if (key === 'thread_limit') return whole(value, 1, 16, 'thread_limit');
  if (key === 'approval_mode') return approval(value);
  if (key === 'outbound') {
    if (typeof value !== 'object' || Object.keys(value).some(k => !['policy', 'daily_cap'].includes(k))) throw bad('outbound is {policy, daily_cap}');
    const merged = { ...(current?.outbound || DEFAULTS().outbound), ...value };
    return { policy: choice(merged.policy, ['ask', 'allow'], 'outbound policy'), daily_cap: whole(merged.daily_cap, 1, 1000, 'outbound daily_cap') };
  }
  if (key === 'fallback') {
    if (!Array.isArray(value) || value.length > 5 || value.some(f => !f || !f.endpoint_id)) throw bad('fallback is a list of up to 5 models');
    return value.map(f => ({ endpoint_id: f.endpoint_id, ...(f.model_override ? { model_override: f.model_override } : {}) }));
  }
  if (key === 'cache_keep_warm') return choice(value, KEEP_WARM, 'cache_keep_warm');
  if (key === 'place') return choice(value, PLACES, 'place');
  if (key === 'tool_scope') {
    if (typeof value !== 'object' || Object.keys(value).some(k => !['allow', 'deny'].includes(k))) throw bad('tool_scope is {allow, deny}');
    return { allow: selectors(value.allow || [], 'tool_scope allow'), deny: selectors(value.deny || [], 'tool_scope deny') };
  }
  if (key === 'connector_scopes') {
    const entries = Object.entries(value);
    if (entries.length > 100 || entries.some(([k, v]) => k.length < 1 || k.length > 80 || !['off', 'read', 'write'].includes(v))) throw bad('connector_scopes maps up to 100 apps to off, read or write');
    return { ...value };
  }
  if (key === 'always_allow') {
    if (!Array.isArray(value) || value.length > 200 || value.some(s => typeof s !== 'string' || s.length < 1 || s.length > 1024)) throw bad('always_allow is a list of up to 200 entries of up to 1024 characters');
    return [...new Set(value)];
  }
  throw bad(`${key} cannot be changed`);
}

function routine(r) {
  if (!r || typeof r !== 'object') throw bad('a routine is an object');
  const name = String(r.name || '').trim(), prompt = String(r.prompt || '').trim();
  if (!name || name.length > 200) throw bad('a routine needs a name of 1 to 200 characters');
  if (!prompt || prompt.length > 8000) throw bad('a routine needs instructions of 1 to 8000 characters');
  if (!['daily', 'interval'].includes(r.schedule_kind)) throw bad('a routine runs daily or every so many hours');
  if (r.schedule_kind === 'daily' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(r.run_time || ''))) throw bad('a daily routine needs run_time as HH:MM and no interval');
  if (r.schedule_kind === 'interval' && !(Number.isInteger(r.interval_seconds) && r.interval_seconds >= 60)) throw bad('an interval routine needs interval_seconds of at least 60 and no run_time');
  return { ...r, name, prompt };
}
function seedNotes(list) {
  if (!Array.isArray(list)) throw bad('memory_seed is a list of {section, text}');
  let total = 0;
  const seed = list.map(n => {
    const section = SECTIONS.find(s => s.toLowerCase() === String(n?.section || '').trim().toLowerCase());
    const text = String(n?.text || '').split(/\s+/).filter(Boolean).join(' ');
    if (!section || !text) throw bad(`each memory note needs a section (${SECTIONS.join(', ')}) and text`);
    total += text.length; return { section, text };
  });
  if (total > MAX_SEED) throw bad(`the starting notes are limited to ${MAX_SEED} characters; this is ${total}`);
  return seed;
}

module.exports = ({ state, data, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  seeded0 = () => state.botsCore || {};
  const seeded = () => {
    if (state.botsCore) return state.botsCore;
    const store = state.botsCore = { counter: 100, maxBots: MAX_BOTS, agents: [], threads: [], defaults: {}, presets: [], created: [] };
    for (const [index, a] of (data.agentsFixture || []).entries()) {
      const record = { ...DEFAULTS(), ...JSON.parse(JSON.stringify(a)), created_at: a.created_at ?? clock() - 86400 * (10 - index) };
      record.soul = record.soul || record.instructions || ''; delete record.instructions;
      record.avatar ||= { version: 3, character: 'ajar', shape: 'round', color: (a.color || COLORS[index % COLORS.length]).toUpperCase(), acc: 'none', finish: 'flat' };
      store.agents.push(record);
      // Earlier demo checks can create IDs past the fixture's initial counter.
      const suffix = /^a(\d+)$/.exec(a.id);
      if (suffix) store.counter = Math.max(store.counter, Number(suffix[1]));
    }
    // These conversations belong to the named fixture bots, regardless of the
    // incoming roster's order or how many other agents earlier checks created.
    const scout = store.agents.find(a => a.id === 'a1'), archivist = store.agents.find(a => a.id === 'a2');
    const thread = (id, agent_id, title, age, extra = {}, messages = 2) => store.threads.push({ id, agent_id, title, created_at: clock() - age, updated_at: clock() - age / 2,
      message_count: messages, model_endpoint_id: 'm1', model_override: null, model_effort: null, preview: messages ? 'The reference notes are ready.' : '', thread: { ...THREAD_DEFAULTS(), ...extra } });
    if (scout) { thread('bots-t1', scout.id, `Chat with ${scout.name}`, 5000, { main: true }); thread('bots-t2', scout.id, 'Weekly postings', 3000); }
    if (archivist) thread('bots-t3', archivist.id, `Chat with ${archivist.name}`, 4000, { main: true });
    return store;
  };
  const find = (id) => seeded().agents.find(a => a.id === id);
  const need = (id) => { const a = find(id); if (!a) throw new Refusal(404, 'agent not found'); return a; };
  const visible = () => seeded().agents.filter(a => !a.hidden);
  const sorted = () => [...seeded().agents].sort((x, y) => (x.order === null) - (y.order === null) || (x.order ?? 0) - (y.order ?? 0) || x.created_at - y.created_at);
  const summary = (a) => ({ ...a, instructions: a.soul || '', blurb: a.blurb || '', revision: a.revision || 0,
    status: a.enabled === false ? 'off' : a.status || 'idle', status_detail: a.status_detail || '', needs_you: a.needs_you || 0, runs_today: a.runs_today || 0 });
  const taken = () => seeded().agents.map(a => a.name.toLowerCase());
  const suggestName = () => NAMES.find(n => !taken().includes(n.toLowerCase())) || `${NAMES[0]} 2`;
  const threadsOf = (id) => seeded().threads.filter(t => t.agent_id === id);
  const mainOf = (id) => threadsOf(id).find(t => t.thread.main)?.id || null;
  const ensureMain = (id) => {
    const list = threadsOf(id).sort((x, y) => x.created_at - y.created_at);
    if (!list.some(t => t.thread.main)) { const first = list.find(t => !t.thread.archived_at); if (first) first.thread.main = true; }
    return mainOf(id);
  };
  const follows = (t, a) => t.model_endpoint_id === (a.endpoint_id || 'm1') && (t.model_override === null || t.model_override === (a.model_override ?? null))
    && (t.model_effort === null || t.model_effort === (a.model_effort ?? null));
  const row = (t, a) => ({ id: t.id, title: t.title, created_at: t.created_at, updated_at: t.updated_at, message_count: t.message_count,
    model_endpoint_id: t.model_endpoint_id, model_override: t.model_override, model_effort: t.model_effort, follows_bot_model: follows(t, a),
    thread: { ...THREAD_DEFAULTS(), ...t.thread }, status: (state.botsWorking || []).includes(t.id) ? 'working' : 'idle', preview: t.preview });
  const header = (t) => ({ id: t.id, title: t.title, starred: false, created_at: t.created_at, updated_at: t.updated_at, message_count: t.message_count,
    model_endpoint_id: t.model_endpoint_id, project_id: null, open_mic: false, agent_id: t.agent_id, is_forge: false, launch_dir: null, thread: { ...t.thread } });
  const ownThread = (agent, sid) => { const t = seeded().threads.find(x => x.id === sid && x.agent_id === agent.id); if (!t) throw new Refusal(404, 'thread not found'); return t; };

  function newBot(body, extra = {}) {
    const store = seeded();
    if (store.agents.length >= store.maxBots) throw new Refusal(409, `you can have up to ${store.maxBots} bots; delete or archive one first`);
    const name = String(body.name || '').split(/\s+/).filter(Boolean).join(' ');
    if (!name || name.length > 100) throw bad("an agent's name is 1 to 100 characters");
    if (taken().includes(name.toLowerCase())) throw bad(`an agent called ${name} already exists`);
    const fields = {};
    for (const key of Object.keys(body)) if (BOT_EDITABLE.includes(key) && body[key] !== undefined) { if (key === 'hidden' && body.hidden) throw bad('a new bot cannot start archived'); if (key !== 'hidden') fields[key] = clean(key, body[key], null); }
    const soul = body.soul ?? (String(body.instructions || '').trim() || undefined);
    const record = { ...DEFAULTS(), id: `a${++store.counter}`, name, role: body.role || '', blurb: body.blurb || '', revision: 1,
      endpoint_id: body.endpoint_id || null, color: COLORS.includes(body.color) ? body.color : COLORS[store.agents.length % COLORS.length],
      enabled: true, daily_run_cap: body.daily_run_cap || 12, deliver_to_channel: body.deliver_to_channel || null,
      integration_ids: body.integration_ids ?? null, keep_signed_in: !!body.keep_signed_in, memory_upkeep: !!body.memory_upkeep, peers: body.peers || [],
      created_at: clock(), status: 'idle', status_detail: '', needs_you: 0, runs_today: 0, ...fields, ...extra };
    if (soul !== undefined) record.soul = soul;
    record.avatar = body.avatar || { version: 3, character: 'ajar', shape: 'round', color: record.color.toUpperCase(), acc: 'none', finish: 'flat' };
    store.agents.push(record); store.created.push(record.id);
    return record;
  }

  function patch(agent, body, actor = 'user') {
    const changes = {};
    const fields = { ...body };
    if ('expected_revision' in fields) {
      const expected = fields.expected_revision; delete fields.expected_revision;
      if (expected !== null && expected !== undefined && (agent.revision || 0) !== expected) throw new Refusal(409, 'The profile changed. Reload it before saving.');
    }
    const before = JSON.parse(JSON.stringify(agent));
    if ('instructions' in fields) { if (!('soul' in fields)) fields.soul = fields.instructions ?? ''; delete fields.instructions; }
    for (const [key, value] of Object.entries(fields)) {
      if (BOT_EDITABLE.includes(key)) {
        changes[key] = clean(key, value, agent);
        if (key === 'hidden' && changes.hidden && !agent.hidden && !seeded().agents.some(a => a.id !== agent.id && !a.hidden))
          throw new Refusal(409, 'keep at least one bot visible: archive another first, or create one');
      } else if (key === 'name') {
        const name = String(value || '').split(/\s+/).filter(Boolean).join(' ');
        if (!name || name.length > 100) throw bad("an agent's name is 1 to 100 characters");
        if (seeded().agents.some(a => a.id !== agent.id && a.name.toLowerCase() === name.toLowerCase())) throw bad(`an agent called ${name} already exists`);
        changes.name = name;
      } else if (['role', 'blurb', 'soul', 'endpoint_id', 'model_override', 'model_effort', 'color', 'enabled', 'daily_run_cap', 'deliver_to_channel',
        'integration_ids', 'keep_signed_in', 'memory_upkeep', 'peers', 'avatar'].includes(key)) changes[key] = value;
      else throw bad(`${key} cannot be changed`);
    }
    if ('hidden' in changes) { if (changes.hidden === !!agent.hidden) delete changes.hidden; else changes.hidden_at = changes.hidden ? clock() : null; }
    const differs = Object.entries(changes).some(([k, v]) => JSON.stringify(agent[k]) !== JSON.stringify(v));
    if (differs) {
      const drifted = (seeded().soulFiles || {})[agent.id];
      if ('soul' in changes && drifted !== undefined && drifted !== (agent.soul ?? null)) throw bad('SOUL.md differs from the stored soul; read and apply the external edit first');
      Object.assign(agent, changes);
      if (Object.keys(changes).some(k => !NO_REVISION.includes(k))) agent.revision = (agent.revision || 0) + 1;
      const rows = (seeded().history ||= {})[agent.id] ||= [];
      for (const [key, value] of Object.entries(changes)) {
        if (['revision', 'hidden_at'].includes(key) || JSON.stringify(before[key]) === JSON.stringify(value)) continue;
        rows.push({ id: `h${seeded().counter++}`, ts: clock(), actor, field: key, summary: `Changed ${key.replace(/_/g, ' ')}`, before: before[key] ?? null, after: value, revision: agent.revision || 0, receipt_id: null });
      }
    }
    return agent;
  }

  function configured(body) {
    const store = seeded();
    if (!body.profile || typeof body.profile !== 'object') throw bad('profile is required');
    if (store.agents.length >= store.maxBots) throw new Refusal(409, `you can have up to ${store.maxBots} bots; delete or archive one first`);
    const mode = approval(body.approval_mode ?? 'full');
    const base = body.use_defaults ? store.defaults : {};
    const profile = { ...body.profile };
    const draftImage = profile.avatar_image; delete profile.avatar_image;
    for (const key of ['role', 'blurb', 'soul', 'color', 'section']) if (!profile[key] && base[key]) profile[key] = base[key];
    const seed = seedNotes(body.memory_seed ?? base.memory_seed ?? []);
    const routines = (body.routines ?? base.routines ?? []).map(routine);
    if (routines.length > MAX_ROUTINES) throw bad(`at most ${MAX_ROUTINES} routines`);
    const fail = state.botsConfiguredFail;
    if (fail) throw new Refusal(fail.status || 500, fail.detail || 'The routine could not be made', { cleanup_errors: fail.cleanup_errors || [] });
    const record = newBot({ ...profile, ...(body.model || {}), integration_ids: body.integration_ids, keep_signed_in: body.keep_signed_in,
      memory_upkeep: body.memory_upkeep ?? base.memory_upkeep, origin: body.origin, approval_mode: mode, section: profile.section ?? undefined,
      daily_run_cap: base.daily_run_cap, thread_limit: base.thread_limit, place: base.place, cache_keep_warm: base.cache_keep_warm });
    const made = routines.map((r, i) => ({ id: `r${record.id}-${i + 1}`, agent_id: record.id, enabled: true, schedule_kind: r.schedule_kind, ...r }));
    store.memories = { ...(store.memories || {}), [record.id]: seed };
    const warnings = [...(state.botsConfiguredWarnings || [])];
    if (draftImage) {
      const drafts = store.drafts || [];
      if (drafts.includes(draftImage.asset_id)) { store.drafts = drafts.filter(id => id !== draftImage.asset_id); (store.assets ||= {})[record.id] = [draftImage.asset_id]; record.avatar_image = { ...draftImage }; }
      else warnings.push('The picture was not added: That draft picture is no longer available.');
    }
    if (warnings.length && made.length) made[made.length - 1].enabled = false;
    (store.routines ||= {})[record.id] = made;
    return { agent: summary(record), routines: made, warnings };
  }

  function overview(a) {
    const routines = (seeded().routines || {})[a.id] || [];
    return { who: { name: a.name, role: a.role || '', blurb: a.blurb || '', section: a.section, color: a.color, avatar: a.avatar },
      does: { routines: routines.map(r => ({ id: r.id, name: r.name, schedule_kind: r.schedule_kind, run_time: r.run_time || null, interval_seconds: r.interval_seconds || null, enabled: r.enabled })), triggers: [], open_cards: 0, peers: [] },
      reaches: { endpoint_id: a.endpoint_id, model_override: a.model_override || null, model_effort: a.model_effort || null,
        integrations: a.integration_ids === null ? 'all' : a.integration_ids, place: a.place, keep_signed_in: !!a.keep_signed_in, deliver_to_channel: a.deliver_to_channel },
      wont: [...(a.enabled === false ? ['It is turned off, so it will not run until you turn it on.'] : []), `It stops after ${a.daily_run_cap} runs a day.`,
        ...a.tool_scope.deny.map(s => `Blocked by tool selection: ${s}.`)],
      recent: [], grants: { approval_mode: a.approval_mode, outbound: a.outbound, always_allow: a.always_allow, tool_scope: a.tool_scope, connector_scopes: a.connector_scopes },
      setup: [{ id: 'identity', done: !!(a.role || '').trim(), label: 'Give it a name and a job', section: 'identity' },
        { id: 'soul', done: !!(a.soul || '').trim(), label: 'Write its standing instructions', section: 'soul' },
        { id: 'model', done: !!a.endpoint_id, label: 'Choose its model', section: 'model' },
        { id: 'schedule', done: routines.length > 0, label: 'Give it a schedule or a trigger', section: 'routines' }] };
  }

  function systemPrompt(a) {
    const parts = [['identity', 'Who it is', `[You are ${a.name}, one of the person's Kairos agents. The person is talking with you directly in this chat.`, ''],
      ...(a.role ? [['role', 'Its job', `Your role: ${a.role}`, '\n']] : []), ...(a.soul ? [['soul', 'Standing instructions', `How to work: ${a.soul}`, '\n']] : []),
      ['rules', 'Tool rules', 'Use agent_remember to keep anything you will need on later runs; use agent_ask when you need a decision from the person.]', '\n']];
    const sections = parts.map(([id, label, text, sep]) => ({ id, label, text, bytes: Buffer.byteLength(sep + text) }));
    const total = sections.reduce((n, s) => n + s.bytes, 0);
    return { sections, total_bytes: total, approx_tokens: Math.ceil(total / 4),
      note: "This is what Kairos adds about this bot at the start of a chat. The model's provider adds its own system prompt as well, which is not shown here." };
  }

  const soulFile = (a) => {
    const drifted = (seeded().soulFiles || {})[a.id];
    const file = drifted === undefined ? (a.soul ?? null) : drifted;
    return { soul: a.soul ?? null, file_text: file, in_sync: file === (a.soul ?? null), revision: a.revision || 0, bytes: Buffer.byteLength(a.soul || ''), limit: 24000 };
  };
  const avatarSnapshot = (a) => JSON.stringify([a.avatar, a.avatar_image, a.mascot_expression]).length.toString(16) + ':' + [a.avatar?.shape, a.avatar?.color, a.avatar?.acc, a.avatar_image?.asset_id, a.avatar_image?.shape, a.mascot_expression].join('/');
  const preset = (p) => {
    if (!p || typeof p !== 'object') throw bad('a preset is an object');
    const extra = Object.keys(p).filter(k => !['name', 'role', 'blurb', 'soul', 'avatar', 'routines', 'memory_seed'].includes(k));
    if (extra.length) throw bad(`a preset cannot carry ${extra.join(', ')}: identity, notes and routines only`);
    const name = String(p.name || '').split(/\s+/).filter(Boolean).join(' ');
    if (!name || name.length > 100) throw bad("a preset's name is 1 to 100 characters");
    return { name, role: p.role || '', blurb: p.blurb || '', soul: p.soul || '', avatar: p.avatar ?? null, routines: (p.routines || []).map(routine), memory_seed: seedNotes(p.memory_seed || []) };
  };
  const defaultsView = () => ({ defaults: seeded().defaults, model_selection: { endpoint_id: 'm1', model_override: null, model_effort: null,
    source: 'the first Claude connection until a bot picks its own' }, suggested_name: suggestName() });
  const DEFAULT_FIELDS = ['role', 'blurb', 'soul', 'color', 'section', 'daily_run_cap', 'memory_upkeep', 'keep_signed_in', 'cache_keep_warm', 'place', 'thread_limit', 'memory_seed', 'routines',
    'reply_style', 'notifications', 'speak_replies', 'voice_id', 'call_mode', 'skill_selection', 'mascot_expression'];

  return {
    read(route, query = {}) {
      if (!state.botsLive) return undefined;
      try { return readRoute(route, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },

    store: () => seeded(),
    mutate(route, method, body = {}, query = {}) {
      if (!state.botsLive) return undefined;
      try { return handle(route, method, body || {}); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message, ...error.extra }; throw error; }
    },
  };

  function readRoute(route, query) {
      let m;
      if (route === '/api/agents') return sorted().map(summary);
      if (route === '/api/agents/defaults') return defaultsView();
      if (route === '/api/agents/presets') return seeded().presets.map(p => ({ ...p, source: 'saved' }));
      if (route === '/api/agents/conversations')
        return { agents: seeded().agents.map(a => ({ id: a.id, session_id: mainOf(a.id), preview: threadsOf(a.id)[0]?.preview || '', at: clock() - 600, message_count: threadsOf(a.id).length, pinned: (seeded().pins || []).includes(a.id), unread: 0 })), preferences: {} };
      if (route === '/api/sessions' && query.agent_id) return threadsOf(query.agent_id).map(header);
      if ((m = route.match(/^\/api\/agents\/([^/]+)$/)) && !RESERVED.includes(m[1])) {
        const a = need(m[1]);
        return { agent: summary(a), soul_file: soulFile(a), memory: (seeded().memoryText || {})[a.id] ?? '', memory_upkeep_journal: (seeded().journal || {})[a.id] || [],
          setup_receipts: [], goals: (seeded().goals || {})[a.id] || [], cards: [], inbox: [], answered: [], runs: (seeded().runs || {})[a.id] || [], teams: [], triggers: [],
          avatar_snapshot: avatarSnapshot(a) };
      }
      if ((m = route.match(/^\/api\/agents\/([^/]+)\/(overview|system-prompt|threads)$/))) {
        const a = need(m[1]);
        if (m[2] === 'overview') return overview(a);
        if (m[2] === 'system-prompt') return systemPrompt(a);
        const main_id = ensureMain(a.id), all = query.include_archived === '1' || query.include_archived === 1;
        return { main_id, threads: threadsOf(a.id).filter(t => all || !t.thread.archived_at).map(t => row(t, a)) };
      }
      return undefined;
  }

  function handle(route, method, body) {
    const store = seeded();
    let m;
    if (route === '/api/agents' && method === 'POST') return summary(newBot(body));
    // Pinning a bot (routes/agent_routes.py conversation actions); only pin and unpin are modelled here.
    if ((m = route.match(/^\/api\/agents\/conversations\/agent\/([^/]+)$/)) && method === 'POST' && ['pin', 'unpin'].includes(body.action)) {
      need(decodeURIComponent(m[1])); const pins = new Set(seeded().pins || []);
      body.action === 'pin' ? pins.add(decodeURIComponent(m[1])) : pins.delete(decodeURIComponent(m[1])); seeded().pins = [...pins]; return { ok: true };
    }
    if (route === '/api/agents/configured' && method === 'POST') return configured(body);
    if (route === '/api/agents/order' && method === 'POST') {
      const ids = body.ids || [];
      if (new Set(ids).size !== ids.length) throw bad('each bot can be listed once');
      for (const id of ids) if (need(id).hidden) throw bad('an archived bot cannot be reordered');
      const rest = sorted().filter(a => !a.hidden && !ids.includes(a.id));
      [...ids.map(find), ...rest].forEach((a, i) => { a.order = i; });
      return { ok: true };
    }
    if (route === '/api/agents/defaults' && method === 'PUT') {
      const d = body.defaults;
      if (!d || typeof d !== 'object') throw bad('defaults is an object');
      const extra = Object.keys(d).filter(k => !DEFAULT_FIELDS.includes(k));
      if (extra.length) throw bad(`defaults cannot carry ${extra.join(', ')}: preferences only`);
      if ('routines' in d) { if (d.routines.length > MAX_ROUTINES) throw bad(`at most ${MAX_ROUTINES} routines`); d.routines.forEach(routine); }
      if ('memory_seed' in d) seedNotes(d.memory_seed);
      if (JSON.stringify(d).length > 200 * 1024) throw bad('new-bot defaults are limited to 200 KB');
      store.defaults = d; return defaultsView();
    }
    if (route === '/api/agents/presets' && method === 'POST') {
      if (!!body.from_agent_id === !!body.preset) throw bad('send either from_agent_id or preset');
      const source = body.from_agent_id ? need(body.from_agent_id) : null;
      if (store.presets.length >= MAX_PRESETS) throw new Refusal(409, `you can save up to ${MAX_PRESETS} presets; delete one first`);
      const made = { id: `pre${store.presets.length + 1}${Math.round(clock()) % 1000}`, ...preset(source ? { name: source.name, role: source.role, blurb: source.blurb, soul: source.soul, avatar: source.avatar, routines: [], memory_seed: [] } : body.preset), created_at: clock() };
      store.presets.push(made); return { ...made, source: 'saved' };
    }
    if ((m = route.match(/^\/api\/agents\/presets\/([^/]+)$/)) && method === 'DELETE') {
      const at = store.presets.findIndex(p => p.id === m[1]);
      if (at < 0) throw new Refusal(404, 'preset not found');
      store.presets.splice(at, 1); return { ok: true };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)$/)) && !RESERVED.includes(m[1])) {
      if (method === 'PATCH') return summary(patch(need(m[1]), body));
      if (method === 'DELETE') {
        const a = need(m[1]);
        if (a.builtin) throw new Refusal(409, 'this built-in bot cannot be deleted; archive it instead');
        store.agents.splice(store.agents.indexOf(a), 1);
        store.threads = store.threads.filter(t => t.agent_id !== a.id);
        return { ok: true, removed_work: 0 };
      }
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/duplicate$/)) && method === 'POST') {
      const a = need(m[1]);
      let name = body.name;
      if (!name) { name = `${a.name} copy`; for (let n = 2; taken().includes(name.toLowerCase()); n++) name = `${a.name} copy ${n}`; }
      const copy = {}; for (const k of ['role', 'blurb', 'soul', 'color', 'avatar', 'endpoint_id', 'model_override', 'model_effort', 'integration_ids', 'daily_run_cap', 'section', 'approval_mode',
        'outbound', 'fallback', 'cache_keep_warm', 'place', 'tool_scope', 'connector_scopes', 'always_allow', 'thread_limit', 'memory_upkeep',
        'reply_style', 'notifications', 'speak_replies', 'voice_id', 'call_mode', 'skill_selection', 'mascot_expression']) if (a[k] !== undefined && a[k] !== null) copy[k] = JSON.parse(JSON.stringify(a[k]));
      return summary(newBot({ name }, { ...copy, origin: { kind: 'duplicate', from_agent_id: a.id } }));
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/threads$/)) && method === 'POST') {
      const a = need(m[1]);
      if (body.folder_id && !a.folders.some(f => f.id === body.folder_id)) throw bad('that folder does not exist');
      if (body.approval_mode != null) approval(body.approval_mode, 'thread approval_mode', THREAD_APPROVAL);
      const id = `bots-t${store.counter++}`, at = clock();
      const t = { id, agent_id: a.id, title: body.title || 'New Chat', created_at: at, updated_at: at, message_count: 0, model_endpoint_id: a.endpoint_id || 'm1', model_override: null, model_effort: null, preview: '',
        thread: { ...THREAD_DEFAULTS(), main: !mainOf(a.id), folder_id: body.folder_id || null, approval_mode: body.approval_mode || null, title_source: body.title ? 'person' : 'machine' } };
      store.threads.push(t);
      return { id, title: t.title, agent_id: a.id, agent_prompt: `[You are ${a.name}, one of the person's Kairos agents.`, model_endpoint_id: t.model_endpoint_id, messages: [], created_at: at, updated_at: at, thread: { ...t.thread } };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/threads\/delete$/)) && method === 'POST') {
      const a = need(m[1]), ids = [...new Set(body.thread_ids || [])];
      if (!ids.length || ids.length > 200) throw new Refusal(422, 'thread_ids must hold 1 to 200 ids');
      const have = threadsOf(a.id).map(t => t.id), busyNow = state.botsWorking || [];
      const missing = ids.filter(i => !have.includes(i)), present = ids.filter(i => have.includes(i));
      const busy = present.filter(i => busyNow.includes(i)); let doomed = present.filter(i => !busy.includes(i)); const kept = [];
      if (doomed.length && !have.filter(i => !doomed.includes(i)).length) {
        const keep = doomed.find(i => threadsOf(a.id).find(t => t.id === i).thread.main) || [...doomed].sort((x, y) => store.threads.find(t => t.id === y).updated_at - store.threads.find(t => t.id === x).updated_at)[0];
        doomed = doomed.filter(i => i !== keep); kept.push(keep);
      }
      store.threads = store.threads.filter(t => !doomed.includes(t.id));
      if (doomed.length) ensureMain(a.id);
      return { deleted: doomed, busy, missing, kept };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/threads\/follow-model$/)) && method === 'POST') {
      const a = need(m[1]), updated = [], busy = [];
      for (const t of threadsOf(a.id)) { if (follows(t, a)) continue; if ((state.botsWorking || []).includes(t.id)) { busy.push(t.id); continue; } Object.assign(t, { model_endpoint_id: a.endpoint_id || 'm1', model_override: null, model_effort: null }); updated.push(t.id); }
      return { updated, busy };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/threads\/([^/]+)$/)) && method === 'PATCH') {
      const a = need(m[1]), t = ownThread(a, m[2]);
      for (const [key, value] of Object.entries(body)) {
        if (key === 'title') { const title = String(value || '').split(/\s+/).filter(Boolean).join(' '); if (!title || title.length > 200) throw bad('a title is 1 to 200 characters'); t.title = title; t.thread.title_source = 'person'; }
        else if (key === 'folder_id') { if (value && !a.folders.some(f => f.id === value)) throw bad('that folder does not exist'); t.thread.folder_id = value || null; }
        else if (key === 'pinned' || key === 'unread') { if (typeof value !== 'boolean') throw bad(`${key} is true or false`); t.thread[key] = value; }
        else if (key === 'archived') { if (value && t.thread.main) throw new Refusal(409, 'this is the main conversation; make another one the main first'); t.thread.archived_at = value ? clock() : null; }
        else if (key === 'snooze') {
          const at = clock();
          t.thread.snoozed_until = value === 'activity' ? 0 : value === 'stop' ? null : value === 'tonight' ? at + 3 * 3600 : value === 'tomorrow' ? at + 12 * 3600
            : (typeof value === 'number' && value >= 0 ? value : (() => { throw bad('snooze is activity, tonight, tomorrow, stop or a unix time'); })());
        }
        else if (key === 'approval_mode') t.thread.approval_mode = value === null ? null : approval(value, 'thread approval_mode', THREAD_APPROVAL);
        else if (key === 'place') { if (value !== null) choice(value, PLACES, 'place'); t.thread.place = value; }
        else throw bad(`${key} cannot be changed`);
      }
      return row(t, a);
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/folders$/)) && method === 'POST') {
      const a = need(m[1]), name = String(body.name || '').split(/\s+/).filter(Boolean).join(' ');
      if (!name || name.length > 80) throw bad("a folder's name is 1 to 80 characters");
      if (String(body.emoji || '').length > 8) throw bad("a folder's emoji is up to 8 characters");
      if (a.folders.length >= MAX_FOLDERS) throw new Refusal(409, `a bot can have up to ${MAX_FOLDERS} folders`);
      const folder = { id: `f${store.counter++}`, name, emoji: String(body.emoji || '').trim(), order: Math.max(-1, ...a.folders.map(f => f.order)) + 1 };
      a.folders.push(folder); return folder;
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/folders\/order$/)) && method === 'PUT') {
      const a = need(m[1]), ids = body.ids || [];
      if (new Set(ids).size !== ids.length || ids.some(i => !a.folders.some(f => f.id === i))) throw bad("list each of this bot's folders at most once");
      const rest = [...a.folders].sort((x, y) => x.order - y.order).filter(f => !ids.includes(f.id)).map(f => f.id);
      [...ids, ...rest].forEach((id, i) => { a.folders.find(f => f.id === id).order = i; });
      return { folders: [...a.folders].sort((x, y) => x.order - y.order) };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/folders\/([^/]+)$/))) {
      const a = need(m[1]), f = a.folders.find(x => x.id === m[2]);
      if (!f) throw new Refusal(404, 'folder not found');
      if (method === 'PATCH') {
        if ('name' in body) { const name = String(body.name || '').trim(); if (!name || name.length > 80) throw bad("a folder's name is 1 to 80 characters"); f.name = name; }
        if ('emoji' in body) { if (String(body.emoji || '').length > 8) throw bad("a folder's emoji is up to 8 characters"); f.emoji = String(body.emoji || '').trim(); }
        return { ...f };
      }
      if (method === 'DELETE') {
        a.folders = a.folders.filter(x => x.id !== f.id);
        const inside = threadsOf(a.id).filter(t => t.thread.folder_id === f.id); inside.forEach(t => { t.thread.folder_id = null; });
        return { ok: true, cleared: inside.length };
      }
    }
    return undefined;
  }
};
module.exports.MAX_BOTS = MAX_BOTS;
module.exports.DEFAULTS = DEFAULTS;
module.exports.THREAD_DEFAULTS = THREAD_DEFAULTS;
