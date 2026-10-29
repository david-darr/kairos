// Bots mode: the applied-change card for a bot-made automation change (Agents 3.0 Phase 3, unit U5).
// Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 5.3 and 9.
// Styled by static/css/bots-cards.css. Data: GET /api/bot-automation-changes and POST .../{id}/undo
// (routes/bot_automation_change_routes.py).
//
// A bot's change to its own routines or webhook triggers applies at once; this card says what changed, shows the
// before and after on request, and offers Pause, Edit and Undo. Undo is checked on the server against the revision
// the change left, so a stale Undo is refused and the card says why. Webhook addresses and secrets never reach this
// card: the receipt carries none.
//
// `mount(host, ctx)` resolves to { dispose, refresh } like every Phase 3 section. The first half is plain
// functions with no DOM, so scripts/test_bots_cards.cjs loads this file in Node.
import { icon } from './botsIcons.js';
import { loadBotsCss } from './botsUi.js';

export const POLL_MS = 4000;

// -- Model --------------------------------------------------------------------------------

const NOUN = { routine: 'routine', trigger: 'webhook trigger' };

// What the card shows for one receipt.
export function changeModel(receipt, local = {}) {
  const undone = receipt.state === 'undone';
  const failed = receipt.state === 'failed' || receipt.state === 'pending';
  const canUndo = !!receipt.undoable && !undone && !local.undoing;
  const touchable = receipt.state === 'applied' && !undone && receipt.action !== 'delete' && !!receipt.target_id;
  const paused = local.paused !== undefined ? local.paused : receipt.action === 'pause';
  return {
    id: receipt.id,
    line: failed ? (receipt.error || 'This change was not applied.') : receipt.summary,
    state: undone ? 'undone' : failed ? 'failed' : receipt.undo_expired ? 'expired' : 'applied',
    status: undone ? 'Undone' : failed ? 'Not applied' : receipt.undo_expired ? 'Undo has expired' : 'Applied',
    canUndo,
    canPause: touchable && receipt.kind in NOUN,
    pauseLabel: paused ? 'Resume' : 'Pause',
    canEdit: touchable,
    paused,
    rows: (receipt.details || []).map(r => ({ label: r.label, before: r.before || '', after: r.after || '' })),
    flag: receipt.tainted ? 'This turn read outside content.' : '',
    noun: NOUN[receipt.kind] || 'automation',
    undoError: local.error || '',
  };
}

// Which request the Pause or Resume button sends. Routines are tasks; triggers have their own route.
export function pauseRequest(receipt, resume) {
  const path = receipt.kind === 'trigger'
    ? receipt.source === 'app' ? `/api/bot-app-triggers/${receipt.target_id}` : `/api/triggers/${receipt.target_id}`
    : `/api/bot-routines/${receipt.target_id}`;
  return { path, method: 'PATCH', body: { enabled: !!resume } };
}

// "Changed since" is the server's refusal code; say what it means.
export function undoRefusalText(body) {
  if (body && body.code === 'stale') return body.detail || 'It changed after this, so Undo left it alone.';
  if (body && body.code === 'expired') return 'The Undo window for this change has closed.';
  return (body && body.detail) || 'Undo did not finish. Try again.';
}

// -- DOM ----------------------------------------------------------------------------------

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, { method, signal, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await response.json(); } catch { /* an empty body */ }
  return { status: response.status, body: data };
}

