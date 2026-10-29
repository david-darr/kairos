// Bots mode: the webhook and app-event blocks of the Automations details panel, and the fix buttons
// (Agents 3.0 Phase 3, unit U3). Spec: phase-3-design.md sections 6 and 7; OMB F55, F57, F58.
// Styled by static/css/bots-automations.css.
//
//   mountWebhookDetails(host, item, ctx)   copy the address, replace it, send a test, capture a sample, recent calls
//   mountAppEventDetails(host, item, ctx)  recent arrivals, test, check now (sync)
//   runFix(item, ctx)                      the one button a Needs-you row offers
//   ATTEMPT_REASONS, attemptReason()       the plain words for a call that was turned away
//
// Addresses and secrets: the address is fetched on demand from the owner-only route and copied straight to the
// clipboard. It is never drawn on the page, put in a log or kept in a variable past the click.
// Every mount returns {dispose, refresh}; it owns only the children of `host` and aborts its requests on dispose.
import { api, toast, confirmDialog } from './api.js';
import { icon } from './botsIcons.js';
import { dedupeAttempts, attemptWord, relative, refusalOf } from './botsAutomationModel.js';

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

export const ATTEMPT_REASONS = {
  400: 'The call was not understood.', 401: 'The secret did not match.', 403: 'Not allowed.', 404: 'No such address.', 409: 'This automation is paused.',
  410: 'The bot is gone.', 413: 'The call was too large.', 429: 'Too many calls too fast.',
};
export function attemptReason(attempt) {
  if (attempt.reason) return String(attempt.reason);
  return ATTEMPT_REASONS[attempt.status_code ?? attempt.status] || '';
}

const post = (path, body, signal) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal, toast: false });

async function copyAddress(item) {
  try {
    const data = await api(`/api/bot-webhooks/${encodeURIComponent(item.id)}/address`, { toast: false });
    const address = data?.address || (data?.path ? new URL(data.path, location.origin).href : '');
    if (!address) { toast('This webhook has no address to copy. Replace it to get a new one.', 'error'); return; }
    await navigator.clipboard.writeText(address);
    toast('Address copied', 'success');
  } catch (error) { toast(refusalOf(error).message || 'Could not copy the address.', 'error'); }
}

function attemptRow(attempt, now) {
  const [word, tone] = attemptWord(attempt.outcome);
  const reason = attemptReason(attempt);
  const row = h('li', { class: 'bots-ev-attempt', 'data-outcome': attempt.outcome || '' });
  const head = h('button', { type: 'button', class: 'bots-ev-attempt-head', 'aria-expanded': 'false' }, [
    h('span', { class: 'bots-ev-mark', 'data-tone': tone, 'aria-hidden': 'true' }, [icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'x' : 'info', { size: 12 })]),
    h('span', { class: 'bots-ev-attempt-text' }, [h('span', { text: word }), reason ? h('span', { class: 'bots-ev-reason', text: reason }) : null]),
    h('span', { class: 'bots-ev-when', text: relative(attempt.at, now) }),
  ]);
  const detail = h('pre', { class: 'bots-ev-payload', hidden: '' });
  detail.textContent = attempt.payload_preview ? String(attempt.payload_preview).slice(0, 1200) : 'No payload was kept.';
  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', open ? 'true' : 'false'); detail.hidden = !open;
  });
  row.append(head, detail);
  return row;
}

function attemptList(attempts, label) {
  const now = Date.now();
  const rows = dedupeAttempts(attempts, 30);
  if (!rows.length) return h('p', { class: 'bots-ev-none', text: 'Nothing has arrived yet.' });
  return h('ul', { class: 'bots-ev-attempts', 'aria-label': label }, rows.map(a => attemptRow(a, now)));
}

// -- Webhooks -------------------------------------------------------------------------------------------

export function mountWebhookDetails(host, item, ctx = {}) {
  const root = h('section', { class: 'bots-ev bots-ev-webhook', 'aria-label': 'Webhook' });
  host.append(root);
  const control = new AbortController();
  ctx.signal?.addEventListener('abort', () => control.abort(), { once: true });
  let disposed = false, busy = false;

  async function act(label, run) {
    if (busy) return;
    busy = true; root.dataset.busy = '';
    try { await run(); } catch (error) { toast(refusalOf(error).message || `${label} did not work.`, 'error'); }
    finally { busy = false; delete root.dataset.busy; if (!disposed) await refresh(); ctx.refresh?.(); }
  }

  const button = (label, iconName, onClick, extra = {}) => h('button', { type: 'button', class: `bots-btn${extra.danger ? ' danger' : ''}`, onclick: onClick }, [icon(iconName, { size: 16 }), label]);

  async function refresh() {
    if (disposed) return;
    let attempts = [];
    try { attempts = (await api(`/api/bot-webhooks/${encodeURIComponent(item.id)}/attempts`, { signal: control.signal, toast: false }))?.attempts || []; } catch { /* keep what is shown */ }
    if (disposed) return;
    const t = item.trigger || {};
    root.replaceChildren(
      h('div', { class: 'bots-ev-actions' }, [
        button('Copy address', 'copy', () => copyAddress(item)),
        button('Send a test', 'zap', () => act('The test', async () => { await post(`/api/bot-webhooks/${encodeURIComponent(item.id)}/test`); toast('Test sent', 'success'); })),
        button('Capture a sample', 'download', () => act('Capture', async () => { await post(`/api/bot-webhooks/${encodeURIComponent(item.id)}/capture`); toast('Waiting for one call. The next one is saved, not run.', 'success'); })),
        button('Replace address', 'refresh-cw', async () => {
          if (!await confirmDialog({ title: 'Replace the address?', message: 'The old address and secret stop working. Anything that calls this webhook needs the new one.', confirmLabel: 'Replace', danger: true })) return;
          act('Replace', async () => { await post(`/api/bot-webhooks/${encodeURIComponent(item.id)}/rotate`); toast('The address was replaced. Copy the new one.', 'success'); });
        }),
      ]),
      t.auto_run === false || t.auto_run === undefined ? h('p', { class: 'bots-ev-note', text: 'Each call waits for your OK before the bot starts.' }) : h('p', { class: 'bots-ev-note', text: 'Calls start the bot straight away.' }),
      Array.isArray(t.events) && t.events.length ? h('p', { class: 'bots-ev-note', text: `Accepts: ${t.events.join(', ')}` }) : null,
      h('p', { class: 'bots-ev-note', text: 'Calls only reach Kairos while it is open and reachable from the internet.' }),
      h('h4', { class: 'bots-caps', text: 'Recent calls' }),
      attemptList(attempts, 'Recent calls'),
    );
  }
  refresh();
  return { dispose() { disposed = true; control.abort(); root.remove(); }, refresh };
}

