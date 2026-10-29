// The Bots widgets and apps API (/api/bot-widgets), in memory, for the Electron checks (Phase 6 unit U2, 2026-10-29).
// ui-smoke.cjs consults every scripts/fixtures/bots-*-backend.cjs before demo/fixtures.js while demoState.botsLive is
// set: read(path, query) and mutate(path, method, body, query) answer a route or return undefined to let the demo have it.
// A check seeds state.botsWidgets itself and restores it when done; nothing is seeded here. The answers follow
// routes/bot_widget_routes.py (scripts/test_bots_widgets.py holds the real rules): a press with an old `rev` is 409, a repeat of
// the same `send_id` returns the first answer, an answered card refuses another answer, and an app page names its policy.
//
// state.botsWidgets = {
//   widgets: { [messageId]: { rev, refs: [ref], settled: null | { send_id, ref, result } } },
//   apps: { [messageId]: { latest, title, versions: [{ rev, html, at }] } },
//   presses: [body], rpcs: [{ messageId, method, params }], contexts: [{ messageId, text }], appReads: [{ messageId, rev }],
//   failNext: { status, detail } | null,     // the next press fails
//   appFail: { status, detail } | null }     // app page reads fail while set
const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; "
  + "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com; "
  + "font-src https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.gstatic.com; "
  + "img-src data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; media-src data: blob:; connect-src 'none'; "
  + "frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

module.exports = ({ state }) => {
  const store = () => state.botsWidgets;
  const refuse = (status, detail) => ({ _status: status, detail });

  return {
    read(route, query = {}) {
      if (!state.botsLive || !store()) return undefined;
      const m = route.match(/^\/api\/bot-widgets\/([^/]+)\/apps\/([^/]+)$/);
      if (!m) return undefined;
      const s = store();
      const id = decodeURIComponent(m[2]);
      (s.appReads ||= []).push({ messageId: id, rev: query.rev ? Number(query.rev) : null });
      if (s.appFail) return refuse(s.appFail.status || 404, s.appFail.detail || 'There is no app with that id.');
      const app = s.apps?.[id];
      if (!app) return refuse(404, 'There is no app with that id.');
      const want = query.rev ? Number(query.rev) : app.latest;
      const version = app.versions.find(v => v.rev === want);
      if (!version) return refuse(404, 'That version of the app is no longer kept.');
      return { rev: want, latest: app.latest, title: app.title, html: version.html, csp: CSP, sandbox: 'allow-scripts allow-forms', at: version.at,
        versions: app.versions.map(v => ({ rev: v.rev, at: v.at })) };
    },

    mutate(route, method, body = {}) {
      if (!state.botsLive || !store() || !route.startsWith('/api/bot-widgets/') || method !== 'POST') return undefined;
      const s = store();
      let m;
      if ((m = route.match(/^\/api\/bot-widgets\/([^/]+)\/press$/))) {
        (s.presses ||= []).push(body);
        if (s.failNext) { const failure = s.failNext; s.failNext = null; return refuse(failure.status || 500, failure.detail || 'That did not go through.'); }
        const widget = s.widgets?.[body.message_id];
        if (!widget) return refuse(404, 'That card is gone.');
        if (widget.settled && widget.settled.send_id === body.send_id) return widget.settled.result;
        if (body.rev !== widget.rev) return refuse(409, 'This card changed. Look at the new one.');
        if (widget.settled) return refuse(409, 'This card was already answered.');
        if (!widget.refs.includes(body.ref)) return refuse(400, 'That button is not on this card.');
        const result = { status: 'started', n: s.presses.length };
        widget.settled = { send_id: body.send_id, ref: body.ref, result };
        return result;
      }
      if ((m = route.match(/^\/api\/bot-widgets\/([^/]+)\/apps\/([^/]+)\/rpc$/))) {
        (s.rpcs ||= []).push({ messageId: decodeURIComponent(m[2]), method: body.method, params: body.params });
        if (!['ui/message', 'ui/update-model-context'].includes(body.method)) return refuse(400, 'That app call is not supported.');
        return { status: 'started' };
      }
      if ((m = route.match(/^\/api\/bot-widgets\/([^/]+)\/apps\/([^/]+)\/context$/))) {
        (s.contexts ||= []).push({ messageId: decodeURIComponent(m[2]), text: body.text });
        return { ok: true };
      }
      return undefined;
    },
  };
};
