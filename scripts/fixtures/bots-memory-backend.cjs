// The notebook lane of the Bots fixture backend (Phase 2 unit U1): /api/bots/<id>/memory..., served from
// state.botsMemory so it never touches another lane's state. It answers only its own routes and returns
// undefined for everything else (the core fixture's roster and every other lane stay as they are). It
// follows routes/bot_memory_routes.py and services/bot_memory.py closely enough for the Memory section:
// hashes, expected-hash 409s, 413 on a big topic, read-only logs, entries, the change history with diffs, guarded
// Undo, settings, tidy and the loopback-only open. A bot must exist in the core fixture (state.botsCore).
// Switches a check may set on state.botsMemory: failOverview (a count of overview failures), remote (opens are refused).
const crypto = require('node:crypto');
const core = require('./bots-core-backend.cjs');

const ABSENT = 'absent';
const INDEX = 'MEMORY.md';
const ARCHIVE = 'memory/archive.md';
const WRITE_LIMIT = 512 * 1024, TOPIC_LIMIT = 64 * 1024, LINES = 200, BYTES = 24576;
class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const bad = detail => new Refusal(400, detail);
const sha = text => (text === null || text === undefined ? ABSENT : crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
const bytesOf = text => Buffer.byteLength(text || '', 'utf8');

const NEW = /^- (\d{4}-\d{2}-\d{2}) · from ([^·\n]{1,40}?) · (.*?)(?: · until (\d{4}-\d{2}-\d{2}))?$/;
const STRUCK = /^- ~~(\d{4}-\d{2}-\d{2}) · from ([^·\n]{1,40}?) · (.*?)~~ · superseded (\d{4}-\d{2}-\d{2})$/;
const OLD = /^\s*-\s+(\d{4}-\d{2}-\d{2})(?:\s+\(until (\d{4}-\d{2}-\d{2})\))?\s*:\s*(.*)$/;

module.exports = ({ state, data, now }) => {
  const base = core({ state, data, now });
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const today = () => new Date(clock() * 1000).toISOString().slice(0, 10);
  const lane = () => (state.botsMemory ||= { books: {}, counter: 0, opened: [], failOverview: 0, remote: false });
  const need = id => { const a = base.store().agents.find(x => x.id === id); if (!a) throw new Refusal(404, 'no such bot'); return a; };
  const book = id => {
    const agent = need(id);
    return lane().books[id] ||= {
      enabled: true, room_capture: false, files: { [INDEX]: `# ${agent.name}'s notes\n\n## About this work\n- ${agent.role || ''}\n\n## Preferences\n\n## Corrections\n\n## Notes\n` },
      journal: [], snapshots: {},
    };
  };
  const kindOf = path => {
    if (path === INDEX) return 'index';
    if (path === ARCHIVE) return 'archive';
    if (/^memory\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/.test(path) && !['archive', 'log'].includes(path.slice(7, -3).toLowerCase())) return 'topic';
    if (/^memory\/log\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) return 'log';
    throw bad('that is not a notebook file');
  };
  const limitOf = kind => (kind === 'topic' ? TOPIC_LIMIT : WRITE_LIMIT);
  const lineCount = text => (text.match(/\n/g) || []).length + (text && !text.endsWith('\n') ? 1 : 0);

  function clip(text) {
    const lines = text.split(/(?<=\n)/).filter(Boolean);
    let used = 0, kept = 0;
    for (const line of lines.slice(0, LINES)) { const size = bytesOf(line); if (used + size > BYTES) break; used += size; kept += 1; }
    const stored = bytesOf(text);
    return { loaded_lines: kept, stored_lines: lines.length, loaded_bytes: used, stored_bytes: stored, line_limit: LINES, byte_limit: BYTES, clipped: used < stored || kept < lines.length };
  }
  function notes(text) {
    const out = [], seen = {};
    let section = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('## ')) { section = line.slice(3).trim(); continue; }
      let m, entry = null;
      if ((m = STRUCK.exec(line))) entry = { learned: m[1], source: m[2], text: m[3], until: null, superseded: m[4], legacy: false };
      else if ((m = NEW.exec(line))) entry = { learned: m[1], source: m[2], text: m[3], until: m[4] || null, superseded: null, legacy: false };
      else if ((m = OLD.exec(line))) entry = { learned: m[1], source: 'legacy', text: m[3], until: m[2] || null, superseded: null, legacy: true };
      if (!entry) continue;
      const hash = crypto.createHash('sha1').update(line + '\n').digest('hex').slice(0, 10);
      seen[hash] = (seen[hash] || 0) + 1;
      out.push({ id: seen[hash] === 1 ? hash : `${hash}-${seen[hash]}`, section, ...entry, protected: /allerg|medic|health|safety/i.test(entry.text), raw: line });
    }
    return out;
  }
  const publicNotes = text => notes(text).map(({ raw, ...rest }) => rest);
  function info(path, text) {
    const kind = kindOf(path);
    const out = { path, kind, text, hash: sha(text), exists: true, bytes: bytesOf(text), lines: lineCount(text), read_only: kind === 'log', limit: limitOf(kind) };
    if (kind === 'topic') {
      const name = path.slice(7, -3), front = /^---\ntitle: (.*)\ndescription: (.*)\n---/.exec(text);
      Object.assign(out, { name, title: front ? front[1] : name, description: (front && front[2]) || 'No description provided', aliases: [] });
    }
    if (kind === 'index' || kind === 'topic') out.notes = publicNotes(text);
    return out;
  }
  const diffOf = (path, before, after) => {
    const old = new Set((before || '').split('\n')), now2 = new Set((after || '').split('\n'));
    const rows = [`--- before/${path}`, `+++ after/${path}`, '@@ @@'];
    for (const line of (before || '').split('\n')) if (line && !now2.has(line)) rows.push(`-${line}`);
    for (const line of (after || '').split('\n')) if (line && !old.has(line)) rows.push(`+${line}`);
    return rows.join('\n').slice(0, 8000);
  };

  function journal(b, files, { actor, source, summary, operation, reverts }) {
    const rowFiles = files.map(f => ({ path: f.path, operation: f.before === null ? 'create' : f.after === null ? 'delete' : 'edit', before_hash: sha(f.before), after_hash: sha(f.after),
      counts: { added: 1, removed: 0, bytes_before: bytesOf(f.before), bytes_after: bytesOf(f.after) } }));
    const id = `c${++lane().counter}`;
    const row = { id, time: clock(), actor, source, thread_id: null, run_id: null, path: files.length === 1 ? files[0].path : `${files.length} files`, operation: operation || rowFiles[0].operation,
      before_hash: rowFiles[0].before_hash, after_hash: rowFiles[0].after_hash, counts: { files: files.length, added: 1, removed: 0 }, diff: files.map(f => diffOf(f.path, f.before, f.after)).join('\n'),
      summary: summary || `${rowFiles[0].operation === 'create' ? 'Created' : rowFiles[0].operation === 'delete' ? 'Deleted' : 'Edited'} ${files[0].path}`, revertible: true, reverts: reverts || null, reverted_by: null, files: rowFiles };
    b.journal.unshift(row);
    b.snapshots[id] = Object.fromEntries(files.map(f => [f.path, f.before]));
    if (reverts) { const original = b.journal.find(r => r.id === reverts); if (original) original.reverted_by = id; }
    return row;
  }
  function apply(b, changes, meta) {
    const done = [];
    for (const c of changes) {
      const current = b.files[c.path] ?? null;
      if (sha(current) !== c.expected) throw new Refusal(409, 'this note changed since you opened it; reload it first');
      if (c.after !== null && bytesOf(c.after) > limitOf(kindOf(c.path))) throw new Refusal(413, `${c.path} is limited to ${limitOf(kindOf(c.path)) / 1024} KiB`);
      if (current !== c.after) done.push({ path: c.path, before: current, after: c.after });
    }
    for (const f of done) { if (f.after === null) delete b.files[f.path]; else b.files[f.path] = f.after; }
    return done.length ? journal(b, done, meta) : null;
  }
  const listFiles = b => Object.keys(b.files).filter(p => kindOf(p)).map(p => {
    const i = info(p, b.files[p]); const { text, notes: _n, ...rest } = i; return { ...rest, modified: clock() };
  });
  const overview = (id) => {
    const b = book(id), agent = need(id), text = b.files[INDEX] ?? '';
    const last = b.journal.find(r => ['upkeep', 'dream', 'capture', 'organize'].includes(r.actor) && !r.reverted_by);
    const settings = { enabled: b.enabled, upkeep: !!agent.memory_upkeep, room_capture: b.room_capture };
    return { bot_id: id, bot_name: agent.name, settings, enabled: b.enabled,
      index: { path: INDEX, text, hash: sha(b.files[INDEX] ?? null), exists: INDEX in b.files, ...clip(text), notes: publicNotes(text) },
      files: listFiles(b), maintenance: { upkeep: !!agent.memory_upkeep, changes: b.journal.length, last: last ? { id: last.id, time: last.time, actor: last.actor, summary: last.summary } : null } };
  };

  function appendEntry(text, section, body, source, until) {
    const lines = text.split('\n');
    const row = `- ${today()} · from ${source} · ${body}${until ? ` · until ${until}` : ''}`;
    const at = lines.findIndex(l => l === `## ${section}`);
    if (at < 0) { while (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push('', `## ${section}`, row, ''); return lines.join('\n'); }
    let end = at + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
    while (end > at + 1 && lines[end - 1].trim() === '') end -= 1;
    lines.splice(end, 0, row);
    return lines.join('\n');
  }
  function entryAction(b, body) {
    const path = body.path || INDEX, kind = kindOf(path);
    if (!['index', 'topic'].includes(kind)) throw bad('notes are added to the main page or a topic');
    const before = b.files[path] ?? null;
    if (sha(before) !== body.expected_hash) throw new Refusal(409, 'this note changed since you opened it; reload it first');
    let after = before ?? '';
    const text = String(body.text ?? '').trim();
    if (body.action === 'append') {
      if (!text) throw bad('there is nothing to remember');
      if (text.length > 1000) throw bad('this entry exceeds the 1,000-character limit');
      after = appendEntry(after, body.section || 'Notes', text, 'owner', body.until || null);
    } else if (body.action === 'remove') {
      const target = notes(after).find(n => n.id === body.target);
      if (!target) throw bad('that note is not in the document any more; reload it');
      const lines = after.split('\n'); lines.splice(lines.indexOf(target.raw), 1); after = lines.join('\n');
    } else if (body.action === 'replace' || body.action === 'supersede') {
      const target = notes(after).find(n => n.id === body.target);
      if (!target) throw bad('that note is not in the document any more; reload it');
      if (!text) throw bad('there is nothing to remember');
      const lines = after.split('\n'), at = lines.indexOf(target.raw), fresh = `- ${today()} · from owner · ${text}`;
      if (body.action === 'replace') lines[at] = fresh;
      else lines.splice(at, 1, `- ~~${target.learned} · from ${target.source} · ${target.text}~~ · superseded ${today()}`, fresh);
      after = lines.join('\n');
    } else throw bad('action must be one of: append, replace, remove, supersede');
    if (kind === 'index' && bytesOf(after) > BYTES * 1000) throw new Refusal(413, 'too big');
    const row = apply(b, [{ path, expected: sha(before), after }], { actor: 'person', source: 'owner',
      summary: { append: 'Added a note to ' + (body.section || 'Notes'), remove: 'Removed a note', replace: 'Changed a note', supersede: 'Replaced a note' }[body.action] });
    return { file: info(path, b.files[path] ?? ''), changed: !!row, displaced: 0, change_id: row ? row.id : null };
  }

  function tidy(b, id) {
    const agent = need(id);
    if (!agent.memory_upkeep) throw new Refusal(409, 'turn on keeping its notes tidy first');
    const text = b.files[INDEX] ?? '';
    const gone = notes(text).filter(n => !n.protected && (n.superseded || (n.until && n.until <= today())));
    if (!gone.length) return { queued: true, passes: [] };
    const lines = text.split('\n');
    for (const n of gone) lines.splice(lines.indexOf(n.raw), 1);
    const archive = (b.files[ARCHIVE] ?? '') + `\n## Archived ${today()}\n` + gone.map(n => `\n### ${n.section}\n${n.raw}\n`).join('');
    const row = apply(b, [{ path: INDEX, expected: sha(text), after: lines.join('\n') }, { path: ARCHIVE, expected: sha(b.files[ARCHIVE] ?? null), after: archive }],
      { actor: 'upkeep', source: 'tidy', summary: `Tidied ${gone.length} note${gone.length === 1 ? '' : 's'}` });
    return { queued: true, passes: row ? [row.id] : [] };
  }
  function revert(b, changeId) {
    const row = b.journal.find(r => r.id === changeId);
    if (!row) throw new Refusal(404, 'there is no such change');
    if (row.reverted_by) throw new Refusal(409, 'this change was already undone');
    if (!row.revertible) throw new Refusal(409, 'this change cannot be undone: its old version is not kept');
    const changes = [];
    for (const f of row.files) {
      if (sha(b.files[f.path] ?? null) !== f.after_hash) throw new Refusal(409, 'this change cannot be undone: the notes changed after it');
      changes.push({ path: f.path, expected: f.after_hash, after: b.snapshots[changeId][f.path] });
    }
    return apply(b, changes, { actor: 'person', source: 'undo', operation: 'revert', reverts: changeId, summary: `Undid: ${row.summary}` });
  }

  function read(route, query = {}) {
    let m;
    if (!(m = route.match(/^\/api\/bots\/([^/]+)\/memory(\/.*)?$/))) return undefined;
    const id = m[1], tail = m[2] || '', b = book(id);
    if (tail === '') {
      if (lane().failOverview > 0) { lane().failOverview -= 1; throw new Refusal(500, 'the notebook is not available right now'); }
      return overview(id);
    }
    if (tail === '/file') {
      const path = query.path || '';
      kindOf(path);
      if (!(path in b.files)) throw new Refusal(404, 'there is no such note');
      return info(path, b.files[path]);
    }
    if (tail === '/journal') return { rows: b.journal.slice(0, Number(query.limit || 50)) };
    if (tail === '/upkeep') return { enabled: !!need(id).memory_upkeep, entries: b.journal.filter(r => r.actor === 'upkeep') };
    return undefined;
  }

  function mutate(route, method, body = {}, query = {}) {
    let m;
    if (!(m = route.match(/^\/api\/bots\/([^/]+)\/memory(\/.*)?$/))) return undefined;
    const id = m[1], tail = m[2] || '', b = book(id);
    if (tail === '/settings' && method === 'PATCH') {
      const known = ['enabled', 'upkeep', 'room_capture'];
      if (Object.keys(body).some(k => !known.includes(k)) || known.some(k => k in body && typeof body[k] !== 'boolean')) throw new Refusal(422, 'settings are on or off');
      if ('enabled' in body) b.enabled = body.enabled;
      if ('room_capture' in body) b.room_capture = body.room_capture;
      if ('upkeep' in body) need(id).memory_upkeep = body.upkeep;
      return overview(id).settings;
    }
    if (tail === '/file') {
      const path = query.path || '', kind = kindOf(path);
      if (kind === 'log') throw new Refusal(403, 'daily logs are read-only');
      const before = b.files[path] ?? null;
      if (method === 'PUT') {
        if (typeof body.text !== 'string' || typeof body.expected_hash !== 'string') throw new Refusal(422, 'text and expected_hash are needed');
        const row = apply(b, [{ path, expected: body.expected_hash, after: body.text }], { actor: 'person', source: 'memory editor' });
        return { file: info(path, b.files[path]), changed: !!row, change_id: row ? row.id : null };
      }
      if (method === 'DELETE') {
        if (kind === 'index') throw new Refusal(403, "the notebook's main page cannot be deleted; empty it instead");
        if (before === null && query.expected_hash === ABSENT) throw new Refusal(404, 'there is no such note');
        const row = apply(b, [{ path, expected: query.expected_hash, after: null }], { actor: 'person', source: 'memory editor' });
        return { deleted: true, change_id: row ? row.id : null };
      }
    }
    if (tail === '/entries' && method === 'POST') return entryAction(b, body);
    if (tail === '/tidy' && method === 'POST') return tidy(b, id);
    if (tail === '/open' && method === 'POST') {
      if (lane().remote) throw new Refusal(403, 'the notebook can only be opened on the computer it is stored on');
      if (!['folder', 'obsidian'].includes(body.target || 'folder')) throw bad('open the folder or Obsidian');
      lane().opened.push(body.target || 'folder');
      return { opened: body.target || 'folder' };
    }
    if ((m = tail.match(/^\/journal\/([^/]+)\/revert$/)) && method === 'POST') {
      const row = revert(b, m[1]);
      return { reverted: m[1], change_id: row ? row.id : null };
    }
    return undefined;
  }

  const guard = fn => (route, ...rest) => {
    if (!state.botsLive) return undefined;
    try { return fn(route, ...rest); }
    catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
  };
  return { read: guard(read), mutate: guard(mutate) };
};
