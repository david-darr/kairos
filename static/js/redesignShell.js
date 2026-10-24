import { collectActivity } from "./activityModel.js";
// Redesign preview: the app shell's "need you" row.
//
// With Settings > Appearance > Redesign preview on, the floating chat pill
// (floatingProgress.js) is hidden by redesign-shell.css and its information
// lives here instead: one compact row in the sidebar, above the nav, and a
// flyout (a sheet on phones) listing each item with its action. The row hides
// completely when nothing waits on the person; items that are only working
// never keep it visible, but they are listed in the flyout while it shows.
//
// Sources, all existing ones (nothing new on the backend):
//   chatStream            running turns, finished turns, permission prompts
//   /api/agents/inbox     agent questions, reports, results to review
//                         (the same call that drives the Agents nav badge and
//                         Home's "waiting on you" stat)
//   /api/agents           agent names, and which agents are working
//   /api/triggers         pending approvals ("GitHub push is waiting")
//   /api/notifications    a device whose last push failed to deliver
// Every request here is a read. With the switch off this module does nothing.
import * as chatStream from "./chatStream.js";
import { api } from "./api.js";
import { openSession } from "./floatingProgress.js";

const root = document.documentElement;
const phone = matchMedia("(max-width: 768px)");
const POLL_MS = 30000;
const SVG = (paths, size = 16, width = 1.6) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON_SEARCH = SVG('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>');
const ICON_CLOSE = SVG('<path d="M6 6l12 12M18 6 6 18"/>', 16, 1.8);

const chats = new Map();            // sessionId -> { title, status, permission, text }
const remote = { agents: [], inbox: { items: [], reviews: [] }, pending: [], devices: [] };
const dismissed = new Set();        // keys the person marked done on this device
const disabled = new Set();         // sources this person is not allowed to read
let ui = null;                      // { row, flyout, scrim, ... } while mounted
let started = false;
let open = false;
let timer = null;
let unsubscribe = null;
let lastFocus = null;
const activityListeners = new Set();
// The phone player consumes the same reads and actions as the desktop row.
export function subscribeActivity(listener) {
  activityListeners.add(listener);
  listener(collect());
  return () => activityListeners.delete(listener);
}

const isOn = () => root.classList.contains("kairos-redesign");
const go = detail => document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail }));
const initial = text => (String(text || "").trim()[0] || "K").toUpperCase();
const clip = (text, max = 90) => { const t = String(text || "").replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };

// -- data ---------------------------------------------------------------------

function onChat(sessionId, entry) {
  const before = chats.get(sessionId);
  if (!entry) {
    // chatStream forgets a finished turn after four seconds; a finished reply
    // keeps waiting here until it is opened or marked done.
    if (before && before.status === "processing") chats.delete(sessionId);
    return refresh();
  }
  const next = { title: entry.sessionTitle || "Chat", status: entry.status, permission: !!entry.permission, text: !!entry.text };
  if (entry.status !== "processing" && before?.status === "processing" && viewingChats()) chats.delete(sessionId);
  else chats.set(sessionId, next);
  refresh();
}

const viewingChats = () => ["chat", "forgeShell"].includes(root.dataset.view) && document.hasFocus();

function clearFinishedChats() {
  let changed = false;
  for (const [id, chat] of chats) if (chat.status !== "processing") { chats.delete(id); changed = true; }
  if (changed) refresh();
}

async function read(source, path, apply) {
  if (disabled.has(source)) return;
  try { apply(await api(path)); }
  catch (error) { if (/^(401|403|404|405)\b/.test(error.message)) disabled.add(source); }
}

async function poll() {
  clearTimeout(timer);
  if (!started) return;
  timer = setTimeout(poll, POLL_MS);
  if (document.hidden) return;
  await Promise.all([
    read("inbox", "/api/agents/inbox", data => { remote.inbox = { items: data?.items || [], reviews: data?.reviews || [] }; }),
    read("agents", "/api/agents", data => { remote.agents = Array.isArray(data) ? data : []; }),
    read("triggers", "/api/triggers", data => { remote.pending = data?.pending || []; }),
    read("devices", "/api/notifications", data => { remote.devices = data?.devices || []; }),
  ]);
  if (started) refresh();
}

function collect() { return collectActivity({ chats, remote, dismissed, chatStream, openSession, go, refresh }); }

// -- view ---------------------------------------------------------------------

function avatar(item) {
  const node = document.createElement("span");
  node.className = `rd-av rd-av-${item.kind}`;
  node.setAttribute("aria-hidden", "true");
  if (item.tint) node.style.setProperty("--rd-av", item.tint);
  node.textContent = item.initial;
  return node;
}

