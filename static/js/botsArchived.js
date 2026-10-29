// Archiving, restoring and deleting bots (Agents 3.0 Phase 0, unit U4; OMB feature F4).
//
//   archiveBotWithNotice(agent)   confirm, hide the bot, show a corner notice with Undo
//   restoreBot(agent)             un-hide it
//   deleteBotWithConfirm(agent)   confirm, then delete (the server refuses while it works)
//   duplicateBot(agent)           POST /duplicate, then open the copy
//   openArchivedBots()            the Archived panel: restore, delete, restore all, delete all
//   notice({text, actionLabel, onAction})   the corner notice
//
// Archive only hides a bot: its routines keep running and still spend its daily runs. The
// confirm says so (Q6 in the design), and points at the switch that really stops it.
import { api, el, toast, confirmDialog, openPanelDialog } from './api.js';
import { agentAvatar } from './agentAvatar.js';
import { Button, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';

const CSS = '/static/css/bots-create.css';
const announce = (detail = {}) => document.dispatchEvent(new CustomEvent('jarvis:agents-changed', { detail }));
const patch = (id, body) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body), toast: false });
const messageOf = error => String(error?.message || error).replace(/^\d+:\s*/, '');

// -- the corner notice ----------------------------------------------------------------------------
let current = null;
export function notice({ text, actionLabel = '', onAction, ms = 8000 } = {}) {
  current?.dismiss();
  loadBotsCss(CSS);
  let host = document.getElementById('bots-notice-host');
  if (!host) { host = el('div', { id: 'bots-notice-host', 'aria-live': 'polite' }); document.body.append(host); }
  let timer = 0;
  const node = el('div', { class: 'bots-notice', role: 'status' }, [icon('archive', { size: 16 }), el('span', { class: 'bots-notice-text', text })]);
  const dismiss = () => { clearTimeout(timer); node.remove(); if (current?.node === node) current = null; };
  if (actionLabel) node.append(el('button', { type: 'button', class: 'bots-notice-action', text: actionLabel, onclick: async () => { dismiss(); await onAction?.(); } }));
  node.append(el('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Dismiss', onclick: dismiss }, [icon('x', { size: 14 })]));
  host.append(node);
  timer = setTimeout(dismiss, ms);
  current = { node, dismiss };
  return { node, dismiss };
}

// -- one bot ---------------------------------------------------------------------------------------
export async function archiveBotWithNotice(agent, { onDone } = {}) {
  await loadBotsCss(CSS);
  const yes = await confirmDialog({ title: `Archive ${agent.name}?`,
    message: `Archiving only hides ${agent.name} from your lists. Its routines keep running on schedule and still use its daily runs. To stop it, turn it off in its settings first.`,
    confirmLabel: 'Archive', danger: false });
  if (!yes) return false;
  try { await patch(agent.id, { hidden: true }); }
  catch (error) { toast(messageOf(error), 'error'); return false; }
  announce({ agentId: agent.id });
  notice({ text: `${agent.name} is archived`, actionLabel: 'Undo', onAction: () => restoreBot(agent) });
  onDone?.();
  return true;
}

export async function restoreBot(agent) {
  try { await patch(agent.id, { hidden: false }); }
  catch (error) { toast(messageOf(error), 'error'); return false; }
  announce({ agentId: agent.id });
  toast(`${agent.name} is back`, 'success');
  return true;
}

async function removeBot(agent) {
  try { await api(`/api/agents/${agent.id}`, { method: 'DELETE', toast: false }); return { ok: true }; }
  catch (error) { return { ok: false, error: messageOf(error) }; }
}

export async function deleteBotWithConfirm(agent, { onDone } = {}) {
  const yes = await confirmDialog({ title: `Delete ${agent.name}?`,
    message: `${agent.name}, its routines and its notes are removed for good. Its conversations stay in Chats as ordinary chats.`, confirmLabel: 'Delete bot' });
  if (!yes) return false;
  const result = await removeBot(agent);
  if (!result.ok) { toast(result.error, 'error'); return false; }
  announce({ agentId: agent.id, deleted: true });
  toast(`${agent.name} was deleted`, 'success');
  onDone?.();
  return true;
}

