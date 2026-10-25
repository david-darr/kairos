import { collectActivity } from './activityModel.js';
import * as chatStream from './chatStream.js';
import { createMascot, KAIROS_SPEC } from './mascot.js';
import { shortReading, PROVIDERS, SIGN_IN } from './quotaReadings.js';
import { kipStyleOf } from './kipStyle.js';
import { chatRows, taskRows } from './notchSteps.js';
import { createGlow } from './notchGlow.js';
import { approvalPanel, cliPanel, questionPanel, errorPanel, recoveringPanel, donePanel, createTakeover } from './notchPanels.js';
import { watchDrags, dropPanel } from './notchDrop.js';
import { createComposer } from './notchComposer.js';
import { ICONS } from './notchIcons.js';
import { modelLogo, logoRing } from './notchModelMarks.js';
import { createQuietView, createQuietData, layoutFor, workingAgents } from './notchQuiet.js';
import { createSideNotch, isSideEdge, sideCardAt } from './notchSide.js';

// The desktop notch, at the top centre or on the left or right edge. Phase 1:
// the shell and status. Phase 2 (Kairos Notch build spec, 4a): the step list,
// the panels that take over the Kip card, rail mode and the halftone glows.
// Phase 3: the drop zone and the quick composer. Round 6: model logos, the
// quiet view (fewer than two agents at work, nothing in flight) and the side
// notch. It never sends work by itself, and it answers a request only from a
// deliberate click on that request's panel, in every layout. Drawn to the
// Kairos Mobile v2 boards: NotchCollapsed, NotchWorking, NotchQuiet,
// NotchSide, NotchQuestion, NotchError, NotchDrop and NotchComposer.
const HEX = /^#[0-9a-f]{6}$/i;
// The expanded status row fits four readings in the 820 DIP panel beside its buttons.
const MAX_WORDS = 4;
const RING = 2 * Math.PI * 7.5;
const DONE_MS = 6000;
// chatStream.js's words for a turn the server lost in a restart.
const RESTARTED = 'The server restarted before this reply completed.';
const RECOVER_LINE = 'Kairos lost its place and is getting back on its feet.';

