// Notes and Email writes for scripts/g4-checks.cjs, kept out of demo/fixtures.js (the site demo is built from that file).
// ui-smoke.cjs consults this first while demoState.g4Live is set; everything else is untouched.
module.exports = ({ state, notes }) => {
  const failing = (list, id) => (list || []).includes(id);
  return {
    read(route) {
      if (route === '/api/email/accounts') return state.g4Accounts || [];
      if (route === '/api/email/triage' && state.g4Triaged) return { generated_at: Date.now() / 1000, scanned: 3, items: [{ subject: 'Invoice due Friday', from: 'billing@example.test', reason: 'A payment deadline.' }] };
      return undefined;
    },
    mutate(route, method, body) {
      const noteRoute = route.match(/^\/api\/notes(?:\/([^/]+))?$/);
      if (noteRoute) {
        const id = noteRoute[1];
        if (!id && method === 'POST') { const n = { id: 'g4-' + (notes.length + 1), completed: false, ...body }; notes.push(n); return n; }
        if (id && failing(state.g4FailNotes, id)) return { _status: 500, detail: 'Note service unavailable' };
        const at = notes.findIndex(n => n.id === id);
        if (id && method === 'PATCH' && at >= 0) return Object.assign(notes[at], body);
        if (id && method === 'DELETE') { if (at >= 0) notes.splice(at, 1); return { ok: true }; }
      }
      const accountRoute = route.match(/^\/api\/email\/accounts(?:\/([^/]+)(?:\/(test))?)?$/);
      if (accountRoute) {
        state.g4Accounts ||= [];
        if (!accountRoute[1] && method === 'POST') { const { password, ...rest } = body; const a = { id: 'mail-' + (state.g4Accounts.length + 1), ...rest }; state.g4Accounts.push(a); return a; }
        if (accountRoute[2] === 'test') return state.g4Test || { imap: true, smtp: false, imap_error: null, smtp_error: 'Authentication failed' };
        if (accountRoute[1] && method === 'DELETE') { state.g4Accounts = state.g4Accounts.filter(a => a.id !== accountRoute[1]); return { ok: true }; }
      }
      if (route === '/api/email/triage/run' && method === 'POST') {
        if (state.g4TriageFail) return { _status: 502, detail: 'triage failed: provider unavailable' };
        state.g4Triaged = true; return { summary: 'Scanned 3 unread, 1 important.' };
      }
      return undefined;
    },
  };
};
