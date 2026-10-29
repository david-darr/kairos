import { h, Button, loadBotsCss } from './botsUi.js';
import { targetId } from './botsNavigation.js';
import { teamRequest, teamError } from './botsTeamHost.js';
export const SETUP_CHOICES = ['Research a topic', 'Watch for useful updates', 'Organize mail and calendar', 'Plan everyday errands', 'Work with data and reports'];
export function setupChoices(raw) {
  const choices = (raw?.suggestions || raw?.choices || []).map(s => typeof s === 'string' ? s : s.text || s.label || '').filter(s => s.length <= 50 && !/[\d@]|https?:|\n/.test(s));
  return choices.length >= 3 ? choices.slice(0, 8) : SETUP_CHOICES;
}
export function mountSetupCard(host, ctx = {}) {
  loadBotsCss('/static/css/bots-teams.css');
  if (!targetId(ctx.agentId) || !targetId(ctx.threadId)) throw new Error('A bot and conversation are required.');
  const abort = new AbortController(), request = (p, init = {}) => (ctx.api || teamRequest)(p, { ...init, signal: abort.signal });
  const path = `/api/bot-setup/${ctx.agentId}`;
  let disposed = false, busy = false, eligible = false, choices = SETUP_CHOICES, timer = 0, started = 0;
  const box = h('section', { class: 'bots-team-card', 'data-card-kind': 'setup', hidden: true }); host.append(box);
  const error = h('p', { class: 'bots-team-error', role: 'alert' });
  async function pick(text) {
    if (busy || !eligible) return;
    busy = true; draw();
    try {
      await request(`${path}/request`, { method: 'POST', body: { thread_id: ctx.threadId, ...(text ? { text } : {}) } });
      if (disposed) return;
      await ctx.onPick?.(text ? `/setup ${text}` : '', { agentId: ctx.agentId, threadId: ctx.threadId, setup: true, other: !text });
      eligible = false; box.hidden = true;
    } catch (problem) { if (!disposed) error.textContent = teamError(problem); }
    finally { busy = false; if (!disposed) draw(); }
  }
  async function dismiss() {
    if (busy) return; busy = true;
    try { await request(`${path}/request`, { method: 'DELETE' }); if (!disposed) { eligible = false; box.hidden = true; } }
    catch (problem) { if (!disposed) error.textContent = teamError(problem); }
    finally { busy = false; }
  }
  function draw(pending = false) {
    box.hidden = !eligible;
    box.replaceChildren(h('h3', { text: 'What should this bot help with first?' }),
      ...(pending ? Array.from({ length: 5 }, () => h('div', { class: 'bots-row', 'aria-busy': 'true', text: 'Finding ideas...' })) : choices.map((text, i) => Button({ label: `${String.fromCharCode(65 + i)}. ${text}`, disabled: busy, onClick: () => pick(text) }))),
      h('div', { class: 'bots-team-actions' }, [Button({ label: 'Something else', disabled: busy, onClick: () => pick('') }), Button({ label: 'Close', disabled: busy, onClick: dismiss })]), error);
  }
  async function suggestions() {
    try { const raw = await request(`${path}/suggestions`); if (disposed) return; choices = setupChoices(raw); const pending = raw.pending && Date.now() - started < 8000; draw(pending); if (raw.pending && Date.now() - started < 20000) timer = setTimeout(suggestions, 1000); }
    catch { if (!disposed) draw(); }
  }
  async function refresh() {
    try { const state = await request(`${path}/request?thread_id=${encodeURIComponent(ctx.threadId)}`); if (disposed) return; eligible = state.eligible === true || state.show === true; draw(); if (eligible) { clearTimeout(timer); started = Date.now(); suggestions(); } }
    catch (problem) { if (!disposed) { box.hidden = false; box.replaceChildren(h('p', { role: 'alert', text: `Setup could not load. ${teamError(problem)}` }), Button({ label: 'Try again', onClick: refresh })); } }
  }
  box.addEventListener('keydown', event => { if (event.target !== box || busy || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return; const i = event.key.toUpperCase().charCodeAt(0) - 65; if (event.key.length === 1 && i >= 0 && i < choices.length) { event.preventDefault(); pick(choices[i]); } });
  box.tabIndex = 0; refresh();
  return { refresh, flush: async () => ({ ok: !busy }), destroy() { disposed = true; clearTimeout(timer); abort.abort(); box.remove(); } };
}
export const mount = mountSetupCard;
