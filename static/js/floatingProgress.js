// Compact top-right overlay showing every chat session currently
// generating a reply, regardless of which tab is active (David's ask
// 2026-09-12 — sending a prompt then switching to Notes to get other
// things done used to give zero indication anything was still happening).
// Mounted once from app.js at startup, independent of app.js's per-tab
// view-swapping. chatStream.js mirrors the backend's live turns across
// devices. This uses the same lazily-created-host
// pattern api.js's toast() already uses for #toast-host, just a separate
// corner and a different lifecycle (driven by chatStream's subscribeAll,
// not a fixed timer).
import * as chatStream from "./chatStream.js";

let host = null;
let _switchTab = null; // injected by init(), same dependency-passing convention commandPalette.js uses
const cards = new Map(); // sessionId -> HTMLElement
const working = new Set();
let summary = null;
let list = null;
let expanded = false;

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "chat-progress-host";
  summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'chat-progress-card chat-progress-summary';
  summary.hidden = true;
  summary.setAttribute('aria-controls', 'chat-progress-list');
  summary.appendChild(Object.assign(document.createElement('span'), { className: 'chat-progress-dot' }));
  summary.appendChild(Object.assign(document.createElement('span'), { className: 'chat-progress-label' }));
  summary.addEventListener('click', () => { expanded = !expanded; updatePresentation(); });
  list = document.createElement('div');
  list.id = 'chat-progress-list';
  host.append(summary, list);
  document.body.appendChild(host);
  document.addEventListener('click', event => {
    if (expanded && !host.contains(event.target)) { expanded = false; updatePresentation(); }
  }, true);
  document.addEventListener('keydown', event => {
    if (expanded && event.key === 'Escape') {
      expanded = false;
      updatePresentation();
      summary.focus();
    }
  });
  return host;
}

function updatePresentation() {
  const grouped = working.size >= 2;
  if (!grouped) expanded = false;
  // Completion cards retain chatStream's existing four-second lifetime.
  // Only live turns contribute to the "working" count.
  const focusedCard = list.contains(document.activeElement);
  const focusedSummary = document.activeElement === summary;
  summary.hidden = !grouped;
  summary.querySelector('.chat-progress-label').textContent = `${working.size} chats working`;
  summary.setAttribute('aria-label', `${working.size} chats working`);
  summary.setAttribute('aria-expanded', String(expanded));
  list.hidden = grouped && !expanded;
  if (grouped && !expanded && focusedCard) summary.focus();
  if (!grouped && focusedSummary) {
    const active = [...working].map(id => cards.get(id))[0] || cards.values().next().value;
    active?.focus();
  }
  if (grouped && !summary.classList.contains('show')) {
    summary.getBoundingClientRect();
    summary.classList.add('show');
  }
}

async function jumpToSession(sessionId) {
  await _switchTab("chat");
  const chatView = await import("./views/chat.js");
  chatView.openSessionById(sessionId);
}

function render(sessionId, entry) {
  ensureHost();
  let card = cards.get(sessionId);
  if (!entry) {
    if (card) { card.remove(); cards.delete(sessionId); }
    working.delete(sessionId);
    updatePresentation();
    return;
  }
  if (!card) {
    card = document.createElement("button");
    card.type = 'button';
    card.className = "chat-progress-card";
    card.addEventListener("click", () => jumpToSession(sessionId));
    list.appendChild(card);
    cards.set(sessionId, card);
    // Force layout before the "show" transition so it actually animates in.
    card.getBoundingClientRect();
    card.classList.add("show");
    card.appendChild(Object.assign(document.createElement('span'), { className: 'chat-progress-dot' }));
    card.appendChild(Object.assign(document.createElement('span'), { className: 'chat-progress-label' }));
  }
  card.classList.toggle("done", entry.status === "done");
  card.classList.toggle("failed", entry.status === "failed");
  card.classList.toggle("stopped", entry.status === "stopped");
  const statusText = entry.status === "processing" ? (entry.text ? 'receiving response' : 'waiting for response')
    : entry.status === "done" ? "finished"
      : entry.status === "stopped" ? "stopped"
        : "failed";
  const label = card.querySelector('.chat-progress-label');
  const next = `${entry.sessionTitle} · ${statusText}`;
  if (label.textContent !== next) label.textContent = next;
  if (entry.status === 'processing') working.add(sessionId);
  else working.delete(sessionId);
  updatePresentation();
}

export function init({ switchTab }) {
  _switchTab = switchTab;
  chatStream.subscribeAll(render);
  // Cover a turn that was already in flight before this module's first
  // subscribeAll call (shouldn't normally happen — app.js calls init() at
  // startup, before any message could have been sent — but cheap insurance
  // against init-order changes later).
  for (const { sessionId, ...entry } of chatStream.listInFlight()) render(sessionId, entry);
}
