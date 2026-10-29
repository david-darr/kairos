import { api, el } from './api.js';
import { pageHeader, group, row, field, pill } from './settingsKit.js';
import { loadBotsCss } from './botsUi.js';
import { lifetime } from './botsWorkbenchModel.js';

export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots.css'); loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx), root = el('div', { 'data-app-mode': 'bots', 'data-section': 'computers' });
  host.replaceChildren(root);
  async function refresh() {
    root.replaceChildren(el('p', { role: 'status', text: 'Loading computers' }));
    try {
      const data = await api('/api/bot-workbench/computers', { signal: life.signal });
      if (!life.active) return;
      const max = el('input', { type: 'number', min: '1', max: '8', value: data.settings.max_running, 'aria-label': 'Running computers' });
      const idle = el('input', { type: 'number', min: '5', max: '1440', value: data.settings.idle_minutes, 'aria-label': 'Idle minutes' });
      const error = el('p', { role: 'alert', class: 'bots-workbench-error' });
      const save = el('button', { type: 'button', class: 'btn', text: 'Save', onclick: async () => {
        save.disabled = true;
        try { await api('/api/bot-workbench/computers/settings', { method: 'PUT', body: JSON.stringify({ max_running: Number(max.value), idle_minutes: Number(idle.value) }), signal: life.signal, toast: false }); if (life.active) await refresh(); }
        catch (e) { if (life.active) { error.textContent = e.message; save.disabled = false; } }
      } });
      root.replaceChildren(pageHeader('Bot computers', 'Contained computers on this machine', [el('button', { class: 'btn', text: 'Check again', onclick: refresh })]),
        group({ title: 'Computer runtime' }, [row({ title: 'Docker', description: data.docker.reason || 'Ready for contained computers', control: pill(data.docker.available ? 'Ready' : 'Needs setup', data.docker.available ? 'ok' : 'warn') })]),
        group({ title: 'Limits' }, [field('Running computers', max, 'From 1 to 8'), field('Idle minutes', idle, 'From 5 to 1440'), row({ title: 'Save limits', control: save })]), error,
        group({ title: 'Computers' }, data.computers.length ? data.computers.map(bot => row({ title: bot.name,
          description: bot.running ? bot.taken_over ? 'You have the wheel' : 'Running' : 'Asleep',
          control: bot.running ? el('button', { type: 'button', class: 'btn', text: 'Sleep', onclick: async event => {
            const button = event.currentTarget; button.disabled = true;
            try { await api(`/api/bot-workbench/${encodeURIComponent(bot.bot_id)}/computer/sleep`, { method: 'POST', signal: life.signal, toast: false }); if (life.active) await refresh(); }
            catch (e) { if (life.active) { error.textContent = e.message; button.disabled = false; } }
          } }) : pill('Asleep'),
        })) : [row({ title: 'No bot computers' })]));
    } catch (e) { if (life.active) root.replaceChildren(el('p', { role: 'alert', text: e.message }), el('button', { class: 'btn', text: 'Retry', onclick: refresh })); }
  }
  await refresh(); return life.handle(refresh);
}