function itemRow(item) {
  const wrap = document.createElement("div");
  wrap.className = "rd-item";
  const main = document.createElement("button");
  main.type = "button";
  main.className = "rd-item-main";
  const copy = document.createElement("span");
  copy.className = "rd-item-copy";
  const title = document.createElement("span"); title.className = "rd-item-title"; title.textContent = item.title;
  const detail = document.createElement("span"); detail.className = "rd-item-detail"; detail.textContent = item.detail;
  copy.append(title, detail);
  const action = document.createElement("span"); action.className = "rd-item-action"; action.textContent = item.action;
  main.append(avatar(item), copy, action);
  main.addEventListener("click", () => { closeFlyout(false); item.go(); });
  wrap.append(main);
  if (item.done) {
    const done = document.createElement("button");
    done.type = "button"; done.className = "rd-item-done"; done.textContent = "Done";
    done.setAttribute("aria-label", `Mark done: ${item.title}`);
    done.addEventListener("click", item.done);
    wrap.append(done);
  }
  return wrap;
}

function mount() {
  if (ui) return;
  const sidebar = document.getElementById("sidebar");
  const nav = document.getElementById("nav");
  if (!sidebar || !nav) return;

  // Jump to: the existing Ctrl+K command palette, one click away.
  const jump = document.createElement("button");
  jump.type = "button"; jump.id = "rd-jump"; jump.className = "rd-jump";
  jump.setAttribute("aria-label", "Jump to, Ctrl K");
  const mac = root.classList.contains("platform-mac");
  jump.innerHTML = `${ICON_SEARCH}<span class="rd-jump-text">Jump to…</span><kbd>${mac ? "⌘ K" : "Ctrl K"}</kbd>`;
  jump.addEventListener("click", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));

  const row = document.createElement("button");
  row.type = "button"; row.id = "rd-needs"; row.className = "rd-needs"; row.hidden = true;
  row.setAttribute("aria-controls", "rd-flyout");
  row.setAttribute("aria-expanded", "false");
  row.setAttribute("aria-haspopup", "true");
  row.innerHTML = `<span class="rd-needs-avatars" aria-hidden="true"></span>
    <span class="rd-needs-text"><span class="rd-needs-need"></span><span class="rd-needs-work"></span></span>
    <span class="rd-needs-count" aria-hidden="true"></span>`;
  row.addEventListener("click", () => (open ? closeFlyout(true) : openFlyout()));

  const flyout = document.createElement("div");
  flyout.id = "rd-flyout"; flyout.className = "rd-flyout rd-menu-in"; flyout.hidden = true;
  flyout.setAttribute("role", "region"); flyout.setAttribute("aria-label", "Updates");
  flyout.innerHTML = `<div class="rd-flyout-head"><span class="rd-flyout-title">Updates</span>
    <button type="button" class="rd-flyout-close" aria-label="Close updates">${ICON_CLOSE}</button></div>
    <div class="rd-flyout-body"></div>`;
  flyout.querySelector(".rd-flyout-close").addEventListener("click", () => closeFlyout(true));
  const scrim = document.createElement("div");
  scrim.className = "rd-flyout-scrim"; scrim.hidden = true;
  scrim.addEventListener("click", () => closeFlyout(true));

  nav.before(jump, row);
  document.body.append(scrim, flyout);
  ui = { row, jump, flyout, scrim, body: flyout.querySelector(".rd-flyout-body") };
}

function unmount() {
  closeFlyout(false);
  if (!ui) return;
  ui.row.remove(); ui.jump.remove(); ui.flyout.remove(); ui.scrim.remove();
  ui = null;
}

function refresh() {
  for (const listener of activityListeners) listener(collect());
  if (!ui || !started) return;
  const { need, work } = collect();
  const n = need.length, w = work.length;
  const needText = `${n} ${n === 1 ? "needs" : "need"} you`;
  const workText = w ? `${w} working` : "";
  const row = ui.row;
  // Hide at zero: working items alone never keep the row visible.
  row.hidden = n === 0;
  row.querySelector(".rd-needs-need").textContent = needText;
  row.querySelector(".rd-needs-work").textContent = workText;
  row.querySelector(".rd-needs-count").textContent = n > 99 ? "99+" : String(n);
  row.setAttribute("aria-label", `Updates: ${needText}${workText ? ", " + workText : ""}`);
  const stack = row.querySelector(".rd-needs-avatars");
  stack.replaceChildren(...need.slice(0, 3).map(avatar));
  if (n === 0 && open) closeFlyout(false);
  if (open) renderFlyout(need, work);
}

