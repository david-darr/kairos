// A bot's Activity (Agents 3.0 Phase 1, unit U5): its recent real events across
// every conversation, newest first, by day. Rows come from persisted runs and
// redacted runtime records; each says which Kairos record it came from. Full
// usage tracing is later work, so nothing here claims to be a provider trace.
import { icon } from './botsIcons.js';
import { BASE, groupByDay, entryLine, formatAge, h, errorText } from './botsAttentionHost.js';

export async function mount(root, ctx) {
  const view = { agentId: ctx.args?.agentId || '', bots: [], entries: [], total: 0, error: '', loaded: false };
  let disposed = false;
  const list = h('div', { class: 'bots-attn-scroll' });
  root.replaceChildren(list);

  async function load() {
    try {
      if (!view.agentId) {
        view.bots = (await ctx.get('/api/agents')).filter(bot => !bot.hidden);
        view.agentId = view.bots[0]?.id || '';
      }
      if (view.agentId) {
        const data = await ctx.get(`${BASE}/bots/${encodeURIComponent(view.agentId)}/activity`);
        if (disposed) return;
        view.entries = data.entries || []; view.total = data.total || 0;
      }
      view.loaded = true; view.error = '';
    } catch (error) {
      if (disposed) return;
      view.error = errorText(error);
    }
    draw();
  }

  async function pick(id) { view.agentId = id; view.entries = []; view.loaded = false; draw(); await load(); }

  function draw() {
    if (disposed) return;
    const picker = view.bots.length > 1 ? h('select', { class: 'bots-attn-search', 'aria-label': 'Bot' },
      view.bots.map(bot => h('option', { value: bot.id, text: bot.name, selected: bot.id === view.agentId }))) : null;
    picker?.addEventListener('change', () => pick(picker.value));
    const groups = groupByDay(view.entries);
    list.replaceChildren(
      picker ? h('div', { class: 'bots-attn-tools' }, [picker]) : null,
      h('p', { class: 'bots-attn-note', text: 'Events Kairos recorded while this bot worked. Older events are removed after 30 days.' }),
      view.error ? h('p', { class: 'bots-attn-note error', role: 'alert', text: view.error }) : null,
      ...(groups.length ? groups.map(group => h('section', { class: 'bots-attn-day' }, [
        h('div', { class: 'bots-caps bots-attn-day-label', text: group.label }),
        h('div', { class: 'bots-attn-rows', role: 'list' }, group.entries.map(entry)),
      ])) : [h('p', { class: 'bots-attn-note', text: !view.agentId ? 'There are no bots yet.' : view.loaded ? 'No activity yet.' : 'Loading...' })]),
    );
  }

  function entry(item) {
    const line = entryLine(item);
    const session = item.target?.sessionId || '';
    const inspect = session ? h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Inspect this conversation', title: 'Inspect this conversation', 'data-action': 'inspect' }, [icon('eye', { size: 16 })]) : null;
    inspect?.addEventListener('click', () => ctx.open('inspector', { sessionId: session, agentId: view.agentId }));
    const open = item.target?.sessionId ? h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Open in chat', title: 'Open in chat', 'data-action': 'open-chat' }, [icon('message-square', { size: 16 })]) : null;
    open?.addEventListener('click', () => ctx.openTarget(item.target));
    return h('div', { class: `bots-attn-entry tone-${line.tone}`, role: 'listitem', 'data-id': item.id }, [
      h('span', { class: 'bots-attn-row-main' }, [
        h('span', { class: 'bots-attn-row-top' }, [h('span', { class: 'bots-attn-subject', text: line.title }), h('span', { class: 'bots-attn-age', text: formatAge(item.at) })]),
        line.detail ? h('span', { class: 'bots-attn-snippet', text: line.detail }) : null,
        h('span', { class: 'bots-attn-source', text: line.source }),
      ]),
      inspect, open,
    ]);
  }

  await load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, 20000);
  return { dispose() { disposed = true; clearInterval(timer); }, refresh: load };
}
