import { dateOnly, eventColor, itemsOnDay, googleCalendars, eventDialog, weekGrid, deleteCalendarEvent } from '../googleCalendar.js';
import { api, el, iconButton, openPanelDialog } from "../api.js";
import { ICONS } from "../icons.js";
import { segmented } from '../kairosParts.js';
import { redesignOn, workspaceEmpty } from '../workspaceParts.js';

// Real visual monthly grid, resized to leave room for a day-detail panel
// (David's ask, 2026-08-31) that lists every event/note for whichever day
// was last clicked, with delete. Still built on the same merged
// /api/calendar/events range endpoint, so real events and due-dated Notes
// both render in-grid and in the detail panel, tagged by source.
//
// Follow-up asks, same day: (1) default day-panel state (nothing selected)
// shows the next 7 days grouped by day, not a dead "click a day" prompt;
// (2) real bug fix — the "Today" button only reset the month, never
// actually selected/showed today; (3) checkboxes to mark an event or note
// complete directly from Calendar, persisted (real calendar events now have
// a `completed` field — see services/calendar_service.py — and it survives
// a CalDAV/iCal re-sync via the feed's own UID).

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Real bug found live (David: synced Canvas iCal items "displayed a day
// early"). All-day items store a bare "YYYY-MM-DD" string (no time/offset —
// see core/dav_client.py's _to_iso for date-only DTSTART values, e.g. every
// Canvas assignment due date). `new Date("2026-09-05")` parses that per the
// ISO 8601 spec as UTC midnight; toDateString() then renders it in the
// browser's LOCAL timezone, which rolls back to the previous day for any
// timezone behind UTC (Eastern US included) — the exact off-by-one David
// hit. Fixed by building the Date from its literal Y/M/D components
// (local, no UTC round-trip) for date-only values instead of handing the
// bare string to `new Date()`. Timed events (which include an actual time
// and usually a "Z") are unaffected and keep the normal parse.
function localDayKey(item) {
  if (item.all_day && !String(item.start).includes("T")) {
    const [y, m, d] = item.start.split("-").map(Number);
    return new Date(y, m - 1, d).toDateString();
  }
  return new Date(item.start).toDateString();
}

let viewMonth = new Date();
viewMonth.setDate(1);
viewMonth.setHours(0, 0, 0, 0);

const phoneCalendar = () => redesignOn() && window.matchMedia('(max-width: 768px)').matches;
const weekOffset = date => redesignOn() ? (date.getDay() + 6) % 7 : date.getDay();

const hiddenSources = new Set();
let selectedDayKey = null;
let viewMode = 'month';
let viewDay = new Date();
viewDay.setHours(0, 0, 0, 0);
let viewWeek = new Date();
viewWeek.setHours(0, 0, 0, 0);
viewWeek.setDate(viewWeek.getDate() - weekOffset(viewWeek));

export async function render(container) {
  container.innerHTML = "";
  container.classList.add("cal-layout");
  selectedDayKey = redesignOn() ? viewDay.toDateString() : null;
  if (!redesignOn() && viewMode === 'day') viewMode = 'month';

  const left = el("div", { class: "cal-left" });
  const header = el("div", { class: "view-header" }, [
    el("div", {}, [
      el("h2", { text: "Calendar" }),
      el("div", { class: "sub", text: "Make room for what matters. Events and deadlines, together." }),
    ]),
  ]);

  const createBar = buildCreateBar();
  const calendarList = el('div', { class: 'cal-calendar-list' });
  const calendarStore = el('section', { class: 'cal-calendars-card', hidden: true }, [...(redesignOn() ? [el('h3', { text: 'Calendars' })] : []), calendarList]);
  createBar._calendarStore = calendarStore;
  const calendarsBtn = el('button', { type: 'button', class: 'btn cal-calendars-trigger', text: redesignOn() ? 'Your calendars' : 'Google calendars', 'aria-label': redesignOn() ? 'Your calendars' : 'Google calendars', 'aria-haspopup': 'dialog' });
  calendarsBtn.insertAdjacentHTML('afterbegin', redesignOn() ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>' : ICONS.calendar);
  calendarsBtn.addEventListener('click', () => {
    calendarStore.hidden = false; calendarStore._inDialog = true;
    const dialog = openPanelDialog({ title: redesignOn() ? 'Your calendars' : 'Google calendars', body: calendarStore, opener: calendarsBtn,
      owner: container, group: 'calendar-selection', className: 'cal-calendars-dialog',
      onClose: () => { calendarStore._dialog = null; calendarStore._inDialog = false; calendarStore.hidden = !(redesignOn() && !phoneCalendar() && viewMode === 'month'); (calendarStore.hidden ? left : dayPanel).append(calendarStore); } });
    calendarStore._dialog = dialog;
    dialog.panel.classList.add('rd-sheet-in');
    dialog.panel.dataset.view = 'calendar';
    dialog.panel.addEventListener('animationend', () => dialog.panel.classList.remove('rd-sheet-in'), { once: true });
    dialog.panel.parentElement.classList.add('rd-scrim-in');
  });
  header.append(calendarsBtn);

  const nav = el("div", { class: "cal-nav" });
  const monthLabel = el(redesignOn() ? "button" : "div", { type: "button", class: "cal-month-label", ...(redesignOn() ? { "aria-label": "Today", title: "Go to today" } : {}) });
  const prevBtn = el("button", { class: "btn", text: "‹ Prev" });
  const todayBtn = el("button", { class: "btn", text: "Today" });
  const nextBtn = el("button", { class: "btn", text: "Next ›" });
  const archiveBtn = el("button", { class: "btn", text: "Archive", style: "margin-left:auto;" });
  const monthBtn = el('button', { class: 'btn', text: 'Month', 'aria-pressed': String(viewMode === 'month') });
  const weekBtn = el('button', { class: 'btn', text: 'Week', 'aria-pressed': String(viewMode === 'week') });
  // The wrapper only lets the redesign draw Month and Week as one segmented
  // control; with the switch off it is display: contents (redesign-calendar.css).
  const viewSwitch = redesignOn() ? segmented({ label: 'Calendar view', value: viewMode,
    options: ['day', 'week', 'month'].map(value => ({ value, text: value[0].toUpperCase() + value.slice(1) })),
    onChange: mode => setMode(mode) })
    : el('div', { class: 'cal-view-switch', role: 'group', 'aria-label': 'Calendar view' }, [monthBtn, weekBtn]);
  viewSwitch.classList.add('cal-range-switch');
  if (redesignOn()) {
    viewSwitch.classList.add('cal-view-switch');
    for (const button of viewSwitch.querySelectorAll('button')) {
      const mode = button.textContent.toLowerCase();
      button.setAttribute('aria-pressed', String(viewMode === mode));
    }
  }
  if (redesignOn()) {
    prevBtn.textContent = '\u2039'; nextBtn.textContent = '\u203a';
    prevBtn.classList.add('cal-period-prev'); nextBtn.classList.add('cal-period-next');
    prevBtn.setAttribute('aria-label', 'Previous period'); nextBtn.setAttribute('aria-label', 'Next period');
    nav.append(monthLabel, prevBtn, nextBtn, viewSwitch);
    calendarStore.append(archiveBtn);
    if (phoneCalendar()) calendarStore.append(
      el('button', { type: 'button', class: 'btn', text: 'Previous period', onclick: () => shift(-1) }),
      el('button', { type: 'button', class: 'btn', text: 'Next period', onclick: () => shift(1) }));
  } else nav.append(prevBtn, todayBtn, monthLabel, nextBtn, viewSwitch, archiveBtn);

  const grid = el("div", { class: "cal-grid glass" });
  const phoneDays = el('div', { class: 'cal-phone-days workspace-phone-only', role: 'group', 'aria-label': 'Choose a day' });
  createBar._phoneDays = phoneDays;
  // Phone has a title row and a range row; desktop owns all controls in one header.
  if (redesignOn()) {
    header.append(createBar);
    createBar.querySelector('button').setAttribute('aria-label', phoneCalendar() ? 'Add' : 'New event');
    if (phoneCalendar()) left.append(header, calendarStore, nav, phoneDays, grid);
    else { header.append(nav, calendarsBtn, createBar); left.append(header, calendarStore, phoneDays, grid); }
  } else {
    left.append(header, createBar, calendarStore, nav, phoneDays, grid);
  }

  const dayPanel = el("div", { class: "glass bracket cal-day-panel rd-stagger" });

  container.append(left, dayPanel);

  const refresh = () => renderGrid(monthLabel, grid, createBar, dayPanel);
  createBar._refresh = refresh;
  createBar._owner = left;
  const setMode = mode => {
    const today = new Date();
    const anchorDay = selectedDayKey ? new Date(selectedDayKey) : viewMode === 'day' ? viewDay : viewMode === 'week' ? viewWeek
      : viewMonth.getFullYear() === today.getFullYear() && viewMonth.getMonth() === today.getMonth() ? today : viewMonth;
    if (mode !== viewMode) {
      if (mode === 'week') {
        viewWeek = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), anchorDay.getDate() - weekOffset(anchorDay));
      } else if (mode === 'month') {
        viewMonth = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), 1);
      }
      if (mode === 'day') viewDay = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), anchorDay.getDate());
    }
    viewMode = mode;
    monthBtn.setAttribute('aria-pressed', String(mode === 'month'));
    weekBtn.setAttribute('aria-pressed', String(mode === 'week'));
    for (const button of viewSwitch.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.textContent.toLowerCase() === mode));
    }
    selectedDayKey = redesignOn() ? anchorDay.toDateString() : null; refresh();
  };
  monthBtn.onclick = () => setMode('month'); weekBtn.onclick = () => setMode('week');
  const shift = amount => {
    if (viewMode === 'day') viewDay.setDate(viewDay.getDate() + amount);
    else if (viewMode === 'week') viewWeek.setDate(viewWeek.getDate() + amount * 7);
    else viewMonth.setMonth(viewMonth.getMonth() + amount);
    if (redesignOn()) {
      const anchor = viewMode === 'day' ? viewDay : viewMode === 'week' ? viewWeek : viewMonth;
      selectedDayKey = anchor.toDateString();
      viewDay = new Date(anchor);
    }
    refresh();
  };
  prevBtn.onclick = () => shift(-1); nextBtn.onclick = () => shift(1);
  // Real bug found live (David: "Today" didn't bring you to the actual
  // day") — this only ever reset the month, it never set selectedDayKey or
  // showed today in the panel, so the grid re-rendered on the current
  // month but nothing was actually selected. Now it jumps to the current
  // month AND selects/shows today, same as clicking today's cell would.
  const goToday = () => {
    const today = new Date();
    viewDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    viewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    viewWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekOffset(today));
    createBar._dateInput.value = dateOnly(today);
    selectedDayKey = today.toDateString();
    renderGrid(monthLabel, grid, createBar, dayPanel);
  };
  todayBtn.addEventListener("click", goToday);
  if (redesignOn()) monthLabel.addEventListener("click", goToday);
  archiveBtn.addEventListener("click", () => { calendarStore._dialog?.close(); openArchiveModal(() => renderGrid(monthLabel, grid, createBar, dayPanel)); });

  try {
    createBar._calendars = await googleCalendars(calendarList, reconnect => reconnect ? render(container) : refresh());
  } catch (error) { calendarList.append(el('div', { class: 'meta', text: `Google calendars unavailable: ${error.message}` })); }
  if (redesignOn()) {
    for (const [source, label] of [['calendar', 'Kairos'], ['note', 'Notes with due times'], ['tab', 'Workspace deadlines']]) {
      const check = el('input', { type: 'checkbox', checked: !hiddenSources.has(source) });
      check.onchange = () => { check.checked ? hiddenSources.delete(source) : hiddenSources.add(source); refresh(); };
      calendarList.append(el('label', { class: 'cal-calendar-choice' }, [check, label]));
    }
    calendarList.append(el('button', { type: 'button', class: 'btn quiet cal-connect', text: 'Connect another calendar', onclick: () => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'library', section: 'google' } })) }));
  }
  dayPanel._createBar = createBar;
  await refresh();
  if (!grid.isConnected) return;
  const timer = setInterval(() => { if (viewMode !== 'month') refresh(); }, 60000);
  const observer = new MutationObserver(() => {
    if (!grid.isConnected) { clearInterval(timer); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function buildCreateBar() {
  const bar = el('div', { class: 'cal-create-bar' });
  bar._dateInput = el('input', { type: 'date', value: dateOnly(new Date()) });
  bar._calendars = [];
  bar.append(el('button', { type: 'button', class: 'btn primary', text: redesignOn() ? (phoneCalendar() ? '+' : 'New event') : '+ Add an event', onclick: () => {
    const day = new Date(`${bar._dateInput.value}T00:00:00`);
    eventDialog(bar._calendars, bar._refresh, null, day, bar._owner);
  } }));
  return bar;
}

async function renderGrid(monthLabel, grid, createBar, dayPanel) {
  // Month also loads Next 7 Days. Keep the panel busy until both requests
  // settle, so a previous selected day's late response is not treated as ready.
  dayPanel.setAttribute('aria-busy', 'true');
  const pending = renderGridContent(monthLabel, grid, createBar, dayPanel);
  const generation = grid._generation;
  try { await pending; }
  finally {
    if (generation === grid._generation) dayPanel.setAttribute('aria-busy', 'false');
  }
}

async function renderGridContent(monthLabel, grid, createBar, dayPanel) {
  monthLabel.textContent = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const generation = grid._generation = (grid._generation || 0) + 1;
  const mode = viewMode;
  const firstOfMonth = new Date(viewMonth);
  const gridStart = new Date(mode === 'day' ? viewDay : mode === 'week' ? viewWeek : firstOfMonth);
  if (mode !== 'day') gridStart.setDate(gridStart.getDate() - weekOffset(gridStart));

  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridEnd.getDate() + (mode === 'day' ? 1 : mode === 'week' ? 7 : 42));
  if (mode === 'day') createBar._dateInput.value = dateOnly(gridStart);

  const items = (await api(`/api/calendar/events?start=${encodeURIComponent(gridStart.toISOString())}&end=${encodeURIComponent(gridEnd.toISOString())}`)).filter(item => !redesignOn() || !hiddenSources.has(item.source));

  if (generation !== grid._generation || !grid.isConnected) return;
  const isCurrent = () => generation === grid._generation && grid.isConnected;
  const byDay = {};
  const previousScroll = grid.scrollTop;
  const enteringView = grid._viewMode !== mode;
  grid._viewMode = mode;
  grid.innerHTML = '';
  grid.classList.toggle('cal-week-grid', mode !== 'month');
  grid.classList.toggle('cal-single-day', mode === 'day');
  grid.parentElement.dataset.calendarRange = mode;
  if (createBar._calendarStore && !createBar._calendarStore._inDialog) createBar._calendarStore.hidden = !(redesignOn() && !phoneCalendar() && mode === 'month');
  if (createBar._phoneDays) {
    const monday = new Date(viewDay);
    monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
    createBar._phoneDays.replaceChildren(...Array.from({ length: 7 }, (_, i) => {
      const date = new Date(monday); date.setDate(date.getDate() + i);
      return el('button', { type: 'button', 'aria-label': date.toDateString(), 'aria-current': dateOnly(date) === dateOnly(new Date()) ? 'date' : 'false', 'aria-pressed': String(dateOnly(date) === dateOnly(viewDay)), onclick: () => {
        viewDay = date; selectedDayKey = date.toDateString(); refresh();
      } }, [el('small', { text: date.toLocaleDateString(undefined, { weekday: 'short' }) }), el('span', { text: String(date.getDate()) })]);
    }));
  }
  const refresh = () => renderGrid(monthLabel, grid, createBar, dayPanel);
  if (mode !== 'month') {
    const last = new Date(gridEnd); last.setDate(last.getDate() - 1);
    monthLabel.textContent = mode === 'day' ? gridStart.toLocaleDateString(undefined, phoneCalendar() ? { month: 'long', year: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : `${gridStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} \u2013 ${last.toLocaleDateString(undefined, { ...(last.getMonth() !== gridStart.getMonth() ? { month: 'short' } : {}), day: 'numeric', ...(!phoneCalendar() ? { year: 'numeric' } : {}) })}`;
    weekGrid(grid, gridStart, items, (date, dayItems) => {
      selectedDayKey = date.toDateString(); createBar._dateInput.value = dateOnly(date);
      if (redesignOn()) viewDay = new Date(date);
      renderDayPanel(dayPanel, date, dayItems, refresh);
    }, (item, date, dayItems) => {
      if ((item.source === 'google' && item.editable) || item.source === 'calendar')
        eventDialog(createBar._calendars, refresh, item, date, createBar._owner);
      else renderDayPanel(dayPanel, date, dayItems, refresh);
    }, mode === 'day' ? 1 : 7);
    grid.scrollTop = enteringView ? (redesignOn() ? 8 * (phoneCalendar() ? 28 : 42) : Math.max(0, (new Date().getHours() - 1) * 42)) : previousScroll;
    let legend = grid.parentElement.querySelector('.cal-legend');
    if (redesignOn() && mode === 'week') {
      if (!legend) { legend = el('div', { class: 'cal-legend', 'aria-label': 'Calendar legend' }); grid.parentElement.append(legend); }
      const sources = new Map();
      for (const item of items) sources.set(item.calendar_id || item.source, item);
      legend.replaceChildren(...[...sources.values()].map(item => eventColor(el('span', { class: `cal-legend-item cal-src-${item.source || 'event'}`, text: item.calendar_name || item.source_label || (item.source === 'google' ? 'Google' : item.source === 'note' ? 'Notes' : 'Kairos') }), item)));
    }
    if (mode === 'day') grid.parentElement.querySelector('.cal-legend')?.remove();
    if (mode === 'day') await renderDayPanel(dayPanel, gridStart, itemsOnDay(items, gridStart), refresh);
    else if (selectedDayKey) await renderDayPanel(dayPanel, new Date(selectedDayKey), itemsOnDay(items, new Date(selectedDayKey)), refresh);
    else await renderUpcomingPanel(dayPanel, refresh, isCurrent);
    return;
  }
  grid.parentElement.querySelector('.cal-legend')?.remove();
  for (const wd of (redesignOn() ? [...WEEKDAYS.slice(1), WEEKDAYS[0]] : WEEKDAYS)) grid.appendChild(el('div', { class: 'cal-weekday', text: phoneCalendar() ? wd[0] : wd }));
  const cursor = new Date(gridStart);
  const currentMonth = firstOfMonth.getMonth();
  const todayKey = new Date().toDateString();
  // Fit the redesign to the actual month; classic retains its six-week grid.
  const weeks = redesignOn() ? Math.ceil((weekOffset(firstOfMonth) + new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 0).getDate()) / 7) : 6;
  grid.style.setProperty('--calendar-weeks', weeks);
  for (let i = 0; i < weeks * 7; i++) {
    const dayKey = cursor.toDateString();
    const isOtherMonth = cursor.getMonth() !== currentMonth;
    const cell = el("button", { type: "button", "aria-label": dayKey, class: "cal-day" + (isOtherMonth ? " other-month" : "") + (dayKey === todayKey ? " today" : "") + (dayKey === selectedDayKey ? " selected" : "") });
    if (!(redesignOn() && phoneCalendar() && isOtherMonth)) cell.appendChild(el("div", { class: "cal-day-num", text: String(cursor.getDate()) }));
    if (redesignOn() && phoneCalendar() && isOtherMonth) { cell.disabled = true; cell.setAttribute('aria-label', 'Outside this month'); }

    const dayItems = byDay[dayKey] = itemsOnDay(items, cursor);
    for (const item of (redesignOn() && phoneCalendar() && isOtherMonth ? [] : dayItems.slice(0, 2))) {
      cell.appendChild(eventColor(el("div", { class: "cal-event-pill " + (item.source === "note" ? "note" : "event") + ` cal-src-${item.source || "event"}` + (item.completed ? " completed" : ""), text: item.title, title: item.title }), item));
    }
    const overflow = dayItems.length - 2;
    if (overflow > 0 && !(redesignOn() && phoneCalendar() && isOtherMonth)) cell.appendChild(el("div", { class: "cal-event-pill overflow", text: `+${overflow} more` }));

    const dateForForm = dateOnly(cursor);
    const dayDate = new Date(cursor);
    cell.addEventListener("click", () => {
      createBar._dateInput.value = dateForForm;
      selectedDayKey = dayKey;
      if (redesignOn()) viewDay = new Date(dayDate);
      renderDayPanel(dayPanel, dayDate, dayItems, refresh);
      [...grid.querySelectorAll(".cal-day")].forEach((c) => c.classList.remove("selected"));
      cell.classList.add("selected");
    });

    grid.appendChild(cell);
    cursor.setDate(cursor.getDate() + 1);
  }

  // Show the selected agenda (with upcoming items below it in the redesign),
  // or the next-7-days list if nothing is selected (David's ask 2026-08-31 — the old default was just
  // a dead "click a day" prompt with nothing actually useful in it).
  if (selectedDayKey) {
    for (const [key, dayItems] of Object.entries(byDay)) {
      if (key === selectedDayKey) {
        await renderDayPanel(dayPanel, new Date(key), dayItems, refresh);
        return;
      }
    }
    // Selected day has no items but is still a real day (e.g. today with
    // nothing scheduled) — reconstruct its Date from the key itself.
    await renderDayPanel(dayPanel, new Date(selectedDayKey), [], refresh);
  } else {
    await renderUpcomingPanel(dayPanel, refresh, isCurrent);
  }
}

async function renderUpcomingPanel(dayPanel, onChange, isCurrent = () => dayPanel.isConnected) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const items = (await api(`/api/calendar/events?start=${encodeURIComponent(today.toISOString())}&end=${encodeURIComponent(weekEnd.toISOString())}`))
    .filter(item => !item.completed && (!redesignOn() || !hiddenSources.has(item.source)));
  if (!isCurrent()) return;

  dayPanel.innerHTML = "";
  dayPanel.appendChild(el("div", { class: "cal-day-panel-title", text: "Next 7 Days" }));

  if (items.length === 0) {
    dayPanel.appendChild((redesignOn() ? workspaceEmpty({ title: 'Nothing coming up.', hint: 'Make room for something new.', actionLabel: 'Add an event', onAction: () => dayPanel._createBar?.querySelector('button')?.click() }) : el("div", { class: "empty-state", text: "Nothing coming up." })));
    return;
  }

  const cursor = new Date(today);
  for (let i = 0; i < 7; i++) {
    const dayItems = itemsOnDay(items, cursor);
    if (dayItems && dayItems.length > 0) {
      dayPanel.appendChild(el("div", {
        class: "cal-upcoming-day-label",
        text: i === 0 ? "Today" : cursor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
      }));
      for (const item of dayItems) appendItemCard(dayPanel, item, onChange, true);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
}

async function renderDayPanel(dayPanel, date, items, onChange) {
  // The selected agenda shares the active-only list with Next 7 Days.
  // Range responses can still include completed calendar and tab items.
  items = items.filter(item => !item.completed);
  let upcomingReady;
  const store = dayPanel._createBar?._calendarStore;
  // Keep the live filter controls attached while rebuilding the selected day.
  if (store && !store._inDialog) dayPanel._createBar._owner.append(store);
  dayPanel.innerHTML = "";
  const selected = el('section', { class: 'cal-selected-agenda' });
  selected._createBar = dayPanel._createBar;
  const target = redesignOn() ? selected : dayPanel;
  target.appendChild(el("div", { class: "cal-day-panel-title", text: date.toLocaleDateString(undefined, { weekday: "long", month: redesignOn() ? "short" : "long", day: "numeric" }) }));
  if (redesignOn()) {
    const counts = ['No events', 'One event', 'Two events', 'Three events'];
    target.append(el('h3', { class: 'cal-day-count', text: counts[items.length] || `${items.length} events` }));
    dayPanel.append(selected);
    if (viewMode === 'month') {
      const store = dayPanel._createBar?._calendarStore;
      if (store && !phoneCalendar() && !store._inDialog) { store.hidden = false; dayPanel.append(store); }
      const upcoming = el('section', { class: 'cal-upcoming' }); upcoming._createBar = dayPanel._createBar;
      dayPanel.append(upcoming);
      upcomingReady = renderUpcomingPanel(upcoming, onChange, () => upcoming.isConnected && dayPanel.querySelector('.cal-upcoming') === upcoming);
    }
  }

  if (items.length === 0) {
    target.appendChild((redesignOn() ? workspaceEmpty({ title: 'Nothing on this day.', hint: 'Make room for something new.', actionLabel: 'Add an event', onAction: () => dayPanel._createBar?.querySelector('button')?.click() }) : el("div", { class: "empty-state", text: "Nothing on this day." })));
    await upcomingReady;
    return;
  }

  const rows = redesignOn() && viewMode === 'month' ? el('div', { class: 'cal-selected-events' }) : target;
  rows._createBar = dayPanel._createBar;
  if (rows !== target) target.append(rows);
  for (const item of items) appendItemCard(rows, item, onChange);
  await upcomingReady;
}

// Shared by both the day panel and the upcoming list — a checkbox to mark
// an event/note complete (David's ask 2026-08-31), plus delete for
// calendar-sourced items (note-backed ones are deleted from Notes, not
// here). Upcoming cards fade out after completion, then `refreshGrid`
// re-fetches the grid and panel so their completion state stays in sync.
function appendItemCard(dayPanel, item, refreshGrid, upcoming = false) {
  const edit = () => eventDialog(dayPanel._createBar?._calendars || [], refreshGrid, item,
    new Date(localDayKey(item)), dayPanel._createBar?._owner);
  if (item.source === 'google') {
    const actions = el('div', { class: 'row-actions' });
    if (item.editable) actions.append(
      el('button', { type: 'button', class: 'btn quiet', text: 'Edit', onclick: edit }),
      iconButton(ICONS.trash, 'Delete event', () => deleteCalendarEvent(item, refreshGrid, dayPanel._createBar?._owner), { danger: true }),
    );
    appendAgendaCard(dayPanel, eventColor(el('div', { class: 'glass card has-row-actions' + (item.completed ? ' cal-item-completed' : '') }, [
      el('div', { class: 'title', text: item.title }),
      el('div', { class: 'meta', text: `${item.calendar_name} · ${item.all_day ? 'All day' : new Date(item.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` }), actions,
    ]), item), item);
    return;
  }
  const checkbox = el("input", { type: "checkbox" });
  checkbox.checked = !!item.completed;
  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true;
    try {
      if (item.source === "calendar") {
        await api(`/api/calendar/events/${item.id}`, { method: "PATCH", body: JSON.stringify({ completed: checkbox.checked }) });
      } else if (item.source === "tab") {
        await api(item.toggle_url, { method: "PATCH", body: JSON.stringify({ completed: checkbox.checked }) });
      } else {
        await api(`/api/notes/${item.id}`, { method: "PATCH", body: JSON.stringify({ completed: checkbox.checked }) });
      }
      if (upcoming && checkbox.checked && card.isConnected && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        await card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.catch(() => {});
      }
      await refreshGrid();
    } finally {
      checkbox.disabled = false;
    }
  });

  const canDelete = item.source === "calendar";
  const trailing = canDelete
    ? el("div", { class: "row-actions" }, [
        el("button", { type: "button", class: "btn quiet", text: "Edit", onclick: edit }),
        iconButton(ICONS.trash, "Delete event", () => deleteCalendarEvent(item, refreshGrid, dayPanel._createBar?._owner), { danger: true }),
      ])
    : el("span", { class: "meta", text: item.source === "tab" ? item.source_label : "From Notes" });

  const card = el("div", { class: "glass card has-row-actions" + (item.completed ? " cal-item-completed" : "") }, [
    el("div", { class: "card-row" }, [
      redesignOn() ? el("label", { class: "cal-completion-hit", "aria-label": "Mark complete" }, [checkbox]) : checkbox,
      el("div", { style: "flex:1;" }, [
        el("div", { class: "title", text: item.title }),
        el("div", { class: "meta", text: item.all_day ? "All day" : new Date(item.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }),
      ]),
      trailing,
    ]),
  ]);
  appendAgendaCard(dayPanel, card, item);
}

function appendAgendaCard(panel, card, item) {
  if (redesignOn()) {
    card.classList.add('cal-agenda-card');
    const source = item.calendar_name || (item.source === 'google' ? 'Google' : item.source === 'note' ? 'Notes' : item.source === 'tab' ? item.source_label : 'Kairos');
    card.append(el('span', { class: 'cal-agenda-source', text: source }));
    const clock = el('div', { class: 'cal-agenda-clock', text: item.all_day ? 'All day' : (viewMode === 'month' ? [item.start] : [item.start, item.end]).filter(Boolean).map(value => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })).join(' \u2013 ') });
    card.append(clock);
    card.prepend(el('span', { class: 'workspace-phone-only cal-agenda-hour', text: item.all_day ? 'All day' : new Date(item.start).toLocaleTimeString([], { hour: 'numeric' }) }));
  }
  panel.appendChild(card);
}

// -- Archive (David's ask, 2026-08-31): a real modal listing every checked-
// off event/note with a Reopen action, not date-range-limited so a
// completed item stays findable regardless of when it was scheduled.
// Reuses the same .modal-backdrop/.modal-panel pattern as the workspace
// picker (static/js/views/chat.js) and Settings window.
let archiveModal = null;

function getArchiveModal() {
  if (archiveModal) return archiveModal;
  const closeBtn = el("button", { class: "modal-close-btn", text: "✕" });
  const body = el("div", { style: "overflow-y:auto;flex:1;margin-top:10px;" });
  const panel = el("div", { class: "glass modal-panel cal-archive-panel rd-sheet-in" }, [
    el("h4", { text: "Archive" }, [closeBtn]),
    el("div", { class: "muted", text: "Checked-off events and notes. Reopen to bring one back to the active calendar." }),
    body,
  ]);
  const backdrop = el("div", { class: "modal-backdrop hidden rd-scrim-in" }, [panel]);
  panel.dataset.view = 'calendar';
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.classList.add("hidden"); });
  panel.addEventListener("click", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", () => backdrop.classList.add("hidden"));
  document.body.appendChild(backdrop);
  archiveModal = { backdrop, body };
  return archiveModal;
}

