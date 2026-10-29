import { h, Button, loadBotsCss } from './botsUi.js';
import { departmentPath, teamRequest, teamError, teamChanged, openTeamDialog, openTeamInstructions, openTeamMemory } from './botsTeamHost.js';

export const chiefDisabledReason = bot => !bot?.section ? 'Choose a team first.' : bot.tools_available === false || bot.can_use_tools === false || bot.capabilities?.tools === false ? 'This model cannot use tools.' : '';
export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-teams.css');
  const request = ctx.ui?.api ? (p, init = {}) => ctx.ui.api(p, { ...init, ...(init.body ? { body: JSON.stringify(init.body) } : {}), toast: false }) : ctx.api || teamRequest;
  let disposed = false, generation = 0;
  const agent = () => ctx.state?.agent || ctx.getAgent?.() || ctx.agent || {};
  async function refresh() {
    const at = ++generation, bot = agent();
    host.replaceChildren(h('p', { role: 'status', text: 'Loading team...' }));
    try {
      const raw = await request('/api/bot-departments');
      if (disposed || at !== generation) return;
      const teams = Array.isArray(raw) ? raw : raw.departments || [];
      const team = teams.find(t => t.name === bot.section), chief = team?.chief_bot_id === bot.id;
      const select = h('select', { 'aria-label': 'Team' }, [h('option', { value: '', text: 'No team' }), ...teams.map(t => h('option', { value: t.name, text: t.name }))]);
      select.value = bot.section || '';
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          const saved = await ctx.flushResult?.(); if (saved?.ok === false) throw saved.error;
          const result = await request(`/api/agents/${encodeURIComponent(ctx.agentId || bot.id)}`, { method: 'PATCH', body: { section: select.value } });
          ctx.adopt?.(result.agent || result); teamChanged(); await ctx.refresh?.(); if (!disposed) refresh();
        } catch (error) { if (!disposed) { errorLine.textContent = teamError(error); select.value = bot.section || ''; select.disabled = false; } }
      });
      const reason = chiefDisabledReason(bot), errorLine = h('p', { class: 'bots-team-error', role: 'alert' });
      const chiefButton = Button({ label: chief ? 'Remove chief' : 'Make chief', iconName: 'crown', disabled: !!reason || !team, onClick: async () => {
        chiefButton.disabled = true;
        try { await request(`${departmentPath(team.id)}/chief`, { method: 'PUT', body: { bot_id: chief ? null : bot.id, also_manages: team.also_manages || [] } }); teamChanged(); refresh(); }
        catch (error) { if (!disposed) { errorLine.textContent = teamError(error); chiefButton.disabled = false; } }
      } });
      host.replaceChildren(h('div', { class: 'bots-row' }, [h('label', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: 'Team' }), select])]),
        h('div', { class: 'bots-team-actions' }, [Button({ label: 'New team', iconName: 'plus', onClick: () => openTeamDialog({ agentId: bot.id }) }), chiefButton,
          ...(team ? [Button({ label: 'Team instructions', onClick: () => openTeamInstructions({ departmentId: team.id }) }), Button({ label: 'Team memory', onClick: () => openTeamMemory({ departmentId: team.id }) })] : [])]),
        reason ? h('p', { class: 'bots-hint', text: reason }) : h('p', { class: 'bots-hint', text: chief ? 'Chief of Staff for this team.' : 'One Chief of Staff can coordinate this team.' }), errorLine);
    } catch (error) { if (!disposed && at === generation) host.replaceChildren(h('p', { role: 'alert', text: `Team could not load. ${teamError(error)}` }), Button({ label: 'Try again', onClick: refresh })); }
  }
  refresh(); return { refresh, flush: async () => ({ ok: true }), destroy() { disposed = true; ++generation; host.replaceChildren(); } };
}
