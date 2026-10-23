import { el } from './api.js';
import { dotMatrix, segmented } from './kairosParts.js';

export function activityBins(runs, range, now = new Date()) {
  const days = range === 'year' ? 366 : range === 'month' ? 31 : 7;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const cells = Array(days * 24).fill('empty');
  let count = 0, done = 0;
  for (const run of runs) {
    const date = new Date((run.started_at || run.ran_at) * 1000);
    if (!(date >= start && date <= now)) continue;
    // Local calendar days, independent of daylight-saving transitions.
    const day = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
      - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000);
    const index = day * 24 + date.getHours();
    const success = run.outcome === 'succeeded';
    if (!success || cells[index] === 'empty') cells[index] = success ? 'a' : 'b';
    count++; if (success) done++;
  }
  return { cells, count, done, days };
}

export function renderTaskActivity(host, runs) {
  let range = host.dataset.range || 'week';
  const body = el('div', { class: 'task-activity-body' });
  const draw = () => {
    host.dataset.range = range;
    const { cells, count, done, days } = activityBins(runs, range);
    // Month/year aggregate each day's recorded outcome to keep dots legible.
    const shown = range === 'week' ? cells : Array.from({ length: days }, (_, i) => {
      const day = cells.slice(i * 24, i * 24 + 24);
      return day.includes('b') ? 'b' : day.includes('a') ? 'a' : 'empty';
    });
    body.replaceChildren(el('div', { class: 'task-activity-count' }, [el('span', { text: 'Recorded runs' }),
      el('strong', { text: String(count) }), el('small', { text: `${done} succeeded · ${count - done} other outcomes` })]),
      dotMatrix({ rows: range === 'week' ? 7 : Math.ceil(days / 24), cols: 24, cells: shown,
        label: `${count} recorded runs over the last ${days} days. ${done} succeeded. Ink: succeeded. Accent: other outcomes.` }),
      el('p', { class: 'meta', text: 'From retained scheduled-task history. Older runs may no longer be stored.' }));
  };
  host.replaceChildren(segmented({ label: 'Run history range', value: range,
    options: ['week', 'month', 'year'].map(value => ({ value, text: value[0].toUpperCase() + value.slice(1) })),
    onChange: value => { range = value; draw(); } }), body);
  draw();
}
