import { h, Button, loadBotsCss } from '../botsUi.js';
import { targetId } from '../botsNavigation.js';
import { mount as mountCanvas } from '../botsTeamCanvas.js';
import { mapData, taggedBots, tagSlug } from '../botsTeamMapModel.js';
import { teamRequest, teamError, openNewRoom, openTeamDialog } from '../botsTeamHost.js';

export async function render(container, tabId, options = {}) {
  await loadBotsCss('/static/css/bots-teams.css');
  let disposed = false, reading = false, first = true, data = mapData(), signature = '', sending = false;
  const selected = new Set(), tickets = new Map();
  const request = options.api || teamRequest;
  const error = h('p', { class: 'bots-team-error', role: 'alert', hidden: true });
  const canvasHost = h('div', { class: 'bots-team-canvas-host' });
  const tags = h('div', { class: 'bots-team-tags', role: 'group', 'aria-label': 'Send to bots or teams' });
  const input = h('textarea', { rows: '2', 'aria-label': 'Message tagged bots', placeholder: 'Tag @bots, a team or @everyone', maxlength: '100000' });
  const receipts = h('div', { class: 'bots-team-receipts', role: 'status', 'aria-live': 'polite' });
  const send = Button({ label: 'Send', variant: 'primary', onClick: submit });
  const composer = h('form', { class: 'bots-team-composer', onsubmit: e => { e.preventDefault(); submit(); } }, [tags, input, send, receipts]);
  const edges = h('details', { class: 'bots-team-edges' });
  const root = h('main', { class: 'bots-team-map' }, [h('header', { class: 'bots-team-map-head' }, [h('h1', { text: 'Team map' }),
    Button({ label: 'New room', iconName: 'hash', onClick: () => openNewRoom() }), Button({ label: 'New team', iconName: 'plus', onClick: () => openTeamDialog() })]), error, canvasHost, composer, edges]);
  container.replaceChildren(root);
  const canvas = mountCanvas(canvasHost, { api: request, onChanged: refresh, onTag: id => { selected.has(id) ? selected.delete(id) : selected.add(id); paintTags(); } });
  function recipients() { return taggedBots(input.value, [...selected], data); }
  function paintTags() {
    const add = (label, ids) => {
      const on = ids.length > 0 && ids.every(id => selected.has(id));
      return h('button', { type: 'button', class: 'bots-team-tag', text: label, 'aria-pressed': String(on), disabled: !ids.length || sending,
        onclick: () => { ids.forEach(id => on ? selected.delete(id) : selected.add(id)); paintTags(); } });
    };
    tags.replaceChildren(add('@everyone', data.bots.map(b => b.id)), ...data.departments.filter(t => !t.ungrouped).map(t => add(`@${tagSlug(t.name)}`, t.members.map(b => b.id))), ...data.bots.map(b => add(`@${b.name || b.id}`, [b.id])));
    canvas.select(recipients().map(b => b.id)); send.disabled = sending || !input.value.trim() || !recipients().length;
  }
  async function submit() {
    const bots = recipients(), text = input.value.trim();
    if (sending || !text || !bots.length) return;
    sending = true; error.hidden = true; input.disabled = true; paintTags();
    const results = [];
    for (const bot of bots) {
      if (disposed) break;
      // Keep the same ID and destination after a lost response. Successful recipients are not resent.
      const key = `${bot.id}\n${text}`;
      let ticket = tickets.get(key);
      if (!ticket) { ticket = { id: crypto.randomUUID(), sent: false }; tickets.set(key, ticket); }
      if (ticket.sent) { results.push({ bot, ok: true }); continue; }
      try {
        const saved = await (await import('../botsPatchQueue.js')).flushBotEdits(bot.id);
        if (saved?.ok === false) throw new Error('Save the bot settings before sending.');
        if (!ticket.sid) {
          const threads = await request(`/api/agents/${encodeURIComponent(bot.id)}/threads`);
          ticket.sid = targetId(threads.main_id);
          if (!ticket.sid) ticket.sid = targetId((await request(`/api/agents/${encodeURIComponent(bot.id)}/threads`, { method: 'POST', body: {} })).id);
          if (!ticket.sid) throw new Error('A conversation could not start.');
          ticket.leaf = (await request(`/api/bot-chat/${ticket.sid}/state`)).active_leaf_id || null;
        }
        await request(`/api/bot-chat/${ticket.sid}/send`, { method: 'POST', body: { text, send_id: ticket.id, expected_leaf_id: ticket.leaf } });
        ticket.sent = true; results.push({ bot, ok: true });
      } catch (problem) { results.push({ bot, ok: false }); error.hidden = false; error.textContent = `${bot.name}: ${teamError(problem)}`; }
    }
    if (disposed) return;
    receipts.replaceChildren(...results.map(r => h('span', { class: 'bots-tag', text: `${r.ok ? 'Sent to' : 'Could not send to'} ${r.bot.name || 'bot'}` })));
    canvas.sent(results.filter(r => r.ok).map(r => r.bot.id));
    if (results.length === bots.length && results.every(r => r.ok)) { input.value = ''; tickets.clear(); }
    sending = false; input.disabled = false; paintTags();
  }
  async function refresh() {
    if (disposed || reading || document.hidden) return;
    reading = true;
    try {
      const raw = await request('/api/bot-team/map');
      if (disposed) return;
      error.hidden = true;
      const next = JSON.stringify(raw);
      if (next === signature) return;
      signature = next; data = mapData(raw);
      for (const id of selected) if (!data.bots.some(b => b.id === id)) selected.delete(id);
      canvas.refresh(data); paintTags();
      edges.replaceChildren(h('summary', { text: `Handoffs ${data.edges.length}` }), ...data.edges.map(edge => h('button', { type: 'button', class: 'bots-team-edge',
        text: `${edge.source_name || edge.requester?.bot_id || edge.source_bot_id || 'Bot'} → ${edge.target_name || edge.assignee_bot_id || edge.target_bot_id || 'Bot'}: ${edge.reason || edge.status || 'Working'}`,
        onclick: () => { const roomId = targetId(edge.room_id), bot = targetId(edge.assignee_bot_id || edge.target_bot_id), sid = targetId(edge.work_session_id); if (roomId) import('../botsTeamHost.js').then(m => m.teamNavigate('botsRoom', { roomId })); else if (bot) import('../botsTeamHost.js').then(m => m.teamNavigate('botsShell', { agentId: bot, sessionId: sid })); } })));
      if (first) { first = false; canvas.initialFit(); const id = targetId(options.departmentId); if (id) root.querySelector(`[data-team-key="${CSS.escape(id)}"]`)?.classList.add('selected'); }
    } catch (problem) { if (!disposed) { error.hidden = false; error.replaceChildren(h('span', { text: `Team map could not load. ${teamError(problem)}` }), Button({ label: 'Try again', onClick: refresh })); } }
    finally { reading = false; }
  }
  input.addEventListener('input', paintTags);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); submit(); } });
  document.addEventListener('jarvis:agents-changed', refresh); document.addEventListener('visibilitychange', refresh);
  const timer = setInterval(refresh, 3000); await refresh();
  return () => { disposed = true; clearInterval(timer); document.removeEventListener('jarvis:agents-changed', refresh); document.removeEventListener('visibilitychange', refresh); canvas.destroy(); root.remove(); };
}
