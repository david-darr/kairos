import { el } from "./api.js";
import { agentAvatar } from "./agentAvatar.js";
import { createMascot } from "./mascot.js";
import { openKipMenu, showKip } from "./kipPicker.js";
import { getAppearance } from "./appearance.js";
import { KIP_STYLE_NAMES } from "./kipStyle.js";
import { ICONS } from "./icons.js";
import { subscribeActivity } from "./redesignShell.js";
import { dotMatrix, pill, usageCard } from "./kairosParts.js";
import { openNotifications } from './mobileActions.js';
import { getLayout, saveLayout, homeLayout, knownHomeCards, HOME_SECTIONS } from "./layout.js";

const navigate = (tab, options = {}) => document.dispatchEvent(new CustomEvent("jarvis:navigate", { detail: { tab, ...options } }));
const isTab = (id) => id.startsWith("tab:");

// Natural column span and Customize-sheet wording per built-in card.
const META = {
  needs: { label: "Needs you", sub: "Replies, approvals and failures", span: 8 },
  working: { label: "Working now", sub: "Live chats and agent runs", span: 4 },
  chats: { label: "Recent chats", sub: "Your latest conversations", span: 4 },
  schedule: { label: "Coming up", sub: "Events from the next seven days", span: 4 },
  models: { label: "Model usage", sub: "Providers, usage limits and tokens", span: 4 },
  system: { label: "Systems", sub: "Vault, scheduler, Discord, computer use", span: 12 },
  stats: { label: "At a glance", sub: "Counts for chats, notes, automations", span: 12 },
  projects: { label: "Projects", sub: "Project shelf with document counts", span: 4 },
  agents: { label: "Agents", sub: "Who is working and who needs you", span: 4 },
  activity: { label: "Activity", sub: "Recent events", span: 8 },
  store: { label: "Tool Store", sub: "Installed items and updates", span: 4 },
};
const TAB_SPAN = 4;
const spanOf = (id) => (META[id] ? META[id].span : TAB_SPAN);

// Phone order; desktop places the three small cards in their preferred row.
const DEFAULT_ORDER = ["needs", "working", "models", "chats", "schedule", "system", "stats", "projects", "agents", "activity", "store"];
const DEFAULT_SHOWN = 6;
const AUTO_KEY = "kairos:redesign-home-auto";
const readAuto = () => { try { return localStorage.getItem(AUTO_KEY); } catch { return null; } };
const writeAuto = (value) => { try { value ? localStorage.setItem(AUTO_KEY, value) : localStorage.removeItem(AUTO_KEY); } catch { /* optional */ } };

// The built-in part of an arrangement, comparable as a string.
const snapshot = layout => JSON.stringify({ order: layout.home, hidden: [...layout.hiddenHome].sort() });
const legacySnapshot = layout => JSON.stringify({
  order: layout.home.filter(id => !isTab(id) && !["needs", "working"].includes(id)),
  hidden: layout.hiddenHome.filter(id => !isTab(id) && !["needs", "working"].includes(id)).sort(),
});

// True when nobody has arranged Home: built-ins in today's default order,
// none hidden (the redesign-only "needs" aside), and no tab card turned on.
function untouched(layout) {
  const order = layout.home.filter((id) => !isTab(id));
  if (order.join() !== HOME_SECTIONS.map(s => s.id).join()) return false;
  if (layout.hiddenHome.some((id) => !isTab(id) && !["needs", "working"].includes(id))) return false;
  return layout.home.filter(isTab).every((id) => layout.hiddenHome.includes(id));
}

// Write the redesign's default arrangement through layout.js's own API.
function applyDefault({ remember = false } = {}) {
  const layout = getLayout();
  const tabs = layout.home.filter(isTab);
  saveLayout({ ...layout, home: [...DEFAULT_ORDER, ...tabs], hiddenHome: [...DEFAULT_ORDER.slice(DEFAULT_SHOWN), ...tabs] });
  writeAuto(remember ? snapshot(getLayout()) : null);
}

