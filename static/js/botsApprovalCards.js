// The typed-card registry also accepts renderers supplied by the approval unit.
import { h, loadBotsCss } from './botsUi.js';
import { mount as peer } from './botsPeerApprovalCard.js';
import { mount as setup } from './botsTeamSetupCard.js';
import { teamRequest, teamError } from './botsTeamHost.js';
const renderers = new Map([['peer_approval', peer], ['team_setup', setup]]);
export function registerCardRenderer(kind, renderer) { if (!kind || typeof renderer !== 'function') throw new Error('A card kind and renderer are required.'); renderers.set(kind, renderer); return () => { if (renderers.get(kind) === renderer) renderers.delete(kind); }; }
export const registerCardKind = registerCardRenderer;
export const cardKinds = () => [...renderers.keys()];
export function mountCard(host, ctx) {
  const renderer = renderers.get(ctx.card?.kind || ctx.card?.type);
  if (!renderer) { host.replaceChildren(h('p', { role: 'status', text: 'Open this request in Inbox to review it.' })); return { destroy() { host.replaceChildren(); } }; }
  return renderer(host, ctx);
}
export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-teams.css');
  const abort = new AbortController(), request = ctx.api || teamRequest;
  let disposed = false, handles = [], generation = 0;
  async function refresh() {
    const at = ++generation;
    try {
      const raw = ctx.cards || await request(`/api/bot-cards?thread_id=${encodeURIComponent(ctx.threadId || '')}`, { signal: abort.signal });
      if (disposed || at !== generation) return;
      handles.forEach(h => (h?.destroy || h?.dispose)?.call(h)); handles = []; host.replaceChildren();
      const cards = Array.isArray(raw) ? raw : raw.cards || [];
      for (const card of cards) { const slot = h('div'); host.append(slot); handles.push(mountCard(slot, { ...ctx, card, onChanged: result => { ctx.onChanged?.(result); refresh(); } })); }
    } catch (problem) { if (!disposed && at === generation) host.replaceChildren(h('p', { role: 'alert', text: `Requests could not load. ${teamError(problem)}` })); }
  }
  refresh(); return { refresh, dispose() { this.destroy(); }, destroy() { disposed = true; ++generation; abort.abort(); handles.forEach(h => (h?.destroy || h?.dispose)?.call(h)); handles = []; host.replaceChildren(); } };
}
