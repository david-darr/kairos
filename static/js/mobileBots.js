// Bots on a phone (Agents 3.0, 2026-10-30). Chats under More in Bots opens the sidebar's own list (bots and their
// conversations, rooms, teams, Team map, Templates, Automations, Archived) in a full-screen sheet: one list for
// both sizes, so a phone reaches everything the desktop sidebar does. Inbox opens the attention host's inbox,
// which is already a bottom sheet on a phone (bots-attention.css). Picking anything in the list closes the sheet.
import { attachSheetDrag, slideSheetAway } from './mobileSheet.js';
import { button, mobileOn, phone, haptic } from './mobileShared.js';

let sheet = null, cleanup = null, opener = null, offPanel = null;

// The grabber, Escape and a tap outside slide the sheet down; leaving the page closes it at once.
const dismissList = () => slideSheetAway(sheet) || closeBotsList();
function closeOnLeave() { closeBotsList({ restoreFocus: false }); }
function closeOnSize() { if (!mobileOn()) closeBotsList({ restoreFocus: false }); }

export function closeBotsList({ restoreFocus = true } = {}) {
  if (!sheet?.open) return;
  sheet.close(); sheet.removeAttribute('aria-modal');
  cleanup?.(); cleanup = null; offPanel?.(); offPanel = null;
  sheet.querySelector('.ms-bots-list-host').replaceChildren();
  document.removeEventListener('jarvis:navigate', closeOnLeave);
  phone.removeEventListener?.('change', closeOnSize);
  if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
}

export async function openBotsList(from) {
  if (!mobileOn()) return;
  if (sheet?.open) { closeBotsList(); return; }
  if (!sheet) {
    sheet = document.createElement('dialog'); sheet.className = 'ms-tab-sheet ms-bots-sheet rd-sheet-in'; sheet.id = 'ms-bots-sheet';
    sheet.setAttribute('aria-label', 'Chats');
    sheet.addEventListener('click', event => { if (event.target === sheet) dismissList(); });
    sheet.addEventListener('cancel', event => { event.preventDefault(); dismissList(); });
    attachSheetDrag(sheet, closeBotsList, { enabled: mobileOn });
    const panel = document.createElement('div'); panel.className = 'ms-sheet-panel';
    const grab = button('Close Chats', dismissList, 'ms-sheet-grab'); grab.setAttribute('aria-label', 'Close Chats');
    const heading = document.createElement('h2'); heading.className = 'ms-sheet-heading'; heading.textContent = 'Chats';
    const host = document.createElement('nav'); host.className = 'ms-bots-list-host'; host.setAttribute('aria-label', 'Bots and conversations');
    panel.append(grab, heading, host); sheet.append(panel); document.body.append(sheet);
  }
  opener = from || null; haptic();
  document.dispatchEvent(new CustomEvent('kairos:mobile-drawer-opening', { detail: { id: 'bots-list' } }));
  const [{ mountBotsRail }, { onBotPanelChange }] = await Promise.all([import('./botsRail.js'), import('./botsPanelHost.js')]);
  if (!mobileOn() || sheet.open) return;
  cleanup = mountBotsRail(sheet.querySelector('.ms-bots-list-host'));
  // A bot's settings panel opens beside the page, under this sheet; make way for it.
  offPanel = onBotPanelChange(state => { if (state?.open) closeBotsList({ restoreFocus: false }); });
  document.addEventListener('jarvis:navigate', closeOnLeave);
  phone.addEventListener?.('change', closeOnSize);
  sheet.showModal(); sheet.setAttribute('aria-modal', 'true');
}

export async function openBotsInbox() {
  const host = await import('./botsAttentionHost.js');
  const root = document.documentElement.dataset;
  return host.toggleAttention('inbox', { agentId: root.botsAgent || '', sessionId: root.botsSession || '' });
}
