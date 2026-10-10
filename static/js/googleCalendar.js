import { api, el, toast, openPanelDialog } from './api.js';
import { repeatControls } from './calendarRepeat.js';

export function dateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function eventColor(node, item) {
  const color = item.calendar_color || item.color;
  if (item.source === 'google' && /^#[a-f\d]{6}$/i.test(color || '')) {
    node.style.setProperty('--calendar-color', color);
    node.classList.add('cal-google-event');
  }
  return node;
}

export function itemsOnDay(items, day) {
  const next = new Date(day); next.setDate(next.getDate() + 1);
  return items.filter(item => {
    if (item.all_day && !item.start.includes('T')) {
      const key = dateOnly(day);
      // Google all-day ends are exclusive; feed/local date semantics stay intact.
      return item.source === 'google' || item.end_exclusive ? item.start <= key && key < item.end : item.start === key;
    }
    const start = new Date(item.start), end = item.end ? new Date(item.end) : new Date(start.getTime() + 1);
    return start < next && (end > day || (start.getTime() === end.getTime() && start >= day));
  });
}

export async function googleCalendars(host, onChange) {
  const auth = await api('/api/auth/status');
  if (!auth.is_admin) return [];
  const status = await api('/api/google/status');
  if (!status.connected) {
    host.append(el('div', { class: 'meta', text: 'Connect Google in Library to add your calendars.' }));
    return [];
  }
  if (!status.calendar_connected) {
    const reconnect = el('button', { class: 'btn', text: 'Reconnect to add Calendar' });
    const onHost = Boolean(window.jarvis?.openGoogleSignIn) || ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);
    reconnect.disabled = !onHost;
    reconnect.onclick = async () => {
      try {
        const result = await api('/api/google/oauth/start', { method: 'POST', body: '{}' });
        if (window.jarvis?.openGoogleSignIn) await window.jarvis.openGoogleSignIn(result.url);
        else window.open(result.url, '_blank', 'noopener');
        reconnect.disabled = true;
        const started = Date.now();
        const poll = async () => {
          if (!host.isConnected) return;
          if (Date.now() - started > 600000) { reconnect.disabled = false; return; }
          try {
            if ((await api('/api/google/status')).calendar_connected) { await onChange(true); return; }
          } catch { /* sign-in may still be in progress */ }
          setTimeout(poll, 1800);
        };
        poll();
      } catch (error) { toast(error.message, 'error'); }
    };
    host.append(reconnect);
    if (!onHost) host.append(el('div', { class: 'meta', text: 'Reconnect on the computer running Kairos.' }));
    return [];
  }
  const calendars = await api('/api/google/calendar/calendars');
  const selected = new Set(status.calendar_ids ?? calendars.filter(c => c.selected).map(c => c.id));
  host.append(el('strong', { text: 'Google calendars' }));
  for (const calendar of calendars) {
    const checkbox = el('input', { type: 'checkbox', checked: selected.has(calendar.id) });
    const label = eventColor(el('label', { class: 'cal-calendar-choice' }, [checkbox, calendar.name]), { source: 'google', color: calendar.color });
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      checkbox.checked ? selected.add(calendar.id) : selected.delete(calendar.id);
      try {
        await api('/api/google/calendar/settings', { method: 'PATCH', body: JSON.stringify({ calendar_ids: [...selected] }) });
        await onChange();
      } catch {
        checkbox.checked = !checkbox.checked;
        checkbox.checked ? selected.add(calendar.id) : selected.delete(calendar.id);
      } finally { checkbox.disabled = false; }
    });
    host.append(label);
  }
  return calendars;
}