export async function mount(host, ctx = {}) {
  await loadBotsCss('/static/css/bots-cards.css');
  const root = h('div', { class: 'bots-changes' });
  host.append(root);
  const control = new AbortController();
  const onAbort = () => control.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  const view = { receipts: [], local: {}, timer: 0, disposed: false, busy: new Set() };

  async function load() {
    const params = ctx.threadId ? `?thread_id=${encodeURIComponent(ctx.threadId)}` : ctx.agentId ? `?bot_id=${encodeURIComponent(ctx.agentId)}` : '';
    if (!params) { view.receipts = []; return; }
    try {
      const { status, body } = await request(`/api/bot-automation-changes${params}`, { signal: control.signal });
      if (status === 200) view.receipts = body.changes || [];
    } catch { /* keep what is shown */ }
  }

  async function refresh() {
    if (view.disposed) return;
    await load();
    if (!view.disposed) render();
  }

  const note = id => (view.local[id] ||= {});

  async function undo(receipt) {
    if (view.busy.has(receipt.id)) return;
    view.busy.add(receipt.id);
    note(receipt.id).undoing = true; note(receipt.id).error = '';
    render();
    try {
      const { status, body } = await request(`/api/bot-automation-changes/${receipt.id}/undo`, { method: 'POST', signal: control.signal });
      if (status === 200) {
        const at = view.receipts.findIndex(r => r.id === receipt.id);
        if (at >= 0) view.receipts[at] = body;
        ctx.refresh?.();
        document.dispatchEvent(new CustomEvent('kairos:bots-automation-changed', { detail: { receipt: body } }));
      } else {
        note(receipt.id).error = undoRefusalText(body);
        // Show the true state: a stale refusal leaves the receipt applied; an expired one closes it.
        await load();
      }
    } catch (error) {
      if (error.name !== 'AbortError') note(receipt.id).error = 'Undo did not finish. Try again.';
    } finally {
      view.busy.delete(receipt.id);
      note(receipt.id).undoing = false;
      if (!view.disposed) render();
    }
  }

  async function pause(receipt) {
    const model = changeModel(receipt, view.local[receipt.id]);
    if (view.busy.has(receipt.id)) return;
    view.busy.add(receipt.id);
    note(receipt.id).error = '';
    render();
    try {
      const { path, method, body } = pauseRequest(receipt, model.paused);
      const result = await request(path, { method, body, signal: control.signal });
      if (result.status === 200) {
        note(receipt.id).paused = !model.paused;
        ctx.refresh?.();
      } else note(receipt.id).error = result.body.detail || 'That did not go through.';
    } catch (error) {
      if (error.name !== 'AbortError') note(receipt.id).error = 'That did not go through.';
    } finally {
      view.busy.delete(receipt.id);
      if (!view.disposed) render();
    }
  }

  // The editor is Unit U3's; load it only when asked, and fall back to the Automations page.
  async function edit(receipt) {
    try {
      const editor = await import('./botsAutomationEditor.js');
      const open = receipt.kind === 'trigger' ? receipt.source === 'app' ? editor.openAppEventEditor : editor.openWebhookEditor || editor.openTriggerEditor : editor.openRoutineEditor;
      if (typeof open === 'function') {
        await open({ id: receipt.target_id, agentId: receipt.bot_id, onSaved: () => refresh() });
        return;
      }
    } catch { /* the editor is not here yet */ }
    ctx.navigate?.('botsAutomations', { agentId: receipt.bot_id, focus: receipt.target_id });
  }

  function card(receipt) {
    const local = view.local[receipt.id] || {};
    const model = changeModel(receipt, local);
    const busy = view.busy.has(receipt.id);
    const titleId = `bots-change-${receipt.id}`;
    const button = (label, variant, onClick, action, enabled = true) =>
      h('button', { type: 'button', class: `bots-btn ${variant}`.trim(), 'data-action': action, disabled: busy || !enabled, onclick: onClick, text: label });
    const buttons = model.state === 'applied' ? [
      model.canPause ? button(model.pauseLabel, '', () => pause(receipt), 'pause') : null,
      model.canEdit ? button('Edit', '', () => edit(receipt), 'edit') : null,
      model.canUndo ? button('Undo', '', () => undo(receipt), 'undo') : null,
    ] : [];
    return h('section', { class: 'bots-change-card', 'data-state': model.state, 'data-receipt-id': receipt.id, role: 'group',
      'aria-labelledby': titleId, 'aria-busy': busy ? 'true' : 'false' }, [
      h('div', { class: 'bots-change-head' }, [
        h('span', { class: 'bots-change-icon' }, icon(model.state === 'undone' ? 'undo-2' : model.state === 'failed' ? 'circle-alert' : 'check', { size: 14 })),
        h('span', { class: 'bots-change-line', id: titleId, text: model.line }),
        h('span', { class: 'bots-pill bots-change-status', text: model.status }),
      ]),
      model.flag ? h('p', { class: 'bots-cards-hint', text: model.flag }) : null,
      model.rows.length ? h('details', { class: 'bots-change-details' }, [
        h('summary', { text: 'Details' }),
        h('dl', { class: 'bots-change-diff' }, model.rows.flatMap(row => [
          h('dt', { text: row.label }),
          h('dd', {}, [row.before ? h('span', { class: 'bots-change-before', text: row.before }) : null,
            row.before && row.after ? h('span', { class: 'bots-change-arrow', 'aria-hidden': 'true', text: ' → ' }) : null,
            row.after ? h('span', { class: 'bots-change-after', text: row.after }) : null]),
        ])),
      ]) : null,
      model.undoError ? h('p', { class: 'bots-cards-error', role: 'alert', text: model.undoError }) : null,
      buttons.some(Boolean) ? h('div', { class: 'bots-cards-actions' }, buttons) : null,
    ]);
  }

  function render() {
    if (view.disposed) return;
    const active = document.activeElement;
    const kept = active && root.contains(active) ? { id: active.closest('[data-receipt-id]')?.dataset.receiptId, action: active.dataset.action } : null;
    const shown = view.receipts.filter(r => r.state !== 'pending');
    root.replaceChildren(...shown.map(card));
    root.dataset.count = String(shown.length);
    if (kept?.id && kept.action) root.querySelector(`[data-receipt-id="${kept.id}"] [data-action="${kept.action}"]`)?.focus();
  }

  const onEvent = () => refresh();
  document.addEventListener('kairos:bot-automation-change', onEvent);
  const poll = () => { view.timer = setTimeout(async () => { await refresh(); if (!view.disposed) poll(); }, POLL_MS); };
  await refresh();
  poll();

  return {
    refresh,
    dispose() {
      view.disposed = true;
      clearTimeout(view.timer);
      control.abort();
      ctx.signal?.removeEventListener('abort', onAbort);
      document.removeEventListener('kairos:bot-automation-change', onEvent);
      root.remove();
    },
  };
}
