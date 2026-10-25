import { collectActivity } from './activityModel.js';
import * as chatStream from './chatStream.js';
import { createMascot, KAIROS_SPEC } from './mascot.js';
import { shortReading } from './quotaReadings.js';
import { kipStyleOf } from './kipStyle.js';
import { ICONS } from './notchIcons.js';
import { modelLogo, logoRing } from './notchModelMarks.js';
import { createQuietView, createQuietData, layoutFor, workingAgents } from './notchQuiet.js';
import { createSideNotch, isSideEdge, sideCardAt } from './notchSide.js';

// Phase 1 owns only the shell and status. It never answers or sends work.
// Drawn to the Kairos Mobile v2 boards: NotchCollapsed (resting, working,
// needs you), NotchWorking (expanded), NotchQuiet (expanded with fewer than two
// agents at work) and NotchSide (the same notch on the left or right edge).
const HEX = /^#[0-9a-f]{6}$/i;
// The expanded status row fits four readings in the 820 DIP panel beside its buttons.
const MAX_WORDS = 4;
const RING = 2 * Math.PI * 7.5;

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

export function createNotchShell({ pill, card, bridge, hideCard, renderRing }) {
  const shell = build('section'); shell.id = 'notch-shell'; shell.setAttribute('aria-label', 'Kairos notch');
  const kip = (size, id) => { const face = createMascot({ state: 'idle', size, spec: KAIROS_SPEC }); face.id = id; return face; };

  // Collapsed: Kip, then either the usage rings and agent dots (resting) or the
  // current line and its signal (working, needs you).
  const bar = build('div'); bar.id = 'notch-bar';
  const face = kip(28, 'notch-kip');
  const usage = build('span'); usage.id = 'notch-usage';
  const status = build('span'); status.id = 'notch-status';
  const signal = build('span'); signal.id = 'notch-signal';
  const cluster = build('span'); cluster.id = 'notch-cluster';
  bar.append(face, usage, status, signal, cluster);

  // Expanded: the status row, then the Kip card, the agent chips and the rail.
  const panel = build('div'); panel.id = 'notch-panel';
  const top = build('div', 'n-top');
  const side = createSideNotch({ shell, bridge });
  const button = (id, label, icon, tab) => {
    const b = build('button', 'n-ic'); if (id) b.id = id; b.setAttribute('aria-label', label); b.innerHTML = icon;
    b.addEventListener('click', e => { e.stopPropagation(); bridge.openApp?.(tab); }); return b;
  };
  const readings = build('span'); readings.id = 'notch-readings';
  top.append(button('notch-open', 'Open Kairos', ICONS.home), button('', 'Chats', ICONS.chats, 'chat'),
    button('', 'Settings', ICONS.settings, 'settings'), side.newChat, readings);
  const row = build('div', 'n-row');
  const now = build('div', 'n-now');
  const bigKip = kip(92, 'notch-kip-large');
  const lines = build('div', 'n-lines');
  const before = build('span', 'n-quiet'), current = build('span', 'n-current'), after = build('span', 'n-quiet');
  lines.append(before, current, after); now.append(bigKip, lines);
  const chips = build('div', 'n-chips');
  const rail = build('div', 'n-rail');
  row.append(now, chips, rail);
  // With fewer than two agents at work the quiet view takes the row's place; the side panel adds Up next and the quick actions.
  const quietData = createQuietData(() => { renderQuiet(); side.update(quietData.data.events); });
  const quiet = createQuietView({ bridge, bigKip });
  panel.append(top, row, quiet.node, side.next, side.actions);
  shell.append(bar, panel, pill);
  document.getElementById('root').append(shell);

  const chats = new Map(), remote = { agents: [], inbox: { items: [], reviews: [] }, pending: [], devices: [] };
  let expanded = false, expandTimer = null, closeTimer = null, appearanceKey = '';
  let edge = 'top-centre', working = 0, activityInfo = null;
  const reducedMotion = () => document.body.classList.contains('notch-reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  function setExpanded(value) {
    if (expanded === value) return;
    const from = shell.getBoundingClientRect();
    expanded = value; shell.classList.toggle('expanded', value);
    shell.setAttribute('aria-expanded', String(value));
    side.place(); if (value) quietData.refresh(true);
    shell.getAnimations().forEach(animation => animation.cancel());
    if (reducedMotion()) shell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    else {
      // The boards' 230 ms spring from one size to the other.
      const to = shell.getBoundingClientRect(), w = r => (r.right - r.left) + 'px', h = r => (r.bottom - r.top) + 'px';
      shell.animate([{ width: w(from), height: h(from) }, { width: w(to), height: h(to) }],
        { duration: 230, easing: 'cubic-bezier(.32,1.25,.5,1)' });
    }
    if (!value) hideCard();
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
  function pointer(x, y) {
    const inside = hot(x, y);
    if (inside) {
      clearTimeout(closeTimer); closeTimer = null;
      if (!expanded && expandTimer === null) expandTimer = setTimeout(() => { expandTimer = null; setExpanded(true); }, 150);
    } else {
      clearTimeout(expandTimer); expandTimer = null;
      if (expanded && closeTimer === null) closeTimer = setTimeout(() => { closeTimer = null; setExpanded(false); }, 250);
    }
    return inside;
  }
  shell.addEventListener('click', () => setExpanded(true));

  let idleSince = Date.now(), signature = '';
  function chipFor(agent, state) {
    const chip = build('span', 'n-chip');
    chip.dataset.tone = state === 'resting' ? 'rest' : 'live';
    if (HEX.test(agent.color || '')) chip.style.setProperty('--tint', agent.color);
    chip.append(dot(agent.color, 12), build('span', 'n-chip-text', `${agent.name || 'Agent'}: ${state}`));
    return chip;
  }
  function renderActivity() {
    const { need, work } = collectActivity({ chats, remote });
    if (need.length || work.length) idleSince = Date.now();
    const state = need.some(item => item.status === 'error' || item.status === 'failed') ? 'error'
      : need.length || work.some(item => item.needsYou) ? 'needs' : work.length ? 'thinking' : Date.now() - idleSince >= 600000 ? 'sleeping' : 'idle';
    for (const mascot of [face, bigKip]) if (mascot.getAttribute('state') !== state) mascot.setAttribute('state', state);
    shell.dataset.state = state;
    const waiting = [...need, ...work.filter(item => item.needsYou)];
    const focus = waiting[0] || work[0] || null;
    const words = item => item.kind === 'chat' ? (item.status === 'processing' ? `${item.title} needs you` : `${item.title} ${item.detail.split('· ')[1] || ''}`.trim()) : item.title;

    // Collapsed status line and its signal: a gold point, or the count of what waits.
    status.textContent = focus ? (waiting.length ? words(focus) : focus.title) : '';
    signal.replaceChildren(...(waiting.length ? [build('span', 'n-count', String(waiting.length))] : work.length ? [dot('', 8)] : []));

    // Kip card: what the focused item says about itself, and how much else is waiting.
    if (focus) {
      before.textContent = focus.detail || '';
      current.textContent = focus.title; // the detail line above already says it waits for you
      const more = need.length + work.length - 1;
      after.textContent = more > 0 ? `${more} more in Kairos` : 'Open Kairos for details';
    } else {
      before.textContent = state === 'sleeping' ? 'Resting' : 'All quiet';
      current.textContent = 'Nothing running';
      after.textContent = remote.agents.length ? `${remote.agents.length} agent${remote.agents.length === 1 ? '' : 's'} on call` : 'Start a chat from Kairos';
    }

    // Agents: dots when collapsed, chips and the rail when expanded. Each shows
    // once, with what the shared need/work model says it is doing.
    const doing = new Map();
    for (const item of [...work, ...need]) if (item.agent && !doing.has(item.agent.id))
      doing.set(item.agent.id, need.includes(item) || item.needsYou ? 'needs you' : (item.detail || 'working').toLowerCase());
    // Fewer than two agents at work: the quiet view; otherwise the chips and the rail. The side panel always stacks both.
    working = workingAgents(work);
    activityInfo = { state, focus, agents: remote.agents, doing };
    applyLayout(); renderQuiet();
    const agents = remote.agents.slice(0, 4);
    const next = JSON.stringify([agents.map(a => [a.id, a.name, a.color, doing.get(a.id)]), remote.agents.length, work.filter(i => !i.agent).map(i => i.title)]);
    if (next !== signature) {
      signature = next;
      cluster.replaceChildren(...agents.map(agent => dot(agent.color, 8)));
      if (remote.agents.length > 4) cluster.append(build('span', 'n-more', `+${remote.agents.length - 4}`));
      cluster.setAttribute('aria-label', `${remote.agents.length} agents, ${doing.size ? `${doing.size} active` : 'idle'}`);
      const list = agents.map(agent => chipFor(agent, doing.get(agent.id) || 'resting'));
      for (const item of work) if (!item.agent && list.length < 4) list.push(chipFor({ name: item.title }, 'working'));
      chips.replaceChildren(...(list.length ? list : [build('span', 'n-empty', 'No agents yet')]));
      rail.replaceChildren(...agents.map(agent => { const d = dot(agent.color, 14); d.classList.toggle('n-dim', !doing.has(agent.id)); return d; }));
      rail.setAttribute('aria-label', `Agents: ${doing.size} running`);
      rail.hidden = !agents.length;
    }
  }
  function applyLayout() {
    const layout = isSideEdge(edge) ? 'side' : layoutFor(working);
    if (panel.dataset.layout === layout) return;
    panel.dataset.layout = layout;
    if (layout === 'quiet') quiet.holdKip(); else now.prepend(bigKip);
  }
  function renderQuiet() {
    if (activityInfo) quiet.update(activityInfo, quietData.data);
  }
  chatStream.subscribeAll((id, entry) => {
    if (entry) chats.set(id, { title: entry.sessionTitle || 'Chat', status: entry.status, permission: !!entry.permission, text: !!entry.text });
    else if (chats.get(id)?.status === 'processing') chats.delete(id);
    renderActivity();
  });
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
      chatStream.sync().then(() => { shell.dataset.connection = 'connected'; document.body.classList.remove('notch-offline'); })
        .catch(() => { shell.dataset.connection = 'reconnecting'; document.body.classList.add('notch-offline'); bridge.setInteractive?.(false); reset(); }),
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
  read('identity', '/api/auth/status', data => { appearanceKey = 'jarvis:appearance:v1:' + (data.username || 'local'); applyAppearance(); });
  window.addEventListener('storage', event => { if (event.key === appearanceKey) applyAppearance(); });
  poll(); const timer = setInterval(poll, 15000); // Snapshot fallback while SSE reconnects; also refresh bot/inbox sources.
  window.addEventListener('pagehide', () => { clearInterval(timer); reset(); }, { once: true });
  applyAppearance(); renderActivity(); renderRing();
  // The tooltip, and the screen-reader name, of a model's logo.
  const labelled = (node, name, label) => { node.title = name; node.setAttribute('aria-label', label); return node; };
  return { hot, pointer, reset, isExpanded: () => expanded,
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
