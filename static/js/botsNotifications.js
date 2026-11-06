// The Bots notification feed (Agents 3.0 Phase 1, unit U5): the newest 500
// retained alerts, with unread counts, filters, pinning, mark-all-read, and a
// click that opens the exact conversation (and message) the alert is about.
// Mounted by botsAttentionHost.js. Device enrollment lives elsewhere
// (/api/notifications); this reads /api/bot-attention/notifications.
import { icon } from './botsIcons.js';
import { Segmented } from './botsUi.js';
import { answerRing } from './ringHost.js';
import { BASE, FEED_FILTERS, filterNotifications, unreadCount, formatAge, kindLabel, navigationFor, h, errorText } from './botsAttentionHost.js';

export async function mount(root, ctx) {
  const view = { rows: [], filter: 'all', botId: ctx.args?.agentId || '', error: '', loaded: false };
  let disposed = false;
  const list = h('div', { class: 'bots-attn-scroll' });
  root.replaceChildren(list);

  async function load() {
    try {
      const data = await ctx.get(`${BASE}/notifications`);
      if (disposed) return;
      view.rows = data.rows || []; view.loaded = true; view.error = '';
      ctx.setCounts({ notifications: data.unread || 0 });
    } catch (error) {
      if (disposed) return;
      view.error = errorText(error);
    }
    draw();
  }

  async function act(path, body, change) {
    const before = view.rows.map(row => ({ ...row }));
    change();
    draw();
    try { await ctx.post(`${BASE}${path}`, body); ctx.setCounts({ notifications: unreadCount(view.rows) }); }
    catch (error) { view.rows = before; view.error = errorText(error); draw(); }
  }

  function draw() {
    if (disposed) return;
    const unread = unreadCount(view.rows);
    const filters = Segmented({ label: 'Notification filter', value: view.filter, options: FEED_FILTERS, onChange: value => { view.filter = value; draw(); } });
    filters.classList.add('bots-attn-tabs');
    const markAll = h('button', { type: 'button', class: 'bots-btn', text: 'Mark all read', 'data-action': 'read-all' });
    markAll.disabled = !unread;
    markAll.addEventListener('click', () => act('/notifications/read-all', {}, () => view.rows.forEach(row => { row.read = true; })));
    const rows = filterNotifications(view.rows, view.filter, view.botId);
    list.replaceChildren(
      h('div', { class: 'bots-attn-tools' }, [
        h('div', { class: 'bots-attn-summary' }, [h('span', { class: 'bots-attn-count', role: 'status', text: unread ? `${unread} unread` : 'All caught up' }), markAll]),
        filters,
      ]),
      view.error ? h('p', { class: 'bots-attn-note error', role: 'alert', text: view.error }) : null,
      h('div', { class: 'bots-attn-rows', role: 'list' }, rows.length ? rows.map(item) : [h('p', { class: 'bots-attn-note', text: view.loaded ? 'No notifications here.' : 'Loading...' })]),
    );
  }

  function item(row) {
    const target = navigationFor(row.target);
    const open = h('button', { type: 'button', class: `bots-attn-row${row.read ? '' : ' unread'}`, 'data-id': row.id, 'data-kind': row.kind, 'data-open': target ? 'true' : undefined }, [
      h('span', { class: 'bots-attn-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'bots-attn-row-main' }, [
        h('span', { class: 'bots-attn-row-top' }, [h('span', { class: 'bots-attn-sender', text: kindLabel(row.kind) }), h('span', { class: 'bots-attn-age', text: formatAge(row.at) })]),
        h('span', { class: 'bots-attn-subject', text: row.title }),
        row.body && row.body !== row.title ? h('span', { class: 'bots-attn-snippet', text: row.body }) : null,
      ]),
    ]);
    open.setAttribute('aria-label', `${row.read ? '' : 'Unread. '}${kindLabel(row.kind)}: ${row.title}`);
    open.addEventListener('click', async () => {
      if (!row.read) { row.read = true; ctx.post(`${BASE}/notifications/${encodeURIComponent(row.id)}/read`).catch(() => {}); ctx.setCounts({ notifications: unreadCount(view.rows) }); }
      if (target) ctx.openTarget(row.target); else draw();
    });
    const pin = h('button', { type: 'button', class: `bots-icon-btn bots-attn-pin${row.pinned ? ' on' : ''}`, 'aria-pressed': row.pinned ? 'true' : 'false',
      'aria-label': row.pinned ? 'Unpin' : 'Pin', title: row.pinned ? 'Unpin' : 'Pin' }, [icon('pin', { size: 16 })]);
    pin.addEventListener('click', () => act(`/notifications/${encodeURIComponent(row.id)}/pin`, { pinned: !row.pinned }, () => { row.pinned = !row.pinned; view.rows.sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at)); }));
    // A missed call can be returned: it opens that bot's call screen with the reason it rang.
    const callBack = row.call_back?.ring_id ? h('button', { type: 'button', class: 'bots-btn bots-attn-callback', 'data-action': 'call-back', text: 'Call back' }) : null;
    callBack?.addEventListener('click', async () => {
      callBack.disabled = true;
      try { await answerRing(row.call_back.ring_id); } catch (error) { view.error = 'That call can no longer be returned.'; callBack.disabled = false; draw(); }
    });
    return h('div', { class: 'bots-attn-feed-row', role: 'listitem' }, [open, ...(callBack ? [callBack] : []), pin]);
  }

  await load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, 20000);
  return { dispose() { disposed = true; clearInterval(timer); }, refresh: load };
}