export async function duplicateBot(agent) {
  try {
    const copy = await api(`/api/agents/${agent.id}/duplicate`, { method: 'POST', body: JSON.stringify({}), toast: false });
    announce({ agentId: copy.id });
    toast(`${copy.name} is ready`, 'success');
    document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'botsShell', agentId: copy.id } }));
    return copy;
  } catch (error) { toast(messageOf(error), 'error'); return null; }
}

// -- the Archived panel ---------------------------------------------------------------------------------
export async function openArchivedBots({ onChange } = {}) {
  await loadBotsCss(CSS);
  const list = el('div', { class: 'bots-archived-list' });
  const restoreAll = Button({ label: 'Restore all', iconName: 'archive-restore' });
  const deleteAll = Button({ label: 'Delete all', iconName: 'trash-2', variant: 'danger' });
  const dialog = openPanelDialog({ title: 'Archived bots', body: list, className: 'bots-dialog bots-archived-dialog',
    footer: el('div', { class: 'bots-dialog-footer' }, [restoreAll, deleteAll, Button({ label: 'Close', onClick: () => dialog.close() })]) });
  let hidden = [];
  const changed = () => { announce(); onChange?.(); };

  async function load() {
    try { hidden = (await api('/api/agents', { toast: false })).filter(a => a.hidden); }
    catch (error) { list.replaceChildren(el('p', { class: 'bots-hint', role: 'alert', text: messageOf(error) })); hidden = []; restoreAll.disabled = deleteAll.disabled = true; return; }
    draw();
  }
  function draw() {
    restoreAll.disabled = deleteAll.disabled = !hidden.length;
    if (!hidden.length) { list.replaceChildren(el('div', { class: 'bots-empty' }, [icon('archive', { size: 22 }), el('p', { text: 'Nothing is archived.' }), el('p', { class: 'bots-hint', text: 'Archive a bot from its menu to tuck it away without deleting it.' })])); return; }
    list.replaceChildren(...hidden.map(agent => {
      const restore = Button({ label: 'Restore', iconName: 'archive-restore', onClick: async () => { if (await restoreBot(agent)) { changed(); load(); } } });
      const del = Button({ label: 'Delete', iconName: 'trash-2', variant: 'danger', onClick: async () => { if (await deleteBotWithConfirm(agent)) { changed(); load(); } } });
      return el('div', { class: 'bots-archived-row', 'data-agent': agent.id }, [
        agentAvatar(agent, 40),
        el('div', { class: 'bots-archived-id' }, [el('strong', { text: agent.name }), el('span', { class: 'bots-row-hint', text: agent.role || 'No job set' })]),
        restore, del]);
    }));
  }
  restoreAll.addEventListener('click', async () => {
    const failed = [];
    for (const agent of [...hidden]) { try { await patch(agent.id, { hidden: false }); } catch (error) { failed.push(`${agent.name}: ${messageOf(error)}`); } }
    if (failed.length) toast(failed.join(' '), 'error'); else toast('Everything is restored', 'success');
    changed(); load();
  });
  deleteAll.addEventListener('click', async () => {
    const yes = await confirmDialog({ title: `Delete all ${hidden.length} archived bots?`, message: 'They, their routines and their notes are removed for good. Their conversations stay in Chats.', confirmLabel: 'Delete all' });
    if (!yes) return;
    const failed = [];
    for (const agent of [...hidden]) { const result = await removeBot(agent); if (!result.ok) failed.push(`${agent.name}: ${result.error}`); }
    if (failed.length) toast(failed.join(' '), 'error'); else toast('The archive is empty', 'success');
    changed(); load();
  });
  await load();
  return dialog;
}