async function openArchiveModal(onChange) {
  const modal = getArchiveModal();
  modal.backdrop.classList.remove("hidden");
  await refreshArchive(modal.body, onChange);
}

async function refreshArchive(body, onChange) {
  const [events, notes] = await Promise.all([
    api("/api/calendar/events/archived"),
    api("/api/notes?include_completed=true"),
  ]);
  const completedNotes = notes.filter((n) => n.completed && n.due_date);
  const items = [
    ...events.map((e) => ({ ...e, source: "calendar" })),
    ...completedNotes.map((n) => ({ id: n.id, title: n.text, start: n.due_date, all_day: false, source: "note" })),
  ].sort((a, b) => new Date(b.start) - new Date(a.start));

  body.innerHTML = "";
  if (items.length === 0) {
    body.appendChild(el("div", { class: "empty-state", text: "Nothing archived yet." }));
    return;
  }

  for (const item of items) {
    const reopenBtn = el("button", { class: "btn", text: "Reopen" });
    reopenBtn.addEventListener("click", async () => {
      if (item.source === "calendar") {
        await api(`/api/calendar/events/${item.id}`, { method: "PATCH", body: JSON.stringify({ completed: false }) });
      } else {
        await api(`/api/notes/${item.id}`, { method: "PATCH", body: JSON.stringify({ completed: false }) });
      }
      await refreshArchive(body, onChange);
      await onChange();
    });
    body.appendChild(el("div", { class: "card-row", style: "justify-content:space-between;align-items:center;margin-top:8px;" }, [
      el("div", {}, [
        el("div", { class: "title", style: "font-size:12.5px;", text: item.title }),
        // localDayKey's same all-day-safe date handling — a bare "YYYY-MM-DD"
        // (every all-day/Canvas-style event) must not round-trip through
        // new Date()'s UTC parsing, or it hits the exact off-by-one bug
        // already fixed above for the month grid.
        el("div", { class: "meta", text: `${item.source === "note" ? "Note" : "Event"} · ${new Date(localDayKey(item)).toLocaleDateString()}` }),
      ]),
      reopenBtn,
    ]));
  }
}
