// A data result inside the conversation (Phase 6 unit U2, 2026-10-29): a small card with the result's title, its
// size, an inline chart (280 px tall) when the result has one, and an "Open result" chip that opens the Data tab
// of the bot's workbench on that result. The row is made by the data_sql tool (a display-only message with a
// `data_result` field); the chart is fetched fresh from the bot's own database, never stored in the message.
import { h, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { drawChart } from './botsDataChart.js';
import { rowCountLabel } from './botsDataModel.js';

const CSS = '/static/css/bots-data.css';

// Open the workbench on a result. The request goes out first as a cancelable event (kairos:bots-workbench-open);
// if nothing handles it, the workbench host (another unit's module) is loaded lazily and asked directly.
export async function openResult(agentId, cardId, threadId = '') {
  const request = new CustomEvent('kairos:bots-workbench-open', { detail: { agentId, tab: 'data', threadId, cardId }, cancelable: true });
  if (!document.dispatchEvent(request)) return true;   // something already handled it
  try {
    const host = await import('./botsWorkbenchHost.js');
    if (typeof host.openWorkbench === 'function') { host.openWorkbench(agentId, { tab: 'data', threadId, cardId }); return true; }
  } catch { /* the workbench is not available */ }
  return false;
}

// message: {id, data_result: {card_id, title, rows, chart, columns}}. ctx: {agentId, sessionId, fetcher?}.
export function renderDataResultRow(message, ctx = {}) {
  loadBotsCss(CSS);
  const info = message.data_result || {};
  const open = h('button', { type: 'button', class: 'bots-data-chip' }, [icon('panel-right', { size: 14 }), 'Open result']);
  open.addEventListener('click', () => openResult(ctx.agentId, info.card_id, ctx.sessionId));
  const body = h('div', { class: 'bots-data-inline-body' });
  const root = h('div', { class: 'bots-data-inline', 'data-card-id': info.card_id || '' }, [
    h('div', { class: 'bots-data-inline-head' }, [h('span', { class: 'bots-data-inline-title', text: info.title || 'Result' }),
      info.rows !== undefined && info.rows !== null ? h('span', { class: 'bots-data-inline-count', text: rowCountLabel(info.rows) }) : null, open]),
    body]);
  if (info.chart && ctx.agentId && info.card_id) {
    body.append(h('p', { class: 'bots-data-note', role: 'status', text: 'Drawing the chart' }));
    (ctx.fetcher || fetch)(`/api/bot-data/${encodeURIComponent(ctx.agentId)}/cards/${encodeURIComponent(info.card_id)}/chart`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error('gone'))))
      .then(chart => { body.replaceChildren(); drawChart(body, chart, { width: 480, height: 280, label: info.title || 'Chart' }); })
      .catch(() => body.replaceChildren(h('p', { class: 'bots-data-note', text: 'The chart is not available any more. Open the result to see the table.' })));
  } else if (info.columns?.length) {
    body.append(h('p', { class: 'bots-data-note', text: `Columns: ${info.columns.join(', ')}` }));
  }
  return root;
}
