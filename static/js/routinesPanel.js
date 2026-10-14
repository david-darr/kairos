// A bot's routines (Agents 2.0, 2026-10-14). The storage and the API still
// call them goals -- tasks with schedule_kind "daily", "interval" or "once"
// and an agent_id -- and deliberately so: renaming live schedules would buy
// nothing the person can see and would risk their real routines. This is the
// one place the two words meet. The bot page's Routines tab and the profile
// sheet's Routines section share this panel.
import { api, el, customSelect, toast, confirmDialog } from './api.js';

export function cadence(routine) {
  if (routine.schedule_kind === 'daily') return `Every day at ${routine.run_time}`;
  if (routine.schedule_kind === 'once') return 'Once';
  const minutes = Math.round((routine.interval_seconds || 0) / 60);
  return minutes % 60 === 0 ? `Every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}` : `Every ${minutes} minutes`;
}

function routineRow(routine, refresh) {
  const summary = () => `${cadence(routine)} · ${routine.report_when === 'always' ? 'always reports' : 'reports when notable'}${routine.enabled ? '' : ' · paused'}`;
  const row = el('div', { class: 'agent-row routine-row' });
  row.dataset.routineId = routine.id;
  const view = el('div', {}, [el('div', { class: 'routine-name', text: routine.name }), el('div', { class: 'meta', text: summary() })]);
  // Editing covers what the existing update route allows: the name and what to
  // check. A different schedule is a new routine (remove, then add).
  const name = el('input', { value: routine.name, 'aria-label': 'Routine name' });
  const prompt = el('textarea', { rows: '3', 'aria-label': 'What to check' });
  prompt.value = routine.prompt || '';
  const editor = el('div', { class: 'routine-editor', hidden: true }, [
    el('div', { class: 'field field-grow' }, [el('label', { text: 'Name' }), name]),
    el('div', { class: 'field field-grow' }, [el('label', { text: 'What to check' }), prompt]),
    el('div', { class: 'routine-editor-actions' }, [
      el('button', { type: 'button', class: 'btn primary', text: 'Save', onclick: async () => {
        if (!name.value.trim() || !prompt.value.trim()) { toast('A routine needs a name and what to check', 'error'); return; }
        try {
          await api(`/api/tasks/${routine.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.value.trim(), prompt: prompt.value.trim() }) });
          refresh();
        } catch (problem) { toast(problem.message, 'error'); }
      } }),
      el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => { editor.hidden = true; view.hidden = false; } }),
    ]),
  ]);
  row.append(view, editor, el('div', { class: 'agent-row-actions' }, [
    el('button', { type: 'button', class: 'btn quiet', text: 'Check now', onclick: async () => {
      try { await api(`/api/tasks/${routine.id}/run`, { method: 'POST' }); toast('Checked', 'success'); }
      catch (problem) { toast(problem.message, 'error'); }
      refresh();
    } }),
    el('button', { type: 'button', class: 'btn quiet', text: routine.enabled ? 'Pause' : 'Resume', onclick: async () => {
      try { await api(`/api/tasks/${routine.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !routine.enabled }) }); refresh(); }
      catch (problem) { toast(problem.message, 'error'); }
    } }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Edit', onclick: () => { view.hidden = true; editor.hidden = false; name.focus(); } }),
    el('button', { type: 'button', class: 'btn danger', text: 'Remove', onclick: async () => {
      if (!await confirmDialog({ title: 'Remove this routine?', message: `"${routine.name}" will stop running.`, confirmLabel: 'Remove' })) return;
      await api(`/api/tasks/${routine.id}`, { method: 'DELETE' }); refresh();
    } }),
  ]));
  return row;
}

export function routinesPanel(agentId, routines, refresh) {
  const panel = el('div', { class: 'glass card routines-panel' }, [
    el('div', { class: 'title', text: 'Routines' }),
    el('div', { class: 'meta', style: 'margin:4px 0 10px;', text: 'Run on a schedule. Quiet routines only report when something turned up.' }),
  ]);
  if (!routines.length) panel.append(el('p', { class: 'meta routines-empty', text: 'No routines yet.' }));
  for (const routine of routines) panel.append(routineRow(routine, refresh));
  const name = el('input', { placeholder: 'e.g. New postings', 'aria-label': 'New routine name' });
  const prompt = el('textarea', { rows: '2', placeholder: 'What to check, and what counts as worth telling you', 'aria-label': 'What the new routine checks' });
  const kind = customSelect({}, [el('option', { value: 'daily', text: 'Every day at' }), el('option', { value: 'interval', text: 'Every N hours' })]);
  const time = el('input', { type: 'time', value: '08:00' });
  const hours = el('input', { type: 'number', min: '1', value: '6' });
  const timeField = el('div', { class: 'field field-sm' }, [el('label', { text: 'At' }), time]);
  const hoursField = el('div', { class: 'field field-sm', style: 'display:none;' }, [el('label', { text: 'Hours' }), hours]);
  kind.addEventListener('change', () => {
    timeField.style.display = kind.value === 'daily' ? '' : 'none';
    hoursField.style.display = kind.value === 'interval' ? '' : 'none';
  });
  const report = customSelect({}, [el('option', { value: 'notable', text: 'Only when notable' }), el('option', { value: 'always', text: 'Every time' })]);
  const add = async () => {
    if (!name.value.trim() || !prompt.value.trim()) { toast('A routine needs a name and what to check', 'error'); return; }
    const body = { name: name.value.trim(), prompt: prompt.value.trim(), schedule_kind: kind.value, report_when: report.value };
    if (kind.value === 'daily') body.run_time = time.value; else body.interval_seconds = Math.max(1, parseInt(hours.value, 10) || 1) * 3600;
    try { await api(`/api/agents/${agentId}/goals`, { method: 'POST', body: JSON.stringify(body) }); refresh(); }
    catch (problem) { toast(problem.message, 'error'); }
  };
  panel.append(el('details', { class: 'disclosure-panel' }, [el('summary', { text: '+ Add a routine' }), el('div', { class: 'form-grid' }, [
    el('div', { class: 'field field-grow' }, [el('label', { text: 'Name' }), name]),
    el('div', { class: 'field field-grow', style: 'flex-basis:100%;' }, [el('label', { text: 'What to check' }), prompt]),
    el('div', { class: 'field' }, [el('label', { text: 'When' }), kind]), timeField, hoursField,
    el('div', { class: 'field' }, [el('label', { text: 'Report' }), report]),
    el('button', { class: 'btn primary', text: 'Add routine', onclick: add }),
  ])]));
  return panel;
}
