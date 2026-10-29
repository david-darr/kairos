import { api } from './api.js';
import { h, Button, loadBotsCss, isAdvanced } from './botsUi.js';
import { botKip } from './botsKip.js';

const beats = new Map();
export function registerOnboardingBeat(beat) {
  if (!beat?.id || typeof beat.mount !== 'function' || !Number.isFinite(beat.order)) throw new Error('An onboarding beat needs id, order and mount.');
  beats.set(beat.id, beat);
  return () => { if (beats.get(beat.id) === beat) beats.delete(beat.id); };
}
export const onboardingBeats = () => [...beats.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export const stepDashes = (step, count) => Array.from({ length: count }, (_, i) => ({ current: i === step, label: `Step ${i + 1} of ${count}` }));
const endpoint = '/api/bot-onboarding';
export const saveOnboarding = patch => api(endpoint, { method: 'PATCH', toast: false, body: JSON.stringify(patch) });
let welcome = null, opening = null;

registerOnboardingBeat({ id: 'meet', order: 10, async mount(host, ctx) {
  const text = 'Plan my day and help me finish one thing.';
  const demo = h('p', { class: 'bots-welcome-composer', 'aria-label': 'Example message', 'aria-hidden': 'true' });
  let timer = null, position = 0;
  host.replaceChildren(botKip({}, { size: 96, state: 'idle' }), h('h1', { text: 'Meet your bots', tabindex: '-1' }),
    h('p', { text: 'Give each bot a job. Talk, share files, and follow its work here.' }), demo,
    Button({ label: 'Ready-made bots', onClick: async () => {
      try { const { openReadyGallery } = await import('./botsGallery.js'); await openReadyGallery(); ctx.close(); }
      catch { host.append(h('p', { role: 'status', text: 'Ready-made bots could not load. Try again.' })); }
    } }));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) demo.textContent = text;
  else timer = setInterval(() => { if (document.hidden) return; demo.textContent = text.slice(0, ++position); if (position >= text.length) clearInterval(timer); }, 45);
  ctx.primary({ label: ctx.modelReady ? 'Make your first bot' : 'Connect a model', run: async () => {
    if (!ctx.modelReady) { ctx.close(); ctx.navigate('add-models'); }
    else {
      try { const { openNewBot } = await import('./botsCreate.js'); await openNewBot(); ctx.close(); }
      catch { host.append(h('p', { role: 'status', text: 'The new bot dialog could not load. Try again.' })); }
    }
  } });
  return { destroy() { clearInterval(timer); } };
} });
registerOnboardingBeat({ id: 'setup', order: 100, async mount(host, ctx) {
  ctx.primary({ label: 'Start using Bots', run: ctx.close });
  try { const module = await import('./botsSetupChecklist.js'); return await module.mount(host, { ...ctx, navigate: section => { ctx.close(); ctx.navigate(section); } }); }
  catch { host.replaceChildren(h('p', { role: 'status', text: 'Setup checklist could not load. Close and try again.' })); }
} });

