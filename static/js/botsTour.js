import { api } from './api.js';
import { h, isAdvanced } from './botsUi.js';

export const TOUR_STEPS = [
  { id: 'composer', selector: '.bots-composer textarea', title: 'Start a conversation', text: 'Give your bot a task or ask a question.' },
  { id: 'bot', selector: '.bots-head-pill', title: 'Your bot', text: 'Open its details and settings here.' },
  { id: 'model', selector: '.bots-composer-model', title: 'Choose a model', text: 'Pick a connected model for this conversation.' },
  { id: 'computer', selector: '.bots-monitor', title: 'Follow the work', text: 'Open the computer, browser, data, and files.' },
  { id: 'tools', selector: '[data-section="access"]', title: 'Tools and access', text: 'Choose what this bot can use in Access.' },
  { id: 'apps', selector: '[data-section="connections"]', title: 'Connect apps', text: 'Add apps and choose the tools each bot can use.' },
  { id: 'files', selector: '.bots-composer-clip, .bots-composer-plus', title: 'Share a file', text: 'Attach a file when your bot needs it.' },
  { id: 'automations', selector: '[data-nav="botsAutomations"]', title: 'Repeat a task', text: 'Set up a routine from your bot settings.' },
  { id: 'threads', selector: '.bots-convos-button, .bots-convo-toggle, [aria-controls="bots-convos"]', title: 'Keep work together', text: 'Use another conversation for a separate task.' },
  { id: 'voice', selector: '.agent-call-open', title: 'Talk to your bot', text: 'Start a voice call when you prefer to talk.' },
];
export function tourSteps(steps, find) { return steps.map(step => ({ ...step, anchor: find(step.selector) })).filter(step => step.anchor); }
let active = null;
export function closeTour() { active?.destroy(); }
export async function openTour({ signal, advanced = isAdvanced(), start = 0 } = {}) {
  if (signal?.aborted) return null;
  active?.destroy();
  let dead = false, spotlight = null, index = 0, revision = 0;
  const abort = new AbortController();
  const variant = advanced ? 'advanced' : 'simple';
  const find = selector => [...document.querySelectorAll(selector)].find(node => node.getBoundingClientRect().height > 0);
  const configured = TOUR_STEPS.map(step => !advanced && ['model', 'tools', 'apps', 'automations'].includes(step.id)
    ? { ...step, selector: '.bots-head-pill' } : step);
  const steps = tourSteps(configured, find);
  const save = (done, step) => api('/api/bot-onboarding', { method: 'PATCH', toast: false, body: JSON.stringify({ tour: { done, step, variant } }) });
  const fallback = h('p', { class: 'bots-onboarding-error', role: 'status' });
  const destroy = () => { if (dead) return; dead = true; revision++; abort.abort(); spotlight?.destroy(); fallback.remove(); if (active?.destroy === destroy) active = null; };
  const close = () => { save(true, index).catch(() => {}); destroy(); };
  async function show(at) {
    if (dead) return;
    spotlight?.destroy(); spotlight = null;
    if (at < 0) at = 0;
    if (at >= steps.length) { close(); return; }
    index = at; const mine = ++revision;
    if (!steps[at].anchor.isConnected) { show(at + 1); return; }
    try {
      const { openSpotlight } = await import('./botsSpotlight.js');
      if (dead || mine !== revision) return;
      spotlight = openSpotlight({ ...steps[index], index, count: steps.length, next: () => show(index + 1), back: () => show(index - 1), close });
      save(false, index).catch(() => { if (!dead) { fallback.textContent = 'Tour progress could not save.'; document.body.append(fallback); } });
    } catch { if (!dead) { fallback.textContent = 'Tour could not load. Replay it from Settings.'; document.body.append(fallback); } }
  }
  signal?.addEventListener('abort', destroy, { once: true });
  active = { destroy, refresh: () => show(index), flush: async () => ({ ok: true }) };
  await show(Math.min(Math.max(0, start), Math.max(0, steps.length - 1)));
  return active;
}

export async function mount(host, ctx = {}) { return openTour(ctx); }