function renderFlyout(need, work) {
  // Keep keyboard focus on the same control when the list redraws (a poll).
  const focusKey = ui.flyout.contains(document.activeElement) ? document.activeElement.closest(".rd-item")?.dataset.key : null;
  const focusDone = document.activeElement?.classList.contains("rd-item-done");
  const parts = [];
  for (const item of need) { const node = itemRow(item); node.dataset.key = item.key; parts.push(node); }
  if (work.length) {
    const label = document.createElement("div");
    label.className = "rd-flyout-label"; label.textContent = "Working";
    parts.push(label);
    for (const item of work) { const node = itemRow(item); node.dataset.key = item.key; parts.push(node); }
  }
  ui.body.replaceChildren(...parts);
  if (focusKey) {
    const again = [...ui.body.querySelectorAll(".rd-item")].find(node => node.dataset.key === focusKey);
    (focusDone ? again?.querySelector(".rd-item-done") : again?.querySelector(".rd-item-main"))?.focus({ preventScroll: true });
  }
  place();
}

function place() {
  if (!ui || !open) return;
  const { flyout, row } = ui;
  const sheet = phone.matches;
  flyout.classList.toggle("rd-flyout-sheet", sheet);
  ui.scrim.hidden = !sheet;
  if (sheet) {
    flyout.style.left = flyout.style.top = flyout.style.maxHeight = "";
    return;
  }
  const side = document.getElementById("sidebar").getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.top, innerHeight - 160));
  flyout.style.left = `${Math.round(side.right + 8)}px`;
  flyout.style.top = `${Math.round(top)}px`;
  flyout.style.maxHeight = `${Math.round(innerHeight - top - 12)}px`;
}

function openFlyout() {
  if (!ui || open) return;
  open = true;
  lastFocus = document.activeElement;
  const { need, work } = collect();
  ui.flyout.hidden = false;
  ui.row.setAttribute("aria-expanded", "true");
  if (phone.matches) {
    // A sheet over the drawer: modal, so the drawer's own focus trap and
    // swipe gestures stand aside (app.js and mobileDrawers.js skip aria-modal).
    ui.flyout.setAttribute("role", "dialog");
    ui.flyout.setAttribute("aria-modal", "true");
  } else {
    ui.flyout.setAttribute("role", "region");
    ui.flyout.removeAttribute("aria-modal");
  }
  renderFlyout(need, work);
  (ui.body.querySelector(".rd-item-main") || ui.flyout.querySelector(".rd-flyout-close")).focus({ preventScroll: true });
}

function closeFlyout(restoreFocus) {
  if (!ui || !open) { open = false; return; }
  open = false;
  ui.flyout.hidden = true;
  ui.scrim.hidden = true;
  ui.flyout.removeAttribute("aria-modal");
  ui.row.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    const target = ui.row.hidden ? lastFocus : ui.row;
    (target?.isConnected ? target : document.body).focus?.({ preventScroll: true });
  }
}

// -- lifecycle ----------------------------------------------------------------

document.addEventListener("keydown", event => {
  if (!open || !ui) return;
  if (event.key === "Escape" && !event.defaultPrevented) {
    event.preventDefault();
    closeFlyout(true);
  } else if (event.key === "Tab" && ui.flyout.getAttribute("aria-modal") === "true") {
    const controls = [...ui.flyout.querySelectorAll("button")].filter(node => !node.disabled && node.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !ui.flyout.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !ui.flyout.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
});
document.addEventListener("pointerdown", event => {
  if (!open || !ui || phone.matches) return;
  if (!ui.flyout.contains(event.target) && !ui.row.contains(event.target)) closeFlyout(false);
}, true);
addEventListener("resize", () => place());
phone.addEventListener("change", () => { if (open) closeFlyout(false); });
document.addEventListener("jarvis:agents-changed", () => { if (started) poll(); });
document.addEventListener("visibilitychange", () => { if (started && !document.hidden) poll(); });
document.addEventListener("transitionend", event => { if (open && event.target?.id === "sidebar") place(); });

function start() {
  if (started) return;
  started = true;
  mount();
  if (!ui) { started = false; return; }
  unsubscribe = chatStream.subscribeAll(onChat);
  for (const { sessionId, ...entry } of chatStream.listInFlight()) if (entry.status === "processing") onChat(sessionId, entry);
  refresh();
  poll();
}

function stop() {
  if (!started && !ui) return;
  started = false;
  clearTimeout(timer);
  unsubscribe?.(); unsubscribe = null;
  chats.clear();
  unmount();
}

function sync() { isOn() ? start() : stop(); }

export function init() {
  new MutationObserver(records => {
    for (const record of records) {
      if (record.attributeName === "data-view" && started && ["chat", "forgeShell"].includes(root.dataset.view)) clearFinishedChats();
    }
    sync();
  }).observe(root, { attributes: true, attributeFilter: ["class", "data-view"] });
  document.addEventListener("kairos:appearance", sync);
  // The sidebar is rebuilt on layout and mode changes; the row sits outside
  // what it rebuilds, but re-check that it is still in place.
  document.addEventListener("kairos:layout", () => { if (started && ui && !ui.row.isConnected) { unmount(); started = false; sync(); } });
  sync();
}
