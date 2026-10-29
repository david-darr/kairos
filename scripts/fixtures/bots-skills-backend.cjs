// The Bots skills API in memory, for the Electron checks (Phase 2, unit U3).
// Answers /api/bots/<id>/skills*, /skill-*, /api/bots/skills-library* and /api/bots/shares* while demoState.botsLive is set, and
// returns undefined for everything else (the g4Backend pattern; see scripts/fixtures/bots-core-backend.cjs). State lives under
// state.botsSkills so a check can seed or change it. It mirrors routes/bot_skills_routes.py: review before enable bound to the
// reviewed hash, 409 for stale revisions, 422 for a held card, 413 for capacity. It never assumes which bots exist.
const crypto = require('node:crypto');

const OPEN_LIMIT = 20;
class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const bad = detail => new Refusal(400, detail);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = ['goal', 'learn', 'setup'];

function parse(md) {
  const front = md.startsWith('---\n') ? md.split('\n---')[0] : '';
  const value = key => (new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(front)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  return { name: value('name'), description: value('description') };
}

module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const store = () => state.botsSkills ||= { counter: 1, bots: {}, library: {}, assignments: { revision: 0, every: [], bots: {} }, shares: [] };
  const bot = id => store().bots[id] ||= { skills: {}, requests: [], receipts: {}, settings: { enabled: true, steps: 10, sharing: 'ask' } };
  const next = () => String(store().counter++).padStart(6, '0');

  function bundle(name, md, references = {}) {
    if (!NAME.test(name || '') || name.length > 64) throw bad('Use a lowercase skill name with words joined by hyphens.');
    if (RESERVED.includes(name)) throw bad('That name is a built-in command. Choose another.');
    const meta = parse(md || '');
    if (!meta.description || meta.description.length > 1024) throw bad('Add a one-line description of at most 1,024 characters.');
    if (meta.name && meta.name !== name) throw bad('The frontmatter name must match the skill name.');
    if (/​|⁠|﻿/.test(md)) throw new Refusal(422, 'Remove invisible Unicode formatting from this skill.');
    if (/curl[^\n]*\|\s*(ba|z)?sh/.test(md)) throw new Refusal(422, 'The skill scan refused this content.');
    if (Object.keys(references).length > 8) throw bad('A skill can include at most eight references.');
    return { name, description: meta.description, skill_md: md, references, tags: [], sha256: sha(JSON.stringify([md, references])), warnings: [],
      storage_revision: 'rev-' + next(), enabled: false, reviewed_sha256: null, retired: false, changed_after_review: false,
      source: 'pasted', origin: 'private', skipped_files: [], imported_at: clock() };
  }
  const view = (entry, extra = {}) => ({ ...entry, effective_enabled: !!(entry.enabled && !entry.retired && !entry.changed_after_review && entry.reviewed_sha256 === entry.sha256),
    path: `/bot-workspaces/skills/${entry.name}/SKILL.md`, ...extra });
  const row = value => { const { skill_md, references, ...rest } = value; return { ...rest, reference_names: Object.keys(references || {}).sort() }; };
  const libraryView = entry => view(entry, { origin: entry.origin === 'private' ? 'library' : entry.origin, every_bot: store().assignments.every.includes(entry.name),
    assigned_bots: Object.entries(store().assignments.bots).filter(([, names]) => names.includes(entry.name)).map(([id]) => id).sort() });

  function card(request, id) {
    const current = bot(id).skills[request.name];
    const value = { ...request, sha_prefix: request.bundle_sha256.slice(0, 12), title: (request.kind === 'update' ? 'Update skill ' : 'Enable skill ') + request.name,
      current_skill_md: request.kind === 'update' && current ? current.skill_md : null, current_revision: current && !current.retired ? current.storage_revision : 'absent' };
    const receipt = request.receipt_id && bot(id).receipts[request.receipt_id];
    if (receipt) value.receipt = { id: receipt.id, applied_revision: receipt.applied_revision, applied_at: receipt.applied_at, undone: receipt.undone };
    return value;
  }
  const live = (id, name) => { const e = bot(id).skills[name]; return e && !e.retired ? e : null; };

  function listBot(id) {
    const b = bot(id), own = Object.values(b.skills).filter(e => !e.retired);
    const shadow = new Set(own.map(e => e.name)), wanted = new Set([...store().assignments.every, ...(store().assignments.bots[id] || [])]);
    const library = [...wanted].map(n => store().library[n]).filter(e => e && !e.retired && !shadow.has(e.name))
      .map(e => ({ ...libraryView(e), assigned_via: store().assignments.every.includes(e.name) ? 'every' : 'bot' })).filter(e => e.effective_enabled);
    return { skills: own.sort((a, b) => a.name.localeCompare(b.name)).map(e => row(view(e))), library: library.map(row),
      requests: b.requests.filter(r => ['open', 'held'].includes(r.status)).map(r => card(r, id)), notes: [], settings: { ...b.settings } };
  }

  function land(results, candidate, install) {
    try { install(candidate); results.push({ name: candidate.name, status: 'imported', warnings: [], skipped_files: [] }); }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      results.push({ name: candidate.name, status: error.status === 409 ? 'exists' : 'refused', reason: error.status === 409 ? 'A skill with this name is already here.' : error.message });
    }
  }
  function candidates(body) {
    if (body.source) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(body.source.trim()) && !/^https:\/\/(github\.com|skills\.sh)\//.test(body.source.trim())) throw bad('Enter a GitHub link, owner/repo, or a skills.sh link.');
      const list = state.botsSkillsSource?.[body.source.trim()];
      if (!list) throw new Refusal(404, 'The source answered with status 404.');
      return list.map(c => ({ ...c, source: 'github:' + body.source.trim() }));
    }
    if (!body.content || !body.content.trim()) throw bad('Paste the text of a SKILL.md file.');
    const name = parse(body.content).name;
    if (!name) throw bad('Add a name line to the SKILL.md frontmatter, or upload a file named after the skill.');
    return [{ name, skill_md: body.content, source: 'pasted' }];
  }

  const actions = {
    apply(id, request, body) {
      if (request.status === 'applied') return { receipt: bot(id).receipts[request.receipt_id], request: card(request, id) };
      if (['denied', 'undone'].includes(request.status)) throw new Refusal(409, 'This request is closed.');
      if (!body.reviewed_sha256) throw bad('Send the hash of the text you reviewed.');
      if (body.reviewed_sha256 !== request.bundle_sha256) throw new Refusal(409, 'This request changed after review. Reload and review it again.');
      const current = live(id, request.name);
      if ((current ? current.storage_revision : 'absent') !== (body.expected_base_revision ?? request.base_revision)) {
        request.status = 'held'; request.held_reason = 'The skill changed after this was proposed. Retry to review it against the current version.';
        throw new Refusal(422, request.held_reason);
      }
      const entry = { ...bundle(request.name, request.skill_md, request.references), source: 'learned:' + request.source, enabled: true };
      entry.reviewed_sha256 = entry.sha256;
      const receipt = { id: 'rc-' + request.id, request: request.id, name: request.name, previous: current || null, applied_revision: entry.storage_revision, applied_at: clock(), undone: false };
      bot(id).receipts[receipt.id] = receipt; bot(id).skills[request.name] = entry;
      Object.assign(request, { status: 'applied', receipt_id: receipt.id, held_reason: null });
      return { receipt, request: card(request, id) };
    },
    undo(id, request) {
      if (request.status === 'undone') return { receipt: bot(id).receipts[request.receipt_id], request: card(request, id) };
      if (request.status !== 'applied') throw new Refusal(409, 'Only an applied request can be undone.');
      const receipt = bot(id).receipts[request.receipt_id], current = live(id, receipt.name);
      if (!current || current.storage_revision !== receipt.applied_revision) throw new Refusal(409, 'The skill has changed since this was applied, so it cannot be undone.');
      if (receipt.previous) bot(id).skills[receipt.name] = receipt.previous; else delete bot(id).skills[receipt.name];
      receipt.undone = true; request.status = 'undone';
      return { receipt, request: card(request, id) };
    },
    deny(id, request) {
      if (['open', 'held'].includes(request.status)) request.status = 'denied';
      else if (request.status !== 'denied') throw new Refusal(409, 'This request is already applied. Undo it instead.');
      return { request: card(request, id) };
    },
    retry(id, request) {
      if (request.status !== 'held') throw new Refusal(409, 'Only a held request can be retried.');
      const current = live(id, request.name);
      Object.assign(request, { status: 'open', held_reason: null, base_revision: current ? current.storage_revision : 'absent', kind: current ? 'update' : 'create' });
      return { request: card(request, id) };
    },
    share(id, request, body) {
      if (request.status !== 'applied') throw new Refusal(409, 'Apply the skill before sharing it.');
      if ((body.audience || 'library') !== 'library') throw new Refusal(403, 'Sharing with a department or room is not available yet. Share to the library instead.');
      const own = live(id, request.name), entry = { ...bundle(own.name, own.skill_md, own.references), source: 'shared:' + id, origin: 'shared', enabled: true };
      entry.reviewed_sha256 = entry.sha256;
      store().library[own.name] = entry;
      return { status: 'published', library_revision: entry.storage_revision, assigned: [] };
    },
  };

  function handle(route, method, body, query) {
    const s = store();
    let m;
    if (route === '/api/bots/skills-library') {
      if (method === 'GET') {
        const q = (query.query || '').toLowerCase(), tag = query.tag || '';
        return { skills: Object.values(s.library).filter(e => !e.retired && (!tag || e.tags.includes(tag)) && (!q || [e.name, e.description, ...e.tags].join(' ').toLowerCase().includes(q)))
          .sort((a, b) => a.name.localeCompare(b.name)).map(e => row(libraryView(e))), assignments: s.assignments, pending_shares: s.shares.filter(x => x.status === 'pending') };
      }
      if (method === 'POST') {
        const results = [];
        for (const c of candidates(body)) land(results, c, item => {
          if (s.library[item.name] && !s.library[item.name].retired) throw new Refusal(409, 'exists');
          s.library[item.name] = { ...bundle(item.name, item.skill_md), source: item.source, origin: 'imported' };
        });
        return { results, skipped: [] };
      }
    }
    if ((m = route.match(/^\/api\/bots\/skills-library\/([^/]+)$/))) {
      const entry = s.library[m[1]];
      if (!entry || entry.retired) throw new Refusal(404, 'Library skill not found.');
      if (method === 'GET') return { ...libraryView(entry), revisions: [{ storage_revision: entry.storage_revision, sha256: entry.sha256, current: true }] };
      if (body.expected_revision !== undefined || method === 'DELETE') {
        const expected = method === 'DELETE' ? query.expected_revision : body.expected_revision;
        if (expected !== entry.storage_revision) throw new Refusal(409, 'This skill changed. Reload and review the current text.');
      }
      if (method === 'DELETE') {
        entry.retired = true; entry.enabled = false;
        s.assignments.every = s.assignments.every.filter(n => n !== entry.name);
        for (const id of Object.keys(s.assignments.bots)) s.assignments.bots[id] = s.assignments.bots[id].filter(n => n !== entry.name);
        s.assignments.revision++;
        return { retired: entry.name };
      }
      if (method === 'PATCH') {
        if (body.enabled === true) {
          if (body.reviewed_sha256 !== entry.sha256 || entry.changed_after_review) throw new Refusal(409, 'This skill changed after review. Reload and review it again.');
          entry.reviewed_sha256 = body.reviewed_sha256; entry.enabled = true;
        } else if (body.enabled === false) entry.enabled = false;
        if (body.tags) entry.tags = [...new Set(body.tags)];
        if (body.every_bot !== undefined) {
          const every = new Set(s.assignments.every); if (body.every_bot) every.add(entry.name); else every.delete(entry.name);
          s.assignments.every = [...every].sort(); s.assignments.revision++;
        }
        return libraryView(entry);
      }
    }
    if ((m = route.match(/^\/api\/bots\/shares\/([^/]+)\/(approve|deny)$/)) && method === 'POST') {
      const share = s.shares.find(x => x.id === m[1]);
      if (!share) throw new Refusal(404, 'Share request not found.');
      share.status = m[2] === 'approve' ? 'approved' : 'denied';
      return { status: share.status };
    }
    if (!(m = route.match(/^\/api\/bots\/([^/]+)\/(skills|skill-template|skills-library|skill-settings|skill-requests)(?:\/(.+))?$/))) return undefined;
    const [, id, kind, rest] = m, b = bot(id);
    if (kind === 'skills' && !rest) {
      if (method === 'GET') return listBot(id);
      if (method === 'POST') {
        const results = [];
        for (const c of candidates(body)) land(results, c, item => {
          if (live(id, item.name)) throw new Refusal(409, 'exists');
          b.skills[item.name] = { ...bundle(item.name, item.skill_md), source: item.source };
        });
        return { results, skipped: [] };
      }
    }
    if (kind === 'skills' && rest) {
      const entry = live(id, rest);
      if (!entry) throw new Refusal(404, 'Skill not found.');
      if (method === 'GET') return view(entry);
      const expected = method === 'DELETE' ? query.expected_revision : body.expected_revision;
      if (expected !== entry.storage_revision) throw new Refusal(409, 'This skill changed. Reload and review the current text.');
      if (method === 'DELETE') { entry.retired = true; entry.enabled = false; return { retired: rest }; }
      if (method === 'PATCH') {
        if (body.enabled === true) {
          if (body.reviewed_sha256 !== entry.sha256 || entry.changed_after_review) throw new Refusal(409, 'This skill changed after review. Reload and review it again.');
          entry.reviewed_sha256 = body.reviewed_sha256;
        }
        entry.enabled = !!body.enabled;
        return view(entry);
      }
    }
    if (kind === 'skill-template' && method === 'POST') {
      const description = String(body.description || '');
      if (!description || /[\r\n]/.test(description)) throw bad('Add a one-line description.');
      if (!body.instructions || body.instructions.length > 16000) throw bad('Instructions must contain 1 to 16,000 characters.');
      const text = `---\nname: ${body.name}\ndescription: ${description}\n---\n\n${body.instructions}\n`;
      const current = live(id, body.name);
      if ((current ? current.storage_revision : 'absent') !== (body.expected_revision || 'absent')) throw new Refusal(409, 'This skill changed. Reload and review the current text.');
      return view(b.skills[body.name] = { ...bundle(body.name, text), source: 'written:bot settings' });
    }
    if (kind === 'skills-library' && method === 'PUT') {
      if (body.expected_revision !== s.assignments.revision) throw new Refusal(409, 'Assignments changed. Reload and try again.');
      for (const n of body.skills) if (!s.library[n] || s.library[n].retired) throw new Refusal(404, `Library skill ${n} was not found.`);
      if (body.skills.length) s.assignments.bots[id] = [...new Set(body.skills)].sort(); else delete s.assignments.bots[id];
      s.assignments.revision++;
      return s.assignments;
    }
    if (kind === 'skill-settings' && method === 'PATCH') {
      if (body.review_steps !== undefined && !(Number.isInteger(body.review_steps) && body.review_steps >= 3 && body.review_steps <= 100)) throw bad('Choose between 3 and 100 tool steps.');
      if (body.review_enabled !== undefined) b.settings.enabled = body.review_enabled;
      if (body.review_steps !== undefined) b.settings.steps = body.review_steps;
      if (body.sharing !== undefined) b.settings.sharing = body.sharing;
      return { ...b.settings };
    }
    if (kind === 'skill-requests') {
      if (!rest && method === 'GET') return { requests: b.requests.filter(r => query.closed === 'true' || ['open', 'held'].includes(r.status)).map(r => card(r, id)) };
      if (!rest && method === 'POST') {
        const value = bundle(body.name, body.skill_md, body.references || {});
        if (b.requests.filter(r => ['open', 'held'].includes(r.status)).length >= OPEN_LIMIT) throw new Refusal(413, 'This bot has 20 skill requests waiting. Review some before adding more.');
        const current = live(id, body.name);
        const request = { id: 'q-' + next(), bot_id: id, name: body.name, kind: current ? 'update' : 'create', skill_md: body.skill_md, references: body.references || {}, tags: [],
          description: value.description, bundle_sha256: value.sha256, base_revision: current ? current.storage_revision : 'absent', source: 'saved by you', gist: body.gist || '',
          actor: 'person', status: 'open', held_reason: null, created_at: clock(), receipt_id: null };
        b.requests.push(request);
        return card(request, id);
      }
      const [requestId, action] = (rest || '').split('/');
      const request = b.requests.find(r => r.id === requestId);
      if (!request) throw new Refusal(404, 'Skill request not found.');
      if (method === 'POST' && actions[action]) return actions[action](id, request, body);
      throw new Refusal(404, 'Unknown action.');
    }
    return undefined;
  }

  return {
    read(route, query = {}) {
      if (!state.botsLive || !route.startsWith('/api/bots/')) return undefined;
      try { return handle(route, 'GET', {}, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
    mutate(route, method, body = {}, query = {}) {
      if (!state.botsLive || !route.startsWith('/api/bots/')) return undefined;
      try { return handle(route, method, body || {}, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
  };
};
