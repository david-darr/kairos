// A bot's Access section (Phase 2, unit U4). Phase 1's panel mounts this lazily: mount(host, ctx) ->
// {destroy, refresh, flush}, safe to destroy while requests are pending. ctx: agentId, state.agent, advanced, flush(),
// refresh(), go(section).
//
// It shows what the bot can reach (the ceiling, in words), each connected app with its scope and tools, and the built-in
// tools. Every change saves at once against the revision last read; a refused save puts the screen back and says why, and
// a stale revision reloads the current state. A tool that cannot be used here cannot be switched on. Full approval is not
// shown as a way to reach more: it cannot add to this.
import { api, toast } from './api.js';
import { Card, SwitchRow, Segmented, Button, h, isAdvanced, onBotsInterface, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import {
  SCOPE_LABEL, appSummary, ceilingLines, createGrantSaver, effectLabel, formFrom, messageOf, switchState, withApp, withNative,
  withTool,
} from './botsGrantsModel.js';

export const GRANTS_CSS = '/static/css/bots-grants.css';

const note = text => h('div', { class: 'bots-row bots-note-line' }, [icon('info', { size: 16 }), h('span', { class: 'bots-row-hint', text })]);
const advancedNow = ctx => (typeof ctx.advanced === 'function' ? ctx.advanced() : ctx.advanced ?? isAdvanced());

export function mount(host, ctx) {
  loadBotsCss(GRANTS_CSS);
  const path = `/api/bots/${encodeURIComponent(ctx.agentId)}/access`;
  const root = h('div', { class: 'bots-grants', 'data-section': 'grants' });
  host.append(root);

  let destroyed = false, loading = true, loadError = '', access = null, form = null, saver = null, staleNote = '', generation = 0;
  let pending = 0, search = '';
  const open = new Set();
  const stopAdvanced = onBotsInterface(() => draw());

  async function load() {
    const mine = ++generation;
    if (!access) { loading = true; draw(); }
    try {
      const next = await api(path, { toast: false });
      if (destroyed || mine !== generation) return;
      access = next; form = formFrom(next); loadError = ''; staleNote = '';
      saver = createGrantSaver({ api, path, access: next, onChange, onStale, onError });
    } catch (error) {
      if (destroyed || mine !== generation) return;
      loadError = messageOf(error);
    }
    loading = false;
    draw();
  }

  function onChange(saved, nextForm) {
    if (destroyed) return;
    pending = Math.max(0, pending - 1);
    access = saved;
    if (!pending) form = nextForm;   // only the last save's answer redraws, so typing-speed switching never flickers
    draw();
  }
  function onStale(fresh, nextForm, message) {
    if (destroyed) return;
    pending = Math.max(0, pending - 1);
    if (fresh) { access = fresh; form = nextForm; }
    staleNote = 'Access changed somewhere else, so this shows the current settings. Your last change was not saved.';
    draw();
  }
  function onError(message, before) {
    if (destroyed) return;
    pending = Math.max(0, pending - 1);
    if (before) form = before;
    toast(message, 'error');
    draw();
  }

  function change(next) {
    const before = form;
    form = next;
    pending += 1;
    staleNote = '';
    draw();
    saver.save(next, before);
  }

  // -- drawing --------------------------------------------------------------------------------------------
  function appRows(app) {
    const state = form.apps[app.id];
    const names = app.tools.filter(t => t.available !== false).map(t => t.name);
    const gate = switchState(app);
    const rows = [SwitchRow({
      title: app.name, hint: gate.disabled ? gate.reason : appSummary(app), checked: !!state?.on && !gate.disabled, disabled: gate.disabled,
      onChange: on => change(withApp(form, app.id, { on })),
    })];
    rows[0].dataset.app = app.id;
    if (state?.on && !gate.disabled) {
      const scope = Segmented({
        label: `${app.name} scope`, value: state.scope, options: ['read', 'write'].map(value => ({ value, label: SCOPE_LABEL[value] })),
        onChange: value => change(withApp(form, app.id, { scope: value })),
      });
      scope.dataset.scope = app.id;
      rows.push(h('div', { class: 'bots-row bots-stack-row' }, [scope, h('span', { class: 'bots-row-hint', text: state.scope === 'read'
        ? 'It may look but not change anything. A tool whose effect is not known is blocked.' : 'It may look and make changes.' })]));
      if (app.accounts?.length) rows.push(h('div', { class: 'bots-row bots-stack-row' }, [h('span', { class: 'bots-row-hint', text: 'Accounts it may use. None picked means any.' }),
        ...app.accounts.map(account => SwitchRow({ title: account.label, checked: state.accounts.includes(account.id), onChange: on => {
          const set = new Set(state.accounts); if (on) set.add(account.id); else set.delete(account.id);
          change(withApp(form, app.id, { accounts: [...set] }));
        } }))]));
      if (advancedNow(ctx) && app.tools.length) {
        const toggle = Button({ label: open.has(app.id) ? 'Hide tools' : `Choose tools (${app.tools.length})`, iconName: 'chevron-down', onClick: () => {
          if (open.has(app.id)) open.delete(app.id); else open.add(app.id);
          draw();
        } });
        rows.push(h('div', { class: 'bots-row' }, [toggle]));
        if (open.has(app.id)) for (const tool of app.tools) {
          const blocked = switchState(tool, app.available);
          const checked = state.all ? tool.available !== false : state.tools.includes(tool.name);
          const row = SwitchRow({ title: tool.name, hint: blocked.disabled ? blocked.reason : `${effectLabel(tool)}${tool.state === 'off' && checked ? `. ${tool.reason}` : ''}`,
            checked: checked && !blocked.disabled, disabled: blocked.disabled, onChange: on => change(withTool(form, app.id, tool.name, on, names)) });
          row.dataset.tool = `${app.id}:${tool.name}`;
          rows.push(row);
        }
      }
    }
    return rows;
  }

  function nativeCard() {
    const q = search.trim().toLowerCase();
    const list = access.native.filter(t => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q) || (t.app || '') === q);
    const input = h('input', { type: 'search', class: 'bots-grants-search', placeholder: 'Search built-in tools', 'aria-label': 'Search built-in tools', value: search });
    input.addEventListener('input', () => { search = input.value; draw(); input.focus(); });
    const rows = list.slice(0, 80).map(tool => {
      const blocked = switchState(tool);
      const checked = !form.denied.includes(tool.name);
      const row = SwitchRow({ title: tool.name, hint: blocked.disabled ? blocked.reason : tool.description, checked: checked && !blocked.disabled, disabled: blocked.disabled,
        onChange: on => change(withNative(form, tool.name, on)) });
      row.dataset.native = tool.name;
      return row;
    });
    return Card({ label: `Built-in tools (${access.native.length})`, className: 'bots-grants-native', children: [h('div', { class: 'bots-row' }, [input]),
      ...(rows.length ? rows : [note('No tool matches that.')]), ...(list.length > 80 ? [note('Search to narrow the list.')] : [])] });
  }

  function draw() {
    if (destroyed) return;
    const focus = document.activeElement?.classList?.contains('bots-grants-search') ? 'search' : '';
    root.replaceChildren();
    if (loading) { root.append(note('Loading…')); return; }
    if (loadError) {
      root.append(note(`Access could not load. ${loadError}`), h('div', { class: 'bots-actions' }, [Button({ label: 'Try again', iconName: 'refresh-cw', onClick: () => load() })]));
      return;
    }
    if (staleNote) root.append(h('div', { class: 'bots-row bots-note-line bots-grants-stale', role: 'status' }, [icon('info', { size: 16 }),
      h('span', { class: 'bots-row-hint', text: staleNote }), Button({ label: 'Reload', iconName: 'refresh-cw', onClick: () => load() })]));
    root.append(Card({ label: 'What it can reach', className: 'bots-grants-ceiling', children: ceilingLines(access).map(note) }));
    const apps = access.apps.flatMap(app => appRows(app));
    root.append(Card({ label: 'Connected apps', children: apps.length ? apps : [note('No apps are connected yet. Add one in Settings, under Connections.')] }));
    if (advancedNow(ctx)) root.append(nativeCard());
    if (focus) root.querySelector('.bots-grants-search')?.focus();
  }

  load();
  return {
    destroy() { destroyed = true; stopAdvanced(); generation++; root.remove(); },
    refresh() { return load(); },
    // Saves are immediate, so there is nothing held back; wait for any save still in flight.
    async flush() { await saver?.idle; },
  };
}
