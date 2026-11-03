import * as chatStream from './chatStream.js';
import { api, openPanelDialog, el, toast } from './api.js';
import { subscribeActivity } from './redesignShell.js';
import { button, mobileOn, go, haptic, longPress } from './mobileShared.js';

const finished = new Map();
const putAway = new Set();
let snapshot = { need: [], work: [] }, host, homeSlot, expanded = false, spread = false, active = 0, signature = '';
let sessions = [], models = [], acceptsHome = () => true;
let pressCleanups = [];
const openChat = id => go('chat', { sessionId: id });
export const attentionCount = () => snapshot.need.filter(item => !item.finished).length;
export function activityMetadata(nextSessions, nextModels) {
  if (Array.isArray(nextSessions)) sessions = nextSessions;
  if (Array.isArray(nextModels)) models = nextModels;
  render();
}
function modelFor(id, item = {}) {
  const session = sessions.find(s => s.id === id);
  return item.model || session?.model || models.find(m => m.id === (item.modelEndpointId || session?.model_endpoint_id))?.name || '';
}
async function stopAgent(item) {
  try {
    const [detail, threads] = await Promise.all([api(`/api/agents/${encodeURIComponent(item.agentId)}`), api(`/api/sessions?agent_id=${encodeURIComponent(item.agentId)}`)]);
    const tasks = new Map([
      ...(detail.cards || []).filter(c => c.status === 'running').map(c => [c.id, c.name]),
      ...(detail.runs || []).filter(r => r.outcome === 'running' && r.task_id).map(r => [r.task_id, r.task_name || 'Scheduled work']),
    ]);
    const choices = [...tasks].map(([id, title]) => ({ title, stop: () => api(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' }) }));
    for (const session of threads) if (chatStream.getInFlight(session.id)?.status === 'processing') choices.push({ title: session.title, stop: () => chatStream.stopTurn(session.id) });
    if (!choices.length) { toast('This work has already finished', 'info'); return; }
    if (choices.length === 1) await choices[0].stop();
    else {
      const body = el('div');
      const panel = openPanelDialog({ title: 'Stop work', body });
      for (const choice of choices) body.append(button(choice.title, async () => { await choice.stop(); panel.close(); }, 'btn'));
    }
    document.dispatchEvent(new CustomEvent('jarvis:agents-changed'));
  } catch (error) { toast(error.message || 'Could not stop work', 'error'); }
}
// Rows for the tab sheet: what is running or waiting, and what just finished.
export function activityItems() {
  const live = [...snapshot.need.filter(i => !i.finished && !(i.kind === 'chat' && i.status !== 'processing')), ...snapshot.work]
    .map(i => i.agentId ? { ...i, stop: () => stopAgent(i) } : i);
  return { live: live.map(i => ({ title: i.title, detail: modelFor(i.sessionId, i) || i.detail || '', needsYou: !!(i.needsYou || snapshot.need.some(n => n.key === i.key)), go: i.go, stop: i.stop })),
    done: [...finished.values()].sort((a, b) => b.at - a.at).map(i => ({ title: i.title, status: i.status, go: () => { dismiss(i.key); i.go ? i.go() : openChat(i.sessionId); } })) };
}
export const refreshActivity = () => { signature = ''; render(); };
// What the phone sidebar's Home badge shows: needs-you items, else running work.
let badges = { need: 0, live: 0 };
export const badgeCounts = () => ({ ...badges });
export function attachActivity(slot, accepts = () => true) {
  acceptsHome = accepts; homeSlot = slot; signature = ''; render();
  return () => { if (homeSlot === slot) homeSlot = null; signature = ''; render(); };
}
function dismiss(key) { putAway.add(key); finished.delete(key); signature = ''; render(); }
function render() {
  if (!host) return;
  const live = [...snapshot.need.filter(i => !i.finished && !(i.kind === 'chat' && i.status !== 'processing')), ...snapshot.work]
    .map(i => i.agentId ? { ...i, stop: () => stopAgent(i) } : i).filter(acceptsHome);
  const done = [...finished.values()].filter(acceptsHome).sort((a, b) => b.at - a.at);
  // Status outside the launch surface never floats over content: it shows as a badge on the sidebar's Home
  // (mobileSidebar.js), on a conversation's back button, and as rows in the More sheet.
  const count = attentionCount(), total = live.length;
  for (const anchor of document.querySelectorAll('.ms-chat-back')) {
    let badge = anchor.querySelector(':scope > .ms-avatar-badge');
    const shown = count || total, text = shown > 99 ? '99+' : String(shown);
    if (shown && !badge) { badge = document.createElement('span'); badge.className = 'ms-avatar-badge'; badge.setAttribute('aria-hidden', 'true'); anchor.append(badge); }
    if (badge && badge.textContent !== text) badge.textContent = text;
    if (badge) badge.hidden = shown === 0;
  }
  if (count !== badges.need || total !== badges.live) {
    badges = { need: count, live: total };
    document.dispatchEvent(new CustomEvent('kairos:mobile-activity', { detail: { ...badges } }));
  }
  const atHome = !!homeSlot?.isConnected;
  host.hidden = !mobileOn() || !atHome || (!live.length && !done.length);
  if (!atHome) { signature = ''; return; }
  if (host.parentNode !== homeSlot) homeSlot.append(host);
  active = Math.min(active, Math.max(0, live.length - 1));
  // Tokens do not rebuild controls or interrupt keyboard focus.
  const next = JSON.stringify([atHome, expanded, spread, active, live.map(i => [i.key, i.title, i.detail, modelFor(i.sessionId, i)]), done.map(i => [i.key, i.title])]);
  if (next === signature) return; signature = next;
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  pressCleanups.forEach(cancel => cancel()); pressCleanups = [];
  host.replaceChildren();
  const control = (label, action, key, cls = 'ms-glass') => {
    const node = button(label, action, cls); node.dataset.focus = key; return node;
  };
  if (done.length) {
    const deck = document.createElement('div'); deck.className = 'ms-finished-deck'; deck.classList.toggle('ms-spread', spread);
    deck.append(control(spread ? 'Stack finished' : `Finished (${done.length})`, () => { spread = !spread; haptic(); render(); }, 'spread'),
      control('Clear all', () => { for (const key of finished.keys()) putAway.add(key); finished.clear(); render(); }, 'clear'));
    const cards = document.createElement('div'); cards.className = 'ms-finished-cards';
    done.forEach((item, i) => {
      const card = control(`${item.title} · ${item.status}`, () => {
        if (done.length > 1 && !spread) { spread = true; render(); return; }
        dismiss(item.key); item.go ? item.go() : openChat(item.sessionId);
      }, item.key, 'ms-glass ms-finished-card');
      card.style.setProperty('--deck-index', Math.min(i, 2));
      card.hidden = !spread && i > 2; card.inert = !spread && i > 0;
      card.setAttribute('aria-label', `${item.title}, ${item.status}. Long press to put away`);
      pressCleanups.push(longPress(card, () => dismiss(item.key)));
      cards.append(card);
      if (spread) cards.append(control('Put away', () => dismiss(item.key), `dismiss:${item.key}`, 'ms-put-away'));
    });
    deck.append(cards); host.append(deck);
  }
  if (live.length) {
    const current = live[active], player = document.createElement('div'); player.className = 'ms-player ms-glass';
    player.classList.toggle('ms-needs-you', current.needsYou || snapshot.need.some(i => i.key === current.key));
    const main = control(`${current.title} · ${modelFor(current.sessionId, current) || current.detail}`, () => {
      if (live.length > 1) { expanded = !expanded; haptic(); render(); } else current.go();
    }, 'player', 'ms-player-main');
    const indicator = document.createElement('span'); indicator.className = 'ms-spinner'; indicator.setAttribute('aria-hidden', 'true'); main.prepend(indicator);
    player.append(main);
    if (current.stop) player.append(control('Stop', () => { current.stop(); }, 'stop'));
    if (live.length > 1) player.append(control(`${active + 1} of ${live.length} ›`, () => { active = (active + 1) % live.length; haptic(); render(); }, 'skip'));
    host.append(player);
    if (expanded && live.length > 1) {
      const mini = document.createElement('div'); mini.className = 'ms-mini-pills';
      live.forEach(item => {
        const row = document.createElement('div'); row.className = 'ms-mini-row';
        row.append(control(`${item.title} · ${item.detail}`, item.go, item.key));
        if (item.stop) row.append(control('Stop', item.stop, `stop:${item.key}`));
        mini.append(row);
      }); host.append(mini);
    }
  }
  if (focused) [...host.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focused)?.focus({ preventScroll: true });
}

export function initActivity() {
  host = document.createElement('section'); host.className = 'ms-activity'; host.setAttribute('aria-label', 'Work and updates'); host.hidden = true;
  document.body.append(host);
  subscribeActivity(value => {
    snapshot = value;
    const remoteKeys = new Set(value.need.filter(i => i.finished).map(i => i.key));
    for (const [key, item] of finished) if (item.remote && !remoteKeys.has(key)) finished.delete(key);
    for (const item of value.need.filter(i => i.finished)) if (!finished.has(item.key) && !putAway.has(item.key)) finished.set(item.key, { ...item, remote: true, at: Date.now() / 1000, status: 'Ready to review' });
    render();
  });
  chatStream.subscribeAll((id, entry) => {
    if (!mobileOn() || !entry || entry.status === 'processing') return;
    const key = `${id}:${entry.turnId || entry.startedAt || ''}`;
    if (!finished.has(key) && !putAway.has(key)) {
      finished.set(key, { key, sessionId: id, title: entry.sessionTitle || 'Chat', status: entry.status === 'done' ? 'Reply ready' : entry.status === 'stopped' ? 'Stopped' : 'Failed', at: entry.endedAt || Date.now() / 1000 });
      haptic(); render();
    }
  });
  document.addEventListener('kairos:appearance', render); addEventListener('resize', render);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && (expanded || spread) && mobileOn()) { expanded = spread = false; render(); host.querySelector('button')?.focus(); } });
}