function timeInput(value, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = key => parts.find(part => part.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function eventDialog(calendars, refresh, item = null, day = new Date(), owner = null) {
  const originalItem = item;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const editingGoogle = item?.source === 'google';
  const title = el('input', { value: item?.title || '', required: true, 'aria-label': 'Event title' });
  const target = el('select', { 'aria-label': 'Calendar', disabled: Boolean(item) }, [
    el('option', { value: 'kairos', text: 'Kairos' }),
    ...calendars.filter(c => ['owner', 'writer'].includes(c.access_role) || c.id === item?.calendar_id)
      .map(c => el('option', { value: c.id, text: c.name })),
  ]);
  target.value = item ? (editingGoogle ? item.calendar_id : 'kairos') : (calendars.find(c => c.primary && ['owner', 'writer'].includes(c.access_role))?.id || 'kairos');
  const allDay = el('input', { type: 'checkbox', checked: Boolean(item?.all_day) });
  const zone = el('input', { value: item?.time_zone || browserZone, 'aria-label': 'Time zone' });
  const zoneField = el('div', { class: 'field' }, [el('label', { text: 'Time zone' }), zone]);
  const start = el('input', { type: 'datetime-local', required: true, 'aria-label': 'Start' });
  const end = el('input', { type: 'datetime-local', required: true, 'aria-label': 'End' });
  const endLabel = el('label', { text: 'End' });
  const location = el('input', { value: item?.location || '', 'aria-label': 'Location' });
  const description = el('textarea', { 'aria-label': 'Description' }); description.value = item?.description || '';
  const feedback = el('div', { class: 'meta', role: 'status' });
  const repeat = repeatControls();
  const editScope = el('select', { 'aria-label': 'Edit recurring event' }, [
    el('option', { value: 'occurrence', text: 'This event' }), el('option', { value: 'series', text: 'All events in this series' }),
  ]);
  const scopeField = el('div', { class: 'field field-grow', hidden: !originalItem?.series_id }, [el('label', { text: 'Apply changes to' }), editScope]);
  const updateRepeat = () => {
    repeat.host.hidden = Boolean(originalItem?.series_id) && editScope.value === 'occurrence';
    repeat.setAvailable(!repeat.host.hidden);
  };
  repeat.load(item || {}); updateRepeat();
  const followingDate = value => {
    const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + 1);
    return dateOnly(date);
  };
  const updateFields = (loadItem = true) => {
    const selectedDate = start.value.slice(0, 10) || dateOnly(day);
    zoneField.hidden = allDay.checked; zone.disabled = false;
    start.type = end.type = allDay.checked ? 'date' : 'datetime-local';
    endLabel.textContent = allDay.checked ? 'End date (exclusive)' : 'End';
    if (allDay.checked) {
      start.value = loadItem && item?.all_day ? String(item.start).slice(0, 10) : selectedDate;
      let storedEnd = loadItem && item?.all_day && item.end ? (item.end.includes('T') ? dateOnly(new Date(item.end)) : item.end) : '';
      // Older local/feed date-only ends include their final date. The editor
      // always shows the equivalent exclusive boundary, including multi-day spans.
      if (storedEnd && !item.end.includes('T') && item.source !== 'google' && !item.end_exclusive) storedEnd = followingDate(storedEnd);
      end.value = storedEnd > start.value ? storedEnd : followingDate(start.value);
    } else {
      start.value = loadItem && item && !item.all_day ? timeInput(item.start, zone.value) : `${selectedDate}T09:00`;
      end.value = loadItem && item && !item.all_day && item.end ? timeInput(item.end, zone.value) : `${selectedDate}T09:30`;
    }
  };
  allDay.onchange = () => updateFields(false);
  updateFields();
  const close = el('button', { type: 'button', class: 'btn quiet', text: 'Cancel' });
  const save = el('button', { type: 'submit', class: 'btn primary', text: item ? 'Save event' : 'Create event' });
  const form = el('form', { class: 'glass modal-panel cal-event-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': item ? 'Edit event' : 'Create event' }, [
    el('h3', { text: item ? 'Edit event' : 'Create event' }),
    el('div', { class: 'form-grid' }, [
      el('div', { class: 'field field-grow' }, [el('label', { text: 'Event title' }), title]),
      el('div', { class: 'field' }, [el('label', { text: 'Calendar' }), target]),
      el('div', { class: 'field' }, [el('label', { text: 'Start' }), start]),
      el('div', { class: 'field' }, [endLabel, end]), zoneField, scopeField,
      el('label', { class: 'cal-checkbox-label' }, [allDay, 'All day']),
      el('div', { class: 'field' }, [el('label', { text: 'Location' }), location]),
      el('div', { class: 'field field-grow' }, [el('label', { text: 'Description' }), description]),
      repeat.host,
    ]), feedback, el('div', { class: 'row-actions' }, [close, save]),
  ]);
  const backdrop = el('div', { class: 'modal-backdrop' }, [form]);
  const opener = document.activeElement;
  const dispose = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); observer.disconnect(); opener?.focus(); };
  const onKey = event => {
    if (event.key === 'Escape') dispose();
    if (event.key === 'Tab') {
      const nodes = [...form.querySelectorAll('button,input,select,textarea')].filter(n => !n.disabled && n.offsetParent !== null);
      const index = nodes.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && index === nodes.length - 1) { event.preventDefault(); nodes[0]?.focus(); }
    }
  };
  const observer = new MutationObserver(() => { if (owner && !owner.isConnected) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true });
  close.onclick = dispose; backdrop.onclick = event => { if (event.target === backdrop) dispose(); };
  let scopeGeneration = 0;
  editScope.onchange = async () => {
    const generation = ++scopeGeneration;
    save.disabled = true; feedback.textContent = 'Loading event…';
    try {
      const nextItem = editScope.value === 'series' ? await api(editingGoogle
        ? `/api/google/calendar/events/${encodeURIComponent(originalItem.series_id)}?calendar_id=${encodeURIComponent(originalItem.calendar_id)}`
        : `/api/calendar/events/${encodeURIComponent(originalItem.id)}?scope=series`) : originalItem;
      if (!form.isConnected || generation !== scopeGeneration) return;
      item = nextItem;
      title.value = item.title || ''; location.value = item.location || ''; description.value = item.description || '';
      allDay.checked = Boolean(item.all_day); zone.value = item.time_zone || browserZone;
      repeat.load(item); updateFields(); updateRepeat(); feedback.textContent = '';
      save.disabled = false;
    } catch (error) {
      if (!form.isConnected || generation !== scopeGeneration) return;
      feedback.textContent = error.message;
      // Keep Save unavailable: it must never apply stale fields to a different scope.
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true; editScope.disabled = true;
    try {
      const google = target.value !== 'kairos';
      if (!title.value.trim() || !start.value || !end.value) throw new Error('Enter a title, start and end');
      if (end.value <= start.value) throw new Error('End must be after start');
      const changeRepeat = !originalItem?.series_id || editScope.value === 'series';
      const repeatValue = changeRepeat ? repeat.value(start.value.slice(0, 10)) : undefined;
      if (google) {
        await api('/api/google/calendar/action', { method: 'POST', body: JSON.stringify({
          action: item ? 'update' : 'create', calendar_id: target.value, ...(item ? { event_id: item.id } : {}),
          event: { summary: title.value.trim(), location: location.value, description: description.value,
            start: allDay.checked ? { date: start.value } : { dateTime: `${start.value}:00`, timeZone: zone.value },
            end: allDay.checked ? { date: end.value } : { dateTime: `${end.value}:00`, timeZone: zone.value },
            ...(repeatValue !== undefined ? { repeat: repeatValue } : {}) },
        }) });
      } else {
        await api(item ? `/api/calendar/events/${item.id}` : '/api/calendar/events', { method: item ? 'PATCH' : 'POST', body: JSON.stringify({
          title: title.value.trim(), start: allDay.checked ? start.value : `${start.value}:00`,
          end: allDay.checked ? end.value : `${end.value}:00`,
          all_day: allDay.checked, location: location.value, description: description.value,
          time_zone: zone.value, scope: editScope.value,
          ...(repeatValue !== undefined ? { recurrence: repeatValue } : {}),
        }) });
      }
      dispose(); await refresh(); toast(item ? 'Event saved' : 'Event created', 'success');
    } catch (error) { feedback.textContent = error.message; save.disabled = false; editScope.disabled = false; }
  };
  document.body.append(backdrop); document.addEventListener('keydown', onKey); title.focus();
}