function build(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function dot(color, size) {
  const node = build('span', 'n-dot');
  node.style.setProperty('--dot', HEX.test(color || '') ? color : 'var(--n-watch)');
  if (size) node.style.setProperty('--size', size + 'px');
  return node;
}
// Below half the window the ring stays parchment; then gold, then ember at 80%.
function toneOf(used) { return used >= .8 ? 'var(--n-crit)' : used >= .5 ? 'var(--n-watch)' : 'var(--n-text)'; }
function headline(snap) { const ws = snap?.windows || []; return ws.find(w => w.id === 'session') || ws[0] || null; }
function percent(used) { return Math.round(Math.min(Math.max(used || 0, 0), 1) * 100); }

export function createNotchShell({ card, bridge, hideCard, renderReadings, refreshQuota }) {
  // An overlay document cached before round 6 can still contain the old handles.
  // Their SVG arcs have no size or hiding rules in the shell's stylesheet.
  for (const id of ['tail', 'move', 'orb', 'pill']) document.getElementById(id)?.remove();
  const shell = build('section'); shell.id = 'notch-shell'; shell.setAttribute('aria-label', 'Kairos notch');
  const kip = (size, id) => { const face = createMascot({ state: 'idle', size, spec: KAIROS_SPEC }); face.id = id; return face; };

  // Collapsed: Kip on its halo, then either the usage rings and agent dots
  // (resting) or the current line and its signal (working, needs you).
  const bar = build('div'); bar.id = 'notch-bar';
  const halo = build('span', 'n-halo');
  const face = kip(28, 'notch-kip');
  halo.append(face);
  const usage = build('span'); usage.id = 'notch-usage';
  const status = build('span'); status.id = 'notch-status';
  const signal = build('span'); signal.id = 'notch-signal';
  const cluster = build('span'); cluster.id = 'notch-cluster';
  bar.append(halo, usage, status, signal, cluster);

  // Expanded: the status row, then the Kip card (or a panel in its place),
  // the agent chips and the rail.
  const panel = build('div'); panel.id = 'notch-panel';
  const top = build('div', 'n-top');
  const side = createSideNotch({ shell, bridge, onNewChat: () => openComposer() });
  const button = (id, label, icon, tab) => {
    const b = build('button', 'n-ic'); if (id) b.id = id; b.setAttribute('aria-label', label); b.innerHTML = icon;
    b.addEventListener('click', e => { e.stopPropagation(); bridge.openApp?.(tab); }); return b;
  };
  const readings = build('span'); readings.id = 'notch-readings';
  // One New chat button in every layout; it opens the quick composer (phase 3).
  side.newChat.id = 'notch-new';
  top.append(button('notch-open', 'Open Kairos', ICONS.home), button('', 'Chats', ICONS.chats, 'chat'),
    button('', 'Settings', ICONS.settings, 'settings'), side.newChat, readings);
  const row = build('div', 'n-row');
  const now = build('div', 'n-now');
  const bigKip = kip(92, 'notch-kip-large');
  const lines = build('div', 'n-lines');
  const before = build('span', 'n-quiet'), current = build('span', 'n-current'), after = build('span', 'n-quiet');
  lines.append(before, current, after); now.append(bigKip, lines);
  const takeoverSlot = build('div', 'n-takeover'); takeoverSlot.id = 'notch-takeover'; takeoverSlot.hidden = true;
  const takeoverHost = build('div', 'n-takeover-host');
  takeoverSlot.append(takeoverHost);
  const chips = build('div', 'n-chips');
  const rail = build('div', 'n-rail');
  row.append(now, takeoverSlot, chips, rail);
  // With fewer than two agents at work and nothing in flight the quiet view takes the row's place; the side panel adds Up next and the quick actions.
  const quietData = createQuietData(() => { renderQuiet(); side.update(quietData.data.events); });
  const quiet = createQuietView({ bridge, bigKip, onNewChat: () => openComposer() });
  panel.append(top, row, quiet.node, side.next, side.actions);
  shell.append(bar, panel);
  document.getElementById('root').append(shell);

  const chats = new Map(), remote = { agents: [], inbox: { items: [], reviews: [] }, pending: [], devices: [] };
  let expanded = false, expandTimer = null, closeTimer = null, appearanceKey = '';
  let edge = 'top-centre', working = 0, busy = false, activityInfo = null;
  const reducedMotion = () => document.body.classList.contains('notch-reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  function setExpanded(value) {
    if (expanded === value) return;
    const from = shell.getBoundingClientRect();
    expanded = value; shell.classList.toggle('expanded', value);
    shell.setAttribute('aria-expanded', String(value));
    side.place(); if (value) quietData.refresh(true);
    shell.getAnimations().forEach(animation => animation.cancel());
    let morph;
    if (reducedMotion()) morph = shell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    else {
      // The boards' 230 ms spring from one size to the other.
      const to = shell.getBoundingClientRect(), w = r => (r.right - r.left) + 'px', h = r => (r.bottom - r.top) + 'px';
      morph = shell.animate([{ width: w(from), height: h(from) }, { width: w(to), height: h(to) }],
        { duration: 230, easing: 'cubic-bezier(.32,1.25,.5,1)' });
    }
    if (value) {
      takeover.revealed();
      // The cards take their full size once the morph lands; glows are drawn then.
      morph.finished.then(() => { if (expanded) paintGlows(); }, () => {});
    } else hideCard();
  }
  function reset() { clearTimeout(expandTimer); clearTimeout(closeTimer); expandTimer = closeTimer = null; setExpanded(false); }
  function hit(x, y, element) {
    const r = element.getBoundingClientRect();
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  }
  function hot(x, y) {
    if (document.body.classList.contains('notch-offline')) return false;
    return hit(x, y, document.body.classList.contains('folded') ? document.getElementById('rest') : shell)
      || (expanded && card.classList.contains('show') && hit(x, y, card));
  }
  // A panel being typed into keeps the notch open when the pointer leaves.
  const sticky = () => !!takeover.panel?.sticky?.() || drags.dragging || composer.open;
  function pointer(x, y) {
    const inside = hot(x, y);
    if (inside) {
      clearTimeout(closeTimer); closeTimer = null;
      if (!expanded && expandTimer === null) expandTimer = setTimeout(() => { expandTimer = null; setExpanded(true); }, 150);
    } else {
      clearTimeout(expandTimer); expandTimer = null;
      if (expanded && closeTimer === null && !sticky()) closeTimer = setTimeout(() => { closeTimer = null; if (!sticky()) setExpanded(false); }, 250);
    }
    return inside;
  }
  shell.addEventListener('click', () => setExpanded(true));

  // ---- Phase 2: what the live feed says, beyond the shared need/work model ----
  // live: session -> the turn as the step list and panels need it.
  // tasks: session -> its background items (bg_tasks). pairs: terminal pairings.
  const live = new Map(), tasks = new Map(), pairs = new Map(), dismissed = new Set(), cleared = new Set();
  let recent = null, quotas = [], hostFailures = 0, identity = { admin: false, signedIn: false }, preferred = null;
  const openChat = id => bridge.openChat?.(id);
  const deps = {
    post: (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    openChat, openApp: () => bridge.openApp?.('home'), focus: on => bridge.setFocus?.(!!on),
    // A dismissed or opened turn leaves the need list too, for good.
    dismiss: key => {
      dismissed.add(key);
      const [kind, id, turn] = key.split(':');
      if (['failed', 'recovering'].includes(kind)) { cleared.add(`${id}:${turn}`); chats.delete(id); }
      renderActivity();
    },
    reducedMotion,
  };
  const takeover = createTakeover(takeoverHost, takeoverSlot);
  const glows = { now: createGlow(now), takeover: createGlow(takeoverSlot), halo: createGlow(halo, { shape: 'halo', cell: 3 }) };
  let glowTone = '';
  function paintGlows() {
    const panelTone = takeover.panel?.glow;
    glows.now.set(glowTone); glows.takeover.set(panelTone || ''); glows.halo.set(panelTone || glowTone);
  }
  const TONE_OF = { thinking: 'gold', needs: 'gold', error: 'ember', success: 'sage', sleeping: '', idle: '' };

  // A turn that finished while this notch watched shows Done for 6 s.
  // (A failed one keeps its panel until dismissed or opened: wantedPanel.)
  function finished(id, entry, before) {
    if (before !== 'processing' || entry.status !== 'done') return;
    recent = { key: `done:${id}:${entry.turnId || entry.startedAt}`, title: entry.sessionTitle || 'Chat', sessionId: id, until: Date.now() + DONE_MS };
    setTimeout(renderActivity, DONE_MS + 50);
  }
  // ---- Phase 3: the drop zone and the quick composer ----
  const composer = createComposer({ bridge, post: deps.post, render: () => renderActivity(), isAdmin: () => identity.admin, reducedMotion,
    // After Send, the working panel follows that turn.
    onSent: sessionId => { preferred = sessionId; chatStream.sync().catch(() => {}); } });
  function openComposer() { if (!identity.signedIn) return; setExpanded(true); composer.openComposer(); }
  const drags = watchDrags({ pathFor: file => bridge.pathFor?.(file) || '',
    onChange: dragging => { if (dragging && identity.signedIn) setExpanded(true); renderActivity(); },
    onDrop: async ({ files, folders }) => {
      if (!identity.signedIn) return;
      if (files.length) await composer.addFiles(files);
      if (folders.length) await composer.addFolders(folders);
    } });
  // Clicking Kip opens the composer; the shell's own click only expands.
  for (const node of [face, bigKip]) node.addEventListener('click', event => { event.stopPropagation(); openComposer(); });
  // Clicking another window takes the keyboard there: the composer closes and keeps its draft.
  window.addEventListener('blur', () => { if (composer.open) composer.close(); });

  function wantedPanel() {
    if (drags.dragging && identity.signedIn) return { key: 'drop', make: dropPanel };
    for (const [id, request] of pairs) {
      if (request.expires_at && request.expires_at * 1000 < Date.now()) pairs.delete(id);
      else return { key: `cli:${id}`, make: () => cliPanel(request, deps) };
    }
    const folder = composer.folderWant();
    if (folder) return folder;
    for (const [id, turn] of live) {
      const request = turn.permission;
      if (turn.status !== 'processing' || !request?.id) continue;
      if (request.tool === 'kairos_cli_pair') return { key: `cli:${request.id}`, make: () => cliPanel(request, deps) };
      const context = { title: turn.title, sessionId: id };
      return request.kind === 'question'
        ? { key: `question:${request.id}`, make: () => questionPanel(request, context, deps) }
        : { key: `approval:${request.id}`, make: () => approvalPanel(request, context, deps) };
    }
    const compose = composer.want();
    if (compose) return compose;
    for (const [id, turn] of live) {
      if (turn.status !== 'failed' || turn.error === RESTARTED) continue;
      const key = `failed:${id}:${turn.turnId}`;
      if (!dismissed.has(key)) return { key, make: () => errorPanel({ key, title: `Couldn't finish ${turn.title}`,
        reason: 'The reply stopped before it finished.', note: 'Open the chat to retry it, or to try another model.', sessionId: id }, deps) };
    }
    for (const [sessionId, items] of tasks) for (const item of items) {
      const key = `task-failed:${item.id}`;
      if (item.status === 'failed' && !dismissed.has(key)) return { key, make: () => errorPanel({ key, title: `${item.label} couldn't finish`,
        reason: 'A background task stopped with an error.', note: 'Open the chat to see what it reached.', sessionId }, deps) };
    }
    for (const quota of quotas) {
      const name = PROVIDERS.find(p => p.id === quota.provider)?.name || 'A model';
      const key = `quota:${quota.provider}:${quota.status}`;
      if (quota.status === 'needs_sign_in' && !dismissed.has(key)) return { key, make: () => errorPanel({ key, title: `${name} needs a sign-in`,
        reason: 'Its usage stopped updating.', note: SIGN_IN[quota.provider] || '', retry: () => refreshQuota(quota.provider) }, deps) };
    }
    if (hostFailures === 1) {
      const key = 'host';
      if (!dismissed.has(key)) return { key, make: () => errorPanel({ key, title: "Kairos isn't answering",
        reason: 'Live updates stopped.', note: 'The notch keeps the last thing it saw.', retry: () => poll().then(() => hostFailures === 0) }, deps) };
    }
    for (const [id, turn] of live) {
      if ((turn.status === 'processing' && turn.connected === false) || (turn.status === 'failed' && turn.error === RESTARTED)) {
        const key = `recovering:${id}:${turn.turnId}`;
        if (!dismissed.has(key)) return { key, make: () => recoveringPanel({ key, line: RECOVER_LINE, sessionId: id }, deps) };
      }
    }
    for (const quota of quotas) {
      const name = PROVIDERS.find(p => p.id === quota.provider)?.name || 'A model';
      const key = `paused:${quota.provider}`;
      if (quota.status === 'rate_limited' && !dismissed.has(key)) return { key, make: () => recoveringPanel({ key,
        line: `${name} asked for a pause. Kairos will read its usage again shortly.` }, deps) };
    }
    if (recent && recent.until > Date.now() && !dismissed.has(recent.key)) {
      const done = recent;
      return { key: done.key, make: () => donePanel(done, deps) };
    }
    return null;
  }
  // The step list: the focused chat's turn, else a running background task.
  function steps(focus) {
    // The turn just sent from the composer, while it runs; then the focus.
    if (preferred && live.get(preferred)?.status !== 'processing' && live.has(preferred)) preferred = null;
    const id = preferred && live.has(preferred) ? preferred : focus?.sessionId;
    const turn = id ? live.get(id) : null;
    if (turn?.status === 'processing') return chatRows(turn.entry, tasks.get(id) || []);
    for (const [sessionId, items] of tasks) {
      const running = items.find(item => item.status === 'running' || item.status === 'waiting');
      if (running) return { ...taskRows(running, items), sessionId };
    }
    return null;
  }
  function stepTo(node, text) {
    if (node.textContent === text) return;
    node.textContent = text;
    if (!text || reducedMotion() || !expanded) return;
    // The incoming row rises 8 px as it fades in (spec 4a, Motion: step change).
    node.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  let idleSince = Date.now(), signature = '';
  function chipFor(agent, state, open, sessionId) {
    const chip = build(open ? 'button' : 'span', 'n-chip');
    if (sessionId) chip.dataset.session = sessionId;
    chip.dataset.tone = state === 'resting' ? 'rest' : 'live';
    if (HEX.test(agent.color || '')) chip.style.setProperty('--tint', agent.color);
    chip.append(dot(agent.color, 12), build('span', 'n-chip-text', `${agent.name || 'Agent'}: ${state}`));
    if (open) { chip.type = 'button'; chip.addEventListener('click', event => { event.stopPropagation(); open(); }); }
    return chip;
  }
  function renderActivity() {
    const { need, work } = collectActivity({ chats, remote });
    if (need.length || work.length) idleSince = Date.now();
    const aggregate = need.some(item => item.status === 'error' || item.status === 'failed') ? 'error'
      : need.length || work.some(item => item.needsYou) ? 'needs' : work.length ? 'thinking' : Date.now() - idleSince >= 600000 ? 'sleeping' : 'idle';
    const active = takeover.show(wantedPanel());
    const state = active ? active.kip : aggregate;
    for (const mascot of [face, bigKip]) if (mascot.getAttribute('state') !== state) mascot.setAttribute('state', state);
    shell.dataset.state = state;
    shell.dataset.panel = active?.kind || '';
    if (row.classList.contains('n-rail-mode') !== !!active) {
      row.classList.toggle('n-rail-mode', !!active);
      // Chips to rail, or back: the card that takes the room grows in over 250 ms.
      if (expanded && !reducedMotion()) (active ? takeoverSlot : now).animate([{ opacity: 0, transform: 'scaleX(.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 250, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    const waiting = [...need, ...work.filter(item => item.needsYou)];
    const focus = waiting[0] || work[0] || null;
    const words = item => item.kind === 'chat' ? (item.status === 'processing' ? `${item.title} needs you` : `${item.title} ${item.detail.split('· ')[1] || ''}`.trim()) : item.title;

    // Collapsed status line and its signal: a gold point, or the count of what
    // waits; a panel with nothing waiting (an error, done) reads its own line.
    status.textContent = active ? active.node.getAttribute('aria-label') : focus ? (waiting.length ? words(focus) : focus.title) : '';
    signal.replaceChildren(...(waiting.length ? [build('span', 'n-count', String(waiting.length))] : work.length || active ? [dot('', 8)] : []));

    // Kip card: the focused turn's real steps; otherwise what the focused item
    // says about itself, and how much else is waiting.
    const rows = steps(focus);
    if (rows) {
      stepTo(before, rows.before); stepTo(current, rows.current); stepTo(after, rows.after);
      current.classList.add('n-shimmer');
    } else if (focus) {
      current.classList.remove('n-shimmer');
      stepTo(before, focus.detail || '');
      stepTo(current, focus.title); // the detail line above already says it waits for you
      const more = need.length + work.length - 1;
      stepTo(after, more > 0 ? `${more} more in Kairos` : 'Open Kairos for details');
    } else {
      current.classList.remove('n-shimmer');
      stepTo(before, state === 'sleeping' ? 'Resting' : 'All quiet');
      stepTo(current, 'Nothing running');
      stepTo(after, remote.agents.length ? `${remote.agents.length} agent${remote.agents.length === 1 ? '' : 's'} on call` : 'Start a chat from Kairos');
    }
    glowTone = TONE_OF[aggregate] || '';
    paintGlows();

    // Agents: dots when collapsed, chips and the rail when expanded. Each shows
    // once, with what the shared need/work model says it is doing; running
    // background items join the chips. A chip opens its agent or chat.
    const doing = new Map();
    for (const item of [...work, ...need]) if (item.agent && !doing.has(item.agent.id))
      doing.set(item.agent.id, need.includes(item) || item.needsYou ? 'needs you' : (item.detail || 'working').toLowerCase());
    // Fewer than two agents at work and no panel or turn in flight: the quiet view; otherwise the Kip card, chips and rail.
    // The side panel always stacks both.
    working = workingAgents(work);
    busy = !!active || !!rows;  // a panel or a turn in flight keeps the Kip card in view
    activityInfo = { state, focus, agents: remote.agents, doing };
    applyLayout(); renderQuiet();
    const agents = remote.agents.slice(0, 4);
    const background = [...tasks].flatMap(([sessionId, items]) => items.filter(item => item.status === 'running').map(item => ({ ...item, sessionId })));
    const next = JSON.stringify([agents.map(a => [a.id, a.name, a.color, doing.get(a.id)]), remote.agents.length, work.filter(i => !i.agent).map(i => i.title),
      background.map(item => [item.id, item.label])]);
    if (next !== signature) {
      signature = next;
      cluster.replaceChildren(...agents.map(agent => dot(agent.color, 8)));
      if (remote.agents.length > 4) cluster.append(build('span', 'n-more', `+${remote.agents.length - 4}`));
      cluster.setAttribute('aria-label', `${remote.agents.length} agents, ${doing.size ? `${doing.size} active` : 'idle'}`);
      // Running work first, then the agents at rest, four at most.
      const agentChip = agent => chipFor(agent, doing.get(agent.id) || 'resting', () => bridge.openAgent?.(agent.id));
      const list = [...agents.filter(agent => doing.has(agent.id)).map(agentChip),
        ...background.map(item => chipFor({ name: item.label }, 'running', () => openChat(item.sessionId), item.sessionId)),
        ...work.filter(item => !item.agent).map(item => chipFor({ name: item.title }, 'working', item.sessionId ? () => openChat(item.sessionId) : null, item.sessionId)),
        ...agents.filter(agent => !doing.has(agent.id)).map(agentChip)].slice(0, 4);
      chips.replaceChildren(...(list.length ? list : [build('span', 'n-empty', 'No agents yet')]));
      rail.replaceChildren(...agents.map(agent => { const d = dot(agent.color, 14); d.classList.toggle('n-dim', !doing.has(agent.id)); return d; }));
      rail.setAttribute('aria-label', `Agents: ${doing.size} running`);
      rail.hidden = !agents.length;
    }
  }
  function applyLayout() {
    const layout = isSideEdge(edge) ? 'side' : busy ? 'agents' : layoutFor(working);
    if (panel.dataset.layout === layout) return;
    panel.dataset.layout = layout;
    if (layout === 'quiet') quiet.holdKip(); else now.prepend(bigKip);
    if (expanded) paintGlows();
  }
  function renderQuiet() {
    if (activityInfo) quiet.update(activityInfo, quietData.data);
  }
  chatStream.subscribeAll((id, entry) => {
    const before = live.get(id)?.status;
    if (entry) {
      if (cleared.has(`${id}:${entry.turnId}`)) chats.delete(id);
      else chats.set(id, { title: entry.sessionTitle || 'Chat', status: entry.status, permission: !!entry.permission, text: !!entry.text });
      live.set(id, { title: entry.sessionTitle || 'Chat', status: entry.status, permission: entry.permission || null, error: entry.error || null,
        connected: entry.connected, turnId: entry.turnId, entry: { toolSteps: [...(entry.toolSteps || [])], text: entry.text || '', permission: entry.permission || null } });
      finished(id, entry, before);
    } else {
      if (chats.get(id)?.status === 'processing') chats.delete(id);
      // A failed or restarted turn keeps its panel until dismissed; the rest go.
      if (live.get(id)?.status !== 'failed') live.delete(id);
    }
    renderActivity();
  });
  document.addEventListener('kairos:bg-tasks', event => {
    const { sessionId, items } = event.detail || {};
    if (!sessionId) return;
    const before = new Map((tasks.get(sessionId) || []).map(item => [item.id, item.status]));
    tasks.set(sessionId, Array.isArray(items) ? items : []);
    for (const item of tasks.get(sessionId)) if (item.status === 'done' && ['running', 'waiting'].includes(before.get(item.id))) {
      recent = { key: `task-done:${item.id}`, title: item.label, sessionId, until: Date.now() + DONE_MS };
      setTimeout(renderActivity, DONE_MS + 50);
    }
    renderActivity();
  });
  // Terminal pairings ride the feed to the app window, and the notch shares
  // its cookie; the notch shows them only as "Open Kairos" (spec section 6).
  document.addEventListener('kairos:cli-pair', event => { if (event.detail?.id) { pairs.set(event.detail.id, event.detail); renderActivity(); } });
  document.addEventListener('kairos:cli-pair-closed', event => { pairs.delete(event.detail?.id); renderActivity(); });
  chatStream.connect().catch(() => {});
  const denied = new Set();
  async function read(key, url, apply) {
    if (denied.has(key)) return;
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if ([401, 403, 404].includes(response.status)) { denied.add(key); return; }
      if (response.ok) apply(await response.json());
    } catch { /* Preserve the last aggregate on a temporary connection failure. */ }
  }
  async function poll() {
    await Promise.all([
      read('agents', '/api/agents', data => { remote.agents = Array.isArray(data) ? data : []; }),
      read('inbox', '/api/agents/inbox', data => { remote.inbox = { items: data.items || [], reviews: data.reviews || [] }; }),
      read('triggers', '/api/triggers', data => { remote.pending = data.pending || []; }),
      read('devices', '/api/notifications', data => { remote.devices = data.devices || []; }),
      // One missed snapshot shows "Kairos isn't answering" with a reconnect;
      // a second hides the notch, as when the host is down.
      chatStream.sync().then(() => { hostFailures = 0; shell.dataset.connection = 'connected'; document.body.classList.remove('notch-offline'); })
        .catch(() => {
          hostFailures += 1; shell.dataset.connection = 'reconnecting';
          if (hostFailures >= 2) { document.body.classList.add('notch-offline'); bridge.setInteractive?.(false); reset(); }
        }),
    ]);
    renderActivity(); quietData.refresh();
  }
  function applyAppearance() {
    let settings = {};
    try { settings = JSON.parse(localStorage.getItem(appearanceKey) || '{}'); } catch { /* Defaults. */ }
    const style = kipStyleOf(settings), mascot = style !== 'hidden';
    shell.classList.toggle('hide-kip', !mascot);
    document.documentElement.dataset.mascot = mascot ? 'on' : 'off';
    document.documentElement.dataset.kip = style;
    document.dispatchEvent(new CustomEvent('kairos:appearance'));
    document.body.classList.toggle('notch-reduced', settings.motion === false);
    for (const node of [face, bigKip]) node.toggleAttribute('still', settings.motion === false);
    const color = HEX.test(settings.color || '') ? settings.color : getComputedStyle(document.documentElement).getPropertyValue('--k-parchment').trim();
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    document.body.classList.toggle('notch-light', settings.mode !== 'color' || rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 128);
  }
  read('identity', '/api/auth/status', data => {
    identity = { admin: !!data.is_admin, signedIn: !!data.username };
    appearanceKey = 'jarvis:appearance:v1:' + (data.username || 'local'); applyAppearance();
  });
  window.addEventListener('storage', event => { if (event.key === appearanceKey) applyAppearance(); });
  poll(); const timer = setInterval(poll, 15000); // Snapshot fallback while SSE reconnects; also refresh bot/inbox sources.
  window.addEventListener('pagehide', () => { clearInterval(timer); reset(); }, { once: true });
  applyAppearance(); renderActivity(); renderReadings();
  // The tooltip, and the screen-reader name, of a model's logo.
  const labelled = (node, name, label) => { node.title = name; node.setAttribute('aria-label', label); return node; };
  return { hot, pointer, reset, isExpanded: () => expanded,
    // Raw provider statuses (core/quota_usage.py): sign-in errors and pauses.
    quota(providers = []) { quotas = providers.map(p => ({ provider: p.provider, status: p.status })); renderActivity(); },
    // Which edge the notch is on and how far along it (the side notch only has a place along its edge).
    setEdge(value, offset) { edge = value; side.setEdge(value, offset); applyLayout(); },
    // Where the usage card goes beside the side panel, level with the reading hovered.
    cardAt(wordRect, cardSize) {
      return sideCardAt(edge, shell.getBoundingClientRect(), wordRect, cardSize, { width: innerWidth, height: innerHeight });
    },
    readings(providers, groups = []) {
    // Logos, not names: the name is the tooltip and the aria-label. Collapsed: a
    // ring with the model's logo inside and the percentage beside it for each
    // subscription quota, then the next logo and "+N" for the other connected
    // models. Expanded: every model's logo and short reading ("5h 34%", "2.1K
    // today"), each opening its usage card on hover; past MAX_WORDS the last
    // place is "+N", whose card lists them all.
    const rings = [];
    for (const provider of providers) {
      const h = headline(provider.snap), signedOut = provider.snap?.status === 'needsAuth';
      const pct = h && !signedOut ? `${percent(h.used)}%` : signedOut ? 'sign in' : '…';
      const ring = labelled(build('span', 'n-reading'), provider.name, signedOut ? `${provider.name}, sign in to see usage` : `${provider.name} ${pct} used`);
      ring.style.setProperty('--arc', h ? toneOf(h.used) : 'var(--n-text)');
      ring.append(logoRing(provider, h && !signedOut ? h.used : 0), build('span', 'n-pct', pct));
      rings.push(ring);
    }
    const others = groups.filter(group => !providers.some(provider => provider.id === group.id));
    if (others.length) {
      const more = labelled(build('span', 'n-models'), others.map(group => group.name).join(', '), `${others.length} more model${others.length === 1 ? '' : 's'}: ${others.map(group => group.name).join(', ')}`);
      more.append(modelLogo(others[0], 14), build('span', '', `+${others.length}`));
      rings.push(more);
    }
    const shown = groups.length > MAX_WORDS ? groups.slice(0, MAX_WORDS - 1) : groups;
    const words = shown.map(group => {
      const reading = shortReading(group).replace(/ tokens (today|this week)$/, ' $1');
      const word = labelled(build('span', 'n-word'), group.name, `${group.name} usage, ${reading}. Hover for details.`);
      word.dataset.p = group.id;
      word.append(modelLogo(group, 14), build('span', 'n-word-text', reading));
      return word;
    });
    if (shown.length < groups.length) {
      const all = build('span', 'n-word n-word-more', `+${groups.length - shown.length}`);
      all.dataset.p = 'all';
      all.setAttribute('aria-label', `${groups.length - shown.length} more models. Hover to see all ${groups.length}.`);
      words.push(all);
    }
    usage.replaceChildren(...rings); readings.replaceChildren(...words);
    quiet.usage(providers, quietData.data);
  } };
}