// A person who never arranged Home gets the redesign's default. Someone with
// their own saved arrangement keeps it.
function ensureArrangement() {
  const layout = getLayout(), remembered = readAuto();
  // Old auto markers omitted tab cards, so they cannot prove that a mixed
  // arrangement is still automatic. Preserve those saved placements.
  const automatic = remembered && (snapshot(layout) === remembered ||
    (!layout.home.some(isTab) && legacySnapshot(layout) === remembered));
  if (untouched(layout) || automatic) applyDefault({ remember: true });
}

// Optional row groups keep the default rows intact when sections are missing.
// Within a partial row distribute spare columns evenly, preserving proportions.
export function packRows(items) {
  const rows = [];
  let row = [], sum = 0;
  const flush = () => {
    if (!row.length) return;
    let spare = 12 - sum;
    row.forEach((cell, i) => { const extra = Math.floor(spare / (row.length - i)); cell.span += extra; spare -= extra; });
    rows.push(row); row = []; sum = 0;
  };
  for (const item of items) {
    if (sum + item.span > 12 || (row.length && item.group !== row[0].group)) flush();
    row.push({ ...item }); sum += item.span;
    if (sum === 12) flush();
  }
  flush();
  return rows;
}

// The week/hero are fixed; live sections use the saved Customize arrangement.
export function mountRedesignHome({ container, content, hero, grid, parts, data, rearrange, launchSurface = false }) {
  let disposed = false, active = false, sheet = null, customizeButton = null, stopPhoneKip = null;
  let activity = { need: [], work: [] };
  let entranceTimer = 0, entered = false;
  const phone = matchMedia('(max-width: 768px)');
  const heroAnchor = document.createComment('Home hero');
  hero.before(heroAnchor);
  const heroMascot = hero.querySelector('kairos-mascot');
  const banner = hero.querySelector('.dashboard-core');
  const bannerAnchor = document.createComment('Home banner');
  banner?.before(bannerAnchor);
  const hiddenChrome = ['.dashboard-header', '.dashboard-next'].map(selector => hero.querySelector(selector)).filter(Boolean);
  const heading = el('header', { class: 'hm-heading' });
  // Keep the painter connected while the first week request is pending;
  // backgroundEffects disposes owners removed from the document.
  const bannerParking = el('div', { hidden: true });
  const hour = new Date().getHours();
  heading.append(el('div', {}, [el('p', { text: new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) }),
    el('h1', { text: `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}` })]));
  const controls = el('div', { class: 'hm-heading-actions' }, [pill({ text: 'New chat', onClick: () => navigate('chat') })]);
  const notificationsButton = el('button', { type: 'button', class: 'hm-phone-notifications', 'aria-label': 'Notifications', onclick: () => openNotifications(notificationsButton) });
  notificationsButton.innerHTML = ICONS.bell;
  const settingsButton = el('button', { type: 'button', class: 'hm-phone-settings', 'aria-label': 'Settings', onclick: () => navigate('settings') });
  settingsButton.innerHTML = ICONS.settings;
  controls.append(settingsButton, notificationsButton);
  heading.append(controls, bannerParking);
  const week = el('section', { class: 'dashboard-section hm-week', 'aria-label': 'This week' });
  const makeSection = (title, id, link, go) => {
    const body = el('div', { class: 'dashboard-section-body' });
    const panel = el('section', { class: 'dashboard-section', 'data-home-section': id }, [
      el('div', { class: 'dashboard-section-header' }, [el('h2', { text: title }),
        el('button', { type: 'button', class: 'btn quiet', text: link, onclick: go })]), body,
    ]);
    return { panel, body };
  };
  const needs = makeSection('Needs you', 'needs', 'See all', () => navigate('agents'));
  const working = makeSection('Working now', 'working', 'All tasks', () => navigate('tasks'));
  const models = makeSection('Model usage', 'models', 'Models', () => navigate('settings', { section: 'models' }));
  let glance = null;
  const cardFor = id => {
    if (id === 'needs') return needs.panel;
    if (id === 'working') return working.panel;
    if (id === 'models') return models.panel;
    if (id === 'stats') {
      if (!glance) glance = makeSection('At a glance', 'stats', '', () => {});
      glance.body.append(parts.stats); return glance.panel;
    }
    return parts[id];
  };
  function activityRow(item, needsYou) {
    const agent = item.agent || data().agents?.find(a => a.id === item.agentId);
    const face = !needsYou ? el('span', { class: 'hm-working-dot', 'aria-hidden': 'true' })
      : agent ? agentAvatar(agent, 40, 'needs') : createMascot({ state: 'needs', size: 40, decorative: true });
    return el('div', { class: 'hm-live-row' }, [face,
      el('button', { type: 'button', class: 'hm-live-copy', onclick: item.go }, [
        el('span', { class: 'hm-live-title', text: item.title }), el('span', { class: 'hm-live-detail', text: item.detail }),
      ]), ...(needsYou ? [pill({ text: item.action === 'Reply' ? 'Answer' : item.action,
        kind: item.action === 'Review' ? 'secondary' : 'primary', onClick: item.go })] : []),
    ]);
  }
  function drawGreeting() {
    const name = data().auth?.username;
    const greeting = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}`;
    heading.querySelector('h1').textContent = greeting + (name && name !== 'local' ? ', ' + name : '');
  }
  function drawActivity() {
    needs.body.replaceChildren(...activity.need.map(item => activityRow(item, true)));
    working.body.replaceChildren(...activity.work.map(item => activityRow(item, false)));
  }
  function statsNodes(value) {
    return [['chats', 'chats'], ['agent_runs', 'agent runs'], ['notes_done', 'notes done']]
      .filter(([key]) => !value.unavailable?.includes(key) && Number.isFinite(value.totals?.[key]))
      .map(([key, label]) => el('div', {}, [el('strong', { text: String(value.totals[key]) }), el('span', { text: label })]));
  }
  function drawWeek() {
    const value = data().week;
    week.replaceChildren();
    if (!value?.slots || value.slots.length !== 14) { week.hidden = true; return; }
    week.hidden = false;
    const date = iso => new Date(iso + 'T12:00:00');
    const start = date(value.start), end = date(value.end);
    const range = start.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' \u2013 ' +
      end.toLocaleDateString([], start.getMonth() === end.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    const shortDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const fullDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const busiest = fullDays[shortDays.indexOf(value.busiest)] || value.busiest;
    const cells = [];
    for (let r = 0; r < 6; r++) for (const [c, slot] of value.slots.entries()) {
      const level = 6 - r;
      const chats = value.unavailable?.includes('chats') ? 0 : slot.chats;
      const runs = value.unavailable?.includes('agent_runs') ? 0 : slot.agent_runs;
      cells.push(level <= chats ? 'a' : level <= chats + runs ? 'b' : (r + c) % 2 ? 'dim' : 'empty');
    }
    week.append(el('div', { class: 'dashboard-section-header' }, [el('h2', { text: 'This week' }), el('span', { class: 'hm-week-range', text: range })]),
      el('div', { class: 'hm-week-stats' }, statsNodes(value)),
      dotMatrix({ rows: 6, cols: 14, cells, label: 'Activity per half day, Monday AM to Sunday PM. Chats below agent runs; up to six per column.' }),
      el('div', { class: 'hm-week-days' }, shortDays.map(text => el('span', { text }))),
      el('div', { class: 'hm-week-legend' }, [el('span', { class: 'hm-legend-chats', text: 'Chats' }), el('span', { class: 'hm-legend-runs', text: 'Agent work' }),
        ...(busiest ? [el('span', { class: 'hm-busiest', text: 'Busiest: ' + busiest })] : [])]));
  }
  function drawUsage() {
    // Every connected model, with its quota or the tokens Kairos counted.
    const list = data().quotas?.models || [];
    models.panel.hidden = !list.length;
    models.body.replaceChildren(...(list.length ? [usageCard({ models: list })] : []));
  }
  function hasItems(id) {
    if (id === 'needs') return activity.need.length > 0;
    if (id === 'working') return activity.work.length > 0;
    if (id === 'models') return !models.panel.hidden;
    if (id === 'chats') return !!data().sessions?.length;
    // Home already applies its upcoming-event and date-only filter.
    if (id === 'schedule') return !!parts.schedule.querySelector('.dashboard-row');
    if (id === 'store') return !parts.store.hidden && parts.store.dataset.hasItems === 'true';
    const node = cardFor(id);
    return node && !node.hidden && !node.querySelector('.dashboard-empty, .skeleton');
  }
  function place(host, nodes) {
    if (host.children.length !== nodes.length || nodes.some((node, i) => host.children[i] !== node)) host.replaceChildren(...nodes);
    if (!entered) {
      entered = true; grid.classList.add('rd-stagger');
      entranceTimer = setTimeout(() => grid.classList.remove('rd-stagger'), 800);
    }
  }
  function arrange(order, hidden) {
    if (launchSurface) return false;
    if (!active) {
      active = true; ensureArrangement(); ({ order, hidden } = homeLayout());
      content.classList.add('hm-home'); content.prepend(heading);
      hiddenChrome.forEach(node => node.remove());
      customizeButton = el('button', { type: 'button', class: 'hm-customize', 'aria-label': 'Customize Home', 'aria-haspopup': 'dialog', onclick: openSheet }, [el('span', { text: 'Customize' })]);
      const customizeIcon = el('span', { class: 'hm-customize-icon', 'aria-hidden': 'true' });
      customizeIcon.innerHTML = ICONS.settings; customizeButton.append(customizeIcon);
      for (const [id, label] of [['chats', 'All chats'], ['schedule', 'Calendar'], ['system', 'Details']]) {
        const link = parts[id].querySelector('.dashboard-section-header button');
        link.textContent = label;
      }
      const calendarTitle = parts.schedule.querySelector('h2');
      calendarTitle.textContent = 'Coming up';
      controls.prepend(customizeButton); drawGreeting(); drawActivity(); drawWeek(); drawUsage();
      // Customize remains available without taking a third root-header slot.
      const phoneCustomize = el('button', { type: 'button', class: 'hm-phone-customize', text: 'Customize Home', onclick: openSheet });
      // Phone Home draws no Kip, so its style switch sits beside Customize.
      const phoneKip = el('button', { type: 'button', class: 'hm-phone-kip', 'aria-haspopup': 'dialog' });
      const kipLabel = () => { const style = getAppearance().kip; phoneKip.textContent = style === 'hidden' ? 'Show Kip' : `Kip: ${KIP_STYLE_NAMES[style]}`; };
      phoneKip.addEventListener('click', () => { if (getAppearance().kip === 'hidden') showKip(); else openKipMenu(phoneKip); });
      document.addEventListener('kairos:appearance', kipLabel);
      stopPhoneKip = () => document.removeEventListener('kairos:appearance', kipLabel);
      kipLabel();
      content.append(phoneCustomize, phoneKip);
    }
    const cards = order.filter(id => id === 'system' || (!hidden.includes(id) && hasItems(id)));
    if (!cards.includes('system')) cards.push('system');
    const defaultOrder = cards.every((id, i) => DEFAULT_ORDER.indexOf(id) >= 0 && (!i || DEFAULT_ORDER.indexOf(cards[i - 1]) < DEFAULT_ORDER.indexOf(id)));
    grid.classList.toggle('hm-custom-order', !defaultOrder);
    let ordered = cards;
    if (defaultOrder && !phone.matches) {
      // Only reorder the recent-card slots. Keep every enabled saved section.
      const recent = ['chats', 'schedule', 'models'].filter(id => cards.includes(id));
      ordered = cards.map(id => ['chats', 'schedule', 'models'].includes(id) ? recent.shift() : id);
    }
    // Reuse the one mounted Home painter across breakpoints and refreshes.
    // The detached desktop hero has no phone slogan or pointer listener.
    if (phone.matches) {
      if (banner && !week.hidden && banner.parentElement !== week) week.prepend(banner);
      else if (week.hidden) bannerParking.append(banner);
      hero.remove(); heroMascot?.removeAttribute('follow-pointer');
    } else {
      bannerAnchor.after(banner); heroMascot?.setAttribute('follow-pointer', '');
    }
    const fixed = [...(!phone.matches ? [hero] : []), ...(!week.hidden ? [week] : [])];
    const nodes = [...fixed, ...ordered.map(cardFor)].filter(Boolean);
    const groupOf = id => ['needs', 'working'].includes(id) ? 'live' : ['chats', 'schedule', 'models'].includes(id) ? 'recent' : id;
    const packed = packRows(nodes.map((node, i) => ({ id: i, span: node === hero ? 8 : node === week ? 4 : spanOf(node.dataset.homeSection),
      group: i < fixed.length ? 'hero' : node === parts.system ? 'system' : defaultOrder ? groupOf(node.dataset.homeSection) : 'custom' })));
    for (const row of packed) for (const cell of row) nodes[cell.id].style.setProperty('--rd-span', cell.span);
    place(grid, nodes);
    return true;
  }
  function deactivate() {
    if (!active) return;
    clearTimeout(entranceTimer); grid.classList.remove('rd-stagger');
    active = false; closeSheet(false); heading.remove(); content.querySelector('.hm-phone-customize')?.remove(); content.querySelector('.hm-phone-kip')?.remove(); stopPhoneKip?.(); stopPhoneKip = null; customizeButton?.remove(); customizeButton = null;
    bannerAnchor.after(banner); heroAnchor.after(hero); heroMascot?.removeAttribute('follow-pointer'); content.classList.remove('hm-home');
    grid.classList.remove('hm-custom-order');
    for (const panel of [hero, ...Object.values(parts)]) panel.style.removeProperty('--rd-span');
    for (const node of [week, needs.panel, working.panel, models.panel]) node.remove();
  }
  // -- Customize sheet -----------------------------------------------------------
  const tabCard = (id) => knownHomeCards().find((c) => c.id === id);
  function sheetRows() {
    const layout = getLayout();
    const tabs = layout.home.filter((id) => isTab(id) && tabCard(id) && layout.hiddenHome.includes(id));
    const main = layout.home.filter((id) => META[id] || (isTab(id) && tabCard(id) && !layout.hiddenHome.includes(id)));
    return { layout, main, tabs };
  }
  function change(mutate) {
    const layout = getLayout();
    mutate(layout);
    saveLayout(layout);
  }
  function swap(id, step) {
    change((layout) => {
      const { main, tabs } = sheetRows();
      const peers = main.includes(id) ? main : tabs;
      const i = layout.home.indexOf(id);
      let j = i + step;
      while (j >= 0 && j < layout.home.length && !peers.includes(layout.home[j])) j += step;
      if (j < 0 || j >= layout.home.length) return;
      [layout.home[i], layout.home[j]] = [layout.home[j], layout.home[i]];
    });
  }
  function toggleCard(id) {
    change((layout) => {
      layout.hiddenHome = layout.hiddenHome.includes(id) ? layout.hiddenHome.filter((x) => x !== id) : [...layout.hiddenHome, id];
    });
  }

  function sheetRow(id, label, sub, shown, first, last) {
    const toggle = el("button", { type: "button", class: "hm-switch", role: "switch", "aria-checked": String(shown), "aria-label": (shown ? "Hide " : "Show ") + label, "data-focus": id + ":toggle", onclick: () => toggleCard(id) }, [el("span", { class: "hm-switch-knob" })]);
    if (id === 'system') { toggle.disabled = true; toggle.setAttribute('aria-checked', 'true'); toggle.setAttribute('aria-label', 'Systems is always shown'); }
    const up = el("button", { type: "button", class: "hm-ib", "aria-label": "Move " + label + " up", "data-focus": id + ":up", text: "↑", onclick: () => swap(id, -1) });
    const down = el("button", { type: "button", class: "hm-ib", "aria-label": "Move " + label + " down", "data-focus": id + ":down", text: "↓", onclick: () => swap(id, 1) });
    up.disabled = first; down.disabled = last;
    return el("div", { class: "hm-sheet-row" }, [el("div", { class: "hm-sheet-text" }, [el("div", { class: "hm-sheet-label", text: label }), el("div", { class: "hm-sheet-sub", text: sub })]), toggle, up, down]);
  }

  function drawSheet() {
    if (!sheet) return;
    const focused = document.activeElement?.dataset?.focus;
    const { layout, main, tabs } = sheetRows();
    const shownCount = [...main, ...tabs].filter((id) => !layout.hiddenHome.includes(id)).length;
    const list = (ids, labelOf, subOf) => ids.map((id, i) => sheetRow(id, labelOf(id), subOf(id), !layout.hiddenHome.includes(id), i === 0, i === ids.length - 1));
    sheet.list.replaceChildren(
      el("div", { class: "hm-sheet-group" }, [el("h3", { text: "Cards" }), el("span", { text: `${shownCount} of ${main.length + tabs.length} shown` })]),
      ...list(main, (id) => META[id]?.label || tabCard(id).title, (id) => META[id]?.sub || "From " + tabCard(id).tab_name),
      ...(tabs.length ? [el("div", { class: "hm-sheet-group" }, [el("h3", { text: "From your tabs" })]), ...list(tabs, (id) => tabCard(id).title, (id) => "From " + tabCard(id).tab_name)] : []),
    );
    if (focused) sheet.list.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }

  function openSheet(event) {
    if (sheet) return;
    const returnTo = event?.currentTarget || document.activeElement;
    const done = el("button", { type: "button", class: "hm-btn hm-btn-primary", text: "Done", onclick: () => closeSheet(true) });
    const list = el("div", { class: "hm-sheet-list" });
    const panel = el("aside", { class: "hm-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Customize Home" }, [
      el("div", { class: "hm-sheet-top" }, [el("h2", { text: "Customize Home" }), done]),
      el("p", { class: "hm-sheet-intro", text: "Switch cards on or off and move them up or down. Your choices are saved on this device." }),
      list,
      el("div", { class: "hm-sheet-foot" }, [
        el("button", { type: "button", class: "hm-btn hm-btn-secondary", text: "Reset to default", onclick: () => applyDefault() }),
        el("button", { type: "button", class: "hm-link", text: "Layout settings ↗", onclick: () => { closeSheet(false); navigate("settings", { section: "layout" }); } }),
      ]),
    ]);
    const scrim = el("div", { class: "hm-scrim", "aria-hidden": "true", onclick: () => closeSheet(true) });
    const root = el("div", { class: "hm-sheet-root" }, [scrim, panel]);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeSheet(true); return; }
      if (e.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll("button:not([disabled])")];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.append(root);
    sheet = { root, list, returnTo };
    drawSheet();
    done.focus();
  }
  function closeSheet(restore) {
    if (!sheet) return;
    const { root, returnTo } = sheet;
    sheet = null;
    root.remove();
    if (restore && returnTo?.isConnected) returnTo.focus();
  }

  const stopActivity = subscribeActivity(value => {
    activity = value;
    if (!active || disposed) return;
    drawActivity(); rearrange();
  });
  const onLayout = () => { if (active) drawSheet(); };
  const onPhone = () => { if (active) rearrange(); };
  phone.addEventListener('change', onPhone);
  document.addEventListener('kairos:layout', onLayout);
  return { arrange, update(key) {
    if (!active || disposed) return;
    if (key === 'auth') drawGreeting();
    if (key === 'week') drawWeek();
    if (key === 'quotas') drawUsage();
    if (key === 'agents') drawActivity();
    rearrange();
  }, dispose() {
    disposed = true; stopActivity(); deactivate(); heroAnchor.remove(); bannerAnchor.remove();
    phone.removeEventListener('change', onPhone);
    document.removeEventListener('kairos:layout', onLayout);
  } };
}