export function deleteCalendarEvent(item, refresh, owner = null) {
  const scope = el('select', { 'aria-label': 'Delete recurring event' }, [
    el('option', { value: 'occurrence', text: 'This event' }), el('option', { value: 'series', text: 'All events in this series' }),
  ]);
  const feedback = el('div', { class: 'meta', role: 'status' });
  const cancel = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
  const remove = el('button', { type: 'button', class: 'btn danger', text: 'Delete event' });
  const body = el('div', {}, [el('p', { text: `“${item.title}” will be permanently removed from your calendar.` }),
    ...(item.series_id ? [el('div', { class: 'field' }, [el('label', { text: 'Delete' }), scope])] : []), feedback,
  ]);
  // The shared dialog footer, as confirmDialog uses; .row-actions is hover-revealed.
  const dialog = openPanelDialog({ title: 'Delete this event?', body, footer: el('div', {}, [cancel, remove]),
    className: 'confirm-panel', owner, opener: document.activeElement, group: 'calendar-delete' });
  cancel.onclick = () => dialog.close();
  remove.onclick = async () => {
    remove.disabled = true;
    try {
      if (item.source === 'google') {
        await api('/api/google/calendar/action', { method: 'POST', signal: dialog.signal, body: JSON.stringify({ action: 'delete',
          calendar_id: item.calendar_id, event_id: scope.value === 'series' ? item.series_id || item.id : item.id }) });
      } else await api(`/api/calendar/events/${encodeURIComponent(item.id)}?scope=${scope.value}`, { method: 'DELETE', signal: dialog.signal });
      dialog.close(); await refresh(); toast('Event deleted', 'success');
    } catch (error) { if (body.isConnected) { feedback.textContent = error.message; remove.disabled = false; } }
  };
}

