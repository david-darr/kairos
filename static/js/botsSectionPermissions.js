// A bot's Permissions section (Phase 3, unit U1). Phase 1's panel mounts this lazily: mount(host, ctx) ->
// {destroy, dispose, refresh, flush}. ctx: agentId, threadId (optional), state.agent, advanced, update(fields), go().
//
// Simple view: Ask first or Just do it, the chip for what this conversation follows, and the daily allowance.
// Advanced view: all five levels, remembered commands, runs per day. Lowering a level saves at once and is never
// queued; raising one is confirmed in the desktop app, and the page only starts that request.
import { api, toast } from './api.js';
import { Card, Segmented, RadioGroup, SwitchRow, TextRow, Button, h, isAdvanced, onBotsInterface, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { SIMPLE_OPTIONS, allowanceText, changeLevel, describe, levelOptions, messageOf, simpleChoice } from './botsApprovalModel.js';

export const PERMISSIONS_CSS = '/static/css/bots-permissions.css';

const note = text => h('div', { class: 'bots-row bots-note-line' }, [icon('info', { size: 16 }), h('span', { class: 'bots-row-hint', text })]);
const advancedNow = ctx => (typeof ctx.advanced === 'function' ? ctx.advanced() : ctx.advanced ?? isAdvanced());

export function mount(host, ctx) {
  loadBotsCss(PERMISSIONS_CSS);
  const base = `/api/bots-approvals/${encodeURIComponent(ctx.agentId)}`;
  const threadId = () => (typeof ctx.threadId === 'function' ? ctx.threadId() : ctx.threadId) || null;
  const root = h('div', { class: 'bots-permissions', 'data-section': 'permissions' });
  host.append(root);
  let destroyed = false, view = null, outbound = null, rules = null, failure = '', busy = false, scope = 'thread', generation = 0;
  const stopAdvanced = onBotsInterface(() => draw());

  const post = (tail, body) => api(`${base}${tail}`, { method: 'POST', body: JSON.stringify(body), toast: false });
  const desktop = () => (typeof window !== 'undefined' ? window.jarvis?.botApprovals : null);

  async function load() {
    const mine = ++generation;
    try {
      const query = threadId() ? `?thread_id=${encodeURIComponent(threadId())}` : '';
      const [next, money] = await Promise.all([api(`${base}${query}`, { toast: false }), api(`${base}/outbound`, { toast: false }).catch(() => null)]);
      if (destroyed || mine !== generation) return;
      view = next; outbound = money; failure = '';
      rules = advancedNow(ctx) ? await api(`${base}/commands`, { toast: false }).catch(() => null) : null;
    } catch (error) {
      if (destroyed || mine !== generation) return;
      failure = messageOf(error);
    }
    draw();
  }

  async function choose(target, where) {
    if (busy) return;
    busy = true; draw();
    const result = await changeLevel({ post, desktop: desktop() }, { view, target, scope: where, threadId: threadId() });
    busy = false;
    if (destroyed) return;
    if (!result.ok) toast(result.message, 'error');
    await load();
  }

  function levelCard() {
    const thread = threadId();
    const info = describe(view);
    const where = thread && scope === 'thread' ? 'thread' : 'bot';
    const children = [h('div', { class: 'bots-row bots-note-line' }, [h('span', { class: 'bots-permissions-chip', 'data-chip': 'level', text: info.chip })])];
    if (thread) children.push(h('div', { class: 'bots-row bots-stack-row' }, [Segmented({ label: 'Change it for', value: scope,
      options: [{ value: 'thread', label: 'This conversation' }, { value: 'bot', label: 'The whole bot' }], onChange: value => { scope = value; draw(); } })]));
    const current = simpleChoice(view);
    if (advancedNow(ctx)) {
      const options = levelOptions(view);
      const selected = where === 'thread' && !view.inherited ? view.thread_mode : view.bot_mode;
      children.push(RadioGroup({ label: 'Approval', value: selected, options: options.map(o => ({ value: o.value, title: o.label, hint: o.raise
        ? `${o.hint} Confirming this opens a prompt in the desktop app.` : o.hint, disabled: o.disabled || busy })), onChange: value => choose(value, where) }));
    } else {
      children.push(RadioGroup({ label: 'Approval', value: current, options: SIMPLE_OPTIONS.map(o => ({ ...o, title: o.label, disabled: busy })),
        onChange: value => choose(value, where) }));
    }
    if (thread && !view.inherited) children.push(h('div', { class: 'bots-row' }, [Button({ label: 'Follow the bot again', iconName: 'refresh-cw',
      disabled: busy, onClick: () => choose(null, 'thread') })]));
    for (const line of info.lines) children.push(note(line));
    if (view.levels.some(l => !l.available) && advancedNow(ctx)) {
      for (const level of view.levels.filter(l => !l.available)) children.push(note(`${level.label}: ${level.reason}`));
    }
    return Card({ label: 'Before it acts', className: 'bots-permissions-level', children });
  }

  function moneyCard() {
    const agent = ctx.state?.agent || {};
    const policy = agent.outbound?.policy || outbound?.policy || 'ask';
    const cap = agent.outbound?.daily_cap ?? outbound?.cap ?? 25;
    const choice = Segmented({ label: 'Messages outside the app', value: policy, options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }],
      onChange: value => { ctx.update?.({ outbound: { policy: value, daily_cap: cap } }); setTimeout(load, 400); } });
    const capRow = TextRow({ title: 'Outside messages per day', hint: 'Below Full, it may send this many on its own each day.', value: String(cap), onCommit: value => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 1000) { toast('Outside messages per day is a whole number from 1 to 1000.', 'error'); capRow.set(String(cap)); return; }
      ctx.update?.({ outbound: { policy: policy, daily_cap: n } }); setTimeout(load, 400);
    } });
    const full = view.mode === 'full';
    return Card({ label: 'Messages outside the app', className: 'bots-permissions-outbound', children: [
      h('div', { class: 'bots-row bots-stack-row' }, [choice]), capRow,
      note(full ? 'At Full it sends on its own, so the allowance does not apply.' : allowanceText(outbound))] });
  }

  function commandsCard() {
    const list = rules?.rules || [];
    const rows = list.length ? list.map(rule => h('div', { class: 'bots-row', 'data-rule': rule.id }, [
      h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: rule.command.length > 90 ? `${rule.command.slice(0, 89)}…` : rule.command }),
        h('span', { class: 'bots-row-hint', text: `In ${rule.cwd}` })]),
      Button({ label: 'Remove', iconName: 'x', onClick: async () => {
        try { await api(`${base}/commands/${encodeURIComponent(rule.id)}`, { method: 'DELETE', toast: false }); } catch (error) { toast(messageOf(error), 'error'); }
        load();
      } })])) : [note('No commands are remembered. Choose "Always allow this exact command here" when it asks.')];
    return Card({ label: 'Remembered commands', className: 'bots-permissions-commands', children: [...rows,
      ...(rules?.state_corrupt ? [note('The saved approvals could not be read, so remembered commands are off.')] : [])] });
  }

  function limitsCard() {
    const agent = ctx.state?.agent || {};
    const capRow = TextRow({ title: 'Runs per day', hint: 'It stops for the day after this many (1 to 200).', value: String(agent.daily_run_cap ?? 12), onCommit: value => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 200) { toast('Runs per day is a whole number from 1 to 200.', 'error'); capRow.set(String(agent.daily_run_cap ?? 12)); return; }
      ctx.update?.({ daily_run_cap: n });
    } });
    return Card({ label: 'Limits', children: [SwitchRow({ title: 'This bot is on', hint: 'Off, it takes no new work and its routines do not run.',
      checked: agent.enabled !== false, onChange: value => ctx.update?.({ enabled: value }) }), capRow] });
  }

  function draw() {
    if (destroyed) return;
    root.replaceChildren();
    if (failure) {
      root.append(note(`Permissions could not load. ${failure}`), h('div', { class: 'bots-actions' }, [Button({ label: 'Try again', iconName: 'refresh-cw', onClick: () => load() })]));
      return;
    }
    if (!view) { root.append(note('Loading…')); return; }
    root.append(levelCard(), moneyCard());
    if (advancedNow(ctx)) root.append(commandsCard());
    root.append(limitsCard());
  }

  load();
  const handle = {
    destroy() { destroyed = true; stopAdvanced(); generation++; root.remove(); },
    refresh() { return load(); },
    async flush() {},
  };
  handle.dispose = handle.destroy;
  return handle;
}
