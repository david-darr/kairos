import { h, Button, loadBotsCss } from './botsUi.js';
import { diffLines } from './botsProfileDiff.js';
import { teamRequest, teamError, teamChanged } from './botsTeamHost.js';
export const setupActions = card => { const state = card?.state || card?.status || 'proposed'; return ['proposed', 'open', 'pending'].includes(state) ? ['apply', 'cancel'] : state === 'applied' ? ['undo'] : []; };
export function setupDiff(ops = []) {
  return ops.map(op => ({ title: op.name || op.after?.name || op.before?.name || op.bot_id || 'New bot', op: op.op || 'update',
    fields: [...new Set([...Object.keys(op.before || {}), ...Object.keys(op.after || {})])].filter(key => key !== 'soul' && JSON.stringify(op.before?.[key]) !== JSON.stringify(op.after?.[key])).map(key => ({ key, before: op.before?.[key], after: op.after?.[key] })),
    soul: op.after && Object.hasOwn(op.after, 'soul') ? diffLines(op.before?.soul || '', op.after.soul || '') : [],
    capabilities: op.capability_differences || op.capabilities || [] }));
}
export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-teams.css');
  const abort = new AbortController(), request = ctx.api || teamRequest;
  let card = ctx.card || {}, busy = false, disposed = false;
  const box = h('section', { class: 'bots-team-card', 'data-card-kind': 'team_setup' }); host.append(box);
  async function act(action) {
    if (busy || !setupActions(card).includes(action)) return;
    busy = true; draw();
    try {
      const payload = card.payload || card.data || card, id = payload.receipt_id || card.receipt_id || payload.id || card.id;
      const result = await request(`/api/bot-team/changes/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: { expected_revision: card.revision ?? payload.revision }, signal: abort.signal });
      if (disposed) return;
      card = result.receipt || result.change || result.card || { ...card, state: action === 'undo' ? 'undone' : action === 'cancel' ? 'cancelled' : 'applied' };
      ctx.onChanged?.(result); teamChanged();
    } catch (error) { if (!disposed) { const conflict = error?.status === 409 || /^409\b/.test(String(error?.message)); message = conflict ? 'This setup changed. Reload it before trying again.' : teamError(error); if (conflict) card = { ...card, state: 'stale' }; } }
    finally { busy = false; if (!disposed) draw(); }
  }
  let message = '';
  function draw() {
    const payload = card.payload || card.data || card;
    const val = value => value === undefined || value === null || value === '' ? 'None' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    box.replaceChildren(h('h3', { text: 'Team setup' }), h('p', { text: payload.reason || 'Review these team changes.' }),
      ...setupDiff(payload.ops || []).map(op => h('section', {}, [h('h4', { text: `${op.op}: ${op.title}` }),
        ...op.fields.map(f => h('p', { text: `${f.key === 'section' ? 'Team' : f.key === 'chief' ? 'Chief of Staff' : f.key}: ${val(f.before)} → ${val(f.after)}` })),
        ...(op.soul.length ? [h('pre', {}, op.soul.map(line => h('span', { class: `bots-team-diff-${line.type}`, text: `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} ${line.text}\n` })))] : []),
        ...(Array.isArray(op.capabilities) ? op.capabilities : [op.capabilities]).map(text => h('p', { class: 'bots-hint', text: val(text) })),
      ])), h('p', { role: 'status', text: card.state || card.status || 'Proposed' }),
      message ? h('p', { class: 'bots-team-error', role: 'alert', text: message }) : null,
      h('div', { class: 'bots-team-actions' }, setupActions(card).map(action => Button({ label: action === 'apply' ? 'Apply setup' : action === 'cancel' ? 'Cancel' : 'Undo', variant: action === 'apply' ? 'primary' : 'secondary', disabled: busy, onClick: () => act(action) }))));
  }
  draw(); return { refresh(next) { card = next?.card || next || card; message = ''; draw(); }, flush: async () => ({ ok: !busy }), destroy() { disposed = true; abort.abort(); box.remove(); } };
}
export const mountTeamSetupCard = mount;
