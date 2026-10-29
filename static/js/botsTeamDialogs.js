import { h, Button } from './botsUi.js';
import { teamRequest, teamError, teamChanged, departmentPath, openTeamSurface, confirmTeamAction } from './botsTeamHost.js';
import { chiefDisabledReason } from './botsSectionTeam.js';

export const byteCounter = (text, limit = 24000) => { const used = new TextEncoder().encode(String(text || '')).length; return { used, limit, over: used > limit, label: `${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} bytes` }; };
export const isDirty = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
export const bulkPreviewRows = raw => (Array.isArray(raw) ? raw : raw?.bots || raw?.results || raw?.preview || []).map(row => ({ ...row,
  status: ['will-change', 'will_change', 'change'].includes(row.status) ? 'will-change' : row.status === 'unchanged' ? 'unchanged' : 'skipped', reason: String(row.reason || '') }));
export function memoryGroups(entries = []) {
  return ['person', 'place', 'decision', 'term'].map(kind => ({ kind, label: { person: 'People', place: 'Places', decision: 'Decisions', term: 'Terms' }[kind], entries: entries.filter(e => e.kind === kind && e.status !== 'proposed') }));
}
export function mount(host, ctx = {}) {
  const abort = new AbortController(), request = (path, init = {}) => (ctx.api || teamRequest)(path, { ...init, signal: abort.signal });
  const mode = ctx.mode || (ctx.departmentId ? 'manage' : 'create');
  let disposed = false, busy = false, baseline = null, department = null, bots = [], selected = new Set();
  const name = h('input', { 'aria-label': 'Team name', maxlength: '60', required: true });
  const picker = h('div', { class: 'bots-team-picker', role: 'group', 'aria-label': 'Team members' });
  const error = h('p', { class: 'bots-team-error', role: 'alert' });
  const progress = h('p', { role: 'status', 'aria-live': 'polite' });
  const save = Button({ label: mode === 'delete' ? 'Delete team' : mode === 'chief' ? 'Save chief' : 'Save team', variant: mode === 'delete' ? 'danger' : 'primary', onClick: submit });
  host.append(h('label', { class: 'bots-team-field' }, [h('span', { text: 'Team name' }), name]), picker, progress, error, save);
  const snapshot = () => ({ name: name.value.trim(), ids: [...selected].sort() });
  async function refresh() {
    if (busy || (baseline && isDirty(baseline, snapshot()))) return;
    save.disabled = true;
    try {
      const [allBots, allTeams] = await Promise.all([request('/api/agents'), request('/api/bot-departments')]);
      if (disposed) return;
      bots = (Array.isArray(allBots) ? allBots : allBots.agents || []).filter(b => !b.hidden);
      const teams = Array.isArray(allTeams) ? allTeams : allTeams.departments || [];
      department = mode === 'create' ? null : teams.find(t => t.id === ctx.departmentId) || teams.find(t => t.name === bots.find(b => b.id === ctx.agentId)?.section);
      if (mode !== 'create' && !department) throw new Error('This team no longer exists.');
      name.value = department?.name || ''; name.disabled = ['delete', 'chief'].includes(mode);
      selected = new Set(bots.filter(b => b.section && b.section === department?.name).map(b => b.id));
      if (mode === 'create' && ctx.agentId) selected.add(ctx.agentId);
      picker.replaceChildren(...bots.map(bot => {
        const check = h('input', { type: 'checkbox', 'aria-label': bot.name || 'Bot', checked: selected.has(bot.id), disabled: ['rename', 'delete', 'chief'].includes(mode), onchange: () => check.checked ? selected.add(bot.id) : selected.delete(bot.id) });
        return h('label', { class: 'bots-row' }, [check, h('span', { text: `${bot.name}${bot.section ? ` (${bot.section})` : ''}` })]);
      }));
      if (mode === 'chief') {
        const bot = bots.find(b => b.id === ctx.agentId);
        if (!bot) throw new Error('This bot no longer exists.');
        const reason = chiefDisabledReason(bot); if (reason) throw new Error(reason);
        picker.replaceChildren(h('p', { text: `${department.chief_bot_id === bot.id ? 'Remove' : 'Make'} ${bot.name} as Chief of Staff for ${department.name}?` }));
      }
      if (mode === 'delete') picker.replaceChildren(h('p', { text: 'Remove this team. Its bots keep their conversations.' }));
      baseline = snapshot(); error.textContent = ''; save.disabled = false;
    } catch (problem) { if (!disposed) { error.replaceChildren(h('span', { text: teamError(problem) }), Button({ label: 'Try again', onClick: refresh })); } }
  }
  async function submit() {
    if (busy || !baseline) return;
    const value = name.value.trim();
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) { error.textContent = 'Use a short team name without control characters.'; return; }
    busy = true; save.disabled = true; error.textContent = '';
    try {
      if (mode === 'chief') await request(`${departmentPath(department.id)}/chief`, { method: 'PUT', body: { bot_id: department.chief_bot_id === ctx.agentId ? null : ctx.agentId, also_manages: department.also_manages || [] } });
      else if (mode === 'delete') {
        if (!await confirmTeamAction(host, { title: `Delete ${department.name}?`, confirmLabel: 'Delete team' })) return;
        await request(departmentPath(department.id), { method: 'DELETE' });
      } else if (!department) await request('/api/bot-departments', { method: 'POST', body: { name: value, bot_ids: [...selected] } });
      else {
        if (department.name !== value) { const result = await request(departmentPath(department.id), { method: 'PATCH', body: { name: value, expected_revision: department.revision } }); department = { ...department, name: value, ...(result.department || result) }; }
        if (mode === 'manage') {
          let count = 0;
          for (const bot of bots) {
            const was = baseline.ids.includes(bot.id), now = selected.has(bot.id);
            if (was === now) continue;
            await request(`/api/agents/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: { section: now ? value : '' } });
            progress.textContent = `${++count} updated`; baseline.ids = now ? [...baseline.ids, bot.id] : baseline.ids.filter(id => id !== bot.id);
          }
        }
      }
      baseline = snapshot(); teamChanged(); ctx.onChanged?.(); ctx.onSaved?.();
    } catch (problem) { if (!disposed) error.textContent = teamError(problem); teamChanged(); }
    finally { busy = false; if (!disposed) save.disabled = false; }
  }
  refresh(); return { refresh, flush: async () => ({ ok: !busy, dirty: baseline && isDirty(baseline, snapshot()) }), dirty: () => baseline && isDirty(baseline, snapshot()), get busy() { return busy; }, destroy() { disposed = true; abort.abort(); host.replaceChildren(); } };
}
export function open(options = {}) {
  let handle;
  const dialog = openTeamSurface({ title: options.mode === 'chief' ? 'Chief of Staff' : options.mode === 'rename' ? 'Rename team' : options.mode === 'delete' ? 'Delete team' : options.departmentId ? 'Manage team' : 'New team', width: 520,
    beforeClose: async () => !handle?.busy && (!handle?.dirty() || await confirmTeamAction(dialog.body, { title: 'Discard your team changes?', confirmLabel: 'Discard' })), onClose: () => handle?.destroy() });
  handle = mount(dialog.body, { ...options, onSaved: () => { options.onSaved?.(); dialog.destroy(); } });
  return { ...dialog, refresh: handle.refresh, flush: handle.flush };
}
