import { h, loadBotsCss } from './botsUi.js';
import { reachValue, widensReach } from './botsDelegationModel.js';

const CSS = '/static/css/bots-delegation.css';
async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || 'Could not save reach.');
  return value;
}

export function mount(host, ctx) {
  loadBotsCss(CSS);
  const botId = ctx.agentId || ctx.botId;
  const api = ctx.request || request;
  let destroyed = false, generation = 0, saved, pending = null;
  const error = h('p', { class: 'bots-reach-error', role: 'alert' });
  const root = h('section', { class: 'bots-reach' });
  host.replaceChildren(root);

  function draw(data, bots) {
    saved = data;
    const mode = h('select', { 'aria-label': 'Who this bot can reach' }, [
      h('option', { value: 'all', text: 'All visible bots' }), h('option', { value: 'listed', text: 'Only these bots' }),
      h('option', { value: 'none', text: 'No bots' }),
    ]);
    mode.value = data.mode;
    const picker = h('fieldset', { class: 'bots-reach-picker' }, [h('legend', { text: 'Bots' })]);
    const boxes = bots.filter(bot => bot.id !== botId && !bot.hidden).map(bot => {
      const box = h('input', { type: 'checkbox', value: bot.id });
      box.checked = data.peers.includes(bot.id);
      picker.append(h('label', {}, [box, h('span', { text: bot.name })]));
      return box;
    });
    const approvals = h('input', { type: 'checkbox' });
    approvals.checked = data.approve_peer_comms !== false;
    const acknowledge = h('input', { type: 'checkbox', 'data-reach-ack': '' });
    const ackRow = h('label', { class: 'bots-reach-ack' }, [acknowledge, h('span', { text: 'I allow this bot to contact more bots.' })]);
    const button = h('button', { type: 'submit', text: 'Save reach', class: 'bots-reach-save' });
    const before = reachValue(data.mode, data.peers);
    const value = () => reachValue(mode.value, boxes.filter(box => box.checked).map(box => box.value));
    const sync = () => {
      picker.hidden = mode.value !== 'listed';
      const wider = widensReach(before, value());
      ackRow.hidden = !wider;
      button.disabled = wider && !acknowledge.checked;
    };
    mode.addEventListener('change', () => { acknowledge.checked = false; sync(); });
    boxes.forEach(box => box.addEventListener('change', () => { acknowledge.checked = false; sync(); }));
    acknowledge.addEventListener('change', sync);
    const form = h('form', { onsubmit: event => {
      event.preventDefault();
      if (button.disabled || pending) return;
      button.disabled = true; error.textContent = '';
      pending = api(`/api/bot-peers/${encodeURIComponent(botId)}/reach`, 'PUT', {
        mode: mode.value, peers: value() || [], expected_revision: saved.revision,
        acknowledge_scope: acknowledge.checked, approve_peer_comms: approvals.checked,
      }).then(async () => { if (!destroyed) { await ctx.onChanged?.(); await refresh(); } })
        .catch(cause => { if (!destroyed) { error.textContent = cause.message || String(cause); sync(); } })
        .finally(() => { pending = null; });
    } }, [h('label', { text: 'Who this bot can reach' }), mode, picker,
      h('label', {}, [approvals, h('span', { text: 'Ask before contacting bots below Full' })]), ackRow, button, error]);
    root.replaceChildren(form); sync();
  }

  async function refresh() {
    const revision = ++generation;
    try {
      const [data, agents] = await Promise.all([api(`/api/bot-peers/${encodeURIComponent(botId)}/reach`), api('/api/agents')]);
      if (destroyed || revision !== generation) return;
      draw(data, Array.isArray(agents) ? agents : agents.agents || []);
    } catch (cause) {
      if (!destroyed && revision === generation) { error.textContent = cause.message || String(cause); root.replaceChildren(error); }
    }
  }
  root.append(h('p', { text: 'Loading reach' }));
  refresh();
  return { refresh, async flush() { if (pending) await pending; return !error.textContent; },
    destroy() { destroyed = true; generation++; host.replaceChildren(); } };
}
