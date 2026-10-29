// The memory lifecycle lane of the Bots fixture backend (Phase 2 unit U2): Memory activity, recall, forget and
// About you. Routes follow routes/bot_recall_routes.py. State lives in state.botsMemoryRuntime; a check seeds it
// and reads it back. It never creates a bot and never seeds a roster: a check makes its own bot through the
// core backend, and this lane answers only the routes below (undefined otherwise).
//   lane.bots[id]   {memory_enabled, upkeep, model_available, report, capture, dream, ideas, pending_threads, pending_turns}
//   lane.profile    {text, hash, learned: [{id, text, learned_by, at}]}
//   lane.results    recall results by query word; lane.messages  message text by ref
//   lane.failActivity / lane.failProfile / lane.conflictProfile: failure switches a check turns on and off again
const LIMIT = 24000;
class Refusal extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const bad = detail => new Refusal(400, detail);

module.exports = ({ state, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const lane = () => (state.botsMemoryRuntime ||= {
    bots: {}, profile: { text: '', hash: 'h0', learned: [] }, results: {}, messages: {}, counter: 1,
    failActivity: false, failProfile: false, conflictProfile: false, forgot: [], tidied: 0,
  });
  const exists = id => Boolean(state.botsCore?.agents?.some?.(a => a.id === id));
  const bot = id => {
    if (!exists(id)) throw new Refusal(404, 'bot not found');
    return (lane().bots[id] ||= { memory_enabled: true, upkeep: true, model_available: true, report: null, capture: null,
      dream: { last_run: null, report: null }, ideas: [], pending_threads: 0, pending_turns: 0, tidy_time: '03:00' });
  };
  const hashOf = text => `h${[...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;
  const WORD = /[\p{L}\p{N}]+/gu;

  function read(route, query = {}) {
    let m;
    if (route === '/api/bots/profile') return { text: lane().profile.text, hash: lane().profile.hash, limit: LIMIT, chars: lane().profile.text.length,
      learned: [...lane().profile.learned].reverse(), limits: { learned: 200 } };
    if ((m = route.match(/^\/api\/bots\/([^/]+)\/memory\/activity$/))) {
      if (lane().failActivity) throw new Refusal(500, 'The activity could not be read.');
      const b = bot(m[1]);
      return { memory_enabled: b.memory_enabled, upkeep: b.upkeep, model_available: b.model_available, last_tidy_day: null, report: b.report,
        capture: b.capture, tidy_time: b.tidy_time, pending_threads: b.pending_threads, pending_turns: b.pending_turns, dream: b.dream, ideas: b.ideas };
    }
    if ((m = route.match(/^\/api\/bots\/([^/]+)\/recall$/))) {
      const b = bot(m[1]);
      if (!b.memory_enabled) return { results: [], count: 0, disabled: true };
      const words = String(query.q || '').toLowerCase().match(WORD) || [];
      if (!words.length) throw bad('give words to look for, or a since date');
      const found = words.flatMap(w => lane().results[w] || []);
      return { results: found, count: found.length };
    }
    if ((m = route.match(/^\/api\/bots\/([^/]+)\/recall\/messages\/([^/]+)$/))) {
      bot(m[1]);
      const text = lane().messages[decodeURIComponent(m[2])];
      if (text === undefined) throw new Refusal(404, 'not found');
      return { ref: m[2], kind: 'conversation', source: 'c1', title: 'Trip', role: 'user', ts: clock(), text, truncated: false };
    }
    return undefined;
  }

  function mutate(route, method, body) {
    let m;
    if (route === '/api/bots/profile' && method === 'PUT') {
      const p = lane().profile;
      if (lane().failProfile) throw new Refusal(503, 'The profile could not be saved.');
      if (lane().conflictProfile || body.expected_hash !== p.hash) throw new Refusal(409, 'About you changed since you opened it');
      if (typeof body.text !== 'string' || body.text.length > LIMIT) throw new Refusal(413, 'About you is too long');
      p.text = body.text; p.hash = hashOf(body.text) + String(lane().counter++);
      return { text: p.text, hash: p.hash, limit: LIMIT, chars: p.text.length };
    }
    if ((m = route.match(/^\/api\/bots\/profile\/learned\/([^/]+)\/remove$/)) && method === 'POST') {
      const p = lane().profile, at = p.learned.findIndex(f => f.id === m[1]);
      if (at < 0) throw new Refusal(404, 'that fact is already gone');
      p.learned.splice(at, 1);
      return { removed: m[1] };
    }
    if ((m = route.match(/^\/api\/bots\/([^/]+)\/memory\/tidy$/)) && method === 'POST') {
      const b = bot(m[1]);
      if (!b.upkeep) throw bad('turn on keeping notes tidy first');
      lane().tidied++;
      // Stamped with the real time: the run-wide `now` is fixed at start, so late in a full run it reads minutes old.
      b.report = { kind: 'tidy', at: Date.now() / 1000, expired: 1, duplicates: 0, superseded: 0, deferred: 0, organized: 0, contradictionsChecked: 1, topicChecks: 0, note: '' };
      return { queued: true, running: true };
    }
    if ((m = route.match(/^\/api\/bots\/([^/]+)\/memory\/forget$/)) && method === 'POST') {
      bot(m[1]);
      const term = String(body.term || '').trim();
      if (term.replace(/[^\p{L}]/gu, '').length < 3) throw bad('name a word of at least three letters to forget (60 characters at most)');
      lane().forgot.push(term);
      return { term, notebook_lines: 2, learned_facts: 1, about_lines: 0 };
    }
    return undefined;
  }

  return {
    read(route, query = {}) {
      if (!state.botsLive || !route.startsWith('/api/bots/')) return undefined;
      try { return read(route, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
    mutate(route, method, body = {}) {
      if (!state.botsLive || !route.startsWith('/api/bots/')) return undefined;
      try { return mutate(route, method, body || {}); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
  };
};
