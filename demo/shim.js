// The website's live demo (docs/demo): lets the real Kairos interface run on
// a static site, or straight from disk, with no server and no service worker.
// It loads before the app's bundle and, inside this page only,
// - answers fetch("/api/...") from the sample data in fixtures.js (the same
//   data scripts/ui-smoke.cjs tests against), keeping changes in memory,
// - plays a short scripted reply when a chat message is sent,
// - stands in for the Swarm event stream, which has nothing to say here,
// - shows computer use: a sample frame, Take over, recording and skill review,
//   and a chat that "opens a website" when asked to.
// Nothing leaves the visitor's browser and no model is ever called.
(function () {
  // Device sign-in, model setup/install progress and public submissions are
  // synthetic in-memory fixtures. Vendor apps never launch in the demo.
  const state = { empty: false, githubSignedIn: false, githubConfigured: true };
  const { fixture, data, mutate, media } = window.kairosFixtures({ state, demo: true });
  const store = { sessions: {}, nextId: 1 };  // chats started in the demo
  const realFetch = window.fetch.bind(window);
  // The app watches server-owned turns now (2026-10-15). Keep the same
  // revisioned feed in memory so navigation and Stop work in the static demo.
  const liveRuns = {}, liveClients = new Set();
  let nextTurn = 1;
  const snapshot = () => ({ type: 'snapshot', runs: structuredClone(liveRuns) });
  function broadcast(packet) {
    for (const client of liveClients) client.send(packet);
  }
  function liveChange(id, changes) {
    const run = liveRuns[id];
    Object.assign(run, changes); run.revision++;
    broadcast({ type: 'update', sessionId: id, turnId: run.turnId, revision: run.revision, changes });
  }

  // The fixtures name the sample frame by the app's absolute path; the demo
  // serves it relative to its own folder (it may be opened from disk).
  const relative = (text) => text.split('"/static/img/computer-fixture.jpg"').join('"static/img/computer-fixture.jpg"');
  const json = (body, status = 200) => new Response(relative(JSON.stringify(body)), { status, headers: { "Content-Type": "application/json" } });

  // The app asks for absolute paths ("/api/notes"). From disk those resolve to
  // file:///api/notes, and on GitHub Pages to the site's root, so the route is
  // read from the path the app asked for, not from where it would resolve.
  function route(input) {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    if (typeof raw !== "string") return null;
    const url = new URL(raw, location.href);
    const at = url.pathname.search(/\/(api|generated-files)\//);
    return at < 0 ? null : new URL(url.pathname.slice(at) + url.search, "http://demo");
  }

  window.fetch = async function (input, init = {}) {
    const url = route(input);
    if (!url) return realFetch(input, init);
    const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname.startsWith("/generated-files/")) {
      return new Response("# Project brief\n\nA sample file from the Kairos demo.\n", { headers: { "Content-Type": "text/markdown" } });
    }
    if (method === 'GET' && /\/terminals\/[^/]+\/output$/.test(url.pathname)) {
      const encoder = new TextEncoder(); let timer, ended = false;
      const stop = () => { ended = true; clearInterval(timer); };
      return new Response(new ReadableStream({ start(controller) {
        let cursor = Number(url.searchParams.get('after') || 0);
        const send = () => {
          if (ended) return;
          url.searchParams.set('after', String(cursor));
          const result = fixture(url);
          for (const event of result.events) { cursor = event.id; controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify({ output: event.data })}\n\n`)); }
          if (result.ended) { controller.enqueue(encoder.encode('event: closed\ndata: {}\n\n')); stop(); controller.close(); }
        };
        timer = setInterval(send, 50); send();
        init.signal?.addEventListener('abort', () => { if (!ended) { stop(); controller.close(); } }, { once: true });
      }, cancel: stop }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return api(url, method, init.body);
  };

  // Live streams: a computer's live view sends its sample frame once a second
  // until the computer is stopped; anything else (Swarm events) has nothing to
  // say and reports itself closed, as the browser does when a server ends one.
  window.EventSource = class DemoEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url); this.readyState = 2; this.withCredentials = false;
      this.onopen = this.onmessage = this.onerror = null;
      const frames = route(this.url);
      if (frames?.pathname === '/api/chat/live/events') {
        this.readyState = 1;
        liveClients.add(this);
        setTimeout(() => this.send(snapshot()), 0);
      } else if (frames && /^\/api\/computer\/[^/]+\/frames$/.test(frames.pathname)) {
        this.readyState = 1;
        const send = () => {
          const frame = fixture(frames);
          if (!frame.owner) { this.close(); this.dispatchEvent(new MessageEvent("closed", { data: "{}" })); return; }
          this.dispatchEvent(new MessageEvent("frame", { data: relative(JSON.stringify(frame)) }));
        };
        this.timer = setInterval(send, 1000);
        setTimeout(send, 0);
      }
    }
    send(packet) {
      if (this.readyState !== 1) return;
      const event = new MessageEvent('message', { data: relative(JSON.stringify(packet)) });
      this.dispatchEvent(event); this.onmessage?.(event);
    }
    close() { this.readyState = 2; clearInterval(this.timer); liveClients.delete(this); }
  };
  Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });

  async function api(url, method, rawBody) {
    const path = url.pathname;
    if (method === "GET") {
      if (path === '/api/chat/live/snapshot') return json(snapshot());
      const file = media(url);
      if (file) return new Response(file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : file.body,
        { headers: { 'Content-Type': file.type } });
      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && state.handoffSessions?.[sessionMatch[1]]) return json(fixture(url));
      if (sessionMatch && store.sessions[sessionMatch[1]]) return json(store.sessions[sessionMatch[1]]);
      if (path.match(/^\/api\/sessions\/([^/]+)\/context$/) && store.sessions[path.split("/")[3]]) return json({ available: false });
      try { return json(fixture(url)); } catch (_) { return json({ detail: "Not available in the demo" }, 404); }
    }
    let body = {};
    try { if (typeof rawBody === "string") body = JSON.parse(rawBody); } catch (_) { /* not JSON */ }
    if (path === '/api/chat/live/stop') {
      const active = liveRuns[body.session_id]?.status === 'processing';
      if (active) {
        // Save before notifying viewers: their next history read must not
        // replace the stopped partial reply with the full scripted text.
        const session = store.sessions[body.session_id] || data.forgeSessions[body.session_id];
        const saved = session?.messages.at(-1);
        if (saved?.role === 'assistant') Object.assign(saved, { content: liveRuns[body.session_id].text, status: 'interrupted' });
        if (state.computerChat === body.session_id) {
          state.stoppedOwners ||= []; state.stoppedOwners.push('chat:' + body.session_id);
        }
        liveChange(body.session_id, { status: 'stopped', stopping: false, permission: null });
      }
      return json({ stopping: active });
    }
    if (path === "/api/settings/computer-use") { state.computerUse = body; return json({ ok: true }); }
    const workspaceMatch = path.match(/^\/api\/sessions\/([^/]+)\/workspace$/);
    if (workspaceMatch) {
      if (store.sessions[workspaceMatch[1]]) store.sessions[workspaceMatch[1]].workspace_dir = body.path;
      return json({ workspace_dir: body.path });
    }
    if (['/api/chat/stream', '/api/chat/live'].includes(path) && body.references?.some(ref => ref.kind === 'agent') && store.sessions[body.session_id]) {
      state.handoffSessions ||= {};
      state.handoffSessions[body.session_id] ||= store.sessions[body.session_id];
    }
    // Community installs and refresh use the same fixtures as desktop/phone smoke.
    const updated = mutate(path === '/api/chat/live' ? '/api/chat/stream' : path, method, body, Object.fromEntries(url.searchParams));
    if (path === '/api/chat/live') {
      if (updated?._status) return json(updated, updated._status);
      return startLive(body, updated);
    }
    if (updated?._appStart) {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ async start(controller) {
        const send = packet => controller.enqueue(encoder.encode(`data: ${JSON.stringify(packet)}\n\n`));
        send(updated._appStart);
        if (updated._appStart.permission) {
          const request = updated._appStart.permission;
          while (!state.forgeAppAnswers[request.id]) await new Promise(resolve => setTimeout(resolve, 50));
          send(state.forgeAppAnswers[request.id] === 'once' ? mutate(updated._approvedPath || path.replace(/\/(start|restart)$/, '/approved'), 'POST', {})._appStart : { error: 'The action was not approved.' });
        }
        controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (updated?.handoffs) {
      // Let the visitor see queued, working and the returned agent reply.
      setTimeout(() => { state.handoffStatus = 'working'; }, 1200);
      setTimeout(() => { state.handoffStatus = 'done'; }, 4500);
      return new Response(`data: ${JSON.stringify(updated)}\n\ndata: {"done":true}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (updated?._forgePackets) return reply(body, updated);
    if (updated) { const { _status = 200, ...payload } = updated; return json(payload, _status); }
    if (path === "/api/sessions" && method === "POST") {
      const id = "demo" + store.nextId++;
      const now = Date.now() / 1000;
      const session = { id, title: "New chat", created_at: now, updated_at: now, model_endpoint_id: "m1", messages: [] };
      store.sessions[id] = session;
      data.sessions.unshift({ id, title: session.title, updated_at: now });
      return json(session);
    }
    if (path === "/api/chat/stream" && method === "POST") return reply(body);
    if (path === "/api/notes" && method === "POST") {
      const note = { id: "demo-note-" + store.nextId++, text: body.text || "New note", completed: false, due_date: body.due_date || null };
      data.notes.unshift(note);
      return json(note);
    }
    const noteMatch = path.match(/^\/api\/notes\/([^/]+)$/);
    if (noteMatch) {
      const index = data.notes.findIndex((n) => n.id === noteMatch[1]);
      if (method === "DELETE" && index >= 0) data.notes.splice(index, 1);
      else if (index >= 0) Object.assign(data.notes[index], body);
      return json(index >= 0 ? data.notes[index] || { ok: true } : { ok: true });
    }
    const modelMatch = path.match(/^\/api\/sessions\/([^/]+)\/model$/);
    if (modelMatch) {
      if (store.sessions[modelMatch[1]]) Object.assign(store.sessions[modelMatch[1]], {
        model_endpoint_id: body.model_endpoint_id, model_override: body.model_override ?? null, model_effort: body.effort ?? null,
      });
      return json({ ok: true, model_override: body.model_override ?? null, effort: body.effort ?? null });
    }
    return json({ ok: true });
  }

  const REPLY = "*Demo reply.* This is the Kairos interface running on sample data, so no model answered you. "
    + "In the app, your message goes to the model you choose (Claude, Codex, a local model or any API), "
    + "with your vault, notes and tools at hand. Have a look around the other tabs, then download Kairos to try it for real.";

  function startLive(body, updated) {
    const id = body.session_id;
    if (liveRuns[id]?.status === 'processing') return json({ detail: 'This chat already has a response in progress' }, 409);
    const run = liveRuns[id] = { turnId: 'demo-turn-' + nextTurn++, sessionTitle: 'Chat', prompt: body.message,
      text: '', startedAt: Date.now() / 1000, status: 'processing', stopping: false, permission: null,
      toolEvents: [], toolSteps: [], handoffs: null, runId: null, error: null, revision: 1 };
    broadcast({ type: 'started', sessionId: id, run });
    // Reuse the scripted stream, including Forge and computer activity, so
    // the old request and the shared feed cannot acquire different replies.
    setTimeout(async () => {
      if (updated?.handoffs) {
        liveChange(id, { handoffs: updated.handoffs, status: 'done' });
        setTimeout(() => { state.handoffStatus = 'working'; }, 1200);
        setTimeout(() => { state.handoffStatus = 'done'; }, 4500);
        return;
      }
      const reader = reply(body, updated?._forgePackets ? updated : null).body.getReader();
      const decoder = new TextDecoder(); let pending = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (run.status !== 'processing') { await reader.cancel(); break; }
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 2);
            if (!line.startsWith('data: ')) continue;
            const packet = JSON.parse(line.slice(6));
            if (packet.run_id) liveChange(id, { runId: packet.run_id });
            for (const type of ['tool_event', 'tool_step']) if (packet[type]) {
              run[type === 'tool_event' ? 'toolEvents' : 'toolSteps'].push(packet[type]); run.revision++;
              broadcast({ type, sessionId: id, turnId: run.turnId, revision: run.revision, value: packet[type] });
            }
            if (packet.chunk) {
              run.text += packet.chunk; run.revision++;
              broadcast({ type: 'chunk', sessionId: id, turnId: run.turnId, revision: run.revision, chunk: packet.chunk });
            }
            if (packet.done) liveChange(id, { status: 'done' });
          }
        }
      } catch (error) {
        if (run.status === 'processing') liveChange(id, { status: 'failed', error: String(error) });
      } finally {
        const session = store.sessions[id] || data.forgeSessions[id];
        const saved = session?.messages.at(-1);
        if (saved?.role === 'assistant') Object.assign(saved, { content: run.text,
          ...(run.status === 'stopped' ? { status: 'interrupted' } : {}) });
      }
    }, 0);
    return json({ turn_id: run.turnId });
  }

  function reply(body, forgeTurn = null) {
    const session = store.sessions[body.session_id] || data.forgeSessions[body.session_id];
    const now = Date.now() / 1000;
    // Asked to open or visit a website, the reply shows the computer at work.
    const usesComputer = /\b(?:open|browse|visit|website|computer)\b/i.test(body.message || "");
    if (usesComputer) {
      state.computerChat = body.session_id;
      state.stoppedOwners = (state.stoppedOwners || []).filter((owner) => owner !== "chat:" + body.session_id);
    }
    if (session) {
      session.messages.push({ role: "user", content: String(body.message || ""), ts: now });
      session.messages.push({ role: "assistant", content: REPLY, ts: now + 1, ...(forgeTurn ? { run_id: forgeTurn.run_id } : usesComputer ? { run_id: "r-computer" } : {}) });
      if (session.title === "New chat") session.title = String(body.message || "New chat").slice(0, 48);
      const listed = data.sessions.find((s) => s.id === session.id);
      if (listed) { listed.title = session.title; listed.updated_at = now; }
    }
    const words = REPLY.split(/(?<= )/);
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream({
      async start(controller) {
        for (const packet of forgeTurn?._forgePackets || []) {
          if (cancelled) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(packet)}\n\n`));
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        const computerEvent = (kind, detail) => controller.enqueue(encoder.encode(relative(`data: ${JSON.stringify({
          run_id: "r-computer", tool_event: { at: now, kind, name: "computer", ok: true, detail: JSON.stringify(detail) } })}\n\n`)));
        if (usesComputer) {
          computerEvent("tool_started", { action: "open", url: "https://example.com/" });
          computerEvent("tool_finished", { action: "open", url: "https://example.com/", image_url: "static/img/computer-fixture.jpg" });
        }
        for (const word of words) {
          if (cancelled) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: word })}\n\n`));
          await new Promise((r) => setTimeout(r, 28));
        }
        if (cancelled) return;
        if (usesComputer) {
          state.stoppedOwners ||= []; state.stoppedOwners.push("chat:" + body.session_id);
          computerEvent("tool_finished", { action: "done", url: "https://example.com/" });
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        controller.close();
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const badge = document.createElement("div");
    badge.className = "demo-badge";
    badge.textContent = "Demo · sample data · nothing leaves your browser";
    document.body.append(badge);
  });
})();
