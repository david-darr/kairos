import { api, el } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { lifetime } from './botsWorkbenchModel.js';

export async function mount(host, ctx) {
  loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx), root = el('section', { class: 'bots-browser-profiles' });
  const base = `/api/bot-workbench/${encodeURIComponent(ctx.agentId)}`;
  host.replaceChildren(root);
  async function write(path, method, body) {
    if (ctx.flush && await ctx.flush() === false) return;
    try {
      await api(path, { method, body: body ? JSON.stringify(body) : undefined, signal: life.signal, toast: false });
      if (life.active) { await refresh(); ctx.refresh?.(); }
    } catch (e) { if (life.active) root.append(el('p', { role: 'alert', text: e.message })); }
  }
  async function refresh() {
    root.replaceChildren(el('p', { role: 'status', text: 'Loading profiles' }));
    try {
      const [profiles, status] = await Promise.all([api('/api/bot-workbench/profiles', { signal: life.signal }), api(base + '/status', { signal: life.signal })]);
      if (!life.active) return;
      const enabled = el('input', { type: 'checkbox', checked: status.browser.enabled, 'aria-label': 'Browser enabled', onchange: event => write(base + '/browser', 'PUT', { enabled: event.target.checked }) });
      const select = el('select', { 'aria-label': 'Browser profile', onchange: event => write(base + '/browser', 'PUT', { profile: event.target.value }) }, [
        el('option', { value: 'own', text: 'Own profile' }), el('option', { value: 'guest', text: 'Guest, no saved sign-ins' }),
        ...profiles.map(p => el('option', { value: `shared:${p.id}`, text: p.name })),
      ]);
      select.value = status.browser.profile;
      root.replaceChildren(el('h3', { text: 'Browser profiles' }), el('label', { class: 'bots-workbench-row' }, [enabled, 'Browser enabled']), select);
      for (const profile of profiles) {
        const name = el('input', { value: profile.name, maxlength: '60', 'aria-label': `Profile name, ${profile.name}` });
        const users = profile.used_by.map(a => a.name).join(', ');
        root.append(el('div', { class: 'bots-workbench-row' }, [name, el('small', { text: users ? `Used by ${users}` : 'No bots use this profile' }),
          el('button', { type: 'button', class: 'bots-btn', text: 'Rename', onclick: () => write(`/api/bot-workbench/profiles/${profile.id}`, 'PATCH', { name: name.value }) }),
          el('button', { type: 'button', class: 'bots-btn', text: 'Delete', disabled: profile.used_by.some(a => a.running), onclick: () => write(`/api/bot-workbench/profiles/${profile.id}`, 'DELETE') }),
        ]));
      }
      if (!profiles.length) root.append(el('p', { text: 'No shared profiles' }));
      const name = el('input', { maxlength: '60', placeholder: 'Profile name', 'aria-label': 'New profile name' });
      root.append(el('form', { class: 'bots-workbench-row', onsubmit: event => { event.preventDefault(); write('/api/bot-workbench/profiles', 'POST', { name: name.value }); } }, [name,
        el('button', { type: 'submit', class: 'bots-btn', text: 'Create profile', disabled: profiles.length >= 20 }),
      ]));
    } catch (e) { if (life.active) root.replaceChildren(el('p', { role: 'alert', text: e.message }), el('button', { class: 'bots-btn', text: 'Retry', onclick: refresh })); }
  }
  await refresh(); return life.handle(refresh);
}
