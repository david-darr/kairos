// Bots mode: usage-limit awareness (Agents 3.0 Phase 3, unit U3). Spec: phase-3-design.md sections 5.4, 6, 7; OMB F59.
// Styled by static/css/bots-automations.css.
//
//   mount(host, ctx)             Phase 1's chat mounts this in the header and failed-turn slot. ctx:
//                                {agentId, threadId, stoppedByLimit?: () => boolean, signal}.
//                                Draws a pill ("Claude: 92% used, resets 3:40 PM"; click rechecks) when an account is
//                                near its limit, and "Continue when my limit resets" after a turn a limit stopped.
//   mountWarnings(host, ctx)     The Automations page's banner: automations due before the reset, each with
//                                "Move to after reset". ctx: {routines(): normalized routines, onChanged()}.
//
// The numbers are the account's, read from GET /api/bot-limit-resets (cached on the server; ?refresh=1 asks again).
// One 60 second poll is shared by every mount. Moving a run changes only that routine's NEXT occurrence
// (POST /api/bot-limit-resets/after-reset); "continue" makes one once-only routine in that thread. Neither decides a time
// here: the server adds the 60 seconds after the reset.
import { api, toast } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { nearLimit, limitPillText, dueBeforeReset, whenMid, refusalOf } from './botsAutomationModel.js';

const CSS = '/static/css/bots-automations.css';
export const POLL_MS = 60000;

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

// -- The shared reading -----------------------------------------------------------------------------------

const listeners = new Set();
let reading = { endpoints: [], loaded: false }, timer = 0, inflight = null;

async function fetchReading(refresh = false) {
  if (inflight && !refresh) return inflight;
  const query = refresh ? '?refresh=1' : '';
  inflight = api(`/api/bot-limit-resets${query}`, { toast: false })
    .then(data => { reading = { endpoints: (data?.endpoints || data?.limits || []).map(e => ({ ...e, used_percent: e.used_percent ?? Math.max(0, ...(e.windows || []).map(w => Number(w.used_percent) || 0)) })), loaded: true }; })
    .catch(() => { reading = { ...reading, loaded: true }; })
    .finally(() => { inflight = null; for (const fn of listeners) fn(reading); });
  return inflight;
}

function subscribe(fn) {
  listeners.add(fn);
  if (!timer) timer = setInterval(() => { if (!document.hidden) fetchReading(); }, POLL_MS);
  fetchReading();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) { clearInterval(timer); timer = 0; }
  };
}

export const currentReading = () => reading;

// -- Header pill and the continue button --------------------------------------------------------------------

export async function mount(host, ctx = {}) {
  await loadBotsCss(CSS);
  const root = h('div', { class: 'bots-limit' });
  host.append(root);
  let disposed = false, busy = false;

  function draw() {
    if (disposed) return;
    const near = reading.endpoints.filter(nearLimit);
    const nodes = near.map(e => {
      const pill = h('button', { type: 'button', class: 'bots-limit-pill', 'data-blocked': e.blocked ? '' : undefined, 'data-endpoint': e.endpoint_id,
        title: 'Check again', 'aria-label': `${limitPillText(e)}. Check again.` }, [icon('clock', { size: 14 }), h('span', { text: limitPillText(e) })]);
      pill.addEventListener('click', async () => { pill.dataset.busy = ''; await fetchReading(true); });
      return pill;
    });
    const stopped = ctx.stoppedByLimit?.() && ctx.threadId && near.length;
    if (stopped) {
      const button = h('button', { type: 'button', class: 'bots-btn bots-limit-continue' }, [icon('refresh-cw', { size: 16 }), 'Continue when my limit resets']);
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true; button.disabled = true;
        try {
          await api('/api/bot-limit-resets/continue', { method: 'POST', body: JSON.stringify({ bot_id: ctx.agentId, thread_id: ctx.threadId }), toast: false });
          toast('Done. It will pick this up after the reset.', 'success');
          ctx.refresh?.();
        } catch (error) { toast(refusalOf(error).message || 'That did not work.', 'error'); button.disabled = false; }
        finally { busy = false; }
      });
      nodes.push(button);
    }
    root.replaceChildren(...nodes);
    root.hidden = !nodes.length;
  }
  const unsubscribe = subscribe(draw);
  draw();
  const stop = () => { disposed = true; unsubscribe(); root.remove(); };
  ctx.signal?.addEventListener('abort', stop, { once: true });
  return { dispose: stop, refresh: draw };
}

// -- The page banner --------------------------------------------------------------------------------------

export async function mountWarnings(host, ctx = {}) {
  await loadBotsCss(CSS);
  const root = h('section', { class: 'bots-limit-warn', 'aria-label': 'Usage limits', hidden: '' });
  host.append(root);
  let disposed = false;

  async function move(entry) {
    try {
      await api('/api/bot-limit-resets/after-reset', { method: 'POST', body: JSON.stringify({ routine_id: entry.routine.id }), toast: false });
      toast('Moved to after the reset', 'success');
      ctx.onChanged?.();
    } catch (error) { toast(refusalOf(error).message || 'That did not move.', 'error'); }
  }

  function draw() {
    if (disposed) return;
    const due = dueBeforeReset(ctx.routines?.() || [], reading.endpoints);
    root.hidden = !due.length;
    if (!due.length) { root.replaceChildren(); return; }
    const first = due[0];
    root.replaceChildren(
      h('p', { class: 'bots-limit-warn-title' }, [icon('triangle-alert', { size: 16 }), `${first.endpoint.name || 'Your AI'} is near its limit and resets ${whenMid(first.resetsAt)}. These are due first.`]),
      h('ul', { class: 'bots-limit-warn-list' }, due.slice(0, 5).map(entry => h('li', { 'data-routine-id': entry.routine.id }, [
        h('span', { class: 'bots-limit-warn-name', text: `${entry.routine.name}, ${whenMid(entry.routine.nextRunAt)}` }),
        h('button', { type: 'button', class: 'bots-btn', text: 'Move to after reset', 'aria-label': `Move ${entry.routine.name} to after the reset`, onclick: () => move(entry) }),
      ]))),
    );
  }
  const unsubscribe = subscribe(draw);
  draw();
  const stop = () => { disposed = true; unsubscribe(); root.remove(); };
  ctx.signal?.addEventListener('abort', stop, { once: true });
  return { dispose: stop, refresh: draw };
}