export async function openWelcome({ force = false, state, signal } = {}) {
  if (welcome) return welcome;
  loadBotsCss('/static/css/bots-onboarding.css');
  const abort = new AbortController();
  let dead = false, handle = null, step = 0, version = 0;
  let saved = state;
  if (!saved) saved = await api(endpoint, { signal: signal || abort.signal, toast: false });
  if (!force && saved.welcome_seen || signal?.aborted) return null;
  const opener = document.activeElement;
  const dialog = h('dialog', { class: 'bots-welcome', 'data-section': 'welcome', 'data-app-mode': 'bots', 'aria-label': 'Welcome to Bots' });
  const dashes = h('nav', { class: 'bots-welcome-dashes', 'aria-label': 'Welcome steps' });
  const pane = h('div', { class: 'bots-welcome-pane' });
  const status = h('p', { role: 'status' });
  const primary = Button({ label: 'Continue', variant: 'primary', onClick: () => primaryRun() });
  let primaryRun = () => show(step + 1);
  const close = () => {
    if (dead) return; dead = true; version++; abort.abort(); handle?.destroy?.(); dialog.close(); dialog.remove(); welcome = null;
    if (opener?.isConnected) opener.focus?.();
  };
  const navigate = section => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings', section } }));
  const list = onboardingBeats();
  const setup = await api(endpoint + '/setup', { signal: abort.signal, toast: false }).catch(() => null);
  if (signal?.aborted) return null;
  const modelReady = !!setup?.checks?.some(row => row.id === 'model' && row.status === 'ready');
  async function show(index) {
    if (dead) return;
    if (index >= list.length) { close(); return; }
    step = index; const mine = ++version; handle?.destroy?.(); handle = null;
    dashes.replaceChildren(...stepDashes(step, list.length).map((dash, i) => h('button', { type: 'button', class: 'bots-welcome-dash', 'aria-label': dash.label, 'aria-current': dash.current ? 'step' : undefined, onclick: () => show(i) })));
    const beatHost = h('div');
    pane.replaceChildren(beatHost); beatHost.append(h('p', { text: 'Loading...' })); primary.disabled = true;
    try {
      const mounted = await list[step].mount(beatHost, { signal: abort.signal, modelReady, navigate, close,
        primary({ label, run }) { if (dead || mine !== version) return; primary.textContent = label; primaryRun = run; } });
      if (dead || mine !== version) { mounted?.destroy?.(); return; }
      handle = mounted; pane.querySelector('h1, h2')?.focus();
    } catch { if (!dead && mine === version) pane.replaceChildren(h('p', { text: 'This welcome step could not load. Try another step.' })); }
    finally { if (!dead && mine === version) primary.disabled = false; }
  }
  dialog.append(dashes, pane, h('footer', {}, [status, primary, Button({ label: 'Not now', onClick: close })]));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  signal?.addEventListener('abort', close, { once: true });
  welcome = { destroy: close, refresh: () => show(step), flush: async () => ({ ok: true }) };
  document.body.append(dialog); dialog.showModal();
  // Receipt is written on presentation, including Escape and Not now.
  saveOnboarding({ welcome_seen: true }).catch(() => { if (!dead) status.textContent = 'Welcome state could not save. Try again from Settings.'; });
  await show(0); return welcome;
}

export function maybeWelcome(options = {}) {
  if (opening) return opening;
  opening = openWelcome(options).finally(() => { opening = null; });
  return opening;
}

export async function enterBots({ signal } = {}) {
  const state = await api(endpoint, { signal, toast: false });
  if (signal?.aborted) return;
  const handles = [];
  await maybeWelcome({ state, signal });
  for (const [path, name] of [['./botsHints.js', 'Hints'], ['./botsNotices.js', 'Notices']]) {
    try { const module = await import(path); if (!signal?.aborted) handles.push(module.mount(document.body, { state, signal, save: saveOnboarding })); }
    catch { if (!signal?.aborted) document.body.append(h('p', { class: 'bots-onboarding-error', role: 'status', text: `${name} could not load. Reopen Bots to try again.` })); }
  }
  let tourStarted = !!state.tour?.done;
  const tourTimer = setInterval(async () => {
    if (tourStarted || signal?.aborted || !document.querySelector('.bots-composer') || document.querySelector('dialog[open], .modal-backdrop:not(.hidden), [role="dialog"]:not([hidden])')) return;
    tourStarted = true;
    try { const { openTour } = await import('./botsTour.js'); if (!signal?.aborted) handles.push(await openTour({ signal, start: state.tour?.step || 0 })); }
    catch { if (!signal?.aborted) document.body.append(h('p', { class: 'bots-onboarding-error', text: 'Tour could not load. Replay it from Settings.' })); }
  }, 1000);
  signal?.addEventListener('abort', () => { clearInterval(tourTimer); handles.forEach(handle => handle?.destroy?.()); document.querySelectorAll('.bots-onboarding-error').forEach(node => node.remove()); }, { once: true });
  return { destroy() { clearInterval(tourTimer); handles.forEach(handle => handle?.destroy?.()); welcome?.destroy(); } };
}
