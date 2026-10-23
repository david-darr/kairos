import { api, el, modelMark } from './api.js';
import { createMascot } from './mascot.js';
import { PROVIDERS, SIGN_IN, toSnap, toneOf, pctText, resetCopy, staleOf, ago, usedCopy } from './quotaReadings.js';

export function segmented({ label, options, value, onChange }) {
  const track = el('div', { class: 'rd-segmented', role: 'radiogroup', 'aria-label': label });
  const thumb = el('span', { class: 'rd-segmented-thumb', 'aria-hidden': 'true' });
  track.style.setProperty('--rd-segments', Math.max(1, options.length));
  let selected = Math.max(0, options.findIndex(option => option.value === value));
  const select = (index, notify = false) => {
    selected = index;
    track.style.setProperty('--rd-selected', index);
    buttons.forEach((button, i) => {
      button.setAttribute('aria-checked', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });
    if (notify) onChange?.(options[index].value);
  };
  const buttons = options.map((option, index) => el('button', {
    type: 'button', role: 'radio', text: option.text,
    onclick: () => select(index, true),
    onkeydown: event => {
      const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (selected + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + options.length) % options.length;
      select(next, true);
      buttons[next].focus();
    },
  }));
  track.append(thumb, ...buttons);
  select(selected);
  return track;
}

export function pill({ text, kind = 'primary', onClick, href }) {
  return el(href ? 'a' : 'button', {
    class: `rd-pill rd-pill-${kind}`, text,
    ...(href ? { href } : { type: 'button' }), ...(onClick ? { onclick: onClick } : {}),
  });
}

export function dotMatrix({ rows, cols, cells = [], label }) {
  const matrix = el('div', { class: 'rd-dot-matrix', role: 'img', 'aria-label': label });
  matrix.style.setProperty('--rd-cols', Math.max(1, cols));
  for (let i = 0; i < rows * cols; i++) {
    const state = ['a', 'b', 'dim'].includes(cells[i]) ? cells[i] : 'empty';
    matrix.append(el('span', { class: `rd-dot rd-dot-${state}`, 'aria-hidden': 'true' }));
  }
  return matrix;
}

export function emptyState({ mascotState = 'idle', title, text, action }) {
  const node = el('section', { class: 'rd-empty-state' });
  if (document.documentElement.dataset.mascot !== 'off') {
    node.append(el('div', { class: 'rd-empty-mascot', 'aria-hidden': 'true' }, [
      createMascot({ state: mascotState, size: 84, decorative: true }),
    ]));
  }
  node.append(el('h2', { text: title }), el('p', { text }));
  if (action) node.append(pill(action));
  return node;
}

export function usageCard({ providers = [], accounting = [] }) {
  const card = el('section', { class: 'rd-usage-card', 'aria-label': 'Model usage' }, [el('h2', { text: 'Model usage' })]);
  for (const provider of PROVIDERS) {
    const reading = providers.find(p => p.provider === provider.id);
    const snap = toSnap(reading || { status: 'unavailable' });
    if (!snap.windows.length && snap.status !== 'needsAuth') continue;
    const section = el('div', { class: 'rd-usage-provider', 'data-provider': provider.id }, [el('h3', {}, [modelMark(provider.mark, provider.name), provider.name])]);
    if (snap.status === 'needsAuth') section.append(el('p', { class: 'rd-usage-note', text: [SIGN_IN[provider.id], snap.note].filter(Boolean).join(' ') }));
    else {
      for (const window of snap.windows) {
        const label = window.id === 'session' ? '5-hour' : window.id === 'weekly' ? 'Weekly' : window.label;
        const bar = dotMatrix({ rows: 1, cols: 24,
          cells: Array.from({ length: 24 }, (_, i) => i < Math.round(Math.min(1, window.used) * 24) ? 'a' : 'empty'),
          label: `${label}: ${pctText(window.used)}% used` });
        bar.classList.add('rd-usage-bar', `rd-tone-${toneOf(window.used)}`);
        bar.setAttribute('role', 'meter');
        bar.setAttribute('aria-label', `${label}: ${usedCopy(window)}`);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(Math.min(100, window.used * 100)));
        section.append(el('div', { class: 'rd-usage-window', 'data-quota-tone': toneOf(window.used), title: usedCopy(window) }, [el('span', { class: 'rd-part-label', text: label }), bar,
          el('span', { class: 'rd-usage-percent', text: `${pctText(window.used)}%`, 'aria-hidden': 'true' })]));
      }
      const resets = snap.windows.map(w => `${w.id === 'session' ? '5-hour' : w.id === 'weekly' ? 'Weekly' : w.label}: ${resetCopy(w.resets_at)}`).filter(s => !s.endsWith(': '));
      if (staleOf(snap)) resets.push(snap.fetched_at ? 'Updated ' + ago(snap.fetched_at) : 'Usage may be out of date.');
      section.append(el('p', { class: 'rd-usage-note', text: resets.join(' · ') || snap.note || 'Waiting for usage.' }));
    }
    card.append(section);
  }
  for (const item of accounting) card.append(el('p', { class: 'rd-usage-accounting', title: item.title }, [
    el('span', { text: item.name + ': ' }), el('span', { class: 'dashboard-model-usage', text: item.text }),
  ]));
  return card;
}

// No timer or document listeners: callers own when their card refreshes.
export async function loadUsageCard(container) {
  let revision = 0;
  const refresh = async () => {
    const current = ++revision;
    try {
      const data = await loadQuotas();
      if (current === revision) container.replaceChildren(usageCard({ providers: data.providers }));
    } catch {
      if (current === revision) container.replaceChildren(el('p', { class: 'rd-part-note', role: 'status', text: 'Could not load model usage.' }));
    }
  };
  await refresh();
  return refresh;
}

// Home and the shared card use one request contract.
export function loadQuotas() { return api('/api/models/quotas'); }
