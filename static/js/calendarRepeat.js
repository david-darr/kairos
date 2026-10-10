import { el } from './api.js';

export function repeatControls() {
  const frequency = el('select', { 'aria-label': 'Repeat' }, [
    ...[['none', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]
      .map(([value, text]) => el('option', { value, text })),
  ]);
  const interval = el('input', { type: 'number', min: 1, max: 365, value: '1', 'aria-label': 'Repeat interval' });
  const ending = el('select', { 'aria-label': 'Repeat ends' }, [
    ...[['never', 'Never'], ['until', 'On a date'], ['count', 'After a number of events']]
      .map(([value, text]) => el('option', { value, text })),
  ]);
  const until = el('input', { type: 'date', 'aria-label': 'Repeat end date' });
  const count = el('input', { type: 'number', min: 1, max: 10000, value: '10', 'aria-label': 'Repeat count' });
  const intervalLabel = el('label', { text: 'Every (days)' });
  const intervalField = el('div', { class: 'field' }, [intervalLabel, interval]);
  const endingField = el('div', { class: 'field' }, [el('label', { text: 'Ends' }), ending]);
  const untilField = el('div', { class: 'field' }, [el('label', { text: 'Last date' }), until]);
  const countField = el('div', { class: 'field' }, [el('label', { text: 'Number of events' }), count]);
  const note = el('div', { class: 'meta field-grow' });
  const host = el('div', { class: 'form-grid field-grow', 'data-repeat-controls': '' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Repeat' }), frequency]),
    intervalField, endingField, untilField, countField, note,
  ]);
  let supported = true, available = true;
  function update() {
    const repeating = frequency.value !== 'none';
    intervalField.hidden = endingField.hidden = !repeating;
    untilField.hidden = !repeating || ending.value !== 'until';
    countField.hidden = !repeating || ending.value !== 'count';
    intervalLabel.textContent = `Every (${({ daily: 'days', weekly: 'weeks', monthly: 'months' })[frequency.value] || 'days'})`;
    frequency.disabled = !supported || !available;
    for (const input of [interval, ending, until, count]) input.disabled = !supported || !available || !repeating;
    until.disabled ||= ending.value !== 'until';
    count.disabled ||= ending.value !== 'count';
    until.required = repeating && ending.value === 'until';
    count.required = repeating && ending.value === 'count';
    note.textContent = !supported ? 'This Google series uses a custom repeat rule. Its rule is kept when you save.'
      : frequency.value === 'monthly' ? 'Repeats on the same day of the month. Months without that day are skipped.' : '';
  }
  frequency.onchange = ending.onchange = update;
  function load(item = {}) {
    supported = item.recurrence_supported !== false;
    const rule = item.recurrence;
    frequency.value = rule?.frequency || 'none'; interval.value = String(rule?.interval || 1);
    ending.value = rule?.until ? 'until' : rule?.count ? 'count' : 'never';
    until.value = rule?.until || ''; count.value = String(rule?.count || 10);
    frequency.disabled = !supported;
    update();
  }
  function value(startDate) {
    if (!supported) return undefined;
    if (frequency.value === 'none') return null;
    const every = Number(interval.value);
    if (!Number.isInteger(every) || every < 1 || every > 365) throw new Error('Repeat interval must be from 1 to 365');
    const rule = { frequency: frequency.value, interval: every };
    if (ending.value === 'until') {
      if (!until.value || until.value < startDate) throw new Error('Choose a repeat end date on or after the start');
      rule.until = until.value;
    } else if (ending.value === 'count') {
      const number = Number(count.value);
      if (!Number.isInteger(number) || number < 1 || number > 10000) throw new Error('Repeat count must be from 1 to 10000');
      rule.count = number;
    }
    return rule;
  }
  load();
  return { host, load, value, setAvailable(value) { available = value; update(); } };
}