export function weekGrid(grid, start, items, selectDay, edit) {
  grid.classList.add('cal-week-grid');
  const header = el('div', { class: 'cal-week-header' }, [el('span', { text: 'All day' })]);
  const timeline = el('div', { class: 'cal-week-timeline' });
  const hours = el('div', { class: 'cal-week-hours' });
  // The locale's own hour format, as the rest of the calendar shows times ("9 PM", not "21:00").
  const hourLabel = (hour) => new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
  for (let hour = 0; hour < 24; hour++) hours.append(el('span', { text: hourLabel(hour), style: `top:${hour * 42}px` }));
  timeline.append(hours);
  const today = new Date();
  for (let day = 0; day < 7; day++) {
    const date = new Date(start); date.setDate(date.getDate() + day);
    const next = new Date(date); next.setDate(next.getDate() + 1);
    const dayItems = itemsOnDay(items, date);
    const cell = el('div', { class: 'cal-week-heading' }, [el('button', { type: 'button', class: 'btn quiet',
      text: date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }), onclick: () => selectDay(date, dayItems) })]);
    for (const item of dayItems.filter(item => item.all_day)) cell.append(eventColor(el('button', { type: 'button', class: 'cal-event-pill', text: item.title,
      onclick: () => edit(item, date, dayItems) }), item));
    header.append(cell);
    const column = el('div', { class: 'cal-week-day', 'aria-label': date.toDateString() });
    const minutes = stamp => stamp <= date ? 0 : stamp >= next ? 1440 : stamp.getHours() * 60 + stamp.getMinutes();
    const events = dayItems.filter(item => !item.all_day).map(item => ({ item, from: minutes(new Date(item.start)),
      to: minutes(item.end ? new Date(item.end) : new Date(new Date(item.start).getTime() + 1800000)) })).sort((a, b) => a.from - b.from);
    const lanes = [];
    for (const event of events) {
      let lane = lanes.findIndex(end => end <= event.from);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = Math.max(event.from + 15, event.to); event.lane = lane;
    }
    for (const event of events) {
      const node = eventColor(el('button', { type: 'button', class: 'cal-week-event', text: event.item.title, title: event.item.title,
        onclick: () => edit(event.item, date, dayItems) }), event.item);
      node.style.top = `${event.from * .7}px`; node.style.height = `${Math.max(18, (event.to - event.from) * .7)}px`;
      node.style.left = `${event.lane * 100 / lanes.length}%`; node.style.width = `${100 / lanes.length}%`;
      column.append(node);
    }
    if (date.toDateString() === today.toDateString()) column.append(el('div', { class: 'cal-today-line', 'aria-label': 'Current time', style: `top:${(today.getHours() * 60 + today.getMinutes()) * .7}px` }));
    timeline.append(column);
  }
  grid.replaceChildren(header, timeline);
}
