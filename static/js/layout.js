// The sidebar's and Home's layout (David, 2026-10-07): which tabs sit in
// which sidebar group and in what order, which are hidden, and the order and
// visibility of Home's panels. Set in Settings > Layout (views/layoutPanel.js),
// saved on this device per user like Appearance, and applied live: changes
// fire `kairos:layout`, which app.js (the sidebar) and views/home.js follow.

export const SIDEBAR_GROUPS = [
  { id: "main", label: "" },
  { id: "workspace", label: "Workspace" },
  { id: "intelligence", label: "Intelligence" },
];
export const HOME_SECTIONS = [
  { id: "stats", label: "Summary numbers" },
  { id: "chats", label: "Recent chats" },
  { id: "schedule", label: "Upcoming" },
  { id: "agents", label: "Agents" },
  { id: "models", label: "Models" },
  { id: "store", label: "Tool Store" },
  { id: "projects", label: "Projects" },
  { id: "activity", label: "Activity" },
  { id: "system", label: "Systems" },
];
// Redesign preview only: Home's "Needs you" card (redesignHome.js). It is part
// of the layout (and listed in Settings > Layout) only while the preview is on,
// so with the preview off this module behaves exactly as before.
const NEEDS = { id: "needs", label: "Needs you" };
const needsOn = () => document.documentElement.classList.contains("kairos-redesign");
function syncNeeds() {
  const at = HOME_SECTIONS.indexOf(NEEDS);
  if (needsOn() && at < 0) HOME_SECTIONS.push(NEEDS);
  else if (!needsOn() && at >= 0) HOME_SECTIONS.splice(at, 1);
}
// Home is never hidden: it's the way back from anywhere.
export const ALWAYS_SHOWN = "home";

const DEFAULT_GROUPS = {
  main: ["home", "chat", "agents"],
  workspace: ["notes", "library", "calendar", "email", "tasks"],
  intelligence: ["tool-store", "cookbook"],
};
const defaults = () => (syncNeeds(), {
  groups: structuredClone(DEFAULT_GROUPS), hiddenTabs: [],
  home: HOME_SECTIONS.map((s) => s.id), hiddenHome: needsOn() ? ["needs"] : [],
});

let layout = defaults(), storageKey = "", known = [], cards = [];

const ids = (value, maxLength = 80) => Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === "string" && v.length < maxLength))] : [];
const tabCardId = (id) => id.startsWith("tab:");
function normalize(raw = {}) {
  syncNeeds();
  const value = defaults();
  if (raw.groups && typeof raw.groups === "object") {
    for (const { id } of SIDEBAR_GROUPS) value.groups[id] = ids(raw.groups[id]);
    // A tab saved in two groups keeps its first place.
    const seen = new Set();
    for (const { id } of SIDEBAR_GROUPS) value.groups[id] = value.groups[id].filter((tab) => !seen.has(tab) && seen.add(tab));
  }
  value.hiddenTabs = ids(raw.hiddenTabs).filter((tab) => tab !== ALWAYS_SHOWN);
  const homeIds = HOME_SECTIONS.map((s) => s.id);
  const order = ids(raw.home, Infinity).filter((id) => homeIds.includes(id) || tabCardId(id));
  value.home = [...order, ...homeIds.filter((id) => !order.includes(id))];
  value.hiddenHome = ids(raw.hiddenHome, Infinity).filter((id) => homeIds.includes(id) || tabCardId(id));
  // A card added after this arrangement was saved starts hidden, like a new tab card.
  if (needsOn() && !ids(raw.home, Infinity).includes("needs") && !value.hiddenHome.includes("needs")) value.hiddenHome.push("needs");
  return value;
}

export function initLayout(username) {
  cards = [];
  storageKey = "kairos:layout:v1:" + String(username || "local");
  try { layout = normalize(JSON.parse(localStorage.getItem(storageKey) || "{}")); }
  catch { layout = defaults(); }
}

export function getLayout() { return structuredClone(layout); }

export function saveLayout(next) {
  layout = normalize(next);
  try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* applies for this visit */ }
  document.dispatchEvent(new CustomEvent("kairos:layout"));
}
export function resetSidebarLayout() { const d = defaults(); saveLayout({ ...layout, groups: d.groups, hiddenTabs: [] }); }
export function resetHomeLayout() {
  const tabIds = layout.home.filter(tabCardId);
  saveLayout({ ...layout, home: [...defaults().home, ...tabIds], hiddenHome: [...(needsOn() ? ["needs"] : []), ...tabIds] });
}

// Remember placement even when a tab is off. Only newly discovered cards
// default to hidden; a successful empty response changes availability alone.
export function setHomeCards(next) {
  cards = next.map(({ id, title, tab_name, slug, tab_icon }) => ({ id, title, tab_name, slug, tab_icon }));
  const added = cards.map(c => c.id).filter(id => tabCardId(id) && !layout.home.includes(id));
  if (added.length) saveLayout({ ...layout, home: [...layout.home, ...added], hiddenHome: [...layout.hiddenHome, ...added] });
}
export function knownHomeCards() { return cards.slice(); }

// Every tab the sidebar can show ({id, label}), as app.js last built it,
// custom tabs included, for the Layout page to list.
export function setKnownTabs(tabs) { known = tabs.map(({ id, label }) => ({ id, label })); }
export function knownTabs() { return known.slice(); }

// The sidebar's groups with every known tab placed exactly once: where it
// was saved, else in its default group, else (a custom tab) at the end of
// the last group. Hidden tabs are left out unless asked for.
export function sidebarLayout(tabIds, { includeHidden = false } = {}) {
  const placed = new Set();
  const groups = SIDEBAR_GROUPS.map((g) => ({ ...g, ids: layout.groups[g.id].filter((id) => tabIds.includes(id) && !placed.has(id) && placed.add(id)) }));
  for (const id of tabIds) {
    if (placed.has(id)) continue;
    const home = SIDEBAR_GROUPS.find((g) => DEFAULT_GROUPS[g.id].includes(id)) || SIDEBAR_GROUPS.at(-1);
    groups.find((g) => g.id === home.id).ids.push(id);
    placed.add(id);
  }
  if (!includeHidden) for (const g of groups) g.ids = g.ids.filter((id) => id === ALWAYS_SHOWN || !layout.hiddenTabs.includes(id));
  return groups;
}

export function homeLayout() { return { order: layout.home.slice(), hidden: layout.hiddenHome.slice() }; }

// The preview switch decides whether "needs" is part of the layout; re-read the
// saved one when it flips (the in-memory copy dropped or never had it).
document.addEventListener("kairos:appearance", () => {
  const before = HOME_SECTIONS.includes(NEEDS);
  syncNeeds();
  if (before === HOME_SECTIONS.includes(NEEDS) || !storageKey) return;
  try { layout = normalize(JSON.parse(localStorage.getItem(storageKey) || "{}")); } catch { layout = defaults(); }
});