// -- App events -----------------------------------------------------------------------------------------

export function mountAppEventDetails(host, item, ctx = {}) {
  const root = h('section', { class: 'bots-ev bots-ev-app', 'aria-label': 'App events' });
  host.append(root);
  const control = new AbortController();
  ctx.signal?.addEventListener('abort', () => control.abort(), { once: true });
  let disposed = false, busy = false;

  async function act(label, run) {
    if (busy) return;
    busy = true;
    try { await run(); } catch (error) { toast(refusalOf(error).message || `${label} did not work.`, 'error'); }
    finally { busy = false; if (!disposed) await refresh(); ctx.refresh?.(); }
  }

  async function refresh() {
    if (disposed) return;
    let record = item.trigger || {};
    try { record = { ...record, ...(await api(`/api/bot-app-triggers/${encodeURIComponent(item.id)}`, { signal: control.signal, toast: false })) }; } catch { /* keep what is shown */ }
    if (disposed) return;
    const attempts = (record.attempts || []).slice(0, 6);
    const delivery = record.delivery === 'instant' ? 'Instant' : `Checks every ${record.interval_minutes || 15} minutes`;
    root.replaceChildren(
      h('p', { class: 'bots-ev-note', text: `${record.app_name || record.app || 'App'}${record.account_label ? ` (${record.account_label})` : ''} · ${delivery}` }),
      record.problem ? h('p', { class: 'bots-ev-note bots-ev-bad', role: 'status', text: record.problem }) : null,
      h('div', { class: 'bots-ev-actions' }, [
        h('button', { type: 'button', class: 'bots-btn', onclick: () => act('The test', async () => { await post(`/api/bot-app-triggers/${encodeURIComponent(item.id)}/test`); toast('Test started', 'success'); }) }, [icon('zap', { size: 16 }), 'Send a test']),
        h('button', { type: 'button', class: 'bots-btn', onclick: () => act('The check', async () => { await post(`/api/bot-app-triggers/${encodeURIComponent(item.id)}/sync`); toast('Checked', 'success'); }) }, [icon('refresh-cw', { size: 16 }), 'Check now']),
      ]),
      record.skipped_today ? h('p', { class: 'bots-ev-note', text: `Skipped ${record.skipped_today} today (${record.skip_reason || 'over the daily limit'}).` }) : null,
      h('h4', { class: 'bots-caps', text: 'Latest arrivals' }),
      attemptList(attempts, 'Latest arrivals'),
    );
  }
  refresh();
  return { dispose() { disposed = true; control.abort(); root.remove(); }, refresh };
}

// -- Fix buttons ----------------------------------------------------------------------------------------

// The one fix a Needs-you row offers (design 7). ctx: {openThread(botId, threadId), edit(item), refresh(), go(tab, options)}.
export async function runFix(item, ctx) {
  const fix = item.trouble?.fix;
  if (!fix) return;
  try {
    if (fix.kind === 'open_run') {
      const run = item.routine?.runs.find(r => r.id === fix.runId) || item.routine?.lastRun;
      if (run?.threadId) ctx.openThread(item.botId, run.threadId);
      else toast('That run has no conversation to open.', 'error');
    } else if (fix.kind === 'usage') ctx.go('settings', { section: 'usage' });
    else if (fix.kind === 'reconnect') ctx.go('tool-store', {});
    else if (fix.kind === 'edit') ctx.edit(item);
    else if (fix.kind === 'run') {
      if (item.kind === 'routine') await post(`/api/bot-routines/${encodeURIComponent(item.id)}/run`, { request_id: crypto.randomUUID() });
      else if (item.kind === 'webhook') await post(`/api/bot-webhooks/${encodeURIComponent(item.id)}/test`);
      else await post(`/api/bot-app-triggers/${encodeURIComponent(item.id)}/test`);
      toast('Started', 'success');
    }
  } catch (error) { toast(refusalOf(error).message || 'That did not work.', 'error'); }
  ctx.refresh?.();
}

