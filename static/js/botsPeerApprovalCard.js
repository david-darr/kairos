import { h, Button, loadBotsCss } from './botsUi.js';
import { teamRequest, teamError } from './botsTeamHost.js';
export const peerActions = card => ['pending', 'open', 'proposed'].includes(card?.status || card?.state || 'pending') ? ['allow', 'deny', 'always_allow'] : [];
export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-teams.css');
  const abort = new AbortController(), request = ctx.api || teamRequest;
  let card = ctx.card || {}, disposed = false, busy = false;
  const box = h('section', { class: 'bots-team-card', 'data-card-kind': 'peer_approval' }); host.append(box);
  async function respond(action) {
    if (busy || !peerActions(card).includes(action)) return;
    busy = true; draw();
    try {
      const payload = { action: action === 'always_allow' ? 'allow' : action, expected_revision: card.revision, ...(action === 'always_allow' ? { remember: true } : {}) };
      const result = ctx.respond ? await ctx.respond(card, payload) : await request(`/api/bot-cards/${encodeURIComponent(card.id)}/respond`, { method: 'POST', body: payload, signal: abort.signal });
      if (disposed) return;
      card = result.card || { ...card, status: action === 'deny' ? 'denied' : 'allowed' }; ctx.onChanged?.(result); draw();
    } catch (error) { if (!disposed) box.append(h('p', { class: 'bots-team-error', role: 'alert', text: teamError(error) })); }
    finally { busy = false; if (!disposed) box.querySelectorAll('button').forEach(b => { b.disabled = !peerActions(card).length; }); }
  }
  function draw() {
    const payload = card.payload || card.data || card;
    box.replaceChildren(h('h3', { text: `${payload.sender_name || payload.bot_name || 'This bot'} wants to contact ${payload.target_name || payload.target_id || 'a teammate'}` }),
      h('p', { text: payload.reason || payload.brief || 'Review this contact request.' }),
      h('p', { class: 'bots-hint', text: 'Allowing contact does not give the teammate extra authority.' }),
      ...(peerActions(card).length ? [h('div', { class: 'bots-team-actions' }, [
        Button({ label: 'Allow', variant: 'primary', disabled: busy, onClick: () => respond('allow') }),
        Button({ label: 'Deny', disabled: busy, onClick: () => respond('deny') }),
        Button({ label: 'Always allow', disabled: busy, onClick: () => respond('always_allow') }),
      ])] : [h('p', { role: 'status', text: `Request ${card.status || card.state || 'closed'}` })]));
  }
  draw(); return { refresh(next) { card = next?.card || next || card; draw(); }, flush: async () => ({ ok: !busy }), destroy() { disposed = true; abort.abort(); box.remove(); } };
}
export const mountPeerApprovalCard = mount;
