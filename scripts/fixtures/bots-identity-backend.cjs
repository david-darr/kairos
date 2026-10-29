// The identity lane of the Bots fixture backend (Phase 1 unit U2): profile history, soul drift, avatar pictures and the
// saved image connection, memory, routines, and the small reads the panel's sections make. It works on the records in
// state.botsCore (scripts/fixtures/bots-core-backend.cjs), so a PATCH made there shows up in the history served here.
// Routes follow routes/agent_routes.py. Binary bodies are not visible to fixtures (ui-smoke parses JSON only), so an
// upload always succeeds unless a check sets state.botsIdentity.uploadError, and a picture is never served as bytes.
// Handlers return undefined for routes they do not own.
const core = require('./bots-core-backend.cjs');

const MAX_DIRECTION = 400;
class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const bad = detail => new Refusal(400, detail);

module.exports = ({ state, data, now }) => {
  const base = core({ state, data, now });
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const store = () => base.store();
  const lane = () => (state.botsIdentity ||= { provider: null, uploadError: null, generateError: null, generateDelay: 0, counter: 0 });
  const need = id => { const a = store().agents.find(x => x.id === id); if (!a) throw new Refusal(404, 'agent not found'); return a; };
  const assetId = () => { const n = ++lane().counter; return (n.toString(16).padStart(8, '0') + 'ab'.repeat(12)).slice(0, 32); };
  const own = (agent, id) => { ((store().assets ||= {})[agent.id] ||= []).push(id); return id; };
  const snapshot = a => JSON.stringify([a.avatar, a.avatar_image, a.mascot_expression]).length.toString(16) + ':' + [a.avatar?.shape, a.avatar?.color, a.avatar?.acc, a.avatar_image?.asset_id, a.avatar_image?.shape, a.mascot_expression].join('/');
  const summary = a => ({ ...a, instructions: a.soul || '', revision: a.revision || 0, status: a.enabled === false ? 'off' : a.status || 'idle', status_detail: '', needs_you: 0, runs_today: a.runs_today || 0 });
  const soulFile = a => {
    const drifted = (store().soulFiles || {})[a.id];
    const file = drifted === undefined ? (a.soul ?? null) : drifted;
    return { soul: a.soul ?? null, file_text: file, in_sync: file === (a.soul ?? null), revision: a.revision || 0, bytes: Buffer.byteLength(a.soul || ''), limit: 24000 };
  };
  const rows = id => (store().history ||= {})[id] ||= [];
  const staged = () => ({ asset_id: assetId(), mime: 'image/png', width: 16, height: 16, bytes: 90 });

  function read(route, query = {}) {
    let m;
    if (route === '/api/agents/section-modules') return { modules: state.botsSectionModules || [] };
    if (route === '/api/agents/avatar-provider') {
      const p = lane().provider;
      return p ? { configured: true, kind: p.kind, base_url: p.base_url, model: p.model } : { configured: false, kind: null, base_url: null, model: null };
    }
    if (route === '/api/agent-calls/voices') return { voices: state.botsVoices || [], models: [] };
    if (route === '/api/agent-calls/live-choices') return state.botsLiveChoices || [];
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/history$/))) {
      const a = need(m[1]), limit = Number(query.limit || 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw bad('history limit is 1 to 500');
      const out = rows(a.id).slice(-limit).reverse().map(r => (r.field === 'soul' ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'before' && k !== 'after')) : r));
      return { rows: out, revision: a.revision || 0 };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/history\/([^/]+)$/))) {
      const row = rows(need(m[1]).id).find(r => r.id === m[2]);
      if (!row) throw new Refusal(404, 'no history row with that id');
      return row;
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/memory\/topics$/))) {
      need(m[1]);
      return { topics: (store().topics || {})[m[1]] || [] };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/soul$/))) return soulFile(need(m[1]));
    // A picture's bytes cannot be served by a JSON fixture; answering keeps the request from being an error,
    // and the browser then cannot decode it, which is the path that falls back to the bot's Kip.
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/avatar-image\/[0-9a-f]{32}$/))) { need(m[1]); return { picture: 'not served by the fixture' }; }
    if (/^\/api\/agents\/avatar-drafts\/[0-9a-f]{32}$/.test(route)) return { picture: 'not served by the fixture' };
    return undefined;
  }

  function mutate(route, method, body = {}) {
    let m;
    const s = store();
    if (route === '/api/agents/avatar-provider') {
      if (method === 'PUT') {
        if (!['openai', 'xai', 'compatible'].includes(body.kind)) throw bad('Choose OpenAI, xAI or a compatible server.');
        if (String(body.key || '').trim().length < 8) throw bad("Paste the connection's key.");
        if (body.kind === 'compatible' && !String(body.base_url || '').trim()) throw bad('A compatible server needs its address.');
        lane().provider = { kind: body.kind, base_url: body.base_url || (body.kind === 'xai' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1'), model: body.model || 'image-model' };
        return read(route);
      }
      if (method === 'DELETE') { lane().provider = null; return read(route); }
    }
    if (route === '/api/agents/avatar-drafts' && method === 'POST') {
      if (lane().uploadError) throw bad(lane().uploadError);
      const made = staged(); (s.drafts ||= []).push(made.asset_id); return made;
    }
    if (route === '/api/agents/avatar-drafts/generate' && method === 'POST') {
      generateChecks(body);
      const made = staged(); (s.drafts ||= []).push(made.asset_id); return made;
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/avatar-image$/))) {
      const a = need(m[1]);
      if (method === 'POST') {
        if (lane().uploadError) throw bad(lane().uploadError);
        const made = staged(); own(a, made.asset_id); return { ...made, snapshot: snapshot(a) };
      }
      if (method === 'PUT') {
        if (body.expected_snapshot && body.expected_snapshot !== snapshot(a)) throw new Refusal(409, 'The look changed while this picture was being made. Choose it again to use it.');
        if (body.asset_id === null || body.asset_id === undefined) { a.avatar_image = null; a.mascot_expression = null; }
        else {
          if (!((s.assets || {})[a.id] || []).includes(body.asset_id)) throw bad('That picture does not belong to this bot.');
          const image = { asset_id: body.asset_id, shape: body.shape || 'circle', zoom: body.zoom ?? 1, focus_x: body.focus_x ?? 0.5, focus_y: body.focus_y ?? 0.5 };
          if (!['circle', 'rounded', 'square', 'kip'].includes(image.shape) || image.zoom < 1 || image.zoom > 3) throw bad('invalid framing');
          a.avatar_image = image;
        }
        a.revision = (a.revision || 0) + 1;
        rows(a.id).push({ id: `h${s.counter++}`, ts: clock(), actor: 'user', field: 'avatar_image', summary: 'Changed avatar image', before: null, after: a.avatar_image, revision: a.revision, receipt_id: null });
        return summary(a);
      }
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/avatar-image\/generate$/)) && method === 'POST') {
      const a = need(m[1]);
      generateChecks(body);
      const made = staged(); own(a, made.asset_id); return { ...made, snapshot: body.snapshot || snapshot(a) };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/soul\/(apply|discard-file)$/)) && method === 'POST') {
      const a = need(m[1]), file = soulFile(a);
      if ((a.revision || 0) !== body.expected_revision || file.file_text !== body.expected_file_text) throw new Refusal(409, 'The instructions changed. Reload before changing the file edit.');
      if (m[2] === 'apply') { if (file.file_text === null) throw bad('SOUL.md is missing; there is no external edit to apply');
        const before = a.soul; a.soul = file.file_text; a.revision = (a.revision || 0) + 1;
        rows(a.id).push({ id: `h${s.counter++}`, ts: clock(), actor: 'file', field: 'soul', summary: 'Changed soul', before, after: a.soul, revision: a.revision, receipt_id: null }); }
      delete (s.soulFiles ||= {})[a.id];
      return soulFile(a);
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/history\/([^/]+)\/rollback$/)) && method === 'POST') {
      const a = need(m[1]), row = rows(a.id).find(r => r.id === m[2]);
      if (!row) throw new Refusal(404, 'no history row with that id');
      if (row.field !== 'soul') throw bad('Only standing instructions can be restored from history.');
      if ((a.revision || 0) !== body.expected_revision) throw new Refusal(409, 'The profile changed. Reload it before saving.');
      if (soulFile(a).file_text !== body.expected_file_text) throw new Refusal(409, 'The instructions file changed. Reload before restoring.');
      const before = a.soul; a.soul = row.before || ''; a.revision = (a.revision || 0) + 1;
      rows(a.id).push({ id: `h${s.counter++}`, ts: clock(), actor: 'user', field: 'soul', summary: 'Changed soul', before, after: a.soul, revision: a.revision, receipt_id: null });
      return { agent: summary(a), soul_file: soulFile(a) };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/proposals\/([^/]+)\/undo$/)) && method === 'POST') {
      const a = need(m[1]), receipt = (a.profile_proposals || []).find(r => r.id === m[2]);
      if (!receipt) throw new Refusal(404, 'no change with that receipt');
      if (receipt.state !== 'applied' || receipt.revision !== body.expected_revision || (a.revision || 0) !== receipt.revision) throw new Refusal(409, 'This change is no longer available to undo.');
      Object.assign(a, receipt.before); a.revision = (a.revision || 0) + 1; receipt.state = 'undone';
      return { receipt, agent: summary(a) };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/memory$/)) && method === 'PUT') {
      need(m[1]);
      if (String(body.text || '').length > 8000) throw bad('memory is limited to 8000 characters');
      (s.memoryText ||= {})[m[1]] = body.text; return { memory: body.text };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/memory\/upkeep\/([^/]+)\/undo$/)) && method === 'POST') {
      const entry = ((s.journal || {})[m[1]] || []).find(e => e.id === m[2]);
      if (!entry || entry.status !== 'committed') throw new Refusal(409, 'Undo refused: pass is missing or already undone');
      entry.status = 'undone'; return { ok: true };
    }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/forget-logins$/)) && method === 'POST') { need(m[1]); return { ok: true }; }
    if ((m = route.match(/^\/api\/agents\/([^/]+)\/goals$/)) && method === 'POST') {
      const a = need(m[1]);
      if (!body.name || !body.prompt) throw bad('a routine needs a name and instructions');
      const goal = { id: `goal-${s.counter++}`, agent_id: a.id, name: body.name, prompt: body.prompt, schedule_kind: body.schedule_kind, run_time: body.run_time || null, interval_seconds: body.interval_seconds || null,
        time_zone: body.time_zone || null, weekdays: body.weekdays || null, enabled: true };
      ((s.goals ||= {})[a.id] ||= []).push(goal); return goal;
    }
    if ((m = route.match(/^\/api\/tasks\/(goal-[^/]+)(\/run)?$/))) {
      const all = Object.values(s.goals || {}).flat(), goal = all.find(g => g.id === m[1]);
      if (!goal) throw new Refusal(404, 'task not found');
      if (m[2] && method === 'POST') { (lane().ran ||= []).push(goal.id); return { ok: true }; }
      if (method === 'PATCH') { Object.assign(goal, Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'prompt', 'enabled', 'time_zone', 'weekdays'].includes(k)))); return goal; }
      if (method === 'DELETE') { for (const list of Object.values(s.goals)) { const at = list.indexOf(goal); if (at >= 0) list.splice(at, 1); } return { ok: true }; }
    }
    return undefined;
  }

  function generateChecks(body) {
    const text = String(body.direction || '').trim();
    if (!text) throw bad('Describe the picture you want.');
    if (text.length > MAX_DIRECTION) throw bad(`Keep the description under ${MAX_DIRECTION} characters.`);
    if (!lane().provider) throw new Refusal(502, 'Save an image connection first.');
    if (lane().generateError) throw new Refusal(502, lane().generateError);
  }

  return {
    read(route, query = {}) {
      if (!state.botsLive) return undefined;
      try { return read(route, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
    mutate(route, method, body = {}) {
      if (!state.botsLive) return undefined;
      try { return mutate(route, method, body || {}); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
  };
};
