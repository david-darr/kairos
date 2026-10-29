import { api, el } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { mountComputerPanel } from './computerPanel.js';
import { createLease, lifetime, phaseView, pollCadence } from './botsWorkbenchModel.js';
import { mount as mountPlaces } from './botsPlaceChooser.js';
import { mount as mountHelp } from './botsHelpCard.js';

export async function mount(host, ctx) {
  loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx), lease = createLease();
  const base = `/api/bot-workbench/${encodeURIComponent(ctx.agentId)}`;
  const query = ctx.threadId ? `?thread_id=${encodeURIComponent(ctx.threadId)}` : '';
  let screen = null, timer, request = false, first = true;
  const caption = el('h3', { text: `Screen of ${ctx.state?.agent?.name || 'bot'}` });
  const badges = el('div', { class: 'bots-workbench-badges' });
  const message = el('p', { class: 'bots-workbench-phase', role: 'status', text: 'Loading computer' });
  const error = el('p', { class: 'bots-workbench-error', role: 'alert' });
  const frame = el('div', { class: 'bots-workbench-screen' });
  const help = el('div');
  const chooser = el('div');
  const action = el('button', { type: 'button', class: 'bots-btn bots-workbench-action', text: 'Check again', disabled: true });
  const sleep = el('button', { type: 'button', class: 'bots-btn', text: 'Sleep', onclick: () => mutate('/computer/sleep') });
  const fullscreen = el('button', { type: 'button', class: 'bots-btn', text: 'Full screen', onclick: async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await frame.requestFullscreen(); } catch (e) { error.textContent = e.message; }
  } });
  const controls = el('div', { class: 'bots-workbench-controls' }, [action, fullscreen, sleep]);
  const root = el('section', { class: `bots-workbench-computer${ctx.advanced ? ' is-advanced' : ''}` }, [caption, badges, message, error, help, frame, controls, chooser]);
  host.replaceChildren(root);
  let helpHandle;
  async function mutate(path, body) {
    action.disabled = true;
    error.textContent = '';
    try {
      if (ctx.flush && await ctx.flush() === false) return;
      const result = await api(base + path + (path === '/computer/start' ? query : ''), { method: 'POST', body: body ? JSON.stringify(body) : undefined, signal: life.signal, toast: false });
      if (body?.action === 'take') lease.taken(result);
      if (body?.action === 'release') lease.clear();
    } catch (e) { if (life.active) error.textContent = e.message; }
    finally { if (life.active) { action.disabled = false; await refresh(); } }
  }
  async function refresh() {
    if (!life.active || request) return;
    clearTimeout(timer); request = true;
    let delay = 4000;
    try {
      const status = await api(base + '/status' + query, { signal: life.signal });
      if (!life.active) return;
      ctx.onStatus?.(status);
      if (first && status.computer.taken_over) lease.taken(status.computer);
      first = false;
      const view = phaseView(status);
      message.textContent = view.message;
      root.dataset.phase = status.phase;
      action.textContent = view.label;
      action.disabled = false;
      action.onclick = () => {
        if (view.action === 'settings' || view.action === 'prepare') document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings', section: 'computer' } }));
        else if (view.action === 'place') chooser.querySelector('button')?.focus();
        else if (view.action === 'refresh') refresh();
        else if (view.action === 'release') mutate('/computer/control', lease.release());
        else if (view.action === 'take') mutate('/computer/control', { action: 'take' });
        else mutate('/computer/start');
      };
      badges.replaceChildren(...status.computer.badges.map(text => el('span', { class: 'bots-workbench-badge', text })));
      sleep.disabled = fullscreen.disabled = !status.computer.running;
      if (status.computer.running) {
        if (!screen) screen = mountComputerPanel(frame, `agent:${ctx.agentId}`, status.computer);
        else screen.update(status.computer);
      } else { screen?.dispose(); screen = null; frame.replaceChildren(el('p', { text: view.message })); }
      helpHandle?.destroy();
      helpHandle = await mountHelp(help, { ...ctx, signal: life.signal, help: status.help, refresh });
      delay = pollCadence(status.phase);
    } catch (e) { if (life.active) { error.textContent = e.message; action.textContent = 'Retry'; action.disabled = false; action.onclick = refresh; } }
    finally { request = false; if (life.active) timer = setTimeout(refresh, delay); }
  }
  life.own(() => { clearTimeout(timer); screen?.dispose(); helpHandle?.destroy(); root.remove(); });
  const places = await mountPlaces(chooser, { ...ctx, signal: life.signal, refresh });
  life.own(places.destroy);
  await refresh();
  return life.handle(refresh);
}

export async function mountComputerSection(host, ctx) {
  const life = lifetime(ctx);
  const button = el('button', { class: 'bots-btn', type: 'button', text: 'Open computer', onclick: async () => {
    const { openWorkbench } = await import('./botsWorkbenchHost.js');
    if (life.active) openWorkbench(ctx.agentId, { tab: 'computer', threadId: ctx.threadId });
  } });
  const profiles = el('div'), sites = el('div');
  host.replaceChildren(button, profiles, sites);
  for (const [name, target] of [['botsBrowserProfiles', profiles], ['botsSectionSites', sites]]) {
    try { const module = await import(`./${name}.js`); if (!life.active) break; const handle = await module.mount(target, { ...ctx, signal: life.signal }); life.own(() => handle.destroy()); }
    catch (e) { if (life.active) target.textContent = `This section could not load. ${e.message}`; }
  }
  return life.handle(async () => {});
}
